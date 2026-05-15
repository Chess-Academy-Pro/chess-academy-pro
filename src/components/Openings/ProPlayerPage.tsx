import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { getPlayerById, getPlayerOpenings } from '../../services/proRepertoireService';
import { toggleFavorite } from '../../services/openingService';
import { OpeningCard } from './OpeningCard';
import type { OpeningRecord, ProPlayer } from '../../types';

export function ProPlayerPage(): JSX.Element {
  const { playerId } = useParams<{ playerId: string }>();
  const navigate = useNavigate();
  const [player, setPlayer] = useState<ProPlayer | null>(null);
  const [openings, setOpenings] = useState<OpeningRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!playerId) return;
    const p = getPlayerById(playerId);
    setPlayer(p ?? null);
    void getPlayerOpenings(playerId).then((result) => {
      setOpenings(result);
      setLoading(false);
    });
  }, [playerId]);

  const handleToggleFavorite = useCallback(async (id: string): Promise<void> => {
    const newVal = await toggleFavorite(id);
    setOpenings((prev) =>
      prev.map((o) => (o.id === id ? { ...o, isFavorite: newVal } : o)),
    );
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Loading player...</p>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Player not found.</p>
      </div>
    );
  }

  const whites = openings.filter((o) => o.color === 'white');
  const blacks = openings.filter((o) => o.color === 'black');

  return (
    <div className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto" data-testid="pro-player-page">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => void navigate('/openings')}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          aria-label="Back to openings"
          data-testid="back-button"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <div className="w-12 h-12 rounded-full bg-theme-accent/20 flex items-center justify-center shrink-0">
          <span className="text-sm font-bold text-theme-accent">{player.imageInitials}</span>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-theme-text">{player.name}</h1>
            <span className="text-sm font-mono text-theme-accent">{player.title}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-theme-text-muted">
            <span>FIDE {player.rating}</span>
            <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
            <span>{player.style}</span>
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-theme-text-muted mb-6">{player.description}</p>

      {/* White Openings */}
      {whites.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-bold text-theme-text-muted uppercase tracking-widest mb-3">
            White Repertoire
          </h2>
          <div className="space-y-2">
            {whites.map((opening, i) => (
              <motion.div
                key={opening.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03, duration: 0.25 }}
              >
                <OpeningCard
                  opening={opening}
                  onClick={() => void navigate(`/openings/pro/${playerId}/${opening.id}`)}
                  onToggleFavorite={() => void handleToggleFavorite(opening.id)}
                />
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Black Openings */}
      {blacks.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-bold text-theme-text-muted uppercase tracking-widest mb-3">
            Black Repertoire
          </h2>
          <div className="space-y-2">
            {blacks.map((opening, i) => (
              <motion.div
                key={opening.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03, duration: 0.25 }}
              >
                <OpeningCard
                  opening={opening}
                  onClick={() => void navigate(`/openings/pro/${playerId}/${opening.id}`)}
                  onToggleFavorite={() => void handleToggleFavorite(opening.id)}
                />
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {openings.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-theme-text-muted">
          No openings found for this player.
        </div>
      )}
    </div>
  );
}
