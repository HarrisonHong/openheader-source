import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { z } from 'zod';
import {
  MAX_QUARANTINE_GENERATIONS,
  QUARANTINE_KEY_SUFFIX,
  type QuarantinedRecord,
  StorageValidationError,
  defineStorageItem,
  installState,
  migrateEnvelope,
  quarantineKey,
} from './storage';

const widgetSchema = z.object({ label: z.string(), count: z.number().int() });
type Widget = z.infer<typeof widgetSchema>;

function makeItem(overrides: Partial<Parameters<typeof defineStorageItem<Widget>>[0]> = {}) {
  return defineStorageItem<Widget>({
    key: 'test:widget',
    version: 1,
    schema: widgetSchema,
    defaultValue: () => ({ label: 'default', count: 0 }),
    ...overrides,
  });
}

/** Writes a raw value, bypassing the wrapper, to simulate corruption/skew. */
async function writeRaw(key: string, value: unknown): Promise<void> {
  await fakeBrowser.storage.local.set({ [key]: value });
}

describe('storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe('happy path', () => {
    it('round-trips a valid value', async () => {
      const item = makeItem();
      await item.set({ label: 'hello', count: 3 });

      const result = await item.get();
      expect(result).toEqual({
        ok: true,
        value: { label: 'hello', count: 3 },
        source: 'stored',
        migrated: false,
      });
    });

    it('returns the default when nothing is stored', async () => {
      const result = await makeItem().get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source).toBe('default');
      expect(result.value).toEqual({ label: 'default', count: 0 });
    });

    it('wraps stored values in a versioned envelope', async () => {
      await makeItem().set({ label: 'x', count: 1 });
      const raw = await fakeBrowser.storage.local.get('test:widget');
      expect(raw['test:widget']).toEqual({ version: 1, data: { label: 'x', count: 1 } });
    });

    it('updates read-modify-write', async () => {
      const item = makeItem();
      await item.set({ label: 'a', count: 1 });
      const next = await item.update((current) => ({ ...current, count: current.count + 1 }));
      expect(next.count).toBe(2);
      expect(await item.getOrThrow()).toEqual({ label: 'a', count: 2 });
    });
  });

  describe('corrupted records fail loudly', () => {
    it.each([
      ['a bare string', 'not-an-envelope'],
      ['a number', 42],
      ['an array', [1, 2, 3]],
      ['an object with no version', { data: { label: 'x', count: 1 } }],
      ['an envelope with a non-numeric version', { version: 'one', data: {} }],
    ])('rejects %s as a malformed envelope', async (_name, raw) => {
      await writeRaw('test:widget', raw);

      const result = await makeItem().get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(StorageValidationError);
      expect(result.error.reason).toBe('malformed-envelope');
    });

    it('rejects a well-formed envelope whose data violates the schema', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'x', count: 'three' } });

      const result = await makeItem().get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('schema-mismatch');
      expect(result.error.message).toContain('count');
    });

    it('does not fall back to the default when a record is corrupt', async () => {
      await writeRaw('test:widget', { version: 1, data: { nope: true } });
      const result = await makeItem().get();
      // A corrupt record must not silently become the default — that hides data
      // loss from the user.
      expect(result.ok).toBe(false);
    });

    it('getOrThrow throws StorageValidationError on a corrupt record', async () => {
      await writeRaw('test:widget', 'garbage');
      await expect(makeItem().getOrThrow()).rejects.toBeInstanceOf(StorageValidationError);
    });

    it('update refuses to write on top of a corrupt record', async () => {
      await writeRaw('test:widget', 'garbage');
      await expect(makeItem().update((current) => current)).rejects.toBeInstanceOf(
        StorageValidationError,
      );
      // The corrupt value is left untouched rather than being overwritten.
      const raw = await fakeBrowser.storage.local.get('test:widget');
      expect(raw['test:widget']).toBe('garbage');
    });

    it('reports backend failures instead of pretending the value is missing', async () => {
      const item = makeItem({
        backend: {
          get: () => Promise.reject(new Error('storage quota exceeded')),
          set: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
      });

      const result = await item.get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('backend-unavailable');
      expect(result.error.message).toContain('storage quota exceeded');
    });
  });

  describe('version skew', () => {
    it('refuses a record written by a NEWER schema version', async () => {
      await writeRaw('test:widget', { version: 7, data: { label: 'x', count: 1 } });

      const result = await makeItem().get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('version-ahead');
      expect(result.error.message).toContain('refusing to downgrade');
    });

    it('migrates a record written by an OLDER schema version', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'old' } });

      const item = defineStorageItem<Widget>({
        key: 'test:widget',
        version: 2,
        schema: widgetSchema,
        defaultValue: () => ({ label: 'default', count: 0 }),
        migrations: {
          2: (previous) => ({ ...(previous as object), count: 0 }),
        },
      });

      const result = await item.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ label: 'old', count: 0 });
      expect(result.migrated).toBe(true);
    });

    it('runs multi-step migrations in order', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'v1' } });

      const item = defineStorageItem<Widget>({
        key: 'test:widget',
        version: 3,
        schema: widgetSchema,
        defaultValue: () => ({ label: 'default', count: 0 }),
        migrations: {
          2: (previous) => ({ ...(previous as object), count: 1 }),
          3: (previous) => ({ ...(previous as Widget), count: (previous as Widget).count + 10 }),
        },
      });

      const result = await item.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ label: 'v1', count: 11 });
    });

    it('fails loudly when the migration chain has a gap', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'v1' } });

      const item = defineStorageItem<Widget>({
        key: 'test:widget',
        version: 3,
        schema: widgetSchema,
        defaultValue: () => ({ label: 'default', count: 0 }),
        migrations: { 3: (previous) => previous },
      });

      const result = await item.get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('migration-missing');
    });

    it('fails loudly when a migration throws', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'v1' } });

      const item = defineStorageItem<Widget>({
        key: 'test:widget',
        version: 2,
        schema: widgetSchema,
        defaultValue: () => ({ label: 'default', count: 0 }),
        migrations: {
          2: () => {
            throw new Error('bad data');
          },
        },
      });

      const result = await item.get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('migration-failed');
      expect(result.error.message).toContain('bad data');
    });

    it('rejects a migrated record that still fails the current schema', async () => {
      await writeRaw('test:widget', { version: 1, data: { label: 'v1' } });

      const item = defineStorageItem<Widget>({
        key: 'test:widget',
        version: 2,
        schema: widgetSchema,
        defaultValue: () => ({ label: 'default', count: 0 }),
        // Migration forgets to add `count`.
        migrations: { 2: (previous) => previous },
      });

      const result = await item.get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('schema-mismatch');
    });
  });

  describe('migrateEnvelope', () => {
    it('is a no-op when versions already match', () => {
      const result = migrateEnvelope('k', { version: 2, data: { a: 1 } }, 2, {});
      expect(result).toEqual({ ok: true, data: { a: 1 }, migrated: false });
    });
  });

  describe('writes are validated too', () => {
    it('refuses to persist a value that violates the schema', async () => {
      const item = makeItem();
      await expect(
        item.set({ label: 'x', count: 1.5 } satisfies Widget as Widget),
      ).rejects.toBeInstanceOf(StorageValidationError);

      const raw = await fakeBrowser.storage.local.get('test:widget');
      expect(raw['test:widget']).toBeUndefined();
    });
  });

  describe('foundation items', () => {
    it('installState defaults are self-consistent', async () => {
      const result = await installState.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.onboardingCompletedAt).toBeNull();
      expect(result.value.acknowledgedPrivacyVersion).toBe(0);
    });

    it('rejects a version-skewed installState record', async () => {
      await writeRaw('foundation:installState', { version: 99, data: {} });
      const result = await installState.get();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('version-ahead');
    });

    it('defaults installState to "nothing shown, nothing acknowledged"', async () => {
      const result = await installState.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.shownPrivacyVersion).toBe(0);
    });

    it('migrates a v1 installState record forward, treating v1 as already shown', async () => {
      // v1 predates `shownPrivacyVersion`, but every v1 build opened the welcome
      // page on install, so disclosure 1 was in fact shown.
      await writeRaw('foundation:installState', {
        version: 1,
        data: {
          installedAt: 5,
          lastSeenVersion: '0.0.1',
          onboardingCompletedAt: null,
          acknowledgedPrivacyVersion: 0,
        },
      });

      const result = await installState.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migrated).toBe(true);
      expect(result.value.shownPrivacyVersion).toBe(1);
      expect(result.value.acknowledgedPrivacyVersion).toBe(0);
      expect(result.value.installedAt).toBe(5);
    });

    it('never migrates a v1 record to a shown version below what it acknowledged', async () => {
      await writeRaw('foundation:installState', {
        version: 1,
        data: {
          installedAt: 5,
          lastSeenVersion: '0.0.1',
          onboardingCompletedAt: 6,
          acknowledgedPrivacyVersion: 3,
        },
      });

      const result = await installState.get();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.shownPrivacyVersion).toBe(3);
    });
  });

  describe('quarantine', () => {
    /** Reads a generational quarantine slot. */
    async function readSlot(generation: number): Promise<QuarantinedRecord | undefined> {
      const slot = quarantineKey('test:widget', generation);
      return (await fakeBrowser.storage.local.get(slot))[slot] as QuarantinedRecord | undefined;
    }

    it('copies the raw unreadable value aside verbatim', async () => {
      const corrupt = { version: 99, data: { from: 'a newer build' } };
      await writeRaw('test:widget', corrupt);

      const result = await makeItem().quarantine('version-ahead');

      expect(result).toMatchObject({
        quarantined: true,
        key: 'test:widget.quarantine.1',
        generation: 1,
      });
      const stored = await readSlot(1);
      expect(stored?.raw).toEqual(corrupt);
      expect(stored?.detail).toBe('version-ahead');
      expect(stored?.quarantinedAt).toBeGreaterThan(0);
    });

    it('leaves the original key untouched', async () => {
      await writeRaw('test:widget', 'garbage');
      await makeItem().quarantine('malformed-envelope');

      const raw = await fakeBrowser.storage.local.get('test:widget');
      expect(raw['test:widget']).toBe('garbage');
    });

    it('reports that there was nothing to preserve', async () => {
      const result = await makeItem().quarantine('malformed-envelope');
      expect(result).toEqual({ quarantined: false, reason: 'nothing-stored' });
    });

    it('preserves every occurrence under its own generational key', async () => {
      await writeRaw('test:widget', 'first');
      const first = await makeItem().quarantine('first failure');

      await writeRaw('test:widget', 'second');
      const second = await makeItem().quarantine('second failure');

      // Neither copy is destroyed to make room for the other.
      expect(first).toMatchObject({ quarantined: true, generation: 1 });
      expect(second).toMatchObject({ quarantined: true, generation: 2 });
      expect((await readSlot(1))?.raw).toBe('first');
      expect((await readSlot(2))?.raw).toBe('second');
    });

    it('does not announce a displacement while generations remain free', async () => {
      await writeRaw('test:widget', 'only');
      const result = await makeItem().quarantine('once');
      expect(result).not.toHaveProperty('displaced');
    });

    it('keeps the newest record when the generation budget is exhausted', async () => {
      const item = makeItem();
      for (let generation = 1; generation <= MAX_QUARANTINE_GENERATIONS; generation++) {
        await writeRaw('test:widget', `record-${generation}`);
        await item.quarantine(`failure ${generation}`);
      }

      await writeRaw('test:widget', 'newest');
      const result = await item.quarantine('overflow');

      // The oldest copy makes way; the newest record survives, and the drop is
      // reported rather than swallowed.
      expect(result).toMatchObject({ quarantined: true, generation: 1 });
      expect(result).toHaveProperty('displaced');
      if (result.quarantined) {
        expect(result.displaced).toMatchObject({
          key: 'test:widget.quarantine.1',
          detail: 'failure 1',
        });
      }
      expect((await readSlot(1))?.raw).toBe('newest');
      // Every other generation is untouched.
      expect((await readSlot(2))?.raw).toBe('record-2');
      expect((await readSlot(MAX_QUARANTINE_GENERATIONS))?.raw).toBe(
        `record-${MAX_QUARANTINE_GENERATIONS}`,
      );
    });

    it('never exceeds its generation budget', async () => {
      const item = makeItem();
      for (let attempt = 0; attempt < MAX_QUARANTINE_GENERATIONS + 3; attempt++) {
        await writeRaw('test:widget', `record-${attempt}`);
        await item.quarantine(`failure ${attempt}`);
      }

      const keys = Object.keys(await fakeBrowser.storage.local.get(null as never)).filter((key) =>
        key.includes(QUARANTINE_KEY_SUFFIX),
      );
      expect(keys).toHaveLength(MAX_QUARANTINE_GENERATIONS);
    });

    it('reports a backend failure rather than throwing', async () => {
      const item = makeItem({
        backend: {
          get: () => Promise.reject(new Error('storage unavailable')),
          set: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
      });

      await expect(item.quarantine('any')).resolves.toMatchObject({
        quarantined: false,
        reason: 'backend-unavailable',
      });
    });

    it('reports a failed write rather than claiming the value was preserved', async () => {
      const item = makeItem({
        backend: {
          get: (keys) => Promise.resolve(keys === 'test:widget' ? { 'test:widget': 'x' } : {}),
          set: () => Promise.reject(new Error('quota exceeded')),
          remove: () => Promise.resolve(),
        },
      });

      await expect(item.quarantine('any')).resolves.toMatchObject({
        quarantined: false,
        reason: 'backend-unavailable',
      });
    });
  });
});
