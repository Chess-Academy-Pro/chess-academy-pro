/**
 * GamesDrilldownPage — "Games behind this stat" full-page view.
 *
 * Renders the set of games that satisfy a stacked StatFilter list.
 * Every aggregate on /weaknesses (heatmap cells, time-control rows,
 * tactic-recognition rows, critical-moments card, opening
 * proficiency cells, Patterns cards, personal records) navigates
 * here with one or more filters encoded in the URL. The user can
 * add more filters by tapping on other stats elsewhere, OR remove
 * filters here by tapping the X on a chip.
 *
 * Each game row uses `EnhancedGameCard` (richer than the basic
 * GameCard — eval sparkline + time-control + opening name) and
 * routes to `/coach/review/:gameId` on tap for full review-with-
 * coach.
 *
 * URL shape: `/weaknesses/games?f=<base64-encoded JSON array>`
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { db } from '../../db/schema';
import {
  decodeFilters,
  encodeFilters,
  resolveFiltersToGames,
  type StatFilter,
} from '../../services/gameFilterService';
import { logAppAudit } from '../../services/appAuditor';
import { EnhancedGameCard } from './EnhancedGameCard';
import type { GameRecord } from '../../types';

export function GamesDrilldownPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filtersParam = searchParams.get('f') ?? '';
  const filters = useMemo<StatFilter[]>(() => decodeFilters(filtersParam), [filtersParam]);

  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      const profile = await db.profiles.toCollection().first();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) return;
      setUsername(
        profile?.preferences.chessComUsername
          ?? profile?.preferences.lichessUsername
          ?? profile?.name
          ?? null,
      );
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void logAppAudit({
      kind: 'weakness-report-refresh',
      category: 'subsystem',
      source: 'GamesDrilldownPage.mount',
      summary: `drilldown filters=${filters.length}`,
      details: JSON.stringify({ filters: filters.map((f) => ({ source: f.source, label: f.label })) }),
    });
    void resolveFiltersToGames(filters).then((result) => {
      if (!cancelled) {
        // Newest-first ordering.
        const sorted = [...result].sort((a, b) => b.date.localeCompare(a.date));
        setGames(sorted);
      }
    });
    return () => { cancelled = true; };
  }, [filtersParam]);  // eslint-disable-line react-hooks/exhaustive-deps

  const removeFilter = (idx: number): void => {
    const next = filters.filter((_, i) => i !== idx);
    if (next.length === 0) {
      setSearchParams({});
    } else {
      setSearchParams({ f: encodeFilters(next) });
    }
  };

  return (
    <motion.div
      className="flex flex-col h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      data-testid="games-drilldown-page"
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-2 shrink-0 flex items-center gap-3">
        <button
          onClick={() => void navigate('/weaknesses')}
          className="p-1.5 rounded-lg hover:opacity-80"
          aria-label="Back to weaknesses"
          data-testid="back-btn"
        >
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
            Games behind this stat
          </h2>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {games === null
              ? 'Loading…'
              : `${games.length} game${games.length === 1 ? '' : 's'} match${games.length === 1 ? 'es' : ''}`}
          </span>
        </div>
      </div>

      {/* Filter chips */}
      {filters.length > 0 && (
        <div className="px-5 pb-2 flex flex-wrap gap-1.5">
          {filters.map((f, i) => (
            <button
              key={`${f.source}-${i}`}
              onClick={() => removeFilter(i)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)',
                color: 'var(--color-text)',
              }}
              data-testid={`filter-chip-${f.source}`}
            >
              <span>{f.label}</span>
              <X size={12} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          ))}
        </div>
      )}

      {/* Game list */}
      <div className="flex-1 overflow-y-auto px-5 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6">
        {games === null && (
          <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Loading games…
          </div>
        )}
        {games !== null && games.length === 0 && (
          <div className="py-10 text-center" data-testid="games-drilldown-empty">
            <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              No games match these filters
            </div>
            <div className="text-xs mt-2 max-w-xs mx-auto" style={{ color: 'var(--color-text-muted)' }}>
              Remove a chip above to widen the search, or go back to /weaknesses and tap a different stat.
            </div>
          </div>
        )}
        {games && games.map((g) => (
          <EnhancedGameCard key={g.id} game={g} username={username} />
        ))}
      </div>
    </motion.div>
  );
}
