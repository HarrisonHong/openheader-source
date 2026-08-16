import { useEffect, useState } from 'preact/hooks';

/**
 * Tracks connectivity so surfaces can render the offline state.
 *
 * `navigator.onLine` only proves the machine has a link, not that anything is
 * reachable. That is fine here: it drives an informational notice, never a
 * feature gate. Nothing in this extension may become unusable when offline.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    globalThis.addEventListener('online', goOnline);
    globalThis.addEventListener('offline', goOffline);
    return () => {
      globalThis.removeEventListener('online', goOnline);
      globalThis.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
