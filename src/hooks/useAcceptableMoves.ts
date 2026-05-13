// useAcceptableMoves
// ------------------
// Phase 6 (#6): "should accept any move within an eval threshold of
// the engine's pick." Review-puzzle surfaces (From-Your-Games) feed
// the returned SANs into `useEndgamePlayout({ acceptableSans })` so
// any move within `toleranceCp` of the engine's bestmove is treated
// as a curated-correct answer — not flashed red.
//
// Cost: one Stockfish multipv analysis per FEN (depth 12, ~200-500ms).
// Result cached by the engine's own LRU. Returns the empty array
// during the in-flight period so the playout falls back to the strict
// expected-SAN gate until acceptable moves are known.

import { useEffect, useState } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { stockfishEngine } from '../services/stockfishEngine';

export interface UseAcceptableMovesOptions {
  /** Current FEN. Acceptable moves are recomputed when this changes. */
  fen: string;
  /** Centipawn-loss tolerance vs the engine's best line. Default 30. */
  toleranceCp?: number;
  /** Stockfish search depth. Lower = faster, less accurate. Default 12. */
  depth?: number;
  /** Skip analysis when false (e.g., when the host has decided exact-
   *  match is the right gate). */
  enabled?: boolean;
}

export interface UseAcceptableMovesResult {
  /** SAN strings that are acceptable substitutes for the engine's pick. */
  sans: string[];
  /** True while Stockfish is analyzing. */
  loading: boolean;
}

function uciToSan(fen: string, uci: string): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = chess.move({ from, to, promotion });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

export function useAcceptableMoves({
  fen,
  toleranceCp = 30,
  depth = 12,
  enabled = true,
}: UseAcceptableMovesOptions): UseAcceptableMovesResult {
  const [sans, setSans] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);

  useEffect(() => {
    if (!enabled || !fen) {
      setSans([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSans([]);

    void stockfishEngine
      .analyzePosition(fen, depth)
      .then((analysis) => {
        if (cancelled) return;
        const lines = analysis.topLines ?? [];
        if (lines.length === 0) {
          setSans([]);
          setLoading(false);
          return;
        }
        const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';
        const score = (cp: number): number => (sideToMove === 'w' ? cp : -cp);
        const bestCp = score(lines[0].evaluation);
        const accepted: string[] = [];
        for (const line of lines) {
          const firstUci = line.moves[0];
          if (!firstUci) continue;
          const san = uciToSan(fen, firstUci);
          if (!san) continue;
          if (bestCp - score(line.evaluation) <= toleranceCp) {
            accepted.push(san);
          }
        }
        setSans(accepted);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSans([]);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fen, toleranceCp, depth, enabled]);

  return { sans, loading };
}
