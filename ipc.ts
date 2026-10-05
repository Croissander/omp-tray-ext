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

/**
 * Resolve with `p`'s value, or reject `Error("dbus call timeout")` if `p` is
 * still unsettled after `ms`; the timer is cleared as soon as `p` settles.
 *
 * WHY: dbus-next settles a pending `call()` ONLY when a reply message arrives —
 * `disconnect()`, connection errors, and remote bus death leave the promise
 * pending forever (no timeout machinery in the lib). Without this wrapper an
 * unanswered RPC wedges the caller's serialized state chain for good.
 */
export function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const t = setTimeout(() => reject(new Error("dbus call timeout")), ms);
  p.then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); },
  );
  return promise;
}

/** Session-bus factory `connectBus` calls; tests swap it to avoid the real bus. */
let sessionBus: () => dbus.MessageBus = dbus.sessionBus;

/** @internal test seam: swap the session-bus factory; `null` restores `dbus.sessionBus`. */
export function __setSessionBusForTests(factory: (() => dbus.MessageBus) | null): void {
  sessionBus = factory ?? dbus.sessionBus;
}

/** Milliseconds left until the absolute `until` timestamp (`Date.now()` basis); floors at 0. */
const budgetLeft = (until: number): number => Math.max(0, until - Date.now());

/** Result of opening a session-bus connection. */
interface BusConnection {
  bus: dbus.MessageBus | null;
  ok: boolean;
}

/** Open a session-bus connection with a connect timeout. Disconnects on failure. */
function connectBus(timeoutMs = 3000): Promise<BusConnection> {
  let bus: dbus.MessageBus;
  try {
    bus = sessionBus();
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

/**
 * Ping the daemon: returns true if reachable. `timeoutMs` is ONE absolute
 * budget covering the bus connect and every RPC below.
 */
export async function daemonAlive(timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const conn = await connectBus(budgetLeft(until));
  if (!conn.ok || !conn.bus) return false;
  try {
    const dbusProxy = await deadline(
      conn.bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"),
      budgetLeft(until),
    );
    const driver = dbusProxy.getInterface<DriverIface & dbus.ClientInterface>("org.freedesktop.DBus");
    return await deadline(driver.NameHasOwner(DAEMON_NAME), budgetLeft(until));
  } catch {
    return false;
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}

/**
 * Send a state update to the daemon. Resolves true iff the daemon accepted it;
 * false when the daemon is unreachable or the send fails — the caller decides
 * on recovery. Never blocks the agent loop on tray IPC. `timeoutMs` is ONE
 * absolute budget covering the bus connect and every RPC.
 */
export async function sendState(state: DaemonState, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const conn = await connectBus(budgetLeft(until));
  if (!conn.ok || !conn.bus) return false;
  try {
    const proxy = await deadline(conn.bus.getProxyObject(DAEMON_NAME, DAEMON_PATH), budgetLeft(until));
    const control = proxy.getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE);
    await deadline(control.SetState(state), budgetLeft(until));
    return true;
  } catch {
    // Daemon not up yet, or vanished — caller recovers (respawn + reseed).
    return false;
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}

/**
 * Tell the daemon to release its DBus name and exit (clean tray removal).
 * Resolves true iff the `Stop()` RPC completed, false otherwise; never throws.
 * `timeoutMs` is ONE absolute budget covering the bus connect and every RPC.
 */
export async function stopDaemon(timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const conn = await connectBus(budgetLeft(until));
  if (!conn.ok || !conn.bus) return false;
  try {
    const proxy = await deadline(conn.bus.getProxyObject(DAEMON_NAME, DAEMON_PATH), budgetLeft(until));
    const control = proxy.getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE);
    await deadline(control.Stop(), budgetLeft(until));
    return true;
  } catch {
    // daemon not running — nothing to stop
    return false;
  } finally {
    try { conn.bus.disconnect(); } catch {}
  }
}
