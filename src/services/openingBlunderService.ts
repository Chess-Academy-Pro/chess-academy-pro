// openingBlunderService
// ----------------------
// Mines `src/data/puzzles.json` (Lichess CC0 subset, 15K curated) for
// opening blunders — positions tagged `opening` AND carrying a
// tactical-outcome theme (mate / crushing / fork / pin / skewer /
// hangingPiece / attackingF2F7 / attraction / deflection).
//
// The Lichess puzzle taxonomy doesn't have an explicit "openingBlunder"
// theme — these tags are separate axes. Filtering for the
// intersection gives us the same effective surface: positions where
// someone walked into a tactical refutation during the opening.
//
// Used by the /tactics/opening-traps surface.

import { Chess } from 'chess.js';
import puzzlesRaw from '../data/puzzles.json';

const TACTICAL_OUTCOME_THEMES = new Set<string>([
  'mate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'crushing',
  'fork',
  'pin',
  'skewer',
  'hangingPiece',
  'attackingF2F7',
  'attraction',
  'deflection',
  'kingsideAttack',
  'queensideAttack',
  'xRayAttack',
  'doubleCheck',
  'discoveredAttack',
]);

export interface OpeningBlunderPuzzle {
  id: string;
  fen: string;
  /** Space-separated UCI moves. Index 0 is the OPPONENT's setup move
   *  that creates the puzzle position; index 1 onward is the
   *  alternating student/opponent solution. */
  moves: string;
  rating: number;
  themes: string[];
  /** Lichess opening tags. Can be a string or an array depending on
   *  how this row was authored. Normalised by `openingFamily()`. */
  openingTags: string | string[];
  popularity: number;
  nbPlays: number;
  /** Color the STUDENT plays — i.e., the side to move AFTER the
   *  opponent's setup move (moves[0]) is applied. This is the side
   *  that delivers the punishing tactic. Pre-computed for fast filter. */
  studentColor: 'white' | 'black';
  /** Fullmove number from the puzzle's FEN. 1 = before white's first
   *  move. Pre-computed so the picker can filter / sort by depth
   *  without re-parsing FENs. */
  fullmove: number;
  /** Coarse depth classification:
   *  - 'opening'    : fullmove ≤ 7 (~14 ply). True opening-trap territory.
   *  - 'transition' : 8-12 (~16-24 ply). Late opening / early middlegame.
   *  - 'middlegame' : > 12. Position grew well past the opening label.
   *  Used to default the picker to the cleanest early-opening subset. */
  phase: 'opening' | 'transition' | 'middlegame';
}

interface RawPuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
  openingTags?: string | string[];
  popularity?: number;
  nbPlays?: number;
}

const puzzles = puzzlesRaw as RawPuzzle[];

/** Family slug for grouping: first opening tag, lowercased, spaces ⇒ underscores.
 *  Returns 'other' when no tag is present. */
export function openingFamily(p: { openingTags?: string | string[] }): string {
  const t = p.openingTags;
  if (!t) return 'other';
  const first = Array.isArray(t) ? t[0] : t.split(/\s+/)[0];
  if (!first) return 'other';
  return first.toLowerCase().replace(/\s+/g, '_');
}

/** Human-readable label for a family slug (turn underscores into spaces). */
export function familyLabel(family: string): string {
  return family.replace(/_/g, ' ');
}

/** Side the puzzle's STUDENT plays — i.e., the side to move after the
 *  opponent's setup move (UCI moves[0]) is applied. Returns null when
 *  the move sequence can't be replayed. */
function deriveStudentColor(
  fen: string,
  moves: string,
): 'white' | 'black' | null {
  const uciList = moves.split(/\s+/).filter(Boolean);
  if (uciList.length === 0) {
    return fen.split(' ')[1] === 'w' ? 'white' : 'black';
  }
  try {
    const c = new Chess(fen);
    const uci = uciList[0];
    c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return c.turn() === 'w' ? 'white' : 'black';
  } catch {
    return null;
  }
}

function fullmoveFromFen(fen: string): number {
  const parts = fen.split(' ');
  const n = Number(parts[5]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function phaseFromFullmove(fullmove: number): 'opening' | 'transition' | 'middlegame' {
  if (fullmove <= 7) return 'opening';
  if (fullmove <= 12) return 'transition';
  return 'middlegame';
}

/** All opening blunders in the local corpus. Sort default: depth
 *  ascending (shallow openings first), tie-break popularity. Callers
 *  filter by `phase === 'opening'` to focus on true opening traps. */
export function getOpeningBlunderPuzzles(): OpeningBlunderPuzzle[] {
  const out: OpeningBlunderPuzzle[] = [];
  for (const p of puzzles) {
    const themes = p.themes ?? [];
    if (!themes.includes('opening')) continue;
    const hasTactic = themes.some((t) => TACTICAL_OUTCOME_THEMES.has(t));
    if (!hasTactic) continue;
    const studentColor = deriveStudentColor(p.fen, p.moves);
    if (!studentColor) continue;
    const fullmove = fullmoveFromFen(p.fen);
    out.push({
      id: p.id,
      fen: p.fen,
      moves: p.moves,
      rating: p.rating,
      themes,
      openingTags: p.openingTags ?? '',
      popularity: p.popularity ?? 0,
      nbPlays: p.nbPlays ?? 0,
      studentColor,
      fullmove,
      phase: phaseFromFullmove(fullmove),
    });
  }
  out.sort((a, b) => {
    if (a.fullmove !== b.fullmove) return a.fullmove - b.fullmove;
    return b.popularity - a.popularity;
  });
  return out;
}

export interface OpeningBlunderFamily {
  family: string;
  label: string;
  white: OpeningBlunderPuzzle[];
  black: OpeningBlunderPuzzle[];
}

/** Same data grouped by opening family, with white/black panels split
 *  by the punishing side (student color). Families sorted by total
 *  count desc. Each color list is sorted by popularity desc. */
export function groupByOpeningFamily(): OpeningBlunderFamily[] {
  const map = new Map<string, { white: OpeningBlunderPuzzle[]; black: OpeningBlunderPuzzle[] }>();
  for (const p of getOpeningBlunderPuzzles()) {
    const fam = openingFamily(p);
    const bucket = map.get(fam) ?? { white: [], black: [] };
    if (p.studentColor === 'white') bucket.white.push(p);
    else bucket.black.push(p);
    map.set(fam, bucket);
  }
  return Array.from(map.entries())
    .map(([family, lists]) => ({
      family,
      label: familyLabel(family),
      white: lists.white,
      black: lists.black,
    }))
    .sort((a, b) => b.white.length + b.black.length - (a.white.length + a.black.length));
}
