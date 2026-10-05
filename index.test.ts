// Spawn-runner resolution: daemon.ts must run under bun, NEVER under the host
// binary — inside omp, process.execPath is omp itself and spawning it
// fork-bombed the machine (2026-10-05).
// bun test index.test.ts
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MessageBus } from "dbus-next";
import ompTray, { ensureDaemon, resolveDaemonRunner } from "./index";
import { __setSessionBusForTests } from "./ipc";

test("prefers bun from PATH over the host binary", () => {
  expect(resolveDaemonRunner(() => "/usr/bin/bun", "/home/u/.local/bin/omp")).toBe("/usr/bin/bun");
});

test("never spawns a non-bun host binary (fork-bomb pin)", () => {
  expect(resolveDaemonRunner(() => null, "/home/u/.local/bin/omp")).toBeNull();
});

test("allows the host binary when the host is bun", () => {
  expect(resolveDaemonRunner(() => null, "/usr/bin/bun")).toBe("/usr/bin/bun");
});

// --- extension-level pins: spawn single-flight, generation guard, restart ---

/** Mutable Bun.spawn slot so tests can stub it; restored in afterEach. */
const bunMut = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;

afterEach(() => {
  __setSessionBusForTests(null);
  bunMut.spawn = realSpawn;
});

/**
 * Duck-typed MessageBus fake (same surface ipc.test.ts drives): no I/O at
 * all. `alive` answers NameHasOwner, `onSetState` observes sends, `stopFails`
 * rejects the Stop() RPC so stopDaemon() resolves false.
 */
function fakeBus(opts: {
  alive?: () => boolean;
  onSetState?: (state: string) => void;
  stopFails?: boolean;
}) {
  const methods = {
    NameHasOwner: () => Promise.resolve(opts.alive?.() ?? true),
    SetState: (state: string) => {
      opts.onSetState?.(state);
      return Promise.resolve();
    },
    Stop: () => (opts.stopFails ? Promise.reject(new Error("stop failed")) : Promise.resolve()),
  };
  return {
    on(event: string, listener: () => void) {
      // Complete the handshake asynchronously like a real bus; "error"
      // listeners are accepted but never emitted.
      if (event === "connect") queueMicrotask(listener);
    },
    disconnect() {},
    getProxyObject() {
      return Promise.resolve({ getInterface: () => methods });
    },
  };
}

/** The only ctx surface the pinned command paths touch. */
interface StubCtx {
  ui: { notify(message: string, kind: string): void };
}

/** Minimal ExtensionAPI double: captures handlers/commands per activation. */
function stubPi() {
  const events = new Map<string, (event?: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: StubCtx) => Promise<void> }>();
  const api = {
    on: (event: string, handler: (event?: unknown) => unknown) => {
      events.set(event, handler);
    },
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: StubCtx) => Promise<void> },
    ) => {
      commands.set(name, spec);
    },
  } as unknown as ExtensionAPI;
  return { api, events, commands };
}

test("overlapping ensureDaemon calls share one spawn attempt (single-flight pin)", async () => {
  let spawns = 0;
  let spawned = false;
  bunMut.spawn = () => {
    spawns += 1;
    spawned = true;
    return { pid: 424242, unref() {} };
  };
  // No daemon until the spawn lands, then it claims its name — keeps the
  // attempt's poll loop to a single probe.
  __setSessionBusForTests(() => fakeBus({ alive: () => spawned }) as unknown as MessageBus);

  // Overlap deliberately: both callers arrive before any spawn has happened.
  const first = ensureDaemon();
  const second = ensureDaemon();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(spawns).toBe(1);
});

test("stale activation is silent; the newest activation sends (generation pin)", async () => {
  const sends: string[] = [];
  let spawns = 0;
  bunMut.spawn = () => {
    spawns += 1;
    return { pid: 424242, unref() {} };
  };
  // Daemon already alive (the default): every activation adopts it — the
  // load-time re-ensures included, none may spawn.
  __setSessionBusForTests(
    () => fakeBus({ onSetState: (s) => { sends.push(s); } }) as unknown as MessageBus,
  );

  const first = stubPi();
  const second = stubPi();
  ompTray(first.api);
  ompTray(second.api);

  // Fire the FIRST (stale) activation's captured handlers: one index.ts event
  // handler and one controller event whose send goes through the gen-guarded
  // wrapper. Neither may produce any bus traffic.
  const staleStart = first.events.get("session_start");
  const staleAgent = first.events.get("agent_start");
  expect(staleStart).toBeDefined();
  expect(staleAgent).toBeDefined();
  await staleStart?.({});
  await staleAgent?.({});
  expect(sends).toEqual([]);

  // The SECOND activation's handlers DO send (both event shapes).
  const freshAgent = second.events.get("agent_start");
  const freshStart = second.events.get("session_start");
  expect(freshAgent).toBeDefined();
  expect(freshStart).toBeDefined();
  await freshAgent?.({});
  expect(sends).toEqual(["working"]);
  await freshStart?.({});
  expect(sends).toEqual(["working", "idle"]);
  expect(spawns).toBe(0);
});

test("restart reports failure and spawns nothing when stop fails (restart-failure pin)", async () => {
  let spawns = 0;
  bunMut.spawn = () => {
    spawns += 1;
    return { pid: 424242, unref() {} };
  };
  // Daemon still alive and the stop path failing: restart must neither adopt
  // nor spawn — and must say so.
  __setSessionBusForTests(
    () => fakeBus({ alive: () => true, stopFails: true }) as unknown as MessageBus,
  );

  const cap = stubPi();
  ompTray(cap.api);
  const command = cap.commands.get("tray");
  expect(command).toBeDefined();

  const notes: [string, string][] = [];
  const ctx: StubCtx = {
    ui: {
      notify: (message, kind) => {
        notes.push([message, kind]);
      },
    },
  };
  await command?.handler("restart", ctx);

  expect(notes).toEqual([["Tray restart failed", "error"]]);
  expect(spawns).toBe(0);
});
