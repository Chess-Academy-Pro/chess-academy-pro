/**
 * RolodexRow components
 * ---------------------
 * One component per row kind on the active card body. Each owns its
 * PLUMBING-01 hook + its destination URL + (for Puzzles) the
 * family-fallback voice fire-and-forget side-effect. They render
 * through a shared `BaseRow` for visual consistency.
 *
 * Per-kind components (instead of a single generic + config table)
 * because React hooks can't be called conditionally — each kind
 * needs to call exactly one progress hook, and only the per-kind
 * component can decide which.
 *
 * Row data contracts (PLUMBING-01):
 *   - Tracked rows return `{ completed, total, loading }` from their
 *     hook. We render "X / Y" with a loading dash while in-flight.
 *   - Puzzles returns `{ count, source, family? }` with three branches:
 *       • exact     → "N" with no chip
 *       • family    → "N" with a "<family> family" chip
 *       • none      → "0" with a "no puzzles yet" nudge
 *   - Placeholder rows (GM Games, Practice variants) return a
 *     `{ status: 'not-tracked-yet' }` shape; we render "—" + the
 *     row-specific nudge copy and skip navigation entirely. Tap is
 *     disabled so the row doesn't promise something it can't deliver.
 *
 * Navigation URLs come from the WO matrix (one row, one canonical
 * destination). PLUMBING-01 wired 6 of 7 destinations to consume
 * `?opening=`; PR-3 also extends `/tactics/drill` to consume it for
 * the Puzzles row.
 */
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Target,
  Crown,
  AlertTriangle,
  Repeat,
  GraduationCap,
  Bot,
  FastForward,
  type LucideIcon,
} from 'lucide-react';
import {
  useOpeningLinesProgress,
  useOpeningPuzzlesProgress,
  useOpeningTrapsProgress,
  useOpeningMistakesProgress,
  useOpeningWalkthroughProgress,
} from '../../hooks/useOpeningProgress';
import { requestPuzzlesFamilyFallbackVoice } from '../../services/puzzlesFamilyFallbackNotify';
import { voiceService } from '../../services/voiceService';
import type { OpeningRecord } from '../../types';
import type { RolodexRowKey } from './rolodexRows';

interface BaseRowProps {
  rowKey: RolodexRowKey;
  Icon: LucideIcon;
  label: string;
  /** Display string for the right-edge counter — "5 / 12", "—", "192", or "…". */
  countText: string;
  /** Optional pill above/after the label (family-fallback or nudge). */
  chip?: string;
  /** Optional sub-text below the label for placeholder rows. */
  nudge?: string;
  onTap?: () => void;
  href?: string;
}

function BaseRow({
  rowKey,
  Icon,
  label,
  countText,
  chip,
  nudge,
  onTap,
  href,
}: BaseRowProps): JSX.Element {
  const tappable = Boolean(onTap || href);
  const content = (
    <>
      <Icon size={20} className="text-theme-text-muted shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-theme-text truncate">
          {label}
          {chip && (
            <span
              className="ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded-md bg-theme-accent/15 text-theme-accent font-semibold align-middle"
              data-testid={`rolodex-row-chip-${rowKey}`}
            >
              {chip}
            </span>
          )}
        </span>
        {nudge && (
          <span className="block text-[11px] text-theme-text-muted italic mt-0.5">
            {nudge}
          </span>
        )}
      </span>
      <span
        className="text-xs text-theme-text-muted tabular-nums"
        data-testid={`rolodex-row-count-${rowKey}`}
      >
        {countText}
      </span>
    </>
  );

  return (
    <li className="border-0 p-0" data-testid={`rolodex-row-${rowKey}`}>
      {tappable ? (
        <button
          type="button"
          onClick={onTap}
          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-theme-surface/60 transition-colors"
          data-testid={`rolodex-row-tap-${rowKey}`}
        >
          {content}
        </button>
      ) : (
        <div className="px-4 py-3 flex items-center gap-3 opacity-70">{content}</div>
      )}
    </li>
  );
}

function formatTracked(completed: number, total: number, loading: boolean): string {
  if (loading) return '…';
  return `${completed} / ${total}`;
}

interface RowProps {
  opening: OpeningRecord;
}

export function TheoryLinesRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  const { completed, total, loading } = useOpeningLinesProgress(opening.id);
  return (
    <BaseRow
      rowKey="theory-lines"
      Icon={BookOpen}
      label="Theory & Lines"
      countText={formatTracked(completed, total, loading)}
      onTap={() => { void navigate(`/openings?opening=${encodeURIComponent(opening.name)}`); }}
    />
  );
}

export function PuzzlesRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  const progress = useOpeningPuzzlesProgress(opening.name);
  const countText = String(progress.count);
  // The destination always carries the FAVORITED opening name, not
  // the family. `/tactics/drill` resolves the family fallback on its
  // own when rendering the filter chip on the destination page. This
  // keeps the URL stable across the user's lifetime ("favorited X"
  // → URL says "X"), even if the family migrates later.
  const onTap = (): void => {
    void navigate(
      `/tactics/drill?opening=${encodeURIComponent(opening.name)}`,
    );
    // Family-fallback voice acknowledgment — fire-and-forget. Only
    // when the row resolved via family-walk (the WO's "no exact
    // puzzles, but here's the family" beat). Never blocks navigation
    // or row render; voice plays whenever the brain answers.
    if (progress.source === 'family' && progress.family) {
      void requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: opening.name,
        family: progress.family,
        count: progress.count,
      }).then((text) => {
        if (text) void voiceService.speakIfFree(text);
      });
    }
  };
  return (
    <BaseRow
      rowKey="puzzles"
      Icon={Target}
      label="Puzzles"
      countText={countText}
      chip={
        progress.source === 'family' && progress.family
          ? `${progress.family} family`
          : undefined
      }
      nudge={progress.source === 'none' ? 'No puzzles tagged for this line yet' : undefined}
      onTap={progress.source === 'none' ? undefined : onTap}
    />
  );
}

export function GMGamesRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  // GM Games has no per-opening progress yet (would need a new
  // modelGameReviews table — see PLUMBING-01 audit A2). Still
  // tappable: the /games page consumes ?eco= so the user lands on
  // their ECO-filtered games even without progress tracking. Until
  // per-opening reviews ship, the count stays "—" with a placeholder
  // nudge.
  return (
    <BaseRow
      rowKey="gm-games"
      Icon={Crown}
      label="GM Games"
      countText="—"
      nudge="Game-by-game progress tracking coming soon"
      onTap={() => { void navigate(`/games?eco=${encodeURIComponent(opening.eco)}`); }}
    />
  );
}

export function TrapsRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  const { completed, total, loading } = useOpeningTrapsProgress(opening.id);
  // Trap-completion tracking is pending per PLUMBING-01 retro —
  // `completed` always renders as 0 today. Total is real
  // (`trapLines.length`). Tappable since `/tactics/opening-traps`
  // consumes ?opening=.
  return (
    <BaseRow
      rowKey="traps"
      Icon={AlertTriangle}
      label="Traps & Pitfalls"
      countText={formatTracked(completed, total, loading)}
      onTap={() => {
        void navigate(`/tactics/opening-traps?opening=${encodeURIComponent(opening.name)}`);
      }}
    />
  );
}

export function BlundersRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  const { completed, total, loading } = useOpeningMistakesProgress(opening.name);
  return (
    <BaseRow
      rowKey="blunders"
      Icon={Repeat}
      label="Your blunders"
      countText={formatTracked(completed, total, loading)}
      nudge={
        !loading && total === 0
          ? 'Play a game to unlock blunder review'
          : undefined
      }
      onTap={() => {
        void navigate(`/tactics/mistakes?opening=${encodeURIComponent(opening.name)}`);
      }}
    />
  );
}

export function WalkthroughRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  const { completed, total, loading } = useOpeningWalkthroughProgress(opening.name);
  return (
    <BaseRow
      rowKey="walkthrough"
      Icon={GraduationCap}
      label="Coached walkthrough"
      countText={formatTracked(completed, total, loading)}
      onTap={() => {
        void navigate(`/coach/teach?opening=${encodeURIComponent(opening.name)}`);
      }}
    />
  );
}

export function PracticeFromStartRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  // No per-opening progress yet (would need a new game-history
  // table). Tappable since /coach/play consumes both opening + mode.
  return (
    <BaseRow
      rowKey="practice-from-start"
      Icon={Bot}
      label="Practice from move 1"
      countText="—"
      nudge="Engine plays the full opening with you"
      onTap={() => {
        void navigate(
          `/coach/play?opening=${encodeURIComponent(opening.name)}&mode=from-start`,
        );
      }}
    />
  );
}

export function PracticeMiddlegameRow({ opening }: RowProps): JSX.Element {
  const navigate = useNavigate();
  return (
    <BaseRow
      rowKey="practice-middlegame"
      Icon={FastForward}
      label="Practice middlegame"
      countText="—"
      nudge="Skip the opening, start from the critical position"
      onTap={() => {
        void navigate(
          `/coach/play?opening=${encodeURIComponent(opening.name)}&mode=middlegame`,
        );
      }}
    />
  );
}
