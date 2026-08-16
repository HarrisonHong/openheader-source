import { describe, expect, it } from 'vitest';
import {
  looksLikeModHeaderExport,
  parseModHeaderExport,
  suggestOriginsFromRegex,
  upgradeProfile,
} from './modheader';
import { sequentialIds } from './rules';

/**
 * Fixtures are shaped from real exports, not invented:
 *
 *  - `V2_EXPORT` follows ModHeader 7's own `exportProfile` output, verified
 *    against `requestly/modheader-export-backup` (`src/modheader-format.mjs`,
 *    a port of the extension's `exportProfileHook`) and its golden test.
 *  - `V1_EXPORT` is the shape found in the wild in
 *    `solita/ara-etp/etp-front/modheaders.json`: no `version`, profile-level
 *    `appendMode`, and an empty tagged `filters` array.
 *  - `EXCLUDE_EXPORT` mirrors `Zerohazard8x/custom/modheader/headers.json`,
 *    which is a v2 export using `excludeUrlFilters`.
 *
 * See docs/modheader-import.md for the field-by-field table and source URLs.
 */

const V2_EXPORT = JSON.stringify([
  {
    title: 'Staging',
    shortTitle: 'S',
    version: 2,
    headers: [
      { enabled: true, name: 'Authorization', value: 'Bearer token', comment: 'staging key' },
      { enabled: false, name: 'X-Off', value: 'no' },
    ],
    respHeaders: [{ enabled: true, name: 'Access-Control-Allow-Origin', value: '*' }],
    urlFilters: [{ enabled: true, urlRegex: '.*://.*\\.example\\.com/.*', comment: '' }],
    excludeUrlFilters: [{ enabled: true, urlRegex: '.*/health.*', comment: '' }],
    resourceFilters: [{ enabled: true, resourceType: ['xmlhttprequest', 'main_frame'], comment: '' }],
    requestMethodFilters: [{ enabled: true, requestMethod: ['GET', 'POST'], comment: '' }],
  },
]);

const V1_EXPORT = JSON.stringify([
  {
    appendMode: false,
    backgroundColor: '#6e1056',
    filters: [],
    headers: [{ comment: '', enabled: true, name: 'x-amzn-oidc-identity', value: 'me@example.com' }],
    hideComment: true,
    respHeaders: [],
    shortTitle: '1',
    title: 'me@example.com',
    urlReplacements: [],
  },
]);

const EXCLUDE_EXPORT = JSON.stringify([
  {
    headers: [{ enabled: true, name: 'X-Forwarded-For', value: '127.0.0.1' }],
    title: 'headers',
    shortTitle: '1',
    version: 2,
    alwaysOn: true,
    excludeUrlFilters: [
      { enabled: true, urlRegex: '.*lazada.*' },
      { enabled: true, urlRegex: '.*gaming.amazon.*' },
    ],
  },
]);

function parse(raw: string, sites: string[] = []) {
  return parseModHeaderExport(raw, sequentialIds('mh'), { sites });
}

describe('looksLikeModHeaderExport', () => {
  it('recognises a v2 export', () => {
    expect(looksLikeModHeaderExport(JSON.parse(V2_EXPORT))).toBe(true);
  });

  it('recognises a v1 export, which has no version field at all', () => {
    expect(looksLikeModHeaderExport(JSON.parse(V1_EXPORT))).toBe(true);
  });

  it.each([[[]], [{}], [null], [[{ title: 'no lists' }]], [[{ headers: [] }]]])(
    'rejects %s',
    (value) => {
      expect(looksLikeModHeaderExport(value)).toBe(false);
    },
  );
});

describe('failure modes are explained, not shrugged at', () => {
  it('rejects invalid JSON with the parser message', () => {
    const result = parse('{ not json');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not valid JSON');
  });

  it('tells the user how to produce the right file when given an object', () => {
    const result = parse('{"profiles": []}');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Export → Download JSON');
  });

  it('rejects an empty array', () => {
    const result = parse('[]');
    expect(result.ok).toBe(false);
  });

  it('rejects a file that is JSON but not a ModHeader export', () => {
    const result = parse('[{"foo": 1}]');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('does not look like a ModHeader export');
  });
});

describe('a v2 export', () => {
  it('imports request and response headers into one rule', () => {
    const result = parse(V2_EXPORT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [profile] = result.profiles;
    expect(profile?.name).toBe('Staging');
    expect(profile?.rules).toHaveLength(1);

    const rule = profile!.rules[0]!;
    expect(rule.headers).toEqual([
      expect.objectContaining({
        target: 'request',
        operation: 'set',
        name: 'Authorization',
        value: 'Bearer token',
        enabled: true,
      }),
      expect.objectContaining({ name: 'X-Off', enabled: false }),
      expect.objectContaining({
        target: 'response',
        name: 'Access-Control-Allow-Origin',
        value: '*',
      }),
    ]);
  });

  it('imports URL filters as regex conditions and exclusions as regex exclusions', () => {
    const result = parse(V2_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    const rule = result.profiles[0]!.rules[0]!;
    expect(rule.match).toEqual([
      expect.objectContaining({ kind: 'regex', value: '.*://.*\\.example\\.com/.*' }),
    ]);
    expect(rule.exclude).toEqual([
      expect.objectContaining({ kind: 'regex', value: '.*/health.*' }),
    ]);
  });

  it('imports resource and method filters', () => {
    const result = parse(V2_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    const rule = result.profiles[0]!.rules[0]!;
    expect(rule.resourceTypes).toEqual(['xmlhttprequest', 'main_frame']);
    expect(rule.requestMethods).toEqual(['get', 'post']);
  });

  it('suggests site access from the URL filter instead of leaving the user to retype it', () => {
    const result = parse(V2_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.sites).toEqual(['*://*.example.com/*']);
    expect(result.report.notes.some((note) => note.message.includes('Site access was suggested'))).toBe(
      true,
    );
  });

  it('counts what it imported', () => {
    const result = parse(V2_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.report.profileCount).toBe(1);
    expect(result.report.ruleCount).toBe(1);
    expect(result.report.headerCount).toBe(3);
  });
});

describe('a v1 export', () => {
  it('is upgraded the way ModHeader itself would upgrade it', () => {
    const upgraded = upgradeProfile(
      { title: 'old', appendMode: true, sendEmptyHeader: true, headers: [{ name: 'A', value: '1' }] },
      0,
    );

    expect(upgraded.version).toBe(2);
    expect(upgraded.appendMode).toBeUndefined();
    expect(upgraded.headers).toEqual([
      { name: 'A', value: '1', appendMode: 'append', sendEmptyHeader: true },
    ]);
  });

  it('splits the v1 tagged filters array into per-kind lists', () => {
    const upgraded = upgradeProfile(
      {
        title: 'old',
        filters: [
          { type: 'urls', enabled: true, urlRegex: '.*://legacy\\.example\\.com/.*' },
          { type: 'excludeUrls', enabled: true, urlRegex: '.*/health.*' },
          { type: 'types', enabled: true, resourceType: ['script'] },
        ],
      },
      0,
    );

    expect(upgraded.urlFilters).toHaveLength(1);
    expect(upgraded.excludeUrlFilters).toHaveLength(1);
    expect(upgraded.resourceFilters).toHaveLength(1);
    expect(upgraded.filters).toBeUndefined();
  });

  it('imports a real-world v1 profile and says it was upgraded', () => {
    const result = parse(V1_EXPORT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rule = result.profiles[0]!.rules[0]!;
    expect(result.profiles[0]?.name).toBe('me@example.com');
    expect(rule.headers[0]).toMatchObject({
      name: 'x-amzn-oidc-identity',
      value: 'me@example.com',
      operation: 'set',
    });
    expect(result.report.notes.some((note) => note.message.includes('older ModHeader'))).toBe(true);
  });

  it('says out loud that a profile with no URL filter has no site access yet', () => {
    const result = parse(V1_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    // ModHeader applied such a profile everywhere. We never hold blanket access,
    // so the user is told rather than left wondering why nothing happens.
    expect(result.profiles[0]!.rules[0]!.match).toEqual([]);
    expect(
      result.report.notes.some(
        (note) => note.level === 'warning' && note.message.includes('every site'),
      ),
    ).toBe(true);
  });

  it('uses sites supplied on the import screen', () => {
    const result = parse(V1_EXPORT, ['https://app.example.com/*']);
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.sites).toEqual(['https://app.example.com/*']);
  });
});

describe('exclusion-only export', () => {
  it('imports exclusions even when there are no positive URL filters', () => {
    const result = parse(EXCLUDE_EXPORT);
    if (!result.ok) throw new Error('expected a successful import');

    const rule = result.profiles[0]!.rules[0]!;
    expect(rule.exclude.map((entry) => entry.value)).toEqual(['.*lazada.*', '.*gaming.amazon.*']);
  });
});

/**
 * An import is a file someone else wrote, parsed in the service worker. A
 * pattern longer than Chrome will compile could never have matched anything, in
 * ModHeader either — so it is dropped, and dropping it is said out loud rather
 * than left for the user to discover.
 */
describe('an absurdly long URL filter', () => {
  const OVERSIZE = 'a'.repeat(2_001);

  it('is skipped, with a note saying so', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'oversize',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlFilters: [
            { enabled: true, urlRegex: OVERSIZE },
            { enabled: true, urlRegex: '.*example\\.com.*' },
          ],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const rule = result.profiles[0]!.rules[0]!;
    expect(rule.match.map((entry) => entry.value)).toEqual(['.*example\\.com.*']);
    expect(result.report.notes.some((note) => note.message.includes('2001 characters'))).toBe(true);
    // Losing a match condition can only narrow the rule, so it still arrives on.
    expect(rule.enabled).toBe(true);
  });

  it('leaves the rule TURNED OFF when the pattern dropped was an exclusion', () => {
    // Dropping an exclusion widens a rule — it would then apply to requests the
    // profile it came from kept it away from. Arriving off is the only honest
    // outcome; the note says what to restore.
    const result = parse(
      JSON.stringify([
        {
          title: 'oversize exclusion',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
          excludeUrlFilters: [{ enabled: true, urlRegex: OVERSIZE }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const rule = result.profiles[0]!.rules[0]!;
    expect(rule.enabled).toBe(false);
    expect(result.report.notes.some((note) => note.message.includes('TURNED OFF'))).toBe(true);
  });

  /**
   * Oversize is not the only way an exclusion can be lost. A malformed entry and
   * a field that is not a list drop one just as completely, and a rule that
   * arrives ON after either applies to requests the profile it came from kept it
   * away from — silently, which is the thing this module promises never to do.
   */
  it.each([
    ['an entry that is not an object', { excludeUrlFilters: ['*://ads.example.com/*'] }, 'not a filter'],
    ['an entry with an empty pattern', { excludeUrlFilters: [{ enabled: true, urlRegex: '  ' }] }, 'empty'],
    ['a field that is not a list', { excludeUrlFilters: { urlRegex: '.*ads.*' } }, 'where a list of filters belongs'],
  ])('leaves the rule TURNED OFF when the exclusion was lost to %s', (_name, overrides, expected) => {
    const result = parse(
      JSON.stringify([
        {
          title: 'malformed exclusion',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
          ...overrides,
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.enabled).toBe(false);
    expect(result.report.notes.some((note) => note.message.includes(expected))).toBe(true);
    expect(result.report.notes.some((note) => note.message.includes('TURNED OFF'))).toBe(true);
  });

  it('leaves the rule ON when it was a MATCH filter that was lost', () => {
    // Losing a match condition can only narrow a rule, so it is safe to import
    // switched on — the asymmetry is the whole point.
    const result = parse(
      JSON.stringify([
        {
          title: 'malformed match',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlFilters: ['*://api.example.com/*', { enabled: true, urlRegex: '.*example\\.com.*' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.enabled).toBe(true);
    expect(result.report.notes.some((note) => note.message.includes('not a filter'))).toBe(true);
  });

  it('keeps a pattern right up to the limit', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'at the limit',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: 'a'.repeat(2_000) }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.match).toHaveLength(1);
  });
});

describe('header operations', () => {
  it('maps append modes', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'ops',
          version: 2,
          headers: [
            { enabled: true, name: 'A', value: '1', appendMode: 'append' },
            { enabled: true, name: 'B', value: '2', appendMode: 'comma' },
            { enabled: true, name: 'C', value: '3' },
            { enabled: true, name: 'D', value: '4', sendEmptyHeader: true },
          ],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const operations = result.profiles[0]!.rules[0]!.headers.map((header) => [
      header.name,
      header.operation,
    ]);
    expect(operations).toEqual([
      ['A', 'append'],
      ['B', 'append'],
      ['C', 'set'],
      ['D', 'remove'],
    ]);
  });

  it('notes the comma-append difference rather than silently changing behaviour', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'ops',
          version: 2,
          headers: [{ enabled: true, name: 'B', value: '2', appendMode: 'comma' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.report.notes.some((note) => note.message.includes('comma-separated'))).toBe(true);
  });
});

describe('features we do not import', () => {
  it('reports redirects and tab filters instead of dropping them silently', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'extras',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          urlReplacements: [{ enabled: true, name: 'a', value: 'b' }],
          tabFilters: [{ enabled: true, tabId: 3 }],
          timeFilters: [{ enabled: true }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const messages = result.report.notes.map((note) => note.message).join('\n');
    expect(messages).toContain('urlReplacements');
    expect(messages).toContain('tabFilters');
    expect(messages).toContain('timeFilters');
  });

  it('combines CSP directives into one response header', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'csp',
          version: 2,
          cspDirectives: [
            { enabled: true, name: 'default-src', value: "'self'" },
            { enabled: true, name: 'img-src', value: '*' },
          ],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.headers[0]).toMatchObject({
      target: 'response',
      name: 'Content-Security-Policy',
      value: "default-src 'self'; img-src *",
    });
  });

  it('imports reqCookieAppend as an append to the Cookie header', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'cookies',
          version: 2,
          reqCookieAppend: [{ enabled: true, name: 'session', value: 'abc' }],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.headers[0]).toMatchObject({
      target: 'request',
      operation: 'append',
      name: 'Cookie',
      value: 'session=abc',
      enabled: true,
    });
  });

  it('imports the unverified cookie modifiers TURNED OFF, with the reason', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'cookies',
          version: 2,
          setCookieHeaders: [{ enabled: true, name: 'a', value: 'b' }],
          urlFilters: [{ enabled: true, urlRegex: '.*example\\.com.*' }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const header = result.profiles[0]!.rules[0]!.headers[0]!;
    expect(header.name).toBe('Set-Cookie');
    expect(header.enabled).toBe(false);
    expect(
      result.report.notes.some(
        (note) => note.level === 'warning' && note.message.includes('TURNED OFF'),
      ),
    ).toBe(true);
  });

  it('reports an unknown resource type rather than silently narrowing the rule', () => {
    const result = parse(
      JSON.stringify([
        {
          title: 'types',
          version: 2,
          headers: [{ enabled: true, name: 'A', value: '1' }],
          resourceFilters: [{ enabled: true, resourceType: ['xmlhttprequest', 'teleport'] }],
        },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles[0]!.rules[0]!.resourceTypes).toEqual(['xmlhttprequest']);
    expect(result.report.notes.some((note) => note.message.includes('teleport'))).toBe(true);
  });
});

describe('suggestOriginsFromRegex', () => {
  it.each([
    ['.*://.*\\.example\\.com/.*', ['*://*.example.com/*']],
    ['^https://api\\.example\\.com/v1/.*', ['*://*.api.example.com/*']],
    ['.*lazada.*', []],
  ])('%s → %s', (pattern, expected) => {
    expect(suggestOriginsFromRegex(pattern)).toEqual(expected);
  });

  it('produces only patterns the permission policy would accept', () => {
    for (const origin of suggestOriginsFromRegex('.*://.*\\.example\\.co\\.uk/.*')) {
      expect(origin.startsWith('*://')).toBe(true);
    }
  });

  /**
   * A suggestion the extension would refuse to request is no use as a
   * suggestion. `lib/rules-engine.ts` refuses an import outright over a
   * too-broad site, so synthesising one here failed the whole file over a
   * pattern the user never wrote and could not edit from the import screen.
   */
  it.each([
    ['.*\\.github\\.io/.*', 'a public suffix'],
    ['.*\\.pages\\.dev/.*', 'another public suffix'],
    ['.*\\.co\\.uk/.*', 'a registry label under a ccTLD'],
    ['.*\\.com/.*', 'a bare TLD'],
  ])('suggests nothing for %s, which names %s', (pattern) => {
    expect(suggestOriginsFromRegex(pattern)).toEqual([]);
  });

  it('still suggests a host that sits under a public suffix', () => {
    expect(suggestOriginsFromRegex('.*://myproject\\.github\\.io/.*')).toEqual([
      '*://*.myproject.github.io/*',
    ]);
  });

  /**
   * This runs in the service worker, once per regex matcher, on a file someone
   * else wrote — and a worker busy here serves no messages, so the popup and the
   * options page hang with it. The host scan used to be O(n²) on a long run of
   * undotted word characters: 100 KB of `a` took eight seconds, and a 500 KB
   * field would have taken minutes. The scan is now capped and the label
   * quantifier bounded, so it is linear and short whatever arrives.
   */
  it('stays fast on input built to make the host scan quadratic', () => {
    const timeFor = (n: number): number => {
      const start = performance.now();
      suggestOriginsFromRegex('a'.repeat(n));
      return performance.now() - start;
    };

    // Sixteen times the input must not cost meaningfully more than the smallest
    // run. Quadratic scaling would be ~256×.
    const small = timeFor(6_250);
    const large = timeFor(100_000);
    expect(large).toBeLessThan(Math.max(small, 1) * 8);
    // An absolute bound too, so the ratio cannot be satisfied by both being slow.
    expect(large).toBeLessThan(100);
  });

  it('scans only the head of an absurdly long pattern, and still finds what is there', () => {
    const padding = 'a'.repeat(50_000);
    expect(suggestOriginsFromRegex(`.*://.*\\.example\\.com/.*${padding}`)).toEqual([
      '*://*.example.com/*',
    ]);
    // Past the cap there is nothing left to suggest, and nothing is claimed.
    expect(suggestOriginsFromRegex(`${padding}api.example.com`)).toEqual([]);
  });
});

describe('multiple profiles', () => {
  it('imports each profile as its own profile, keeping the names', () => {
    const result = parse(
      JSON.stringify([
        { title: 'One', version: 2, headers: [{ enabled: true, name: 'A', value: '1' }] },
        { title: 'Two', version: 2, headers: [{ enabled: true, name: 'B', value: '2' }] },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    expect(result.profiles.map((profile) => profile.name)).toEqual(['One', 'Two']);
    expect(result.report.profileCount).toBe(2);
  });

  it('gives every imported profile and rule a distinct id', () => {
    const result = parse(
      JSON.stringify([
        { title: 'One', version: 2, headers: [{ enabled: true, name: 'A', value: '1' }] },
        { title: 'Two', version: 2, headers: [{ enabled: true, name: 'B', value: '2' }] },
      ]),
    );
    if (!result.ok) throw new Error('expected a successful import');

    const ids = [
      ...result.profiles.map((profile) => profile.id),
      ...result.profiles.flatMap((profile) => profile.rules.map((rule) => rule.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
