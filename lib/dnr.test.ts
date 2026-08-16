import { describe, expect, it } from 'vitest';
import {
  APPENDABLE_REQUEST_HEADERS,
  PRIORITY_ALLOW,
  PRIORITY_PLAIN,
  PRIORITY_SUPPRESSIBLE,
  checkRegexSupport,
  compileDocument,
  requiredOriginsFor,
  statusesById,
} from './dnr';
import type { RuleStatus } from './dnr';
import type { HeaderEdit, HeaderRule, Matcher, RulesDocument } from './rules';
import { RESOURCE_TYPES, sequentialIds } from './rules';

const newId = sequentialIds('t');

function matcher(kind: Matcher['kind'], value: string, enabled = true): Matcher {
  return { id: newId(), enabled, kind, value };
}

function header(overrides: Partial<HeaderEdit> = {}): HeaderEdit {
  return {
    id: newId(),
    enabled: true,
    target: 'request',
    operation: 'set',
    name: 'X-Debug',
    value: '1',
    ...overrides,
  };
}

function rule(overrides: Partial<HeaderRule> = {}): HeaderRule {
  return {
    id: newId(),
    name: 'Rule',
    enabled: true,
    match: [matcher('domain', 'api.example.com')],
    exclude: [],
    sites: [],
    resourceTypes: [...RESOURCE_TYPES],
    requestMethods: [],
    headers: [header()],
    notes: '',
    ...overrides,
  };
}

function document(rules: HeaderRule[], active = true): RulesDocument {
  return {
    profiles: [{ id: 'profile-1', name: 'Default', rules }],
    activeProfileIds: active ? ['profile-1'] : [],
  };
}

/** Everything a rule on api.example.com needs, granted. */
const GRANTED = ['*://*.api.example.com/*'];

function compile(rules: HeaderRule[], granted: readonly string[] = GRANTED, active = true) {
  return compileDocument(document(rules, active), { grantedOrigins: granted });
}

function only(statuses: RuleStatus[]): RuleStatus {
  expect(statuses).toHaveLength(1);
  return statuses[0]!;
}

describe('checkRegexSupport', () => {
  it.each([
    ['^https://api\\.example\\.com/v[0-9]+/', true],
    ['.*\\.example\\.com.*', true],
    ['(?=foo)', false],
    ['(?!foo)', false],
    ['(?<=foo)bar', false],
    ['(?<!foo)bar', false],
    ['(a)\\1', false],
    ['(?>a+)b', false],
    ['(unclosed', false],
    ['', false],
  ])('%s → supported: %s', (pattern, supported) => {
    expect(checkRegexSupport(pattern).supported).toBe(supported);
  });

  it('explains why, in words a user can act on', () => {
    const result = checkRegexSupport('(?=x)');

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('Lookahead');
    expect(result.reason).toContain('RE2');
  });
});

describe('a straightforward rule', () => {
  it('compiles to one modifyHeaders rule and reports active', () => {
    const { dnrRules, statuses } = compile([rule()]);

    expect(dnrRules).toHaveLength(1);
    expect(dnrRules[0]?.action).toEqual({
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X-Debug', operation: 'set', value: '1' }],
    });
    expect(dnrRules[0]?.condition.requestDomains).toEqual(['api.example.com']);
    expect(dnrRules[0]?.priority).toBe(PRIORITY_PLAIN);

    const status = only(statuses);
    expect(status.state).toBe('active');
    expect(status.problems).toEqual([]);
    expect(status.dnrRuleIds).toEqual([1]);
  });

  it('carries request AND response headers on one rule', () => {
    const { dnrRules } = compile([
      rule({
        headers: [
          header({ target: 'request', name: 'X-Debug', value: '1' }),
          header({ target: 'response', name: 'Access-Control-Allow-Origin', value: '*' }),
        ],
      }),
    ]);

    expect(dnrRules[0]?.action).toEqual({
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X-Debug', operation: 'set', value: '1' }],
      responseHeaders: [
        { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
      ],
    });
  });

  it('applies to XHR and fetch by default', () => {
    // The single most common failure in this category is a header editor that
    // works on navigations and silently does nothing on fetch.
    const { dnrRules } = compile([rule()]);

    expect(dnrRules[0]?.condition.resourceTypes).toContain('xmlhttprequest');
  });

  it('restricts to the chosen request methods, and to none when none are chosen', () => {
    expect(compile([rule({ requestMethods: ['post', 'put'] })]).dnrRules[0]?.condition.requestMethods)
      .toEqual(['post', 'put']);
    expect(compile([rule()]).dnrRules[0]?.condition.requestMethods).toBeUndefined();
  });

  it('emits one browser rule per URL-shaped condition and folds domains into one', () => {
    const { dnrRules } = compile(
      [
        rule({
          match: [
            matcher('domain', 'api.example.com'),
            matcher('domain', 'cdn.example.com'),
            matcher('url-prefix', 'https://api.example.com/v2/'),
          ],
        }),
      ],
      ['*://*.example.com/*'],
    );

    expect(dnrRules).toHaveLength(2);
    expect(dnrRules[0]?.condition.requestDomains).toEqual(['api.example.com', 'cdn.example.com']);
    expect(dnrRules[1]?.condition.urlFilter).toBe('|https://api.example.com/v2/');
  });
});

describe('states', () => {
  it('reports a disabled rule as inactive, with the reason', () => {
    const status = only(compile([rule({ enabled: false })]).statuses);

    expect(status.state).toBe('inactive');
    expect(status.inactiveReason).toBe('rule-disabled');
    expect(status.summary).toContain('turned off');
  });

  it('reports a rule in an inactive profile as inactive, with the reason', () => {
    const status = only(compile([rule()], GRANTED, false).statuses);

    expect(status.state).toBe('inactive');
    expect(status.inactiveReason).toBe('profile-inactive');
    expect(status.summary).toContain('profile');
  });

  it('reports a missing host permission rather than pretending the rule works', () => {
    const status = only(compile([rule()], []).statuses);

    expect(status.state).toBe('needs-permission');
    expect(status.missingOrigins).toEqual(['*://*.api.example.com/*']);
    expect(status.summary).toContain('*://*.api.example.com/*');
  });

  it('installs nothing for a rule that is only partly permitted', () => {
    const { dnrRules } = compile([rule()], []);
    expect(dnrRules).toEqual([]);
  });

  it('still analyses a disabled rule, so a broken rule is visible before it is turned on', () => {
    const status = only(compile([rule({ enabled: false, headers: [header({ name: 'bad header' })] })]).statuses);

    expect(status.state).toBe('inactive');
    expect(status.problems.map((problem) => problem.code)).toContain('invalid-header-name');
  });
});

describe('problems — nothing is ever a silent no-op', () => {
  it('every non-active status carries a summary sentence', () => {
    const cases = [
      compile([rule({ enabled: false })]),
      compile([rule()], []),
      compile([rule({ match: [] })]),
      compile([rule({ headers: [] })]),
    ];

    for (const result of cases) {
      const status = only(result.statuses);
      expect(status.summary.length).toBeGreaterThan(0);
      expect(status.state).not.toBe('active');
    }
  });

  it('rejects a rule with no conditions', () => {
    const status = only(compile([rule({ match: [] })]).statuses);

    expect(status.state).toBe('unsupported');
    expect(status.problems.map((problem) => problem.code)).toContain('no-match');
  });

  it('rejects a rule that changes no headers', () => {
    const status = only(compile([rule({ headers: [] })]).statuses);

    expect(status.problems.map((problem) => problem.code)).toContain('no-headers');
  });

  it('rejects an invalid header name and names the offending header', () => {
    const bad = header({ name: 'X Debug: yes' });
    const status = only(compile([rule({ headers: [bad] })]).statuses);

    const problem = status.problems.find((entry) => entry.code === 'invalid-header-name');
    expect(problem?.headerId).toBe(bad.id);
    expect(problem?.message).toContain('X Debug: yes');
  });

  /**
   * Chrome refuses the WHOLE ruleset over one unacceptable header value, because
   * `updateDynamicRules` is atomic. Uncaught, a newline copied along with a
   * bearer token stopped every rule in the profile applying while all of them
   * still badged "Active". Caught here it costs one rule, and that rule says why.
   */
  it.each([
    ['a carriage return and newline, the copy-paste case', 'abc\r\nX-Injected: evil', 'a carriage return'],
    ['a bare newline', 'token\n', 'a line break'],
    ['a NUL', 'tok\u0000en', 'a control character (0x00)'],
  ])('rejects a header value containing %s', (_name, value, expected) => {
    const bad = header({ name: 'X-Token', value });
    const status = only(compile([rule({ headers: [bad] })]).statuses);

    const problem = status.problems.find((entry) => entry.code === 'invalid-header-value');
    expect(problem).toBeDefined();
    expect(problem?.headerId).toBe(bad.id);
    // The offending character is named, because it is invisible in the field
    // the user is looking at.
    expect(problem?.message).toContain(expected);
    expect(status.state).toBe('unsupported');
  });

  it('installs nothing for a rule whose header value Chrome would refuse', () => {
    // The point of catching it: the bad rule alone stops, and the good rule in
    // the same batch keeps working. Before this, Chrome rejected the batch and
    // every rule silently became a no-op.
    const good = rule({ name: 'good' });
    const bad = rule({ name: 'bad', headers: [header({ value: 'abc\r\nX-Injected: evil' })] });
    const { dnrRules, statuses } = compile([good, bad]);

    expect(statuses[0]?.state).toBe('active');
    expect(statuses[1]?.state).toBe('unsupported');
    expect(dnrRules).toHaveLength(1);
    expect(statuses[1]?.dnrRuleIds).toEqual([]);
  });

  it('allows a tab inside a header value, which Chrome accepts', () => {
    const status = only(compile([rule({ headers: [header({ value: 'a\tb' })] })]).statuses);
    expect(status.problems).toEqual([]);
    expect(status.state).toBe('active');
  });

  /**
   * The rejected set is exactly NUL, CR and LF, and it is measured rather than
   * read off the RFC: Chrome 151.0.7922.137 was probed over CDP with one
   * `modifyHeaders` rule per value, and every value below was ACCEPTED. Refusing
   * one of them would turn a rule that works today into "Won't apply" and blame
   * Chrome for a restriction Chrome does not impose — the silent-breakage
   * failure this product exists to prevent, arriving from the validation side.
   */
  it.each([
    ['a non-ASCII character', 'café'],
    ['CJK', '中'],
    ['an emoji', '\u{1f600}'],
    ['a DEL', 'tok\u007fen'],
    ['obs-text', 'tok\u0080en'],
    ['an ESC', 'tok\u001ben'],
  ])('accepts a header value containing %s, which Chrome accepts', (_name, value) => {
    const status = only(compile([rule({ headers: [header({ value })] })]).statuses);

    expect(status.problems).toEqual([]);
    expect(status.state).toBe('active');
  });

  it('ignores the value of a Remove, which Chrome never sends', () => {
    const status = only(
      compile([
        rule({ headers: [header({ operation: 'remove', value: 'abc\r\nX-Injected: evil' })] }),
      ]).statuses,
    );

    expect(status.problems).toEqual([]);
    expect(status.warnings.map((warning) => warning.code)).toContain('value-ignored-on-remove');
  });

  it('rejects appending to a request header Chrome cannot append to', () => {
    const status = only(
      compile([rule({ headers: [header({ operation: 'append', name: 'X-Debug' })] })]).statuses,
    );

    const problem = status.problems.find((entry) => entry.code === 'append-not-supported');
    expect(problem).toBeDefined();
    // The message has to be actionable, so it lists what can be appended.
    expect(problem?.message).toContain('user-agent');
  });

  it.each(APPENDABLE_REQUEST_HEADERS)('allows appending to %s', (name) => {
    const status = only(
      compile([rule({ headers: [header({ operation: 'append', name, value: 'x' })] })]).statuses,
    );

    expect(status.problems).toEqual([]);
  });

  it('allows appending to any response header', () => {
    const status = only(
      compile([
        rule({ headers: [header({ target: 'response', operation: 'append', name: 'X-Trace', value: 'a' })] }),
      ]).statuses,
    );

    expect(status.problems).toEqual([]);
  });

  it('rejects an unusable regex and quotes the reason', () => {
    const status = only(
      compile([rule({ match: [matcher('regex', 'https://(?=api).*')] , sites: ['*://*.example.com/*']})]).statuses,
    );

    const problem = status.problems.find((entry) => entry.code === 'regex-unsupported');
    expect(problem?.message).toContain('Lookahead');
  });

  it('rejects a URL condition Chrome cannot match byte-wise', () => {
    const status = only(
      compile([rule({ match: [matcher('url-prefix', 'https://éxample.com/')], sites: ['*://*.example.com/*'] })])
        .statuses,
    );

    expect(status.problems.map((problem) => problem.code)).toContain('non-ascii-url-filter');
  });

  it('rejects an invalid domain and quotes what the user typed', () => {
    const status = only(compile([rule({ match: [matcher('domain', 'not a host')] })]).statuses);

    const problem = status.problems.find((entry) => entry.code === 'invalid-domain');
    expect(problem?.message).toContain('not a host');
    expect(status.state).toBe('unsupported');
  });

  it('rejects a rule whose sites cannot be worked out', () => {
    const status = only(
      compile([rule({ match: [matcher('regex', '.*/api/.*')], sites: [] })]).statuses,
    );

    const problem = status.problems.find((entry) => entry.code === 'undecidable-site');
    expect(problem?.message).toContain('Site access');
  });

  it('rejects a site pattern that is too broad, even if a user typed it', () => {
    const status = only(compile([rule({ sites: ['<all_urls>'] })], ['<all_urls>']).statuses);

    expect(status.problems.map((problem) => problem.code)).toContain('site-too-broad');
  });

  it('rejects a rule that applies to no request types', () => {
    const status = only(compile([rule({ resourceTypes: [] })]).statuses);

    expect(status.problems.map((problem) => problem.code)).toContain('no-resource-types');
  });

  it('reports the rule limit rather than quietly dropping the overflow', () => {
    const rules = [rule(), rule()];
    const { dnrRules, statuses } = compileDocument(document(rules), {
      grantedOrigins: GRANTED,
      maxRules: 1,
    });

    expect(dnrRules).toHaveLength(1);
    expect(statuses[0]?.state).toBe('active');
    expect(statuses[1]?.state).toBe('unsupported');
    expect(statuses[1]?.problems.map((problem) => problem.code)).toContain('rule-limit-exceeded');
  });
});

/**
 * The one thing that must never be true: a rule the user is told will not apply
 * that Chrome is applying anyway. With `declarativeNetRequestWithHostAccess`,
 * such a rule would attach its header — routinely a bearer token — on every host
 * granted for some other rule, while both surfaces read "Won't apply".
 */
describe('what is reported and what is installed cannot disagree', () => {
  it('installs nothing for a rule whose sites cannot be derived', () => {
    // Reachable straight through the shipped ModHeader import: a urlRegex with
    // no dotted hostname suggests no site, and localhost is the host developers
    // point rules at most.
    const { dnrRules, statuses } = compile([
      rule({
        match: [matcher('regex', 'http://localhost:3000/.*')],
        sites: [],
        headers: [header({ name: 'Authorization', value: 'Bearer secret' })],
      }),
    ]);

    expect(only(statuses).state).toBe('unsupported');
    expect(dnrRules).toEqual([]);
  });

  it('installs nothing for a "URL contains" rule with no site named', () => {
    const { dnrRules, statuses } = compile([
      rule({ match: [matcher('url-contains', '/v1/')], sites: [] }),
    ]);

    expect(only(statuses).problems.map((problem) => problem.code)).toContain('undecidable-site');
    expect(dnrRules).toEqual([]);
  });

  it('installs nothing for a rule that names no sites at all', () => {
    const { dnrRules, statuses } = compile([rule({ match: [], sites: [] })]);

    expect(only(statuses).problems.map((problem) => problem.code)).toContain('no-sites');
    expect(dnrRules).toEqual([]);
  });

  it('installs nothing for a rule whose site pattern is too broad', () => {
    const { dnrRules, statuses } = compile([rule({ sites: ['<all_urls>'] })], ['<all_urls>']);

    expect(only(statuses).state).toBe('unsupported');
    expect(dnrRules).toEqual([]);
  });

  it('leaves a working rule installed alongside an unsupported one', () => {
    const working = rule();
    const broken = rule({ match: [matcher('regex', '.*/api/.*')], sites: [] });
    const { dnrRules, statuses } = compile([working, broken]);

    expect(statuses[0]?.state).toBe('active');
    expect(statuses[1]?.state).toBe('unsupported');
    expect(dnrRules).toHaveLength(1);
    expect(statuses[1]?.dnrRuleIds).toEqual([]);
  });

  it('holds for every status a compile produces', () => {
    const { statuses, compileError } = compile([
      rule(),
      rule({ enabled: false }),
      rule({ match: [matcher('regex', '.*/api/.*')], sites: [] }),
      rule({ sites: ['https://elsewhere.example.org/*'] }),
      rule({ resourceTypes: [] }),
    ]);

    for (const status of statuses) {
      if (status.state !== 'active') expect(status.dnrRuleIds).toEqual([]);
    }
    // The safeguard is a backstop, not a working part: reaching it means the
    // compiler contradicted itself, and `lib/rules-engine.ts` turns this into an
    // engine error rather than a rejected promise the UI cannot recover from.
    expect(compileError).toBeNull();
  });
});

describe('warnings — worth saying, not worth blocking', () => {
  it('warns when a value is set on a Remove', () => {
    const status = only(
      compile([rule({ headers: [header({ operation: 'remove', value: 'ignored' })] })]).statuses,
    );

    expect(status.state).toBe('active');
    expect(status.warnings.map((warning) => warning.code)).toContain('value-ignored-on-remove');
  });

  it('warns about an empty header value', () => {
    const status = only(compile([rule({ headers: [header({ value: '' })] })]).statuses);

    expect(status.warnings.map((warning) => warning.code)).toContain('empty-value');
  });

  it('warns when a URL condition contains pattern metacharacters', () => {
    const status = only(
      compile([
        rule({ match: [matcher('url-prefix', 'https://api.example.com/*/items')] }),
      ]).statuses,
    );

    expect(status.warnings.map((warning) => warning.code)).toContain(
      'url-filter-special-characters',
    );
  });

  it('drops a resource type this browser does not know, and says so', () => {
    const { dnrRules, statuses } = compileDocument(document([rule()]), {
      grantedOrigins: GRANTED,
      supportedResourceTypes: ['main_frame', 'xmlhttprequest'],
    });

    expect(dnrRules[0]?.condition.resourceTypes).toEqual(['main_frame', 'xmlhttprequest']);
    expect(statuses[0]?.warnings.map((warning) => warning.code)).toContain(
      'unsupported-resource-type',
    );
  });
});

describe('exclusions', () => {
  it('expresses a domain exclusion natively and exactly', () => {
    const { dnrRules } = compile([
      rule({ exclude: [matcher('domain', 'health.api.example.com')] }),
    ]);

    expect(dnrRules).toHaveLength(1);
    expect(dnrRules[0]?.condition.excludedRequestDomains).toEqual(['health.api.example.com']);
    expect(dnrRules[0]?.priority).toBe(PRIORITY_PLAIN);
  });

  it('expresses a REGEX exclusion — which Chrome has no condition field for — as an allow rule', () => {
    const { dnrRules, statuses } = compile([
      rule({ exclude: [matcher('regex', '.*/health.*')] }),
    ]);

    expect(dnrRules).toHaveLength(2);

    const modify = dnrRules.find((entry) => entry.action.type === 'modifyHeaders');
    const allow = dnrRules.find((entry) => entry.action.type === 'allow');

    expect(modify?.priority).toBe(PRIORITY_SUPPRESSIBLE);
    expect(allow?.priority).toBe(PRIORITY_ALLOW);
    // Strictly greater priority is what makes Chrome skip the modify rule.
    expect(allow!.priority).toBeGreaterThan(modify!.priority);
    expect(allow?.condition.regexFilter).toBe('.*/health.*');
    // The exemption is scoped to the rule's own domains, not the whole browser.
    expect(allow?.condition.requestDomains).toEqual(['api.example.com']);

    expect(only(statuses).state).toBe('active');
  });

  it('does NOT scope the allow rule to the domains when the rule also matches by URL', () => {
    // match = [domain a, url-prefix on b] with exclude = [url-contains]. Scoping
    // the exemption to `a` would leave the url-prefix branch unexcluded, so a
    // request to b/x/skip would be modified despite the user excluding it —
    // the exclusion silently ceasing to exclude.
    const { dnrRules } = compile(
      [
        rule({
          match: [
            matcher('domain', 'api.example.com'),
            matcher('url-prefix', 'https://other.example.net/x'),
          ],
          exclude: [matcher('url-contains', '/skip')],
          sites: ['*://*.other.example.net/*'],
        }),
      ],
      [...GRANTED, '*://*.other.example.net/*', 'https://other.example.net/*'],
    );

    const modify = dnrRules.filter((entry) => entry.action.type === 'modifyHeaders');
    const allow = dnrRules.filter((entry) => entry.action.type === 'allow');

    expect(modify).toHaveLength(2);
    expect(allow).toHaveLength(1);
    expect(allow[0]?.condition.urlFilter).toBe('/skip');
    expect(allow[0]?.condition.requestDomains).toBeUndefined();
  });

  it('keeps rules without URL exclusions above the allow band, out of reach of them', () => {
    const excluding = rule({ exclude: [matcher('regex', '.*/health.*')] });
    const plain = rule();
    const { dnrRules } = compile([excluding, plain]);

    const plainModify = dnrRules.filter((entry) => entry.priority === PRIORITY_PLAIN);
    expect(plainModify).toHaveLength(1);
    expect(plainModify[0]!.priority).toBeGreaterThan(PRIORITY_ALLOW);
  });

  it('warns — rather than staying quiet — when two rules share the allow band', () => {
    const first = rule({ exclude: [matcher('regex', '.*/health.*')] });
    const second = rule({ exclude: [matcher('url-contains', '/metrics')] });
    const { statuses } = compile([first, second]);

    for (const status of statuses) {
      expect(status.state).toBe('active');
      expect(status.warnings.map((warning) => warning.code)).toContain('shared-exclusion-band');
    }
  });

  it('does not warn when only one rule uses a URL exclusion', () => {
    const { statuses } = compile([rule({ exclude: [matcher('regex', '.*/health.*')] }), rule()]);

    for (const status of statuses) {
      expect(status.warnings.map((warning) => warning.code)).not.toContain('shared-exclusion-band');
    }
  });

  it('rejects an unusable exclusion regex instead of quietly ignoring the exclusion', () => {
    const status = only(compile([rule({ exclude: [matcher('regex', '(?<=x)y')] })]).statuses);

    expect(status.state).toBe('unsupported');
    expect(status.problems.map((problem) => problem.code)).toContain('regex-unsupported');
  });
});

describe('requiredOriginsFor', () => {
  it('merges named sites with those the conditions imply', () => {
    expect(
      requiredOriginsFor(
        rule({ match: [matcher('domain', 'api.example.com')], sites: ['https://app.example.com/*'] }),
      ),
    ).toEqual(['*://*.api.example.com/*', 'https://app.example.com/*']);
  });
});

describe('statusesById', () => {
  it('keys statuses for the UI', () => {
    const single = rule();
    const map = statusesById(compile([single]).statuses);

    expect(map.get(single.id)?.state).toBe('active');
  });
});

describe('rule ids', () => {
  it('allocates browser rule ids without collisions across rules', () => {
    const { dnrRules } = compile([
      rule({ exclude: [matcher('regex', '.*/health.*')] }),
      rule(),
      rule({ match: [matcher('domain', 'api.example.com'), matcher('url-contains', '/v2/')] }),
    ]);

    const ids = dnrRules.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(1);
  });
});
