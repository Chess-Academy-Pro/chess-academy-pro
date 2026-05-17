import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { motion, MotionConfig } from 'framer-motion';
import { voiceService } from '../../services/voiceService';
import { getGameProgress } from '../../services/journeyService';
import { QueenVsArmy } from './QueenVsArmy';
import { QueensGauntlet } from './QueensGauntlet';
import type { JourneyProgress } from '../../types';

type HubView = 'menu' | 'queen-vs-army' | 'queens-gauntlet';

interface LevelCompletion {
  queenArmy: boolean[];
  gauntlet: boolean[];
}

export function QueenGamesHub(): JSX.Element {
  const navigate = useNavigate();
  const [view, setView] = useState<HubView>('menu');
  const [voiceOn, setVoiceOn] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completion, setCompletion] = useState<LevelCompletion>({
    queenArmy: [false, false, false],
    gauntlet: [false, false, false],
  });

  useEffect(() => {
    void getGameProgress('pawns-journey').then((progress: JourneyProgress | null) => {
      if (progress) {
        setUnlocked(true); // DEV: unlocked for testing
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!loading && voiceOn && view === 'menu') {
      if (unlocked) {
        void voiceService.speak('Welcome to the Queen Games! Choose your challenge.');
      } else {
        void voiceService.speak('Complete the Knight chapter first to unlock the Queen Games!');
      }
    }
  }, [loading, unlocked, voiceOn, view]);

  const handleBack = useCallback((): void => {
    if (view !== 'menu') {
      setView('menu');
    } else {
      void navigate('/kid');
    }
  }, [view, navigate]);

  const handleVoiceToggle = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  const handleArmyComplete = useCallback((level: number, won: boolean): void => {
    if (won) {
      setCompletion((prev) => {
        const updated = [...prev.queenArmy];
        updated[level - 1] = true;
        return { ...prev, queenArmy: updated };
      });
      if (voiceOn) {
        void voiceService.speak('Amazing! You defeated the pawn army!');
      }
    }
  }, [voiceOn]);

  const handleGauntletComplete = useCallback((level: number, won: boolean): void => {
    if (won) {
      setCompletion((prev) => {
        const updated = [...prev.gauntlet];
        updated[level - 1] = true;
        return { ...prev, gauntlet: updated };
      });
      if (voiceOn) {
        void voiceService.speak('Brilliant! You navigated the gauntlet safely!');
      }
    }
  }, [voiceOn]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center flex-1 p-6"
        style={{ color: 'var(--color-text)' }}
        data-testid="queen-games-loading"
      >
        <p className="text-xl font-bold animate-pulse">Loading...</p>
      </div>
    );
  }

  if (view === 'queen-vs-army') {
    return (
      <MotionConfig transition={{ duration: 0.15 }}>
        <QueenVsArmy onBack={handleBack} onComplete={handleArmyComplete} />
      </MotionConfig>
    );
  }

  if (view === 'queens-gauntlet') {
    return (
      <MotionConfig transition={{ duration: 0.15 }}>
        <QueensGauntlet onBack={handleBack} onComplete={handleGauntletComplete} />
      </MotionConfig>
    );
  }

  const armyCompleted = completion.queenArmy.filter(Boolean).length;
  const gauntletCompleted = completion.gauntlet.filter(Boolean).length;

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="queen-games-hub"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="queen-hub-back"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-2xl font-bold">Queen Games</h1>
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
          data-testid="queen-hub-voice"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {!unlocked && (
        <div
          className="rounded-xl p-5 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
          data-testid="queen-games-locked"
        >
          <span className="text-4xl block mb-2">🔒</span>
          <p className="font-bold">Locked</p>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Complete the Knight chapter to unlock these games!
          </p>
        </div>
      )}

      {unlocked && (
        <div className="flex flex-col gap-4">
          {/* Queen vs Army card */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setView('queen-vs-army')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 text-left transition-colors"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="queen-army-card"
          >
            <span className="text-4xl flex-shrink-0">⚔️</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Queen vs. Army</div>
              <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Capture all enemy pawns before they promote!
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-accent)' }}>
                {armyCompleted}/3 levels completed
              </div>
            </div>
          </motion.button>

          {/* Queen's Gauntlet card */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setView('queens-gauntlet')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 text-left transition-colors"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="queen-gauntlet-card"
          >
            <span className="text-4xl flex-shrink-0">🛡️</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Queen&apos;s Gauntlet</div>
              <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Navigate through enemy lines to reach the target!
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-accent)' }}>
                {gauntletCompleted}/3 levels completed
              </div>
            </div>
          </motion.button>

          {/* Per-piece adaptive puzzles — Phase 8. */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => void navigate('/kid/queen-games/puzzles')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 text-left transition-colors"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="queen-puzzles-card"
          >
            <span className="text-2xl">🧩</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Queen Puzzles</div>
              <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Find the queen move that wins.
              </div>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => void navigate('/kid/queen-games/maze/1')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="queen-maze-card"
          >
            <span className="text-2xl">🧭</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Queen Path</div>
              <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Guide the queen to the target square.
              </div>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => void navigate('/kid/queen-games/sweep/1')}
            className="rounded-xl p-5 border-2 flex items-center gap-4 text-left transition-colors"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.1)',
            }}
            data-testid="queen-hunt-card"
          >
            <span className="text-2xl">⚔️</span>
            <div className="flex-1">
              <div className="font-bold text-lg">Queen Hunt</div>
              <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Capture every target.
              </div>
            </div>
          </motion.button>
        </div>
      )}
    </div>
  );
}
