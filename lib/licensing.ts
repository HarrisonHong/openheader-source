/**
 * Payment / licensing seam.
 *
 * No payment integration in this phase and no vendor API is called: this is the
 * interface the eventual merchant-of-record integration plugs into, plus a local
 * no-op implementation so the rest of the foundation is testable today. See
 * docs/licensing.md.
 *
 * The extension has to stay usable offline. Entitlement is a pure function of a
 * locally cached record and the clock — it never blocks on the network, and a
 * network failure can never disable anything. `entitled: false` gates paid
 * features; it never gates the extension working at all.
 */

import './zod-config';
import { z } from 'zod';
import { defineStorageItem } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a cached validation is considered fresh before we would like to
 * re-check with the licensing server.
 */
export const REVALIDATE_AFTER_MS = 7 * DAY_MS;

/**
 * How long a paid license keeps working after going stale with the server still
 * unreachable. Deliberately generous: laptops go offline and servers go down,
 * and neither is the user's fault.
 */
export const OFFLINE_GRACE_MS = 30 * DAY_MS;

export type LicenseTier = 'free' | 'pro';

export type EntitlementState =
  /** No license key has been activated. Free tier. */
  | 'unlicensed'
  /** Cached validation is fresh. */
  | 'active'
  /** Cached validation is stale but within the offline grace period. */
  | 'grace'
  /** Grace period exhausted, or the subscription period ended. */
  | 'expired'
  /** The server told us this key is not valid. */
  | 'invalid';

export const licenseRecordSchema = z.object({
  /** The user-entered license key. Stored locally only; never bundled. */
  key: z.string().min(1),
  /** Result of the last completed server validation. */
  status: z.enum(['valid', 'invalid']),
  tier: z.enum(['free', 'pro']),
  /** Epoch ms of the last successful server validation. */
  lastValidatedAt: z.number().int().nonnegative(),
  /** Subscription end, epoch ms. `null` means perpetual. */
  expiresAt: z.number().int().nonnegative().nullable(),
  /** Vendor-side activation instance id, when the vendor issues one. */
  instanceId: z.string().nullable(),
});
export type LicenseRecord = z.infer<typeof licenseRecordSchema>;

export const entitlementSchema = z.object({
  state: z.enum(['unlicensed', 'active', 'grace', 'expired', 'invalid']),
  tier: z.enum(['free', 'pro']),
  /** Whether paid features are unlocked right now. */
  entitled: z.boolean(),
  /** Epoch ms when the offline grace period runs out. `null` when not in/near grace. */
  graceEndsAt: z.number().int().nonnegative().nullable(),
  /** Whole days of grace remaining, for user-facing copy. `null` when not applicable. */
  graceDaysRemaining: z.number().int().nullable(),
  /** True when a server re-check is due (the caller decides whether to try). */
  revalidationDue: z.boolean(),
});
export type Entitlement = z.infer<typeof entitlementSchema>;

export const UNLICENSED: Entitlement = {
  state: 'unlicensed',
  tier: 'free',
  entitled: false,
  graceEndsAt: null,
  graceDaysRemaining: null,
  revalidationDue: false,
};

export interface EntitlementPolicy {
  revalidateAfterMs: number;
  offlineGraceMs: number;
}

export const DEFAULT_POLICY: EntitlementPolicy = {
  revalidateAfterMs: REVALIDATE_AFTER_MS,
  offlineGraceMs: OFFLINE_GRACE_MS,
};

/**
 * Pure entitlement evaluation. No I/O, no network, no clock access — `now` is
 * injected so the offline grace path is fully testable.
 */
export function evaluateEntitlement(
  record: LicenseRecord | null,
  now: number,
  policy: EntitlementPolicy = DEFAULT_POLICY,
): Entitlement {
  if (record === null) return UNLICENSED;

  if (record.status === 'invalid') {
    return {
      state: 'invalid',
      tier: 'free',
      entitled: false,
      graceEndsAt: null,
      graceDaysRemaining: null,
      revalidationDue: false,
    };
  }

  // A known subscription end date beats any cache freshness reasoning.
  if (record.expiresAt !== null && now >= record.expiresAt) {
    return {
      state: 'expired',
      tier: 'free',
      entitled: false,
      graceEndsAt: null,
      graceDaysRemaining: null,
      revalidationDue: false,
    };
  }

  const staleAt = record.lastValidatedAt + policy.revalidateAfterMs;
  const graceEndsAt = staleAt + policy.offlineGraceMs;

  if (now < staleAt) {
    return {
      state: 'active',
      tier: record.tier,
      entitled: true,
      graceEndsAt: null,
      graceDaysRemaining: null,
      revalidationDue: false,
    };
  }

  if (now < graceEndsAt) {
    return {
      state: 'grace',
      tier: record.tier,
      entitled: true,
      graceEndsAt,
      graceDaysRemaining: Math.ceil((graceEndsAt - now) / DAY_MS),
      revalidationDue: true,
    };
  }

  return {
    state: 'expired',
    tier: 'free',
    entitled: false,
    graceEndsAt,
    graceDaysRemaining: 0,
    revalidationDue: true,
  };
}

export type ActivationFailureReason =
  | 'provider-not-configured'
  | 'invalid-key'
  | 'activation-limit-reached'
  | 'network-unavailable';

export type ActivationResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: ActivationFailureReason; message: string };

/**
 * The seam. A merchant-of-record implementation (Lemon Squeezy is the target —
 * see docs/licensing.md) implements this and nothing else changes.
 */
export interface LicenseProvider {
  /** Stable id, surfaced in diagnostics. */
  readonly id: string;
  /** Whether this provider can talk to a licensing server at all. */
  readonly supportsActivation: boolean;
  /** Evaluate entitlement from the local cache. Must not hit the network. */
  getEntitlement(now?: number): Promise<Entitlement>;
  /** Activate a license key. May hit the network. */
  activate(key: string, now?: number): Promise<ActivationResult>;
  /** Release this device's activation and clear the local cache. */
  deactivate(): Promise<void>;
  /**
   * Attempt a server re-validation. Resolves rather than rejecting when offline,
   * returning the cached entitlement unchanged, so being offline cannot break
   * anything.
   */
  refresh(now?: number): Promise<Entitlement>;
}

/** Locally cached license record. Never leaves the device. */
export const licenseRecord = defineStorageItem<LicenseRecord | null>({
  key: 'foundation:license',
  version: 1,
  schema: licenseRecordSchema.nullable(),
  defaultValue: () => null,
});

/**
 * The default for this phase. It runs the full read/evaluate/cache path, so the
 * offline grace logic is exercised end to end, but refuses activation — there is
 * no merchant account and no vendor API wired up yet.
 */
export class LocalNoopLicenseProvider implements LicenseProvider {
  readonly id = 'local-noop';
  readonly supportsActivation = false;

  async getEntitlement(now: number = Date.now()): Promise<Entitlement> {
    const result = await licenseRecord.get();
    if (!result.ok) {
      // A corrupt license cache must never brick the extension. The free tier is
      // fully functional, so degrade to it rather than throwing into the UI.
      return UNLICENSED;
    }
    return evaluateEntitlement(result.value, now);
  }

  async activate(_key: string): Promise<ActivationResult> {
    return {
      ok: false,
      reason: 'provider-not-configured',
      message:
        'Licensing is not configured in this build. See docs/licensing.md for the integration plan.',
    };
  }

  async deactivate(): Promise<void> {
    await licenseRecord.set(null);
  }

  async refresh(now: number = Date.now()): Promise<Entitlement> {
    return this.getEntitlement(now);
  }
}

let activeProvider: LicenseProvider = new LocalNoopLicenseProvider();

export function getLicenseProvider(): LicenseProvider {
  return activeProvider;
}

/** Swap the implementation. Used by tests today; used by phase 2 wiring later. */
export function setLicenseProvider(provider: LicenseProvider): void {
  activeProvider = provider;
}
