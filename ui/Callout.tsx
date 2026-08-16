import type { ComponentChildren, JSX } from 'preact';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

export interface CalloutProps {
  tone: CalloutTone;
  title?: string;
  children: ComponentChildren;
  /**
   * Announce this immediately. Use for something that just happened as a result
   * of the user's action (a failed save, a refused rule set) — not for standing
   * information, which would then be re-read on every render.
   */
  live?: boolean;
}

/** A bordered message block. Tone is carried by the text as well as the colour. */
export function Callout({ tone, title, children, live = false }: CalloutProps): JSX.Element {
  return (
    <div
      class={`ui-callout ui-callout--${tone}`}
      role={live ? 'alert' : undefined}
    >
      <div class="ui-callout__body ui-stack ui-stack--1">
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}
