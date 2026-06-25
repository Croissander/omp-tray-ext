// omp tray daemon. Owns the DBus StatusNotifierItem. The omp extension
// (index.ts) spawns this detached at load and stops it on quit via DBus
// method calls on org.omptray.Daemon.
//
// States:  idle=">_",  working=spinning ring,  error="!!"
// The daemon's lifetime mirrors the omp process: spawned at startup,
// removed on exit.

import dbus from "dbus-next";
import { glyph, spinnerFrameByIndex, toArgb, type Pixels } from "./icons";

const { interface: iface } = dbus;

type DaemonState = "idle" | "working" | "error";

interface WatcherIface {
  RegisterStatusNotifierItem(service: string): Promise<void>;
}
function watcherInterface(proxy: dbus.ProxyObject) {
  return proxy.getInterface<WatcherIface & dbus.ClientInterface>("org.kde.StatusNotifierWatcher");
}

type BusWithName = dbus.MessageBus & { name: string | null };
function busName(bus: dbus.MessageBus): string {
  return (bus as BusWithName).name ?? "";
}

const DAEMON_IFACE = "org.omptray.Daemon";
const DAEMON_PATH = "/org/omptray/Daemon";
const DAEMON_NAME = "org.omptray.Daemon";
const SNI_IFACE = "org.kde.StatusNotifierItem";
const SNI_PATH = "/StatusNotifierItem";
const SNI_NAME = "org.kde.StatusNotifierItem.omptray";
const SPINNER_INTERVAL_MS = 120;

function pixmapOf(px: Pixels): [number, number, Uint8Array][] {
  const { w, h, bytes } = toArgb(px);
  return [[w, h, bytes]];
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



//麒 ponytail: the daemon's own control interface accepts SetState(s) + Stop().
class DaemonControl extends iface.Interface {
  constructor() {
    super(DAEMON_IFACE);
  }
  SetState(state: string) {
    daemon.setState(state as DaemonState);
  }
  Stop() {
    // Defer shutdown so the DBus reply for Stop() is delivered before exit.
    setImmediate(() => daemon.shutdown());
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

class Daemon {
  private bus: dbus.MessageBus | null = null;
  private item: OmpTrayItem | null = null;
  private control: DaemonControl | null = null;
  private spinner: SpinnerHandle | null = null;
  private frame = 0;
  private state: DaemonState = "idle";
  started = false;

  private render() {
    if (!this.item) return;
    let px: Pixels;
    let status: string;
    let tooltip: string;
    if (this.state === "working") {
      px = spinnerFrameByIndex(this.frame);
      status = "Active";
      tooltip = "Working";
    } else if (this.state === "error") {
      px = glyph("error");
      status = "NeedsAttention";
      tooltip = "Error — agent stopped";
    } else {
      px = glyph("prompt");
      status = "Active";
      tooltip = "Idle";
    }
    this.item.IconPixmap = pixmapOf(px);
    this.item.AttentionIconPixmap = this.state === "error" ? pixmapOf(px) : [];
    this.item.Status = status;
    this.item.ToolTip = ["", pixmapOf(px), "omp", tooltip];
    iface.Interface.emitPropertiesChanged(this.item, {
      Status: this.item.Status,
      IconPixmap: this.item.IconPixmap,
      AttentionIconPixmap: this.item.AttentionIconPixmap,
      ToolTip: this.item.ToolTip,
    }, []);
    this.item.NewIcon();
    this.item.NewStatus();
    this.item.NewAttentionIcon();
  }

  private startSpinner() {
    if (this.spinner) return;
    this.spinner = setInterval(() => {
      this.frame = (this.frame + 1) % 8;
      if (this.state === "working") {
        // Only update the pixmap + signal; status stays "Active".
        if (this.item) {
          const px = spinnerFrameByIndex(this.frame);
          this.item.IconPixmap = pixmapOf(px);
          this.item.ToolTip = ["", pixmapOf(px), "omp", "Working"];
          iface.Interface.emitPropertiesChanged(this.item, {
            IconPixmap: this.item.IconPixmap,
            ToolTip: this.item.ToolTip,
          }, []);
          this.item.NewIcon();
        }
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
    bus.on("error", () => { clearTimeout(t); resolve(false); });
    const connected = await promise;
    if (!connected) {
      console.error("[omptray-daemon] session bus connect failed or timed out");
      try { bus.disconnect(); } catch {}
      return false;
    }
    this.bus = bus;

    this.item = new OmpTrayItem();
    this.control = new DaemonControl();
    bus.export(SNI_PATH, this.item);
    bus.export(DAEMON_PATH, this.control);
    const reply = await bus.requestName(SNI_NAME, dbus.NameFlag.REPLACE_EXISTING | dbus.NameFlag.ALLOW_REPLACEMENT);
    if (reply !== dbus.RequestNameReply.PRIMARY_OWNER) {
      console.error("[omptray-daemon] could not own SNI name, reply:", reply);
    }
    // Also own the daemon control name so the extension can find us.
    await bus.requestName(DAEMON_NAME, dbus.NameFlag.REPLACE_EXISTING).catch(() => {});

    try {
      const watcherProxy = await bus.getProxyObject("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher");
      await watcherInterface(watcherProxy).RegisterStatusNotifierItem(busName(bus));
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

  shutdown() {
    this.stopSpinner();
    const bus = this.bus;
    if (!bus) return;
    try {
      if (this.item) bus.unexport(SNI_PATH, this.item);
      if (this.control) bus.unexport(DAEMON_PATH, this.control);
      bus.releaseName(SNI_NAME).catch(() => {});
      bus.releaseName(DAEMON_NAME).catch(() => {});
    } finally {
      bus.disconnect();
      this.bus = null;
      this.item = null;
      this.control = null;
      this.started = false;
    }
    console.log("[omptray-daemon] stopped");
    process.exit(0);
  }
}

const daemon = new Daemon();

// Graceful signals: release the name so the panel removes the icon promptly.
const die = (sig: string) => {
  process.removeListener(sig, (die as unknown as () => void));
  daemon.shutdown();
};
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => die(sig));
}

if (import.meta.main) {
  const ok = await daemon.start();
  if (!ok) process.exit(1);
  // Keep the event loop alive for DBus I/O + the spinner timer.
}
