/**
 * masterPlayAuditBridge
 * ---------------------
 * Production-safe bridge that exposes the master-play services on
 * `window.__masterPlayAudit` ONLY when the audit-stream is configured.
 * Lets `scripts/audit-coach-master-integration.mjs` drive the
 * deployed app via `page.evaluate` without needing the source-file
 * paths Vite serves in dev mode (production bundles those away).
 *
 * The bridge is a side-effect import — pulling this module is enough
 * to install the bridge at boot. It's a no-op when localStorage's
 * `auditStreamUrl` is unset, which is the default for every real
 * user. The audit script sets that key via `addInitScript` before
 * page load, so the bridge activates only during audit runs.
 *
 * Why this isn't a leak:
 *   - The bridge is gated on `auditStreamUrl` being set, which the
 *     migration in `appAuditor.loadAuditStreamConfig` clears from
 *     localStorage after copying to Dexie. So even if the value
 *     somehow ends up in a real user's localStorage, the bridge
 *     window is one boot wide; subsequent boots see the cleared
 *     key.
 *   - The exposed surface is read-only (functions), not state.
 *     Nothing here grants extra capabilities beyond what the
 *     services already expose.
 *   - Kid contract: getKidLlmResponse is exposed alongside
 *     getCoachChatResponse so the audit can verify the kid path
 *     does NOT engage grounding. The bridge does not change kid
 *     behavior.
 */

import { lookupMasterPlay } from './masterPlayLookup';
import { prefetchMasterPlay, prefetchWalkthroughSequence } from './masterPlayWatcher';
import { masterPlayCache } from './masterPlayCache';
import { getCoachChatResponse, getKidLlmResponse } from './coachApi';
import { validateClaims } from './claimValidator';

declare global {
  interface Window {
    __masterPlayAudit?: {
      lookupMasterPlay: typeof lookupMasterPlay;
      prefetchMasterPlay: typeof prefetchMasterPlay;
      prefetchWalkthroughSequence: typeof prefetchWalkthroughSequence;
      masterPlayCache: typeof masterPlayCache;
      getCoachChatResponse: typeof getCoachChatResponse;
      getKidLlmResponse: typeof getKidLlmResponse;
      validateClaims: typeof validateClaims;
    };
  }
}

/** Install the bridge once at module load. No-op outside the browser
 *  and no-op when the audit-stream isn't configured. */
function installBridge(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = window.localStorage.getItem('auditStreamUrl');
    if (!url) return;
  } catch {
    return;
  }
  window.__masterPlayAudit = {
    lookupMasterPlay,
    prefetchMasterPlay,
    prefetchWalkthroughSequence,
    masterPlayCache,
    getCoachChatResponse,
    getKidLlmResponse,
    validateClaims,
  };
}

installBridge();
