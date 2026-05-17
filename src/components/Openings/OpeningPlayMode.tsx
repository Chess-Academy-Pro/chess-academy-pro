import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Chess } from 'chess.js';
import { ArrowLeft, Volume2, VolumeX, Swords, RotateCcw } from 'lucide-react';
import { useChessGame } from '../../hooks/useChessGame';
import { useBoardContext } from '../../hooks/useBoardContext';
import { useHintSystem } from '../../hooks/useHintSystem';
import { useCoachTips } from '../../hooks/useCoachTips';
import { ControlledChessBoard } from '../Board/ControlledChessBoard';
import { EngineLines } from '../Board/EngineLines';
import { LichessLines } from '../Board/LichessLines';
import { AnalysisToggles } from '../Board/AnalysisToggles';
import { BoardControls } from '../Board/BoardControls';
import { HintButton } from '../Coach/HintButton';
import { DifficultyToggle } from '../Coach/DifficultyToggle';
import { ResignButton } from '../Coach/ResignButton';
import { ExplanationCard } from './ExplanationCard';
import { useAppStore } from '../../stores/appStore';
import { useSettings } from '../../hooks/useSettings';
import { getAdaptiveMove, getRandomLegalMove, getTargetStrength } from '../../services/coachGameEngine';
import { stockfishEngine } from '../../services/stockfishEngine';
import { fetchCloudEval } from '../../services/lichessExplorerService';
import { voiceService } from '../../services/voiceService';
import { usePieceSound } from '../../hooks/usePieceSound';
import { useMasterPlayWatcher } from '../../hooks/useMasterPlayWatcher';
import { logAppAudit } from '../../services/appAuditor';
import type { OpeningRecord, OpeningVariation, OpeningPlayResult, CoachDifficulty, AnalysisLine, LichessCloudEval } from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';
import type { MoveQuality } from '../Board/ChessBoard';

interface OpeningPlayModeProps {
  opening: OpeningRecord;
  customLine?: OpeningVariation;
  startFen?: string;
  onExit: () => void;
}

type PlayPhase = 'pregame' | 'opening' | 'middlegame' | 'postgame';

export function OpeningPlayMode({ opening, customLine, startFen, onExit }: OpeningPlayModeProps): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const { settings } = useSettings();
  const playerRating = activeProfile?.currentRating ?? 1420;
  const [difficulty, setDifficulty] = useState<CoachDifficulty>('medium');
  const targetStrength = getTargetStrength(playerRating, difficulty);
  const playerColor = opening.color;
  const activePgn = customLine ? customLine.pgn : opening.pgn;
  const displayName = customLine ? `${opening.name}: ${customLine.name}` : opening.name;

  const game = useChessGame(startFen, playerColor);

  // Publish board context for global coach drawer
  const playTurn = game.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const lastSan = game.history.length > 0 ? game.history[game.history.length - 1] : undefined;
  const ctxLastMove = game.lastMove && lastSan ? { ...game.lastMove, san: lastSan } : undefined;
  useBoardContext(game.fen, activePgn, game.history.length, playerColor, playTurn, ctxLastMove, game.history);

  const [playPhase, setPlayPhase] = useState<PlayPhase>(startFen ? 'middlegame' : 'pregame');
  const [voiceOn, setVoiceOn] = useState(true);
  const [deviationCard, setDeviationCard] = useState<string | null>(null);
  const [result, setResult] = useState<OpeningPlayResult | null>(null);
  const [computerLastMove, setComputerLastMove] = useState<{ from: string; to: string } | null>(null);
  const [moveFlash, setMoveFlash] = useState<MoveQuality>(null);
  const isComputerThinking = useRef(false);
  const moveCountRef = useRef(0);
  const { playCelebration } = usePieceSound();

  // Analysis toggle overrides (user can toggle in-game)
  const [evalBarOverride, setEvalBarOverride] = useState<boolean | null>(null);
  const [engineLinesOverride, setEngineLinesOverride] = useState<boolean | null>(null);
  const showEvalBarEffective = evalBarOverride ?? settings.showEvalBar;
  const showEngineLinesEffective = engineLinesOverride ?? settings.showEngineLines;

  // Stockfish eval state
  const [latestEval, setLatestEval] = useState<number | null>(null);
  const [latestIsMate, setLatestIsMate] = useState(false);
  const [latestMateIn, setLatestMateIn] = useState<number | null>(null);
  const [latestTopLines, setLatestTopLines] = useState<AnalysisLine[]>([]);

  // Lichess cloud eval state
  const [lichessOverride, setLichessOverride] = useState<boolean | null>(null);
  const showLichessEffective = lichessOverride ?? false;
  const [cloudEval, setCloudEval] = useState<LichessCloudEval | null>(null);

  // Move history for navigation
  const [moveHistory, setMoveHistory] = useState<Array<{ fen: string; from: string; to: string }>>([]);
  const [viewedMoveIndex, setViewedMoveIndex] = useState<number | null>(null);

  // Parse expected opening moves
  const openingMoves = useMemo((): Array<{ san: string; from: string; to: string }> => {
    const tokens = activePgn.trim().split(/\s+/).filter(Boolean);
    const chess = new Chess();
    const moves: Array<{ san: string; from: string; to: string }> = [];
    for (const san of tokens) {
      try {
        const move = chess.move(san);
        moves.push({ san, from: move.from, to: move.to });
      } catch {
        break;
      }
    }
    return moves;
  }, [activePgn]);

  const openingPhaseLength = openingMoves.length;

  // Hint system — knownMove during opening phase, Stockfish in middlegame
  const isPlayersTurn =
    (playerColor === 'white' && game.turn === 'w') ||
    (playerColor === 'black' && game.turn === 'b');
  const inOpeningForHint = playPhase === 'opening' && moveCountRef.current < openingMoves.length;
  const hintKnownMove = useMemo((): { from: string; to: string; san: string } | null => {
    if (!isPlayersTurn || playPhase === 'pregame' || playPhase === 'postgame') return null;
    if (inOpeningForHint) {
      const expected = openingMoves[moveCountRef.current];
      return expected;
    }
    return null; // Stockfish mode in middlegame
  }, [isPlayersTurn, playPhase, inOpeningForHint, openingMoves]);

  const { hintState, requestHint, resetHints } = useHintSystem({
    fen: game.fen,
    playerColor,
    enabled: settings.showHints && (playPhase === 'opening' || playPhase === 'middlegame') && !game.isGameOver,
    knownMove: hintKnownMove,
  });

  // Track deviations
  const [firstDeviation, setFirstDeviation] = useState<number | null>(null);
  const [correctMovesPlayed, setCorrectMovesPlayed] = useState(0);
  const deviatedRef = useRef(false);

  // Speak helper
  const say = useCallback((text: string): void => {
    if (voiceOn) {
      void voiceService.speak(text);
    }
  }, [voiceOn]);

  // Coach tips during middlegame — detect tactics and alert about missed ones
  const coachTipMoves = useMemo(() =>
    moveHistory.map((m, i) => ({
      moveNumber: Math.floor(i / 2) + 1,
      san: '',
      fen: m.fen,
      isCoachMove: false,
      commentary: '',
      evaluation: null,
      classification: null,
      expanded: false,
      bestMove: null,
      bestMoveEval: null,
      preMoveEval: null,
    } as const)),
    [moveHistory],
  );

  const handleOpeningTip = useCallback((tip: string) => {
    say(tip);
  }, [say]);

  const handleMissedTacticInOpening = useCallback((message: string) => {
    say(message);
  }, [say]);

  useCoachTips({
    fen: game.fen,
    playerColor,
    isPlayerTurn: isPlayersTurn,
    enabled: playPhase === 'middlegame' && !game.isGameOver,
    moves: coachTipMoves,
    playerRating,
    onTip: handleOpeningTip,
    onMissedTactic: handleMissedTacticInOpening,
  });

  // ─── Stockfish eval on position change ──────────────────────────────────
  // Runs at priority='prefetch' so it doesn't contend with the
  // opponent-move analyzePosition call (which runs at default 'brain'
  // priority). Without this split the eval-bar pipe lost every race
  // against getAdaptiveMove and the bar froze at its initial value.
  // Each branch (success / prefetch-dropped / hard fail) emits an audit
  // event so a stuck eval bar is debuggable from the audit stream.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const analysis = await stockfishEngine.analyzePosition(
          game.fen,
          12,
          undefined,
          'prefetch',
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelled) {
          setLatestEval(analysis.evaluation);
          setLatestIsMate(analysis.isMate);
          setLatestMateIn(analysis.mateIn);
          setLatestTopLines(analysis.topLines);
          void logAppAudit({
            kind: 'opening-play-eval-updated',
            category: 'subsystem',
            source: 'OpeningPlayMode.evalEffect',
            summary: `eval=${analysis.evaluation}cp isMate=${analysis.isMate} mateIn=${analysis.mateIn ?? '-'} depth=${analysis.depth}`,
            fen: game.fen,
          });
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (/PrefetchDropped|dropped/i.test(msg)) {
          // Expected when the opponent-move analyzePosition is in flight;
          // a subsequent FEN change will re-fire this effect.
          void logAppAudit({
            kind: 'opening-play-eval-prefetch-dropped',
            category: 'subsystem',
            source: 'OpeningPlayMode.evalEffect',
            summary: `dropped by in-flight brain eval — will retry on next FEN change`,
            fen: game.fen,
          });
          return;
        }
        void logAppAudit({
          kind: 'opening-play-eval-error',
          category: 'subsystem',
          source: 'OpeningPlayMode.evalEffect',
          summary: `analyzePosition failed — ${msg}`,
          fen: game.fen,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [game.fen]);

  // ─── Coach grounding (Layer A) — masterPlayWatcher prefetch ─────────────
  // Warms the local masters cache + look-ahead positions on every FEN
  // change so the coach grounding pipeline can answer "what do masters
  // play here?" without waiting on a live Lichess call. Same hook the
  // rest of the coach surfaces use — keeps `/openings/<id>/play` in
  // sync with `/coach/play` so opponent move source decisions stay
  // consistent across the app.
  useMasterPlayWatcher(`/openings/${opening.id}/play`, game.fen);

  // ─── Lichess cloud eval on position change ────────────────────────────
  useEffect(() => {
    if (!showLichessEffective) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchCloudEval(game.fen, 3);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelled) {
          setCloudEval(result);
        }
      } catch {
        // Cloud eval not available
      }
    })();
    return () => { cancelled = true; };
  }, [game.fen, showLichessEffective]);

  // ─── Move navigation ──────────────────────────────────────────────────
  const displayFen = viewedMoveIndex !== null
    ? (viewedMoveIndex === -1 ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : moveHistory[viewedMoveIndex]?.fen ?? game.fen)
    : game.fen;

  const goToFirstMove = useCallback(() => {
    if (moveHistory.length === 0) return;
    setViewedMoveIndex(-1);
  }, [moveHistory.length]);

  const goToPrevMove = useCallback(() => {
    if (moveHistory.length === 0) return;
    setViewedMoveIndex((prev) => {
      if (prev === null) return moveHistory.length - 2;
      return Math.max(-1, prev - 1);
    });
  }, [moveHistory.length]);

  const goToNextMove = useCallback(() => {
    if (moveHistory.length === 0) return;
    setViewedMoveIndex((prev) => {
      if (prev === null) return null;
      if (prev >= moveHistory.length - 1) return null;
      return prev + 1;
    });
  }, [moveHistory.length]);

  const goToLastMove = useCallback(() => {
    setViewedMoveIndex(null);
  }, []);

  // ─── Takeback ──────────────────────────────────────────────────────────
  const handleTakeback = useCallback(() => {
    if (moveHistory.length < 2) return;
    game.undoMove();
    game.undoMove();
    moveCountRef.current = Math.max(0, moveCountRef.current - 2);
    setMoveHistory((prev) => prev.slice(0, -2));
    setComputerLastMove(null);
    resetHints();
    setViewedMoveIndex(null);
  }, [game, moveHistory.length, resetHints]);

  // ─── Resign ────────────────────────────────────────────────────────────
  const handleResign = useCallback(() => {
    const openingPlayerMoves = Math.ceil(openingPhaseLength / 2);
    const correctMoves = Math.min(correctMovesPlayed, openingPlayerMoves);
    const playResult: OpeningPlayResult = {
      openingId: opening.id,
      openingMovesTotal: openingPlayerMoves,
      openingMovesCorrect: correctMoves,
      firstDeviationMove: firstDeviation,
      correctMoveAtDeviation: firstDeviation !== null && firstDeviation < openingMoves.length
        ? openingMoves[firstDeviation].san
        : null,
      finalEval: latestEval,
      recommendation: 'You resigned. Review the position to see where things went wrong.',
    };
    setResult(playResult);
    setPlayPhase('postgame');
  }, [openingPhaseLength, correctMovesPlayed, opening.id, firstDeviation, openingMoves, latestEval]);

  // ─── Pregame intro ───────────────────────────────────────────────────────
  useEffect(() => {
    if (playPhase !== 'pregame') return;
    say(`Let's play the ${displayName}. Remember your key ideas and play confidently.`);
    const timer = setTimeout(() => {
      setPlayPhase('opening');
    }, 2500);
    return () => clearTimeout(timer);
  }, [playPhase, opening.name, displayName, say]);

  // ─── Check for game over ─────────────────────────────────────────────────
  useEffect(() => {
    if (!game.isGameOver || playPhase === 'postgame' || playPhase === 'pregame') return;

    const openingPlayerMoves = Math.ceil(openingPhaseLength / 2);
    const correctMoves = Math.min(correctMovesPlayed, openingPlayerMoves);

    const playResult: OpeningPlayResult = {
      openingId: opening.id,
      openingMovesTotal: openingPlayerMoves,
      openingMovesCorrect: correctMoves,
      firstDeviationMove: firstDeviation,
      correctMoveAtDeviation: firstDeviation !== null && firstDeviation < openingMoves.length
        ? openingMoves[firstDeviation].san
        : null,
      finalEval: null,
      recommendation: correctMoves >= openingPlayerMoves
        ? 'You played the opening perfectly! Focus on the middlegame now.'
        : firstDeviation !== null
          ? `You deviated at move ${Math.ceil((firstDeviation + 1) / 2)}. Review the line from that point.`
          : 'Good game! Keep drilling the opening to make it automatic.',
    };

    setResult(playResult);
    setPlayPhase('postgame');

    const won = game.isCheckmate && (
      (playerColor === 'white' && game.turn === 'b') ||
      (playerColor === 'black' && game.turn === 'w')
    );
    if (won) {
      playCelebration();
      say(`Great win! You played ${correctMoves} out of ${openingPlayerMoves} opening moves correctly.`);
    } else {
      say(`Game over. You got ${correctMoves} out of ${openingPlayerMoves} opening moves right.`);
    }
  }, [game.isGameOver, game.isCheckmate, game.turn, playPhase, playerColor, correctMovesPlayed, firstDeviation, openingMoves, openingPhaseLength, opening.id, playCelebration, say]);

  // ─── Computer moves ─────────────────────────────────────────────────────
  useEffect(() => {
    const isComputerTurn =
      (playPhase === 'opening' || playPhase === 'middlegame') &&
      !game.isGameOver &&
      ((playerColor === 'white' && game.turn === 'b') ||
       (playerColor === 'black' && game.turn === 'w'));

    if (!isComputerTurn || isComputerThinking.current) return;
    isComputerThinking.current = true;

    const abortController = new AbortController();
    const isCancelled = (): boolean => abortController.signal.aborted;

    const tryMakeMove = (moveUci: string): MoveResult | null => {
      const from = moveUci.slice(0, 2);
      const to = moveUci.slice(2, 4);
      const promotion = moveUci.length > 4 ? moveUci[4] : undefined;
      return game.makeMove(from, to, promotion);
    };

    const makeComputerMove = async (): Promise<void> => {
      if (isCancelled()) return;

      const currentMoveIdx = moveCountRef.current;
      const inOpeningPhase = currentMoveIdx < openingPhaseLength && !deviatedRef.current;

      if (inOpeningPhase && currentMoveIdx < openingMoves.length) {
        // Play the repertoire move
        const expected = openingMoves[currentMoveIdx];
        const moveResult = game.makeMove(expected.from, expected.to);
        if (moveResult) {
          setComputerLastMove({ from: expected.from, to: expected.to });
          setMoveHistory((prev) => [...prev, { fen: moveResult.fen, from: expected.from, to: expected.to }]);
          moveCountRef.current += 1;
          void logAppAudit({
            kind: 'opening-play-opponent-move',
            category: 'subsystem',
            source: 'OpeningPlayMode.makeComputerMove',
            summary: `source=repertoire move=${expected.from}${expected.to} idx=${currentMoveIdx}/${openingMoves.length} openingId=${opening.id}`,
            fen: moveResult.fen,
          });
          if (moveCountRef.current >= openingPhaseLength) {
            setPlayPhase('middlegame');
          }
        }
      } else {
        // Post-opening / post-deviation opponent. getAdaptiveMove now
        // consults the masters DB (local → live Lichess) before falling
        // through to Stockfish — its internal `source` field tells us
        // which layer answered. Surface it via an opponent-move audit
        // so the play surface is debuggable end-to-end.
        try {
          const adaptive = await getAdaptiveMove(game.fen, targetStrength);
          if (isCancelled()) return;
          const { move, source } = adaptive;

          let result = tryMakeMove(move);
          if (!result) {
            const randomMove = getRandomLegalMove(game.fen);
            if (randomMove) result = tryMakeMove(randomMove);
          }
          if (result) {
            setComputerLastMove({ from: result.from, to: result.to });
            const r = result;
            setMoveHistory((prev) => [...prev, { fen: r.fen, from: r.from, to: r.to }]);
            moveCountRef.current += 1;
            void logAppAudit({
              kind: 'opening-play-opponent-move',
              category: 'subsystem',
              source: 'OpeningPlayMode.makeComputerMove',
              summary: `source=${source} move=${result.from}${result.to} openingId=${opening.id} targetElo=${targetStrength}`,
              fen: r.fen,
            });
          }
        } catch (err) {
          if (isCancelled()) return;
          void logAppAudit({
            kind: 'opening-play-opponent-error',
            category: 'subsystem',
            source: 'OpeningPlayMode.makeComputerMove',
            summary: `getAdaptiveMove threw — ${(err as Error)?.message ?? err}`,
            fen: game.fen,
          });
          const randomMove = getRandomLegalMove(game.fen);
          if (randomMove) {
            const fallback = tryMakeMove(randomMove);
            if (fallback) {
              setComputerLastMove({ from: fallback.from, to: fallback.to });
              setMoveHistory((prev) => [...prev, { fen: fallback.fen, from: fallback.from, to: fallback.to }]);
              moveCountRef.current += 1;
              void logAppAudit({
                kind: 'opening-play-opponent-move',
                category: 'subsystem',
                source: 'OpeningPlayMode.makeComputerMove',
                summary: `source=random move=${fallback.from}${fallback.to} (catch-fallback) openingId=${opening.id}`,
                fen: fallback.fen,
              });
            }
          }
        }
      }

      isComputerThinking.current = false;
    };

    const timer = setTimeout(() => void makeComputerMove(), 600);
    return () => {
      abortController.abort();
      clearTimeout(timer);
      isComputerThinking.current = false;
    };
  }, [game.turn, game.fen, game.isGameOver, playPhase, playerColor, targetStrength, openingMoves, openingPhaseLength, game]);

  // ─── Handle player move ──────────────────────────────────────────────────
  const handlePlayerMove = useCallback((moveResult: MoveResult): void => {
    const currentMoveIdx = moveCountRef.current;
    moveCountRef.current += 1;
    setComputerLastMove(null);
    resetHints();
    setViewedMoveIndex(null);

    // Sync move to parent game state so turn flips and computer move effect triggers
    game.makeMove(moveResult.from, moveResult.to, moveResult.promotion);
    setMoveHistory((prev) => [...prev, { fen: moveResult.fen, from: moveResult.from, to: moveResult.to }]);

    const inOpeningPhase = currentMoveIdx < openingPhaseLength && !deviatedRef.current;

    if (inOpeningPhase && currentMoveIdx < openingMoves.length) {
      const expected = openingMoves[currentMoveIdx];
      if (moveResult.from === expected.from && moveResult.to === expected.to) {
        // Correct opening move
        setCorrectMovesPlayed((prev) => prev + 1);
        if (settings.moveQualityFlash) {
          setMoveFlash('good');
          setTimeout(() => setMoveFlash(null), 600);
        }
      } else {
        // Deviation!
        if (settings.moveQualityFlash) {
          setMoveFlash('inaccuracy');
          setTimeout(() => setMoveFlash(null), 600);
        }
        if (firstDeviation === null) {
          setFirstDeviation(currentMoveIdx);
          deviatedRef.current = true;
          setDeviationCard('You stepped out of your preparation — this is uncharted territory.');
          setTimeout(() => setDeviationCard(null), 4000);
        }
        setPlayPhase('middlegame');
      }

      // Check if opening phase just completed
      if (moveCountRef.current >= openingPhaseLength) {
        setPlayPhase('middlegame');
      }
    }
  }, [openingMoves, openingPhaseLength, firstDeviation, game, settings.moveQualityFlash, resetHints]);

  // ─── Postgame report ─────────────────────────────────────────────────────
  if (playPhase === 'postgame' && result) {
    return (
      <div className="flex flex-col flex-1 p-4 md:p-6 items-center justify-center" data-testid="play-postgame">
        <div className="w-full max-w-sm space-y-6">
          <h2 className="text-xl font-bold text-theme-text text-center">Opening Report</h2>

          <div className="bg-theme-surface rounded-xl p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-theme-text-muted">Opening moves correct</span>
              <span className="text-sm font-bold text-theme-text" data-testid="report-correct">
                {result.openingMovesCorrect} / {result.openingMovesTotal}
              </span>
            </div>

            {result.firstDeviationMove !== null && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-theme-text-muted">First deviation</span>
                <span className="text-sm font-bold text-amber-500" data-testid="report-deviation">
                  Move {Math.ceil((result.firstDeviationMove + 1) / 2)}
                </span>
              </div>
            )}

            {result.correctMoveAtDeviation && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-theme-text-muted">Correct move was</span>
                <span className="text-sm font-bold text-theme-accent" data-testid="report-correct-move">
                  {result.correctMoveAtDeviation}
                </span>
              </div>
            )}

            <div className="pt-2 border-t border-theme-border">
              <p className="text-sm text-theme-text leading-relaxed" data-testid="report-recommendation">
                {result.recommendation}
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => {
                game.resetGame();
                moveCountRef.current = 0;
                setCorrectMovesPlayed(0);
                setFirstDeviation(null);
                deviatedRef.current = false;
                setResult(null);
                setDeviationCard(null);
                setComputerLastMove(null);
                resetHints();
                setMoveFlash(null);
                setMoveHistory([]);
                setViewedMoveIndex(null);
                setLatestEval(null);
                setLatestIsMate(false);
                setLatestMateIn(null);
                setPlayPhase('pregame');
                
              }}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold hover:opacity-90 transition-opacity"
              data-testid="play-again"
            >
              <RotateCcw size={16} />
              Play Again
            </button>
            <button
              onClick={onExit}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-surface border border-theme-border text-theme-text font-semibold hover:bg-theme-border transition-colors"
              data-testid="play-exit"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Game screen ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 overflow-hidden" data-testid="opening-play-mode">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
        <div className="flex items-center gap-3">
          <button onClick={onExit} className="p-1.5 rounded-lg hover:bg-theme-surface">
            <ArrowLeft size={18} className="text-theme-text" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <Swords size={14} className="text-theme-accent" />
              <p className="text-sm font-semibold text-theme-text">{displayName}</p>
            </div>
            <p className="text-xs text-theme-text-muted">
              {playPhase === 'pregame' && 'Starting...'}
              {playPhase === 'opening' && `Opening phase: move ${Math.ceil(moveCountRef.current / 2)} / ${Math.ceil(openingPhaseLength / 2)}`}
              {playPhase === 'middlegame' && `~${targetStrength} ELO opponent`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <AnalysisToggles
            showEvalBar={showEvalBarEffective}
            onToggleEvalBar={() => setEvalBarOverride((prev) => !(prev ?? settings.showEvalBar))}
            showEngineLines={showEngineLinesEffective}
            onToggleEngineLines={() => setEngineLinesOverride((prev) => !(prev ?? settings.showEngineLines))}
            showLichessLines={showLichessEffective}
            onToggleLichessLines={() => setLichessOverride((prev) => !(prev ?? false))}
          />
          <DifficultyToggle
            value={difficulty}
            onChange={setDifficulty}
            disabled={moveHistory.length > 0}
          />
          <button
            onClick={() => setVoiceOn(!voiceOn)}
            className="p-2 rounded-lg hover:bg-theme-surface text-theme-text-muted"
            aria-label={voiceOn ? 'Mute voice' : 'Enable voice'}
            data-testid="voice-toggle"
          >
            {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
      </div>

      {/* Opening phase indicator */}
      {playPhase === 'opening' && (
        <div className="px-4 pt-2">
          <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-theme-accent transition-all duration-300 rounded-full"
              style={{ width: `${Math.min(100, (moveCountRef.current / openingPhaseLength) * 100)}%` }}
              data-testid="opening-progress"
            />
          </div>
        </div>
      )}

      {/* Board */}
      <div className="flex-1 flex flex-col items-center justify-start pt-2 px-2 py-2">
        <div className="w-full md:max-w-[420px]">
          <ControlledChessBoard
            game={game}
            positionOverride={viewedMoveIndex !== null ? displayFen : undefined}
            interactive={
              viewedMoveIndex === null &&
              (playPhase === 'opening' || playPhase === 'middlegame') &&
              !game.isGameOver &&
              !isComputerThinking.current
            }
            onMove={handlePlayerMove}
            showEvalBar={showEvalBarEffective}
            evaluation={latestEval}
            isMate={latestIsMate}
            mateIn={latestMateIn}
            showFlipButton={true}
            highlightSquares={computerLastMove}
            showLastMoveHighlight={settings.highlightLastMove}
            moveQualityFlash={moveFlash}
            arrows={hintState.arrows.length > 0 ? hintState.arrows : undefined}
            ghostMove={hintState.ghostMove}
          />
        </div>
        {showEngineLinesEffective && latestTopLines.length > 0 && (
          <EngineLines lines={latestTopLines} fen={game.fen} className="mt-1" />
        )}
        {showLichessEffective && cloudEval && (
          <LichessLines cloudEval={cloudEval} fen={game.fen} className="mt-1" />
        )}
      </div>

      {/* Controls bar */}
      {(playPhase === 'opening' || playPhase === 'middlegame') && !game.isGameOver && (
        <div className="px-4">
          <BoardControls
            onFirst={goToFirstMove}
            onPrev={goToPrevMove}
            onNext={goToNextMove}
            onLast={goToLastMove}
            canGoPrev={moveHistory.length > 0 && (viewedMoveIndex === null || viewedMoveIndex > -1)}
            canGoNext={viewedMoveIndex !== null}
            onTakeback={handleTakeback}
            canTakeback={moveHistory.length >= 2}
            extraLeft={
              settings.showHints ? (
                <HintButton
                  currentLevel={hintState.level}
                  onRequestHint={requestHint}
                  disabled={hintState.isAnalyzing}
                />
              ) : undefined
            }
            extraRight={<ResignButton onResign={handleResign} disabled={moveHistory.length === 0} />}
          />
        </div>
      )}

      {/* Nudge text */}
      {hintState.nudgeText && (
        <div className="px-4 pb-2">
          <p className="text-xs text-amber-500 max-w-sm" data-testid="hint-nudge">
            {hintState.nudgeText}
          </p>
        </div>
      )}

      {/* Deviation card */}
      <div className="px-4 pb-safe-4 min-h-[60px]">
        <ExplanationCard
          text={deviationCard ?? ''}
          visible={deviationCard !== null}
          onDismiss={() => setDeviationCard(null)}
          variant="warning"
        />
      </div>
    </div>
  );
}
