import { MasteryRing } from './MasteryRing';
import { getMasteryPercent, needsReview } from '../../services/openingService';
import type { OpeningRecord } from '../../types';
import { Repeat, AlertCircle, Heart } from 'lucide-react';
import { useStarAnimationStore } from '../../stores/starAnimationStore';
import { getNeonColor, scaledShadow } from '../../utils/neonColors';
import { useSettings } from '../../hooks/useSettings';

interface OpeningCardProps {
  opening: OpeningRecord;
  onClick: () => void;
  onToggleFavorite?: (e: React.MouseEvent) => void;
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return 'Not studied';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function OpeningCard({ opening, onClick, onToggleFavorite }: OpeningCardProps): JSX.Element {
  const mastery = getMasteryPercent(opening);
  const flagged = needsReview(opening);
  const neon = getNeonColor(opening.style);
  const { settings } = useSettings();
  const b = settings.glowBrightness;
  const s = b / 100;
  const triggerStarAnimation = useStarAnimationStore((store) => store.trigger);

  const shadow = scaledShadow(neon.rgb, b);
  const shadowHov = scaledShadow(neon.rgb, Math.min(200, b * 1.4));
  const borderAccent = `rgba(${neon.rgb}, ${Math.min(1, 0.6 * s)})`;
  const borderAccentHov = `rgba(${neon.rgb}, ${Math.min(1, 0.85 * s)})`;
  const borderSubtle = `rgba(${neon.rgb}, ${Math.min(1, 0.1 * s)})`;
  const borderSubtleHov = `rgba(${neon.rgb}, ${Math.min(1, 0.2 * s)})`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="w-full text-left bg-theme-surface rounded-xl p-3.5 transition-all duration-200 group relative cursor-pointer"
      style={{
        borderTop: `1px solid ${borderSubtle}`,
        borderRight: `1px solid ${borderSubtle}`,
        borderLeft: `2px solid ${borderAccent}`,
        borderBottom: `2px solid ${borderAccent}`,
        boxShadow: shadow,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.borderTop = `1px solid ${borderSubtleHov}`;
        el.style.borderRight = `1px solid ${borderSubtleHov}`;
        el.style.borderLeft = `2px solid ${borderAccentHov}`;
        el.style.borderBottom = `2px solid ${borderAccentHov}`;
        el.style.boxShadow = shadowHov;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.borderTop = `1px solid ${borderSubtle}`;
        el.style.borderRight = `1px solid ${borderSubtle}`;
        el.style.borderLeft = `2px solid ${borderAccent}`;
        el.style.borderBottom = `2px solid ${borderAccent}`;
        el.style.boxShadow = shadow;
      }}
      data-testid={`opening-card-${opening.id}`}
    >
      <div className="flex items-center gap-3">
        {/* Mastery ring */}
        <MasteryRing percent={mastery} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-mono text-xs font-semibold ${neon.ecoBadge}`}>{opening.eco}</span>
            <span className="text-sm font-semibold text-theme-text truncate">
              {opening.name}
            </span>
            {flagged && (
              <AlertCircle size={13} className="text-red-500 shrink-0" data-testid="needs-review" />
            )}
          </div>

          {/* Style tag */}
          {opening.style && (
            <span className={`inline-block mt-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded-full ${neon.tagBg} ${neon.tagText}`}>
              {opening.style}
            </span>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-theme-text-muted">
            <span>{formatRelativeDate(opening.lastStudied)}</span>
            {opening.woodpeckerReps > 0 && (
              <span className="flex items-center gap-1">
                <Repeat size={10} />
                {opening.woodpeckerReps} reps
              </span>
            )}
          </div>
        </div>

        {/* Favorite button */}
        {onToggleFavorite && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Fire the star-slide animation only on the false→true
              // edge — unfavoriting doesn't earn the visual.
              if (!opening.isFavorite) {
                const r = e.currentTarget.getBoundingClientRect();
                triggerStarAnimation({
                  sourceRect: { x: r.x, y: r.y, width: r.width, height: r.height },
                  openingName: opening.name,
                  openingColor: opening.color,
                });
              }
              onToggleFavorite(e);
            }}
            className="p-1.5 rounded-lg hover:bg-theme-border/50 transition-colors shrink-0"
            aria-label={opening.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            data-testid={`favorite-toggle-${opening.id}`}
          >
            <Heart
              size={16}
              className={opening.isFavorite ? 'text-red-500 fill-red-500' : 'text-theme-text-muted'}
            />
          </button>
        )}
      </div>
    </div>
  );
}
