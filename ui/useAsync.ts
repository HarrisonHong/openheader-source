import { useCallback, useEffect, useState } from 'preact/hooks';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; value: T }
  | { status: 'error'; error: Error };

/**
 * Maps a promise onto the loading / success / error states the design system
 * has primitives for. Errors are surfaced, never swallowed — a failed storage
 * read must show the error state rather than a half-rendered UI.
 */
export function useAsync<T>(
  run: () => Promise<T>,
  deps: readonly unknown[] = [],
): { state: AsyncState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    run().then(
      (value) => {
        if (!cancelled) setState({ status: 'success', value });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
    // `run` is intentionally not a dependency: callers pass inline closures and
    // declare their real inputs via `deps`.
  }, [nonce, ...deps]);

  return { state, reload };
}
