// oh-my-pi tray extension: a native Linux status-bar indicator.
//
// Spawns a detached daemon (daemon.ts) that owns the DBus StatusNotifierItem.
// The daemon is started at load and stopped on omp quit, so the tray mirrors
// the omp session's lifetime. The extension forwards agent lifecycle events
// to the daemon over DBus IPC. The tray shows:
//   idle    ">_"   (prompt glyph)
//   working  spinning ring (a rotated circle with a chunk missing)
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TrayController } from "./controller";
import { daemonAlive, sendState, stopDaemon } from "./ipc";


const DAEMON_SCRIPT = new URL("./daemon.ts", import.meta.url).pathname;
/** Fork the daemon detached so it outlives this omp process. */
let daemonPid: number | null = null;

async function ensureDaemon(): Promise<boolean> {
  if (await daemonAlive()) return true;
  try {
    const proc = Bun.spawn(["bun", "run", DAEMON_SCRIPT], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    proc.unref();
    daemonPid = proc.pid;
    // Give the daemon a moment to claim its DBus name before we send state.
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    return false;
  }
  return daemonAlive();
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
  pi.on("session_start", async () => {
    daemonReady = await ensureDaemon();
    if (daemonReady) await sendState("idle");
  });

  pi.registerCommand("tray", {
    description: "Control the persistent omp tray daemon",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "stop" || arg === "off") {
        await stopDaemon();
        ctx.ui.notify("Tray daemon stopped", "info");
        return;
      }
      if (arg === "restart") {
        await stopDaemon();
        await new Promise((r) => setTimeout(r, 300));
        daemonReady = await ensureDaemon();
        await sendState("idle");
        ctx.ui.notify(daemonReady ? "Tray daemon restarted" : "Tray restart failed", daemonReady ? "info" : "error");
        return;
      }
      if (arg === "working" || arg === "error") {
        await sendState(arg);
        ctx.ui.notify(`Tray state: ${arg}`, "info");
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
