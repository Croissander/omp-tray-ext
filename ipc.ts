// Shared DBus IPC contract between the omp extension (client) and the
// persistent tray daemon (server). Kept in one place so both sides agree on
// the bus name, path, interface, and method names.

import dbus from "dbus-next";

/** Bus name the daemon owns so the extension can locate it. */
export const DAEMON_NAME = "org.omptray.Daemon";
/** Object path the daemon exports its control interface at. */
export const DAEMON_PATH = "/org/omptray/Daemon";
/** DBus interface name for daemon control methods. */
export const DAEMON_IFACE = "org.omptray.Daemon";

/** Agent state the extension forwards to the daemon. */
export type DaemonState = "idle" | "working" | "error";

/** Typed view over the daemon's control interface (dbus-next's is `{ [k]: Function }`). */
export interface DaemonControlIface {
  SetState(state: string): Promise<void>;
  Stop(): Promise<void>;
}

/** Typed view over the DBus daemon driver for NameHasOwner. */
interface DriverIface {
  NameHasOwner(name: string): Promise<boolean>;
}

/** Result of opening a session-bus connection. */
interface BusConnection {
  bus: dbus.MessageBus | null;
  ok: boolean;
}

/** Open a session-bus connection with a connect timeout. Disconnects on failure. */
function connectBus(timeoutMs = 3000): Promise<BusConnection> {
  let bus: dbus.MessageBus;
  try {
    bus = dbus.sessionBus();
  } catch {
    return Promise.resolve({ bus: null, ok: false });
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const t = setTimeout(() => resolve(false), timeoutMs);
  bus.on("connect", () => { clearTimeout(t); resolve(true); });
  bus.on("error", () => { clearTimeout(t); resolve(false); });
  return promise.then((ok) => {
    if (!ok) {
      try { bus.disconnect(); } catch {}
      return { bus: null, ok: false };
    }
    return { bus, ok: true };
  });
}

/** Ping the daemon: returns true if reachable. */
export async function daemonAlive(): Promise<boolean> {
  const conn = await connectBus();
  if (!conn.ok || !conn.bus) return false;
  try {
    const dbusProxy = await conn.bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    const driver = dbusProxy.getInterface<DriverIface & dbus.ClientInterface>("org.freedesktop.DBus");
    return await driver.NameHasOwner(DAEMON_NAME);
  } catch {
    return false;
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}

/**
 * Send a state update to the daemon. No-op if the daemon isn't running so the
 * extension never blocks the agent loop on tray IPC.
 */
export async function sendState(state: DaemonState): Promise<void> {
  const conn = await connectBus();
  if (!conn.ok || !conn.bus) return;
  try {
    const proxy = await conn.bus.getProxyObject(DAEMON_NAME, DAEMON_PATH);
    const control = proxy.getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE);
    await control.SetState(state);
  } catch {
    // Daemon not up yet, or vanished — silently drop; the extension will retry.
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}

/** Tell the daemon to release its DBus name and exit (clean tray removal). */
export async function stopDaemon(): Promise<void> {
  const conn = await connectBus();
  if (!conn.ok || !conn.bus) return;
  try {
    const proxy = await conn.bus.getProxyObject(DAEMON_NAME, DAEMON_PATH);
    const control = proxy.getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE);
    await control.Stop();
  } catch {
    // daemon not running — nothing to stop
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}
