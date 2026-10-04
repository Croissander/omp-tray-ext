// oh-my-pi tray extension: a native Linux status-bar indicator.
//
// Spawns a detached daemon (daemon.ts) that owns the DBus StatusNotifierItem.
// The daemon is started at load and stopped on omp quit, so the tray mirrors
// the omp session's lifetime. The extension forwards agent lifecycle events
// to the daemon over DBus IPC. The tray shows:
//   idle    ">_"   (prompt glyph)
//   working  spinning ring (a rotated circle with a chunk missing)
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TrayController } from "./controller";
import { daemonAlive, stopDaemon } from "./ipc";


const DAEMON_SCRIPT = fileURLToPath(new URL("./daemon.ts", import.meta.url));
/** Fork the daemon detached so it outlives this omp process. */
let daemonPid: number | null = null;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function ensureDaemon(): Promise<boolean> {
  if (await daemonAlive()) return true;
  try {
    // process.execPath is the bun binary itself (omp loads extensions via
    // Bun), so we don't depend on `bun` being on the spawned process's PATH.
    const proc = Bun.spawn([process.execPath, "run", DAEMON_SCRIPT], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    proc.unref();
    daemonPid = proc.pid;
  } catch {
    return false;
  }
  // Poll until the daemon claims its DBus name — fast when Bun boots quickly,
  // resilient when startup is slow (a fixed sleep is neither).
  for (let waited = 0; waited < 2000; waited += 100) {
    if (await daemonAlive()) return true;
    await sleep(100);
  }
  return false;
}

// ponytail: last-resort synchronous kill on ANY exit path. session_shutdown
// (graceful /quit, Ctrl+C, Ctrl+D) already calls stopDaemon() over DBus, but
// SIGHUP (terminal closed) and SIGTERM (kill) skip session.dispose() entirely
// via postmortem's process.exit(). This fires on all paths; the daemon's own
// SIGTERM handler removes the SNI item cleanly. process.kill on an already-dead
// PID throws ESRCH — swallowed.
process.on("exit", () => {
  if (daemonPid !== null) {
    try { process.kill(daemonPid, "SIGTERM"); } catch {}
  }
});

export default function ompTray(pi: ExtensionAPI) {
  let daemonReady = false;

  const controller = new TrayController(pi);
  controller.attach();

  // Spawn the daemon at load time so the tray appears immediately — not on
  // first prompt. Fire-and-forget: the daemon defaults to "idle" on its own.
  void ensureDaemon().then((ok) => {
    daemonReady = ok;
    if (!ok) pi.logger?.warn?.("[omp-tray] could not start tray daemon");
    else pi.logger?.info?.("[omp-tray] tray daemon ready");
  });

  // Re-ensure after reload/session-switch (daemon may have been stopped).
  // force("idle") resets a stale "working" for a new session and force-sends
  // through the controller chain so a fresh daemon learns where we are —
  // never a bare sendState, which could reorder against a queued transition.
  pi.on("session_start", async () => {
    daemonReady = await ensureDaemon();
    if (daemonReady) await controller.force("idle");
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
        daemonReady = false;
        ctx.ui.notify("Tray daemon stopped", "info");
        return;
      }
      if (arg === "restart") {
        await stopDaemon();
        // Wait until the old daemon is actually gone before respawning: if
        // ensureDaemon() ran while daemonAlive() was still true, it would
        // adopt the dying daemon and never spawn a fresh one. Bounded ~2 s.
        for (let waited = 0; waited < 2000 && (await daemonAlive()); waited += 100) {
          await sleep(100);
        }
        daemonReady = await ensureDaemon();
        if (daemonReady) await controller.reseed();
        ctx.ui.notify(daemonReady ? "Tray daemon restarted" : "Tray restart failed", daemonReady ? "info" : "error");
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
          `daemon ready  : ${daemonReady}`,
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
  // The daemon is tied to the omp process lifetime: stop it so the tray
  // icon is removed when omp closes.
  pi.on("session_shutdown", async () => {
    await stopDaemon();
  });
}
