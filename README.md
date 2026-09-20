# Headerman — a privacy-first HTTP header editor

Edit the HTTP request and response headers of the websites you choose. Built as a
Manifest V3 extension with [WXT](https://wxt.dev/) + TypeScript + Preact, and
shipped to both Chrome and Microsoft Edge from one codebase.

> **No account. No telemetry. No `debugger` permission. Rules that never silently
> stop working.**

The store listing title is the keyword-bearing form —
**Headerman — HTTP Header Editor** — because the store's listing title *is*
`manifest.name`. In the product it is just **Headerman**.
See [docs/single-purpose.md](docs/single-purpose.md#on-the-name).

## What it does

- **Request and response header rules** that genuinely apply to `fetch`, XHR and
  POST — not just to page loads. Every request type is on by default.
- **Real profiles**, switched in one click, with more than one active at a time.
- **A visible status on every rule** — active, inactive, waiting for site access,
  won't apply, or refused by the browser, *and why*. A rule that cannot work
  never looks like one that can, and no rule claims to be applying while the
  browser is applying nothing.
- **Regex matching everywhere, including exclusions**, which `declarativeNetRequest`
  has no condition field for (see [the exclusion design](docs/architecture.md#exclusions-and-why-they-need-a-priority-band)).
- **One-click ModHeader import**, built against
  [the real export format](docs/modheader-import.md), reporting everything it
  could not bring across rather than dropping it silently.
- **Export to a file** for backup or sharing. No server, no login.
- **Automatic backups** before every import, restore and extension update, with a
  one-click way back.

### What it does not do

No accounts, no cloud sync, no telemetry of any kind, no response-**body**
rewriting (that is what forces the `debugger` permission), no redirects. See
[docs/single-purpose.md](docs/single-purpose.md).

## Permissions

At install the extension holds access to **no website** and shows **no permission
warning**. Site access is granted one site at a time, by you, when a rule needs
it, and can be revoked at any time. `debugger` is never requested — the build
fails if it appears in the manifest. See [docs/permissions.md](docs/permissions.md).

## Requirements

- Node.js >= 20.19
- Chrome and Microsoft Edge. Both are built and verified from this tree and the
  two builds are byte-identical; see [docs/edge.md](docs/edge.md). Nothing blocks
  Firefox/Safari later, but neither is built or verified today

## Build

```bash
npm install
npm run build       # Chrome  -> .output/chrome-mv3/
npm run build:edge  # Edge    -> .output/edge-mv3/
```

To produce the submittable packages:

```bash
npm run zip         # -> .output/headerman-<version>-chrome.zip
npm run zip:edge    # -> .output/headerman-<version>-edge.zip
```

The two builds differ in nothing but the output directory — same manifest, same
JS, byte for byte. [docs/edge.md](docs/edge.md) records how that is checked and
what Edge Add-ons submission needs.

## Load unpacked

1. `npm run build` (or `npm run build:edge`)
2. Open `chrome://extensions` — in Edge, `edge://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked**
5. Select `.output/chrome-mv3/` (or `.output/edge-mv3/`)

The welcome page opens automatically on first install. Click the toolbar icon
(or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>) for the popup; the rule
workbench is behind the popup's **Manage rules** button.

To inspect the service worker, click **service worker** on the extension's card
in `chrome://extensions` (`edge://extensions` in Edge).

### Try it in 60 seconds

1. Open **Manage rules** → **Add rule**.
2. Set the condition to Domain → `localhost` (or whatever you are testing).
3. Add a request header, e.g. `X-Debug` → `1`.
4. The rule says **Needs site access**. Click **Grant access**.
5. It says **Active**. Load the site and look at the request headers.

If step 5 works on the page but not on a `fetch`, the browser also needs access
to the page *making* the request — add that site too. The rule says so, and the
popup offers a one-click grant for the tab you are on.

## Develop

```bash
npm run dev     # WXT dev server with auto-reload
```

## Test

```bash
npm test           # vitest, single run
npm run test:watch
```

Coverage includes rule CRUD and profiles, the rule compiler (regex, exclusions,
and every problem it reports), host-permission derivation, ModHeader import
against real-world v1 and v2 fixtures, storage migration and backup/restore, the
engine's read-back verification, storage schema validation, message contracts,
the licensing seam's offline grace path, WCAG AA contrast in both themes, and
proof that the security lint rules, the CI guard, the built-bundle verifier and
the Chrome/Edge parity check actually fire on violations.

## Check everything

```bash
npm run check     # lint + typecheck + test + build + bundle verification,
                  # for BOTH the Chrome and the Edge build, plus the
                  # byte-identity check between them
```

Individually:

```bash
npm run lint            # eslint, including the security rules
npm run compile         # tsc --noEmit, strict
npm run verify:bundle   # assert the BUILT output's CSP, permissions, and no dynamic code
npm run verify:parity   # assert the Chrome and Edge builds are byte-identical
npm run verify:browser  # install the built extension in a real browser and prove
                        # headers are applied to a real fetch POST and XHR
npm run audit           # npm audit --audit-level=moderate
```

Each has an `:edge` counterpart — `verify:bundle:edge`, `verify:browser:edge` —
reading `.output/edge-mv3/` instead. Both read a build directory, so they need a
build first. `verify:browser` also needs a browser binary, which is why it is not
part of `npm run check`; CI runs `verify:bundle` for both targets, so a failure
there reproduces locally byte for byte.

`verify:browser` takes its binary from `CHROME`, so it runs against Edge with:

```bash
CHROME=/opt/microsoft/msedge/msedge npm run verify:browser:edge
```

`verify:browser:edge` has no default binary: without `CHROME` it exits rather
than installing the Edge build in Chrome and passing, which would prove nothing
about Edge.

## Layout

```
entrypoints/    background service worker, popup, options, welcome
lib/            rules, compiler, engine, storage, messaging, permissions
components/     product UI shared by the popup and the options page
ui/             design-system primitives + tokens
docs/           architecture, security, permissions, Edge, ModHeader import, licensing
scripts/        bundle verification, Chrome/Edge parity, real-browser verification
```

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The product invariants, the exclusion priority bands, backups, stateless worker, typed messaging |
| [docs/permissions.md](docs/permissions.md) | Per-permission justification, why not `debugger`, how site access works |
| [docs/edge.md](docs/edge.md) | The Edge build, what was verified about Edge and how, and Edge Add-ons submission requirements |
| [docs/single-purpose.md](docs/single-purpose.md) | The single-purpose statement and what it rules out |
| [docs/modheader-import.md](docs/modheader-import.md) | Where the ModHeader schema came from and what happens to every field |
| [docs/security.md](docs/security.md) | CSP, no-eval/no-innerHTML enforcement, supply chain, release self-check |
| [docs/licensing.md](docs/licensing.md) | Payment seam, merchant-of-record target, offline grace policy |
| [docs/design-system.md](docs/design-system.md) | Tokens, dark mode, accessibility, popup sizing |
| [PRIVACY.md](PRIVACY.md) | Privacy policy — no data collected, nothing transmitted |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability privately, what to expect, what is in scope |
| [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) | The MIT notices for the two dependencies that ship inside the bundle |

## Privacy

This extension collects nothing and transmits nothing. Your rules — which often
contain tokens and cookies — are stored locally via `chrome.storage.local`;
browser sync storage is deliberately unused because it would copy them to a
remote server. See [PRIVACY.md](PRIVACY.md).

## License

The source is published so that anyone can read it, audit it, and build and run
their own copy locally — because code you cannot read is a promise you cannot
check. It is **source-available, not open source**: all rights are reserved, and
redistributing it or shipping it as your own product is not granted. The exact
terms are in [LICENSE](LICENSE).
