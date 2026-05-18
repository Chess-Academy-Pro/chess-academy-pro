import { ANNOTATION_MODULES } from '../data/annotations';
import { Chess } from 'chess.js';
import { getBestNarration, shouldUseClaudeFallback, pickNarration } from './openingNarrationService';
import type { OpeningMoveAnnotation, OpeningAnnotations } from '../types';

// Map pro repertoires to a specific sub-line instead of the main line.
// Keyed by full opening ID first, then by suffix as fallback.
const PRO_ID_TO_SUBLINE: Record<string, string> = {
  'pro-naroditsky-scotch': 'variation-0',
  'pro-hikaru-scotch': 'variation-5',
  'pro-dubov-scotch': 'variation-3',
  'pro-naroditsky-vienna': 'variation-5',
  'pro-firouzja-vienna': 'variation-6',
  'pro-gothamchess-london': 'variation-5',
  'pro-hikaru-london': 'variation-9',
  'pro-annacramling-london': 'variation-7',
  'pro-carlsen-qgd': 'variation-7',
  'pro-caruana-qgd': 'variation-8',
  'pro-carlsen-london-d4': 'variation-8',
  'pro-hikaru-najdorf': 'variation-6',
  'pro-firouzja-najdorf': 'variation-7',
  'pro-hikaru-nimzo': 'variation-5',
  'pro-caruana-nimzo': 'variation-6',
  'pro-caruana-italian': 'variation-6',
  'pro-firouzja-italian': 'variation-7',
  'pro-naroditsky-fantasy-caro': 'variation-4',
  'pro-gothamchess-fantasy-caro': 'variation-5',
  'pro-hikaru-kid': 'variation-5',
  'pro-dubov-sveshnikov': 'variation-6',
  'pro-carlsen-catalan': 'variation-5',
  'pro-caruana-catalan': 'variation-6',
  'pro-firouzja-grunfeld': 'variation-5',
  'pro-carlsen-berlin': 'variation-6',
  'pro-caruana-berlin': 'variation-6',
  'pro-caruana-ruy-lopez': 'variation-7',
  'pro-dubov-anti-marshall': 'variation-8',
  'pro-firouzja-ruy-lopez': 'variation-9',
  'pro-praggnanandhaa-ruy-lopez': 'variation-10',
  'pro-niemann-anti-marshall': 'variation-11',
};

const PRO_SUFFIX_TO_SUBLINE: Record<string, string> = {
  'anti-berlin': 'variation-5',
  'anti-sicilian': 'variation-5',
  'benoni': 'variation-5',
  'berlin': 'variation-2',
  'dutch': 'variation-5',
  'english': 'variation-0',
  'french': 'variation-5',
  'kia': 'variation-0',
  'milner-barry': 'variation-6',
  'najdorf': 'variation-5',
  'ponziani': 'variation-5',
  'qgd': 'variation-5',
  'rossolimo': 'variation-5',
  'scandinavian': 'variation-5',
  'semi-slav': 'variation-5',
  'stafford-refute': 'variation-5',
  'tarrasch-defense': 'variation-6',
  'tarrasch-french': 'variation-3',
};

// Map pro-repertoire suffixes to base annotation IDs.
//
// CRITICAL: these values MUST match real files in
// src/data/annotations/. The May-2026 orphan-rename pass converted
// every annotation filename from British "Defence" to American
// "Defense" + Lichess-canonical apostrophe-bearing names
// ("kings-indian-defense" → "king-s-indian-defense"). Aliases that
// still pointed at the old filenames silently returned null at
// runtime, so every pro repertoire whose ID ended in one of these
// suffixes lost its annotations. Run `node
// scripts/verify-pro-suffix-bases.mjs` to validate after any edit.
const PRO_SUFFIX_TO_BASE: Record<string, string> = {
  // ─── Sicilian family (sicilian-defense.json is the bare base;
  // deeper variants for the specific lines that exist post-rename) ─
  'alapin': 'sicilian-defense-alapin-variation',
  'anti-sicilian': 'sicilian-defense-alapin-variation',
  'najdorf': 'sicilian-defense-najdorf-variation-opocensky-variation-traditional-line',
  'rossolimo': 'sicilian-defense',
  'sicilian': 'sicilian-defense',
  'sicilian-najdorf': 'sicilian-defense-najdorf-variation-opocensky-variation-traditional-line',
  'sveshnikov': 'sicilian-defense-lasker-pelikan-variation-sveshnikov-variation-chelyabinsk-variation',
  // ─── Ruy Lopez family (unchanged; ruy-lopez.json still exists) ─
  'anti-berlin': 'ruy-lopez',
  'anti-marshall': 'ruy-lopez',
  'berlin': 'ruy-lopez',
  'ponziani': 'italian-game',
  'ruy-lopez': 'ruy-lopez',
  // ─── Italian / Two Knights / Evans ─
  'italian': 'italian-game',
  // ─── Open games ─
  'kings-gambit': 'king-s-gambit',
  'petroff': 'petrov-s-defense',
  'scotch': 'scotch-game',
  'stafford': 'petrov-s-defense-stafford-gambit',
  'stafford-refute': 'petrov-s-defense-stafford-gambit',
  'vienna': 'vienna-game',
  // ─── French ─
  'french': 'french-defense',
  'milner-barry': 'french-defense',
  'tarrasch-french': 'french-defense',
  // ─── Caro-Kann ─
  'caro-kann': 'caro-kann-defense',
  'fantasy-caro': 'caro-kann-defense',
  // ─── Other 1.e4 ─
  'scandinavian': 'scandinavian-defense',
  // ─── 1.d4 Indian systems ─
  'benoni': 'benoni-defense',
  'benko': 'benko-gambit-accepted-central-storming-variation',
  'dutch': 'dutch-defense',
  'grunfeld': 'gr-nfeld-defense',
  'kid': 'king-s-indian-defense',
  'nimzo': 'nimzo-indian-defense',
  // ─── Closed games (Queen's pawn) ─
  'catalan': 'catalan-opening',
  'cow': 'formation-hippopotamus-attack',
  'jobava-london': 'london-system',
  'london': 'london-system',
  'london-d4': 'london-system',
  'qgd': 'queen-s-gambit-declined',
  'semi-slav': 'semi-slav-defense',
  'tarrasch-defense': 'queen-s-gambit-declined-tarrasch-defense',
  // ─── 1.Nf3 / 1.c4 ─
  'english': 'english-opening',
  'englund': 'englund-gambit',
  'kia': 'king-s-indian-attack',
};

// Repertoire / gambits / one-off legacy IDs that pre-date the
// May-2026 orphan-rename pass. Same class of drift as
// PRO_SUFFIX_TO_BASE — the source JSONs (repertoire.json,
// gambits.json) still slugify their IDs with the OLD rules
// (apostrophe-stripped, British "-defence", umlaut-stripped) so
// "King's Gambit" reads as `kings-gambit`. Annotation files were
// renamed to the NEW slugify ("king-s-gambit"), so the bare-id
// lookup misses. This map repairs the resolution.
//
// Locked by scripts/verify-annotation-resolution.test.ts — every
// value must resolve to a real annotation file.
const LEGACY_ID_TO_BASE: Record<string, string> = {
  // Repertoire-list IDs (src/data/repertoire.json) ──────────────────
  'sicilian-najdorf': 'sicilian-defense-najdorf-variation-opocensky-variation-traditional-line',
  'sicilian-dragon': 'sicilian-defense-dragon-variation-yugoslav-attack-old-line',
  'sicilian-sveshnikov': 'sicilian-defense-lasker-pelikan-variation-sveshnikov-variation-chelyabinsk-variation',
  'sicilian-alapin': 'sicilian-defense-alapin-variation',
  'kings-gambit': 'king-s-gambit',
  'french-defence': 'french-defense',
  'caro-kann': 'caro-kann-defense',
  'pirc-defence': 'pirc-defense',
  'scandinavian-defence': 'scandinavian-defense',
  'alekhine-defence': 'alekhine-defense',
  'philidor-defence': 'philidor-defense',
  'petrov-defence': 'petrov-s-defense',
  'queens-gambit': 'queen-s-gambit',
  'qgd': 'queen-s-gambit-declined',
  'qga': 'queen-s-gambit-accepted',
  'slav-defence': 'slav-defense',
  'semi-slav': 'semi-slav-defense',
  'kings-indian-defence': 'king-s-indian-defense',
  'nimzo-indian': 'nimzo-indian-defense',
  'grunfeld-defence': 'gr-nfeld-defense',
  'dutch-defence': 'dutch-defense',
  'benoni-defence': 'benoni-defense',
  'benko-gambit': 'benko-gambit-accepted-central-storming-variation',
  'queens-indian': 'queen-s-indian-defense',
  'budapest-gambit': 'indian-defense-budapest-defense',
  'old-indian-defence': 'old-indian-defense',
  'reti-opening': 'r-ti-opening',
  'kings-indian-attack': 'king-s-indian-attack',
  'birds-opening': 'bird-opening',
  'two-knights-defence': 'italian-game-two-knights-defense-modern-bishop-s-opening',
  'evans-gambit': 'italian-game-evans-gambit',
  'stafford-gambit': 'petrov-s-defense-stafford-gambit',
  // Gambits-list IDs (src/data/gambits.json) ────────────────────────
  // (Gambits use a `gambit-` prefix in their record IDs; the suffix
  // after that prefix is the canonical gambit name.)
  'gambit-kings-gambit': 'king-s-gambit',
  'gambit-evans-gambit': 'italian-game-evans-gambit',
  'gambit-budapest-gambit': 'indian-defense-budapest-defense',
  'gambit-benko-gambit': 'benko-gambit-accepted-central-storming-variation',
  'scotch-gambit': 'scotch-game-scotch-gambit',
  'vienna-gambit': 'vienna-game-vienna-gambit',
  'smith-morra-gambit': 'sicilian-defense-smith-morra-gambit',
  'marshall-attack': 'ruy-lopez-marshall-attack',
  'albin-countergambit': 'queen-s-gambit-declined-albin-countergambit',
};

function resolveAnnotationId(openingId: string): string {
  if (Object.hasOwn(ANNOTATION_MODULES, openingId)) return openingId;

  // Legacy-id alias map first — covers repertoire/gambits IDs whose
  // slug style pre-dates the May-2026 orphan-rename pass.
  const legacyBase = LEGACY_ID_TO_BASE[openingId];
  if (legacyBase && Object.hasOwn(ANNOTATION_MODULES, legacyBase)) {
    return legacyBase;
  }

  // Strip pro-<player>- prefix and try mapping
  const match = /^pro-[a-z]+-(.+)$/.exec(openingId);
  if (match) {
    const suffix = match[1];
    const baseId = PRO_SUFFIX_TO_BASE[suffix];
    if (baseId && Object.hasOwn(ANNOTATION_MODULES, baseId)) return baseId;
  }

  // dataLoader builds opening IDs as slugify(`${eco}-${name}`) — e.g.
  // "c50-italian-game". Annotation files are keyed by the name-only
  // slug — "italian-game". Strip a leading ECO prefix (letter + 2
  // digits + dash) and retry. Without this, the 3641 Lichess-ECO
  // openings couldn't reach the 1916 annotation files (the audit's
  // #1 unreachable-content finding — generated but never rendered).
  const ecoStripped = /^[a-e]\d{2}-(.+)$/.exec(openingId);
  if (ecoStripped) {
    const bare = ecoStripped[1];
    if (Object.hasOwn(ANNOTATION_MODULES, bare)) return bare;
    // Last-chance: the legacy-id alias map covers any post-ECO-strip
    // legacy slug (e.g. ECO entries whose name slugifies the old way).
    const ecoLegacy = LEGACY_ID_TO_BASE[bare];
    if (ecoLegacy && Object.hasOwn(ANNOTATION_MODULES, ecoLegacy)) {
      return ecoLegacy;
    }
  }

  return openingId;
}

const cache = new Map<string, OpeningAnnotations>();

async function loadModule(openingId: string): Promise<OpeningAnnotations | null> {
  const resolvedId = resolveAnnotationId(openingId);
  const cached = cache.get(resolvedId);
  if (cached) return cached;

  const loader = ANNOTATION_MODULES[resolvedId] as (() => Promise<{ default: OpeningAnnotations }>) | undefined;
  if (!loader) return null;

  const mod = await loader();
  const data = mod.default;
  cache.set(resolvedId, data);
  return data;
}

export async function loadAnnotations(openingId: string): Promise<OpeningMoveAnnotation[] | null> {
  // Check if this pro repertoire should use a sub-line instead of the main line
  const fullIdSubLine = PRO_ID_TO_SUBLINE[openingId];
  if (fullIdSubLine) {
    return loadSubLineAnnotations(openingId, fullIdSubLine);
  }
  const proMatch = /^pro-[a-z]+-(.+)$/.exec(openingId);
  if (proMatch) {
    const subLineKey = PRO_SUFFIX_TO_SUBLINE[proMatch[1]];
    if (subLineKey) {
      return loadSubLineAnnotations(openingId, subLineKey);
    }
  }

  const data = await loadModule(openingId);
  return data?.moveAnnotations ?? null;
}

/**
 * Parse a PGN string into an array of SAN moves using chess.js for validation.
 * Returns only valid moves (stops at the first invalid token).
 */
function parsePgnToSans(pgn: string): string[] {
  const tokens = pgn.trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  const sans: string[] = [];
  for (const token of tokens) {
    try {
      const move = chess.move(token);
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans;
}

/**
 * Count how many leading moves match between a PGN and an annotation set.
 */
function countMatchingMoves(pgn: string, annotations: OpeningMoveAnnotation[]): number {
  const sans = parsePgnToSans(pgn);
  let matches = 0;
  for (let i = 0; i < Math.min(sans.length, annotations.length); i++) {
    if (sans[i] === annotations[i].san) {
      matches++;
    } else {
      break;
    }
  }
  return matches;
}

/**
 * Load annotations for an opening, using the PGN to find the best-matching
 * annotation set. When the main line annotations diverge from the opening's
 * PGN, this searches subLines for a better match.
 */
export async function loadAnnotationsForPgn(
  openingId: string,
  pgn: string,
): Promise<OpeningMoveAnnotation[] | null> {
  const data = await loadModule(openingId);
  if (!data) return null;

  const mainLineMatch = countMatchingMoves(pgn, data.moveAnnotations);
  const pgnMoveCount = parsePgnToSans(pgn).length;

  // If main line matches all (or nearly all) PGN moves, use it
  if (mainLineMatch >= pgnMoveCount || mainLineMatch >= data.moveAnnotations.length) {
    return data.moveAnnotations;
  }

  // Search subLines for the BEST match
  let bestAnnotations = data.moveAnnotations;
  let bestMatch = mainLineMatch;
  if (data.subLines && data.subLines.length > 0) {
    for (const subLine of data.subLines) {
      const subMatch = countMatchingMoves(pgn, subLine.moveAnnotations);
      if (subMatch > bestMatch) {
        bestMatch = subMatch;
        bestAnnotations = subLine.moveAnnotations;
      }
    }
  }

  // If even the BEST match covers less than half the PGN's plies, the
  // annotations are for a DIFFERENT variation than what the user is
  // walking through — returning them would put wrong-variation
  // commentary on the board (e.g. Caro Classical "3.Nc3 / develops
  // the knight" text rendered on Fantasy Caro's 3.f3 move). Return null
  // instead so the WalkthroughMode caller's synthesise-from-PGN +
  // LLM-enricher path takes over fully. 2026-05-17 Fantasy Caro audit
  // caught this — pro-gothamchess-fantasy-caro resolves to
  // caro-kann-defense.json whose main line is Classical Caro; the first
  // 4 plies prefix-match (1.e4 c6 2.d4 d5) so the loader returned
  // Classical annotations and the first 6 plies of the walkthrough
  // showed Classical Caro narration.
  const pgnLen = pgnMoveCount;
  if (pgnLen > 0 && bestMatch * 2 < pgnLen) {
    return null;
  }

  return bestAnnotations;
}

export async function loadSubLineAnnotations(
  openingId: string,
  subLineKey: string,
  // Optional name AND pgn from repertoire.json's variation entry. The
  // index-based subLineKey lookup misses for 34/40 openings because
  // variations get added to repertoire without matching annotation
  // subLine entries. variationPgn is the safest fallback: we only
  // accept a subline if its move sequence is a strict prefix of the
  // repertoire variation's PGN. Name match alone is unreliable —
  // "From's Gambit Declined" vs "From's Gambit" share a name stem but
  // are completely different lines, and a fuzzy name match was returning
  // the WRONG annotation, producing narration-doesn't-match-board.
  variationName?: string,
  variationPgn?: string,
): Promise<OpeningMoveAnnotation[] | null> {
  const data = await loadModule(openingId);
  if (!data?.subLines || data.subLines.length === 0) return null;

  // Strategy 1 (most reliable): the annotation's own move sequence
  // must be a literal prefix of the repertoire variation's PGN. If a
  // subline walks 16 plies and they all match the first 16 SAN tokens
  // of variationPgn exactly, it's the right annotation regardless of
  // name. If no subline's moves are a clean prefix, NONE is right —
  // because mismatched moves means the board would play one line and
  // narration would describe a different one.
  if (variationPgn) {
    const repSans = variationPgn.trim().split(/\s+/).filter(Boolean);
    for (const sl of data.subLines) {
      const annSans = (sl.moveAnnotations ?? []).map((m) => m.san);
      if (annSans.length === 0) continue;
      let isPrefix = true;
      for (let i = 0; i < annSans.length; i++) {
        if (annSans[i] !== repSans[i]) { isPrefix = false; break; }
      }
      if (isPrefix) return sl.moveAnnotations;
    }
  }

  // Strategy 2: exact name match — only used when no PGN was supplied
  // (e.g. trap/warning callers that don't carry a repertoire entry).
  // Fuzzy normalization is intentionally NOT used here; "Declined" and
  // "Accepted" sublines share a stem but are different lines.
  if (variationName) {
    const direct = data.subLines.find((sl) => sl.name === variationName);
    if (direct?.moveAnnotations) return direct.moveAnnotations;
  }

  // Strategy 3: legacy index-based lookup — supports the trap-N /
  // warning-N case where there's no PGN to verify against.
  const match = /^(variation|trap|warning)-(\d+)$/.exec(subLineKey);
  if (!match) return null;

  const type = match[1] as 'variation' | 'trap' | 'warning';
  const localIdx = parseInt(match[2], 10);

  const hasTypes = data.subLines.some((sl) => sl.type != null);
  if (hasTypes) {
    const matching = data.subLines.filter((sl) => sl.type === type);
    return matching[localIdx]?.moveAnnotations ?? null;
  }

  if (type !== 'variation') return null;
  return data.subLines[localIdx]?.moveAnnotations ?? null;
}

/**
 * Enhance a static annotation with a DB-driven narration if a good match
 * exists. Returns the original annotation with the `annotation` text
 * replaced by the curated narration when appropriate; all other fields
 * (arrows, highlights, plans, etc.) are preserved from the static JSON.
 *
 * This is the "hybrid" integration point: DB narrations for text quality,
 * static JSON for visual elements.
 */
export async function enhanceWithNarration(
  annotation: OpeningMoveAnnotation,
  fen: string,
  moveHistory: string[],
  openingName?: string,
): Promise<OpeningMoveAnnotation> {
  const match = await getBestNarration(fen, moveHistory, openingName);

  if (!match || shouldUseClaudeFallback(match)) {
    return annotation;
  }

  const narrationText = pickNarration(match.narration);
  if (!narrationText) return annotation;

  return { ...annotation, annotation: narrationText };
}

export function clearAnnotationCache(): void {
  cache.clear();
}
