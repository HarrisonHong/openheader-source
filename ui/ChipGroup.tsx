import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface ChipOption {
  value: string;
  label: string;
}

export interface ChipGroupProps {
  legend: string;
  hint?: string | undefined;
  options: readonly ChipOption[];
  selected: readonly string[];
  onToggle: (value: string, selected: boolean) => void;
}

/**
 * Multi-select as a row of chips.
 *
 * Each chip is a real checkbox inside its own label, so the whole group is a
 * `<fieldset>` with a name, every chip is reachable by Tab and toggled with
 * Space, and the selected state is announced rather than only coloured.
 */
export function ChipGroup({
  legend,
  hint,
  options,
  selected,
  onToggle,
}: ChipGroupProps): JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <fieldset class="ui-field" aria-describedby={hintId}>
      <legend class="ui-field__label">{legend}</legend>
      <div class="ui-chips">
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <label key={option.value} class={`ui-chip${on ? ' ui-chip--on' : ''}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={(event) =>
                  onToggle(option.value, (event.currentTarget as HTMLInputElement).checked)
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {hint ? (
        <span class="ui-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </fieldset>
  );
}
