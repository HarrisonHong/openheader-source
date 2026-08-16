import { describe, expect, it } from 'vitest';
import {
  MAX_BACKUPS,
  TRANSFER_FORMAT,
  addBackup,
  buildTransferFile,
  makeBackup,
  parseTransferFile,
  serialiseTransferFile,
  transferFileName,
} from './rules-storage';
import type { Backup } from './rules-storage';
import { addRule, createDocument, createRule, sequentialIds } from './rules';

const newId = sequentialIds('id');

function documentWithOneRule() {
  const ids = sequentialIds('doc');
  const document = createDocument(ids);
  return addRule(document, document.profiles[0]!.id, createRule(ids, 'Auth'));
}

function backupAt(time: number): Backup {
  return makeBackup(documentWithOneRule(), 'manual', time, newId);
}

describe('makeBackup', () => {
  it('records what the snapshot contains, so the list is readable without opening it', () => {
    const backup = makeBackup(documentWithOneRule(), 'before-import', 1_700_000_000_000, newId);

    expect(backup.profileCount).toBe(1);
    expect(backup.ruleCount).toBe(1);
    expect(backup.reason).toBe('before-import');
  });

  it('keeps the raw stored bytes when they were available', () => {
    const raw = { version: 0, data: { legacy: true } };
    const backup = makeBackup(documentWithOneRule(), 'before-migration', 1, newId, raw);

    // A migration that drops a field is still recoverable by hand from this.
    expect(backup.raw).toEqual(raw);
  });

  it('omits raw entirely when there was nothing stored', () => {
    expect(makeBackup(documentWithOneRule(), 'manual', 1, newId)).not.toHaveProperty('raw');
  });
});

describe('backup retention', () => {
  it('keeps newest first', () => {
    const older = backupAt(1);
    const newer = backupAt(2);

    expect(addBackup([older], newer).entries.map((entry) => entry.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it('drops the oldest past the cap and REPORTS what it dropped', () => {
    const existing = Array.from({ length: MAX_BACKUPS }, (_, index) => backupAt(index));
    const fresh = backupAt(999);

    const { entries, dropped } = addBackup(existing, fresh);

    expect(entries).toHaveLength(MAX_BACKUPS);
    expect(entries[0]?.id).toBe(fresh.id);
    // Silently discarding a user's backup is the same failure as losing the
    // rules, so retention has to be announced.
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.id).toBe(existing.at(-1)?.id);
  });

  it('drops nothing while there is room', () => {
    expect(addBackup([backupAt(1)], backupAt(2)).dropped).toEqual([]);
  });

  it('honours a custom cap', () => {
    const { entries, dropped } = addBackup([backupAt(1), backupAt(2)], backupAt(3), 2);

    expect(entries).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });
});

describe('the transfer file', () => {
  it('round-trips a rule set', () => {
    const document = documentWithOneRule();
    const file = buildTransferFile(document.profiles, 1_700_000_000_000);

    const parsed = parseTransferFile(serialiseTransferFile(file));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.file.profiles).toEqual(document.profiles);
  });

  it('contains nothing but the rules — no account, no device id', () => {
    const file = buildTransferFile(documentWithOneRule().profiles, 1_700_000_000_000);

    expect(Object.keys(file).sort()).toEqual([
      'exportedAt',
      'format',
      'formatVersion',
      'profiles',
    ]);
    expect(file.format).toBe(TRANSFER_FORMAT);
  });

  it('rejects invalid JSON with the parser message', () => {
    const result = parseTransferFile('{ not json');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not valid JSON');
  });

  it('rejects a file from a different tool', () => {
    const result = parseTransferFile(JSON.stringify([{ title: 'ModHeader profile' }]));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not a rule export from this extension');
  });

  it('refuses a file written by a newer build rather than importing half of it', () => {
    const file = buildTransferFile(documentWithOneRule().profiles, 1);
    const raw = JSON.stringify({ ...file, formatVersion: 99 });

    const result = parseTransferFile(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('newer version');
  });

  it('rejects a file whose rules do not match the schema', () => {
    const raw = JSON.stringify({
      format: TRANSFER_FORMAT,
      formatVersion: 1,
      exportedAt: 1,
      profiles: [{ id: 'p', name: 'p', rules: [{ id: 'r' }] }],
    });

    expect(parseTransferFile(raw).ok).toBe(false);
  });

  it('names the file so it sorts chronologically and identifies nobody', () => {
    const name = transferFileName(new Date('2026-07-31T09:15:00.000Z'));

    expect(name).toBe('header-rules-2026-07-31-09-15-00.json');
  });
});
