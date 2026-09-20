# Permissions

## The rule

**No permission ships without a row in the table below.**

A row is not a formality — it is the user-facing justification. If you cannot
write the "Why the user benefits" column in one plain sentence that a
non-technical person would accept, the permission does not ship.

This applies to `permissions`, `optional_permissions`, `host_permissions`, and
`optional_host_permissions` alike. All four are declared in `wxt.config.ts`.

## Hard limits

These are enforced, not merely encouraged:

| Limit | Enforced by |
| --- | --- |
| Never `<all_urls>`, anywhere in the manifest | `scripts/verify-bundle.mjs`, tested in `tests/verify-bundle.test.ts`; and `assertOriginIsNarrow()` in `lib/permissions.ts` at runtime |
| Never `debugger` | `FORBIDDEN_PERMISSIONS` in `scripts/verify-bundle.mjs` |
| Never plain `declarativeNetRequest`, `declarativeNetRequestFeedback`, `tabs`, `webRequest`, `webRequestBlocking` | same |
| Never a granted wildcard host permission (`*://*/*`, `https://*/*`) | `assertOriginIsNarrow()`, tested in `lib/permissions.test.ts` |
| Never a wildcard over a bare TLD (`*://*.com/*`) or over a *listed* public suffix (`*://*.co.uk/*`, `*://*.github.io/*`) — see [the honest version](#the-public-suffix-check-honestly) | same |
| `host_permissions` and `optional_permissions` stay empty | `scripts/verify-bundle.mjs` |
| `optional_host_permissions` declares exactly `*://*/*` and nothing else | same |
| Optional permissions cannot be requested unless declared with a justification | `OPTIONAL_PERMISSIONS` registry in `lib/permissions.ts` |

## Required permissions

Granted at install time. Keep this list as close to empty as the architecture
allows. **None of these produces an install-time permission warning.**

| Permission | Why the user benefits | Why it cannot be optional | Warning shown to user | Added |
| --- | --- | --- | --- | --- |
| `storage` | Remembers your rules and settings between sessions, on your device only. | The MV3 service worker is terminated by Chrome at any moment, so *all* state — rules, profiles, backups, onboarding status — must be persisted. Without it the extension cannot remember anything at all. It is also the mechanism that keeps data local instead of on a server. | None. | 2026-07-31 |
| `declarativeNetRequestWithHostAccess` | Lets your rules actually change request and response headers. | It is the API that performs the extension's single purpose. Chrome does not offer it as an optional permission, and a header editor that cannot edit headers has no first-run state worth showing. | None. Unlike plain `declarativeNetRequest`, the WithHostAccess variant shows **no** install warning and can act only on hosts you have separately granted. | 2026-07-31 |
| `activeTab` | Lets the popup offer "Allow on *this site*" for the page you are looking at. | It only has meaning at the moment you click the extension, which is exactly when the popup needs it. Chrome grants it for the active tab, for that invocation only, and it expires when the tab navigates. | None. | 2026-07-31 |

Every row above holds on Microsoft Edge as well as Chrome. Adding the Edge build
target widened nothing: the Edge manifest is byte-identical to the Chrome one.
Microsoft documents `declarativeNetRequestWithHostAccess` with the same
semantics we rely on, and the `optional_host_permissions` envelope — which
Microsoft's manifest reference omits — was tested directly in Edge 151 and
behaves as it does in Chrome. See [edge.md](edge.md).

### Why not `debugger`

`debugger` is Chrome's most invasive permission. It triggers a severe install
warning and a persistent *"… started debugging this browser"* banner, and the
incumbent (Header Editor Lite) requests it from **every** user at install even
though the only feature that needs it is response-**body** rewriting.

**This extension never requests it.** Response-body editing is not in the
product. If it is ever added it will be an opt-in module that calls
`requestPermission()` at the moment of use and offers `revokePermission()`
afterwards — the seam already exists in `lib/permissions.ts`. `verify-bundle.mjs`
fails the build if `debugger` appears in the manifest at all, optional or not.

### Why not plain `declarativeNetRequest`

The plain permission shows the "Block content on any page" install warning and
grants implicit reach for `allow`/`block` rules. `WithHostAccess` shows no
warning and cannot touch a host the user has not granted. It is strictly the
smaller ask, so it is the only acceptable form.

## Host permissions

**Empty at install, and expected to stay that way.** The extension starts with
access to no website whatsoever.

| Origin | Feature that needs it | Why `activeTab` is insufficient | Added |
| --- | --- | --- | --- |
| _(none)_ | | | |

## Optional host permissions

Requested at runtime, from a user gesture, one site at a time, when a rule needs
it. Requested through `requestOrigins()` in `lib/permissions.ts`, which runs
`assertOriginIsNarrow()` on every pattern first.

| Declared | Ever granted | Why |
| --- | --- | --- |
| `*://*/*` | **Never.** Only specific hosts derived from a rule (`*://*.api.example.com/*`, `https://app.example.com/*`, `*://localhost/*`) are ever requested. | Chrome requires a requested pattern to be *contained in* a declared one, and the hosts a user's rules name are not knowable at build time. |

### Why the envelope is broad and the grant is not

Declaring `*://*/*` under `optional_host_permissions` **grants nothing** and
shows no install warning; it is only the outer bound of what may later be asked
for. The permission the user actually holds is the union of the specific hosts
they clicked "Grant" on, visible on the options page and revocable there.

Two mechanical guards keep the distinction real:

1. `assertOriginIsNarrow()` runs on every origin before any request and rejects
   `<all_urls>`, `*://*/*`, `https://*/*`, wildcards over a bare TLD, and
   wildcards over the public suffixes it knows about. Every rule's origins pass
   through it (see `lib/dnr.ts`, which reports a `site-too-broad` problem rather
   than requesting one).
2. `verify-bundle.mjs` fails the build if `optional_host_permissions` contains
   anything other than `*://*/*`, or if `<all_urls>` appears anywhere.

The scheme wildcard is required, not cosmetic: Chrome rejects a request for
`*://api.example.com/*` against an `http://*/*` + `https://*/*` declaration with
*"Only permissions specified in the manifest may be requested"* — verified
against Chrome 150.

### The public-suffix check, honestly

"Never a wildcard over a public suffix" is stronger than what the code can
promise, so here is what it actually does.

`assertOriginIsNarrow()` rejects, always:

- a host that is a bare wildcard (`*`), or a wildcard anywhere but a single
  leading `*.`;
- `*.` over a **single label** — `*://*.com/*`, `*://*.io/*` — which is every
  bare TLD, structurally, with no list involved;
- `*.` over a two-label host whose first label is a registry label under a
  two-letter ccTLD (`*.co.uk`, `*.com.au`, `*.ne.jp`), from a fixed list of 14
  such labels;
- `*.` over one of **19 named** multi-party suffixes: `github.io`, `pages.dev`,
  `vercel.app`, `herokuapp.com` and the rest of `PUBLIC_SUFFIXES` in
  `lib/permissions.ts`.

All four hold **whatever case the host is written in**. Chrome matches the host
component case-insensitively — with only `*://*.co.uk/*` granted,
`permissions.contains({origins: ['*://*.CO.UK/*']})` answers true, verified in
Chrome 151 — and the two lists above are lowercase, so the host is normalised
before either is consulted. Without that, `*://*.CO.UK/*` would be accepted while
`*://*.co.uk/*` was refused, for the identical permission. The scheme is *not*
normalised, deliberately: `HTTPS://…` is not a pattern Chrome accepts at all, and
it is refused as malformed.

It does **not** reject a wildcard over a public suffix outside that list.
`*://*.eu.org/*` and `*://*.s3.amazonaws.com/*` are accepted today. The list is a
hand-maintained best-effort subset, not the Public Suffix List, and it is
deliberately not the real thing: the PSL is a ~10,000-line dataset that changes
continuously, and vendoring it would mean either a stale copy shipped in the
bundle or a network fetch — and this extension makes no network requests. The
failure mode of the subset is a *false rejection* of an unusual-looking host,
which is safe and visible; it is never a false acceptance of a bare TLD.

The practical exposure is bounded by where a site pattern can come from. There
are two ways in, and both go through this check: the user types it, from a user
gesture; or it arrives inside an imported rules file, and `importRules()` in
`lib/rules-engine.ts` runs the same function over every `rule.sites` entry and
refuses the whole import rather than letting the pattern reach the Grant button.
Either way the resulting grant is listed and revocable on the options page.

Add entries to `PUBLIC_SUFFIXES` as real cases appear — `lib/permissions.test.ts`
is where each new one is pinned, in both cases.

### The initiator requirement

For anything that is not a top-level navigation, Chrome requires host access to
**both** the request URL **and** the page that initiated the request. This is the
single most common reason a header rule appears to work on page loads and does
nothing on `fetch`/XHR. The UI says so in three places (`components/SiteAccess.tsx`,
the popup's "Allow on this site" prompt, and each rule's status), because a
silent failure here is exactly what this product exists to avoid.

## Optional API permissions

Declared in the `OPTIONAL_PERMISSIONS` registry in `lib/permissions.ts`.

**Currently empty.** No feature needs an optional API permission.

| ID | Permission / origin | Feature that needs it | Why the user benefits | What happens if declined | Added |
| --- | --- | --- | --- | --- | --- |
| _(none)_ | | | | | |

## Adding a permission — checklist

1. Confirm it traces to the [single-purpose statement](single-purpose.md).
2. Confirm `activeTab` cannot do the job (for anything host-related).
3. Decide required vs optional. **Default to optional.** Required means every
   user pays for a feature some of them will never use.
4. Add the row to the correct table above, including the exact permission warning
   Chrome will display.
5. If optional: add it to `OPTIONAL_PERMISSIONS` in `lib/permissions.ts` with a
   `justification` (shown to the user *before* the Chrome prompt) and a
   `declineBehaviour` (what degrades — never "it breaks").
6. Add it to `wxt.config.ts` and to `ALLOWED_PERMISSIONS` in
   `scripts/verify-bundle.mjs`.
7. Surface the justification in the UI at the point of request, then call
   `requestPermission()` / `requestOrigins()` synchronously from the click handler.
8. Verify the feature still works when the user declines.
9. Update [PRIVACY.md](../PRIVACY.md) if the permission changes what data is
   accessible, and increment `PRIVACY_DISCLOSURE_VERSION` in `lib/storage.ts` so
   existing users get proactive notice.
