import { Chess } from 'chess.js';
import { db } from '../db/schema';
import { createDefaultSrsFields } from './srsEngine';
import ecoData from '../data/openings-lichess.json';
import repertoireData from '../data/repertoire.json';
import proRepertoireData from '../data/pro-repertoires.json';
import gambitData from '../data/gambits.json';
import modelGamesData from '../data/model-games.json';
import middlegamePlansData from '../data/middlegame-plans.json';
import { CURATED_NARRATIONS } from '../data/opening-narrations';
import type { OpeningRecord, FlashcardRecord, ModelGame, MiddlegamePlan } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EcoEntry {
  eco: string;
  name: string;
  pgn: string;
}

interface RepertoireEntry {
  id: string;
  eco: string;
  name: string;
  pgn: string;
  color: 'white' | 'black';
  style: string;
  overview: string;
  keyIdeas: string[];
  traps: string[];
  warnings: string[];
  variations: Array<{
    name: string;
    pgn: string;
    explanation: string;
  }>;
  trapLines?: Array<{
    name: string;
    pgn: string;
    explanation: string;
  }>;
  warningLines?: Array<{
    name: string;
    pgn: string;
    explanation: string;
  }>;
}

// ─── PGN Helpers ──────────────────────────────────────────────────────────────

interface PositionResult {
  fen: string;
  uci: string;
}

/**
 * Plays through a space-separated SAN move string and returns the final FEN
 * and UCI move string.
 */
export function computePosition(pgn: string): PositionResult {
  const chess = new Chess();
  const uciMoves: string[] = [];

  const tokens = pgn.trim().split(/\s+/).filter(Boolean);

  for (const san of tokens) {
    try {
      const move = chess.move(san);
      uciMoves.push(move.from + move.to + (move.promotion ?? ''));
    } catch {
      break;
    }
  }

  return { fen: chess.fen(), uci: uciMoves.join(' ') };
}

/**
 * Generates a URL-safe slug from a name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Seeding State ────────────────────────────────────────────────────────────

const SEED_KEY = 'db_seeded_v12';

/**
 * Pro-repertoire content revision. Bump this whenever
 * `src/data/pro-repertoires.json` changes shape — added/renamed/
 * removed trapLines, warningLines, variations, explanations,
 * color/style edits, anything content-driven. On the next boot,
 * every user's Dexie reconciles to the new content via
 * `reconcileProRepertoires()` while preserving drill/SRS/woodpecker
 * progress, isRepertoire, isFavorite, and any per-opening dynamic
 * state.
 *
 * Versioning convention: `<YYYY-MM-DD>-<short-topic>`. The string is
 * compared byte-for-byte to the meta key, so any change triggers a
 * full content refresh.
 */
const PRO_DATA_REVISION = '2026-05-16-traps-orient-fix';
const PRO_REVISION_KEY = 'pro_data_revision';

export async function isDatabaseSeeded(): Promise<boolean> {
  const record = await db.meta.get(SEED_KEY);
  return record?.value === 'true';
}

async function markDatabaseSeeded(): Promise<void> {
  await db.meta.put({ key: SEED_KEY, value: 'true' });
}

// ─── ECO Loader ───────────────────────────────────────────────────────────────

export async function loadEcoData(): Promise<void> {
  const defaults = createDefaultSrsFields();

  const records: OpeningRecord[] = (ecoData as EcoEntry[]).map((entry) => {
    const { fen, uci } = computePosition(entry.pgn);
    const id = slugify(`${entry.eco}-${entry.name}`);

    return {
      id,
      eco: entry.eco,
      name: entry.name,
      pgn: entry.pgn,
      uci,
      fen,
      color: 'white',       // ECO-only entries don't have a fixed color
      style: '',
      isRepertoire: false,
      overview: null,
      keyIdeas: null,
      traps: null,
      warnings: null,
      variations: null,
      drillAccuracy: 0,
      drillAttempts: 0,
      lastStudied: null,
      woodpeckerReps: 0,
      woodpeckerSpeed: null,
      woodpeckerLastDate: null,
      isFavorite: false,
      // SRS fields (unused on non-repertoire records, but schema requires them
      // since they share a table — stored as defaults)
      ...defaults,
    };
  });

  // bulkPut is idempotent — safe to re-run
  await db.openings.bulkPut(records);
}

// ─── Repertoire Loader ────────────────────────────────────────────────────────

export async function loadRepertoireData(): Promise<void> {
  const defaults = createDefaultSrsFields();

  const records: OpeningRecord[] = (repertoireData as RepertoireEntry[]).map(
    (entry) => {
      const { fen, uci } = computePosition(entry.pgn);

      return {
        id: entry.id,
        eco: entry.eco,
        name: entry.name,
        pgn: entry.pgn,
        uci,
        fen,
        color: entry.color,
        style: entry.style,
        isRepertoire: true,
        overview: entry.overview,
        keyIdeas: entry.keyIdeas,
        traps: entry.traps,
        warnings: entry.warnings,
        variations: entry.variations,
        trapLines: entry.trapLines ?? null,
        warningLines: entry.warningLines ?? null,
        drillAccuracy: 0,
        drillAttempts: 0,
        lastStudied: null,
        woodpeckerReps: 0,
        woodpeckerSpeed: null,
        woodpeckerLastDate: null,
        isFavorite: false,
        ...defaults,
      };
    },
  );

  // bulkPut: upserts so we can re-seed without data loss
  await db.openings.bulkPut(records);
}

// ─── Pro Repertoire Loader ────────────────────────────────────────────────────

interface ProRepertoireEntry extends RepertoireEntry {
  playerId: string;
}

export async function loadProRepertoireData(): Promise<void> {
  const defaults = createDefaultSrsFields();
  const entries = (proRepertoireData as { openings: ProRepertoireEntry[] }).openings;

  const records: OpeningRecord[] = entries.map((entry) => {
    const { fen, uci } = computePosition(entry.pgn);

    return {
      id: entry.id,
      eco: entry.eco,
      name: entry.name,
      pgn: entry.pgn,
      uci,
      fen,
      color: entry.color,
      style: entry.style,
      isRepertoire: false,
      proPlayerId: entry.playerId,
      overview: entry.overview,
      keyIdeas: entry.keyIdeas,
      traps: entry.traps,
      warnings: entry.warnings,
      variations: entry.variations,
      trapLines: entry.trapLines ?? null,
      warningLines: entry.warningLines ?? null,
      drillAccuracy: 0,
      drillAttempts: 0,
      lastStudied: null,
      woodpeckerReps: 0,
      woodpeckerSpeed: null,
      woodpeckerLastDate: null,
      isFavorite: false,
      ...defaults,
    };
  });

  await db.openings.bulkPut(records);
}

/**
 * Reconcile `pro-repertoires.json` content into Dexie for already-
 * seeded users. No-op when the meta-stored revision matches the
 * current `PRO_DATA_REVISION` constant; otherwise walks every entry
 * in the JSON and merges static content fields onto the existing
 * Dexie record (or inserts fresh when the id is new).
 *
 * User-progress fields are preserved across the merge:
 *   isRepertoire, drillAccuracy, drillAttempts, lastStudied,
 *   woodpeckerReps, woodpeckerSpeed, woodpeckerLastDate,
 *   variationAccuracy, drillHistory, linesDiscovered,
 *   linesPerfected, isFavorite, srs* fields.
 *
 * Static fields rewritten from the JSON:
 *   eco, name, pgn, uci, fen, color, style, proPlayerId, overview,
 *   keyIdeas, traps, warnings, variations, trapLines, warningLines.
 *
 * Entries that disappear from the JSON are left in Dexie untouched
 * (orphaned records won't surface in the player-list UI but a user
 * who had stats on them keeps that history).
 */
export async function reconcileProRepertoires(): Promise<void> {
  const meta = await db.meta.get(PRO_REVISION_KEY);
  if (meta?.value === PRO_DATA_REVISION) return;

  const defaults = createDefaultSrsFields();
  const entries = (proRepertoireData as { openings: ProRepertoireEntry[] }).openings;

  const toPut: OpeningRecord[] = [];
  for (const entry of entries) {
    const { fen, uci } = computePosition(entry.pgn);
    const existing = await db.openings.get(entry.id);

    if (existing) {
      toPut.push({
        ...existing,
        eco: entry.eco,
        name: entry.name,
        pgn: entry.pgn,
        uci,
        fen,
        color: entry.color,
        style: entry.style,
        proPlayerId: entry.playerId,
        overview: entry.overview,
        keyIdeas: entry.keyIdeas,
        traps: entry.traps,
        warnings: entry.warnings,
        variations: entry.variations,
        trapLines: entry.trapLines ?? null,
        warningLines: entry.warningLines ?? null,
      });
    } else {
      toPut.push({
        id: entry.id,
        eco: entry.eco,
        name: entry.name,
        pgn: entry.pgn,
        uci,
        fen,
        color: entry.color,
        style: entry.style,
        isRepertoire: false,
        proPlayerId: entry.playerId,
        overview: entry.overview,
        keyIdeas: entry.keyIdeas,
        traps: entry.traps,
        warnings: entry.warnings,
        variations: entry.variations,
        trapLines: entry.trapLines ?? null,
        warningLines: entry.warningLines ?? null,
        drillAccuracy: 0,
        drillAttempts: 0,
        lastStudied: null,
        woodpeckerReps: 0,
        woodpeckerSpeed: null,
        woodpeckerLastDate: null,
        isFavorite: false,
        ...defaults,
      });
    }
  }

  await db.openings.bulkPut(toPut);
  await db.meta.put({ key: PRO_REVISION_KEY, value: PRO_DATA_REVISION });
}

// ─── Gambit Loader ───────────────────────────────────────────────────────────

export async function loadGambitData(): Promise<void> {
  const defaults = createDefaultSrsFields();

  const records: OpeningRecord[] = (gambitData as RepertoireEntry[]).map(
    (entry) => {
      const { fen, uci } = computePosition(entry.pgn);

      return {
        id: entry.id,
        eco: entry.eco,
        name: entry.name,
        pgn: entry.pgn,
        uci,
        fen,
        color: entry.color,
        style: entry.style,
        isRepertoire: false,
        isGambit: true,
        overview: entry.overview,
        keyIdeas: entry.keyIdeas,
        traps: entry.traps,
        warnings: entry.warnings,
        variations: entry.variations,
        trapLines: entry.trapLines ?? null,
        warningLines: entry.warningLines ?? null,
        drillAccuracy: 0,
        drillAttempts: 0,
        lastStudied: null,
        woodpeckerReps: 0,
        woodpeckerSpeed: null,
        woodpeckerLastDate: null,
        isFavorite: false,
        ...defaults,
      };
    },
  );

  await db.openings.bulkPut(records);
}

// ─── Model Games Loader ──────────────────────────────────────────────────────

export async function loadModelGamesData(): Promise<void> {
  const records = (modelGamesData as ModelGame[]).map((entry) => ({
    ...entry,
  }));
  await db.modelGames.bulkPut(records);
}

// ─── Middlegame Plans Loader ─────────────────────────────────────────────────

export async function loadMiddlegamePlansData(): Promise<void> {
  const records = (middlegamePlansData as MiddlegamePlan[]).map((entry) => ({
    ...entry,
  }));
  await db.middlegamePlans.bulkPut(records);
}

// ─── Flashcard Seeder ─────────────────────────────────────────────────────────

/**
 * Generates flashcard decks for all repertoire openings that don't yet have
 * cards. Skips openings already seeded.
 */
export async function seedFlashcardsForRepertoire(): Promise<void> {
  const repertoire = await db.openings
    .filter((o) => o.isRepertoire)
    .toArray();

  for (const opening of repertoire) {
    if (!opening.variations?.length) continue;

    const existing = await db.flashcards
      .where('openingId')
      .equals(opening.id)
      .count();

    if (existing > 0) continue;

    await generateFlashcardsForOpening(opening);
  }
}

function generateFlashcardsForOpening(opening: OpeningRecord): Promise<void> {
  const defaults = createDefaultSrsFields();
  const cards: FlashcardRecord[] = [];
  const today = new Date().toISOString().split('T')[0];

  // Card 1: Name the opening (position → name)
  cards.push({
    id: `${opening.id}-name-0`,
    openingId: opening.id,
    type: 'name_opening',
    questionFen: opening.fen,
    questionText: 'Name this opening position.',
    answerMove: null,
    answerText: `${opening.name} (ECO ${opening.eco}). ${opening.overview ?? ''}`,
    srsInterval: defaults.interval,
    srsEaseFactor: defaults.easeFactor,
    srsRepetitions: defaults.repetitions,
    srsDueDate: today,
    srsLastReview: null,
  });

  // Card 2: Explain the opening idea
  if (opening.keyIdeas?.length) {
    cards.push({
      id: `${opening.id}-idea-0`,
      openingId: opening.id,
      type: 'explain_idea',
      questionFen: opening.fen,
      questionText: `What are the key ideas in the ${opening.name}?`,
      answerMove: null,
      answerText: opening.keyIdeas.join(' | '),
      srsInterval: defaults.interval,
      srsEaseFactor: defaults.easeFactor,
      srsRepetitions: defaults.repetitions,
      srsDueDate: today,
      srsLastReview: null,
    });
  }

  // Cards 3+: One card per variation (best move type)
  (opening.variations ?? []).forEach((variation, i) => {
    const { fen } = computePosition(variation.pgn);
    cards.push({
      id: `${opening.id}-var-${i}`,
      openingId: opening.id,
      type: 'best_move',
      questionFen: fen,
      questionText: `What is the key idea in the ${variation.name}?`,
      answerMove: null,
      answerText: variation.explanation,
      srsInterval: defaults.interval,
      srsEaseFactor: defaults.easeFactor,
      srsRepetitions: defaults.repetitions,
      srsDueDate: today,
      srsLastReview: null,
    });
  });

  // WO-REAL-FIXES — bulkPut (upsert). See dbService.populateFromOpenings
  // for the rationale; same deterministic-id collision pattern.
  return db.flashcards.bulkPut(cards).then(() => undefined);
}

// ─── Opening Narrations ──────────────────────────────────────────────────────

async function loadOpeningNarrations(): Promise<void> {
  await db.openingNarrations.bulkPut(CURATED_NARRATIONS);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Seeds the database on first launch. Safe to call on every app start —
 * the bulk seed is a no-op if already seeded, but pro-repertoire
 * content is reconciled on every boot so existing users pick up
 * trapLines/warningLines/variations/explanation updates without
 * losing drill progress. See `reconcileProRepertoires` for details.
 */
export async function seedDatabase(): Promise<void> {
  if (!(await isDatabaseSeeded())) {
    await loadEcoData();
    await loadRepertoireData();
    await loadProRepertoireData();
    await loadGambitData();
    await loadModelGamesData();
    await loadMiddlegamePlansData();
    await seedFlashcardsForRepertoire();
    await loadOpeningNarrations();
    await markDatabaseSeeded();
    // Fresh seed already used the current JSON — mark the revision
    // so the reconcile path no-ops on the next boot.
    await db.meta.put({ key: PRO_REVISION_KEY, value: PRO_DATA_REVISION });
    return;
  }

  // Already-seeded users: reconcile pro content on every boot so
  // updates to pro-repertoires.json reach them without wiping
  // drill/SRS/favorites/woodpecker progress.
  await reconcileProRepertoires();
}
