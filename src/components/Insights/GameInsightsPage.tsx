import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, RefreshCw, Search, Sparkles } from 'lucide-react';
import {
  getOverviewInsights,
  getOpeningInsights,
  getMistakeInsights,
  getTacticInsights,
} from '../../services/gameInsightsService';
import { runBackgroundAnalysis } from '../../services/gameAnalysisService';
import { ImportGamesButton } from '../Games/ImportGamesButton';
import { useAppStore } from '../../stores/appStore';
import { routeChatIntent } from '../../services/coachSessionRouter';
import { OverviewTab } from './OverviewTab';
import { ShareableInsightsStrip } from './ShareableInsightsStrip';
import { OpeningsTab } from './OpeningsTab';
import { MistakesTab } from './MistakesTab';
import { TacticsTab } from './TacticsTab';
import type {
  InsightsTab,
  OverviewInsights,
  OpeningInsights,
  MistakeInsights,
  TacticInsights,
} from '../../types';

const TABS: { id: InsightsTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'openings', label: 'Openings' },
  { id: 'mistakes', label: 'Mistakes' },
  { id: 'tactics', label: 'Tactics' },
];

export function GameInsightsPage(): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<InsightsTab>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [overview, setOverview] = useState<OverviewInsights | null>(null);
  const [openings, setOpenings] = useState<OpeningInsights | null>(null);
  const [mistakes, setMistakes] = useState<MistakeInsights | null>(null);
  const [tactics, setTactics] = useState<TacticInsights | null>(null);

  // Subscribe to the global background-analysis store so the CTA on the
  // Overview tab reflects live progress AND so navigating to another
  // tab (Openings, Tactics, Weaknesses) doesn't kill the analysis or
  // orphan its progress — runBackgroundAnalysis pushes into this store,
  // and AppLayout renders a persistent top-of-app banner from it.
  const bgAnalysisRunning = useAppStore((s) => s.backgroundAnalysisRunning);
  const bgAnalysisProgress = useAppStore((s) => s.backgroundAnalysisProgress);
  const prevBgRunning = useRef(false);

  async function loadAll(): Promise<void> {
    const [ov, op, mi, ta] = await Promise.all([
      getOverviewInsights(),
      getOpeningInsights(),
      getMistakeInsights(),
      getTacticInsights(),
    ]);
    setOverview(ov);
    setOpenings(op);
    setMistakes(mi);
    setTactics(ta);
  }

  useEffect(() => {
    void loadAll().finally(() => setLoading(false));
  }, []);

  // When the global background analysis finishes, reload insights so the
  // freshly-populated classifications feed into the accuracy stats.
  useEffect(() => {
    if (prevBgRunning.current && !bgAnalysisRunning) {
      void loadAll();
    }
    prevBgRunning.current = bgAnalysisRunning;
  }, [bgAnalysisRunning]);

  async function handleRefresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }

  function handleAnalyze(): void {
    if (bgAnalysisRunning) return;
    // runBackgroundAnalysis is fire-and-forget: it owns the Stockfish
    // worker pool and reports progress into the global Zustand store,
    // so the yellow top-of-app banner shows "Analyzing 3/12 — ..."
    // across every tab. The useEffect above reloads insights when the
    // run completes.
    runBackgroundAnalysis();
  }

  async function handleSearch(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    // Route through the agent's intent router first so phrases like
    // "review my last Catalan" or "play the KIA against me" open the
    // right surface instead of dumping the user into an empty chat.
    // Only fall back to /coach/chat when the query is genuinely a
    // question (intent === qa) — and in that case carry the query so
    // the chat can auto-send it.
    try {
      const routed = await routeChatIntent(query);
      if (routed?.path) {
        void navigate(routed.path);
        return;
      }
    } catch (err: unknown) {
      console.warn('[GameInsightsPage] intent routing failed:', err);
    }
    void navigate(`/coach/chat?q=${encodeURIComponent(query)}`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12" data-testid="insights-loading">
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Analysing your games...</span>
      </div>
    );
  }

  const totalGames = overview?.totalGames ?? 0;

  return (
    <motion.div
      className="flex flex-col h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      data-testid="game-insights-page"
    >
      {/* Fixed header */}
      <div className="px-5 pt-5 pb-0 shrink-0">
        {/* Title row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => void navigate('/coach')}
              className="p-1.5 rounded-lg hover:opacity-80"
              data-testid="back-btn"
            >
              <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
            </button>
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>Game Insights</h2>
              <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {totalGames} game{totalGames !== 1 ? 's' : ''} analysed
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <ImportGamesButton variant="compact" />
            <button
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="p-2 rounded-lg hover:opacity-80 disabled:opacity-40"
              data-testid="refresh-btn"
            >
              <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>
        </div>

        {/* Search bar */}
        <form onSubmit={(e) => { void handleSearch(e); }} className="mb-3">
          <div
            className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 border"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          >
            <Search size={14} style={{ color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ask about your games..."
              className="flex-1 bg-transparent border-none outline-none text-sm"
              style={{ color: 'var(--color-text)' }}
              data-testid="search-input"
            />
            <div
              className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md"
              style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
            >
              <Sparkles size={10} />
              AI
            </div>
          </div>
        </form>

        {/* Empty-state CTA — no games imported yet. Drops a prominent
            import button right under the search bar so the user has
            a one-tap path forward instead of staring at zeros. */}
        {overview !== null && overview.totalGames === 0 && (
          <div
            className="flex flex-col items-center gap-2 py-4 border-b text-center"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No games analysed yet. Import some games to see stats, mistakes,
              and weaknesses.
            </p>
            <ImportGamesButton variant="primary" />
          </div>
        )}

        {/* Summary stats */}
        {overview && overview.totalGames > 0 && (
          <div
            className="flex justify-between py-3 border-b"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <SummaryItem value={`${overview.totalGames}`} label="Games" />
            <SummaryItem value={`${overview.winRate}%`} label="Win Rate" color="var(--color-success)" />
            <SummaryItem value={`${overview.avgElo}`} label="Avg ELO" />
            <SummaryItem value={`${overview.avgAccuracy}%`} label="Accuracy" color="var(--color-warning)" />
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 py-2">
          {TABS.map((t) => {
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex-1 text-center py-2.5 px-2 text-sm font-semibold rounded-lg transition-all"
                style={{
                  color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  border: isActive ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
                  background: isActive ? 'color-mix(in srgb, var(--color-accent) 8%, var(--color-surface))' : 'transparent',
                  boxShadow: isActive ? '0 0 8px color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'none',
                }}
                data-testid={`tab-${t.id}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6">
        {tab === 'overview' && overview && (
          <>
            {/* Shareable "Your Chess, In A Nutshell" cards — the
                launch-critical growth surface. Hidden when the user
                has too few games for honest insights. */}
            <ShareableInsightsStrip />
            <OverviewTab
              data={overview}
              onAnalyze={handleAnalyze}
              isAnalyzing={bgAnalysisRunning}
              analysisLabel={bgAnalysisProgress}
            />
          </>
        )}
        {tab === 'openings' && openings && <OpeningsTab data={openings} />}
        {tab === 'mistakes' && mistakes && <MistakesTab data={mistakes} />}
        {tab === 'tactics' && tactics && <TacticsTab data={tactics} />}
      </div>
    </motion.div>
  );
}

function SummaryItem({ value, label, color }: { value: string; label: string; color?: string }): JSX.Element {
  return (
    <div className="text-center flex-1">
      <div className="text-xl font-bold" style={{ color: color ?? 'var(--color-text)' }}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}
