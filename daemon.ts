// omp tray daemon. Owns the DBus StatusNotifierItem and the shared
// org.omptray.Daemon control name — exactly one daemon per session bus
// (slot losers exit cleanly). The omp extension (index.ts) spawns it
// detached; /tray stop calls Stop over DBus, process teardown sends SIGTERM.
//
// States:  idle=">_",  working=spinning ring,  error="X"

import dbus from "dbus-next";
import { readFileSync } from "node:fs";
import { DAEMON_IFACE, DAEMON_NAME, DAEMON_PATH, deadline, type DaemonState } from "./ipc";
import { glyph, spinnerFrameByIndex, toArgb, type Pixels } from "./icons";

const { interface: iface } = dbus;

interface WatcherIface {
  RegisterStatusNotifierItem(service: string): Promise<void>;
}

/** Typed view over the org.freedesktop.DBus driver. */
interface DriverIface {
  NameHasOwner(name: string): Promise<boolean>;
}

const SNI_IFACE = "org.kde.StatusNotifierItem";
const SNI_PATH = "/StatusNotifierItem";
const SNI_NAME = "org.kde.StatusNotifierItem.omptray";
const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const WATCHER_IFACE = "org.kde.StatusNotifierWatcher";
const MENU_PATH = "/MenuBar";
const DBUSMENU_IFACE = "com.canonical.dbusmenu";
const SPINNER_INTERVAL_MS = 120;
// dbus-next pending calls NEVER settle on connection loss, so every RPC is
// deadline-bound.
const CALL_TIMEOUT_MS = 3000;
const PROBE_INTERVAL_MS = 30_000;

/** State → human label shared by the menu header and nothing else. */
const STATE_LABEL: Record<DaemonState, string> = { idle: "Idle", working: "Working", error: "Error" };

// ---- Right-click menu (com.canonical.dbusmenu) ------------------------------
//
// Menu item ids — a STATIC tree: ids never change, so clients can cache them
// and live values (header label, Interrupt enabled, watcher row) ride
// ItemsPropertiesUpdated property updates instead of layout churn. The layout
// revision therefore never moves.
const M_HEADER = 1;
const M_SEP_TOP = 2;
const M_INTERRUPT = 3;
const M_PROMPTS = 4;
const M_PROMPT_COMMIT = 5;
const M_PROMPT_TESTS = 6;
const M_PROMPT_SUMMARY = 7;
const M_SEP_BOTTOM = 8;
const M_DEBUG = 9;
const M_DEBUG_VERSION = 10;
const M_DEBUG_STARTED = 11;
const M_DEBUG_OWNER = 12;
const M_DEBUG_WATCHER = 13;
const M_STOP = 14;

/** Quick prompts the menu offers; the text is the verbatim user message. */
const PROMPT_ITEMS: [number, string][] = [
  [M_PROMPT_COMMIT, "Commit the changes with a clear message"],
  [M_PROMPT_TESTS, "Run the tests and fix any failures"],
  [M_PROMPT_SUMMARY, "Summarize what you changed in this session"],
];

/** Static menu tree: id → children (root 0 first). */
const MENU_TREE: Record<number, number[]> = {
  0: [M_HEADER, M_SEP_TOP, M_INTERRUPT, M_PROMPTS, M_SEP_BOTTOM, M_DEBUG, M_STOP],
  [M_PROMPTS]: PROMPT_ITEMS.map(([id]) => id),
  [M_DEBUG]: [M_DEBUG_VERSION, M_DEBUG_STARTED, M_DEBUG_OWNER, M_DEBUG_WATCHER],
};

const LAYOUT_REVISION = 1;

type MenuProps = Record<string, dbus.Variant>;

const svar = (value: string): dbus.Variant => new dbus.Variant("s", value);
const bvar = (value: boolean): dbus.Variant => new dbus.Variant("b", value);
const infoRow = (label: string): MenuProps => ({ label: svar(label), enabled: bvar(false) });

const hhmm = (at: Date): string =>
  `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

function filterProps(props: MenuProps, names: string[]): MenuProps {
  if (names.length === 0) return props;
  const out: MenuProps = {};
  for (const name of names) {
    if (Object.hasOwn(props, name)) out[name] = props[name]!;
  }
  return out;
}

const pixmapCache = new WeakMap<Pixels, [number, number, Uint8Array]>();
function pixmapOf(px: Pixels): [number, number, Uint8Array][] {
  let entry = pixmapCache.get(px);
  if (!entry) {
    const { w, h, bytes } = toArgb(px);
    entry = [w, h, bytes];
    pixmapCache.set(px, entry);
  }
  return [entry];
}

class OmpTrayItem extends iface.Interface {
  Id = "omp-agent";
  Title = "omp";
  Category = "ApplicationStatus"; // waybar drops items with an empty Category
  // True: /MenuBar serves a real dbusmenu now — this flag is how hosts hint
  // "menu available" (and e.g. GNOME opens it on left-click too).
  ItemIsMenu = true;
  Menu = "/MenuBar";
  Status = "Passive";
  ToolIconName = "";
  IconName = "";
  IconThemePath = "";
  AttentionIconName = "";
  IconPixmap: [number, number, Uint8Array][] = [];
  AttentionIconPixmap: [number, number, Uint8Array][] = [];
  ToolTip: [string, [number, number, Uint8Array][], string, string] = ["", [], "omp", "Idle"];
  constructor() {
    super(SNI_IFACE);
  }

  ContextMenu(_x: number, _y: number) {}
  Activate(_x: number, _y: number) {}
  SecondaryActivate(_x: number, _y: number) {}
  Scroll(_delta: number, _orientation: string) {}

  NewIcon() {}
  NewAttentionIcon() {}
  // dbus-next emits a signal's RETURN value as its body; spec 3.3.6 passes
  // the status as the signal's single string arg (parameters "(s)"). A flat
  // "s" body is what makes xfce's g_variant_get(parameters, "(s)") work.
  NewStatus(status: string): string {
    return status;
  }
  NewTitle() {}
  NewToolTip() {}
}

OmpTrayItem.configureMembers({
  properties: {
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "readwrite" },
    Category: { signature: "s", access: "read" },
    ItemIsMenu: { signature: "b", access: "read" },
    Menu: { signature: "o", access: "read" },
    Status: { signature: "s", access: "readwrite" },
    ToolIconName: { signature: "s", access: "read" },
    IconName: { signature: "s", access: "readwrite" },
    IconThemePath: { signature: "s", access: "read" },
    AttentionIconName: { signature: "s", access: "readwrite" },
    IconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionIconPixmap: { signature: "a(iiay)", access: "read" },
    ToolTip: { signature: "(sa(iiay)ss)", access: "readwrite" },
  },
  methods: {
    ContextMenu: { inSignature: "ii" },
    Activate: { inSignature: "ii" },
    SecondaryActivate: { inSignature: "ii" },
    Scroll: { inSignature: "is" },
  },
  signals: {
    NewIcon: { signature: "" },
    NewAttentionIcon: { signature: "" },
    NewStatus: { signature: "s" },
    NewTitle: { signature: "" },
    NewToolTip: { signature: "" },
  },
});

/**
 * com.canonical.dbusmenu at /MenuBar — the right-click context menu: hosts
 * fetch GetLayout and deliver clicks as Event("clicked"). (A live Menu path
 * is also what GNOME requires to show the icon at all.) The item tree is
 * static; dynamic values (header label, Interrupt enabled, watcher row) ride
 * ItemsPropertiesUpdated, so the layout revision never moves.
 */
class OmpTrayMenu extends iface.Interface {
  Version = 3;
  TextDirection = "ltr";
  Status = "normal";
  IconThemePath: string[] = [];
  Theme: string[] = [];
  constructor(private d: Daemon) {
    super(DBUSMENU_IFACE);
  }

  private propsFor(id: number): MenuProps {
    const d = this.d;
    switch (id) {
      case M_HEADER:
        // Informational row — disabled so hosts render it as a label.
        return { label: svar(d.headerLabel()), enabled: bvar(false) };
      case M_INTERRUPT:
        return { label: svar("Interrupt agent"), enabled: bvar(d.state === "working") };
      case M_PROMPTS:
        return { label: svar("Prompts"), "children-display": svar("submenu") };
      case M_DEBUG:
        return { label: svar("Debug"), "children-display": svar("submenu") };
      case M_STOP:
        return { label: svar("Stop daemon") };
      case M_SEP_TOP:
      case M_SEP_BOTTOM:
        return { type: svar("separator") };
      case M_DEBUG_VERSION:
        return infoRow(`omp-tray-ext v${d.version}`);
      case M_DEBUG_STARTED:
        return infoRow(`started ${hhmm(d.startedAt)}`);
      case M_DEBUG_OWNER:
        return infoRow(`owner pid ${d.ownerPid}`);
      case M_DEBUG_WATCHER:
        return infoRow(d.watcherRegistered ? "watcher: registered" : "watcher: not registered");
      default: {
        const prompt = PROMPT_ITEMS.find(([pid]) => pid === id);
        return prompt ? { label: svar(prompt[1] ?? "") } : {};
      }
    }
  }

  /**
   * Layout node is (ia{sv}av) — (id, properties, children) — matching every
   * real client's reply type. Honors the libdbusmenu depth semantics:
   * 0 = the parent only, N = N levels of children, -1 = full recursion (what
   * real hosts ask for). propertyNames filters the returned properties; []
   * means all. The ticket's "k" timestamp code is not a D-Bus type: it is u,
   * as in every real implementation.
   */
  GetLayout(parentId: number, recursionDepth: number, propertyNames: string[]): [number, [number, MenuProps, dbus.Variant[]]] {
    const node = (id: number, depth: number): [number, MenuProps, dbus.Variant[]] => [
      id,
      filterProps(this.propsFor(id), propertyNames),
      depth === 0
        ? []
        : (MENU_TREE[id] ?? []).map((child) => new dbus.Variant("(ia{sv}av)", node(child, depth < 0 ? depth : depth - 1))),
    ];
    return [LAYOUT_REVISION, node(parentId, recursionDepth)];
  }

  GetGroupProperties(ids: number[], propertyNames: string[]): [number, MenuProps][] {
    return ids.map((id) => [id, filterProps(this.propsFor(id), propertyNames)]);
  }

  GetProperty(id: number, name: string): dbus.Variant {
    return this.propsFor(id)[name] ?? svar("");
  }

  /** Route one "clicked" event; false when the id/event is not an action. */
  private dispatch(id: number, eventId: string): boolean {
    if (eventId !== "clicked") return false;
    // Trust boundary: only known ids do anything — header, separators,
    // submenus and unknown ids are inert.
    const prompt = PROMPT_ITEMS.find(([pid]) => pid === id);
    if (prompt) {
      this.d.requestAction("prompt", prompt[1] ?? "");
      return true;
    }
    if (id === M_INTERRUPT) {
      this.d.requestAction("abort", "");
      return true;
    }
    if (id === M_STOP) {
      this.d.requestStop();
      return true;
    }
    return false;
  }

  Event(id: number, eventId: string, _data: dbus.Variant, _timestamp: number) {
    this.dispatch(id, eventId);
  }

  // Canonical events are (u,s,v,u) — id typed u here but i in Event. Weird,
  // but both real implementations agree.
  EventGroup(events: [number, string, dbus.Variant, number][]): number[] {
    return events.filter(([id, eventId]) => this.dispatch(id, eventId)).map(([id]) => id);
  }

  AboutToShow(_id: number): boolean {
    // False: the layout never changes, and dynamic values are pushed via
    // ItemsPropertiesUpdated the moment they change.
    return false;
  }

  AboutToShowGroup(ids: number[]): [number, boolean][] {
    return ids.map((id): [number, boolean] => [id, false]);
  }

  /** Emit ItemsPropertiesUpdated to cached clients (header label, enabled, watcher row). */
  pushProperties(updated: [number, MenuProps][]) {
    this.ItemsPropertiesUpdated(updated, []);
  }

  ItemsPropertiesUpdated(updated: [number, MenuProps][], removed: [number, string[]][]): [[number, MenuProps][], [number, string[]][]] {
    return [updated, removed];
  }

  // Declared for introspection completeness; never emitted — the item tree
  // is static, so property changes ride ItemsPropertiesUpdated and a
  // LayoutUpdated would only trigger pointless client refetches.
  LayoutUpdated(_revision: number, _parentId: number) {}
}

OmpTrayMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: "read" },
    TextDirection: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    IconThemePath: { signature: "as", access: "read" },
    Theme: { signature: "as", access: "read" },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "auas", outSignature: "a(ia{sv})" },
    // Canonical arg types per the KDE/libdbusmenu interface: id is i (and
    // Event's data rides BEFORE the timestamp). The stub-era (us)/(usuv) here
    // mismatched every conformant client's marshalling once real items
    // existed — clicks would have been rejected on signature.
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu" },
    EventGroup: { inSignature: "a(usuv)", outSignature: "au" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aib" },
  },
  signals: {
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ias)" },
    LayoutUpdated: { signature: "ui" },
  },
});

class DaemonControl extends iface.Interface {
  constructor(private d: Daemon) {
    super(DAEMON_IFACE);
  }
  SetState(state: string) {
    // DBus method args are a trust boundary — don't let garbage state strings
    // put the daemon into an unhandled state.
    if (state !== "idle" && state !== "working" && state !== "error") {
      console.warn(`[omptray-daemon] ignoring invalid SetState: ${String(state)}`);
      return;
    }
    this.d.setState(state);
  }
  SetDetail(detail: string) {
    // Trust boundary: this text lands in menu/tooltip labels — trim and clamp.
    const clean = detail.trim().slice(0, 80);
    this.d.setDetail(clean || null);
  }
  Stop() {
    this.d.requestStop();
  }
  // daemon → extension: a menu action for the session ("abort" with an empty
  // arg, or "prompt" carrying the verbatim prompt text). The bus only
  // delivers this to subscribers matching sender=org.omptray.Daemon, which
  // requires owning the name — spoofing is not possible.
  SessionAction(action: string, arg: string): [string, string] {
    return [action, arg];
  }
}

DaemonControl.configureMembers({
  methods: {
    SetState: { inSignature: "s" },
    SetDetail: { inSignature: "s" },
    Stop: {},
  },
  signals: {
    SessionAction: { signature: "ss" },
  },
  properties: {},
});

/** Handle for setInterval timers (spinner ticks, bus self-probe). */
type SpinnerHandle = NodeJS.Timeout;

/** State → render mapping: the one place status/tooltip/attention are decided. */
export function stateView(state: DaemonState, frame: number): {
  px: Pixels;
  status: "Active" | "NeedsAttention";
  tooltip: string;
  attention: boolean;
} {
  if (state === "working") {
    return { px: spinnerFrameByIndex(frame), status: "Active", tooltip: "Working", attention: false };
  }
  if (state === "error") {
    return { px: glyph("error"), status: "NeedsAttention", tooltip: "Error — agent stopped", attention: true };
  }
  return { px: glyph("prompt"), status: "Active", tooltip: "Idle", attention: false };
}

/** Version from package.json (read per-construction — importing stays side-effect-free). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

class Daemon {
  private bus: dbus.MessageBus | null = null;
  private item: OmpTrayItem | null = null;
  private menu: OmpTrayMenu | null = null;
  private control: DaemonControl | null = null;
  private spinner: SpinnerHandle | null = null;
  private probe: SpinnerHandle | null = null;
  private frame = 0;
  // state/detail are read by OmpTrayMenu to build item properties — they are
  // the shared-slot truth: last-writer-wins across sessions, by design.
  state: DaemonState = "idle";
  detail: string | null = null;
  watcherRegistered = false;
  readonly startedAt = new Date();
  readonly ownerPid: number;
  readonly version: string;
  // Last header label / Interrupt-enabled value pushed to menu clients, so
  // property updates fire only on real changes.
  private pushedHeader: string | null = null;
  private pushedInterrupt: boolean | null = null;
  private tooltipText: string | null = null;
  private shuttingDown = false;
  private registering = false;
  private registerPending = false;
  started = false;

  constructor(ownerPid: number = Number(process.argv[2]) || process.ppid) {
    this.ownerPid = ownerPid;
    this.version = packageVersion();
  }

  /** The one place IconPixmap + ToolTip + NewIcon are built. */
  private paint(px: Pixels, tooltip: string) {
    if (!this.item) return;
    const pixmap = pixmapOf(px);
    this.item.IconPixmap = pixmap;
    // Spinner ticks repaint every 120 ms; only a tooltip TEXT change may set
    // ToolTip and emit NewToolTip, or hosts get a churn storm.
    const tooltipChanged = tooltip !== this.tooltipText;
    this.tooltipText = tooltip;
    if (tooltipChanged) {
      this.item.ToolTip = ["", pixmap, "omp", tooltip];
    }
    iface.Interface.emitPropertiesChanged(
      this.item,
      tooltipChanged
        ? { IconPixmap: this.item.IconPixmap, ToolTip: this.item.ToolTip }
        : { IconPixmap: this.item.IconPixmap },
      [],
    );
    this.item.NewIcon();
    if (tooltipChanged) this.item.NewToolTip();
  }

  private render() {
    if (!this.item) return;
    const { px, status, tooltip, attention } = stateView(this.state, this.frame);
    this.paint(px, this.composeTooltip(tooltip));
    this.item.Status = status;
    this.item.AttentionIconPixmap = attention ? pixmapOf(px) : [];
    iface.Interface.emitPropertiesChanged(this.item, {
      Status: this.item.Status,
      AttentionIconPixmap: this.item.AttentionIconPixmap,
    }, []);
    this.item.NewStatus(this.item.Status);
    this.item.NewAttentionIcon();
  }

  private startSpinner() {
    if (this.spinner) return;
    this.spinner = setInterval(() => {
      this.frame = (this.frame + 1) % 8;
      if (this.state === "working") {
        // Only update the pixmap + signal; status stays "Active". The
        // composed tooltip is constant across ticks, so paint's dedupe
        // keeps NewToolTip quiet.
        this.paint(spinnerFrameByIndex(this.frame), this.composeTooltip("Working"));
      }
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner() {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
    }
  }

  setState(state: DaemonState) {
    if (state === this.state) return;
    this.state = state;
    if (state === "idle") {
      // Idle header/tooltip carry no run detail.
      this.detail = null;
    }
    this.stopSpinner();
    if (state === "working") {
      this.frame = 0;
      this.startSpinner();
    }
    this.render();
    this.syncMenu();
  }

  /** Menu header: "omp — Working · Edit" — state plus the run detail. */
  headerLabel(): string {
    const base = `omp — ${STATE_LABEL[this.state]}`;
    return this.state === "idle" || !this.detail ? base : `${base} · ${this.detail}`;
  }

  /** Tooltip carries the run detail only while working (error stays plain). */
  private composeTooltip(base: string): string {
    return this.state === "working" && this.detail ? `${base} · ${this.detail}` : base;
  }

  /** Push changed menu properties (header label, Interrupt enabled) to clients. */
  private syncMenu() {
    const menu = this.menu;
    if (!menu) return;
    const updates: [number, MenuProps][] = [];
    const label = this.headerLabel();
    if (label !== this.pushedHeader) {
      this.pushedHeader = label;
      updates.push([M_HEADER, { label: svar(label) }]);
    }
    const interrupt = this.state === "working";
    if (interrupt !== this.pushedInterrupt) {
      this.pushedInterrupt = interrupt;
      updates.push([M_INTERRUPT, { enabled: bvar(interrupt) }]);
    }
    if (updates.length) menu.pushProperties(updates);
  }

  /** Run detail from the extension (the current tool name) → header + tooltip. */
  setDetail(detail: string | null) {
    if (detail === this.detail) return;
    this.detail = detail;
    // Same pixmap, possibly changed text: paint's tooltip dedupe keeps quiet
    // when the composed text did not move.
    const { px, tooltip } = stateView(this.state, this.frame);
    this.paint(px, this.composeTooltip(tooltip));
    this.syncMenu();
  }

  /** Menu → extension: emit a session action on the control interface. */
  requestAction(action: string, arg: string) {
    this.control?.SessionAction(action, arg);
  }

  /** Shared by DaemonControl.Stop and the menu's Stop daemon item. */
  requestStop() {
    // Defer shutdown so the DBus reply for Stop()/the menu click is delivered
    // before exit.
    setImmediate(() => this.shutdown());
  }

  /**
   * (Re-)register with the StatusNotifierWatcher. Idempotent per watcher
   * appearance: bursts (rapid owner churn) coalesce into at most one extra
   * registration, and failure is warn-only — the next owner appearance
   * retries.
   */
  private wantRegister(): void {
    if (this.registering) {
      this.registerPending = true;
      return;
    }
    void this.register();
  }

  private async register(): Promise<void> {
    const bus = this.bus;
    if (!bus || this.shuttingDown) return;
    this.registering = true;
    this.registerPending = false;
    try {
      await deadline(
        (async () => {
          const watcherProxy = await bus.getProxyObject(WATCHER_NAME, WATCHER_PATH);
          const watcher = watcherProxy.getInterface<WatcherIface & dbus.ClientInterface>(WATCHER_IFACE);
          const name = "name" in bus && typeof bus.name === "string" ? bus.name : "";
          await watcher.RegisterStatusNotifierItem(name);
        })(),
        CALL_TIMEOUT_MS,
      );
      this.watcherRegistered = true;
      this.menu?.pushProperties([[M_DEBUG_WATCHER, { label: svar("watcher: registered") }]]);
    } catch (e) {
      console.warn("[omptray-daemon] StatusNotifierWatcher registration failed:", (e as Error).message);
    } finally {
      this.registering = false;
      if (this.registerPending && !this.shuttingDown) void this.register();
    }
  }

  async start(): Promise<boolean> {
    if (this.started) return true;
    let bus: dbus.MessageBus;
    try {
      bus = dbus.sessionBus();
    } catch (e) {
      console.error("[omptray-daemon] failed to open session bus:", (e as Error).message);
      return false;
    }

    const { promise, resolve } = Promise.withResolvers<boolean>();
    const t = setTimeout(() => resolve(false), 10000);
    bus.on("connect", () => { clearTimeout(t); resolve(true); });
    bus.on("error", (e) => {
      clearTimeout(t);
      resolve(false); // no-op once the start promise has settled
      // Bus died. Without DBus we're nothing; the names vanish with the
      // socket so the panel drops the icon, and the extension respawns us on
      // the next session_start. Exit in EVERY state — pre-start errors used
      // to be ignored and start() then wedged on a never-settling requestName.
      console.error("[omptray-daemon] session bus error:", (e as Error).message);
      this.shutdown(1);
    });
    const connected = await promise;
    if (!connected) {
      console.error("[omptray-daemon] session bus connect failed or timed out");
      try { bus.disconnect(); } catch {}
      return false;
    }
    this.bus = bus;

    this.item = new OmpTrayItem();
    this.menu = new OmpTrayMenu(this);
    this.control = new DaemonControl(this);
    bus.export(SNI_PATH, this.item);
    bus.export(MENU_PATH, this.menu);
    bus.export(DAEMON_PATH, this.control);

    // Own the daemon control name first — the exclusive slot for exactly one
    // daemon. DO_NOT_QUEUE, no replacement: a second daemon's claim gets
    // EXISTS and exits before claiming the SNI alias or registering with the
    // watcher — at most one tray icon even when several daemons start
    // concurrently. (REPLACE_EXISTING + a displacement watch shipped two
    // icons on 2026-10-05: the replace let both claimants pass the gate, and
    // the watch's subscription raced the takeover.) Deliberate takeover is
    // /tray restart (stop + respawn).
    const controlReply = await deadline(
      bus.requestName(DAEMON_NAME, dbus.NameFlag.DO_NOT_QUEUE),
      CALL_TIMEOUT_MS,
    ).catch((e): number | null => {
      // request rejection = transport failure (distinct from a non-PRIMARY
      // reply below = slot taken).
      console.error("[omptray-daemon] control name claim failed (bus):", (e as Error).message);
      return null;
    });
    if (controlReply === null) {
      this.shutdown(1);
      return false;
    }
    if (controlReply !== dbus.RequestNameReply.PRIMARY_OWNER) {
      console.error("[omptray-daemon] control name owned by another omp-tray daemon (slot taken), exiting");
      this.shutdown(0);
      return false;
    }

    // SNI alias second, also DO_NOT_QUEUE — REPLACE_EXISTING |
    // ALLOW_REPLACEMENT let a second daemon steal the alias from the live
    // winner while the winner kept painting into a name it lost.
    try {
      const reply = await deadline(bus.requestName(SNI_NAME, dbus.NameFlag.DO_NOT_QUEUE), CALL_TIMEOUT_MS);
      if (reply !== dbus.RequestNameReply.PRIMARY_OWNER) {
        console.error("[omptray-daemon] could not own SNI name (slot taken), reply:", reply);
      }
    } catch (e) {
      console.error("[omptray-daemon] SNI name claim failed (bus):", (e as Error).message);
      this.shutdown(1);
      return false;
    }

    // Publish the full initial state BEFORE registering with the watcher: a
    // fast host snapshots GetAll at RegisterStatusNotifierItem time and must
    // see Status "Active" + icon + tooltip already (a bare setState("idle")
    // is a dedupe no-op on the already-idle state).
    this.render();

    // Watcher lifecycle: (re-)register on EVERY owner appearance of the
    // watcher name — covers watcher absent at boot AND panel/DE restart
    // (watcher item lists are in-memory and empty on restart; no host
    // solicits re-registration). Race-free subscribe-before-act: on this
    // connection the NameOwnerChanged AddMatch is queued before the flush
    // roundtrip below, so any appearance lands either in the snapshot or in
    // the handler — and appearances seen while bootstrapping coalesce into
    // the single initial register.
    const dbusProxy = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    const driver = dbusProxy.getInterface<DriverIface & dbus.ClientInterface>("org.freedesktop.DBus");
    let bootstrapping = true;
    let sawAppearance = false;
    driver.on("NameOwnerChanged", (name: string, _oldOwner: string, newOwner: string) => {
      if (name !== WATCHER_NAME || newOwner === "") return;
      if (bootstrapping) {
        sawAppearance = true;
        return;
      }
      this.wantRegister();
    });
    const watcherUp =
      (await deadline(driver.NameHasOwner(WATCHER_NAME), CALL_TIMEOUT_MS).catch(() => false)) || sawAppearance;
    bootstrapping = false;
    if (watcherUp) this.wantRegister();

    // Silent bus death self-probe: a clean socket close emits no event and an
    // idle daemon (spinner stopped) never writes, so it would linger forever.
    // NameHasOwner rides our connection like any pending call — rejection
    // (dead socket) or false (our name gone) means we are gone.
    this.probe = setInterval(() => {
      void deadline(driver.NameHasOwner(DAEMON_NAME), CALL_TIMEOUT_MS).then(
        (ok) => {
          if (!ok) this.shutdown(1);
        },
        () => this.shutdown(1),
      );
    }, PROBE_INTERVAL_MS);

    this.started = true;
    // Panels subscribe to our signals asynchronously after
    // RegisterStatusNotifierItem returns, so the initial NewIcon/NewStatus
    // fired in render above may be missed. Re-emit shortly after so the
    // idle icon surfaces immediately at omp launch, without waiting for the
    // first agent state change. (paint's tooltip dedupe keeps it quiet.)
    setTimeout(() => this.render(), 300);
    console.log("[omptray-daemon] started, SNI exported, listening for SetState");
    return true;
  }

  shutdown(exitCode = 0) {
    // Re-entrant-safe and ALWAYS exits, even with a null bus: a SIGTERM
    // during the up-to-10s connect window used to return silently here and
    // the orphaned daemon went on to claim the slot and register an icon.
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopSpinner();
    if (this.probe) {
      clearInterval(this.probe);
      this.probe = null;
    }
    const bus = this.bus;
    if (bus) {
      try {
        if (this.item) bus.unexport(SNI_PATH, this.item);
        if (this.menu) bus.unexport(MENU_PATH, this.menu);
        if (this.control) bus.unexport(DAEMON_PATH, this.control);
      } catch {}
      // No releaseName calls: names die with the connection (dbus spec) and
      // fire-and-forget releases could re-enter this error path synchronously
      // on an ended stream. disconnect() is what makes icon removal prompt.
      try { bus.disconnect(); } catch {}
    }
    this.bus = null;
    this.item = null;
    this.menu = null;
    this.control = null;
    this.started = false;
    console.log("[omptray-daemon] stopped");
    process.exit(exitCode);
  }
}

/**
 * The owner's controlling-terminal device from /proc/<pid>/stat (field 7,
 * `tty_nr`), 0 when the process has no ctty, -1 when the stat read fails —
 * an unreadable stat must never read as "no terminal", only a confirmed 0
 * means the terminal is gone. stat is "pid (comm) state ppid pgrp session
 * tty_nr ..."; comm may contain spaces/parens, so parsing starts after the
 * last ")" (same shape as the extension's isOwnerless).
 *
 * @internal `statOf` injectable for tests.
 */
export function ownerTtyNr(
  pid: number,
  statOf: (pid: number) => string = (p) => readFileSync(`/proc/${p}/stat`, "utf8"),
): number {
  try {
    const stat = statOf(pid);
    const tty = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
    return Number.isFinite(tty) && tty >= 0 ? tty : -1;
  } catch {
    return -1;
  }
}

// Module import is side-effect-free (tests import stateView); daemon
// instantiation and signal wiring happen only when run as the daemon.
if (import.meta.main) {
  const owner = Number(process.argv[2]) || process.ppid;
  const daemon = new Daemon(owner);
  // Graceful signals: release the name so the panel removes the icon promptly.
  const die = () => daemon.shutdown();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, die);
  }
  // Owner-liveness watchdog: the icon must vanish WITH its app, but a closing
  // omp often cannot signal us — process.on("exit") never runs on signal death
  // (SIGHUP terminal close, SIGINT, SIGTERM, SIGKILL), so the extension's
  // exit-hook kill is skipped exactly then. The spawner passes its pid as
  // argv[2]; when it dies we are reparented (ppid changes) and shut down
  // within one poll. The boot check covers the owner dying before this
  // process even started. Manual `bun daemon.ts` runs fall back to the
  // spawning shell — same rule, die with the shell. The check is stateless
  // (ppid never changes back), so registration order cannot miss a death.
  if (process.ppid !== owner) process.exit(0);
  // The owner can also OUTLIVE its terminal: omp's disconnect teardown
  // sometimes hangs instead of exiting (stdin end → self-SIGHUP never
  // completes; upstream oh-my-pi #5835/#6788 class), and ppid alone then
  // never changes — the icon would track a headless zombie forever. When the
  // terminal dies for good, the session leader dies with it and the owner's
  // controlling terminal is released: /proc/<owner>/stat tty_nr drops to 0,
  // readable from here even while the owner's event loop is wedged. Owners
  // that never had a ctty (piped stdin, setsid — boot tty 0) are
  // non-interactive by construction and keep the ppid-only rule.
  // ponytail: a terminal dying during the ~2 s spawn window reads as
  // non-interactive and disarms this check (ppid still covers the exit);
  // upgrade path: the extension passes its own isTTY in argv[3].
  const bootTty = ownerTtyNr(owner);
  setInterval(() => {
    if (process.ppid !== owner) {
      daemon.shutdown();
      return;
    }
    if (bootTty > 0 && ownerTtyNr(owner) === 0) daemon.shutdown();
  }, 1000);
  const ok = await daemon.start();
  if (!ok) process.exit(1);
  // Keep the event loop alive for DBus I/O + the spinner timer.
}
