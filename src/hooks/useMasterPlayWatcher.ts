/**
 * useMasterPlayWatcher
 * --------------------
 * React hook that mounts the master-play watcher (Layer A of the
 * coach grounding pipeline). On every FEN change, calls
 * `prefetchMasterPlay` so the cache stays warm for the pre-injection
 * (Layer B) and tool-use (Layer C) layers.
 *
 * Kid surfaces MUST NOT call this hook. The watcher's own kid-route
 * exclusion is a backstop — the contract is "don't even mount it on
 * `/kid/*`." See CLAUDE.md "Kids section non-negotiables."
 *
 * Usage:
 *
 *   function CoachChatPage() {
 *     const fen = useChessGame().fen;
 *     useMasterPlayWatcher('/coach/chat', fen);
 *     // ... rest of the surface
 *   }
 *
 * The hook is fire-and-forget. The prefetch runs in the background;
 * if it fails or returns no data, the next chat turn just doesn't
 * have pre-injection context (and the LLM falls back to its
 * existing behavior).
 */

import { useEffect } from 'react';
import { prefetchMasterPlay } from '../services/masterPlayWatcher';

export function useMasterPlayWatcher(
  surface: string,
  fen: string | null | undefined,
  sessionId?: string,
): void {
  useEffect(() => {
    if (!fen) return;
    void prefetchMasterPlay(fen, { surface, sessionId });
  }, [surface, fen, sessionId]);
}
