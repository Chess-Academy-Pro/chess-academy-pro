import { useState, useEffect, useCallback } from 'react';
import { Swords, Zap, Target, EyeOff } from 'lucide-react';
import { OpeningChallenge } from './OpeningChallenge';
import { OpeningSpeedrun } from './OpeningSpeedrun';
import { GuessTheMove } from './GuessTheMove';
import { BlindfolTrainer } from './BlindfolTrainer';
import {
  getOpeningsByMode,
  getDueCount,
  type ChallengeMode,
} from '../../services/gamesService';
import type { OpeningRecord } from '../../types';

type GameType = 'challenge' | 'speedrun' | 'guess' | 'blindfold';
type PagePhase = 'menu' | 'challenge-modes' | 'playing';

interface GameCardDef {
  id: GameType;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}

const GAME_CARDS: GameCardDef[] = [
  {
    id: 'challenge',
    icon: Swords,
    title: 'Opening Challenge',
    description: 'Play the correct moves for your openings',
  },
  {
    id: 'speedrun',
    icon: Zap,
    title: 'Opening Speedrun',
    description: 'Race through your repertoire',
  },
  {
    id: 'guess',
    icon: Target,
    title: 'Guess the Move',
    description: 'Find the move from real games',
  },
  {
    id: 'blindfold',
    icon: EyeOff,
    title: 'Blindfold Trainer',
    description: 'Play your openings from memory',
  },
];

interface ChallengeModeCard {
  mode: ChallengeMode;
  label: string;
  description: string;
}

const CHALLENGE_MODES: ChallengeModeCard[] = [
  { mode: 'due_review', label: 'Due for Review', description: 'Openings ready for practice' },
  { mode: 'random', label: 'Random', description: 'Surprise me' },
  { mode: 'favorites', label: 'Favorites', description: 'Your starred openings' },
  { mode: 'weakest', label: 'Weakest Lines', description: 'Lowest accuracy openings' },
  { mode: 'previously_drilled', label: 'Previously Drilled', description: 'Review old lines' },
  { mode: 'traps', label: 'Traps & Pitfalls', description: 'Openings with known traps' },
  { mode: 'warnings', label: 'Watch Out For', description: 'Openings with warnings' },
];

export function GamesPage(): JSX.Element {
  const [phase, setPhase] = useState<PagePhase>('menu');
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [dueCount, setDueCount] = useState(0);

  // Challenge-specific state
  const [challengeQueue, setChallengeQueue] = useState<OpeningRecord[]>([]);
  const [challengeIdx, setChallengeIdx] = useState(0);


  // Load due count
  useEffect(() => {
    void getDueCount().then(setDueCount);
  }, []);

  // Select a game type
  const handleGameSelect = useCallback((game: GameType): void => {
    setSelectedGame(game);
    if (game === 'challenge') {
      setPhase('challenge-modes');
    } else {
      setPhase('playing');
    }
  }, []);

  // Select a challenge mode
  const handleChallengeMode = useCallback(async (mode: ChallengeMode): Promise<void> => {
    const openings = await getOpeningsByMode(mode);
    if (openings.length === 0) return;
    setChallengeQueue(openings);
    setChallengeIdx(0);
    setPhase('playing');
  }, []);

  // Back to menu
  const handleBackToMenu = useCallback((): void => {
    setPhase('menu');
    setSelectedGame(null);
    setChallengeQueue([]);
    setChallengeIdx(0);
    // Refresh due count
    void getDueCount().then(setDueCount);
  }, []);

  // Challenge: advance to next opening
  const handleChallengeNext = useCallback((): void => {
    if (challengeIdx + 1 < challengeQueue.length) {
      setChallengeIdx((prev) => prev + 1);
    } else {
      handleBackToMenu();
    }
  }, [challengeIdx, challengeQueue.length, handleBackToMenu]);

  // Challenge: on complete (no-op — tracked for future session stats)
  const handleChallengeComplete = useCallback(
    (_perfect: boolean): void => { /* future: session stats */ },
    [],
  );

  // ─── Playing phase: render selected game ────────────────────────────────────
  if (phase === 'playing' && selectedGame) {
    switch (selectedGame) {
      case 'challenge': {
        const opening = challengeQueue[challengeIdx];
        return (
          <OpeningChallenge
            key={opening.id}
            opening={opening}
            queuePosition={`${challengeIdx + 1} / ${challengeQueue.length}`}
            hasNext={challengeIdx + 1 < challengeQueue.length}
            onComplete={handleChallengeComplete}
            onNext={handleChallengeNext}
            onExit={handleBackToMenu}
          />
        );
      }
      case 'speedrun':
        return <OpeningSpeedrun onExit={handleBackToMenu} />;
      case 'guess':
        return <GuessTheMove onExit={handleBackToMenu} />;
      case 'blindfold':
        return <BlindfolTrainer onExit={handleBackToMenu} />;
    }
  }

  // ─── Challenge mode selection ───────────────────────────────────────────────
  if (phase === 'challenge-modes') {
    return (
      <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="challenge-modes">
        <div className="max-w-lg mx-auto space-y-4">
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={handleBackToMenu}
              className="p-2 rounded-lg hover:bg-theme-surface"
              data-testid="modes-back"
            >
              <Swords size={18} className="text-theme-text" />
            </button>
            <div>
              <h2 className="text-lg font-bold text-theme-text">Opening Challenge</h2>
              <p className="text-xs text-theme-text-muted">Choose your challenge</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {CHALLENGE_MODES.map(({ mode, label, description }) => (
              <button
                key={mode}
                onClick={() => void handleChallengeMode(mode)}
                className="relative p-4 rounded-xl bg-theme-surface border border-theme-border hover:border-theme-accent/50 transition-colors text-left"
                data-testid={`mode-${mode}`}
              >
                <p className="text-sm font-semibold text-theme-text">{label}</p>
                <p className="text-xs text-theme-text-muted mt-0.5">{description}</p>
                {mode === 'due_review' && dueCount > 0 && (
                  <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full bg-theme-accent text-white text-[10px] font-bold">
                    {dueCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─── Main menu ──────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="games-page">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-theme-text">Play</h1>
          <p className="text-sm text-theme-text-muted">Interactive chess training games</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {GAME_CARDS.map(({ id, icon: Icon, title, description }) => (
            <button
              key={id}
              onClick={() => handleGameSelect(id)}
              className="relative flex flex-col items-start p-5 rounded-xl bg-theme-surface border border-theme-border hover:border-theme-accent/50 hover:shadow-md transition-all text-left"
              data-testid={`game-${id}`}
            >
              <div className="w-10 h-10 rounded-lg bg-theme-accent/10 flex items-center justify-center mb-3">
                <Icon size={20} className="text-theme-accent" />
              </div>
              <p className="text-sm font-semibold text-theme-text">{title}</p>
              <p className="text-xs text-theme-text-muted mt-1">{description}</p>
              {id === 'challenge' && dueCount > 0 && (
                <span className="absolute top-3 right-3 px-1.5 py-0.5 rounded-full bg-theme-accent text-white text-[10px] font-bold">
                  {dueCount} due
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
