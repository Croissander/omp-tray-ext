// oh-my-pi tray extension: a native Linux status-bar indicator.
//
// Spawns a detached daemon (daemon.ts) that owns the DBus StatusNotifierItem.
// One daemon serves every omp on the session bus (shared icon, last writer
// wins); teardown signals only the daemon this process spawned. The extension
// forwards agent lifecycle events to the daemon over DBus IPC and respawns it
// mid-turn when a send fails. The tray shows:
//   idle    ">_"   (prompt glyph)
//   working  spinning ring (a rotated circle with a chunk missing)
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TrayController } from "./controller";
import { daemonAlive, sendState, stopDaemon } from "./ipc";


const DAEMON_SCRIPT = fileURLToPath(new URL("./daemon.ts", import.meta.url));
/** Fork the daemon detached so it outlives this omp process. */
let daemonPid: number | null = null;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Resolve the TS runtime that runs daemon.ts: `bun` from PATH, else the host
 * binary when the host itself is bun. NEVER `process.execPath` blindly — inside
 * omp (Bun-compiled) it is omp, and spawning `omp run daemon.ts` starts another
 * omp session that auto-loads this extension and spawns again without bound
 * (process storm that froze the machine, 2026-10-05). Missing runner = "no
 * tray", never "spawn the host".
 *
 * @internal `which`/`execPath` injectable for tests (see index.test.ts).
 */
export function resolveDaemonRunner(
  which: (name: string) => string | null = Bun.which,
  execPath: string = process.execPath,
): string | null {
  return which("bun") ?? (basename(execPath) === "bun" ? execPath : null);
}

// Single-flight spawn attempt shared by overlapping callers: the load-time
// ensureDaemon(), the session_start/session_switch handlers, recover() and
// /tray restart all pass the daemonAlive() probe before any of them has
// spawned, so each would run its own Bun.spawn. daemonPid is last-write-wins:
// when an extra spawn loses the daemon's exclusive name slot and exits,
// daemonPid names the DEAD loser while the surviving daemon (also ours) is
// never killed at exit — orphaned icon. Cleared when the attempt settles so
// later re-ensures can start a fresh one.
let ensureInFlight: Promise<boolean> | null = null;

/**
 * Ensure a tray daemon is running: adopt one that is already alive (another
 * omp may own the shared slot), else spawn one and wait for its DBus name.
 * Concurrent callers share a single spawn attempt.
 *
 * @internal exported for the single-flight pin in index.test.ts.
 */
export function ensureDaemon(): Promise<boolean> {
  if (ensureInFlight) return ensureInFlight;
  const attempt = ensureDaemonAttempt().finally(() => {
    ensureInFlight = null;
  });
  ensureInFlight = attempt;
  return attempt;
}

async function ensureDaemonAttempt(): Promise<boolean> {
  if (await daemonAlive()) return true;
  const runner = resolveDaemonRunner();
  if (!runner) return false;
  try {
    const proc = Bun.spawn([runner, DAEMON_SCRIPT], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    proc.unref();
    daemonPid = proc.pid;
  } catch {
    return false;
  }
  // Poll until the daemon claims its DBus name — fast when Bun boots quickly,
  // resilient when startup is slow (a fixed sleep is neither). Wall-clock
  // deadline + short probe timeout: gives up in ~2-3 s even when the bus
  // connect itself hangs (each probe is capped at 300 ms).
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await daemonAlive(300)) return true;
    await sleep(100);
  }
  return false;
}

// ponytail: last-resort synchronous kill on ANY exit path (session_shutdown,
// SIGHUP terminal close, SIGTERM kill). PID-targeted with a /proc identity
// check: PID reuse could signal an unrelated process, and an adopted daemon
// (spawned by another omp) is never ours to kill. The daemon's SIGTERM
// handler removes the SNI item cleanly. Linux-only check is fine — the
// extension is Linux-only (SNI/DBus).
function killOwnDaemon() {
  if (daemonPid === null) return;
  try {
    // cmdline is NUL-separated argv — DAEMON_SCRIPT matches the path arg.
    const cmdline = readFileSync(`/proc/${daemonPid}/cmdline`, "utf8");
    if (cmdline.includes(DAEMON_SCRIPT)) process.kill(daemonPid, "SIGTERM");
  } catch {
    // Dead or foreign PID — nothing to signal.
  }
}
process.on("exit", killOwnDaemon);

// Generation counter shared across module scopes — see the guard note in
// ompTray. `as unknown as` mirror of globalThis, same trick as ipc.test.ts.
const GEN = Symbol.for("omp-tray-ext.gen");
const gens = globalThis as unknown as { [key: symbol]: number | undefined };

export default function ompTray(pi: ExtensionAPI) {
  // Generation guard for double-load AND reload: extension modules
  // RE-EVALUATE on every load (fresh ?mtime import tag) while globalThis
  // persists, and the same extension can load twice in one process (two path
  // spellings → two module scopes sharing one process). Each activation bumps
  // the shared counter; every handler body it registers starts with the
  // stale() check and NO-OPS silently once a newer activation has taken over —
  // double-load collapses to one live handler set (newest wins) and a reload
  // replaces the previous activation cleanly. Deliberately NOT stale-guarded:
  // process.on("exit", killOwnDaemon) — a stale activation must still reap
  // its own spawn (the kill is PID-targeted with a /proc identity check).
  const gen = (gens[GEN] = (gens[GEN] ?? 0) + 1);
  const stale = () => gens[GEN] !== gen;

  // Mid-turn recovery: a failed send means the daemon died or lost the shared
  // slot. Respawn + reseed. NEVER awaited from inside the controller chain —
  // reseed() enqueues onto TrayController.chain, so awaiting it from a chain
  // job would deadlock the chain against itself. Single-flight: sends failing
  // during recovery are superseded by the reseed() that follows.
  let recovering = false;
  function recover() {
    if (recovering) return;
    recovering = true;
    void (async () => {
      let ok = false;
      try {
        ok = await ensureDaemon();
      } finally {
        // Drop the flag BEFORE the reseed, not after it: when the reseed's own
        // send fails, the nested recover() it triggers must be able to start a
        // NEW recovery — clearing afterwards suppressed that nested recover()
        // and left nothing to retry once the flag dropped.
        recovering = false;
      }
      if (ok) await controller.reseed();
    })();
  }

  // The send wrapper is stale-guarded like the handlers: a stale activation's
  // controller still runs its transitions, but they must not reach the bus.
  const controller = new TrayController(pi, async (s) => {
    if (stale()) return;
    if (!(await sendState(s))) recover();
  });
  controller.attach();

  // Spawn the daemon at load time so the tray appears immediately — not on
  // first prompt. Fire-and-forget: the daemon defaults to "idle" on its own.
  void ensureDaemon().then((ok) => {
    if (!ok) pi.logger?.warn?.("[omp-tray] could not start tray daemon");
    else pi.logger?.info?.("[omp-tray] tray daemon ready");
  });

  // Re-ensure after reload (the daemon may have been stopped while we were
  // gone). force("idle") resets a stale "working" for a new session and
  // force-sends through the controller chain so a fresh daemon learns where
  // we are — never a bare sendState, which could reorder against a queued
  // transition.
  pi.on("session_start", async () => {
    if (stale()) return;
    if (await ensureDaemon()) await controller.force("idle");
  });

  // Session switch is the same re-ensure (the daemon may have been stopped on
  // the session we are leaving) minus the state forcing: switching sessions
  // does not mean the agent went idle. Name per types.ts on() overload.
  pi.on("session_switch", () => {
    if (stale()) return;
    void ensureDaemon();
  });

  // `/debug` is an omp builtin, so debug lives as `/tray debug` to avoid the
  // reserved-name collision (the extension runner silently skips conflicts).
  const SUBCOMMANDS = [
    { name: "status", description: "Show daemon running state (default)" },
    { name: "stop", description: "Stop the tray daemon" },
    { name: "off", description: "Alias for stop" },
    { name: "restart", description: "Stop and restart the daemon" },
    { name: "working", description: "Force the tray to working" },
    { name: "error", description: "Force the tray to error" },
    { name: "debug", description: "Show plugin/daemon state for troubleshooting" },
  ] as const;

  pi.registerCommand("tray", {
    description: "Control the persistent omp tray daemon",
    getArgumentCompletions: (argumentPrefix) => {
      if (argumentPrefix.includes(" ")) return null;
      const lower = argumentPrefix.toLowerCase();
      const matches = SUBCOMMANDS.filter((s) => s.name.startsWith(lower));
      return matches.length > 0
        ? matches.map((s) => ({ value: `${s.name} `, label: s.name, description: s.description }))
        : null;
    },
    handler: async (args, ctx) => {
      if (stale()) return;
      const arg = args.trim().toLowerCase();
      if (arg === "stop" || arg === "off") {
        await stopDaemon();
        ctx.ui.notify("Tray daemon stopped", "info");
        return;
      }
      if (arg === "restart") {
        // Fail honestly: stopDaemon() resolves true only when the Stop() RPC
        // completed, and a daemon still alive at the wait deadline may still
        // own the shared slot — ensureDaemon() would ADOPT it and report a
        // false "restarted". Neither failure may spawn or adopt; just report.
        if (!(await stopDaemon())) {
          ctx.ui.notify("Tray restart failed", "error");
          return;
        }
        // Wait until the old daemon is actually gone before respawning: if
        // ensureDaemon() ran while daemonAlive() was still true, it would
        // adopt the dying daemon and never spawn a fresh one. Bounded ~2 s.
        const deadline = Date.now() + 2000;
        let alive = await daemonAlive(300);
        while (alive && Date.now() < deadline) {
          await sleep(100);
          alive = await daemonAlive(300);
        }
        if (alive) {
          ctx.ui.notify("Tray restart failed", "error");
          return;
        }
        const ok = await ensureDaemon();
        if (ok) await controller.reseed();
        ctx.ui.notify(ok ? "Tray daemon restarted" : "Tray restart failed", ok ? "info" : "error");
        return;
      }
      if (arg === "working" || arg === "error") {
        await controller.force(arg);
        ctx.ui.notify(`Tray state: ${arg}`, "info");
        return;
      }
      if (arg === "debug") {
        const daemonRunning = await daemonAlive();
        const lines = [
          `daemon running : ${daemonRunning}`,
          `daemon pid    : ${daemonPid ?? "(none)"}`,
          `plugin state  : ${controller.state}`,
          `daemon script : ${DAEMON_SCRIPT}`,
          `model         : ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}`,
          `agent idle    : ${ctx.isIdle()}`,
          `cwd           : ${ctx.cwd}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const alive = await daemonAlive();
      ctx.ui.notify(alive ? "Tray daemon running (persistent)" : "Tray daemon not running", alive ? "info" : "error");
    },
  });

  // session_shutdown fires on process exit (SIGINT/SIGTERM, /quit, /exit).
  // Signal only the daemon this process spawned (killOwnDaemon): with an
  // adopted daemon — another omp spawned it — name-targeted stopDaemon()
  // would stop that omp's tray. /tray stop|off|restart keep stopDaemon():
  // an explicit user command targets the shared slot.
  pi.on("session_shutdown", async () => {
    if (stale()) return;
    killOwnDaemon();
  });
}
