import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { MistakePuzzleBoard } from './MistakePuzzleBoard';
import {
  getAllMistakePuzzles,
  getMistakePuzzleStats,
  gradeMistakePuzzle,
  deleteMistakePuzzle,
  reanalyzeImportedGames,
  type MistakePuzzleStats,
  type ReanalysisProgress,
} from '../../services/mistakePuzzleService';
import { ArrowLeft, Trash2, AlertTriangle, Trophy, CheckCircle, CircleDot, RefreshCw, BookOpen, Swords, Crown } from 'lucide-react';
import { logAppAudit } from '../../services/appAuditor';
import type { MistakePuzzle, MistakeClassification, MistakePuzzleSourceMode, MistakePuzzleStatus, MistakeGamePhase } from '../../types';

type ClassificationFilter = MistakeClassification | 'all';
type SourceFilter = MistakePuzzleSourceMode | 'all';
type StatusFilter = MistakePuzzleStatus | 'all';

const CLASSIFICATION_COLORS: Record<MistakeClassification, string> = {
  inaccuracy: 'text-yellow-500 bg-yellow-500/10',
  mistake: 'text-orange-500 bg-orange-500/10',
  blunder: 'text-red-500 bg-red-500/10',
  miss: 'text-purple-500 bg-purple-500/10',
};

const CLASSIFICATION_SYMBOLS: Record<MistakeClassification, string> = {
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  miss: '✕',
};

const SOURCE_LABELS: Record<MistakePuzzleSourceMode, string> = {
  coach: 'Coach',
  lichess: 'Lichess',
  chesscom: 'Chess.com',
};

interface PhaseTabConfig {
  phase: MistakeGamePhase | 'all';
  label: string;
  icon: JSX.Element;
  description: string;
}

const PHASE_TABS: PhaseTabConfig[] = [
  { phase: 'all', label: 'All', icon: <AlertTriangle size={16} />, description: 'All mistakes from your games' },
  { phase: 'opening', label: 'Opening', icon: <BookOpen size={16} />, description: 'Development and opening theory mistakes' },
  { phase: 'middlegame', label: 'Middlegame', icon: <Swords size={16} />, description: 'Tactical and positional errors' },
  { phase: 'endgame', label: 'Endgame', icon: <Crown size={16} />, description: 'Conversion and technique mistakes' },
];

interface MistakesPageLocationState {
  initialPhase?: MistakeGamePhase;
  initialClassification?: MistakeClassification;
  initialStatus?: MistakePuzzleStatus;
  initialOpeningName?: string;
}

export function MyMistakesPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navState = (location.state ?? {}) as MistakesPageLocationState;
  // Rolodex deep-link URL fallback (WO-ROLODEX-PLUMBING-01 item 4).
  // The legacy entry path passes `initialOpeningName` via
  // `location.state` (in-app navigation only); the rolodex deep-link
  // `/tactics/mistakes?opening=<name>` is also accepted by reading
  // the URL param. State wins when both are present (in-app links
  // can carry more context).
  const urlOpeningParam = (searchParams.get('opening') ?? '').trim();
  const initialOpeningFromUrlOrState = navState.initialOpeningName ?? (urlOpeningParam.length > 0 ? urlOpeningParam : null);
  const [puzzles, setPuzzles] = useState<MistakePuzzle[]>([]);
  const [stats, setStats] = useState<MistakePuzzleStats | null>(null);
  const [activePuzzle, setActivePuzzle] = useState<MistakePuzzle | null>(null);
  const [phaseTab, setPhaseTab] = useState<MistakeGamePhase | 'all'>(navState.initialPhase ?? 'all');
  const [classFilter, setClassFilter] = useState<ClassificationFilter>(navState.initialClassification ?? 'all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(navState.initialStatus ?? 'all');
  const [openingFilter, setOpeningFilter] = useState<string | null>(initialOpeningFromUrlOrState);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<ReanalysisProgress | null>(null);

  // Mount audit — adds observability so the audit-stream can see
  // when the user opens the mistakes browser. Was zero-coverage
  // before this commit.
  useEffect(() => {
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'MyMistakesPage.mount',
      summary: 'mistakes browser opened',
      details: JSON.stringify({
        initialPhase: navState.initialPhase ?? 'all',
        initialClassification: navState.initialClassification ?? 'all',
      }),
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async () => {
    const [allPuzzles, puzzleStats] = await Promise.all([
      getAllMistakePuzzles(),
      getMistakePuzzleStats(),
    ]);
    setPuzzles(allPuzzles);
    setStats(puzzleStats);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filtered = puzzles.filter((p) => {
    if (phaseTab !== 'all' && p.gamePhase !== phaseTab) return false;
    if (classFilter !== 'all' && p.classification !== classFilter) return false;
    if (sourceFilter !== 'all' && p.sourceMode !== sourceFilter) return false;
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (openingFilter !== null && p.openingName !== openingFilter) return false;
    return true;
  }).sort((a, b) => {
    // Newest games first; games older than 1 year sink to the bottom
    const now = Date.now();
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    const dateA = a.gameDate ? new Date(a.gameDate).getTime() : new Date(a.createdAt).getTime();
    const dateB = b.gameDate ? new Date(b.gameDate).getTime() : new Date(b.createdAt).getTime();
    const oldA = (now - dateA) > oneYear;
    const oldB = (now - dateB) > oneYear;
    if (oldA !== oldB) return oldA ? 1 : -1;
    return dateB - dateA;
  });

  const handleDelete = useCallback(async (id: string) => {
    await deleteMistakePuzzle(id);
    if (activePuzzle?.id === id) setActivePuzzle(null);
    void loadData();
  }, [activePuzzle, loadData]);

  const handlePuzzleComplete = useCallback((correct: boolean): void => {
    if (!activePuzzle) return;
    void gradeMistakePuzzle(activePuzzle.id, correct ? 'good' : 'again', correct).then(() => {
      setActivePuzzle(null);
      void loadData();
    });
  }, [activePuzzle, loadData]);

  const handleReanalyze = useCallback(async () => {
    setAnalyzing(true);
    setAnalysisProgress(null);
    const lastProgressRef: { current: ReanalysisProgress | null } = { current: null };
    try {
      await reanalyzeImportedGames((progress) => {
        lastProgressRef.current = progress;
        setAnalysisProgress(progress);
      });
      await loadData();
    } finally {
      setAnalyzing(false);
      // Preserve a terminal warning (e.g. "set your chess.com
      // username...") so the user can read it after the progress
      // bar disappears. Clear everything else.
      const final = lastProgressRef.current;
      if (final && final.warning) {
        setAnalysisProgress(final);
      } else {
        setAnalysisProgress(null);
      }
    }
  }, [loadData]);

  const getPhaseCount = (phase: MistakeGamePhase | 'all'): number => {
    if (!stats) return 0;
    if (phase === 'all') return stats.total;
    return stats.byPhase[phase];
  };

  if (loading) {
    return (
      <div className="p-6 text-center text-theme-text-muted" data-testid="loading">
        Loading mistakes...
      </div>
    );
  }

  // Solving mode
  if (activePuzzle) {
    return (
      <div className="p-4 max-w-xl mx-auto space-y-4" data-testid="solving-mode">
        <button
          onClick={() => setActivePuzzle(null)}
          className="flex items-center gap-1 text-sm text-theme-text-muted hover:text-theme-text"
        >
          <ArrowLeft size={16} />
          Back to list
        </button>
        <MistakePuzzleBoard
          puzzle={activePuzzle}
          onComplete={handlePuzzleComplete}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto" data-testid="my-mistakes-page">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => void navigate('/tactics')}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          aria-label="Back to puzzles"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <h1 className="text-xl font-bold text-theme-text flex-1">My Mistakes</h1>
        <button
          onClick={() => void handleReanalyze()}
          disabled={analyzing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-theme-accent/10 text-theme-accent hover:bg-theme-accent/20 disabled:opacity-50 transition-colors"
          data-testid="reanalyze-button"
        >
          <RefreshCw size={14} className={analyzing ? 'animate-spin' : ''} />
          {analyzing ? 'Analyzing...' : 'Re-analyze Games'}
        </button>
      </div>

      {/* Analysis progress */}
      {analyzing && analysisProgress && (
        <div className="p-3 rounded-lg bg-theme-surface border border-theme-border mb-4" data-testid="analysis-progress">
          <div className="flex justify-between text-xs text-theme-text-muted mb-1.5">
            <span>Analyzing game {analysisProgress.current} of {analysisProgress.total}</span>
            <span>{analysisProgress.puzzlesFound} mistakes found</span>
          </div>
          <div className="h-1.5 rounded-full bg-theme-border overflow-hidden">
            <div
              className="h-full rounded-full bg-theme-accent transition-all duration-300"
              style={{ width: `${(analysisProgress.current / Math.max(analysisProgress.total, 1)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Username-missing warning — surfaces the specific reason the
          analysis couldn't produce puzzles rather than silently ending
          with zero results. */}
      {analysisProgress?.warning && (
        <div
          className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-400 text-xs mb-4"
          data-testid="analysis-warning"
        >
          {analysisProgress.warning}
        </div>
      )}

      {/* Stats bar */}
      {stats && stats.total > 0 && (
        <div className="flex gap-4 text-sm mb-4" data-testid="stats-bar">
          <div className="flex items-center gap-1 text-theme-text-muted">
            <AlertTriangle size={14} />
            <span>{stats.total} total</span>
          </div>
          <div className="flex items-center gap-1 text-orange-500">
            <CircleDot size={14} />
            <span>{stats.unsolved} unsolved</span>
          </div>
          <div className="flex items-center gap-1 text-blue-500">
            <CheckCircle size={14} />
            <span>{stats.solved} solved</span>
          </div>
          <div className="flex items-center gap-1 text-green-500">
            <Trophy size={14} />
            <span>{stats.mastered} mastered</span>
          </div>
        </div>
      )}

      {/* Phase tabs */}
      <div className="grid grid-cols-4 gap-2 mb-4" data-testid="phase-tabs">
        {PHASE_TABS.map((tab) => {
          const count = getPhaseCount(tab.phase);
          const isActive = phaseTab === tab.phase;
          return (
            <button
              key={tab.phase}
              onClick={() => setPhaseTab(tab.phase)}
              className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                isActive
                  ? 'bg-theme-accent/10 border-theme-accent text-theme-accent'
                  : 'bg-theme-surface border-theme-border text-theme-text-muted hover:border-theme-accent/30'
              }`}
              data-testid={`phase-tab-${tab.phase}`}
            >
              {tab.icon}
              <span className="text-xs font-semibold">{tab.label}</span>
              <span className="text-[10px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Phase description */}
      {phaseTab !== 'all' && (
        <p className="text-xs text-theme-text-muted mb-3" data-testid="phase-description">
          {PHASE_TABS.find((t) => t.phase === phaseTab)?.description}
        </p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4" data-testid="filters">
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value as ClassificationFilter)}
          className="text-xs px-2 py-1 rounded bg-theme-surface text-theme-text border border-theme-border"
          data-testid="classification-filter"
        >
          <option value="all">All Types</option>
          <option value="inaccuracy">Inaccuracies</option>
          <option value="mistake">Mistakes</option>
          <option value="blunder">Blunders</option>
          <option value="miss">Misses</option>
        </select>

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className="text-xs px-2 py-1 rounded bg-theme-surface text-theme-text border border-theme-border"
          data-testid="source-filter"
        >
          <option value="all">All Sources</option>
          <option value="coach">Coach</option>
          <option value="lichess">Lichess</option>
          <option value="chesscom">Chess.com</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="text-xs px-2 py-1 rounded bg-theme-surface text-theme-text border border-theme-border"
          data-testid="status-filter"
        >
          <option value="all">All Status</option>
          <option value="unsolved">Unsolved</option>
          <option value="solved">Solved</option>
          <option value="mastered">Mastered</option>
        </select>

        {openingFilter !== null && (
          <button
            onClick={() => setOpeningFilter(null)}
            className="text-xs px-2 py-1 rounded font-medium flex items-center gap-1"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            data-testid="opening-filter-badge"
          >
            {openingFilter} &times;
          </button>
        )}
      </div>

      {/* Empty state */}
      {puzzles.length === 0 && (
        <div className="text-center py-12 text-theme-text-muted flex flex-col items-center gap-4" data-testid="empty-state">
          <AlertTriangle size={48} className="mx-auto opacity-30" />
          <p className="text-lg font-medium">No mistakes yet</p>
          <p className="text-sm">
            Import games to review your in-game mistakes and generate practice puzzles.
          </p>
          <button
            onClick={() => void navigate('/games/import')}
            className="px-5 py-2.5 rounded-xl font-semibold text-sm bg-red-500 text-white hover:opacity-90 transition-opacity"
          >
            Import Games
          </button>
        </div>
      )}

      {/* Filtered empty state */}
      {puzzles.length > 0 && filtered.length === 0 && (
        <div className="text-center py-8 text-theme-text-muted" data-testid="no-matches">
          <p className="text-sm">No puzzles match your filters.</p>
        </div>
      )}

      {/* Puzzle list */}
      <div className="space-y-2" data-testid="puzzle-list">
        {filtered.map((puzzle) => (
          <div
            key={puzzle.id}
            className="flex items-center gap-3 p-3 rounded-lg bg-theme-surface border border-theme-border hover:border-theme-accent/50 transition-colors"
            data-testid="puzzle-card"
          >
            {/* Classification badge */}
            <span
              className={`inline-flex items-center justify-center w-8 h-8 rounded text-xs font-bold ${CLASSIFICATION_COLORS[puzzle.classification]}`}
            >
              {CLASSIFICATION_SYMBOLS[puzzle.classification]}
            </span>

            {/* Info */}
            <button
              className="flex-1 text-left"
              onClick={() => setActivePuzzle(puzzle)}
              data-testid="solve-button"
            >
              <div className="text-sm font-medium text-theme-text">
                Move {puzzle.moveNumber} — {puzzle.bestMoveSan}
              </div>
              <div className="flex items-center gap-2 text-xs text-theme-text-muted flex-wrap">
                {puzzle.opponentName && (
                  <>
                    <span>vs {puzzle.opponentName}</span>
                    <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
                  </>
                )}
                <span>{SOURCE_LABELS[puzzle.sourceMode]}</span>
                <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
                <span>{puzzle.cpLoss}cp</span>
                <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
                <span className="capitalize">{puzzle.gamePhase}</span>
                <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
                <span className={
                  puzzle.status === 'mastered' ? 'text-green-500' :
                  puzzle.status === 'solved' ? 'text-blue-500' :
                  'text-theme-text-muted'
                }>
                  {puzzle.status}
                </span>
              </div>
              {puzzle.narration.intro && (
                <p className="text-xs text-theme-text-muted mt-1 line-clamp-1" data-testid="narration-preview">
                  {puzzle.narration.intro}
                </p>
              )}
            </button>

            {/* Delete */}
            <button
              onClick={() => void handleDelete(puzzle.id)}
              className="p-1.5 text-theme-text-muted hover:text-red-500 transition-colors"
              aria-label="Delete puzzle"
              data-testid="delete-button"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
