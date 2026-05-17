/**
 * RolodexCard
 * -----------
 * A single card in a Training Plan rolodex stack. Two visual modes:
 *
 *   - **Active** (front of stack): full card body — opening name header
 *     plus the 8 training-material rows (Theory & Lines, Puzzles, GM
 *     Games, Traps, Your blunders, Coached walkthrough, Practice from
 *     move 1, Practice middlegame). PR-2 ships the rows STATIC — labels
 *     + icons + "—" placeholder. PR-3 wires real counts and deep-link
 *     navigation from the PLUMBING-01 hooks.
 *   - **Stacked** (peeking behind): a single-row "tab" showing just the
 *     ECO code + opening name. Tap to bring this card to the front.
 *
 * Animation is driven by Framer Motion's `layout` prop on the wrapping
 * `motion.div`: when the stack order changes (a peeking tab is tapped,
 * a card becomes active), Framer animates the position swap with a
 * weighted spring transition. The cards are rendered as sibling motion
 * elements under a `LayoutGroup` in `RolodexCardStack`, which is what
 * synchronizes the simultaneous moves.
 *
 * No 3D transforms (avoids the iOS Safari `transform-style: preserve-3d`
 * jank). The visual is a 2D shuffle with hover-lift on inactive cards
 * to telegraph clickability and a shadow bloom on the active card.
 *
 * Long-press / drag-reorder is PR-4 — the component accepts an optional
 * `onLongPress` callback but no gesture wiring lands here.
 */
import { motion } from 'framer-motion';
import {
  TheoryLinesRow,
  PuzzlesRow,
  GMGamesRow,
  TrapsRow,
  BlundersRow,
  WalkthroughRow,
  PracticeFromStartRow,
  PracticeMiddlegameRow,
} from './RolodexRow';
import type { OpeningRecord } from '../../types';

interface RolodexCardProps {
  opening: OpeningRecord;
  isActive: boolean;
  /** Called when the user activates this card. Active card receives
   *  no-op clicks on its own tab/header (it's already active); back
   *  cards activate on tab tap. */
  onActivate: () => void;
}

export function RolodexCard({ opening, isActive, onActivate }: RolodexCardProps): JSX.Element {

  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 280, damping: 26 }}
      className={`border-2 rounded-2xl overflow-hidden bg-theme-surface ${
        isActive
          ? 'border-theme-accent shadow-lg shadow-theme-accent/10'
          : 'border-theme-border'
      }`}
      data-testid={`rolodex-card-${opening.id}`}
      data-active={isActive ? 'true' : 'false'}
      whileHover={isActive ? undefined : { y: -2, transition: { duration: 0.12 } }}
    >
      {isActive ? (
        <div role="group" aria-label={`${opening.name} — training material`}>
          <header
            className="px-4 py-3 flex items-center gap-3 bg-theme-accent/5 border-b border-theme-border"
            data-testid={`rolodex-card-header-${opening.id}`}
          >
            <span className="text-xs uppercase tracking-wide text-theme-text-muted font-semibold">
              {opening.eco}
            </span>
            <h3 className="font-bold text-base text-theme-text flex-1 min-w-0 truncate">
              {opening.name}
            </h3>
          </header>
          <ul className="divide-y divide-theme-border" data-testid={`rolodex-card-rows-${opening.id}`}>
            <TheoryLinesRow opening={opening} />
            <PuzzlesRow opening={opening} />
            <GMGamesRow opening={opening} />
            <TrapsRow opening={opening} />
            <BlundersRow opening={opening} />
            <WalkthroughRow opening={opening} />
            <PracticeFromStartRow opening={opening} />
            <PracticeMiddlegameRow opening={opening} />
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={onActivate}
          aria-label={`Open ${opening.name} card`}
          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-theme-surface/80 transition-colors"
          data-testid={`rolodex-card-tab-${opening.id}`}
        >
          <span className="text-xs uppercase tracking-wide text-theme-text-muted font-semibold">
            {opening.eco}
          </span>
          <span className="font-semibold text-sm text-theme-text flex-1 min-w-0 truncate">
            {opening.name}
          </span>
        </button>
      )}
    </motion.div>
  );
}
