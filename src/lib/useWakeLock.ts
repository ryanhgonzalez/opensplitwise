import { useEffect } from 'react';

/** Whether this browser can keep the screen on. */
export const canKeepAwake = (): boolean => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/**
 * Keeps the screen from dimming or locking while `active`, so a code stays up
 * while the other phone gets ready. The browser lets go when the page is
 * hidden, so it's asked again when the page comes back.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !canKeepAwake()) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;

    const take = async () => {
      try {
        const got = await navigator.wakeLock.request('screen');
        if (stopped) void got.release().catch(() => {});
        else lock = got;
      } catch {
        // Refused (low battery, not allowed): the screen just dims as usual.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) void take();
    };

    void take();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
