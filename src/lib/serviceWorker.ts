import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the service worker that precaches the app for offline use (see
 * the VitePWA config in vite.config.ts).
 *
 * After a deploy, the new version downloads in the background and waits.
 * It takes over on the next launch once every tab of the app is closed, or
 * sooner when the app is in the background with no sheet open, so a reload
 * never throws away an expense someone is halfway through entering.
 */
export function startServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      const applyWhenIdle = () => {
        const editing = document.querySelector('.sheet-overlay') !== null;
        if (document.visibilityState === 'hidden' && !editing) {
          document.removeEventListener('visibilitychange', applyWhenIdle);
          void updateSW(true);
        }
      };
      document.addEventListener('visibilitychange', applyWhenIdle);
    },
  });
}

/**
 * Better scan (Florence-2) was retired for PaddleOCR. Anyone who tried it
 * still has ~390 MB of model files in Transformers.js's cache, which nothing
 * reads any more, plus its settings. Remove them; does nothing when absent.
 */
export function forgetRetiredBetterScan(): void {
  try {
    for (const key of ['opensplitwise-better-scan', 'opensplitwise-better-scan-running', 'opensplitwise-better-scan-blocked']) {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was saved either.
  }
  if (typeof caches !== 'undefined') void caches.delete('transformers-cache').catch(() => {});
}
