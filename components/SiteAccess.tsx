import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { deriveOrigins, hostnameOf, missingOrigins, patternForDomain } from '../lib/match-patterns';
import { requestOrigins, revokeOrigins } from '../lib/permissions';
import type { HeaderRule } from '../lib/rules';
import { Button, Callout, TextField } from '../ui';

export interface SiteAccessProps {
  rule: HeaderRule;
  grantedOrigins: readonly string[];
  onChange: (sites: string[]) => void;
  /** Called after Chrome's answer, so the caller can recompile. */
  onPermissionsChanged: () => void;
}

/**
 * Which sites a rule may touch, and whether Chrome has agreed to it. This is
 * where the product's central trade-off shows: the extension holds no site
 * access at install, so every rule names its own sites and asks for them when it
 * is saved. Asking for every site up front is what the incumbent does, and what
 * these users just left.
 *
 * The note about the initiating page is not decoration. For anything that is not
 * a top-level navigation Chrome requires host access to the page that started
 * the request as well as to the request itself, and not knowing that is the most
 * common reason a header rule "works on the page but not on fetch".
 */
export function SiteAccess({
  rule,
  grantedOrigins,
  onChange,
  onPermissionsChanged,
}: SiteAccessProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`, which belongs to the "Add a site" field: what
  // Chrome said about a grant or a revoke is about the list above, not about
  // that input, and routing it there would mark an untouched field invalid to a
  // screen reader and then throw the explanation away on the next keystroke.
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const derived = deriveOrigins(rule.match).origins;
  const all = [...new Set([...rule.sites, ...derived])].sort();
  const missing = missingOrigins(all, grantedOrigins);

  const add = (): void => {
    const host = hostnameOf(draft);
    if (!host) {
      setError('Enter a site such as api.example.com or https://api.example.com.');
      return;
    }
    const pattern = patternForDomain(host);
    setError(null);
    setDraft('');
    if (!rule.sites.includes(pattern)) onChange([...rule.sites, pattern].sort());
  };

  const grant = (): void => {
    setBusy(true);
    setPermissionError(null);
    // Must run from this click: Chrome refuses a permission prompt that is not
    // tied to a user gesture.
    void requestOrigins(missing).then((result) => {
      setBusy(false);
      if (!result.granted) {
        setPermissionError(
          result.reason === 'denied'
            ? 'Access was declined. The rule stays saved and will start applying if you grant access later.'
            : (result.message ?? 'That access could not be granted.'),
        );
      }
      onPermissionsChanged();
    });
  };

  const revoke = (origin: string): void => {
    setBusy(true);
    setPermissionError(null);
    // A revoke Chrome refuses must say so: leaving it silent would re-render the
    // origin still badged "Granted" with no explanation.
    void revokeOrigins([origin]).then((result) => {
      setBusy(false);
      if (!result.revoked) setPermissionError(result.message);
      onPermissionsChanged();
    });
  };

  return (
    <div class="ui-stack ui-stack--2">
      <div class="ui-stack ui-stack--1">
        <span class="ui-field__label">Site access</span>
        <span class="ui-field__hint">
          This extension asks for nothing at install. A rule only works on the sites listed here,
          and you can hand any of them back at any time.
        </span>
      </div>

      {permissionError ? (
        <Callout tone="danger" live>
          <p>{permissionError}</p>
        </Callout>
      ) : null}

      {all.length === 0 ? (
        <p class="ui-muted">
          No sites yet. Add one below, or use a Domain condition and it will be filled in for you.
        </p>
      ) : (
        <ul class="ui-list">
          {all.map((origin) => {
            const granted = missing.indexOf(origin) === -1;
            const isDerived = !rule.sites.includes(origin);
            return (
              <li key={origin} class="ui-item">
                <div class="ui-row ui-row--between ui-row--wrap">
                  <span class="ui-grow ui-mono ui-truncate" title={origin}>
                    {origin}
                  </span>
                  <span class={`ui-badge ui-badge--${granted ? 'active' : 'warning'}`}>
                    {granted ? 'Granted' : 'Not granted'}
                  </span>
                  {granted ? (
                    <Button variant="ghost" disabled={busy} onClick={() => revoke(origin)}>
                      Revoke
                    </Button>
                  ) : null}
                  {isDerived ? null : (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onChange(rule.sites.filter((site) => site !== origin))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {isDerived ? (
                  <span class="ui-field__hint">Added automatically from this rule&rsquo;s conditions.</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {missing.length > 0 ? (
        <div>
          <Button variant="primary" loading={busy} onClick={grant}>
            Grant access to {missing.length} site{missing.length === 1 ? '' : 's'}
          </Button>
        </div>
      ) : null}

      <div class="ui-row ui-row--top">
        <div class="ui-grow">
          <TextField
            label="Add a site"
            placeholder="api.example.com"
            value={draft}
            error={error ?? undefined}
            hint="Covers that host and its subdomains."
            onValueChange={(value) => {
              setDraft(value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if ((event as KeyboardEvent).key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button onClick={add}>Add</Button>
      </div>

      <Callout tone="info">
        <p>
          For <span class="ui-mono">fetch</span> and <span class="ui-mono">XHR</span> requests
          the browser also needs access to the page that <em>makes</em> the request, not just the
          URL being requested. If a rule looks active but nothing changes on a background request, add
          the site you are testing <em>from</em> as well.
        </p>
      </Callout>
    </div>
  );
}
