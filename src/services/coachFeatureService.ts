import { Chess } from 'chess.js';
import { db } from '../db/schema';
import { getCoachCommentary } from './coachApi';
import { buildChessContextMessage } from './coachPrompts';
import { coachService } from '../coach/coachService';
// REVIEW_MOVE_SEGMENT_ADDITION dropped in ship-3 — the per-ply segments
// are now built deterministically from the engine annotations. See
// `buildReviewSegments` / `generateReviewNarration` for the new path.
import {
  GAME_POST_REVIEW_ADDITION,
  REVIEW_INTRO_ADDITION,
} from './coachPrompts';
import { getThemeSkills } from './puzzleService';
import { logAppAudit } from './appAuditor';
import { unwrapSpineError } from './sanitizeCoachText';
import type { BadHabit, CoachContext, UserProfile } from '../types';

// ─── Bad Habit Detection ────────────────────────────────────────────────────

export async function detectBadHabits(profile: UserProfile): Promise<BadHabit[]> {
  const themeSkills = await getThemeSkills();
  const habits: BadHabit[] = [...profile.badHabits];
  const today = new Date().toISOString().split('T')[0];

  // Check for weak themes (accuracy < 40% with 5+ attempts)
  for (const skill of themeSkills) {
    if (skill.accuracy < 0.4 && skill.attempts >= 5) {
      const existingIdx = habits.findIndex((h) => h.id === `weak-${skill.theme}`);
      if (existingIdx >= 0) {
        habits[existingIdx] = {
          ...habits[existingIdx],
          occurrences: habits[existingIdx].occurrences + 1,
          lastSeen: today,
          isResolved: skill.accuracy >= 0.6,
        };
      } else {
        habits.push({
          id: `weak-${skill.theme}`,
          description: `Struggling with ${skill.theme} puzzles (${Math.round(skill.accuracy * 100)}% accuracy)`,
          occurrences: 1,
          lastSeen: today,
          isResolved: false,
        });
      }
    }
  }

  // Mark habits as resolved if accuracy improved
  for (const habit of habits) {
    if (habit.id.startsWith('weak-')) {
      const theme = habit.id.replace('weak-', '');
      const skill = themeSkills.find((s) => s.theme === theme);
      if (skill && skill.accuracy >= 0.6) {
        habit.isResolved = true;
      }
    }
  }

  return habits;
}

export async function updateBadHabits(profile: UserProfile): Promise<BadHabit[]> {
  const habits = await detectBadHabits(profile);
  await db.profiles.update(profile.id, { badHabits: habits });
  return habits;
}

// ─── Post-Game Analysis ─────────────────────────────────────────────────────

export async function getPostGameAnalysis(
  context: CoachContext,
  onStream?: (chunk: string) => void,
): Promise<string> {
  return getCoachCommentary('post_game_analysis', context, onStream);
}

// ─── Daily Lesson ───────────────────────────────────────────────────────────

export async function getDailyLesson(
  context: CoachContext,
  onStream?: (chunk: string) => void,
): Promise<string> {
  return getCoachCommentary('daily_lesson', context, onStream);
}

// ─── Bad Habit Report ───────────────────────────────────────────────────────

export async function getBadHabitReport(
  context: CoachContext,
  onStream?: (chunk: string) => void,
): Promise<string> {
  return getCoachCommentary('bad_habit_report', context, onStream);
}

// ─── Weekly Report ──────────────────────────────────────────────────────────

export async function getWeeklyReport(
  context: CoachContext,
  onStream?: (chunk: string) => void,
): Promise<string> {
  return getCoachCommentary('weekly_report', context, onStream);
}

// ─── Bad Habit Detection from Coach Game ────────────────────────────────────

export async function detectBadHabitsFromGame(
  moves: { classification: string | null; san: string }[],
  profile: UserProfile,
): Promise<BadHabit[]> {
  const habits = [...profile.badHabits];
  const today = new Date().toISOString().split('T')[0];

  // Count mistakes and blunders
  const blunders = moves.filter((m) => m.classification === 'blunder').length;
  const mistakes = moves.filter((m) => m.classification === 'mistake').length;
  const inaccuracies = moves.filter((m) => m.classification === 'inaccuracy').length;

  // Detect time pressure blunders (blunders in last 10 moves)
  const lastMoves = moves.slice(-10);
  const lateBlunders = lastMoves.filter((m) => m.classification === 'blunder' || m.classification === 'mistake').length;
  if (lateBlunders >= 2) {
    const existingIdx = habits.findIndex((h) => h.id === 'game-time-pressure');
    if (existingIdx >= 0) {
      habits[existingIdx] = {
        ...habits[existingIdx],
        occurrences: habits[existingIdx].occurrences + 1,
        lastSeen: today,
        isResolved: false,
      };
    } else {
      habits.push({
        id: 'game-time-pressure',
        description: 'Tends to blunder in the later stages of the game (possible time pressure)',
        occurrences: 1,
        lastSeen: today,
        isResolved: false,
      });
    }
  }

  // Detect consistently inaccurate play
  if (blunders + mistakes >= 3) {
    const existingIdx = habits.findIndex((h) => h.id === 'game-calculation');
    if (existingIdx >= 0) {
      habits[existingIdx] = {
        ...habits[existingIdx],
        occurrences: habits[existingIdx].occurrences + 1,
        lastSeen: today,
        isResolved: false,
      };
    } else {
      habits.push({
        id: 'game-calculation',
        description: `Frequent calculation errors (${blunders} blunders, ${mistakes} mistakes in last game)`,
        occurrences: 1,
        lastSeen: today,
        isResolved: false,
      });
    }
  }

  // Mark improvement — if no blunders at all, mark calculation habit as resolved
  if (blunders === 0 && mistakes === 0 && inaccuracies <= 1) {
    for (const habit of habits) {
      if (habit.id === 'game-calculation' && !habit.isResolved) {
        habit.isResolved = true;
      }
    }
  }

  await db.profiles.update(profile.id, { badHabits: habits });
  return habits;
}

// ─── Narrative Summary ──────────────────────────────────────────────────────

export interface NarrativeMoveData {
  moveNumber: number;
  san: string;
  classification: string | null;
  commentary: string;
  evaluation: number | null;
  bestMove: string | null;
  isCoachMove: boolean;
}

/** Exact fallback sentence required by WO-REVIEW-01 when the per-move
 *  analysis is empty. The UI surfaces this verbatim — do not prettify. */
export const NARRATIVE_SUMMARY_NO_DATA = 'I need a moment to analyze this game. Tap Full Review for complete analysis.';

/** Format a single move row for the grounded [Per-move analysis] block.
 *  Columns: full move number, color, SAN, eval before, eval after, best,
 *  classification. Every field is either derived from the move record or
 *  explicitly marked "n/a" so the LLM cannot invent the missing value. */
function formatMoveRow(m: NarrativeMoveData, prevEvalCp: number | null, coachColor: 'White' | 'Black'): string {
  const fullMove = Math.ceil(m.moveNumber / 2);
  const moverColor: 'White' | 'Black' = m.moveNumber % 2 === 1 ? 'White' : 'Black';
  const side = m.isCoachMove ? `${moverColor}/coach` : moverColor === coachColor ? `${moverColor}/coach` : `${moverColor}/student`;
  const evalBefore = prevEvalCp !== null ? (prevEvalCp / 100).toFixed(2) : 'n/a';
  const evalAfter = m.evaluation !== null ? (m.evaluation / 100).toFixed(2) : 'n/a';
  const best = m.bestMove ?? 'n/a';
  const classification = m.classification ?? 'unclassified';
  return `Move ${fullMove}. ${m.san} (${side}) — eval before: ${evalBefore}, eval after: ${evalAfter}, best: ${best}, classification: ${classification}`;
}

export async function generateNarrativeSummary(
  pgn: string,
  playerColor: string,
  openingName: string | null,
  result: string,
  playerRating: number,
  onStream?: (chunk: string) => void,
  moveData?: NarrativeMoveData[],
): Promise<string> {
  // No per-move analysis → bail out with the graceful fallback.
  // Writing prose from nothing is exactly the hallucination path
  // WO-REVIEW-01 closes.
  if (!moveData || moveData.length === 0) {
    onStream?.(NARRATIVE_SUMMARY_NO_DATA);
    return NARRATIVE_SUMMARY_NO_DATA;
  }

  // Count errors across ALL student (non-coach) moves for the tone guide.
  let blunderCount = 0;
  let mistakeCount = 0;
  let inaccuracyCount = 0;
  for (const m of moveData) {
    if (m.isCoachMove) continue;
    if (m.classification === 'blunder') blunderCount++;
    else if (m.classification === 'mistake') mistakeCount++;
    else if (m.classification === 'inaccuracy') inaccuracyCount++;
  }
  const totalErrors = blunderCount + mistakeCount + inaccuracyCount;
  const toneGuide = totalErrors === 0
    ? 'The student played cleanly — praise the accuracy without overclaiming brilliance.'
    : totalErrors <= 2
      ? 'Mostly solid play with a couple areas to improve. Be constructive.'
      : `The student made ${totalErrors} errors (${blunderCount} blunders, ${mistakeCount} mistakes, ${inaccuracyCount} inaccuracies). Be honest about what went wrong — do NOT call the game "excellent" or "great". Focus on the specific errors and what to learn from them.`;

  // Build a [Per-move analysis] block with EVERY move. Previously the
  // filter limited this to blunders/mistakes/inaccuracies, which left
  // the LLM free to invent narrative for unanalyzed moves — the
  // hallucination mode WO-REVIEW-01 is fixing. Every move gets a row.
  const coachColor: 'White' | 'Black' = playerColor === 'white' ? 'Black' : 'White';
  const rows: string[] = [];
  let prevEvalCp: number | null = 0;
  for (const m of moveData) {
    rows.push(formatMoveRow(m, prevEvalCp, coachColor));
    prevEvalCp = m.evaluation;
  }

  const perMoveBlock = `[Per-move analysis]\n${rows.join('\n')}`;
  const resultLine = `Game result: ${result}.`;
  const openingLine = openingName
    ? `Opening: ${openingName}.`
    : 'Opening: (not classified).';
  const playerLine = `Student color: ${playerColor}. Student rating: ~${playerRating}.`;
  const errorSummary = `Student errors — blunders: ${blunderCount}, mistakes: ${mistakeCount}, inaccuracies: ${inaccuracyCount}.`;

  const userMessage = [
    playerLine,
    openingLine,
    resultLine,
    errorSummary,
    `Tone: ${toneGuide}`,
    '',
    perMoveBlock,
    '',
    `PGN: ${pgn}`,
  ].join('\n');

  // WO-COACH-UNIFY-01 Review-tab parity: route through coachService.ask
  // with surface='review' so the unified envelope (REVIEW_MODE_ADDITION
  // identity + memory + live-state) wraps every Review-tab LLM call —
  // same shape as /coach/teach and /coach/play. GAME_POST_REVIEW_ADDITION
  // threads as systemPromptAddition. Empty string on provider error
  // preserves the legacy "graceful blank" contract.
  const finalFen = (() => {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess.fen();
    } catch {
      return undefined;
    }
  })();
  const spineAnswer = await coachService.ask(
    {
      surface: 'review',
      ask: userMessage,
      liveState: {
        surface: 'review',
        fen: finalFen,
        userJustDid: 'Reviewing the completed game',
        whoseTurn: finalFen?.split(' ')[1] === 'b' ? 'black' : 'white',
      },
    },
    {
      // chat_response (not game_narrative_summary) so the spine
      // envelope doesn't push deepseek-reasoner into empty-content.
      // See the segments call below for the full rationale.
      task: 'chat_response',
      maxTokens: 800,
      maxToolRoundTrips: 1,
      systemPromptAddition: GAME_POST_REVIEW_ADDITION,
      // GAME_POST_REVIEW_ADDITION wants grounded prose; surface block's
      // [VOICE:] / [BOARD:] marker mandate would leak markers into the
      // streamed summary card. Memory + live-state still inject.
      suppressSurfaceMode: true,
      onChunk: onStream,
    },
  );
  return unwrapSpineError(spineAnswer.text);
}

// ─── Review Narration Segments ─────────────────────────────────────────────

export interface ReviewNarrationSegments {
  intro: string;
  closing: string;
}

export async function generateReviewNarrationSegments(
  pgn: string,
  playerColor: string,
  openingName: string | null,
  result: string,
  playerRating: number,
  moveData?: NarrativeMoveData[],
): Promise<ReviewNarrationSegments> {
  let analysisContext = '';
  if (moveData && moveData.length > 0) {
    const keyMoves = moveData.filter((m) =>
      !m.isCoachMove && m.classification &&
      m.classification !== 'good' && m.classification !== 'book',
    );
    if (keyMoves.length > 0) {
      analysisContext = '\n\nEngine analysis of key moments:\n' +
        keyMoves.map((m) => {
          const evalText = m.evaluation !== null ? ` (eval: ${(m.evaluation / 100).toFixed(1)})` : '';
          const bestText = m.bestMove ? `, best was ${m.bestMove}` : '';
          return `- Move ${Math.ceil(m.moveNumber / 2)} ${m.san}: ${m.classification}${evalText}${bestText}`;
        }).join('\n');
    }
  }

  const context: CoachContext = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    lastMoveSan: null,
    moveNumber: 0,
    pgn,
    openingName,
    stockfishAnalysis: null,
    playerMove: null,
    moveClassification: null,
    playerProfile: {
      rating: playerRating,
      weaknesses: [],
    },
    additionalContext: `Player color: ${playerColor}. Game result: ${result}.
Generate two short narration segments for a move-by-move game review (2-3 sentences each, spoken aloud):

1. INTRO: Spoken before any moves play. Set the scene — mention the opening, early impressions, and what to watch for.
2. CLOSING: Spoken after the last move. Summarize takeaways — what went well, what to improve, and an encouraging note.

Respond ONLY with valid JSON: {"intro": "...", "closing": "..."}
Do not include any other text outside the JSON.${analysisContext}`,
  };

  // WO-COACH-UNIFY-01 final review-tab parity: route through
  // coachService.ask with surface='review' so this prep call ALSO
  // rides the unified envelope (REVIEW_MODE_ADDITION + memory +
  // live-state). Was the last legacy LLM caller in the Review path.
  // The JSON-only instruction lives inside `context.additionalContext`,
  // so it ends up in the user message via buildChessContextMessage —
  // identical wire shape as the legacy getCoachCommentary call.
  const userMessage = buildChessContextMessage(context);
  let raw = '';
  try {
    const spineAnswer = await coachService.ask(
      {
        surface: 'review',
        ask: userMessage,
        liveState: {
          surface: 'review',
          fen: context.fen,
          userJustDid: 'Generating intro/closing narration for the review',
        },
      },
      {
        // chat_response avoids the deepseek-reasoner empty-content
        // regression — see segments call for full rationale.
        task: 'chat_response',
        maxTokens: 800,
        maxToolRoundTrips: 1,
        // The user message asks for `{"intro":..., "closing":...}` JSON
        // only. REVIEW_MODE_ADDITION's [VOICE:] / [BOARD:] marker
        // mandate fights that. Skip the surface block so the JSON
        // contract wins; memory + live-state still load.
        suppressSurfaceMode: true,
      },
    );
    raw = unwrapSpineError(spineAnswer.text);
  } catch {
    // Fall through to the deterministic fallback below.
  }
  try {
    // Extract JSON from the response (may have markdown fences).
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { intro: string; closing: string };
      return { intro: parsed.intro, closing: parsed.closing };
    }
  } catch {
    // Fallback: split the text in half
  }
  // Fallback if parsing fails
  return {
    intro: openingName
      ? `Let's review this game. You played the ${openingName}.`
      : `Let's walk through this game together.`,
    closing: 'That wraps up the review. Keep practicing and learning from each game!',
  };
}

// ─── Build Context from Profile ─────────────────────────────────────────────

export function buildProfileContext(profile: UserProfile): CoachContext {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    lastMoveSan: null,
    moveNumber: 0,
    pgn: '',
    openingName: null,
    stockfishAnalysis: null,
    playerMove: null,
    moveClassification: null,
    playerProfile: {
      rating: profile.currentRating,
      weaknesses: profile.badHabits
        .filter((h) => !h.isResolved)
        .map((h) => h.description),
    },
  };
}

// ─── Walk-the-game Review Narration (WO-REVIEW-02) ──────────────────────────


/** One move's worth of review narration material. Merged at build time
 *  from the deterministic move data (FEN / classification / best move)
 *  plus the per-ply narration string the LLM returned. A null `narration`
 *  means "this move passes in silence" — the review UI advances the
 *  board but speaks nothing. */
export interface ReviewMoveSegment {
  /** 1-indexed ply count. Ply 1 = White's first move, ply 2 = Black's first. */
  ply: number;
  /** Chess "full move number" — Math.ceil(ply / 2). */
  moveNumber: number;
  san: string;
  playerColor: 'white' | 'black';
  fenBefore: string;
  fenAfter: string;
  classification: 'brilliant' | 'great' | 'good' | 'book' | 'inaccuracy' | 'mistake' | 'blunder' | 'miss' | null;
  evalBefore: number | null;
  evalAfter: number | null;
  bestMoveSan: string | null;
  bestMoveUci: string | null;
  narration: string | null;
}

export interface ReviewNarration {
  intro: string;
  segments: ReviewMoveSegment[];
  /** Optional — spoken when the user reaches the last ply. Null by default. */
  closing: string | null;
}

/** Rich move data that feeds the walk-the-game review. Includes the
 *  starting-FEN before each move so the board can rewind/replay
 *  precisely. Derived by CoachGameReview from CoachGameMove[]. */
export interface ReviewMoveInput {
  ply: number;
  san: string;
  isCoachMove: boolean;
  classification: ReviewMoveSegment['classification'];
  evaluation: number | null;
  preMoveEval: number | null;
  bestMove: string | null;
  fenAfter: string;
}

// `parseSegmentsJson` + `buildPerMoveBlock` deleted in ship-3 — both
// only fed the legacy LLM segments call (REVIEW_MOVE_SEGMENT_ADDITION),
// which has been replaced by `buildReviewSegments` (deterministic).

/** Reconstruct the FEN at each ply from the move list. Uses chess.js
 *  to replay the SAN sequence — if any SAN is invalid we bail with a
 *  shorter list (better to narrate the moves we can than refuse the
 *  whole review). */
function buildFenChain(moves: ReviewMoveInput[]): { fenBefore: string; fenAfter: string }[] {
  const chain: { fenBefore: string; fenAfter: string }[] = [];
  const chess = new Chess();
  for (const m of moves) {
    const fenBefore = chess.fen();
    let moveResult: unknown = null;
    try {
      moveResult = chess.move(m.san);
    } catch {
      moveResult = null;
    }
    if (!moveResult) break;
    chain.push({ fenBefore, fenAfter: chess.fen() });
  }
  return chain;
}

/** Convert a UCI move (e.g., "e2e4", "g7g8q") to SAN at the given
 *  pre-move FEN. Returns null when the UCI is missing or chess.js
 *  can't legally play the move from that position. Used by the
 *  deterministic narration builder to surface "best move" SANs in
 *  the per-ply prose. */
function uciToSanAt(uci: string | null, fenBefore: string): string | null {
  if (!uci || uci.length < 4) return null;
  try {
    const chess = new Chess(fenBefore);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move.san;
  } catch {
    return null;
  }
}

/**
 * Deterministic per-ply narration. Drives the walk-the-game banner
 * directly from the engine annotations — no LLM segments call (ship-3).
 *
 * Follows CLAUDE.md narration voice rules:
 *   - Silent on `book` / `good` / `null` (rule #4 — silence is OK).
 *   - No "great job" / "well played" filler on routine moves (rule #5).
 *   - Talks about the move's chess content (best alternative + swing in
 *     pawns), not the interface or restating the SAN (rules #2/3).
 *   - 3 stem variants per classification rotate by ply so the narration
 *     doesn't read like a metronome across 40 moves (rule #9).
 *
 * Returns `null` when the position deserves silence. The walk UI
 * already renders "(this move passes silently…)" for null narrations.
 */
function buildDeterministicNarration(params: {
  ply: number;
  isStudentMove: boolean;
  classification: import('../types').MoveClassification | null;
  bestMoveSan: string | null;
  preMoveEval: number | null;
  evaluation: number | null;
}): string | null {
  const { ply, isStudentMove, classification, bestMoveSan, preMoveEval, evaluation } = params;
  if (classification === null || classification === 'book' || classification === 'good') {
    return null;
  }

  const variant = ply % 3;

  // Swing magnitude in pawns (positive = how much the moving side
  // conceded). Both evals are centipawns, white POV; the absolute
  // difference is the swing regardless of moving side because the
  // classification flags the bad direction.
  const swingPawns =
    preMoveEval !== null && evaluation !== null
      ? Math.abs((preMoveEval - evaluation) / 100)
      : null;
  const swingPhrase =
    swingPawns !== null && swingPawns >= 0.1
      ? ` Drops about ${swingPawns.toFixed(1)} pawns.`
      : '';

  if (classification === 'brilliant') {
    if (isStudentMove) {
      const stems = [
        'Brilliant — that was the move.',
        'Brilliant find.',
        'Brilliant. The engine agrees.',
      ];
      return stems[variant];
    }
    return 'Brilliant shot — your opponent found the only line.';
  }

  if (classification === 'great') {
    return isStudentMove ? 'Strong, accurate move.' : null;
  }

  if (classification === 'miss') {
    if (bestMoveSan) {
      return `Missed chance — ${bestMoveSan} was the move.`;
    }
    return 'Missed chance here — the engine had a stronger continuation.';
  }

  if (classification === 'inaccuracy') {
    if (isStudentMove) {
      if (bestMoveSan) {
        const stems = [
          `Inaccuracy. ${bestMoveSan} was sharper.`,
          `Slightly off — ${bestMoveSan} kept the edge.`,
          `${bestMoveSan} was the more accurate move.`,
        ];
        return stems[variant];
      }
      return 'Inaccuracy — there was a more precise move available.';
    }
    if (bestMoveSan) {
      return `Your opponent slipped — ${bestMoveSan} was stronger.`;
    }
    return null;
  }

  if (classification === 'mistake') {
    if (isStudentMove) {
      if (bestMoveSan) {
        const stems = [
          `Mistake. The best move was ${bestMoveSan}.${swingPhrase}`,
          `${bestMoveSan} was the move — this one gave back real ground.${swingPhrase}`,
          `Mistake here. ${bestMoveSan} held the position.${swingPhrase}`,
        ];
        return stems[variant];
      }
      return `Mistake — the engine had a stronger continuation.${swingPhrase}`;
    }
    if (bestMoveSan) {
      return `Your opponent erred — ${bestMoveSan} was much better.${swingPhrase}`;
    }
    return `Your opponent gave ground here.${swingPhrase}`;
  }

  if (classification === 'blunder') {
    if (isStudentMove) {
      if (bestMoveSan) {
        const stems = [
          `Blunder. ${bestMoveSan} was the move.${swingPhrase}`,
          `Costly. ${bestMoveSan} held everything together.${swingPhrase}`,
          `Blunder — ${bestMoveSan} kept you in the game.${swingPhrase}`,
        ];
        return stems[variant];
      }
      return `Blunder — the engine had a much stronger continuation.${swingPhrase}`;
    }
    if (bestMoveSan) {
      return `Your opponent blundered — ${bestMoveSan} would have held.${swingPhrase}`;
    }
    return `Your opponent blundered here.${swingPhrase}`;
  }

  return null;
}

/**
 * Build the full `ReviewMoveSegment[]` deterministically from the
 * per-ply annotations + a reconstructed FEN chain. Exported for tests;
 * `generateReviewNarration` calls this directly. Replaces the LLM
 * segments call that used to drive the walk (ship-3) — see the
 * generateReviewNarration commentary for the rationale.
 */
export function buildReviewSegments(
  moves: ReviewMoveInput[],
): ReviewMoveSegment[] {
  const fenChain = buildFenChain(moves);
  const usable = fenChain.length;
  const segments: ReviewMoveSegment[] = [];
  for (let i = 0; i < usable; i++) {
    const m = moves[i];
    const fenPair = fenChain[i];
    const fullMove = Math.ceil(m.ply / 2);
    const moverColor: 'white' | 'black' = m.ply % 2 === 1 ? 'white' : 'black';
    const bestMoveSan = uciToSanAt(m.bestMove, fenPair.fenBefore);
    const narration = buildDeterministicNarration({
      ply: m.ply,
      isStudentMove: !m.isCoachMove,
      classification: m.classification,
      bestMoveSan,
      preMoveEval: m.preMoveEval,
      evaluation: m.evaluation,
    });
    segments.push({
      ply: m.ply,
      moveNumber: fullMove,
      san: m.san,
      playerColor: moverColor,
      fenBefore: fenPair.fenBefore,
      fenAfter: fenPair.fenAfter,
      classification: m.classification,
      evalBefore: m.preMoveEval,
      evalAfter: m.evaluation,
      bestMoveSan,
      bestMoveUci: m.bestMove,
      narration,
    });
  }
  return segments;
}

/** Fallback intro used if the LLM intro call fails. Still grounded in
 *  result + opening name. */
function defaultIntroText(params: {
  playerColor: 'white' | 'black';
  result: string;
  openingName: string | null;
  mistakeCount: number;
}): string {
  const colorWord = params.playerColor === 'white' ? 'White' : 'Black';
  const resultWord = params.result === 'win' ? 'a win' : params.result === 'loss' ? 'a loss' : 'a draw';
  const openingBit = params.openingName ? ` — ${params.openingName}.` : '.';
  const momentBit = params.mistakeCount > 0
    ? ` A few moments to review along the way.`
    : ` Mostly clean play — we'll flag what stood out.`;
  return `Let's walk through this game. You played ${colorWord} and finished with ${resultWord}${openingBit}${momentBit}`;
}

/**
 * Build the per-move walk-the-game narration for a completed game.
 *
 * ship-3 inversion: the per-ply segments come from a deterministic
 * builder (`buildReviewSegments`) driven by the Stockfish annotations
 * the analysis pipeline already produced. The legacy LLM segments
 * call (REVIEW_MOVE_SEGMENT_ADDITION) is gone — it was the single
 * point of failure for the entire walk-the-game UX:
 *   - 30s spine timeout on long games → silent walk
 *   - JSON parse failure on malformed output → silent walk
 *   - 4000-token cap truncation past ~30 plies → silent tail
 *   - Voice-marker collision with REVIEW_MODE_ADDITION → markdown leak
 *   - "Every ply gets prose" prompt → chatty filler that contradicts
 *     CLAUDE.md narration voice rules (silence is acceptable, etc.)
 *
 * The deterministic builder produces narration grounded in
 * classification + bestMove + eval swing. Silent on book/good per the
 * narration voice rules; templated prose on inaccuracy/mistake/blunder/
 * brilliant with stem rotation to avoid repetition.
 *
 * The intro LLM call is preserved — it's short (200 tokens), useful
 * framing, and doesn't load-bear the per-ply experience. If it fails,
 * a deterministic default intro covers the gap.
 */
export async function generateReviewNarration(params: {
  moves: ReviewMoveInput[];
  playerColor: 'white' | 'black';
  openingName: string | null;
  result: string;
  playerRating: number;
  /** Coach Narration verbosity ('silent' / 'brief' / 'full'). Brief
   *  caps the intro LLM call at fewer tokens so the spoken intro
   *  stays tight; silent skips the LLM call entirely (speakInternal
   *  silences playback anyway, but we save the token spend). When
   *  undefined, defaults to full-length behavior (legacy). */
  coachNarration?: 'silent' | 'brief' | 'full';
}): Promise<ReviewNarration> {
  const { moves, playerColor, openingName, result, coachNarration } = params;

  // Reconstruct FENs via chess.js so the UI can rewind cleanly.
  const fenChain = buildFenChain(moves);
  const usableCount = fenChain.length;

  // Count student mistakes for the intro tone.
  let mistakeCount = 0;
  for (const m of moves.slice(0, usableCount)) {
    if (m.isCoachMove) continue;
    if (m.classification === 'blunder' || m.classification === 'mistake' || m.classification === 'inaccuracy') {
      mistakeCount += 1;
    }
  }

  // Graceful empty case — if chess.js couldn't replay any moves, return
  // a minimal narration with just an intro so the UI can still mount.
  if (usableCount === 0) {
    return {
      intro: defaultIntroText({ playerColor, result, openingName, mistakeCount }),
      segments: [],
      closing: null,
    };
  }

  const introUserMessage = [
    `Student color: ${playerColor}.`,
    `Game result: ${result}.`,
    openingName ? `Opening: ${openingName}.` : 'Opening: (not classified).',
    `Student errors: ${mistakeCount} (blunders + mistakes + inaccuracies).`,
  ].join('\n');

  // Per-ply segments are now built deterministically from the engine
  // annotations — no LLM round-trip. The intro LLM call still rides
  // the unified envelope so it picks up memory + live-state context.
  const reviewLiveState = {
    surface: 'review' as const,
    fen: fenChain[fenChain.length - 1]?.fenAfter,
    userJustDid: 'Opening review of the completed game (prep scan)',
  };
  // Silent mode: skip the LLM intro entirely (speakInternal silences
  // playback anyway, so the spent tokens would be invisible). Falls
  // through to the deterministic defaultIntroText below.
  const skipIntroLlm = coachNarration === 'silent';
  // Brief mode: cap the intro at ~80 tokens so the spoken line stays
  // tight (~1 sentence). Full mode keeps the 200-token allowance.
  const introMaxTokens = coachNarration === 'brief' ? 80 : 200;
  const introRaw = skipIntroLlm
    ? ''
    : await coachService.ask(
      {
        surface: 'review',
        ask: introUserMessage,
        liveState: reviewLiveState,
      },
      {
        task: 'chat_response',
        maxTokens: introMaxTokens,
        maxToolRoundTrips: 1,
        systemPromptAddition: REVIEW_INTRO_ADDITION,
        // REVIEW_INTRO_ADDITION asks for prose only; REVIEW_MODE_ADDITION
        // (surface block) mandates [VOICE:] / [BOARD:] markers per turn.
        // Keep memory + live-state injection via surface='review', but
        // skip the surface mode block so the prose-only contract wins.
        suppressSurfaceMode: true,
      },
    ).then((a) => unwrapSpineError(a.text)).catch(() => '');

  // Intro: use LLM response if non-empty and not the ⚠️ error placeholder;
  // else fall back to a grounded default.
  const introTrimmed = introRaw.trim();
  const intro = introTrimmed && !introTrimmed.startsWith('⚠️')
    ? introTrimmed
    : defaultIntroText({ playerColor, result, openingName, mistakeCount });

  const segments = buildReviewSegments(moves.slice(0, usableCount));

  const narratedCount = segments.filter((s) => s.narration !== null).length;
  void logAppAudit({
    kind: 'review-segments-generated',
    category: 'subsystem',
    source: 'coachFeatureService.generateReviewNarration',
    summary: `${narratedCount} of ${segments.length} plies narrated (deterministic)`,
    details: JSON.stringify({ totalSegments: segments.length, narratedCount, source: 'deterministic-ship3' }),
  });

  return { intro, segments, closing: null };
}
