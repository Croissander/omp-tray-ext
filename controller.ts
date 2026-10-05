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
 *  - agent_end → idle (turn_end ignored; it fires mid-loop)
 *  - agent_start / tool_execution_start → working
 *  - before_provider_request / assistant message_start → working
 *  - tool_result(isError) → error (transient; reverts to the pre-error
 *    state after errorMs)
 *  - (shutdown handled by index.ts: stops the daemon on quit)
 */
export class TrayController {
  private current: DaemonState = "idle";
  private revertTo: DaemonState = "idle";
  private errorClearTimer: TimerHandle | null = null;
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
      await this.transition("working");
    });

    this.pi.on("before_provider_request", async () => {
      await this.transition("working");
    });

    this.pi.on("message_start", async (event) => {
      if (messageRole(event.message) === "assistant") {
        await this.transition("working");
      }
    });

    this.pi.on("tool_execution_start", async () => {
      await this.transition("working");
    });

    this.pi.on("tool_result", async (event) => {
      if (event.isError) {
        this.flashError();
        return;
      }
      await this.transition("working");
    });

    this.pi.on("agent_end", async () => {
      await this.transition("idle");
    });
  }
}
