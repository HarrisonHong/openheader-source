import type { JSX } from 'preact';
import type { RuleStatus } from '../lib/dnr';
import { Button, Callout } from '../ui';

export interface RuleStatusDetailProps {
  status: RuleStatus | undefined;
  /** Offered when the only thing missing is site access. */
  onGrantAccess?: () => void;
  granting?: boolean;
}

/**
 * The badge says what state a rule is in; this says why, in the same words on
 * every surface. A rule that cannot apply must never look like one that can —
 * that behaviour is the incumbent's worst-reviewed feature.
 */
export function RuleStatusDetail({
  status,
  onGrantAccess,
  granting = false,
}: RuleStatusDetailProps): JSX.Element | null {
  if (!status) return null;

  const hasProblems = status.problems.length > 0;
  const hasWarnings = status.warnings.length > 0;
  const needsAccess = status.state === 'needs-permission';

  if (!hasProblems && !hasWarnings && !needsAccess) return null;

  return (
    <div class="ui-stack ui-stack--2">
      {hasProblems ? (
        <Callout tone="danger" title="This rule will not be applied">
          <ul class="ui-stack ui-stack--1">
            {status.problems.map((problem) => (
              <li key={`${problem.code}-${problem.matcherId ?? problem.headerId ?? ''}`}>
                {problem.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {needsAccess ? (
        <Callout tone="warning" title="Waiting for site access">
          <p>
            An extension cannot change headers on a site you have not granted access to. This
            rule needs:
          </p>
          <ul class="ui-stack ui-stack--1">
            {status.missingOrigins.map((origin) => (
              <li key={origin} class="ui-mono">
                {origin}
              </li>
            ))}
          </ul>
          {onGrantAccess ? (
            <div>
              <Button variant="primary" loading={granting} onClick={onGrantAccess}>
                Grant access
              </Button>
            </div>
          ) : null}
        </Callout>
      ) : null}

      {hasWarnings ? (
        <Callout tone="info" title="Worth knowing">
          <ul class="ui-stack ui-stack--1">
            {status.warnings.map((warning) => (
              <li key={`${warning.code}-${warning.matcherId ?? warning.headerId ?? ''}`}>
                {warning.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </div>
  );
}
