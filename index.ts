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
import { daemonAlive, daemonProcessPid, sendState, stopDaemon, watchSessionActions } from "./ipc";


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
// /tray restart all pass the daemonProcessPid() probe before any of them has
// spawned, so each would run its own Bun.spawn. daemonPid is last-write-wins:
// when an extra spawn loses the daemon's exclusive name slot and exits,
// daemonPid names the DEAD loser and the exit hook signals nothing — the
// surviving daemon (also ours) still dies with this process via its owner
// watchdog, so at worst its icon lingers one poll past a clean exit.
// ensureInFlight is cleared when the attempt settles so later re-ensures can
// start a fresh one.
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

/**
 * True when `pid` has no living parent — a daemon orphaned by an owner that
 * died without signaling it (every daemon predating the owner watchdog, plus
 * any hard-killed owner). Such a daemon is bound to no app and can never
 * disappear with one: the stale-icon case. Replaced at adoption, never
 * adopted.
 * ponytail: ppid 1 is the orphan signal; a subreaper-reparented orphan reads
 * as owned. Upgrade path: daemon-side owner-pid handshake.
 *
 * @internal `statOf` injectable for tests.
 */
export function isOwnerless(
  pid: number,
  statOf: (pid: number) => string = (p) => readFileSync(`/proc/${p}/stat`, "utf8"),
): boolean {
  try {
    // stat is "pid (comm) state ppid ..."; comm may contain spaces/parens.
    const stat = statOf(pid);
    const ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    return ppid === "1";
  } catch {
    return true; // vanished mid-check — definitely not owned
  }
}

/**
 * Wait until the daemon's exclusive name slot is free (the dying daemon must
 * release it before a respawn, or the fresh daemon loses the slot race and
 * exits). Bounded by `ms`; true iff the slot is free.
 */
async function waitGone(ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  let alive = await daemonAlive(300);
  while (alive && Date.now() < until) {
    await sleep(100);
    alive = await daemonAlive(300);
  }
  return !alive;
}

async function ensureDaemonAttempt(): Promise<boolean> {
  const pid = await daemonProcessPid();
  // Adopt only an owner-bound daemon (another live omp owns the shared slot):
  // its icon already tracks a live app.
  if (pid !== null && !isOwnerless(pid)) return true;
  if (pid !== null) {
    // Owner-less daemon on the slot: replace it with an owner-bound one so the
    // icon can again disappear with its app. Wait for its slot to free first
    // (the /tray restart shape).
    await stopDaemon();
    if (!(await waitGone())) return false;
  }
  const runner = resolveDaemonRunner();
  if (!runner) return false;
  try {
    // argv[2] = our pid: the daemon's owner-watchdog target — it exits when
    // this process dies, whatever the death mode (see daemon.ts).
    const proc = Bun.spawn([runner, DAEMON_SCRIPT, String(process.pid)], {
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

// Instant synchronous kill on CLEAN exits (quit, process.exit, drained loop).
// process.on("exit") never runs on signal death (SIGHUP terminal close,
// SIGINT, SIGTERM, SIGKILL — verified empirically), so those are covered by
// the daemon's owner watchdog instead. PID-targeted with a /proc identity
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

// Tray-menu agent actions flow daemon → extension as SessionAction signals.
// ONE listener per process, started once: omp re-binds extension factories
// per subagent (child) session without re-evaluating the module, and two live
// subscriptions would deliver every menu click twice (double prompts).
// actionRoute is last-write-wins like daemonPid — the newest factory's
// session handles the actions.
let actionRoute: ((action: string, arg: string) => void) | null = null;
let actionListenerStarted = false;

function ensureActionListener() {
  if (actionListenerStarted) return;
  actionListenerStarted = true;
  // Fire-and-forget: watchSessionActions owns its reconnect loop and warns on
  // handler errors; nothing here may block or reject into the omp flow.
  void watchSessionActions((action, arg) => actionRoute?.(action, arg));
}

export default function ompTray(pi: ExtensionAPI) {
  // Deliberately NO globalThis generation/staleness guard (the v1.3.0 one is
  // removed): omp re-binds extension factories in-process per subagent
  // (child) session WITHOUT re-evaluating the module, so a generation counter
  // silences the parent's handlers and drops queued sends the moment any
  // subagent has run — dropping the final "idle" strands the icon at
  // "working". Double-load duplicates without the guard are benign: same
  // events → identical sends, and the daemon's SetState is idempotent.

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
      // Reseed even when the ensure failed (daemonReady = ok): a failed
      // ensure is not final — the daemon may appear moments later (another
      // omp spawning it), and this forced reseed is the retry that rescues a
      // lost final "idle". Skipping it left the controller's dedupe to
      // swallow the next identical idle — stuck spinner.
      await controller.reseed();
    })();
  }

  const controller = new TrayController(pi, async (s, detail) => {
    if (!(await sendState(s, detail))) recover();
  });
  controller.attach();

  // Route the tray menu's agent actions to THIS session. Trust boundary:
  // only the daemon can emit SessionAction (bus matches sender=name), but the
  // action kind is still validated — unknown kinds are dropped with a warn.
  // "prompt" texts are BY DESIGN arbitrary: they are the menu's quick prompts
  // the user clicked.
  actionRoute = (action, arg) => {
    if (action === "abort") {
      controller.interrupt();
      return;
    }
    if (action === "prompt" && arg) {
      // omp semantics: idle → starts a turn; streaming → queues as steer.
      pi.sendUserMessage(arg);
      return;
    }
    pi.logger?.warn?.(`[omp-tray] ignoring unknown tray action: ${String(action)}`);
  };
  ensureActionListener();

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
    if (await ensureDaemon()) await controller.force("idle");
  });

  // Session switch is the same re-ensure (the daemon may have been stopped on
  // the session we are leaving) minus the state forcing: switching sessions
  // does not mean the agent went idle. Name per types.ts on() overload.
  pi.on("session_switch", () => {
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
        // ensureDaemon() ran while the slot was still owned, it would adopt
        // the dying daemon and never spawn a fresh one.
        if (!(await waitGone())) {
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

  // Deliberately NO pi.on("session_shutdown", killOwnDaemon): hazardous — the
  // event also fires when a subagent CHILD session is disposed (omp re-binds
  // extension factories per child session: same module scope, shared
  // daemonPid), so a child's dispose would kill the shared daemon
  // mid-parent-turn. The controller maps session_shutdown to the icon state
  // itself; teardown is killOwnDaemon on clean process exits plus the
  // daemon's owner watchdog for every other death mode.
}
