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
 *  when the prompt / output format changes. v3 invalidates entries
 *  cached before the curator-context fix that feeds the opening's
 *  overview / keyIdeas / variation explanation INTO the LLM prompt
 *  so per-move narration aligns with the variation's actual point
 *  (caught after a 2026-05-17 audit showed a Fantasy Caro walkthrough
 *  describing the Classical Caro because the LLM had no idea what
 *  variation it was narrating). */
const CACHE_VERSION = 'v3';

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
  /**
   * Curator framing for the WHOLE opening — the overview text written
   * for the parent opening page. Without this, the LLM doesn't know
   * what the opening's strategic identity is and generates generic
   * commentary that often contradicts the variation's actual purpose
   * (e.g. recommending Nxe4 recapture in a Fantasy Caro where the
   * whole point is fxe4 for the open f-file). Pass `overview` from
   * OpeningRecord here.
   */
  openingOverview?: string;
  /**
   * Curator framing for the WHOLE opening — keyIdeas bullets from the
   * parent opening page. Same purpose as openingOverview: gives the
   * LLM the strategic themes to weave into per-move narration. Pass
   * `keyIdeas` from OpeningRecord here.
   */
  openingKeyIdeas?: string[];
  /**
   * Curator framing for the SPECIFIC variation — the explanation text
   * from the variation entry. This is the most important context:
   * it usually walks the actual move sequence and names the key
   * structural ideas (e.g. "after fxe4 you have the open f-file and
   * the Bc4 aimed at f7"). Without this, the LLM generates per-move
   * text that may directly contradict the variation's mainline plan.
   */
  variationExplanation?: string;
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
    {
      openingOverview: input.openingOverview,
      openingKeyIdeas: input.openingKeyIdeas,
      variationExplanation: input.variationExplanation,
    },
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

interface CuratorContext {
  openingOverview?: string;
  openingKeyIdeas?: string[];
  variationExplanation?: string;
}

async function requestLlmNarrations(
  openingName: string,
  variationName: string | undefined,
  perMove: PerMoveContext[],
  indices: number[],
  curator: CuratorContext = {},
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
    'You are given CURATOR CONTEXT describing the opening and the specific variation\'s strategic identity. Your per-move narrations MUST align with that context — never recommend a recapture, plan, or piece manoeuvre that contradicts what the curator framed. If the curator says "the whole point is fxe4 opening the f-file," do NOT recommend Nxe4 in your move-by-move narration.',
    'For EVERY move tagged [NARRATE], produce ONE narration sentence (max 28 words) that actually teaches. Follow ARA: Annotation (what was played and where), Reasoning (the purpose — a concrete feature like central control, piece activity, king safety, a specific plan), Action (what this move threatens, prepares, or restricts).',
    'Cite concrete squares, files, diagonals, or pieces. Do NOT say "develops naturally", "heads toward the critical moment", "position is roughly equal", or any generic filler. If the move is a standard developing move, explain WHY that particular square matters in THIS opening (the curator context tells you).',
    'For moves tagged [skip], return an empty string in that slot.',
    'Return a JSON array of strings, exactly one entry per move in order. No markdown, no prose before or after.',
  ].join(' ');

  // Build a curator-framing block IF the caller supplied context. The
  // LLM uses this to align per-move narration with the parent opening
  // page's overview/keyIdeas and the variation's own explanation —
  // preventing the cross-variation hallucinations the v2 prompt
  // produced (Fantasy Caro narrations describing Classical Caro plans,
  // etc.).
  const curatorBlock: string[] = [];
  if (curator.openingOverview && curator.openingOverview.trim()) {
    curatorBlock.push('CURATOR — Opening overview:', curator.openingOverview.trim(), '');
  }
  if (curator.openingKeyIdeas && curator.openingKeyIdeas.length > 0) {
    curatorBlock.push(
      'CURATOR — Key strategic ideas (use these to inform your narration; do NOT contradict):',
      ...curator.openingKeyIdeas.map((idea, i) => `${i + 1}. ${idea}`),
      '',
    );
  }
  if (curator.variationExplanation && curator.variationExplanation.trim()) {
    curatorBlock.push(
      'CURATOR — This specific variation\'s strategic point (ALIGN your per-move narration with this):',
      curator.variationExplanation.trim(),
      '',
    );
  }

  const userMessage = [
    header,
    '',
    ...curatorBlock,
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
  // Mix curator context into the cache key so that edits to the
  // overview / keyIdeas / variation explanation invalidate stale
  // cached narration. Without this, rewriting the curator data
  // (as happened in the 2026-05-17 narration sweep) would leave the
  // cached LLM output stuck on the OLD framing.
  const curatorSig = simpleHash(
    [
      input.openingOverview ?? '',
      (input.openingKeyIdeas ?? []).join('|'),
      input.variationExplanation ?? '',
    ].join('::'),
  );
  return `walkthrough-narr:${CACHE_VERSION}:${input.openingName}${variation}:${pgnHash}:${curatorSig}`;
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
