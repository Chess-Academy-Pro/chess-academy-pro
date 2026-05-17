import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { getGameProgress, isChapterUnlocked, getChapterProgress } from '../../services/journeyService';
import { StarDisplay } from './StarDisplay';
import type { JourneyProgress, JourneyChapter, KidGameConfig } from '../../types';

interface GameMapPageProps {
  config: KidGameConfig;
}

export function GameMapPage({ config }: GameMapPageProps): JSX.Element {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<JourneyProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);

  // Voice helper
  const kidSpeak = useCallback((text: string): void => {
    if (!voiceOn) return;
    void voiceService.speak(text);
  }, [voiceOn]);

  // Load progress on mount
  useEffect(() => {
    void getGameProgress(config.gameId).then((p) => {
      setProgress(p);
      setLoading(false);
    });
  }, [config.gameId]);

  // Welcome speech on mount
  const hasSpoken = useRef(false);
  useEffect(() => {
    if (!loading && !hasSpoken.current) {
      hasSpoken.current = true;
      kidSpeak(`Welcome to ${config.title}! Choose a chapter to begin.`);
    }
  }, [loading, kidSpeak, config.title]);

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  const handleBack = useCallback((): void => {
    void navigate('/kid');
  }, [navigate]);

  const handleChapterClick = useCallback((chapter: JourneyChapter): void => {
    void navigate(`${config.routePrefix}/${chapter.id}`);
  }, [navigate, config.routePrefix]);

  const completedCount = progress
    ? config.chapters.filter((ch) => progress.chapters[ch.id]?.completed).length
    : 0;

  if (loading) {
    return (
      <div
        className="flex flex-col items-center justify-center flex-1 p-6"
        style={{ color: 'var(--color-text)' }}
        data-testid="journey-loading"
      >
        <div className="text-xl font-bold animate-pulse">Loading your journey...</div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4 p-6 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="journey-map-page"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="journey-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-2xl font-bold">{config.title}</h1>
        </div>
        <button
          onClick={handleToggleVoice}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="journey-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Progress text */}
      <p
        className="text-center text-sm font-medium"
        style={{ color: 'var(--color-text-muted)' }}
        data-testid="journey-progress-text"
      >
        Chapter {completedCount} of {config.chapters.length}
      </p>

      {/* Chapter cards */}
      <div className="flex flex-col gap-3">
        {config.chapters.map((chapter) => {
          const unlocked = progress
            ? isChapterUnlocked(chapter.id, progress, config.chapterOrder)
            : true; // DEV: all chapters unlocked for testing
          const chapterProgress = progress
            ? getChapterProgress(chapter.id, progress)
            : null;
          const completed = chapterProgress?.completed === true;

          // Show Queen Games card after the knight chapter (for pawns-journey only)
          const showQueenGames =
            config.gameId === 'pawns-journey' && chapter.id === 'knight';
          const knightCompleted = true; // DEV: unlocked for testing

          return (
            <Fragment key={chapter.id}>
              <button
                onClick={() => handleChapterClick(chapter)}
                disabled={!unlocked}
                className={[
                  'rounded-xl p-4 border-2 flex items-center gap-4 text-left transition-all',
                  !unlocked && 'opacity-50 cursor-not-allowed',
                  unlocked && !completed && 'hover:opacity-90',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  background: 'var(--color-surface)',
                  borderColor: completed
                    ? '#22c55e'
                    : unlocked
                      ? 'var(--color-accent)'
                      : 'var(--color-border)',
                  animation: unlocked && !completed ? 'journey-pulse 2s ease-in-out infinite' : undefined,
                }}
                data-testid={`chapter-card-${chapter.id}`}
              >
                {/* Icon */}
                <span className="text-3xl flex-shrink-0">
                  {unlocked ? chapter.icon : '\uD83D\uDD12'}
                </span>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm">{chapter.title}</div>
                  <div
                    className="text-xs truncate"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {chapter.subtitle}
                  </div>
                </div>

                {/* Status indicator */}
                {chapterProgress !== null && chapterProgress.completed && (
                  <div className="flex-shrink-0">
                    <StarDisplay earned={chapterProgress.bestScore} total={3} size="sm" />
                  </div>
                )}
              </button>

              {showQueenGames && (
                <button
                  onClick={() => void navigate('/kid/queen-games')}
                  disabled={!knightCompleted}
                  className="rounded-xl p-4 border-2 flex items-center gap-4 text-left transition-all ml-6 hover:opacity-90"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: 'var(--color-accent)',
                  }}
                  data-testid="queen-games-card"
                >
                  <span className="text-2xl flex-shrink-0">👑</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">Queen Games</div>
                    <div
                      className="text-xs truncate"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      Two queen mini-games to test your skills!
                    </div>
                  </div>
                </button>
              )}
            </Fragment>
          );
        })}
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes journey-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--color-accent); }
          50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-accent) 30%, transparent); }
        }
      `}</style>
    </div>
  );
}
