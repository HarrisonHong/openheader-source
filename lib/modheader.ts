/**
 * ModHeader export import.
 *
 * The schema here is documented, not guessed. ModHeader's own export routine was
 * read from `requestly/modheader-export-backup` (`src/modheader-format.mjs`), a
 * line-by-line port of ModHeader 7.0.18's `exportProfileHook`, cross-checked
 * against Requestly's shipped importer
 * (`requestly/interceptor`, `app/src/modules/rule-adapters/modheader-rule-adapters/
 * parseRulesFromModheader.ts`) and against two real exports found in the wild.
 * See docs/modheader-import.md for the field-by-field table and the URLs.
 *
 * The file is a bare JSON array of profiles, in one of two shapes. v2
 * (`version: 2`) puts `appendMode`/`sendEmptyHeader` on each header and splits
 * filters into `urlFilters`, `excludeUrlFilters`, `resourceFilters` and friends.
 * v1 has no `version` field: those settings sit on the profile and the filters
 * are one tagged array. ModHeader upgraded v1 in place on load, so exports of
 * long-lived profiles are still v1 in the wild — the sample we verified against
 * is one — and `upgradeProfile()` below reproduces that upgrade.
 *
 * Nothing is dropped silently: every field we cannot represent produces a note
 * in the report, and anything imported on a best-effort reading arrives turned
 * off with a note saying why.
 */

import './zod-config';
import { z } from 'zod';
import type {
  HeaderEdit,
  IdFactory,
  Matcher,
  Profile,
  RequestMethod,
  ResourceType,
} from './rules';
import { REQUEST_METHODS, RESOURCE_TYPES } from './rules';
import { assertOriginIsNarrow } from './permissions';

/** Zod-backed because the report crosses the service-worker boundary. */
export const importNoteSchema = z.object({
  level: z.enum(['info', 'warning']),
  /** Profile the note belongs to, when it is profile-specific. */
  profile: z.string().optional(),
  message: z.string(),
});
export type ImportNote = z.infer<typeof importNoteSchema>;
export type NoteLevel = ImportNote['level'];

export const importReportSchema = z.object({
  profileCount: z.number().int().nonnegative(),
  ruleCount: z.number().int().nonnegative(),
  headerCount: z.number().int().nonnegative(),
  notes: z.array(importNoteSchema),
});
export type ImportReport = z.infer<typeof importReportSchema>;

export type ModHeaderImport =
  | { ok: true; profiles: Profile[]; report: ImportReport }
  | { ok: false; error: string };

export interface ModHeaderImportOptions {
  /**
   * Sites to put on every imported rule. ModHeader held blanket access to every
   * site; this extension never does, so the import screen asks for the sites the
   * rules should apply to and passes them here.
   */
  sites?: readonly string[];
}

/** Every list field ModHeader can write, in its own order. */
const LIST_FIELDS = [
  'headers',
  'respHeaders',
  'urlReplacements',
  'cookieHeaders',
  'setCookieHeaders',
  'cspHeaders',
  'reqCookieAppend',
  'urlFilters',
  'initiatorDomainFilters',
  'excludeUrlFilters',
  'resourceFilters',
  'tabFilters',
  'tabGroupFilters',
  'windowFilters',
  'timeFilters',
  'excludeRequestDomainFilters',
  'requestMethodFilters',
] as const;

/**
 * Longest `urlRegex` this importer will accept, and the longest slice of one it
 * will scan for host names.
 *
 * An import is a file someone else wrote, parsed inside the MV3 service worker,
 * which serves no messages while it is busy — so the work it can be made to do
 * has to be bounded by the input, not by trust. Chrome's own
 * `declarativeNetRequest` regex budget is well under 2 KB, so a pattern longer
 * than this could not have matched anything in ModHeader either.
 */
const MAX_URL_REGEX_LENGTH = 2000;

type Json = Record<string, unknown>;

/**
 * Recognises a ModHeader export without relying on a version field — v1
 * profiles have none. Mirrors `looksLikeModHeaderProfiles` in ModHeader's own
 * export tooling.
 */
export function looksLikeModHeaderExport(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (profile) =>
        isObject(profile) &&
        typeof profile.title === 'string' &&
        LIST_FIELDS.some((field) => Array.isArray(profile[field])),
    )
  );
}

export function parseModHeaderExport(
  raw: string,
  newId: IdFactory,
  options: ModHeaderImportOptions = {},
): ModHeaderImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      error: `That file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        'A ModHeader export is a JSON array of profiles. This file contains ' +
        `${describeJson(parsed)} instead. Export from ModHeader with Export → Download JSON.`,
    };
  }

  if (parsed.length === 0) {
    return { ok: false, error: 'That ModHeader export contains no profiles.' };
  }

  if (!looksLikeModHeaderExport(parsed)) {
    return {
      ok: false,
      error:
        'That file does not look like a ModHeader export: every profile should have a "title" and ' +
        'at least one list of headers or filters.',
    };
  }

  const notes: ImportNote[] = [];
  const profiles: Profile[] = [];
  let ruleCount = 0;
  let headerCount = 0;

  parsed.forEach((entry, index) => {
    if (!isObject(entry)) {
      notes.push({
        level: 'warning',
        message: `Profile ${index + 1} was skipped: it is ${describeJson(entry)}, not an object.`,
      });
      return;
    }

    const profile = convertProfile(entry, index, newId, notes, options);
    profiles.push(profile);
    ruleCount += profile.rules.length;
    headerCount += profile.rules.reduce((total, rule) => total + rule.headers.length, 0);
  });

  if (profiles.length === 0) {
    return { ok: false, error: 'None of the profiles in that export could be read.' };
  }

  return {
    ok: true,
    profiles,
    report: { profileCount: profiles.length, ruleCount, headerCount, notes },
  };
}

/**
 * Reproduces ModHeader's own `upgradeProfile`. v1 stored one `appendMode` and
 * one `sendEmptyHeader` for the whole profile plus a single tagged `filters`
 * array; v2 moves them onto individual headers and splits the filters by kind.
 */
export function upgradeProfile(profile: Json, index: number): Json {
  if (profile.version) return profile;

  const upgraded: Json = { ...profile, version: 2 };
  if (typeof upgraded.title !== 'string' || upgraded.title === '') {
    upgraded.title = `Profile ${index + 1}`;
  }

  const rawAppend = profile.appendMode;
  const appendMode =
    rawAppend === 'comma' ? 'comma' : rawAppend === true || rawAppend === 'true' ? 'append' : undefined;
  delete upgraded.appendMode;

  const sendEmptyHeader = Boolean(profile.sendEmptyHeader);
  delete upgraded.sendEmptyHeader;

  for (const field of ['headers', 'respHeaders'] as const) {
    const list = asArray(profile[field]);
    upgraded[field] = list.map((header) => {
      if (!isObject(header)) return header;
      const next: Json = { ...header, appendMode };
      if (sendEmptyHeader) next.sendEmptyHeader = true;
      return next;
    });
  }

  const urlFilters: unknown[] = [];
  const excludeUrlFilters: unknown[] = [];
  const resourceFilters: unknown[] = [];
  for (const filter of asArray(profile.filters)) {
    if (!isObject(filter)) continue;
    const { type, ...rest } = filter;
    if (type === 'urls') urlFilters.push(rest);
    else if (type === 'excludeUrls') excludeUrlFilters.push(rest);
    else if (type === 'types') resourceFilters.push(rest);
  }
  upgraded.urlFilters = urlFilters;
  upgraded.excludeUrlFilters = excludeUrlFilters;
  upgraded.resourceFilters = resourceFilters;
  delete upgraded.filters;

  return upgraded;
}

function convertProfile(
  raw: Json,
  index: number,
  newId: IdFactory,
  notes: ImportNote[],
  options: ModHeaderImportOptions,
): Profile {
  const profile = upgradeProfile(raw, index);
  const title = typeof profile.title === 'string' && profile.title ? profile.title : `Profile ${index + 1}`;
  const note = (level: NoteLevel, message: string): void => {
    notes.push({ level, profile: title, message });
  };

  if (raw.version === undefined) {
    note(
      'info',
      'This profile was saved by an older ModHeader, so its per-profile append and filter settings ' +
        'were upgraded the same way ModHeader itself would have.',
    );
  }

  const headers: HeaderEdit[] = [];
  headers.push(...convertHeaders(profile.headers, 'request', newId, note));
  headers.push(...convertHeaders(profile.respHeaders, 'response', newId, note));
  headers.push(...convertCsp(profile, newId, note));
  headers.push(...convertCookies(profile, newId, note));

  const matchFilters = convertUrlFilters(profile.urlFilters, newId, note, 'match');
  const excludeFilters = convertUrlFilters(profile.excludeUrlFilters, newId, note, 'exclude');
  const match = matchFilters.matchers;
  const exclude = [
    ...excludeFilters.matchers,
    ...convertDomainFilters(profile.excludeRequestDomainFilters, newId, note),
  ];

  const resourceTypes = convertResourceFilters(profile.resourceFilters, note);
  const requestMethods = convertMethodFilters(profile.requestMethodFilters, note);

  reportUnsupported(profile, note);

  const suggested = match.flatMap((matcher) =>
    matcher.kind === 'regex' ? suggestOriginsFromRegex(matcher.value) : [],
  );
  const sites = [...new Set([...(options.sites ?? []), ...suggested])].sort();

  if (match.length === 0) {
    note(
      'warning',
      'ModHeader applied this profile to every site. This extension never asks for access to every ' +
        'site, so the imported rule has no site access yet — open it and name the sites it should ' +
        'apply to.',
    );
  } else if (suggested.length > 0 && (options.sites ?? []).length === 0) {
    note(
      'info',
      `Site access was suggested from the URL filters (${suggested.join(', ')}). Check it before ` +
        'granting access.',
    );
  } else if (suggested.length === 0 && (options.sites ?? []).length === 0) {
    note(
      'warning',
      'No site access could be worked out from this profile\'s URL filters — they named no host, ' +
        'or named one this extension will never ask for access to, such as a whole public suffix ' +
        'like github.io. Open the imported rule and name the sites it should apply to.',
    );
  }

  if (headers.length === 0) {
    note('warning', 'This profile contained no headers, so its rule changes nothing yet.');
  }

  // Dropping a *match* filter can only narrow a rule. Dropping an *exclusion*
  // widens it — the rule would apply to requests the original profile kept it
  // away from — so the rule arrives turned off rather than quietly doing more
  // than the file asked for. Same treatment the cookie fields get above.
  const excludeWasDropped = excludeFilters.dropped > 0;
  if (excludeWasDropped) {
    note(
      'warning',
      'An exclusion was skipped, which would leave this rule applying more widely than the ' +
        'profile it came from. The rule was imported TURNED OFF — read it, restore the ' +
        'exclusion you need, then turn it on.',
    );
  }

  const rules =
    headers.length === 0 && match.length === 0
      ? []
      : [
          {
            id: newId(),
            name: title,
            enabled: !excludeWasDropped,
            match,
            exclude,
            sites,
            resourceTypes,
            requestMethods,
            headers,
            notes: 'Imported from ModHeader.',
          },
        ];

  return { id: newId(), name: title, rules };
}

/**
 * `appendMode`/`sendEmptyHeader` follow the only shipped reading of these fields
 * we could verify, Requestly's importer: non-appending and flagged to send when
 * empty means removal, an append mode means append, everything else replaces.
 */
function convertHeaders(
  value: unknown,
  target: 'request' | 'response',
  newId: IdFactory,
  note: (level: NoteLevel, message: string) => void,
): HeaderEdit[] {
  const result: HeaderEdit[] = [];

  for (const entry of asArray(value)) {
    if (!isObject(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const headerValue = typeof entry.value === 'string' ? entry.value : '';
    if (name.trim() === '' && headerValue.trim() === '') continue;

    const appendMode = entry.appendMode;
    const appends = appendMode === 'append' || appendMode === 'comma' || appendMode === true;
    const removes = !appends && Boolean(entry.sendEmptyHeader);

    if (appendMode === 'comma') {
      note(
        'info',
        `"${name}" used ModHeader's comma-separated append. Chrome appends with its own separator ` +
          'for this header, which is a comma for everything except Cookie.',
      );
    }

    result.push({
      id: newId(),
      enabled: entry.enabled !== false,
      target,
      operation: removes ? 'remove' : appends ? 'append' : 'set',
      name,
      value: removes ? '' : headerValue,
    });
  }

  return result;
}

/** `cspDirectives` (Requestly's name) and `cspHeaders` (ModHeader's) are the same list. */
function convertCsp(
  profile: Json,
  newId: IdFactory,
  note: (level: NoteLevel, message: string) => void,
): HeaderEdit[] {
  const directives = [...asArray(profile.cspHeaders), ...asArray(profile.cspDirectives)]
    .filter(isObject)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => `${String(entry.name ?? '')} ${String(entry.value ?? '')}`.trim())
    .filter((entry) => entry !== '');

  if (directives.length === 0) return [];

  note(
    'info',
    `${directives.length} Content-Security-Policy directive(s) were combined into a single ` +
      'Content-Security-Policy response header.',
  );

  return [
    {
      id: newId(),
      enabled: true,
      target: 'response',
      operation: 'set',
      name: 'Content-Security-Policy',
      value: directives.join('; '),
    },
  ];
}

/**
 * `reqCookieAppend` is the MV3 shape and maps cleanly onto appending to the
 * `Cookie` request header. `cookieHeaders` / `setCookieHeaders` are the older
 * modifiers, and we could not verify their semantics against any shipped
 * implementation — so they come in turned off. Dropping them silently would be
 * worse; enabling a guessed cookie rewrite could break a live session with no
 * clue why.
 */
function convertCookies(
  profile: Json,
  newId: IdFactory,
  note: (level: NoteLevel, message: string) => void,
): HeaderEdit[] {
  const result: HeaderEdit[] = [];

  const appended = asArray(profile.reqCookieAppend)
    .filter(isObject)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => `${String(entry.name ?? '')}=${String(entry.value ?? '')}`)
    .filter((entry) => entry !== '=');

  if (appended.length > 0) {
    result.push({
      id: newId(),
      enabled: true,
      target: 'request',
      operation: 'append',
      name: 'Cookie',
      value: appended.join('; '),
    });
    note('info', `${appended.length} cookie(s) were imported as an append to the Cookie header.`);
  }

  const unverified: Array<[string, 'request' | 'response', string]> = [
    ['cookieHeaders', 'request', 'Cookie'],
    ['setCookieHeaders', 'response', 'Set-Cookie'],
  ];

  for (const [field, target, header] of unverified) {
    const entries = asArray(profile[field])
      .filter(isObject)
      .filter((entry) => entry.enabled !== false);
    if (entries.length === 0) continue;

    result.push({
      id: newId(),
      enabled: false,
      target,
      operation: 'append',
      name: header,
      value: entries
        .map((entry) => `${String(entry.name ?? '')}=${String(entry.value ?? '')}`)
        .join('; '),
    });
    note(
      'warning',
      `ModHeader's "${field}" list was imported as a ${header} header but left TURNED OFF: its exact ` +
        'behaviour could not be verified, and a wrong cookie rewrite can break a signed-in session. ' +
        'Check the value, then turn it on.',
    );
  }

  return result;
}

/** ModHeader URL filters are regular expressions, matched against the whole URL. */
function convertUrlFilters(
  value: unknown,
  newId: IdFactory,
  note: (level: NoteLevel, message: string) => void,
  kind: 'match' | 'exclude',
): { matchers: Matcher[]; dropped: number } {
  const matchers: Matcher[] = [];
  let dropped = 0;

  // Every filter this function does not keep is counted, not just the oversize
  // one: `convertProfile` reads the count to decide whether a rule may arrive
  // switched on, and a *skipped exclusion* widens the rule whatever the reason
  // it was skipped. A field holding something other than a list is the same
  // loss as an entry inside one, so it is reported here rather than vanishing
  // into `asArray()`.
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    dropped++;
    note(
      'warning',
      `The ${kind} URL filters were skipped: the file holds ${describeJson(value)} where a list ` +
        'of filters belongs.',
    );
    return { matchers, dropped };
  }

  for (const entry of asArray(value)) {
    if (!isObject(entry)) {
      dropped++;
      note('warning', `A ${kind} URL filter was skipped: it is ${describeJson(entry)}, not a filter.`);
      continue;
    }
    const pattern = typeof entry.urlRegex === 'string' ? entry.urlRegex : '';
    if (pattern.trim() === '') {
      dropped++;
      note('warning', `An empty ${kind} URL filter was skipped.`);
      continue;
    }
    if (pattern.length > MAX_URL_REGEX_LENGTH) {
      dropped++;
      note(
        'warning',
        `A ${kind} URL filter was skipped: its pattern is ${pattern.length} characters, and ` +
          `anything over ${MAX_URL_REGEX_LENGTH} is past what Chrome will compile, so it could ` +
          'never have matched. Nothing was silently kept from it.',
      );
      continue;
    }
    matchers.push({ id: newId(), enabled: entry.enabled !== false, kind: 'regex', value: pattern });
  }

  return { matchers, dropped };
}

function convertDomainFilters(
  value: unknown,
  newId: IdFactory,
  note: (level: NoteLevel, message: string) => void,
): Matcher[] {
  const result: Matcher[] = [];

  for (const entry of asArray(value)) {
    if (!isObject(entry)) continue;
    const domain = firstString(entry, ['domain', 'requestDomain', 'value', 'name']);
    if (!domain) {
      note('warning', 'A request-domain exclusion was skipped: it named no domain.');
      continue;
    }
    result.push({ id: newId(), enabled: entry.enabled !== false, kind: 'domain', value: domain });
  }

  return result;
}

function convertResourceFilters(
  value: unknown,
  note: (level: NoteLevel, message: string) => void,
): ResourceType[] {
  const selected = new Set<ResourceType>();
  const unknown = new Set<string>();

  for (const entry of asArray(value)) {
    if (!isObject(entry) || entry.enabled === false) continue;
    for (const type of asArray(entry.resourceType)) {
      if (typeof type !== 'string') continue;
      if ((RESOURCE_TYPES as readonly string[]).includes(type)) selected.add(type as ResourceType);
      else unknown.add(type);
    }
  }

  if (unknown.size > 0) {
    note(
      'warning',
      `Chrome has no request type called ${[...unknown].join(', ')}, so it was left out of the rule.`,
    );
  }

  // No resource filter in ModHeader means "every request type".
  return selected.size === 0 ? [...RESOURCE_TYPES] : [...selected];
}

function convertMethodFilters(
  value: unknown,
  note: (level: NoteLevel, message: string) => void,
): RequestMethod[] {
  const selected = new Set<RequestMethod>();
  const unknown = new Set<string>();

  for (const entry of asArray(value)) {
    if (!isObject(entry) || entry.enabled === false) continue;
    for (const method of asArray(entry.requestMethod)) {
      if (typeof method !== 'string') continue;
      const lower = method.toLowerCase();
      if ((REQUEST_METHODS as readonly string[]).includes(lower)) selected.add(lower as RequestMethod);
      else unknown.add(method);
    }
  }

  if (unknown.size > 0) {
    note('warning', `Unknown request method(s) ${[...unknown].join(', ')} were left out of the rule.`);
  }

  return [...selected];
}

/** Fields we deliberately do not import, each reported rather than dropped. */
const UNSUPPORTED_FIELDS: ReadonlyArray<[string, string]> = [
  [
    'urlReplacements',
    'URL redirects are not imported: this extension edits headers and does not redirect requests.',
  ],
  [
    'initiatorDomainFilters',
    'Filters on the initiating domain are not imported: rules here are matched on the request URL.',
  ],
  ['tabFilters', 'Tab filters are not imported: rules here are not scoped to a specific tab.'],
  [
    'tabGroupFilters',
    'Tab-group filters are not imported: rules here are not scoped to a tab group.',
  ],
  ['windowFilters', 'Window filters are not imported: rules here are not scoped to a window.'],
  ['timeFilters', 'Time-of-day filters are not imported.'],
];

function reportUnsupported(profile: Json, note: (level: NoteLevel, message: string) => void): void {
  for (const [field, message] of UNSUPPORTED_FIELDS) {
    const entries = asArray(profile[field]).filter(isObject);
    if (entries.length === 0) continue;
    note('warning', `${entries.length} × ${field}: ${message}`);
  }
}

/**
 * Best-effort host names out of a ModHeader URL regex, so the import screen can
 * suggest site access rather than making the user retype it. Suggestions are
 * always shown for review; nothing is granted automatically.
 */
export function suggestOriginsFromRegex(pattern: string): string[] {
  // ModHeader patterns are full-URL regexes such as `.*://.*\.example\.com/.*`.
  // Only the head is scanned. The importer already refuses anything longer, so
  // this bounds the one path that reaches here directly, and a URL regex past
  // that length has nothing left to suggest anyway.
  const literal = pattern.slice(0, MAX_URL_REGEX_LENGTH).replace(/\\([.\-/])/g, '$1');
  const hosts = new Set<string>();
  // The label quantifier is bounded rather than open — `[a-z0-9-]*` inside a
  // repeated group, with `exec` restarting at every failing offset, made this
  // O(n²) on a long run of undotted word characters: 100 KB of `a` took eight
  // seconds and blocked every message the worker had to serve. 63 is the DNS
  // label limit, so nothing real is lost.
  const hostPattern = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/gi;

  let found: RegExpExecArray | null;
  while ((found = hostPattern.exec(literal)) !== null) {
    const host = found[0].toLowerCase();
    // A bare `.*` fragment can leave a stray label behind, so drop anything with
    // surviving regex metacharacters.
    if (/[^a-z0-9.-]/.test(host)) continue;
    hosts.add(host);
  }

  return [...hosts]
    .map((host) => `*://*.${host}/*`)
    // A suggestion the extension would refuse to request is no use as a
    // suggestion. `.*\.github\.io/.*` names a public suffix, so the pattern
    // built from it is one `assertOriginIsNarrow()` rejects — and
    // `lib/rules-engine.ts` refuses an import outright over a too-broad site.
    // Synthesising one here would fail the whole file over a pattern the user
    // never wrote and cannot edit from the import screen. The rule still
    // arrives, with no site access and a note saying to name the sites.
    .filter((origin) => {
      try {
        assertOriginIsNarrow(origin);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(source: Json, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
