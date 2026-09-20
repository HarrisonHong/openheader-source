# Microsoft Edge

Headerman ships the same extension to the Chrome Web Store and to Microsoft
Edge Add-ons. This file records what was **verified** about Edge, how, and what
a submitter needs. Where something could not be verified it says so; "Edge is
Chromium, so it is probably the same" is not evidence and is not used here.

## The build

```sh
npm run build:edge          # -> .output/edge-mv3/
npm run zip:edge            # -> .output/headerman-<version>-edge.zip
npm run verify:bundle:edge  # the shipped-output check, against the Edge build
npm run verify:parity       # proves the two builds are one artifact
npm run verify:browser:edge # behavioural check; needs an Edge binary in CHROME
```

`npm run check` builds and verifies **both** targets. There is no separate Edge
source tree and no Edge-specific code: `wxt build -b edge` and `wxt build`
produce a **byte-identical `manifest.json` and byte-identical JS**. That is
checked, not assumed: `npm run verify:parity` compares every emitted file byte
for byte — the manifest, the JS, the HTML, the CSS and the icons — and both
`npm run check` and CI run it, so the claim fails the build the day it stops
being true. The consequence worth knowing is
that a change which breaks Edge breaks Chrome too, so there is no drift to
manage; what Edge needs is its own *verification*, not its own *code*.

`verify:browser:edge` takes the browser binary from `CHROME`, so it runs against
Edge with:

```sh
CHROME=/opt/microsoft/msedge/msedge npm run verify:browser:edge
```

There is no default: with `CHROME` unset the script exits 2 rather than
installing the Edge build in Chrome and reporting a green run that proves
nothing about Edge.

## The permission surface on Edge

The product's whole pitch is `declarativeNetRequestWithHostAccess` with **zero**
host permissions granted at install and **no** `debugger` permission. That has
to hold on Edge or the Edge listing is not the same product.

| Claim | Status on Edge | Source |
| --- | --- | --- |
| `declarativeNetRequestWithHostAccess` is a supported permission | **Confirmed** | Microsoft lists the permission string verbatim in [Declare API permissions in the manifest][declare], with the same semantics: "Always requires host permissions on the request URL and on the initiator, to act on the request." |
| `chrome.declarativeNetRequest` is a supported API | **Confirmed** | Listed as supported for MV3 on Windows, Linux, Mac, Android in [Supported APIs][apis] |
| `storage`, `activeTab` supported | **Confirmed** | [Declare API permissions in the manifest][declare] |
| `modifyHeaders` on **request** headers | **Confirmed by test**, not by Microsoft prose | `verify:browser:edge` against Edge 151.0.4129.93 — a real `fetch` POST and a real XHR both carried the injected request header |
| `modifyHeaders` on **response** headers | **Confirmed by test**, not by Microsoft prose | same run — both the POST and the XHR saw the injected response header |
| Zero host permissions at install | **Confirmed by test** | `permissions.getAll()` in Edge returned `origins: []` |
| `optional_host_permissions` envelope works | **Confirmed by test** | see "The one documentation gap" below |
| The options page's "Change browser shortcuts" button reaches the shortcuts page | **Confirmed by test** | Driven over the DevTools Protocol in Edge 151.0.4129.93 and Chrome 151.0.7922.137: a request for `chrome://extensions/shortcuts` settles at `edge://extensions/shortcuts`, titled "Extensions", in Edge, and at `chrome://extensions/shortcuts`, titled "Extensions", in Chrome. Edge rewrites the Chrome-style address to its own; the reverse does not hold — `edge://extensions/shortcuts` in Chrome settles at a blank, untitled page — so the `chrome://` form the options page uses is the portable one, and branching on the running browser would only break Chrome |

### Microsoft does not separately document `modifyHeaders`

This is the honest limit of the documentary evidence. Microsoft's supported-API
table links `declarativeNetRequest` **directly to Google's reference** and states
that its pages are modifications of Google's work. So Microsoft documents the
API's *availability* itself, and adopts Chrome's documentation by reference for
the API's *behaviour* — it publishes no independent description of
`modifyHeaders`, of `RuleActionType`, or of the request/response header
distinction.

That means no amount of reading Microsoft's site can confirm header modification
behaves identically. Only running it can, which is why the two `modifyHeaders`
rows above cite a test rather than a document.

**No divergence from Chrome was found.** Every check in
`scripts/verify-browser.mjs` — including both header directions, the
engine-refusal path, the exclusion-to-`allow`-rule compilation, and the
read-back comparison — passes identically in Edge 151 and in Chrome. The script
prints `ALL CHECKS PASSED` only when none failed; no count is quoted here
because a number in prose drifts the moment a check is added.

### The one documentation gap

Microsoft's [manifest file format][manifest] page lists `host_permissions` and
`optional_permissions` but **omits `optional_host_permissions`** — the key this
extension depends on to request user-named origins at runtime. If Edge genuinely
did not support it, the zero-install-permission design would be broken on Edge.

That omission is a documentation artifact, not a behaviour difference. The page
is visibly a stale copy of Chrome's key list: it also lists MV2-only keys
(`content_capabilities`, `nacl_modules`, `event_rules`) and shows
`content_security_policy` in its MV2 string form.

Tested directly against Edge 151, from the extension's own options page:

| Request | Result in Edge |
| --- | --- |
| `origins: ['*://api.example.com/*']` — narrow, under our envelope | **Accepted**; Edge showed its native grant prompt |
| `permissions: ['debugger']` — not declared | Refused: "Only permissions specified in the manifest may be requested." |
| `origins: ['ftp://example.com/*']` — scheme outside our envelope | Refused, same message |

The two refusals are the control: they prove the probe can detect a rejection,
so the acceptance of the narrow origin is a real result. `optional_host_permissions`
is honoured by Edge exactly as by Chrome. Nothing in the manifest needs to
change for Edge.

## Submission requirements

Recorded for whoever submits the package. **Nothing here has been submitted, and
no Partner Center account has been created.** Registering that account is the
project owner's step, under their own account, and nothing in this repository
does it.

### What the package must satisfy

| Requirement | Source | Where we stand |
| --- | --- | --- |
| Package is a `.zip` containing the manifest plus every file the extension needs | [Publish an extension][publish] | `npm run zip:edge` — 97 KB, 16 files, no source maps |
| No `update_url` key in the manifest | [Port a Chrome extension][port] | We declare none |
| The word "Chrome" must not appear in the manifest `name` or `description` | [Port a Chrome extension][port] — *"To pass the certification process, the changes are required"* | Neither contains it, and the user-facing copy no longer names a browser either — see below |
| MV3 may not load or execute remotely hosted code | [Publish an extension][publish] | `connect-src 'none'` plus the no-network-sinks scan in `scripts/verify-bundle.mjs` |
| Manifest `name` → store "Extension name" (read-only in Partner Center) | [Publish an extension][publish] | Unchanged from Chrome |
| Manifest `description` → store "Short description" (read-only in Partner Center) | [Publish an extension][publish] | Unchanged from Chrome |

Microsoft's publishing documentation states **no package size limit**, so none is
recorded here. At 97 KB the question is not close either way.

### What the submitter must supply in Partner Center

These are listing fields and assets, uploaded separately from the package.

| Field | Required? | Constraint |
| --- | --- | --- |
| Description | Yes, per language | **Minimum 250 characters**, maximum 10,000. Longer than the manifest `description`, so it must be written for Edge |
| Extension logo | Yes, per language | 1:1, **recommended 300×300**, minimum 128×128. `public/icon/128.png` meets the minimum; nothing in the repo is 300×300 |
| Category | Yes | — |
| Single Purpose Description | Yes | `docs/single-purpose.md` is the source |
| Permission justification, per declared permission | Yes | `docs/permissions.md` has a row per permission written for exactly this purpose |
| "Are you using remote code?" | Yes | **No** |
| Data usage disclosure + certification | Yes | Zero collection — `PRIVACY.md` |
| Privacy Policy URL | Yes, if any data is handled | `PRIVACY.md` needs a resolvable public URL |
| Small promotional tile | Optional | 440×280 |
| Large promotional tile | Optional | 1400×560 |
| Screenshots | Optional | Max 6, either 640×480 or 1280×800 |
| Search terms | Optional | Max 7 terms / 21 words, 30 chars each |

Certification takes **up to seven business days**.

### Browser wording in the user interface

Roughly 25 user-facing strings used to name Chrome directly, so an Edge user was
told *"Active — Chrome is applying this rule"* inside Edge. This was never a
certification blocker — Microsoft's rebranding rule covers only the manifest
`name` and `description`, and both are clean — but it was wrong on half the
installs once Edge became a shipped target.

**Decided 2026-08-19: the copy names no browser at all.** Those strings now say
"the browser", or drop the actor where the sentence reads better without one, as
in "Active. The browser is applying this rule."

The alternative was detecting the running browser and substituting its name.
That was rejected deliberately: it would make every message depend on runtime
state for no functional gain, and one wording that is correct everywhere beats
two wordings that each have to be kept right. It also keeps this code free of a
browser check that nothing else in the product needs.

Two categories were left alone, because naming a browser there is a statement of
fact rather than a description of what is happening now:

- `ImportPanel`'s "removed from the Chrome and Edge stores in July 2026" —
  history, and accurate.
- `ChromeDnr` in `lib/rules-engine.ts` — an internal type name for the Chromium
  `declarativeNetRequest` shape, never rendered.

## Evidence

Reproduce with:

```sh
npm run build && npm run build:edge
npm run verify:parity   # every emitted file, byte for byte
```

Verified against **Microsoft Edge 151.0.4129.93 stable** (Linux x64), the
current stable at the time of writing, driven through the DevTools Protocol
`Extensions.loadUnpacked` — Chrome 137+ ignores `--load-extension` and Edge 151
inherits that, so the same route `scripts/verify-browser.mjs` already documents
is the only one that works.

[apis]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support
[declare]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/declare-permissions
[manifest]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format
[publish]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
[port]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension
