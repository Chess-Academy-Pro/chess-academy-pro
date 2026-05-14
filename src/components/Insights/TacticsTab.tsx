import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { InsightsDonutChart } from './InsightsDonutChart';
import { InsightsBarChart } from './InsightsBarChart';
import { InsightsStackedBar } from './InsightsStackedBar';
import { StrengthsCard } from './StrengthsCard';
import type { TacticInsights, TacticalMoment } from '../../types';

interface TacticsTabProps {
  data: TacticInsights;
}

const TACTIC_LABELS: Record<string, string> = {
  fork: 'Forks',
  pin: 'Pins',
  skewer: 'Skewers',
  discovered_attack: 'Disc. attacks',
  back_rank: 'Back rank',
  hanging_piece: 'Hanging pcs',
  promotion: 'Promotions',
  deflection: 'Deflections',
  overloaded_piece: 'Overloaded',
  tactical_sequence: 'Sequences',
};

export function TacticsTab({ data }: TacticsTabProps): JSX.Element {
  const navigate = useNavigate();

  const foundDonut = [
    { name: 'Brilliant', value: data.tacticsFound.brilliant, color: '#22d3ee' },
    { name: 'Great', value: data.tacticsFound.great, color: 'var(--color-success)' },
  ];
  const totalFound = data.tacticsFound.brilliant + data.tacticsFound.great;

  const fvmBar = [
    { label: 'Found', value: data.foundVsMissed.found, color: '#22d3ee' },
    { label: 'Missed', value: data.foundVsMissed.missed, color: 'var(--color-error)' },
  ];

  return (
    <div data-testid="tactics-tab">
      {/* Tactics Found */}
      <Section title="Tactics Found in Games">
        <div className="flex items-center gap-5 py-3.5">
          <InsightsDonutChart data={foundDonut} centerValue={totalFound} centerLabel="Found" />
          <div className="flex flex-col gap-1.5 flex-1">
            {foundDonut.map((d) => (
              <div key={d.name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                {d.name}
                <span className="ml-auto font-semibold" style={{ color: 'var(--color-text)' }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
        <DataRow label="Avg brilliant moves / game" value={`${data.avgBrilliantsPerGame}`} color="#22d3ee" />
        <DataRow label="Avg great moves / game" value={`${data.avgGreatPerGame}`} color="var(--color-success)" />
      </Section>

      {/* Best Tactical Sequences */}
      {data.bestSequences.length > 0 && (
        <Section title="Best Tactical Sequences">
          <div className="text-[10px] py-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Tap to replay on the board
          </div>
          {data.bestSequences.map((m) => (
            <TacticRow key={`${m.gameId}:${m.moveNumber}`} moment={m} navigate={navigate} positive />
          ))}
        </Section>
      )}

      {/* Worst Tactical Misses */}
      {data.worstMisses.length > 0 && (
        <Section title="Worst Tactical Misses">
          <div className="text-[10px] py-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Tap to play the position
          </div>
          {data.worstMisses.map((m) => (
            <TacticRow key={`${m.gameId}:${m.moveNumber}`} moment={m} navigate={navigate} positive={false} />
          ))}
        </Section>
      )}

      {/* Tactics Missed by Type */}
      {data.missedByType.length > 0 && (
        <Section title="Tactics Missed by Type">
          <InsightsBarChart
            data={data.missedByType.map((t) => ({
              label: TACTIC_LABELS[t.type] ?? t.type,
              value: t.count,
              color: 'var(--color-error)',
            }))}
          />
          {data.missedByType.length > 0 && (
            <DataRow
              label="Avg cost per missed tactic"
              value={`−${Math.round(data.missedByType.reduce((s, t) => s + t.avgCost * t.count, 0) / Math.max(1, data.foundVsMissed.missed))} cp`}
              color="#f97316"
            />
          )}
        </Section>
      )}

      {/* Found vs Missed */}
      {(data.foundVsMissed.found + data.foundVsMissed.missed) > 0 && (
        <Section title="Tactics Found vs Missed">
          <InsightsStackedBar segments={fvmBar} />
          <DataRow label="Tactical awareness rate" value={`${data.awarenessRate}%`} color="#22d3ee" />
        </Section>
      )}

      {/* Missed by Phase */}
      {data.missedByPhase.some((p) => p.count > 0) && (
        <Section title="Missed Tactics by Phase">
          <InsightsBarChart
            data={data.missedByPhase.map((p) => ({
              label: p.phase.charAt(0).toUpperCase() + p.phase.slice(1),
              value: p.count,
              color: p.phase === 'opening' ? 'var(--color-success)' : p.phase === 'middlegame' ? '#f59e0b' : '#f97316',
            }))}
          />
        </Section>
      )}

      <StrengthsCard strengths={data.strengths} />
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

function TacticRow({
  moment,
  navigate,
  positive,
}: {
  moment: TacticalMoment;
  navigate: ReturnType<typeof useNavigate>;
  positive: boolean;
}): JSX.Element {
  const color = positive ? '#22d3ee' : 'var(--color-error)';
  const evalStr = positive ? `+${moment.evalSwing}` : `−${Math.abs(moment.evalSwing)}`;

  return (
    <div>
      <button
        onClick={() => void navigate(`/coach/review/${encodeURIComponent(moment.gameId)}?move=${moment.moveNumber}`)}
        className="flex items-center justify-between w-full py-2 border-b text-sm hover:opacity-80 transition-opacity"
        style={{ borderColor: 'color-mix(in srgb, var(--color-border) 50%, transparent)' }}
        data-testid="tactic-row"
      >
        <span style={{ color: 'var(--color-text)' }}>
          {moment.explanation}
          <span className="text-[11px] ml-1" style={{ color: 'var(--color-text-muted)' }}>
            vs {moment.opponentName}
          </span>
        </span>
        <span className="font-semibold text-xs flex items-center gap-1" style={{ color }}>
          {evalStr} cp
          <Play size={10} style={{ color: 'var(--color-accent)' }} />
        </span>
      </button>
      <div
        className="text-xs py-1 pl-3.5 border-b"
        style={{ color: 'var(--color-text-muted)', borderColor: 'color-mix(in srgb, var(--color-border) 30%, transparent)' }}
      >
        {moment.openingName ?? 'Unknown'} · {moment.date} · move {moment.moveNumber}
      </div>
    </div>
  );
}
