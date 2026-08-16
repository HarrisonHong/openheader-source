import type { ComponentChildren, JSX } from 'preact';

/** Visible to assistive technology, invisible on screen. */
export function VisuallyHidden({ children }: { children: ComponentChildren }): JSX.Element {
  return <span class="ui-visually-hidden">{children}</span>;
}
