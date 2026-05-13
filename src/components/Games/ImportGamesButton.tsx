/**
 * ImportGamesButton — shared CTA that routes to /games/import.
 *
 * David's audit: Game Insights and From-Your-Games surfaces both
 * told the user to "import some games" but provided no entry point
 * to the import flow. Each surface dropping this component in
 * gives users a one-tap path to the existing import page.
 *
 * Two visual variants:
 *   - 'primary'   — full-width pill, used on empty states. Loud.
 *   - 'compact'   — small inline pill, used on populated states
 *                   (header actions, next to other affordances).
 */
import { useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';

interface ImportGamesButtonProps {
  variant?: 'primary' | 'compact';
  className?: string;
  /** Optional override label. Defaults: "Import games" (compact),
   *  "Import games from Lichess / Chess.com" (primary). */
  label?: string;
}

export function ImportGamesButton({
  variant = 'compact',
  className = '',
  label,
}: ImportGamesButtonProps): JSX.Element {
  const navigate = useNavigate();
  const text =
    label ??
    (variant === 'primary'
      ? 'Import games from Lichess / Chess.com'
      : 'Import games');

  if (variant === 'primary') {
    return (
      <button
        type="button"
        onClick={() => void navigate('/games/import')}
        className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500/15 border-2 border-cyan-500/40 text-cyan-300 text-sm font-semibold hover:bg-cyan-500/25 transition-colors ${className}`}
        data-testid="import-games-cta"
      >
        <Upload size={16} />
        {text}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void navigate('/games/import')}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-xs font-medium hover:bg-cyan-500/25 transition-colors ${className}`}
      data-testid="import-games-cta"
    >
      <Upload size={12} />
      {text}
    </button>
  );
}
