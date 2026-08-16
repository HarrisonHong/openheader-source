# Licensing & Payments

**Status: seam only. No payment integration exists. No vendor API is called.**

`lib/licensing.ts` defines the interface a real implementation drops into. This
document is the design it must satisfy.

## Why a seam now

Payment integration is the kind of thing that, retrofitted, leaks into every
component: entitlement checks scattered through the UI, network calls on the
critical path, and an extension that stops working when the licensing server has
a bad day. Defining the boundary before there is anything to sell keeps all of
that in one file.

## The interface

```ts
interface LicenseProvider {
  readonly id: string;
  readonly supportsActivation: boolean;
  getEntitlement(now?: number): Promise<Entitlement>;  // MUST NOT hit the network
  activate(key: string, now?: number): Promise<ActivationResult>;
  deactivate(): Promise<void>;
  refresh(now?: number): Promise<Entitlement>;         // MUST resolve when offline
}
```

Swap implementations with `setLicenseProvider()`. The default is
`LocalNoopLicenseProvider`, which implements the full read/evaluate/cache path
but refuses activation with `provider-not-configured`.

## Target: merchant of record

**Lemon Squeezy**, using license keys.

A merchant of record sells to the customer on their own infrastructure and takes
on the tax liability — VAT, GST, US sales tax — for every jurisdiction. For a
solo-maintained extension that is the difference between shipping and not
shipping. Paddle is the obvious alternative and fits the same seam; nothing below
is Lemon Squeezy-specific except the endpoint names.

Purchase happens **entirely outside the extension**, on the vendor's hosted
checkout. The extension never sees a card number, never embeds a payment SDK, and
never handles PII. It only ever knows a license key the user chose to paste in.

## Entitlement evaluation

`evaluateEntitlement(record, now, policy)` is a **pure function** — no I/O, no
network, no ambient clock. That is what makes the offline path testable, and it
is why entitlement can never block on a request.

```
record = null                              → unlicensed  (free tier)
record.status = 'invalid'                  → invalid     (not entitled)
now >= record.expiresAt                    → expired     (not entitled)
now <  lastValidatedAt + REVALIDATE_AFTER  → active      (entitled)
now <  staleAt + OFFLINE_GRACE             → grace       (ENTITLED)
otherwise                                  → expired     (not entitled)
```

| Constant | Value | Meaning |
| --- | --- | --- |
| `REVALIDATE_AFTER_MS` | 7 days | After this, we would *like* to re-check |
| `OFFLINE_GRACE_MS` | 30 days | After the cache goes stale, keep working anyway |

**Total: 37 days of uninterrupted offline use before a paid license degrades.**

## The offline rule

> **The extension MUST stay usable offline. No exceptions.**

This is a hard architectural constraint, and it decomposes into four rules that a
future integration must not break:

1. **Nothing in the free tier ever depends on the network.** `entitled: false`
   gates paid features only. It never gates the extension working at all. Today
   there are no paid features, so it gates nothing.
2. **`getEntitlement()` never makes a network request.** It reads the local cache
   and evaluates. It is safe to call on every render.
3. **`refresh()` resolves when offline — it never rejects.** A failed
   revalidation returns the cached entitlement unchanged. Being offline can never
   downgrade a user. Tested in `lib/licensing.test.ts`.
4. **A corrupt license cache degrades to the free tier, it does not throw.**
   Bricking a working extension because a stored record went bad is the worst
   possible failure mode. Tested.

Revalidation is opportunistic: when `entitlement.revalidationDue` is true and the
network happens to be available, try. If it fails, say nothing and try later.

## What an integration must add

1. **Activation** — `POST /v1/licenses/activate` with the key and a generated
   instance name. On success, write a `LicenseRecord` via `licenseRecord.set()`.
2. **Validation** — `POST /v1/licenses/validate` with key + instance id, called
   opportunistically when `revalidationDue` is true. Update `lastValidatedAt`
   **only on success**.
3. **Deactivation** — `POST /v1/licenses/deactivate`, so a user can move their
   license to a new machine. Always clear the local record even if the call
   fails.
4. **A settings UI** — key entry, current state, grace-period countdown when in
   grace, and a deactivate button.
5. **A host permission** for the vendor's API origin. It must be an
   `optional_permission`, requested only when the user chooses to activate a
   license, so users who never buy anything are never asked. Add the row to
   [permissions.md](permissions.md).
6. **A privacy policy update.** This would be the extension's first network
   request. Update [PRIVACY.md](../PRIVACY.md), state exactly what is sent (a
   license key and an opaque instance id — never browsing data), increment
   `PRIVACY_DISCLOSURE_VERSION` in `lib/storage.ts`, and let the existing
   proactive-notice path show users the change.

## Security notes

- **No secrets in the bundle.** Everything shipped is public — `.crx` files are
  trivially unpacked. Lemon Squeezy's license endpoints are designed for exactly
  this: they take the license key as the credential and need no API secret. If an
  integration ever appears to require a secret in the client, the design is
  wrong.
- **Client-side license checks are advisory.** Anyone determined can patch the
  bundle. The check exists to keep honest users honest, not to be unbreakable.
  Do not distort the architecture — especially not by adding server round-trips
  on the critical path — chasing enforcement that is not achievable in a client.
- **Never send usage data with a validation call.** The request carries a license
  key and an instance id. Nothing else.
