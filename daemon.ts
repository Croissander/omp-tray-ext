// omp tray daemon. Owns the DBus StatusNotifierItem and the shared
// org.omptray.Daemon control name — exactly one daemon per session bus
// (slot losers exit cleanly). The omp extension (index.ts) spawns it
// detached; /tray stop calls Stop over DBus, process teardown sends SIGTERM.
//
// States:  idle=">_",  working=spinning ring,  error="X"

import dbus from "dbus-next";
import { DAEMON_IFACE, DAEMON_NAME, DAEMON_PATH, type DaemonState } from "./ipc";
import { glyph, spinnerFrameByIndex, toArgb, type Pixels } from "./icons";

const { interface: iface } = dbus;

interface WatcherIface {
  RegisterStatusNotifierItem(service: string): Promise<void>;
}

const SNI_IFACE = "org.kde.StatusNotifierItem";
const SNI_PATH = "/StatusNotifierItem";
const SNI_NAME = "org.kde.StatusNotifierItem.omptray";
const SPINNER_INTERVAL_MS = 120;

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
  NewStatus() {}
  NewTitle() {}
  NewToolTip() {}
}

OmpTrayItem.configureMembers({
  properties: {
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "readwrite" },
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
    NewStatus: { signature: "" },
    NewTitle: { signature: "" },
    NewToolTip: { signature: "" },
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

/** Handle for the spinner's setInterval timer. */
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
  private control: DaemonControl | null = null;
  private spinner: SpinnerHandle | null = null;
  private frame = 0;
  private state: DaemonState = "idle";
  started = false;

  /** The one place IconPixmap + ToolTip + NewIcon are built. */
  private paint(px: Pixels, tooltip: string) {
    if (!this.item) return;
    const pixmap = pixmapOf(px);
    this.item.IconPixmap = pixmap;
    this.item.ToolTip = ["", pixmap, "omp", tooltip];
    iface.Interface.emitPropertiesChanged(this.item, {
      IconPixmap: this.item.IconPixmap,
      ToolTip: this.item.ToolTip,
    }, []);
    this.item.NewIcon();
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
    this.item.NewStatus();
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
      if (this.started) {
        // Bus died mid-flight. Without DBus we're nothing; the names vanish
        // with the socket so the panel drops the icon, and the extension
        // respawns us on the next session_start. Without this, a "working"
        // spinner interval keeps the process alive forever as a zombie.
        console.error("[omptray-daemon] session bus error:", (e as Error).message);
        this.shutdown(1);
      }
    });
    const connected = await promise;
    if (!connected) {
      console.error("[omptray-daemon] session bus connect failed or timed out");
      try { bus.disconnect(); } catch {}
      return false;
    }
    this.bus = bus;

    this.item = new OmpTrayItem();
    this.control = new DaemonControl(this);
    bus.export(SNI_PATH, this.item);
    bus.export(DAEMON_PATH, this.control);
    const reply = await bus.requestName(SNI_NAME, dbus.NameFlag.REPLACE_EXISTING | dbus.NameFlag.ALLOW_REPLACEMENT);
    if (reply !== dbus.RequestNameReply.PRIMARY_OWNER) {
      console.error("[omptray-daemon] could not own SNI name, reply:", reply);
    }
    // Own the daemon control name — the exclusive slot for exactly one daemon.
    // DO_NOT_QUEUE, no replacement: a second daemon's claim gets EXISTS and
    // exits before registering with the watcher — at most one tray icon even
    // when several daemons start concurrently. (REPLACE_EXISTING + a
    // displacement watch shipped two icons on 2026-10-05: the replace let both
    // claimants pass the gate, and the watch's subscription raced the
    // takeover.) Deliberate takeover is /tray restart (stop + respawn).
    const controlReply = await bus
      .requestName(DAEMON_NAME, dbus.NameFlag.DO_NOT_QUEUE)
      .catch(() => 0);
    if (controlReply !== dbus.RequestNameReply.PRIMARY_OWNER) {
      console.error("[omptray-daemon] control name owned by another omp-tray daemon, exiting");
      this.shutdown(0);
      return false;
    }

    try {
      const watcherProxy = await bus.getProxyObject("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher");
      const watcher = watcherProxy.getInterface<WatcherIface & dbus.ClientInterface>("org.kde.StatusNotifierWatcher");
      const name = "name" in bus && typeof bus.name === "string" ? bus.name : "";
      await watcher.RegisterStatusNotifierItem(name);
    } catch (e) {
      console.warn("[omptray-daemon] no StatusNotifierWatcher:", (e as Error).message);
    }

    this.item.Title = "omp";
    this.setState("idle");
    this.started = true;
    // Panels subscribe to our signals asynchronously after
    // RegisterStatusNotifierItem returns, so the initial NewIcon/NewStatus
    // fired in setState above may be missed. Re-emit shortly after so the
    // idle icon surfaces immediately at omp launch, without waiting for the
    // first agent state change.
    setTimeout(() => this.render(), 300);
    console.log("[omptray-daemon] started, SNI exported, listening for SetState");
    return true;
  }

  shutdown(exitCode = 0) {
    this.stopSpinner();
    const bus = this.bus;
    if (!bus) return;
    try {
      if (this.item) bus.unexport(SNI_PATH, this.item);
      if (this.control) bus.unexport(DAEMON_PATH, this.control);
      bus.releaseName(SNI_NAME).catch(() => {});
      bus.releaseName(DAEMON_NAME).catch(() => {});
    } finally {
      // Disconnecting an already-dead bus throws — swallow (AGENTS.md rule).
      try { bus.disconnect(); } catch {}
      this.bus = null;
      this.item = null;
      this.control = null;
      this.started = false;
    }
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
  const ok = await daemon.start();
  if (!ok) process.exit(1);
  // Keep the event loop alive for DBus I/O + the spinner timer.
}
