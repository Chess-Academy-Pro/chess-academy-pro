#!/usr/bin/env node
/**
 * audit-featured-narrations.mjs
 * -----------------------------
 * Focused, zero-cost narration audit for the surfaces the user actually
 * sees:
 *
 *   - The 40 openings in src/data/repertoire.json ("Most Common" tab)
 *       · main-line annotations (src/data/annotations/<id>.json)
 *       · content-only sublines (skips empty annotations)
 *       · inline variations[].explanation (audited against final FEN)
 *   - The ~80 pro entries in src/data/pro-repertoires.json ("Pro" tab)
 *       · top-level overview (audited against final FEN of main pgn)
 *       · variations[].explanation (audited against final FEN)
 *
 * Rules-based prose checks (port of src/services/narrationAuditor.ts):
 *   1. piece-on-square claim contradicts the position
 *   2. hanging-piece claim with no piece of that type on the board
 *   3. unambiguous check claim while position is not in check
 *   4. checkmate claim while position is not mate
 *   5. illegal SAN reference (capitalized N/B/R/Q/K-prefixed move not
 *      legal in the position)
 *   6. templated-filler match (would be silently dropped at runtime by
 *      walkthroughNarration.isGenericAnnotationText, mirrored here)
 *   7. arrow legality (annotation arrows whose from→to is not a legal
 *      move in fenBefore)
 *
 * Outputs audit-reports/featured-narrations.{json,md}.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Chess } from 'chess.js';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const outDir = join(repoRoot, 'audit-reports');
mkdirSync(outDir, { recursive: true });

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const MIN_PROSE_LEN = 20; // skip stubs / very short fragments

function readJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf-8'));
}

function tokensToSans(pgn) {
  return pgn
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d+\.+$/.test(t));
}

function replay(startFen, sans) {
  const chess = new Chess(startFen);
  const plies = [];
  for (let i = 0; i < sans.length; i++) {
    const fenBefore = chess.fen();
    let move;
    try {
      move = chess.move(sans[i]);
    } catch {
      plies.push({ moveIndex: i, san: sans[i], fenBefore, fenAfter: null, illegal: true });
      return plies;
    }
    plies.push({ moveIndex: i, san: move.san, fenBefore, fenAfter: chess.fen() });
  }
  return plies;
}

function finalFen(startFen, sans) {
  const plies = replay(startFen, sans);
  if (plies.length === 0) return startFen;
  const last = plies[plies.length - 1];
  return last.fenAfter ?? last.fenBefore;
}

// ─── Featured-ID loader ─────────────────────────────────────────────────────

function loadFeaturedIds() {
  const rep = readJson('src/data/repertoire.json');
  const pro = readJson('src/data/pro-repertoires.json');
  return {
    repertoire: rep,
    repertoireIds: new Set(rep.map((r) => r.id)),
    pro,
    proIds: new Set(pro.openings.map((o) => o.id)),
  };
}

// Resolve an opening id (or pro id) to the annotation file it should
// load — mirrors src/services/annotationService.ts. Returns null when
// no file exists (the pro entry is then audited from inline data only).
function resolveAnnotationFile(id) {
  const direct = `src/data/annotations/${id}.json`;
  try {
    readFileSync(join(repoRoot, direct), 'utf-8');
    return direct;
  } catch {
    /* fall through */
  }
  const m = /^pro-[a-z]+-(.+)$/.exec(id);
  if (m) {
    const bare = `src/data/annotations/${m[1]}.json`;
    try {
      readFileSync(join(repoRoot, bare), 'utf-8');
      return bare;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ─── Prose-rule checks (port of src/services/narrationAuditor.ts) ──────────

const PIECE_NAME_TO_LETTER = {
  pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k',
};

const PIECE_ON_SQUARE_RE =
  /\b(?:the|a|my|our|your|their|his|her|white(?:'s)?|black(?:'s)?)\s+(?:[a-z]+\s+)?(pawn|knight|bishop|rook|queen|king)\s+on\s+([a-h][1-8])\b/gi;

const HANGING_PIECE_RE =
  /\b(?:hanging|undefended|loose|dropped)\s+(pawn|knight|bishop|rook|queen|king)\b/gi;

const CHECK_CLAIM_RE =
  /\b(?:in\s+check|delivers?\s+check|delivering\s+check|giving\s+check)\b/i;

const MATE_CLAIM_RE = /\b(?:checkmate|forced\s+mate)\b/i;

const SAN_REF_RE = /\b((?:[NBRQK]x?)?[a-h][1-8])\b/g;

// Mirrors src/services/walkthroughNarration.ts GENERIC_ANNOTATION_PATTERNS
// — annotations matching ANY of these are silently dropped at runtime.
const GENERIC_PATTERNS = [
  /\bposition is heading toward the critical moment\b/i,
  /\bposition is becoming uncomfortable\b/i,
  /\bcareful defense is needed\b/i,
  /\bposition is roughly (equal|balanced)\b/i,
  /\bboth sides have chances\b/i,
  /\bThe position is sharp and requires precise play from this point forward\b/i,
  /\bThe key moment is approaching\b/i,
  /\bThe critical moment is approaching\b/i,
  /\bcritical moment in the trap\b/i,
  /\bcritical moment in the opening( battle)?\b/i,
  /\bThis is a critical moment where precise play is essential\b/i,
  /\bDevelopment with purpose\s*[—–-]\s*the \w+ on \w+ eyes important squares\b/i,
  /\bThe \w+ on \w+ improves (?:White|Black)'?s piece coordination and flexibility\b/i,
  /\bThis move contributes to (?:White|Black)'?s opening development and fight for central control\b/i,
  /\b(?:White|Black) improves piece placement heading into the critical phase of the game\b/i,
  /\bConnecting the rooks is a priority\b/i,
  /\bThe rook now enters the game on a central file\b/i,
  /\bCentral pawns control space and restrict the opponent'?s piece activity\b/i,
  /\bThis central advance fights for space and control of key squares\b/i,
  /\bControlling the center is the foundation of a strong position\b/i,
  /\bThis pawn move supports a future d-pawn advance, a key central plan\b/i,
  /\bGaining space here creates potential targets and restricts the opponent'?s counterplay\b/i,
  /\bA flank pawn advance, creating space on the (?:queenside|kingside)\b/i,
  /\bpawn advance gains space and can support a future attack toward the enemy king\b/i,
  /\bAn aggressive pawn advance, signaling kingside intentions and opening lines\b/i,
  /\bwas less effective on \w+ and moves to \w+ where it serves the plan better\b/i,
  /\bThis exchange changes the balance\s*[—–-]\s*(?:White|Black) reconfigures the pawn structure or gains material\b/i,
  /\bA thematic move in this position, maintaining (?:White|Black)'?s initiative\b/i,
  /\bThe fianchettoed bishop rakes the long diagonal, exerting pressure from a distance\b/i,
  /\bdeveloping normally\.\s*The opponent may not see what'?s coming\b/i,
  /\bopponent (?:may|might|won[’']?t|will not|doesn[’']?t)(?:\s+not)? (?:see|notice|spot|catch) what[’']?s coming\b/i,
  /\bThis move looks reasonable but allows the trap to unfold\b/i,
  /\bThis looks natural,? but it walks into the trap\b/i,
  /\bThis is the problematic continuation you need to recognize\b/i,
  /\bthe trap is being set\b/i,
  /\bThis is the natural continuation that leads into the warning line\b/i,
  /\bThis sequence leads to the dangerous line\b/i,
  /\bThe position looks normal so far\b/i,
  /\bCheck forces a response\.\s*This is where the danger begins\b/i,
  /\bThis is the position you must avoid\b/i,
  /\bThe damage is done\b/i,
  /\bThis is the uncomfortable position that results from this line\b/i,
  /\bThis is the move that causes all the trouble\b/i,
  /\bThe position is now very difficult\.\s*This is the warning\b/i,
  /\bWe'?re approaching the critical position\b/i,
  /\bpreparing for the middlegame while the trap is being set\b/i,
  /\bThis exchange is part of the trap setup\b/i,
  /\bestablishing the position\.\s*The key moment is approaching\b/i,
  /\bThis is a critical moment in the trap\b/i,
  /\bThe position looks safe, but danger lurks\b/i,
  /\band this is the final blow\b/i,
  /\bMemorize this pattern\b/i,
  /\bThe trap is complete\b/i,
  /\bRemember this pattern\b/i,
  /\bThe trap is sprung\b/i,
  /\bThis is the key takeaway from the\b/i,
  /\bNow the trap is revealed\b/i,
  /\bThe opponent is in serious trouble\b/i,
  /\bThis is where the trap begins\b/i,
  /^\s*(?:White|Black)\s+plays\s+[A-Za-z][\w+#=!?-]*\.?\s*$/i,
  /^\s*Be alert\.?\s*$/i,
  /\bimproving piece coordination and maintaining pressure\b/i,
  /\bwinning material or improving the position\b/i,
];

function isGenericFiller(text) {
  return GENERIC_PATTERNS.some((re) => re.test(text));
}

function arrowLegal(fen, from, to) {
  if (!fen) return true;
  try {
    const chess = new Chess(fen);
    return chess.moves({ verbose: true }).some((m) => m.from === from && m.to === to);
  } catch {
    return true;
  }
}

function auditProse(text, fenAfter) {
  const flags = [];
  if (!text || text.length < MIN_PROSE_LEN) return flags;

  if (isGenericFiller(text)) {
    flags.push({ kind: 'templated-filler', detail: 'matches a runtime-suppressed generic pattern' });
  }

  let chess;
  try {
    chess = fenAfter ? new Chess(fenAfter) : null;
  } catch {
    chess = null;
  }
  if (!chess) return flags;

  // 1. Piece-on-square claims
  //
  // Skip when surrounding context shows the prose is referencing a
  // PRIOR or FUTURE piece position rather than the current board state:
  //   - past tense: "was on X", "was at X", "had been on X" — describes
  //     the position BEFORE the move that just landed.
  //   - future / intent: "fianchetto to X", "prepares to fianchetto",
  //     "will move to X", "to X where", "heading to X" — describes
  //     where a piece WILL be, not where it is now.
  //   - capture origin: "captures the pawn on X" where X is the
  //     square being CAPTURED on (the SAN's destination); the piece
  //     was on that square before being captured.
  const seenSqClaim = new Set();
  for (const m of text.matchAll(PIECE_ON_SQUARE_RE)) {
    const [full, pieceName, square] = m;
    const key = `${pieceName.toLowerCase()}::${square.toLowerCase()}`;
    if (seenSqClaim.has(key)) continue;
    seenSqClaim.add(key);

    // Temporal-context skip: scan a 150-char window BEFORE and AFTER
    // the match for tense / move-description markers that explain a
    // non-current claim. The audit checks `chess.get(square)` against
    // the post-move FEN; many narration patterns reference the
    // square's PRIOR or FUTURE state in service of describing the
    // move itself, which makes the literal post-move check a false
    // positive.
    const matchIdx = m.index ?? 0;
    const lead = text.slice(Math.max(0, matchIdx - 150), matchIdx).toLowerCase();
    const tail = text.slice(matchIdx + full.length, matchIdx + full.length + 150).toLowerCase();

    // Past tense — "was on/at", "was harassed", "was at risk",
    // "had been on", "previously on". Often appears AFTER the
    // piece-on-square phrase ("the bishop on h4 was at risk").
    const pastInTail = /^\s*(?:was|were|had\s+been|previously)\b/.test(tail);
    const pastInLead = /\b(?:was|were|had\s+been|previously|before\s+(?:the\s+move|this))\b[^.]{0,80}$/.test(lead);

    // Future / intent — "fianchetto" anywhere in the 200-char window
    // means forward-looking bishop placement (the fianchettoed-square
    // mention always describes WHERE the bishop will land); "prepares
    // to ...", "will (move|land|bring|develop)", "heading to", "going
    // to" within the closer 80-char window also indicate forward-
    // looking prose. We allow periods between fianchetto and the
    // piece-on-square claim because a single description often spans
    // two short sentences ("…prepares to fianchetto to g7. The
    // bishop on g7…").
    const widerLead = text.slice(Math.max(0, matchIdx - 200), matchIdx).toLowerCase();
    const futureInLead =
      /\bfianchetto\b/.test(widerLead)
      || /\b(?:prepares?\s+to|will\s+(?:move|land|bring|reach|be|develop|place|exert)|heading\s+to(?:wards?)?|going\s+to)\b[^.]{0,150}$/.test(lead);
    const futureInTail =
      /^\s*(?:will\s+(?:move|land|bring|reach|be|develop|place|exert))\b/.test(tail);

    // Move-description: "the X on Y captures/moves/advances/steps/
    // retreats/develops/lands/recaptures" — the piece-on-square phrase
    // is the SUBJECT of a verb describing the move. Common when the
    // narration says "The pawn on e3 captures the pawn on d4" (the e3
    // pawn IS the actor; after the move it's on d4, not e3).
    const moveSubjectInTail =
      /^\s+(?:captures|recaptures|takes|moves|advances|steps|retreats|develops|lands|jumps|hops|swings|slides|maneuvers|relocates|repositions|deploys|drops|withdraws)\b/.test(tail);

    if (pastInTail || pastInLead || futureInLead || futureInTail || moveSubjectInTail) continue;

    const expected = PIECE_NAME_TO_LETTER[pieceName.toLowerCase()];
    const actual = chess.get(square);
    if (!actual || actual.type !== expected) {
      flags.push({
        kind: 'piece-on-square',
        detail: actual
          ? `claims ${pieceName} on ${square}, board holds a ${actual.type}`
          : `claims ${pieceName} on ${square}, square is empty`,
        excerpt: full,
      });
    }
  }

  // 2. Hanging-piece claims with no piece of that type on the board
  for (const m of text.matchAll(HANGING_PIECE_RE)) {
    const [full, pieceName] = m;
    const letter = PIECE_NAME_TO_LETTER[pieceName.toLowerCase()];
    if (!letter || letter === 'k') continue;
    let any = false;
    for (const row of chess.board()) {
      for (const sq of row) if (sq && sq.type === letter) { any = true; break; }
      if (any) break;
    }
    if (!any) {
      flags.push({
        kind: 'hanging-piece',
        detail: `claims hanging ${pieceName}, no ${pieceName}s on the board`,
        excerpt: full,
      });
    }
  }

  // 3. Check claim
  if (CHECK_CLAIM_RE.test(text) && !chess.inCheck()) {
    flags.push({ kind: 'check-claim', detail: 'narration claims check, position is not in check' });
  }

  // 4. Mate claim (checkmate / forced mate)
  //
  // Skip when the prose describes mate as a thematic GOAL or as a
  // characteristic of the opening, not an assertion about the current
  // position. Markers:
  //   - "race to (deliver) (check)mate" — describes a race, not a state
  //   - "approaching (check)mate" — descriptive of trajectory
  //   - "threatening (check)mate" — a threat, not an assertion
  //   - "leading to (check)mate" — a consequence, not now
  //   - "after (check)mate" / "before (check)mate" — temporal
  //   - "delivering / deliver (check)mate" — describes the action of
  //     mating, often in a thematic context
  const mateMatch = MATE_CLAIM_RE.exec(text);
  if (mateMatch && !chess.isCheckmate()) {
    const start = Math.max(0, mateMatch.index - 60);
    const lead = text.slice(start, mateMatch.index).toLowerCase();
    const isThematic =
      /\b(?:race\s+to(?:\s+deliver)?|approaching|threatening|leading\s+to|after|before|toward(?:s)?|deliver(?:ing|s)?|defines?\s+every\s+tempo)\b[^.]{0,40}$/.test(lead);
    if (!isThematic) {
      flags.push({ kind: 'mate-claim', detail: 'narration claims checkmate, position is not mate' });
    }
  }

  return flags;
}

// Illegal-SAN check is run separately so it can use both fenBefore (the
// position the move was played FROM) and the played san. We skip the
// check when the candidate is the move just played, or would have been
// legal in fenBefore — both of those are normal narrative references
// (e.g. "the Nf3 also prepares castling" right after Nf3).
function auditIllegalSan(text, fenBefore, fenAfter, playedSan) {
  if (!text || text.length < MIN_PROSE_LEN) return [];
  let chessAfter, chessBefore;
  try { chessAfter = fenAfter ? new Chess(fenAfter) : null; } catch { chessAfter = null; }
  try { chessBefore = fenBefore ? new Chess(fenBefore) : null; } catch { chessBefore = null; }
  if (!chessAfter) return [];

  const legalAfter = new Set(chessAfter.moves());
  const legalBefore = chessBefore ? new Set(chessBefore.moves()) : new Set();
  const flags = [];
  const seen = new Set();
  for (const m of text.matchAll(SAN_REF_RE)) {
    const cand = m[1];
    if (!/^[NBRQK]/.test(cand)) continue;
    if (seen.has(cand)) continue;
    seen.add(cand);
    if (cand === playedSan) continue;
    const variants = [cand, `${cand}+`, `${cand}#`];
    if (variants.some((v) => legalAfter.has(v) || legalBefore.has(v))) continue;
    flags.push({ kind: 'illegal-san', detail: `references ${cand}, not legal here or in the previous position`, excerpt: cand });
  }
  return flags;
}

function auditArrows(arrows, fenBefore) {
  const flags = [];
  if (!Array.isArray(arrows) || !fenBefore) return flags;
  for (const a of arrows) {
    if (!a || typeof a !== 'object') continue;
    const from = a.from ?? a.startSquare;
    const to = a.to ?? a.endSquare;
    if (!from || !to) continue;
    if (!arrowLegal(fenBefore, from, to)) {
      flags.push({ kind: 'illegal-arrow', detail: `${from}->${to} not legal in fenBefore` });
    }
  }
  return flags;
}

// ─── Records build ─────────────────────────────────────────────────────────

const records = [];

function pushAnnotationFile(openingId, source) {
  const path = resolveAnnotationFile(openingId);
  if (!path) return { mainEmpty: 0, mainTotal: 0, subEmpty: 0, subTotal: 0 };
  const data = JSON.parse(readFileSync(join(repoRoot, path), 'utf-8'));
  const stats = { mainEmpty: 0, mainTotal: 0, subEmpty: 0, subTotal: 0 };

  // Main line
  const mainSans = (data.moveAnnotations ?? []).map((m) => m.san);
  const mainPlies = replay(STARTING_FEN, mainSans);
  for (let i = 0; i < (data.moveAnnotations ?? []).length; i++) {
    const ann = data.moveAnnotations[i];
    const ply = mainPlies[i];
    stats.mainTotal++;
    const text = (ann.annotation ?? '').trim();
    if (!text) { stats.mainEmpty++; continue; }
    if (text.length < MIN_PROSE_LEN) continue;
    if (!ply || ply.illegal) continue;
    records.push({
      source: `${source}-main`,
      openingId,
      sublineName: null,
      moveIndex: i,
      san: ann.san,
      text,
      fenBefore: ply.fenBefore,
      fenAfter: ply.fenAfter,
      arrows: Array.isArray(ann.arrows) ? ann.arrows : null,
    });
  }

  // Sublines (content-only — empty annotations are skipped per request)
  for (const sl of data.subLines ?? []) {
    const sans = (sl.moveAnnotations ?? []).map((m) => m.san);
    const plies = replay(STARTING_FEN, sans);
    for (let i = 0; i < (sl.moveAnnotations ?? []).length; i++) {
      const ann = sl.moveAnnotations[i];
      const ply = plies[i];
      stats.subTotal++;
      const text = (ann.annotation ?? '').trim();
      if (!text) { stats.subEmpty++; continue; }
      if (text.length < MIN_PROSE_LEN) continue;
      if (!ply || ply.illegal) continue;
      records.push({
        source: `${source}-subline`,
        openingId,
        sublineName: sl.name ?? null,
        moveIndex: i,
        san: ann.san,
        text,
        fenBefore: ply.fenBefore,
        fenAfter: ply.fenAfter,
        arrows: Array.isArray(ann.arrows) ? ann.arrows : null,
      });
    }
  }
  return stats;
}

function pushVariations(openingId, source, variations) {
  if (!Array.isArray(variations)) return;
  for (const v of variations) {
    const explanation = (v.explanation ?? '').trim();
    if (!explanation || explanation.length < MIN_PROSE_LEN) continue;
    const sans = tokensToSans(v.pgn ?? '');
    if (sans.length === 0) continue;
    const fen = finalFen(STARTING_FEN, sans);
    records.push({
      source,
      openingId,
      sublineName: v.name ?? null,
      moveIndex: sans.length - 1,
      san: sans[sans.length - 1],
      text: explanation,
      fenBefore: null,
      fenAfter: fen,
      arrows: null,
    });
  }
}

function pushOverview(openingId, name, pgn, overview) {
  const text = (overview ?? '').trim();
  if (!text || text.length < MIN_PROSE_LEN) return;
  const sans = tokensToSans(pgn ?? '');
  const fen = sans.length > 0 ? finalFen(STARTING_FEN, sans) : STARTING_FEN;
  records.push({
    source: 'pro-overview',
    openingId,
    sublineName: name ?? null,
    moveIndex: Math.max(0, sans.length - 1),
    san: sans[sans.length - 1] ?? null,
    text,
    fenBefore: null,
    fenAfter: fen,
    arrows: null,
  });
}

const collectionStats = {
  repertoireMainTotal: 0, repertoireMainEmpty: 0,
  repertoireSubTotal: 0, repertoireSubEmpty: 0,
  repertoireVariationsAudited: 0,
  proOpeningsWithFile: 0, proOpeningsStandalone: 0,
  proOverviewsAudited: 0, proVariationsAudited: 0,
};

function collectAll(ids) {
  // 40 repertoire openings
  for (const r of ids.repertoire) {
    const s = pushAnnotationFile(r.id, 'rep');
    collectionStats.repertoireMainTotal += s.mainTotal;
    collectionStats.repertoireMainEmpty += s.mainEmpty;
    collectionStats.repertoireSubTotal += s.subTotal;
    collectionStats.repertoireSubEmpty += s.subEmpty;
    const before = records.length;
    pushVariations(r.id, 'repertoire-variation', r.variations);
    collectionStats.repertoireVariationsAudited += records.length - before;
  }
  // 80 pro entries
  for (const o of ids.pro.openings) {
    const path = resolveAnnotationFile(o.id);
    if (path) {
      collectionStats.proOpeningsWithFile++;
      pushAnnotationFile(o.id, 'pro');
    } else {
      collectionStats.proOpeningsStandalone++;
    }
    const beforeOv = records.length;
    pushOverview(o.id, o.name, o.pgn, o.overview);
    collectionStats.proOverviewsAudited += records.length - beforeOv;
    const beforeVar = records.length;
    pushVariations(o.id, 'pro-variation', o.variations);
    collectionStats.proVariationsAudited += records.length - beforeVar;
  }
}

// ─── Audit pipeline ────────────────────────────────────────────────────────

function auditRecord(r) {
  // illegal-san is intentionally NOT run here — empirically it false-
  // positives heavily on legitimate references to past/future/thematic
  // moves ("Nc4 to pressure d6", "without the Bc1"). The piece-on-
  // square check already catches the actual bug class (templated
  // capture sentences naming the wrong piece). Re-enable if a stricter
  // "plays X / moves X" gating gets implemented.
  const flags = auditProse(r.text ?? '', r.fenAfter);
  for (const f of auditArrows(r.arrows, r.fenBefore)) flags.push(f);
  return flags;
}

// ─── Output (filled in last chunk) ─────────────────────────────────────────

function writeReports(summary, findings) {
  // Group findings by kind for both JSON and the markdown summary.
  const byKind = new Map();
  for (const f of findings) {
    const k = f.flag.kind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(f);
  }
  const kindCounts = Object.fromEntries([...byKind.entries()].map(([k, v]) => [k, v.length]));

  const bySource = new Map();
  for (const f of findings) {
    bySource.set(f.source, (bySource.get(f.source) ?? 0) + 1);
  }
  const byOpening = new Map();
  for (const f of findings) {
    byOpening.set(f.openingId, (byOpening.get(f.openingId) ?? 0) + 1);
  }
  const topOpenings = [...byOpening.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

  writeFileSync(
    join(outDir, 'featured-narrations.json'),
    JSON.stringify(
      {
        summary: { ...summary, kindCounts, bySource: Object.fromEntries(bySource), collectionStats },
        findings,
      },
      null,
      2,
    ),
  );

  const md = [];
  md.push('# Featured-Narrations Audit Report');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Elapsed: ${summary.elapsedMs}ms`);
  md.push('');
  md.push('Scope: 40 openings from `repertoire.json` + 80 pro entries from');
  md.push('`pro-repertoires.json`. Empty subline annotations are skipped per');
  md.push('user request — this audit covers content-only records.');
  md.push('');
  md.push('## Confidence');
  md.push('');
  md.push('- **piece-on-square** — high signal. Templated annotations slot a');
  md.push('  wrong piece name into capture sentences ("captures the knight on');
  md.push('  e5" when e5 holds a pawn). Almost all hits are real bugs.');
  md.push('- **templated-filler** — high signal. These annotations match the');
  md.push('  same generic patterns that `walkthroughNarration.ts` silently');
  md.push('  drops at runtime — i.e. the user never hears them, contributing');
  md.push('  to the perceived narration ↔ board desync.');
  md.push('- **hanging-piece / check-claim / mate-claim** — medium signal.');
  md.push('  Few hits; review individually.');
  md.push('- **illegal-arrow** — high signal when present (board would');
  md.push('  display an arrow that is not a legal move).');
  md.push('- *illegal-san is intentionally not run* — too noisy on legitimate');
  md.push('  references to past / future / thematic moves.');
  md.push('');
  md.push('## Collection');
  md.push('');
  md.push('| Bucket | Count |');
  md.push('|---|---:|');
  md.push(`| Repertoire main-line moves (total / empty) | ${collectionStats.repertoireMainTotal} / ${collectionStats.repertoireMainEmpty} |`);
  md.push(`| Repertoire subline moves (total / empty) | ${collectionStats.repertoireSubTotal} / ${collectionStats.repertoireSubEmpty} |`);
  md.push(`| Repertoire variation explanations audited | ${collectionStats.repertoireVariationsAudited} |`);
  md.push(`| Pro entries with annotation file | ${collectionStats.proOpeningsWithFile} |`);
  md.push(`| Pro standalone entries (inline only) | ${collectionStats.proOpeningsStandalone} |`);
  md.push(`| Pro overview blurbs audited | ${collectionStats.proOverviewsAudited} |`);
  md.push(`| Pro variation explanations audited | ${collectionStats.proVariationsAudited} |`);
  md.push(`| **Total non-empty records audited** | **${summary.totalRecords}** |`);
  md.push('');
  md.push('## Findings by kind');
  md.push('');
  md.push('| Kind | Count |');
  md.push('|---|---:|');
  for (const [k, c] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    md.push(`| ${k} | ${c} |`);
  }
  md.push(`| **TOTAL** | **${summary.totalFindings}** |`);
  md.push('');
  md.push('## Findings by source');
  md.push('');
  md.push('| Source | Count |');
  md.push('|---|---:|');
  for (const [s, c] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    md.push(`| ${s} | ${c} |`);
  }
  md.push('');
  md.push('## Top openings by finding count');
  md.push('');
  md.push('| Opening | Findings |');
  md.push('|---|---:|');
  for (const [op, c] of topOpenings) md.push(`| ${op} | ${c} |`);
  md.push('');

  // Per-kind sample sections (15 examples each)
  const kindOrder = [
    'piece-on-square',
    'illegal-san',
    'hanging-piece',
    'check-claim',
    'mate-claim',
    'illegal-arrow',
    'templated-filler',
  ];
  for (const kind of kindOrder) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    md.push(`## ${kind} (${list.length})`);
    md.push('');
    md.push('| Source | Opening | Subline / Variation | Move# | SAN | Detail |');
    md.push('|---|---|---|---:|---|---|');
    for (const f of list.slice(0, 15)) {
      const detail = String(f.flag.detail ?? '').replace(/\|/g, '\\|').slice(0, 140);
      const sub = String(f.sublineName ?? '').replace(/\|/g, '\\|');
      md.push(`| ${f.source} | ${f.openingId} | ${sub} | ${(f.moveIndex ?? 0) + 1} | ${f.san ?? ''} | ${detail} |`);
    }
    if (list.length > 15) md.push(`| … | … | (${list.length - 15} more in JSON) | | | |`);
    md.push('');
  }

  writeFileSync(join(outDir, 'featured-narrations.md'), md.join('\n'));
  console.log(`[audit-featured] wrote audit-reports/featured-narrations.{json,md}`);
  console.log('[audit-featured] kind counts:', kindCounts);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const t0 = Date.now();
const ids = loadFeaturedIds();
console.log(
  `[audit-featured] ${ids.repertoireIds.size} repertoire ids, ${ids.proIds.size} pro ids`,
);
collectAll(ids);
console.log(`[audit-featured] collected ${records.length} non-empty records`);
const findings = [];
for (const r of records) {
  const flags = auditRecord(r);
  for (const f of flags) findings.push({ ...r, flag: f });
}
const summary = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  totalRecords: records.length,
  totalFindings: findings.length,
};
writeReports(summary, findings);
console.log(`[audit-featured] done in ${summary.elapsedMs}ms`);
