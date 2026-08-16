import { describe, expect, it } from 'vitest';
import {
  addProfile,
  addRule,
  cloneRuleWithNewIds,
  countRules,
  createDocument,
  createProfile,
  createRule,
  duplicateProfile,
  findRule,
  isProfileActive,
  moveRule,
  normaliseDocument,
  removeProfile,
  removeRule,
  renameProfile,
  sequentialIds,
  setProfileActive,
  setRuleEnabled,
  switchToProfile,
  validateDocument,
  activeRules,
} from './rules';
import type { RulesDocument } from './rules';

function seeded(): { document: RulesDocument; newId: () => string } {
  const newId = sequentialIds('id');
  const document = createDocument(newId);
  return { document, newId };
}

describe('document factory', () => {
  it('starts with one profile, active, so a rule has somewhere to live', () => {
    const { document } = seeded();

    expect(document.profiles).toHaveLength(1);
    expect(document.activeProfileIds).toEqual([document.profiles[0]?.id]);
    expect(countRules(document)).toBe(0);
  });

  it('puts every request type — including xmlhttprequest — on a new rule', () => {
    const rule = createRule(sequentialIds('r'));

    // A default that omits xmlhttprequest is the classic "works on the page,
    // does nothing on fetch" bug this product cannot afford.
    expect(rule.resourceTypes).toContain('xmlhttprequest');
    expect(rule.resourceTypes).toContain('main_frame');
  });
});

describe('rule CRUD', () => {
  it('adds, finds, updates and removes a rule', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const profileId = document.profiles[0]!.id;
    const rule = createRule(newId, 'Auth');

    document = addRule(document, profileId, rule);
    expect(countRules(document)).toBe(1);
    expect(findRule(document, rule.id)?.rule.name).toBe('Auth');

    document = setRuleEnabled(document, rule.id, false);
    expect(findRule(document, rule.id)?.rule.enabled).toBe(false);

    document = removeRule(document, rule.id);
    expect(findRule(document, rule.id)).toBeUndefined();
    expect(countRules(document)).toBe(0);
  });

  it('never mutates the document it was given', () => {
    const newId = sequentialIds('id');
    const document = createDocument(newId);
    const before = structuredClone(document);

    addRule(document, document.profiles[0]!.id, createRule(newId));

    expect(document).toEqual(before);
  });

  it('reorders rules and clamps a move past either end', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const profileId = document.profiles[0]!.id;
    const first = createRule(newId, 'first');
    const second = createRule(newId, 'second');
    document = addRule(addRule(document, profileId, first), profileId, second);

    document = moveRule(document, second.id, -1);
    expect(document.profiles[0]?.rules.map((rule) => rule.name)).toEqual(['second', 'first']);

    document = moveRule(document, second.id, -5);
    expect(document.profiles[0]?.rules.map((rule) => rule.name)).toEqual(['second', 'first']);

    document = moveRule(document, second.id, 9);
    expect(document.profiles[0]?.rules.map((rule) => rule.name)).toEqual(['first', 'second']);
  });

  it('ignores a move for a rule that does not exist', () => {
    const { document } = seeded();
    expect(moveRule(document, 'nope', 1)).toEqual(document);
  });
});

describe('profiles', () => {
  it('switches to exactly one profile in one click', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const staging = createProfile(newId, 'Staging');
    document = addProfile(document, staging);
    document = setProfileActive(document, staging.id, true);

    expect(document.activeProfileIds).toHaveLength(2);

    document = switchToProfile(document, staging.id);
    expect(document.activeProfileIds).toEqual([staging.id]);
    expect(isProfileActive(document, staging.id)).toBe(true);
  });

  it('supports more than one active profile at a time', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const staging = createProfile(newId, 'Staging');
    document = setProfileActive(addProfile(document, staging), staging.id, true);

    expect(document.activeProfileIds).toHaveLength(2);

    document = setProfileActive(document, staging.id, false);
    expect(document.activeProfileIds).not.toContain(staging.id);
  });

  it('refuses to delete the last profile', () => {
    const { document } = seeded();
    expect(removeProfile(document, document.profiles[0]!.id)).toEqual(document);
  });

  it('drops a deleted profile from the active set', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const staging = createProfile(newId, 'Staging');
    document = setProfileActive(addProfile(document, staging), staging.id, true);

    document = removeProfile(document, staging.id);

    expect(document.profiles).toHaveLength(1);
    expect(document.activeProfileIds).not.toContain(staging.id);
  });

  it('renames a profile', () => {
    const { document } = seeded();
    const renamed = renameProfile(document, document.profiles[0]!.id, 'Production');
    expect(renamed.profiles[0]?.name).toBe('Production');
  });

  it('duplicates a profile with fresh ids so edits cannot cross over', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const profileId = document.profiles[0]!.id;
    document = addRule(document, profileId, createRule(newId, 'Auth'));

    document = duplicateProfile(document, profileId, newId);

    const [original, copy] = document.profiles;
    expect(copy?.name).toBe('Default copy');
    expect(copy?.id).not.toBe(original?.id);
    expect(copy?.rules[0]?.id).not.toBe(original?.rules[0]?.id);
    expect(copy?.rules[0]?.headers[0]?.id).not.toBe(original?.rules[0]?.headers[0]?.id);
    expect(validateDocument(document)).toEqual([]);
  });

  it('lists only the rules of active profiles', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const staging = createProfile(newId, 'Staging');
    document = addProfile(document, staging);
    document = addRule(document, document.profiles[0]!.id, createRule(newId, 'live'));
    document = addRule(document, staging.id, createRule(newId, 'staged'));

    expect(activeRules(document).map((entry) => entry.rule.name)).toEqual(['live']);
  });
});

describe('cloneRuleWithNewIds', () => {
  it('renews every nested id', () => {
    const newId = sequentialIds('id');
    const rule = createRule(newId, 'Auth');
    rule.exclude = [{ id: newId(), enabled: true, kind: 'domain', value: 'health.example.com' }];

    const clone = cloneRuleWithNewIds(rule, sequentialIds('clone'));

    expect(clone.id).not.toBe(rule.id);
    expect(clone.match[0]?.id).not.toBe(rule.match[0]?.id);
    expect(clone.exclude[0]?.id).not.toBe(rule.exclude[0]?.id);
    expect(clone.headers[0]?.id).not.toBe(rule.headers[0]?.id);
    expect(clone.match[0]?.value).toBe(rule.match[0]?.value);
  });
});

describe('validateDocument', () => {
  it('accepts a well-formed document', () => {
    expect(validateDocument(createDocument(sequentialIds('id')))).toEqual([]);
  });

  it('reports duplicate rule ids rather than letting an edit hit the wrong rule', () => {
    const newId = sequentialIds('id');
    let document = createDocument(newId);
    const rule = createRule(newId, 'Auth');
    document = addRule(addRule(document, document.profiles[0]!.id, rule), document.profiles[0]!.id, rule);

    expect(validateDocument(document).map((problem) => problem.code)).toContain('duplicate-rule-id');
  });

  it('reports duplicate profile ids', () => {
    const newId = sequentialIds('id');
    const document = createDocument(newId);
    const doubled = addProfile(document, document.profiles[0]!);

    expect(validateDocument(doubled).map((problem) => problem.code)).toContain(
      'duplicate-profile-id',
    );
  });

  it('reports an active profile that does not exist', () => {
    const document = { ...createDocument(sequentialIds('id')), activeProfileIds: ['ghost'] };

    expect(validateDocument(document).map((problem) => problem.code)).toContain(
      'unknown-active-profile',
    );
  });

  it('reports an empty document', () => {
    expect(validateDocument({ profiles: [], activeProfileIds: [] }).map((p) => p.code)).toContain(
      'no-profiles',
    );
  });
});

describe('normaliseDocument', () => {
  it('drops active ids that point at nothing', () => {
    const document = { ...createDocument(sequentialIds('id')), activeProfileIds: ['ghost'] };
    const normalised = normaliseDocument(document, sequentialIds('new'));

    expect(normalised.activeProfileIds).toEqual([normalised.profiles[0]?.id]);
  });

  it('creates a profile when there are none, rather than leaving nowhere to save a rule', () => {
    const normalised = normaliseDocument(
      { profiles: [], activeProfileIds: [] },
      sequentialIds('new'),
    );

    expect(normalised.profiles).toHaveLength(1);
    expect(normalised.activeProfileIds).toEqual([normalised.profiles[0]?.id]);
  });

  it('leaves duplicate ids alone — silently renumbering them would hide a bad merge', () => {
    const newId = sequentialIds('id');
    const document = createDocument(newId);
    const doubled = addProfile(document, document.profiles[0]!);

    expect(normaliseDocument(doubled, newId).profiles).toHaveLength(2);
    expect(validateDocument(normaliseDocument(doubled, newId))).not.toEqual([]);
  });
});
