/**
 * BuildVersionWidget — small floating indicator showing the bundle
 * hash currently running, plus a "fresh build available, refresh
 * to update" warning when the service worker has cached a newer
 * version than the page is running.
 *
 * Why: David's audit cycle ccd0057 showed a tab running build
 * `378be66` even though the service worker had cached `ccd0057`.
 * The user had no way to tell that Phase 8 wasn't actually active
 * in that session. This widget makes the running version visible
 * at a glance and surfaces the SW-update mismatch.
 *
 * Tap to copy the build ID to clipboard.
 */
import { useEffect, useState } from 'react';
import { getBuildId } from '../../services/appAuditor';

export function BuildVersionWidget(): JSX.Element | null {
  const buildId = getBuildId();
  const [copied, setCopied] = useState(false);
  const [swUpdate, setSwUpdate] = useState<boolean>(false);

  // Watch the active SW registration for an `updatefound` event.
  // When the new worker installs (state !== 'activated' yet),
  // surface the refresh-to-update hint.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    let cancelled = false;
    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (cancelled || !reg) return;
      // If a waiting worker already exists, an update is pending now.
      if (reg.waiting) setSwUpdate(true);
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            setSwUpdate(true);
          }
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard might be blocked (insecure context, permissions).
      // No fallback worth shipping — the value is also visible in
      // the audit log.
    }
  };

  // Build ID is always present (defaulting to 'unknown'), so render
  // unconditionally. If 'unknown' we still want to show it — that
  // itself is useful debug info (the build define didn't apply).
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={`fixed bottom-1 right-1 z-50 select-none rounded px-1.5 py-0.5 font-mono text-[9px] leading-tight backdrop-blur-sm transition-opacity ${
        swUpdate
          ? 'bg-amber-500/20 text-amber-300 opacity-100 hover:bg-amber-500/30'
          : 'bg-black/30 text-white/40 opacity-50 hover:opacity-100 hover:bg-black/50'
      }`}
      aria-label="Build version (tap to copy)"
      title={swUpdate ? 'New build available — hard refresh' : 'Build version (tap to copy)'}
      data-testid="build-version-widget"
    >
      {copied ? 'copied' : swUpdate ? `${buildId.slice(0, 7)} • refresh` : buildId.slice(0, 7)}
    </button>
  );
}
