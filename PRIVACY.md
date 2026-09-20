# Privacy Policy

**Last updated: 2026-08-15**
**Disclosure version: 2** (matches `PRIVACY_DISCLOSURE_VERSION` in [`lib/storage.ts`](https://github.com/HarrisonHong/openheader-source/blob/main/lib/storage.ts))

## Summary

**This extension collects no data. Nothing you do with it leaves your device.**

## What we collect

Nothing.

There is no analytics, no telemetry, no crash reporting, no advertising, no
tracking, no user account, and no unique identifier of any kind.

## What we transmit

Nothing.

The extension makes no network requests. It has no server. There is no endpoint
for your data to be sent to, and no third party receives anything.

## What we store, and where

Your header rules, profiles and settings are stored **on your device only**,
using the browser's `chrome.storage.local` API. That data never leaves the
machine it was written on.

Header rules routinely contain credentials — bearer tokens, session cookies, API
keys. Treat an exported rule file the way you would treat those credentials. The
extension itself never sends one anywhere; an export is a file you save, and
sharing it is something only you can do.

We deliberately do **not** use `chrome.storage.sync`, even though it would be
convenient, because browser sync storage copies data to the browser vendor's
servers. Keeping storage local means "nothing leaves the device" is a property of
the architecture, not a promise.

You can erase everything the extension has stored by removing the extension.

## What we can access

**At install: no website, at all.** The extension ships with no host permissions
and no content scripts, and it produces no install-time permission warning.

It requests three permissions at install, none of which shows a warning:

- `storage` — its own private local storage area, and nothing else.
- `declarativeNetRequestWithHostAccess` — the API that changes headers. It can
  only act on sites you have separately granted access to.
- `activeTab` — the address of the tab you are looking at, only at the moment you
  click the extension, so the popup can offer to allow rules on that site.

Site access is granted **one site at a time, by you, from a button**, when a rule
needs it, and can be revoked from the settings page or from the rule itself. The
extension can change headers only on the sites in that list. It cannot read your
browsing history, your bookmarks, your downloads, or your identity, and it cannot
read the content of the pages you visit.

### It does not request `debugger`

`debugger` is Chrome's most invasive permission: it triggers a severe install
warning and a persistent "started debugging this browser" banner. The only header
feature that needs it is rewriting response **bodies**, which this extension does
not do. If that is ever added it will be an opt-in module that asks at the moment
you use it and can be revoked afterwards — never a permission asked for at
install.

The full table of permissions and their justifications is kept in
[`docs/permissions.md`](https://github.com/HarrisonHong/openheader-source/blob/main/docs/permissions.md)
in the extension's source tree. The three permissions above are the complete
list — nothing is omitted here.

## Third parties

None. The extension bundles all of its code; it loads nothing at runtime from a
CDN or any other remote source.

## Payments

The extension has no payment integration today. If paid features are added, the
plan is to use a merchant of record that handles the transaction on its own site;
license validation would be the only network request the extension ever makes,
and it would carry only a license key you chose to enter — never your browsing
data. Any such change would be disclosed here first, the disclosure version above
would be incremented, and existing users would be shown a notice inside the
extension before the change took effect. The plan is written up in
[`docs/licensing.md`](https://github.com/HarrisonHong/openheader-source/blob/main/docs/licensing.md)
in the extension's source tree; nothing in it is in effect today.

## Limited Use

The extension complies with the Chrome Web Store Limited Use policy by not
collecting data at all. There is no data to use, transfer, or sell. Data that is
never collected cannot be repurposed later, which is the point.

The same holds for the Microsoft Edge Add-ons developer policies, which the
extension is also distributed under: the Edge build is byte-identical to the
Chrome one, so every statement in this policy applies to it unchanged.

## Changes to this policy

If the disclosed data practices ever change, the disclosure version at the top of
this file is incremented. The extension detects that on update and proactively
shows you the change — you will not have to come looking for it.

### History

| Version | Date | Change |
| --- | --- | --- |
| 2 | 2026-07-31 | The extension gained header rules, so it can now hold access to sites you name and change the headers of requests to them. Still no data collection and no network requests. |
| 1 | 2026-07-31 | Initial disclosure. |

## Contact

Support and privacy questions go to the developer contact address published on
this extension's store listing — on the Chrome Web Store or on Microsoft Edge
Add-ons, whichever you installed from. It is shown on the listing page
under **Support**. Reaching it needs no account anywhere, which is why it is
named first, and it still works for everything.

**Security vulnerabilities go somewhere else.** The extension's source is now
published as an auditable, source-available snapshot at
https://github.com/HarrisonHong/openheader-source, and that repository's
[SECURITY.md](SECURITY.md) names the reporting route: GitHub private
vulnerability reporting, from the **Security** tab of that repository, or
`openheadersupport@gmail.com` if you do not use GitHub. Please do not report a
vulnerability in a public issue — that publishes it before a fix exists.

Earlier versions of this policy promised that if a public channel was ever
opened, it would be added here rather than replacing the address. That is what
this is. The support address above is unchanged.
