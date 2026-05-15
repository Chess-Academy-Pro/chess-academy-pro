import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { MiniGameLevelSelect } from './MiniGameLevelSelect';
import { getMiniGameProgress } from '../../services/miniGameService';
import { PAWN_WARS_LEVELS } from '../../data/pawnWarsConfig';
import { BLOCKER_LEVELS } from '../../data/blockerConfig';
import type { MiniGameProgress } from '../../types';

interface GameSection {
  id: 'pawn-wars' | 'blocker';
  title: string;
  icon: string;
  description: string;
}

const GAME_SECTIONS: GameSection[] = [
  {
    id: 'pawn-wars',
    title: 'Pawn Wars',
    icon: '\u2694\uFE0F',
    description: 'Race your pawns to the other side!',
  },
  {
    id: 'blocker',
    title: 'Blocker',
    icon: '\uD83D\uDEE1\uFE0F',
    description: 'Stop the enemy pawn while promoting yours!',
  },
];

export function MiniGameHubPage(): JSX.Element {
  const navigate = useNavigate();
  const [pawnWarsProgress, setPawnWarsProgress] =
    useState<MiniGameProgress | null>(null);
  const [blockerProgress, setBlockerProgress] =
    useState<MiniGameProgress | null>(null);

  useEffect(() => {
    void getMiniGameProgress('pawn-wars').then((p) => setPawnWarsProgress(p));
    void getMiniGameProgress('blocker').then((p) => setBlockerProgress(p));
  }, []);

  const handleLevelSelect = useCallback(
    (gameId: string, level: number): void => {
      void navigate(`/kid/mini-games/${gameId}/${level}`);
    },
    [navigate],
  );

  const handleBack = useCallback((): void => {
    void navigate('/kid');
  }, [navigate]);

  function getProgress(gameId: string): MiniGameProgress | null {
    return gameId === 'pawn-wars' ? pawnWarsProgress : blockerProgress;
  }

  function getLevels(gameId: string): typeof PAWN_WARS_LEVELS {
    return gameId === 'pawn-wars' ? PAWN_WARS_LEVELS : BLOCKER_LEVELS;
  }

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="mini-game-hub"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleBack}
          className="p-2 rounded-lg hover:opacity-80"
          style={{ background: 'var(--color-surface)' }}
          data-testid="hub-back"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-bold">Mini-Games</h1>
      </div>

      {/* Game sections */}
      {GAME_SECTIONS.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{section.icon}</span>
            <div>
              <h2 className="font-bold text-lg">{section.title}</h2>
              <p
                className="text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {section.description}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {getLevels(section.id).map((levelConfig) => (
              <MiniGameLevelSelect
                key={levelConfig.level}
                config={levelConfig}
                progress={getProgress(section.id)}
                onSelect={(level) => handleLevelSelect(section.id, level)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
