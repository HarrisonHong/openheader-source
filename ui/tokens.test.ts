import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Accessibility is a release requirement, so contrast is verified mechanically
 * against the file that actually ships rather than eyeballed once.
 *
 * The thresholds are WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text and
 * UI component boundaries.
 */

const TOKENS_CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);

const DARK_MARKER = '@media (prefers-color-scheme: dark)';

function parseCustomProperties(css: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

const markerIndex = TOKENS_CSS.indexOf(DARK_MARKER);

const lightTokens = parseCustomProperties(TOKENS_CSS.slice(0, markerIndex));
const darkOverrides = parseCustomProperties(TOKENS_CSS.slice(markerIndex));
const darkTokens = new Map([...lightTokens, ...darkOverrides]);

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

function token(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  if (!value) throw new Error(`Missing design token ${name}`);
  return value;
}

/** [foreground, background, minimum ratio, what it is] */
const TEXT_PAIRS: ReadonlyArray<[string, string, number, string]> = [
  ['--ui-color-text', '--ui-color-bg', 4.5, 'body text on page background'],
  ['--ui-color-text', '--ui-color-surface', 4.5, 'body text on surface'],
  ['--ui-color-text', '--ui-color-bg-subtle', 4.5, 'body text on subtle background'],
  ['--ui-color-text-muted', '--ui-color-bg', 4.5, 'muted text on page background'],
  ['--ui-color-text-muted', '--ui-color-surface', 4.5, 'muted text on surface'],
  ['--ui-color-text-muted', '--ui-color-bg-subtle', 4.5, 'muted text on subtle background'],
  ['--ui-color-on-accent', '--ui-color-accent', 4.5, 'primary button label'],
  ['--ui-color-on-accent', '--ui-color-accent-hover', 4.5, 'primary button label (hover)'],
  ['--ui-color-accent', '--ui-color-bg', 4.5, 'ghost button label'],
  ['--ui-color-accent', '--ui-color-surface', 4.5, 'link/ghost label on surface'],
  ['--ui-color-danger', '--ui-color-danger-bg', 4.5, 'error callout text'],
  ['--ui-color-success', '--ui-color-success-bg', 4.5, 'success callout text'],
  ['--ui-color-warning', '--ui-color-warning-bg', 4.5, 'warning callout text'],
];

/** Non-text contrast: focus rings, borders on interactive controls. */
const UI_PAIRS: ReadonlyArray<[string, string, number, string]> = [
  ['--ui-color-focus', '--ui-color-bg', 3, 'focus ring on page background'],
  ['--ui-color-focus', '--ui-color-surface', 3, 'focus ring on surface'],
  ['--ui-color-border-strong', '--ui-color-surface', 3, 'secondary button border'],
  ['--ui-color-border-strong', '--ui-color-bg', 3, 'switch track off-state'],
];

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
])('%s theme', (themeName, theme) => {
  it('defines every colour token', () => {
    const colourTokens = [...lightTokens.keys()].filter((name) => name.startsWith('--ui-color-'));
    expect(colourTokens.length).toBeGreaterThan(10);
    for (const name of colourTokens) {
      expect(theme.get(name), `${themeName}: ${name}`).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it.each([...TEXT_PAIRS, ...UI_PAIRS])(
    'meets AA for %s on %s (>= %s:1) — %s',
    (foreground, background, minimum) => {
      const ratio = contrastRatio(token(theme, foreground), token(theme, background));
      expect(
        Number(ratio.toFixed(2)),
        `${themeName}: ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );
});

describe('theme completeness', () => {
  it('overrides every colour token in dark mode', () => {
    const lightColours = [...lightTokens.keys()].filter((name) => name.startsWith('--ui-color-'));
    const missing = lightColours.filter((name) => !darkOverrides.has(name));
    // Both themes are defined from the start; retrofitting dark mode later is
    // the most common polish failure, so an unhandled token fails here.
    expect(missing).toEqual([]);
  });

  it('has no in-extension theme toggle — dark mode is driven by the OS only', () => {
    expect(TOKENS_CSS).toContain(DARK_MARKER);
    expect(TOKENS_CSS).not.toMatch(/\[data-theme/);
  });

  it('pins the popup to a well-behaved width inside Chromium 800x600 clamp', () => {
    expect(token(lightTokens, '--ui-popup-width')).toBe('360px');
    expect(parseInt(token(lightTokens, '--ui-popup-max-height'), 10)).toBeLessThanOrEqual(600);
  });

  it('uses the system font stack so the UI reads as browser chrome', () => {
    expect(token(lightTokens, '--ui-font-sans')).toMatch(/^\s*system-ui/);
  });
});
