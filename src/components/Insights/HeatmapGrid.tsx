/**
 * HeatmapGrid — generic 2D matrix heatmap.
 *
 * Used for: opening proficiency, phase strength over time, tactic
 * recognition. NOT for the calendar/activity view — that's a
 * dedicated `ActivityHeatmap` component because its column grouping
 * (weeks of the year) doesn't fit the row-by-row matrix shape.
 *
 * The component is deliberately dumb — it takes the data shaped and
 * the color scale, renders. All semantics (what's a "good" cell,
 * what's "empty") are decided by the caller via the color function.
 */
import type { ReactNode } from 'react';

export interface HeatmapCell {
  /** Raw value used by the color function. null = "no data". */
  value: number | null;
  /** Display text inside the cell (formatted by the caller). */
  display: string;
  /** Optional tooltip-style label (rendered as title attribute). */
  hint?: string;
}

export interface HeatmapRow {
  label: string;
  /** Optional secondary label rendered under the main one. */
  sublabel?: string;
  cells: HeatmapCell[];
}

export interface HeatmapGridProps {
  /** Column headers, left-to-right. */
  columns: string[];
  rows: HeatmapRow[];
  /** Maps cell value → CSS color string. Receives null for empty
   *  cells; return 'transparent' or a muted color in that case. */
  cellColor: (value: number | null) => string;
  /** Optional caption rendered above the grid. */
  caption?: string;
  /** Optional legend rendered below the grid. */
  legend?: ReactNode;
  /** Width of the row-label column. CSS string. */
  labelColumnWidth?: string;
  /** Min cell height — keep cells thumb-friendly on mobile. */
  cellMinHeight?: string;
  /** Optional cell-click handler. Receives the row index, column
   *  index, and the cell value. Cells become buttons when this is
   *  set; null-value cells are still clickable so callers can
   *  decide whether to early-return on empty data. */
  onCellClick?: (rowIndex: number, columnIndex: number, value: number | null) => void;
  testId?: string;
}

export function HeatmapGrid({
  columns,
  rows,
  cellColor,
  caption,
  legend,
  labelColumnWidth = '110px',
  cellMinHeight = '36px',
  onCellClick,
  testId,
}: HeatmapGridProps): JSX.Element {
  return (
    <div className="w-full" data-testid={testId}>
      {caption && (
        <p className="text-[11px] mb-2" style={{ color: 'var(--color-text-muted)' }}>
          {caption}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-separate" style={{ borderSpacing: '2px' }}>
          <thead>
            <tr>
              <th style={{ width: labelColumnWidth }} />
              {columns.map((c) => (
                <th
                  key={c}
                  className="text-[10px] font-semibold text-center pb-1"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.label}>
                <td
                  className="text-[11px] font-medium pr-2 align-middle"
                  style={{ width: labelColumnWidth, color: 'var(--color-text)' }}
                >
                  <div className="truncate" title={row.label}>{row.label}</div>
                  {row.sublabel && (
                    <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                      {row.sublabel}
                    </div>
                  )}
                </td>
                {row.cells.map((cell, i) => {
                  const sharedStyle = {
                    background: cellColor(cell.value),
                    color: cell.value === null ? 'var(--color-text-muted)' : '#0a0a0a',
                    minHeight: cellMinHeight,
                    height: cellMinHeight,
                    padding: '4px 6px',
                  } as const;
                  if (onCellClick) {
                    return (
                      <td key={`${row.label}-${i}`} style={{ padding: 0 }}>
                        <button
                          type="button"
                          onClick={() => onCellClick(rowIndex, i, cell.value)}
                          title={cell.hint}
                          className="w-full h-full text-center font-semibold rounded-md tabular-nums hover:opacity-80 transition-opacity"
                          style={sharedStyle}
                        >
                          {cell.display}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={`${row.label}-${i}`}
                      title={cell.hint}
                      className="text-center font-semibold rounded-md tabular-nums"
                      style={sharedStyle}
                    >
                      {cell.display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {legend && (
        <div className="mt-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          {legend}
        </div>
      )}
    </div>
  );
}

// Color-scale helpers live in `./heatmapScales` so this file can
// stay component-only (Vite Fast Refresh requirement).
