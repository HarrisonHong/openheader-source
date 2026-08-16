import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface SwitchProps {
  label: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Settings toggle built on a native checkbox, so keyboard operation (Tab +
 * Space), focus ring and screen-reader semantics come for free.
 */
export function Switch({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: SwitchProps): JSX.Element {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div class="ui-switch">
      <span class="ui-stack ui-stack--1">
        <label class="ui-label" for={id}>
          {label}
        </label>
        {description ? (
          <span class="ui-muted" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        id={id}
        class="ui-switch__control"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
      />
    </div>
  );
}
