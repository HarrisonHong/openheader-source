/**
 * The header-rule domain model.
 *
 * Schemas, factories and immutable CRUD helpers. Nothing here knows about
 * `chrome.*`, so every operation the UI performs on a rule set is testable
 * without a browser. Compilation to declarativeNetRequest lives in `lib/dnr.ts`;
 * persistence in `lib/rules-storage.ts`.
 */

import './zod-config';
import { z } from 'zod';

/**
 * In Chrome's own order. `webtransport` and `webbundle` exist only on newer
 * Chrome, and Chrome rejects the whole ruleset over an unknown value, so
 * `lib/dnr.ts` filters against what the running browser actually reports.
 */
export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * Everything, deliberately. A default that omits `xmlhttprequest` is the classic
 * "works on page loads, does nothing on fetch" bug and this category's most
 * common one-star complaint.
 */
export const DEFAULT_RESOURCE_TYPES: readonly ResourceType[] = RESOURCE_TYPES;

export const REQUEST_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'connect',
  'other',
] as const;
export type RequestMethod = (typeof REQUEST_METHODS)[number];

/**
 * How a rule decides which requests it applies to.
 *
 * `domain` and `url-prefix` map straight onto declarativeNetRequest conditions.
 * So does `regex`, including in exclusions — which Header Editor Lite's Chrome
 * build structurally cannot do. See docs/architecture.md, "Exclusions".
 */
export const MATCHER_KINDS = [
  'domain',
  'url-prefix',
  'url-contains',
  'url-exact',
  'regex',
] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

export const MATCHER_KIND_LABELS: Record<MatcherKind, string> = {
  domain: 'Domain',
  'url-prefix': 'URL starts with',
  'url-contains': 'URL contains',
  'url-exact': 'URL is exactly',
  regex: 'URL matches regex',
};

export const matcherSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  kind: z.enum(MATCHER_KINDS),
  value: z.string(),
});
export type Matcher = z.infer<typeof matcherSchema>;

export const HEADER_TARGETS = ['request', 'response'] as const;
export type HeaderTarget = (typeof HEADER_TARGETS)[number];

export const HEADER_OPERATIONS = ['set', 'append', 'remove'] as const;
export type HeaderOperation = (typeof HEADER_OPERATIONS)[number];

export const headerEditSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  target: z.enum(HEADER_TARGETS),
  operation: z.enum(HEADER_OPERATIONS),
  name: z.string(),
  value: z.string(),
});
export type HeaderEdit = z.infer<typeof headerEditSchema>;

export const headerRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  /** OR-ed: a request matches the rule when any enabled matcher matches. */
  match: z.array(matcherSchema),
  /** OR-ed: a request is excluded when any enabled matcher matches. */
  exclude: z.array(matcherSchema),
  /**
   * Chrome match patterns naming the sites this rule may touch. These are the
   * only host permissions the extension ever asks for, and they are requested
   * when the rule is saved — never at install.
   */
  sites: z.array(z.string()),
  resourceTypes: z.array(z.enum(RESOURCE_TYPES)),
  /** Empty means "every method". */
  requestMethods: z.array(z.enum(REQUEST_METHODS)),
  headers: z.array(headerEditSchema),
  /** Free-text. Carries imported ModHeader comments so nothing is lost. */
  notes: z.string(),
});
export type HeaderRule = z.infer<typeof headerRuleSchema>;

export const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  rules: z.array(headerRuleSchema),
});
export type Profile = z.infer<typeof profileSchema>;

export const rulesDocumentSchema = z.object({
  profiles: z.array(profileSchema),
  /**
   * Profiles whose rules are currently installed. More than one may be active
   * at a time; the popup's one-click switch collapses the set to a single id.
   */
  activeProfileIds: z.array(z.string()),
});
export type RulesDocument = z.infer<typeof rulesDocumentSchema>;

/** Injectable so tests get deterministic ids and the pure layer never reaches
 * for a global. */
export type IdFactory = () => string;

export const randomId: IdFactory = () => globalThis.crypto.randomUUID();

/** Deterministic ids for tests: `seq('rule')` → `rule-1`, `rule-2`, … */
export function sequentialIds(prefix: string): IdFactory {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export function createMatcher(
  newId: IdFactory,
  kind: MatcherKind = 'domain',
  value = '',
): Matcher {
  return { id: newId(), enabled: true, kind, value };
}

export function createHeaderEdit(
  newId: IdFactory,
  target: HeaderTarget = 'request',
): HeaderEdit {
  return { id: newId(), enabled: true, target, operation: 'set', name: '', value: '' };
}

export function createRule(newId: IdFactory, name = 'New rule'): HeaderRule {
  return {
    id: newId(),
    name,
    enabled: true,
    match: [createMatcher(newId, 'domain', '')],
    exclude: [],
    sites: [],
    resourceTypes: [...DEFAULT_RESOURCE_TYPES],
    requestMethods: [],
    headers: [createHeaderEdit(newId, 'request')],
    notes: '',
  };
}

export function createProfile(newId: IdFactory, name = 'Default'): Profile {
  return { id: newId(), name, rules: [] };
}

/**
 * What a first-run user gets: one empty profile, active. Starting with zero
 * profiles would make "create a profile" a mandatory first step before you can
 * create a rule.
 */
export function createDocument(newId: IdFactory = randomId): RulesDocument {
  const profile = createProfile(newId, 'Default');
  return { profiles: [profile], activeProfileIds: [profile.id] };
}

// Every helper below returns a new document. The UI edits a local copy and saves
// it in one message, so a half-applied edit cannot be persisted.

export function findProfile(document: RulesDocument, profileId: string): Profile | undefined {
  return document.profiles.find((profile) => profile.id === profileId);
}

export function findRule(
  document: RulesDocument,
  ruleId: string,
): { profile: Profile; rule: HeaderRule } | undefined {
  for (const profile of document.profiles) {
    const rule = profile.rules.find((candidate) => candidate.id === ruleId);
    if (rule) return { profile, rule };
  }
  return undefined;
}

export function addProfile(document: RulesDocument, profile: Profile): RulesDocument {
  return { ...document, profiles: [...document.profiles, profile] };
}

export function updateProfile(
  document: RulesDocument,
  profileId: string,
  updater: (profile: Profile) => Profile,
): RulesDocument {
  return {
    ...document,
    profiles: document.profiles.map((profile) =>
      profile.id === profileId ? updater(profile) : profile,
    ),
  };
}

export function renameProfile(
  document: RulesDocument,
  profileId: string,
  name: string,
): RulesDocument {
  return updateProfile(document, profileId, (profile) => ({ ...profile, name }));
}

/**
 * Removes a profile and drops it from the active set.
 *
 * Refuses to remove the last profile: a document with no profiles has nowhere
 * to put a rule, and silently recreating one would discard the user's rules
 * without saying so.
 */
export function removeProfile(document: RulesDocument, profileId: string): RulesDocument {
  if (document.profiles.length <= 1) return document;
  return {
    profiles: document.profiles.filter((profile) => profile.id !== profileId),
    activeProfileIds: document.activeProfileIds.filter((id) => id !== profileId),
  };
}

export function duplicateProfile(
  document: RulesDocument,
  profileId: string,
  newId: IdFactory,
): RulesDocument {
  const source = findProfile(document, profileId);
  if (!source) return document;
  return addProfile(document, {
    ...cloneProfileWithNewIds(source, newId),
    name: `${source.name} copy`,
  });
}

export function cloneProfileWithNewIds(profile: Profile, newId: IdFactory): Profile {
  return {
    id: newId(),
    name: profile.name,
    rules: profile.rules.map((rule) => cloneRuleWithNewIds(rule, newId)),
  };
}

export function cloneRuleWithNewIds(rule: HeaderRule, newId: IdFactory): HeaderRule {
  return {
    ...rule,
    id: newId(),
    match: rule.match.map((matcher) => ({ ...matcher, id: newId() })),
    exclude: rule.exclude.map((matcher) => ({ ...matcher, id: newId() })),
    headers: rule.headers.map((header) => ({ ...header, id: newId() })),
    sites: [...rule.sites],
    resourceTypes: [...rule.resourceTypes],
    requestMethods: [...rule.requestMethods],
  };
}

/** One-click switch: exactly this profile is active. */
export function switchToProfile(document: RulesDocument, profileId: string): RulesDocument {
  if (!findProfile(document, profileId)) return document;
  return { ...document, activeProfileIds: [profileId] };
}

export function setProfileActive(
  document: RulesDocument,
  profileId: string,
  active: boolean,
): RulesDocument {
  if (!findProfile(document, profileId)) return document;
  const without = document.activeProfileIds.filter((id) => id !== profileId);
  return { ...document, activeProfileIds: active ? [...without, profileId] : without };
}

export function isProfileActive(document: RulesDocument, profileId: string): boolean {
  return document.activeProfileIds.includes(profileId);
}

export function addRule(
  document: RulesDocument,
  profileId: string,
  rule: HeaderRule,
): RulesDocument {
  return updateProfile(document, profileId, (profile) => ({
    ...profile,
    rules: [...profile.rules, rule],
  }));
}

export function updateRule(
  document: RulesDocument,
  ruleId: string,
  updater: (rule: HeaderRule) => HeaderRule,
): RulesDocument {
  return {
    ...document,
    profiles: document.profiles.map((profile) => ({
      ...profile,
      rules: profile.rules.map((rule) => (rule.id === ruleId ? updater(rule) : rule)),
    })),
  };
}

export function removeRule(document: RulesDocument, ruleId: string): RulesDocument {
  return {
    ...document,
    profiles: document.profiles.map((profile) => ({
      ...profile,
      rules: profile.rules.filter((rule) => rule.id !== ruleId),
    })),
  };
}

/** Moves a rule within its profile. `delta` is clamped, so callers cannot throw. */
export function moveRule(document: RulesDocument, ruleId: string, delta: number): RulesDocument {
  return {
    ...document,
    profiles: document.profiles.map((profile) => {
      const index = profile.rules.findIndex((rule) => rule.id === ruleId);
      if (index === -1) return profile;
      const target = Math.min(Math.max(index + delta, 0), profile.rules.length - 1);
      if (target === index) return profile;
      const rules = [...profile.rules];
      const [moved] = rules.splice(index, 1);
      if (!moved) return profile;
      rules.splice(target, 0, moved);
      return { ...profile, rules };
    }),
  };
}

export function setRuleEnabled(
  document: RulesDocument,
  ruleId: string,
  enabled: boolean,
): RulesDocument {
  return updateRule(document, ruleId, (rule) => ({ ...rule, enabled }));
}

/** Rules that are candidates for installation: enabled, in an active profile. */
export function activeRules(
  document: RulesDocument,
): ReadonlyArray<{ profile: Profile; rule: HeaderRule }> {
  return document.profiles
    .filter((profile) => document.activeProfileIds.includes(profile.id))
    .flatMap((profile) => profile.rules.map((rule) => ({ profile, rule })));
}

export function countRules(document: RulesDocument): number {
  return document.profiles.reduce((total, profile) => total + profile.rules.length, 0);
}

export interface DocumentProblem {
  code: 'duplicate-profile-id' | 'duplicate-rule-id' | 'unknown-active-profile' | 'no-profiles';
  message: string;
}

/**
 * Structural checks Zod cannot express. Imported and restored documents go
 * through this before they are written: a duplicate id would make a later edit
 * silently modify the wrong rule.
 */
export function validateDocument(document: RulesDocument): DocumentProblem[] {
  const problems: DocumentProblem[] = [];

  if (document.profiles.length === 0) {
    problems.push({ code: 'no-profiles', message: 'The rule set contains no profiles.' });
  }

  const profileIds = new Set<string>();
  const ruleIds = new Set<string>();
  for (const profile of document.profiles) {
    if (profileIds.has(profile.id)) {
      problems.push({
        code: 'duplicate-profile-id',
        message: `Two profiles share the id "${profile.id}".`,
      });
    }
    profileIds.add(profile.id);

    for (const rule of profile.rules) {
      if (ruleIds.has(rule.id)) {
        problems.push({
          code: 'duplicate-rule-id',
          message: `Two rules share the id "${rule.id}" (in profile "${profile.name}").`,
        });
      }
      ruleIds.add(rule.id);
    }
  }

  for (const id of document.activeProfileIds) {
    if (!profileIds.has(id)) {
      problems.push({
        code: 'unknown-active-profile',
        message: `Active profile "${id}" does not exist in this rule set.`,
      });
    }
  }

  return problems;
}

/**
 * Repairs the two faults that can be repaired without guessing: an active id
 * pointing at nothing, and an empty profile list. Duplicate ids are left alone —
 * they mean a caller merged two documents wrongly, and renumbering would hide
 * that.
 */
export function normaliseDocument(
  document: RulesDocument,
  newId: IdFactory = randomId,
): RulesDocument {
  const profiles = document.profiles.length > 0 ? document.profiles : [createProfile(newId)];
  const known = new Set(profiles.map((profile) => profile.id));
  const active = document.activeProfileIds.filter((id) => known.has(id));
  const firstProfile = profiles[0];
  return {
    profiles,
    activeProfileIds: active.length > 0 || !firstProfile ? active : [firstProfile.id],
  };
}
