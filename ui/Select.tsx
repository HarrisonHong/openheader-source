import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string;
  options: readonly SelectOption[];
  hint?: string | undefined;
  disabled?: boolean;
  labelHidden?: boolean;
  onValueChange: (value: string) => void;
}

/** A labelled native `<select>`. Native so keyboard and mobile behaviour are free. */
export function Select({
  label,
  value,
  options,
  hint,
  disabled = false,
  labelHidden = false,
  onValueChange,
}: SelectProps): JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div class="ui-field">
      <label class={labelHidden ? 'ui-visually-hidden' : 'ui-field__label'} for={id}>
        {label}
      </label>
      <select
        id={id}
        class="ui-select"
        value={value}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => onValueChange((event.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span class="ui-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
