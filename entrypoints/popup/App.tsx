import { browser } from '#imports';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { EngineAlerts } from '../../components/EngineAlerts';
import { useRulesState } from '../../components/useRulesState';
import { missingOrigins, patternForPageUrl } from '../../lib/match-patterns';
import { requestOrigins } from '../../lib/permissions';
import type { RuleStatus } from '../../lib/dnr';
import type { HeaderRule, Profile, RulesDocument } from '../../lib/rules';
import { isProfileActive, setProfileActive, setRuleEnabled, switchToProfile } from '../../lib/rules';
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  Switch,
  useAsync,
} from '../../ui';

/**
 * The popup: switch profile, see at a glance whether every rule is actually
 * applying, and fix the one thing that most often stops them — site access for
 * the page you are on.
 *
 * Deliberately not a rule editor. Editing lives on the options page, where there
 * is room to show a rule's conditions and its status side by side.
 */
export function PopupApp(): JSX.Element {
  const rules = useRulesState();

  return (
    <div class="ui-popup">
      <header class="ui-popup__header">
        <img class="ui-brand-mark" src="/icon/32.png" alt="" width={20} height={20} />
        <h1 class="ui-heading">Headerman</h1>
      </header>

      <main class="ui-popup__body" id="popup-main">
        <div class="ui-stack ui-stack--3">
          <EngineAlerts engine={rules.engine} saveError={rules.saveError} />

          {rules.phase === 'loading' ? (
            <LoadingState label="Loading your rules" />
          ) : null}

          {rules.phase === 'error' ? (
            <ErrorState
              title="Could not reach the service worker"
              detail={rules.loadError ?? undefined}
              onRetry={rules.refresh}
            />
          ) : null}

          {rules.document ? (
            <>
              <CurrentSiteAccess
                grantedOrigins={rules.engine?.grantedOrigins ?? []}
                onGranted={rules.refresh}
              />
              <ProfileSwitcher document={rules.document} onChange={rules.update} />
              <ActiveRules
                document={rules.document}
                statuses={rules.statuses}
                onChange={rules.update}
              />
            </>
          ) : null}
        </div>
      </main>

      <footer class="ui-popup__footer">
        <div class="ui-row ui-row--between">
          <span>
            {rules.engine ? `${rules.engine.installedRuleCount} browser rule(s) applied` : ' '}
          </span>
          <Button variant="ghost" onClick={() => void browser.runtime.openOptionsPage()}>
            Manage rules
          </Button>
        </div>
      </footer>
    </div>
  );
}

/**
 * Site access for the tab the user is looking at.
 *
 * One specific Chrome behaviour puts this here: for anything that is not a
 * top-level navigation, header rules also need access to the page that made the
 * request. Without this button that fix is invisible and the rule just looks
 * broken.
 */
function CurrentSiteAccess({
  grantedOrigins,
  onGranted,
}: {
  grantedOrigins: readonly string[];
  onGranted: () => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  // `activeTab` gives us this tab's URL because the user just opened the popup.
  const { state } = useAsync(
    () => browser.tabs.query({ active: true, currentWindow: true }),
    [],
  );

  if (state.status !== 'success') return null;

  const url = state.value[0]?.url ?? '';
  const pattern = patternForPageUrl(url);
  if (!pattern) return null;
  // Coverage, not string equality: this page's pattern is concrete
  // (`https://www.example.com/*`) while a grant made from a domain matcher is
  // `*://*.example.com/*`. Comparing them literally would announce missing
  // access the extension already holds.
  if (missingOrigins([pattern], grantedOrigins).length === 0) return null;

  const host = new URL(url).hostname;

  return (
    <Callout tone="info">
      <p>
        Rules can only change headers on sites you have granted access to, and{' '}
        <strong>{host}</strong> is not one of them yet.
      </p>
      {declined ? <p>Access was declined. You can grant it later from any rule.</p> : null}
      <div>
        <Button
          variant="primary"
          loading={busy}
          onClick={() => {
            setBusy(true);
            setDeclined(false);
            void requestOrigins([pattern]).then((result) => {
              setBusy(false);
              if (!result.granted) setDeclined(true);
              onGranted();
            });
          }}
        >
          Allow on {host}
        </Button>
      </div>
    </Callout>
  );
}

function ProfileSwitcher({
  document,
  onChange,
}: {
  document: RulesDocument;
  onChange: (change: (document: RulesDocument) => RulesDocument) => void;
}): JSX.Element {
  return (
    <section class="ui-stack ui-stack--2" aria-label="Profiles">
      <h2 class="ui-field__label">Profiles</h2>
      <ul class="ui-list">
        {document.profiles.map((profile) => (
          <li key={profile.id} class="ui-item">
            <div class="ui-row ui-row--between ui-row--wrap">
              <Switch
                label={profile.name}
                checked={isProfileActive(document, profile.id)}
                onChange={(on) => onChange((current) => setProfileActive(current, profile.id, on))}
              />
              <Button
                variant="ghost"
                onClick={() => onChange((current) => switchToProfile(current, profile.id))}
              >
                Only this
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActiveRules({
  document,
  statuses,
  onChange,
}: {
  document: RulesDocument;
  statuses: Map<string, RuleStatus>;
  onChange: (change: (document: RulesDocument) => RulesDocument) => void;
}): JSX.Element {
  const visible: Array<{ profile: Profile; rule: HeaderRule }> = document.profiles
    .filter((profile) => isProfileActive(document, profile.id))
    .flatMap((profile) => profile.rules.map((rule) => ({ profile, rule })));

  if (visible.length === 0) {
    return (
      <EmptyState
        title="No rules in your active profiles"
        body="Add a rule to start changing request or response headers on the sites you choose."
        action={
          <Button variant="primary" onClick={() => void browser.runtime.openOptionsPage()}>
            Create a rule
          </Button>
        }
      />
    );
  }

  return (
    <section class="ui-stack ui-stack--2" aria-label="Rules">
      <h2 class="ui-field__label">Rules</h2>
      <ul class="ui-list">
        {visible.map(({ rule }) => {
          const status = statuses.get(rule.id);
          return (
            <li key={rule.id} class="ui-item ui-stack ui-stack--1">
              <div class="ui-row ui-row--between ui-row--wrap">
                <Switch
                  label={rule.name || 'Untitled rule'}
                  checked={rule.enabled}
                  onChange={(enabled) =>
                    onChange((current) => setRuleEnabled(current, rule.id, enabled))
                  }
                />
                <StatusBadge
                  state={status?.state ?? 'inactive'}
                  hasWarnings={(status?.warnings.length ?? 0) > 0}
                />
              </div>
              {/* The reason is always visible — a rule that is not applying must
                  never look the same as one that is. */}
              {status && status.state !== 'active' ? (
                <p class="ui-muted">{status.summary}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
