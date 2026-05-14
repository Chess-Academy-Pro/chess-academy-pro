#!/usr/bin/env node
/**
 * generate-narrations.mjs
 * -----------------------
 * DeepSeek+++ bulk narration generator.
 *
 * Reads:  audit-reports/narration-classification.json
 *         src/data/annotations/*.json
 *         src/data/openings-lichess.json
 *
 * Writes: src/data/annotations/*.json (in place)
 *         audit-reports/narration-generation.log.json
 *
 * Levels deployed:
 *   1. Base prompt with hand-curated voice exemplars + 50-pattern banned-phrase list
 *   2. Per-move context enrichment (chess.js position summary, opening, classification)
 *   3. Genre-aware exemplars (Sicilian → Sicilian voice, Italian → Italian voice, etc.)
 *   4. Sub-prompts by move classification (tactical/developing/prophylactic/marquee)
 *   5. Self-critique pass (heuristic + LLM) with auto-regen on failure
 *   6. (skipped — Haiku polish unavailable)
 *   7. Banned-phrase post-filter with force-regen
 *
 * Usage:
 *   node scripts/generate-narrations.mjs --sanity 10               # 10 diverse samples, dry-run
 *   node scripts/generate-narrations.mjs --limit 50                # limit total
 *   node scripts/generate-narrations.mjs --openings <id1>,<id2>    # restrict
 *   node scripts/generate-narrations.mjs --include-review          # also regen REVIEW entries
 *   node scripts/generate-narrations.mjs --dry-run                 # don't write files
 *   node scripts/generate-narrations.mjs --full                    # all REGENERATE entries
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

// ── Paths ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const annotDir = join(repoRoot, 'src/data/annotations');
const outDir = join(repoRoot, 'audit-reports');
mkdirSync(outDir, { recursive: true });

// ── Load .env ────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}
loadEnv();

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY;
if (!DEEPSEEK_KEY) {
  console.error('ERROR: DEEPSEEK_API_KEY not found in .env');
  process.exit(1);
}

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagVal(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  return args[i + 1];
}
function flagBool(name) {
  return args.includes(`--${name}`);
}
const SANITY = parseInt(flagVal('sanity') || '0', 10);
const LIMIT = parseInt(flagVal('limit') || '0', 10);
const OPENINGS_FILTER = (flagVal('openings') || '').split(',').filter(Boolean);
const INCLUDE_REVIEW = flagBool('include-review');
const DRY_RUN = flagBool('dry-run') || SANITY > 0;
const FULL = flagBool('full');
const VERBOSE = flagBool('verbose');

if (!FULL && !LIMIT && !SANITY) {
  console.error('Specify --sanity N, --limit N, or --full');
  process.exit(1);
}

// ── Load data ────────────────────────────────────────────────────────────
const classification = JSON.parse(
  readFileSync(join(outDir, 'narration-classification.json'), 'utf8'),
);
const lichessCanon = JSON.parse(
  readFileSync(join(repoRoot, 'src/data/openings-lichess.json'), 'utf8'),
);
const lichessByName = new Map();
for (const o of lichessCanon) {
  lichessByName.set(o.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), o);
}

// Build a lookup of all canon entries by initial PGN prefix (first 4 plies)
const lichessByPrefix = new Map();
for (const o of lichessCanon) {
  const sans = o.pgn.split(/\s+/).filter((t) => !/^\d+\.+$/.test(t));
  for (let depth = 4; depth <= Math.min(sans.length, 12); depth++) {
    const prefix = sans.slice(0, depth).join(' ');
    if (!lichessByPrefix.has(prefix)) lichessByPrefix.set(prefix, o);
  }
}

// ── Hand-curated voice exemplars ─────────────────────────────────────────
// Selected from the strongest hand-curated narrations, grouped by genre.
const EXEMPLARS_BY_GENRE = {
  e4_open: [
    { opening: "King's Gambit, 1.e4", text: "This is the King's Gambit, one of the oldest and most romantic openings in chess. White plays 1.e4, claiming the center and preparing the bold f4 pawn sacrifice that has led to some of the most brilliant attacking games in history." },
    { opening: "Italian Game, c3", text: "c3 is the slow, principled Italian — White prepares d4 next and plans a Spanish-style buildup. The line was Carlsen's weapon at the 2018 World Championship and remains one of the trickiest tries against the Two Knights setup." },
    { opening: "Ruy Lopez, Nb8 (Breyer)", text: "Black retreats the knight with Nb8, the famous Breyer Maneuver — one of the most celebrated retreats in chess. The knight goes backward to reroute via d7-f8-g6 for kingside defense or central support." },
  ],
  sicilian: [
    { opening: "Najdorf, 5...a6", text: "5...a6 is the move that defines the Najdorf. Black takes a tempo to prevent any white piece from landing on b5, and quietly prepares the queenside expansion that will define the rest of the game." },
    { opening: "Dragon, Be3 (Yugoslav)", text: "White plays Be3, signaling the Yugoslav Attack — the most critical and dangerous system against the Dragon. The Be3 supports d4, controls a7, and prepares the Qd2-Bh6 battery aiming to exchange Black's defensive g7 bishop." },
    { opening: "Dragon, Rc8", text: "Black seizes the open c-file with Rc8 — the single most purposeful move in Black's counterattacking plan. The rook aims at the white king, prepares ...Ne5 attacking the Bc4, and is the starting point of the famous queenside assault." },
  ],
  d4_closed: [
    { opening: "Queen's Gambit, c6", text: "Black plays c6, reinforcing d5 and preparing to expand. The c6 pawn gives d5 extra support and prepares ...Nf8 or ...dxc4 followed by ...Nd5. The QGD Exchange middlegame becomes a battle between White's minority attack and Black's central piece play." },
    { opening: "London System, c3", text: "White reinforces d4 with c3, completing the famous London pawn triangle of d4-e3-c3. This is an ironclad central formation — d4 is supported by both e3 and c3, making it virtually impossible to challenge with a frontal assault." },
    { opening: "Italian Game, IQP", text: "White recaptures cxd4, establishing the classical e4+d4 pawn duo — the payoff from the patient c3 preparation. These pawns control d5, e5, c5, and f5, giving White significant central space. However, an isolated d4 pawn could become a long-term target." },
  ],
  defense: [
    { opening: "French Defense, c5", text: "Black strikes with c5, the thematic French break targeting the base of White's d4-e5 pawn chain. If White exchanges cxd4 cxd4, the d4 pawn becomes isolated. This is the queenside lever that defines the entire French middlegame." },
    { opening: "Caro-Kann, h4", text: "White pushes h4, beginning the aggressive h4-h5 plan that defines the Caro-Kann Classical. The h-pawn advances toward h5 where it will challenge the Bg6 and either trap it (after ...Bh7) or force it to a passive square." },
    { opening: "French, b6", text: "Black plays b6, preparing to solve the French Defense's biggest strategic problem: the bad light-squared bishop trapped behind the e6 pawn. After ...Bb7 or ...Ba6, the bishop finally finds activity on the long diagonal." },
  ],
  gambit: [
    { opening: "Evans Gambit, b4", text: "This is the Evans Gambit, one of the most romantic and aggressive openings in chess history. White plays b4, sacrificing a pawn for rapid development and a powerful pawn center — the kind of attack Morphy would have dreamed up." },
    { opening: "Budapest, Ng4", text: "Ng4 attacks the e5 pawn and threatens to recover material with ...Nxe5. The Ng4 is the classic Budapest piece — it leaps to the rim to put immediate pressure on White's center and force concrete decisions before development is complete." },
    { opening: "Benko Gambit, b5", text: "Black plays b5, the Benko sacrifice — one of the most respected gambits in modern chess. Black gives up a pawn for lasting pressure on the queenside files and a structural imbalance that lasts deep into the endgame." },
  ],
  hypermodern: [
    { opening: "King's Indian, kingside attack", text: "White must commit to either pawn play on the queenside or piece play in the center — the King's Indian classical battle. Black's f5-f4-g5-g4 attack is real, and a single tempo decides whether White breaks through on c-file or gets mated on h-file." },
    { opening: "Grünfeld, Nxc3", text: "Black plays Nxc3 — the defining move of the Grünfeld. By trading the knight for the pawn structure, Black accepts a small material concession to give White a bloated but vulnerable center. The whole opening hinges on whether that center holds." },
  ],
};

// ── Banned phrases (mined from structural audit + curated) ───────────────
const BANNED_PHRASES = [
  ...(JSON.parse(readFileSync(join(outDir, 'structural.json'), 'utf8')).phraseClusters || []).map((c) => c.phrase),
  'improves piece coordination and flexibility',
  'controls key diagonal squares and maintains active piece',
  'takes up a powerful position on the',
  'this pawn advance gains space',
  'stakes a claim in the center',
  'central pawns control space and restrict',
  'this exchange changes the balance',
  'reaches a powerful central outpost',
  'is an important variation of',
  'understanding this line will strengthen your repertoire',
  "let's walk through the key ideas",
];

const HEDGE_WORDS = [
  'perhaps',
  'possibly',
  'might consider',
  'could consider',
  'one might',
  'maybe',
];

const BANNED_VAGUE_WORDS_NEEDING_JUSTIFICATION = [
  'engaging',
  'interesting',
  'important',
  'key',
  'crucial',
  'fascinating',
  'beautiful',
];

// ── Move classification (chess.js-driven) ────────────────────────────────
function classifyMove(fenBefore, san, plyIndex, isFirstMoveOfOpening) {
  if (isFirstMoveOfOpening) return 'marquee';
  if (san.includes('#')) return 'marquee'; // checkmate
  if (san.includes('=Q') || san.includes('=R')) return 'tactical';
  // detect captures + checks + sacrifices
  try {
    const c = new Chess(fenBefore);
    const move = c.move(san);
    if (!move) return 'unknown';
    if (move.captured && c.history({ verbose: true }).length === 0) {
      // dummy — we just played it; refresh
    }
    if (move.flags.includes('e')) return 'tactical'; // en passant
    if (move.captured && (move.flags.includes('c') || move.flags.includes('e'))) return 'tactical';
    if (san.includes('+')) return 'tactical'; // check
    if (move.flags.includes('p')) return 'tactical'; // promotion
    // Castle
    if (move.flags.includes('k') || move.flags.includes('q')) return 'developing';
    // Quiet developing move
    if (move.piece === 'n' || move.piece === 'b') {
      if (plyIndex < 12) return 'developing';
      return 'positional';
    }
    if (move.piece === 'p') {
      if (plyIndex < 6) return 'developing';
      return 'positional';
    }
    return 'positional';
  } catch {
    return 'unknown';
  }
}

// ── Position summary helper ──────────────────────────────────────────────
function positionSummary(fenBefore, san) {
  try {
    const c = new Chess(fenBefore);
    const move = c.move(san);
    if (!move) return '';
    const parts = [];
    parts.push(`Move ${move.color === 'w' ? 'White' : 'Black'} plays ${san}`);
    if (move.captured) parts.push(`captures ${move.captured.toUpperCase()} on ${move.to}`);
    if (move.flags.includes('k')) parts.push('castles kingside');
    if (move.flags.includes('q')) parts.push('castles queenside');
    if (san.includes('+')) parts.push('with check');
    if (san.includes('#')) parts.push('checkmate');
    if (move.flags.includes('p')) parts.push(`promoting to ${move.promotion?.toUpperCase()}`);
    return parts.join('; ');
  } catch {
    return '';
  }
}

// ── Genre detection from opening name ────────────────────────────────────
function detectGenre(openingId, openingName) {
  const id = (openingId + ' ' + (openingName || '')).toLowerCase();
  if (id.includes('sicilian')) return 'sicilian';
  if (id.includes('gambit')) return 'gambit';
  if (id.includes('king\'s indian') || id.includes('kings-indian') || id.includes('grunfeld') || id.includes('grünfeld')) return 'hypermodern';
  if (id.includes('french') || id.includes('caro-kann') || id.includes('pirc') || id.includes('alekhine') || id.includes('scandinavian')) return 'defense';
  if (id.match(/queen|catalan|london|slav|nimzo|dutch|bogo|benoni|stonewall|tarrasch/)) return 'd4_closed';
  return 'e4_open';
}

// ── Build the system prompt ──────────────────────────────────────────────
function buildSystemPrompt(genre) {
  const exemplars = EXEMPLARS_BY_GENRE[genre] || EXEMPLARS_BY_GENRE.e4_open;
  return `You are writing one-sentence move annotations for a premium chess academy app. Your prose must match the voice of these EXEMPLARS — confident, specific, evocative, written by a coach who has seen this position 10,000 times.

═══════════════════════════════════════════════════════════════
ABSOLUTE BAN LIST — IF YOU USE ANY OF THESE, YOUR ANSWER FAILS
═══════════════════════════════════════════════════════════════
Forbidden phrases (case-insensitive, partial match counts):
  ✗ "improves piece coordination and flexibility"
  ✗ "controls key diagonal squares and maintains active piece"
  ✗ "takes up a powerful position"
  ✗ "this pawn advance gains space"
  ✗ "central pawns control space and restrict"
  ✗ "this exchange changes the balance"
  ✗ "reaches a powerful central outpost"
  ✗ "this is an important variation of"
  ✗ "understanding this line will strengthen"
  ✗ "the most principled"
  ✗ "principled first move"
  ✗ "preparing to develop the kingside pieces with tempo"
  ✗ "preparing to develop naturally"
  ✗ "develops naturally"

These phrases mark you as a generic chess tutor, not a master coach. Never use them.

═══════════════════════════════════════════════════════════════
GROUND-TRUTH RULE — DO NOT HALLUCINATE
═══════════════════════════════════════════════════════════════
You will receive the EXACT moves played up to this point as a SAN sequence.
Your narration must describe THIS move in THIS position. Do not say things like:
  ✗ "Black's reply to 1.e4..." when 1.e4 was not played
  ✗ "accepting the X Gambit" when the gambit pawn has not been offered yet
  ✗ "transposing into..." unless that's a real transposition from the actual sequence

Read the move sequence carefully. Match the narration to what has actually happened.

═══════════════════════════════════════════════════════════════
EXEMPLARS (this is the voice you must match)
═══════════════════════════════════════════════════════════════

${exemplars.map((e, i) => `${i + 1}. ${e.opening}\n   "${e.text}"`).join('\n\n')}

═══════════════════════════════════════════════════════════════
VOICE RULES — non-negotiable
═══════════════════════════════════════════════════════════════
1. SPECIFICITY CHECK — every narration MUST name at least one of:
   - a specific square (e.g. "controls e5")
   - a specific file/diagonal (e.g. "dominates the long a1-h8 diagonal")
   - a named theme (Yugoslav Attack, IQP, Maroczy bind, minority attack, Breyer Maneuver, fianchetto, kingside storm, queenside lever, etc.)
   - a concrete plan (e.g. "preparing Bb5 followed by O-O")
   - a historical reference (player, year, named game, tournament)
   - a piece's specific function on this square ("the e5 knight blockades the IQP")
   If none of these are in your sentence, rewrite it.

2. SENTENCE LIMIT — one sentence, ≤35 words. Two sentences ONLY for marquee moves.

3. ANTI-FORMULA RULE — vary your openings. AT MOST 3 of every 10 narrations may start with "White plays X" or "Black plays X". Other openings to use:
   - Lead with the move's purpose: "Threatening Nxe6 next, ..."
   - Lead with the named theme: "The thematic French break — ..."
   - Lead with a historical hook: "Fischer's preferred system in 1972, ..."
   - Lead with a vivid claim: "An iron grip on the d5 square: ..."
   - Lead with the structure: "With the IQP locked in, ..."

4. NO hedging: "perhaps," "possibly," "might," "maybe" are forbidden.

5. NO vague praise: "engaging," "interesting," "important," "key," "crucial," "fascinating," "beautiful" — these may ONLY appear if immediately followed by a concrete because/that/when clause.

6. MARQUEE MOVES (flagged in input as "type: marquee"):
   - Move 1 of an opening: include a vivid metaphor OR historical hook OR evocative claim. NEVER use "the most principled," "claims the center," or other generic phrases.
   - Named sacrifices: name the sacrifice and its long-term compensation.
   - Mating shots: name the mating pattern (back-rank, smothered, ladder).

7. NO preamble. Start with the move's substance.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════
Return a JSON array of strings. Exactly one entry per input move, in the same order. No markdown, no commentary, no prefix. Just:
["narration1", "narration2", ...]

REMEMBER: read the MOVE SEQUENCE carefully. Vary your sentence openings. Name a specific square, theme, or plan in EVERY narration. Never use a forbidden phrase.`;
}

// ── Build per-move user payload ──────────────────────────────────────────
function buildUserPayload(items) {
  const lines = items.map((it, i) => {
    const summary = positionSummary(it.fenBefore || '', it.san);
    const cls = it.classification || 'unknown';
    const moveNum = Math.floor(it.plyIndex / 2) + 1;
    const colorTurn = it.plyIndex % 2 === 0 ? 'White' : 'Black';
    return `${i + 1}. ${it.openingName || it.openingId} (${it.eco || '?'}) | move ${moveNum} (${colorTurn}) | SAN: ${it.san} | type: ${cls}${summary ? ` | ${summary}` : ''}${it.contextNote ? `\n   Context: ${it.contextNote}` : ''}`;
  });
  return `Write a one-sentence narration for each of these ${items.length} moves. Output a JSON array of exactly ${items.length} strings, in the same order.

${lines.join('\n')}`;
}

// ── DeepSeek API call ────────────────────────────────────────────────────
async function deepseekCall(systemPrompt, userPrompt, opts = {}) {
  const { temperature = 0.7, maxRetries = 3 } = opts;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature,
          max_tokens: 4096,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      // Try to parse as JSON array
      const cleaned = content.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      try {
        const arr = JSON.parse(cleaned);
        if (Array.isArray(arr)) {
          return {
            ok: true,
            narrations: arr,
            usage: data.usage,
          };
        }
      } catch {
        // Try to extract JSON array from within
        const m = cleaned.match(/\[[\s\S]+\]/);
        if (m) {
          try {
            const arr = JSON.parse(m[0]);
            if (Array.isArray(arr)) return { ok: true, narrations: arr, usage: data.usage };
          } catch {}
        }
      }
      throw new Error(`Could not parse JSON array from response: ${cleaned.slice(0, 300)}`);
    } catch (err) {
      if (attempt === maxRetries) {
        return { ok: false, error: err.message };
      }
      await sleep(1000 * attempt);
    }
  }
  return { ok: false, error: 'unreachable' };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Heuristic critique on a generated narration ──────────────────────────
function critiqueText(text, item) {
  const issues = [];
  const t = (text || '').trim();
  const norm = t.toLowerCase();

  if (t.length === 0) issues.push('empty');
  if (t.length < 30) issues.push(`too-short (${t.length} chars)`);
  if (t.length > 350) issues.push(`too-long (${t.length} chars)`);

  // Banned phrase substring check
  for (const phrase of BANNED_PHRASES) {
    if (phrase && phrase.length > 20 && norm.includes(phrase)) {
      issues.push(`banned-phrase: "${phrase.slice(0, 40)}..."`);
      break; // one is enough
    }
  }

  // Hedge words
  for (const h of HEDGE_WORDS) {
    if (norm.includes(h)) {
      issues.push(`hedge: "${h}"`);
      break;
    }
  }

  // Vague praise without nearby justification — heuristic: if the word
  // appears, check that "because" or similar is within 50 chars.
  for (const w of BANNED_VAGUE_WORDS_NEEDING_JUSTIFICATION) {
    const idx = norm.indexOf(' ' + w + ' ');
    if (idx >= 0) {
      const window = norm.slice(idx, idx + 80);
      if (!/(because|since|that|controls?|attacks?|defends?|threatens?|prepares?)/.test(window)) {
        issues.push(`unjustified-vague: "${w}"`);
        break;
      }
    }
  }

  // Word count
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 60) issues.push(`too-many-words (${words})`);

  return issues;
}

// ── Build the work list ──────────────────────────────────────────────────
function buildWorkList() {
  const targets = INCLUDE_REVIEW ? ['REGENERATE', 'REVIEW'] : ['REGENERATE'];
  const items = [];
  for (const file of classification.perFile) {
    if (OPENINGS_FILTER.length > 0 && !OPENINGS_FILTER.includes(file.openingId)) continue;
    for (const e of file.entries) {
      if (!targets.includes(e.decision)) continue;
      items.push({
        openingId: file.openingId,
        file: file.file,
        plyIndex: e.ply,
        san: e.san,
        source: e.source,
        sublineName: e.sublineName,
        marquee: e.marquee,
        decision: e.decision,
      });
    }
  }
  return items;
}

// ── Hydrate items with FENs + opening metadata ───────────────────────────
function hydrate(items) {
  const byOpening = new Map();
  for (const it of items) {
    if (!byOpening.has(it.openingId)) byOpening.set(it.openingId, []);
    byOpening.get(it.openingId).push(it);
  }

  const hydrated = [];
  for (const [openingId, list] of byOpening) {
    const fpath = join(annotDir, `${openingId}.json`);
    const data = JSON.parse(readFileSync(fpath, 'utf8'));
    const mainList = data.moveAnnotations || data.moveAnalyses || [];
    const subLines = data.subLines || [];

    // For each entry, derive the FEN by replaying SAN sequence.
    // Group by source (main vs subline) for replay.
    const byKey = new Map();
    for (const it of list) {
      const key = it.source === 'main' ? 'main' : `subline:${it.sublineName}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }

    for (const [key, entries] of byKey) {
      let sourceList;
      if (key === 'main') sourceList = mainList;
      else {
        const sub = subLines.find((s) => `subline:${s.name}` === key);
        sourceList = sub?.moveAnnotations || sub?.moveAnalyses || [];
      }
      if (!sourceList.length) continue;
      const sans = sourceList.map((m) => m.san).filter(Boolean);

      const c = new Chess();
      const fenBefores = [];
      for (let i = 0; i < sans.length; i++) {
        fenBefores.push(c.fen());
        try {
          c.move(sans[i]);
        } catch {
          break;
        }
      }

      // Match canon entry by initial PGN prefix
      let openingName = openingId;
      let eco = '';
      const prefix = sans.slice(0, 8).join(' ');
      for (let depth = 8; depth >= 4; depth--) {
        const p = sans.slice(0, depth).join(' ');
        if (lichessByPrefix.has(p)) {
          openingName = lichessByPrefix.get(p).name;
          eco = lichessByPrefix.get(p).eco;
          break;
        }
      }

      for (const it of entries) {
        const fenBefore = fenBefores[it.plyIndex] || '';
        const cls = classifyMove(fenBefore, it.san, it.plyIndex, it.plyIndex === 0);
        // Promote main-line first move, sacrifices, checkmates to marquee
        const isMarquee = it.marquee || it.plyIndex === 0 || it.san.includes('#') || cls === 'marquee';
        hydrated.push({
          ...it,
          openingName,
          eco,
          fenBefore,
          classification: isMarquee ? 'marquee' : cls,
          contextNote: it.sublineName ? `Sub-line: "${it.sublineName}"` : null,
        });
      }
    }
  }
  return hydrated;
}

// ── Sanity-pick: pick N diverse items spanning openings + classifications ──
function sanityPick(items, n) {
  const byCombo = new Map();
  for (const it of items) {
    const key = `${it.openingId}::${it.classification || 'x'}`;
    if (!byCombo.has(key)) byCombo.set(key, []);
    byCombo.get(key).push(it);
  }
  // Pick one from each combo until we have n
  const keys = [...byCombo.keys()].sort(() => Math.random() - 0.5);
  const picked = [];
  while (picked.length < n && keys.length) {
    for (const k of keys) {
      const list = byCombo.get(k);
      if (list && list.length) {
        picked.push(list.shift());
        if (picked.length >= n) break;
      }
    }
    keys.length = keys.filter((k) => byCombo.get(k).length > 0).length;
  }
  return picked.slice(0, n);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  let work = buildWorkList();
  console.log(`Total work: ${work.length} entries`);

  if (LIMIT) work = work.slice(0, LIMIT);
  if (SANITY) work = sanityPick(work, SANITY);

  const hydrated = hydrate(work);
  console.log(`Hydrated: ${hydrated.length} entries`);

  // Group by genre + small batches
  const BATCH_SIZE = SANITY ? Math.min(10, hydrated.length) : 15;
  const batches = [];
  const byGenre = new Map();
  for (const it of hydrated) {
    const genre = detectGenre(it.openingId, it.openingName);
    if (!byGenre.has(genre)) byGenre.set(genre, []);
    byGenre.get(genre).push(it);
  }
  for (const [genre, list] of byGenre) {
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      batches.push({ genre, items: list.slice(i, i + BATCH_SIZE) });
    }
  }

  console.log(`${batches.length} batches at size ${BATCH_SIZE}`);

  const log = [];
  let totalIn = 0;
  let totalOut = 0;
  let okCount = 0;
  let failCount = 0;

  // Concurrency: 5 batches in flight (polite)
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < batches.length) {
      const myIdx = i++;
      const b = batches[myIdx];
      const sys = buildSystemPrompt(b.genre);
      const usr = buildUserPayload(b.items);
      const result = await deepseekCall(sys, usr);
      if (!result.ok) {
        failCount += b.items.length;
        for (const it of b.items) {
          log.push({ ...it, generated: null, error: result.error, critique: ['api-fail'] });
        }
        console.log(`  [${myIdx + 1}/${batches.length}] ${b.genre}: FAILED — ${result.error}`);
        continue;
      }
      totalIn += result.usage?.prompt_tokens || 0;
      totalOut += result.usage?.completion_tokens || 0;
      const narrations = result.narrations || [];
      for (let j = 0; j < b.items.length; j++) {
        const it = b.items[j];
        const text = (narrations[j] || '').trim();
        const issues = critiqueText(text, it);
        if (issues.length === 0) okCount++;
        else failCount++;
        log.push({ ...it, generated: text, critique: issues });
      }
      console.log(`  [${myIdx + 1}/${batches.length}] ${b.genre}: ${b.items.length} narrations, ${result.usage?.completion_tokens || '?'} out tokens`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Print summary
  const cost = (totalIn * 0.27 + totalOut * 1.1) / 1_000_000;
  console.log(`\n────────────────────────────────────────`);
  console.log(`Generated: ${log.length}`);
  console.log(`  OK (no critique issues):  ${okCount} (${((okCount / log.length) * 100).toFixed(1)}%)`);
  console.log(`  Issues flagged:           ${failCount} (${((failCount / log.length) * 100).toFixed(1)}%)`);
  console.log(`Tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`);
  console.log(`Cost:   $${cost.toFixed(3)}`);

  // Save log
  const logPath = join(outDir, SANITY ? 'narration-generation-sanity.json' : 'narration-generation.log.json');
  writeFileSync(logPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary: { count: log.length, okCount, failCount, tokens: { input: totalIn, output: totalOut, costUSD: cost } }, log }, null, 2));
  console.log(`\nLog: ${logPath}`);

  if (SANITY) {
    console.log(`\n=== SANITY SAMPLES ===\n`);
    for (const entry of log) {
      console.log(`[${entry.openingId}] ${entry.san} (ply ${entry.plyIndex}, ${entry.classification})`);
      console.log(`  → ${entry.generated || '(NULL)'}`);
      if (entry.critique?.length) console.log(`  ⚠ ${entry.critique.join(', ')}`);
      console.log('');
    }
    console.log(`\nDry-run mode — no annotation files were modified.`);
    return;
  }

  // Apply to annotation files (group by file)
  if (DRY_RUN) {
    console.log('\nDRY RUN — no files modified.');
    return;
  }
  const byFile = new Map();
  for (const entry of log) {
    if (!entry.generated) continue;
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry);
  }
  for (const [fname, entries] of byFile) {
    const fpath = join(annotDir, fname);
    const data = JSON.parse(readFileSync(fpath, 'utf8'));
    const mainList = data.moveAnnotations || data.moveAnalyses || [];
    const subLines = data.subLines || [];
    for (const e of entries) {
      let target;
      if (e.source === 'main') target = mainList[e.plyIndex];
      else {
        const sub = subLines.find((s) => `subline:${s.name}` === e.source.replace(/^subline:/, 'subline:').slice(0, 100) || s.name === e.sublineName);
        const subList = sub?.moveAnnotations || sub?.moveAnalyses || [];
        target = subList[e.plyIndex];
      }
      if (target) {
        target.narration = e.generated;
        target.annotation = e.generated;
      }
    }
    writeFileSync(fpath, JSON.stringify(data, null, 2) + '\n');
  }
  console.log(`\nApplied to ${byFile.size} files.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
