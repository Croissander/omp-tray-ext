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
  SetDetail(detail: string): Promise<void>;
  Stop(): Promise<void>;
}

/**
 * Typed view of the daemon's control interface as a SIGNAL source: menu
 * clicks arrive here as SessionAction(action, arg) — ("abort", "") or
 * ("prompt", verbatim prompt text).
 */
export interface DaemonActionSource {
  on(event: "SessionAction", handler: (action: string, arg: string) => void): unknown;
}

/** Typed view over the org.freedesktop.DBus driver (name/owner queries). */
interface DriverIface {
  NameHasOwner(name: string): Promise<boolean>;
  GetConnectionUnixProcessID(name: string): Promise<number>;
}

/**
 * Resolve with `p`'s value, or reject `Error("dbus call timeout")` if `p` is
 * still unsettled after `ms`; the timer is cleared as soon as `p` settles.
 *
 * WHY: dbus-next settles a pending `call()` ONLY when a reply message arrives —
 * `disconnect()`, connection errors, and remote bus death leave the promise
 * pending forever (no timeout machinery in the lib). Without this wrapper an
 * unanswered RPC wedges the caller's serialized state chain for good.
 *
 * `unrefTimer` arms the timeout unref'd — for callers that must never hold a
 * host event loop open (the action listener in short-lived processes such as
 * `omp install`).
 */
export function deadline<T>(p: Promise<T>, ms: number, unrefTimer = false): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const t = setTimeout(() => reject(new Error("dbus call timeout")), ms);
  if (unrefTimer) (t as unknown as { unref?: () => void }).unref?.();
  p.then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); },
  );
  return promise;
}

/** Unref'd sleep: fires while the process lives but never keeps it alive. */
function parkTimer(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  unrefTimer(timer);
  return promise;
}

/**
 * A dbus-next connection's raw socket: no public API exposes it (no hard
 * close, no unref), it lives at `_connection.stream`. Named once so the two
 * private-path pokes below share one honest shape.
 */
interface SocketInternals {
  _connection?: { stream?: { unref?: () => void; destroy?: () => void } };
}

function unrefTimer(handle: unknown): void {
  if (handle && typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }
}

/**
 * Disconnect and HARD-close a connection's socket. `bus.disconnect()` is only
 * `stream.end()` — a graceful FIN whose FD parks in FIN_WAIT/CLOSE_WAIT
 * against a hung peer until that peer dies. Every call below owns its private
 * connection and gives up via `deadline()` first, so destroying is safe.
 */
function destroyBus(bus: dbus.MessageBus | null): void {
  try {
    bus?.disconnect();
  } catch {}
  try {
    const internals = bus as unknown as SocketInternals | null; // private path, see SocketInternals
    internals?._connection?.stream?.destroy?.();
  } catch {}
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
      destroyBus(bus);
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
    destroyBus(conn.bus);
  }
}

/**
 * PID of the process owning the daemon's bus name — one roundtrip answering
 * both "is the daemon up" (null = nobody owns the name) and "which process
 * runs it" (the owner-liveness check at adoption). `timeoutMs` is ONE
 * absolute budget covering the bus connect and every RPC.
 */
export async function daemonProcessPid(timeoutMs = 3000): Promise<number | null> {
  const until = Date.now() + timeoutMs;
  const conn = await connectBus(budgetLeft(until));
  if (!conn.ok || !conn.bus) return null;
  try {
    const dbusProxy = await deadline(
      conn.bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"),
      budgetLeft(until),
    );
    const driver = dbusProxy.getInterface<DriverIface & dbus.ClientInterface>("org.freedesktop.DBus");
    return await deadline(driver.GetConnectionUnixProcessID(DAEMON_NAME), budgetLeft(until));
  } catch {
    // No owner for the name (daemon absent) or the call failed — same answer.
    return null;
  } finally {
    destroyBus(conn.bus);
  }
}

/**
 * Send a state update to the daemon, plus optional run detail (the current
 * tool name — menu header/tooltip text). Resolves true iff the daemon
 * accepted the state; false when the daemon is unreachable or the send fails
 * — the caller decides on recovery. The detail RPC rides the SAME connection
 * and is best-effort: a failure there (e.g. an older daemon without
 * SetDetail) never fails the state send. Never blocks the agent loop on tray
 * IPC. `timeoutMs` is ONE absolute budget covering the bus connect and every
 * RPC.
 */
export async function sendState(state: DaemonState, detail?: string, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const conn = await connectBus(budgetLeft(until));
  if (!conn.ok || !conn.bus) return false;
  try {
    const proxy = await deadline(conn.bus.getProxyObject(DAEMON_NAME, DAEMON_PATH), budgetLeft(until));
    const control = proxy.getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE);
    await deadline(control.SetState(state), budgetLeft(until));
    if (detail !== undefined) {
      await deadline(control.SetDetail(detail), budgetLeft(until)).catch(() => {});
    }
    return true;
  } catch {
    // Daemon not up yet, or vanished — caller recovers (respawn + reseed).
    return false;
  } finally {
    destroyBus(conn.bus);
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
    destroyBus(conn.bus);
  }
}

/** Interval between liveness probes of the action-listener connection. */
const ACTION_PROBE_INTERVAL_MS = 30_000;

/**
 * Subscribe to the daemon's menu actions. ONE persistent session-bus
 * connection whose signal match is addressed by the well-known daemon name.
 * A daemon respawn swaps the unique name behind that name, and dbus-next
 * filters delivered signals by its cached owner — so the subscription
 * re-opens on every name re-ownership (see the NameOwnerChanged watch).
 *
 * The connection self-heals like the daemon's own link: reconnect after a
 * bus `error`, and probe liveness every `probeMs` — pending calls never
 * settle on a clean socket close (no event), the same dbus-next defect the
 * daemon's self-probe exists for, so silence must be tested, not assumed.
 *
 * Fire-and-forget by design: never awaited from the agent flow, handler
 * errors are warn-only. Returns a disposer that stops the loop (tests).
 *
 * @internal `probeMs` injectable for tests (default 30 s).
 */
export function watchSessionActions(
  onAction: (action: string, arg: string) => void,
  timeoutMs = 3000,
  probeMs: number = ACTION_PROBE_INTERVAL_MS,
): () => void {
  let stopped = false;

  void (async () => {
    while (!stopped) {
      const conn = await connectBus(timeoutMs);
      if (stopped) {
        destroyBus(conn.bus);
        return;
      }
      if (!conn.bus) {
        await parkTimer(timeoutMs);
        continue;
      }
      const bus = conn.bus;
      try {
        // Settled by the bus `error` event or a name re-ownership. A mutable
        // callback, not a shared promise raced per probe tick — reactions on
        // a promise that only settles at connection death would pile up one
        // per tick for the life of the connection.
        let die: (() => void) | null = null;
        bus.on("error", () => die?.());
        const proxy = await deadline(bus.getProxyObject(DAEMON_NAME, DAEMON_PATH), timeoutMs, true);
        const control = proxy.getInterface<DaemonActionSource & dbus.ClientInterface>(DAEMON_IFACE);
        control.on("SessionAction", (action, arg) => {
          try {
            onAction(action, arg);
          } catch (e) {
            console.warn("[omptray] session action handler failed:", (e as Error).message);
          }
        });
        const driverProxy = await deadline(
          bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"),
          timeoutMs,
          true,
        );
        const driver = driverProxy.getInterface<DriverIface & dbus.ClientInterface>("org.freedesktop.DBus");
        // dbus-next drops any signal whose sender is not the CACHED owner of
        // the well-known name (proxy-interface.js), and that cache only
        // re-learns from a delivered NameOwnerChanged or a call reply FROM
        // the name. A respawned daemon owns the name under a NEW unique id,
        // so without this watch every later SessionAction is dropped as a
        // foreign sender — menu clicks dead after one daemon restart. A new
        // owner tears the connection down: the reconnect's introspection
        // re-learns the owner and re-subscribes.
        driver.on("NameOwnerChanged", (name: string, _oldOwner: string, newOwner: string) => {
          if (name === DAEMON_NAME && newOwner !== "") die?.();
        });
        // Event-loop neutrality: a short-lived process that merely loads the
        // extension entry (omp install) must be able to exit — the persistent
        // socket and every park/probe timer are unref'd, so the subscription
        // lives as long as the host lives but never keeps it alive.
        // ponytail: upgrade path an unref handle from dbus-next.
        const internals = bus as unknown as SocketInternals | null; // private path, see SocketInternals
        internals?._connection?.stream?.unref?.();
        // Park until the connection dies: an explicit error event, a name
        // re-ownership, or a failed liveness probe (NameHasOwner — `false` is
        // a HEALTHY answer: an absent daemon is valid, the name-based match
        // revives with it).
        while (!stopped) {
          const wake = Promise.withResolvers<"dead" | "tick">();
          const park = setTimeout(() => wake.resolve("tick"), probeMs);
          unrefTimer(park);
          die = () => {
            clearTimeout(park); // settled race: no dangling probe timer
            wake.resolve("dead");
          };
          const woke = await wake.promise;
          if (stopped || woke === "dead") break;
          const alive = await deadline(driver.NameHasOwner(DAEMON_NAME), timeoutMs, true).then(
            () => true,
            () => false,
          );
          if (!alive) break;
        }
      } catch {
        // Subscribe failed (daemon absent, connect broken) — bounded pause.
        await parkTimer(timeoutMs);
      } finally {
        destroyBus(bus);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
