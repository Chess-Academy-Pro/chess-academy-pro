import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { motion } from 'framer-motion';
import { getGamesByOpening } from '../../services/gameInsightsService';
import { reconstructMovesFromGame } from '../../services/gameReconstructionService';
import { calculateAccuracy, getClassificationCounts } from '../../services/accuracyService';
import { logAppAudit } from '../../services/appAuditor';
import { useAppStore } from '../../stores/appStore';
import { InsightsDonutChart } from './InsightsDonutChart';
import { GameCard } from './GameCard';
import type { OpeningAggregateStats, GameRecord } from '../../types';

interface OpeningDrilldownProps {
  opening: OpeningAggregateStats;
  onBack: () => void;
}

interface GameCardData {
  game: GameRecord;
  playerColor: 'white' | 'black';
  accuracy: number | null;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  moves: number;
  result: 'win' | 'loss' | 'draw';
}

const AI_NAMES = ['AI Coach', 'Stockfish Bot'];

/** Resolve which color the user played in a given game. Previously
 *  this only checked AI_NAMES and defaulted to 'white' — silently
 *  misclassified every imported game where the user was Black.
 *  Now checks the three identity sources the rest of the app uses
 *  (chess.com username + lichess username + profile name). */
function getPlayerColor(
  game: GameRecord,
  identity: { profileName?: string; chessComUsername?: string; lichessUsername?: string },
): 'white' | 'black' {
  if (AI_NAMES.includes(game.white)) return 'black';
  if (AI_NAMES.includes(game.black)) return 'white';
  const candidates: string[] = [];
  if (identity.chessComUsername) candidates.push(identity.chessComUsername.toLowerCase());
  if (identity.lichessUsername) candidates.push(identity.lichessUsername.toLowerCase());
  if (identity.profileName) candidates.push(identity.profileName.toLowerCase());
  const whiteName = game.white.toLowerCase();
  const blackName = game.black.toLowerCase();
  for (const c of candidates) {
    if (whiteName === c) return 'white';
    if (blackName === c) return 'black';
  }
  for (const c of candidates) {
    if (whiteName.includes(c)) return 'white';
    if (blackName.includes(c)) return 'black';
  }
  return 'white';
}

function getResult(game: GameRecord, color: 'white' | 'black'): 'win' | 'loss' | 'draw' {
  if (game.result === '1/2-1/2') return 'draw';
  if ((color === 'white' && game.result === '1-0') || (color === 'black' && game.result === '0-1')) return 'win';
  return 'loss';
}

export function OpeningDrilldown({ opening, onBack }: OpeningDrilldownProps): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const [games, setGames] = useState<GameCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!opening.eco) {
      setLoading(false);
      return;
    }
    void getGamesByOpening(opening.eco).then((rawGames) => {
      const processed: GameCardData[] = rawGames.map((game) => {
        const playerColor = getPlayerColor(game, {
          profileName: activeProfile?.name,
          chessComUsername: activeProfile?.preferences.chessComUsername,
          lichessUsername: activeProfile?.preferences.lichessUsername,
        });
        let accuracy: number | null = null;
        let blunders = 0, mistakes = 0, inaccuracies = 0;

        if (game.annotations && game.annotations.length > 0) {
          const moves = reconstructMovesFromGame(game, playerColor);
          if (moves.length > 0) {
            const acc = calculateAccuracy(moves);
            accuracy = Math.round(playerColor === 'white' ? acc.white : acc.black);
            const counts = getClassificationCounts(moves, playerColor);
            blunders = counts.blunder;
            mistakes = counts.mistake;
            inaccuracies = counts.inaccuracy;
          }
        }

        const moveCount = game.pgn.split(/\s+/).filter((t) => !/^\d+\.+$/.test(t)).length;

        return {
          game,
          playerColor,
          accuracy,
          blunders,
          mistakes,
          inaccuracies,
          moves: moveCount,
          result: getResult(game, playerColor),
        };
      });
      processed.sort((a, b) => b.game.date.localeCompare(a.game.date));
      setGames(processed);
      setLoading(false);
    });
    // activeProfile is read inside the .then() callback above for
    // playerColor inference; deps include it so a username change
    // re-resolves the orientation correctly.
     
  }, [opening.eco, activeProfile?.name, activeProfile?.preferences.chessComUsername, activeProfile?.preferences.lichessUsername]);

  const wldData = [
    { name: 'Wins', value: opening.wins, color: 'var(--color-success)' },
    { name: 'Losses', value: opening.losses, color: 'var(--color-error)' },
    { name: 'Draws', value: opening.draws, color: 'var(--color-text-muted)' },
  ];

  const errorsPerGame = opening.games > 0
    ? ((games.reduce((s, g) => s + g.blunders + g.mistakes + g.inaccuracies, 0)) / opening.games).toFixed(1)
    : '0';

  return (
    <motion.div
      initial={{ x: '100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '100%', opacity: 0 }}
      transition={{ duration: 0.2 }}
      data-testid="opening-drilldown"
    >
      {/* Header */}
      <div className="flex items-center gap-3 pt-4 mb-3">
        <button onClick={onBack} className="p-1.5 rounded-lg hover:opacity-80" data-testid="drilldown-back">
          <ArrowLeft size={18} style={{ color: 'var(--color-text)' }} />
        </button>
        <h3 className="text-base font-bold flex-1" style={{ color: 'var(--color-text)' }}>{opening.name}</h3>
        {opening.eco && (
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text-muted)' }}>{opening.eco}</span>
        )}
      </div>

      {/* Summary stats */}
      <div className="flex border-b pb-3.5" style={{ borderColor: 'var(--color-border)' }}>
        <SumStat value={`${opening.games}`} label="Games" />
        <SumStat value={`${opening.winRate}%`} label="Win Rate" color="var(--color-success)" />
        <SumStat value={loading ? '—' : errorsPerGame} label="Err/Game" />
      </div>

      {/* Record donut */}
      <div className="flex items-center gap-5 py-3.5">
        <InsightsDonutChart data={wldData} size={64} innerRadius={20} outerRadius={28} centerValue={`${opening.wins}W`} />
        <div className="flex flex-col gap-1.5 flex-1">
          {wldData.map((d) => (
            <div key={d.name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
              {d.name}
              <span className="ml-auto font-semibold" style={{ color: 'var(--color-text)' }}>{d.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Game list */}
      <h3
        className="text-[10px] font-bold uppercase tracking-wider pb-2 border-b mt-2"
        style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
      >
        All Games ({games.length})
      </h3>

      {loading && (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
      )}

      {!loading && games.map((g) => {
        const oppName = g.playerColor === 'white' ? g.game.black : g.game.white;
        const oppElo = g.playerColor === 'white' ? g.game.blackElo : g.game.whiteElo;

        return (
          <GameCard
            key={g.game.id}
            opponentName={oppName}
            opponentElo={oppElo}
            result={g.result}
            accuracy={g.accuracy}
            blunders={g.blunders}
            mistakes={g.mistakes}
            inaccuracies={g.inaccuracies}
            moves={g.moves}
            cpLoss={null}
            date={g.game.date}
            onClick={() => {
              void logAppAudit({
                kind: 'coach-surface-migrated',
                category: 'subsystem',
                source: 'OpeningDrilldown.tapGame',
                summary: `open review for ${g.game.id} (eco=${opening.eco ?? 'unknown'})`,
                details: JSON.stringify({ gameId: g.game.id, eco: opening.eco, openingName: opening.name }),
              });
              void navigate(
                `/coach/review/${encodeURIComponent(g.game.id)}`,
                { state: { from: '/weaknesses', tab: 'openings' } },
              );
            }}
          />
        );
      })}
    </motion.div>
  );
}

function SumStat({ value, label, color }: { value: string; label: string; color?: string }): JSX.Element {
  return (
    <div className="text-center flex-1">
      <div className="text-lg font-bold" style={{ color: color ?? 'var(--color-text)' }}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}
