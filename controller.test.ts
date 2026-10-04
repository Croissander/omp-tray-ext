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

// Minimal stub: we drive transitions directly through the controller's
// internal transition/flashError, no real event emitter needed.
function stubApi(): ExtensionAPI {
  return { on: () => {} } as unknown as ExtensionAPI;
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

  const c = new TrayController(stubApi(), send);
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

  const c = new TrayController(stubApi(), send);
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

  const c = new TrayController(stubApi(), send);
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

  const c = new TrayController(stubApi(), send);
  void c["transition"]("working");
  await drain();
  expect(observed).toEqual(["working"]);
  // Fresh daemon knows nothing — reseed must replay the current state.
  void c.reseed();
  await drain();
  expect(observed).toEqual(["working", "working"]);
});

test("flashError does not resend while already flashing", async () => {
  const observed: DaemonState[] = [];
  const send = async (s: DaemonState): Promise<void> => {
    observed.push(s);
  };

  const c = new TrayController(stubApi(), send);
  void c["flashError"]();
  void c["flashError"]();
  await drain();
  // One send for two consecutive tool errors — the second only extends the
  // 5 s auto-clear timer.
  expect(observed).toEqual(["error"]);
});
