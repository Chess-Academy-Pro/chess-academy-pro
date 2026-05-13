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

import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useNarration } from '../../hooks/useNarration';
import { SmartSearchBar } from '../Search/SmartSearchBar';
import { useSettings } from '../../hooks/useSettings';
import { scaledShadow } from '../../utils/neonColors';
import {
  getOpeningBlunderPuzzles,
  groupByOpeningFamily,
  type OpeningBlunderPuzzle,
  type OpeningBlunderFamily,
} from '../../services/openingBlunderService';

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

export function OpeningBlundersPage(): JSX.Element {
  const families = useMemo<OpeningBlunderFamily[]>(() => groupByOpeningFamily(), []);
  const total = useMemo<number>(() => getOpeningBlunderPuzzles().length, []);
  const [activeFamily, setActiveFamily] = useState<string | null>(null);
  const [activeColor, setActiveColor] = useState<ColorTab>('white');
  const [activePuzzle, setActivePuzzle] = useState<OpeningBlunderPuzzle | null>(null);

  if (activePuzzle) {
    return <PuzzleView puzzle={activePuzzle} onExit={() => setActivePuzzle(null)} />;
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
      />
    );
  }
  return (
    <FamilyPickerView
      families={families}
      total={total}
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
  onPick: (family: string) => void;
}

function FamilyPickerView({ families, total, onPick }: FamilyPickerViewProps): JSX.Element {
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="opening-blunders-page"
    >
      <h1 className="text-xl font-bold text-center mt-2">Opening Traps</h1>
      <p className="text-[11px] text-theme-text-muted text-center -mt-2">
        {total} tactical refutations · grouped by opening
      </p>

      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar scope="opening" placeholder="Search openings…" />
      </div>

      <div className="grid grid-cols-2 gap-3 flex-1 content-start max-w-lg mx-auto w-full">
        {families.map((f) => {
          const palette = paletteFor(f.family);
          const total = f.white.length + f.black.length;
          const shadow = scaledShadow(palette.rgb, gB);
          const shadowHover = scaledShadow(palette.rgb, Math.min(200, gB * 1.4));
          return (
            <button
              key={f.family}
              onClick={() => onPick(f.family)}
              className={`${palette.bgColor} rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all duration-200 aspect-square px-3`}
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
              <span className={`text-sm font-bold ${palette.color} text-center leading-tight`}>
                {f.label}
              </span>
              <div className="flex items-center gap-1.5 text-[10px] text-theme-text-muted font-mono">
                <span aria-hidden>♙ {f.white.length}</span>
                <span aria-hidden>·</span>
                <span aria-hidden>♟ {f.black.length}</span>
              </div>
              <span className="text-[10px] text-theme-text-muted opacity-70">
                {total} trap{total === 1 ? '' : 's'}
              </span>
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
}

function FamilyDetailView({
  family,
  activeColor,
  onColorChange,
  onPickPuzzle,
  onBack,
}: FamilyDetailViewProps): JSX.Element {
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;
  const palette = paletteFor(family.family);
  const list = activeColor === 'white' ? family.white : family.black;
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
            {family.white.length + family.black.length} traps to punish
          </p>
        </div>
      </div>

      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar scope="opening" placeholder="Search openings…" />
      </div>

      {/* White / Black toggle — same shape as Settings tab bar */}
      <div className="max-w-lg mx-auto w-full">
        <div
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
}

function PuzzleView({ puzzle, onExit }: PuzzleViewProps): JSX.Element {
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

  const introText = useMemo<string>(
    () =>
      `${puzzleGoalSentence(puzzle.themes)}. ${studentSide === 'white' ? 'White' : 'Black'} to play.`,
    [puzzle.themes, studentSide],
  );
  useNarration({ text: introText });

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
      fen={playout.fen}
      boardOrientation={studentSide}
      interactive={playout.phase === 'student-to-move'}
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
          >
            Hint
          </button>
        )}
        <button
          onClick={onExit}
          className="flex-1 px-3 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
        >
          Next trap
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
