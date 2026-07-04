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
 * Mapping (the daemon renders: idle=">_", working=spinner, error="!!"):
 *  - session_start / agent_end → idle (turn_end ignored; it fires mid-loop)
 *  - agent_start / tool_execution_start → working
 *  - before_provider_request / assistant message_start → working
 *  - tool_result(isError) → error (transient; cleared by the next turn event)
 *  - (shutdown handled by index.ts: stops the daemon on quit)
 */
export class TrayController {
  private current: DaemonState = "idle";
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
    /** @internal injectable for tests; defaults to the DBus client. */
    private send: (s: DaemonState) => Promise<void> = sendState,
  ) {}

  private transition(state: DaemonState): Promise<void> {
    // Catch so a failing send (e.g. timeout) can't reject the chain and wedge
    // every later state — that would reproduce the stuck-spinning bug.
    this.chain = this.chain
      .then(async () => {
        if (this.errorClearTimer) {
          clearTimeout(this.errorClearTimer);
          this.errorClearTimer = null;
        }
        if (this.current === state) return;
        this.current = state;
        await this.send(state);
      })
      .catch(() => {});
    return this.chain;
  }

  // Error is transient: show "!!" briefly, then revert to idle/working.
  private flashError() {
    // Routed through the chain too, so an un-awaited "error" send can't
    // overtake a subsequent "idle"/"working" and wedge the daemon.
    this.chain = this.chain
      .then(async () => {
        this.current = "error";
        await this.send("error");
      })
      .catch(() => {});
    if (this.errorClearTimer) clearTimeout(this.errorClearTimer);
    this.errorClearTimer = setTimeout(() => {
      this.errorClearTimer = null;
      void this.transition("idle");
    }, 5000);
  }

  attach() {
    this.pi.on("session_start", async () => {
      await this.transition("idle");
    });

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

    this.pi.on("turn_end", async () => {
      // turn_end fires between sub-turns in a multi-step turn; don't flip to
      // idle here. Only agent_end marks the whole agent loop as done.
    });

    this.pi.on("agent_end", async () => {
      await this.transition("idle");
    });
  }
}
