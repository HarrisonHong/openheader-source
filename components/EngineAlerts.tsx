import type { JSX } from 'preact';
import { Callout } from '../ui';
import type { EngineSummary } from './useRulesState';

export interface EngineAlertsProps {
  engine: EngineSummary | null;
  saveError: string | null;
}

/**
 * Everything that went wrong below the level of a single rule: the browser
 * refused the rule set, the browser kept something other than what we installed,
 * the stored rules were unreadable, or a save failed. Unsaid, all four look
 * identical to "the extension just stopped working".
 */
export function EngineAlerts({ engine, saveError }: EngineAlertsProps): JSX.Element | null {
  if (!engine && !saveError) return null;

  const alerts: JSX.Element[] = [];

  if (saveError) {
    alerts.push(
      <Callout key="save" tone="danger" title="Not saved" live>
        <p>{saveError}</p>
      </Callout>,
    );
  }

  if (engine?.recoveryError) {
    alerts.push(
      <Callout key="recovery" tone="danger" title="Your saved rules could not be read">
        <p>{engine.recoveryError}</p>
        {engine.quarantinedAt ? (
          <p>
            Nothing was thrown away. The unreadable record was kept at{' '}
            <span class="ui-mono">{engine.quarantinedAt}</span>, and you can restore an earlier
            snapshot from Backups below.
          </p>
        ) : (
          <p>Check Backups below — an earlier snapshot may still be there.</p>
        )}
      </Callout>,
    );
  }

  if (engine?.engineError) {
    alerts.push(
      <Callout key="engine" tone="danger" title="The browser refused your rules">
        <p>{engine.engineError}</p>
      </Callout>,
    );
  }

  if (engine && !engine.verification.ok && engine.verification.detail) {
    alerts.push(
      <Callout key="verify" tone="warning" title="The browser did not keep what we installed">
        <p>
          After installing your rules we read them back out of Chrome and they did not match:{' '}
          {engine.verification.detail} Your rules may not be applying. Reloading the extension
          usually clears this.
        </p>
      </Callout>,
    );
  }

  if (alerts.length === 0) return null;

  return <div class="ui-stack ui-stack--2">{alerts}</div>;
}
