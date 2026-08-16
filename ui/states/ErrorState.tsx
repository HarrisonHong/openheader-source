import type { JSX } from 'preact';
import { Button } from '../Button';

export interface ErrorStateProps {
  title: string;
  /**
   * Technical detail. Shown verbatim — storage and messaging failures are
   * supposed to be loud, not swallowed.
   */
  detail?: string | undefined;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = 'Try again',
}: ErrorStateProps): JSX.Element {
  return (
    <div class="ui-state" role="alert">
      <span class="ui-state__icon" aria-hidden="true">
        {'!'}
      </span>
      <p class="ui-state__title">{title}</p>
      {detail ? <p class="ui-state__body ui-mono">{detail}</p> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
