/**
 * Verifies the built extension, not the source. Lint and tests check what we
 * wrote; this checks what we ship, so a build-tool change cannot quietly widen
 * the security surface.
 *
 * It is a checked-in file rather than an inline `node -e '...'` in the CI
 * workflow for a specific reason: the assertions below contain single quotes
 * (`script-src 'self'`), which terminate a single-quoted shell string, so the
 * check would silently receive `script-src self` and never match. That bug
 * shipped once. A real file has no shell quoting to get wrong.
 *
 * Run: node scripts/verify-bundle.mjs [outDir]
 * Exits 0 when everything holds, 1 with a specific reason otherwise.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(process.argv[2] ?? '.output/chrome-mv3');

/** Permissions allowed to appear in the manifest. Each needs a row in docs/permissions.md. */
const ALLOWED_PERMISSIONS = new Set([
  'storage',
  'declarativeNetRequestWithHostAccess',
  'activeTab',
]);

/**
 * Permissions that must never ship, whatever else changes. `debugger` is the
 * cleanest thing distinguishing this product — the incumbent requests it from
 * every user at install — and shipping it would throw away the reason the
 * extension exists. Bare `declarativeNetRequest` triggers an install-time
 * warning and grants implicit reach, so only the WithHostAccess variant is
 * acceptable.
 */
const FORBIDDEN_PERMISSIONS = new Map([
  [
    'debugger',
    'the extension must never request the debugger permission — see docs/permissions.md and PRIVACY.md',
  ],
  [
    'declarativeNetRequest',
    'use declarativeNetRequestWithHostAccess instead: it shows no install warning and cannot act without a granted host',
  ],
  ['declarativeNetRequestFeedback', 'it exposes matched requests and is not needed to apply rules'],
  ['tabs', 'activeTab covers the one thing we need and shows no install warning'],
  ['webRequest', 'header editing goes through declarativeNetRequest; webRequest reads request bodies'],
  ['webRequestBlocking', 'not available in MV3 and would read every request'],
  ['<all_urls>', 'never'],
]);

/** Manifest keys that must stay empty — see docs/permissions.md "Hard limits". */
const MUST_BE_EMPTY = ['host_permissions', 'optional_permissions'];

/**
 * The only optional host patterns allowed to be declared. Declaring them grants
 * nothing and shows no install warning — it is the envelope Chrome requires
 * before `permissions.request()` may ask for a user-named origin, and every
 * origin actually requested is narrowed by `assertOriginIsNarrow()` in
 * lib/permissions.ts. Anything else here means someone widened the ask.
 */
const ALLOWED_OPTIONAL_HOST_PERMISSIONS = new Set(['*://*/*']);

/**
 * Dynamic-code sinks that must not survive into the shipped bundle.
 *
 * Spelling-based checks are not enough. `const F = Function; new F(body)` reaches
 * the same sink as `new Function(body)`, defeats a `new Function(` search, and is
 * what a minifier produces anyway — and it is exactly the shape of the incident
 * this product exists because of: dynamic codegen sitting in a dependency,
 * invisible to the project's own scanner. So the rule is stricter than the sink.
 * Any reference to the `Function` constructor in shipped JS is a finding, aliased
 * or not, as is reaching it back through `.constructor`. Benign matches are
 * declared one by one in `KNOWN_DYNAMIC_CODE`; anything else fails the build.
 *
 * Both names are matched through member access too, catching `window.eval(`,
 * `globalThis.eval(` and `globalThis.Function` — same sink, and the ESLint rules
 * cover only first-party source, not bundled dependencies. The leading `[^\w$]`
 * keeps `myeval(` and `asFunction` from matching.
 */
const DYNAMIC_CODE = [
  { pattern: /(^|[^\w])eval\s*\(/g, label: 'eval(' },
  { pattern: /new\s+Function\s*\(/g, label: 'new Function(' },
  { pattern: /(^|[^\w$])Function\b/g, label: 'the Function constructor' },
  { pattern: /\.\s*constructor\s*\(/g, label: '.constructor( — codegen through a constructor' },
  { pattern: /\[\s*(["'`])constructor\1\s*\]/g, label: 'computed ["constructor"] access' },
];

/**
 * Matches that are known, read, and unreachable — declared here rather than
 * papered over with a looser pattern. Each entry is stripped from a file before
 * the rules above run, so any occurrence that is not one of these fails the
 * build. The patterns anchor on surrounding code rather than identifier names,
 * because a minifier renames identifiers on every build; if one stops matching
 * after a dependency bump, that is the point — read the new code before
 * re-declaring it. Why each of these cannot execute is in docs/security.md.
 */
const KNOWN_DYNAMIC_CODE = [
  {
    id: 'zod-allows-eval-probe',
    // zod 4.4.3, v4/core/util.js `allowsEval`: a capability probe. `jitless` is
    // set in lib/zod-config.ts — its own module precisely because evaluation
    // order decides this — and returns false above this line, so the probe never
    // runs; the extension CSP would block it in any case.
    pattern: /includes\(`Cloudflare`\)\)return\s*!1;\s*try\s*\{\s*return Function\(``\)\s*,\s*!0\s*\}/g,
  },
  {
    id: 'zod-doc-compile',
    // zod 4.4.3, v4/core/doc.js `Doc.compile()`: the JIT validator generator,
    // only reached from the `allowsEval` path that lib/zod-config.ts turns off.
    pattern: /compile\(\)\s*\{\s*(?:let|const|var)\s+[\w$]+\s*=\s*Function\s*,/g,
  },
  {
    id: 'preact-component-constructor',
    // preact 10.29.7: `Component.prototype.render` delegates to the component's
    // own constructor. `this` is a component instance, never a function, so this
    // is not a route to the Function constructor.
    pattern: /\{\s*return this\.constructor\([\w$]+\s*,\s*[\w$]+\)\s*\}/g,
  },
];

/**
 * Ways a shipped bundle could talk to a server. What ended the incumbent was a
 * collector nobody could see in a signed build, so reading the source is not
 * enough to promise zero data collection — a dependency or a build-tool change
 * can add a request nobody wrote. The shipped JS is scanned for the sinks
 * themselves, and every match must be declared in `KNOWN_NETWORK_SINKS` with the
 * reason it does not reach the network. The CSP's `connect-src` is the
 * independent second barrier.
 */
const NETWORK_SINKS = [
  { pattern: /(^|[^\w$.])fetch\s*\(/g, label: 'fetch(' },
  { pattern: /\.\s*fetch\s*\(/g, label: '.fetch(' },
  { pattern: /\bXMLHttpRequest\b/g, label: 'XMLHttpRequest' },
  { pattern: /\bsendBeacon\b/g, label: 'navigator.sendBeacon' },
  { pattern: /\bWebSocket\b/g, label: 'WebSocket' },
  { pattern: /\bEventSource\b/g, label: 'EventSource' },
  { pattern: /\bimportScripts\s*\(/g, label: 'importScripts(' },
];

const KNOWN_NETWORK_SINKS = [
  {
    id: 'vite-modulepreload-polyfill',
    // Vite's `modulepreload` polyfill fetches the extension's OWN chunk through
    // the href of a <link rel="modulepreload"> it just found in the document.
    // It never gets that far in a browser that supports modulepreload natively,
    // which Chrome has since 66: the polyfill's first statement returns on
    // `relList.supports('modulepreload')`. `connect-src 'none'` would refuse it
    // anyway. The `.ep` marker is the polyfill's own "already processed" flag
    // and is what anchors this.
    pattern:
      /if\([\w$]+\.ep\)return;[\w$]+\.ep=!0;\s*(?:let|const|var)\s+[\w$]+=[\w$]+\([\w$]+\);fetch\([\w$]+\.href,[\w$]+\)/g,
  },
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function readManifest() {
  const path = join(OUT_DIR, 'manifest.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    fail(`could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}

function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkJs(full);
    } else if (full.endsWith('.js')) {
      yield full;
    }
  }
}

const manifest = readManifest();

if (manifest) {
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  for (const directive of ["script-src 'self'", "object-src 'none'"]) {
    if (!csp.includes(directive)) {
      fail(`CSP is missing "${directive}". Actual extension_pages CSP: ${csp || '(none)'}`);
    }
  }
  // Anything that re-enables dynamic code execution defeats the point.
  for (const forbidden of ['unsafe-eval', 'wasm-unsafe-eval', 'unsafe-inline']) {
    if (csp.includes(forbidden)) {
      fail(`CSP contains "${forbidden}", which re-enables dynamic code. Actual CSP: ${csp}`);
    }
  }

  // `connect-src 'none'` is the browser-enforced half of "nothing leaves this
  // device". Checked as an allowlist — the source list must be exactly `'none'` —
  // because the realistic way this directive widens is a concrete host, and no
  // denylist of schemes catches `connect-src 'self' https://collector.example.com`.
  // Chrome polices `script-src` in an MV3 manifest itself but does not police
  // `connect-src` at all, so this check is the only thing standing behind
  // PRIVACY.md's claim that the extension makes no network requests.
  const connectSrc = /(?:^|;)\s*connect-src([^;]*)/.exec(csp);
  if (!connectSrc) {
    fail(`CSP is missing "connect-src 'none'". Actual extension_pages CSP: ${csp || '(none)'}`);
  } else {
    const sources = connectSrc[1].trim().split(/\s+/).filter(Boolean);
    if (sources.length !== 1 || sources[0] !== "'none'") {
      fail(
        "connect-src must be exactly 'none' — this extension opens no connections, to anywhere " +
          `(see PRIVACY.md). Found: connect-src ${sources.join(' ') || '(empty)'}`,
      );
    }
  }

  for (const key of MUST_BE_EMPTY) {
    const value = manifest[key] ?? [];
    if (value.length > 0) {
      fail(`${key} must stay empty, found: ${JSON.stringify(value)}`);
    }
  }

  const declaredPermissions = [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ];

  for (const permission of declaredPermissions) {
    const why = FORBIDDEN_PERMISSIONS.get(permission);
    if (why) fail(`forbidden permission "${permission}": ${why}`);
  }

  const extra = (manifest.permissions ?? []).filter((p) => !ALLOWED_PERMISSIONS.has(p));
  if (extra.length > 0) {
    fail(
      `undocumented permission(s): ${extra.join(', ')} — add a row to docs/permissions.md, ` +
        'then add them to ALLOWED_PERMISSIONS in this script',
    );
  }

  const optionalHosts = manifest.optional_host_permissions ?? [];
  const unexpectedHosts = optionalHosts.filter(
    (pattern) => !ALLOWED_OPTIONAL_HOST_PERMISSIONS.has(pattern),
  );
  if (unexpectedHosts.length > 0) {
    fail(
      `optional_host_permissions may only declare ${[...ALLOWED_OPTIONAL_HOST_PERMISSIONS].join(', ')}, ` +
        `found: ${JSON.stringify(unexpectedHosts)}`,
    );
  }

  // `<all_urls>` anywhere in the manifest — permissions, optional hosts, a
  // content script's matches — is an automatic failure. See docs/permissions.md.
  if (JSON.stringify(manifest).includes('<all_urls>')) {
    fail('the manifest contains <all_urls>, which this extension never requests');
  }

  // A content script would need host access nothing has justified.
  if ((manifest.content_scripts ?? []).length > 0) {
    fail('content_scripts must stay empty — see docs/architecture.md');
  }
}

/**
 * The two bundle scans, each with its own declared-benign list. Same discipline
 * for both: an undeclared match fails the build.
 */
const BUNDLE_SCANS = [
  { what: 'dynamic code', patterns: DYNAMIC_CODE, known: KNOWN_DYNAMIC_CODE },
  { what: 'network access', patterns: NETWORK_SINKS, known: KNOWN_NETWORK_SINKS },
];

/**
 * Blanks out every declared-benign occurrence, keeping the file's length so the
 * offsets in any remaining finding still point at real code.
 */
function withoutKnownMatches(source, known, exempted) {
  let remaining = source;
  for (const { id, pattern } of known) {
    pattern.lastIndex = 0;
    remaining = remaining.replace(pattern, (match) => {
      exempted.set(id, (exempted.get(id) ?? 0) + 1);
      return ' '.repeat(match.length);
    });
  }
  return remaining;
}

/** A little context either side, so a failure can be read without opening the file. */
function excerpt(source, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(source.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

let scanned = 0;
const exempted = new Map();
try {
  for (const file of walkJs(OUT_DIR)) {
    scanned++;
    const source = readFileSync(file, 'utf8');

    for (const { what, patterns, known } of BUNDLE_SCANS) {
      const scannable = withoutKnownMatches(source, known, exempted);

      // Ranges already reported, so `new Function(` is not counted a second time
      // by the broader bare-`Function` rule that follows it.
      const reported = [];
      for (const { pattern, label } of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(scannable)) !== null) {
          const start = match.index;
          const end = start + match[0].length;
          if (reported.some(([from, to]) => start < to && end > from)) continue;
          reported.push([start, end]);
          fail(
            `${label} found in built bundle: ${file}\n      ${excerpt(source, start, match[0].length)}\n` +
              `      If this cannot reach ${what === 'network access' ? 'the network' : 'a code sink'}, ` +
              `read it and declare it in ${what === 'network access' ? 'KNOWN_NETWORK_SINKS' : 'KNOWN_DYNAMIC_CODE'} ` +
              'in scripts/verify-bundle.mjs with the reason — do not widen the pattern.',
          );
        }
      }
    }
  }
} catch (cause) {
  fail(`could not scan ${OUT_DIR}: ${cause instanceof Error ? cause.message : String(cause)}`);
}

if (scanned === 0) {
  fail(`no .js files found under ${OUT_DIR} — did the build run?`);
}

if (failures.length > 0) {
  console.error(`bundle verification FAILED (${failures.length} problem(s)):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`bundle verification passed (${scanned} JS file(s) scanned in ${OUT_DIR})`);
for (const { what, known } of BUNDLE_SCANS) {
  for (const { id } of known) {
    const hits = exempted.get(id) ?? 0;
    console.log(
      hits > 0
        ? `  declared-benign ${what}: ${id} × ${hits}`
        : `  declared-benign ${what}: ${id} — no longer present, drop the declaration`,
    );
  }
}
