import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX, Lock } from 'lucide-react';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import {
  getRookGameProgress,
  isPawnChapterCompleted,
} from '../../services/rookGameService';
import { ROOK_MAZE_LEVELS } from '../../data/rookMazeLevels';
import { ROW_CLEARER_LEVELS } from '../../data/rowClearerLevels';
import type { RookGameProgress, MiniGameLevelProgress } from '../../types/rookGames';

export function RookGamesPage(): JSX.Element {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<RookGameProgress | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);
  const hasSpoken = useRef(false);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  // Load progress and unlock state
  useEffect(() => {
    void (async () => {
      const [prog, pawnDone] = await Promise.all([
        getRookGameProgress(),
        isPawnChapterCompleted(),
      ]);
      setProgress(prog);
      setUnlocked(pawnDone);
      setLoading(false);
    })();
  }, []);

  // Welcome speech
  useEffect(() => {
    if (!loading && !hasSpoken.current) {
      hasSpoken.current = true;
      if (unlocked) {
        kidSpeak('Rook Games! Choose a game and level.');
      } else {
        kidSpeak('Complete the Pawn chapter first to unlock Rook Games!');
      }
    }
  }, [loading, unlocked, kidSpeak]);

  const handleBack = useCallback((): void => {
    void navigate('/kid');
  }, [navigate]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) voiceService.stop();
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  const handleMazeLevel = useCallback(
    (levelId: number): void => {
      void navigate(`/kid/rook-maze/${levelId}`);
    },
    [navigate],
  );

  const handleClearerLevel = useCallback(
    (levelId: number): void => {
      void navigate(`/kid/row-clearer/${levelId}`);
    },
    [navigate],
  );

  if (loading) {
    return (
      <div
        className="flex flex-col items-center justify-center flex-1 p-6"
        style={{ color: 'var(--color-text)' }}
        data-testid="rook-games-loading"
      >
        <div className="text-xl font-bold animate-pulse">Loading...</div>
      </div>
    );
  }

  const isLevelUnlocked = (
    _gameProgress: Record<number, MiniGameLevelProgress> | undefined,
    _levelId: number,
  ): boolean => {
    // DEV: all levels unlocked for testing
    return true;
  };

  return (
    <div
      className="flex flex-col gap-4 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="rook-games-page"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="rook-games-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-2xl font-bold">Rook Games</h1>
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
          data-testid="rook-games-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Lock overlay */}
      {!unlocked && (
        <div
          className="rounded-xl p-6 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            opacity: 0.7,
          }}
          data-testid="rook-games-locked"
        >
          <Lock size={32} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="font-bold">Locked</p>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Complete the Pawn chapter in Pawn&apos;s Journey to unlock!
          </p>
        </div>
      )}

      {unlocked && (
        <>
          {/* Rook Maze section */}
          <div>
            <h2 className="text-lg font-bold mb-3">Rook Maze</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
              Navigate your rook to the target square through obstacles!
            </p>
            <div className="flex flex-col gap-2">
              {ROOK_MAZE_LEVELS.map((level) => {
                const levelUnlocked = isLevelUnlocked(progress?.rookMaze, level.id);
                const levelProgress = progress?.rookMaze[level.id];

                return (
                  <button
                    key={`maze-${level.id}`}
                    onClick={() => handleMazeLevel(level.id)}
                    disabled={!levelUnlocked}
                    className="rounded-xl p-4 border-2 flex items-center gap-4 text-left transition-all"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: levelProgress?.completed
                        ? '#22c55e'
                        : levelUnlocked
                          ? 'var(--color-accent)'
                          : 'var(--color-border)',
                      opacity: levelUnlocked ? 1 : 0.5,
                      cursor: levelUnlocked ? 'pointer' : 'not-allowed',
                    }}
                    data-testid={`maze-level-${level.id}`}
                  >
                    <span className="text-2xl flex-shrink-0">
                      {levelUnlocked ? '\u265C' : '\uD83D\uDD12'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm">
                        Level {level.id}: {level.name}
                      </div>
                      <div
                        className="text-xs"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        Par: {level.par} moves
                        {levelProgress?.completed && ` · Best: ${levelProgress.bestMoves}`}
                      </div>
                    </div>
                    {levelProgress?.completed && (
                      <StarDisplay earned={levelProgress.stars} total={3} size="sm" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row Clearer section */}
          <div>
            <h2 className="text-lg font-bold mb-3">Row Clearer</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
              Capture all enemy pawns using your rook in as few moves as possible!
            </p>
            <div className="flex flex-col gap-2">
              {ROW_CLEARER_LEVELS.map((level) => {
                const levelUnlocked = isLevelUnlocked(progress?.rowClearer, level.id);
                const levelProgress = progress?.rowClearer[level.id];

                return (
                  <button
                    key={`clearer-${level.id}`}
                    onClick={() => handleClearerLevel(level.id)}
                    disabled={!levelUnlocked}
                    className="rounded-xl p-4 border-2 flex items-center gap-4 text-left transition-all"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: levelProgress?.completed
                        ? '#22c55e'
                        : levelUnlocked
                          ? 'var(--color-accent)'
                          : 'var(--color-border)',
                      opacity: levelUnlocked ? 1 : 0.5,
                      cursor: levelUnlocked ? 'pointer' : 'not-allowed',
                    }}
                    data-testid={`clearer-level-${level.id}`}
                  >
                    <span className="text-2xl flex-shrink-0">
                      {levelUnlocked ? '\u265C' : '\uD83D\uDD12'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm">
                        Level {level.id}: {level.name}
                      </div>
                      <div
                        className="text-xs"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        Par: {level.par} moves · {level.enemies.length} pawns
                        {level.rooks.length > 1 && ` · ${level.rooks.length} rooks`}
                        {levelProgress?.completed && ` · Best: ${levelProgress.bestMoves}`}
                      </div>
                    </div>
                    {levelProgress?.completed && (
                      <StarDisplay earned={levelProgress.stars} total={3} size="sm" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
