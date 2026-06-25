// Monochrome tray glyphs. All icons are white-on-transparent ARGB32 so they
// read on both light and dark panels. Drawn pixel-by-pixel — no font, no image
// library. The working state is a spinner: 8 frames of a ring with a ~90° arc
// gap, rotated each tick by the daemon.

const SIZE = 22;

export type Pixels = { w: number; h: number; rgba: Uint8Array };

function blank(): Pixels {
  return { w: SIZE, h: SIZE, rgba: new Uint8Array(SIZE * SIZE * 4) };
}

/** Set a pixel to opaque white. */
function set(px: Pixels, x: number, y: number, on = true) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const idx = (y * SIZE + x) * 4;
  if (on) {
    px.rgba[idx] = 255;
    px.rgba[idx + 1] = 255;
    px.rgba[idx + 2] = 255;
    px.rgba[idx + 3] = 255;
  }
}

/** ">_" idle prompt glyph: a ">" chevron + baseline underscore. */
function promptGlyph(): Pixels {
  const px = blank();
  const set2 = (x: number, y: number) => set(px, x, y);
  // ">" chevron: apex at left (x=3), arms fan to x=8 at top (y=4) and bottom (y=14).
  for (let r = 0; r <= 5; r++) {
    set2(3 + r, 4 + r);   // upper arm going down-right
    set2(3 + r, 14 - r); // lower arm going up-right
  }
  // underscore baseline at row 17, columns 3..16.
  for (let c = 3; c <= 16; c++) set2(c, 17);
  return px;
}

/** "X" error glyph — two crossed diagonal strokes, 2px wide, symmetric. */
function errorGlyph(): Pixels {
  const px = blank();
  const set2 = (x: number, y: number) => set(px, x, y);
  // Both diagonals share center (10.5, 10). Half-extent 7 → rows 3..17.
  for (let r = -7; r <= 7; r++) {
    const y = 10 + r;
    set2(10 + r, y); set2(11 + r, y); // "\"
    set2(10 - r, y); set2(11 - r, y); // "/"
  }
  return px;
}

/**
 * One spinner frame: a ring with a ~90° arc gap, rotated by `rotation` (in
 * steps of 45°, 0..7). Drawn by stamping 8 arc segments around a circle and
 * skipping the ones that fall in the gap window.
 */
function spinnerFrame(rotation: number): Pixels {
  const px = blank();
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const r = 8; // ring radius
  // Stamp every pixel near radius r that isn't in the missing 90° (PI/2) arc.
  // Gap centered at angle = rotation * 45°.
  const gapCenter = (rotation * Math.PI) / 4;
  const halfGap = Math.PI / 4; // 45° half = 90° total gap
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < r - 1.2 || d > r + 1.2) continue;
      let theta = Math.atan2(dy, dx); // -PI..PI
      if (theta < 0) theta += 2 * Math.PI;
      // Angular distance from gap center, normalized to [0, PI].
      let diff = Math.abs(theta - gapCenter);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < halfGap) continue; // skip the gap
      set(px, x, y);
    }
  }
  return px;
}

/** All 8 spinner frames, pre-rendered. */
const spinnerFrames: Pixels[] = Array.from({ length: 8 }, (_, i) => spinnerFrame(i));

export type IconKind = "prompt" | "error" | "spinner";

export function glyph(kind: IconKind): Pixels {
  if (kind === "prompt") return promptGlyph();
  if (kind === "error") return errorGlyph();
  return spinnerFrames[0] ?? promptGlyph();
}

export function spinnerFrameByIndex(i: number): Pixels {
  return spinnerFrames[i % 8] ?? spinnerFrames[0] ?? promptGlyph();
}

/** Convert a Pixels buffer to ARGB32 (a,r,g,b) bytes for SNI IconPixmap. */
export function toArgb(px: Pixels): { w: number; h: number; bytes: Uint8Array } {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const r = px.rgba[i * 4] ?? 0;
    const g = px.rgba[i * 4 + 1] ?? 0;
    const b = px.rgba[i * 4 + 2] ?? 0;
    const a = px.rgba[i * 4 + 3] ?? 0;
    bytes[i * 4] = a;
    bytes[i * 4 + 1] = r;
    bytes[i * 4 + 2] = g;
    bytes[i * 4 + 3] = b;
  }
  return { w: SIZE, h: SIZE, bytes };
}

/** Size constant, re-exported for consistency. */
export const ICON_SIZE = SIZE;

if (import.meta.main) {
  const glyphs: Record<string, Pixels> = {
    prompt: promptGlyph(),
    error: errorGlyph(),
    "spinner-0": spinnerFrame(0),
    "spinner-1": spinnerFrame(1),
  };
  for (const [name, px] of Object.entries(glyphs)) {
    const { bytes } = toArgb(px);
    const on = Array.from(bytes).filter((b, i) => i % 4 === 3 && b !== 0).length;
    console.log(`${name}: ${px.w}x${px.h} opaque_pixels=${on}`);
  }
}
