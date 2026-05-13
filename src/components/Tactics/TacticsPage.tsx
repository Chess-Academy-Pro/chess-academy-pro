import { useNavigate } from 'react-router-dom';
import { Eye, AlertTriangle, Shuffle, Trophy, Wrench, Crosshair } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { SmartSearchBar } from '../Search/SmartSearchBar';
import { THEME_MAP } from '../../services/puzzleService';
import { useSettings } from '../../hooks/useSettings';
import { scaledShadow } from '../../utils/neonColors';

// ─── Theme Category Definitions ──────────────────────────────────────────

interface ThemeCard {
  label: string;
  themes: string[];
  emoji: string;
  color: string;
  bgColor: string;
  rgb: string;
}

const THEME_STYLE: Record<string, { emoji: string; color: string; bgColor: string; rgb: string }> = {
  'Forks':              { emoji: '\u2694\uFE0F', color: 'text-red-400', bgColor: 'bg-red-500/10', rgb: '239, 68, 68' },
  'Pins & Skewers':     { emoji: '\uD83D\uDCCC', color: 'text-sky-400', bgColor: 'bg-sky-500/10', rgb: '56, 189, 248' },
  'Discovered Attacks':  { emoji: '\uD83D\uDCA5', color: 'text-orange-400', bgColor: 'bg-orange-500/10', rgb: '249, 115, 22' },
  'Back Rank Mates':     { emoji: '\uD83C\uDFF0', color: 'text-purple-400', bgColor: 'bg-purple-500/10', rgb: '168, 85, 247' },
  'Sacrifices':          { emoji: '\uD83D\uDD25', color: 'text-amber-400', bgColor: 'bg-amber-500/10', rgb: '245, 158, 11' },
  'Deflection & Decoy':  { emoji: '\u21AA\uFE0F', color: 'text-cyan-400', bgColor: 'bg-cyan-500/10', rgb: '6, 182, 212' },
  'Zugzwang':            { emoji: '\u26A1', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10', rgb: '250, 204, 21' },
  'Endgame Technique':   { emoji: '\uD83C\uDFC1', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', rgb: '52, 211, 153' },
  'Opening Traps':       { emoji: '\uD83E\uDEA4', color: 'text-rose-400', bgColor: 'bg-rose-500/10', rgb: '251, 113, 133' },
  'Mating Nets':         { emoji: '\uD83D\uDC51', color: 'text-indigo-400', bgColor: 'bg-indigo-500/10', rgb: '99, 102, 241' },
};

const THEME_CARDS: ThemeCard[] = Object.entries(THEME_MAP).map(([label, themes]) => {
  const config = THEME_STYLE[label] ?? { emoji: '\uD83C\uDFAF', color: 'text-gray-400', bgColor: 'bg-gray-500/10', rgb: '156, 163, 175' };
  return { label, themes, ...config };
});

// ─── Main Page ──────────────────────────────────────────────────────────────

// Fixed-position buttons with their own rgb values
const FIXED_BUTTONS: { key: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; route: string; color: string; bgColor: string; rgb: string; colSpan: boolean; py: string; iconSize: number; textSize: string; state?: Record<string, unknown> }[] = [
  { key: 'spot', label: 'My Profile', icon: Eye, route: '/tactics/profile', color: 'text-amber-400', bgColor: 'bg-amber-500/10', rgb: '245, 158, 11', colSpan: true, py: 'py-8', iconSize: 40, textSize: 'text-lg' },
  { key: 'daily', label: 'Daily Training', icon: Trophy, route: '/tactics/classic', color: 'text-violet-400', bgColor: 'bg-violet-500/10', rgb: '139, 92, 246', colSpan: false, py: 'py-6', iconSize: 28, textSize: 'text-sm' },
  { key: 'setup', label: 'Setup Trainer', icon: Wrench, route: '/tactics/setup', color: 'text-teal-400', bgColor: 'bg-teal-500/10', rgb: '45, 212, 191', colSpan: false, py: 'py-6', iconSize: 28, textSize: 'text-sm' },
  { key: 'random-mix', label: 'Random Mix', icon: Shuffle, route: '/tactics/drill', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', rgb: '52, 211, 153', colSpan: true, py: 'py-6', iconSize: 32, textSize: 'text-base', state: { filterThemes: ['fork', 'pin', 'skewer', 'discoveredAttack', 'backRankMate', 'sacrifice', 'deflection'] } },
];

const BOTTOM_BUTTONS: { key: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; route: string; color: string; bgColor: string; rgb: string }[] = [
  { key: 'my-weaknesses', label: 'My Weaknesses', icon: Crosshair, route: '/tactics/weakness-themes', color: 'text-rose-400', bgColor: 'bg-rose-500/10', rgb: '244, 63, 94' },
  { key: 'my mistakes', label: 'My Mistakes', icon: AlertTriangle, route: '/tactics/mistakes', color: 'text-red-400', bgColor: 'bg-red-500/10', rgb: '239, 68, 68' },
];

function neonBorderStyle(rgb: string, gS: number): React.CSSProperties {
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

export function TacticsPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const navigate = useNavigate();
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;

  if (!activeProfile) return <></>;

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="tactics-page"
    >
      <h1 className="text-xl font-bold text-center mt-2">
        Tactical Training
      </h1>

      {/* Search */}
      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar placeholder="Search tactics, games, openings..." />
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 flex-1 content-start max-w-lg mx-auto w-full">
        {/* Fixed buttons (Profile, Daily, Setup, Random Mix) */}
        {FIXED_BUTTONS.map((btn) => {
          const Icon = btn.icon;
          const shadow = scaledShadow(btn.rgb, gB);
          const shadowHover = scaledShadow(btn.rgb, Math.min(200, gB * 1.4));
          return (
            <button
              key={btn.key}
              onClick={() => void navigate(btn.route, btn.state ? { state: btn.state } : undefined)}
              className={`${btn.colSpan ? 'col-span-2' : ''} ${btn.py} ${btn.bgColor} rounded-2xl flex flex-col items-center justify-center gap-3 transition-all duration-200`}
              style={{ ...neonBorderStyle(btn.rgb, gS), boxShadow: shadow }}
              onMouseEnter={(e) => { applyHoverBorder(e.currentTarget, btn.rgb, gS); e.currentTarget.style.boxShadow = shadowHover; }}
              onMouseLeave={(e) => { applyRestBorder(e.currentTarget, btn.rgb, gS); e.currentTarget.style.boxShadow = shadow; }}
              data-testid={`section-${btn.key}`}
            >
              <Icon size={btn.iconSize} className={btn.color} />
              <span className={`${btn.textSize} font-bold ${btn.color}`}>{btn.label}</span>
            </button>
          );
        })}

        {/* Individual tactic categories */}
        {THEME_CARDS.map((card) => {
          const shadow = scaledShadow(card.rgb, gB);
          const shadowHover = scaledShadow(card.rgb, Math.min(200, gB * 1.4));
          // 'Opening Traps' was a stale theme-filter pipe into the
          // generic drill page — wiped per the user's morning request:
          // "Wipe that tab clean / hide the data. Organize by opening.
          // Separate white and black." Now routes to the dedicated
          // /tactics/opening-traps surface (family-grouped + W/B split,
          // mined from the 625 opening + tactical puzzles in the local
          // Lichess corpus).
          const onClick =
            card.label === 'Opening Traps'
              ? () => void navigate('/tactics/opening-traps')
              : () => void navigate('/tactics/drill', { state: { filterThemes: card.themes } });
          return (
            <button
              key={card.label}
              onClick={onClick}
              className={`${card.bgColor} rounded-2xl flex flex-col items-center justify-center gap-2 transition-all duration-200 aspect-square`}
              style={{ ...neonBorderStyle(card.rgb, gS), boxShadow: shadow }}
              onMouseEnter={(e) => { applyHoverBorder(e.currentTarget, card.rgb, gS); e.currentTarget.style.boxShadow = shadowHover; }}
              onMouseLeave={(e) => { applyRestBorder(e.currentTarget, card.rgb, gS); e.currentTarget.style.boxShadow = shadow; }}
              data-testid={`section-${card.label.toLowerCase()}`}
            >
              <span className="text-2xl">{card.emoji}</span>
              <span className={`text-sm font-bold ${card.color} text-center px-2 leading-tight`}>{card.label}</span>
            </button>
          );
        })}

        {/* Bottom full-width buttons (Weaknesses, Mistakes) */}
        {BOTTOM_BUTTONS.map((btn) => {
          const Icon = btn.icon;
          const shadow = scaledShadow(btn.rgb, gB);
          const shadowHover = scaledShadow(btn.rgb, Math.min(200, gB * 1.4));
          return (
            <button
              key={btn.key}
              onClick={() => void navigate(btn.route)}
              className={`col-span-2 py-6 ${btn.bgColor} rounded-2xl flex flex-col items-center justify-center gap-3 transition-all duration-200`}
              style={{ ...neonBorderStyle(btn.rgb, gS), boxShadow: shadow }}
              onMouseEnter={(e) => { applyHoverBorder(e.currentTarget, btn.rgb, gS); e.currentTarget.style.boxShadow = shadowHover; }}
              onMouseLeave={(e) => { applyRestBorder(e.currentTarget, btn.rgb, gS); e.currentTarget.style.boxShadow = shadow; }}
              data-testid={`section-${btn.key}`}
            >
              <Icon size={32} className={btn.color} />
              <span className={`text-base font-bold ${btn.color}`}>{btn.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
