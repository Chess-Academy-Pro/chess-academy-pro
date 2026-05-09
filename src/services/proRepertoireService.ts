import { db } from '../db/schema';
import type { OpeningRecord, ProPlayer } from '../types';
import proRepertoireData from '../data/pro-repertoires.json';

interface ProRepertoireJson {
  players: ProPlayer[];
  openings: Array<{
    id: string;
    playerId: string;
    eco: string;
    name: string;
    pgn: string;
    color: 'white' | 'black';
    style: string;
    overview: string;
    keyIdeas: string[];
    traps: string[];
    warnings: string[];
    variations: Array<{ name: string; pgn: string; explanation: string }>;
    trapLines?: Array<{ name: string; pgn: string; explanation: string }>;
    warningLines?: Array<{ name: string; pgn: string; explanation: string }>;
  }>;
}

const data = proRepertoireData as ProRepertoireJson;

export function getPlayers(): ProPlayer[] {
  return data.players;
}

export function getPlayerById(playerId: string): ProPlayer | undefined {
  return data.players.find((p) => p.id === playerId);
}

export async function getPlayerOpenings(playerId: string): Promise<OpeningRecord[]> {
  const all = await db.openings.toArray();
  return all.filter((o) => o.proPlayerId === playerId);
}

/** A curated trap line surfaced for the line picker. Drawn from
 *  pro-repertoires.json's trapLines arrays, filtered to the family
 *  whose canonical PGN matches the requested opening's bare line. */
export interface TrapTile {
  /** Trap line's display name from the curator (e.g. "Qh4 Blunder
   *  Trap", "Premature ...d5 Punished by e5"). */
  trapName: string;
  /** Pro-repertoire opening this trap belongs to (e.g. "Scotch Game
   *  (Naroditsky)"). Used as a secondary chip on the tile so the
   *  student knows which repertoire / coach the trap comes from. */
  parentOpeningName: string;
  /** ECO from the parent opening — surfaced as a small badge. */
  eco: string;
  /** Full SAN move sequence of the trap, leading to the punishment.
   *  This is what the walkthrough plays when the student taps the
   *  tile. */
  pgn: string;
  /** Curator's explanation of what's happening / why it works.
   *  Used as the walkthrough intro when the trap is selected. */
  explanation: string;
}

/** Suppress trap tiles when the picker's canonical opening is too
 *  broad (≤ this ply count). Production audit (build cca83fb): user
 *  searched a family-level parent like "King's Pawn Game" (canonical
 *  PGN = `e4`, 1 ply) and the picker drowned in 30+ red TRAP tiles
 *  from every B/C-code opening that starts with 1.e4 — Sicilian,
 *  Caro-Kann, Scandinavian, Petroff, Vienna, Italian, Scotch all
 *  flooded in. Their words: "for real tho, we can't have this." A
 *  1-3 ply prefix is shared by hundreds of unrelated openings so a
 *  prefix match is meaningless that shallow. At 4+ plies the
 *  variations have actually diverged and trap matches become
 *  topical. */
const MIN_TRAP_PREFIX_PLIES = 4;

/** Hard cap on trap tiles surfaced per picker. Even at a 4-ply
 *  prefix, popular families (Italian, Sicilian) carry 5+ curated
 *  traps; capping at 4 keeps the grid scannable without
 *  overwhelming the variation tiles. */
const MAX_TRAP_TILES_PER_PICKER = 4;

/** Find curated trap lines whose PGN starts with the given canonical
 *  bare-opening line (e.g. for "Italian Game" with canonical PGN
 *  "e4 e5 Nf3 Nc6 Bc4", returns every trap line whose PGN starts
 *  with that prefix). Used by the Coach line picker to surface red
 *  trap tiles alongside the Lichess-DB variation tiles. Returns []
 *  when no curated traps fall under this opening family OR when the
 *  canonical PGN is too shallow for prefix matching to be topical. */
export function findTrapTilesForCanonicalLine(
  canonicalPgn: string,
): TrapTile[] {
  const prefix = canonicalPgn.trim();
  if (!prefix) return [];
  const prefixPlies = prefix.split(/\s+/).filter(Boolean).length;
  if (prefixPlies < MIN_TRAP_PREFIX_PLIES) return [];
  const tiles: TrapTile[] = [];
  for (const op of data.openings) {
    if (!op.trapLines) continue;
    for (const t of op.trapLines) {
      if (!t.pgn.startsWith(prefix + ' ') && t.pgn !== prefix) continue;
      tiles.push({
        trapName: t.name,
        parentOpeningName: op.name,
        eco: op.eco,
        pgn: t.pgn,
        explanation: t.explanation,
      });
    }
  }
  return tiles.slice(0, MAX_TRAP_TILES_PER_PICKER);
}
