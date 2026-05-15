import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Target, Crosshair, Shuffle, ChevronRight, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  detectWeaknessThemes,
  generatePersonalizedDrill,
} from '../../services/weaknessAnalyzer';
import { getAllMistakePuzzles } from '../../services/mistakePuzzleService';
import { gradeMistakePuzzle } from '../../services/mistakePuzzleService';
import { MistakePuzzleBoard } from './MistakePuzzleBoard';
import { logAppAudit } from '../../services/appAuditor';
import type { WeaknessTheme, WeaknessDrillItem } from '../../types';

type Phase = 'loading' | 'themes' | 'drilling' | 'summary';

const THEME_COLORS: string[] = [
  'border-red-500/30 bg-red-500/10',
  'border-orange-500/30 bg-orange-500/10',
  'border-amber-500/30 bg-amber-500/10',
  'border-yellow-500/30 bg-yellow-500/10',
  'border-purple-500/30 bg-purple-500/10',
  'border-sky-500/30 bg-sky-500/10',
  'border-teal-500/30 bg-teal-500/10',
  'border-pink-500/30 bg-pink-500/10',
];

const SEVERITY_COLORS: Record<string, string> = {
  high: 'text-red-400',
  medium: 'text-orange-400',
  low: 'text-yellow-400',
};

function getSeverity(avgCpLoss: number): 'high' | 'medium' | 'low' {
  if (avgCpLoss >= 200) return 'high';
  if (avgCpLoss >= 100) return 'medium';
  return 'low';
}

export function WeaknessThemesPage(): JSX.Element {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('loading');
  const [themes, setThemes] = useState<WeaknessTheme[]>([]);
  const [drillItems, setDrillItems] = useState<WeaknessDrillItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const [activeTheme, setActiveTheme] = useState<string | null>(null);
  const [completedSet] = useState(() => new Set<number>());

  // Mount audit — F1-lineage observability for the audit stream.
  useEffect(() => {
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'WeaknessThemesPage.mount',
      summary: 'weakness-themes detection page opened',
    });
  }, []);

  const loadThemes = useCallback(async (): Promise<void> => {
    setPhase('loading');
    const mistakes = await getAllMistakePuzzles();
    const nonMastered = mistakes.filter((m) => m.status !== 'mastered');
    const detected = detectWeaknessThemes(nonMastered);
    setThemes(detected);
    setPhase('themes');
  }, []);

  useEffect(() => {
    void loadThemes();
  }, [loadThemes]);

  const startDrill = useCallback(async (themeFilter?: string): Promise<void> => {
    setPhase('loading');
    const session = await generatePersonalizedDrill(themeFilter, 20);
    setDrillItems(session.drillItems);
    setCurrentIndex(0);
    setSolved(0);
    setFailed(0);
    setActiveTheme(themeFilter ?? null);
    completedSet.clear();

    if (session.drillItems.length === 0) {
      setPhase('summary');
    } else {
      setPhase('drilling');
    }
  }, [completedSet]);

  const handleComplete = useCallback(async (correct: boolean): Promise<void> => {
    const item = drillItems.at(currentIndex);
    if (!item) return;
    if (completedSet.has(currentIndex)) return;
    completedSet.add(currentIndex);

    if (correct) {
      setSolved((s) => s + 1);
    } else {
      setFailed((f) => f + 1);
    }

    const grade = correct ? 'good' : 'again';
    await gradeMistakePuzzle(item.mistakePuzzle.id, grade, correct);
  }, [drillItems, currentIndex, completedSet]);

  const goNext = useCallback((): void => {
    const nextIdx = currentIndex + 1;
    if (nextIdx >= drillItems.length) {
      setPhase('summary');
    } else {
      setCurrentIndex(nextIdx);
    }
  }, [currentIndex, drillItems.length]);

  const currentItem = drillItems.at(currentIndex);
  const total = solved + failed;

  return (
    <div
      className="max-w-2xl mx-auto w-full p-4 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-4 min-h-[80vh]"
      data-testid="weakness-themes-page"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            if (phase === 'drilling') {
              setPhase('themes');
            } else {
              void navigate('/tactics');
            }
          }}
          className="p-2 rounded-lg hover:opacity-80"
          data-testid="back-btn"
        >
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <Crosshair size={24} style={{ color: 'var(--color-error)' }} />
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>
          {phase === 'drilling' ? (activeTheme ?? 'Mixed Training') : 'My Weaknesses'}
        </h1>
      </div>

      {/* Loading */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1" data-testid="loading">
          <p style={{ color: 'var(--color-text-muted)' }}>Analyzing your mistakes...</p>
        </div>
      )}

      {/* Theme List */}
      {phase === 'themes' && (
        <div className="flex flex-col gap-4" data-testid="themes-list">
          {themes.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-4 py-12">
              <AlertTriangle size={40} style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-center" style={{ color: 'var(--color-text-muted)' }}>
                No weakness data yet. Import and analyze some games to see your patterns.
              </p>
              <button
                onClick={() => void navigate('/games/import')}
                className="px-5 py-2.5 rounded-xl font-semibold text-sm"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              >
                Import Games
              </button>
            </div>
          ) : (
            <>
              {/* Mixed Training button */}
              <button
                onClick={() => void startDrill()}
                className="w-full py-5 bg-emerald-500/10 border-emerald-500/30 border-2 rounded-2xl flex items-center justify-center gap-3 hover:opacity-80 transition-all duration-200"
                data-testid="mixed-training-btn"
              >
                <Shuffle size={24} className="text-emerald-400" />
                <span className="text-base font-bold text-emerald-400">
                  Mixed Weakness Training
                </span>
              </button>

              {/* Theme cards */}
              <div className="flex flex-col gap-3">
                {themes.map((theme, index) => {
                  const colorClass = THEME_COLORS[index % THEME_COLORS.length];
                  const severity = getSeverity(theme.avgCentipawnLoss);
                  return (
                    <motion.div
                      key={theme.theme}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={`border-2 rounded-2xl p-4 ${colorClass}`}
                      data-testid={`theme-card-${index}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Target size={18} className={SEVERITY_COLORS[severity]} />
                            <h3
                              className="font-bold text-base"
                              style={{ color: 'var(--color-text)' }}
                            >
                              {theme.theme}
                            </h3>
                          </div>
                          <p
                            className="text-xs mt-1"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            {theme.specificPattern}
                          </p>
                          <div
                            className="flex gap-4 mt-2 text-xs"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            <span>{theme.frequency} mistake{theme.frequency !== 1 ? 's' : ''}</span>
                            <span className={SEVERITY_COLORS[severity]}>
                              avg {theme.avgCentipawnLoss} cp loss
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => void startDrill(theme.theme)}
                          className="flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80"
                          style={{
                            background: 'var(--color-accent)',
                            color: 'var(--color-bg)',
                          }}
                          data-testid={`drill-btn-${index}`}
                        >
                          Practice
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Drilling */}
      {phase === 'drilling' && currentItem && (
        <div className="flex flex-col gap-4" data-testid="drill-view">
          {/* Progress */}
          <div className="flex items-center gap-3">
            <div
              className="flex-1 h-2 rounded-full overflow-hidden"
              style={{ background: 'var(--color-border)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  background: 'var(--color-accent)',
                  width: `${Math.round((currentIndex / drillItems.length) * 100)}%`,
                }}
              />
            </div>
            <span
              className="text-xs font-medium"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {currentIndex + 1}/{drillItems.length}
            </span>
          </div>

          {/* Theme badge */}
          <div className="flex items-center gap-2">
            <span
              className="text-xs px-2 py-1 rounded-full font-medium"
              style={{
                background: 'color-mix(in srgb, var(--color-error) 15%, transparent)',
                color: 'var(--color-error)',
              }}
            >
              {currentItem.themeKey}
            </span>
            {currentItem.mistakePuzzle.openingName && (
              <span
                className="text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {currentItem.mistakePuzzle.openingName}
              </span>
            )}
          </div>

          {/* Board */}
          <MistakePuzzleBoard
            key={currentItem.mistakePuzzle.id}
            puzzle={currentItem.mistakePuzzle}
            onComplete={(correct) => void handleComplete(correct)}
          />

          {/* Next button */}
          <div className="flex justify-center">
            <button
              onClick={goNext}
              className="px-6 py-2.5 rounded-xl font-semibold text-sm"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-bg)',
              }}
              data-testid="next-btn"
            >
              {currentIndex + 1 >= drillItems.length ? 'Finish' : 'Next'}
            </button>
          </div>

          {/* Stats */}
          <div
            className="flex justify-center gap-6 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <span style={{ color: 'var(--color-success)' }}>{solved} solved</span>
            <span style={{ color: 'var(--color-error)' }}>{failed} missed</span>
          </div>
        </div>
      )}

      {/* Summary */}
      {phase === 'summary' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center flex-1 gap-6"
          data-testid="session-summary"
        >
          <div className="text-center">
            <h2
              className="text-2xl font-bold"
              style={{ color: 'var(--color-text)' }}
            >
              {total > 0 ? 'Drill Complete' : 'No Drills Available'}
            </h2>
            {total > 0 ? (
              <p
                className="text-lg mt-2"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {solved}/{total} solved ({Math.round((solved / total) * 100)}%)
              </p>
            ) : (
              <p
                className="text-sm mt-2"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {activeTheme
                  ? `No unsolved mistakes for "${activeTheme}". Try another theme!`
                  : 'Import and analyze some games to get personalized drills.'}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => void loadThemes()}
              className="px-6 py-3 rounded-xl font-semibold text-sm"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-bg)',
              }}
              data-testid="back-to-themes"
            >
              Back to Themes
            </button>
            <button
              onClick={() => void navigate('/tactics')}
              className="px-6 py-3 rounded-xl font-semibold text-sm border"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text)',
              }}
            >
              Back to Tactics
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
