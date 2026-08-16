# ModHeader import

`lib/modheader.ts` reads a ModHeader export file. This document records **where
the schema came from**, so nobody has to guess at it again, and **exactly what we
do with each field**.

## Provenance

ModHeader itself is closed source and was pulled from the Chrome Web Store on
2026-07-10 and Edge Add-ons on 2026-07-03, so the schema was reconstructed from
three independent sources and cross-checked:

| Source | What it gave us |
| --- | --- |
| [`requestly/modheader-export-backup`](https://github.com/requestly/modheader-export-backup) → `src/modheader-format.mjs` | A line-by-line port of ModHeader 7.0.18's own `exportProfileHook`, including the full field lists, the v1→v2 `upgradeProfile` pass and the export transform. This is the authoritative one. |
| [`requestly/interceptor`](https://github.com/requestly/interceptor) → `app/src/modules/rule-adapters/modheader-rule-adapters/parseRulesFromModheader.ts` | A shipped importer, and the only verifiable reading of the `appendMode` / `sendEmptyHeader` combination. |
| Real exports found in public repositories (`solita/ara-etp/etp-front/modheaders.json`, `Zerohazard8x/custom/modheader/headers.json`) | Confirmation that both v1 (no `version` field) and v2 exports exist in the wild. Both shapes are covered by fixtures in `lib/modheader.test.ts`. |

## The file

A ModHeader export is a **bare JSON array of profiles** — not an object with a
`profiles` key. Two shapes exist:

- **v2** (`"version": 2`) — per-header `appendMode`/`sendEmptyHeader`, filters
  split into one list per kind.
- **v1** (no `version` at all) — profile-level `appendMode`/`sendEmptyHeader` and
  a single `filters` array tagged with `type: "urls" | "excludeUrls" | "types"`.
  ModHeader upgraded these in place on load, so long-lived profiles still export
  as v1. `upgradeProfile()` reproduces that upgrade exactly.

## Field-by-field

| ModHeader field | What we do | Note produced |
| --- | --- | --- |
| `title` | Profile name, and the imported rule's name. | — |
| `headers[]` | Request header edits. | — |
| `respHeaders[]` | Response header edits. | — |
| `headers[].appendMode` | `"append"`/`"comma"`/`true` → Append; otherwise Set. | `"comma"` is noted: Chrome chooses its own separator per header. |
| `headers[].sendEmptyHeader` | With no append mode, → Remove. Follows Requestly's shipped reading. | — |
| `urlFilters[].urlRegex` | A regex match condition. Over 2,000 characters it is skipped — past what Chrome will compile, so it could never have matched in ModHeader either. | Warns, with the length, when one is skipped. |
| `excludeUrlFilters[].urlRegex` | A regex **exclusion**. Chrome has no exclusion field for these, so `lib/dnr.ts` compiles them to higher-priority `allow` rules. Same 2,000-character limit. | Warns as above — **and the rule is imported turned off**, because losing an exclusion makes a rule apply more widely than the profile it came from. The same holds for *any* exclusion this importer cannot keep: an oversize pattern, an empty one, an entry that is not an object, or the whole field holding something other than a list. |
| `excludeRequestDomainFilters[]` | A domain exclusion (native and exact). | Skipped with a reason if it names no domain. |
| `resourceFilters[].resourceType` | Request types. Absent → every type. | Unknown types are named in a note. |
| `requestMethodFilters[].requestMethod` | Request methods, lower-cased. | Unknown methods are named in a note. |
| `cspHeaders[]` / `cspDirectives[]` | Combined into one `Content-Security-Policy` response header. | Says how many directives were combined. |
| `reqCookieAppend[]` | An append to the `Cookie` request header. | Says how many cookies. |
| `cookieHeaders[]`, `setCookieHeaders[]` | Imported as `Cookie` / `Set-Cookie` edits but **turned off**. | Warns why: their exact semantics could not be verified, and a wrong cookie rewrite silently breaks a signed-in session. |
| `urlReplacements[]` | Not imported. | Warns: this extension edits headers and does not redirect. |
| `initiatorDomainFilters[]`, `tabFilters[]`, `tabGroupFilters[]`, `windowFilters[]`, `timeFilters[]` | Not imported. | Each warns, with the count. |
| `backgroundColor`, `textColor`, `shortTitle`, `hideComment`, `alwaysOn` | Ignored (presentation only). | — |

**Nothing is dropped silently.** Every field we cannot represent produces an
entry in the returned `ImportReport`, which the import panel renders in full.

## Site access

ModHeader held blanket access to every site. This extension never does, so:

- A profile **with** URL filters gets site access *suggested* from the hostnames
  in its regexes (`suggestOriginsFromRegex`). Suggestions are shown for review
  and never granted automatically.
- A profile **without** URL filters applied to everything in ModHeader. It
  imports with no conditions and a loud warning telling the user to name the
  sites — the alternative would be asking for access to the whole web, which is
  the thing this product refuses to do.
- The import screen also accepts a list of sites to apply to every imported rule.
- Every site pattern typed on the import screen or carried in the file goes
  through `assertOriginIsNarrow()` before the import is accepted. A file naming
  something broader than this extension will ever request is refused outright
  rather than landing in the rule set and waiting to be granted. See
  [permissions.md](permissions.md).
- A *suggested* pattern is filtered by the same function at source instead, in
  `suggestOriginsFromRegex()`. A regex naming a bare public suffix
  (`.*\.github\.io/.*`) would otherwise be turned into `*://*.github.io/*` and
  then refuse the whole file over a pattern the user never wrote and cannot edit
  from the import screen. Such a profile imports with no site access and a
  warning telling the user to name the sites themselves.

## Safety

`importRules()` in `lib/rules-engine.ts` takes a `before-import` snapshot **before**
writing, so any import is undoable from the Backups panel. A file that fails to
parse changes nothing at all — proven in `tests/rules-engine.test.ts`.

The scan that suggests hostnames runs in the service worker, on a file someone
else may have written, so it is bounded: only the first 2,000 characters of a
pattern are scanned, and the host-matching regex uses a bounded label quantifier.
Both exist because the unbounded version was quadratic — 100 KB of undotted
characters took eight seconds, during which the worker served no messages and
every surface hung.
