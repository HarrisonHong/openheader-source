import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  OPTIONAL_PERMISSIONS,
  PermissionPolicyError,
  assertOriginIsNarrow,
  hasPermission,
  revokeOrigins,
} from './permissions';

describe('optional permission registry', () => {
  it('is empty in the foundation build', () => {
    // Empty by design: no shipped feature needs an optional API permission, and
    // the one that would (response-body rewriting, which forces `debugger`) is
    // deliberately not built. When this fails, the change had better come with a
    // new row in docs/permissions.md.
    expect(Object.keys(OPTIONAL_PERMISSIONS)).toEqual([]);
  });

  it('refuses to request a permission that is not in the registry', async () => {
    await expect(hasPermission('activeTab' as never)).rejects.toBeInstanceOf(PermissionPolicyError);
  });
});

describe('assertOriginIsNarrow', () => {
  it.each([
    '<all_urls>',
    '*://*/*',
    'http://*/*',
    'https://*/*',
    'file:///*',
    'https://*/',
    '*://*.com/*',
  ])('rejects the over-broad pattern %s', (origin) => {
    expect(() => assertOriginIsNarrow(origin)).toThrow(PermissionPolicyError);
  });

  it.each([
    // A wildcard over a public suffix spans every registrable domain under it,
    // which is a wildcard TLD wearing a second label.
    'https://*.co.uk/*',
    '*://*.com.au/*',
    'https://*.org.uk/*',
    'https://*.ne.jp/*',
    // Anyone can register under these, so the wildcard spans unrelated parties.
    '*://*.github.io/*',
    'https://*.pages.dev/*',
    'https://*.vercel.app/*',
    // Malformed wildcards that are unbounded if honoured.
    'https://*./*',
    'https://sub.*.example.com/*',
    'https://*.*.example.com/*',
    // Chrome matches the host component case-insensitively: with only
    // `*://*.co.uk/*` granted, `permissions.contains({origins:
    // ['*://*.CO.UK/*']})` answers true — verified in Chrome 151. The lists this
    // check consults are lowercase, so an un-normalised host let the shouted
    // spelling through and asked Chrome for the identical access the quiet one
    // is refused. Every entry below is the same permission as one above it.
    '*://*.CO.UK/*',
    '*://*.Co.Uk/*',
    'https://*.COM.AU/*',
    '*://*.GITHUB.IO/*',
    '*://*.GitHub.io/*',
    'https://*.vercel.App/*',
    'https://*.PAGES.DEV/*',
    '*://*.COM/*',
    '*://*.Com/*',
  ])('rejects the wildcard-suffix pattern %s', (origin) => {
    expect(() => assertOriginIsNarrow(origin)).toThrow(PermissionPolicyError);
  });

  it('agrees with itself whatever case the host is written in', () => {
    // The property, rather than a list: if two spellings are one permission to
    // Chrome, this policy must give them one answer. A future entry added to
    // PUBLIC_SUFFIXES in lowercase only cannot reintroduce the gap.
    //
    // Only the HOST is varied. Chrome is case-insensitive there and nowhere
    // else — an upper-cased scheme (`HTTPS://…`) is an invalid pattern Chrome
    // rejects outright, so refusing it as malformed is the correct answer and
    // not part of this property.
    const accepts = (value: string): boolean => {
      try {
        assertOriginIsNarrow(value);
        return true;
      } catch {
        return false;
      }
    };
    const shoutHost = (origin: string): string =>
      origin.replace(/^([^:]+:\/\/)([^/]*)/, (_all, scheme: string, host: string) =>
        `${scheme}${host.toUpperCase()}`,
      );

    for (const origin of [
      '*://*.co.uk/*',
      '*://*.github.io/*',
      '*://*.vercel.app/*',
      '*://*.com/*',
      '*://*.example.com/*',
      '*://*.myorg.github.io/*',
      'https://api.example.co.uk/v1/*',
      'https://localhost/*',
    ]) {
      expect(accepts(shoutHost(origin)), shoutHost(origin)).toBe(accepts(origin));
    }
  });

  it.each([
    'https://example.com/*',
    'https://*.example.com/*',
    'https://api.example.com/v1/*',
    // Legitimate subdomain wildcards over a real registrable domain, including
    // one that sits under a multi-label public suffix.
    'https://*.example.co.uk/*',
    'https://*.myorg.github.io/*',
    'https://*.deep.sub.example.com/*',
    'https://localhost/*',
    // Normalising the host must not start refusing legitimate patterns just
    // because someone typed them with capitals.
    'https://*.EXAMPLE.COM/*',
    'https://API.Example.com/v1/*',
  ])('accepts the specific origin %s', (origin) => {
    expect(() => assertOriginIsNarrow(origin)).not.toThrow();
  });

  it('rejects a malformed pattern', () => {
    expect(() => assertOriginIsNarrow('example.com')).toThrow(PermissionPolicyError);
  });
});

/**
 * A revoke that quietly did nothing is the same class of bug as a rule that
 * quietly stops applying, so `revokeOrigins` answers rather than throwing or
 * shrugging. Chrome refuses `permissions.remove()` for a pattern it was not
 * granted under — which is precisely a derived origin covered by a broader
 * standing grant — and can also resolve `false` having removed nothing.
 */
describe('revokeOrigins', () => {
  /**
   * `fakeBrowser.permissions.remove` is typed callback-style, so its answer has
   * to be handed over the declared return type rather than through
   * `mockResolvedValue`.
   */
  function whenChrome(outcome: { removes: boolean } | { rejects: Error }) {
    return vi.spyOn(fakeBrowser.permissions, 'remove').mockImplementation(
      (() =>
        'removes' in outcome
          ? Promise.resolve(outcome.removes)
          : Promise.reject(outcome.rejects)) as never,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports success when Chrome hands the access back', async () => {
    whenChrome({ removes: true });

    await expect(revokeOrigins(['https://api.example.com/*'])).resolves.toEqual({ revoked: true });
  });

  it('says nothing was removed rather than leaving the row looking granted', async () => {
    whenChrome({ removes: false });

    await expect(revokeOrigins(['https://app.example.com/*'])).resolves.toEqual({
      revoked: false,
      reason: 'kept',
      message: expect.stringContaining('https://app.example.com/*'),
    });
  });

  it('turns a rejection into a result instead of an unhandled rejection', async () => {
    whenChrome({ rejects: new Error('You cannot remove permissions that were not granted') });

    await expect(revokeOrigins(['https://app.example.com/*'])).resolves.toEqual({
      revoked: false,
      reason: 'error',
      message: expect.stringContaining('cannot remove permissions'),
    });
  });

  it('is a no-op for an empty list rather than a call to Chrome', async () => {
    const remove = whenChrome({ removes: true });

    await expect(revokeOrigins([])).resolves.toEqual({ revoked: true });
    expect(remove).not.toHaveBeenCalled();
  });
});
