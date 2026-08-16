/**
 * Chrome match patterns: parsing, coverage, and derivation from a rule's
 * matchers.
 *
 * `modifyHeaders` applies only where the extension holds host permission for the
 * request URL and — for anything that is not a top-level navigation — for the
 * request's initiator. That is the whole reason competing header editors work on
 * page loads and do nothing on fetch. So permissions have to be reasoned about
 * precisely, per rule, with the missing ones named; `lib/dnr.ts` turns that into
 * a rule status.
 *
 * Every pattern produced here is narrow. `<all_urls>` and wildcard hosts are
 * never generated, and `assertOriginIsNarrow()` in lib/permissions.ts rejects
 * them before anything is requested.
 */

import type { Matcher } from './rules';

export interface ParsedPattern {
  /** `*` means "http and https", matching Chrome's own scheme wildcard. */
  scheme: string;
  /** Host, possibly with a single leading `*.`. Empty for `<all_urls>`. */
  host: string;
  /** Path, always starting with `/`. */
  path: string;
  /** True for the literal `<all_urls>`. */
  allUrls: boolean;
}

const ALL_URLS = '<all_urls>';

/** Schemes Chrome's `*` scheme wildcard expands to for host permissions. */
const WILDCARD_SCHEMES = ['http', 'https'];

/**
 * Parses a Chrome match pattern. Returns `null` for anything malformed rather
 * than throwing — callers are usually comparing a granted permission list that
 * came from the browser, and one odd entry must not break the whole comparison.
 */
export function parseMatchPattern(pattern: string): ParsedPattern | null {
  if (pattern === ALL_URLS) {
    return { scheme: '*', host: '', path: '/*', allUrls: true };
  }

  const match = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!match) return null;

  const scheme = match[1] ?? '';
  const host = match[2] ?? '';
  const path = match[3] ?? '/';

  // `file://` has no host; every other scheme requires one.
  if (host === '' && scheme !== 'file') return null;
  // Chrome permits at most a single leading `*.`.
  if (host.includes('*') && host !== '*' && !/^\*\.[^*]+$/.test(host)) return null;

  return { scheme, host, path, allUrls: false };
}

function schemeCovers(granted: string, required: string): boolean {
  if (granted === required) return true;
  if (granted === '*') return WILDCARD_SCHEMES.includes(required) || required === '*';
  return false;
}

function hostCovers(granted: string, required: string): boolean {
  if (granted === '*') return true;
  if (granted === required) return true;
  if (granted.startsWith('*.')) {
    const base = granted.slice(2);
    const bare = required.startsWith('*.') ? required.slice(2) : required;
    return bare === base || bare.endsWith(`.${base}`);
  }
  // A required `*.example.com` is broader than a granted `example.com`.
  return false;
}

function pathCovers(granted: string, required: string): boolean {
  if (granted === '/*') return true;
  if (granted === required) return true;
  if (granted.endsWith('*')) return required.startsWith(granted.slice(0, -1));
  return false;
}

/** Does the granted pattern cover everything the required pattern would match? */
export function patternCovers(granted: string, required: string): boolean {
  const g = parseMatchPattern(granted);
  const r = parseMatchPattern(required);
  if (!g || !r) return false;
  if (g.allUrls) return true;
  if (r.allUrls) return false;
  return schemeCovers(g.scheme, r.scheme) && hostCovers(g.host, r.host) && pathCovers(g.path, r.path);
}

/** Which of `required` is not covered by any granted pattern. */
export function missingOrigins(
  required: readonly string[],
  granted: readonly string[],
): string[] {
  return required.filter((origin) => !granted.some((have) => patternCovers(have, origin)));
}

/**
 * Covers a hostname and its subdomains: `api.example.com` becomes
 * `*://*.api.example.com/*`, which Chrome reads as "that host and anything
 * under it".
 *
 * Single-label hosts and IP literals get no subdomain wildcard. `*.localhost` is
 * a wildcard over a public suffix and `assertOriginIsNarrow()` rejects it — and
 * `localhost` is the host developers point rules at most, so getting this wrong
 * breaks the primary use case.
 */
export function patternForDomain(host: string): string {
  const bare = stripLeadingDot(host);
  return isSingleLabelOrIp(bare) ? `*://${bare}/*` : `*://*.${bare}/*`;
}

function isSingleLabelOrIp(host: string): boolean {
  if (!host.includes('.')) return true;
  // IPv4 literal. (IPv6 arrives from URL.hostname bracketed, which has no dot.)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Host permission pattern for a concrete URL: scheme + host, whole path. */
export function patternForUrl(url: URL): string {
  return `${url.protocol.replace(':', '')}://${url.hostname}/*`;
}

function stripLeadingDot(host: string): string {
  return host.startsWith('.') ? host.slice(1) : host;
}

/** Normalises user input like `https://api.example.com/v1` down to a hostname. */
export function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(candidate).hostname;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

export interface DerivedOrigins {
  /** Patterns we could work out from the matchers themselves. */
  origins: string[];
  /**
   * Matchers whose site access cannot be derived (a bare regex or substring
   * matches URLs on hosts we cannot enumerate). The user must name the sites,
   * and `lib/dnr.ts` reports the rule as unsupported until they do.
   */
  undecidable: Matcher[];
}

/**
 * Works out which host permissions a rule's matchers imply.
 *
 * A `regex` or `url-contains` matcher yields nothing, deliberately: escalating
 * to broad host access because a pattern is hard to analyse is the shortcut that
 * ends in `<all_urls>`.
 */
export function deriveOrigins(matchers: readonly Matcher[]): DerivedOrigins {
  const origins = new Set<string>();
  const undecidable: Matcher[] = [];

  for (const matcher of matchers) {
    if (!matcher.enabled || matcher.value.trim() === '') continue;

    switch (matcher.kind) {
      case 'domain': {
        const host = hostnameOf(matcher.value);
        if (host) origins.add(patternForDomain(host));
        else undecidable.push(matcher);
        break;
      }
      case 'url-prefix':
      case 'url-exact': {
        const url = parseUrl(matcher.value);
        if (url) origins.add(patternForUrl(url));
        else undecidable.push(matcher);
        break;
      }
      case 'url-contains':
      case 'regex':
        undecidable.push(matcher);
        break;
    }
  }

  return { origins: [...origins].sort(), undecidable };
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}

/**
 * Host permission for the page the user is on. The popup offers this as a
 * one-click grant because for fetch and XHR Chrome also requires access to the
 * initiating page — the most confusing failure in this category.
 */
export function patternForPageUrl(pageUrl: string): string | null {
  const url = parseUrl(pageUrl);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return patternForUrl(url);
}
