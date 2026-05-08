import { useNavigate } from 'react-router-dom';
import { Swords, BarChart3, Calendar, Search, MessageCircle, GraduationCap, History, Info, X } from 'lucide-react';
import { useState } from 'react';
import { SmartSearchBar } from '../Search/SmartSearchBar';
import { useSettings } from '../../hooks/useSettings';
import { scaledShadow } from '../../utils/neonColors';
import { logAppAudit } from '../../services/appAuditor';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

// ─── Helpers ────────────────────────────────────────────────────────────────

function neonBorderStyle(rgb: string, gS: number): CSSProperties {
  return {
    borderTop: `1px solid rgba(${rgb}, ${Math.min(1, 0.1 * gS)})`,
    borderRight: `1px solid rgba(${rgb}, ${Math.min(1, 0.1 * gS)})`,
    borderLeft: `2px solid rgba(${rgb}, ${Math.min(1, 0.6 * gS)})`,
    borderBottom: `2px solid rgba(${rgb}, ${Math.min(1, 0.6 * gS)})`,
  };
}

function applyHoverBorder(el: HTMLElement, rgb: string, gS: number): void {
  el.style.borderLeft = `2px solid rgba(${rgb}, ${Math.min(1, 0.85 * gS)})`;
  el.style.borderBottom = `2px solid rgba(${rgb}, ${Math.min(1, 0.85 * gS)})`;
  el.style.borderTop = `1px solid rgba(${rgb}, ${Math.min(1, 0.2 * gS)})`;
  el.style.borderRight = `1px solid rgba(${rgb}, ${Math.min(1, 0.2 * gS)})`;
}

function applyRestBorder(el: HTMLElement, rgb: string, gS: number): void {
  el.style.borderLeft = `2px solid rgba(${rgb}, ${Math.min(1, 0.6 * gS)})`;
  el.style.borderBottom = `2px solid rgba(${rgb}, ${Math.min(1, 0.6 * gS)})`;
  el.style.borderTop = `1px solid rgba(${rgb}, ${Math.min(1, 0.1 * gS)})`;
  el.style.borderRight = `1px solid rgba(${rgb}, ${Math.min(1, 0.1 * gS)})`;
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function CoachHomePage(): JSX.Element {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;

  // Audit-driven (WO-COACH-UNIFY-01 #15): tile taps were silent. A
  // "user went to Coach hub but ended up on Tactics" report now has
  // a trail showing which tile they actually clicked.
  const goTo = (tile: string, path: string) => () => {
    void logAppAudit({
      kind: 'coach-hub-tile-clicked',
      category: 'subsystem',
      source: 'CoachHomePage',
      summary: `tile=${tile} → ${path}`,
    });
    void navigate(path);
  };

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="coach-home-page"
    >
      <h1 className="text-xl font-bold text-center mt-2">
        Coach
      </h1>

      {/* Search */}
      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar placeholder="Ask your coach or say what you want to do..." />
      </div>

      {/* Tile grid — same neon pattern the Dashboard and Tactics page
          use. Play + Learn are the two primary big aspect-square tiles
          with subtitle descriptions; Game Insights / Training Plan /
          Analyse / Chat fill the secondary row. The old "Work with
          Coach" tile was removed — it overlapped with Learn (live
          teach session) and Training Plan (structured plan). */}
      <div className="grid grid-cols-2 gap-3 flex-1 content-start max-w-lg mx-auto w-full">
        <PrimaryTile
          icon={<Swords size={40} className="text-emerald-400" />}
          label="Play with Coach"
          subtitle="Real game vs the engine. Coach narrates each move and helps when you're stuck."
          info="Play a full game against Stockfish (difficulty matches your rating). The coach narrates your moves, calls out tactics you missed, walks you through phase transitions, and offers a hint ladder when you're stuck. Post-game, opens a review walk."
          rgb="52, 211, 153"
          bgClass="bg-emerald-500/10"
          textColorClass="text-emerald-400"
          onClick={goTo('play', '/coach/play')}
          gB={gB}
          gS={gS}
          testId="coach-action-play"
        />
        <PrimaryTile
          icon={<GraduationCap size={40} className="text-cyan-400" />}
          label="Learn with Coach"
          subtitle="Guided lessons — pick a topic and dive in."
          info={
            "Ask the coach to teach you something. Defaults to an animated walkthrough when you say \"teach me [opening]\", but you can also:\n\n• Walk through an opening — moves animate with voice-over\n• Set up specific positions — coach explains the idea\n• Play it out as a game — you take a side, coach plays the other\n• Quiz me on the moves — coach tests recall\n\nJust ask in plain language."
          }
          rgb="6, 182, 212"
          bgClass="bg-cyan-500/10"
          textColorClass="text-cyan-400"
          onClick={goTo('teach', '/coach/teach')}
          gB={gB}
          gS={gS}
          testId="coach-action-teach"
        />

        <SecondaryTile
          icon={<BarChart3 size={28} className="text-violet-400" />}
          label="Game Insights"
          info="Analytics across all your games — accuracy trend, time-management patterns, opening win rates, blunder frequency by phase, and the weaknesses the coach has flagged. Opens the dashboard view, not a chat."
          rgb="139, 92, 246"
          bgClass="bg-violet-500/10"
          textColorClass="text-violet-400"
          onClick={goTo('report', '/coach/report')}
          gB={gB}
          gS={gS}
          testId="coach-action-report"
        />
        <SecondaryTile
          icon={<Calendar size={28} className="text-amber-400" />}
          label="Training Plan"
          info="Coach generates a daily plan based on your weaknesses and recent games — tactics sets, opening drills, endgame practice. You can ask it to adjust the plan in plain language."
          rgb="245, 158, 11"
          bgClass="bg-amber-500/10"
          textColorClass="text-amber-400"
          onClick={goTo('plan', '/coach/plan')}
          gB={gB}
          gS={gS}
          testId="coach-action-plan"
        />
        <SecondaryTile
          icon={<Search size={28} className="text-sky-400" />}
          label="Analyse"
          info={
            "Drop a position, ask the coach to break it down. Stockfish runs the eval, the coach explains it in words: who's better and why, what each side is trying to do, the candidate moves and the trade-offs.\n\nGood for: studying a position from a book, a game you saw online, or a moment from your own game you want to revisit."
          }
          rgb="56, 189, 248"
          bgClass="bg-sky-500/10"
          textColorClass="text-sky-400"
          onClick={goTo('analyse', '/coach/analyse')}
          gB={gB}
          gS={gS}
          testId="coach-action-analyse"
        />
        <SecondaryTile
          icon={<MessageCircle size={28} className="text-rose-400" />}
          label="Chat"
          info="Open-ended chat with the coach. No board required. Ask about openings, principles, study advice, anything chess. Coach has access to Stockfish and the Lichess opening explorer when needed."
          rgb="251, 113, 133"
          bgClass="bg-rose-500/10"
          textColorClass="text-rose-400"
          onClick={goTo('chat', '/coach/chat')}
          gB={gB}
          gS={gS}
          testId="coach-action-chat"
        />
        <SecondaryTile
          icon={<History size={28} className="text-teal-400" />}
          label="Review with Coach"
          info={
            "Pick any of your past games (coach, Lichess imports, Chess.com imports) and walk through it move by move with the coach. Each ply gets a per-position read: what was good, what was missed, what the engine preferred.\n\nGood for: post-game learning on a game that already happened."
          }
          rgb="45, 212, 191"
          bgClass="bg-teal-500/10"
          textColorClass="text-teal-400"
          onClick={goTo('review', '/coach/review')}
          gB={gB}
          gS={gS}
          testId="coach-action-review"
        />
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface TileProps {
  icon: ReactNode;
  label: string;
  subtitle?: string;
  /** Long-form description shown when the user taps the ⓘ button.
   *  Multi-line strings are rendered with line breaks preserved so
   *  bullet lists or paragraph breaks display naturally. */
  info?: string;
  rgb: string;
  bgClass: string;
  textColorClass: string;
  onClick: () => void;
  gB: number;
  gS: number;
  testId: string;
}

/** Small ⓘ button anchored to the top-right corner of a tile. Clicking
 *  it opens a description modal. stopPropagation so it doesn't trigger
 *  the tile's own onClick (which would navigate). */
function InfoButton({ label, info, textColorClass }: { label: string; info: string; textColorClass: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const handleOpen = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    setOpen(true);
  };
  const handleClose = (e: MouseEvent<HTMLElement>): void => {
    e.stopPropagation();
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={`absolute top-1.5 right-1.5 p-1 rounded-full hover:bg-black/20 ${textColorClass}`}
        aria-label={`What does ${label} do?`}
        data-testid={`coach-tile-info-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <Info size={14} />
      </button>
      {open && (
        <div
          onClick={handleClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${label} description`}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-md w-full rounded-2xl p-5 relative"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          >
            <button
              type="button"
              onClick={handleClose}
              className="absolute top-2.5 right-2.5 p-1 rounded-full hover:bg-black/20"
              aria-label="Close description"
            >
              <X size={18} style={{ color: 'var(--color-text-muted)' }} />
            </button>
            <h3 className={`text-base font-bold mb-2 ${textColorClass}`}>{label}</h3>
            <p
              className="text-sm leading-relaxed whitespace-pre-line"
              style={{ color: 'var(--color-text)' }}
            >
              {info}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/** Big aspect-square primary tile. Used for Play + Learn so they're
 *  the visual focus of the hub. Title + subtitle stacked. */
function PrimaryTile({ icon, label, subtitle, info, rgb, bgClass, textColorClass, onClick, gB, gS, testId }: TileProps): JSX.Element {
  const shadow = scaledShadow(rgb, gB);
  const shadowHover = scaledShadow(rgb, Math.min(200, gB * 1.4));
  return (
    <button
      onClick={onClick}
      className={`${bgClass} rounded-2xl flex flex-col items-center justify-center gap-2 px-3 py-4 transition-all duration-200 aspect-square relative`}
      style={{ ...neonBorderStyle(rgb, gS), boxShadow: shadow }}
      onMouseEnter={(e) => { applyHoverBorder(e.currentTarget, rgb, gS); e.currentTarget.style.boxShadow = shadowHover; }}
      onMouseLeave={(e) => { applyRestBorder(e.currentTarget, rgb, gS); e.currentTarget.style.boxShadow = shadow; }}
      data-testid={testId}
    >
      {info && <InfoButton label={label} info={info} textColorClass={textColorClass} />}
      {icon}
      <span className={`text-base font-bold ${textColorClass}`}>{label}</span>
      {subtitle && (
        <span className="text-[11px] text-center leading-snug" style={{ color: 'var(--color-text-muted)' }}>
          {subtitle}
        </span>
      )}
    </button>
  );
}

/** Smaller aspect-square secondary tile — for Game Insights, Training
 *  Plan, Analyse, Chat. Icon + label only, no subtitle. */
function SecondaryTile({ icon, label, info, rgb, bgClass, textColorClass, onClick, gB, gS, testId }: TileProps): JSX.Element {
  const shadow = scaledShadow(rgb, gB);
  const shadowHover = scaledShadow(rgb, Math.min(200, gB * 1.4));
  return (
    <button
      onClick={onClick}
      className={`${bgClass} rounded-2xl flex flex-col items-center justify-center gap-2 py-6 transition-all duration-200 relative`}
      style={{ ...neonBorderStyle(rgb, gS), boxShadow: shadow }}
      onMouseEnter={(e) => { applyHoverBorder(e.currentTarget, rgb, gS); e.currentTarget.style.boxShadow = shadowHover; }}
      onMouseLeave={(e) => { applyRestBorder(e.currentTarget, rgb, gS); e.currentTarget.style.boxShadow = shadow; }}
      data-testid={testId}
    >
      {info && <InfoButton label={label} info={info} textColorClass={textColorClass} />}
      {icon}
      <span className={`text-sm font-bold ${textColorClass}`}>{label}</span>
    </button>
  );
}
