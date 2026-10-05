// Wires omp extension events to the tray daemon over DBus IPC.
// The daemon owns the persistent SNI tray; this controller just forwards
// state transitions and never blocks the agent loop on tray IPC.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { sendState, type DaemonState } from "./ipc";

/** Handle for the error-clear setTimeout timer. */
type TimerHandle = NodeJS.Timeout;


function messageRole(message: unknown): string | undefined {
  if (typeof message === "object" && message !== null && "role" in message) {
    const role = (message as { role: unknown }).role;
    return typeof role === "string" ? role : undefined;
  }
  return undefined;
}

/**
 * Mapping (the daemon renders: idle=">_", working=spinner, error="X"):
 *  - agent_start → working; agent_end(willContinue falsy) → idle
 *  - assistant message_start / tool_execution_start / tool_result → working,
 *    only inside the agent_start..terminal agent_end window (`inRun`)
 *  - tool_result(isError) → error anywhere (transient; reverts to the
 *    pre-error state after errorMs)
 *  - session_before_switch / session_switch / session_shutdown → idle
 *    (a mid-turn switch swallows agent_end; these are the only idle signal)
 *  - (shutdown handled by index.ts: stops the daemon on quit)
 *
 * before_provider_request is deliberately UNMAPPED and must NEVER be
 * re-added: prompt-cache idle warming replays provider calls while idle with
 * no run around them, so mapping it flips the tray to working with no
 * agent_end to settle it back — the stuck-working bug this gating exists to
 * prevent. In-run it would be redundant anyway (agent_start / assistant
 * message_start / tool_execution_start already cover every run).
 */
export class TrayController {
  private current: DaemonState = "idle";
  private revertTo: DaemonState = "idle";
  private errorClearTimer: TimerHandle | null = null;
  // True between agent_start and its terminal agent_end. Working-mapped
  // events are only trusted inside this window: some sources fire with no
  // agent_end to settle them back (non-loop tool_result from standalone tool
  // dispatches, idle cache-warm provider replays) and would strand "working".
  private inRun = false;
  // ponytail: serializes state changes so the daemon sees them in the same
  // order the extension emits them. Each sendState opens its own DBus
  // connection (ipc.connectBus) with no cross-connection FIFO, so two
  // concurrent transitions can reorder — a stale "working" landing after a
  // later "idle" leaves the tray spinning forever. The chain forces call B
  // to wait for call A's sendState to resolve before starting.
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private pi: ExtensionAPI,
    /** @internal injectable for tests; defaults to the DBus client.
     *  The controller ignores the result (ipc.sendState reports success). */
    private send: (s: DaemonState) => Promise<unknown> = sendState,
    /** @internal injectable for tests; error flash duration in ms. */
    private errorMs = 5000,
  ) {}

  /** Current plugin-side state (last value forwarded toward the daemon). */
  get state(): DaemonState {
    return this.current;
  }

  /**
   * Queue one state send on the chain. A function state resolves INSIDE the
   * job, not at call time: `current`/`revertTo` only advance when queued jobs
   * run, so a call-time capture can replay a stale state (and the dedupe then
   * swallows the real one — stuck spinner).
   */
  private transition(
    state: DaemonState | (() => DaemonState),
    force = false,
  ): Promise<void> {
    // Catch so a failing send (e.g. timeout) can't reject the chain and wedge
    // every later state — that would reproduce the stuck-spinning bug.
    this.chain = this.chain
      .then(async () => {
        if (this.errorClearTimer) {
          clearTimeout(this.errorClearTimer);
          this.errorClearTimer = null;
        }
        const next = typeof state === "function" ? state() : state;
        if (!force && this.current === next) return;
        this.current = next;
        await this.send(next);
      })
      .catch(() => {});
    return this.chain;
  }

  /** External override (/tray working|error): always sends so the daemon and
   *  the plugin-side state stay in sync. */
  force(state: DaemonState): Promise<void> {
    return this.transition(state, true);
  }

  /** Re-send the current state through the chain — after the daemon was
   *  (re)spawned, so the fresh daemon learns where we are. `current` is read
   *  inside the job (like `revertTo`): with a chain backlog a call-time
   *  capture replays a stale state and the fresh daemon gets stuck on it. */
  reseed(): Promise<void> {
    return this.transition(() => this.current, true);
  }

  // Error is transient: show "X" briefly (errorMs), then revert to the state
  // that was current before the flash (working or idle).
  private flashError() {
    // Routed through the chain too, so an un-awaited "error" send can't
    // overtake a subsequent "idle"/"working" and wedge the daemon. Both the
    // revert target and the revert timer start inside the job: `current` only
    // advances when queued jobs run, and a call-time timer burns the flash
    // inside any chain backlog (and strands it if a later job clears that
    // timer). A flash already showing just extends the live timer instead of
    // sending "error" twice.
    this.chain = this.chain
      .then(async () => {
        if (this.current === "error") {
          this.armErrorTimer();
          return;
        }
        this.revertTo = this.current;
        this.current = "error";
        try {
          await this.send("error");
        } finally {
          // Armed even when the send failed, so `current` cannot wedge on
          // "error" with no timer left to clear it.
          this.armErrorTimer();
        }
      })
      .catch(() => {});
  }

  // Always replaces the previous handle, so overlapping flashes never leak
  // timers.
  private armErrorTimer() {
    clearTimeout(this.errorClearTimer ?? undefined);
    this.errorClearTimer = setTimeout(() => {
      this.errorClearTimer = null;
      // Revert target is read when the revert is sent, not when armed.
      void this.transition(() => this.revertTo);
    }, this.errorMs);
  }

  attach() {
    this.pi.on("agent_start", async () => {
      this.inRun = true;
      await this.transition("working");
    });

    // Working-mapped handlers below are gated on `inRun`: the unbracketed
    // sources (non-loop tool_result from standalone tool dispatches, idle
    // cache-warm provider replays) fire outside any run, and a "working"
    // send from them has no agent_end to settle it back — stuck spinner.
    this.pi.on("message_start", async (event) => {
      if (!this.inRun) return;
      if (messageRole(event.message) === "assistant") {
        await this.transition("working");
      }
    });

    this.pi.on("tool_execution_start", async () => {
      if (!this.inRun) return;
      await this.transition("working");
    });

    this.pi.on("tool_result", async (event) => {
      // Errors flash UNGATED (self-healing: the flash reverts after errorMs):
      // a background tool failure must still surface even outside a run.
      if (event.isError) {
        this.flashError();
        return;
      }
      if (!this.inRun) return;
      await this.transition("working");
    });

    this.pi.on("agent_end", async (event) => {
      // A truthy willContinue means a continuation is already scheduled
      // (incl. awaitingAsyncWork waits): not a user-visible terminal, so
      // keep the window open and send nothing — the continuation's
      // agent_start continues the same visible run. If that continuation is
      // aborted, its terminal agent_end closes the window normally.
      if (event.willContinue) return;
      this.inRun = false;
      await this.transition("idle");
    });

    // Mid-turn session switches disconnect listeners before the abort, so
    // agent_end never arrives — the transition is the window's only idle
    // close. Bound on both names: session_before_switch is the earliest
    // bindable signal, session_switch covers hosts that skip the before-hook.
    this.pi.on("session_before_switch", async () => {
      this.inRun = false;
      await this.transition("idle");
    });
    this.pi.on("session_switch", async () => {
      this.inRun = false;
      await this.transition("idle");
    });

    // Fires on ANY session dispose (subagent child sessions included): a
    // child's dispose happens before its abort swallows agent_end, so this
    // resets a working stranded by a child run.
    this.pi.on("session_shutdown", async () => {
      this.inRun = false;
      await this.transition("idle");
    });
  }
}
