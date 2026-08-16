import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The icons are committed artwork with no generation step, so nothing else in
 * the build would notice if one went missing, got renamed, or was re-encoded
 * badly — the manifest would still be valid and the toolbar button would just
 * render blank. That is a store-submission blocker discovered at the worst
 * possible moment, so the files are checked mechanically here, the same way
 * `ui/tokens.test.ts` checks the stylesheet that actually ships.
 *
 * The two size rules below look like mistakes and are deliberate; both are
 * recorded in `docs/design-system.md` and asserted here so that a future
 * "fix" fails loudly instead of silently shipping an off-spec store icon.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SIZES = [16, 32, 48, 128] as const;

/** Google's store-icon spec: 96x96 of art centred in a 128x128 canvas. */
const STORE_ICON_PADDING = 16;

interface Bitmap {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  pixels: Buffer;
}

/**
 * Minimal decoder for 8-bit RGBA, non-interlaced PNGs — which is what these
 * four files are, and is asserted below before any of this runs. Hand-rolled
 * because the project deliberately ships no image library (see docs/security.md).
 */
function decodePng(buf: Buffer): Bitmap {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [bitDepth, colourType] = [buf[24], buf[25]];
  const interlace = buf[28];
  expect({ bitDepth, colourType, interlace }).toEqual({
    bitDepth: 8,
    colourType: 6, // truecolour with alpha
    interlace: 0,
  });

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    if (buf.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      idat.push(buf.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));

  // Reverse the per-scanline filters. Each row is prefixed with its filter byte.
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? pixels[y * stride + x - bpp]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp]! : 0;
      const value = raw[rowStart + 1 + x]!;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const dl = Math.abs(p - left);
          const du = Math.abs(p - up);
          const dul = Math.abs(p - upLeft);
          restored = value + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
      pixels[y * stride + x] = restored & 0xff;
    }
  }

  return { width, height, pixels };
}

interface AlphaReport {
  /** Bounding box of every pixel that is not fully transparent. */
  padding: { left: number; top: number; right: number; bottom: number };
  artwork: { width: number; height: number };
  /** Pixels with alpha strictly between 0 and 255 — i.e. antialiased edges. */
  partial: number;
}

function measureAlpha({ width, height, pixels }: Bitmap): AlphaReport {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let partial = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3]!;
      if (alpha === 0) continue;
      if (alpha < 255) partial++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  expect(maxX, 'the icon is entirely transparent').toBeGreaterThanOrEqual(0);

  return {
    padding: { left: minX, top: minY, right: width - 1 - maxX, bottom: height - 1 - maxY },
    artwork: { width: maxX - minX + 1, height: maxY - minY + 1 },
    partial,
  };
}

/** The icon paths the manifest will actually declare, read from the config. */
function declaredIconPaths(): Map<number, string> {
  const config = readFileSync(join(ROOT, 'wxt.config.ts'), 'utf8');
  const block = /icons:\s*\{([^}]*)\}/.exec(config);
  expect(block, 'wxt.config.ts no longer declares an icons block').not.toBeNull();

  const paths = new Map<number, string>();
  const entry = /(\d+)\s*:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block![1]!)) !== null) {
    paths.set(Number(match[1]!), match[2]!);
  }
  return paths;
}

/**
 * Decoded lazily, and inside the test that needs it, so that a missing file
 * fails as a named assertion below rather than crashing collection — the point
 * of this suite is to say which icon is wrong, not merely to go red.
 */
const bitmaps = new Map<number, Bitmap>();

function bitmap(size: number): Bitmap {
  const cached = bitmaps.get(size);
  if (cached) return cached;

  const decoded = decodePng(readFileSync(join(ROOT, 'public', 'icon', `${size}.png`)));
  bitmaps.set(size, decoded);
  return decoded;
}

describe('the icons the manifest points at', () => {
  it('declares exactly the four sizes that exist on disk', () => {
    expect([...declaredIconPaths().keys()].sort((a, b) => a - b)).toEqual([...SIZES]);
  });

  it.each(SIZES)('resolves the declared path for %i to a real file', (size) => {
    const declared = declaredIconPaths().get(size);
    expect(declared).toBe(`/icon/${size}.png`);

    // Everything under public/ is copied to the bundle root, so a leading-slash
    // manifest path resolves against public/ at build time.
    expect(existsSync(join(ROOT, 'public', declared!.replace(/^\//, '')))).toBe(true);
  });
});

describe('the icon artwork', () => {
  it.each(SIZES)('is a %ipx square canvas', (size) => {
    const { width, height } = bitmap(size);
    expect({ width, height }).toEqual({ width: size, height: size });
  });

  // A lossy optimiser run over these would flatten or posterise the antialiased
  // edge; the art was deliberately not put through one.
  it.each(SIZES)('keeps a real alpha channel at %ipx', (size) => {
    expect(measureAlpha(bitmap(size)).partial).toBeGreaterThan(0);
  });

  // Deliberate, not a bug: Google's store-icon spec asks for the art to sit
  // inside padding rather than bleed to the canvas edge. Do not "fix" this by
  // scaling the artwork up.
  it('pads the 128px store icon to 96x96 of art, per Google\'s spec', () => {
    const { padding, artwork } = measureAlpha(bitmap(128));

    expect(padding).toEqual({
      left: STORE_ICON_PADDING,
      top: STORE_ICON_PADDING,
      right: STORE_ICON_PADDING,
      bottom: STORE_ICON_PADDING,
    });
    expect(artwork).toEqual({ width: 96, height: 96 });
  });

  // Also deliberate, and the opposite rule: padding an already-tiny toolbar
  // icon only makes it smaller, so these bleed to the canvas edge.
  it.each([16, 32, 48] as const)('lets the %ipx toolbar icon fill its canvas', (size) => {
    const { padding, artwork } = measureAlpha(bitmap(size));

    expect(padding).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(artwork).toEqual({ width: size, height: size });
  });
});
