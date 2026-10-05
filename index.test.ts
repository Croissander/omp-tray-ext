// Spawn-runner resolution: daemon.ts must run under bun, NEVER under the host
// binary — inside omp, process.execPath is omp itself and spawning it
// fork-bombed the machine (2026-10-05).
// bun test index.test.ts
import { test, expect } from "bun:test";
import { resolveDaemonRunner } from "./index";

test("prefers bun from PATH over the host binary", () => {
  expect(resolveDaemonRunner(() => "/usr/bin/bun", "/home/u/.local/bin/omp")).toBe("/usr/bin/bun");
});

test("never spawns a non-bun host binary (fork-bomb pin)", () => {
  expect(resolveDaemonRunner(() => null, "/home/u/.local/bin/omp")).toBeNull();
});

test("allows the host binary when the host is bun", () => {
  expect(resolveDaemonRunner(() => null, "/usr/bin/bun")).toBe("/usr/bin/bun");
});
