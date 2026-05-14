import { useState, useCallback, useEffect, useRef } from 'react';
import { ControlledChessBoard } from '../Board/ControlledChessBoard';
import { EngineLines } from '../Board/EngineLines';
import { useChessGame } from '../../hooks/useChessGame';
import { useSettings } from '../../hooks/useSettings';
import { stockfishEngine } from '../../services/stockfishEngine';
import { getCoachChatResponse } from '../../services/coachApi';
import { speechService } from '../../services/speechService';
import { sanitizeForTTS } from '../../services/voiceService';
import { ArrowLeft, MessageCircle, Volume2, VolumeX, Undo, Lightbulb } from 'lucide-react';
import type {
  MiddlegamePlan,
  StockfishAnalysis,
  AnalysisLine,
  BoardArrow,
} from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';

interface MiddlegamePracticeProps {
  plan: MiddlegamePlan;
  playerColor: 'white' | 'black';
  onExit: () => void;
}

interface CoachMessage {
  role: 'user' | 'assistant';
  content: string;
}

const BEST_MOVE_COLOR = 'rgba(255, 215, 0, 0.85)';
const ALT_MOVE_COLOR_2 = 'rgba(148, 163, 184, 0.5)';
const ALT_MOVE_COLOR_3 = 'rgba(148, 163, 184, 0.35)';

function uciToSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function buildPlanContext(plan: MiddlegamePlan): string {
  const lines: string[] = [];
  lines.push(`MIDDLEGAME PLAN: "${plan.title}"`);
  lines.push(`OVERVIEW: ${plan.overview}`);

  if (plan.pawnBreaks.length > 0) {
    lines.push('\nKEY PAWN BREAKS:');
    for (const pb of plan.pawnBreaks) {
      lines.push(`- ${pb.move}: ${pb.explanation}`);
    }
  }

  if (plan.pieceManeuvers.length > 0) {
    lines.push('\nKEY PIECE MANEUVERS:');
    for (const pm of plan.pieceManeuvers) {
      lines.push(`- ${pm.piece} (${pm.route}): ${pm.explanation}`);
    }
  }

  if (plan.strategicThemes.length > 0) {
    lines.push('\nSTRATEGIC THEMES:');
    for (const theme of plan.strategicThemes) {
      lines.push(`- ${theme}`);
    }
  }

  if (plan.endgameTransitions.length > 0) {
    lines.push('\nENDGAME TRANSITIONS:');
    for (const et of plan.endgameTransitions) {
      lines.push(`- ${et}`);
    }
  }

  return lines.join('\n');
}

const MIDDLEGAME_PRACTICE_PROMPT = `You are coaching a student through middlegame practice. They are playing from a specific position and you know the middlegame plan they should be executing.

YOUR JOB:
- After each student move, give brief feedback (1-2 sentences max)
- If the move MATCHES a plan idea (a pawn break, piece maneuver, or strategic theme), praise it and explain why it's good
- If the move is REASONABLE but doesn't match the plan, acknowledge it and gently suggest the plan's idea
- If the move is BAD (Stockfish says it loses material or position), warn them concisely
- Reference the specific plan ideas (pawn breaks, maneuvers) by name when relevant
- Keep it conversational and encouraging — like a coach sitting next to them

DO NOT:
- Give long lectures — keep each comment under 40 words
- Repeat the move notation back to them
- List engine lines or evaluation numbers
- Be discouraging — always frame suggestions positively

After 10+ moves, if asked for a summary, give a brief assessment of how well they executed the plan.`;

/** Strip a leading move-notation citation from text destined for TTS.
 *  The system prompt instructs the LLM not to repeat the move
 *  notation back ("DO NOT … Repeat the move notation back to them"),
 *  but it sometimes leads with "Rf8...d8:" or "**Nxf7** —" anyway.
 *  sanitizeForTTS expands SAN to plain English ("knight takes f7"),
 *  which the student then hears as the first thing on every reply.
 *  Strip it here so the spoken version cuts straight to the
 *  conceptual feedback. The displayed text bubble keeps the prefix
 *  as visual context. */
const LEADING_CITATION_RE = new RegExp(
  // optional whitespace + optional **bold** open
  '^[\\s*]*' +
  // SAN token (piece + optional file/rank/capture + dest + check/promo) OR castle
  '(?:O-O-?O?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)' +
  // optional repeats joined by ellipsis / arrow / hyphen / em-dash
  // (chess citations use any of: "Rf8...d8", "Nf3-d2", "Rf8…d8",
  // "Nf3 → d2"). Single hyphen between two SAN-shaped tokens is
  // safe here because the SAN pattern requires "[a-h][1-8]" — plain
  // English words won't match the join target.
  '(?:\\s*(?:\\.{2,}|…|→|–|—|-)\\s*' +
    '(?:O-O-?O?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?))*' +
  // optional **bold** close + whitespace
  '[\\s*]*' +
  // separator that confirms this was a CITATION, not the start of a
  // legitimate sentence: colon, em/en-dash, hyphen, newline
  '(?:[:—–\\-\\n])\\s*',
);
function stripLeadingMoveCitation(text: string): string {
  return text.replace(LEADING_CITATION_RE, '');
}

function buildEngineArrows(analysis: StockfishAnalysis): BoardArrow[] {
  const arrows: BoardArrow[] = [];
  const colors = [BEST_MOVE_COLOR, ALT_MOVE_COLOR_2, ALT_MOVE_COLOR_3];

  for (let i = 0; i < analysis.topLines.length && i < 3; i++) {
    const line = analysis.topLines[i];
    const move = line.moves[0];
    if (!move) continue;
    const { from, to } = uciToSquares(move);
    arrows.push({ startSquare: from, endSquare: to, color: colors[i] });
  }

  if (arrows.length === 0 && analysis.bestMove) {
    const { from, to } = uciToSquares(analysis.bestMove);
    arrows.push({ startSquare: from, endSquare: to, color: BEST_MOVE_COLOR });
  }

  return arrows;
}

export function MiddlegamePractice({
  plan,
  playerColor,
  onExit,
}: MiddlegamePracticeProps): JSX.Element {
  const game = useChessGame(plan.criticalPositionFen, playerColor);
  const { settings } = useSettings();
  const showEngineLines = settings.showEngineLines;

  const [coachText, setCoachText] = useState<string>(
    'Let\'s practice this plan! Make your move.',
  );
  const [isCoachThinking, setIsCoachThinking] = useState(false);
  const [isNarrating, setIsNarrating] = useState(false);
  const [moveCount, setMoveCount] = useState(0);
  const [engineAnalysis, setEngineAnalysis] = useState<StockfishAnalysis | null>(null);
  const [engineArrows, setEngineArrows] = useState<BoardArrow[]>([]);
  const [topLines, setTopLines] = useState<AnalysisLine[]>([]);
  const [isEngineMoving, setIsEngineMoving] = useState(false);

  const chatHistoryRef = useRef<CoachMessage[]>([]);
  const planContextRef = useRef(buildPlanContext(plan));
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Set board orientation
  useEffect(() => {
    game.setOrientation(playerColor);
  }, [playerColor, game.setOrientation]);

  // Analyze position for engine lines when it's player's turn
  const analyzePosition = useCallback(async (fen: string) => {
    try {
      const analysis = await stockfishEngine.queueAnalysis(fen, 16);
      if (!isMountedRef.current) return;
      setEngineAnalysis(analysis);
      setTopLines(analysis.topLines);
      if (showEngineLines) {
        setEngineArrows(buildEngineArrows(analysis));
      } else {
        setEngineArrows([]);
      }
    } catch {
      // Analysis cancelled or failed — ignore
    }
  }, [showEngineLines]);

  // Check if it's the engine's turn and make a move
  const isEngineTurn = useCallback((): boolean => {
    const turn = game.turn;
    return (playerColor === 'white' && turn === 'b') ||
           (playerColor === 'black' && turn === 'w');
  }, [game.turn, playerColor]);

  // Engine makes a move
  const makeEngineMove = useCallback(async () => {
    if (!isEngineTurn() || isEngineMoving) return;
    setIsEngineMoving(true);
    setEngineArrows([]);

    try {
      // Small delay so it feels natural
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (!isMountedRef.current) return;

      const bestMove = await stockfishEngine.getBestMove(game.fen, 800);
      if (!isMountedRef.current) return;

      if (bestMove) {
        const from = bestMove.slice(0, 2);
        const to = bestMove.slice(2, 4);
        const promotion = bestMove.length > 4 ? bestMove[4] : undefined;
        game.makeMove(from, to, promotion);
      }
    } catch {
      // Engine failed — ignore
    } finally {
      if (isMountedRef.current) {
        setIsEngineMoving(false);
      }
    }
  }, [game, isEngineTurn, isEngineMoving]);

  // After each position change, check if engine should move or analyze
  useEffect(() => {
    if (game.isCheckmate || game.isStalemate || game.isDraw) return;

    if (isEngineTurn()) {
      void makeEngineMove();
    } else {
      // Player's turn — analyze for engine lines
      void analyzePosition(game.fen);
    }
  }, [game.fen, game.isCheckmate, game.isStalemate, game.isDraw, isEngineTurn, makeEngineMove, analyzePosition]);

  // Get coach feedback after player move
  const getCoachFeedback = useCallback(async (moveSan: string, fen: string) => {
    setIsCoachThinking(true);

    try {
      // Get quick analysis for the move
      const analysis = await stockfishEngine.queueAnalysis(fen, 14);
      if (!isMountedRef.current) return;

      const evalStr = analysis.isMate
        ? `Mate in ${analysis.mateIn}`
        : `${(analysis.evaluation / 100).toFixed(1)} pawns`;

      const userMsg: CoachMessage = {
        role: 'user',
        content: `Position (FEN): ${fen}\nStudent played: ${moveSan} (move ${moveCount + 1})\nStockfish evaluation after this move: ${evalStr} (depth ${analysis.depth})\nBest move was: ${analysis.bestMove}\n\nGive brief feedback on this move in context of the middlegame plan.`,
      };

      chatHistoryRef.current.push(userMsg);

      const systemAddition = `${MIDDLEGAME_PRACTICE_PROMPT}\n\n${planContextRef.current}`;

      const response = await getCoachChatResponse(
        chatHistoryRef.current,
        systemAddition,
        undefined,
        'explore_reaction',
        256,
      );

      if (!isMountedRef.current) return;

      const assistantMsg: CoachMessage = { role: 'assistant', content: response };
      chatHistoryRef.current.push(assistantMsg);

      setCoachText(response);

      if (isNarrating) {
        // LLM response sometimes leads with a move citation
        // ("Rf8...d8:" or "**Nxf7** —") despite the prompt's
        // explicit "Do not repeat the move notation back."
        // stripLeadingMoveCitation drops the SAN prefix so the
        // student hears the conceptual feedback first instead of
        // "rook to f8 dot dot dot d8" at the start of every reply.
        // sanitizeForTTS still expands any inline SAN inside the
        // body to plain English.
        void speechService.speak(sanitizeForTTS(stripLeadingMoveCitation(response)));
      }
    } catch {
      if (isMountedRef.current) {
        setCoachText('Keep going — play your next move!');
      }
    } finally {
      if (isMountedRef.current) {
        setIsCoachThinking(false);
      }
    }
  }, [moveCount, isNarrating]);

  // Handle player move
  const handleMove = useCallback((moveResult: MoveResult) => {
    setMoveCount((prev) => prev + 1);
    setEngineArrows([]);
    setTopLines([]);
    void getCoachFeedback(moveResult.san, moveResult.fen);
  }, [getCoachFeedback]);

  const toggleNarration = useCallback(() => {
    if (isNarrating) {
      speechService.stop();
    }
    setIsNarrating((prev) => !prev);
  }, [isNarrating]);

  // Takeback: undo the last FULL move (player + engine reply) so the
  // student lands back on their own turn. Single-ply undo would leave
  // the engine-to-move state, which isn't actionable in practice mode.
  const handleTakeback = useCallback(() => {
    if (isCoachThinking || isEngineMoving) return;
    game.undoMove();
    // When it's the engine's turn after the single undo (i.e. we just
    // undid the engine's reply), the useEffect(fen) watcher will
    // trigger makeEngineMove again — so undo a second ply to bring
    // it back to the student's turn.
    if (isEngineTurn()) {
      game.undoMove();
    }
    setMoveCount((n) => Math.max(0, n - 2));
    setEngineArrows([]);
    setTopLines([]);
    setCoachText('Try again — your move.');
  }, [game, isCoachThinking, isEngineMoving, isEngineTurn]);

  // Hint: surface the engine's top move as a gold arrow for 4s. Same
  // pattern the Coach play view uses — non-destructive preview, no
  // state mutation on the game itself.
  const [isHintActive, setIsHintActive] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleGetHint = useCallback(async () => {
    if (isCoachThinking || isEngineMoving || isHintActive) return;
    setIsHintActive(true);
    try {
      const analysis = engineAnalysis ?? await stockfishEngine.queueAnalysis(game.fen, 16);
      if (!isMountedRef.current) return;
      setEngineArrows(buildEngineArrows(analysis));
    } catch {
      // Engine unavailable — hint silently fails
    }
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setEngineArrows([]);
      setIsHintActive(false);
    }, 4000);
  }, [game.fen, engineAnalysis, isCoachThinking, isEngineMoving, isHintActive]);

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

  const isPlayerTurn = !isEngineTurn() && !game.isCheckmate && !game.isStalemate && !game.isDraw;
  const canTakeback = isPlayerTurn && moveCount > 0;

  return (
    <div className="flex flex-col h-full" data-testid="middlegame-practice">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-theme-border flex-shrink-0">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-border/50 transition-colors"
          aria-label="Exit practice"
          data-testid="practice-exit-btn"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-theme-text truncate">
            Practice: {plan.title}
          </h3>
          <p className="text-xs text-theme-text-muted">
            {moveCount} moves played
            {isEngineMoving ? ' — Engine thinking...' : ''}
          </p>
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-2 overflow-hidden">
        <div className="relative w-full max-w-lg">
          {/* Narration toggle — overlaid on the board so it sits at
              the user's natural focal point. Backdrop-blur + surface
              fill keeps it readable over light or dark squares. */}
          <button
            onClick={toggleNarration}
            className={`absolute top-2 right-2 z-10 p-2 rounded-lg border border-theme-border/60 backdrop-blur-sm transition-colors shadow-md ${
              isNarrating
                ? 'bg-theme-accent text-white'
                : 'bg-theme-surface/90 text-theme-text-muted hover:text-theme-text hover:bg-theme-surface'
            }`}
            aria-label={isNarrating ? 'Stop narration' : 'Read aloud'}
            data-testid="narration-toggle"
          >
            {isNarrating ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <ControlledChessBoard
            game={game}
            interactive={isPlayerTurn}
            onMove={handleMove}
            showEvalBar={settings.showEvalBar}
            evaluation={engineAnalysis?.evaluation ?? null}
            isMate={engineAnalysis?.isMate ?? false}
            mateIn={engineAnalysis?.mateIn ?? null}
            arrows={engineArrows}
            showLastMoveHighlight
          />

          {/* Engine Lines (when setting is on) */}
          {showEngineLines && isPlayerTurn && topLines.length > 0 && (
            <EngineLines lines={topLines} fen={game.fen} className="mt-1" />
          )}
        </div>
      </div>

      {/* Practice controls — mirror the Get-a-Hint / Takeback surface
          from CoachGamePage so practice behaves like the full Play
          view the user already knows. */}
      <div
        className="flex-shrink-0 flex gap-2 px-4 py-2 border-t border-theme-border"
        data-testid="middlegame-practice-controls"
      >
        <button
          onClick={() => void handleGetHint()}
          disabled={!isPlayerTurn || isHintActive || isCoachThinking}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border border-theme-accent/50 text-theme-accent disabled:opacity-40"
          data-testid="hint-btn"
          aria-label="Get a hint"
        >
          <Lightbulb size={14} />
          Get a Hint
        </button>
        <button
          onClick={handleTakeback}
          disabled={!canTakeback || isCoachThinking || isEngineMoving}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border border-theme-border text-theme-text disabled:opacity-40"
          data-testid="takeback-btn"
          aria-label="Take back last move"
        >
          <Undo size={14} />
          Takeback
        </button>
      </div>

      {/* Coach Commentary */}
      <div
        className="flex-shrink-0 border-t border-theme-border bg-theme-surface/80 px-4 py-3 pb-safe-4"
        data-testid="coach-commentary"
      >
        <div className="flex items-start gap-3 max-w-lg mx-auto">
          <div className="w-8 h-8 rounded-full bg-theme-accent/20 flex items-center justify-center shrink-0 mt-0.5">
            <MessageCircle size={14} className="text-theme-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-sm text-theme-text leading-relaxed ${
              isCoachThinking ? 'animate-pulse' : ''
            }`}>
              {isCoachThinking ? 'Thinking...' : coachText}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
