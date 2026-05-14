import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { InsightsDonutChart } from './InsightsDonutChart';
import { InsightsBarChart } from './InsightsBarChart';
import { InsightsStackedBar } from './InsightsStackedBar';
import { StrengthsCard } from './StrengthsCard';
import type { MistakeInsights, GamePhase } from '../../types';

interface MistakesTabProps {
  data: MistakeInsights;
}

const PHASE_COLORS: Record<GamePhase, string> = {
  opening: 'var(--color-success)',
  middlegame: '#f59e0b',
  endgame: '#f97316',
};

export function MistakesTab({ data }: MistakesTabProps): JSX.Element {
  const navigate = useNavigate();

  const errorDonut = [
    { name: 'Blunders', value: data.errorBreakdown.blunders, color: 'var(--color-error)' },
    { name: 'Mistakes', value: data.errorBreakdown.mistakes, color: '#f97316' },
    { name: 'Inaccuracies', value: data.errorBreakdown.inaccuracies, color: '#f59e0b' },
  ];

  const totalErrors = data.errorBreakdown.blunders + data.errorBreakdown.mistakes + data.errorBreakdown.inaccuracies;

  const situationDonut = [
    { name: 'When winning', value: data.errorsBySituation.winning, color: 'var(--color-success)' },
    { name: 'When equal', value: data.errorsBySituation.equal, color: 'var(--color-accent)' },
    { name: 'When losing', value: data.errorsBySituation.losing, color: 'var(--color-error)' },
  ];
  const situationTotal = data.errorsBySituation.winning + data.errorsBySituation.equal + data.errorsBySituation.losing;

  const puzzleProgress = [
    { label: 'Mastered', value: data.puzzleProgress.mastered, color: 'var(--color-success)' },
    { label: 'Solved', value: data.puzzleProgress.solved, color: 'var(--color-accent)' },
    { label: 'Unsolved', value: data.puzzleProgress.unsolved, color: 'var(--color-text-muted)' },
  ];

  return (
    <div data-testid="mistakes-tab">
      {/* Error Breakdown */}
      <Section title="Error Breakdown">
        <div className="flex items-center gap-5 py-3.5">
          <InsightsDonutChart data={errorDonut} centerValue={totalErrors} centerLabel="Errors" />
          <div className="flex flex-col gap-1.5 flex-1">
            {errorDonut.map((d) => (
              <div key={d.name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                {d.name}
                <span className="ml-auto font-semibold" style={{ color: 'var(--color-text)' }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
        <DataRow label="Missed wins" value={`${data.missedWins}`} color="#a855f7" />
        <DataRow label="Avg centipawn loss" value={`${data.avgCpLoss} cp`} />
      </Section>

      {/* Errors by Phase */}
      <Section title="Errors by Phase">
        <InsightsBarChart
          data={data.errorsByPhase.map((p) => ({
            label: p.phase.charAt(0).toUpperCase() + p.phase.slice(1),
            value: p.errors,
            color: PHASE_COLORS[p.phase],
          }))}
        />
        {data.errorsByPhase.map((p) => (
          <DataRow
            key={p.phase}
            label={`Avg CP loss — ${p.phase.charAt(0).toUpperCase() + p.phase.slice(1)}`}
            value={`${p.avgCpLoss} cp`}
            color={PHASE_COLORS[p.phase]}
          />
        ))}
      </Section>

      {/* Errors by Situation */}
      {situationTotal > 0 && (
        <Section title="Errors by Situation">
          <div className="flex items-center gap-5 py-3.5">
            <InsightsDonutChart data={situationDonut} centerValue={situationTotal} centerLabel="Total" />
            <div className="flex flex-col gap-1.5 flex-1">
              {situationDonut.map((d) => (
                <div key={d.name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                  {d.name}
                  <span className="ml-auto font-semibold" style={{ color: 'var(--color-text)' }}>{d.value}</span>
                </div>
              ))}
            </div>
          </div>
          <DataRow label="Thrown wins (ahead → lost)" value={`${data.thrownWins}`} color="var(--color-error)" />
          <DataRow label="Late-game collapses" value={`${data.lateGameCollapses} of ${data.totalGames}`} color="#f97316" />
        </Section>
      )}

      {/* Costliest Mistakes */}
      {data.costliestMistakes.length > 0 && (
        <Section title="Costliest Mistakes">
          <div className="text-[10px] py-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Tap to review on the board
          </div>
          {data.costliestMistakes.map((m) => (
            <div key={`${m.gameId}:${m.moveNumber}`}>
              <button
                onClick={() => void navigate(`/coach/review/${encodeURIComponent(m.gameId)}?move=${m.moveNumber}`)}
                className="flex items-center justify-between w-full py-2 border-b text-sm hover:opacity-80 transition-opacity"
                style={{ borderColor: 'color-mix(in srgb, var(--color-border) 50%, transparent)' }}
                data-testid="mistake-row"
              >
                <span style={{ color: 'var(--color-text)' }}>
                  {m.san}{m.classification === 'blunder' ? '??' : '?'}
                  <span className="text-[11px] ml-1" style={{ color: 'var(--color-text-muted)' }}>
                    vs {m.opponentName}
                  </span>
                </span>
                <span className="font-semibold text-xs flex items-center gap-1" style={{ color: 'var(--color-error)' }}>
                  −{m.cpLoss} cp
                  <Play size={10} style={{ color: 'var(--color-accent)' }} />
                </span>
              </button>
              <div
                className="text-xs py-1 pl-3.5 border-b"
                style={{ color: 'var(--color-text-muted)', borderColor: 'color-mix(in srgb, var(--color-border) 30%, transparent)' }}
              >
                {m.openingName ?? 'Unknown'} · {m.date} · move {m.moveNumber}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* Puzzle Progress */}
      {(data.puzzleProgress.mastered + data.puzzleProgress.solved + data.puzzleProgress.unsolved) > 0 && (
        <Section title="Mistake Puzzle Progress">
          <InsightsStackedBar segments={puzzleProgress} />
        </Section>
      )}

      <StrengthsCard strengths={data.strengths} />
    </div>
  );
}

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
