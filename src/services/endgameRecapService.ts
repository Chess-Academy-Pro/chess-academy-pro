/**
 * endgameRecapService — Stockfish-driven post-playout accuracy recap.
 *
 * David's Photo 3 audit: "it would be awesome to have a short recap
 * of move accuracy written and narrated. But it needs to not be done
 * by the LLM. Can stockfish provide analysis?"
 *
 * Yes. For each correct student move recorded by useEndgamePlayout
 * (StudentMoveRecord with fen-before + fen-after), we run a shallow
 * Stockfish analysis on both positions, compute the win-percent drop
 * from the moving side's perspective, and route through the existing
 * winPercent + accuracyFromWinDelta + harmonic-mean pipeline that
 * the rest of the app already uses for game accuracy (ship-2).
 *
 * Output: a `EndgameRecap` that the UI can render and the voice
 * service can narrate. No LLM authorship anywhere — narration is
 * template-driven with a small bank of stems that rotate per recap
 * so a 10-puzzle session doesn't sound robotic.
 */
import type { StudentMoveRecord } from '../hooks/useEndgamePlayout';
import { stockfishEngine } from './stockfishEngine';
import { winPercent, accuracyFromWinDelta } from './accuracyService';

/** Per-move analysis result — used internally and surfaced for tests. */
export interface RecapMove {
  san: string;
  /** Centipawns from White's POV, after Stockfish at recap depth. */
  evalBefore: number;
  evalAfter: number;
  /** Win-percent drop from the student's POV (0 = perfect). */
  winDrop: number;
  /** 0..100 accuracy on that single move. */
  accuracy: number;
  classification: RecapClassification;
}

/** Coarse classification for a single move. We don't surface the
 *  full Chess.com taxonomy (brilliant/great/etc.) — for a 3-8 move
 *  endgame playout, four buckets is plenty. */
export type RecapClassification = 'best' | 'inaccuracy' | 'mistake' | 'blunder';

export interface EndgameRecap {
  /** Aggregate harmonic-mean accuracy across all student moves. */
  accuracy: number;
  /** Per-move analysis in playout order. */
  moves: RecapMove[];
  /** Tally for UI pills. */
  counts: {
    best: number;
    inaccuracy: number;
    mistake: number;
    blunder: number;
  };
  /** The worst single move (highest winDrop), or null if all clean. */
  worstMove: RecapMove | null;
  /** Short narration text — concrete, no acknowledgments, no LLM. */
  narration: string;
}

/** Stockfish depth for recap analysis. Lowered from 12 → 8 because
 *  David's audit showed 6 s/eval on degraded single-thread (the
 *  10-eval recap took 60 s to complete). Depth 8 is ~4x faster and
 *  the win-percent drop thresholds we classify against are coarse
 *  enough that the rougher eval doesn't change the verdict. */
const RECAP_DEPTH = 8;
/** Per-call timeout. If a single Stockfish eval hangs (worker in
 *  recovery, multi-thread crash mid-flight, etc.), the recap falls
 *  back to 0 for that move and CONTINUES instead of freezing the
 *  spinner forever. Audit cycle ccd0057 showed evals taking
 *  6 s each on degraded single-thread; 5 s catches genuine hangs
 *  without false-positive-ing slow-but-completing evals. */
const RECAP_EVAL_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('recap-eval-timeout')), ms),
    ),
  ]);
}

/** Win-percent drop thresholds for classification. Match the
 *  thresholds used elsewhere (gameAnalysisService) so the same move
 *  classifies consistently across surfaces. */
const BLUNDER_DROP = 20;
const MISTAKE_DROP = 10;
const INACCURACY_DROP = 5;

function classifyDrop(winDrop: number): RecapClassification {
  if (winDrop >= BLUNDER_DROP) return 'blunder';
  if (winDrop >= MISTAKE_DROP) return 'mistake';
  if (winDrop >= INACCURACY_DROP) return 'inaccuracy';
  return 'best';
}

function harmonicMean(values: number[]): number {
  if (values.length === 0) return 0;
  let reciprocalSum = 0;
  for (const v of values) reciprocalSum += 1 / Math.max(1, v);
  return values.length / reciprocalSum;
}

/** Render a short, concrete narration from the aggregated stats.
 *  Rotates stem variants based on the worst-move classification so a
 *  multi-puzzle session doesn't speak the same opener every time. */
function buildNarration(args: {
  accuracy: number;
  moves: RecapMove[];
  worstMove: RecapMove | null;
}): string {
  const { accuracy, moves, worstMove } = args;
  const acc = Math.round(accuracy);
  const n = moves.length;
  if (n === 0) return '';

  // Perfect or near-perfect run.
  if (!worstMove || worstMove.classification === 'best') {
    const stems = [
      `Clean conversion. ${n} ${n === 1 ? 'move' : 'moves'} at ${acc} percent.`,
      `Held the technique. ${acc} percent across ${n} ${n === 1 ? 'move' : 'moves'}.`,
      `${acc} percent. Every move on the right idea.`,
    ];
    return stems[Math.floor(Math.random() * stems.length)];
  }

  const tag = worstMove.classification;
  const idx = moves.indexOf(worstMove) + 1;
  const tagWord = tag === 'inaccuracy' ? 'inaccuracy' : tag;
  const stems = [
    `${acc} percent. One ${tagWord} on move ${idx}.`,
    `${acc} percent across ${n} ${n === 1 ? 'move' : 'moves'} — the ${tagWord} on move ${idx} was the costliest.`,
    `Move ${idx} was a ${tagWord}. ${acc} percent overall.`,
  ];
  return stems[Math.floor(Math.random() * stems.length)];
}

/** Run Stockfish on every recorded student move and assemble the
 *  recap. Returns null when the move log is empty (nothing to recap
 *  — e.g. display-only positions). */
export async function buildEndgameRecap(
  studentMoves: StudentMoveRecord[],
  studentSide: 'white' | 'black',
): Promise<EndgameRecap | null> {
  if (studentMoves.length === 0) return null;

  // Analyze every fen-before / fen-after pair. We can't run them in
  // parallel — Stockfish is a single worker and serializes anyway —
  // so a tight sequential loop is the simplest correct path.
  const recapMoves: RecapMove[] = [];
  for (const move of studentMoves) {
    let evalBefore = 0;
    let evalAfter = 0;
    try {
      const before = await withTimeout(
        stockfishEngine.analyzePosition(move.fenBefore, RECAP_DEPTH),
        RECAP_EVAL_TIMEOUT_MS,
      );
      evalBefore = before.evaluation;
    } catch {
      // Engine error — fall back to 0 (treat as neutral). Better to
      // surface a partial recap than crash the UI.
    }
    try {
      const after = await withTimeout(
        stockfishEngine.analyzePosition(move.fenAfter, RECAP_DEPTH),
        RECAP_EVAL_TIMEOUT_MS,
      );
      evalAfter = after.evaluation;
    } catch {
      // see above
    }

    // Win-percent must be from the moving side's perspective.
    const sign = studentSide === 'white' ? 1 : -1;
    const winBefore = winPercent(evalBefore * sign);
    const winAfter = winPercent(evalAfter * sign);
    const winDrop = Math.max(0, winBefore - winAfter);
    const accuracy = accuracyFromWinDelta(winDrop);
    const classification = classifyDrop(winDrop);

    recapMoves.push({
      san: move.san,
      evalBefore,
      evalAfter,
      winDrop,
      accuracy,
      classification,
    });
  }

  const accuracy = Math.round(harmonicMean(recapMoves.map((m) => m.accuracy)) * 10) / 10;

  const counts = recapMoves.reduce(
    (acc, m) => {
      acc[m.classification] += 1;
      return acc;
    },
    { best: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
  );

  // Worst move = largest winDrop. Tie-breaking: first occurrence
  // wins so the narration points to the earliest crucial slip.
  let worstMove: RecapMove | null = null;
  for (const m of recapMoves) {
    if (!worstMove || m.winDrop > worstMove.winDrop) worstMove = m;
  }
  // Clean-run case: don't surface a "worst" move when every move is
  // already classified 'best'.
  if (worstMove && worstMove.classification === 'best') worstMove = null;

  const narration = buildNarration({ accuracy, moves: recapMoves, worstMove });

  return {
    accuracy,
    moves: recapMoves,
    counts,
    worstMove,
    narration,
  };
}
