/**
 * Runtime optional-permission requests.
 *
 * The manifest ships the smallest `permissions` array it can; anything not
 * needed to start belongs in `optional_permissions` and is requested here, at
 * the point of use, from a user gesture. Nothing can be requested without an
 * entry in `OPTIONAL_PERMISSIONS` carrying a user-facing justification — the
 * same sentence that appears as a row in docs/permissions.md. `<all_urls>` and
 * wildcard hosts are rejected at runtime, not merely discouraged.
 */

import { browser } from '#imports';

export interface OptionalPermissionSpec {
  /** Stable id used in code and in the docs/permissions.md table. */
  readonly id: string;
  /** API permissions to request. */
  readonly permissions?: readonly string[];
  /** Host permissions to request. Must be specific origins. */
  readonly origins?: readonly string[];
  /**
   * Shown in the UI immediately before Chrome's own prompt. Required: an
   * unexplained prompt is a declined prompt.
   */
  readonly justification: string;
  /** What breaks if the user declines. Must degrade, never crash. */
  readonly declineBehaviour: string;
}

/**
 * Empty by design. No shipped feature needs an optional API permission, and the
 * one that would — response-body rewriting, which forces `debugger` — is
 * deliberately not built. An entry here without a matching row in
 * docs/permissions.md is a review failure.
 */
export const OPTIONAL_PERMISSIONS = {} as const satisfies Record<string, OptionalPermissionSpec>;

export type OptionalPermissionId = keyof typeof OPTIONAL_PERMISSIONS;

/** Origin patterns that are never acceptable, regardless of justification. */
const FORBIDDEN_ORIGIN_PATTERNS = [
  '<all_urls>',
  '*://*/*',
  'http://*/*',
  'https://*/*',
  '*://*/',
  'file:///*',
];

export class PermissionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionPolicyError';
  }
}

/**
 * Registry-operated labels that sit directly under a two-letter ccTLD. A
 * wildcard over one of these (`*.co.uk`) spans every registrable domain in that
 * country, exactly like a wildcard TLD.
 */
const SECOND_LEVEL_REGISTRY_LABELS = new Set([
  'ac',
  'biz',
  'co',
  'com',
  'edu',
  'go',
  'gov',
  'info',
  'me',
  'mil',
  'ne',
  'net',
  'or',
  'org',
]);

/**
 * Multi-label suffixes anyone can register under, so a wildcard over them spans
 * unrelated parties. Deliberately not the full Public Suffix List: that is a
 * moving 10k-line dataset and a dependency this build does without. Add entries
 * as real requests need them — the failure mode is a false rejection, never a
 * false acceptance of a bare TLD.
 */
const PUBLIC_SUFFIXES = new Set([
  'appspot.com',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'firebaseapp.com',
  'github.io',
  'gitlab.io',
  'glitch.me',
  'herokuapp.com',
  'netlify.app',
  'onrender.com',
  'pages.dev',
  'r2.dev',
  'sourceforge.io',
  'surge.sh',
  'trycloudflare.com',
  'vercel.app',
  'web.app',
  'workers.dev',
]);

/**
 * Is `host` a suffix that many unrelated parties register under, rather than one
 * party's registrable domain? `example.com` is not; `com`, `co.uk` and
 * `github.io` are.
 */
function isPublicSuffix(host: string): boolean {
  // Both sets below are lowercase and Chrome's host matching is case-insensitive,
  // so an un-normalised host would let `*.CO.UK` through the check that `*.co.uk`
  // fails while asking Chrome for the identical permission. Normalised here as
  // well as at the caller because this function is the one holding the lists.
  const labels = host.toLowerCase().split('.');
  // A single label is a bare TLD: `*.com`.
  if (labels.length < 2) return true;
  if (PUBLIC_SUFFIXES.has(labels.join('.'))) return true;
  if (labels.length === 2) {
    const [secondLevel = '', tld = ''] = labels;
    // `*.co.uk`, `*.com.au`, `*.ne.jp` — registry label under a ccTLD.
    if (tld.length === 2 && SECOND_LEVEL_REGISTRY_LABELS.has(secondLevel)) return true;
  }
  return false;
}

/**
 * Over-broad means: on the deny list, a bare wildcard host, or a leading `*.`
 * covering a public suffix rather than one registrable domain. Exported so the
 * policy itself is testable.
 */
export function assertOriginIsNarrow(origin: string): void {
  if (FORBIDDEN_ORIGIN_PATTERNS.includes(origin)) {
    throw new PermissionPolicyError(
      `Refusing over-broad host permission "${origin}". Request specific origins instead. See docs/permissions.md.`,
    );
  }

  const match = /^(\*|https?|wss?|file|ftp):\/\/([^/]*)/.exec(origin);
  if (!match) {
    throw new PermissionPolicyError(`Refusing malformed host permission "${origin}".`);
  }

  // Lower-cased before anything looks at it. Chrome match patterns are
  // case-insensitive in the host component — with only `*://*.co.uk/*` granted,
  // `permissions.contains({origins: ['*://*.CO.UK/*']})` answers true — so a
  // case-sensitive check here would refuse a pattern and then accept the very
  // same permission spelled differently. Verified against Chrome 151.
  const host = (match[2] ?? '').toLowerCase();
  const refuse = (): never => {
    throw new PermissionPolicyError(
      `Refusing wildcard host "${origin}". Name the specific host. See docs/permissions.md.`,
    );
  };

  if (host === '' || host === '*') refuse();

  if (host.includes('*')) {
    // Chrome permits only a single leading `*.`; anything else is malformed and,
    // if honoured, unbounded.
    if (!host.startsWith('*.')) refuse();

    const covered = host.slice(2);
    // `*.example.com` names one registrable domain and is fine.
    // `*.com`, `*.co.uk` and `*.github.io` each span the open internet.
    if (covered.includes('*') || covered.split('.').includes('') || isPublicSuffix(covered)) {
      refuse();
    }
  }
}

function specOf(id: OptionalPermissionId): OptionalPermissionSpec {
  const spec = (OPTIONAL_PERMISSIONS as Record<string, OptionalPermissionSpec | undefined>)[
    id as string
  ];
  if (!spec) {
    throw new PermissionPolicyError(
      `Unknown optional permission "${String(id)}". Declare it in lib/permissions.ts with a justification and add a row to docs/permissions.md.`,
    );
  }
  spec.origins?.forEach(assertOriginIsNarrow);
  return spec;
}

interface PermissionSet {
  permissions: string[];
  origins: string[];
}

/**
 * `browser.permissions` is typed against the generated union of manifest
 * permission literals. This registry is string-keyed on purpose, so a permission
 * cannot be added without going through `OptionalPermissionSpec` and therefore
 * without a justification. The policy check lives in `assertOriginIsNarrow`, not
 * in the type.
 */
const permissionsApi = browser.permissions as unknown as {
  contains(set: PermissionSet): Promise<boolean>;
  request(set: PermissionSet): Promise<boolean>;
  remove(set: PermissionSet): Promise<boolean>;
  getAll(): Promise<{ permissions?: string[]; origins?: string[] }>;
};

function toRequest(spec: OptionalPermissionSpec): PermissionSet {
  return {
    permissions: [...(spec.permissions ?? [])],
    origins: [...(spec.origins ?? [])],
  };
}

/** Has the user already granted this permission set? */
export async function hasPermission(id: OptionalPermissionId): Promise<boolean> {
  return permissionsApi.contains(toRequest(specOf(id)));
}

export type PermissionRequestResult =
  | { granted: true }
  | { granted: false; reason: 'denied' | 'error'; message?: string };

/**
 * Request an optional permission.
 *
 * Must be called synchronously from a click handler — Chrome rejects the prompt
 * otherwise. Show the spec's `justification` first, so Chrome's prompt is never
 * the first the user hears of it.
 */
export async function requestPermission(
  id: OptionalPermissionId,
): Promise<PermissionRequestResult> {
  const spec = specOf(id);
  try {
    const granted = await permissionsApi.request(toRequest(spec));
    return granted ? { granted: true } : { granted: false, reason: 'denied' };
  } catch (cause) {
    return {
      granted: false,
      reason: 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Give a permission back. Offer this wherever a permission was requested. */
export async function revokePermission(id: OptionalPermissionId): Promise<boolean> {
  return permissionsApi.remove(toRequest(specOf(id)));
}

/** Everything currently granted, for the options page transparency panel. */
export async function listGrantedPermissions(): Promise<{
  permissions: string[];
  origins: string[];
}> {
  const granted = await permissionsApi.getAll();
  return {
    permissions: [...(granted.permissions ?? [])],
    origins: [...(granted.origins ?? [])],
  };
}

// User-named host permissions. A rule names its own sites, so these origins are
// not knowable at build time and cannot live in the static registry above. They
// still go through the same policy: `assertOriginIsNarrow()` runs on every
// pattern before anything is requested, so no rule can talk the extension into
// asking for `<all_urls>` or a wildcard TLD. The manifest declares no host
// permissions at all — everything here is requested when a rule needs it, from a
// click, and can be handed back. See docs/permissions.md.

export type OriginRequestResult =
  | { granted: true }
  | { granted: false; reason: 'denied' | 'error' | 'policy'; message?: string };

function assertNarrowOrigins(origins: readonly string[]): void {
  origins.forEach(assertOriginIsNarrow);
}

/** Host permissions Chrome currently reports as granted. */
export async function grantedOrigins(): Promise<string[]> {
  const granted = await permissionsApi.getAll();
  return [...(granted.origins ?? [])];
}

/**
 * Must be called synchronously from a user gesture — Chrome silently refuses the
 * prompt otherwise, and a prompt that never appears is the failure mode this
 * product exists to avoid.
 */
export async function requestOrigins(origins: readonly string[]): Promise<OriginRequestResult> {
  if (origins.length === 0) return { granted: true };

  try {
    assertNarrowOrigins(origins);
  } catch (cause) {
    return {
      granted: false,
      reason: 'policy',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  try {
    const granted = await permissionsApi.request({ permissions: [], origins: [...origins] });
    return granted ? { granted: true } : { granted: false, reason: 'denied' };
  } catch (cause) {
    return {
      granted: false,
      reason: 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export type OriginRevokeResult =
  | { revoked: true }
  | { revoked: false; reason: 'kept' | 'error'; message: string };

/**
 * Hand site access back. Offered next to every grant.
 *
 * Returns a result rather than a bare boolean, and never rejects, because Chrome
 * has two ways to not revoke: it throws for a pattern it was not granted under —
 * which `https://app.example.com/*` is when the standing grant is the broader
 * `*://*.example.com/*` — and it can also resolve `false` having removed
 * nothing. Either way the caller has to be able to say so, or the UI leaves a
 * "Granted" badge up over a revoke that did nothing.
 */
export async function revokeOrigins(origins: readonly string[]): Promise<OriginRevokeResult> {
  if (origins.length === 0) return { revoked: true };

  try {
    const removed = await permissionsApi.remove({ permissions: [], origins: [...origins] });
    if (removed) return { revoked: true };
    return {
      revoked: false,
      reason: 'kept',
      message:
        `Chrome kept access to ${origins.join(', ')}. That happens when the access comes from a ` +
        'broader grant covering this site — revoke that one instead, or remove it from chrome://extensions.',
    };
  } catch (cause) {
    return {
      revoked: false,
      reason: 'error',
      message: `Chrome would not hand back ${origins.join(', ')}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}
