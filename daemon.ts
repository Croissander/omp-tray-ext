// omp tray daemon. Owns the DBus StatusNotifierItem and the shared
// org.omptray.Daemon control name — exactly one daemon per session bus
// (slot losers exit cleanly). The omp extension (index.ts) spawns it
// detached; /tray stop calls Stop over DBus, process teardown sends SIGTERM.
//
// States:  idle=">_",  working=spinning ring,  error="X"

import dbus from "dbus-next";
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
  ItemIsMenu = false;
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
 * Minimal com.canonical.dbusmenu at /MenuBar. GNOME requires a live Menu
 * path to show the icon at all (a dead path churns its DBusMenu client).
 * No menu items — the tray is a status display.
 */
class OmpTrayMenu extends iface.Interface {
  Version = 3;
  TextDirection = "ltr";
  Status = "normal";
  IconThemePath: string[] = [];
  Theme: string[] = [];
  constructor() {
    super(DBUSMENU_IFACE);
  }

  /** Revision 1 and one empty root node (id 0, no props, no children). */
  GetLayout(_parentId: number, _recursionDepth: number, _propertyNames: string[]): [number, [number, Record<string, dbus.Variant>, dbus.Variant[]]] {
    return [1, [0, {}, []]];
  }
  GetGroupProperties(_ids: number[], _propertyNames: string[]): [number, Record<string, dbus.Variant>][] {
    return [];
  }
  GetProperty(_id: number, _name: string): dbus.Variant {
    return new dbus.Variant("s", "");
  }
  Event(_id: number, _eventId: string, _timestamp: number, _data: dbus.Variant) {}
  EventGroup(_events: [number, string, number, dbus.Variant][]): number[] {
    return [];
  }
  AboutToShow(_id: number): boolean {
    return false;
  }
  AboutToShowGroup(ids: number[]): [number, boolean][] {
    return ids.map((id): [number, boolean] => [id, false]);
  }
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
    // Layout node is (ia{sv}av) — (id, properties, children) — matching the
    // empty root (0, {}, []) and every real client's reply type. The ticket's
    // "k" timestamp code is not a D-Bus type: it is u, as in every real
    // implementation.
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "auas", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "us", outSignature: "v" },
    Event: { inSignature: "usuv" },
    EventGroup: { inSignature: "a(usuv)", outSignature: "au" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aib" },
  },
  signals: {},
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
  Stop() {
    // Defer shutdown so the DBus reply for Stop() is delivered before exit.
    setImmediate(() => this.d.shutdown());
  }
}

DaemonControl.configureMembers({
  methods: {
    SetState: { inSignature: "s" },
    Stop: {},
  },
  signals: {},
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

class Daemon {
  private bus: dbus.MessageBus | null = null;
  private item: OmpTrayItem | null = null;
  private menu: OmpTrayMenu | null = null;
  private control: DaemonControl | null = null;
  private spinner: SpinnerHandle | null = null;
  private probe: SpinnerHandle | null = null;
  private frame = 0;
  private state: DaemonState = "idle";
  private tooltipText: string | null = null;
  private shuttingDown = false;
  private registering = false;
  private registerPending = false;
  started = false;

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
    this.paint(px, tooltip);
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
        // Only update the pixmap + signal; status stays "Active".
        this.paint(spinnerFrameByIndex(this.frame), "Working");
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
    this.stopSpinner();
    if (state === "working") {
      this.frame = 0;
      this.startSpinner();
    }
    this.render();
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
    this.menu = new OmpTrayMenu();
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

// Module import is side-effect-free (tests import stateView); daemon
// instantiation and signal wiring happen only when run as the daemon.
if (import.meta.main) {
  const daemon = new Daemon();
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
  const owner = Number(process.argv[2]) || process.ppid;
  if (process.ppid !== owner) process.exit(0);
  setInterval(() => {
    if (process.ppid !== owner) daemon.shutdown();
  }, 1000);
  const ok = await daemon.start();
  if (!ok) process.exit(1);
  // Keep the event loop alive for DBus I/O + the spinner timer.
}
