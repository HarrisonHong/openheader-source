import type { JSX } from 'preact';
import { VisuallyHidden } from './VisuallyHidden';

export interface SpinnerProps {
  /** Screen-reader text. Every spinner needs one. */
  label: string;
}

export function Spinner({ label }: SpinnerProps): JSX.Element {
  return (
    <>
      <span class="ui-spinner" aria-hidden="true" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </>
  );
}
