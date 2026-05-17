import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX, Lock } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { getGameProgress } from '../../services/journeyService';

export function KnightGamesPage(): JSX.Element {
  const navigate = useNavigate();
  const [voiceOn, setVoiceOn] = useState(true);
  const [loading, setLoading] = useState(true);
  const [bishopCompleted, setBishopCompleted] = useState(false);

  useEffect(() => {
    void getGameProgress('pawns-journey').then((progress) => {
      setBishopCompleted(progress?.chapters.bishop?.completed === true);
      setLoading(false);
    });
  }, []);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  useEffect(() => {
    if (!loading && bishopCompleted) {
      kidSpeak('Knight Games! Choose your challenge.');
    } else if (!loading && !bishopCompleted) {
      kidSpeak(
        'Complete the bishop chapter in Pawn\'s Journey to unlock Knight Games!',
      );
    }
  }, [loading, bishopCompleted, kidSpeak]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center flex-1"
        style={{ color: 'var(--color-text)' }}
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="knight-games-page"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Knight Games</h2>
        </div>
        <button
          onClick={handleToggleVoice}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn
              ? 'var(--color-accent)'
              : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn
              ? 'var(--color-bg)'
              : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {!bishopCompleted && (
        <div
          className="rounded-2xl p-6 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
          data-testid="knight-games-locked"
        >
          <Lock
            size={48}
            className="mx-auto mb-3"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <div className="text-xl font-bold mb-2">Locked</div>
          <div style={{ color: 'var(--color-text-muted)' }}>
            Complete the Bishop chapter in Pawn&apos;s Journey to unlock
            Knight Games!
          </div>
          <button
            onClick={() => void navigate('/kid/journey')}
            className="mt-4 px-4 py-2 rounded-lg font-semibold"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
            }}
          >
            Go to Pawn&apos;s Journey
          </button>
        </div>
      )}

      {bishopCompleted && (
        <div className="flex flex-col gap-4">
          {/* Leap Frog card */}
          <button
            onClick={() => void navigate('/kid/knight-games/leap-frog')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="leap-frog-card"
          >
            <span className="text-3xl">🐸</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Leap Frog</div>
              <div
                className="text-sm"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Guide your knight to the treasure, avoiding danger zones!
              </div>
            </div>
            <span className="text-2xl">♞</span>
          </button>

          {/* Knight Sweep card */}
          <button
            onClick={() => void navigate('/kid/knight-games/knight-sweep')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="knight-hunt-card"
          >
            <span className="text-3xl">⚔️</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Knight Hunt</div>
              <div
                className="text-sm"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Capture all enemies in as few moves as possible!
              </div>
            </div>
            <span className="text-2xl">♞</span>
          </button>

          <button
            onClick={() => void navigate('/kid/knight-games/puzzles')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="knight-puzzles-card"
          >
            <span className="text-2xl">🧩</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Knight Puzzles</div>
              <div
                className="text-sm"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Find the knight move that wins.
              </div>
            </div>
          </button>

        <button
          onClick={() => void navigate('/kid/knight-games/maze/1')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="knight-maze-card"
        >
          <span className="text-2xl">🧭</span>
          <div className="flex-1">
            <div className="font-bold text-lg">Knight Path</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Guide the knight to the target square.
            </div>
          </div>
        </button>

        <button
          onClick={() => void navigate('/kid/knight-games/sweep/1')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="knight-sweep-card"
        >
          <span className="text-2xl">⚔️</span>
          <div className="flex-1">
            <div className="font-bold text-lg">Knight Sweep</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Capture every target.
            </div>
          </div>
        </button>
        </div>
      )}
    </div>
  );
}
