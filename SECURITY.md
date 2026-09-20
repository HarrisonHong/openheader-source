# Security Policy

Headerman's source is published so it can be audited. If you audit it and find
something, this is where to send it.

## Supported version

This source tree builds version 1.1.0, and that is the version security fixes
are written against. There is no support matrix beyond that: the fix goes into
the next release, and the next release is what users get.

## Reporting a vulnerability

**Preferred: GitHub private vulnerability reporting.** Open the **Security** tab
of this repository and use **Report a vulnerability**. The report is private —
only the maintainer sees it — and it keeps the whole exchange, including the fix,
in one place.

**Fallback: `openheadersupport@gmail.com`.** Use this if you do not have a GitHub
account or would rather not use one. It reaches the same person.

**Please do not open a public issue for a vulnerability.** A public issue
publishes the flaw to everyone, including people who would use it, before a fix
exists.

## What to expect

This is a solo-maintained project, so the honest commitment is a small one: an
acknowledgement within **7 days**, and a plain answer about whether the report is
being treated as a security issue and what happens next. There is no bug bounty
and no payment.

If you do not hear back within 7 days, try the other channel above — the most
likely explanation is that the first message did not arrive.

Credit in the release notes is offered for any report that leads to a fix; say so
if you would rather not be named.

## Scope

The extension has no server, no backend, and makes no network requests, so there
is no hosted surface to test. In scope is the extension itself:

- The extension code in this repository, and the build that produces the shipped
  bundle.
- Anything that lets the extension read, send, or leak data it states it does not
  touch — see `PRIVACY.md`.
- Anything that widens the permission surface beyond what `docs/permissions.md`
  documents, or that reaches host access the user did not grant.
- Anything that makes a header rule apply where it should not, or silently stop
  applying without saying so.
- Dynamic code execution or remote code loading reachable in the shipped bundle.

Out of scope: the Chrome Web Store and Microsoft Edge Add-ons listing
infrastructure, the browsers themselves, and reports that amount to "an
extension with granted host access can change headers on those hosts" — that is
the product, and the grant is per-site and revocable.
