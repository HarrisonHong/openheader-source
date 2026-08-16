/**
 * Typed, schema-validated wrapper around `chrome.storage`.
 *
 * The MV3 service worker is stateless and can be killed at any moment, so
 * everything that must survive an event boundary lives here. Reads are validated
 * on the way in: a corrupt or version-skewed record returns `{ ok: false }`
 * rather than poisoning the UI with half-typed data, and every record sits in a
 * versioned envelope so a schema change has a migration path instead of a guess.
 * See docs/architecture.md.
 *
 * Only the `local` area is used. `chrome.storage.sync` would copy rules — and
 * the tokens in them — to Google's servers, which is the opposite of what
 * PRIVACY.md promises.
 */

import './zod-config';
import { browser } from '#imports';
import { z } from 'zod';

/** Reasons a read can fail. Every one of them is loud. */
export type StorageFailureReason =
  /** The stored value is not a `{ version, data }` envelope at all. */
  | 'malformed-envelope'
  /** Envelope was written by a newer schema version than this build knows. */
  | 'version-ahead'
  /** No migration exists to bring the record up to the current version. */
  | 'migration-missing'
  /** A migration function threw. */
  | 'migration-failed'
  /** Data does not satisfy the current schema. */
  | 'schema-mismatch'
  /** `chrome.storage` itself failed or is unavailable. */
  | 'backend-unavailable';

export class StorageValidationError extends Error {
  readonly key: string;
  readonly reason: StorageFailureReason;
  readonly detail: string;

  constructor(key: string, reason: StorageFailureReason, detail: string) {
    super(`storage[${key}]: ${reason} — ${detail}`);
    this.name = 'StorageValidationError';
    this.key = key;
    this.reason = reason;
    this.detail = detail;
  }
}

export type StorageReadResult<T> =
  | { ok: true; value: T; source: 'stored' | 'default'; migrated: boolean }
  | { ok: false; error: StorageValidationError };

/** Suffix of the side keys an unreadable record is copied to. */
export const QUARANTINE_KEY_SUFFIX = '.quarantine';

/**
 * How many unreadable records are preserved per key before the oldest is
 * displaced. A bound is required: a record that fails to read on every event
 * would otherwise grow the keyspace until the storage quota is gone.
 */
export const MAX_QUARANTINE_GENERATIONS = 5;

/** `foundation:installState.quarantine.2` — generation is 1-based. */
export function quarantineKey(key: string, generation: number): string {
  return `${key}${QUARANTINE_KEY_SUFFIX}.${generation}`;
}

export type QuarantineResult =
  | {
      quarantined: true;
      /** The generational key the raw value was written to. */
      key: string;
      generation: number;
      /**
       * Present only when every generation was occupied. The newest record is
       * always the one preserved, so the oldest copy is dropped to make room —
       * callers must announce this rather than swallowing it.
       */
      displaced?: DisplacedQuarantine;
    }
  | {
      quarantined: false;
      /** Why nothing was copied aside. Neither of these is data loss. */
      reason: 'nothing-stored' | 'backend-unavailable';
    };

export interface DisplacedQuarantine {
  key: string;
  detail: string;
  quarantinedAt: number;
}

/** Shape written to the quarantine key. The raw value is stored verbatim. */
export interface QuarantinedRecord {
  quarantinedAt: number;
  detail: string;
  raw: unknown;
}

/** Minimal surface of `chrome.storage.local` that this module depends on. */
export interface StorageBackend {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

/**
 * Upgrades a record from version `n - 1` to version `n`. The payload arrives as
 * `unknown` and unvalidated — the schema it was written against no longer exists.
 */
export type Migration = (previousData: unknown) => unknown;

export interface StorageItemDefinition<T> {
  /** Storage key. Namespaced to keep the keyspace legible. */
  key: string;
  /** Current schema version. Bump whenever `schema` changes shape. */
  version: number;
  /** Zod schema for the current version. */
  schema: z.ZodType<T>;
  /** Value returned when nothing is stored yet. Must satisfy `schema`. */
  defaultValue: () => T;
  /**
   * `migrations[n]` upgrades a record from version `n - 1` to version `n`.
   * A gap in the chain is a hard error, not a silent fallback.
   */
  migrations?: Record<number, Migration>;
  /** Injectable for tests. Defaults to `chrome.storage.local`. */
  backend?: StorageBackend;
}

export interface StorageItem<T> {
  readonly key: string;
  readonly version: number;
  /** Validated read. Never throws for data problems — returns a result. */
  get(): Promise<StorageReadResult<T>>;
  /**
   * The stored envelope, exactly as it sits on disk, with no validation and no
   * migration. `undefined` when nothing is stored.
   *
   * This exists so a backup can preserve the bytes a migration is about to
   * rewrite. Everything else uses `get()`; an unvalidated value has no business
   * reaching the UI.
   */
  readRaw(): Promise<unknown>;
  /** Validated read that throws `StorageValidationError`. For callers that already have an error boundary. */
  getOrThrow(): Promise<T>;
  /** Validates before writing. Throws on programmer error (invalid value). */
  set(value: T): Promise<void>;
  /** Read-modify-write. Fails loudly if the current record is unreadable. */
  update(updater: (current: T) => T): Promise<T>;
  /**
   * Copies the raw stored value aside to the next free generational key
   * (`${key}${QUARANTINE_KEY_SUFFIX}.1`, `.2`, …).
   *
   * A caller that cannot read a record and must carry on with defaults calls
   * this first, so the unreadable bytes survive the overwrite and a later build
   * that understands them can recover them. Occurrences accumulate up to
   * `MAX_QUARANTINE_GENERATIONS`; past that the oldest copy is displaced, so the
   * newest record — the one holding the user's current data — is the one kept.
   */
  quarantine(detail: string): Promise<QuarantineResult>;
  remove(): Promise<void>;
  /** Subscribe to changes to this key. Returns an unsubscribe function. */
  watch(listener: (result: StorageReadResult<T>) => void): () => void;
}

const envelopeSchema = z.object({
  version: z.number().int().nonnegative(),
  data: z.unknown(),
});

type Envelope = { version: number; data: unknown };

function defaultBackend(): StorageBackend {
  return {
    get: (keys) => browser.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => browser.storage.local.set(items),
    remove: (keys) => browser.storage.local.remove(keys),
  };
}

/**
 * Walks a stored envelope up to the current version. Exported so the migration
 * chain can be tested directly.
 */
export function migrateEnvelope(
  key: string,
  envelope: Envelope,
  targetVersion: number,
  migrations: Record<number, Migration>,
): { ok: true; data: unknown; migrated: boolean } | { ok: false; error: StorageValidationError } {
  if (envelope.version > targetVersion) {
    return {
      ok: false,
      error: new StorageValidationError(
        key,
        'version-ahead',
        `stored version ${envelope.version} is newer than supported version ${targetVersion}; ` +
          'refusing to downgrade a record written by a newer build',
      ),
    };
  }

  let data = envelope.data;
  for (let next = envelope.version + 1; next <= targetVersion; next++) {
    const migration = migrations[next];
    if (!migration) {
      return {
        ok: false,
        error: new StorageValidationError(
          key,
          'migration-missing',
          `no migration registered for version ${next} (stored ${envelope.version}, target ${targetVersion})`,
        ),
      };
    }
    try {
      data = migration(data);
    } catch (cause) {
      return {
        ok: false,
        error: new StorageValidationError(
          key,
          'migration-failed',
          `migration to version ${next} threw: ${errorMessage(cause)}`,
        ),
      };
    }
  }

  return { ok: true, data, migrated: envelope.version !== targetVersion };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function defineStorageItem<T>(definition: StorageItemDefinition<T>): StorageItem<T> {
  const { key, version, schema, defaultValue } = definition;
  const migrations = definition.migrations ?? {};
  const backend = definition.backend ?? defaultBackend();

  function decode(raw: unknown): StorageReadResult<T> {
    if (raw === undefined || raw === null) {
      return { ok: true, value: defaultValue(), source: 'default', migrated: false };
    }

    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      return {
        ok: false,
        error: new StorageValidationError(
          key,
          'malformed-envelope',
          `expected { version, data }, got ${describe(raw)}`,
        ),
      };
    }

    const migrated = migrateEnvelope(key, envelope.data, version, migrations);
    if (!migrated.ok) return migrated;

    const parsed = schema.safeParse(migrated.data);
    if (!parsed.success) {
      return {
        ok: false,
        error: new StorageValidationError(
          key,
          'schema-mismatch',
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        ),
      };
    }

    return { ok: true, value: parsed.data, source: 'stored', migrated: migrated.migrated };
  }

  async function get(): Promise<StorageReadResult<T>> {
    let record: Record<string, unknown>;
    try {
      record = await backend.get(key);
    } catch (cause) {
      return {
        ok: false,
        error: new StorageValidationError(key, 'backend-unavailable', errorMessage(cause)),
      };
    }
    return decode(record[key]);
  }

  async function set(value: T): Promise<void> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      // Writing invalid data is a programmer error, not a data-integrity
      // problem, so this throws rather than returning a result.
      throw new StorageValidationError(
        key,
        'schema-mismatch',
        `refusing to write invalid value: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const envelope: Envelope = { version, data: parsed.data };
    await backend.set({ [key]: envelope });
  }

  const generationKeys = Array.from({ length: MAX_QUARANTINE_GENERATIONS }, (_, index) =>
    quarantineKey(key, index + 1),
  );

  async function quarantine(detail: string): Promise<QuarantineResult> {
    let stored: Record<string, unknown>;
    let occupants: unknown[];
    try {
      const [own, ...slots] = await Promise.all([
        backend.get(key),
        ...generationKeys.map((slot) => backend.get(slot)),
      ]);
      stored = own ?? {};
      occupants = slots.map((slot, index) => slot[generationKeys[index] ?? '']);
    } catch {
      return { quarantined: false, reason: 'backend-unavailable' };
    }

    const raw = stored[key];
    if (raw === undefined) {
      return { quarantined: false, reason: 'nothing-stored' };
    }

    const free = occupants.findIndex((occupant) => occupant === undefined);
    const index = free === -1 ? indexOfOldestQuarantine(occupants) : free;
    const target = generationKeys[index] ?? quarantineKey(key, 1);
    const record: QuarantinedRecord = { quarantinedAt: Date.now(), detail, raw };

    try {
      await backend.set({ [target]: record });
    } catch {
      return { quarantined: false, reason: 'backend-unavailable' };
    }

    if (free === -1) {
      return {
        quarantined: true,
        key: target,
        generation: index + 1,
        displaced: describeQuarantined(target, occupants[index]),
      };
    }
    return { quarantined: true, key: target, generation: index + 1 };
  }

  async function readRaw(): Promise<unknown> {
    try {
      const record = await backend.get(key);
      return record[key];
    } catch {
      return undefined;
    }
  }

  return {
    key,
    version,
    get,
    set,
    quarantine,
    readRaw,
    async getOrThrow(): Promise<T> {
      const result = await get();
      if (!result.ok) throw result.error;
      return result.value;
    },
    async update(updater): Promise<T> {
      const current = await get();
      if (!current.ok) throw current.error;
      const next = updater(current.value);
      await set(next);
      return next;
    },
    async remove(): Promise<void> {
      await backend.remove(key);
    },
    watch(listener): () => void {
      const handler = (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ): void => {
        if (areaName !== 'local') return;
        const change = changes[key];
        if (!change) return;
        listener(decode(change.newValue));
      };
      browser.storage.onChanged.addListener(handler);
      return () => browser.storage.onChanged.removeListener(handler);
    },
  };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function quarantinedAtOf(occupant: unknown): number | null {
  if (typeof occupant !== 'object' || occupant === null) return null;
  const at = (occupant as { quarantinedAt?: unknown }).quarantinedAt;
  return typeof at === 'number' ? at : null;
}

/** Oldest by `quarantinedAt`. Slots we cannot date are treated as oldest. */
function indexOfOldestQuarantine(occupants: unknown[]): number {
  let oldest = 0;
  let oldestAt = Number.POSITIVE_INFINITY;
  occupants.forEach((occupant, index) => {
    const at = quarantinedAtOf(occupant) ?? Number.NEGATIVE_INFINITY;
    if (at < oldestAt) {
      oldestAt = at;
      oldest = index;
    }
  });
  return oldest;
}

function describeQuarantined(key: string, occupant: unknown): DisplacedQuarantine {
  const detail =
    typeof occupant === 'object' && occupant !== null
      ? (occupant as { detail?: unknown }).detail
      : undefined;
  return {
    key,
    detail: typeof detail === 'string' ? detail : 'unknown',
    quarantinedAt: quarantinedAtOf(occupant) ?? 0,
  };
}

// Records the foundation itself needs. The header rules live in
// `lib/rules-storage.ts`, on the same machinery.

/**
 * Bumped whenever PRIVACY.md's disclosed data practices change. The background
 * worker compares this against the acknowledged value and proactively re-shows
 * the disclosure — required by the Chrome Web Store disclosure policy that took
 * effect 2026-08-01.
 *
 * Version 2 (2026-07-31): the extension gained header rules, which means it can
 * now hold host permissions for sites the user names and can read and change the
 * headers of requests to them. That is a genuine widening of what it can access,
 * so every existing user is shown the disclosure again.
 */
export const PRIVACY_DISCLOSURE_VERSION = 2;

export const installStateSchema = z.object({
  installedAt: z.number().int().nonnegative(),
  lastSeenVersion: z.string(),
  onboardingCompletedAt: z.number().int().nonnegative().nullable(),
  /**
   * Highest disclosure version the user acknowledged by clicking through
   * onboarding. Drives `install:getState`.
   */
  acknowledgedPrivacyVersion: z.number().int().nonnegative(),
  /**
   * Highest disclosure version we actually put in front of the user, clicked or
   * not. Drives the proactive re-notice: "the user closed the tab" is not the
   * same event as "our data practices changed".
   */
  shownPrivacyVersion: z.number().int().nonnegative(),
});
export type InstallState = z.infer<typeof installStateSchema>;

/** Exported so callers recovering from an unreadable record fall back to the
 * same baseline the item itself uses. */
export function defaultInstallState(): InstallState {
  return {
    installedAt: 0,
    lastSeenVersion: '0.0.0',
    onboardingCompletedAt: null,
    acknowledgedPrivacyVersion: 0,
    shownPrivacyVersion: 0,
  };
}

export const installState = defineStorageItem<InstallState>({
  key: 'foundation:installState',
  version: 2,
  schema: installStateSchema,
  defaultValue: defaultInstallState,
  migrations: {
    /**
     * v1 had no `shownPrivacyVersion`. Every v1 record was written by a build
     * whose only disclosure version was 1, and that build opened the welcome
     * page on install — so disclosure 1 was shown, and anything acknowledged
     * was shown by definition. The literal 1 is deliberate: it records history,
     * so it must not follow later bumps of `PRIVACY_DISCLOSURE_VERSION`.
     */
    2: (previous) => {
      const record = (previous ?? {}) as Record<string, unknown>;
      const acknowledged = record.acknowledgedPrivacyVersion;
      return {
        ...record,
        shownPrivacyVersion: Math.max(typeof acknowledged === 'number' ? acknowledged : 0, 1),
      };
    },
  },
});

// A `preferences` item lived here holding one `verboseLogging` flag that nothing
// ever read, behind an options-page switch promising diagnostics it never wrote.
// On a page whose purpose is transparency, a control with no behaviour is worse
// than no control. Add one back when something actually reads it.
