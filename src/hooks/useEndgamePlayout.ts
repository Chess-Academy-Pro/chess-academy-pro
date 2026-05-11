/**
 * useEndgamePlayout
 * -----------------
 * Multi-ply playout runner for endgame lessons. The student plays
 * each of their moves on the board; the opponent's curated reply
 * auto-plays after a brief animation delay. Wrong move flashes
 * red, the position stays, the student retries until they find
 * the move.
 *
 * Two flavours of "the answer":
 *   1. Curated `solution` (SAN[], alternating student/opponent
 *      starting with the student) — every move is hand-authored
 *      from named chess theory. This is the canonical path.
 *   2. Stockfish fallback — when the curated line ends OR is empty
 *      but a single `bestMove` is provided, the student plays their
 *      move and the engine plays the reply via getCoachMove(). Used
 *      by Eval Lab stage 2 ("play it out") to test whether the
 *      student can hold the eval through a real engine response.
 *
 * Architectural contract: this hook NEVER asks an LLM what to play.
 * Curated moves come from the lesson JSON; engine moves come from
 * Stockfish via coachPlaySession. The hook is pure runtime — no
 * authorship at runtime, per CLAUDE.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { PieceDropHandlerArgs } from 'react-chessboard';
import { getCoachMove, resolveConfig } from '../services/coachPlaySession';
import type { CoachDifficulty } from '../services/coachAgent';

/** Strip annotations from a SAN so comparison is robust to "+#!?"
 *  decorations or promotion suffix differences. */
function stripSan(san: string): string {
  return san.replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
}

export interface EndgamePlayoutOptions {
  /** Starting position. Side-to-move in this FEN is the student. */
  startFen: string;
  /** Curated alternating SAN sequence. Index 0 = first student
   *  move, index 1 = opponent's reply, index 2 = next student move,
   *  ... Pass [] when only a single bestMove is curated. */
  solution: string[];
  /** Optional single first-move-only answer when no full solution
   *  is curated. The hook uses it as solution[0] when solution is
   *  empty. */
  bestMove?: string;
  /** When true, after the curated line is exhausted the engine
   *  takes over as opponent (Eval Lab stage 2). When false, the
   *  playout marks `complete` as soon as the curated line ends.
   *  Default false. */
  stockfishFallback?: boolean;
  /** Difficulty for the Stockfish opponent during fallback. Only
   *  used when stockfishFallback === true. Defaults to 'easy' so
   *  the student is rewarded for finding the right idea without
   *  needing engine-perfect technique. */
  fallbackDifficulty?: CoachDifficulty;
  /** Player ELO used by resolveConfig for the fallback engine.
   *  Defaults to 1500. */
  fallbackPlayerElo?: number;
  /** How many extra plies of student play to require in the
   *  fallback. After this many student moves, the playout is
   *  marked complete (won the holding test). Default 4. */
  fallbackPliesToPlay?: number;
  /** Animation delay (ms) before the opponent's auto-reply plays.
   *  Keeps the board readable rather than instantly snapping to
   *  the next position. Default 450. */
  replyDelayMs?: number;
}

export type PlayoutPhase =
  | 'idle'                   // No active playout (before start, after reset)
  | 'student-to-move'        // Waiting for the student's piece drop
  | 'opponent-replying'      // Opponent's curated/engine move is being animated
  | 'complete'               // Full sequence played successfully
  | 'failed';                // Reserved for future "give up" state

export interface EndgamePlayoutState {
  /** Current FEN displayed on the board. */
  fen: string;
  /** Side the student is playing. Computed from startFen. */
  studentSide: 'white' | 'black';
  /** Phase of the playout — drives UI state. */
  phase: PlayoutPhase;
  /** Number of correct student moves played so far. */
  studentMovesPlayed: number;
  /** Total student moves the curated line contains (or 0 when only
   *  bestMove is present without a full solution). */
  curatedStudentMoves: number;
  /** Number of wrong-move attempts on the CURRENT prompt. Resets
   *  to 0 when the student finds the right move and advances. */
  wrongAttempts: number;
  /** Last wrong destination square for red-flash UI. null when no
   *  recent wrong attempt OR when the flash timer has expired. */
  wrongSquare: string | null;
  /** Whether the student got the answer right on the FIRST try
   *  across the entire playout. Goes false the moment they make
   *  one wrong drop. Used for "perfect run" UI badges. */
  firstTryPerfect: boolean;
  /** True once the playout reaches the 'complete' phase. */
  isComplete: boolean;
  /** When stockfishFallback is true, this is the outcome of the
   *  fallback play: 'curated' (didn't reach fallback), 'survived'
   *  (held the eval through fallback plies), or 'unknown' (mid-
   *  fallback). For Eval Lab stage 2 reveal. */
  fallbackOutcome: 'curated' | 'survived' | 'unknown';
  /** The SAN the student should play right now. Exposed so the UI
   *  can render a "Show hint" button or post-bail reveal. Empty
   *  string when no expected move (engine fallback phase or done). */
  expectedSan: string;
  /** Number of opponent moves left in the curated line after the
   *  student's next correct move. Used for "X moves to go" UX. */
  curatedRepliesRemaining: number;
}

export interface EndgamePlayoutControls {
  /** Wire to ConsistentChessboard.onPieceDrop. Returns true when
   *  the drop is the correct move (board updates), false otherwise
   *  (board snaps back, red flash fires). */
  onPieceDrop: (args: PieceDropHandlerArgs) => boolean;
  /** Reset the playout to its starting FEN, wipe state. Used by
   *  the "Try again" button. */
  reset: () => void;
  /** Manually skip the playout to complete with `firstTryPerfect`
   *  false. Used by "Reveal answer" / "Give up" affordances. The
   *  curated line is auto-played at full speed to land on the
   *  final position. */
  reveal: () => void;
}

/** The hook return shape — state + controls. Components destructure
 *  what they need. */
export type EndgamePlayoutResult = EndgamePlayoutState & EndgamePlayoutControls;

/** Multi-ply endgame playout runner.
 *
 *  Usage:
 *    const playout = useEndgamePlayout({ startFen, solution });
 *    <ConsistentChessboard fen={playout.fen} interactive={playout.phase === 'student-to-move'}
 *      onPieceDrop={playout.onPieceDrop} squareStyles={...flash} />
 *
 *  The hook owns the chess.js instance and the timing of opponent
 *  replies. The host component only renders + reads state. */
export function useEndgamePlayout(options: EndgamePlayoutOptions): EndgamePlayoutResult {
  const {
    startFen,
    solution,
    bestMove,
    stockfishFallback = false,
    fallbackDifficulty = 'easy',
    fallbackPlayerElo = 1500,
    fallbackPliesToPlay = 4,
    replyDelayMs = 450,
  } = options;

  // Build the effective curated line: if solution is empty but
  // bestMove is present, treat bestMove as a 1-move curated line.
  const effectiveLine = useMemo<string[]>(() => {
    if (solution.length > 0) return solution;
    if (bestMove) return [bestMove];
    return [];
  }, [solution, bestMove]);

  // Total student moves in the curated line (every even index 0,2,4…).
  const curatedStudentMoves = useMemo<number>(() => {
    let count = 0;
    for (let i = 0; i < effectiveLine.length; i += 2) count += 1;
    return count;
  }, [effectiveLine]);

  const studentSide = useMemo<'white' | 'black'>(
    () => (startFen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [startFen],
  );

  // chess.js instance is owned by a ref so it doesn't re-create on
  // every render. Reset rebuilds it from startFen.
  const chessRef = useRef<Chess>(new Chess(startFen));
  const [fen, setFen] = useState<string>(startFen);
  const [studentMovesPlayed, setStudentMovesPlayed] = useState<number>(0);
  const [wrongAttempts, setWrongAttempts] = useState<number>(0);
  const [wrongSquare, setWrongSquare] = useState<string | null>(null);
  const [firstTryPerfect, setFirstTryPerfect] = useState<boolean>(true);
  const [phase, setPhase] = useState<PlayoutPhase>(
    effectiveLine.length > 0 ? 'student-to-move' : 'complete',
  );
  const [fallbackPliesPlayed, setFallbackPliesPlayed] = useState<number>(0);
  const [fallbackOutcome, setFallbackOutcome] =
    useState<'curated' | 'survived' | 'unknown'>('curated');

  // Reset state + chess.js whenever startFen changes (lesson navigation).
  useEffect(() => {
    chessRef.current = new Chess(startFen);
    setFen(startFen);
    setStudentMovesPlayed(0);
    setWrongAttempts(0);
    setWrongSquare(null);
    setFirstTryPerfect(true);
    setFallbackPliesPlayed(0);
    setFallbackOutcome(effectiveLine.length > 0 ? 'curated' : 'survived');
    setPhase(effectiveLine.length > 0 ? 'student-to-move' : 'complete');
  }, [startFen, effectiveLine.length]);

  // Auto-clear the wrong-square red flash after 600ms.
  useEffect(() => {
    if (!wrongSquare) return;
    const t = window.setTimeout(() => setWrongSquare(null), 600);
    return () => window.clearTimeout(t);
  }, [wrongSquare]);

  // The expected SAN for the student's current move.
  const expectedSan = useMemo<string>(() => {
    const idx = studentMovesPlayed * 2;
    if (idx < effectiveLine.length) return effectiveLine[idx];
    return '';
  }, [effectiveLine, studentMovesPlayed]);

  /** Play the opponent's curated reply (or engine move) and advance
   *  the phase. Called after the student's correct move lands. */
  const playOpponentReply = useCallback(async (): Promise<void> => {
    const curatedIdx = studentMovesPlayed * 2 + 1;
    // Curated reply available — play it after the animation delay.
    if (curatedIdx < effectiveLine.length) {
      setPhase('opponent-replying');
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, replyDelayMs),
      );
      const reply = effectiveLine[curatedIdx];
      try {
        chessRef.current.move(reply);
        setFen(chessRef.current.fen());
      } catch {
        // Curated line is broken — surface as complete rather than
        // hanging the UI. The build-time audit should have caught
        // this, but defensive in case a hand-edit slipped through.
        setPhase('complete');
        return;
      }
      // Check if there are more student moves in the curated line.
      const nextStudentIdx = (studentMovesPlayed + 1) * 2;
      if (nextStudentIdx < effectiveLine.length) {
        setPhase('student-to-move');
      } else {
        // Curated line consumed. Either kick off Stockfish fallback
        // or mark complete.
        if (stockfishFallback) {
          setFallbackOutcome('unknown');
          setPhase('student-to-move');
        } else {
          setPhase('complete');
        }
      }
      return;
    }
    // No curated reply — we're in Stockfish fallback territory.
    if (!stockfishFallback) {
      setPhase('complete');
      return;
    }
    setPhase('opponent-replying');
    try {
      const config = resolveConfig(fallbackDifficulty, fallbackPlayerElo);
      const move = await getCoachMove(chessRef.current.fen(), config);
      chessRef.current.move({ from: move.from, to: move.to, promotion: move.promotion });
      setFen(chessRef.current.fen());
    } catch {
      // Engine failure → end the playout. We don't want to leave
      // the UI in 'opponent-replying' forever.
      setPhase('complete');
      return;
    }
    // Count this fallback ply (engine's reply). If we've played
    // enough student moves in fallback, mark survived.
    if (fallbackPliesPlayed + 1 >= fallbackPliesToPlay) {
      setFallbackOutcome('survived');
      setPhase('complete');
    } else {
      setPhase('student-to-move');
    }
  }, [
    studentMovesPlayed,
    effectiveLine,
    replyDelayMs,
    stockfishFallback,
    fallbackDifficulty,
    fallbackPlayerElo,
    fallbackPliesPlayed,
    fallbackPliesToPlay,
  ]);

  const onPieceDrop = useCallback(
    (args: PieceDropHandlerArgs): boolean => {
      if (phase !== 'student-to-move') return false;
      if (!args.sourceSquare || !args.targetSquare) return false;
      // Probe the move on a copy so a wrong attempt doesn't mutate
      // the running game.
      const probe = new Chess(chessRef.current.fen());
      let played;
      try {
        played = probe.move({
          from: args.sourceSquare,
          to: args.targetSquare,
          promotion: 'q',
        });
      } catch {
        return false;
      }
      // Inside the curated line — must match the expected SAN.
      if (expectedSan) {
        const expectedClean = stripSan(expectedSan);
        const playedClean = stripSan(played.san);
        if (playedClean !== expectedClean) {
          setWrongSquare(args.targetSquare);
          setWrongAttempts((n) => n + 1);
          setFirstTryPerfect(false);
          return false;
        }
        // Correct curated move.
        chessRef.current.move(played.san);
        setFen(chessRef.current.fen());
        setStudentMovesPlayed((n) => n + 1);
        setWrongAttempts(0);
        void playOpponentReply();
        return true;
      }
      // Fallback (Stockfish) territory — any legal move is accepted.
      // The engine's response decides whether the student held the
      // eval. (For Eval Lab stage 2.)
      chessRef.current.move(played.san);
      setFen(chessRef.current.fen());
      setStudentMovesPlayed((n) => n + 1);
      setFallbackPliesPlayed((n) => n + 1);
      void playOpponentReply();
      return true;
    },
    [phase, expectedSan, playOpponentReply],
  );

  const reset = useCallback((): void => {
    chessRef.current = new Chess(startFen);
    setFen(startFen);
    setStudentMovesPlayed(0);
    setWrongAttempts(0);
    setWrongSquare(null);
    setFirstTryPerfect(true);
    setFallbackPliesPlayed(0);
    setFallbackOutcome(effectiveLine.length > 0 ? 'curated' : 'survived');
    setPhase(effectiveLine.length > 0 ? 'student-to-move' : 'complete');
  }, [startFen, effectiveLine.length]);

  const reveal = useCallback((): void => {
    // Auto-play the entire remaining curated line and mark complete
    // with firstTryPerfect=false. Used by "Reveal answer".
    const chess = chessRef.current;
    let played = studentMovesPlayed;
    for (let i = played * 2; i < effectiveLine.length; i += 1) {
      try {
        chess.move(effectiveLine[i]);
      } catch {
        break;
      }
      if (i % 2 === 0) played += 1;
    }
    setFen(chess.fen());
    setStudentMovesPlayed(played);
    setFirstTryPerfect(false);
    setPhase('complete');
  }, [effectiveLine, studentMovesPlayed]);

  const curatedRepliesRemaining = useMemo<number>(() => {
    const consumedReplies = studentMovesPlayed; // each correct student move triggers one reply
    const totalCuratedReplies = Math.floor(effectiveLine.length / 2);
    return Math.max(0, totalCuratedReplies - consumedReplies);
  }, [effectiveLine.length, studentMovesPlayed]);

  return {
    fen,
    studentSide,
    phase,
    studentMovesPlayed,
    curatedStudentMoves,
    wrongAttempts,
    wrongSquare,
    firstTryPerfect,
    isComplete: phase === 'complete',
    fallbackOutcome,
    expectedSan,
    curatedRepliesRemaining,
    onPieceDrop,
    reset,
    reveal,
  };
}
