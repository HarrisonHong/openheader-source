import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the CI workflow against the bug that once made it fail every time.
 *
 * Bundle verification used to be an inline `node --input-type=module -e '...'`
 * whose JS body contained `script-src 'self'`. Inside a single-quoted shell
 * string those inner quotes close the string, so node received `script-src self`
 * — a condition the real CSP can never satisfy. The check was guaranteed to fail
 * while reporting a correctly locked-down CSP as broken. The logic now lives in
 * `scripts/verify-bundle.mjs`, where no shell quoting applies and
 * `npm run verify:bundle` runs byte-identical code locally and in CI.
 *
 * Each check below is a pure function of the workflow text and is proven against
 * a deliberately broken workflow as well as the real one, the same bar
 * `tests/security-lint.test.ts` holds the lint rules to. A guard nobody has seen
 * fail is a guard you are only hoping still guards.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * The workflow with YAML comments stripped. The comment above the verification
 * step quotes the broken `node -e` form on purpose to explain why it is banned,
 * and names `npm run verify:bundle` to say what replaced it. Prose must neither
 * trip the ban nor satisfy the presence check — only executed commands count.
 */
function commandsOf(workflow: string): string {
  return workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** True when a step actually runs the checked-in verification script. */
function runsBundleVerification(workflow: string): boolean {
  return commandsOf(workflow)
    .split('\n')
    .some((line) => /^\s*(-\s+)?run:\s*npm run verify:bundle\s*$/.test(line));
}

/**
 * True when a step verifies the EDGE build too. Edge is a shipped target, so
 * "it is Chromium, it will be fine" is exactly the assumption this asserts
 * against — the gate has to run on the artifact that ships.
 */
function runsEdgeBundleVerification(workflow: string): boolean {
  return commandsOf(workflow)
    .split('\n')
    .some((line) => /^\s*(-\s+)?run:\s*npm run verify:bundle:edge\s*$/.test(line));
}

/**
 * True when a step proves the two builds are the same artifact. The
 * byte-identity claim is load-bearing in three published documents, so it has
 * to be measured rather than remembered.
 */
function runsParityVerification(workflow: string): boolean {
  return commandsOf(workflow)
    .split('\n')
    .some((line) => /^\s*(-\s+)?run:\s*npm run verify:parity\s*$/.test(line));
}

/**
 * True when any command inlines a JS body into the shell. Flags `-e` and
 * `--eval` behind any number of other node flags, so neither
 * `node --input-type=module -e` nor `node --experimental-x --eval=...` slips by.
 */
function inlinesNodeScript(workflow: string): boolean {
  return /\bnode\b(\s+-[^\s]+)*\s+(-e|--eval)\b/.test(commandsOf(workflow));
}

/** The workflow as it would look if someone deleted the verification step. */
const WORKFLOW_WITHOUT_STEP = WORKFLOW.split('\n')
  .filter(
    (line) =>
      !/^\s*(-\s+)?(name:\s*Verify built bundle|run:\s*npm run verify:bundle)\s*$/.test(line),
  )
  .join('\n');

describe('CI workflow', () => {
  it('runs bundle verification through the checked-in script', () => {
    expect(runsBundleVerification(WORKFLOW)).toBe(true);
  });

  it('notices when the verification step is deleted', () => {
    // The explanatory comment still names the script, so a check that merely
    // searched the raw text for the string would stay green here.
    expect(WORKFLOW_WITHOUT_STEP).toContain('npm run verify:bundle');
    expect(runsBundleVerification(WORKFLOW_WITHOUT_STEP)).toBe(false);
  });

  it('never inlines a node script into the shell', () => {
    // `node -e` / `--eval` bodies get mangled by shell quoting. Anything worth
    // asserting belongs in a file under scripts/.
    expect(inlinesNodeScript(WORKFLOW)).toBe(false);
  });

  it.each([
    ['node -e', "      - run: node -e 'console.log(1)'"],
    ['node --input-type=module -e', "      - run: node --input-type=module -e 'x'"],
    ['node --eval', "      - run: node --eval 'x'"],
    ['node --input-type=module --eval=', "      - run: node --input-type=module --eval='x'"],
    ['node --experimental-strip-types -e', "      - run: node --experimental-strip-types -e 'x'"],
  ])('notices an inlined %s', (_name, step) => {
    expect(inlinesNodeScript(`${WORKFLOW}\n${step}\n`)).toBe(true);
  });

  it('does not mistake the explanatory comment for an inlined command', () => {
    expect(inlinesNodeScript("      # once an inline `node --input-type=module -e '...'`")).toBe(
      false,
    );
  });

  it('exposes the same verification locally as npm run verify:bundle', () => {
    expect(PACKAGE.scripts['verify:bundle']).toBe('node scripts/verify-bundle.mjs');
  });

  it('builds and verifies the Edge target in CI', () => {
    expect(runsEdgeBundleVerification(WORKFLOW)).toBe(true);
    expect(commandsOf(WORKFLOW)).toMatch(/run:\s*npm run build:edge\s*$/m);
  });

  it('notices when the Edge verification step is deleted', () => {
    const without = WORKFLOW.split('\n')
      .filter((line) => !/^\s*(-\s+)?run:\s*npm run verify:bundle:edge\s*$/.test(line))
      .join('\n');
    expect(runsEdgeBundleVerification(without)).toBe(false);
    // The Chrome check must not stand in for the Edge one: `verify:bundle` is a
    // prefix of `verify:bundle:edge`, so a looser test would still pass here.
    expect(runsBundleVerification(without)).toBe(true);
  });

  it('points the Edge verification at the Edge output directory', () => {
    expect(PACKAGE.scripts['verify:bundle:edge']).toBe(
      'node scripts/verify-bundle.mjs .output/edge-mv3',
    );
    expect(PACKAGE.scripts['build:edge']).toBe('wxt build -b edge');
  });

  it('verifies Chrome/Edge parity in CI', () => {
    expect(runsParityVerification(WORKFLOW)).toBe(true);
  });

  it('notices when the parity step is deleted', () => {
    const without = WORKFLOW.split('\n')
      .filter((line) => !/^\s*(-\s+)?run:\s*npm run verify:parity\s*$/.test(line))
      .join('\n');
    expect(runsParityVerification(without)).toBe(false);
    // The explanatory comment still names the script, so a raw-text search
    // would stay green here.
    expect(without).toContain('npm run verify:parity');
  });

  it('points parity verification at the checked-in script', () => {
    expect(PACKAGE.scripts['verify:parity']).toBe('node scripts/verify-parity.mjs');
  });

  it('makes the Edge browser check name its own binary', () => {
    // EXT_DIR alone would install the Edge build in google-chrome and pass — a
    // green run that proves nothing about Edge. EXPECT_BROWSER makes the script
    // refuse rather than default.
    expect(PACKAGE.scripts['verify:browser:edge']).toContain('EXT_DIR=.output/edge-mv3');
    expect(PACKAGE.scripts['verify:browser:edge']).toContain('EXPECT_BROWSER=edge');
  });

  it('includes bundle verification in the local check script', () => {
    // Local `npm run check` must exercise everything CI does, or CI-only
    // failures are discovered by pushing rather than by checking.
    expect(PACKAGE.scripts['check']).toContain('verify:bundle');
    expect(PACKAGE.scripts['check']).toContain('verify:bundle:edge');
    expect(PACKAGE.scripts['check']).toContain('build:edge');
    expect(PACKAGE.scripts['check']).toContain('verify:parity');
  });

  it('keeps the CSP assertions quoted in a place shell quoting cannot reach', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/verify-bundle.mjs'), 'utf8');
    expect(script).toContain("script-src 'self'");
    expect(script).toContain("object-src 'none'");
    expect(script).toContain("connect-src 'none'");
  });
});
