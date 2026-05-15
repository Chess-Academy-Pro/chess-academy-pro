import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Target, TrendingUp, AlertCircle, ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { decryptApiKey } from '../../services/cryptoService';
import {
  fetchPuzzleDashboard,
  fetchPuzzleActivity,
  getWeakestThemesFromDashboard,
  formatThemeName,
} from '../../services/lichessPuzzleService';
import { logAppAudit } from '../../services/appAuditor';
import type { LichessPuzzleDashboard, LichessPuzzleActivityEntry } from '../../types';

export function LichessDashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<LichessPuzzleDashboard | null>(null);
  const [activity, setActivity] = useState<LichessPuzzleActivityEntry[]>([]);
  const [days, setDays] = useState(30);

  const tokenEncrypted = activeProfile?.preferences.lichessTokenEncrypted;
  const tokenIv = activeProfile?.preferences.lichessTokenIv;
  const hasToken = Boolean(tokenEncrypted && tokenIv);

  // Mount audit — observability for the audit stream. Includes
  // the token-present flag so the audit-stream can distinguish
  // empty-token-CTA hits from authenticated dashboard hits.
  useEffect(() => {
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'LichessDashboardPage.mount',
      summary: hasToken ? 'lichess dashboard opened (token present)' : 'lichess dashboard opened (no token)',
      details: JSON.stringify({ hasToken }),
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async (): Promise<void> => {
    if (!tokenEncrypted || !tokenIv) return;
    setLoading(true);
    setError(null);
    try {
      const token = await decryptApiKey(tokenEncrypted, tokenIv);
      const [dash, acts] = await Promise.all([
        fetchPuzzleDashboard(token, days),
        fetchPuzzleActivity(token, 100),
      ]);
      setDashboard(dash);
      setActivity(acts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Lichess data');
    } finally {
      setLoading(false);
    }
  }, [tokenEncrypted, tokenIv, days]);

  useEffect(() => {
    if (hasToken) {
      void loadData();
    }
  }, [hasToken, loadData]);

  const handleTrainWeaknesses = (): void => {
    if (!dashboard) return;
    const weakThemes = getWeakestThemesFromDashboard(dashboard, 5);
    void navigate('/tactics/adaptive', { state: { forcedWeakThemes: weakThemes } });
  };

  if (!hasToken) {
    return (
      <div className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="lichess-dashboard-no-token">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/tactics')}
            className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
            aria-label="Back to Tactics"
            data-testid="back-btn"
          >
            <ArrowLeft size={18} className="text-theme-text" />
          </button>
          <h1 className="text-xl font-bold text-theme-text">Lichess Dashboard</h1>
        </div>
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <AlertCircle size={40} className="text-theme-text-muted" />
          <div>
            <p className="text-theme-text font-medium">No Lichess token found</p>
            <p className="text-sm text-theme-text-muted mt-1">
              Add a personal API token in Settings to view your puzzle dashboard.
            </p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-theme-accent text-white"
          >
            Go to Settings
            <ExternalLink size={13} />
          </Link>
          <a
            href="https://lichess.org/account/oauth/token/create?scopes[]=puzzle:read&description=Chess+Academy+Pro"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-theme-text-muted underline"
          >
            Create a token at lichess.org
          </a>
        </div>
      </div>
    );
  }

  const totalActivity = activity.length;
  const activityWins = activity.filter((a) => a.win).length;
  const activityWinRate = totalActivity > 0 ? Math.round((activityWins / totalActivity) * 100) : 0;

  const globalWinRate = dashboard
    ? dashboard.global.nb > 0
      ? Math.round((dashboard.global.firstWins / dashboard.global.nb) * 100)
      : 0
    : 0;

  const weakThemes = dashboard ? getWeakestThemesFromDashboard(dashboard, 5) : [];

  const sortedThemes = dashboard
    ? Object.entries(dashboard.themes)
        .filter(([, data]) => data.results.nb >= 1)
        .map(([theme, data]) => ({
          theme,
          nb: data.results.nb,
          firstWins: data.results.firstWins,
          winRate: data.results.nb > 0 ? data.results.firstWins / data.results.nb : 0,
        }))
        .sort((a, b) => a.winRate - b.winRate)
    : [];

  return (
    <div className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="lichess-dashboard-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void navigate('/tactics')}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          aria-label="Back to Tactics"
          data-testid="back-btn"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <h1 className="text-xl font-bold text-theme-text">Lichess Dashboard</h1>
        <div className="flex-1" />
        {/* Days selector */}
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-2 py-1 rounded-lg border text-xs text-theme-text bg-theme-surface border-theme-border"
          aria-label="Time range"
          data-testid="days-select"
        >
          {[7, 14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>Last {d}d</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12" data-testid="dashboard-loading">
          <Loader2 size={24} className="animate-spin text-theme-text-muted" />
        </div>
      )}

      {error && (
        <div className="p-4 rounded-lg" style={{ background: 'var(--color-error, #ef4444)10', border: '1px solid var(--color-error, #ef4444)20' }} data-testid="dashboard-error">
          <p className="text-sm" style={{ color: 'var(--color-error)' }}>{error}</p>
          <button
            onClick={() => void loadData()}
            className="mt-2 text-xs underline" style={{ color: 'var(--color-error)' }}
          >
            Retry
          </button>
        </div>
      )}

      {dashboard && !loading && (
        <>
          {/* Overall stats */}
          <div className="grid grid-cols-3 gap-3" data-testid="dashboard-stats">
            <div className="p-3 rounded-lg bg-theme-surface border border-theme-border text-center">
              <div className="text-lg font-bold text-theme-text">{dashboard.global.nb}</div>
              <div className="text-xs text-theme-text-muted">Puzzles</div>
            </div>
            <div className="p-3 rounded-lg bg-theme-surface border border-theme-border text-center">
              <div className="text-lg font-bold text-theme-text">{globalWinRate}%</div>
              <div className="text-xs text-theme-text-muted">Win Rate</div>
            </div>
            <div className="p-3 rounded-lg bg-theme-surface border border-theme-border text-center">
              <div className="text-lg font-bold text-theme-text">{activityWinRate}%</div>
              <div className="text-xs text-theme-text-muted">Recent ({totalActivity})</div>
            </div>
          </div>

          {/* Train Weaknesses button */}
          {weakThemes.length > 0 && (
            <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-3" data-testid="train-weaknesses-card">
              <div className="flex items-center gap-2">
                <Target size={16} className="text-theme-accent" />
                <span className="text-sm font-semibold text-theme-text">Your Weakest Themes</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {weakThemes.map((theme) => (
                  <span
                    key={theme}
                    className="px-2 py-0.5 rounded-full text-xs"
                    style={{ background: 'color-mix(in srgb, var(--color-error) 10%, transparent)', color: 'var(--color-error)', border: '1px solid color-mix(in srgb, var(--color-error) 20%, transparent)' }}
                  >
                    {formatThemeName(theme)}
                  </span>
                ))}
              </div>
              <button
                onClick={handleTrainWeaknesses}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-theme-accent text-white hover:opacity-90 transition-opacity"
                data-testid="train-weaknesses-btn"
              >
                Train Weaknesses
              </button>
            </div>
          )}

          {/* Theme breakdown */}
          {sortedThemes.length === 0 && (
            <div className="text-center py-8 text-theme-text-muted" data-testid="no-themes">
              <p className="text-sm">No theme data yet. Solve more puzzles on Lichess to see your breakdown.</p>
            </div>
          )}
          {sortedThemes.length > 0 && (
            <div className="space-y-2" data-testid="theme-breakdown">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-theme-accent" />
                <h2 className="text-sm font-semibold text-theme-text">Theme Breakdown</h2>
                <span className="text-xs text-theme-text-muted">({sortedThemes.length} themes)</span>
              </div>
              <div className="space-y-1.5">
                {sortedThemes.map(({ theme, nb, firstWins, winRate }) => {
                  const pct = Math.round(winRate * 100);
                  const isWeak = weakThemes.includes(theme);
                  return (
                    <div
                      key={theme}
                      className="flex items-center gap-3 p-2 rounded-lg bg-theme-surface border border-theme-border"
                      data-testid={`theme-row-${theme}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-theme-text truncate">
                            {formatThemeName(theme)}
                          </span>
                          {isWeak && (
                            <span className="text-xs shrink-0" style={{ color: 'var(--color-error)' }}>weak</span>
                          )}
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-theme-border overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, background: pct >= 70 ? 'var(--color-success)' : pct >= 50 ? 'var(--color-warning)' : 'var(--color-error)' }}
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-bold text-theme-text">{pct}%</div>
                        <div className="text-xs text-theme-text-muted">
                          {firstWins}/{nb}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
