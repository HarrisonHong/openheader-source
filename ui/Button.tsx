import type { ComponentChildren, JSX } from 'preact';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps
  extends Omit<JSX.IntrinsicElements['button'], 'size' | 'class' | 'className'> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  loading?: boolean;
  /** Announced while `loading` is true. */
  loadingLabel?: string;
  children?: ComponentChildren;
}

export function Button({
  variant = 'secondary',
  fullWidth = false,
  loading = false,
  loadingLabel = 'Working',
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const className = [
    'ui-button',
    `ui-button--${variant}`,
    fullWidth ? 'ui-button--full' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      class={className}
      disabled={disabled === true || loading}
      aria-busy={loading ? 'true' : undefined}
    >
      {loading ? (
        <>
          <Spinner label={loadingLabel} />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
