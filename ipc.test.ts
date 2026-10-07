// Behavior pins for the ipc.ts client. dbus-next has NO timeout machinery: a
// pending call settles only when a reply message arrives — not on disconnect,
// connection error, or bus death — so an unanswered RPC used to wedge the
// extension's serialized state chain forever. These pins hold every client
// call to its contract: always settles within the budget (connect + RPCs),
// resolves false on failure instead of throwing, and releases the bus exactly
// once on every path. Hermetic: duck-typed fake bus only, never a real session
// bus (seam is restored after every test).
// bun test ipc.test.ts

import { afterEach, expect, test } from "bun:test";
import type { MessageBus } from "dbus-next";
import { __setSessionBusForTests, daemonAlive, daemonProcessPid, deadline, sendState, stopDaemon, watchSessionActions } from "./ipc";

// Restore the real bus factory even when a test fails mid-flight.
afterEach(() => {
  __setSessionBusForTests(null);
});

/** Duck-typed MessageBus fake: no I/O at all, counts disconnect() calls. */
function fakeBus(
  methods: Record<string, () => Promise<unknown>>,
  opts: { hangIntrospection?: boolean; hangConnect?: boolean } = {},
) {
  const neverSettles = new Promise<never>(() => {});
  return {
    disconnectCount: 0,
    on(event: string, listener: () => void) {
      // Complete the handshake asynchronously like a real bus. "error"
      // listeners are accepted but never emitted: merely attaching one must
      // never be able to crash the caller.
      if (event === "connect" && !opts.hangConnect) queueMicrotask(listener);
    },
    disconnect() {
      this.disconnectCount += 1;
    },
    getProxyObject() {
      return opts.hangIntrospection
        ? neverSettles
        : Promise.resolve({ getInterface: () => methods });
    },
  };
}

const healthy = {
  NameHasOwner: () => Promise.resolve(true),
  SetState: () => Promise.resolve(),
  Stop: () => Promise.resolve(),
};

const rejecting = {
  NameHasOwner: () => Promise.reject(new Error("daemon gone")),
  SetState: () => Promise.reject(new Error("daemon gone")),
  Stop: () => Promise.reject(new Error("daemon gone")),
};

const neverSettling = {
  NameHasOwner: () => new Promise<boolean>(() => {}),
  SetState: () => new Promise<void>(() => {}),
  Stop: () => new Promise<void>(() => {}),
};

// The three client entries with one shape so every pin can drive all of them
// uniformly. The sendState entry is a real adapter, not a rename: it binds the
// state argument ("working") so the matrix can pass only the timeout.
const clientCalls = [
  ["daemonAlive", daemonAlive],
  ["sendState", (ms?: number) => sendState("working", undefined, ms)],
  ["stopDaemon", stopDaemon],
] as const;

// --- (a) deadline unit pins -------------------------------------------------

test("deadline resolves with the promise's value when the promise settles first", async () => {
  expect(await deadline(Promise.resolve(42), 1000)).toBe(42);
});

test("deadline rejects Error('dbus call timeout') when the promise never settles", async () => {
  const start = Date.now();
  const err = await deadline(new Promise<never>(() => {}), 50).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("dbus call timeout");
  expect(Date.now() - start).toBeLessThan(500);
});

test("deadline rejects promptly with the original error when the promise is already rejected", async () => {
  const start = Date.now();
  const err = await deadline(Promise.reject(new Error("boom")), 5000).then(() => null, (e: unknown) => e);
  expect((err as Error).message).toBe("boom");
  // Promptly = well before the 5s timeout that is still armed above.
  expect(Date.now() - start).toBeLessThan(1000);
});

test("deadline disarms its timer when the promise settles (no lingering handle)", async () => {
  // Observable via the timer API: deadline must arm exactly one 60s timer and
  // clear it once p settles. A leaked timer would keep the handle alive.
  const SENTINEL_MS = 60_000;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const g = globalThis as unknown as {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };
  let armed: unknown = undefined;
  let disarmed = false;
  g.setTimeout = ((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    if (ms === SENTINEL_MS) armed = handle;
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  g.clearTimeout = ((h?: unknown) => {
    if (h !== undefined && h === armed) disarmed = true;
    realClear(h as never);
  }) as unknown as typeof globalThis.clearTimeout;
  try {
    expect(await deadline(Promise.resolve("done"), SENTINEL_MS)).toBe("done");
  } finally {
    g.setTimeout = realSet;
    g.clearTimeout = realClear;
  }
  expect(armed).toBeDefined();
  expect(disarmed).toBe(true);
});

// --- (b) never-settling RPC pins --------------------------------------------

for (const [name, call] of clientCalls) {
  test(`${name} settles false fast when getProxyObject never settles`, async () => {
    const fake = fakeBus(neverSettling, { hangIntrospection: true });
    __setSessionBusForTests(() => fake as unknown as MessageBus);
    const start = Date.now();
    expect(await call(50)).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  }, 3000);

  test(`${name} settles false fast when the proxied method never settles`, async () => {
    const fake = fakeBus(neverSettling);
    __setSessionBusForTests(() => fake as unknown as MessageBus);
    const start = Date.now();
    expect(await call(50)).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  }, 3000);
}

// --- (c) success pin --------------------------------------------------------

test("daemonAlive, sendState and stopDaemon all resolve true against a healthy daemon", async () => {
  for (const [, call] of clientCalls) {
    __setSessionBusForTests(() => fakeBus(healthy) as unknown as MessageBus);
    // Default budget (3000ms) must work when no timeoutMs is passed.
    expect(await call()).toBe(true);
  }
});

// --- (d) disconnect-always pin ----------------------------------------------

test("every call disconnects the bus exactly once on success and failure paths", async () => {
  const scenarios = [
    { methods: healthy, opts: {}, budget: 3000, expected: true },
    { methods: rejecting, opts: {}, budget: 3000, expected: false },
    { methods: neverSettling, opts: {}, budget: 50, expected: false },
    { methods: healthy, opts: { hangConnect: true }, budget: 50, expected: false },
  ];
  for (const [, call] of clientCalls) {
    for (const s of scenarios) {
      const fake = fakeBus(s.methods, s.opts);
      __setSessionBusForTests(() => fake as unknown as MessageBus);
      expect(await call(s.budget)).toBe(s.expected);
      expect(fake.disconnectCount).toBe(1);
    }
  }
}, 5000);

// --- (e) owner-pid probe pin ------------------------------------------------

test("daemonProcessPid resolves the owning process's pid against a healthy daemon", async () => {
  const fake = fakeBus({ ...healthy, GetConnectionUnixProcessID: () => Promise.resolve(4242) });
  __setSessionBusForTests(() => fake as unknown as MessageBus);
  expect(await daemonProcessPid(1000)).toBe(4242);
  expect(fake.disconnectCount).toBe(1);
});

test("daemonProcessPid resolves null fast when the name is unowned or the call hangs", async () => {
  const gone = fakeBus({
    ...healthy,
    GetConnectionUnixProcessID: () => Promise.reject(new Error("unknown name")),
  });
  __setSessionBusForTests(() => gone as unknown as MessageBus);
  expect(await daemonProcessPid(1000)).toBeNull();
  expect(gone.disconnectCount).toBe(1);

  const hanging = fakeBus({
    ...neverSettling,
    GetConnectionUnixProcessID: () => new Promise<number>(() => {}),
  });
  __setSessionBusForTests(() => hanging as unknown as MessageBus);
  const start = Date.now();
  expect(await daemonProcessPid(50)).toBeNull();
  expect(Date.now() - start).toBeLessThan(500);
  expect(hanging.disconnectCount).toBe(1);
});

// --- (f) run-detail pin ------------------------------------------------------

test("sendState carries the detail over the same connection; a detail failure never fails the send", async () => {
  const calls: string[] = [];
  const fake = fakeBus({
    SetState: () => {
      calls.push("SetState");
      return Promise.resolve();
    },
    SetDetail: () => {
      calls.push("SetDetail");
      return Promise.resolve();
    },
  });
  __setSessionBusForTests(() => fake as unknown as MessageBus);
  expect(await sendState("working", "Bash")).toBe(true);
  expect(calls).toEqual(["SetState", "SetDetail"]);
  expect(fake.disconnectCount).toBe(1); // one connection, two RPCs

  // An older daemon without SetDetail (or a rejected detail): best-effort —
  // the state send still reports success.
  calls.length = 0;
  const partial = fakeBus({
    SetState: () => {
      calls.push("SetState");
      return Promise.resolve();
    },
    SetDetail: () => {
      calls.push("SetDetail");
      return Promise.reject(new Error("no such method"));
    },
  });
  __setSessionBusForTests(() => partial as unknown as MessageBus);
  expect(await sendState("working", "Edit")).toBe(true);
  expect(calls).toEqual(["SetState", "SetDetail"]);

  // No detail passed: only SetState goes out.
  calls.length = 0;
  const bare = fakeBus({
    SetState: () => {
      calls.push("SetState");
      return Promise.resolve();
    },
    SetDetail: () => {
      calls.push("SetDetail");
      return Promise.resolve();
    },
  });
  __setSessionBusForTests(() => bare as unknown as MessageBus);
  expect(await sendState("idle")).toBe(true);
  expect(calls).toEqual(["SetState"]);
});

// --- (g) watchSessionActions pins --------------------------------------------

/** Fake bus for the action listener: subscribes SessionAction, can emit. */
function fakeActionBus(opts: { probeRejects?: boolean } = {}) {
  const subscriptions: ((action: string, arg: string) => void)[] = [];
  const errorListeners: (() => void)[] = [];
  const bus = {
    disconnectCount: 0,
    on(event: string, listener: () => void) {
      if (event === "connect") queueMicrotask(listener);
      if (event === "error") errorListeners.push(listener);
    },
    disconnect() {
      this.disconnectCount += 1;
    },
    getProxyObject() {
      return Promise.resolve({
        getInterface: () => ({
          // Drives both the control proxy (SessionAction) and the driver
          // proxy (the liveness probe's NameHasOwner).
          on: (event: string, cb: (action: string, arg: string) => void) => {
            if (event === "SessionAction") subscriptions.push(cb);
          },
          NameHasOwner: () =>
            opts.probeRejects ? Promise.reject(new Error("dead socket")) : Promise.resolve(true),
        }),
      });
    },
    emitAction: (action: string, arg: string) => {
      for (const cb of subscriptions) cb(action, arg);
    },
    emitError: () => {
      for (const l of errorListeners) l();
    },
    subscriptionCount: () => subscriptions.length,
  };
  return bus;
}

async function until(check: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
}

test("watchSessionActions delivers SessionAction payloads and reconnects after a bus error", async () => {
  const received: [string, string][] = [];
  const buses: ReturnType<typeof fakeActionBus>[] = [];
  __setSessionBusForTests(() => {
    const bus = fakeActionBus();
    buses.push(bus);
    return bus as unknown as MessageBus;
  });

  const stop = watchSessionActions((action, arg) => received.push([action, arg]), 50, 20);
  try {
    await until(() => buses[0]?.subscriptionCount() === 1);
    expect(buses.length).toBe(1); // one persistent connection

    buses[0]!.emitAction("abort", "");
    buses[0]!.emitAction("prompt", "Commit the changes");
    expect(received).toEqual([
      ["abort", ""],
      ["prompt", "Commit the changes"],
    ]);

    // The connection dies: the listener re-subscribes on a fresh connection.
    buses[0]!.emitError();
    await until(() => buses.length >= 2 && buses[1]?.subscriptionCount() === 1);
    buses[1]!.emitAction("abort", "again");
    expect(received.at(-1)).toEqual(["abort", "again"]);
  } finally {
    stop();
  }
});

test("watchSessionActions reconnects when the connection silently dies (probe pin)", async () => {
  const buses: ReturnType<typeof fakeActionBus>[] = [];
  __setSessionBusForTests(() => {
    // The FIRST connection's probe rejects (dead socket, no error event —
    // the dbus-next defect); every later connection is healthy.
    const bus = fakeActionBus({ probeRejects: buses.length === 0 });
    buses.push(bus);
    return bus as unknown as MessageBus;
  });

  const stop = watchSessionActions(() => {}, 50, 20);
  try {
    // The failed probe must drop connection #1 and park on #2.
    await until(() => buses.length >= 2 && buses[1]?.subscriptionCount() === 1);
    expect(buses[0]?.disconnectCount).toBe(1);
    await Bun.sleep(60); // no reconnect churn beyond the one recovery
    expect(buses.length).toBe(2);
  } finally {
    stop();
  }
});
