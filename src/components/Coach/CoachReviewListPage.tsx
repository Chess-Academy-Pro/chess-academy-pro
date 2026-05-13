import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Filter, Bot, Globe } from 'lucide-react';
import { db } from '../../db/schema';
import type { GameRecord, GameSource } from '../../types';
import { ReviewGameCard } from './ReviewGameCard';
import { ImportGamesButton } from '../Games/ImportGamesButton';
import { logAppAudit } from '../../services/appAuditor';
import { seedReviewSamplesIfNeeded } from '../../services/reviewSampleGames';

type SourceFilter = 'all' | GameSource;

const FILTER_BUTTONS: { id: SourceFilter; label: string; icon: JSX.Element | null }[] = [
  { id: 'all', label: 'All', icon: null },
  { id: 'coach', label: 'vs Coach', icon: <Bot size={14} /> },
  { id: 'lichess', label: 'lichess', icon: <Globe size={14} /> },
  { id: 'chesscom', label: 'chess.com', icon: <Globe size={14} /> },
];

export function CoachReviewListPage(): JSX.Element {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        // First-visit seeding: drop 5 pre-analyzed sample games into
        // the local library so the user has something to click into
        // without having to play or import first. Idempotent — once
        // a meta flag is set, subsequent loads skip the insert.
        await seedReviewSamplesIfNeeded();
        const all = await db.games.orderBy('date').reverse().limit(100).toArray();
        if (cancelled) return;
        setGames(all);
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'CoachReviewListPage',
          summary: `loaded ${all.length} games (cap=100) for review picker`,
          details: JSON.stringify({ count: all.length, cap: 100 }),
        });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!games) return null;
    if (filter === 'all') return games;
    return games.filter((g) => g.source === filter);
  }, [games, filter]);

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="coach-review-list-page"
    >
      <div className="flex items-center gap-2 max-w-lg mx-auto w-full">
        <button
          onClick={() => navigate('/coach/home')}
          aria-label="Back to coach"
          className="p-2 rounded-lg hover:bg-theme-border/50 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold flex-1 text-center">Review with Coach</h1>
        <ImportGamesButton variant="compact" />
      </div>

      <p className="text-center text-sm text-theme-text-muted max-w-lg mx-auto w-full -mt-2">
        Pick a game. The coach walks through it move by move.
      </p>

      {/* Source filter row */}
      <div className="flex items-center gap-2 max-w-lg mx-auto w-full overflow-x-auto pb-1">
        <Filter size={14} className="text-theme-text-muted shrink-0" />
        {FILTER_BUTTONS.map((b) => {
          const active = filter === b.id;
          return (
            <button
              key={b.id}
              onClick={() => {
                // Audit-driven (#14): a "filter looks empty" report
                // now has a trail showing which filter was active and
                // how many games matched.
                const all = games ?? [];
                const matched = b.id === 'all' ? all.length : all.filter((g) => g.source === b.id).length;
                void logAppAudit({
                  kind: 'coach-surface-migrated',
                  category: 'subsystem',
                  source: 'CoachReviewListPage.filter',
                  summary: `filter=${b.id} matched=${matched} of ${all.length}`,
                  details: JSON.stringify({ filter: b.id, matched, total: all.length }),
                });
                setFilter(b.id);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
                active
                  ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                  : 'bg-theme-surface border-theme-border text-theme-text-muted hover:text-theme-text'
              }`}
              data-testid={`review-filter-${b.id}`}
            >
              {b.icon}
              {b.label}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="flex flex-col gap-2 max-w-lg mx-auto w-full">
        {error && (
          <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
            Couldn't load your games: {error}
          </div>
        )}

        {!error && games === null && (
          <div className="text-center text-sm text-theme-text-muted py-8">
            Loading your games…
          </div>
        )}

        {!error && filtered && filtered.length === 0 && (
          <div className="text-center text-sm text-theme-text-muted py-8">
            {filter === 'all'
              ? 'No games to review yet. Play a game with the coach or import games from lichess / chess.com.'
              : `No games from ${filter} yet.`}
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={() => navigate('/coach/play')}
                className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-medium hover:bg-emerald-500/25"
              >
                Play vs Coach
              </button>
              <button
                onClick={() => navigate('/games/import')}
                className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-xs font-medium hover:bg-cyan-500/25"
              >
                Import games
              </button>
            </div>
          </div>
        )}

        {filtered &&
          filtered.map((g) => (
            <ReviewGameCard
              key={g.id}
              game={g}
              onClick={() => navigate(`/coach/review/${encodeURIComponent(g.id)}`)}
            />
          ))}
      </div>
    </div>
  );
}
