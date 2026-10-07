// Suite: stateView render-mapping (state → (px, status, tooltip, attention)),
// SNI conformance + lifecycle pins (Category/Menu/ItemIsMenu, NewStatus (s)
// payload, NewToolTip only on tooltip change, publish-before-register,
// watcher-restart re-registration, SIGTERM during startup), owner-lifetime
// pins (the daemon dies with its owner, whatever the death mode — the
// stale-icon fix; also with the owner's TERMINAL — the headless-zombie fix;
// and stays alive for a non-interactive owner), and the single-instance slot
// pin — two daemon processes racing on one session bus must yield exactly one
// StatusNotifierWatcher registration and one surviving daemon.
//
// bun test daemon.test.ts

import dbus from "dbus-next";
import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { stateView, ownerTtyNr } from "./daemon";
import { glyph, spinnerFrameByIndex } from "./icons";
import { DAEMON_IFACE, DAEMON_NAME, DAEMON_PATH, type DaemonControlIface } from "./ipc";

/** Typed view over org.freedesktop.DBus.Properties (dbus-next's untyped result has optional members). */
interface PropsIface {
  GetAll(name: string): Promise<Record<string, dbus.Variant>>;
}

test("working maps to the spinner frame for the current frame", () => {
  const v = stateView("working", 3);
  expect(v.px).toBe(spinnerFrameByIndex(3));
  expect(v.status).toBe("Active");
  expect(v.tooltip).toBe("Working");
  expect(v.attention).toBe(false);
});

test("error maps to the X glyph with NeedsAttention", () => {
  const v = stateView("error", 0);
  expect(v.px).toBe(glyph("error"));
  expect(v.status).toBe("NeedsAttention");
  expect(v.tooltip).toBe("Error — agent stopped");
  expect(v.attention).toBe(true);
});

test("idle maps to the prompt glyph", () => {
  const v = stateView("idle", 0);
  expect(v.px).toBe(glyph("prompt"));
  expect(v.status).toBe("Active");
  expect(v.tooltip).toBe("Idle");
  expect(v.attention).toBe(false);
});

test("frame only matters for working", () => {
  expect(stateView("idle", 5).px).toBe(glyph("prompt"));
  expect(stateView("error", 5).px).toBe(glyph("error"));
});

test("ownerTtyNr parses tty_nr from stat and never reads a bad stat as terminal-death", () => {
  const statOf = (stat: string) => () => stat;
  // stat is "pid (comm) state ppid pgrp session tty_nr ..."; field 7 is the
  // ctty device, 0 = none. comm may contain spaces/parens.
  expect(ownerTtyNr(1, statOf("1 (systemd) S 0 1 1 0 -1 4194560"))).toBe(0);
  expect(ownerTtyNr(2, statOf("2 (kworker/0:1) S 0 1 1 34817 3897"))).toBe(34817);
  expect(ownerTtyNr(3, statOf("3 (a b (c)) S 0 1 1 34816 3924"))).toBe(34816);
  // Truncated or unreadable stat = unknown, NOT "no ctty" (only a confirmed
  // 0 may kill the daemon).
  expect(ownerTtyNr(4, statOf("4 (gone) S 0"))).toBe(-1);
  expect(
    ownerTtyNr(5, () => {
      throw new Error("EACCES");
    }),
  ).toBe(-1);
});

// ---- Hermetic private-bus harness ------------------------------------------

const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const { interface: iface } = dbus;

class FakeWatcher extends iface.Interface {
  readonly registrations: string[] = [];
  constructor() {
    super(WATCHER_NAME);
  }
  RegisterStatusNotifierItem(service: string) {
    this.registrations.push(service);
  }
}

FakeWatcher.configureMembers({
  methods: {
    RegisterStatusNotifierItem: { inSignature: "s" },
  },
});

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
type Busd = Bun.Subprocess<"ignore", "pipe", "ignore">;

// Private session bus — never the real one — so runs are isolated and
// repeatable. Exit closes the pipe, so the address read can't hang.
async function startPrivateBus(): Promise<{ busd: Busd; addr: string }> {
  const busd = Bun.spawn(["dbus-daemon", "--session", "--print-address", "--nofork"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const reader = busd.stdout.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  while (!printed.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) printed += decoder.decode(value, { stream: true });
  }
  const addr = (printed.split("\n")[0] ?? "").trim();
  if (!addr) throw new Error("dbus-daemon printed no bus address");
  return { busd, addr };
}

// Lockstep spawn shape for every daemon under test (5+ call sites). `ownerArg`
// becomes argv[2] — the owner pid the watchdog watches (index.ts passes its
// own pid there); without it the watchdog falls back to this test process.
function spawnDaemon(addr: string, ownerArg?: string): Child {
  return Bun.spawn([Bun.which("bun") ?? "bun", "daemon.ts", ...(ownerArg ? [ownerArg] : [])], {
    cwd: import.meta.dir,
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: addr },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Always reap so the suite stays repeatable: children first, then the
// private bus — killing it is the backstop for any wedged child. The exit
// wait is bounded so cleanup itself can never hang.
async function cleanup(children: Child[], conns: (dbus.MessageBus | null)[], busd: Busd | null) {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  for (const conn of conns) {
    try {
      conn?.disconnect();
    } catch {}
  }
  try {
    busd?.kill("SIGTERM");
  } catch {}
  await Promise.allSettled(children.map((c) => Promise.race([c.exited, Bun.sleep(2000)])));
}

// Real timers by necessity: the daemon and the bus live in other processes,
// so fake timers cannot drive their clocks — poll observable state with a
// hard bound instead of guessing a duration.
async function waitFor(check: () => boolean, ms: number, step = 20) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await Bun.sleep(step);
}

// Private bus + fake StatusNotifierWatcher, no daemon yet (4 call sites). The
// watcher export also serves the introspection the daemon's getProxyObject
// lookup needs.
async function startWatchedBus() {
  const { busd, addr } = await startPrivateBus();
  const watcher = new FakeWatcher();
  const watcherConn = dbus.sessionBus({ busAddress: addr });
  watcherConn.export("/StatusNotifierWatcher", watcher);
  await watcherConn.requestName(WATCHER_NAME, 0);
  return { busd, addr, watcher, watcherConn };
}

// Private bus + fake watcher + one daemon child, waiting for the initial
// watcher registration — that registration is what "daemon up" means.
async function startRegisteredDaemon() {
  const { busd, addr, watcher, watcherConn } = await startWatchedBus();
  const children = [spawnDaemon(addr)];
  await waitFor(() => watcher.registrations.length >= 1, 4000, 5);
  return { addr, busd, watcher, watcherConn, children };
}

// ---- Single-instance slot pin ----------------------------------------------

test.skipIf(!Bun.which("dbus-daemon"))(
  "two concurrent daemon starts yield one watcher registration and one survivor",
  async () => {
    const { busd, addr, watcher, watcherConn } = await startWatchedBus();

    // Both starts in one tick — the concurrent slot claim this pin exists for.
    const children = [spawnDaemon(addr), spawnDaemon(addr)];

    const alive = new Set(children);
    for (const c of children) {
      const drop = () => {
        alive.delete(c);
      };
      void c.exited.then(drop, drop);
    }

    try {
      // Bounded settle: judge only after a registration has landed, exactly
      // one child survives, and that count held still ~500 ms (the slot loser
      // is still exiting). Real timers are unavoidable here: the daemons and
      // the bus live in separate processes, so fake timers cannot drive their
      // exits. This polls observable state with a hard bound instead of
      // guessing a delay.
      const deadline = Date.now() + 4000;
      let stableSince = Date.now();
      let lastAlive = alive.size;
      while (Date.now() < deadline) {
        await Bun.sleep(100);
        if (alive.size !== lastAlive) {
          lastAlive = alive.size;
          stableSince = Date.now();
        } else if (
          watcher.registrations.length >= 1 &&
          alive.size === 1 && // a stable count of 2 is broken, not settled
          Date.now() - stableSince >= 500
        ) {
          break;
        }
      }

      expect(watcher.registrations.length).toBe(1);
      expect(alive.size).toBe(1);
    } finally {
      await cleanup(children, [watcherConn], busd);
    }
  },
  15_000,
);

// ---- Watcher-restart pin ---------------------------------------------------

test.skipIf(!Bun.which("dbus-daemon"))(
  "a watcher restart re-registers the item with the fresh watcher",
  async () => {
    const { addr, busd, watcher, watcherConn, children } = await startRegisteredDaemon();
    const watcher2 = new FakeWatcher();
    let watcher2Conn: dbus.MessageBus | null = null;
    try {
      expect(watcher.registrations.length).toBe(1);

      // Panel restart: the watcher's in-memory item list dies with its
      // connection; a fresh instance (new connection) re-claims the name with
      // an empty list, and no host ever solicits re-registration.
      watcherConn.disconnect();
      watcher2Conn = dbus.sessionBus({ busAddress: addr });
      watcher2Conn.export("/StatusNotifierWatcher", watcher2);
      await watcher2Conn.requestName(WATCHER_NAME, 0);

      await waitFor(() => watcher.registrations.length + watcher2.registrations.length >= 2, 4000);
      // Real-time quiet period: a third registration could only arrive from
      // the daemon child, whose clock fake timers cannot drive.
      await Bun.sleep(300);
      // Exactly one registration per owner appearance — churn must not
      // multiply them.
      expect(watcher.registrations.length + watcher2.registrations.length).toBe(2);
    } finally {
      await cleanup(children, [watcherConn, watcher2Conn], busd);
    }
  },
  15_000,
);

// ---- Conformance pin -------------------------------------------------------

test.skipIf(!Bun.which("dbus-daemon"))(
  "SNI conformance: Category/Menu/ItemIsMenu, NewStatus (s) payload, NewToolTip on tooltip change",
  async () => {
    const { addr, busd, watcher, watcherConn, children } = await startRegisteredDaemon();
    const client = dbus.sessionBus({ busAddress: addr });
    try {
      const service = watcher.registrations[0] ?? "";
      expect(service).not.toBe("");
      const item = await client.getProxyObject(service, "/StatusNotifierItem");
      // The properties call a host makes first; it also seeds the client's
      // name-owner cache so the signal sender filter below passes.
      const props = item.getInterface<PropsIface & dbus.ClientInterface>("org.freedesktop.DBus.Properties");
      const all = (await props.GetAll("org.kde.StatusNotifierItem")) as Record<string, dbus.Variant>;
      expect(String(all.Category?.value ?? "")).not.toBe("");
      expect(["", "/NO_DBUSMENU"]).not.toContain(String(all.Menu?.value ?? ""));
      expect(all.ItemIsMenu?.value).toBe(false);

      const sni = item.getInterface("org.kde.StatusNotifierItem");
      const statuses: unknown[] = [];
      let tooltipSignals = 0;
      sni.on("NewStatus", (status: unknown) => {
        statuses.push(status);
      });
      sni.on("NewToolTip", () => {
        tooltipSignals += 1;
      });

      const control = await client.getProxyObject(DAEMON_NAME, DAEMON_PATH);
      await control
        .getInterface<DaemonControlIface & dbus.ClientInterface>(DAEMON_IFACE)
        .SetState("working"); // tooltip Idle → Working

      await waitFor(() => statuses.length >= 1 && tooltipSignals >= 1, 2000, 10);
      expect(statuses[0]).toBe("Active"); // spec 3.3.6: NewStatus carries the (s) status
      expect(tooltipSignals).toBeGreaterThanOrEqual(1);

      // Spinner ticks repaint every 120 ms; an unchanged tooltip must not
      // re-emit NewToolTip. Real-time quiet period: the spinner runs in the
      // daemon child, whose timers fake timers cannot drive.
      await Bun.sleep(500);
      expect(tooltipSignals).toBe(1);
    } finally {
      await cleanup(children, [watcherConn, client], busd);
    }
  },
  15_000,
);

// ---- Initial-state pin -----------------------------------------------------

test.skipIf(!Bun.which("dbus-daemon"))(
  "initial state is published before watcher registration",
  async () => {
    // Races the daemon's 300 ms delayed re-render: at registration time a
    // fast host's GetAll must already show Status "Active" + icon — pre-fix
    // it saw "Passive" + empty.
    const { addr, busd, watcher, watcherConn, children } = await startRegisteredDaemon();
    const client = dbus.sessionBus({ busAddress: addr });
    try {
      const service = watcher.registrations[0] ?? "";
      const item = await client.getProxyObject(service, "/StatusNotifierItem");
      const props = item.getInterface<PropsIface & dbus.ClientInterface>("org.freedesktop.DBus.Properties");
      const all = (await props.GetAll("org.kde.StatusNotifierItem")) as Record<string, dbus.Variant>;
      expect(all.Status?.value).toBe("Active");
      expect(((all.IconPixmap?.value ?? []) as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await cleanup(children, [watcherConn, client], busd);
    }
  },
  15_000,
);

// ---- SIGTERM-during-startup pin --------------------------------------------

test("SIGTERM during the startup connect window exits promptly", async () => {
  // Silent listener: accepts the connection but never completes the D-Bus
  // handshake, parking the daemon in its up-to-10 s connect window with no
  // bus yet — the window where a swallowed SIGTERM used to orphan it.
  const sockPath = `${tmpdir()}/omptray-daemon-test-${process.pid}.sock`;
  rmSync(sockPath, { force: true }); // stale socket from a reused pid
  const server = createServer(() => {}); // accept and hold open; never reply
  const listening = Promise.withResolvers<void>();
  server.listen(sockPath, () => listening.resolve());
  await listening.promise;
  const child = spawnDaemon(`unix:path=${sockPath}`);
  try {
    // Real delay: the SIGTERM must land inside the child's live connect
    // window — fake timers cannot schedule signals into another process.
    await Bun.sleep(200);
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    expect(exited).toBe(true);
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {}
    await Promise.race([child.exited, Bun.sleep(2000)]);
    server.close();
    rmSync(sockPath, { force: true });
  }
});

// ---- Owner-lifetime pins (the stale-icon fix) -------------------------------
//
// The icon must disappear WITH its app. An owner often cannot signal us at
// all: process.on("exit") never runs on signal death (SIGHUP terminal close,
// SIGINT, SIGTERM, SIGKILL). The daemon's owner watchdog (argv[2] owner pid,
// ppid comparison) is what takes the icon down then.

test.skipIf(!Bun.which("dbus-daemon"))(
  "a daemon whose owner died before it booted exits at once (owner-predecease pin)",
  async () => {
    const { busd, addr, watcher, watcherConn } = await startWatchedBus();
    // argv[2] is NOT our parent — the spawn-race state where the owner is
    // already gone when the daemon first reads its ppid.
    const child = spawnDaemon(addr, "2147483647");
    try {
      // Bounded exit wait — the watchdog runs on the child's own clock, which
      // fake timers cannot drive (the harness's real-timer rule).
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      expect(exited).toBe(true);
      // It must never have shown an icon. Proving an absence needs a quiet
      // period (no event exists to await); real-time like every other
      // cross-process quiet wait here.
      await Bun.sleep(300);
      expect(watcher.registrations.length).toBe(0);
    } finally {
      await cleanup([child], [watcherConn], busd);
    }
  },
  15_000,
);

test.skipIf(!Bun.which("dbus-daemon"))(
  "the icon dies with its app: a SIGKILLed owner takes the daemon down (stale-icon pin)",
  async () => {
    const { busd, addr, watcher, watcherConn } = await startWatchedBus();
    // Owner stand-in: spawns the daemon exactly like index.ts (owner pid in
    // argv[2], detached), then lives until SIGKILLed — the death mode where NO
    // exit hook can ever run in the owner (the pre-fix stale icon).
    const runner = Bun.which("bun") ?? "bun";
    const ownerSrc = [
      `const proc = Bun.spawn([${JSON.stringify(runner)}, "daemon.ts", String(process.pid)], {`,
      `  cwd: ${JSON.stringify(import.meta.dir)},`,
      `  env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: ${JSON.stringify(addr)} },`,
      `  stdio: ["ignore", "ignore", "ignore"],`,
      `  detached: true,`,
      `});`,
      `proc.unref();`,
      `console.log(String(proc.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const owner = Bun.spawn([runner, "-e", ownerSrc], {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const reader = owner.stdout.getReader();
    const decoder = new TextDecoder();
    let printed = "";
    while (!printed.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) printed += decoder.decode(value, { stream: true });
    }
    void reader.cancel();
    const daemonPid = Number((printed.split("\n")[0] ?? "").trim());
    // The icon exists: the daemon registered with the watcher...
    await waitFor(() => watcher.registrations.length >= 1, 4000, 5);
    expect(Number.isInteger(daemonPid) && daemonPid > 0).toBe(true);

    try {
      // ...then the app dies hard: no exit hook, no signal forwarding.
      owner.kill("SIGKILL");
      // Bounded reap wait — cleanup must never hang (same rule as cleanup()).
      await Promise.race([owner.exited, Bun.sleep(2000)]);

      // The daemon follows within one owner poll. A zombie counts as gone: it
      // is a dead process (connection closed, names released) merely awaiting
      // a reap — from init, or from us if bun test happens to be a subreaper.
      const dead = () => {
        try {
          const stat = readFileSync(`/proc/${daemonPid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        } catch {
          return true;
        }
      };
      await waitFor(dead, 4000, 50);
      expect(dead()).toBe(true);

      // Its names are gone with it — the panel drops the icon.
      const client = dbus.sessionBus({ busAddress: addr });
      try {
        const driver = (
          await client.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus")
        ).getInterface<{ NameHasOwner(name: string): Promise<boolean> } & dbus.ClientInterface>(
          "org.freedesktop.DBus",
        );
        // The bus's name sweep is async to the death — poll the condition with
        // a hard bound instead of guessing a delivery delay.
        let namesReleased = false;
        await waitFor(() => {
          if (!namesReleased) {
            void driver.NameHasOwner(DAEMON_NAME).then(
              (owned) => {
                namesReleased = !owned;
              },
              () => {
                namesReleased = true;
              },
            );
          }
          return namesReleased;
        }, 2000, 50);
        expect(namesReleased).toBe(true);
      } finally {
        try {
          client.disconnect();
        } catch {}
      }
    } finally {
      try {
        owner.kill("SIGKILL");
      } catch {}
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {}
      await cleanup([], [watcherConn], busd);
    }
  },
  15_000,
);

// ---- Owner-terminal pins (the headless-zombie fix) --------------------------
//
// The icon must also disappear when the owner OUTLIVES its terminal: omp's
// disconnect teardown sometimes hangs instead of exiting (upstream #5835 /
// #6788 class), ppid never changes, and the pre-tty-watch daemon tracked the
// headless zombie forever. The daemon reads the owner's controlling terminal
// from /proc/<owner>/stat (tty_nr): a boot tty of 0 (piped stdin, setsid) is
// non-interactive and must NOT arm the check; a released tty (0 later) must
// kill the daemon even though the owner process is still alive.

// Shared owner stand-in source: spawns the daemon exactly like index.ts
// (owner pid in argv[2], detached) and prints "<ownerPid> <daemonPid>" so the
// test can watch both the way the daemon does.
function ownerSource(addr: string, runner: string): string {
  return [
    `const proc = Bun.spawn([${JSON.stringify(runner)}, "daemon.ts", String(process.pid)], {`,
    `  cwd: ${JSON.stringify(import.meta.dir)},`,
    `  env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: ${JSON.stringify(addr)} },`,
    `  stdio: ["ignore", "ignore", "ignore"],`,
    `  detached: true,`,
    `});`,
    `proc.unref();`,
    `console.log(process.pid + " " + proc.pid);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
}

/** Read "<ownerPid> <daemonPid>" from a child's stdout with a hard bound. */
async function readOwnerDaemonPids(child: Child): Promise<[number, number]> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  while (!printed.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) printed += decoder.decode(value, { stream: true });
  }
  void reader.cancel();
  const [ownerStr, daemonStr] = printed.trim().split(" ");
  const ownerPid = Number(ownerStr);
  const daemonPid = Number(daemonStr);
  expect(Number.isInteger(ownerPid) && ownerPid > 0).toBe(true);
  expect(Number.isInteger(daemonPid) && daemonPid > 0).toBe(true);
  return [ownerPid, daemonPid];
}

// A zombie counts as gone: it is a dead process (connection closed, names
// released) merely awaiting a reap — from init, or from us if bun test
// happens to be a subreaper.
function deadOrZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

test.skipIf(!Bun.which("dbus-daemon"))(
  "a non-interactive owner (no ctty) does not arm the tty check (setsid-owner pin)",
  async () => {
    const { busd, addr, watcher, watcherConn } = await startWatchedBus();
    const runner = Bun.which("bun") ?? "bun";
    // detached: true = setsid — the owner gets its own session and no ctty,
    // the same /proc shape as a piped (non-interactive) omp run.
    const owner = Bun.spawn([runner, "-e", ownerSource(addr, runner)], {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    try {
      const [ownerPid, daemonPid] = await readOwnerDaemonPids(owner);
      expect(ownerTtyNr(ownerPid)).toBe(0); // precondition: really no ctty

      // The daemon boots and shows the icon: registration is what "up" means.
      await waitFor(() => watcher.registrations.length >= 1, 4000, 5);
      expect(watcher.registrations.length).toBe(1);

      // And it STAYS up: a wrongly-armed tty check (boot tty 0 misread as a
      // dead terminal) would kill it within a poll or two. Real-time quiet
      // period — the daemon's clock cannot be driven by fake timers.
      await Bun.sleep(2500);
      expect(watcher.registrations.length).toBe(1);
      expect(deadOrZombie(daemonPid)).toBe(false);

      // The ppid rule still applies to this owner: SIGKILL takes the daemon.
      owner.kill("SIGKILL");
      await Promise.race([owner.exited, Bun.sleep(2000)]);
      await waitFor(() => deadOrZombie(daemonPid), 4000, 50);
      expect(deadOrZombie(daemonPid)).toBe(true);
    } finally {
      try {
        owner.kill("SIGKILL");
      } catch {}
      await cleanup([], [watcherConn], busd);
    }
  },
  15_000,
);

test.skipIf(!Bun.which("dbus-daemon") || !Bun.which("script"))(
  "a released controlling terminal takes the daemon down even with the owner alive (tty-loss pin)",
  async () => {
    const { busd, addr, watcher, watcherConn } = await startWatchedBus();
    const runner = Bun.which("bun") ?? "bun";
    // script(1) gives the owner a real pty: it forks a child that setsid()s,
    // claims the slave as its ctty and execs the command. `trap "" HUP` sets
    // SIG_IGN, which survives exec — after we SIGKILL script (the session
    // leader + pty master holder) the master dies, the kernel HUPs the pty's
    // foreground group, and the owner SURVIVES but loses its ctty (tty_nr
    // drops to 0): the headless-zombie shape, with no exit hook in play.
    // The owner runs from a temp file, not bun -e: script routes the command
    // through sh -c, and shell-quoting inline JS is a collision minefield.
    const ownerFile = `${tmpdir()}/omp-tray-tty-owner-${process.pid}.ts`;
    await Bun.write(ownerFile, ownerSource(addr, runner));
    const inner = `trap "" HUP; exec ${JSON.stringify(runner)} ${JSON.stringify(ownerFile)}`;
    const script = Bun.spawn(["script", "-qfec", inner, "/dev/null"], {
      cwd: import.meta.dir,
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: addr },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Hoisted so the backstop cleanup can reach the surviving owner (it
    // outlives script by design) and a daemon that outlived a failed run.
    let ownerPid = 0;
    let daemonPid = 0;
    try {
      [ownerPid, daemonPid] = await readOwnerDaemonPids(script);
      // Precondition: the owner really holds the pty as its ctty.
      expect(ownerTtyNr(ownerPid)).toBeGreaterThan(0);

      // The icon exists: the daemon registered with the watcher.
      await waitFor(() => watcher.registrations.length >= 1, 4000, 5);
      expect(watcher.registrations.length).toBe(1);

      // Terminal death: the owner survives (HUP ignored), its ctty does not.
      script.kill("SIGKILL");
      await Promise.race([script.exited, Bun.sleep(2000)]);
      await waitFor(() => ownerTtyNr(ownerPid) === 0, 4000, 50);
      expect(ownerTtyNr(ownerPid)).toBe(0);

      // The daemon follows within one poll — owner process still alive (the
      // readable stat in ownerTtyNr proves that), names released, panel drops
      // the icon.
      await waitFor(() => deadOrZombie(daemonPid), 4000, 50);
      expect(deadOrZombie(daemonPid)).toBe(true);

      const client = dbus.sessionBus({ busAddress: addr });
      try {
        const driver = (
          await client.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus")
        ).getInterface<{ NameHasOwner(name: string): Promise<boolean> } & dbus.ClientInterface>(
          "org.freedesktop.DBus",
        );
        let namesReleased = false;
        await waitFor(() => {
          if (!namesReleased) {
            void driver.NameHasOwner(DAEMON_NAME).then(
              (owned) => {
                namesReleased = !owned;
              },
              () => {
                namesReleased = true;
              },
            );
          }
          return namesReleased;
        }, 2000, 50);
        expect(namesReleased).toBe(true);
      } finally {
        try {
          client.disconnect();
        } catch {}
      }
    } finally {
      try {
        script.kill("SIGKILL");
      } catch {}
      if (ownerPid > 0) {
        try {
          process.kill(ownerPid, "SIGKILL");
        } catch {}
      }
      if (daemonPid > 0) {
        try {
          process.kill(daemonPid, "SIGKILL");
        } catch {}
      }
      try {
        rmSync(ownerFile, { force: true });
      } catch {}
      await cleanup([], [watcherConn], busd);
    }
  },
  20_000,
);
