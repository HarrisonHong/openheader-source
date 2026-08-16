# Single Purpose

The Chrome Web Store requires every extension to have **one** narrow, easily
understood purpose, and requires that everything the extension does — every
permission, every byte of data, every feature — serve that purpose.

## The statement

> **Edits the HTTP request and response headers of the websites you choose.**

That is the whole product. Everything else in the UI exists to make that one
thing reliable: profiles group rules, backups keep them from being lost, import
brings them across from another tool, and the status on every rule says whether
that rule is currently doing its job.

This statement is the canonical wording. It is copied (verbatim or trivially
reworded) into:

| Location | File |
| --- | --- |
| Manifest description | `wxt.config.ts` → `manifest.description` |
| Onboarding copy | `entrypoints/welcome/App.tsx` |
| Store listing | Chrome Web Store dashboard |
| README | `README.md` |

### On the name

**Decided: the product name is `OpenHeader`.** It replaced the `Plain Headers`
working title with the project owner's sign-off, and it is what ships.

**The store listing title is `OpenHeader — Modify HTTP Request & Response
Headers`** (51 chars, inside Chrome's 75-character `name` limit), decided
2026-08-04. It supersedes the earlier sign-off `OpenHeader — HTTP Header
Editor`, which was found to be a live Chrome Web Store listing published
2026-07-31 by an unrelated developer — publishing a byte-identical title would
have put two identical items in one search page and invited the "misleading
metadata" clause of the Listing Requirements policy. The brand token
`OpenHeader` is kept because it is load-bearing across this repo, the package
name and the licence; the differentiation is in the tail.

Two forms, and where each belongs:

- **The long form** appears in exactly one place: `manifest.name` in
  `wxt.config.ts`. The Web Store dashboard has no title field — the listing
  title *is* `manifest.name` — so that is what the long form is for.
- **`OpenHeader`** is the in-product name everywhere else, because a
  51-character string does not fit a 360px popup header or a `short_name`:
  `short_name` and `action.default_title` in `wxt.config.ts`, the three
  entrypoint `index.html` titles, the headings in
  `entrypoints/{popup,options,welcome}/App.tsx`, and `README.md`.

`scripts/verify-browser.mjs` asserts on the name indirectly through the header
value it injects, so it changes with them.

The rest of the listing — description, screenshots, promotional copy — is still
outward-facing and still needs sign-off before publication.

## The rule

**The architecture must never contradict the single-purpose statement.**

This is a constraint on what gets built, not a box to tick before submission.
Concretely, at review time:

1. **Every permission must trace to the statement.** If you cannot write one
   sentence explaining how a permission serves the stated purpose, the permission
   does not ship. That sentence goes in [permissions.md](permissions.md).
2. **Every piece of stored data must trace to the statement.** Under the Limited
   Use policy, data must be *strictly necessary* to the disclosed purpose.
   Collecting something because it "might be useful later" is a policy violation,
   not foresight.
3. **Every network request must trace to the statement.** There are currently
   zero. See [PRIVACY.md](../PRIVACY.md).
4. **A feature that requires broadening the statement is a different product.**
   If a proposed feature only fits by adding "and also" to the sentence, the
   correct outcome is a second extension, not a wider sentence.

### Things deliberately left out

Each of these would widen the sentence, so each is out:

| Not built | Why |
| --- | --- |
| Redirecting or blocking requests | "and also redirects requests" is a second purpose. A ModHeader import reports its `urlReplacements` as not imported rather than quietly growing the product. |
| Rewriting response **bodies** | It is the one feature that forces the `debugger` permission, which is the thing this product's users left. Designed as a seam (`OPTIONAL_PERMISSIONS` in `lib/permissions.ts`), shipped as nothing. |
| Cookie management | Adjacent, genuinely useful, and a different single purpose — so it is a separate store listing sharing this codebase, not a feature here. |
| Accounts, cloud sync, teams | They require the account-and-server architecture these users are actively fleeing. |

## Review checklist

Before any release:

- [x] The statement above is filled in and is a single sentence.
- [x] The manifest description matches it.
- [x] The onboarding page describes the same purpose in user-facing words.
- [x] Every row in [permissions.md](permissions.md) traces to it.
- [x] Nothing stored locally falls outside it.
- [x] [PRIVACY.md](../PRIVACY.md) still accurately describes data practices.
- [x] Store name signed off (product name `OpenHeader`; listing title
      `OpenHeader — Modify HTTP Request & Response Headers`, decided
      2026-08-04).
- [ ] Store listing copy signed off — description, screenshots, promotional copy.
