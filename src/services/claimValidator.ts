/**
 * claimValidator
 * --------------
 * Post-response gate for the coach grounding pipeline (Layer D of
 * WO-COACH-MASTER-INTEGRATION). Scans LLM output for chess claims
 * that should be grounded in this turn's master-play context.
 *
 * The four claim kinds detected:
 *
 *   - san         — standard algebraic notation tokens (Nf3, exd5, O-O,
 *                   etc.). Each SAN in the response must appear in the
 *                   context's moves[].san (current FEN or any look-ahead).
 *   - numeric     — percentages ("73%"), game counts ("4,200 games"),
 *                   master ratings ("2542 average rating"). Each must
 *                   match — within tolerance — a number derivable from
 *                   the context.
 *   - entity      — named players (Carlsen, Kasparov, …), years
 *                   (19xx / 20xx), event names. Each must appear in
 *                   the context.topGames attribution.
 *   - comparative — "most popular X", "more common than Y", "best-
 *                   scoring move", etc. The X/Y must be backed by
 *                   the context's sort order or game counts.
 *
 * Contract:
 *   - When `context` is undefined, the validator is a no-op
 *     (returns ok:true). Layer B decides whether to pre-inject;
 *     casual chat ("hi", "what's the Sicilian?") doesn't go through
 *     the validator. coachApi only validates when it injected context.
 *   - Two grounding sources count as "has data":
 *       (1) MASTER-PLAY — `context.current` with `source !== 'none'`
 *           and a non-empty `moves[]`. Carries SAN popularity,
 *           percentages, game counts, ratings, `topGames` attribution.
 *       (2) OPENING-DB — `context.dbEntries[]` populated from
 *           `openings-lichess.json` (canonical Lichess names + PGNs).
 *           Carries SANs and historical names (Steinitz, Marshall, …)
 *           but NO frequency / rating data.
 *     SAN and player-name validation accept matches from EITHER source.
 *     Percentage / game-count / rating / year / comparative validation
 *     still requires master-play data (DB has none).
 *   - When BOTH sources are empty (rare — only when the prefetch failed
 *     AND no opening was named or detected), even a single SAN /
 *     percentage / player name is a violation: the LLM was supposed to
 *     say "I can't verify which moves are sound" instead.
 *
 * Returns a `ClaimValidationResult` with `ok` flag and an array of
 * `ClaimViolation` describing each tripped claim. Callers (coachApi)
 * emit `claim-validator-trip` audit events per violation and decide
 * whether to retry, escalate, or pass through.
 *
 * Designed to be conservative — false positives (catching legitimate
 * claims as violations) result in extra LLM calls; false negatives
 * (letting hallucinations through) defeat the purpose. We err toward
 * extra calls.
 */

import type { MasterPlayContext, MasterPlayResult, MasterPlayMove } from './masterPlayTypes';

export type ClaimViolationKind = 'san' | 'numeric' | 'entity' | 'comparative';

export interface ClaimViolation {
  kind: ClaimViolationKind;
  /** The exact substring that tripped the check. */
  claim: string;
  /** Human-readable reason — appears in the audit event. */
  reason: string;
}

export interface ClaimValidationResult {
  ok: boolean;
  violations: ReadonlyArray<ClaimViolation>;
}

// ─── SAN extraction ─────────────────────────────────────────────────

/** Match SAN tokens in prose:
 *   - piece moves: Nf3, Qxh7+, Rxe1#, Nbd7
 *   - pawn moves: e4, exd5, e8=Q+
 *   - castling:  O-O, O-O-O
 *  Excludes lone letters and isolated coords by requiring move shape.
 *  Word boundaries on both sides keep it from chewing into prose. */
const SAN_RE =
  /(?<![A-Za-z0-9])(?:O-O-O|O-O|(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)|(?:[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?)|(?:[a-h][1-8](?:=[QRBN])?[+#]?))(?![A-Za-z0-9])/g;

/** Pawn moves like "e4", "d6" are also legitimate non-chess words in
 *  contexts like "e4 squares" / "the e4 pawn." Don't tag them as
 *  hallucinations just because they're in prose. We only flag pawn
 *  push SANs when they appear in a move-recommendation pattern. */
const PAWN_MOVE_RECOMMENDATION_PATTERN =
  /(?:play|plays|playing|recommend|prefer|choose|consider|try|book move is|here\s+is|move is|with|after)\s+([a-h][1-8])\b/gi;

function extractSans(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = SAN_RE.exec(text))) {
    const san = m[0];
    // Filter pawn moves to those clearly used as move recommendations.
    if (/^[a-h][1-8]$/.test(san)) {
      continue;
    }
    if (!seen.has(san)) {
      seen.add(san);
      out.push(san);
    }
  }
  // Add pawn moves found in recommendation patterns.
  let pm: RegExpExecArray | null;
  while ((pm = PAWN_MOVE_RECOMMENDATION_PATTERN.exec(text))) {
    const san = pm[1];
    if (!seen.has(san)) {
      seen.add(san);
      out.push(san);
    }
  }
  return out;
}

function collectKnownSans(context: MasterPlayContext): Set<string> {
  const set = new Set<string>();
  for (const m of context.current.moves) set.add(m.san);
  for (const lookahead of context.lookahead) {
    for (const m of lookahead.result.moves) set.add(m.san);
    // The transition move itself is also "known" — it's what the
    // LLM was told the position would arise from.
    set.add(lookahead.moveFromCurrent);
  }
  // DB-grounding: every SAN in a related opening-DB entry is canon.
  // This is the "Steinitz Gambit plays 3.f4" path — when the user
  // asks about a named opening, its canonical move sequence (and the
  // move sequences of its named sub-variations) count as book theory
  // even if not in the live Lichess top-N for the exact current FEN.
  if (context.dbEntries) {
    for (const e of context.dbEntries) {
      for (const san of e.sans) set.add(san);
    }
  }
  return set;
}

// ─── Numeric extraction ─────────────────────────────────────────────

/** Percentages: "73%", "73.5 %", " 73 percent ". Captures the number. */
const PERCENT_RE = /\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
/** Game counts: "4,200 games", "5000 master games". Captures the number
 *  (digits + optional thousands separators). */
const GAME_COUNT_RE = /\b(\d{1,3}(?:,\d{3})+|\d{2,})\s*(?:master\s+)?games?\b/gi;
/** Ratings: "2542", "2400-rated", "rated 2700". Capture the rating value.
 *  Restricts to 4-digit numbers in the chess-rating range. */
const RATING_RE = /\b(?:rated|rating(?:\s+of)?|average\s+rating(?:\s+of)?|elo)\s+(\d{4})\b/gi;
const RATING_BARE_RE = /\b(2[0-9]{3}|3[0-2][0-9]{2})\b/g;

function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

function pctNumbersFromContext(result: MasterPlayResult): number[] {
  // Each move contributes its three percentages plus its share of
  // total games. Express as 0-100 to match how prose reports them.
  const pcts: number[] = [];
  for (const m of result.moves) {
    pcts.push(m.whitePct * 100);
    pcts.push(m.drawPct * 100);
    pcts.push(m.blackPct * 100);
    if (result.totalGames > 0) {
      pcts.push((m.games / result.totalGames) * 100);
    }
  }
  return pcts;
}

function gameCountsFromContext(result: MasterPlayResult): Set<number> {
  const set = new Set<number>();
  set.add(result.totalGames);
  for (const m of result.moves) set.add(m.games);
  return set;
}

function ratingsFromContext(result: MasterPlayResult): Set<number> {
  const set = new Set<number>();
  for (const m of result.moves) {
    if (typeof m.averageRating === 'number') set.add(m.averageRating);
  }
  if (result.topGames) {
    for (const g of result.topGames) {
      if (typeof g.whiteRating === 'number') set.add(g.whiteRating);
      if (typeof g.blackRating === 'number') set.add(g.blackRating);
    }
  }
  return set;
}

function numberIsClose(claim: number, candidates: Iterable<number>, tolerance: number): boolean {
  for (const c of candidates) {
    if (Math.abs(c - claim) <= tolerance) return true;
  }
  return false;
}

/** Game-count tolerance: ±10% or 50 games, whichever is larger.
 *  Prose like "around 4,000 games" should pass against a context of
 *  4,200; "5,000 games" against 4,200 should fail. */
function gameCountTolerance(claim: number): number {
  return Math.max(50, claim * 0.1);
}

// ─── Entity extraction ──────────────────────────────────────────────

/** Canonical player surnames the LLM is most likely to name. Match is
 *  case-insensitive and accepts the surname alone or "FirstName, S"
 *  shape. Patronyms / matronyms / variants kept manageable for v1. */
const CANONICAL_PLAYERS: ReadonlyArray<{ display: string; matchers: RegExp[] }> = [
  { display: 'Carlsen', matchers: [/\bcarlsen\b/i, /\bmagnus\b/i] },
  { display: 'Kasparov', matchers: [/\bkasparov\b/i, /\bgarry\b/i] },
  { display: 'Karpov', matchers: [/\bkarpov\b/i, /\banatoly\b/i] },
  { display: 'Fischer', matchers: [/\bfischer\b/i, /\bbobby\b/i] },
  { display: 'Spassky', matchers: [/\bspassky\b/i] },
  { display: 'Petrosian', matchers: [/\bpetrosian\b/i] },
  { display: 'Caruana', matchers: [/\bcaruana\b/i, /\bfabiano\b/i] },
  { display: 'Nakamura', matchers: [/\bnakamura\b/i, /\bhikaru\b/i] },
  { display: 'Anand', matchers: [/\banand\b/i, /\bviswanathan\b/i] },
  { display: 'Tal', matchers: [/\bmikhail\s+tal\b/i, /\btal\b/i] },
  { display: 'Capablanca', matchers: [/\bcapablanca\b/i] },
  { display: 'Alekhine', matchers: [/\balekhine\b/i] },
  { display: 'Botvinnik', matchers: [/\bbotvinnik\b/i] },
  { display: 'Lasker', matchers: [/\blasker\b/i] },
  { display: 'Steinitz', matchers: [/\bsteinitz\b/i] },
  { display: 'Polgar', matchers: [/\bjudit\s+polgar\b/i, /\bpolgar\b/i] },
  { display: 'Ding', matchers: [/\bding\s+liren\b/i] },
  { display: 'Nepomniachtchi', matchers: [/\bnepomniachtchi\b/i, /\bnepo\b/i] },
  { display: 'Aronian', matchers: [/\baronian\b/i] },
  { display: 'Praggnanandhaa', matchers: [/\bpraggnanandhaa\b/i, /\bpragg\b/i] },
  { display: 'Firouzja', matchers: [/\bfirouzja\b/i] },
  { display: 'Vachier-Lagrave', matchers: [/\bvachier[-\s]lagrave\b/i, /\bmvl\b/i] },
  { display: 'Giri', matchers: [/\bgiri\b/i] },
  { display: 'Wei Yi', matchers: [/\bwei\s+yi\b/i] },
  { display: 'Erigaisi', matchers: [/\berigaisi\b/i] },
  { display: 'Mamedyarov', matchers: [/\bmamedyarov\b/i] },
];

const YEAR_RE = /\b(19[0-9]{2}|20[0-2][0-9])\b/g;

function playerSeenInContext(canonical: string, context: MasterPlayContext): boolean {
  const surname = canonical.toLowerCase();
  // First: master-play `topGames` attribution (live Lichess or local DB).
  if (context.current.topGames && context.current.topGames.length > 0) {
    for (const g of context.current.topGames) {
      if ((g.white ?? '').toLowerCase().includes(surname)) return true;
      if ((g.black ?? '').toLowerCase().includes(surname)) return true;
    }
  }
  // DB-grounding fallback: the player's name embedded in a canonical
  // opening/variation name counts as historical attribution. Examples:
  // "Steinitz Gambit" → Steinitz; "Marshall Attack" → Marshall;
  // "Petroff's Defense" → Petroff; "Alekhine's Defense" → Alekhine;
  // "Tal Manoeuvre" → Tal. Without this, the validator killed every
  // response that mentioned Steinitz on a Vienna Steinitz Gambit
  // question because the position's master-play topGames didn't
  // happen to feature Steinitz playing — but the opening is LITERALLY
  // named after him.
  if (context.dbEntries) {
    for (const e of context.dbEntries) {
      if (e.name.toLowerCase().includes(surname)) return true;
    }
  }
  return false;
}

function yearSeenInContext(year: number, context: MasterPlayContext): boolean {
  if (!context.current.topGames || context.current.topGames.length === 0) return false;
  return context.current.topGames.some((g) => g.year === year);
}

// ─── Comparative-claim extraction ───────────────────────────────────

/** Pattern: "the most popular move is X" / "X is the most common".
 *  Captures the move/idea. The LLM tends to use a small set of comparative
 *  superlatives; v1 covers the most common ones. */
const COMPARATIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:the\s+)?most\s+(?:popular|common|played)(?:\s+move)?\s+(?:is|here\s+is)\s+([A-Za-z0-9+#=-]+)/gi,
  /\b([A-Za-z0-9+#=-]+)\s+is\s+(?:the\s+)?most\s+(?:popular|common|played)/gi,
  /\bbest[- ]scoring\s+(?:move\s+)?(?:is|here\s+is)\s+([A-Za-z0-9+#=-]+)/gi,
];

function topMoveFromContext(context: MasterPlayContext): string | undefined {
  return context.current.moves[0]?.san;
}

// ─── Validator ──────────────────────────────────────────────────────

/**
 * Run all four checks. Push violations into the result array.
 */
export function validateClaims(
  response: string,
  context?: MasterPlayContext,
): ClaimValidationResult {
  // No context → validator is a no-op. coachApi only validates when
  // it pre-injected, so casual chat doesn't trip.
  if (!context) {
    return { ok: true, violations: [] };
  }

  const violations: ClaimViolation[] = [];
  const hasMasterData = context.current.source !== 'none' && context.current.moves.length > 0;
  const hasDbData = (context.dbEntries?.length ?? 0) > 0;
  // "hasData" here means we have ANY grounding source — live
  // master-play OR canonical opening DB. The DB-grounding extension
  // means an empty Lichess explorer no longer forces a stock-out when
  // the question is about a named opening that exists in the DB.
  const hasData = hasMasterData || hasDbData;
  const knownSans = collectKnownSans(context);

  // ── SAN check ────────────────────────────────────────────────────
  const sans = extractSans(response);
  for (const san of sans) {
    if (!hasData) {
      violations.push({
        kind: 'san',
        claim: san,
        reason: 'response cites a SAN but master-play context has no data (source:none) for this position',
      });
      continue;
    }
    if (!knownSans.has(san)) {
      violations.push({
        kind: 'san',
        claim: san,
        reason: `SAN "${san}" not present in master-play context for this position (known: ${Array.from(knownSans).slice(0, 6).join(', ')}…)`,
      });
    }
  }

  // ── Percentage check ─────────────────────────────────────────────
  // Percentages, game counts, ratings, and comparative claims still
  // require live master-play data — the openings DB has no popularity
  // statistics. So these checks use `hasMasterData` not `hasData`.
  const contextPcts = hasMasterData ? pctNumbersFromContext(context.current) : [];
  for (const m of contextPcts) void m; // capacity hint only
  let p: RegExpExecArray | null;
  PERCENT_RE.lastIndex = 0;
  while ((p = PERCENT_RE.exec(response))) {
    const value = parseNumber(p[1]);
    if (!hasMasterData) {
      violations.push({
        kind: 'numeric',
        claim: p[0],
        reason: 'percentage cited but master-play context has no data',
      });
      continue;
    }
    if (!numberIsClose(value, contextPcts, 3)) {
      violations.push({
        kind: 'numeric',
        claim: p[0],
        reason: `percentage ${value}% does not match any percentage derivable from this turn's master-play context (±3)`,
      });
    }
  }

  // ── Game count check ─────────────────────────────────────────────
  const contextCounts = hasMasterData ? gameCountsFromContext(context.current) : new Set<number>();
  let c: RegExpExecArray | null;
  GAME_COUNT_RE.lastIndex = 0;
  while ((c = GAME_COUNT_RE.exec(response))) {
    const value = parseNumber(c[1]);
    if (!hasMasterData) {
      violations.push({
        kind: 'numeric',
        claim: c[0],
        reason: 'game count cited but master-play context has no data',
      });
      continue;
    }
    const tol = gameCountTolerance(value);
    if (!numberIsClose(value, contextCounts, tol)) {
      violations.push({
        kind: 'numeric',
        claim: c[0],
        reason: `game count ${value} does not match any count derivable from this turn's master-play context (±${tol.toFixed(0)})`,
      });
    }
  }

  // ── Rating check ─────────────────────────────────────────────────
  const contextRatings = hasMasterData ? ratingsFromContext(context.current) : new Set<number>();
  // Only require explicit "rated/rating ..." patterns to flag — bare
  // 4-digit numbers without rating context could just be years.
  let r: RegExpExecArray | null;
  RATING_RE.lastIndex = 0;
  while ((r = RATING_RE.exec(response))) {
    const value = parseNumber(r[1]);
    if (!hasMasterData) {
      violations.push({
        kind: 'numeric',
        claim: r[0],
        reason: 'rating cited but master-play context has no data',
      });
      continue;
    }
    if (!numberIsClose(value, contextRatings, 30)) {
      violations.push({
        kind: 'numeric',
        claim: r[0],
        reason: `rating ${value} does not match any rating derivable from this turn's master-play context (±30)`,
      });
    }
  }
  // Bare 4-digit numbers in chess-rating range: only flag when the
  // sentence also contains chess-rating cues to avoid year false-positives.
  if (hasMasterData) {
    RATING_BARE_RE.lastIndex = 0;
    while ((r = RATING_BARE_RE.exec(response))) {
      const value = parseNumber(r[1]);
      // Skip if it's a known year in context (probably a year reference).
      if (context.current.topGames?.some((g) => g.year === value)) continue;
      // Only flag if the surrounding 30 chars mention rating cues.
      const start = Math.max(0, r.index - 30);
      const end = Math.min(response.length, r.index + r[0].length + 30);
      const window = response.slice(start, end).toLowerCase();
      if (!/(rated|rating|elo|strength)/.test(window)) continue;
      if (!numberIsClose(value, contextRatings, 30)) {
        violations.push({
          kind: 'numeric',
          claim: r[0],
          reason: `rating ${value} in rating context does not match any rating derivable from this turn's master-play context (±30)`,
        });
      }
    }
  }

  // ── Player + year check ──────────────────────────────────────────
  for (const player of CANONICAL_PLAYERS) {
    for (const re of player.matchers) {
      if (re.test(response)) {
        if (!playerSeenInContext(player.display, context)) {
          violations.push({
            kind: 'entity',
            claim: player.display,
            reason: hasData
              ? `mentions ${player.display} but no topGames attribution in this turn's master-play context, and no opening-DB entry name matches`
              : `mentions ${player.display} but neither master-play nor opening-DB context has data (cannot attribute)`,
          });
        }
        break;
      }
    }
  }

  let y: RegExpExecArray | null;
  YEAR_RE.lastIndex = 0;
  while ((y = YEAR_RE.exec(response))) {
    const year = parseNumber(y[1]);
    // Only flag a year as an entity violation when it sits in a chess-
    // attribution-shaped sentence (e.g. "in 1985 Karpov…"). Bare year
    // references in non-chess prose are too noisy.
    const start = Math.max(0, y.index - 40);
    const end = Math.min(response.length, y.index + y[0].length + 40);
    const window = response.slice(start, end).toLowerCase();
    const attributionCue = /(played|game|world|championship|match|tournament|defeated|beat)/.test(window);
    if (!attributionCue) continue;
    if (!yearSeenInContext(year, context)) {
      violations.push({
        kind: 'entity',
        claim: y[0],
        reason: hasMasterData
          ? `attributes a game/event to ${year} but no topGame in this turn's context matches that year`
          : `attributes a year ${year} but master-play context has no data`,
      });
    }
  }

  // ── Comparative check ────────────────────────────────────────────
  // Comparative claims ("most popular", "best-scoring") require live
  // master-play popularity data — the opening DB has no frequency
  // statistics. Skip this check entirely when only DB grounding
  // applies.
  const topMove = topMoveFromContext(context);
  for (const pat of COMPARATIVE_PATTERNS) {
    pat.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = pat.exec(response))) {
      const claimed = cm[1];
      if (!hasMasterData) {
        violations.push({
          kind: 'comparative',
          claim: cm[0],
          reason: 'makes a comparative claim but master-play context has no data to back it',
        });
        continue;
      }
      // Compare claimed move to the top one in context. Case-insensitive
      // and tolerant of "the X" prefixes.
      const normalized = claimed.replace(/[.,;:!?"']/g, '').trim();
      if (topMove && normalized.toLowerCase() !== topMove.toLowerCase()) {
        violations.push({
          kind: 'comparative',
          claim: cm[0],
          reason: `claims "${normalized}" is most popular but top master move in context is "${topMove}"`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/** Type helpers exposed to callers (coachApi) for unit-test access. */
export type { MasterPlayContext, MasterPlayResult, MasterPlayMove };
