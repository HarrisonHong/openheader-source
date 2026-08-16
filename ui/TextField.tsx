import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface TextFieldProps
  extends Omit<JSX.IntrinsicElements['input'], 'class' | 'className' | 'onChange' | 'value'> {
  label: string;
  value: string;
  hint?: string | undefined;
  /** Rendered as an error message and wired to `aria-describedby`. */
  error?: string | undefined;
  mono?: boolean;
  /** Hides the label visually but keeps it for screen readers. */
  labelHidden?: boolean;
  onValueChange: (value: string) => void;
}

/**
 * A labelled text input.
 *
 * Built on a native `<input>` with a real `<label>`: every field is reachable by
 * Tab, announced by name, and shows the shared focus ring. `aria-describedby`
 * carries the hint and the error, so the reason a field is rejected is spoken,
 * not just coloured.
 */
export function TextField({
  label,
  value,
  hint,
  error,
  mono = false,
  labelHidden = false,
  onValueChange,
  ...rest
}: TextFieldProps): JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div class={`ui-field${error ? ' ui-field--invalid' : ''}`}>
      <label class={labelHidden ? 'ui-visually-hidden' : 'ui-field__label'} for={id}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        class={`ui-input${mono ? ' ui-input--mono' : ''}`}
        value={value}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
        onInput={(event) => onValueChange((event.currentTarget as HTMLInputElement).value)}
      />
      {hint ? (
        <span class="ui-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span class="ui-field__hint ui-field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
