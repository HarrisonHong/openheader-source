# Architecture

A privacy-first HTTP header editor. The four foundation rules below are still
binding; the product sits on top of them.

## Layout

```
entrypoints/
  background.ts      MV3 service worker (stateless)
  popup/             profile switch + rule status, fixed 360px
  options/           the rule workbench, import/export, backups, settings
  welcome/           first-run onboarding (unlisted page)
lib/
  rules.ts           the domain model: pure schemas + immutable CRUD
  dnr.ts             compiles rules to declarativeNetRequest, and explains
                     every rule that will NOT apply
  match-patterns.ts  host-permission derivation and coverage
  modheader.ts       ModHeader export parsing (see modheader-import.md)
  rules-storage.ts   rule document, backups, the export/import file format
  rules-engine.ts    storage → compiler → Chrome, with read-back verification
  storage.ts         typed chrome.storage wrapper, schema-validated on read
  messaging.ts       typed message contracts between surfaces
  licensing.ts       payment seam (interface + local no-op impl)
  permissions.ts     optional API permissions + user-named host permissions
components/          product UI shared by the popup and the options page
ui/                  design-system primitives + tokens
scripts/             bundle verification, real-browser verification
                     (see security.md)
```

There is **no content script**, deliberately. Header editing goes through
`declarativeNetRequest`, which needs no injected code, and an unused content
script is an unjustifiable permission surface.

## The product rules

Beyond the four foundation rules, two product invariants are load-bearing. Each
exists because a competitor breaks it. (The numbering below is this document's
own and continues its foundation rules; the repository's agent-facing notes keep
a separate list.)

### Rule 5 — no permission at install

The manifest holds **no** host permissions and produces **no** install warning.
Site access is requested one host at a time, from a click, when a rule needs it,
and can be handed back. `debugger` is never requested at all. See
[permissions.md](permissions.md); `scripts/verify-bundle.mjs` fails the build on
any regression.

The consequence to be aware of: a rule must name the sites it may touch. A rule
whose conditions are a bare regex cannot have its sites inferred, so it is
reported as unsupported until the user names them. That is a deliberate trade —
the alternative is asking for `<all_urls>`.

### Rule 6 — a rule is never silently a no-op

`compileDocument()` returns a `RuleStatus` for **every** rule, including disabled
ones and ones in inactive profiles. A non-active status always carries a
specific, user-readable reason naming the field that caused it. The problems the
compiler detects rather than letting Chrome swallow:

| Code | What it catches |
| --- | --- |
| `append-not-supported` | Chrome only permits `append` on 21 named request headers; appending to any other is silently ignored by the browser. |
| `regex-unsupported` | `regexFilter` is RE2 — no lookaround, no backreferences. Chrome rejects these when the ruleset is installed. |
| `non-ascii-url-filter` | `urlFilter` is matched byte-wise and can never match a non-ASCII pattern. |
| `invalid-header-value` | NUL, CR or LF in a header value. Chrome refuses the **whole batch** over one of these, so uncaught it would make every rule a no-op; caught, it costs the one rule that owns it. A newline copied along with a bearer token is the realistic cause. Those three are the whole set — measured against Chrome 151 over CDP, which accepted tab, DEL, obs-text, other control characters, accented Latin, CJK and emoji. Do not widen this from the RFC: every value in that list works today, and refusing one would turn a working rule into "Won't apply" and blame the browser for it. |
| `site-too-broad`, `no-sites`, `undecidable-site` | A rule Chrome would refuse to apply for want of host access. |
| `rule-limit-exceeded` | Chrome caps "unsafe" dynamic rules; the overflow is reported instead of truncated. |
| `invalid-header-name`, `no-match`, `no-headers`, `no-resource-types` | A rule that cannot match or cannot act. |

The static regex check is a first pass; the service worker also asks Chrome
itself via `isRegexSupported()` and defers to its answer.

#### Rule 6, continued — the ruleset is verified against the browser

`applyRules()` replaces the whole dynamic ruleset (never diffs it — a diff that
drifts is how rules "stop working after an update"), then **reads it back** and
compares ids. A mismatch is an engine error shown in both surfaces. Chrome
accepting `updateDynamicRules` is not the same as Chrome keeping the rules.

And when Chrome refuses the set outright, no rule may still claim to be applying.
`updateDynamicRules` is atomic, so the refusal takes every rule down together;
`withEngineRefusal()` rewrites each `active` status to `engine-refused` before
the state reaches any surface. A per-rule badge reading "Active" while the
browser is applying nothing is a worse failure than the incumbent's, because it
states the opposite of the truth rather than nothing at all. Statuses that were
already reporting their own reason are left alone — that reason is the more
useful one.

The trigger is a `refused` flag that `install()` raises **only** where
`updateDynamicRules` itself threw, never the engine-error text. Three other
things set an engine error and none of them is a refusal: a failed read of the
current rules happens before the update, so the previously installed set is
untouched and still applying; a failed read-back happens after a successful
update; and a compiler safeguard error has already downgraded the one rule it
concerns while the rest installed normally. Rewriting statuses in those cases
would say "parked" about headers Chrome is still sending — the same lie as a
stale "Active", pointing the other way.

## Exclusions, and why they need a priority band

`declarativeNetRequest` has `excludedRequestDomains` but **no** excluded-URL or
excluded-regex condition. Header Editor Lite's Chrome build simply cannot do
regex exclusions as a result. We can, at the cost of one documented caveat:

- A **domain** exclusion compiles to `excludedRequestDomains` — native, per-rule,
  exact.
- A **URL or regex** exclusion compiles to a higher-priority `allow` rule. Chrome
  applies only those `modifyHeaders` rules whose priority is *strictly greater*
  than any matching `allow`.

An `allow` rule is scoped to the request, not to the rule that produced it, so
three priority bands keep the blast radius as small as it can be:

| Band | Priority | Contents |
| --- | --- | --- |
| Plain | 3 | Rules with no URL-shaped exclusion. Above the allow band, so no other rule's exclusion can reach them. |
| Allow | 2 | The exclusions, each carrying its own rule's resource-type and method conditions — plus its domains, but only when the rule matches on domains *alone*. |
| Suppressible | 1 | Rules that have a URL-shaped exclusion. |

The domain scoping on an `allow` rule is conditional on purpose. When a rule
matches on domains *and* on a URL or regex condition, those domains do not
describe everywhere the rule applies, so scoping the exemption to them would
leave the other branch unexcluded — the exclusion quietly ceasing to exclude,
which is the failure this whole module is built against. In that case the `allow`
is left unscoped, which can only ever over-suppress, inside the band that already
carries the warning below.

That leaves exactly one residual interaction: two rules that **both** use
URL-shaped exclusions share the suppressible band, so a request excluded by one
is exempt from the other. This cannot be expressed away — with n ≥ 2 such rules
the required priority ordering is provably cyclic — so the compiler detects it
and attaches a `shared-exclusion-band` warning to every affected rule, naming the
count and recommending domain exclusions. Reported loudly beats surprising.

## Rule storage and backups

Rules live in `headers:document` through the same versioned, schema-validated
envelope as everything else. On top of that, `lib/rules-engine.ts` snapshots the
rule set into `headers:backups` before every **import**, **restore**, **migration**
and **extension update**, keeping the raw stored bytes alongside the validated
document so even a lossy migration is recoverable. Restoring snapshots what it
replaces first. The cap is 12; dropping the oldest is announced, never silent.

"My rules vanished after an update" is the single most damaging complaint in this
category. It is designed against, not hoped against.

## Rule 1 — the service worker is stateless

Chrome terminates the MV3 service worker at any moment, with no warning and no
chance to flush. Anything held in worker memory is gone.

Therefore, in `entrypoints/background.ts`:

- **No module-scope mutable variables.** Anything read in a later event must have
  been written to `lib/storage.ts` in an earlier one.
- **All listeners are registered synchronously at the top level**, inside
  `defineBackground()`. A worker revived to deliver an event must already have a
  listener for it; registering inside a promise callback is a race.
- **Handlers are self-contained**: read state, act, write state.

If you find yourself wanting a module-level cache in the worker, you want
`lib/storage.ts`.

## Rule 2 — all cross-surface communication is a typed contract

`lib/messaging.ts` owns the entire message layer. Every message is declared in
`MESSAGE_CONTRACTS` with a Zod schema for **both** its request and its response.

- `sendMessage(type, payload)` validates the request, sends it, and validates the
  response. It rejects with a `MessagingError` rather than returning an
  unvalidated value.
- `createMessageRouter(handlers)` is a **pure function** — message in, response
  envelope out, no browser APIs. `registerMessageHandlers()` is a thin adapter
  over it. That is why the contracts are testable without a browser.
- Handler responses are validated on the way out too. A handler that drifts from
  its contract is caught at the boundary, not three surfaces downstream.
- Foreign messages (from other extensions, or with the wrong protocol version)
  are rejected, not guessed at. The listener returns `false` for them so it does
  not hijack messages belonging to other listeners.

**ESLint enforces this mechanically.** `browser.runtime.sendMessage` and
`browser.runtime.onMessage` are banned everywhere except `lib/messaging.ts` via
`no-restricted-syntax`. See `tests/security-lint.test.ts`.

## Rule 3 — storage is validated on the way in

Every record is wrapped in a versioned envelope:

```jsonc
{ "version": 1, "data": { /* the value */ } }
```

`item.get()` returns a discriminated union, never a bare value:

```ts
{ ok: true;  value: T; source: 'stored' | 'default'; migrated: boolean }
{ ok: false; error: StorageValidationError }
```

Failure modes, all loud:

| Reason | Meaning |
| --- | --- |
| `malformed-envelope` | Stored value is not `{ version, data }` at all |
| `version-ahead` | Written by a NEWER build; refuse to downgrade it |
| `migration-missing` | Gap in the migration chain |
| `migration-failed` | A migration threw |
| `schema-mismatch` | Data does not satisfy the current schema |
| `backend-unavailable` | `chrome.storage` itself failed |

A corrupt record **must not** silently become the default value — that hides data
loss from the user. See `loadDocument()` in `lib/rules-engine.ts` for the
pattern: it quarantines the unreadable bytes before anything overwrites them and
returns a `recoveryError` that `components/EngineAlerts.tsx` shows, rather than
handing back an empty rule set that looks like a fresh install.

### Quarantine

A caller that cannot read a record but must carry on anyway — the service worker
handling `onInstalled` is the only one today — calls `item.quarantine(detail)`
first. That copies the raw stored bytes to the next free generational key
(`<key>.quarantine.1`, `.2`, …) and leaves them there, so writing a fresh default
afterwards cannot destroy a record written by a newer build. It also warns to the
console, because silent recovery from data loss is indistinguishable from no data
loss at all.

Every occurrence is preserved, so a later failure never has to choose between
clobbering an earlier copy and discarding the newer record. Generations are
capped at `MAX_QUARANTINE_GENERATIONS`, since a record that fails to read on
every event would otherwise consume the storage quota. At the cap the **newest**
record wins — it carries the user's current data — by displacing the oldest copy,
and the drop is announced rather than swallowed.

Writes are validated too. Writing an invalid value is a programmer error, so
`set()` throws rather than returning a result.

### Bumping a schema

1. Change the Zod schema.
2. Increment `version` on the storage item.
3. Add `migrations[newVersion]` — a function taking the **unvalidated** previous
   `data` and returning the new shape. It receives `unknown` because the schema
   it was written with no longer exists.
4. Add a test. `lib/storage.test.ts` covers the mechanism generically; add a case
   for your specific transformation.

Gaps in the chain are a hard error, not a silent fallback.

### Why only `chrome.storage.local`

`chrome.storage.sync` would copy user data to the browser vendor's servers, which
contradicts [PRIVACY.md](../PRIVACY.md). Keeping storage local makes "nothing
leaves the device" an architectural property rather than a promise.

## Rule 4 — licensing is a seam, not an integration

`lib/licensing.ts` defines the `LicenseProvider` interface and ships
`LocalNoopLicenseProvider`. No vendor API is called. See
[licensing.md](licensing.md) for the full design and the offline grace policy.

## Decisions

### Preact over React

WXT officially supports React via `@wxt-dev/module-react`; Preact needs its Vite
plugin configured manually. We chose Preact anyway:

- **Bundle size.** React + ReactDOM is roughly 45 kB gzipped; Preact is about
  4 kB. In a popup that must paint instantly, that is the difference the user
  actually feels. There is no React-specific library this project needs.
- **The "manual configuration" is one tsconfig setting** (see below), not a
  maintenance burden.
- **API compatibility.** Hooks, JSX and component semantics are the same, so the
  React path remains available if a future dependency demands it — swap in
  `preact/compat` or the WXT React module without rewriting components.

### Preact without a Vite plugin

There is no `@preact/preset-vite` in this project. That plugin peer-depends on
`@babel/core`, which would pull a large dependency tree into the build for two
things: the JSX transform and hot-reload.

Instead, JSX is configured entirely in `tsconfig.json`:

```jsonc
"jsx": "react-jsx",
"jsxImportSource": "preact"
```

Vite reads these directly and compiles JSX to `preact/jsx-runtime`. Verified: the
production bundle contains Preact's renderer and no React. The cost is losing
component-level hot reload in `wxt dev`; WXT reloads the extension surface on
change anyway, which is adequate for a popup.

If component HMR becomes worth a Babel dependency, adding `@preact/preset-vite`
is a two-line change to `wxt.config.ts`.

### Auto-imports disabled

`imports: false` in `wxt.config.ts`. Every symbol has a visible import. Implicit
globals defeat lint rules (you cannot ban what you cannot see) and make review
harder. WXT APIs are imported explicitly from `#imports`.

### Chrome first, nothing Chrome-only

`manifestVersion: 3` and Chrome is the only target built today. Nothing in the
codebase is Chrome-specific: all extension API access goes through WXT's
`browser` namespace, so `wxt build -b firefox|edge|safari` remains available when
someone decides to run it.

## Testing

`vitest` with WXT's `WxtVitest` plugin, which supplies an in-memory
`fakeBrowser`. Tests cover:

| Area | File |
| --- | --- |
| Rule CRUD, profiles, structural validation | `lib/rules.test.ts` |
| Rule matching, regex, exclusions, and every reported problem | `lib/dnr.test.ts` |
| Host-permission derivation and coverage | `lib/match-patterns.test.ts` |
| ModHeader import, v1 and v2, against real-world fixtures | `lib/modheader.test.ts` |
| Backup retention and the export/import file format | `lib/rules-storage.test.ts` |
| The engine: install, read-back verification, backup/restore, import | `tests/rules-engine.test.ts` |
| Storage validation, corruption, version skew, migrations, quarantine | `lib/storage.test.ts` |
| `onInstalled`: first-run welcome, privacy re-notice, unreadable records | `tests/background.test.ts` |
| Message contracts, routing, transport failures | `lib/messaging.test.ts` |
| Licensing seam and offline grace path | `lib/licensing.test.ts` |
| Permission policy (over-broad origin rejection) | `lib/permissions.test.ts` |
| zod's `jitless` setting being in force before any schema is built | `lib/zod-config.test.ts` |
| WCAG AA contrast in both themes, parsed from the shipped CSS | `ui/tokens.test.ts` |
| The manifest's four icons existing, square, and sized to spec | `tests/icons.test.ts` |
| Security lint rules actually firing | `tests/security-lint.test.ts` |
| The built-bundle verifier firing on broken bundles | `tests/verify-bundle.test.ts` |
| The CI workflow calling that verifier, never an inline `node -e` | `tests/ci-workflow.test.ts` |

### Verifying in a real browser

`npm run verify:browser` (after `npm run build`) launches Chrome, installs the
built extension over CDP, creates a rule through the real message contract, and
reads the headers a real page received on a `fetch` POST and an
`XMLHttpRequest`. It is not part of `npm run check` because it needs a Chrome
binary, but it is the only check that proves the product actually works.

It also saves two rules together, one of them carrying a header value Chrome
would refuse, and asserts that the other rule's header still reaches a real
request — the atomic-batch failure under Rule 6, proven against the browser
rather than against a fake.

Four sharp edges it encodes, all of them expensive to rediscover:

- **Chrome 137+ ignores `--load-extension`**, and a puppeteer-launched Chrome
  adds `--disable-extensions`. Launch Chrome directly and install via the CDP
  `Extensions.loadUnpacked` command. An unpacked extension's id is the SHA-256 of
  its absolute path mapped to a–p, so it is stable per checkout.
- **A service worker cannot `sendMessage` to its own `onMessage` listener**, so
  message-contract calls have to run from an extension page.
- **Chrome's optional-permission confirmation is a native dialog** that headless
  Chrome never resolves and CDP cannot click, and seeding the grant into the
  profile's `Preferences` is undone by Chrome's protected-prefs MAC. The script
  therefore proves the no-access path against the shipped build and the
  header-application path against a copy whose manifest pre-grants
  `*://localhost/*` — which is exactly what the user's click produces.
- **A missing CDP `service_worker` target is normal**, not a failure — the MV3
  worker terminates constantly. Send it a message to wake it.
