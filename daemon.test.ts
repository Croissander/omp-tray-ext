// Suite: stateView render-mapping (state → (px, status, tooltip, attention))
// and the single-instance slot pin — two daemon processes racing on one
// session bus must yield exactly one StatusNotifierWatcher registration and
// one surviving daemon.
//
// bun test daemon.test.ts

import dbus from "dbus-next";
import { expect, test } from "bun:test";
import { stateView } from "./daemon";
import { glyph, spinnerFrameByIndex } from "./icons";

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

// ---- Single-instance slot pin --------------------------------------------

const { interface: iface } = dbus;

class FakeWatcher extends iface.Interface {
  readonly registrations: string[] = [];
  constructor() {
    super("org.kde.StatusNotifierWatcher");
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

test.skipIf(!Bun.which("dbus-daemon"))(
  "two concurrent daemon starts yield one watcher registration and one survivor",
  async () => {
    const oldAddr = process.env.DBUS_SESSION_BUS_ADDRESS;
    let busd: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;
    let watcherConn: dbus.MessageBus | null = null;
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    try {
      // Private session bus — never the real one — so the run is isolated
      // and repeatable. Exit closes the pipe, so the address read can't hang.
      busd = Bun.spawn(["dbus-daemon", "--session", "--print-address", "--nofork"], {
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

      // Fake StatusNotifierWatcher; the export also serves the introspection
      // the daemon's getProxyObject lookup needs.
      process.env.DBUS_SESSION_BUS_ADDRESS = addr;
      const watcher = new FakeWatcher();
      watcherConn = dbus.sessionBus();
      watcherConn.export("/StatusNotifierWatcher", watcher);
      await watcherConn.requestName("org.kde.StatusNotifierWatcher", 0);

      const spawnDaemon = () =>
        Bun.spawn([Bun.which("bun") ?? "bun", "daemon.ts"], {
          cwd: import.meta.dir,
          env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: addr },
          stdio: ["ignore", "pipe", "pipe"],
        });
      // Both starts in one tick — the concurrent slot claim this pin exists for.
      children.push(spawnDaemon(), spawnDaemon());

      const alive = new Set(children);
      for (const c of children) {
        const drop = () => {
          alive.delete(c);
        };
        void c.exited.then(drop, drop);
      }

      // Bounded settle: judge only after a registration has landed and the
      // survivor count held still ~500 ms (the slot loser is still exiting).
      // Real timers are unavoidable here: the daemons and the bus live in
      // separate processes, so fake timers cannot drive their exits. This
      // polls observable state with a hard bound instead of guessing a delay.
      const deadline = Date.now() + 4000;
      let stableSince = Date.now();
      let lastAlive = alive.size;
      while (Date.now() < deadline) {
        await Bun.sleep(100);
        if (alive.size !== lastAlive) {
          lastAlive = alive.size;
          stableSince = Date.now();
        } else if (watcher.registrations.length >= 1 && Date.now() - stableSince >= 500) {
          break;
        }
      }

      expect(watcher.registrations.length).toBe(1);
      expect(alive.size).toBe(1);
    } finally {
      // Always reap so the suite stays repeatable: children first, then the
      // private bus — killing it is the backstop for any wedged child. The
      // exit wait is bounded so cleanup itself can never hang.
      for (const c of children) {
        try {
          c.kill("SIGTERM");
        } catch {}
      }
      try {
        watcherConn?.disconnect();
      } catch {}
      try {
        busd?.kill("SIGTERM");
      } catch {}
      await Promise.allSettled(children.map((c) => Promise.race([c.exited, Bun.sleep(2000)])));
      if (oldAddr === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddr;
    }
  },
  15_000,
);
