import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Proves `scripts/verify-parity.mjs` actually fails on a divergent build.
 *
 * It is what turns "the Chrome and Edge builds are byte-identical" from a
 * sentence in `README.md`, `PRIVACY.md`, `docs/architecture.md` and
 * `docs/edge.md` into something the build re-measures. A gate that cannot fail
 * would leave all four documents asserting a fact nothing checks — so each case
 * below lays down two deliberately divergent builds in temp directories and
 * asserts rejection, the same way `tests/verify-bundle.test.ts` proves the
 * bundle checks fire.
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/verify-parity.mjs');

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'fixture', version: '1.0.0' }, null, 2);

/** A build as a path → contents map, so a case can diverge exactly one file. */
const BUILD: Record<string, string> = {
  'manifest.json': MANIFEST,
  'background.js': 'export const run = () => 1;\n',
  'chunks/ui.js': 'export const ui = 2;\n',
  'options.html': '<!doctype html><title>options</title>\n',
  'assets/ui.css': ':root { color: red; }\n',
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-parity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>): string {
  const target = join(root, dir);
  mkdirSync(target, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(target, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return target;
}

/** Lays down both builds and runs the real script over them. */
function verify(
  chrome: Record<string, string> = BUILD,
  edge: Record<string, string> = BUILD,
): { ok: boolean; output: string } {
  const chromeDir = write('chrome-mv3', chrome);
  const edgeDir = write('edge-mv3', edge);
  const result = spawnSync(process.execPath, [SCRIPT, chromeDir, edgeDir], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe('two identical builds', () => {
  it('pass', () => {
    expect(verify().ok).toBe(true);
  });
});

describe('a divergent build', () => {
  it('is rejected when the manifest differs by one byte', () => {
    const { ok, output } = verify(BUILD, { ...BUILD, 'manifest.json': `${MANIFEST} ` });
    expect(ok).toBe(false);
    expect(output).toContain('manifest.json differs');
  });

  it('is rejected when a JS file differs by one byte', () => {
    const { ok, output } = verify(BUILD, { ...BUILD, 'background.js': 'export const run = () => 2;\n' });
    expect(ok).toBe(false);
    expect(output).toContain('background.js differs');
  });

  it('is rejected when a JS file exists in only one build', () => {
    const { ok, output } = verify({ ...BUILD, 'chunks/edge-only.js': 'export const x = 1;\n' });
    expect(ok).toBe(false);
    expect(output).toContain('chunks/edge-only.js');
  });

  it.each([
    ['HTML', 'options.html', '<!doctype html><title>different</title>\n'],
    ['CSS', 'assets/ui.css', ':root { color: blue; }\n'],
  ])('is rejected when the %s differs — not only the manifest and the JS', (_kind, file, changed) => {
    // README.md and PRIVACY.md claim byte-identity without qualification, so
    // every emitted file is in scope, not just the two the security checks read.
    const { ok, output } = verify(BUILD, { ...BUILD, [file]: changed });
    expect(ok).toBe(false);
    expect(output).toContain(`${file} differs`);
  });
});

describe('a build that is not there', () => {
  it('is rejected rather than compared to nothing', () => {
    const chromeDir = write('chrome-mv3', BUILD);
    const result = spawnSync(process.execPath, [SCRIPT, chromeDir, join(root, 'absent')], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
  });

  it('does not let two empty directories compare equal', () => {
    // The failure that would make this whole gate decorative: nothing built,
    // nothing to differ, green.
    const { ok, output } = verify({}, {});
    expect(ok).toBe(false);
    expect(output).toContain('is it built?');
  });
});
