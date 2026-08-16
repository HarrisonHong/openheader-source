/**
 * The rules engine: storage → compiler → Chrome, and back again.
 *
 * Two guarantees, both here because the incumbent breaks them. Nothing is
 * silently a no-op: every rule gets a status (see `lib/dnr.ts`), and after
 * installing we read the ruleset back out of Chrome and compare, reporting any
 * difference rather than assuming it away. And nothing is silently lost: an
 * unreadable document is quarantined before anything overwrites it, and a
 * snapshot is taken before every migration, update, import and restore.
 *
 * Chrome access is injected as `DnrBackend`, so the engine runs under vitest
 * against a fake and the service worker takes the same code path.
 */

import { browser } from '#imports';
import type { CompileResult, DnrRule, RegexSupport, RuleStatus } from './dnr';
import { checkRegexSupport, compileDocument, siteTooBroadReason } from './dnr';
import type { ImportReport } from './modheader';
import { parseModHeaderExport } from './modheader';
import { grantedOrigins } from './permissions';
import type { IdFactory, Profile, RulesDocument } from './rules';
import {
  RESOURCE_TYPES,
  cloneProfileWithNewIds,
  createDocument,
  normaliseDocument,
  randomId,
  validateDocument,
} from './rules';
import type { Backup, BackupReason, BackupSummary } from './rules-storage';
import {
  MAX_BACKUPS,
  addBackup,
  buildTransferFile,
  makeBackup,
  parseTransferFile,
  rulesBackups,
  rulesDocument,
  serialiseTransferFile,
  summariseBackup,
  transferFileName,
} from './rules-storage';

export interface DnrBackend {
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  isRegexSupported(options: {
    regex: string;
  }): Promise<{ isSupported: boolean; reason?: string }>;
  supportedResourceTypes(): readonly string[];
}

/** Minimal shape of the parts of `chrome.declarativeNetRequest` we touch. */
interface ChromeDnr {
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  isRegexSupported(options: {
    regex: string;
  }): Promise<{ isSupported: boolean; reason?: string }>;
  ResourceType?: Record<string, string>;
}

export function chromeDnrBackend(): DnrBackend {
  const api = (browser as unknown as { declarativeNetRequest?: ChromeDnr }).declarativeNetRequest;
  if (!api) {
    throw new Error(
      'chrome.declarativeNetRequest is unavailable. The extension cannot apply header rules ' +
        'without it — check that the declarativeNetRequestWithHostAccess permission is in the manifest.',
    );
  }
  return {
    getDynamicRules: () => api.getDynamicRules(),
    updateDynamicRules: (options) => api.updateDynamicRules(options),
    isRegexSupported: (options) => api.isRegexSupported(options),
    supportedResourceTypes: () =>
      api.ResourceType ? Object.values(api.ResourceType) : [...RESOURCE_TYPES],
  };
}

export interface LoadedDocument {
  document: RulesDocument;
  /**
   * Set when the stored document could not be read. The document above is then
   * a fresh default, and the unreadable bytes have been quarantined.
   */
  recoveryError: string | null;
  /** Where the quarantined copy went, when there was one. */
  quarantinedAt: string | null;
}

/**
 * A corrupt record never silently becomes "you have no rules". The bytes are
 * copied aside first — `lib/storage.ts` keeps several generations — and the
 * caller gets an error string it is expected to show the user.
 */
export async function loadDocument(newId: IdFactory = randomId): Promise<LoadedDocument> {
  const result = await rulesDocument.get();

  if (result.ok) {
    return { document: normaliseDocument(result.value, newId), recoveryError: null, quarantinedAt: null };
  }

  const quarantine = await rulesDocument.quarantine(result.error.message);
  return {
    document: createDocument(newId),
    recoveryError: result.error.message,
    quarantinedAt: quarantine.quarantined ? quarantine.key : null,
  };
}

export interface BackupOutcome {
  created: BackupSummary;
  dropped: BackupSummary[];
}

/**
 * Snapshots the stored document, raw envelope included, so a migration that
 * drops a field is still recoverable by hand.
 */
export async function snapshot(
  reason: BackupReason,
  now: number = Date.now(),
  newId: IdFactory = randomId,
): Promise<BackupOutcome | null> {
  const [raw, current] = await Promise.all([rulesDocument.readRaw(), rulesDocument.get()]);
  if (raw === undefined) return null;

  // An unreadable document is already preserved verbatim by `quarantine()`, and
  // a snapshot needs a valid document to restore from.
  if (!current.ok) return null;

  const backup = makeBackup(current.value, reason, now, newId, raw);
  const existing = await rulesBackups.get();
  const { entries, dropped } = addBackup(
    existing.ok ? existing.value.entries : [],
    backup,
    MAX_BACKUPS,
  );
  await rulesBackups.set({ entries });

  return { created: summariseBackup(backup), dropped };
}

export async function listBackups(): Promise<Backup[]> {
  const result = await rulesBackups.get();
  return result.ok ? result.value.entries : [];
}

export type RestoreResult =
  | { ok: true; document: RulesDocument; replacedBy: BackupOutcome | null }
  | { ok: false; error: string };

/**
 * Restores a snapshot — after snapshotting what it is about to replace, so a
 * mistaken restore is itself undoable.
 */
export async function restoreBackup(
  backupId: string,
  now: number = Date.now(),
  newId: IdFactory = randomId,
): Promise<RestoreResult> {
  const backups = await listBackups();
  const backup = backups.find((entry) => entry.id === backupId);
  if (!backup) {
    return { ok: false, error: `Backup "${backupId}" no longer exists.` };
  }

  const replacedBy = await snapshot('before-restore', now, newId);
  const document = normaliseDocument(backup.document, newId);
  await rulesDocument.set(document);
  return { ok: true, document, replacedBy };
}

export interface ImportOptions {
  source: 'modheader' | 'file';
  json: string;
  mode: 'merge' | 'replace';
  /** Sites to put on every imported rule. */
  sites: readonly string[];
}

export type ImportOutcome =
  | { ok: true; report: ImportReport; document: RulesDocument }
  | { ok: false; error: string };

/**
 * Parses, snapshots, then writes — in that order, and the snapshot is not
 * optional. A replacing import is the easiest way for a user to lose work, so
 * "restore the backup from just before the import" has to be a real answer.
 */
export async function importRules(
  options: ImportOptions,
  now: number = Date.now(),
  newId: IdFactory = randomId,
): Promise<ImportOutcome> {
  const parsed =
    options.source === 'modheader'
      ? parseModHeaderExport(options.json, newId, { sites: options.sites })
      : parseOwnExport(options.json, newId, options.sites);

  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Site patterns are refused at the door rather than at the Grant button.
  // `rule.sites` is a bare `z.array(z.string())` in the schema — nothing before
  // this point has any opinion about what an origin looks like — so a file from
  // a colleague can carry `*://*.co.uk/*` into the rule set and only be stopped
  // by `assertOriginIsNarrow()` at the moment the user clicks Grant. Checking
  // the parsed profiles rather than the merged document is deliberate: a merge
  // must be refused for what the incoming file contains, never for a rule the
  // user already had.
  const tooBroad = parsed.profiles.flatMap((profile) =>
    profile.rules.flatMap((rule) =>
      rule.sites
        .map((site) => siteTooBroadReason(site))
        .filter((reason): reason is string => reason !== null),
    ),
  );
  if (tooBroad.length > 0) {
    return { ok: false, error: [...new Set(tooBroad)].join(' ') };
  }

  const current = await loadDocument(newId);
  const imported = parsed.profiles;

  const next: RulesDocument =
    options.mode === 'replace'
      ? { profiles: imported, activeProfileIds: imported.map((profile) => profile.id) }
      : {
          profiles: [...current.document.profiles, ...imported],
          activeProfileIds: [
            ...current.document.activeProfileIds,
            ...imported.map((profile) => profile.id),
          ],
        };

  const problems = validateDocument(next);
  if (problems.length > 0) {
    return {
      ok: false,
      error: `The imported rules could not be merged: ${problems.map((p) => p.message).join(' ')}`,
    };
  }

  await snapshot('before-import', now, newId);
  await rulesDocument.set(next);

  return { ok: true, report: parsed.report, document: next };
}

/** Our own export format, reported with the same shape as a ModHeader import. */
function parseOwnExport(
  raw: string,
  newId: IdFactory,
  sites: readonly string[],
):
  | { ok: true; profiles: Profile[]; report: ImportReport }
  | { ok: false; error: string } {
  const parsed = parseTransferFile(raw);
  if (!parsed.ok) return parsed;

  // Fresh ids on the way in: importing a file exported from this same browser
  // must not collide with the rules already there.
  const profiles = parsed.file.profiles.map((profile) => {
    const clone = cloneProfileWithNewIds(profile, newId);
    return sites.length === 0
      ? clone
      : {
          ...clone,
          rules: clone.rules.map((rule) => ({
            ...rule,
            sites: [...new Set([...rule.sites, ...sites])].sort(),
          })),
        };
  });

  const ruleCount = profiles.reduce((total, profile) => total + profile.rules.length, 0);
  const headerCount = profiles.reduce(
    (total, profile) =>
      total + profile.rules.reduce((sum, rule) => sum + rule.headers.length, 0),
    0,
  );

  return {
    ok: true,
    profiles,
    report: { profileCount: profiles.length, ruleCount, headerCount, notes: [] },
  };
}

/** Serialises profiles for the user to save. `profileIds` empty means all. */
export async function exportRules(
  profileIds: readonly string[],
  now: Date = new Date(),
): Promise<{ json: string; fileName: string }> {
  const loaded = await loadDocument();
  const profiles =
    profileIds.length === 0
      ? loaded.document.profiles
      : loaded.document.profiles.filter((profile) => profileIds.includes(profile.id));

  return {
    json: serialiseTransferFile(buildTransferFile(profiles, now.getTime())),
    fileName: transferFileName(now),
  };
}

export type Verification = { ok: true } | { ok: false; detail: string };

export interface EngineState {
  document: RulesDocument;
  statuses: RuleStatus[];
  grantedOrigins: string[];
  /** How many declarativeNetRequest rules Chrome is holding for us. */
  installedRuleCount: number;
  /** Non-null when the ruleset could not be installed. */
  engineError: string | null;
  /** Result of reading the ruleset back out of Chrome. */
  verification: Verification;
  recoveryError: string | null;
  quarantinedAt: string | null;
}

export interface ApplyOptions {
  backend?: DnrBackend;
  document?: RulesDocument;
  newId?: IdFactory;
}

/**
 * Compiles the document and installs it, replacing the whole ruleset rather than
 * diffing it. `updateDynamicRules` is atomic, so a full replace cannot leave a
 * half-applied ruleset behind — and a diff that drifts is exactly how rules
 * "stop working after an update".
 */
export async function applyRules(options: ApplyOptions = {}): Promise<EngineState> {
  const newId = options.newId ?? randomId;
  const backend = options.backend ?? chromeDnrBackend();

  let document: RulesDocument;
  let recoveryError: string | null = null;
  let quarantinedAt: string | null = null;

  if (options.document) {
    document = options.document;
  } else {
    const loaded = await loadDocument(newId);
    document = loaded.document;
    recoveryError = loaded.recoveryError;
    quarantinedAt = loaded.quarantinedAt;
  }

  const origins = await grantedOrigins();
  const regexSupport = await buildRegexSupport(document, backend);

  const compiled = compileDocument(document, {
    grantedOrigins: origins,
    supportedResourceTypes: backend.supportedResourceTypes(),
    regexSupport,
  });

  const installed = await install(compiled, backend);
  const engineError =
    [compiled.compileError, installed.engineError].filter(Boolean).join(' ') || null;

  return {
    document,
    statuses: withEngineRefusal(compiled.statuses, installed.refused),
    grantedOrigins: origins,
    installedRuleCount: installed.installedRuleCount,
    engineError,
    verification: installed.verification,
    recoveryError,
    quarantinedAt,
  };
}

/**
 * No rule may say it is applying while the browser is refusing the set.
 *
 * The compiler decides what each rule *should* do; whether Chrome accepted the
 * batch is only known afterwards, and `updateDynamicRules` is atomic — one rule
 * it dislikes takes every other rule down with it. A rule still badged "Active"
 * at that moment is the exact failure this product exists to prevent, and it is
 * worse than the incumbent's, because the user is told the opposite of the
 * truth rather than nothing at all.
 *
 * Only `active` is rewritten. A rule already reporting `unsupported` or
 * `needs-permission` was not part of the refused batch and its own reason is
 * still the useful one. The rules keep their `problems` untouched — there is
 * nothing wrong with them — so `components/RuleStatusDetail.tsx` stays quiet and
 * `components/EngineAlerts.tsx` carries the browser's message once, where it
 * belongs, rather than repeating it under every rule.
 *
 * The trigger is `install()`'s own `refused` flag, never the engine error text.
 * Three other things set an engine error and none of them is a refusal of the
 * batch: a failed read of the current rules happens BEFORE the update, so the
 * previously installed set is untouched and still applying; a failed read-back
 * happens after a successful update; and a compiler safeguard error has already
 * downgraded the one rule it concerns while the rest installed normally. Badging
 * every rule "refused" in those three cases would tell the user their headers
 * are parked while Chrome is still sending them — the dangerous direction.
 */
export function withEngineRefusal(
  statuses: readonly RuleStatus[],
  refused: boolean,
): RuleStatus[] {
  if (!refused) return [...statuses];

  return statuses.map((status) =>
    status.state === 'active'
      ? {
          ...status,
          state: 'engine-refused' as const,
          dnrRuleIds: [],
          summary:
            'Not applied: the browser refused this rule set, so your saved rules are not in ' +
            'effect. See the message at the top of this page for what the browser is still doing.',
        }
      : status,
  );
}

interface InstallResult {
  installedRuleCount: number;
  engineError: string | null;
  /**
   * Set only where `updateDynamicRules` itself threw. That call is the single
   * point at which the browser can reject the whole batch, so it is the only
   * thing that may rewrite a rule's status to `engine-refused`.
   */
  refused: boolean;
  verification: Verification;
}

async function install(compiled: CompileResult, backend: DnrBackend): Promise<InstallResult> {
  let existing: DnrRule[];
  try {
    existing = await backend.getDynamicRules();
  } catch (cause) {
    // Nothing was installed and nothing was removed: whatever the browser was
    // already applying is still in force, so the compiled statuses stand.
    return {
      installedRuleCount: 0,
      engineError: `Could not read the browser's current rules: ${describe(cause)}`,
      refused: false,
      verification: { ok: false, detail: 'The browser rule list could not be read.' },
    };
  }

  try {
    await backend.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: compiled.dnrRules,
    });
  } catch (cause) {
    // `updateDynamicRules` is atomic, so a refusal removes nothing — but only
    // when there was something to keep. Saying "the previous rules are still in
    // place" to someone whose first save was refused states the opposite of the
    // truth, and this is a product whose whole claim is that it does not do that.
    return {
      installedRuleCount: existing.length,
      engineError:
        `The browser refused the rule set, so your rules are NOT being applied: ${describe(cause)}. ` +
        (existing.length > 0
          ? `The ${existing.length} rule(s) it was already applying are still in place.`
          : 'No rules are in effect.'),
      refused: true,
      verification: { ok: false, detail: 'updateDynamicRules rejected the rule set.' },
    };
  }

  // Chrome accepting the call is not the same as Chrome keeping the rules.
  let readBack: DnrRule[];
  try {
    readBack = await backend.getDynamicRules();
  } catch (cause) {
    // The update succeeded, so the rules ARE installed — only the confirmation
    // is missing.
    return {
      installedRuleCount: compiled.dnrRules.length,
      engineError: null,
      refused: false,
      verification: {
        ok: false,
        detail: `Rules were installed but could not be read back to confirm: ${describe(cause)}`,
      },
    };
  }

  return {
    installedRuleCount: readBack.length,
    engineError: null,
    refused: false,
    verification: verifyInstalled(compiled.dnrRules, readBack),
  };
}

/** Compares what we asked Chrome for with what Chrome actually kept. */
export function verifyInstalled(expected: readonly DnrRule[], actual: readonly DnrRule[]): Verification {
  const expectedIds = new Set(expected.map((rule) => rule.id));
  const actualIds = new Set(actual.map((rule) => rule.id));

  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpected = [...actualIds].filter((id) => !expectedIds.has(id));

  if (missing.length === 0 && unexpected.length === 0) return { ok: true };

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} rule(s) the browser did not keep (ids ${missing.join(', ')})`);
  }
  if (unexpected.length > 0) {
    parts.push(`${unexpected.length} rule(s) the browser holds that we did not install (ids ${unexpected.join(', ')})`);
  }
  return { ok: false, detail: `${parts.join('; ')}.` };
}

/**
 * Asks Chrome whether each regex is usable, falling back to the static check
 * when the API is unavailable. Chrome is the authority here — RE2's accepted
 * syntax is not something to guess at.
 */
async function buildRegexSupport(
  document: RulesDocument,
  backend: DnrBackend,
): Promise<(pattern: string) => RegexSupport> {
  const patterns = new Set<string>();
  for (const profile of document.profiles) {
    for (const rule of profile.rules) {
      for (const matcher of [...rule.match, ...rule.exclude]) {
        if (matcher.kind === 'regex' && matcher.value.trim() !== '') patterns.add(matcher.value);
      }
    }
  }

  const verdicts = new Map<string, RegexSupport>();
  for (const pattern of patterns) {
    const staticVerdict = checkRegexSupport(pattern);
    if (!staticVerdict.supported) {
      verdicts.set(pattern, staticVerdict);
      continue;
    }
    try {
      const result = await backend.isRegexSupported({ regex: pattern });
      verdicts.set(
        pattern,
        result.isSupported
          ? { supported: true }
          : {
              supported: false,
              reason: `Chrome rejected it${result.reason ? ` (${result.reason})` : ''}.`,
            },
      );
    } catch {
      // The static check already passed; don't block a rule on an API failure.
      verdicts.set(pattern, staticVerdict);
    }
  }

  return (pattern) => verdicts.get(pattern) ?? checkRegexSupport(pattern);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
