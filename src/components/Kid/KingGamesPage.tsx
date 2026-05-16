import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Shield, Footprints, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';

// /kid/king-games — hub for King Escape + King March, mirroring the
// Rook/Knight/Queen hub shape per non-negotiable #9 ("every kid hub
// looks the same"). Before this hub existed, the two king games were
// rendered as loose tiles on /kid; they're now grouped behind one
// tile that routes here.

export function KingGamesPage(): JSX.Element {
  const navigate = useNavigate();
  const [voiceOn, setVoiceOn] = useState(true);
  const hasSpoken = useRef(false);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  useEffect(() => {
    if (!hasSpoken.current) {
      hasSpoken.current = true;
      kidSpeak('King Games. Pick your challenge.');
    }
  }, [kidSpeak]);

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  return (
    <div
      className="flex flex-col gap-4 p-6 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="king-games-page"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back to Kids Mode"
            data-testid="king-games-back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">King Games</h2>
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
          data-testid="king-games-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <button
          onClick={() => void navigate('/kid/king-games/escape')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="king-escape-card"
        >
          <Shield size={28} style={{ color: 'var(--color-accent)' }} />
          <div className="flex-1">
            <div className="font-bold text-lg">King Escape</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Move the king out of check.
            </div>
          </div>
          <span className="text-2xl">♚</span>
        </button>

        <button
          onClick={() => void navigate('/kid/king-games/march')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="king-march-card"
        >
          <Footprints size={28} style={{ color: 'var(--color-accent)' }} />
          <div className="flex-1">
            <div className="font-bold text-lg">King March</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              March the king to rank 8.
            </div>
          </div>
          <span className="text-2xl">♚</span>
        </button>

        <button
          onClick={() => void navigate('/kid/king-games/puzzles')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="king-puzzles-card"
        >
          <span className="text-2xl">🧩</span>
          <div className="flex-1">
            <div className="font-bold text-lg">King Puzzles</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Find the king move that wins.
            </div>
          </div>
        </button>

        <button
          onClick={() => void navigate('/kid/king-games/maze/1')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="king-maze-card"
        >
          <span className="text-2xl">🧭</span>
          <div className="flex-1">
            <div className="font-bold text-lg">King Path</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Guide the king to the target square.
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
