import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleInstalled, handleInstalledEvent } from '../entrypoints/background';
import {
  MAX_QUARANTINE_GENERATIONS,
  PRIVACY_DISCLOSURE_VERSION,
  installState,
  quarantineKey,
  type InstallState,
  type QuarantinedRecord,
} from '../lib/storage';

/**
 * `onInstalled` is the one place the foundation decides to put a tab in front of
 * the user unprompted, and the one place it reacts to a record it cannot read.
 * Both are user-visible and neither is reachable from the other tests, so they
 * are covered here directly against `fakeBrowser`.
 */

const INSTALL_KEY = 'foundation:installState';
const MANIFEST_VERSION = '1.2.3';
const QUARANTINE_KEY = quarantineKey(INSTALL_KEY, 1);
/** A disclosure version newer than the one this build ships. */
const NEXT_DISCLOSURE_VERSION = PRIVACY_DISCLOSURE_VERSION + 1;

/** Tabs opened since the last reset, newest last. */
function openedUrls(): string[] {
  return createdTabs.map((tab) => tab.url ?? '');
}

type CreatedTab = { url?: string | undefined };

let createdTabs: CreatedTab[] = [];
let warnings: string[] = [];

/** Writes a raw value, bypassing the wrapper, to simulate corruption/skew. */
async function writeRaw(key: string, value: unknown): Promise<void> {
  await fakeBrowser.storage.local.set({ [key]: value });
}

async function readRaw(key: string): Promise<unknown> {
  return (await fakeBrowser.storage.local.get(key))[key];
}

describe('background onInstalled', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    createdTabs = [];
    warnings = [];

    // fakeBrowser has no in-memory getManifest.
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
      version: MANIFEST_VERSION,
    } as never);
    vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation((info: CreatedTab) => {
      createdTabs.push(info);
      return Promise.resolve({ id: createdTabs.length } as never);
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('first install', () => {
    it('opens the welcome page without the privacy-change banner', async () => {
      await handleInstalled('install');

      expect(openedUrls()).toHaveLength(1);
      expect(openedUrls()[0]).not.toContain('notice=privacy');
    });

    it('records the disclosure as shown even though it was not acknowledged', async () => {
      await handleInstalled('install');

      const state = await installState.getOrThrow();
      expect(state.shownPrivacyVersion).toBe(PRIVACY_DISCLOSURE_VERSION);
      // The user never clicked "Got it", so this stays at zero.
      expect(state.acknowledgedPrivacyVersion).toBe(0);
      expect(state.installedAt).toBeGreaterThan(0);
    });

    it('does not re-notice on a later update when the user never acknowledged', async () => {
      // The regression: closing the welcome tab must not be mistaken for
      // "our disclosed data practices changed" on every subsequent update.
      await handleInstalled('install');
      createdTabs = [];

      await handleInstalled('update');

      expect(openedUrls()).toEqual([]);
    });

    it('does not mislabel the first view as a change when the install tab failed to open', async () => {
      // onInstalled can fire with no current window, so tabs.create rejects and
      // nothing was shown. The disclosure the user finally sees on the next
      // update is their first view of it, not a change to it.
      vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValueOnce(new Error('no current window'));
      await handleInstalled('install');
      expect((await installState.getOrThrow()).shownPrivacyVersion).toBe(0);

      await handleInstalled('update');

      expect(openedUrls()).toHaveLength(1);
      expect(openedUrls()[0]).not.toContain('notice=privacy');
      // The retry succeeded, so it is recorded as shown this time.
      expect((await installState.getOrThrow()).shownPrivacyVersion).toBe(
        PRIVACY_DISCLOSURE_VERSION,
      );
    });

    it('preserves the original install timestamp across later events', async () => {
      await handleInstalled('install');
      const installedAt = (await installState.getOrThrow()).installedAt;

      await handleInstalled('update');

      expect((await installState.getOrThrow()).installedAt).toBe(installedAt);
    });
  });

  describe('update', () => {
    it('opens nothing when the disclosure has not changed since it was shown', async () => {
      await installState.set(storedState({ shownPrivacyVersion: PRIVACY_DISCLOSURE_VERSION }));

      await handleInstalled('update');

      expect(openedUrls()).toEqual([]);
    });

    it('re-notices when the disclosure version has moved past what was shown', async () => {
      // A genuinely older, non-zero shown version: disclosure 1 is known to have
      // reached this user, and the build now discloses something newer.
      await installState.set(
        storedState({
          shownPrivacyVersion: PRIVACY_DISCLOSURE_VERSION,
          acknowledgedPrivacyVersion: PRIVACY_DISCLOSURE_VERSION,
        }),
      );

      await handleInstalled('update', NEXT_DISCLOSURE_VERSION);

      expect(openedUrls()).toHaveLength(1);
      expect(openedUrls()[0]).toContain('notice=privacy');
      expect((await installState.getOrThrow()).shownPrivacyVersion).toBe(NEXT_DISCLOSURE_VERSION);
    });

    it('does not claim a change when no disclosure has ever been shown', async () => {
      // shownPrivacyVersion 0 means "we have no record that any disclosure
      // reached this user" — showing it is right, calling it a change is a lie.
      await installState.set(storedState({ shownPrivacyVersion: 0 }));

      await handleInstalled('update');

      expect(openedUrls()).toHaveLength(1);
      expect(openedUrls()[0]).not.toContain('notice=privacy');
    });

    it('keeps the notice pending when the tab cannot be opened', async () => {
      vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('no window available'));
      await installState.set(storedState({ shownPrivacyVersion: 0 }));

      await handleInstalled('update');

      // Nothing was shown, so nothing is recorded as shown — it retries later.
      expect((await installState.getOrThrow()).shownPrivacyVersion).toBe(0);
      expect(warnings.join('\n')).toContain('welcome page');
    });

    it('ignores reasons other than install and update', async () => {
      await installState.set(storedState({ shownPrivacyVersion: 0 }));

      await handleInstalled('chrome_update');

      expect(openedUrls()).toEqual([]);
    });

    it('records the running version', async () => {
      await installState.set(storedState({ lastSeenVersion: '0.0.1' }));

      await handleInstalled('update');

      expect((await installState.getOrThrow()).lastSeenVersion).toBe(MANIFEST_VERSION);
    });
  });

  describe('an unreadable install-state record', () => {
    it('quarantines a version-ahead record instead of downgrading it', async () => {
      const future = { version: 99, data: { written: 'by a newer build' } };
      await writeRaw(INSTALL_KEY, future);

      await handleInstalled('update');

      // The whole point: the newer record is still recoverable verbatim.
      const quarantined = (await readRaw(QUARANTINE_KEY)) as { raw: unknown; detail: string };
      expect(quarantined.raw).toEqual(future);
      expect(quarantined.detail).toContain('refusing to downgrade');
    });

    it('says so out loud rather than losing the record silently', async () => {
      await writeRaw(INSTALL_KEY, { version: 99, data: {} });

      await handleInstalled('update');

      expect(warnings.join('\n')).toContain(QUARANTINE_KEY);
    });

    it('quarantines a structurally corrupt record too', async () => {
      await writeRaw(INSTALL_KEY, 'not-an-envelope');

      await handleInstalled('update');

      expect((await readRaw(QUARANTINE_KEY)) as { raw: unknown }).toMatchObject({
        raw: 'not-an-envelope',
      });
    });

    it('carries on from defaults so the extension still works', async () => {
      await writeRaw(INSTALL_KEY, 'garbage');

      await handleInstalled('update');

      const state = await installState.getOrThrow();
      expect(state.lastSeenVersion).toBe(MANIFEST_VERSION);
      expect(state.onboardingCompletedAt).toBeNull();
    });

    it('does not tell the user their data practices changed', async () => {
      // The record was unreadable, so `previous` fell back to defaults and the
      // shown version is unknown — that is not evidence of a change.
      await writeRaw(INSTALL_KEY, { version: 99, data: {} });

      await handleInstalled('update');

      expect(openedUrls()).toHaveLength(1);
      expect(openedUrls()[0]).not.toContain('notice=privacy');
    });

    it('preserves both copies when a second corruption follows', async () => {
      await writeRaw(INSTALL_KEY, { version: 99, data: { generation: 'first' } });
      await handleInstalled('update');

      await writeRaw(INSTALL_KEY, { version: 99, data: { generation: 'second' } });
      await handleInstalled('update');

      // Neither record is destroyed to make room for the other.
      expect((await readRaw(quarantineKey(INSTALL_KEY, 1))) as QuarantinedRecord).toMatchObject({
        raw: { data: { generation: 'first' } },
      });
      expect((await readRaw(quarantineKey(INSTALL_KEY, 2))) as QuarantinedRecord).toMatchObject({
        raw: { data: { generation: 'second' } },
      });
    });

    it('announces loudly when the generation budget forces a drop', async () => {
      for (let attempt = 0; attempt <= MAX_QUARANTINE_GENERATIONS; attempt++) {
        await writeRaw(INSTALL_KEY, { version: 99, data: { attempt } });
        await handleInstalled('update');
      }

      expect(warnings.join('\n')).toContain('quarantine is full');
      // The newest record is the one kept.
      expect((await readRaw(quarantineKey(INSTALL_KEY, 1))) as QuarantinedRecord).toMatchObject({
        raw: { data: { attempt: MAX_QUARANTINE_GENERATIONS } },
      });
    });
  });

  describe('a storage backend that rejects', () => {
    /**
     * `onInstalled` cannot await, so anything the handler throws would otherwise
     * become a bare unhandled rejection in the worker — the one failure mode
     * with no diagnostic attached to it.
     */
    it('does not reject out of the listener when the final write fails', async () => {
      const rejections: unknown[] = [];
      const record = (reason: unknown): void => void rejections.push(reason);
      process.on('unhandledRejection', record);
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota'));

      try {
        await expect(handleInstalledEvent('install')).resolves.toBeUndefined();
        // Give any stray rejection a turn of the loop to surface.
        await new Promise((done) => setImmediate(done));
      } finally {
        process.off('unhandledRejection', record);
      }

      expect(rejections).toEqual([]);
    });

    it('says which event failed and why', async () => {
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota'));

      await handleInstalledEvent('install');

      const logged = warnings.join('\n');
      expect(logged).toContain('[background]');
      expect(logged).toContain('install');
      expect(logged).toContain('QUOTA_BYTES quota');
    });

    it('still reports a failure the unreadable-record path could not rescue', async () => {
      // Read fails, so quarantine cannot preserve anything either, and the
      // write that follows fails for the same reason. Both must be legible.
      await writeRaw(INSTALL_KEY, { version: 99, data: {} });
      vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('backend gone'));
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('backend gone'));

      await expect(handleInstalledEvent('update')).resolves.toBeUndefined();

      const logged = warnings.join('\n');
      expect(logged).toContain('install state is unreadable');
      expect(logged).toContain('did not complete');
    });

    it('leaves handleInstalled itself throwing, so callers that can await still see it', async () => {
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota'));

      await expect(handleInstalled('install')).rejects.toThrow('QUOTA_BYTES quota');
    });
  });
});

function storedState(overrides: Partial<InstallState> = {}): InstallState {
  return {
    installedAt: 1_000,
    lastSeenVersion: '0.0.1',
    onboardingCompletedAt: null,
    acknowledgedPrivacyVersion: 0,
    shownPrivacyVersion: 0,
    ...overrides,
  };
}
