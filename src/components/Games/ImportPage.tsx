import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { importLichessGames, importLichessStats } from '../../services/lichessService';
import { importChessComGames, importChessComStats } from '../../services/chesscomService';
import { fetchPuzzleActivity, fetchPuzzleDashboard } from '../../services/lichessPuzzleService';
import { decryptApiKey } from '../../services/cryptoService';
import { useAppStore } from '../../stores/appStore';
import { db } from '../../db/schema';
import { ArrowLeft, Loader2, CheckCircle, TrendingUp, Brain, ExternalLink } from 'lucide-react';
import type { PlatformStats, UserProfile } from '../../types';

type Platform = 'lichess' | 'chesscom';

const PLATFORM_LABELS: Record<Platform, string> = {
  chesscom: 'Chess.com',
  lichess: 'Lichess',
};

/**
 * Pick the "primary" rating from platform stats.
 * Prefers rapid > blitz > bullet.
 */
function getPrimaryRating(stats: PlatformStats): number | null {
  if (stats.rapid) return stats.rapid.rating;
  if (stats.blitz) return stats.blitz.rating;
  if (stats.bullet) return stats.bullet.rating;
  return null;
}

export function ImportPage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);

  const [platform, setPlatform] = useState<Platform>('chesscom');
  // Pre-populate the username from the user's profile so they don't
  // re-type it every time. Each platform has its own saved value;
  // switching platforms swaps the input contents below via the
  // `useEffect` that watches platform changes.
  const [username, setUsername] = useState(
    () => activeProfile?.preferences.chessComUsername ?? '',
  );
  // Swap the input when the user toggles platforms — chess.com /
  // lichess usernames are independent fields on the profile, so
  // toggling should reveal the right saved value (or empty if
  // they've never imported from that platform).
  useEffect(() => {
    const saved = platform === 'chesscom'
      ? activeProfile?.preferences.chessComUsername ?? ''
      : activeProfile?.preferences.lichessUsername ?? '';
    setUsername(saved);
  }, [platform, activeProfile?.preferences.chessComUsername, activeProfile?.preferences.lichessUsername]);
  const [importing, setImporting] = useState(false);
  const [progressCount, setProgressCount] = useState(0);
  const [progressStatus, setProgressStatus] = useState('');
  const [gameResult, setGameResult] = useState<number | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Puzzle activity sync state (Lichess only, requires token)
  const [syncingPuzzles, setSyncingPuzzles] = useState(false);
  const [puzzleSyncResult, setPuzzleSyncResult] = useState<{
    total: number;
    wins: number;
    themes: number;
  } | null>(null);
  const [puzzleSyncError, setPuzzleSyncError] = useState<string | null>(null);

  const tokenEncrypted = activeProfile?.preferences.lichessTokenEncrypted;
  const tokenIv = activeProfile?.preferences.lichessTokenIv;
  const hasLichessToken = Boolean(tokenEncrypted && tokenIv);

  const handleProgress = useCallback((count: number, status?: string) => {
    setProgressCount(count);
    if (status) setProgressStatus(status);
  }, []);

  const handleSyncPuzzles = useCallback(async (): Promise<void> => {
    if (!tokenEncrypted || !tokenIv) return;
    setSyncingPuzzles(true);
    setPuzzleSyncResult(null);
    setPuzzleSyncError(null);
    try {
      const token = await decryptApiKey(tokenEncrypted, tokenIv);
      const [activity, dashboard] = await Promise.all([
        fetchPuzzleActivity(token, 100),
        fetchPuzzleDashboard(token, 30),
      ]);
      const wins = activity.filter((a) => a.win).length;
      const themes = Object.keys(dashboard.themes).length;
      setPuzzleSyncResult({ total: activity.length, wins, themes });
    } catch (err) {
      setPuzzleSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncingPuzzles(false);
    }
  }, [tokenEncrypted, tokenIv]);

  const handleImport = async (): Promise<void> => {
    if (!username.trim()) return;
    setImporting(true);
    setProgressCount(0);
    setProgressStatus('Starting import...');
    setGameResult(null);
    setStats(null);
    setError(null);

    try {
      // Import games
      const count = platform === 'lichess'
        ? await importLichessGames(username, handleProgress)
        : await importChessComGames(username, handleProgress);

      setGameResult(count);

      // Import stats
      setProgressStatus('Fetching player stats...');
      let platformStats: PlatformStats | null = null;
      try {
        platformStats = platform === 'lichess'
          ? await importLichessStats(username)
          : await importChessComStats(username);
        setStats(platformStats);
      } catch {
        // Stats are best-effort
      }

      // Save username + update profile
      if (activeProfile) {
        const prefKey = platform === 'chesscom' ? 'chessComUsername' : 'lichessUsername';
        const updates: Partial<UserProfile> = {
          preferences: { ...activeProfile.preferences, [prefKey]: username.trim() },
        };

        if (platformStats) {
          const primaryRating = getPrimaryRating(platformStats);
          if (primaryRating) {
            updates.currentRating = primaryRating;
          }
          if (platformStats.puzzleRating) {
            updates.puzzleRating = platformStats.puzzleRating;
          }
        }

        await db.profiles.update(activeProfile.id, updates);
        const refreshed = await db.profiles.get(activeProfile.id);
        if (refreshed) {
          setActiveProfile(refreshed);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
      setProgressStatus('');
    }
  };

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="import-page"
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => void navigate('/games')}
          className="p-2 rounded-lg hover:opacity-80"
          style={{ background: 'var(--color-surface)' }}
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold">Import Games & Stats</h1>
      </div>

      {/* Platform toggle */}
      <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--color-bg-secondary)' }}>
        {(['chesscom', 'lichess'] as const).map((p) => (
          <button
            key={p}
            onClick={() => {
              setPlatform(p);
              setGameResult(null);
              setStats(null);
              setError(null);
            }}
            className="flex-1 py-2 rounded-md text-sm font-medium"
            style={{
              background: platform === p ? 'var(--color-surface)' : 'transparent',
              color: platform === p ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
            data-testid={`platform-${p}`}
          >
            {PLATFORM_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Username input */}
      <div>
        <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
          {PLATFORM_LABELS[platform]} Username
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleImport();
          }}
          placeholder="Enter username..."
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="username-input"
        />
      </div>

      {/* Import button */}
      <button
        onClick={() => void handleImport()}
        disabled={importing || !username.trim()}
        className="w-full py-3 rounded-lg font-semibold text-sm transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
        style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        data-testid="import-btn"
      >
        {importing ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Importing...
          </>
        ) : (
          'Import Games & Stats'
        )}
      </button>

      {/* Progress */}
      {importing && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {progressStatus}
            </span>
          </div>
          {progressCount > 0 && (
            <p className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
              {progressCount} game{progressCount !== 1 ? 's' : ''} imported so far...
            </p>
          )}
        </div>
      )}

      {/* Game result */}
      {gameResult !== null && (
        <div
          className="flex items-center gap-2 p-3 rounded-lg"
          style={{ background: 'rgba(34,197,94,0.1)' }}
          data-testid="import-result"
        >
          <CheckCircle size={16} style={{ color: 'var(--color-success)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-success)' }}>
            {gameResult === 0
              ? 'No new games to import — you\'re up to date!'
              : `Imported ${gameResult} game${gameResult !== 1 ? 's' : ''}!`
            }
          </span>
        </div>
      )}

      {/* Stats summary */}
      {stats && (
        <div
          className="p-4 rounded-lg space-y-2"
          style={{ background: 'rgba(59,130,246,0.1)' }}
          data-testid="import-stats"
        >
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={16} style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
              Player Stats
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {stats.rapid && (
              <div className="p-2 rounded-md" style={{ background: 'var(--color-surface)' }}>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Rapid</div>
                <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{stats.rapid.rating}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {stats.rapid.wins}W / {stats.rapid.losses}L / {stats.rapid.draws}D
                </div>
              </div>
            )}
            {stats.blitz && (
              <div className="p-2 rounded-md" style={{ background: 'var(--color-surface)' }}>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Blitz</div>
                <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{stats.blitz.rating}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {stats.blitz.wins}W / {stats.blitz.losses}L / {stats.blitz.draws}D
                </div>
              </div>
            )}
            {stats.bullet && (
              <div className="p-2 rounded-md" style={{ background: 'var(--color-surface)' }}>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Bullet</div>
                <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{stats.bullet.rating}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {stats.bullet.wins}W / {stats.bullet.losses}L / {stats.bullet.draws}D
                </div>
              </div>
            )}
            {stats.puzzleRating && (
              <div className="p-2 rounded-md" style={{ background: 'var(--color-surface)' }}>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Puzzles</div>
                <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{stats.puzzleRating}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-sm font-medium text-center" style={{ color: 'var(--color-error)' }} data-testid="import-error">
          {error}
        </p>
      )}

      {/* Lichess Puzzle Sync (only when Lichess platform + token available) */}
      {platform === 'lichess' && (
        <div
          className="p-4 rounded-lg border space-y-3"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          data-testid="puzzle-sync-section"
        >
          <div className="flex items-center gap-2">
            <Brain size={16} style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
              Puzzle Activity
            </span>
          </div>
          {!hasLichessToken ? (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Add a Lichess token in{' '}
              <Link to="/settings" className="underline" style={{ color: 'var(--color-accent)' }}>
                Settings
              </Link>{' '}
              to sync puzzle stats.
            </p>
          ) : (
            <>
              <button
                onClick={() => void handleSyncPuzzles()}
                disabled={syncingPuzzles}
                className="w-full py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="sync-puzzles-btn"
              >
                {syncingPuzzles ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Syncing...
                  </>
                ) : (
                  'Sync Puzzle Stats'
                )}
              </button>

              {puzzleSyncResult && (
                <div className="space-y-1" data-testid="puzzle-sync-result">
                  <div className="flex items-center gap-2">
                    <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />
                    <span className="text-xs font-medium" style={{ color: 'var(--color-success)' }}>
                      {puzzleSyncResult.total} puzzles · {puzzleSyncResult.total > 0 ? Math.round((puzzleSyncResult.wins / puzzleSyncResult.total) * 100) : 0}% win rate · {puzzleSyncResult.themes} themes
                    </span>
                  </div>
                  <Link
                    to="/tactics/lichess"
                    className="flex items-center gap-1 text-xs"
                    style={{ color: 'var(--color-accent)' }}
                    data-testid="view-dashboard-link"
                  >
                    View Full Dashboard
                    <ExternalLink size={11} />
                  </Link>
                </div>
              )}

              {puzzleSyncError && (
                <p className="text-xs" style={{ color: 'var(--color-error)' }} data-testid="puzzle-sync-error">
                  {puzzleSyncError}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
