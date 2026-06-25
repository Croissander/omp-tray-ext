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

  constructor(private pi: ExtensionAPI) {}

  private async transition(state: DaemonState) {
    if (this.errorClearTimer) {
      clearTimeout(this.errorClearTimer);
      this.errorClearTimer = null;
    }
    if (this.current === state) return;
    this.current = state;
    await sendState(state);
  }

  // Error is transient: show "!!" briefly, then revert to idle/working.
  private flashError() {
    void sendState("error");
    this.current = "error";
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
