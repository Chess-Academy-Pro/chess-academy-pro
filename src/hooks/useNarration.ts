/**
 * useNarration — minimal lifecycle-disciplined narration hook.
 *
 * What it does:
 *   - Speaks `text` via `voiceService.speakForced` whenever `text` changes.
 *   - Stops in-flight speech when `text` becomes empty.
 *   - Stops in-flight speech on unmount — which means route changes,
 *     tab switches, and component-level cleanup all cancel narration
 *     for free (David's audit: endgame narration kept playing after
 *     the user navigated away).
 *   - Returns `{ replay, stop }` for manual control.
 *
 * Why not `useStrictNarration`?
 *   That hook is a step-runner for walkthroughs with N discrete
 *   steps and auto-advance gating. Endgame surfaces don't have
 *   "steps" — they're user-driven (play a move → see explanation
 *   → move on, one narration per landing, no auto-advance).
 *
 * Why `speakForced`?
 *   Matches the endgame-narration semantics established in PR #447:
 *   keystone explanations are opt-in lesson content (the user
 *   chose to open the lesson), not a coach side-channel they can
 *   mute. `speakForced` bypasses the `voiceEnabled` pref gate.
 */
import { useCallback, useEffect, useRef } from 'react';
import { voiceService } from '../services/voiceService';

export interface UseNarrationOptions {
  /** Text to speak. Empty string / null / undefined = silence. */
  text: string | null | undefined;
  /** When false, the hook is inert — no speak, no stop. Use for
   *  drill-mode silence or conditionally-narrated screens. */
  enabled?: boolean;
}

export interface UseNarrationReturn {
  /** Re-trigger speak for the current text. No-op when text is empty. */
  replay: () => void;
  /** Stop any in-flight speech immediately. */
  stop: () => void;
}

export function useNarration({
  text,
  enabled = true,
}: UseNarrationOptions): UseNarrationReturn {
  // Token incremented on every speak/stop so stale .then resolutions
  // from a superseded call can detect they've been replaced and bail.
  // Same supersession pattern as useStrictNarration.
  const tokenRef = useRef(0);
  const currentTextRef = useRef<string>('');

  // Speak `t` if non-empty. Bumps the token first so any in-flight
  // speak from a prior call sees its token go stale.
  const speakNow = useCallback((t: string): void => {
    tokenRef.current += 1;
    const myToken = tokenRef.current;
    currentTextRef.current = t;
    if (!t) {
      voiceService.stop();
      return;
    }
    void voiceService.speakForced(t).catch(() => {
      // Speak failures (network, audio context, etc.) are already
      // logged by voiceService.lastSpeakDiagnostic. Don't throw
      // from the hook — narration is best-effort.
      if (myToken !== tokenRef.current) return;
    });
  }, []);

  // Auto-speak on text change. The dep array intentionally watches
  // only `text` + `enabled` — other state changes shouldn't restart
  // speech mid-sentence.
  useEffect(() => {
    if (!enabled) {
      // Disabling cancels in-flight speech and resets the cached
      // text so a re-enable speaks fresh.
      tokenRef.current += 1;
      voiceService.stop();
      currentTextRef.current = '';
      return;
    }
    speakNow(text ?? '');
  }, [text, enabled, speakNow]);

  // Cleanup on unmount — covers route changes, parent unmounts,
  // tab switches in any flow. Single source of "stop on leave."
  useEffect(() => {
    return () => {
      tokenRef.current += 1;
      voiceService.stop();
    };
  }, []);

  const replay = useCallback((): void => {
    if (!enabled) return;
    speakNow(currentTextRef.current);
  }, [enabled, speakNow]);

  const stop = useCallback((): void => {
    tokenRef.current += 1;
    voiceService.stop();
  }, []);

  return { replay, stop };
}
