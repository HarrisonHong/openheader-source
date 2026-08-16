# Security

Verified against
[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security).

## Posture

Secure by default. Every item below is enforced by configuration, lint, or a
test — not by remembering.

| Requirement | How it is enforced | Where |
| --- | --- | --- |
| Minimal permissions | Three warning-free permissions, each justified; no host access at install | `wxt.config.ts`, [permissions.md](permissions.md) |
| Never `debugger` | Build fails if it appears, optional or not | `scripts/verify-bundle.mjs`, `tests/verify-bundle.test.ts` |
| No `<all_urls>` / granted wildcard hosts | Runtime rejection + tests + shipped-manifest check | `lib/permissions.ts`, `lib/permissions.test.ts`, `scripts/verify-bundle.mjs` |
| Optional permissions need a justification | Registry requires the field | `lib/permissions.ts` |
| Locked CSP | `script-src 'self'; object-src 'none'; connect-src 'none';` | `wxt.config.ts` |
| No network access from the shipped bundle | Every network sink in shipped JS is a finding unless declared benign, plus a browser-enforced `connect-src` | `scripts/verify-bundle.mjs`, [below](#network-access-in-dependencies-honestly) |
| No `eval` / `new Function` in our source | `no-eval`, `no-implied-eval`, `no-new-func`, `no-restricted-syntax` | `eslint.config.js` |
| No *reachable* dynamic code in the shipped bundle | Every `Function` reference in shipped JS is a finding unless declared benign | `scripts/verify-bundle.mjs`, [below](#dynamic-code-in-dependencies-honestly) |
| No `innerHTML` / `dangerouslySetInnerHTML` | `no-restricted-properties`, `no-restricted-syntax` | `eslint.config.js` |
| No remote code | CSP + ban on non-literal dynamic `import()` | `eslint.config.js` |
| No ad-hoc messaging | `runtime.sendMessage` / `onMessage` banned outside `lib/messaging.ts` | `eslint.config.js` |
| Lint rules actually fire | Every rule proven against violating source | `tests/security-lint.test.ts` |
| The BUILT bundle still matches this posture | `npm run verify:bundle`, in `npm run check` and CI | `scripts/verify-bundle.mjs` |
| The bundle verifier actually fires | Proven against deliberately broken bundles | `tests/verify-bundle.test.ts` |
| Dependency audit | `npm audit --audit-level=moderate` | `.github/workflows/ci.yml` |
| Zero data collection | No network code, local storage only | [PRIVACY.md](../PRIVACY.md) |

## Content Security Policy

```
script-src 'self'; object-src 'none'; connect-src 'none';
```

`'self'` permits only scripts bundled in the extension package. `wasm-unsafe-eval`
is deliberately **not** included — no WebAssembly is used, so allowing it would
widen the policy for nothing.

`connect-src 'none'` is the browser-enforced half of "nothing leaves this
device": whatever any shipped line of code asks for, an extension page can open
no connection at all. `'none'` rather than `'self'` because `'none'` is what
[PRIVACY.md](../PRIVACY.md) actually claims — the extension makes no requests,
not "only local ones". The single `fetch` in the bundle is in Vite's
`modulepreload` polyfill, which returns before reaching it in any browser with
native modulepreload support; see below.

`verify-bundle.mjs` checks this as an **allowlist**: the `connect-src` source
list must be exactly `'none'`, and anything else fails, whatever it contains. An
earlier version of that check was a denylist of scheme tokens (`*`, `https:`,
`blob:` …), and it would have passed
`connect-src 'self' https://collector.example.com` — a named exfiltration
endpoint — with every guard green. Chrome polices `script-src` in an MV3 manifest
itself; it does not police `connect-src` at all, so this script is the only thing
standing behind the claim, and it now asserts the property rather than
enumerating ways to violate it.

## No remote code

MV3 policy, not preference. All logic ships inside the package:

- No CDN script tags, no remote stylesheets, no remote fonts.
- No `import()` of a computed specifier — lint rejects
  `ImportExpression[source.type!="Literal"]`.
- Dependencies are bundled and **exactly version-pinned** (no `^`, no `~`), with
  `package-lock.json` committed.
- No `chrome.scripting.executeScript` anywhere; MV3 forbids the string form in any
  case.

## Dynamic code in dependencies, honestly

An earlier version of this page claimed there was no `eval(` or `new Function(`
in any shipped `.js`, dependency code included. That claim was checked by
searching for those two spellings, and it was false: `const F = Function;
new F(body)` reaches the identical sink, matches neither spelling, and is what a
minifier emits anyway. It is also exactly the shape of the incident this product
exists because of — dynamic codegen inside a dependency, invisible to the
project's own scanner. The check and the claim are now both stricter and both
narrower than "the string does not appear".

**What is actually checked.** `scripts/verify-bundle.mjs` treats *any* reference
to the `Function` constructor in shipped JS as a finding — `new Function(`,
`Function(`, `const F = Function`, and reaching it back through `.constructor(`
or `["constructor"]` — plus `eval(` including through member access. Each match
must be individually declared in that script's `KNOWN_DYNAMIC_CODE` list with the
reason it cannot execute; anything undeclared fails the build. The declarations
are anchored on surrounding code, not on identifier names, so a dependency bump
that changes the code stops matching and forces someone to read it again.

**What is declared, and why.** zod 4.4.3 ships two such paths, in both
`background.js` and the shared UI chunk:

| Match | Source | Why it cannot execute |
| --- | --- | --- |
| `allowsEval` capability probe | `zod/v4/core/util.js` | `lib/zod-config.ts` sets `z.config({ jitless: true })`, which returns `false` before the probe. |
| `Doc.compile()` validator generator | `zod/v4/core/doc.js` | Only reached from the `allowsEval` path that `jitless` turns off. |

zod reads `jitless` when a schema is **constructed**, not when it is parsed, and
constructing a schema is what evaluates the probe. So the setting cannot be a
line at the top of one convenient module and hope for the right evaluation
order: `lib/zod-config.ts` holds it alone, every schema module imports it as its
first import, and `lib/zod-config.test.ts` proves it is already in force once any
schema module has loaded.

Preact's `Component.prototype.render` delegates to `this.constructor(props,
context)`; `this` is a component instance, never a function, so it is not a route
to the `Function` constructor.

One side effect worth stating, because it will show up in anyone's grep: the
`allowsEval` probe reads `navigator.userAgent` — zod checks for Cloudflare
Workers before trying to compile. `jitless` short-circuits that test before the
read, so an extension marketed on collecting nothing does not in fact touch a
browser identifier. The string survives in the bundle; the read does not happen.

**The residual, stated plainly.** The guarantee is "no dynamic code this
extension can reach", not "the string `Function` appears nowhere in the bundle".
The MV3 CSP (`script-src 'self'`, no `unsafe-eval`, no `wasm-unsafe-eval`) is the
second, independent barrier: all three forms are blocked from inside the
extension package regardless of what the code says. `jitless` is set so the probe
does not even attempt it and raise a `securitypolicyviolation`.

`tests/verify-bundle.test.ts` proves each widened pattern fires, including the
aliased form the old check missed.

## Network access in dependencies, honestly

"No network requests of any kind" is the first thing this product claims and the
whole reason it exists — the incumbent's collector was in a *signed build*, not
in its source. Reading our own code cannot establish that claim: a dependency or
a build-tool change can add a request nobody wrote. So the shipped JS is scanned
for the sinks themselves.

**What is actually checked.** `scripts/verify-bundle.mjs` treats any occurrence
of `fetch(`, `.fetch(`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`,
`EventSource` or `importScripts(` in shipped JS as a finding. Each must be
declared in that script's `KNOWN_NETWORK_SINKS` with the reason it does not reach
the network; anything undeclared fails the build. Same discipline, and the same
anchored-on-surrounding-code patterns, as `KNOWN_DYNAMIC_CODE`.

**What is declared, and why.**

| Match | Source | Why it reaches no server |
| --- | --- | --- |
| `fetch(link.href, …)` in the `modulepreload` polyfill | Vite | It is unreachable in Chrome: the polyfill's first statement returns on `relList.supports('modulepreload')`, which Chrome has supported since 66. Its target would be a `chrome-extension://` URL inside this package in any case, and `connect-src 'none'` refuses it. |

**The residual, stated plainly.** The guarantee is "no shipped code that reaches
a server, and a CSP that would stop it anyway", not "these words appear nowhere
in the bundle". A sink reached through a computed property (`globalThis['fe'+'tch']`)
would not match the scan — `connect-src 'none'` is the barrier that does not
depend on spelling, which is why both exist rather than either alone.

## The `innerHTML` rule, honestly

The lint rule blocks HTML-injection sinks in **our** source, and
`tests/security-lint.test.ts` proves it fires on every variant, including
computed access (`el["innerHTML"]`) and `dangerouslySetInnerHTML` as both a JSX
attribute and an object property.

Preact's own renderer contains an `innerHTML` assignment — it is how the library
implements `dangerouslySetInnerHTML`. That codepath is unreachable from this
codebase because nothing here ever sets that prop, and the lint rule prevents
anyone from starting. Any framework (React, Vue, Svelte) has the equivalent. This
is noted rather than hidden: the guarantee is "our code creates no injection
sink", not "the string `innerHTML` appears nowhere in the bundle".

All UI is built with JSX and text nodes. Preact escapes interpolated text.

## No secrets in the bundle

Everything shipped is public — a `.crx` is a zip file. There are no API keys,
tokens, or credentials in this repository, and the licensing design
([licensing.md](licensing.md)) deliberately targets a vendor whose license
endpoints need no client secret.

## Supply chain

Runtime dependencies — the entire list:

| Package | Version | Why |
| --- | --- | --- |
| `preact` | 10.29.7 | UI rendering. ~4 kB gzipped vs ~45 kB for React. |
| `zod` | 4.4.3 | Runtime schema validation. It *is* the storage/messaging safety property, not a convenience. |

Build/dev dependencies: `wxt`, `typescript`, `vitest`, `eslint`,
`typescript-eslint`, `@eslint/js`, `globals`, `@types/node` (types only, needed
because the tests and the build scripts legitimately run in Node). No Babel, no
framework plugin, no image library — the icons are finished PNGs committed under
`public/icon/`, so nothing generates them at build time.

Rules:

- Every version is exactly pinned.
- `package-lock.json` is committed.
- `npm audit --audit-level=moderate` gates CI.
- Every new dependency is justified in the PR that adds it.

Both runtime dependencies are MIT, and substantial portions of both ship in the
bundle with their comments minified away. Their notices are reproduced in full in
[THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md) — MIT requires it, and a
project that asks not to have its own notices stripped is in a poor position to
strip anyone else's. Adding a runtime dependency means adding it there too.

## Self-check

Run before every release:

```bash
npm run check                      # lint + typecheck + test + build + verify:bundle
npm audit --audit-level=moderate
```

`npm run check` ends with `npm run verify:bundle`, which inspects the built
output in `.output/chrome-mv3/` and fails on any of:

- a CSP missing `script-src 'self'` or `object-src 'none'`; containing
  `unsafe-eval`, `wasm-unsafe-eval`, or `unsafe-inline`; or a `connect-src`
  source list that is anything other than exactly `'none'`;
- a non-empty `host_permissions` or `optional_permissions`; an
  `optional_host_permissions` entry other than the declared `*://*/*` envelope;
  `<all_urls>` anywhere in the manifest; any of the permissions listed under
  "Hard limits" in [permissions.md](permissions.md); or a `permissions` entry
  with no row in that document;
- any `content_scripts`;
- `eval(` — including `window.eval(` and friends — or any reference to the
  `Function` constructor in any shipped `.js`, dependency code included, unless
  it is declared benign in `KNOWN_DYNAMIC_CODE` with a reason; see
  [above](#dynamic-code-in-dependencies-honestly);
- a network sink (`fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
  `EventSource`, `importScripts(`) in any shipped `.js` that is not declared in
  `KNOWN_NETWORK_SINKS`; see
  [above](#network-access-in-dependencies-honestly);
- no JS found at all, so a missing build cannot pass silently.

Do not hand-run a `grep` in place of it: the script is stricter, and
`tests/verify-bundle.test.ts` proves each of those checks fails when it should.
The one thing left to eyeball:

```bash
grep -rn "innerHTML" .output/chrome-mv3/ --include=*.js   # expect only Preact's renderer
```

`npm run verify:browser` goes one step further and installs the built extension
in a real Chrome, asserting the same permission surface from inside the running
extension and proving headers actually reach a `fetch` POST and an XHR with zero
console errors.

Then load unpacked and confirm zero console errors in the popup, the options
page, and the service worker.
