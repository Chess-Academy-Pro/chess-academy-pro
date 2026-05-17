/**
 * TrainingPlanRolodexPage
 * -----------------------
 * The Training Plan tab. A rolodex of the student's favorited
 * openings split by color — White on the left, Black on the right
 * on desktop; manila folder tabs at the top, single-folder content
 * below on mobile.
 *
 * PR-1 of WO-ROLODEX-UI-01 ships the SCAFFOLDING only — page
 * layout, per-color split, empty state, first-favorite
 * auto-activation, mobile tab default driven by
 * `lastActiveRolodexColor`. The actual `RolodexCard` (peeking tab
 * + 8 rows + flip-forward animation + drag-reorder) lands in
 * PR-2/3/4. Until then, each column with favorites renders a
 * placeholder block showing the count and noting "cards in PR-2".
 *
 * Locked spec (see WO):
 *   - Empty state shows per-color (not a global splash) so a user
 *     with white favorites but no black favorites sees a populated
 *     white column and an empty black column side-by-side.
 *   - First-favorite auto-activation: if a color has favorites but
 *     no `activeOpeningCardId` for that color, the first favorite
 *     (by current sort order) becomes active on mount.
 *   - Active-card / last-folder state lives in `coachMemoryStore`
 *     (persists via Dexie, syncs across devices per the existing
 *     memory-store path).
 *   - This page replaces the prior `CoachSessionPlanPage`
 *     (LLM-generated daily session plan, "Start Session" button).
 *     Dave's call: full deletion — training plan IS the rolodex.
 *
 * Data freshness: favorites are loaded once via `getFavoriteOpenings()`
 * on mount and on browser back-nav (React Router re-mounts the
 * route). PR-5 ships the cross-surface star animation that may
 * require a live-update path; for PR-1, per-mount freshness is
 * sufficient.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { getFavoriteOpenings } from '../../services/openingService';
import type { OpeningRecord } from '../../types';

type RolodexColor = 'white' | 'black';

/** Resolve which card should be at the front of a color's stack.
 *  Prefer the persisted `activeOpeningCardId` for that color when
 *  the referenced opening still exists in the favorites list. Falls
 *  back to the first favorite (default sort) when the persisted id
 *  is stale (e.g. the user unfavorited the previously-active card
 *  elsewhere). Returns `null` only when the color has zero
 *  favorites. */
function resolveActiveId(
  favorites: OpeningRecord[],
  persistedId: string | null,
): string | null {
  if (favorites.length === 0) return null;
  if (persistedId && favorites.some((o) => o.id === persistedId)) {
    return persistedId;
  }
  return favorites[0]?.id ?? null;
}

/** Per-color empty state. Open-folder icon + coach-voice prompt +
 *  single "Browse Openings" CTA. Rendered per-column on desktop and
 *  per-active-folder on mobile, so a user can see a populated White
 *  column next to an empty Black column. */
function RolodexEmptyState({ color }: { color: RolodexColor }): JSX.Element {
  const navigate = useNavigate();
  const colorLabel = color === 'white' ? 'White' : 'Black';
  return (
    <div
      className="flex flex-col items-center justify-center text-center gap-4 py-12 px-4"
      data-testid={`rolodex-empty-state-${color}`}
    >
      <FolderOpen
        size={56}
        className="text-theme-text-muted opacity-60"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <p className="text-sm text-theme-text-muted max-w-xs leading-relaxed">
        No {colorLabel} openings favorited yet. Tap the star on any opening to
        start your training plan.
      </p>
      <button
        type="button"
        onClick={() => void navigate('/openings')}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-accent text-white text-sm font-semibold hover:opacity-90 transition-opacity"
        data-testid={`rolodex-empty-cta-${color}`}
      >
        <Sparkles size={16} aria-hidden="true" />
        Browse Openings
      </button>
    </div>
  );
}

/** Placeholder for the card stack itself. Renders only the
 *  active card id + favorites count, with a labeled "PR-2"
 *  marker. Replaced wholesale by `<RolodexCardStack />` in PR-2.
 *  Keeping it visually distinct (dashed border + muted) so a
 *  reviewer can't mistake it for the final card UI. */
function RolodexStackPlaceholder({
  color,
  favorites,
  activeId,
}: {
  color: RolodexColor;
  favorites: OpeningRecord[];
  activeId: string | null;
}): JSX.Element {
  const activeOpening = favorites.find((o) => o.id === activeId);
  const colorLabel = color === 'white' ? 'White' : 'Black';
  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-2xl border-2 border-dashed border-theme-border bg-theme-surface/30"
      data-testid={`rolodex-stack-placeholder-${color}`}
    >
      <p className="text-xs uppercase tracking-wide text-theme-text-muted font-semibold">
        {colorLabel} repertoire · {favorites.length} favorite
        {favorites.length === 1 ? '' : 's'}
      </p>
      {activeOpening && (
        <p
          className="text-base text-theme-text font-semibold"
          data-testid={`rolodex-active-card-name-${color}`}
        >
          {activeOpening.name}
        </p>
      )}
      <p className="text-xs text-theme-text-muted italic">
        Card stack with peeking tabs lands in PR-2. The 8-row content + deep
        links land in PR-3.
      </p>
    </div>
  );
}

export function TrainingPlanRolodexPage(): JSX.Element {
  const [favorites, setFavorites] = useState<OpeningRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  const persisted = useCoachMemoryStore((s) => s.activeOpeningCardId);
  const lastActiveColor = useCoachMemoryStore((s) => s.lastActiveRolodexColor);
  const setActiveOpeningCard = useCoachMemoryStore((s) => s.setActiveOpeningCard);

  // Mobile manila tab — defaults to last-active color, falls back to
  // 'white' on a fresh user with no rolodex history. Hoisted into
  // local state so tab switches don't bump `lastActiveRolodexColor`
  // until the user actually interacts with a card (PR-2).
  const [mobileFolder, setMobileFolder] = useState<RolodexColor>(lastActiveColor ?? 'white');

  // Load favorites once on mount. Re-mounts on browser back-nav from
  // a destination tool, so a user who favorited via /openings sees
  // the new card the moment they tap back to /coach/plan. PR-5 may
  // add a live-update path for in-page favoriting; not needed here.
  useEffect(() => {
    const flag = { cancelled: false };
    void (async () => {
      const rows = await getFavoriteOpenings();
      if (flag.cancelled) return;
      setFavorites(rows);
      setLoaded(true);
    })();
    return () => {
      flag.cancelled = true;
    };
  }, []);

  const white = useMemo(
    () => favorites.filter((o) => o.color === 'white'),
    [favorites],
  );
  const black = useMemo(
    () => favorites.filter((o) => o.color === 'black'),
    [favorites],
  );

  const resolvedWhiteActive = useMemo(
    () => resolveActiveId(white, persisted.white),
    [white, persisted.white],
  );
  const resolvedBlackActive = useMemo(
    () => resolveActiveId(black, persisted.black),
    [black, persisted.black],
  );

  // First-favorite auto-activate: if the resolver landed on a
  // different id than persisted (favorites loaded, persisted was
  // null OR stale), commit the resolution to the memory store so
  // PR-2 cards have a stable activeId to render against. Skip when
  // resolution matches persisted to avoid a redundant set on every
  // mount.
  useEffect(() => {
    if (!loaded) return;
    if (resolvedWhiteActive !== persisted.white) {
      setActiveOpeningCard('white', resolvedWhiteActive);
    }
    if (resolvedBlackActive !== persisted.black) {
      setActiveOpeningCard('black', resolvedBlackActive);
    }
  }, [
    loaded,
    resolvedWhiteActive,
    resolvedBlackActive,
    persisted.white,
    persisted.black,
    setActiveOpeningCard,
  ]);

  const renderColumn = useCallback(
    (color: RolodexColor): JSX.Element => {
      const list = color === 'white' ? white : black;
      const activeId = color === 'white' ? resolvedWhiteActive : resolvedBlackActive;
      if (!loaded) {
        return (
          <div
            className="flex items-center justify-center py-12 text-sm text-theme-text-muted"
            data-testid={`rolodex-loading-${color}`}
          >
            Loading favorites…
          </div>
        );
      }
      if (list.length === 0) {
        return <RolodexEmptyState color={color} />;
      }
      return (
        <RolodexStackPlaceholder color={color} favorites={list} activeId={activeId} />
      );
    },
    [loaded, white, black, resolvedWhiteActive, resolvedBlackActive],
  );

  const mobileTabClass = (color: RolodexColor): string => {
    const isActive = mobileFolder === color;
    const base =
      'flex-1 px-4 pt-3 pb-2 text-sm font-semibold rounded-t-xl border-2 border-b-0 transition-all';
    if (isActive) {
      return `${base} bg-theme-surface border-theme-border text-theme-text -mb-px z-10 relative`;
    }
    return `${base} bg-theme-surface/40 border-transparent text-theme-text-muted hover:text-theme-text`;
  };

  return (
    <div
      className="flex flex-col p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 max-w-6xl mx-auto w-full"
      data-testid="training-plan-rolodex-page"
    >
      <h1 className="text-2xl font-bold text-theme-text">Training Plan</h1>
      <p className="text-sm text-theme-text-muted mt-1">
        Your favorited openings, side-by-side.
      </p>

      {/* Mobile: manila folder tabs */}
      <div
        className="md:hidden flex gap-1 mt-6 border-b-2 border-theme-border"
        role="tablist"
        aria-label="Rolodex color folders"
        data-testid="rolodex-folder-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mobileFolder === 'white'}
          aria-controls="rolodex-mobile-panel"
          onClick={() => setMobileFolder('white')}
          className={mobileTabClass('white')}
          data-testid="rolodex-folder-tab-white"
        >
          White ({white.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileFolder === 'black'}
          aria-controls="rolodex-mobile-panel"
          onClick={() => setMobileFolder('black')}
          className={mobileTabClass('black')}
          data-testid="rolodex-folder-tab-black"
        >
          Black ({black.length})
        </button>
      </div>

      {/* Mobile: single active folder */}
      <div
        className="md:hidden flex-1 mt-0 p-4 bg-theme-surface rounded-b-2xl border-2 border-t-0 border-theme-border"
        role="tabpanel"
        id="rolodex-mobile-panel"
        aria-label={`${mobileFolder === 'white' ? 'White' : 'Black'} repertoire`}
        data-testid="rolodex-mobile-panel"
      >
        {renderColumn(mobileFolder)}
      </div>

      {/* Desktop: two columns side-by-side */}
      <div className="hidden md:grid md:grid-cols-2 md:gap-6 mt-8 flex-1">
        <section
          className="flex flex-col"
          aria-label="White repertoire"
          data-testid="rolodex-white-column"
        >
          <h2 className="text-lg font-semibold text-theme-text mb-3">
            White ({white.length})
          </h2>
          {renderColumn('white')}
        </section>
        <section
          className="flex flex-col"
          aria-label="Black repertoire"
          data-testid="rolodex-black-column"
        >
          <h2 className="text-lg font-semibold text-theme-text mb-3">
            Black ({black.length})
          </h2>
          {renderColumn('black')}
        </section>
      </div>
    </div>
  );
}
