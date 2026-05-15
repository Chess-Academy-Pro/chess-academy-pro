import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore';
import { getThemeSkills } from '../../services/puzzleService';
import { detectBadHabits } from '../../services/coachFeatureService';
import {
  computeWeaknessProfile,
  getStoredWeaknessProfile,
  filterWeaknessesByCategory,
} from '../../services/weaknessAnalyzer';
import { SkillBar } from '../ui/SkillBar';
import {
  Brain,
  Swords,
  BookOpen,
  Lightbulb,
  Calculator,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import type { BadHabit, WeaknessProfile, WeaknessCategory, WeaknessItem, StrengthItem } from '../../types';
import type { ThemeSkill } from '../../services/puzzleService';

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

const SKILL_META: Record<string, { icon: React.ComponentType<{ size?: number }>; category: WeaknessCategory; description: string }> = {
  opening: { icon: BookOpen, category: 'openings', description: 'Drill accuracy across your repertoire' },
  tactics: { icon: Swords, category: 'tactics', description: 'Puzzle accuracy across tactical themes' },
  endgame: { icon: Lightbulb, category: 'endgame', description: 'Endgame puzzle and pattern accuracy' },
  memory: { icon: Brain, category: 'positional', description: 'Retention from flashcard and drill review' },
  calculation: { icon: Calculator, category: 'calculation', description: 'Move quality from analyzed games' },
};

export function StatsPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const navigate = useNavigate();
  const [themeSkills, setThemeSkills] = useState<ThemeSkill[]>([]);
  const [badHabits, setBadHabits] = useState<BadHabit[]>([]);
  const [weaknessProfile, setWeaknessProfile] = useState<WeaknessProfile | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshProfile = useCallback(async (): Promise<void> => {
    if (!activeProfile) return;
    setRefreshing(true);
    try {
      const wp = await computeWeaknessProfile(activeProfile);
      setWeaknessProfile(wp);
      // Reload profile to pick up updated skillRadar
      const { db } = await import('../../db/schema');
      const updated = await db.profiles.get(activeProfile.id);
      if (updated) setActiveProfile(updated);
    } finally {
      setRefreshing(false);
    }
  }, [activeProfile, setActiveProfile]);

  useEffect(() => {
    void getThemeSkills().then(setThemeSkills);

    if (activeProfile) {
      void detectBadHabits(activeProfile).then(setBadHabits);

      // Load stored weakness profile, recompute if stale
      void getStoredWeaknessProfile().then((stored) => {
        if (stored) {
          const age = Date.now() - new Date(stored.computedAt).getTime();
          if (age < STALE_THRESHOLD_MS) {
            setWeaknessProfile(stored);
            return;
          }
        }
        // Stale or missing — recompute
        void refreshProfile();
      });
    }
  }, [activeProfile, refreshProfile]);

  if (!activeProfile) return <></>;

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="stats-page"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Stats & Progress</h1>
        <button
          onClick={() => void refreshProfile()}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
          data-testid="refresh-btn"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Analyzing...' : 'Refresh'}
        </button>
      </div>

      {/* Header stats row */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Puzzle Rating" value={`${activeProfile.puzzleRating}`} icon={<Brain size={18} />} />
        <StatCard label="Game ELO" value={`${activeProfile.currentRating}`} icon={<Swords size={18} />} />
      </div>

      {/* Skill breakdown with drill-down */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      >
        <div className="p-5 pb-3">
          <h2 className="font-semibold text-lg">Skill Breakdown</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Tap a skill to see details
          </p>
        </div>
        <div className="px-5 pb-5 space-y-1">
          {(Object.entries(activeProfile.skillRadar) as Array<[string, number]>).map(([skill, value]) => {
            const meta = SKILL_META[skill] as typeof SKILL_META[keyof typeof SKILL_META] | undefined;
            const isExpanded = expandedSkill === skill;
            const Icon = meta?.icon ?? Brain;

            return (
              <div key={skill} data-testid={`skill-${skill}`}>
                <button
                  className="w-full flex items-center gap-3 py-2 px-1 rounded-lg transition-colors hover:bg-black/5"
                  onClick={() => setExpandedSkill(isExpanded ? null : skill)}
                  data-testid={`skill-toggle-${skill}`}
                >
                  <Icon size={16} />
                  <div className="flex-1">
                    <SkillBar label={skill} value={value} />
                  </div>
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {isExpanded && meta && weaknessProfile && (
                  <SkillDrillDown
                    skill={skill}
                    description={meta.description}
                    category={meta.category}
                    weaknessProfile={weaknessProfile}
                    themeSkills={skill === 'tactics' ? themeSkills : []}
                    onNavigate={(route, state) => void navigate(route, { state })}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tactical themes */}
      {themeSkills.length > 0 && (
        <div
          className="rounded-xl p-5 border"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          data-testid="tactical-themes"
        >
          <h2 className="font-semibold text-lg mb-3">Tactical Themes</h2>
          <div className="space-y-2">
            {themeSkills.map((skill) => (
              <div key={skill.theme} className="flex items-center gap-2">
                <div className="flex-1">
                  <SkillBar
                    label={skill.theme}
                    value={Math.round(skill.accuracy * 100)}
                  />
                </div>
                <span className="text-xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                  {skill.attempts} tries
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bad habits */}
      {badHabits.length > 0 && (
        <div
          className="rounded-xl p-5 border"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          data-testid="bad-habits"
        >
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} style={{ color: 'var(--color-warning)' }} />
            <h2 className="font-semibold text-lg">Bad Habits</h2>
          </div>
          <div className="space-y-2">
            {badHabits.map((h) => (
              <div key={h.id} className="flex items-center justify-between text-sm" data-testid={`habit-${h.id}`}>
                <span>{h.description}</span>
                {h.isResolved ? (
                  <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: 'var(--color-success)', color: 'var(--color-bg)' }}>
                    Resolved
                  </span>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {h.occurrences}x
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skill Drill-Down ────────────────────────────────────────────────────────

function SkillDrillDown({
  skill,
  description,
  category,
  weaknessProfile,
  themeSkills,
  onNavigate,
}: {
  skill: string;
  description: string;
  category: WeaknessCategory;
  weaknessProfile: WeaknessProfile;
  themeSkills: ThemeSkill[];
  onNavigate: (route: string, state?: Record<string, unknown>) => void;
}): JSX.Element {
  const weaknesses = filterWeaknessesByCategory(weaknessProfile, category);
  const strengths = weaknessProfile.strengthItems.filter((s) => s.category === category);

  return (
    <div
      className="ml-7 mr-1 mb-3 mt-1 rounded-lg p-4 space-y-3 border"
      style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}
      data-testid={`drilldown-${skill}`}
    >
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{description}</p>

      {/* Weaknesses for this category */}
      {weaknesses.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-warning)' }}>
            Needs Work
          </h4>
          {weaknesses.map((w, i) => (
            <WeaknessCard key={i} item={w} onNavigate={onNavigate} />
          ))}
        </div>
      )}

      {/* Tactics: show per-theme breakdown */}
      {skill === 'tactics' && themeSkills.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Per-Theme Accuracy
          </h4>
          {themeSkills.slice(0, 6).map((t) => (
            <div key={t.theme} className="flex items-center justify-between text-xs">
              <span className="capitalize">{t.theme}</span>
              <span style={{ color: t.accuracy < 0.5 ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                {Math.round(t.accuracy * 100)}% ({t.attempts})
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Strengths for this category */}
      {strengths.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-success)' }}>
            Strengths
          </h4>
          {strengths.map((s, i) => (
            <StrengthCard key={i} item={s} />
          ))}
        </div>
      )}

      {weaknesses.length === 0 && strengths.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Not enough data yet. Keep playing and solving puzzles!
        </p>
      )}
    </div>
  );
}

function WeaknessCard({
  item,
  onNavigate,
}: {
  item: WeaknessItem;
  onNavigate: (route: string, state?: Record<string, unknown>) => void;
}): JSX.Element {
  return (
    <div
      className="rounded-lg p-3 border"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{item.label}</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{
            background: item.severity >= 70 ? 'var(--color-error)' : item.severity >= 40 ? 'var(--color-warning)' : 'var(--color-border)',
            color: item.severity >= 40 ? 'var(--color-bg)' : 'var(--color-text)',
          }}
        >
          {item.metric}
        </span>
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>{item.detail}</p>
      {item.trainingAction && (
        <button
          onClick={() => {
            const action = item.trainingAction;
            if (action) onNavigate(action.route, action.state);
          }}
          className="mt-2 text-xs font-medium px-3 py-1 rounded-lg transition-colors"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
          data-testid={`train-${item.category}`}
        >
          {item.trainingAction.buttonLabel}
        </button>
      )}
    </div>
  );
}

function StrengthCard({ item }: { item: StrengthItem }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-xs">
      <div>
        <span className="font-medium">{item.title}</span>
        <span className="ml-2" style={{ color: 'var(--color-text-muted)' }}>{item.metric}</span>
      </div>
    </div>
  );
}

// ─── Shared Components ───────────────────────────────────────────────────────

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }): JSX.Element {
  return (
    <div
      className="rounded-xl p-4 border flex flex-col gap-1"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <div style={{ color: 'var(--color-text-muted)' }}>{icon}</div>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs capitalize" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </div>
    </div>
  );
}
