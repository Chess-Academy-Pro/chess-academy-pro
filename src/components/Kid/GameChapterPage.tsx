import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeX, Loader } from 'lucide-react';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { useChessGame } from '../../hooks/useChessGame';
import { HintButton } from '../Coach/HintButton';
import { StarDisplay } from './StarDisplay';
import { useBoardContext } from '../../hooks/useBoardContext';
import { useHintSystem } from '../../hooks/useHintSystem';
import { useAppStore } from '../../stores/appStore';
import { voiceService } from '../../services/voiceService';
import { generateKidPuzzles } from '../../services/kidPuzzleService';
import { stockfishEngine } from '../../services/stockfishEngine';
import {
  getGameProgress,
  initGameProgress,
  completeGameLesson,
  recordGamePuzzleAttempt,
  completeGameChapter,
  getChapterProgress,
} from '../../services/journeyService';
import type { JourneyChapter, JourneyPuzzle, KidGameConfig } from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';

type ChapterPhase = 'intro' | 'lesson' | 'puzzle' | 'reward';

const XP_PER_CORRECT_PUZZLE = 25;

interface GameChapterPageProps {
  config: KidGameConfig;
}

export function GameChapterPage({ config }: GameChapterPageProps): JSX.Element {
  const { chapterId } = useParams<{ chapterId: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<ChapterPhase>('intro');
  const [lessonIndex, setLessonIndex] = useState(0);
  const [puzzleIndex, setPuzzleIndex] = useState(0);
  const [puzzlesCorrect, setPuzzlesCorrect] = useState(0);
  const [puzzleFeedback, setPuzzleFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [aiPuzzles, setAiPuzzles] = useState<JourneyPuzzle[] | null>(null);
  const [puzzlesLoading, setPuzzlesLoading] = useState(false);

  const activeProfile = useAppStore((s) => s.activeProfile);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup feedback timeout on unmount
  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  const kidSpeak = useCallback((text: string): void => {
    if (!voiceOn) return;
    void voiceService.speak(text);
  }, [voiceOn]);

  // Find the chapter
  const chapter: JourneyChapter | undefined = config.chapters.find(
    (c) => c.id === chapterId,
  );

  // Use AI-generated puzzles when available, fall back to hardcoded
  const activePuzzles = useMemo(
    () => aiPuzzles ?? chapter?.puzzles ?? [],
    [aiPuzzles, chapter?.puzzles],
  );

  // Game objects for lesson and puzzle boards
  const lessonGame = useChessGame(
    chapter?.lessons[lessonIndex]?.fen,
    'white',
  );
  const puzzleGame = useChessGame(
    activePuzzles[puzzleIndex]?.fen ?? undefined,
    'white',
  );

  // Sync lesson board FEN when lessonIndex changes
  useEffect(() => {
    const fen = chapter?.lessons[lessonIndex]?.fen;
    if (fen) {
      lessonGame.loadFen(fen);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFen is stable; including lessonGame would cause infinite re-renders
  }, [lessonIndex, chapter?.lessons, lessonGame.loadFen]);

  // Sync puzzle board FEN when puzzleIndex or activePuzzles changes
  useEffect(() => {
    const fen = activePuzzles[puzzleIndex]?.fen;
    if (fen) {
      puzzleGame.loadFen(fen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: rerun on puzzleIndex/activePuzzles only; tracked for dedicated audit.
  }, [puzzleIndex, activePuzzles, puzzleGame.loadFen]);

  // Publish board context for global coach drawer
  const currentFen = chapter
    ? phase === 'puzzle'
      ? activePuzzles[puzzleIndex]?.fen ?? ''
      : phase === 'lesson'
        ? chapter.lessons[lessonIndex]?.fen ?? ''
        : ''
    : '';
  useBoardContext(currentFen, '', 0, 'white', 'w');

  // Derive knownMove for hint system from current puzzle's solution
  const currentPuzzleForHint = phase === 'puzzle' && !puzzlesLoading ? activePuzzles[puzzleIndex] : undefined;
  const kidKnownMove = useMemo((): { from: string; to: string; san: string } | null => {
    if (!currentPuzzleForHint?.fen || !currentPuzzleForHint.solution[0]) return null;
    try {
      const chess = new Chess(currentPuzzleForHint.fen);
      const result = chess.move(currentPuzzleForHint.solution[0]);
      return { from: result.from, to: result.to, san: result.san };
    } catch {
      return null;
    }
  }, [currentPuzzleForHint]);

  const { hintState, requestHint, resetHints } = useHintSystem({
    fen: currentPuzzleForHint?.fen ?? '',
    playerColor: 'white',
    enabled: phase === 'puzzle' && !puzzlesLoading,
    knownMove: kidKnownMove,
  });

  // Generate AI puzzles when entering puzzle phase
  useEffect(() => {
    if (phase !== 'puzzle' || !chapter || !activeProfile || aiPuzzles) return;

    setPuzzlesLoading(true);
    void generateKidPuzzles(chapter, activeProfile).then((puzzles) => {
      setAiPuzzles(puzzles);
      setPuzzlesLoading(false);
    });
  }, [phase, chapter, activeProfile, aiPuzzles]);

  // Load progress on mount
  useEffect(() => {
    if (!chapter) return;

    void (async () => {
      let jp = await getGameProgress(config.gameId);
      if (!jp) {
        jp = await initGameProgress(config.gameId, config.chapterOrder);
      }
      // Resume from where the kid left off if there is partial progress
      const chapterProg = getChapterProgress(chapter.id, jp);
      if (chapterProg.completed) {
        // Allow replay from intro
        setPhase('intro');
      } else if (chapterProg.lessonsCompleted > 0) {
        if (chapterProg.lessonsCompleted >= chapter.lessons.length) {
          // All lessons done, go to puzzle phase
          setPhase('puzzle');
        } else {
          setLessonIndex(chapterProg.lessonsCompleted);
          setPhase('lesson');
        }
      }
    })();
  }, [chapter, config.gameId, config.chapterOrder]);

  // Navigate away if chapter not found
  useEffect(() => {
    if (!chapterId || !chapter) {
      void navigate(config.routePrefix);
    }
  }, [chapterId, chapter, navigate, config.routePrefix]);

  // Voice-narrate when entering intro phase
  useEffect(() => {
    if (phase === 'intro' && chapter) {
      kidSpeak(chapter.storyIntro);
    }
  }, [phase, chapter, kidSpeak]);

  // Voice-narrate current lesson when entering lesson phase or advancing lessons
  useEffect(() => {
    if (phase === 'lesson' && chapter && lessonIndex < chapter.lessons.length) {
      const lesson = chapter.lessons[lessonIndex];
      kidSpeak(lesson.story);
    }
  }, [phase, chapter, lessonIndex, kidSpeak]);

  // Voice-narrate story outro when entering reward phase
  useEffect(() => {
    if (phase === 'reward' && chapter) {
      kidSpeak(chapter.storyOutro);
    }
  }, [phase, chapter, kidSpeak]);

  const handleBegin = useCallback((): void => {
    setPhase('lesson');
  }, []);

  const handleNextLesson = useCallback((): void => {
    if (!chapter) return;

    void completeGameLesson(config.gameId, chapter.id, lessonIndex, config.chapterOrder);

    const nextIndex = lessonIndex + 1;
    if (nextIndex >= chapter.lessons.length) {
      setPhase('puzzle');
    } else {
      setLessonIndex(nextIndex);
    }
  }, [chapter, lessonIndex, config.gameId, config.chapterOrder]);

  const advancePuzzle = useCallback((): void => {
    if (!chapter) return;
    const nextPuzzle = puzzleIndex + 1;
    if (nextPuzzle >= activePuzzles.length) {
      void completeGameChapter(config.gameId, chapter.id, config.chapterOrder);
      setPhase('reward');
    } else {
      setPuzzleIndex(nextPuzzle);
    }
  }, [chapter, puzzleIndex, activePuzzles.length, config.gameId, config.chapterOrder]);

  const handlePuzzleMove = useCallback((move: MoveResult): void => {
    if (!chapter || puzzleFeedback !== null) return;

    const currentPuzzle = activePuzzles[puzzleIndex];

    // Check exact SAN match first (works for hardcoded puzzles)
    const isExactMatch = move.san === currentPuzzle.solution[0];

    if (isExactMatch) {
      setPuzzleFeedback('correct');
      setPuzzlesCorrect((prev) => prev + 1);
      kidSpeak(currentPuzzle.successMessage);
      void recordGamePuzzleAttempt(config.gameId, chapter.id, true, config.chapterOrder);

      feedbackTimeoutRef.current = setTimeout(() => {
        setPuzzleFeedback(null);
        resetHints();
        advancePuzzle();
      }, 1500);
      return;
    }

    // For AI-generated puzzles, use Stockfish to check if the move is strong enough
    if (currentPuzzle.id.startsWith('ai-')) {
      void (async () => {
        try {
          const analysis = await stockfishEngine.analyzePosition(currentPuzzle.fen, 12);
          const bestEval = analysis.evaluation;
          const playerUci = `${move.from}${move.to}${move.promotion ?? ''}`;

          // Check if it's a top engine line
          const isTopLine = analysis.topLines.some((line) => line.moves[0] === playerUci);
          if (isTopLine || playerUci === analysis.bestMove) {
            setPuzzleFeedback('correct');
            setPuzzlesCorrect((prev) => prev + 1);
            kidSpeak(currentPuzzle.successMessage);
            void recordGamePuzzleAttempt(config.gameId, chapter.id, true, config.chapterOrder);

            feedbackTimeoutRef.current = setTimeout(() => {
              setPuzzleFeedback(null);
              resetHints();
              advancePuzzle();
            }, 1500);
            return;
          }

          // Check eval loss — accept if within 150cp
          const { Chess } = await import('chess.js');
          const tempChess = new Chess(currentPuzzle.fen);
          tempChess.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion as 'q' | 'r' | 'b' | 'n' | undefined,
          });
          const afterAnalysis = await stockfishEngine.analyzePosition(tempChess.fen(), 12);
          const playerEval = -afterAnalysis.evaluation;
          const evalLoss = bestEval - playerEval;

          if (evalLoss < 150) {
            setPuzzleFeedback('correct');
            setPuzzlesCorrect((prev) => prev + 1);
            kidSpeak(currentPuzzle.successMessage);
            void recordGamePuzzleAttempt(config.gameId, chapter.id, true, config.chapterOrder);

            feedbackTimeoutRef.current = setTimeout(() => {
              setPuzzleFeedback(null);
              resetHints();
              advancePuzzle();
            }, 1500);
            return;
          }
        } catch {
          // Stockfish failed — fall through to wrong answer
        }

        setPuzzleFeedback('wrong');
        kidSpeak('Not quite, try again!');
        void recordGamePuzzleAttempt(config.gameId, chapter.id, false, config.chapterOrder);

        feedbackTimeoutRef.current = setTimeout(() => {
          setPuzzleFeedback(null);
          puzzleGame.loadFen(currentPuzzle.fen);
        }, 1200);
      })();
      return;
    }

    // Hardcoded puzzle, wrong answer
    setPuzzleFeedback('wrong');
    kidSpeak('Not quite, try again!');
    void recordGamePuzzleAttempt(config.gameId, chapter.id, false, config.chapterOrder);

    feedbackTimeoutRef.current = setTimeout(() => {
      setPuzzleFeedback(null);
      puzzleGame.loadFen(currentPuzzle.fen);
    }, 1200);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tracked for dedicated audit; current deps cover the live callers.
  }, [chapter, puzzleIndex, puzzleFeedback, kidSpeak, config.gameId, config.chapterOrder, activePuzzles, advancePuzzle, resetHints, puzzleGame.loadFen]);

  const handleHint = useCallback((): void => {
    requestHint();
  }, [requestHint]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) {
      voiceService.stop();
    }
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  const handleBack = useCallback((): void => {
    void navigate(config.routePrefix);
  }, [navigate, config.routePrefix]);

  const handleContinue = useCallback((): void => {
    void navigate(config.routePrefix);
  }, [navigate, config.routePrefix]);

  if (!chapter) {
    return <div />;
  }

  const xpEarned = puzzlesCorrect * XP_PER_CORRECT_PUZZLE;

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }}
      data-testid="journey-chapter-page"
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between p-4 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-bg)' }}
            data-testid="chapter-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold">{chapter.title}</h2>
        </div>
        <button
          onClick={handleVoiceToggle}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="chapter-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Phase content */}
      <div className="flex-1 p-6">
        <AnimatePresence mode="wait">
          {/* ── Intro Phase ─────────────────────────────────────────── */}
          {phase === 'intro' && (
            <motion.div
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center gap-6 text-center"
              data-testid="chapter-intro"
            >
              <span className="text-8xl">{chapter.icon}</span>
              <h1 className="text-2xl font-bold">{chapter.title}</h1>
              <p
                className="text-lg leading-relaxed max-w-md"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {chapter.storyIntro}
              </p>
              <button
                onClick={handleBegin}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="chapter-begin-btn"
              >
                Begin!
              </button>
            </motion.div>
          )}

          {/* ── Lesson Phase ────────────────────────────────────────── */}
          {phase === 'lesson' && chapter.lessons[lessonIndex] && (
            <motion.div
              key={`lesson-${lessonIndex}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center gap-5"
              data-testid="chapter-lesson"
            >
              <h3 className="text-xl font-bold">
                {chapter.lessons[lessonIndex].title}
              </h3>
              <p
                className="text-base leading-relaxed max-w-md text-center"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {chapter.lessons[lessonIndex].story}
              </p>
              <p className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
                {chapter.lessons[lessonIndex].instruction}
              </p>

              <div className="w-full md:max-w-[420px] mx-auto">
                <KidChessboard
                  game={lessonGame}
                  interactive={false}
                />
              </div>

              {/* Progress dots */}
              <div className="flex items-center gap-2" data-testid="lesson-dots">
                {chapter.lessons.map((_, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-full"
                    style={{
                      background:
                        i <= lessonIndex
                          ? 'var(--color-accent)'
                          : 'var(--color-border)',
                    }}
                  />
                ))}
              </div>

              <button
                onClick={handleNextLesson}
                className="px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="chapter-next-btn"
              >
                Next
              </button>
            </motion.div>
          )}

          {/* ── Puzzle Phase ────────────────────────────────────────── */}
          {phase === 'puzzle' && puzzlesLoading && (
            <motion.div
              key="puzzle-loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center gap-4 py-12"
              data-testid="puzzle-loading"
            >
              <Loader size={32} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
              <p className="text-lg font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Coach is preparing your puzzles...
              </p>
            </motion.div>
          )}

          {phase === 'puzzle' && !puzzlesLoading && activePuzzles[puzzleIndex] && (
            <motion.div
              key={`puzzle-${puzzleIndex}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center gap-2"
              data-testid="chapter-puzzle"
            >
              <h3 className="text-lg font-bold">
                Puzzle {puzzleIndex + 1} of {activePuzzles.length}
              </h3>

              <div className="w-full md:max-w-[420px] mx-auto">
                <KidChessboard
                  game={puzzleGame}
                  interactive={true}
                  onMove={handlePuzzleMove}
                  arrows={hintState.arrows.length > 0 ? hintState.arrows : undefined}
                  ghostMove={hintState.ghostMove}
                />
              </div>

              {/* Hint + feedback row — compact, directly under board */}
              <div className="flex items-center justify-center gap-2">
                <HintButton
                  currentLevel={hintState.level}
                  onRequestHint={handleHint}
                  disabled={hintState.isAnalyzing}
                />
                {puzzleFeedback && (
                  <span
                    className="px-3 py-1.5 rounded-lg font-bold text-xs"
                    style={{
                      background:
                        puzzleFeedback === 'correct'
                          ? 'var(--color-accent)'
                          : 'var(--color-error)',
                      color: 'var(--color-bg)',
                    }}
                    data-testid="puzzle-feedback"
                  >
                    {puzzleFeedback === 'correct' ? 'Correct!' : 'Try again!'}
                  </span>
                )}
              </div>

              {hintState.nudgeText && (
                <p
                  className="text-xs text-center max-w-sm"
                  style={{ color: 'var(--color-accent)' }}
                  data-testid="chapter-hint-text"
                >
                  {hintState.nudgeText}
                </p>
              )}
            </motion.div>
          )}

          {/* ── Reward Phase ────────────────────────────────────────── */}
          {phase === 'reward' && (
            <motion.div
              key="reward"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="flex flex-col items-center gap-6 text-center"
              data-testid="chapter-reward"
            >
              <h1 className="text-3xl font-bold">Chapter Complete!</h1>

              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 15, delay: 0.2 }}
              >
                <StarDisplay
                  earned={puzzlesCorrect}
                  total={activePuzzles.length}
                  size="lg"
                />
              </motion.div>

              <p
                className="text-xl font-bold"
                style={{ color: 'var(--color-accent)' }}
              >
                +{xpEarned} XP
              </p>

              <p
                className="text-base leading-relaxed max-w-md"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {chapter.storyOutro}
              </p>

              <button
                onClick={handleContinue}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="chapter-continue-btn"
              >
                Continue
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
