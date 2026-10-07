// Spawn-runner resolution: daemon.ts must run under bun, NEVER under the host
// binary — inside omp, process.execPath is omp itself and spawning it
// fork-bombed the machine (2026-10-05).
// bun test index.test.ts
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MessageBus } from "dbus-next";
import ompTray, { ensureDaemon, isOwnerless, resolveDaemonRunner } from "./index";
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

// --- extension-level pins: spawn single-flight, recovery reseed, no
// suppression, restart, shutdown-no-kill, owner-verified adoption ---

/** Mutable Bun.spawn slot so tests can stub it; restored in afterEach. */
const bunMut = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;

// Every SessionAction subscription ever made in this file. The action
// listener is a process-wide singleton — the single-flight route pin below
// asserts the TOTAL count, so the recorder must be file-level, not per-test.
const sessionActionSubscriptions: ((action: string, arg: string) => void)[] = [];

afterEach(() => {
  __setSessionBusForTests(null);
  bunMut.spawn = realSpawn;
});

/**
 * Duck-typed MessageBus fake (same surface ipc.test.ts drives): no I/O at
 * all. `alive` answers NameHasOwner, `onSetState` observes sends (and may
 * throw to model the daemon dying mid-call), `stopFails` rejects the Stop()
 * RPC so stopDaemon() resolves false. A SetState while `alive` is false is
 * lost at the transport: rejected before the observer — never recorded.
 * `onSessionAction` registers every SessionAction subscription so tests can
 * fire menu clicks; `onSetDetail` observes the run-detail RPC.
 */
function fakeBus(opts: {
  alive?: () => boolean;
  /** PID the daemon's name resolves to (adoption owner check); defaults to
   *  this process — owner-bound, never orphaned. */
  ownerPid?: number;
  onSetState?: (state: string) => void;
  onSetDetail?: (detail: string) => void;
  onStop?: () => void;
  stopFails?: boolean;
  onSessionAction?: (handler: (action: string, arg: string) => void) => void;
}) {
  const methods = {
    NameHasOwner: () => Promise.resolve(opts.alive?.() ?? true),
    GetConnectionUnixProcessID: () =>
      opts.alive?.() ?? true
        ? Promise.resolve(opts.ownerPid ?? process.pid)
        : Promise.reject(new Error("unknown name")),
    SetState: (state: string) => {
      // Lost at the transport when the daemon is down — never observed.
      if (!(opts.alive?.() ?? true)) return Promise.reject(new Error("no daemon"));
      opts.onSetState?.(state);
      return Promise.resolve();
    },
    SetDetail: (detail: string) => {
      opts.onSetDetail?.(detail);
      return Promise.resolve();
    },
    Stop: () => {
      if (opts.stopFails) return Promise.reject(new Error("stop failed"));
      opts.onStop?.();
      return Promise.resolve();
    },
    // The action listener's control-interface signal subscription. Every
    // subscription in the file lands in one shared array: the listener is a
    // PROCESS-wide singleton (module-level flag), so the total count across
    // all activations is what the single-flight pin asserts.
    on: (event: string, handler: (action: string, arg: string) => void) => {
      if (event === "SessionAction") {
        sessionActionSubscriptions.push(handler);
        opts.onSessionAction?.(handler);
      }
    },
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
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: StubCtx) => Promise<void> }>();
  const userMessages: string[] = [];
  const warnings: string[] = [];
  const api = {
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      events.set(event, handler);
    },
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: StubCtx) => Promise<void> },
    ) => {
      commands.set(name, spec);
    },
    sendUserMessage: (content: string) => {
      userMessages.push(content);
    },
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
      info: () => {},
    },
  } as unknown as ExtensionAPI;
  return { api, events, commands, userMessages, warnings };
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

test("a lost final idle is retried even after a failed respawn (reseed-after-failed-ensure pin)", async () => {
  const sends: string[] = [];
  const rescue = Promise.withResolvers<void>();
  let crashed = false;
  let up = true; // up at load — the activation adopts the daemon, no spawn
  let spawns = 0;
  bunMut.spawn = () => {
    spawns += 1;
    // The first respawned daemon never claims its DBus name — ensureDaemon's
    // poll window gives up and resolves false. The NEXT spawn is the daemon
    // "appearing moments later": its name probe turns true.
    if (spawns >= 2) up = true;
    return { pid: 424242, unref() {} };
  };
  __setSessionBusForTests(
    () =>
      fakeBus({
        alive: () => up,
        onSetState: (s) => {
          sends.push(s);
          if (s === "idle") rescue.resolve();
          if (crashed) return;
          crashed = true;
          // The daemon dies mid-ack on its first taken call ("a failing first
          // SetState"): observed but failed, and every later send is lost at
          // the transport until a respawn brings the daemon back.
          up = false;
          throw new Error("daemon died mid-call");
        },
      }) as unknown as MessageBus,
  );

  const cap = stubPi();
  ompTray(cap.api);
  // Settle the load-time adopt first so recover() below starts (and the
  // capture joins) its OWN single-flight attempt.
  expect(await ensureDaemon()).toBe(true);
  // The turn: "working" reaches the dying daemon (observed, send fails), the
  // final "idle" is lost — and the respawn triggered by the loss FAILS.
  await cap.events.get("agent_start")?.({});
  const respawn = ensureDaemon(); // joins recover()'s in-flight attempt
  await cap.events.get("agent_end")?.({});
  expect(await respawn).toBe(false); // probe stayed false through the window

  // The forced reseed is the retry — await its landing (the real signal, not
  // a poll). The chain crosses ensureDaemonAttempt's real ~2 s poll window
  // (Date.now()-driven sleeps inside production code; fake timers cannot
  // advance that loop deterministically from a test).
  await rescue.promise;
  // Pre-fix this await hangs (bun test timeout = the failure): the reseed
  // was skipped on a failed ensure, and the controller's dedupe swallows
  // every later identical idle — the list ends at "working".
  expect(sends.at(-1)).toBe("idle");
});

test("no activation is suppressed; both send (no-suppression pin)", async () => {
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

  // omp re-binds extension factories per subagent session WITHOUT
  // re-evaluating the module — an activation must NEVER be silenced (the
  // v1.3.0 generation guard silently dropped the first one's queued sends
  // here, stranding the icon). The FIRST activation's captured agent_start
  // reaches the bus.
  const firstAgent = first.events.get("agent_start");
  expect(firstAgent).toBeDefined();
  await firstAgent?.({});
  expect(sends).toEqual(["working"]);

  // The second activation sends likewise.
  const secondAgent = second.events.get("agent_start");
  expect(secondAgent).toBeDefined();
  await secondAgent?.({});
  expect(sends).toEqual(["working", "working"]);
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

test("session_shutdown settles the icon and never kills the daemon (shutdown-no-kill pin)", async () => {
  const sends: string[] = [];
  let spawns = 0;
  let spawned = false;
  bunMut.spawn = () => {
    spawns += 1;
    spawned = true;
    return { pid: 424242, unref() {} }; // harmless stub — nothing real to signal
  };
  // Not adopted: the ensure below must spawn so daemonPid is the stub — the
  // daemon process "started by ensureDaemon".
  __setSessionBusForTests(
    () =>
      fakeBus({
        alive: () => spawned,
        onSetState: (s) => {
          sends.push(s);
        },
      }) as unknown as MessageBus,
  );

  const cap = stubPi();
  ompTray(cap.api);
  await ensureDaemon(); // joins the load-time attempt — exactly one spawn
  expect(spawns).toBe(1);

  // A turn in progress, then the shutdown. index.ts registers NO
  // session_shutdown handler (the kill one is deleted: the event also fires
  // for subagent child disposals, whose re-bound instance shares daemonPid —
  // a kill there takes the shared daemon down mid-parent-turn). With
  // process.kill unstubbable and the stub pid harmless the kill itself is
  // unobservable — so pin what IS captured: it must be the controller's
  // icon-settling mapping (the bus sees "idle"), never the silent killer
  // (bus stays silent while it signals daemonPid).
  await cap.events.get("agent_start")?.({});
  expect(sends).toEqual(["working"]);
  await cap.events.get("session_shutdown")?.({});
  expect(sends).toEqual(["working", "idle"]);

  // Teardown's instant path lives on clean process exits — and remains
  // registered. (Signal deaths are the daemon's owner watchdog's job.)
  expect(process.listeners("exit").some((fn) => fn.name === "killOwnDaemon")).toBe(true);
});

test("an owner-less daemon is replaced, never adopted (stale-icon self-heal pin)", async () => {
  let spawns = 0;
  let stops = 0;
  let daemonUp = true; // a legacy orphan holds the slot at load
  bunMut.spawn = () => {
    spawns += 1;
    daemonUp = true; // the replacement claims the slot at spawn
    return { pid: 424242, unref() {} };
  };
  __setSessionBusForTests(
    () =>
      fakeBus({
        alive: () => daemonUp,
        ownerPid: 2147483647, // no /proc entry — owner-less
        onStop: () => {
          stops += 1;
          daemonUp = false; // the orphan exits on Stop()
        },
      }) as unknown as MessageBus,
  );

  expect(await ensureDaemon()).toBe(true);
  expect(stops).toBe(1); // the orphan was stopped...
  expect(spawns).toBe(1); // ...and replaced by an owner-bound daemon
});

test("isOwnerless: reaped parent = orphaned, live parent = owned (parse pin)", () => {
  // /proc/<pid>/stat is "pid (comm) state ppid ..." and comm may contain
  // spaces and parens — only the last ")" closes it.
  const statWith = (comm: string, ppid: number) => `123 (${comm}) S ${ppid} 11 0 -1 4194304 0 0`;
  expect(isOwnerless(1, () => statWith("bun daemon.ts", 1))).toBe(true);
  expect(isOwnerless(1, () => statWith("bun daemon.ts", 4567))).toBe(false);
  expect(isOwnerless(1, () => statWith("foo) bar (baz", 1))).toBe(true);
  expect(isOwnerless(1, () => statWith("foo) bar (baz", 4567))).toBe(false);
  // Vanished between lookup and read: not owned.
  expect(
    isOwnerless(1, () => {
      throw new Error("ENOENT");
    }),
  ).toBe(true);
});

test("menu actions route to the newest activation; one listener per process (single-flight route pin)", async () => {
  // This test runs LAST in the file and must stay last: the action listener
  // is a process-wide singleton started by the FIRST ompTray() above, so the
  // pin asserts the file-wide total (every activation in this file joined
  // exactly one subscription) and routes through that one live subscription.
  __setSessionBusForTests(
    () => fakeBus({}) as unknown as MessageBus,
  );

  // Two more factory rebindings (omp does this per subagent session WITHOUT
  // re-evaluating the module): still exactly ONE listener, and the ROUTE
  // points at the newest activation.
  const first = stubPi();
  const second = stubPi();
  ompTray(first.api);
  ompTray(second.api);
  const tick = Promise.withResolvers<void>();
  setTimeout(tick.resolve, 10);
  await tick.promise;
  expect(sessionActionSubscriptions.length).toBe(1);

  const deliver = sessionActionSubscriptions[0];
  expect(deliver).toBeDefined();

  // abort → the newest activation's controller interrupt (ctx captured by
  // ITS agent_start), not the first one's.
  const aborts: number[] = [];
  const secondAborted = Promise.withResolvers<void>();
  await first.events.get("agent_start")?.({}, { abort: () => aborts.push(1) });
  await second.events.get("agent_start")?.({}, {
    abort: () => {
      aborts.push(2);
      secondAborted.resolve();
    },
  });
  deliver?.("abort", "");
  await secondAborted.promise;
  expect(aborts).toEqual([2]);

  // prompt → the newest activation's pi.sendUserMessage, verbatim.
  deliver?.("prompt", "Run the tests and fix any failures");
  expect(second.userMessages).toEqual(["Run the tests and fix any failures"]);
  expect(first.userMessages).toEqual([]);

  // Empty-arg prompts and unknown kinds are dropped.
  deliver?.("prompt", "");
  deliver?.("gibberish", "x");
  await tick.promise;
  expect(second.userMessages).toEqual(["Run the tests and fix any failures"]);
  expect(second.warnings.some((w) => w.includes("gibberish"))).toBe(true);
});
