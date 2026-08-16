import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Proves the security lint rules actually fail on violations.
 *
 * A lint rule nobody has seen fire is a rule you are hoping works. These cases
 * run the project's real eslint.config.js against violating source and assert
 * an error is reported, so the guard cannot silently rot.
 *
 * Code is linted from strings with a synthetic file path — no fixture files on
 * disk that would themselves have to be exempted from `npm run lint`.
 */

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(code: string, filePath = 'lib/__violation__.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? 'unknown');
}

describe('HTML injection sinks are blocked', () => {
  it.each([
    ['innerHTML assignment', 'export function f(el: HTMLElement, s: string) { el.innerHTML = s; }'],
    ['innerHTML read', 'export function f(el: HTMLElement) { return el.innerHTML; }'],
    ['outerHTML assignment', 'export function f(el: HTMLElement, s: string) { el.outerHTML = s; }'],
    [
      'insertAdjacentHTML',
      'export function f(el: HTMLElement, s: string) { el.insertAdjacentHTML("beforeend", s); }',
    ],
    [
      'computed innerHTML access',
      'export function f(el: HTMLElement, s: string) { el["innerHTML"] = s; }',
    ],
    ['document.write', 'export function f(s: string) { document.write(s); }'],
  ])('rejects %s', async (_name, code) => {
    expect(await lint(code)).not.toEqual([]);
  });

  it.each([
    [
      'dangerouslySetInnerHTML as a JSX attribute',
      'export const C = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;',
    ],
    [
      'dangerouslySetInnerHTML as an object property',
      'export const props = { dangerouslySetInnerHTML: { __html: "x" } };',
    ],
  ])('rejects %s', async (_name, code) => {
    expect(await lint(code, 'ui/__violation__.tsx')).not.toEqual([]);
  });
});

describe('dynamic code execution is blocked', () => {
  it.each([
    ['eval', 'export function f(s: string) { return eval(s); }'],
    ['new Function', 'export function f(s: string) { return new Function(s); }'],
    ['Function called without new', 'export function f(s: string) { return Function(s); }'],
    ['setTimeout with a string body', 'export function f() { setTimeout("doThing()", 0); }'],
    // Assembled at runtime so this test file does not trip its own rule.
    ['a script URL', `export const href = "java${'script'}:alert(1)";`],
    [
      'dynamic import of a computed specifier (remote code)',
      'export async function f(url: string) { return import(url); }',
    ],
  ])('rejects %s', async (_name, code) => {
    expect(await lint(code)).not.toEqual([]);
  });

  it('reports the expected rule for eval', async () => {
    expect(await lint('export function f(s: string) { return eval(s); }')).toContain('no-eval');
  });
});

describe('ad-hoc cross-surface messaging is blocked outside lib/messaging.ts', () => {
  it('rejects a raw sendMessage in a component', async () => {
    const code = 'import { browser } from "#imports";\nbrowser.runtime.sendMessage({ a: 1 });\n';
    expect(await lint(code, 'entrypoints/popup/__violation__.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('rejects a raw onMessage listener outside the messaging module', async () => {
    const code =
      'import { browser } from "#imports";\nbrowser.runtime.onMessage.addListener(() => {});\n';
    expect(await lint(code, 'entrypoints/__violation__.ts')).toContain('no-restricted-syntax');
  });

  it('rejects a computed sendMessage call, which reaches the same API', async () => {
    const code =
      'import { browser } from "#imports";\nbrowser.runtime["sendMessage"]({ a: 1 });\n';
    expect(await lint(code, 'entrypoints/popup/__violation__.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('rejects a computed onMessage listener', async () => {
    const code =
      'import { browser } from "#imports";\nbrowser.runtime["onMessage"].addListener(() => {});\n';
    expect(await lint(code, 'entrypoints/__violation__.ts')).toContain('no-restricted-syntax');
  });

  it('allows the raw API inside lib/messaging.ts, which owns the transport', async () => {
    const code =
      'import { browser } from "#imports";\nexport const send = (m: unknown) => browser.runtime.sendMessage(m);\n';
    expect(await lint(code, 'lib/messaging.ts')).toEqual([]);
  });

  it('allows computed access inside lib/messaging.ts too', async () => {
    const code =
      'import { browser } from "#imports";\nexport const send = (m: unknown) => browser.runtime["sendMessage"](m);\n';
    expect(await lint(code, 'lib/messaging.ts')).toEqual([]);
  });
});

describe('clean code passes', () => {
  it('accepts DOM building via textContent', async () => {
    const code =
      'export function f(el: HTMLElement, s: string) { el.textContent = s; }\n';
    expect(await lint(code)).toEqual([]);
  });

  it('accepts a static import', async () => {
    const code = 'import { z } from "zod";\nexport const s = z.string();\n';
    expect(await lint(code)).toEqual([]);
  });
});

describe('the real source tree is clean', () => {
  it('reports no lint errors across the project', async () => {
    const results = await eslint.lintFiles([
      'entrypoints/**/*.{ts,tsx}',
      'lib/**/*.ts',
      'ui/**/*.{ts,tsx}',
    ]);
    const errors = results.flatMap((result) =>
      result.messages
        .filter((message) => message.severity === 2)
        .map((message) => `${result.filePath}:${message.line} ${message.ruleId}`),
    );
    expect(errors).toEqual([]);
  });
});
