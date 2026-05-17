import { Chess } from 'chess.js';
import { stockfishEngine } from './stockfishEngine';
import { getNextOpeningBookMove } from './openingDetectionService';
import { findHangingPieces } from './tacticClassifier';
import { lookupMasterPlay } from './masterPlayLookup';
import { logAppAudit } from './appAuditor';
import type { StockfishAnalysis, CoachDifficulty } from '../types';

const COACH_MOVE_TIMEOUT_MS = 5000;

const FALLBACK_ANALYSIS: StockfishAnalysis = {
  bestMove: '',
  evaluation: 0,
  isMate: false,
  mateIn: null,
  depth: 0,
  topLines: [],
  nodesPerSecond: 0,
};

/**
 * Maps target ELO to Stockfish Skill Level (0–20).
 * Skill Level controls how many intentional "errors" the engine makes —
 * much more natural than picking random non-best moves.
 */
function getSkillLevelForElo(targetElo: number): number {
  if (targetElo < 800) return 2;
  if (targetElo < 1000) return 5;
  if (targetElo < 1200) return 8;
  if (targetElo < 1400) return 11;
  if (targetElo < 1600) return 14;
  if (targetElo < 1800) return 16;
  if (targetElo < 2000) return 18;
  return 20;
}

/**
 * Analysis depth — higher is fine because Skill Level handles weakness.
 * We want the engine to "see" tactics so it doesn't hang pieces.
 */
function getDepthForElo(targetElo: number): number {
  if (targetElo < 1000) return 10;
  if (targetElo < 1200) return 12;
  if (targetElo < 1500) return 14;
  if (targetElo < 1800) return 16;
  return 18;
}

/**
 * Small chance of picking 2nd-best move for variety (not blundering).
 * Kept very low since Skill Level already weakens play naturally.
 */
function getVarietyChance(targetElo: number): number {
  if (targetElo < 1000) return 0.10;
  if (targetElo < 1200) return 0.08;
  if (targetElo < 1500) return 0.05;
  return 0.03;
}

export function getRandomLegalMove(fen: string): string | null {
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return null;

    // Score each move by how many own pieces it leaves hanging
    const scored = moves.map((m) => {
      const test = new Chess(fen);
      test.move({ from: m.from, to: m.to, promotion: m.promotion });
      const hanging = findHangingPieces(test).filter((p) => p.color === chess.turn());
      return { move: m, hangingCount: hanging.length };
    });

    // Prefer moves with fewest hanging pieces
    scored.sort((a, b) => a.hangingCount - b.hangingCount);
    const bestScore = scored[0].hangingCount;
    const candidates = scored.filter((s) => s.hangingCount === bestScore);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    return `${chosen.move.from}${chosen.move.to}${chosen.move.promotion ?? ''}`;
  } catch {
    return null;
  }
}

function makeTimeoutPromise(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Stockfish timeout after ${ms}ms`)), ms);
  });
}

/**
 * Try to play the next opening book move if a requested opening is active.
 * Returns the UCI move string (e.g. "e7e6") or null if not applicable.
 */
export function tryOpeningBookMove(
  fen: string,
  gameHistory: string[],
  openingMoves: string[] | null,
  aiColor: 'white' | 'black',
): string | null {
  if (!openingMoves || openingMoves.length === 0) return null;

  const bookSan = getNextOpeningBookMove(openingMoves, gameHistory, aiColor);
  if (!bookSan) return null;

  // Convert SAN to UCI
  try {
    const chess = new Chess(fen);
    const move = chess.move(bookSan);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  } catch {
    return null;
  }
}

/** UCI encoder used by the master-play path. Converts a SAN move into
 *  the UCI string the rest of the play loop expects. Returns null if
 *  chess.js refuses the move (e.g. ambiguous / illegal for this FEN). */
function sanToUci(fen: string, san: string): string | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move(san);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  } catch {
    return null;
  }
}

/** Pick a master move from a `MasterPlayResult`, weighted by total games
 *  played. Returns the chosen MasterPlayMove, or null when the result
 *  is empty / too sparse. */
function pickMasterMove(
  moves: ReadonlyArray<{ san: string; games: number }>,
  rng: () => number = Math.random,
): { san: string; games: number } | null {
  // Filter to popular replies: cap at top 5 and require ≥1 game.
  const candidates = moves.filter((m) => m.games > 0).slice(0, 5);
  if (candidates.length === 0) return null;
  const total = candidates.reduce((sum, m) => sum + m.games, 0);
  if (total === 0) return null;
  const r = rng() * total;
  let acc = 0;
  for (const m of candidates) {
    acc += m.games;
    if (r < acc) return m;
  }
  return candidates[candidates.length - 1];
}

export async function getAdaptiveMove(
  fen: string,
  targetElo: number,
): Promise<{ move: string; analysis: StockfishAnalysis; source: 'masters' | 'stockfish-best' | 'stockfish-variety' | 'stockfish-fallback' | 'random' }> {
  const depth = getDepthForElo(targetElo);
  const skillLevel = getSkillLevelForElo(targetElo);

  // Layer 0 — master play. Consult the canonical masters DB (local
  // first, then live Lichess) BEFORE Stockfish. When this position has
  // master games, the opponent plays a weighted-random move from the
  // top-5 replies — keeps the line natural / theoretically sound and
  // avoids Stockfish-low-skill blunders that send the user wandering
  // off into nonsense positions. Falls through to Stockfish on cache
  // miss / network failure.
  //
  // Audit emissions on every branch so the play surface is debuggable
  // from the audit stream alone (no console-log archaeology).
  try {
    const masters = await lookupMasterPlay(fen, {
      triggeredBy: 'manual',
      surface: 'coachGameEngine.getAdaptiveMove',
    });
    if (masters.source !== 'none' && masters.moves.length > 0) {
      const picked = pickMasterMove(masters.moves);
      if (picked) {
        const uci = sanToUci(fen, picked.san);
        if (uci) {
          void logAppAudit({
            kind: 'coach-opponent-move-source',
            category: 'subsystem',
            source: 'coachGameEngine.getAdaptiveMove',
            summary: `source=${masters.source} san=${picked.san} games=${picked.games}/${masters.totalGames} elo=${targetElo}`,
            fen,
          });
          return {
            move: uci,
            analysis: { ...FALLBACK_ANALYSIS, bestMove: uci },
            source: 'masters',
          };
        }
      }
    }
    // No masters data OR pickMasterMove rejected. Fall through to Stockfish.
    void logAppAudit({
      kind: 'coach-opponent-masters-miss',
      category: 'subsystem',
      source: 'coachGameEngine.getAdaptiveMove',
      summary: `source=${masters.source} totalGames=${masters.totalGames} elo=${targetElo} — falling to stockfish`,
      fen,
    });
  } catch (err) {
    // Don't let masters-lookup errors block play. Log and continue.
    void logAppAudit({
      kind: 'coach-opponent-masters-error',
      category: 'subsystem',
      source: 'coachGameEngine.getAdaptiveMove',
      summary: `error=${(err as Error)?.message ?? err} elo=${targetElo}`,
      fen,
    });
  }

  let analysis: StockfishAnalysis;
  try {
    analysis = await Promise.race([
      stockfishEngine.analyzePosition(fen, depth, { 'Skill Level': skillLevel }),
      makeTimeoutPromise(COACH_MOVE_TIMEOUT_MS),
    ]);
  } catch (error) {
    void logAppAudit({
      kind: 'coach-opponent-stockfish-error',
      category: 'subsystem',
      source: 'coachGameEngine.getAdaptiveMove',
      summary: `analyzePosition failed/timeout — ${(error as Error)?.message ?? error}`,
      fen,
    });
    stockfishEngine.stop();

    // Second attempt: use movetime-based best move (always returns within budget)
    try {
      const bestMove = await Promise.race([
        stockfishEngine.getBestMove(fen, 2000),
        makeTimeoutPromise(4000),
      ]);
      if (bestMove && bestMove !== '(none)') {
        void logAppAudit({
          kind: 'coach-opponent-move-source',
          category: 'subsystem',
          source: 'coachGameEngine.getAdaptiveMove',
          summary: `source=stockfish-fallback move=${bestMove} elo=${targetElo}`,
          fen,
        });
        return {
          move: bestMove,
          analysis: { ...FALLBACK_ANALYSIS, bestMove },
          source: 'stockfish-fallback',
        };
      }
    } catch (innerErr) {
      void logAppAudit({
        kind: 'coach-opponent-stockfish-error',
        category: 'subsystem',
        source: 'coachGameEngine.getAdaptiveMove',
        summary: `getBestMove fallback also failed — ${(innerErr as Error)?.message ?? innerErr}`,
        fen,
      });
    }

    // Last resort: random legal move (should be extremely rare)
    const fallbackMove = getRandomLegalMove(fen);
    if (!fallbackMove) throw new Error('No legal moves available');
    void logAppAudit({
      kind: 'coach-opponent-move-source',
      category: 'subsystem',
      source: 'coachGameEngine.getAdaptiveMove',
      summary: `source=random move=${fallbackMove} elo=${targetElo}`,
      fen,
    });
    return {
      move: fallbackMove,
      analysis: { ...FALLBACK_ANALYSIS, bestMove: fallbackMove },
      source: 'random',
    };
  }

  const varietyChance = getVarietyChance(targetElo);
  const topLines = analysis.topLines;

  // Occasionally pick the 2nd-best move for variety (not the 3rd — too risky)
  if (topLines.length >= 2 && Math.random() < varietyChance) {
    const secondLine = topLines[1];
    if (secondLine.moves.length > 0) {
      // Only pick 2nd-best if it's not drastically worse (within 0.8 pawns)
      const evalDiff = Math.abs(
        topLines[0].evaluation - secondLine.evaluation,
      );
      if (evalDiff < 80) {
        void logAppAudit({
          kind: 'coach-opponent-move-source',
          category: 'subsystem',
          source: 'coachGameEngine.getAdaptiveMove',
          summary: `source=stockfish-variety move=${secondLine.moves[0]} evalDiff=${evalDiff}cp elo=${targetElo}`,
          fen,
        });
        return { move: secondLine.moves[0], analysis, source: 'stockfish-variety' };
      }
    }
  }

  void logAppAudit({
    kind: 'coach-opponent-move-source',
    category: 'subsystem',
    source: 'coachGameEngine.getAdaptiveMove',
    summary: `source=stockfish-best move=${analysis.bestMove} eval=${analysis.evaluation}cp skill=${skillLevel} elo=${targetElo}`,
    fen,
  });
  return { move: analysis.bestMove, analysis, source: 'stockfish-best' };
}

/** ELO offset per difficulty level relative to the player rating. */
const DIFFICULTY_OFFSET: Record<CoachDifficulty, number> = {
  easy: -300,
  medium: 0,
  hard: 200,
};

export function getTargetStrength(playerRating: number, difficulty: CoachDifficulty = 'medium'): number {
  return Math.max(600, playerRating + DIFFICULTY_OFFSET[difficulty]);
}
