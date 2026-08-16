import type { JSX } from 'preact';

export interface OfflineStateProps {
  /**
   * What still works while offline. Defaults to the truth for this build:
   * everything, because nothing depends on the network.
   */
  body?: string;
}

/**
 * Offline notice. Deliberately reassuring rather than blocking — this extension
 * is local-first and must stay usable with no network. See docs/licensing.md.
 */
export function OfflineState({
  body = 'You are offline. Everything here works offline, so nothing is blocked.',
}: OfflineStateProps): JSX.Element {
  return (
    <div class="ui-callout ui-callout--warning" role="status">
      <span aria-hidden="true">{'⚠'}</span>
      <span>{body}</span>
    </div>
  );
}
