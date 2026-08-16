import { describe, expect, it } from 'vitest';
import {
  deriveOrigins,
  hostnameOf,
  missingOrigins,
  parseMatchPattern,
  patternCovers,
  patternForDomain,
  patternForPageUrl,
} from './match-patterns';
import { assertOriginIsNarrow } from './permissions';
import type { Matcher } from './rules';

function matcher(kind: Matcher['kind'], value: string, enabled = true): Matcher {
  return { id: `${kind}:${value}`, enabled, kind, value };
}

describe('parseMatchPattern', () => {
  it('parses a normal pattern', () => {
    expect(parseMatchPattern('https://api.example.com/*')).toEqual({
      scheme: 'https',
      host: 'api.example.com',
      path: '/*',
      allUrls: false,
    });
  });

  it('recognises <all_urls>', () => {
    expect(parseMatchPattern('<all_urls>')?.allUrls).toBe(true);
  });

  it.each(['example.com', 'https://', 'https://*.*.example.com/*', 'gopher://example.com/*'])(
    'returns null for the malformed pattern %s',
    (pattern) => {
      expect(parseMatchPattern(pattern)).toBeNull();
    },
  );
});

describe('patternCovers', () => {
  it.each([
    ['https://example.com/*', 'https://example.com/*'],
    ['*://*.example.com/*', 'https://api.example.com/*'],
    ['*://*.example.com/*', 'https://example.com/*'],
    ['*://*.example.com/*', '*://*.api.example.com/*'],
    ['https://example.com/*', 'https://example.com/v1/*'],
    ['<all_urls>', 'https://anything.example/*'],
  ])('%s covers %s', (granted, required) => {
    expect(patternCovers(granted, required)).toBe(true);
  });

  it.each([
    ['https://api.example.com/*', 'https://other.example.com/*'],
    ['https://example.com/*', 'http://example.com/*'],
    ['https://example.com/v1/*', 'https://example.com/*'],
    ['*://*.api.example.com/*', '*://*.example.com/*'],
    ['https://example.com/*', '<all_urls>'],
  ])('%s does not cover %s', (granted, required) => {
    expect(patternCovers(granted, required)).toBe(false);
  });

  it('treats the * scheme as http and https only', () => {
    expect(patternCovers('*://example.com/*', 'https://example.com/*')).toBe(true);
    expect(patternCovers('*://example.com/*', 'ws://example.com/*')).toBe(false);
  });
});

describe('missingOrigins', () => {
  it('lists exactly what is not covered', () => {
    const required = ['https://api.example.com/*', 'https://other.test/*'];

    expect(missingOrigins(required, ['*://*.example.com/*'])).toEqual(['https://other.test/*']);
    expect(missingOrigins(required, ['*://*.example.com/*', 'https://other.test/*'])).toEqual([]);
  });
});

describe('patternForDomain', () => {
  it('covers a domain and its subdomains', () => {
    expect(patternForDomain('example.com')).toBe('*://*.example.com/*');
  });

  it('does not put a subdomain wildcard on localhost — that would be a public-suffix wildcard', () => {
    // `*://*.localhost/*` is rejected by the permission policy, and localhost is
    // the host a developer points a header rule at most often.
    expect(patternForDomain('localhost')).toBe('*://localhost/*');
    expect(() => assertOriginIsNarrow(patternForDomain('localhost'))).not.toThrow();
  });

  it('does not put a subdomain wildcard on an IP literal', () => {
    expect(patternForDomain('127.0.0.1')).toBe('*://127.0.0.1/*');
    expect(() => assertOriginIsNarrow(patternForDomain('127.0.0.1'))).not.toThrow();
  });

  it('produces a pattern the permission policy accepts', () => {
    expect(() => assertOriginIsNarrow(patternForDomain('api.example.com'))).not.toThrow();
  });
});

describe('hostnameOf', () => {
  it.each([
    ['example.com', 'example.com'],
    ['https://api.example.com/v1/things', 'api.example.com'],
    ['localhost:3000', 'localhost'],
    ['http://127.0.0.1:8080/', '127.0.0.1'],
    ['  example.com  ', 'example.com'],
  ])('reads %s as %s', (input, expected) => {
    expect(hostnameOf(input)).toBe(expected);
  });

  it.each(['', '   ', 'https://'])('returns null for %s', (input) => {
    expect(hostnameOf(input)).toBeNull();
  });
});

describe('deriveOrigins', () => {
  it('derives site access from a domain condition', () => {
    expect(deriveOrigins([matcher('domain', 'api.example.com')]).origins).toEqual([
      '*://*.api.example.com/*',
    ]);
  });

  it('derives site access from a URL condition', () => {
    expect(deriveOrigins([matcher('url-prefix', 'https://api.example.com/v1/')]).origins).toEqual([
      'https://api.example.com/*',
    ]);
  });

  it('refuses to guess from a regex, rather than escalating to broad access', () => {
    const derived = deriveOrigins([matcher('regex', '.*\\.example\\.com.*')]);

    expect(derived.origins).toEqual([]);
    expect(derived.undecidable).toHaveLength(1);
  });

  it('ignores disabled and empty conditions', () => {
    const derived = deriveOrigins([
      matcher('domain', 'example.com', false),
      matcher('domain', '   '),
    ]);

    expect(derived.origins).toEqual([]);
  });

  it('never derives an origin the permission policy would reject', () => {
    const derived = deriveOrigins([
      matcher('domain', 'example.co.uk'),
      matcher('domain', 'localhost'),
      matcher('url-exact', 'http://127.0.0.1:8080/api'),
    ]);

    for (const origin of derived.origins) {
      expect(() => assertOriginIsNarrow(origin), origin).not.toThrow();
    }
  });
});

describe('patternForPageUrl', () => {
  it('turns the active tab URL into a grantable origin', () => {
    expect(patternForPageUrl('https://app.example.com/dashboard?x=1')).toBe(
      'https://app.example.com/*',
    );
  });

  it.each(['chrome://extensions', 'about:blank', 'file:///tmp/x.html', 'not a url'])(
    'returns null for %s, which cannot be granted',
    (url) => {
      expect(patternForPageUrl(url)).toBeNull();
    },
  );
});
