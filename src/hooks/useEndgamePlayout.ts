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
   *  marked complete (won the holding test). Default 8 — enough
   *  to play past the critical move into an obvious-win position
   *  (David's Photo 1 audit: "should have played out a few more
   *  moves until it was an obvious win"). Stockfish-side moves
   *  in between are NOT counted toward this cap. */
  fallbackPliesToPlay?: number;
  /** When true, after the curated line ends the playout enters
   *  engine fallback automatically AND completes the moment the
   *  position becomes an obvious win (mate, fresh promotion to
   *  queen, or material lead ≥ ~5 pawns). Caps at
   *  `fallbackPliesToPlay` extra student moves regardless. Used
   *  by drill puzzles where the Lichess solution often stops a
   *  few plies before the actual win materializes. */
  extendToObviousWin?: boolean;
  /** Animation delay (ms) before the opponent's auto-reply plays.
   *  Keeps the board readable rather than instantly snapping to
   *  the next position. Default 450. */
  replyDelayMs?: number;
  /** Additional SANs (in current-position notation) that should be
   *  accepted as correct in place of the curated `expectedSan` — used
   *  by review surfaces where multiple moves within an eval threshold
   *  of the engine's pick are all "good enough." When the student's
   *  move matches `expectedSan` OR appears in this list, the playout
   *  accepts and advances (curated-style). Empty/undefined keeps the
   *  default exact-match behavior. */
  acceptableSans?: string[];
  /** Explicit student side — overrides the default behavior of
   *  inferring from `startFen.split(' ')[1]`. Required when the
   *  startFen is captured mid-game (e.g. Play-it-out vs Stockfish
   *  from a tactic puzzle's terminal position) and the side-to-move
   *  in the FEN is the OPPONENT, not the student. Without this
   *  override the hook flips sides on the user and Stockfish plays
   *  the student's color. */
  studentSide?: 'white' | 'black';
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
  /** Parsed source + destination of the expected move. Available
   *  whenever expectedSan is non-empty. Drives the hint button's
   *  square highlighting. null when the move can't be parsed
   *  against the current FEN. */
  hintMove: { from: string; to: string } | null;
  /** Whether the student has revealed the hint on this prompt.
   *  Sticky for the lifetime of the current student-to-move
   *  phase; resets when the playout advances to the next prompt
   *  or is reset. Used to flag a position as imperfect (no
   *  mastery) when the hint is taken. */
  hintRevealed: boolean;
  /** Number of opponent moves left in the curated line after the
   *  student's next correct move. Used for "X moves to go" UX. */
  curatedRepliesRemaining: number;
  /** Every correct student move played in this playout — drives the
   *  post-playout Stockfish accuracy recap (David's Photo 3 audit).
   *  Resets on `reset()`. */
  studentMoveLog: StudentMoveRecord[];
}

/** A single correct student move, with the position before and
 *  after — enough for Stockfish to compute cp loss for each move. */
export interface StudentMoveRecord {
  san: string;
  fenBefore: string;
  fenAfter: string;
  /** True if the move was inside the curated line, false if it was
   *  played in the Stockfish-fallback continuation. */
  curated: boolean;
}

export interface EndgamePlayoutControls {
  /** Wire to ConsistentChessboard.onPieceDrop. Returns true when
   *  the drop is the correct move (board updates), false otherwise
   *  (board snaps back, red flash fires). */
  onPieceDrop: (args: PieceDropHandlerArgs) => boolean;
  /** Direct move API for click-to-move flows. The host component
   *  tracks "selected from square" via onSquareClick and calls
   *  this once the user clicks a destination. Returns true when
   *  accepted, false on rejection. Same semantics as onPieceDrop. */
  playMove: (from: string, to: string) => boolean;
  /** Reset the playout to its starting FEN, wipe state. Used by
   *  the "Try again" button. */
  reset: () => void;
  /** Manually skip the playout to complete with `firstTryPerfect`
   *  false. Used by "Reveal answer" / "Give up" affordances. The
   *  curated line is auto-played at full speed to land on the
   *  final position. */
  reveal: () => void;
  /** Reveal the hint for the current prompt — flips
   *  hintRevealed to true and sets firstTryPerfect to false.
   *  Idempotent on repeated calls. */
  revealHint: () => void;
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
    stockfishFallback: stockfishFallbackOption = false,
    fallbackDifficulty = 'easy',
    fallbackPlayerElo = 1500,
    fallbackPliesToPlay = 4,
    extendToObviousWin = false,
    replyDelayMs = 450,
    acceptableSans,
    studentSide: studentSideOverride,
  } = options;
  // Extend-to-obvious-win implies fallback is on; treat them as
  // a single effective flag in the playOpponentReply path.
  const stockfishFallback = stockfishFallbackOption || extendToObviousWin;

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
    () => studentSideOverride ?? (startFen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [startFen, studentSideOverride],
  );

  // chess.js instance is owned by a ref so it doesn't re-create on
  // every render. Reset rebuilds it from startFen.
  const chessRef = useRef<Chess>(new Chess(startFen));
  const [fen, setFen] = useState<string>(startFen);
  const [studentMovesPlayed, setStudentMovesPlayed] = useState<number>(0);
  const [wrongAttempts, setWrongAttempts] = useState<number>(0);
  const [wrongSquare, setWrongSquare] = useState<string | null>(null);
  const [firstTryPerfect, setFirstTryPerfect] = useState<boolean>(true);
  // Phase 7c (free-play piece-mates): when there's no curated line but
  // stockfishFallback is on, the student starts in 'student-to-move' so
  // they can drive the lone king around. Without this the playout
  // would mark itself complete on mount.
  const [phase, setPhase] = useState<PlayoutPhase>(
    effectiveLine.length > 0
      ? 'student-to-move'
      : stockfishFallback
        ? 'student-to-move'
        : 'complete',
  );
  const [fallbackPliesPlayed, setFallbackPliesPlayed] = useState<number>(0);
  const [fallbackOutcome, setFallbackOutcome] =
    useState<'curated' | 'survived' | 'unknown'>('curated');
  const [hintRevealed, setHintRevealed] = useState<boolean>(false);
  const [studentMoveLog, setStudentMoveLog] = useState<StudentMoveRecord[]>([]);

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
    setHintRevealed(false);
    setPhase(
      effectiveLine.length > 0
        ? 'student-to-move'
        : stockfishFallback
          ? 'student-to-move'
          : 'complete',
    );
    setStudentMoveLog([]);
  }, [startFen, effectiveLine.length, stockfishFallback]);

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
    // If the student's last move already ended the game (mate,
    // stalemate, insufficient material, …), there is no reply to
    // play — surface the outcome immediately.
    if (chessRef.current.isGameOver()) {
      if (chessRef.current.isCheckmate()) setFallbackOutcome('survived');
      setPhase('complete');
      return;
    }
    // Promotion is an obvious-win signal — David's Photo 1 audit
    // wanted the playout to keep going past the critical move
    // "until it was an obvious win." Once the student queens a
    // pawn the lesson is over regardless of whose turn comes next.
    const lastMove = chessRef.current.history({ verbose: true }).slice(-1)[0];
    if (lastMove.flags.includes('p')) {
      setFallbackOutcome('survived');
      setPhase('complete');
      return;
    }
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
      // Opponent's reply ended the game — stop here.
      if (chessRef.current.isGameOver()) {
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
    // Two paths to "playout done" in fallback:
    //   1. extendToObviousWin: complete as soon as the position
    //      is mate / fresh promotion / decisively winning. The
    //      fallback-plies cap still applies as a safety net.
    //   2. fixed-plies (Eval Lab style): play exactly
    //      fallbackPliesToPlay extra student moves, then complete.
    const reachedObvious = extendToObviousWin && isObviousWin(chessRef.current, studentSide);
    const reachedCap = fallbackPliesPlayed + 1 >= fallbackPliesToPlay;
    if (reachedObvious || reachedCap) {
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
    extendToObviousWin,
    studentSide,
  ]);

  // Kick Stockfish off when the playout mounts in fallback mode with
  // the OPPONENT to move (e.g. tactic-puzzle Play-it-out, where the
  // captured FEN was taken right after the student's last curated move
  // so it's now the opponent's turn). Without this the UI sits in
  // 'student-to-move' but the student can't legally move because it
  // isn't their turn — and the engine never wakes up.
  useEffect(() => {
    if (!stockfishFallback) return;
    if (effectiveLine.length > 0) return; // curated line drives turn order
    if (chessRef.current.history().length > 0) return; // already in motion
    const turn = chessRef.current.turn(); // 'w' | 'b'
    const studentTurn = studentSide === 'white' ? 'w' : 'b';
    if (turn === studentTurn) return;
    void playOpponentReply();
    // playOpponentReply is a useCallback that we intentionally exclude
    // from the deps — including it would re-kick on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startFen, stockfishFallback, effectiveLine.length, studentSide]);

  /** Attempt a move at the current position. Returns true when the
   *  move was accepted (curated-correct or in-fallback legal),
   *  false when rejected (wrong move flashes red, attempt counter
   *  bumps). Shared by onPieceDrop (drag) and onSquareClick
   *  (click-to-move) — both call into this. */
  const playMove = useCallback(
    (from: string, to: string): boolean => {
      if (phase !== 'student-to-move') return false;
      // Probe the move on a copy so a wrong attempt doesn't mutate
      // the running game.
      const probe = new Chess(chessRef.current.fen());
      let played;
      try {
        played = probe.move({ from, to, promotion: 'q' });
      } catch {
        return false;
      }
      // Inside the curated line — must match the expected SAN or
      // one of the host-supplied `acceptableSans` alternates (review
      // surfaces use the latter to accept any move within an eval
      // threshold of the engine's pick).
      if (expectedSan) {
        const expectedClean = stripSan(expectedSan);
        const playedClean = stripSan(played.san);
        const isAcceptableAlternate =
          !!acceptableSans &&
          acceptableSans.some((s) => stripSan(s) === playedClean);
        if (playedClean !== expectedClean && !isAcceptableAlternate) {
          setWrongSquare(to);
          setWrongAttempts((n) => n + 1);
          setFirstTryPerfect(false);
          return false;
        }
        // Correct curated move.
        const fenBefore = chessRef.current.fen();
        chessRef.current.move(played.san);
        const fenAfter = chessRef.current.fen();
        setFen(fenAfter);
        setStudentMovesPlayed((n) => n + 1);
        setStudentMoveLog((log) => [
          ...log,
          { san: played.san, fenBefore, fenAfter, curated: true },
        ]);
        setWrongAttempts(0);
        setHintRevealed(false);
        void playOpponentReply();
        return true;
      }
      // Fallback (Stockfish) territory — any legal move is accepted.
      const fenBefore = chessRef.current.fen();
      chessRef.current.move(played.san);
      const fenAfter = chessRef.current.fen();
      setFen(fenAfter);
      setStudentMovesPlayed((n) => n + 1);
      setFallbackPliesPlayed((n) => n + 1);
      setHintRevealed(false);
      setStudentMoveLog((log) => [
        ...log,
        { san: played.san, fenBefore, fenAfter, curated: false },
      ]);
      void playOpponentReply();
      return true;
    },
    [phase, expectedSan, acceptableSans, playOpponentReply],
  );

  const onPieceDrop = useCallback(
    (args: PieceDropHandlerArgs): boolean => {
      if (!args.sourceSquare || !args.targetSquare) return false;
      return playMove(args.sourceSquare, args.targetSquare);
    },
    [playMove],
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
    setHintRevealed(false);
    setPhase(
      effectiveLine.length > 0
        ? 'student-to-move'
        : stockfishFallback
          ? 'student-to-move'
          : 'complete',
    );
    setStudentMoveLog([]);
  }, [startFen, effectiveLine.length, stockfishFallback]);

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

  // Parse the expected SAN against the current FEN to derive
  // from/to squares for the hint button's highlighting. Cheap;
  // recomputes whenever the prompt changes.
  const hintMove = useMemo<{ from: string; to: string } | null>(() => {
    if (!expectedSan) return null;
    try {
      const probe = new Chess(fen);
      const moves = probe.moves({ verbose: true });
      const stripped = stripSan(expectedSan);
      const match = moves.find((m) => stripSan(m.san) === stripped);
      if (!match) return null;
      return { from: match.from, to: match.to };
    } catch {
      return null;
    }
  }, [expectedSan, fen]);

  const revealHint = useCallback((): void => {
    setHintRevealed(true);
    setFirstTryPerfect(false);
  }, []);

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
    hintMove,
    hintRevealed,
    curatedRepliesRemaining,
    studentMoveLog,
    onPieceDrop,
    playMove,
    reset,
    reveal,
    revealHint,
  };
}

/** Return true when the position is clearly won/decided for the
 *  student side — mate on the board OR material lead ≥ ~5 pawn
 *  units OR a fresh promotion to queen (the rook the student just
 *  promoted is counted in material; if the side-to-move's queen
 *  count exceeded the start-of-game count, that's "fresh"
 *  promotion). Used by the drill-extension fallback to stop the
 *  playout once the win has materialized.
 *
 *  We don't call into Stockfish here — chess.js material + game
 *  state is enough for the "obvious" threshold. Edge cases (e.g.
 *  zugzwang win with equal material) won't trip, which is the
 *  right call: the fallback-plies cap still completes the drill. */
function isObviousWin(chess: Chess, studentSide: 'white' | 'black'): boolean {
  if (chess.isCheckmate()) {
    // chess.js: turn() returns the side to move; if it's mate
    // then the SIDE TO MOVE is mated. So the winner is the OTHER
    // side. Match against the student.
    const mated = chess.turn();
    const studentMated = (mated === 'w' && studentSide === 'white') ||
      (mated === 'b' && studentSide === 'black');
    return !studentMated;
  }
  const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let whiteMat = 0;
  let blackMat = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUE[sq.type] ?? 0;
      if (sq.color === 'w') whiteMat += v;
      else blackMat += v;
    }
  }
  const studentEdge = studentSide === 'white' ? whiteMat - blackMat : blackMat - whiteMat;
  return studentEdge >= 5;
}
