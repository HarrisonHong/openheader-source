import type { JSX } from 'preact';
import { Spinner } from '../Spinner';

export interface LoadingStateProps {
  /** Describes what is loading. Announced politely to screen readers. */
  label?: string;
}

export function LoadingState({ label = 'Loading' }: LoadingStateProps): JSX.Element {
  return (
    <div class="ui-state" role="status" aria-live="polite">
      <Spinner label={label} />
      <p class="ui-state__body">{label}…</p>
    </div>
  );
}
