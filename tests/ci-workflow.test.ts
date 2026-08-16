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

  it('includes bundle verification in the local check script', () => {
    // Local `npm run check` must exercise everything CI does, or CI-only
    // failures are discovered by pushing rather than by checking.
    expect(PACKAGE.scripts['check']).toContain('verify:bundle');
  });

  it('keeps the CSP assertions quoted in a place shell quoting cannot reach', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/verify-bundle.mjs'), 'utf8');
    expect(script).toContain("script-src 'self'");
    expect(script).toContain("object-src 'none'");
    expect(script).toContain("connect-src 'none'");
  });
});
