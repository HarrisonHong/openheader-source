import { browser } from '#imports';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { sendMessage } from '../../lib/messaging';
import { Button, Panel } from '../../ui';

/**
 * First-run onboarding, opened by the service worker on `onInstalled`.
 *
 * It is also re-opened with `?notice=privacy` when the disclosed data practices
 * change after install — the proactive-notice requirement of the Chrome Web
 * Store policy effective 2026-08-01. The copy below is the user-facing form of
 * docs/single-purpose.md and PRIVACY.md; if either changes materially, this page
 * changes with it and `PRIVACY_DISCLOSURE_VERSION` is bumped.
 */
export function WelcomeApp(): JSX.Element {
  const isPrivacyNotice = new URLSearchParams(globalThis.location.search).get('notice') === 'privacy';
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function acknowledge(): void {
    setError(null);
    void sendMessage('onboarding:complete', {})
      .then(() => setAcknowledged(true))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }

  return (
    <div class="ui-page">
      <div class="ui-stack ui-stack--6">
        <header class="ui-row">
          <img class="ui-brand-mark" src="/icon/48.png" alt="" width={32} height={32} />
          <h1 class="ui-title">
            {isPrivacyNotice ? 'What changed in OpenHeader' : 'Welcome to OpenHeader'}
          </h1>
        </header>

        {isPrivacyNotice ? (
          <p class="ui-callout ui-callout--warning" role="status">
            Our disclosed data practices were updated. Please review the summary below.
          </p>
        ) : null}

        <Panel title="What this extension does">
          <p class="ui-muted">
            It edits the HTTP request and response headers of the sites you choose — on page loads
            and on <span class="ui-mono">fetch</span>/<span class="ui-mono">XHR</span> requests
            alike. Rules live in profiles you can switch between in one click, and every rule tells
            you whether it is actually being applied.
          </p>
        </Panel>

        <Panel title="What it collects">
          <p class="ui-muted">
            Nothing. There is no analytics, no telemetry, no account, and no network request of any
            kind. Your rules are saved with <span class="ui-mono">chrome.storage.local</span>, which
            keeps them on this device — browser sync is deliberately not used, because it would copy
            your rules (and any tokens in them) to a remote server.
          </p>
        </Panel>

        <Panel title="What it can access">
          <p class="ui-muted">
            At install: nothing. It holds no access to any website until you create a rule and grant
            access to the specific sites that rule names, one site at a time, from a button you
            press. You can hand any of it back at any time from the settings page.
          </p>
          <p class="ui-muted">
            It does <strong>not</strong> request the <span class="ui-mono">debugger</span>{' '}
            permission — the one that shows Chrome&rsquo;s most severe install warning and a
            persistent &ldquo;started debugging this browser&rdquo; banner. The only feature that
            needs it, rewriting response <em>bodies</em>, is not part of this extension.
          </p>
        </Panel>

        <Panel title="Coming from ModHeader?">
          <p class="ui-muted">
            Open the settings page and use <strong>Import your rules</strong>. It reads a ModHeader
            export directly, on this device, and tells you exactly what it could and could not bring
            across. Your current rules are backed up first.
          </p>
        </Panel>

        {error ? (
          <p class="ui-callout ui-callout--danger" role="alert">
            {error}
          </p>
        ) : null}

        <div class="ui-row">
          <Button variant="primary" onClick={acknowledge} disabled={acknowledged}>
            {acknowledged ? 'Thanks — you’re all set' : 'Got it'}
          </Button>
          <Button variant="ghost" onClick={() => void browser.runtime.openOptionsPage()}>
            Open settings
          </Button>
        </div>
      </div>
    </div>
  );
}
