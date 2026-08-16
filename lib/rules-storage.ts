/**
 * Persistence for header rules, and the backup/restore path that exists so
 * "my rules vanished" cannot happen here.
 *
 * Backups are not optional here. The dominant one-star complaint in this
 * category is rules disappearing after an update, and the incumbent's MV3
 * migration produced a whole review cluster of exactly that. So a snapshot is
 * taken automatically before every migration, update, import and restore; it
 * keeps the raw stored bytes next to the validated document, so a lossy
 * migration is still recoverable by hand; restoring snapshots what it is about
 * to replace, so a mistaken restore is itself undoable; and when the bounded
 * list drops its oldest entry, it says so.
 */

import './zod-config';
import { z } from 'zod';
import type { IdFactory, Profile, RulesDocument } from './rules';
import { countRules, createDocument, randomId, rulesDocumentSchema } from './rules';
import { defineStorageItem } from './storage';

/** Bump this together with a migration, never alone. See docs/architecture.md. */
export const RULES_SCHEMA_VERSION = 1;

export const rulesDocument = defineStorageItem<RulesDocument>({
  key: 'headers:document',
  version: RULES_SCHEMA_VERSION,
  schema: rulesDocumentSchema,
  defaultValue: () => createDocument(randomId),
});

export const BACKUP_REASONS = [
  'manual',
  'before-import',
  'before-restore',
  'before-update',
  'before-migration',
] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export const BACKUP_REASON_LABELS: Record<BackupReason, string> = {
  manual: 'Saved by you',
  'before-import': 'Before an import',
  'before-restore': 'Before restoring a backup',
  'before-update': 'Before an extension update',
  'before-migration': 'Before a storage upgrade',
};

/** How many snapshots are kept. Older ones are dropped oldest-first, and said so. */
export const MAX_BACKUPS = 12;

export const backupSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  reason: z.enum(BACKUP_REASONS),
  profileCount: z.number().int().nonnegative(),
  ruleCount: z.number().int().nonnegative(),
  document: rulesDocumentSchema,
  /**
   * The exact stored envelope this snapshot was taken from, when one existed.
   * Kept so a migration that loses a field is still recoverable by hand.
   */
  raw: z.unknown().optional(),
});
export type Backup = z.infer<typeof backupSchema>;

export const backupsSchema = z.object({ entries: z.array(backupSchema) });
export type Backups = z.infer<typeof backupsSchema>;

export const rulesBackups = defineStorageItem<Backups>({
  key: 'headers:backups',
  version: 1,
  schema: backupsSchema,
  defaultValue: () => ({ entries: [] }),
});

/** What the UI lists. Zod-backed because it crosses the worker boundary. */
export const backupSummarySchema = backupSchema.omit({ document: true, raw: true });
export type BackupSummary = z.infer<typeof backupSummarySchema>;

export function summariseBackup(backup: Backup): BackupSummary {
  return {
    id: backup.id,
    createdAt: backup.createdAt,
    reason: backup.reason,
    profileCount: backup.profileCount,
    ruleCount: backup.ruleCount,
  };
}

export interface AddBackupResult {
  /** The list to store, newest first. */
  entries: Backup[];
  /** Snapshots dropped to stay inside `MAX_BACKUPS`. Surfaced, never silent. */
  dropped: BackupSummary[];
}

/** Pure, so retention is testable without storage. Newest first. */
export function addBackup(
  entries: readonly Backup[],
  backup: Backup,
  max: number = MAX_BACKUPS,
): AddBackupResult {
  const next = [backup, ...entries];
  return { entries: next.slice(0, max), dropped: next.slice(max).map(summariseBackup) };
}

export function makeBackup(
  document: RulesDocument,
  reason: BackupReason,
  now: number,
  newId: IdFactory = randomId,
  raw?: unknown,
): Backup {
  const backup: Backup = {
    id: newId(),
    createdAt: now,
    reason,
    profileCount: document.profiles.length,
    ruleCount: countRules(document),
    document,
  };
  return raw === undefined ? backup : { ...backup, raw };
}

/**
 * The on-disk shape of an exported rule file. No server, no account, no id that
 * could identify a person or a machine — an export is the rules and nothing
 * else. See PRIVACY.md.
 */
export const TRANSFER_FORMAT = 'privacy-first-header-editor';
export const TRANSFER_VERSION = 1;

export const transferFileSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  formatVersion: z.number().int().positive(),
  exportedAt: z.number().int().nonnegative(),
  profiles: z.array(rulesDocumentSchema.shape.profiles.element),
});
export type TransferFile = z.infer<typeof transferFileSchema>;

export function buildTransferFile(profiles: readonly Profile[], now: number): TransferFile {
  return {
    format: TRANSFER_FORMAT,
    formatVersion: TRANSFER_VERSION,
    exportedAt: now,
    profiles: profiles.map((profile) => structuredClone(profile)),
  };
}

export function serialiseTransferFile(file: TransferFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type TransferParseResult =
  | { ok: true; file: TransferFile }
  | { ok: false; error: string };

export function parseTransferFile(raw: string): TransferParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      error: `That file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const envelope = transferFileSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      ok: false,
      error:
        'That file is not a rule export from this extension. ' +
        envelope.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
    };
  }

  if (envelope.data.formatVersion > TRANSFER_VERSION) {
    return {
      ok: false,
      error:
        `That file was written by a newer version of this extension (format ${envelope.data.formatVersion}, ` +
        `this build understands ${TRANSFER_VERSION}). Update the extension, then import it again.`,
    };
  }

  return { ok: true, file: envelope.data };
}

/** A filename that sorts chronologically and contains nothing identifying. */
export function transferFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `header-rules-${stamp}.json`;
}
