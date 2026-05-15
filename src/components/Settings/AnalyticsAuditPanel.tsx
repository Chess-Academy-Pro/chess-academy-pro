/**
 * AnalyticsAuditPanel — Settings → About → Diagnostics
 *
 * The "show me the data flow" view. Renders the in-app analytics
 * audit so David (or any next-session Claude) can verify:
 *
 *   1. Which surfaces are actually emitting audit events in the
 *      current window. Red rows = silent surfaces.
 *   2. Which AuditKinds are firing, how often, when last.
 *   3. Live counters: hint activity, dwell averages, move-attempt
 *      distribution — the Tier 1-3 signals the engagement view on
 *      /weaknesses also reads.
 *   4. Dead-capture warnings: persistence (db.sessions today) +
 *      legacy kinds with no in-app consumer.
 *
 * Companion to ANALYTICS_AUDIT.md. The doc is the static record;
 * this panel is the live check.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, Clock, Eye } from 'lucide-react';
import {
  analyticsSelfAudit,
  ANALYTICS_WINDOWS,
  type AnalyticsSelfAudit,
  type AnalyticsWindow,
} from '../../services/analyticsService';
import { logAppAudit } from '../../services/appAuditor';

type WindowChoice = '24h' | '7d' | '30d';

const WINDOW_LABELS: Record<WindowChoice, string> = {
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  '30d': 'Last 30d',
};

function buildWindow(choice: WindowChoice): AnalyticsWindow {
  switch (choice) {
    case '24h': return ANALYTICS_WINDOWS.last24h();
    case '7d': return ANALYTICS_WINDOWS.last7d();
    case '30d': return ANALYTICS_WINDOWS.last30d();
  }
}

function fmtAgo(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const sec = Math.round((now - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function AnalyticsAuditPanel(): JSX.Element {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('24h');
  const [audit, setAudit] = useState<AnalyticsSelfAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await analyticsSelfAudit(buildWindow(windowChoice));
      setAudit(result);
      setNow(Date.now());
      void logAppAudit({
        kind: 'analytics-self-audit',
        category: 'subsystem',
        source: 'AnalyticsAuditPanel.refresh',
        summary: `coverage refresh — window=${windowChoice}, ${result.coverage.totalEvents} events`,
        details: JSON.stringify({
          window: windowChoice,
          totalEvents: result.coverage.totalEvents,
          surfaces: result.coverage.rows.length,
          silentSurfaces: result.coverage.silentSurfaces,
        }),
      });
    } finally {
      setLoading(false);
    }
  }, [windowChoice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !audit) {
    return (
      <div className="text-xs py-3" style={{ color: 'var(--color-text-muted)' }}>
        Reading the audit log…
      </div>
    );
  }
  if (!audit) {
    return (
      <div className="text-xs py-3" style={{ color: 'var(--color-text-muted)' }}>
        No audit data available.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="analytics-audit-panel">
      {/* Header + window picker */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(['24h', '7d', '30d'] as WindowChoice[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindowChoice(w)}
              className="px-2 py-1 rounded-md text-[11px] font-medium"
              style={{
                background: windowChoice === w ? 'var(--color-accent)' : 'transparent',
                color: windowChoice === w ? 'var(--color-bg)' : 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
              data-testid={`analytics-window-${w}`}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1.5 rounded-lg hover:opacity-80 disabled:opacity-40"
          aria-label="Refresh analytics audit"
          data-testid="analytics-refresh-btn"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Top-line summary */}
      <div className="grid grid-cols-3 gap-2">
        <SummaryStat label="Events" value={`${audit.coverage.totalEvents}`} testId="analytics-total-events" />
        <SummaryStat label="Surfaces" value={`${audit.coverage.rows.length}`} testId="analytics-active-surfaces" />
        <SummaryStat label="Kinds" value={`${audit.kinds.length}`} testId="analytics-distinct-kinds" />
      </div>

      {/* Silent surfaces warning */}
      {audit.coverage.silentSurfaces.length > 0 && (
        <div
          className="rounded-xl border p-3"
          style={{
            background: 'color-mix(in srgb, var(--color-warning) 8%, var(--color-surface))',
            borderColor: 'color-mix(in srgb, var(--color-warning) 40%, transparent)',
          }}
          data-testid="analytics-silent-surfaces"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: 'var(--color-warning)' }}>
            <AlertTriangle size={12} />
            Silent surfaces ({audit.coverage.silentSurfaces.length})
          </div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            No audit events in this window: {audit.coverage.silentSurfaces.join(', ')}
          </div>
        </div>
      )}

      {/* Coverage table */}
      <Section title="Surface coverage" icon={<Eye size={12} />}>
        {audit.coverage.rows.length === 0 ? (
          <div className="text-[11px] py-3" style={{ color: 'var(--color-text-muted)' }}>
            No events captured in the selected window.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: 'var(--color-text-muted)' }}>
                  <th className="text-left py-1 font-semibold">Surface</th>
                  <th className="text-right py-1 font-semibold">Events</th>
                  <th className="text-right py-1 font-semibold">Kinds</th>
                  <th className="text-right py-1 font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {audit.coverage.rows.map((row) => (
                  <tr
                    key={row.surface}
                    style={{ borderTop: '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)' }}
                  >
                    <td className="py-1.5 pr-2 font-medium" style={{ color: 'var(--color-text)' }}>
                      {row.surface}
                    </td>
                    <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--color-text)' }}>
                      {row.totalEvents}
                    </td>
                    <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                      {row.kindsEmitted}
                    </td>
                    <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                      {fmtAgo(row.lastSeen, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Live counters */}
      <Section title="Hint activity" icon={<Clock size={12} />}>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <Stat label="Hints" value={`${audit.hint.count}`} />
          <Stat label="Avg latency" value={`${audit.hint.avgLatencyMs}ms`} />
          <Stat label="Effectiveness" value={`${audit.hint.effectivenessPct}%`} />
          <Stat
            label="Top reason"
            value={
              Object.entries(audit.hint.byReason)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
            }
          />
        </div>
      </Section>

      <Section title="Position dwell" icon={null}>
        {/* `position-dwell` AuditKind exists in the union but no
            surface emits it yet (ANALYTICS_AUDIT.md Tier 1 plan,
            still pending). Showing the section flagged so the
            empty values don't look like a bug. Remove the badge
            once emit sites are wired into the move-input layer. */}
        <div className="mb-2 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold"
             style={{ background: 'color-mix(in srgb, var(--color-warning) 18%, transparent)', color: 'var(--color-warning)' }}>
          Not yet emitted — Tier 1 build pending
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="Opening" value={audit.dwell.opening.samples > 0 ? `${Math.round(audit.dwell.opening.avgMs / 1000)}s` : '—'} sub={`${audit.dwell.opening.samples}n`} />
          <Stat label="Middlegame" value={audit.dwell.middlegame.samples > 0 ? `${Math.round(audit.dwell.middlegame.avgMs / 1000)}s` : '—'} sub={`${audit.dwell.middlegame.samples}n`} />
          <Stat label="Endgame" value={audit.dwell.endgame.samples > 0 ? `${Math.round(audit.dwell.endgame.avgMs / 1000)}s` : '—'} sub={`${audit.dwell.endgame.samples}n`} />
        </div>
      </Section>

      <Section title="Move attempts per puzzle" icon={null}>
        {audit.attempts.distribution.length === 0 ? (
          <div className="text-[11px] py-2" style={{ color: 'var(--color-text-muted)' }}>
            No move-attempt events yet. Wire emit sites in puzzle / walkthrough / endgame surfaces to populate this.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <Stat label="Mean attempts" value={`${audit.attempts.meanAttempts}`} />
            <Stat label="First-try %" value={`${audit.attempts.firstTryCorrectPct}%`} />
          </div>
        )}
      </Section>

      {/* Kind frequency — collapsible. Always render last 10. */}
      <Section title="Recent AuditKinds (top 10)" icon={null}>
        <div className="space-y-1">
          {audit.kinds.slice(0, 10).map((row) => (
            <div key={row.kind} className="flex items-center justify-between text-[11px]">
              <code className="px-1 py-0.5 rounded text-[10px]" style={{
                background: 'var(--color-bg-secondary, color-mix(in srgb, var(--color-border) 40%, transparent))',
                color: 'var(--color-text)',
              }}>
                {row.kind}
              </code>
              <span className="tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                {row.count} · {fmtAgo(row.lastSeen, now)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Dead capture */}
      {audit.deadCapture.length > 0 && (
        <Section title="Dead capture" icon={<AlertTriangle size={12} />}>
          <div className="space-y-2">
            {audit.deadCapture.map((row) => (
              <div
                key={row.label}
                className="rounded-lg border p-2"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid={`dead-capture-${row.label}`}
              >
                <div className="flex items-center gap-1.5">
                  <code className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>{row.label}</code>
                  <span
                    className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded"
                    style={{
                      color: row.status === 'orphan-table' ? 'var(--color-error)' : 'var(--color-text-muted)',
                      background: 'color-mix(in srgb, var(--color-border) 40%, transparent)',
                    }}
                  >
                    {row.status.replace(/-/g, ' ')}
                  </span>
                </div>
                <div className="text-[10px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{row.rationale}</div>
                <div className="text-[10px] mt-0.5 italic" style={{ color: 'var(--color-text-muted)' }}>{row.fixHint}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Primitives ────────────────────────────────────────────────────────

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide pb-1.5 mb-2 border-b"
        style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}>
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function SummaryStat({ label, value, testId }: { label: string; value: string; testId: string }): JSX.Element {
  return (
    <div
      className="rounded-lg border p-2 text-center"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      data-testid={testId}
    >
      <div className="text-lg font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div
      className="rounded-md border p-2"
      style={{ borderColor: 'color-mix(in srgb, var(--color-border) 60%, transparent)' }}
    >
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div className="text-sm font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
        {value} {sub && <span className="text-[10px] font-normal" style={{ color: 'var(--color-text-muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}
