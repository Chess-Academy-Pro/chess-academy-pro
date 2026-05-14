import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Sparkles, Calendar, Timer, Target } from 'lucide-react';
import { InsightsDonutChart } from './InsightsDonutChart';
import { InsightsBarChart } from './InsightsBarChart';
import { InsightsStackedBar } from './InsightsStackedBar';
import { StrengthsCard } from './StrengthsCard';
import { ActivityHeatmap } from './ActivityHeatmap';
import {
  activityHeatmap,
  timeControlPerformance,
  criticalMomentsAccuracy,
  type ActivityHeatmapData,
  type TimeControlRow,
  type CriticalMomentsStats,
  type TimeControlBucket,
} from '../../services/analyticsService';
import { encodeFilters, type StatFilter } from '../../services/gameFilterService';
import type { OverviewInsights } from '../../types';

function openDrilldown(navigate: ReturnType<typeof useNavigate>, filters: StatFilter[]): void {
  void navigate(`/weaknesses/games?f=${encodeFilters(filters)}`);
}

const TIME_CONTROL_LABEL: Record<TimeControlBucket, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Daily',
  unknown: 'Other',
};

const TIME_CONTROL_COLOR: Record<TimeControlBucket, string> = {
  bullet: '#ef4444',
  blitz: '#f97316',
  rapid: '#22c55e',
  classical: '#6366f1',
  correspondence: '#a855f7',
  unknown: 'var(--color-text-muted)',
};

interface OverviewTabProps {
  data: OverviewInsights;
  /** Fired when the user taps "Analyze Now". The page-level handler
   *  starts the global background analysis (see GameInsightsPage). */
  onAnalyze?: () => void;
  /** True while the global background analysis is running. When set,
   *  the CTA button disables and shows a muted progress label; live
   *  counts are rendered by the app-level banner so nothing gets out
   *  of sync when the user navigates to another tab. */
  isAnalyzing?: boolean;
  /** Human-readable progress label from the global store
   *  (e.g. "3/12 — Smith vs Jones"). Displayed inline on the CTA
   *  button so the user sees it without leaving the Insights page. */
  analysisLabel?: string | null;
}

export function OverviewTab({ data, onAnalyze, isAnalyzing, analysisLabel }: OverviewTabProps): JSX.Element {
  const navigate = useNavigate();
  // Lazy-load the analytics views — they're additive and shouldn't
  // block the existing tab's first paint. Each renders once its
  // shape resolves; null until then so the section is hidden.
  const [activity, setActivity] = useState<ActivityHeatmapData | null>(null);
  const [timeControls, setTimeControls] = useState<TimeControlRow[] | null>(null);
  const [criticals, setCriticals] = useState<CriticalMomentsStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      activityHeatmap(),
      timeControlPerformance(),
      criticalMomentsAccuracy(),
    ]).then(([a, tc, cm]) => {
      if (cancelled) return;
      setActivity(a);
      setTimeControls(tc);
      setCriticals(cm);
    }).catch(() => { /* analytics is read-only; failures shouldn't break the tab */ });
    return () => { cancelled = true; };
  }, [data.totalGames]);

  const wldData = [
    { name: 'Wins', value: data.wins, color: 'var(--color-success)' },
    { name: 'Losses', value: data.losses, color: 'var(--color-error)' },
    { name: 'Draws', value: data.draws, color: 'var(--color-text-muted)' },
  ];

  const cc = data.classificationCounts;
  const moveQuality = [
    { label: 'Brilliant', value: cc.brilliant, color: '#22d3ee' },
    { label: 'Great', value: cc.great, color: '#22c55e' },
    { label: 'Good', value: cc.good, color: '#6366f1' },
    { label: 'Book', value: cc.book, color: '#3f3f46' },
    { label: 'Inaccuracy', value: cc.inaccuracy, color: '#f59e0b' },
    { label: 'Mistake', value: cc.mistake, color: '#f97316' },
    { label: 'Blunder', value: cc.blunder, color: '#ef4444' },
  ];

  const phaseColors: Record<string, string> = {
    opening: 'var(--color-success)',
    middlegame: '#f59e0b',
    endgame: '#f97316',
  };

  return (
    <div data-testid="overview-tab">
      {(data.gamesNeedingAnalysis > 0 || isAnalyzing) && (
        <AnalyzeCta
          gamesNeedingAnalysis={data.gamesNeedingAnalysis}
          analyzedGameCount={data.analyzedGameCount}
          onAnalyze={onAnalyze}
          isAnalyzing={isAnalyzing ?? false}
          analysisLabel={analysisLabel ?? null}
        />
      )}

      {/* Results */}
      <Section title="Results">
        <div className="flex items-center gap-5 py-3.5">
          <InsightsDonutChart data={wldData} centerValue={data.totalGames} centerLabel="Games" />
          <div className="flex flex-col gap-1.5 flex-1">
            {wldData.map((d) => (
              <div key={d.name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                {d.name}
                <span className="ml-auto font-semibold" style={{ color: 'var(--color-text)' }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
        <DataRow label="Win rate as White" value={`${data.winRateWhite}%`} />
        <DataRow label="Win rate as Black" value={`${data.winRateBlack}%`} />
        {data.highestBeaten && (
          <DataRow label="Highest rated beaten" value={`${data.highestBeaten.elo}`} color="var(--color-success)" />
        )}
        {data.lowestLostTo && (
          <DataRow label="Lowest rated lost to" value={`${data.lowestLostTo.elo}`} color="var(--color-error)" />
        )}
      </Section>

      {/* Move Quality */}
      <Section title="Move Quality">
        <InsightsStackedBar segments={moveQuality} />
      </Section>

      {/* Per Game Averages */}
      <Section title="Per Game Averages">
        <DataRow label="Accuracy" value={`${data.avgAccuracy}%`} />
        <DataRow label="Moves per game" value={`${data.avgMovesPerGame}`} />
        <DataRow label="Brilliant moves" value={`${data.avgBrilliantsPerGame}`} color="#22d3ee" />
        <DataRow label="Inaccuracies" value={`${data.avgInaccuraciesPerGame}`} color="#f59e0b" />
        <DataRow label="Mistakes" value={`${data.avgMistakesPerGame}`} color="#f97316" />
        <DataRow label="Blunders" value={`${data.avgBlundersPerGame}`} color="var(--color-error)" />
        <DataRow label="Best move agreement" value={`${data.bestMoveAgreement}%`} />
      </Section>

      {/* Accuracy by Phase */}
      {data.phaseAccuracy.length > 0 && (
        <Section title="Accuracy by Phase">
          <InsightsBarChart
            data={data.phaseAccuracy.map((p) => ({
              label: p.phase.charAt(0).toUpperCase() + p.phase.slice(1),
              value: p.accuracy,
              color: phaseColors[p.phase] ?? 'var(--color-accent)',
              suffix: '%',
            }))}
            maxValue={100}
          />
        </Section>
      )}

      {/* Accuracy by Color */}
      <Section title="Accuracy by Color">
        <div className="flex gap-5 py-3.5 justify-center">
          <AccuracyRing value={data.accuracyWhite} label="As White" />
          <AccuracyRing value={data.accuracyBlack} label="As Black" />
        </div>
      </Section>

      <StrengthsCard strengths={data.strengths} />

      {/* Activity heatmap — calendar-grid "your year of chess" view.
          Renders below the existing summary so it doesn't push the
          top-of-page numbers off-screen on mobile. */}
      {activity && activity.totalGames > 0 && (
        <Section title="Activity">
          <div className="flex items-center gap-1.5 -mt-1 mb-2 text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            <Calendar size={11} />
            Last year of chess
          </div>
          <ActivityHeatmap
            data={activity}
            onCellClick={(date, count) => {
              openDrilldown(navigate, [
                { source: 'activity-day', date, label: `${date} (${count})` },
              ]);
            }}
          />
        </Section>
      )}

      {/* Time-control performance — bucket games by PGN [TimeControl]
          header and show win-rate per format. Hidden when only one
          bucket has data (too thin to be a comparison). */}
      {timeControls && timeControls.length > 1 && (
        <Section title="By time control">
          <div className="flex items-center gap-1.5 -mt-1 mb-2 text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            <Timer size={11} />
            Where you play and where you win
          </div>
          {timeControls.map((row) => (
            <button
              key={row.bucket}
              type="button"
              onClick={() => openDrilldown(navigate, [
                { source: 'time-control', bucket: row.bucket, label: `${TIME_CONTROL_LABEL[row.bucket]} (${row.games})` },
              ])}
              className="w-full flex items-center justify-between py-2 border-b text-sm hover:opacity-80 transition-opacity"
              style={{ borderColor: 'color-mix(in srgb, var(--color-border) 50%, transparent)' }}
              data-testid={`time-control-row-${row.bucket}`}
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ background: TIME_CONTROL_COLOR[row.bucket] }} />
                <span style={{ color: 'var(--color-text)' }}>{TIME_CONTROL_LABEL[row.bucket]}</span>
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{row.games} gm</span>
              </div>
              <div className="text-xs flex items-center gap-2 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                <span style={{ color: 'var(--color-success)' }}>{row.winRatePct}%</span>
                {row.avgAccuracyPct !== null && (
                  <>
                    <span>·</span>
                    <span style={{ color: 'var(--color-warning)' }}>{row.avgAccuracyPct}% acc</span>
                  </>
                )}
              </div>
            </button>
          ))}
        </Section>
      )}

      {/* Critical-moments accuracy — single big-stat answer to "what's
          your decision quality on the moves that mattered." */}
      {criticals && criticals.total > 0 && (
        <Section title="Critical moments">
          <div className="flex items-center gap-1.5 -mt-1 mb-2 text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            <Target size={11} />
            Best move found when it mattered most
          </div>
          <div
            className="rounded-xl border p-4 flex items-baseline justify-between"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            data-testid="critical-moments-card"
          >
            <button
              type="button"
              onClick={() => openDrilldown(navigate, [
                { source: 'critical-moments', missed: true, label: `Critical moments missed (${criticals.total - criticals.found})` },
              ])}
              className="flex flex-col text-left hover:opacity-80 transition-opacity"
              aria-label="View games with missed critical moments"
            >
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                Decision quality
              </div>
              <div className="text-3xl font-bold tabular-nums" style={{ color: '#22d3ee' }}>
                {criticals.accuracyPct}%
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {criticals.found} of {criticals.total} critical positions solved
              </div>
            </button>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              {criticals.byPhase.map((p) => (
                <button
                  key={p.phase}
                  type="button"
                  disabled={p.total === 0}
                  onClick={() => openDrilldown(navigate, [
                    { source: 'critical-moments', phase: p.phase, missed: true, label: `Missed in ${p.phase}` },
                  ])}
                  className="text-center hover:opacity-80 transition-opacity disabled:cursor-default disabled:opacity-50"
                >
                  <div className="capitalize" style={{ color: 'var(--color-text-muted)' }}>{p.phase}</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
                    {p.total > 0 ? `${p.accuracyPct}%` : '—'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="pt-4">
      <h3
        className="text-[10px] font-bold uppercase tracking-wider pb-2 border-b"
        style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function DataRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div
      className="flex items-center justify-between py-2 border-b text-sm"
      style={{ borderColor: 'color-mix(in srgb, var(--color-border) 50%, transparent)' }}
    >
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className="font-semibold" style={{ color: color ?? 'var(--color-text)' }}>{value}</span>
    </div>
  );
}

function AnalyzeCta({
  gamesNeedingAnalysis,
  analyzedGameCount,
  onAnalyze,
  isAnalyzing,
  analysisLabel,
}: {
  gamesNeedingAnalysis: number;
  analyzedGameCount: number;
  onAnalyze?: () => void;
  isAnalyzing: boolean;
  analysisLabel: string | null;
}): JSX.Element {
  const totalToProcess = gamesNeedingAnalysis;

  const heading = isAnalyzing
    ? 'Analyzing games in background'
    : analyzedGameCount === 0
      ? `${gamesNeedingAnalysis} game${gamesNeedingAnalysis === 1 ? '' : 's'} not analyzed yet`
      : `${gamesNeedingAnalysis} of ${analyzedGameCount + gamesNeedingAnalysis} games not analyzed`;

  const body = isAnalyzing
    ? 'You can switch tabs — progress continues in the top banner. Stats will update when it finishes.'
    : 'Stockfish needs to score every move before accuracy and move-quality stats can populate. Your data stays on-device.';

  return (
    <div
      className="rounded-xl p-4 mb-2 border"
      style={{
        background: 'color-mix(in srgb, var(--color-warning) 10%, var(--color-surface))',
        borderColor: 'color-mix(in srgb, var(--color-warning) 40%, transparent)',
      }}
      data-testid="analyze-cta"
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 mt-0.5 p-1.5 rounded-lg"
          style={{ background: 'color-mix(in srgb, var(--color-warning) 25%, transparent)' }}
        >
          <Sparkles size={16} style={{ color: 'var(--color-warning)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {heading}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {body}
          </div>
          <button
            onClick={onAnalyze}
            disabled={isAnalyzing || !onAnalyze}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'var(--color-warning)', color: '#000' }}
            data-testid="analyze-now-btn"
          >
            {isAnalyzing ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {analysisLabel ? `Analyzing ${analysisLabel}` : 'Analyzing…'}
              </>
            ) : (
              <>Analyze {totalToProcess === 1 ? 'this game' : `all ${totalToProcess} games`} now</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccuracyRing({ value, label }: { value: number; label: string }): JSX.Element {
  const circumference = 2 * Math.PI * 14;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="text-center" role="img" aria-label={`${label}: ${value}% accuracy`}>
      <div className="relative w-16 h-16">
        <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90" aria-hidden>
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--color-border)" strokeWidth="3" />
          <circle
            cx="18" cy="18" r="14" fill="none"
            stroke={value >= 70 ? 'var(--color-text)' : 'var(--color-text-muted)'}
            strokeWidth="3"
            strokeDasharray={`${circumference}`}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold" style={{ color: 'var(--color-text)' }}>
          {value}%
        </div>
      </div>
      <div className="text-[10px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}
