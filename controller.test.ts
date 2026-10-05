// Self-check for the state-serialization fix. Without the chain, a stale
// "working" send resolving after a later "idle" would leave the daemon stuck
// spinning. Here a fake send simulates that reordering; the chain must force
// strictly FIFO observed order.
//
// Run: bun test controller.test.ts

import { test, expect } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TrayController } from "./controller";
import type { DaemonState } from "./ipc";

// Minimal ExtensionAPI double: captures handlers per event (same shape as
// index.test.ts's stubPi) so the mapping pins can drive them directly.
// Most tests still reach straight into transition/flashError and just need
// an `on` that absorbs registrations.
function stubApi() {
  const events = new Map<string, (event?: unknown) => unknown>();
  const api = {
    on: (event: string, handler: (event?: unknown) => unknown) => {
      events.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, events };
}

// Fire a captured handler the way omp would. Optional lookup: a pre-fix
// controller missing the handler must fail on the assertion, not crash.
async function fire(
  events: Map<string, (event?: unknown) => unknown>,
  name: string,
  event?: unknown,
): Promise<void> {
  await events.get(name)?.(event);
}

// Macrotask yield: fully drains the microtask queue before resuming, so the
// serialized chain can settle across its .then().catch() links regardless of
// how many microtask hops they add.
function drain(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

test("agent_end after agent_start settles to idle even when sends reorder", async () => {
  const observed: DaemonState[] = [];
  // Fake send: delays the "working" send until released, so it would
  // otherwise resolve AFTER the "idle" send — exactly the race that stuck
  // the tray. The chain must hold idle behind the delayed working.
  const { promise: busy, resolve: blockWorking } = Promise.withResolvers<void>();
  const send = async (s: DaemonState): Promise<void> => {
    if (s === "working") await busy;
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  // Fire both close together the way omp does (handlers not awaited by omp).
  void c["transition"]("working");
  void c["transition"]("idle");
  // Let microtasks settle; idle cannot complete until working does (chain).
  await drain();
  // Idle must NOT be observed yet — the chain holds it behind the delayed
  // working send. This is the invariant that prevents the reordering race.
  expect(observed).toEqual([]);
  blockWorking();
  // Allow the full chain to drain.
  await drain();
  // Strictly FIFO: working first, then idle. Daemon ends idle.
  expect(observed).toEqual(["working", "idle"]);
});

test("flashError routes through the chain and cannot overtake a later idle", async () => {
  const observed: DaemonState[] = [];
  const { promise: blocked, resolve: blockError } = Promise.withResolvers<void>();
  const send = async (s: DaemonState): Promise<void> => {
    if (s === "error") await blocked;
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  void c["flashError"]();
  // Immediately queue an idle transition — must wait for the error send.
  void c["transition"]("idle");
  await drain();
  expect(observed).toEqual([]);
  blockError();
  await drain();
  expect(observed).toEqual(["error", "idle"]);
});

test("force always sends, bypassing the transition dedupe", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  void c["transition"]("working");
  await drain();
  expect(observed).toEqual(["working"]);
  // Same state: transition dedupes, force (/tray working) must still send so
  // the plugin-side state and the daemon stay in sync.
  void c["transition"]("working");
  void c.force("working");
  await drain();
  expect(observed).toEqual(["working", "working"]);
});

test("reseed resends the current state after a daemon respawn", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  void c["transition"]("working");
  await drain();
  expect(observed).toEqual(["working"]);
  // Fresh daemon knows nothing — reseed must replay the current state.
  void c.reseed();
  await drain();
  expect(observed).toEqual(["working", "working"]);
});

test("reseed sends the state current when its job runs, not at call time", async () => {
  const observed: DaemonState[] = [];
  const { promise: busy, resolve: blockWorking } = Promise.withResolvers<void>();
  let firstSend = true;
  const send = async (s: DaemonState): Promise<void> => {
    if (firstSend) {
      firstSend = false;
      await busy;
    }
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  void c["transition"]("working");
  await drain(); // "working" send in flight, current = "working"
  void c["transition"]("idle"); // queued behind it
  void c.reseed(); // queued last — must NOT capture the stale "working"
  blockWorking();
  await drain();
  // The respawned daemon must learn the settled state. A call-time capture
  // lands "working" last (as if reseeded mid-flight) and the fresh daemon
  // spins forever while the plugin is idle.
  expect(observed).toEqual(["working", "idle", "idle"]);
});

test("flashError does not resend while already flashing", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const c = new TrayController(stubApi().api, send);
  void c["flashError"]();
  void c["flashError"]();
  await drain();
  // One send for two consecutive tool errors — the second only extends the
  // 5 s auto-clear timer.
  expect(observed).toEqual(["error"]);
});

test("flashError reverts to the pre-error state after errorMs", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  // 10 ms flash window, so the test only burns ~30 ms of real time.
  const c = new TrayController(stubApi().api, send, 10);
  void c["transition"]("working");
  await drain();
  void c["flashError"]();
  await drain();
  // Real-clock wait, well past the 10 ms flash window. Deliberate: fake
  // timers cannot drive this test — the flash timer must fire between chain
  // drains while drain() itself schedules real macrotasks on the same clock.
  const { promise: flashed, resolve: tick } = Promise.withResolvers<void>();
  setTimeout(tick, 30);
  await flashed;
  await drain();
  // Reverts to "working" (the pre-error state), NOT hardcoded idle.
  expect(observed).toEqual(["working", "error", "working"]);
  expect(c.state).toBe("working");
});

test("flashError measures errorMs from the error send, not from the call", async () => {
  const sent: DaemonState[] = [];
  const sentAt: number[] = [];
  const { promise: busy, resolve: blockFirst } = Promise.withResolvers<void>();
  let firstSend = true;
  const send = async (s: DaemonState): Promise<void> => {
    if (firstSend) {
      firstSend = false;
      await busy;
    }
    sent.push(s);
    sentAt.push(performance.now());
  };

  const errorMs = 40;
  const c = new TrayController(stubApi().api, send, errorMs);
  void c["transition"]("working"); // first send: gated mid-flight
  await drain();
  const tFlash = performance.now();
  void c["flashError"](); // queued behind the gated send
  // Real-clock waits below: fake timers cannot drive this test — the
  // call-time-armed timer (pre-fix) and the send-time-armed timer must fire
  // in the gaps BETWEEN real chain drains, and that interleaving lives in
  // the platform clock, not in an advanceTimersByTime step.
  // Hold the chain past errorMs: a call-time timer would fire (and revert)
  // before the error ever went out, truncating the flash to ~0.
  const { promise: held, resolve: unhold } = Promise.withResolvers<void>();
  setTimeout(unhold, errorMs + 30);
  await held;
  blockFirst();
  await drain(); // "working" then "error" are out now
  // Wait out the revert window: it runs ~errorMs after the error send.
  const { promise: ticked, resolve: tick } = Promise.withResolvers<void>();
  setTimeout(tick, 2 * errorMs);
  await ticked;
  await drain();

  const errIdx = sent.indexOf("error");
  expect(errIdx).toBeGreaterThan(-1);
  expect(sent[errIdx + 1]).toBe("working"); // reverts to the pre-flash state
  const tError = sentAt[errIdx]!;
  const tRevert = sentAt[errIdx + 1]!;
  // The window runs from the send, not from flashError() — a queued flash
  // must not burn its errorMs inside the chain backlog.
  expect(tRevert - tError).toBeGreaterThanOrEqual(errorMs * 0.6);
  expect(tRevert - tError).toBeLessThanOrEqual(errorMs + 150);
  expect(tRevert - tFlash).toBeGreaterThan(errorMs);
});

test("flashError/transition/flashError burst still reverts to the pre-flash state", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const errorMs = 10;
  const c = new TrayController(stubApi().api, send, errorMs);
  void c["transition"]("working");
  await drain();
  // Rapid burst before the chain drains: the middle transition's job clears
  // whatever timer was armed at call time, so the second flash must re-arm
  // when ITS error goes out — otherwise "error" never clears.
  void c["flashError"]();
  void c["transition"]("working");
  void c["flashError"]();
  await drain();
  // Real-clock wait past the flash window (fake timers can't drive this —
  // the flash timer must fire between chain drains).
  const { promise: flashed, resolve: tick } = Promise.withResolvers<void>();
  setTimeout(tick, 3 * errorMs);
  await flashed;
  await drain();
  // Ends on the pre-flash state ("working"), not stuck "error".
  expect(c.state).toBe("working");
  expect(observed.at(-1)).toBe("working");
});

test("cache-warm idle replays cannot reopen working (no before_provider_request mapping)", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const { api, events } = stubApi();
  const c = new TrayController(api, send);
  c.attach();
  await fire(events, "agent_start", {});
  await fire(events, "agent_end", {});
  await drain();
  expect(observed).toEqual(["working", "idle"]);

  // The user bug: prompt-cache idle warming replays provider calls while
  // idle with no run around them. Pre-fix this mapped
  // before_provider_request → "working" and stranded it
  // (["working","idle","working"], no agent_end anywhere).
  await fire(events, "before_provider_request", {});
  await drain();
  expect(observed).toEqual(["working", "idle"]);
});

test("non-loop tool_result while idle: success ignored, error still flashes", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const { api, events } = stubApi();
  // 50 ms flash window: long enough that the auto-revert cannot race the
  // assertions below, short enough to leave no dangling timer.
  const c = new TrayController(api, send, 50);
  c.attach();
  await drain();
  // Standalone tool dispatches (AskTool, extension-driven runs) fire
  // tool_result with no run around them — success must not flip to working.
  await fire(events, "tool_result", { isError: false });
  await drain();
  expect(observed).toEqual([]);
  // Errors stay visible even outside a run (ungated, self-reverting flash).
  await fire(events, "tool_result", { isError: true });
  await drain();
  expect(observed).toEqual(["error"]);
});

test("willContinue agent_end is not a terminal: the run window stays open", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const { api, events } = stubApi();
  const c = new TrayController(api, send);
  c.attach();
  await fire(events, "agent_start", {});
  await fire(events, "agent_end", { willContinue: true });
  await drain();
  // A continuation is already scheduled: idle here would flash a false
  // terminal between steps of one visible run.
  expect(observed).toEqual(["working"]);
  expect(c.state).toBe("working");
  // Window still open: events inside the continuation keep mapping to
  // working. force("error") is an external override that moves current away
  // from "working", so the mapping shows up as a send instead of being
  // deduped by the transition same-state check.
  await c.force("error");
  await fire(events, "tool_execution_start", {});
  await drain();
  expect(observed).toEqual(["working", "error", "working"]);
  // Terminal settle closes the window.
  await fire(events, "agent_end", {});
  await drain();
  expect(observed).toEqual(["working", "error", "working", "idle"]);
});

test("session switches close a window that never got its agent_end", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const { api, events } = stubApi();
  const c = new TrayController(api, send);
  c.attach();
  // A mid-turn switch disconnects the listeners before the abort, so
  // agent_end never arrives — the transition event is the only idle close.
  await fire(events, "agent_start", {});
  await fire(events, "session_before_switch", {});
  await drain();
  expect(observed).toEqual(["working", "idle"]);
  // And again via session_switch (hosts that skip the before-hook).
  await fire(events, "agent_start", {});
  await fire(events, "session_switch", {});
  await drain();
  expect(observed).toEqual(["working", "idle", "working", "idle"]);
});

test("session_shutdown settles a child-stranded working", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const { api, events } = stubApi();
  const c = new TrayController(api, send);
  c.attach();
  // Subagent child sessions dispose (and emit this) before their abort
  // swallows agent_end — a child run's working must not outlive it.
  await fire(events, "agent_start", {});
  await fire(events, "session_shutdown", {});
  await drain();
  expect(observed).toEqual(["working", "idle"]);
});
