import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface PanelProps {
  title?: string;
  description?: string;
  children?: ComponentChildren;
  /**
   * Preferred element. A `<section>` is a landmark only when it has an
   * accessible name, and a name can come only from `aria-label`/
   * `aria-labelledby` — never from a heading inside it. So a titled panel is a
   * `<section>` labelled by its own `<h2>`, and an untitled one falls back to a
   * `<div>` rather than adding a nameless region to navigate past.
   */
  as?: 'section' | 'div';
}

export function Panel({ title, description, children, as = 'section' }: PanelProps): JSX.Element {
  const titleId = useId();
  const named = as === 'section' && Boolean(title);
  const Tag = named ? 'section' : 'div';

  return (
    <Tag class="ui-panel" aria-labelledby={named ? titleId : undefined}>
      <div class="ui-stack ui-stack--3">
        {title || description ? (
          <div class="ui-stack ui-stack--1">
            {title ? (
              <h2 class="ui-panel__title" id={named ? titleId : undefined}>
                {title}
              </h2>
            ) : null}
            {description ? <p class="ui-muted">{description}</p> : null}
          </div>
        ) : null}
        {children ? <div class="ui-stack ui-stack--3">{children}</div> : null}
      </div>
    </Tag>
  );
}
