/**
 * ActivityHeatmap — GitHub-contribution-style calendar grid showing
 * daily game counts over the past year.
 *
 * Layout: 7 rows (Sun…Sat) × ~52 columns (weeks). Each cell is a
 * day; color intensity scales with the day's game count. Hover/tap
 * shows the date + count.
 *
 * Data: `analyticsService.activityHeatmap()` returns the dense
 * dayCount[] series anchored on today.
 */
import type { ActivityHeatmapData } from '../../services/analyticsService';

interface ActivityHeatmapProps {
  data: ActivityHeatmapData;
  /** Fired when the user taps a populated cell. The drilldown
   *  panel listens via the parent component. Empty-count cells
   *  are still tappable but the handler can early-return on
   *  count === 0 to skip empty-state navigations. */
  onCellClick?: (date: string, count: number) => void;
}

const CELL_PX = 11;
const GAP_PX = 2;
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function colorForCount(count: number, max: number): string {
  if (count === 0) return 'color-mix(in srgb, var(--color-border) 35%, transparent)';
  // 4-tier scale from light green → vivid green
  const ratio = max > 0 ? count / max : 0;
  if (ratio >= 0.75) return 'rgba(34, 197, 94, 0.9)';
  if (ratio >= 0.5) return 'rgba(34, 197, 94, 0.7)';
  if (ratio >= 0.25) return 'rgba(34, 197, 94, 0.5)';
  return 'rgba(34, 197, 94, 0.3)';
}

export function ActivityHeatmap({ data, onCellClick }: ActivityHeatmapProps): JSX.Element {
  if (data.cells.length === 0) {
    return (
      <div className="text-xs py-3 text-center" style={{ color: 'var(--color-text-muted)' }} data-testid="activity-heatmap-empty">
        No games played yet.
      </div>
    );
  }

  // Group cells into weeks. The first column may be a partial week
  // depending on what day-of-week the window starts on; that's fine —
  // it just renders an empty top-of-column.
  const weeks: { date: string; count: number; dayOfWeek: number }[][] = [];
  let currentWeek: { date: string; count: number; dayOfWeek: number }[] = [];
  let currentWeekIndex = -1;
  for (const cell of data.cells) {
    const dt = new Date(cell.date + 'T00:00:00');
    const dow = dt.getDay();
    // Each new Sunday begins a new column.
    if (dow === 0 || currentWeekIndex < 0) {
      if (currentWeek.length > 0) weeks.push(currentWeek);
      currentWeek = [];
      currentWeekIndex++;
    }
    currentWeek.push({ date: cell.date, count: cell.count, dayOfWeek: dow });
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  // Month labels: show the abbreviation when we cross into a new month.
  const monthLabels: { weekIndex: number; label: string }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, i) => {
    const firstDay = new Date(week[0].date + 'T00:00:00');
    if (firstDay.getMonth() !== lastMonth) {
      lastMonth = firstDay.getMonth();
      monthLabels.push({
        weekIndex: i,
        label: firstDay.toLocaleString('en-US', { month: 'short' }),
      });
    }
  });

  return (
    <div className="w-full" data-testid="activity-heatmap">
      <div className="overflow-x-auto pb-2">
        <div className="inline-block">
          {/* Month label row */}
          <div className="flex" style={{ paddingLeft: 26 }}>
            {weeks.map((_, i) => {
              const label = monthLabels.find((m) => m.weekIndex === i);
              return (
                <div
                  key={`m-${i}`}
                  style={{ width: CELL_PX + GAP_PX, height: 11 }}
                  className="text-[9px] font-semibold"
                >
                  <span style={{ color: 'var(--color-text-muted)' }}>{label?.label ?? ''}</span>
                </div>
              );
            })}
          </div>
          {/* Day rows alongside weeks */}
          <div className="flex">
            {/* Y-axis day labels */}
            <div className="flex flex-col mr-1.5" style={{ width: 22 }}>
              {DAY_LABELS.map((d, i) => (
                <div
                  key={i}
                  className="text-[8px]"
                  style={{
                    height: CELL_PX + GAP_PX,
                    color: 'var(--color-text-muted)',
                    lineHeight: `${CELL_PX + GAP_PX}px`,
                  }}
                >
                  {d}
                </div>
              ))}
            </div>
            {/* Week columns */}
            <div className="flex">
              {weeks.map((week, wi) => (
                <div key={`w-${wi}`} className="flex flex-col">
                  {Array.from({ length: 7 }, (_, dow) => {
                    const day = week.find((d) => d.dayOfWeek === dow);
                    if (!day) {
                      return (
                        <div
                          key={`empty-${dow}`}
                          style={{ width: CELL_PX, height: CELL_PX, marginBottom: GAP_PX, marginRight: GAP_PX }}
                        />
                      );
                    }
                    const clickable = onCellClick && day.count > 0;
                    return (
                      <div
                        key={day.date}
                        role={clickable ? 'button' : undefined}
                        tabIndex={clickable ? 0 : -1}
                        onClick={() => { if (clickable) onCellClick(day.date, day.count); }}
                        onKeyDown={(e) => {
                          if (!clickable) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onCellClick(day.date, day.count);
                          }
                        }}
                        title={`${day.date}: ${day.count} game${day.count === 1 ? '' : 's'}${clickable ? ' (click to view)' : ''}`}
                        style={{
                          width: CELL_PX,
                          height: CELL_PX,
                          marginBottom: GAP_PX,
                          marginRight: GAP_PX,
                          background: colorForCount(day.count, data.maxCount),
                          borderRadius: 2,
                          cursor: clickable ? 'pointer' : 'default',
                        }}
                        data-testid={day.count > 0 ? 'activity-cell-played' : 'activity-cell-empty'}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Summary row + legend */}
      <div className="flex items-center justify-between mt-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        <div>
          <span className="font-bold" style={{ color: 'var(--color-text)' }}>
            {data.totalGames}
          </span>{' '}
          games · <span style={{ color: 'var(--color-text)' }}>{data.activeDays}</span> active days in the last year
        </div>
        <div className="flex items-center gap-1">
          <span>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
            const fakeCount = Math.max(1, Math.round(r * Math.max(1, data.maxCount)));
            return (
              <div
                key={i}
                style={{
                  width: 9,
                  height: 9,
                  background: r === 0
                    ? 'color-mix(in srgb, var(--color-border) 35%, transparent)'
                    : colorForCount(fakeCount, data.maxCount),
                  borderRadius: 2,
                }}
              />
            );
          })}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}
