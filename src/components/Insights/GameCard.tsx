interface GameCardProps {
  opponentName: string;
  opponentElo: number | null;
  result: 'win' | 'loss' | 'draw';
  accuracy: number | null;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  moves: number;
  cpLoss: number | null;
  date: string;
  onClick?: () => void;
}

const RESULT_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  win: { label: 'WIN', color: 'var(--color-success)', bg: 'color-mix(in srgb, var(--color-success) 10%, transparent)' },
  loss: { label: 'LOSS', color: 'var(--color-error)', bg: 'color-mix(in srgb, var(--color-error) 10%, transparent)' },
  draw: { label: 'DRAW', color: 'var(--color-text-muted)', bg: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)' },
};

export function GameCard({
  opponentName,
  opponentElo,
  result,
  accuracy,
  blunders,
  mistakes,
  inaccuracies,
  moves,
  cpLoss,
  date,
  onClick,
}: GameCardProps): JSX.Element {
  const rs = RESULT_STYLES[result];

  // When the card is interactive, render it as a real <button> so the
  // keyboard activates it (Enter / Space) and screen readers announce
  // it as a button. The non-interactive form stays a <div> so it
  // doesn't pretend to be tappable when it isn't.
  const inner = (
    <>
      <div className="flex justify-between items-center mb-2">
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
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {accuracy !== null && <StatRow label="Accuracy" value={`${accuracy}%`} />}
        <StatRow label="Moves" value={`${moves}`} />
        <StatRow label="Blunders" value={`${blunders}`} color={blunders > 0 ? 'var(--color-error)' : undefined} />
        <StatRow label="Mistakes" value={`${mistakes}`} color={mistakes > 0 ? 'var(--color-warning)' : undefined} />
        <StatRow label="Inaccuracies" value={`${inaccuracies}`} color={inaccuracies > 0 ? '#f59e0b' : undefined} />
        {cpLoss !== null && <StatRow label="Avg CP loss" value={`${cpLoss} cp`} />}
      </div>
      <div className="text-[10px] mt-2" style={{ color: 'var(--color-text-muted)' }}>{date}</div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-xl border p-3.5 mt-2.5 w-full text-left hover:opacity-80 transition-opacity"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
        data-testid="game-card"
        aria-label={`Review ${result} vs ${opponentName}${opponentElo ? ` (${opponentElo})` : ''} on ${date}`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className="rounded-xl border p-3.5 mt-2.5"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      data-testid="game-card"
    >
      {inner}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="flex justify-between text-[11px] py-0.5">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className="font-semibold" style={{ color: color ?? 'var(--color-text-muted)' }}>{value}</span>
    </div>
  );
}
