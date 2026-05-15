/**
 * walkthroughLlmNarrator
 * ----------------------
 * On-demand LLM narration for opening walkthroughs. Fills in real
 * teaching content when the curated annotation JSON either has no
 * entry for a move or has one of the auto-generated filler templates
 * (suppressed via isGenericAnnotationText).
 *
 * One batched LLM call per walkthrough: we send the whole move list
 * with per-move FEN-after context and ask for a JSON array of
 * narrations. Results are cached in Dexie's `meta` table keyed by a
 * stable hash of (opening name + PGN + variation) so repeat visits
 * don't re-spend tokens.
 *
 * The service composes with curated real annotations — if a move
 * already has a curated non-filler annotation we keep it and only
 * ask the LLM for the rest. That way the curator's work always wins.
 */
import { Chess } from 'chess.js';
import { getCoachChatResponse } from './coachApi';
import { isGenericAnnotationText } from './walkthroughNarration';
import { db } from '../db/schema';

/** Cache version — bump to invalidate all previously-cached narrations
 *  when the prompt / output format changes. v2 invalidates entries
 *  cached before the WalkthroughMode merge fix that lets curated
 *  `annotation` text win over potentially-filler LLM output. */
const CACHE_VERSION = 'v2';

export interface WalkthroughNarrationInput {
  openingName: string;
  /** Variation name, if this walkthrough is for a specific sub-line. */
  variationName?: string;
  /** Space-separated SAN moves, e.g. "d4 Nf6 c4 e6 g3 d5". */
  pgn: string;
  /** Starting FEN. Defaults to the standard starting position. */
  startFen?: string;
  /**
   * Existing per-move narrations (curated). The narrator skips moves
   * whose existing entry is real content and only generates for moves
   * whose entry is empty or generic filler.
   */
  existingNarrations?: (string | undefined)[];
}

export interface WalkthroughNarrationResult {
  /** One narration per move, indexed by ply (0-based). Empty string if
   *  the LLM couldn't produce content for that move. */
  narrations: string[];
  /** Whether the result came from the in-memory/Dexie cache. */
  fromCache: boolean;
}

const STANDARD_START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Generate teaching-quality per-move narration for an opening
 * walkthrough. Uses a batched LLM call and caches in Dexie.
 */
export async function generateWalkthroughNarrations(
  input: WalkthroughNarrationInput,
): Promise<WalkthroughNarrationResult> {
  const startFen = input.startFen ?? STANDARD_START_FEN;
  const moves = input.pgn.trim().split(/\s+/).filter(Boolean);
  if (moves.length === 0) {
    return { narrations: [], fromCache: false };
  }

  // Build per-move context (SAN + FEN after the move) for the prompt
  // and the cache key. Invalid moves truncate the walkthrough — we
  // respect the same truncation when caching.
  const perMove = buildPerMoveContext(startFen, moves);
  if (perMove.length === 0) {
    return { narrations: [], fromCache: false };
  }

  const cacheKey = buildCacheKey(input, perMove);
  const cached = await readCache(cacheKey);
  if (cached && cached.length === perMove.length) {
    return { narrations: mergeWithExisting(cached, input.existingNarrations), fromCache: true };
  }

  // Figure out which moves actually need an LLM narration. Keep any
  // curated real annotations and only ask the model for the rest.
  const existing = input.existingNarrations ?? [];
  const needsGeneration: number[] = [];
  for (let i = 0; i < perMove.length; i++) {
    const existingText = existing[i]?.trim() ?? '';
    if (!existingText || isGenericAnnotationText(existingText)) {
      needsGeneration.push(i);
    }
  }

  // Everything curated — nothing to ask the LLM for.
  if (needsGeneration.length === 0) {
    const out = perMove.map((_, i) => (existing[i] ?? '').trim());
    await writeCache(cacheKey, out);
    return { narrations: out, fromCache: false };
  }

  const llmNarrations = await requestLlmNarrations(
    input.openingName,
    input.variationName,
    perMove,
    needsGeneration,
  );

  // Fold LLM output back into the full array, preserving curated
  // entries where they exist.
  const merged = perMove.map((_, i) => {
    const curated = (existing[i] ?? '').trim();
    if (curated && !isGenericAnnotationText(curated)) return curated;
    return llmNarrations[i] ?? '';
  });

  await writeCache(cacheKey, merged);
  return { narrations: merged, fromCache: false };
}

interface PerMoveContext {
  index: number;
  ply: number;
  moveNumber: number;
  sideToMove: 'White' | 'Black';
  san: string;
  fenAfter: string;
}

function buildPerMoveContext(startFen: string, sanMoves: string[]): PerMoveContext[] {
  const chess = new Chess(startFen);
  const out: PerMoveContext[] = [];
  for (let i = 0; i < sanMoves.length; i++) {
    const san = sanMoves[i];
    const sideToMove: 'White' | 'Black' = chess.turn() === 'w' ? 'White' : 'Black';
    let moved;
    try {
      moved = chess.move(san);
    } catch {
      break;
    }
    out.push({
      index: i,
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      sideToMove,
      san: moved.san,
      fenAfter: chess.fen(),
    });
  }
  return out;
}

async function requestLlmNarrations(
  openingName: string,
  variationName: string | undefined,
  perMove: PerMoveContext[],
  indices: number[],
): Promise<string[]> {
  const moveList = perMove
    .map(
      (m) =>
        `${m.ply}. ${m.sideToMove} ${m.san}` +
        (indices.includes(m.index) ? '  [NARRATE]' : '  [skip — curated]'),
    )
    .join('\n');

  const header = variationName
    ? `Opening: ${openingName} — ${variationName}`
    : `Opening: ${openingName}`;

  const systemAdditions = [
    'You are a chess opening coach writing per-move narration for a walkthrough lesson.',
    'For EVERY move tagged [NARRATE], produce ONE narration sentence (max 28 words) that actually teaches. Follow ARA: Annotation (what was played and where), Reasoning (the purpose — a concrete feature like central control, piece activity, king safety, a specific plan), Action (what this move threatens, prepares, or restricts).',
    'Cite concrete squares, files, diagonals, or pieces. Do NOT say "develops naturally", "heads toward the critical moment", "position is roughly equal", or any generic filler. If the move is a standard developing move, explain WHY that particular square matters in this opening.',
    'For moves tagged [skip], return an empty string in that slot.',
    'Return a JSON array of strings, exactly one entry per move in order. No markdown, no prose before or after.',
  ].join(' ');

  const userMessage = [
    header,
    '',
    'Move list (annotate only moves tagged [NARRATE]):',
    moveList,
    '',
    `Return a JSON array of exactly ${perMove.length} strings.`,
  ].join('\n');

  try {
    const raw = await getCoachChatResponse(
      [{ role: 'user', content: userMessage }],
      systemAdditions,
      undefined,
      'chat_response',
      1200,
    );
    const parsed = extractJsonArray(raw);
    if (Array.isArray(parsed)) {
      return perMove.map((_, i) => {
        const entry = parsed[i];
        return typeof entry === 'string' && entry.trim() ? entry.trim() : '';
      });
    }
  } catch (err: unknown) {
    console.warn('[walkthroughLlmNarrator] batch call failed:', err);
  }
  return perMove.map(() => '');
}

function mergeWithExisting(
  cached: string[],
  existing: (string | undefined)[] | undefined,
): string[] {
  if (!existing) return cached;
  return cached.map((narration, i) => {
    const curated = (existing[i] ?? '').trim();
    if (curated && !isGenericAnnotationText(curated)) return curated;
    return narration;
  });
}

function buildCacheKey(
  input: WalkthroughNarrationInput,
  perMove: PerMoveContext[],
): string {
  const pgnHash = simpleHash(perMove.map((m) => m.san).join(' '));
  const variation = input.variationName ? `:${input.variationName}` : '';
  return `walkthrough-narr:${CACHE_VERSION}:${input.openingName}${variation}:${pgnHash}`;
}

/** Cheap FNV-style string hash — collision-resistant enough for a
 *  cache key prefix on a single-user database. */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

interface CachedNarrations {
  version: string;
  createdAt: number;
  narrations: string[];
}

async function readCache(key: string): Promise<string[] | null> {
  try {
    const entry = await db.meta.get(key);
    if (!entry) return null;
    const payload = parseCache(entry.value);
    if (!payload) return null;
    if (payload.version !== CACHE_VERSION) return null;
    return payload.narrations;
  } catch {
    return null;
  }
}

async function writeCache(key: string, narrations: string[]): Promise<void> {
  // Only bother caching if at least one narration has real content —
  // avoid filling the cache with empty arrays from failed LLM calls.
  if (!narrations.some((n) => n.trim().length > 0)) return;
  const payload: CachedNarrations = {
    version: CACHE_VERSION,
    createdAt: Date.now(),
    narrations,
  };
  try {
    await db.meta.put({ key, value: JSON.stringify(payload) });
  } catch {
    // Cache write failures shouldn't break the walkthrough.
  }
}

function parseCache(raw: string): CachedNarrations | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'narrations' in parsed
    ) {
      const p = parsed as { version: unknown; narrations: unknown };
      if (
        typeof p.version === 'string' &&
        Array.isArray(p.narrations) &&
        p.narrations.every((n) => typeof n === 'string')
      ) {
        return {
          version: p.version,
          narrations: p.narrations,
          createdAt: 0,
        };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function extractJsonArray(raw: string): unknown[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    const direct: unknown = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct as unknown[];
  } catch {
    /* fall through */
  }
  // Strip markdown fences / leading prose and retry.
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const second: unknown = JSON.parse(match[0]);
      if (Array.isArray(second)) return second as unknown[];
    } catch {
      /* give up */
    }
  }
  return null;
}
