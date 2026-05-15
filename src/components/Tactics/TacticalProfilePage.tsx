import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, RefreshCw, Play, Eye, ChevronRight } from 'lucide-react';
import { getThemeSkills, THEME_MAP } from '../../services/puzzleService';
import type { ThemeSkill } from '../../services/puzzleService';
import { logAppAudit } from '../../services/appAuditor';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ThemeCategoryStats {
  name: string;
  accuracy: number;
  attempts: number;
  themes: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const THEME_ICONS: Record<string, string> = {
  'Forks': '\u2694\uFE0F',
  'Pins & Skewers': '\uD83D\uDCCC',
  'Discovered Attacks': '\uD83D\uDCA5',
  'Back Rank Mates': '\uD83C\uDFF0',
  'Sacrifices': '\uD83D\uDD25',
  'Deflection & Decoy': '\u21AA\uFE0F',
  'Zugzwang': '\u26A1',
  'Endgame Technique': '\uD83C\uDFC1',
  'Opening Traps': '\uD83E\uDEA4',
  'Mating Nets': '\uD83D\uDC51',
};

function buildCategoryStats(skills: ThemeSkill[]): ThemeCategoryStats[] {
  const skillMap = new Map(skills.map((s) => [s.theme, s]));

  return Object.entries(THEME_MAP).map(([name, themes]) => {
    let totalAttempts = 0;
    let totalCorrect = 0;

    for (const theme of themes) {
      const skill = skillMap.get(theme);
      if (skill) {
        totalAttempts += skill.attempts;
        totalCorrect += Math.round(skill.accuracy * skill.attempts);
      }
    }

    return {
      name,
      accuracy: totalAttempts > 0 ? totalCorrect / totalAttempts : -1,
      attempts: totalAttempts,
      themes,
    };
  });
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TacticalProfilePage(): JSX.Element {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<ThemeCategoryStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadProfile = useCallback(async (): Promise<void> => {
    const skills = await getThemeSkills();
    setCategories(buildCategoryStats(skills));
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadProfile().finally(() => {
      setLoading(false);
      void logAppAudit({
        kind: 'tactics-surface-event',
        category: 'subsystem',
        source: 'TacticalProfilePage.mount',
        summary: 'tactical profile loaded',
      });
    });
  }, [loadProfile]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadProfile();
    setRefreshing(false);
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'TacticalProfilePage.refresh',
      summary: 'manual refresh',
    });
  }, [loadProfile]);

  const totalAttempts = categories.reduce((sum, c) => sum + c.attempts, 0);
  const attempted = categories.filter((c) => c.attempts > 0);
  const weakest = [...categories]
    .filter((c) => c.attempts > 0)
    .sort((a, b) => a.accuracy - b.accuracy);
  const unattempted = categories.filter((c) => c.attempts === 0);

  const weakestThemes = weakest.length > 0
    ? weakest[0].themes
    : unattempted.length > 0
      ? unattempted[0].themes
      : ['fork'];

  const header = (
    <div className="flex items-center gap-3">
      <button onClick={() => void navigate('/tactics')} className="p-2 rounded-lg hover:opacity-80" data-testid="back-btn">
        <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
      </button>
      <Eye size={24} style={{ color: 'var(--color-accent)' }} />
      <h1 className="text-xl font-bold flex-1" style={{ color: 'var(--color-text)' }}>Tactical Profile</h1>
      <button
        onClick={() => void handleRefresh()}
        disabled={refreshing || loading}
        className="p-2 rounded-lg hover:opacity-80 disabled:opacity-40"
        data-testid="refresh-btn"
      >
        <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} style={{ color: 'var(--color-text-muted)' }} />
      </button>
    </div>
  );

  if (loading) {
    return (
      <div
        className="max-w-2xl mx-auto w-full p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-5"
        data-testid="tactical-profile-page"
      >
        {header}
        <div className="flex items-center justify-center flex-1 min-h-[40vh]" data-testid="loading">
          <p style={{ color: 'var(--color-text-muted)' }}>Loading tactical profile...</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="max-w-2xl mx-auto w-full p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      data-testid="tactical-profile-page"
    >
      {header}

      {/* Begin Training CTA */}
      <button
        onClick={() => void navigate('/tactics/drill', { state: { filterThemes: weakestThemes } })}
        className="w-full py-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-3 transition-opacity hover:opacity-90"
        style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        data-testid="begin-training-btn"
      >
        <Play size={18} />
        Train Your Weakest
        {weakest.length > 0 && (
          <span className="text-xs opacity-80">
            — {weakest[0].name}
          </span>
        )}
      </button>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{totalAttempts}</div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Puzzles Solved</div>
        </div>
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="text-lg font-bold" style={{ color: 'var(--color-success)' }}>
            {attempted.length > 0
              ? `${Math.round(attempted.reduce((sum, c) => sum + c.accuracy * c.attempts, 0) / totalAttempts * 100)}%`
              : '—'}
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Overall Accuracy</div>
        </div>
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{attempted.length}/{categories.length}</div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Themes Practiced</div>
        </div>
      </div>

      {/* Theme Breakdown */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Theme Accuracy
          <span className="font-normal ml-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>tap to drill</span>
        </h3>
        {categories.map((cat) => (
          <ThemeRow
            key={cat.name}
            category={cat}
            onTrain={() => void navigate('/tactics/drill', { state: { filterThemes: cat.themes } })}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ThemeRow({ category, onTrain }: { category: ThemeCategoryStats; onTrain: () => void }): JSX.Element {
  const pct = category.accuracy >= 0 ? Math.round(category.accuracy * 100) : -1;
  const barColor = pct < 0
    ? 'var(--color-border)'
    : pct >= 70
      ? 'var(--color-success)'
      : pct >= 40
        ? 'var(--color-warning)'
        : 'var(--color-error)';

  return (
    <button
      onClick={onTrain}
      className="w-full rounded-lg border p-3 text-left transition-all hover:opacity-90"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      data-testid="theme-row"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">{THEME_ICONS[category.name] ?? '\uD83C\uDFAF'}</span>
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--color-text)' }}>
          {category.name}
        </span>
        {pct >= 0 ? (
          <span className="text-xs font-medium" style={{ color: barColor }}>
            {pct}%
          </span>
        ) : (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            not started
          </span>
        )}
        <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />
      </div>

      {/* Accuracy bar */}
      <div className="h-2 rounded-full overflow-hidden mb-1" style={{ background: 'var(--color-border)' }}>
        {pct >= 0 && (
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ background: barColor, width: `${pct}%` }}
          />
        )}
      </div>

      {category.attempts > 0 && (
        <div className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          {category.attempts} attempts
        </div>
      )}
    </button>
  );
}
