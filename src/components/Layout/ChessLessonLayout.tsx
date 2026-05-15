// ChessLessonLayout — the canonical wrapper for any "lesson with a board" screen
// (walkthroughs, coach dynamic sessions, middlegame studies, etc).
//
// Why this exists:
//   - Every lesson screen needs the same vertical rhythm: header → board →
//     fixed gap → controls → optional below-controls content.
//   - Buttons must stay in the thumb-friendly zone above the mobile bottom nav.
//   - Safe-area insets (notch, home indicator) must be respected.
//   - The board must not push the controls off-screen on short phones, so we
//     cap board height responsively.
//
// Use this for new lesson screens. It does not change any existing screen — it
// is opt-in at the call site.

import { type ReactNode } from 'react';

export interface ChessLessonLayoutProps {
  /** Top bar — back button, title, etc. Stays at the top of the viewport. */
  header?: ReactNode;
  /** Board content. Auto-centered and capped in height to leave room for controls. */
  board: ReactNode;
  /** Optional content rendered between the header and the board (e.g. progress bar). */
  aboveBoard?: ReactNode;
  /** Optional content rendered between the board and the controls (e.g. engine lines). */
  belowBoard?: ReactNode;
  /** Control row — Next/Prev/Flip/Ask/Voice. Always rendered with a fixed gap below the board. */
  controls: ReactNode;
  /** Optional content rendered below the controls (e.g. annotation card). */
  belowControls?: ReactNode;
  /** Whether to add bottom padding to clear the mobile bottom nav. Defaults to true. */
  reserveBottomNav?: boolean;
  /** Test id override. */
  'data-testid'?: string;
}

/** Pixel offset reserved at the bottom of the page on mobile to clear the nav bar.
 *  Mobile nav is `py-2 pb-safe` (~2.5rem icons + 1rem padding + safe-area). */
const MOBILE_NAV_CLEARANCE_CLASS =
  'pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-4';

/** Fixed gap between the board and the controls. Generous on purpose — the
 *  buttons must never feel cramped or risk being tapped while picking a piece. */
const BOARD_TO_CONTROLS_GAP = 'mt-6';

export function ChessLessonLayout({
  header,
  board,
  aboveBoard,
  belowBoard,
  controls,
  belowControls,
  reserveBottomNav = true,
  'data-testid': testId = 'chess-lesson-layout',
}: ChessLessonLayoutProps): JSX.Element {
  return (
    <div
      className={`flex flex-col flex-1 min-h-0 overflow-hidden ${
        reserveBottomNav ? MOBILE_NAV_CLEARANCE_CLASS : ''
      }`}
      data-testid={testId}
    >
      {header && (
        <div className="flex-shrink-0" data-testid="chess-lesson-header">
          {header}
        </div>
      )}

      {aboveBoard && (
        <div className="flex-shrink-0" data-testid="chess-lesson-above-board">
          {aboveBoard}
        </div>
      )}

      {/* Scrollable middle column — board + controls + below content stay grouped.
          On mobile, capping the board's height keeps controls visible without
          requiring the user to scroll the lesson content. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[440px] flex-col items-stretch px-4 pt-2">
          {/* Board slot. The board itself (e.g. react-chessboard) handles its
              own aspect ratio; we cap the wrapper height so the controls
              never get pushed below the fold on short viewports. */}
          <div
            className="w-full self-center max-h-[min(60vh,440px)]"
            data-testid="chess-lesson-board"
          >
            {board}
          </div>

          {belowBoard && (
            <div
              className="flex-shrink-0 mt-2"
              data-testid="chess-lesson-below-board"
            >
              {belowBoard}
            </div>
          )}

          <div
            className={`flex-shrink-0 ${BOARD_TO_CONTROLS_GAP}`}
            data-testid="chess-lesson-controls"
          >
            {controls}
          </div>

          {belowControls && (
            <div
              className="flex-shrink-0 mt-4"
              data-testid="chess-lesson-below-controls"
            >
              {belowControls}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
