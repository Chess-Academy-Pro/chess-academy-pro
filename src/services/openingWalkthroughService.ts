// openingWalkthroughService
// -------------------------
// Reconstruct a plausible move sequence from the chess starting
// position to a given target FEN (the puzzle's pre-state). Used by the
// "Show the opening" button on the Opening Traps puzzle view so the
// user can watch how the position arose — no jump-cut into a deep
// position they've never seen develop.
//
// Strategy: greedy DFS forward from the start, at each ply asking
// Lichess Explorer for the most-popular moves from the current
// position. Try the top-K moves; recurse if the resulting position
// could still reach the target (heuristic: piece-count and material
// monotonically converge toward the target). First branch that hits
// the target FEN wins.
//
// Bounded by:
//   - Max depth = puzzle's fullmove * 2 + 1 (a little slack for ep / castle)
//   - Max explorer calls = MAX_PROBE_CALLS (network ceiling)
//
// On failure, callers fall back to "no walkthrough available, jump to
// puzzle position with a brief intro."

import { Chess } from 'chess.js';
import { fetchLichessExplorer } from './lichessExplorerService';

const MAX_PROBE_CALLS = 24;
const TOP_K_MOVES = 3;

export interface OpeningWalkthroughResult {
  /** SAN move list from the starting position to the target FEN.
   *  Empty when no path was found within the call budget. */
  sans: string[];
  /** True when sans.length > 0 AND the last move's resulting FEN
   *  matches the target (placement+turn+castling+ep). */
  found: boolean;
  /** Number of Lichess explorer probes consumed. Diagnostic. */
  probes: number;
}

function fenKey(fen: string): string {
  // Match positions ignoring half-move clock + full-move number
  // (fields 5 & 6) so the search can find equivalent positions even
  // when those counters drift from popular-move counts in the
  // explorer's reply.
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Attempt to find a move sequence from start to target.
 *  Returns the SAN list, or empty when no path was found. */
export async function reconstructPathToFen(
  targetFen: string,
): Promise<OpeningWalkthroughResult> {
  const maxDepth = (() => {
    const fm = Number(targetFen.split(' ')[5]);
    const side = targetFen.split(' ')[1];
    if (!Number.isFinite(fm) || fm < 1) return 12;
    // fullmove n with white to move = (n-1)*2 ply elapsed.
    // fullmove n with black to move = (n-1)*2 + 1 ply elapsed.
    return (fm - 1) * 2 + (side === 'b' ? 1 : 0);
  })();

  const targetKey = fenKey(targetFen);
  let probes = 0;
  const visited = new Set<string>();

  async function dfs(
    chess: Chess,
    path: string[],
  ): Promise<string[] | null> {
    const currentKey = fenKey(chess.fen());
    if (currentKey === targetKey) return path;
    if (path.length >= maxDepth) return null;
    if (probes >= MAX_PROBE_CALLS) return null;
    if (visited.has(currentKey)) return null;
    visited.add(currentKey);

    probes += 1;
    let explorer;
    try {
      explorer = await fetchLichessExplorer(chess.fen());
    } catch {
      return null;
    }
    const candidates = (explorer.moves ?? [])
      .slice()
      .sort((a, b) => {
        const ag = (a.white ?? 0) + (a.draws ?? 0) + (a.black ?? 0);
        const bg = (b.white ?? 0) + (b.draws ?? 0) + (b.black ?? 0);
        return bg - ag;
      })
      .slice(0, TOP_K_MOVES);

    for (const m of candidates) {
      const san = m.san;
      if (!san) continue;
      const branch = new Chess(chess.fen());
      try {
        branch.move(san);
      } catch {
        continue;
      }
      const result = await dfs(branch, [...path, san]);
      if (result) return result;
    }
    return null;
  }

  try {
    const sans = await dfs(new Chess(), []);
    return {
      sans: sans ?? [],
      found: sans !== null && sans.length > 0,
      probes,
    };
  } catch {
    return { sans: [], found: false, probes };
  }
}
