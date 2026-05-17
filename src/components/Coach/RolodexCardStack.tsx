/**
 * RolodexCardStack
 * ----------------
 * Renders one color's favorited openings as a flip-able, drag-
 * reorderable card stack. Back cards (everything that isn't active)
 * sit above the active card as collapsed "tabs" showing the
 * opening's ECO + name; the active card sits at the bottom of the
 * visual stack with its full body (header + 8 training rows)
 * extended.
 *
 * Why back-on-top, active-on-bottom: matches the physical-rolodex
 * mental model — you flip THROUGH the deck by tapping a card behind
 * the one currently in front. Tap → that card slides into the active
 * position; the previously-active card slots back into the tab list.
 *
 * Two gestures share the card-tab targets:
 *   - Short tap → activate (flip-forward). Wired through the
 *     existing `onActivate` callback.
 *   - Long-press (>= 250 ms) → drag-reorder. dnd-kit's
 *     PointerSensor.activationConstraint.delay disambiguates from
 *     the tap. While dragging, the rest of the stack shifts in
 *     real time via Framer Motion's `layout` prop on each card.
 *
 * On drag-end, the new id sequence is handed to `onReorder` (page
 * persists via `setRolodexOrder`). The reordered ids include ALL
 * cards in the color, render order = front-of-stack last.
 *
 * Stable LayoutGroup id (`rolodex-stack-${color}`) scopes Framer's
 * layout tracking to a single column — important because the page
 * renders both the desktop and mobile panels at all times, so
 * without scoping the same card id would collide across panels.
 *
 * Accessibility: dnd-kit's KeyboardSensor wires keyboard reorder +
 * screen-reader announcements automatically. The card's tab button
 * still owns its own `aria-label` ("Open <name> card") for the tap
 * affordance.
 */
import { useMemo } from 'react';
import { LayoutGroup } from 'framer-motion';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RolodexCard } from './RolodexCard';
import type { OpeningRecord } from '../../types';

interface RolodexCardStackProps {
  color: 'white' | 'black';
  favorites: OpeningRecord[];
  /** The id of the card currently at the front of the stack. Null
   *  shouldn't happen in practice — the stack is only rendered when
   *  `favorites.length > 0` and the page guarantees first-favorite
   *  auto-activation — but treated defensively (renders the first
   *  favorite as active). */
  activeId: string | null;
  /** Called when the user taps a back card's tab. The page wires
   *  this to `setActiveOpeningCard(color, id)` in the memory store. */
  onActivate: (openingId: string) => void;
  /** Called when the user finishes a drag-reorder with a new
   *  sequence of opening ids. The page wires this to
   *  `setRolodexOrder(color, ids)`. Identity-stable order: the
   *  caller persists exactly what's passed (no resorting). */
  onReorder: (orderedIds: string[]) => void;
}

interface SortableCardProps {
  opening: OpeningRecord;
  isActive: boolean;
  onActivate: () => void;
}

function SortableCard({ opening, isActive, onActivate }: SortableCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: opening.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`rolodex-sortable-${opening.id}`}
      {...attributes}
      {...listeners}
    >
      <RolodexCard opening={opening} isActive={isActive} onActivate={onActivate} />
    </div>
  );
}

export function RolodexCardStack({
  color,
  favorites,
  activeId,
  onActivate,
  onReorder,
}: RolodexCardStackProps): JSX.Element {
  const resolvedActiveId = useMemo<string | null>(() => {
    if (favorites.length === 0) return null;
    if (activeId && favorites.some((o) => o.id === activeId)) return activeId;
    return favorites[0]?.id ?? null;
  }, [favorites, activeId]);

  // Render order: back cards first (least-prominent), active card
  // last (front of visual stack). The favorites array's incoming
  // order is the user-defined sequence (the page already reconciled
  // it); we just hoist the active card to the end.
  const orderedCards = useMemo(() => {
    if (favorites.length === 0) return favorites;
    const back = favorites.filter((o) => o.id !== resolvedActiveId);
    const active = favorites.find((o) => o.id === resolvedActiveId);
    return active ? [...back, active] : favorites;
  }, [favorites, resolvedActiveId]);

  // The Sortable context needs the items in a STABLE-IDENTITY order
  // that matches the user's intent for the underlying ordering. We
  // use `favorites` directly (the page-reconciled list, NOT the
  // visual back-then-active ordering) so a drag-reorder reads as
  // "the user shuffled their repertoire," not "the user moved a
  // card relative to whatever was currently active."
  const sortableIds = useMemo(() => favorites.map((o) => o.id), [favorites]);

  // Long-press to drag: 250 ms delay distinguishes from a short tap
  // that fires `onActivate`. Tolerance allows minor finger drift
  // during the hold without canceling activation.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = favorites.findIndex((o) => o.id === active.id);
    const newIndex = favorites.findIndex((o) => o.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = [...favorites];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    onReorder(next.map((o) => o.id));
  };

  return (
    <LayoutGroup id={`rolodex-stack-${color}`}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div
            className="flex flex-col gap-1"
            data-testid={`rolodex-card-stack-${color}`}
          >
            {orderedCards.map((card) => (
              <SortableCard
                key={card.id}
                opening={card}
                isActive={card.id === resolvedActiveId}
                onActivate={() => onActivate(card.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </LayoutGroup>
  );
}
