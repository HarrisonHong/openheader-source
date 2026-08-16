import type { ComponentChildren, JSX } from 'preact';

export interface EmptyStateProps {
  title: string;
  body?: string;
  /** Optional primary action. */
  action?: ComponentChildren;
}

export function EmptyState({ title, body, action }: EmptyStateProps): JSX.Element {
  return (
    <div class="ui-state">
      <span class="ui-state__icon" aria-hidden="true">
        {'—'}
      </span>
      <p class="ui-state__title">{title}</p>
      {body ? <p class="ui-state__body">{body}</p> : null}
      {action}
    </div>
  );
}
