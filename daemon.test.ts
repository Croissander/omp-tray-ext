// Daemon render-mapping tests: state → (px, status, tooltip, attention).
//
// Run: bun test daemon.test.ts

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
