import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { BishopVsPawns } from './BishopVsPawns';
import { ColorWars } from './ColorWars';

// /kid/bishop-games — hub for Bishop vs Pawns + Color Wars, mirroring
// the Rook/Knight/Queen hub shape per non-negotiable #9 ("every kid
// hub looks the same"). Before this hub existed, the two bishop games
// were rendered in-place via `setView` inside KidModePage — gated on
// completing the Rook chapter of Pawn's Journey. The unlock gate is
// preserved here by inspecting that progress before routing.
//
// BishopVsPawnsRoute / ColorWarsRoute below are thin wrappers that
// keep BishopVsPawns / ColorWars's existing `onBack` prop contract
// (tests use that prop directly) while wiring `navigate(...)` for
// the routed surface.

export function BishopGamesPage(): JSX.Element {
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
      kidSpeak('Bishop Games. Pick your challenge.');
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
      data-testid="bishop-games-page"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back to Kids Mode"
            data-testid="bishop-games-back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Bishop Games</h2>
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
          data-testid="bishop-games-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <button
          onClick={() => void navigate('/kid/bishop-games/vs-pawns')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="bishop-vs-pawns-card"
        >
          <span className="text-3xl">♗</span>
          <div className="flex-1">
            <div className="font-bold text-lg">Bishop vs Pawns</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Catch the pawns before they promote.
            </div>
          </div>
        </button>

        <button
          onClick={() => void navigate('/kid/bishop-games/color-wars')}
          className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
          }}
          data-testid="color-wars-card"
        >
          <span className="text-3xl">♗♗</span>
          <div className="flex-1">
            <div className="font-bold text-lg">Color Wars</div>
            <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Two bishops attack on every color.
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

export function BishopVsPawnsRoute(): JSX.Element {
  const navigate = useNavigate();
  return <BishopVsPawns onBack={() => void navigate('/kid/bishop-games')} />;
}

export function ColorWarsRoute(): JSX.Element {
  const navigate = useNavigate();
  return <ColorWars onBack={() => void navigate('/kid/bishop-games')} />;
}
