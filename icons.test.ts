// Icon primitive tests: pixel byte order, drawing, spinner frame identity.
//
// Run: bun test icons.test.ts

import { expect, test } from "bun:test";
import { glyph, spinnerFrameByIndex, toArgb, type Pixels } from "./icons";

test("toArgb writes [a,r,g,b] bytes per pixel", () => {
  // 1x2 buffer with hand-picked rgba values — catches ARGB/RGBA byte swaps.
  const px: Pixels = {
    w: 1,
    h: 2,
    rgba: new Uint8Array([
      1, 2, 3, 4, // pixel 0: r=1 g=2 b=3 a=4
      251, 252, 253, 254, // pixel 1: r=251 g=252 b=253 a=254
    ]),
  };
  const { w, h, bytes } = toArgb(px);
  expect(w).toBe(1);
  expect(h).toBe(2);
  expect([...bytes]).toEqual([4, 1, 2, 3, 254, 251, 252, 253]);
});

test("glyphs and all 8 spinner frames are visible", () => {
  const all: Pixels[] = [
    glyph("prompt"),
    glyph("error"),
    ...Array.from({ length: 8 }, (_, i) => spinnerFrameByIndex(i)),
  ];
  for (const px of all) {
    const { bytes } = toArgb(px);
    const hasOpaque = [...bytes].some((b, i) => i % 4 === 3 && b !== 0);
    expect(hasOpaque).toBe(true);
  }
});

test("spinner frames are pairwise distinct", () => {
  const frames = Array.from(
    { length: 8 },
    (_, i) => toArgb(spinnerFrameByIndex(i)).bytes,
  );
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      expect([...frames[i]!]).not.toEqual([...frames[j]!]);
    }
  }
});

test("spinnerFrameByIndex wraps every 8 frames to the same buffer", () => {
  for (let i = 0; i < 8; i++) {
    expect(spinnerFrameByIndex(i)).toBe(spinnerFrameByIndex(i + 8));
  }
});

test("glyph returns shared pre-rendered instances", () => {
  expect(glyph("prompt")).toBe(glyph("prompt"));
  expect(glyph("error")).toBe(glyph("error"));
});
