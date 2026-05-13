// Opening Traps — Tactics → Opening Traps tab
// --------------------------------------------
// Family-grouped picker mining the local Lichess puzzle DB for
// `opening` + tactical-outcome puzzles. Per-family puzzle list split
// into White / Black (the COLOR YOU PLAY = the punishing side). Tap a
// puzzle → playable lesson with voice intro.
//
// Layout follows the app's standard design language: title at top,
// SmartSearchBar below it, 2-column grid of neon-bordered tap targets
// color-coded by opening type (CLAUDE.md "UI Design Language" + the
// /tactics page pattern).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowLeft, ChevronRight, Target, Flame } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { SmartSearchBar } from '../Search/SmartSearchBar';
import { useSettings } from '../../hooks/useSettings';
import { useAppStore } from '../../stores/appStore';
import { scaledShadow } from '../../utils/neonColors';
import { createStreamingSpeaker } from '../../services/streamingSpeaker';
import { voiceService } from '../../services/voiceService';
import { ScrollHintBar } from '../Common/ScrollHintBar';
import { updatePuzzleRating } from '../../services/puzzleService';
import { reconstructPathToFen } from '../../services/openingWalkthroughService';
import {
  groupByOpeningFamily,
  familyLabel,
  openingFamily,
  type OpeningBlunderPuzzle,
  type OpeningBlunderFamily,
} from '../../services/openingBlunderService';

/** Difficulty band around the user's puzzle rating. Puzzles inside this
 *  band surface first; the rest are still reachable below the fold. */
const ADAPTIVE_BAND = 400;

/** Sort by closeness to the user's rating, then by popularity. */
function adaptiveSort(
  list: OpeningBlunderPuzzle[],
  userRating: number,
): OpeningBlunderPuzzle[] {
  return [...list].sort((a, b) => {
    const da = Math.abs(a.rating - userRating);
    const db = Math.abs(b.rating - userRating);
    if (da !== db) return da - db;
    return b.popularity - a.popularity;
  });
}

// ─── Per-opening palette ─────────────────────────────────────────────────────
// Colour-code each family slug. Substring match so sub-variations
// inherit the parent's hue (e.g. sicilian_defense_najdorf still scores
// Sicilian red). Order matters — first match wins.

interface FamilyPalette {
  match: RegExp;
  color: string;
  bgColor: string;
  rgb: string;
}

const PALETTE: FamilyPalette[] = [
  // Sharp / aggressive openings — red family
  { match: /sicilian/, color: 'text-red-400', bgColor: 'bg-red-500/10', rgb: '239, 68, 68' },
  { match: /(ruy|spanish)/, color: 'text-rose-400', bgColor: 'bg-rose-500/10', rgb: '244, 63, 94' },
  // Gambits — fire amber
  { match: /(gambit|englund)/, color: 'text-amber-400', bgColor: 'bg-amber-500/10', rgb: '245, 158, 11' },
  // Classical 1.e4 e5 — warm
  { match: /italian/, color: 'text-orange-400', bgColor: 'bg-orange-500/10', rgb: '249, 115, 22' },
  { match: /(vienna|center_game)/, color: 'text-yellow-400', bgColor: 'bg-yellow-500/10', rgb: '250, 204, 21' },
  { match: /two_knights/, color: 'text-orange-400', bgColor: 'bg-orange-500/10', rgb: '251, 146, 60' },
  // Solid / restrained — blues / cyans
  { match: /french/, color: 'text-blue-400', bgColor: 'bg-blue-500/10', rgb: '96, 165, 250' },
  { match: /caro/, color: 'text-cyan-400', bgColor: 'bg-cyan-500/10', rgb: '34, 211, 238' },
  { match: /scandinavian/, color: 'text-sky-400', bgColor: 'bg-sky-500/10', rgb: '56, 189, 248' },
  { match: /alekhine/, color: 'text-pink-400', bgColor: 'bg-pink-500/10', rgb: '244, 114, 182' },
  { match: /pirc/, color: 'text-teal-400', bgColor: 'bg-teal-500/10', rgb: '45, 212, 191' },
  { match: /modern/, color: 'text-purple-400', bgColor: 'bg-purple-500/10', rgb: '168, 85, 247' },
  // 1.d4 / Indian systems — structural / positional
  { match: /(queen.?s_gambit|catalan|slav)/, color: 'text-indigo-400', bgColor: 'bg-indigo-500/10', rgb: '129, 140, 248' },
  { match: /(king.?s_indian|nimzo|grunfeld|queen.?s_indian|benoni|benko|indian)/, color: 'text-violet-400', bgColor: 'bg-violet-500/10', rgb: '139, 92, 246' },
  // Flank openings
  { match: /english/, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', rgb: '52, 211, 153' },
  { match: /bird/, color: 'text-yellow-400', bgColor: 'bg-yellow-500/10', rgb: '250, 204, 21' },
  { match: /reti/, color: 'text-teal-400', bgColor: 'bg-teal-500/10', rgb: '45, 212, 191' },
  // Defensive / quieter
  { match: /philidor/, color: 'text-pink-400', bgColor: 'bg-pink-500/10', rgb: '244, 114, 182' },
];

const FALLBACK_PALETTE: FamilyPalette = {
  match: /.*/,
  color: 'text-gray-400',
  bgColor: 'bg-gray-500/10',
  rgb: '156, 163, 175',
};

function paletteFor(family: string): FamilyPalette {
  for (const p of PALETTE) {
    if (p.match.test(family)) return p;
  }
  return FALLBACK_PALETTE;
}

// ─── Puzzle-type chip palette ────────────────────────────────────────────────

const CHIP_STYLE: Array<{ match: (themes: string[]) => boolean; label: (themes: string[]) => string; bg: string; border: string; text: string }> = [
  {
    match: (t) => t.includes('mate'),
    label: (t) => {
      const n = t.find((x) => /^mateIn\d$/.test(x))?.replace('mateIn', '#');
      return n ? `MATE ${n}` : 'MATE';
    },
    bg: 'bg-red-500/15',
    border: 'border-red-500/40',
    text: 'text-red-400',
  },
  {
    match: (t) => t.includes('crushing'),
    label: () => 'CRUSHING',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/40',
    text: 'text-orange-400',
  },
  {
    match: (t) => t.includes('fork'),
    label: () => 'FORK',
    bg: 'bg-cyan-500/15',
    border: 'border-cyan-500/40',
    text: 'text-cyan-400',
  },
  {
    match: (t) => t.includes('pin') || t.includes('skewer'),
    label: (t) => (t.includes('pin') ? 'PIN' : 'SKEWER'),
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/40',
    text: 'text-sky-400',
  },
  {
    match: (t) => t.includes('hangingPiece'),
    label: () => 'HANGING',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/40',
    text: 'text-emerald-400',
  },
  {
    match: (t) => t.includes('attackingF2F7'),
    label: () => 'F2/F7',
    bg: 'bg-rose-500/15',
    border: 'border-rose-500/40',
    text: 'text-rose-400',
  },
  {
    match: (t) => t.includes('deflection') || t.includes('attraction'),
    label: (t) => (t.includes('deflection') ? 'DEFLECTION' : 'ATTRACTION'),
    bg: 'bg-purple-500/15',
    border: 'border-purple-500/40',
    text: 'text-purple-400',
  },
];

function chipFor(themes: string[]): { label: string; bg: string; border: string; text: string } {
  for (const s of CHIP_STYLE) {
    if (s.match(themes)) {
      return { label: s.label(themes), bg: s.bg, border: s.border, text: s.text };
    }
  }
  return { label: 'TACTIC', bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-400' };
}

// ─── Neon border helpers (lifted from TacticsPage to keep the look) ──────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function uciToSanLine(fen: string, uciLine: string): string[] {
  const c = new Chess(fen);
  const sans: string[] = [];
  for (const uci of uciLine.split(/\s+/).filter(Boolean)) {
    try {
      const move = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans;
}

function applyFirstMove(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return c.fen();
  } catch {
    return fen;
  }
}

function puzzleGoalSentence(themes: string[]): string {
  const mateN = themes.find((t) => /^mateIn\d$/.test(t));
  if (mateN) return `${mateN.replace('mateIn', 'Mate in ')}`;
  if (themes.includes('crushing')) return 'Win decisive material';
  if (themes.includes('mate')) return 'Deliver mate';
  const pattern = themes.find((t) =>
    ['fork', 'pin', 'skewer', 'hangingPiece', 'attackingF2F7', 'deflection', 'attraction'].includes(t),
  );
  if (pattern) return `Win material — ${pattern.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`;
  return 'Find the tactic';
}

// ─── Components ──────────────────────────────────────────────────────────────

type ColorTab = 'white' | 'black';

type PhaseFilter = 'opening' | 'transition' | 'middlegame' | 'all';

const PHASE_LABEL: Record<PhaseFilter, string> = {
  opening: 'Opening',
  transition: 'Late opening',
  middlegame: 'Middlegame',
  all: 'All depths',
};

function applyPhaseFilter(
  families: OpeningBlunderFamily[],
  phase: PhaseFilter,
): OpeningBlunderFamily[] {
  if (phase === 'all') return families;
  return families
    .map((f) => ({
      ...f,
      white: f.white.filter((p) => p.phase === phase),
      black: f.black.filter((p) => p.phase === phase),
    }))
    .filter((f) => f.white.length + f.black.length > 0)
    .sort((a, b) => b.white.length + b.black.length - (a.white.length + a.black.length));
}

export function OpeningBlundersPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const userRating = activeProfile?.puzzleRating ?? 1200;
  const allFamilies = useMemo<OpeningBlunderFamily[]>(() => groupByOpeningFamily(), []);
  // Default to true opening-phase puzzles. Per user: "lets start with
  // early opening puzzles. can you sort by that?" — middlegame-deep
  // positions hide here too and they're a different lesson.
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('opening');
  const families = useMemo(
    () => applyPhaseFilter(allFamilies, phaseFilter),
    [allFamilies, phaseFilter],
  );
  const total = useMemo<number>(
    () =>
      families.reduce((acc, f) => acc + f.white.length + f.black.length, 0),
    [families],
  );
  const [activeFamily, setActiveFamily] = useState<string | null>(null);
  const [activeColor, setActiveColor] = useState<ColorTab>('white');
  const [activePuzzle, setActivePuzzle] = useState<OpeningBlunderPuzzle | null>(null);

  // Ordered list of puzzles for the active family + color — drives
  // auto-advance. Adaptive-sorted (closest-to-rating first) so the
  // session moves the user toward their level.
  const orderedPuzzles = useMemo<{ white: OpeningBlunderPuzzle[]; black: OpeningBlunderPuzzle[] }>(() => {
    if (!activeFamily) return { white: [], black: [] };
    const family = families.find((f) => f.family === activeFamily);
    if (!family) return { white: [], black: [] };
    return {
      white: adaptiveSort(family.white, userRating),
      black: adaptiveSort(family.black, userRating),
    };
  }, [activeFamily, families, userRating]);
  // Lightweight session counters — solved / attempted across the
  // current family browse, mirroring the adaptive-drill UX so the user
  // sees forward progress without persisting to Dexie. Resets when
  // they leave the page.
  const [solved, setSolved] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);

  const handlePuzzleResult = (correct: boolean): void => {
    if (correct) {
      setSolved((n) => n + 1);
      setStreak((n) => {
        const next = n + 1;
        setBestStreak((b) => Math.max(b, next));
        return next;
      });
    } else {
      setStreak(0);
    }
    // Persist the ELO update to the active profile so the rating
    // travels with the user across surfaces. Same updatePuzzleRating
    // formula every other puzzle surface uses.
    if (activeProfile && activePuzzle) {
      const newRating = updatePuzzleRating(
        activeProfile.puzzleRating,
        activePuzzle.rating,
        correct,
      );
      setActiveProfile({ ...activeProfile, puzzleRating: newRating });
    }
  };

  /** Auto-advance flow:
   *  1. Try the next puzzle in the current color's list.
   *  2. If we're at the end of that list, flip color and try its list.
   *  3. If THAT list is also exhausted, bounce out to the family picker.
   */
  const handleNextPuzzle = (): void => {
    if (!activePuzzle) return;
    const currentList = orderedPuzzles[activeColor];
    const otherColor: ColorTab = activeColor === 'white' ? 'black' : 'white';
    const otherList = orderedPuzzles[otherColor];

    const idx = currentList.findIndex((p) => p.id === activePuzzle.id);
    if (idx >= 0 && idx + 1 < currentList.length) {
      setActivePuzzle(currentList[idx + 1]);
      return;
    }
    // Current color exhausted — try the other color from the top.
    if (otherList.length > 0) {
      setActiveColor(otherColor);
      setActivePuzzle(otherList[0]);
      return;
    }
    // Both colors exhausted — exit to family list.
    setActivePuzzle(null);
    setActiveFamily(null);
  };

  if (activePuzzle) {
    return (
      <PuzzleView
        puzzle={activePuzzle}
        onExit={() => setActivePuzzle(null)}
        onResult={handlePuzzleResult}
        onNext={handleNextPuzzle}
      />
    );
  }
  if (activeFamily) {
    const family = families.find((f) => f.family === activeFamily);
    if (!family) {
      setActiveFamily(null);
      return <></>;
    }
    return (
      <FamilyDetailView
        family={family}
        activeColor={activeColor}
        onColorChange={setActiveColor}
        onPickPuzzle={setActivePuzzle}
        onBack={() => setActiveFamily(null)}
        userRating={userRating}
        solved={solved}
        streak={streak}
        bestStreak={bestStreak}
      />
    );
  }
  return (
    <FamilyPickerView
      families={families}
      total={total}
      userRating={userRating}
      solved={solved}
      bestStreak={bestStreak}
      phaseFilter={phaseFilter}
      onPhaseFilterChange={setPhaseFilter}
      onPick={(fam) => {
        const f = families.find((x) => x.family === fam);
        if (f) setActiveColor(f.white.length >= f.black.length ? 'white' : 'black');
        setActiveFamily(fam);
      }}
    />
  );
}

interface FamilyPickerViewProps {
  families: OpeningBlunderFamily[];
  total: number;
  userRating: number;
  solved: number;
  bestStreak: number;
  phaseFilter: PhaseFilter;
  onPhaseFilterChange: (p: PhaseFilter) => void;
  onPick: (family: string) => void;
}

function FamilyPickerView({
  families,
  total,
  userRating,
  solved,
  bestStreak,
  phaseFilter,
  onPhaseFilterChange,
  onPick,
}: FamilyPickerViewProps): JSX.Element {
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;
  const phaseStripRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="opening-blunders-page"
    >
      <h1 className="text-xl font-bold text-center mt-2">Opening Traps</h1>
      <p className="text-[11px] text-theme-text-muted text-center -mt-2">
        {total} {PHASE_LABEL[phaseFilter].toLowerCase()} traps · grouped by opening
      </p>

      {/* Phase filter — defaults to true opening-phase puzzles so the
          picker starts on the cleanest shallow set, sorted by depth.
          ScrollHintBar paints the app's signature gold track beneath
          the strip with the spotlight pooled under the active tab. */}
      <div className="max-w-lg mx-auto w-full">
        <div
          ref={phaseStripRef}
          className="flex gap-1 rounded-lg p-1"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          {(['opening', 'transition', 'middlegame', 'all'] as const).map((p) => (
            <button
              key={p}
              onClick={() => onPhaseFilterChange(p)}
              className="flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors text-center"
              style={{
                background: phaseFilter === p ? 'var(--color-surface)' : 'transparent',
                color: phaseFilter === p ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
              data-testid={`opening-blunder-phase-${p}`}
            >
              {PHASE_LABEL[p]}
            </button>
          ))}
        </div>
        <ScrollHintBar
          targetRef={phaseStripRef}
          axis="x"
          spotlightAt={
            (['opening', 'transition', 'middlegame', 'all'] as const).indexOf(phaseFilter) /
              3 +
            0.125
          }
        />
      </div>

      {/* Adaptive rating + session-progress chip row. Matches the
          adaptive puzzle surfaces (rating-banded sort + streak counter). */}
      <div className="flex items-center justify-center gap-2 max-w-lg mx-auto w-full">
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-theme-surface border border-theme-border text-[11px]">
          <Target size={11} className="text-theme-accent" />
          <span className="text-theme-text-muted">Rating</span>
          <span className="font-mono text-theme-text font-semibold">{userRating}</span>
        </span>
        {solved > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-theme-surface border border-theme-border text-[11px]">
            <span className="text-theme-text-muted">Solved</span>
            <span className="font-mono text-theme-text font-semibold">{solved}</span>
          </span>
        )}
        {bestStreak > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11px]">
            <Flame size={11} className="text-amber-400" />
            <span className="font-mono text-amber-300 font-semibold">{bestStreak}</span>
          </span>
        )}
      </div>

      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar scope="opening" placeholder="Search openings…" />
      </div>

      {/* Vertical row list — matches the Openings tab's OpeningCard
          picker shape (left/bottom accent border, bg-theme-surface,
          p-3.5 rounded-xl, space-y-2). User: "squares too big. needed
          to match opening tab style pickers." */}
      <div className="flex flex-col gap-2 max-w-lg mx-auto w-full">
        {families.map((f) => {
          const palette = paletteFor(f.family);
          const total = f.white.length + f.black.length;
          const shadow = scaledShadow(palette.rgb, gB);
          const shadowHover = scaledShadow(palette.rgb, Math.min(200, gB * 1.4));
          return (
            <button
              key={f.family}
              onClick={() => onPick(f.family)}
              className="w-full bg-theme-surface rounded-xl p-3.5 text-left transition-all duration-200"
              style={{ ...neonBorderStyle(palette.rgb, gS), boxShadow: shadow }}
              onMouseEnter={(e) => {
                applyHoverBorder(e.currentTarget, palette.rgb, gS);
                e.currentTarget.style.boxShadow = shadowHover;
              }}
              onMouseLeave={(e) => {
                applyRestBorder(e.currentTarget, palette.rgb, gS);
                e.currentTarget.style.boxShadow = shadow;
              }}
              data-testid={`opening-blunder-family-${f.family}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className={`text-sm font-semibold ${palette.color} truncate`}>
                    {f.label}
                  </span>
                  <div className="flex items-center gap-2 text-[11px] text-theme-text-muted">
                    <span>{total} trap{total === 1 ? '' : 's'}</span>
                    <span aria-hidden>·</span>
                    <span><span aria-hidden>♙</span> {f.white.length}</span>
                    <span aria-hidden>·</span>
                    <span><span aria-hidden>♟</span> {f.black.length}</span>
                  </div>
                </div>
                <ChevronRight size={16} className={`${palette.color} opacity-70 flex-shrink-0`} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface FamilyDetailViewProps {
  family: OpeningBlunderFamily;
  activeColor: ColorTab;
  onColorChange: (c: ColorTab) => void;
  onPickPuzzle: (p: OpeningBlunderPuzzle) => void;
  onBack: () => void;
  userRating: number;
  solved: number;
  streak: number;
  bestStreak: number;
}

function FamilyDetailView({
  family,
  activeColor,
  onColorChange,
  onPickPuzzle,
  onBack,
  userRating,
  solved,
  streak,
  bestStreak,
}: FamilyDetailViewProps): JSX.Element {
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;
  const palette = paletteFor(family.family);
  const colorStripRef = useRef<HTMLDivElement>(null);
  // Adaptive sort: prefer puzzles closest to the user's rating; tie-break
  // by popularity. Then split into in-band (userRating ± 400) vs the rest.
  const rawList = activeColor === 'white' ? family.white : family.black;
  const list = useMemo(() => adaptiveSort(rawList, userRating), [rawList, userRating]);
  const inBandCount = useMemo(
    () => list.filter((p) => Math.abs(p.rating - userRating) <= ADAPTIVE_BAND).length,
    [list, userRating],
  );
  const shadow = scaledShadow(palette.rgb, gB);
  const shadowHover = scaledShadow(palette.rgb, Math.min(200, gB * 1.4));

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
    >
      <div className="flex items-center gap-2 -my-1">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back to openings"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0 text-center pr-[44px]">
          <h1 className={`text-lg font-bold ${palette.color}`}>{family.label}</h1>
          <p className="text-[11px] text-theme-text-muted">
            {family.white.length + family.black.length} traps · {inBandCount} at your rating
          </p>
        </div>
      </div>

      {/* Rating + session counters */}
      <div className="flex items-center justify-center gap-2 max-w-lg mx-auto w-full">
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-theme-surface border border-theme-border text-[11px]">
          <Target size={11} className="text-theme-accent" />
          <span className="font-mono text-theme-text font-semibold">{userRating}</span>
        </span>
        {solved > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-theme-surface border border-theme-border text-[11px]">
            <span className="text-theme-text-muted">Solved</span>
            <span className="font-mono text-theme-text font-semibold">{solved}</span>
          </span>
        )}
        {streak > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11px]">
            <Flame size={11} className="text-amber-400" />
            <span className="font-mono text-amber-300 font-semibold">{streak}</span>
            {bestStreak > streak && (
              <span className="text-[10px] text-theme-text-muted">/ best {bestStreak}</span>
            )}
          </span>
        )}
      </div>

      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar scope="opening" placeholder="Search openings…" />
      </div>

      {/* White / Black toggle — same shape as Settings tab bar +
          gold ScrollHintBar underneath so it carries the app's signature. */}
      <div className="max-w-lg mx-auto w-full">
        <div
          ref={colorStripRef}
          className="flex gap-1 rounded-lg p-1"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          {(['white', 'black'] as const).map((c) => (
            <button
              key={c}
              onClick={() => onColorChange(c)}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors"
              style={{
                background: activeColor === c ? 'var(--color-surface)' : 'transparent',
                color: activeColor === c ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
              data-testid={`opening-blunder-color-${c}`}
            >
              <span aria-hidden>{c === 'white' ? '♙' : '♟'}</span>
              <span className="capitalize">You play {c}</span>
              <span className="text-[11px] opacity-60">
                ({c === 'white' ? family.white.length : family.black.length})
              </span>
            </button>
          ))}
        </div>
        <ScrollHintBar
          targetRef={colorStripRef}
          axis="x"
          spotlightAt={activeColor === 'white' ? 0.25 : 0.75}
        />
      </div>

      {/* Puzzle list — keep as a vertical list since each row needs
          chip + rating + themes detail. Same neon-border / glow as the
          tile grid above so it reads as the same surface. */}
      <div className="flex flex-col gap-2 max-w-lg mx-auto w-full">
        {list.length === 0 ? (
          <p className="text-sm text-theme-text-muted text-center py-8">
            No {activeColor}-side traps for this opening in the local corpus.
          </p>
        ) : (
          list.slice(0, 100).map((p) => {
            const chip = chipFor(p.themes);
            return (
              <button
                key={p.id}
                onClick={() => onPickPuzzle(p)}
                className={`${palette.bgColor} rounded-2xl flex items-center justify-between gap-3 px-4 py-3 text-left min-h-[64px] transition-all duration-200`}
                style={{ ...neonBorderStyle(palette.rgb, gS), boxShadow: shadow }}
                onMouseEnter={(e) => {
                  applyHoverBorder(e.currentTarget, palette.rgb, gS);
                  e.currentTarget.style.boxShadow = shadowHover;
                }}
                onMouseLeave={(e) => {
                  applyRestBorder(e.currentTarget, palette.rgb, gS);
                  e.currentTarget.style.boxShadow = shadow;
                }}
                data-testid={`opening-blunder-${p.id}`}
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded border ${chip.bg} ${chip.border} ${chip.text} text-[9px] font-mono font-semibold tracking-wider`}
                    >
                      {chip.label}
                    </span>
                    <span className="text-[11px] text-theme-text-muted font-mono">{p.rating}</span>
                    <span className="text-[10px] text-theme-text-muted font-mono opacity-70">
                      m{p.fullmove}
                    </span>
                  </div>
                  <p className="text-[11px] text-theme-text-muted truncate">
                    {p.themes
                      .filter((t) => !['opening', 'short', 'long', 'oneMove', 'master'].includes(t))
                      .slice(0, 4)
                      .join(' · ')}
                  </p>
                </div>
                <ChevronRight size={16} className={`${palette.color} opacity-70 flex-shrink-0`} />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Playable puzzle view (unchanged board substrate) ────────────────────────

interface PuzzleViewProps {
  puzzle: OpeningBlunderPuzzle;
  onExit: () => void;
  onResult?: (correct: boolean) => void;
  /** Auto-advance: the page passes a handler that walks to the next
   *  puzzle in the active color's list, then flips color when
   *  exhausted, then exits to family list when both are done. */
  onNext: () => void;
}

function PuzzleView({ puzzle, onExit, onResult, onNext }: PuzzleViewProps): JSX.Element {
  const navigate = useNavigate();
  void navigate; // reserved for future "next puzzle" navigation
  const startFen = useMemo<string>(() => {
    const uciList = puzzle.moves.split(/\s+/).filter(Boolean);
    return uciList.length > 0 ? applyFirstMove(puzzle.fen, uciList[0]) : puzzle.fen;
  }, [puzzle]);

  const solutionSan = useMemo<string[]>(() => {
    const uciList = puzzle.moves.split(/\s+/).filter(Boolean);
    return uciToSanLine(startFen, uciList.slice(1).join(' '));
  }, [startFen, puzzle.moves]);

  const studentSide = puzzle.studentColor;

  const playout = useEndgamePlayout({
    startFen,
    solution: solutionSan,
    replyDelayMs: 450,
  });
  const clickToMove = useClickToMove(playout);

  // Fire onResult once when the puzzle reaches a terminal state and
  // then auto-advance to the next puzzle after a brief beat so the
  // user has time to see "Solved" before the board flips.
  const [reported, setReported] = useState(false);
  useEffect(() => {
    if (!playout.isComplete || reported) return;
    setReported(true);
    onResult?.(playout.firstTryPerfect);
    const t = window.setTimeout(() => onNext(), 1400);
    return () => window.clearTimeout(t);
  }, [playout.isComplete, playout.firstTryPerfect, reported, onResult, onNext]);

  // ─── Walkthrough state — optional "Show the opening" affordance ──
  // Reconstructs the move sequence from the chess start position to
  // this puzzle's pre-state by probing Lichess Explorer. The user
  // taps the button → spinner → board animates ply-by-ply to the
  // puzzle position. No jump-cut.
  const [walkthroughMoves, setWalkthroughMoves] = useState<string[] | null>(null);
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null);
  const [walkthroughPly, setWalkthroughPly] = useState(0);

  const startWalkthrough = async (): Promise<void> => {
    if (walkthroughLoading || walkthroughMoves) return;
    setWalkthroughLoading(true);
    setWalkthroughError(null);
    try {
      const result = await reconstructPathToFen(puzzle.fen);
      if (!result.found) {
        setWalkthroughError("Couldn't find a popular path to this position. Skipping straight to the puzzle.");
        setWalkthroughLoading(false);
        return;
      }
      setWalkthroughMoves(result.sans);
      setWalkthroughPly(0);
    } catch {
      setWalkthroughError('Walkthrough lookup failed. Skipping straight to the puzzle.');
    } finally {
      setWalkthroughLoading(false);
    }
  };

  // Step the walkthrough one ply per ~600 ms so the user can follow.
  useEffect(() => {
    if (!walkthroughMoves) return;
    if (walkthroughPly >= walkthroughMoves.length) return;
    const t = window.setTimeout(() => setWalkthroughPly((n) => n + 1), 600);
    return () => window.clearTimeout(t);
  }, [walkthroughMoves, walkthroughPly]);

  // While the walkthrough plays, derive the position from the
  // start-of-game plus the moves so far. After it finishes, fall back
  // to the playout's normal fen.
  const walkthroughActive = walkthroughMoves !== null && walkthroughPly < walkthroughMoves.length;
  const walkthroughFen = useMemo<string | null>(() => {
    if (!walkthroughMoves) return null;
    const c = new Chess();
    for (let i = 0; i < walkthroughPly && i < walkthroughMoves.length; i++) {
      try { c.move(walkthroughMoves[i]); } catch { return null; }
    }
    return c.fen();
  }, [walkthroughMoves, walkthroughPly]);

  // Streaming intro narration — multi-sentence brief that queues
  // sentence-by-sentence so the FIRST Polly fetch fires immediately
  // and subsequent sentences pre-warm during playback. No per-move
  // narration after the intro per user direction: "wire in the
  // streaming narration. no need for move narrations, just a brief
  // intro." Uses the shared streamingSpeaker helper that all coach
  // streaming surfaces use.
  const introSentences = useMemo<string[]>(() => {
    const family = openingFamily(puzzle);
    const label = familyLabel(family);
    const sentences = [
      label && family !== 'other' ? `${label}.` : null,
      `${studentSide === 'white' ? 'White' : 'Black'} to play.`,
      `${puzzleGoalSentence(puzzle.themes)}.`,
    ].filter((s): s is string => Boolean(s));
    return sentences;
  }, [puzzle, studentSide]);

  useEffect(() => {
    const speaker = createStreamingSpeaker();
    for (const s of introSentences) speaker.add(s);
    return () => {
      // Stop both the queued chain (no future Polly fetches fire) AND
      // any in-flight audio so the next puzzle's intro starts cleanly.
      speaker.abandon();
      voiceService.stop();
    };
  }, [introSentences]);

  const chip = chipFor(puzzle.themes);
  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="flex items-center justify-center gap-2">
            <span
              className={`inline-block px-1.5 py-0.5 rounded border ${chip.bg} ${chip.border} ${chip.text} text-[9px] font-mono font-semibold tracking-wider`}
            >
              {chip.label}
            </span>
            <h2 className="text-sm font-semibold truncate">rating {puzzle.rating}</h2>
          </div>
          <p className="text-[11px] text-theme-text-muted truncate">
            {puzzle.themes
              .filter((t) => !['opening', 'short', 'long', 'oneMove', 'master'].includes(t))
              .slice(0, 5)
              .join(' · ')}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard
      fen={walkthroughActive && walkthroughFen ? walkthroughFen : playout.fen}
      boardOrientation={studentSide}
      interactive={!walkthroughActive && playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      onSquareClick={clickToMove.onSquareClick}
      squareStyles={clickToMove.squareStyles}
    />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-2">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
        {!playout.isComplete && playout.expectedSan && (
          <p className="text-sm text-theme-text">
            {studentSide === 'white' ? 'White' : 'Black'} to play. {puzzleGoalSentence(puzzle.themes)}.
          </p>
        )}
        {playout.isComplete && (
          <p className="text-sm text-green-400 font-semibold">
            Solved — that&apos;s the punishing line.
          </p>
        )}
        {playout.wrongAttempts > 0 && !playout.isComplete && (
          <p className="text-[11px] text-amber-400">
            {playout.wrongAttempts === 1
              ? 'Not the move. Try again.'
              : `${playout.wrongAttempts} wrong tries.`}
          </p>
        )}
      </div>
      {/* Optional "Show the opening" affordance — reconstructs the
          move sequence from start to the puzzle position via Lichess
          explorer probe and animates it ply-by-ply. No jump-cut. */}
      {!walkthroughMoves && !walkthroughLoading && !walkthroughError && (
        <button
          onClick={() => void startWalkthrough()}
          className="px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-sm font-medium hover:bg-cyan-500/20"
          data-testid="opening-blunder-show-opening"
        >
          Show the opening
        </button>
      )}
      {walkthroughLoading && (
        <p className="text-[11px] text-theme-text-muted text-center">Finding the line…</p>
      )}
      {walkthroughError && (
        <p className="text-[11px] text-amber-400">{walkthroughError}</p>
      )}
      {walkthroughActive && (
        <p className="text-[11px] text-cyan-300 text-center font-mono">
          Showing the opening · ply {walkthroughPly}/{walkthroughMoves?.length ?? 0}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => playout.reset()}
          className="flex-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text hover:bg-theme-bg"
        >
          Reset
        </button>
        {playout.hintMove && !playout.hintRevealed && (
          <button
            onClick={() => playout.revealHint()}
            className="flex-1 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-sm font-medium"
            data-testid="opening-blunder-hint"
          >
            Hint
          </button>
        )}
        {/* Reveal-on-wrong: after 2 wrong attempts the student can
            ask the playout to auto-play the rest of the line. Same
            affordance as CuratedMatingLessonView. */}
        {playout.wrongAttempts >= 2 && !playout.isComplete && (
          <button
            onClick={() => playout.reveal()}
            className="flex-1 px-3 py-2 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 text-sm font-medium"
            data-testid="opening-blunder-reveal"
          >
            Reveal line
          </button>
        )}
        <button
          onClick={onNext}
          className="flex-1 px-3 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          data-testid="opening-blunder-next"
        >
          Next trap
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
