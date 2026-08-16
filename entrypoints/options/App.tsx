import { browser } from '#imports';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BackupsPanel } from '../../components/BackupsPanel';
import { EngineAlerts } from '../../components/EngineAlerts';
import { ExportPanel } from '../../components/ExportPanel';
import { ImportPanel } from '../../components/ImportPanel';
import { ProfilesPanel } from '../../components/ProfilesPanel';
import { RulesPanel } from '../../components/RulesPanel';
import { useRulesState } from '../../components/useRulesState';
import { listGrantedPermissions, revokeOrigins } from '../../lib/permissions';
import type { ShortcutDefinition } from '../../ui';
import {
  Button,
  Callout,
  ErrorState,
  LoadingState,
  Panel,
  ShortcutList,
  useAsync,
} from '../../ui';

/**
 * The full rule workbench.
 *
 * Layout is a single scrolling column of labelled panels rather than tabs: every
 * surface stays in the accessibility tree and reachable by Tab, and a rule that
 * has a problem cannot be hidden behind a tab the user never opens.
 */

const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: '_execute_action', description: 'Open the extension popup', keys: ['Alt', 'Shift', 'E'] },
  { id: 'popup-navigate', description: 'Move between controls', keys: ['Tab'] },
  { id: 'popup-activate', description: 'Activate the focused control', keys: ['Enter'] },
  { id: 'popup-toggle', description: 'Toggle the focused switch', keys: ['Space'] },
  { id: 'popup-close', description: 'Close the popup', keys: ['Esc'] },
];

export function OptionsApp(): JSX.Element {
  const rules = useRulesState();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Follow the document: the first profile is selected once loaded, and a
  // selection that no longer exists (deleted, replaced by an import) falls back
  // rather than rendering an empty panel.
  useEffect(() => {
    if (!rules.document) return;
    const known = rules.document.profiles.some((profile) => profile.id === selectedProfileId);
    if (!known) setSelectedProfileId(rules.document.profiles[0]?.id ?? null);
  }, [rules.document, selectedProfileId]);

  const profile = rules.document?.profiles.find((entry) => entry.id === selectedProfileId);

  return (
    <div class="ui-page">
      <a class="ui-skip-link" href="#settings">
        Skip to your rules
      </a>

      <div class="ui-stack ui-stack--6">
        <header class="ui-stack ui-stack--1">
          <h1 class="ui-title">OpenHeader</h1>
          <p class="ui-muted">
            Everything below is stored on this device only. There is no account, no telemetry and no
            network request of any kind.
          </p>
        </header>

        <main id="settings" class="ui-stack ui-stack--4">
          <EngineAlerts engine={rules.engine} saveError={rules.saveError} />

          {rules.phase === 'loading' ? (
            <Panel title="Rules">
              <LoadingState label="Loading your rules" />
            </Panel>
          ) : null}

          {rules.phase === 'error' ? (
            <Panel title="Rules">
              <ErrorState
                title="Could not reach the extension service worker"
                detail={rules.loadError ?? undefined}
                onRetry={rules.refresh}
              />
            </Panel>
          ) : null}

          {rules.document && selectedProfileId ? (
            <>
              <ProfilesPanel
                document={rules.document}
                selectedProfileId={selectedProfileId}
                onSelect={setSelectedProfileId}
                onChange={(change, deferred) =>
                  deferred ? rules.updateDeferred(change) : rules.update(change)
                }
              />

              {profile ? (
                <RulesPanel
                  profile={profile}
                  statuses={rules.statuses}
                  grantedOrigins={rules.engine?.grantedOrigins ?? []}
                  onChange={(change, deferred) =>
                    deferred ? rules.updateDeferred(change) : rules.update(change)
                  }
                  onPermissionsChanged={rules.refresh}
                />
              ) : null}

              <ImportPanel onImported={rules.replace} />
              <ExportPanel document={rules.document} />
            </>
          ) : null}

          <BackupsPanel onRestored={rules.replace} />
          <ShortcutsPanel />
          <PermissionsPanel onPermissionsChanged={rules.refresh} />
          <PrivacyPanel />
        </main>
      </div>
    </div>
  );
}

function ShortcutsPanel(): JSX.Element {
  return (
    <Panel
      title="Keyboard shortcuts"
      description="Every surface is fully operable from the keyboard."
    >
      <ShortcutList shortcuts={SHORTCUTS} />
      <Button
        variant="secondary"
        onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
      >
        Change browser shortcuts
      </Button>
    </Panel>
  );
}

/**
 * What the extension currently holds — and the way to hand it back.
 *
 * The revoke control lives here as well as on each rule because a rule's own
 * panel can only offer the origins that rule lists. Delete the rule, or narrow
 * it, and the grant outlives it with nowhere else to reach it — this panel is
 * that somewhere else.
 */
function PermissionsPanel({ onPermissionsChanged }: { onPermissionsChanged: () => void }): JSX.Element {
  const { state, reload } = useAsync(() => listGrantedPermissions(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = (origin: string): void => {
    setBusy(origin);
    setRevokeError(null);
    // `revokeOrigins` never rejects: a refusal comes back as a result so a
    // revoke that did nothing says so instead of leaving the row unchanged.
    void revokeOrigins([origin]).then((result) => {
      setBusy(null);
      if (!result.revoked) setRevokeError(result.message);
      reload();
      // Handing an origin back changes which rules can apply, so the page has to
      // recompile. Without this a rule keeps reading "Active" for access it no
      // longer has.
      onPermissionsChanged();
    });
  };

  return (
    <Panel
      title="Permissions"
      description="Site access is requested one site at a time, when a rule needs it, and can be revoked here or on any rule."
    >
      <Callout tone="info">
        <p>
          This extension does not request the <span class="ui-mono">debugger</span> permission. That
          is the permission that triggers Chrome&rsquo;s most severe install warning and the
          persistent &ldquo;started debugging this browser&rdquo; banner, and the only feature that
          needs it — rewriting response <em>bodies</em> — is not part of this extension. If it is
          ever added it will be an opt-in module that asks at the moment you use it and can be
          revoked afterwards.
        </p>
      </Callout>

      {revokeError ? (
        <Callout tone="danger" live>
          <p>{revokeError}</p>
        </Callout>
      ) : null}

      {state.status === 'loading' ? <LoadingState label="Reading granted permissions" /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Could not read permissions" detail={state.error.message} onRetry={reload} />
      ) : null}
      {state.status === 'success' ? (
        <div class="ui-stack ui-stack--2">
          <p class="ui-muted">
            API permissions: <span class="ui-mono">{format(state.value.permissions)}</span>
          </p>

          <div class="ui-stack ui-stack--1">
            <span class="ui-field__label">Site access</span>
            {state.value.origins.length === 0 ? (
              <p class="ui-muted">
                No site access has been granted. Rules ask for the sites they name, one at a time.
              </p>
            ) : (
              <ul class="ui-list">
                {state.value.origins.map((origin) => (
                  <li key={origin} class="ui-item">
                    <div class="ui-row ui-row--between ui-row--wrap">
                      <span class="ui-grow ui-mono ui-truncate" title={origin}>
                        {origin}
                      </span>
                      <Button
                        variant="ghost"
                        loading={busy === origin}
                        disabled={busy !== null && busy !== origin}
                        onClick={() => revoke(origin)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function PrivacyPanel(): JSX.Element {
  return (
    <Panel title="Privacy">
      <p class="ui-muted">
        This extension collects no data, contains no analytics, and makes no network requests. All
        state is stored locally with <span class="ui-mono">chrome.storage.local</span>; browser sync
        storage is deliberately not used because it would copy your data to a remote server. Your
        rules — which often contain tokens and cookies — never leave this device unless you export
        them yourself.
      </p>
    </Panel>
  );
}

function format(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
