/**
 * EnhancedGameCard — the richer per-game card used in
 * GamesDrilldownPage. Same opponent/result/stats info as
 * GameCard, plus:
 *   - Time-control bucket badge (Bullet / Blitz / Rapid / etc.)
 *   - Opening name + ECO label
 *   - Eval sparkline thumbnail across the game's evaluations
 *
 * Tap → routes to `/coach/review/:gameId` (the canonical review
 * surface). Used inside `GamesDrilldownPage`; not a general-
 * purpose component (the basic `GameCard` still serves the
 * OpeningDrilldown).
 */
import { useNavigate } from 'react-router-dom';
import type { GameRecord } from '../../types';

const AI_NAMES = ['AI Coach', 'Stockfish Bot'];

function getPlayerColor(game: GameRecord, username: string | null): 'white' | 'black' {
  if (AI_NAMES.includes(game.white)) return 'black';
  if (AI_NAMES.includes(game.black)) return 'white';
  if (username) {
    const lower = username.toLowerCase();
    if (game.black.toLowerCase() === lower) return 'black';
  }
  return 'white';
}

function getResult(game: GameRecord, color: 'white' | 'black'): 'win' | 'loss' | 'draw' {
  if (game.result === '1/2-1/2') return 'draw';
  if ((color === 'white' && game.result === '1-0') || (color === 'black' && game.result === '0-1')) return 'win';
  return 'loss';
}

function parseTimeControlLabel(pgn: string): string | null {
  const match = /\[TimeControl\s+"([^"]+)"\]/.exec(pgn);
  if (!match) return null;
  const v = match[1].trim();
  if (v === '-' || v === '*') return null;
  if (/^\d+\/\d+$/.test(v)) return 'Daily';
  const tc = /^(\d+)(?:\+(\d+))?$/.exec(v);
  if (!tc) return null;
  const initial = Number(tc[1]);
  const increment = tc[2] ? Number(tc[2]) : 0;
  const expected = initial + 40 * increment;
  if (expected <= 179) return 'Bullet';
  if (expected <= 479) return 'Blitz';
  if (expected <= 1499) return 'Rapid';
  return 'Classical';
}

function countMovesInPgn(pgn: string): number {
  return pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)).length;
}

const RESULT_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  win:  { label: 'WIN',  color: 'var(--color-success)', bg: 'color-mix(in srgb, var(--color-success) 10%, transparent)' },
  loss: { label: 'LOSS', color: 'var(--color-error)',   bg: 'color-mix(in srgb, var(--color-error) 10%, transparent)' },
  draw: { label: 'DRAW', color: 'var(--color-text-muted)', bg: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)' },
};

// ─── Eval sparkline ───────────────────────────────────────────────────────
//
// Inline SVG line chart over the game's per-move evaluations, clamped
// to ±1000 cp (anything beyond is essentially "winning/losing"). The
// trace flips sign when the player is Black so a winning position for
// the user is always "up" on the chart. Renders empty when the game
// has no annotations.

interface EvalPoint {
  x: number;
  y: number;
}

function buildEvalSparklinePoints(game: GameRecord, color: 'white' | 'black'): EvalPoint[] {
  if (!game.annotations || game.annotations.length === 0) return [];
  const evals: number[] = [];
  for (const ann of game.annotations) {
    if (ann.evaluation === null) continue;
    const signed = color === 'white' ? ann.evaluation : -ann.evaluation;
    const clamped = Math.max(-1000, Math.min(1000, signed));
    evals.push(clamped);
  }
  if (evals.length === 0) return [];
  // Normalize to [0..1] over the chart's x-axis; y in [-1000..1000]
  // (player POV) gets mapped to [0..1] where 0.5 is "equal."
  return evals.map((e, i) => ({
    x: evals.length > 1 ? i / (evals.length - 1) : 0.5,
    y: 0.5 + (e / 2000), // center at 0.5; e=+1000 → 1.0; e=-1000 → 0.0
  }));
}

function EvalSparkline({ game, playerColor }: { game: GameRecord; playerColor: 'white' | 'black' }): JSX.Element | null {
  const points = buildEvalSparklinePoints(game, playerColor);
  if (points.length === 0) return null;
  const W = 120;
  const H = 28;
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x * W).toFixed(1)} ${(H - p.y * H).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-label="Evaluation trace"
      style={{ overflow: 'visible' }}
    >
      {/* mid line (equal position) */}
      <line
        x1={0} x2={W}
        y1={H / 2} y2={H / 2}
        stroke="var(--color-border)"
        strokeWidth={0.5}
        opacity={0.5}
      />
      <path
        d={path}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────

interface EnhancedGameCardProps {
  game: GameRecord;
  username: string | null;
  /** Optional override for "review with coach" target — defaults to
   *  /coach/review/:gameId. When provided (e.g. with `?move=N`) the
   *  caller can deep-link to a specific ply. */
  reviewHref?: string;
}

export function EnhancedGameCard({ game, username, reviewHref }: EnhancedGameCardProps): JSX.Element {
  const navigate = useNavigate();
  const playerColor = getPlayerColor(game, username);
  const opponentName = playerColor === 'white' ? game.black : game.white;
  const opponentElo = playerColor === 'white' ? game.blackElo : game.whiteElo;
  const result = getResult(game, playerColor);
  const rs = RESULT_STYLES[result];
  const tcLabel = parseTimeControlLabel(game.pgn);
  const moves = countMovesInPgn(game.pgn);
  const openingName = game.openingId ?? game.eco; // best-effort; OpeningDrilldown resolves richer names

  // Per-game accuracy + blunders/mistakes from annotations.
  let accuracyPct: number | null = null;
  let blunders = 0;
  let mistakes = 0;
  let inaccuracies = 0;
  if (game.fullyAnalyzed && game.annotations && game.annotations.length > 0) {
    let total = 0;
    let accurate = 0;
    for (const ann of game.annotations) {
      if (ann.color !== playerColor) continue;
      total++;
      const cls: string = ann.classification;
      if (cls === 'brilliant' || cls === 'great' || cls === 'good' || cls === 'book') accurate++;
      if (cls === 'blunder') blunders++;
      if (cls === 'mistake') mistakes++;
      if (cls === 'inaccuracy') inaccuracies++;
    }
    if (total > 0) accuracyPct = Math.round((accurate / total) * 100);
  }

  const onClick = (): void => {
    void navigate(reviewHref ?? `/coach/review/${encodeURIComponent(game.id)}`);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border p-3.5 mt-2.5 text-left hover:opacity-80 transition-opacity"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      data-testid="enhanced-game-card"
      aria-label={`Review ${result} vs ${opponentName} on ${game.date}`}
    >
      {/* Top row: opponent + result badge */}
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          {opponentName}
          {opponentElo && (
            <span className="text-[11px] ml-1" style={{ color: 'var(--color-text-muted)' }}>
              {opponentElo}
            </span>
          )}
        </span>
        <span
          className="text-[11px] font-bold px-2.5 py-0.5 rounded-md"
          style={{ color: rs.color, background: rs.bg }}
        >
          {rs.label}
        </span>
      </div>

      {/* Sub row: opening + time-control + date */}
      <div className="flex items-center gap-2 mb-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        {openingName && <span className="truncate">{openingName}</span>}
        {tcLabel && <span className="px-1.5 py-px rounded" style={{ background: 'var(--color-border)' }}>{tcLabel}</span>}
        <span className="ml-auto">{game.date}</span>
      </div>

      {/* Stats + sparkline */}
      <div className="flex items-end justify-between gap-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 flex-1 text-[11px]">
          {accuracyPct !== null && <StatRow label="Accuracy" value={`${accuracyPct}%`} />}
          <StatRow label="Moves" value={`${moves}`} />
          <StatRow label="Blunders" value={`${blunders}`} color={blunders > 0 ? 'var(--color-error)' : undefined} />
          <StatRow label="Mistakes" value={`${mistakes}`} color={mistakes > 0 ? 'var(--color-warning)' : undefined} />
          <StatRow label="Inaccuracies" value={`${inaccuracies}`} color={inaccuracies > 0 ? '#f59e0b' : undefined} />
        </div>
        <EvalSparkline game={game} playerColor={playerColor} />
      </div>
    </button>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="flex justify-between text-[11px] py-0.5">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ color: color ?? 'var(--color-text-muted)' }}>{value}</span>
    </div>
  );
}
