import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { DnrRule } from '../lib/dnr';
import type { DnrBackend } from '../lib/rules-engine';
import {
  applyRules,
  exportRules,
  importRules,
  listBackups,
  loadDocument,
  restoreBackup,
  snapshot,
  verifyInstalled,
  withEngineRefusal,
} from '../lib/rules-engine';
import type { HeaderRule, RulesDocument } from '../lib/rules';
import { RESOURCE_TYPES, createDocument, sequentialIds } from '../lib/rules';
import { rulesBackups, rulesDocument } from '../lib/rules-storage';

/**
 * The engine is where storage, the compiler and the browser meet, so this is the
 * file that proves the two guarantees the product is sold on: a rule set that is
 * verified against what Chrome actually kept, and a rule set that cannot vanish.
 */

const DOCUMENT_KEY = 'headers:document';
const GRANTED = ['*://*.api.example.com/*'];

let installed: DnrRule[] = [];
let updateShouldFail: string | null = null;
/** Which `getDynamicRules()` calls throw: the read before the update, the read back after it, or neither. */
let readShouldFail: 'before' | 'after' | null = null;
let reads = 0;
let regexVerdicts: Map<string, boolean>;

function backend(): DnrBackend {
  return {
    getDynamicRules: async () => {
      reads += 1;
      if (readShouldFail === 'before' && reads === 1) throw new Error('storage unavailable');
      if (readShouldFail === 'after' && reads === 2) throw new Error('storage unavailable');
      return installed;
    },
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      if (updateShouldFail) throw new Error(updateShouldFail);
      installed = [...installed.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
    },
    isRegexSupported: async ({ regex }) => ({
      isSupported: regexVerdicts.get(regex) ?? true,
      reason: 'unsupported by RE2',
    }),
    supportedResourceTypes: () => [...RESOURCE_TYPES],
  };
}

const ids = sequentialIds('t');

function ruleFor(host: string, overrides: Partial<HeaderRule> = {}): HeaderRule {
  return {
    id: ids(),
    name: `rule ${host}`,
    enabled: true,
    match: [{ id: ids(), enabled: true, kind: 'domain', value: host }],
    exclude: [],
    sites: [],
    resourceTypes: [...RESOURCE_TYPES],
    requestMethods: [],
    headers: [
      { id: ids(), enabled: true, target: 'request', operation: 'set', name: 'X-Debug', value: '1' },
    ],
    notes: '',
    ...overrides,
  };
}

function documentWith(rules: HeaderRule[]): RulesDocument {
  return { profiles: [{ id: 'p1', name: 'Default', rules }], activeProfileIds: ['p1'] };
}

beforeEach(() => {
  fakeBrowser.reset();
  installed = [];
  updateShouldFail = null;
  readShouldFail = null;
  reads = 0;
  regexVerdicts = new Map();
  vi.restoreAllMocks();
  vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({
    permissions: [],
    origins: GRANTED,
  } as never);
});

describe('loadDocument', () => {
  it('returns the stored rules', async () => {
    const document = documentWith([ruleFor('api.example.com')]);
    await rulesDocument.set(document);

    const loaded = await loadDocument(sequentialIds('n'));

    expect(loaded.recoveryError).toBeNull();
    expect(loaded.document.profiles[0]?.rules).toHaveLength(1);
  });

  it('starts from a usable default when nothing is stored', async () => {
    const loaded = await loadDocument(sequentialIds('n'));

    expect(loaded.recoveryError).toBeNull();
    expect(loaded.document.profiles).toHaveLength(1);
  });

  it('quarantines an unreadable record instead of pretending you had no rules', async () => {
    await fakeBrowser.storage.local.set({ [DOCUMENT_KEY]: 'not an envelope' });

    const loaded = await loadDocument(sequentialIds('n'));

    expect(loaded.recoveryError).toContain('malformed-envelope');
    expect(loaded.quarantinedAt).toBe('headers:document.quarantine.1');

    const preserved = (await fakeBrowser.storage.local.get(loaded.quarantinedAt!))[
      loaded.quarantinedAt!
    ] as { raw: unknown };
    expect(preserved.raw).toBe('not an envelope');
  });

  it('refuses to downgrade a record written by a newer build, and keeps it', async () => {
    await fakeBrowser.storage.local.set({
      [DOCUMENT_KEY]: { version: 99, data: { profiles: [], activeProfileIds: [] } },
    });

    const loaded = await loadDocument(sequentialIds('n'));

    expect(loaded.recoveryError).toContain('version-ahead');
    expect(loaded.quarantinedAt).not.toBeNull();
  });
});

describe('applyRules', () => {
  it('installs the compiled rules and reports them active', async () => {
    const document = documentWith([ruleFor('api.example.com')]);

    const state = await applyRules({ backend: backend(), document });

    expect(state.engineError).toBeNull();
    expect(state.verification.ok).toBe(true);
    expect(state.installedRuleCount).toBe(1);
    expect(state.statuses[0]?.state).toBe('active');
    expect(installed[0]?.action.type).toBe('modifyHeaders');
  });

  it('replaces the previous rule set rather than accumulating', async () => {
    await applyRules({ backend: backend(), document: documentWith([ruleFor('api.example.com')]) });
    await applyRules({ backend: backend(), document: documentWith([ruleFor('api.example.com')]) });

    expect(installed).toHaveLength(1);
  });

  it('removes rules from the browser when the last rule is deleted', async () => {
    await applyRules({ backend: backend(), document: documentWith([ruleFor('api.example.com')]) });
    const state = await applyRules({ backend: backend(), document: documentWith([]) });

    expect(installed).toHaveLength(0);
    expect(state.installedRuleCount).toBe(0);
  });

  it('reports a rule the browser has no permission for, and installs nothing for it', async () => {
    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('other.test')]),
    });

    expect(state.statuses[0]?.state).toBe('needs-permission');
    expect(installed).toHaveLength(0);
  });

  it('says the rules are NOT applied when the browser refuses the rule set', async () => {
    updateShouldFail = 'Rule with id 1 is invalid';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com')]),
    });

    expect(state.engineError).toContain('NOT being applied');
    expect(state.engineError).toContain('Rule with id 1 is invalid');
    expect(state.verification.ok).toBe(false);
  });

  /**
   * The refusal is atomic, so every rule in the batch stops applying. A rule
   * still badged "Active" at that moment tells the user the exact opposite of
   * what the browser is doing — worse than saying nothing, and the failure this
   * whole product is a reaction to. `engineError` alone is not enough: the
   * per-rule badge is what the popup shows.
   */
  it('no rule reports active while the browser is refusing the rule set', async () => {
    updateShouldFail = 'Rule with id 2 must provide a valid header value to be appended/set.';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com'), ruleFor('api.example.com')]),
    });

    expect(state.statuses).toHaveLength(2);
    for (const status of state.statuses) {
      expect(status.state).toBe('engine-refused');
      expect(status.dnrRuleIds).toEqual([]);
      expect(status.summary).toContain('refused');
      // Nothing is wrong with the rules themselves, so they are not blamed.
      expect(status.problems).toEqual([]);
    }
  });

  it('leaves a rule that was never in the batch reporting its own reason', async () => {
    // `needs-permission` is a fact about that rule, and it is more useful than
    // "the browser refused the set" — so only `active` is rewritten.
    updateShouldFail = 'Rule with id 1 is invalid';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([
        ruleFor('api.example.com'),
        ruleFor('elsewhere.example.org', { sites: ['https://elsewhere.example.org/*'] }),
      ]),
    });

    expect(state.statuses[0]?.state).toBe('engine-refused');
    expect(state.statuses[1]?.state).toBe('needs-permission');
  });

  it('does not claim previous rules survive when there were none', async () => {
    // `updateDynamicRules` is atomic, so a refusal really does leave earlier
    // rules in place — but saying so on a first save, when nothing was in place,
    // states the opposite of the truth.
    updateShouldFail = 'Rule with id 1 is invalid';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com')]),
    });

    expect(state.engineError).toContain('No rules are in effect.');
    expect(state.engineError).not.toContain('still in place');
    expect(state.installedRuleCount).toBe(0);
  });

  it('says how many rules survived when the browser was already applying some', async () => {
    installed = [
      { id: 1, priority: 3, action: { type: 'modifyHeaders' }, condition: {} },
      { id: 2, priority: 3, action: { type: 'modifyHeaders' }, condition: {} },
    ];
    updateShouldFail = 'Rule with id 3 is invalid';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com')]),
    });

    expect(state.engineError).toContain('2 rule(s) it was already applying are still in place');
    expect(state.installedRuleCount).toBe(2);
  });

  /**
   * `engine-refused` may only follow an actual refusal by `updateDynamicRules`.
   * Every other engine error leaves rules applying, so rewriting statuses over
   * one would tell the user their headers are parked while Chrome is still
   * sending them — the same lie as a stale "Active", pointing the other way.
   */
  it('keeps the compiled statuses when the current rules could not be read', async () => {
    // The failure is BEFORE the update, so no rule was removed and no rule was
    // added: whatever the browser was already applying is still in force.
    readShouldFail = 'before';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com')]),
    });

    expect(state.engineError).toContain('Could not read');
    expect(state.statuses[0]?.state).toBe('active');
  });

  it('keeps the compiled statuses when only the read-back failed', async () => {
    // The update succeeded, so the rules ARE installed — only the confirmation
    // is missing, and that is what `verification` is for.
    readShouldFail = 'after';

    const state = await applyRules({
      backend: backend(),
      document: documentWith([ruleFor('api.example.com')]),
    });

    expect(state.engineError).toBeNull();
    expect(state.verification.ok).toBe(false);
    expect(state.statuses[0]?.state).toBe('active');
  });

  it('does not badge every rule refused because the compiler withheld one', () => {
    // The compiler's safeguard sets `compileError` while the install itself
    // succeeded, so the surviving rules really are applying. Only the flag
    // `install()` raises in its `updateDynamicRules` catch may rewrite a status.
    const compiled = [
      { ruleId: 'a', profileId: 'p1', state: 'active', summary: 'on', problems: [], warnings: [], dnrRuleIds: [1], missingOrigins: [], requiredOrigins: [] },
    ] as unknown as Parameters<typeof withEngineRefusal>[0];

    expect(withEngineRefusal(compiled, false)[0]?.state).toBe('active');
    expect(withEngineRefusal(compiled, true)[0]?.state).toBe('engine-refused');
  });

  it('defers to the browser when it rejects a regex our static check accepted', async () => {
    regexVerdicts.set('.*/api/.*', false);
    const rule = ruleFor('api.example.com', {
      match: [{ id: ids(), enabled: true, kind: 'regex', value: '.*/api/.*' }],
      sites: GRANTED,
    });

    const state = await applyRules({ backend: backend(), document: documentWith([rule]) });

    expect(state.statuses[0]?.state).toBe('unsupported');
    expect(state.statuses[0]?.problems[0]?.message).toContain('The browser rejected it');
  });

  it('reads the rules back out of the browser and notices a mismatch', async () => {
    const drifting: DnrBackend = {
      ...backend(),
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
    };

    const state = await applyRules({
      backend: drifting,
      document: documentWith([ruleFor('api.example.com')]),
    });

    // Chrome accepting the call is not Chrome keeping the rules.
    expect(state.verification.ok).toBe(false);
    expect(state.verification.ok === false && state.verification.detail).toContain('did not keep');
  });

  it('surfaces an unreadable stored document instead of silently starting empty', async () => {
    await fakeBrowser.storage.local.set({ [DOCUMENT_KEY]: 42 });

    const state = await applyRules({ backend: backend() });

    expect(state.recoveryError).toContain('malformed-envelope');
    expect(state.quarantinedAt).not.toBeNull();
  });
});

describe('verifyInstalled', () => {
  it('passes when the browser kept exactly what we installed', () => {
    const rules = [{ id: 1 }, { id: 2 }] as DnrRule[];
    expect(verifyInstalled(rules, rules)).toEqual({ ok: true });
  });

  it('names the rules the browser dropped', () => {
    const result = verifyInstalled([{ id: 1 }, { id: 2 }] as DnrRule[], [{ id: 1 }] as DnrRule[]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('ids 2');
  });

  it('names rules the browser holds that we did not install', () => {
    const result = verifyInstalled([] as DnrRule[], [{ id: 7 }] as DnrRule[]);

    expect(result.ok === false && result.detail).toContain('ids 7');
  });
});

describe('backups', () => {
  it('takes nothing when there is nothing stored yet', async () => {
    expect(await snapshot('manual', 1)).toBeNull();
  });

  it('snapshots the stored document together with its raw bytes', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));

    const outcome = await snapshot('before-update', 1_700_000_000_000, sequentialIds('b'));

    expect(outcome?.created.reason).toBe('before-update');
    expect(outcome?.created.ruleCount).toBe(1);

    const [stored] = await listBackups();
    expect(stored?.raw).toMatchObject({ version: 1 });
  });

  it('restores a snapshot, and snapshots what it replaced first', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));
    const taken = await snapshot('manual', 1, sequentialIds('b'));

    await rulesDocument.set(documentWith([]));
    const restored = await restoreBackup(taken!.created.id, 2, sequentialIds('c'));

    expect(restored.ok).toBe(true);
    expect(restored.ok && restored.document.profiles[0]?.rules).toHaveLength(1);

    // The state we just replaced is itself recoverable.
    const reasons = (await listBackups()).map((backup) => backup.reason);
    expect(reasons).toContain('before-restore');
  });

  it('refuses to restore a snapshot that no longer exists', async () => {
    const result = await restoreBackup('ghost');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('no longer exists');
  });

  it('survives an unreadable backup list rather than throwing into the UI', async () => {
    await fakeBrowser.storage.local.set({ 'headers:backups': 'rubbish' });

    expect(await listBackups()).toEqual([]);
  });
});

describe('importing', () => {
  const MODHEADER_EXPORT = JSON.stringify([
    {
      title: 'Staging',
      version: 2,
      headers: [{ enabled: true, name: 'Authorization', value: 'Bearer x' }],
      urlFilters: [{ enabled: true, urlRegex: '.*://.*\\.example\\.com/.*' }],
    },
  ]);

  it('imports a ModHeader export and reports what happened', async () => {
    await rulesDocument.set(createDocument(sequentialIds('d')));

    const outcome = await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'merge', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.profileCount).toBe(1);
    expect(outcome.document.profiles.map((profile) => profile.name)).toContain('Staging');
  });

  it('takes a backup BEFORE it changes anything', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));

    await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'replace', sites: [] },
      1,
      sequentialIds('i'),
    );

    const backups = await listBackups();
    expect(backups[0]?.reason).toBe('before-import');
    // The snapshot holds the rules as they were, not as they are now.
    expect(backups[0]?.document.profiles[0]?.rules).toHaveLength(1);
  });

  it('replaces the whole rule set when asked to', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));

    const outcome = await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'replace', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok && outcome.document.profiles).toHaveLength(1);
    expect(outcome.ok && outcome.document.profiles[0]?.name).toBe('Staging');
  });

  it('activates what it imported, so the result is visible immediately', async () => {
    const outcome = await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'merge', sites: [] },
      1,
      sequentialIds('i'),
    );

    if (!outcome.ok) throw new Error('expected a successful import');
    const imported = outcome.document.profiles.find((profile) => profile.name === 'Staging');
    expect(outcome.document.activeProfileIds).toContain(imported?.id);
  });

  it('changes nothing when the file cannot be parsed', async () => {
    const before = documentWith([ruleFor('api.example.com')]);
    await rulesDocument.set(before);

    const outcome = await importRules(
      { source: 'modheader', json: 'nonsense', mode: 'replace', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(false);
    const stored = await rulesDocument.get();
    expect(stored.ok && stored.value).toEqual(before);
    expect(await listBackups()).toEqual([]);
  });

  it('round-trips through our own export format with fresh ids', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));
    const exported = await exportRules([]);

    const outcome = await importRules(
      { source: 'file', json: exported.json, mode: 'merge', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Importing your own export must not collide with the rules already there.
    const ruleIds = outcome.document.profiles.flatMap((profile) =>
      profile.rules.map((rule) => rule.id),
    );
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(outcome.document.profiles).toHaveLength(2);
  });

  /**
   * `rule.sites` is a bare string array in the schema, so a file written by
   * someone else can carry any pattern at all. Left unchecked it reached the
   * Grant button, where `assertOriginIsNarrow()` was the only thing between a
   * shared file and a wildcard over a public suffix — and case alone used to get
   * past that. Refusing at the door means the pattern never enters the rule set.
   */
  it('refuses an imported file naming a site broader than this extension ever requests', async () => {
    const before = documentWith([ruleFor('api.example.com')]);
    await rulesDocument.set(before);

    const hostile = JSON.stringify({
      format: 'privacy-first-header-editor',
      formatVersion: 1,
      exportedAt: 0,
      profiles: [
        {
          id: 'p9',
          name: 'From a colleague',
          rules: [ruleFor('shop.example.co.uk', { sites: ['*://*.CO.UK/*'] })],
        },
      ],
    });

    const outcome = await importRules(
      { source: 'file', json: hostile, mode: 'merge', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('*://*.CO.UK/*');
    expect(outcome.ok === false && outcome.error).toContain('more of the web');

    // Nothing was written and no backup was taken: the file never got in.
    const stored = await rulesDocument.get();
    expect(stored.ok && stored.value).toEqual(before);
    expect(await listBackups()).toEqual([]);
  });

  /**
   * The door check must never fire on a pattern the importer invented. A
   * ModHeader regex naming a public suffix used to be turned into
   * `*://*.github.io/*` by `suggestOriginsFromRegex()` and then refused here —
   * failing the whole file over a pattern the user never wrote and cannot edit
   * from the import screen. The suggestion is filtered at source instead, so the
   * rule arrives with no site access and a note telling the user to name one.
   */
  it('imports a profile whose regex names a public suffix, suggesting no site', async () => {
    const outcome = await importRules(
      {
        source: 'modheader',
        json: JSON.stringify([
          {
            title: 'Pages',
            version: 2,
            headers: [{ enabled: true, name: 'Authorization', value: 'Bearer x' }],
            urlFilters: [{ enabled: true, urlRegex: '.*\\.github\\.io/.*' }],
          },
        ]),
        mode: 'merge',
        sites: [],
      },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const imported = outcome.document.profiles.find((profile) => profile.name === 'Pages');
    expect(imported?.rules[0]?.sites).toEqual([]);
    // Nothing became silent: the user is told to name the sites themselves.
    expect(outcome.report.notes.some((note) => note.message.includes('name the sites'))).toBe(true);
  });

  it('refuses a broad site chosen on the import screen itself', async () => {
    const outcome = await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'merge', sites: ['*://*.github.io/*'] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('*://*.github.io/*');
  });

  it('is refused for what the incoming file holds, never for a rule already stored', async () => {
    // A merge must not be blocked by a pre-existing rule the user cannot see
    // from the import screen — that would be an unfixable dead end.
    await rulesDocument.set(documentWith([ruleFor('api.example.com', { sites: ['*://*.co.uk/*'] })]));

    const outcome = await importRules(
      { source: 'modheader', json: MODHEADER_EXPORT, mode: 'merge', sites: [] },
      1,
      sequentialIds('i'),
    );

    expect(outcome.ok).toBe(true);
  });

  it('exports only the profiles asked for', async () => {
    const document: RulesDocument = {
      profiles: [
        { id: 'p1', name: 'One', rules: [] },
        { id: 'p2', name: 'Two', rules: [] },
      ],
      activeProfileIds: ['p1'],
    };
    await rulesDocument.set(document);

    const exported = await exportRules(['p2']);

    expect(JSON.parse(exported.json).profiles).toHaveLength(1);
    expect(JSON.parse(exported.json).profiles[0].name).toBe('Two');
  });
});

describe('backups clean up after themselves', () => {
  it('never grows past the cap', async () => {
    await rulesDocument.set(documentWith([ruleFor('api.example.com')]));
    const nextId = sequentialIds('b');

    for (let index = 0; index < 20; index++) {
      await snapshot('manual', index, nextId);
    }

    const backups = await rulesBackups.get();
    expect(backups.ok && backups.value.entries.length).toBeLessThanOrEqual(12);
  });
});
