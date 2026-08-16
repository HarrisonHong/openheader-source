import { Fragment } from 'preact';
import type { JSX } from 'preact';

export interface ShortcutDefinition {
  /** Chrome command name, or a synthetic id for in-page shortcuts. */
  id: string;
  description: string;
  /** Individual keys, e.g. ['Alt', 'Shift', 'E']. */
  keys: readonly string[];
}

export function Kbd({ children }: { children: string }): JSX.Element {
  return <kbd class="ui-kbd">{children}</kbd>;
}

export interface ShortcutListProps {
  shortcuts: readonly ShortcutDefinition[];
}

/**
 * Keyboard-shortcut reference. Rendered as a definition list so screen readers
 * announce the pairing rather than a wall of loose text.
 */
export function ShortcutList({ shortcuts }: ShortcutListProps): JSX.Element {
  return (
    <dl class="ui-shortcut-list">
      {shortcuts.map((shortcut) => (
        <div class="ui-shortcut" key={shortcut.id}>
          <dt>{shortcut.description}</dt>
          <dd class="ui-shortcut__keys">
            {shortcut.keys.map((key, index) => (
              <Fragment key={`${shortcut.id}-${key}`}>
                {index > 0 ? <span aria-hidden="true">+</span> : null}
                <Kbd>{key}</Kbd>
              </Fragment>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
