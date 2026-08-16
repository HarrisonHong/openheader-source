import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DEFAULT_POLICY,
  LocalNoopLicenseProvider,
  OFFLINE_GRACE_MS,
  REVALIDATE_AFTER_MS,
  UNLICENSED,
  evaluateEntitlement,
  getLicenseProvider,
  licenseRecord,
  setLicenseProvider,
} from './licensing';
import type { LicenseRecord } from './licensing';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function proLicense(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    key: 'TEST-KEY-0001',
    status: 'valid',
    tier: 'pro',
    lastValidatedAt: T0,
    expiresAt: null,
    instanceId: 'instance-1',
    ...overrides,
  };
}

describe('evaluateEntitlement', () => {
  it('treats a missing license as unlicensed free tier', () => {
    expect(evaluateEntitlement(null, T0)).toEqual(UNLICENSED);
  });

  it('is active while the cached validation is fresh', () => {
    const entitlement = evaluateEntitlement(proLicense(), T0 + DAY);
    expect(entitlement).toMatchObject({ state: 'active', entitled: true, tier: 'pro' });
    expect(entitlement.revalidationDue).toBe(false);
  });

  describe('offline grace path', () => {
    it('stays entitled once the cache goes stale', () => {
      // One day past the revalidation deadline: the extension has had no
      // network, and it must keep working.
      const entitlement = evaluateEntitlement(proLicense(), T0 + REVALIDATE_AFTER_MS + DAY);

      expect(entitlement.state).toBe('grace');
      expect(entitlement.entitled).toBe(true);
      expect(entitlement.tier).toBe('pro');
      expect(entitlement.revalidationDue).toBe(true);
    });

    it('stays entitled right up to the last millisecond of grace', () => {
      const lastMoment = T0 + REVALIDATE_AFTER_MS + OFFLINE_GRACE_MS - 1;
      expect(evaluateEntitlement(proLicense(), lastMoment)).toMatchObject({
        state: 'grace',
        entitled: true,
      });
    });

    it('reports the days of grace remaining for user-facing copy', () => {
      const entitlement = evaluateEntitlement(
        proLicense(),
        T0 + REVALIDATE_AFTER_MS + OFFLINE_GRACE_MS - 5 * DAY,
      );
      expect(entitlement.graceDaysRemaining).toBe(5);
      expect(entitlement.graceEndsAt).toBe(T0 + REVALIDATE_AFTER_MS + OFFLINE_GRACE_MS);
    });

    it('only expires after the full grace period elapses', () => {
      const justAfter = T0 + REVALIDATE_AFTER_MS + OFFLINE_GRACE_MS;
      expect(evaluateEntitlement(proLicense(), justAfter)).toMatchObject({
        state: 'expired',
        entitled: false,
        tier: 'free',
      });
    });

    it('is generous: more than a month of offline use', () => {
      expect(REVALIDATE_AFTER_MS + OFFLINE_GRACE_MS).toBeGreaterThan(30 * DAY);
    });

    it('honours an injected policy so the window is tunable without a code change', () => {
      const shortPolicy = { revalidateAfterMs: DAY, offlineGraceMs: DAY };
      expect(evaluateEntitlement(proLicense(), T0 + 1.5 * DAY, shortPolicy).state).toBe('grace');
      expect(evaluateEntitlement(proLicense(), T0 + 2.5 * DAY, shortPolicy).state).toBe('expired');
    });
  });

  describe('hard stops that grace does not rescue', () => {
    it('never entitles a key the server rejected', () => {
      const entitlement = evaluateEntitlement(proLicense({ status: 'invalid' }), T0);
      expect(entitlement).toMatchObject({ state: 'invalid', entitled: false, tier: 'free' });
    });

    it('expires at the subscription end date regardless of cache freshness', () => {
      const record = proLicense({ lastValidatedAt: T0, expiresAt: T0 + DAY });
      expect(evaluateEntitlement(record, T0 + 2 * DAY)).toMatchObject({
        state: 'expired',
        entitled: false,
      });
    });

    it('is still active before the subscription end date', () => {
      const record = proLicense({ expiresAt: T0 + 10 * DAY });
      expect(evaluateEntitlement(record, T0 + DAY).state).toBe('active');
    });
  });

  it('uses the documented default policy', () => {
    expect(DEFAULT_POLICY).toEqual({
      revalidateAfterMs: REVALIDATE_AFTER_MS,
      offlineGraceMs: OFFLINE_GRACE_MS,
    });
  });
});

describe('LocalNoopLicenseProvider', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    setLicenseProvider(new LocalNoopLicenseProvider());
  });

  it('is the default provider', () => {
    expect(getLicenseProvider().id).toBe('local-noop');
  });

  it('reports unlicensed when nothing is stored', async () => {
    expect(await new LocalNoopLicenseProvider().getEntitlement(T0)).toEqual(UNLICENSED);
  });

  it('evaluates the offline grace path from the cached record', async () => {
    await licenseRecord.set(proLicense());

    const provider = new LocalNoopLicenseProvider();
    const entitlement = await provider.getEntitlement(T0 + REVALIDATE_AFTER_MS + DAY);

    expect(entitlement).toMatchObject({ state: 'grace', entitled: true, tier: 'pro' });
  });

  it('refresh() resolves offline instead of rejecting', async () => {
    await licenseRecord.set(proLicense());

    const provider = new LocalNoopLicenseProvider();
    // There is no network here at all. The contract is that this still resolves
    // with the cached entitlement — being offline can never break the extension.
    const entitlement = await provider.refresh(T0 + REVALIDATE_AFTER_MS + DAY);

    expect(entitlement.entitled).toBe(true);
    expect(entitlement.revalidationDue).toBe(true);
  });

  it('degrades to free rather than throwing when the cache is corrupt', async () => {
    await fakeBrowser.storage.local.set({ 'foundation:license': 'corrupted' });

    const provider = new LocalNoopLicenseProvider();
    // A broken license cache must not brick a working extension.
    await expect(provider.getEntitlement(T0)).resolves.toEqual(UNLICENSED);
  });

  it('refuses activation because no merchant integration exists yet', async () => {
    const result = await new LocalNoopLicenseProvider().activate('ANY-KEY');
    expect(result).toMatchObject({ ok: false, reason: 'provider-not-configured' });
  });

  it('deactivate clears the cached record', async () => {
    await licenseRecord.set(proLicense());
    await new LocalNoopLicenseProvider().deactivate();
    expect(await licenseRecord.getOrThrow()).toBeNull();
  });

  it('the seam is swappable', async () => {
    setLicenseProvider({
      id: 'stub',
      supportsActivation: true,
      getEntitlement: async () => UNLICENSED,
      activate: async () => ({ ok: true, entitlement: UNLICENSED }),
      deactivate: async () => {},
      refresh: async () => UNLICENSED,
    });

    expect(getLicenseProvider().id).toBe('stub');
    expect(getLicenseProvider().supportsActivation).toBe(true);

    setLicenseProvider(new LocalNoopLicenseProvider());
  });
});
