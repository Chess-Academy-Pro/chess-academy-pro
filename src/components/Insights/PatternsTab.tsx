/**
 * PatternsTab — the "Your Habits" view on /weaknesses.
 *
 * Surfaces the cross-cutting strength/weakness signals from
 * analyticsService.engagementSummary() in a nice readable layout.
 * Engagement-coded: users like seeing their own data, and this tab
 * is the place where the app says "here's what your play looks like
 * from above." Pulls together signals that DON'T fit on a single
 * Overview/Openings/Mistakes/Tactics tab — color-proficiency
 * mismatches, comeback wins, first-try mastery, brilliant
 * distribution, tactic transfer gaps, repeat-of-mistake, streaks.
 *
 * All data is derived (read-only) — no emit sites here. Every row
 * gracefully hides when the underlying sample is too small to be
 * honest.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, TrendingUp, Layers, ArrowDownUp, RotateCw, Star, Repeat, Sparkles, Trophy, Crown, Zap, Clock } from 'lucide-react';
import { engagementSummary, type EngagementSummary } from '../../services/analyticsService';
import { encodeFilters, type StatFilter } from '../../services/gameFilterService';
import { StrengthsCard } from './StrengthsCard';
import { HeatmapGrid, type HeatmapRow } from './HeatmapGrid';
import { accuracyColor, gapColor } from './heatmapScales';

interface PatternsTabProps {
  /** When provided, parent skipped its own load — render the
   *  pre-computed summary. When null, we load on mount. */
  data?: EngagementSummary | null;
}

const MIN_GAMES_FOR_SIGNAL = 5;

export function PatternsTab({ data: provided }: PatternsTabProps = {}): JSX.Element {
  const navigate = useNavigate();
  const [data, setData] = useState<EngagementSummary | null>(provided ?? null);
  const [loading, setLoading] = useState(provided === undefined || provided === null);

  const goToDrilldown = (filters: StatFilter[]): void => {
    void navigate(`/weaknesses/games?f=${encodeFilters(filters)}`);
  };

  useEffect(() => {
    if (provided !== undefined && provided !== null) {
      setData(provided);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void engagementSummary()
      .then((s) => { if (!cancelled) { setData(s); setLoading(false); } })
      .catch(() => { if (!cancelled) { setLoading(false); } });
    return () => { cancelled = true; };
  }, [provided]);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }} data-testid="patterns-loading">
        Reading your habits…
      </div>
    );
  }

  if (!data || data.totalGames < MIN_GAMES_FOR_SIGNAL) {
    return (
      <div className="py-10 text-center" data-testid="patterns-empty">
        <Layers size={28} className="mx-auto mb-3 opacity-50" style={{ color: 'var(--color-text-muted)' }} />
        <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          Not enough games yet
        </div>
        <div className="text-xs mt-2 max-w-xs mx-auto" style={{ color: 'var(--color-text-muted)' }}>
          Patterns surface after about {MIN_GAMES_FOR_SIGNAL} games. Play or import
          more to unlock the habits view.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="patterns-tab" className="flex flex-col gap-4 pt-2">
      <PersonalRecordsCard records={data.records} onDrillRecord={goToDrilldown} />
      <StreaksRow streak={data.streak} />
      <PhaseStrengthHeatmap matrix={data.phaseStrength} onDrillCell={goToDrilldown} />
      <TacticRecognitionHeatmap rows={data.tacticRecognition} onDrillRow={goToDrilldown} />
      <FirstTryCard firstTry={data.firstTry} />
      <ColorMismatchCard mismatch={data.colorMismatch} />
      <ComebackCard comeback={data.comeback} winShape={data.winShape} />
      <WinShapeCard winShape={data.winShape} />
      <TacticBreadthCard breadth={data.breadth} brilliantShape={data.brilliantShape} />
      <RepeatMistakeCard repeats={data.repeatMistake} />

      {/* Reuse the existing StrengthsCard primitive for one-liner
       *  consolidated strengths derived from this tab's signals. */}
      <StrengthsCard strengths={buildStrengthsList(data)} />
    </div>
  );
}

// ─── New cards / heatmaps ──────────────────────────────────────────────

function PersonalRecordsCard({ records, onDrillRecord }: { records: EngagementSummary['records']; onDrillRecord: (filters: StatFilter[]) => void }): JSX.Element {
  const hasAny =
    records.highestBeaten ||
    records.fastestWin ||
    records.longestGame ||
    records.bestAccuracyGame ||
    records.longestWinStreak > 0;
  if (!hasAny) return <></>;
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-records"
    >
      <div className="flex items-center gap-2 mb-3">
        <Crown size={16} style={{ color: '#f59e0b' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Personal records
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(() => {
          const r = records.highestBeaten;
          if (!r) return null;
          return (
            <RecordTile
              label="Highest beaten"
              value={`${r.elo}`}
              sub={r.name}
              color="var(--color-success)"
              onClick={() => onDrillRecord([{
                source: 'game-ids',
                ids: [r.gameId],
                label: `Highest beaten: ${r.name} (${r.elo})`,
              }])}
              icon={<Crown size={11} />}
            />
          );
        })()}
        {(() => {
          const r = records.fastestWin;
          if (!r) return null;
          return (
            <RecordTile
              label="Fastest win"
              value={`${r.moves} moves`}
              sub={`vs ${r.opponent}`}
              color="#22d3ee"
              onClick={() => onDrillRecord([{
                source: 'game-ids',
                ids: [r.gameId],
                label: `Fastest win: ${r.moves} moves vs ${r.opponent}`,
              }])}
              icon={<Zap size={11} />}
            />
          );
        })()}
        {(() => {
          const r = records.longestGame;
          if (!r) return null;
          return (
            <RecordTile
              label="Longest game"
              value={`${r.moves} moves`}
              sub={r.result.toUpperCase()}
              color="#a855f7"
              onClick={() => onDrillRecord([{
                source: 'game-ids',
                ids: [r.gameId],
                label: `Longest game: ${r.moves} moves`,
              }])}
              icon={<Clock size={11} />}
            />
          );
        })()}
        {(() => {
          const r = records.bestAccuracyGame;
          if (!r) return null;
          return (
            <RecordTile
              label="Best accuracy"
              value={`${r.accuracyPct}%`}
              sub={`vs ${r.opponent}`}
              color="var(--color-warning)"
              onClick={() => onDrillRecord([{
                source: 'game-ids',
                ids: [r.gameId],
                label: `Best accuracy: ${r.accuracyPct}% vs ${r.opponent}`,
              }])}
              icon={<Sparkles size={11} />}
            />
          );
        })()}
      </div>
    </div>
  );
}

function RecordTile({ label, value, sub, color, icon, onClick }: {
  label: string; value: string; sub: string; color: string; icon?: React.ReactNode; onClick?: () => void;
}): JSX.Element {
  const content = (
    <>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {icon}
        {label}
      </div>
      <div className="text-base font-bold tabular-nums mt-0.5" style={{ color }}>
        {value}
      </div>
      <div className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }} title={sub}>
        {sub}
      </div>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-xl border p-3 text-left hover:opacity-80 transition-opacity"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--color-border)' }}>
      {content}
    </div>
  );
}

function PhaseStrengthHeatmap({ matrix, onDrillCell }: { matrix: EngagementSummary['phaseStrength']; onDrillCell: (filters: StatFilter[]) => void }): JSX.Element {
  // Hide when no row has more than one populated cell — the trend
  // isn't there yet.
  const hasTrendData = matrix.rows.some((r) => r.cells.filter((c) => c.accuracyPct !== null).length >= 2);
  if (!hasTrendData) return <></>;
  const heatRows: HeatmapRow[] = matrix.rows.map((r) => ({
    label: r.phase.charAt(0).toUpperCase() + r.phase.slice(1),
    cells: r.cells.map((c) => ({
      value: c.accuracyPct,
      display: c.accuracyPct !== null ? `${c.accuracyPct}` : '—',
      hint: `${c.monthLabel}: ${c.samples} game${c.samples === 1 ? '' : 's'}`,
    })),
  }));
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-phase-strength"
    >
      <div className="flex items-center gap-2 mb-1">
        <TrendingUp size={16} style={{ color: 'var(--color-success)' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Phase strength over time
        </h3>
      </div>
      <HeatmapGrid
        columns={matrix.monthLabels}
        rows={heatRows}
        cellColor={accuracyColor}
        caption="Accuracy % per phase, by month. Darker green = sharper."
        legend={<span>Red &lt; 55% · Amber 55-85% · Green &gt; 85%</span>}
        testId="patterns-phase-strength-heatmap"
        onCellClick={(rowIndex, colIndex, value) => {
          if (value === null) return;
          const phaseRow = matrix.rows[rowIndex];
          const monthKey = matrix.monthsAsc[colIndex];
          const monthLabel = matrix.monthLabels[colIndex];
          onDrillCell([{
            source: 'phase-month',
            phase: phaseRow.phase,
            monthKey,
            label: `${phaseRow.phase} · ${monthLabel} (${value}%)`,
          }]);
        }}
      />
    </div>
  );
}

function TacticRecognitionHeatmap({ rows, onDrillRow }: { rows: EngagementSummary['tacticRecognition']; onDrillRow: (filters: StatFilter[]) => void }): JSX.Element {
  const significant = rows.filter(
    (r) => r.puzzleAccuracyPct !== null || r.inGameRecognitionPct !== null,
  );
  if (significant.length === 0) return <></>;

  const heatRows: HeatmapRow[] = significant.slice(0, 8).map((r) => ({
    label: r.tacticType.replace(/_/g, ' '),
    cells: [
      { value: r.puzzleAccuracyPct, display: r.puzzleAccuracyPct !== null ? `${r.puzzleAccuracyPct}%` : '—' },
      { value: r.inGameRecognitionPct, display: r.inGameRecognitionPct !== null ? `${r.inGameRecognitionPct}%` : '—' },
      {
        value: r.gapPoints,
        display: r.gapPoints !== null ? `${r.gapPoints > 0 ? '+' : ''}${r.gapPoints}` : '—',
        hint: r.gapPoints !== null
          ? (r.gapPoints > 0
            ? 'Higher in puzzles — pattern known, board awareness weaker'
            : 'Higher in-game — board sense stronger than pattern recognition')
          : undefined,
      },
    ],
  }));

  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-tactic-recognition"
    >
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={16} style={{ color: '#22d3ee' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Tactic recognition
        </h3>
      </div>
      <HeatmapGrid
        columns={['Puzzle', 'In game', 'Gap']}
        rows={heatRows}
        cellColor={(v) => (v === null ? gapColor(null) : accuracyColor(v))}
        caption="How you handle each tactic type. Gap column uses a separate scale: positive = puzzle-strong/game-weak."
        testId="patterns-tactic-recognition-heatmap"
        labelColumnWidth="140px"
        onCellClick={(rowIndex) => {
          const tacticRow = significant[rowIndex];
          onDrillRow([{
            source: 'tactic-type',
            tacticType: tacticRow.tacticType,
            label: tacticRow.tacticType.replace(/_/g, ' '),
          }]);
        }}
      />
    </div>
  );
}

// ─── Cards ─────────────────────────────────────────────────────────────

function StreaksRow({ streak }: { streak: EngagementSummary['streak'] }): JSX.Element {
  const showWin = streak.longestWinStreak > 0;
  const showSolve = streak.longestSolveStreak > 0;
  if (!showWin && !showSolve) return <></>;
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-streaks"
    >
      <div className="flex items-center gap-2 mb-3">
        <Flame size={16} style={{ color: 'var(--color-warning)' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Streaks
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {showWin && (
          <StreakStat
            label="Win streak"
            current={streak.currentWinStreak}
            longest={streak.longestWinStreak}
            color="var(--color-success)"
          />
        )}
        {showSolve && (
          <StreakStat
            label="First-try solves"
            current={streak.currentSolveStreak}
            longest={streak.longestSolveStreak}
            color="#22d3ee"
          />
        )}
      </div>
    </div>
  );
}

function StreakStat({ label, current, longest, color }: {
  label: string; current: number; longest: number; color: string;
}): JSX.Element {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--color-border)' }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-2xl font-bold tabular-nums" style={{ color }}>{current}</span>
        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          {current === longest ? '· peak' : `· best ${longest}`}
        </span>
      </div>
    </div>
  );
}

function FirstTryCard({ firstTry }: { firstTry: EngagementSummary['firstTry'] }): JSX.Element {
  const totalSamples = firstTry.endgame.total + firstTry.mistakePuzzles.total;
  if (totalSamples === 0) return <></>;
  return (
    <PatternCard
      icon={<Star size={16} style={{ color: '#22d3ee' }} />}
      title="First-try mastery"
      subtitle="Solved on the FIRST attempt"
      bigStat={`${firstTry.overallPct}%`}
      bigStatColor="#22d3ee"
      caption={`${firstTry.endgame.mastered} of ${firstTry.endgame.total} endgames · ${firstTry.mistakePuzzles.firstTry} of ${firstTry.mistakePuzzles.total} mistake puzzles`}
      testId="patterns-first-try"
    />
  );
}

function ColorMismatchCard({ mismatch }: { mismatch: EngagementSummary['colorMismatch'] }): JSX.Element {
  if (!mismatch || !mismatch.isSignificant) return <></>;
  return (
    <PatternCard
      icon={<ArrowDownUp size={16} style={{ color: '#a855f7' }} />}
      title="Color flip"
      subtitle={`You play ${mismatch.preferredColor} more, but ${mismatch.otherColor} wins more`}
      bigStat={`+${mismatch.inversionPoints} pts`}
      bigStatColor="#a855f7"
      caption={`As ${mismatch.preferredColor} (${mismatch.preferredShare}% of games): ${mismatch.preferredWinRate}% win rate · As ${mismatch.otherColor} (${mismatch.otherShare}%): ${mismatch.otherWinRate}% win rate.`}
      testId="patterns-color-flip"
    />
  );
}

function ComebackCard({ comeback, winShape }: { comeback: EngagementSummary['comeback']; winShape: EngagementSummary['winShape'] }): JSX.Element {
  if (comeback.comebackWins === 0) return <></>;
  const deepest = comeback.deepestHoleCp !== null ? Math.abs(comeback.deepestHoleCp) : 0;
  return (
    <PatternCard
      icon={<RotateCw size={16} style={{ color: 'var(--color-success)' }} />}
      title="Comeback wins"
      subtitle="Games won from a losing position (≤−2.00)"
      bigStat={`${comeback.comebackWins}`}
      bigStatColor="var(--color-success)"
      caption={`Deepest hole climbed: ${deepest > 0 ? `−${(deepest / 100).toFixed(2)}` : '—'}. ${winShape.totalWins > 0 ? `${Math.round((comeback.comebackWins / winShape.totalWins) * 100)}% of your wins` : ''}`}
      testId="patterns-comeback"
    />
  );
}

function WinShapeCard({ winShape }: { winShape: EngagementSummary['winShape'] }): JSX.Element {
  if (winShape.totalWins === 0) return <></>;
  const pct = (n: number): number => winShape.totalWins > 0 ? Math.round((n / winShape.totalWins) * 100) : 0;
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-win-shape"
    >
      <div className="flex items-center gap-2 mb-3">
        <Trophy size={16} style={{ color: 'var(--color-warning)' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          How you win
        </h3>
      </div>
      <div className="flex gap-2">
        <WinShapeBucket label="Quick" sub="≤20 moves" value={winShape.quickWins} pct={pct(winShape.quickWins)} color="#22d3ee" />
        <WinShapeBucket label="Mid" sub="21-59 moves" value={winShape.midLengthWins} pct={pct(winShape.midLengthWins)} color="#6366f1" />
        <WinShapeBucket label="Grind" sub="≥60 moves" value={winShape.grindWins} pct={pct(winShape.grindWins)} color="#a855f7" />
      </div>
    </div>
  );
}

function WinShapeBucket({ label, sub, value, pct, color }: {
  label: string; sub: string; value: number; pct: number; color: string;
}): JSX.Element {
  return (
    <div className="flex-1 rounded-xl border p-3 text-center" style={{ borderColor: 'var(--color-border)' }}>
      <div className="text-xs font-semibold" style={{ color }}>{label}</div>
      <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{sub}</div>
      <div className="text-xl font-bold tabular-nums mt-1" style={{ color: 'var(--color-text)' }}>{value}</div>
      <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{pct}% of wins</div>
    </div>
  );
}

function TacticBreadthCard({ breadth, brilliantShape }: {
  breadth: EngagementSummary['breadth'];
  brilliantShape: EngagementSummary['brilliantShape'];
}): JSX.Element {
  if (breadth.distinctTypes === 0 && brilliantShape.totalBrilliants === 0) return <></>;
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="patterns-breadth"
    >
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} style={{ color: '#22d3ee' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Brilliance shape
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--color-border)' }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Tactic types found
          </div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
            {breadth.distinctTypes}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            of 14 patterns
          </div>
        </div>
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--color-border)' }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Brilliant moves
          </div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: '#22d3ee' }}>
            {brilliantShape.totalBrilliants}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {brilliantShape.shape === 'spread' && 'spread across games'}
            {brilliantShape.shape === 'clustered' && 'clustered in a few games'}
            {brilliantShape.shape === 'insufficient' && 'one bright game'}
          </div>
        </div>
      </div>
    </div>
  );
}

function RepeatMistakeCard({ repeats }: { repeats: EngagementSummary['repeatMistake'] }): JSX.Element {
  if (repeats.repeatedMistakes === 0) return <></>;
  const tactics = Object.entries(repeats.byTactic).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div
      className="rounded-2xl border p-4"
      style={{
        background: 'color-mix(in srgb, var(--color-error) 4%, var(--color-surface))',
        borderColor: 'color-mix(in srgb, var(--color-error) 30%, var(--color-border))',
      }}
      data-testid="patterns-repeat-mistake"
    >
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={16} style={{ color: 'var(--color-error)' }} />
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Same mistake, twice
        </h3>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--color-error)' }}>
          {repeats.repeatedMistakes}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          of {repeats.totalUnsolved} unsolved mistake puzzles
        </span>
      </div>
      {tactics.length > 0 && (
        <div className="text-[11px] mt-2" style={{ color: 'var(--color-text-muted)' }}>
          Most often: {tactics.map(([t, n]) => `${t.replace(/_/g, ' ')} (${n})`).join(', ')}
        </div>
      )}
    </div>
  );
}

// ─── Reusable primitives ───────────────────────────────────────────────

function PatternCard({ icon, title, subtitle, bigStat, bigStatColor, caption, testId }: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  bigStat: string;
  bigStatColor: string;
  caption?: string;
  testId: string;
}): JSX.Element {
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          {title}
        </h3>
      </div>
      <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</div>
      <div className="text-3xl font-bold tabular-nums" style={{ color: bigStatColor }}>{bigStat}</div>
      {caption && (
        <div className="text-[11px] mt-2" style={{ color: 'var(--color-text-muted)' }}>{caption}</div>
      )}
    </div>
  );
}

// ─── Strength roll-up ──────────────────────────────────────────────────

function buildStrengthsList(data: EngagementSummary): string[] {
  const out: string[] = [];
  if (data.firstTry.overallPct >= 60 && (data.firstTry.endgame.total + data.firstTry.mistakePuzzles.total) >= 5) {
    out.push(`${data.firstTry.overallPct}% first-try mastery rate`);
  }
  if (data.comeback.comebackWins >= 2) {
    out.push(`${data.comeback.comebackWins} comeback wins from a losing position`);
  }
  if (data.streak.longestWinStreak >= 3) {
    out.push(`Best win streak: ${data.streak.longestWinStreak} games`);
  }
  if (data.streak.longestSolveStreak >= 5) {
    out.push(`Best first-try solve streak: ${data.streak.longestSolveStreak}`);
  }
  if (data.breadth.distinctTypes >= 6) {
    out.push(`Found ${data.breadth.distinctTypes} distinct tactic types in your games`);
  }
  if (data.brilliantShape.shape === 'spread' && data.brilliantShape.totalBrilliants >= 5) {
    out.push(`${data.brilliantShape.totalBrilliants} brilliant moves spread across many games (general sharpness)`);
  }
  if (data.winShape.grindWins >= 3 && data.winShape.totalWins > 0) {
    const pct = Math.round((data.winShape.grindWins / data.winShape.totalWins) * 100);
    if (pct >= 30) out.push(`Strong endgame conversion (${pct}% of wins in 60+ moves)`);
  }
  if (data.winShape.quickWins >= 3 && data.winShape.totalWins > 0) {
    const pct = Math.round((data.winShape.quickWins / data.winShape.totalWins) * 100);
    if (pct >= 30) out.push(`Sharp tactical finisher (${pct}% of wins in ≤20 moves)`);
  }
  return out;
}
