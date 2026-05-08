/**
 * openingGenerator
 * ----------------
 * Real-time LLM generation of opening walkthrough trees. The user
 * says "Teach me [any opening]" → surface routing checks the static
 * registry → checks the Dexie cache → if both miss, calls this
 * service which:
 *   1. Calls Anthropic (forced) with a system prompt that includes
 *      the WalkthroughTree schema + a condensed Vienna sample +
 *      formatting rules.
 *   2. Parses the LLM's JSON response.
 *   3. Runs the validation harness (structural + legality).
 *   4. On validation failure: ONE retry with the failure messages
 *      fed back as context.
 *   5. On success: returns the tree. Caller persists to Dexie.
 *
 * Per CLAUDE.md and conversation context, this is a single-user app,
 * so per-call API cost (~$0.10–0.50) is fine. Caching means each
 * opening is generated at most once per user.
 *
 * Voice consistency: the prompt explicitly references Vienna's
 * voice and supplies a sample node so the LLM mimics the pattern.
 * Style drift is the main risk; that's why we anchor on a sample.
 */
import { Chess } from 'chess.js';
import puzzleData from '../data/puzzles.json';
import { getCoachChatResponse, getCoachStructuredResponse } from './coachApi';
import {
  validateWalkthroughTree,
  validateMoveLegality,
  validateTreeMoveLegality,
  formatIssues,
  stripSanAnnotations,
} from '../data/openingWalkthroughs/validate';
import {
  findRelatedDbEntries,
  resolveOpeningEntry,
  findSiblingExtensionBranches,
  findShortestCanonicalPgn,
  findContinuationsAtPly,
  type ForkBranch,
} from './openingDetectionService';
import { db, type CachedOpening } from '../db/schema';
import { logAppAudit } from './appAuditor';
import type {
  WalkthroughTree,
  WalkthroughTreeNode,
  ConceptCheckQuestion,
  FindMoveQuestion,
  DrillLine,
  PunishLesson,
} from '../types/walkthroughTree';

/** Concrete top-of-tree skeleton showing the root → first-move →
 *  second-move structure. Production audit (build 3965c09 and prior)
 *  caught the LLM placing Black moves directly under root for openings
 *  like Pirc/Sicilian/Caro-Kann — the prose rules in the system prompt
 *  weren't enough; the LLM needed to SEE the JSON shape with the root
 *  placeholder + White's first move + Black's response nested below.
 *  This anchor shows it. Generic king-pawn opening template; the LLM
 *  fills in actual moves and idea text appropriate to the requested
 *  opening. */
const ROOT_STRUCTURE_EXAMPLE = `
ROOT STRUCTURE EXAMPLE — top-of-tree shape for a Pirc Defense walkthrough.
The root node ALWAYS has san: null and movedBy: null. The FIRST entry in
root.children is ALWAYS White's 1st move, regardless of which side the
student is learning. Black's response is nested INSIDE that node's children.

{
  "openingName": "Pirc Defense",
  "eco": "B07",
  "studentSide": "black",
  "intro": "...",
  "outro": "...",
  "root": {
    "san": null,
    "movedBy": null,
    "idea": "",
    "children": [
      {
        "node": {
          "san": "e4",
          "movedBy": "white",
          "idea": "1.e4 — White claims the center...",
          "children": [
            {
              "node": {
                "san": "d6",
                "movedBy": "black",
                "idea": "1...d6 — the Pirc setup move...",
                "children": [
                  { "node": { "san": "d4", "movedBy": "white", ... } }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}

Same shape applies to EVERY opening:
- Italian: root → e4 (white) → e5 (black) → Nf3 (white) → Nc6 (black) → Bc4 (white) → ...
- Sicilian: root → e4 (white) → c5 (black) → Nf3 (white) → d6 (black) → ...
- Queen's Gambit: root → d4 (white) → d5 (black) → c4 (white) → ...
`;

/** Condensed Vienna sample shown to the LLM as a few-shot example.
 *  Just one full node (2.Nc3) showing all the conventions: idea
 *  text, narration segments with arrows, color usage. The LLM
 *  generalizes from this rather than reading the full file. */
const VIENNA_SAMPLE = `
Example node — White's 2.Nc3 in the Vienna:

{
  "san": "Nc3",
  "movedBy": "white",
  "idea": "2.Nc3 — and here's where the Vienna actually starts. The natural move is Nf3 (the Italian and the Spanish both go there), but we play Nc3 instead. Why? Three reasons. One: it develops a piece. Two: it defends e4. Three — and this is the big one — it leaves the f-pawn FREE. In the Italian, after Nf3, the f-pawn is locked behind the knight forever; in the Vienna, f4 is on the table from move three onward. That's the whole opening: a kingside pawn storm waiting to happen.",
  "narration": [
    {
      "text": "2.Nc3 — and here's where the Vienna actually starts. The natural move is Nf3 — the Italian and the Spanish both go there.",
      "arrows": [{ "from": "g1", "to": "f3", "color": "red" }]
    },
    {
      "text": "But we play Nc3 instead. Why? Three reasons. One — it develops a piece.",
      "arrows": [{ "from": "b1", "to": "c3", "color": "green" }]
    },
    {
      "text": "Two — it defends e4 in case Black later threatens it.",
      "arrows": [{ "from": "c3", "to": "e4", "color": "blue" }]
    },
    {
      "text": "Three, and this is the big one — it leaves the f-pawn free.",
      "highlights": [{ "square": "f2", "color": "yellow" }]
    },
    {
      "text": "In the Vienna, f4 is on the table from move three onward. That's the whole opening — a kingside pawn storm waiting to happen.",
      "arrows": [{ "from": "f2", "to": "f4", "color": "green" }]
    }
  ],
  "children": [/* fork or linear children here */]
}

Branch points (children.length > 1) need label + forkSubtitle on every child:
{
  "label": "2…Nf6",
  "forkSubtitle": "Hits e4 — invites the gambit",
  "node": { /* the subtree */ }
}
`;

/** System prompt — instructs the LLM to produce a JSON
 *  WalkthroughTree following the Vienna pattern. Critically: output
 *  must be RAW JSON, no markdown fences, no commentary. */
/** Render a Lichess-DB entry list as a numbered, prompt-friendly
 *  block. Each line: "  {N}. [ECO] Name :: PGN". */
function formatDbEntriesForPrompt(
  entries: Array<{ eco: string; name: string; pgn: string }>,
): string {
  return entries
    .map((e, i) => `  ${i + 1}. [${e.eco}] ${e.name} :: ${e.pgn}`)
    .join('\n');
}

/** Build the BOOK SOURCE block to inject into LLM prompts. Pulls
 *  Lichess-DB entries related to the opening name and formats them
 *  so the LLM has a "book on the table" of verified PGN sequences
 *  to anchor on. Empty string when the DB has nothing for the name
 *  (in which case the LLM falls back to training-memory). */
function buildBookSourceBlock(openingName?: string): string {
  if (!openingName) return '';
  const entries = findRelatedDbEntries(openingName, 30);
  if (entries.length === 0) return '';
  return `

BOOK SOURCE — Lichess opening database. The following PGN sequences are verified from master practice. They are your SOURCE OF TRUTH for move sequences:

${formatDbEntriesForPrompt(entries)}

GROUNDING RULES (this is the most important section):
- Every move sequence you emit (tree spine, fork children, drill moves, punish setupMoves, findMove paths) MUST be a prefix or extension of one of the lines above.
- DO NOT invent novel move sequences from training memory. The lines above are the authoritative theory; if a move you'd otherwise play isn't represented here, don't play it.
- Forks should land at positions where the database itself splits (i.e., the parent PGN above has multiple sub-variations diverging at that ply). Each fork child's first move = the divergence move of one listed line.
- Within a branch, continue down the chosen line's PGN. Do NOT mix moves from different lines in the same branch.
- For punish lessons: the inaccuracy + punishment can be moves NOT in the database (since traps by definition deviate from main theory), but the setupMoves leading up to the inaccuracy MUST be a prefix of a listed line. The punishment + followup should land back on or near a known line.`;
}

function buildSystemPrompt(openingName?: string, mode: 'learn' | 'face' = 'learn'): string {
  const faceBlock = mode === 'face' && openingName ? `

FACE MODE — IMPORTANT:
This lesson teaches the user how to FACE the "${openingName}" as the OPPOSITE side, not how to play it.
- Identify the opposite side (if "${openingName}" is normally played by Black, the user is playing White, and vice versa).
- Pick a SOLID, MAINSTREAM main-line counter / response system that masters use against this opening. Examples:
    • Sicilian Najdorf as White → 6.Be3 English Attack OR 6.Bg5 Classical
    • Caro-Kann as White → 3.e5 Advance Variation OR 3.Nc3 / 3.Nd2 Two Knights
    • French as White → 3.Nc3 Classical OR 3.e5 Advance OR 3.Nd2 Tarrasch
    • King's Indian Defense as White → Sämisch 5.f3 OR Classical 5.Nf3 6.Be2 OR Fianchetto 5.g3
    • Pirc as White → Austrian Attack 4.f4 OR Classical 4.Nf3 5.Be2
- The tree's openingName field should describe the COUNTER you chose, e.g. "English Attack vs Najdorf" or "Advance Variation vs Caro-Kann" — NOT the original opening name. The student is learning the counter, not the opening they're facing.
- The tree's studentSide is the OPPOSITE side from "${openingName}"'s natural side.
- The walkthrough's spine should follow the counter's main line. Forks are at the points where the FACING side has meaningful choices (e.g. 6.Be3 vs 6.Bg5 against the Najdorf).
- The narration should frame the lesson from the counter's perspective: "we're playing against the Najdorf — here's how White restrains Black's setup," etc.
- Idea text should explain what the counter ACCOMPLISHES: where the threats come from, what Black is trying to do that we're stopping, when the position transitions to the middlegame.
- Punish lessons should be Black mistakes the student (White) can exploit, not the other way around.
` : '';

  return `You are an expert chess coach generating a walkthrough lesson for a 1200-1600 rated player. Your output is a JSON object matching the WalkthroughTree schema below. You are reading from your knowledge of standard opening theory — moves should be MAIN-LINE master theory, not engine sidelines.

OUTPUT FORMAT: Raw JSON only. No markdown code fences. No prose before or after. The first character must be \`{\` and the last must be \`}\`. The validation pipeline will fail otherwise.

SCOPE: You are generating ONLY the walkthrough tree (the move-by-move lesson). DO NOT include concepts, findMove, drill, or punish fields — those are generated by separate calls. Including them in your output makes the response truncate and the lesson fails to load. Omit them entirely.

OPENING-NAME INTERPRETATION (read the user's request carefully):
- TYPO TOLERANCE: if the request has a misspelling, normalize to the closest canonical opening name and use that in the openingName field. Examples: "Phillador" → "Philidor Defense"; "Sicillian" → "Sicilian Defense"; "Caro Khan" → "Caro-Kann Defense"; "Kings Indian" → "King's Indian Defense"; "Naijdorf" → "Najdorf Sicilian"; "Reuy Lopez" → "Ruy Lopez". Never refuse a request just because of a typo.
- BROAD vs SPECIFIC depth: a walkthrough is "substantial" when the student leaves it ready to play the early middlegame, not at move 4 holding a pawn. Take the student through the named opening AND a few plies into the resulting middlegame; the deep-dive flow handles drilling further inside any single variation, so this top-level walkthrough must cover the whole opening, not a fragment.
  - BROAD opening (e.g. "Sicilian Defense", "Italian Game", "King's Indian", "Slav", "Caro-Kann Defense"): give an OVERVIEW that reaches the middlegame. 2-3 forks at moves 2-4 surveying the main variations, EACH branch continuing 18-25 plies past the fork into a typical middlegame structure. Pawn-only fragments are not acceptable: develop minor pieces, castle when applicable, reach a position where the student knows what plan they're on. Go DEEP — many MORE moves per branch — but keep narration per move concise. Depth comes from move count, not from longer prose.
  - SPECIFIC VARIATION (e.g. "Najdorf Sicilian", "Italian Two Knights", "King's Indian Mar del Plata", "Hampe-Allgaier", "Vienna Gambit", or any ECO code like "B90"/"C25"): fewer top-level forks (1-2), MORE plies — 25-35 plies of theory inside the variation, with the forks placed at the critical decision points within the variation, ending well into a real middlegame position with a clear plan articulated. Each move's narration stays the same length as before; we go deeper by adding MOVES, not words.
  - The deep-dive UI lets the student pick any leaf or fork and ask for more — DO NOT compress your tree on the assumption that they'll dig deeper later. The walkthrough they get from this call IS the foundation; deep-dive is for the next zoom, not for filling in moves you skipped.

SCHEMA (TypeScript types) — these are the ONLY fields you output:

interface WalkthroughTree {
  openingName: string;       // Display name, e.g. "Italian Game"
  eco: string;               // ECO code, e.g. "C50"
  studentSide: 'white' | 'black';  // REQUIRED. Which side the student is learning. White for openings the student plays AS WHITE (Italian, Vienna, Ruy Lopez, Queen's Gambit, etc.). Black for defenses the student plays AS BLACK (Sicilian, French, Caro-Kann, Pirc, King's Indian, Nimzo-Indian, etc.). Drives board orientation.
  intro: string;             // 2-4 sentence opening framing, coach voice
  outro: string;             // 1-2 sentences inviting next steps
  leafOutros?: Record<string, string>;  // Optional per-leaf custom outros, key = SAN path joined by spaces
  root: WalkthroughTreeNode;
}

interface WalkthroughTreeNode {
  san: string | null;        // null only for root
  movedBy: 'white' | 'black' | null;
  idea: string;              // 15-25 word coach explanation of THIS move ONLY; mention the SAN played; do NOT forecast future moves (the next node's narration covers them)
  narration?: NarrationSegment[];  // STRONGLY PREFERRED: include 1-2 segments per move, each with 1-3 arrows showing strategic intent (what the piece NOW eyes / attacks / pressures), NOT the move itself
  children: { label?: string; forkSubtitle?: string; node: WalkthroughTreeNode }[];
}

interface NarrationSegment {
  text: string;              // 1-2 short sentences
  arrows?: { from: string; to: string; color?: 'green'|'red'|'blue'|'yellow' }[];
  highlights?: { square: string; color?: 'green'|'red'|'blue'|'yellow' }[];
}

CRITICAL MOVE-ORDER RULES:
- Chess ALWAYS starts with White's move. root.children[0].node.san MUST be a White move (e.g. 'e4', 'd4', 'Nf3', 'c4'); root.children[0].node.movedBy MUST be 'white'.
- This applies EVEN when studentSide is 'black'. studentSide: 'black' affects board orientation ONLY — the SAN sequence still alternates white→black→white→black starting from White's 1st move.
- See ROOT STRUCTURE EXAMPLE below for the exact JSON shape. Match it precisely. Production audit caught the LLM repeatedly producing Pirc/Sicilian/Caro-Kann trees with the Black move (d6/c5/c6) as root.children[0] — that's illegal because White moves first. The example below shows the correct shape.

${ROOT_STRUCTURE_EXAMPLE}

CONVENTIONS:
- Coach voice: first-person, conversational, pedagogically clear. Read like a strong coach explaining to a student face-to-face.
- Each idea must MENTION the SAN played (e.g. "Bc4 develops..." or "bishop to c4 develops...").
- Branch points (forks) need every child to have label + forkSubtitle.
- Move-order matters: trace each line carefully. For example, you can't push f4 with Black's bishop on c5 (the long diagonal opens and the g1-knight hangs). The trade or the move-order matters.
- TARGET SIZE: see the BROAD vs SPECIFIC depth rules above for fork count + branch length per opening type. Idea text 15-25 words PER MOVE — TIGHT. Narration 1-2 segments per node, EACH with 1-3 arrows showing strategic intent (what the piece NOW eyes / attacks / pressures — NOT the move's own from→to which the board already animates). The way to go deeper is to add MORE NODES (more plies), NOT to make each node's narration longer. max_tokens is 32768 so the budget covers many nodes; spend the budget on additional plies, not on verbose prose per ply.
- DO NOT forecast future moves in idea text. Each node's idea explains ONLY the move JUST PLAYED. Do not say "Now White should play X" or "After this Black will Y" — the next node's narration covers the next move. Production audit (build d9a5f28) caught Yugoslav Attack narrations running to 80 words with sentences like "Now White should retreat to c5" and "Black will then play e5" — the user is reading the same content twice (once forecast, once on the actual move). Keep each idea grounded in WHAT JUST HAPPENED.
- ARROWS ARE REQUIRED on most moves. Each move's narration should include 1-3 arrows pointing at squares the piece NOW threatens, supports, or pressures. Examples: Bc4 narration arrow c4→f7 ("eyes f7"); Nf3 arrow f3→e5 ("controls e5"); ...c5 arrow c5→d4 ("fights for d4"). Skip arrows only on castling and obvious developing moves.

ARROW + HIGHLIGHT RULES (production audit caught useless arrows; follow these strictly):
- DO NOT draw an arrow on the move being played in this node. The board animates the SAN itself — adding an arrow from the same from→to is redundant noise.
- DO draw arrows on FUTURE moves the narration text mentions. If the prose says "preparing ...c5" → green arrow c7→c5. If it says "...e5 will challenge the center" → green arrow e7→e5. If the prose says "we'll castle" → green arrow e8→g8. If "...Nc6 hits d4" → green arrow b8→c6.
- DO highlight key SQUARES the prose talks about ("eyes f7", "controls e5") with yellow.
- DO use red arrows for OPPONENT THREATS the prose warns about ("careful — White wants Bxh7+") with red from→to.
- Color legend: green = our future plan / our piece's destination. Red = opponent's threat or move-not-to-make. Blue = development / defensive squares. Yellow = key squares the prose highlights.
- If a narration segment doesn't reference a specific square or future move, OMIT arrows/highlights entirely on that segment. A clean board with no arrows is better than nonsense arrows.

LEGAL-MOVE TRAPS (production audit caught all of these — DO NOT repeat):
- FIANCHETTO PREP: To play Bg7 you must FIRST move the g-pawn (...g6). Bishop on f8 → bishop to g7 requires g7 to be EMPTY. Same for Bg2 (needs g3) and Bb7 (needs b6) and Bb2 (needs b3). The Pirc move order is ...d6, ...Nf6, ...g6, THEN ...Bg7 — never ...Bg7 before ...g6.
- QUEENSIDE CASTLING (O-O-O): castling cannot pass through ANY piece on the queenside. All THREE squares between king and rook must be empty: b1, c1, d1 for White; b8, c8, d8 for Black. That means the b-knight (Nb1/Nb8), the c-bishop (Bc1/Bc8), AND the queen (Qd1/Qd8) all need to have moved off their starting squares before O-O-O is legal. Production audit (build 41154ec) caught a Najdorf tree with O-O-O attempted while the c1-bishop was still home — the bishop blocks the king's path. Check ALL three squares are empty before emitting O-O-O.
- KINGSIDE CASTLING (O-O): the f-bishop (Bf1/Bf8) AND g-knight (Ng1/Ng8) must both have moved. King and rook must not have moved.
- Pawn moves can never go BACKWARD or sideways. e4 to e5 is legal, e4 to e3 is not.
- ARROWS: every narration arrow must have from !== to. Don't emit no-op arrows like {from: f7, to: f7} — the validator rejects them and the visual is pointless. To highlight a single square, use the highlights array, not arrows.

${VIENNA_SAMPLE}
${buildBookSourceBlock(openingName)}
${faceBlock}
Now generate the WalkthroughTree ${mode === 'face' ? 'for the COUNTER you chose' : 'for the requested opening'}. Output JSON only.`;
}

/** Parse the LLM's response into a WalkthroughTree. Defensively
 *  handles common LLM output mistakes: markdown code fences,
 *  surrounding prose, trailing commas in objects/arrays, single-line
 *  comments. Production audit (build ea296eb) caught "The Pirc"
 *  generation failing on first parse — likely the LLM output got
 *  truncated mid-JSON when max_tokens was 8192 (now bumped to 16384
 *  in the call), but defensive parsing also helps recover from
 *  smaller LLM mistakes. Returns null if JSON parsing still fails. */
/** Parse result that surfaces the JSON.parse error message when it
 *  fails — production audit (build 23c484d) showed retries producing
 *  non-truncated responses (ended with `}`) that still didn't parse.
 *  Without the error message we couldn't tell why. */
interface ParseResult {
  tree: WalkthroughTree | null;
  /** JSON.parse error message when tree is null, e.g.
   *  "Unexpected token } in JSON at position 1234". */
  parseError?: string;
}

/** Defensively normalize an LLM-emitted JSON string before parse:
 *    - smart double quotes → straight double quotes (LLM occasionally
 *      uses curly " " as STRING DELIMITERS, which JSON.parse rejects)
 *    - smart single quotes → straight apostrophes (cosmetic, not a
 *      parse-breaker but keeps text uniform)
 *    - literal NEL / line-separator / paragraph-separator chars in
 *      strings → spaces (these are valid Unicode but iOS Safari
 *      sometimes treats them as illegal in JSON strings)
 *    - tab characters in strings → spaces (also iOS Safari sensitive)
 *  Production audit (builds c95ccc9 + 41154ec) caught Philidor +
 *  Hampe-Allgaier + Najdorf failing JSON.parse with iOS Safari's
 *  "Expected '}'" message and no position info. The position is
 *  always somewhere INSIDE the response — and the recurring suspect
 *  is character-class issues invisible in the audit dump. */
function preprocessForParse(text: string): string {
  // Use Unicode escapes inside the character classes — U+2028 and
  // U+2029 are line terminators in JS source, so writing them as
  // literal chars in a regex literal breaks the parser across lines.
  let out = text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u0085\u2028\u2029]/g, ' ')
    .replace(/\t/g, ' ');
  // Quote bare object keys. Production audit (build 7dc700f) caught
  // "Italian Game: Blackburne-Kosti\u0107 Gambit" failing both attempts on
  // iOS Safari's "Property name must be a string literal" \u2014 the LLM
  // emitted unquoted keys like `{ node: { san: "e4" } }` for niche
  // openings it knows less well. Anchor on a newline + indentation +
  // identifier + colon \u2014 JSON keys appear at line start in pretty-
  // printed output, and JSON strings can't legally contain raw
  // newlines, so this won't touch prose values.
  out = out.replace(/(\n\s+)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  return out;
}

/** Walk a parsed tree and ensure every node carries a `children`
 *  array. Production audit (build 62a884d) caught an unhandled
 *  rejection — `t.children.length` undefined — recursing through a
 *  Sicilian tree shortly after a JSON parse failure. The crash bubbled
 *  up because downstream walkers (validate, normalizeTreeSans,
 *  auditMoveQuality, useTeachWalkthrough) all trust `node.children` to
 *  be an array. If the LLM's JSON parses but a node omits `children`,
 *  every walker explodes. Failing the parse loudly here keeps a
 *  half-formed tree from leaking into Dexie cache or the runtime. */
export function assertTreeShape(tree: unknown): asserts tree is WalkthroughTree {
  if (!tree || typeof tree !== 'object') {
    throw new Error('tree is not an object');
  }
  const root = (tree as { root?: unknown }).root;
  if (!root || typeof root !== 'object') {
    throw new Error('tree.root missing');
  }
  function visit(node: unknown, path: string): void {
    if (!node || typeof node !== 'object') {
      throw new Error(`${path}: node is not an object`);
    }
    const n = node as { children?: unknown; san?: unknown };
    // Tolerate leaf nodes the LLM emits without an explicit empty
    // children array — production audit (build 998f5c4) caught
    // "Italian Game: Rousseau Gambit" failing both gen attempts at
    // depth 12 because the deepest node was missing `children: []`.
    // Treat undefined/null as an empty leaf instead of failing.
    if (n.children === undefined || n.children === null) {
      n.children = [];
    }
    if (!Array.isArray(n.children)) {
      throw new Error(`${path}: children missing or not an array`);
    }
    for (let i = 0; i < n.children.length; i += 1) {
      const child = n.children[i] as { node?: unknown } | null | undefined;
      if (!child || typeof child !== 'object' || !child.node) {
        throw new Error(`${path}.children[${i}]: missing .node`);
      }
      const san = (child.node as { san?: unknown }).san;
      const childPath = `${path}.children[${i}]${typeof san === 'string' ? `(${san})` : ''}`;
      visit(child.node, childPath);
    }
  }
  visit(root, 'root');
}

function parseGeneratedTree(raw: string): ParseResult {
  let text = raw.trim();
  // Strip markdown code fences defensively.
  text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  // Find the first { and last } in case there's surrounding prose.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) {
    return { tree: null, parseError: 'no balanced { ... } found in response' };
  }
  let jsonText = text.slice(firstBrace, lastBrace + 1);
  // Strip C-style line comments (LLMs sometimes add them despite
  // the prompt). Matches // ... to end of line.
  jsonText = jsonText.replace(/^\s*\/\/[^\n]*$/gm, '');
  // Strip trailing commas before } or ] (LLM frequently adds these
  // even though strict JSON disallows them).
  jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
  function tryParse(text: string): ParseResult {
    try {
      const parsed: unknown = JSON.parse(text);
      assertTreeShape(parsed);
      return { tree: parsed };
    } catch (err) {
      return {
        tree: null,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // First parse attempt: as-is.
  const first = tryParse(jsonText);
  if (first.tree) return first;
  // Second attempt: smart-quote / control-char preprocessing.
  // Production audit recurring "Expected '}'" with no position info
  // is most plausibly explained by character-class issues invisible
  // in the audit dump — try to fix them and re-parse before giving up.
  const preprocessed = preprocessForParse(jsonText);
  if (preprocessed !== jsonText) {
    const second = tryParse(preprocessed);
    if (second.tree) return second;
  }
  return first;
}

/** Normalize an opening name for cache lookup. Lowercase + trim. */
export function normalizeOpeningName(name: string): string {
  return name.trim().toLowerCase();
}

/** Read-through cache: check Dexie before generating. RE-VALIDATES
 *  the cached tree before returning — production audit (build
 *  c2bc340) caught a bad Pirc tree shipping into the cache during
 *  the window before tree-legality validation existed. Re-checking
 *  on retrieval means broken trees from old caches get evicted +
 *  re-generated automatically; users don't have to clear storage. */
export async function getCachedOpening(
  name: string,
): Promise<WalkthroughTree | null> {
  try {
    const normalized = normalizeOpeningName(name);
    const cached = await db.cachedOpenings.get(normalized);
    if (!cached) return null;
    // Sanity-check the cached tree before returning. If illegal SANs
    // were saved before the tree-legality gate existed, evict the
    // record so the next request goes through fresh generation.
    const issues = validateTreeMoveLegality(cached.tree);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      void logAppAudit({
        kind: 'dexie-error',
        category: 'subsystem',
        source: 'openingGenerator.getCachedOpening',
        summary: `evicting broken cached tree for "${name}" — ${errors.length} legality errors`,
        details: errors.slice(0, 3).map((e) => e.message).join('; '),
      });
      await db.cachedOpenings.delete(normalized);
      return null;
    }
    return cached.tree;
  } catch {
    return null;
  }
}

/** Persist a generated tree to Dexie so the second visit is instant. */
export async function cacheOpening(
  name: string,
  tree: WalkthroughTree,
): Promise<void> {
  try {
    const record: CachedOpening = {
      normalizedName: normalizeOpeningName(name),
      displayName: tree.openingName,
      eco: tree.eco,
      tree,
      generatedAt: Date.now(),
    };
    await db.cachedOpenings.put(record);
  } catch (err) {
    void logAppAudit({
      kind: 'dexie-error',
      category: 'subsystem',
      source: 'openingGenerator.cacheOpening',
      summary: `failed to cache "${name}"`,
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Result of a generation attempt. */
export interface GenerationResult {
  ok: boolean;
  tree?: WalkthroughTree;
  /** Reason for failure when ok=false. */
  reason?: string;
  /** Validation issues if any (even on success — warnings only). */
  issues?: string;
}

/** Auto-fix cosmetic schema mistakes the LLM repeatedly makes:
 *  missing label / forkSubtitle on fork children. The validator
 *  flags both as errors which forces a retry — but they're trivially
 *  derivable from the child's SAN. Production audit (build 23c484d)
 *  caught Pirc validation failing on 4 missing-label/subtitle errors
 *  even though the chess content was largely correct. Mutating in
 *  place keeps the caller path simple. Returns the count of fields
 *  filled so the audit can record what was repaired. */
/** Normalize every SAN string in a tree (root walk) by stripping
 *  annotation marks (!, ?, !!, ??, !?, ?!). chess.js rejects SAN with
 *  trailing annotations; the LLM frequently emits them on punish
 *  inaccuracies (e.g. "g4?") and occasionally on tree nodes. The
 *  validator already strips before its chess.js calls, but the
 *  RUNTIME (drill playback, punish move execution, walkthrough animation)
 *  also feeds these SANs into chess.js — so the cached data must be
 *  clean too. Mutates in place. Returns the count of fields normalized. */
export function normalizeTreeSans(tree: WalkthroughTree): number {
  let touched = 0;
  function walk(node: WalkthroughTreeNode): void {
    if (node.san !== null) {
      const stripped = stripSanAnnotations(node.san);
      if (stripped !== node.san) {
        node.san = stripped;
        touched += 1;
      }
    }
    for (const child of node.children) {
      walk(child.node);
    }
  }
  walk(tree.root);
  return touched;
}

/** Normalize SANs on a stage payload (one of concepts / findMove /
 *  drill / punish). Mutates in place. Returns count. */
export function normalizeStageSans(
  stage: 'concepts' | 'findMove' | 'drill' | 'punish',
  data: unknown[],
): number {
  let touched = 0;
  const strip = (s: string): string => {
    const stripped = stripSanAnnotations(s);
    if (stripped !== s) touched += 1;
    return stripped;
  };
  if (stage === 'findMove') {
    for (const q of data as { path?: string[]; candidates?: { san: string }[] }[]) {
      if (q.path) q.path = q.path.map(strip);
      if (q.candidates) {
        for (const c of q.candidates) c.san = strip(c.san);
      }
    }
  } else if (stage === 'drill') {
    for (const line of data as { moves?: string[] }[]) {
      if (line.moves) line.moves = line.moves.map(strip);
    }
  } else if (stage === 'punish') {
    for (const lesson of data as {
      setupMoves?: string[];
      inaccuracy?: string;
      punishment?: string;
      distractors?: { san: string }[];
      followup?: { san: string }[];
    }[]) {
      if (lesson.setupMoves) lesson.setupMoves = lesson.setupMoves.map(strip);
      if (typeof lesson.inaccuracy === 'string') lesson.inaccuracy = strip(lesson.inaccuracy);
      if (typeof lesson.punishment === 'string') lesson.punishment = strip(lesson.punishment);
      if (lesson.distractors) {
        for (const d of lesson.distractors) d.san = strip(d.san);
      }
      if (lesson.followup) {
        for (const f of lesson.followup) f.san = strip(f.san);
      }
    }
  } else if (stage === 'concepts') {
    for (const q of data as { path?: string[] }[]) {
      if (q.path) q.path = q.path.map(strip);
    }
  }
  return touched;
}

// ───────────────────────────────────────────────────────────────────
// STAGE REPAIR — drop bad individual entries instead of failing whole
// stages. The LLM produces 5 punish lessons; if 1 has an illegal SAN,
// we want to keep the other 4, not throw the entire stage away.
//
// Production audit (build 23c484d) showed the Pirc punish stage being
// discarded wholesale due to 6 errors — but really only 2-3 lessons
// were broken; the others were fine. The user wants ANY opening they
// pick to "just work," so per-stage all-or-nothing rejection has to go.
// ───────────────────────────────────────────────────────────────────

interface StageRepairReport {
  /** Entries dropped because they were unsalvageable. */
  dropped: number;
  /** Entries mutated to fix recoverable issues. */
  fixed: number;
  /** Per-action notes for audit logging. */
  notes: string[];
}

/** Try a SAN sequence from a starting position; return the resulting
 *  Chess instance if every move is legal, else null. */
function replayAll(sans: string[], startFen?: string): Chess | null {
  const c = startFen ? new Chess(startFen) : new Chess();
  for (const san of sans) {
    try {
      c.move(stripSanAnnotations(san));
    } catch {
      return null;
    }
  }
  return c;
}

/** Concepts repair:
 *  - single-select with 2+ correct → promote to multiSelect (LLM
 *    intended multi-correct; preserves the question)
 *  - 0 correct → drop (no salvage)
 *  - 0 choices → drop
 *  - illegal path → strip the path (question still works as
 *    starting-position MC) */
export function repairConceptsStage(
  data: ConceptCheckQuestion[],
): { kept: ConceptCheckQuestion[]; report: StageRepairReport } {
  const kept: ConceptCheckQuestion[] = [];
  const report: StageRepairReport = { dropped: 0, fixed: 0, notes: [] };
  for (let i = 0; i < data.length; i += 1) {
    const q = data[i];
    if (!q.choices || q.choices.length === 0) {
      report.dropped += 1;
      report.notes.push(`concepts[${i}]: dropped — no choices`);
      continue;
    }
    const correctCount = q.choices.filter((c) => c.correct).length;
    if (correctCount === 0) {
      report.dropped += 1;
      report.notes.push(`concepts[${i}]: dropped — no correct choice`);
      continue;
    }
    if (!q.multiSelect && correctCount > 1) {
      q.multiSelect = true;
      report.fixed += 1;
      report.notes.push(
        `concepts[${i}]: promoted to multiSelect (had ${correctCount} correct)`,
      );
    }
    if (q.path && q.path.length > 0 && !replayAll(q.path)) {
      const droppedPath = q.path.join(' ');
      q.path = [];
      report.fixed += 1;
      report.notes.push(`concepts[${i}]: stripped illegal path "${droppedPath}"`);
    }
    kept.push(q);
  }
  return { kept, report };
}

/** FindMove repair:
 *  - illegal path → drop (the position can't be reached, no salvage)
 *  - illegal candidate SAN → drop just that candidate
 *  - 0 correct candidates after pruning → drop
 *  - 2+ correct candidates → keep only first as correct, mark rest false
 *  - <2 candidates remaining → drop (MC needs at least 2 options) */
export function repairFindMoveStage(
  data: FindMoveQuestion[],
): { kept: FindMoveQuestion[]; report: StageRepairReport } {
  const kept: FindMoveQuestion[] = [];
  const report: StageRepairReport = { dropped: 0, fixed: 0, notes: [] };
  for (let i = 0; i < data.length; i += 1) {
    const q = data[i];
    const replay = replayAll(q.path ?? []);
    if (!replay) {
      report.dropped += 1;
      report.notes.push(`findMove[${i}]: dropped — illegal path`);
      continue;
    }
    const fen = replay.fen();
    // Filter candidates by SAN legality from the path FEN.
    const validCandidates = q.candidates.filter((c) => {
      const probe = new Chess(fen);
      try {
        probe.move(stripSanAnnotations(c.san));
        return true;
      } catch {
        return false;
      }
    });
    const droppedCands = q.candidates.length - validCandidates.length;
    if (droppedCands > 0) {
      report.fixed += 1;
      report.notes.push(
        `findMove[${i}]: dropped ${droppedCands} illegal candidate(s)`,
      );
    }
    if (validCandidates.length < 2) {
      report.dropped += 1;
      report.notes.push(
        `findMove[${i}]: dropped — only ${validCandidates.length} valid candidate(s) after pruning`,
      );
      continue;
    }
    // Enforce exactly-one-correct.
    const correctIndices = validCandidates
      .map((c, idx) => (c.correct ? idx : -1))
      .filter((idx) => idx >= 0);
    if (correctIndices.length === 0) {
      report.dropped += 1;
      report.notes.push(`findMove[${i}]: dropped — no correct candidate`);
      continue;
    }
    if (correctIndices.length > 1) {
      // Keep first as correct; mark rest false.
      for (let j = 1; j < correctIndices.length; j += 1) {
        validCandidates[correctIndices[j]].correct = false;
      }
      report.fixed += 1;
      report.notes.push(
        `findMove[${i}]: kept first of ${correctIndices.length} correct candidates`,
      );
    }
    q.candidates = validCandidates;
    kept.push(q);
  }
  return { kept, report };
}

/** Drill repair:
 *  - empty moves → drop
 *  - line illegal at move N → if N >= 4 plies, truncate (still useful
 *    as a partial drill); else drop entirely */
export function repairDrillStage(
  data: DrillLine[],
): { kept: DrillLine[]; report: StageRepairReport } {
  const kept: DrillLine[] = [];
  const report: StageRepairReport = { dropped: 0, fixed: 0, notes: [] };
  for (let i = 0; i < data.length; i += 1) {
    const line = data[i];
    if (!line.moves || line.moves.length === 0) {
      report.dropped += 1;
      report.notes.push(`drill[${i}]: dropped — empty moves`);
      continue;
    }
    // Walk move-by-move; find the longest legal prefix.
    const c = new Chess();
    let legalUpTo = 0;
    for (let j = 0; j < line.moves.length; j += 1) {
      try {
        c.move(stripSanAnnotations(line.moves[j]));
        legalUpTo = j + 1;
      } catch {
        break;
      }
    }
    if (legalUpTo === line.moves.length) {
      kept.push(line);
      continue;
    }
    if (legalUpTo >= 4) {
      const dropped = line.moves.length - legalUpTo;
      line.moves = line.moves.slice(0, legalUpTo);
      report.fixed += 1;
      report.notes.push(
        `drill[${i}]: truncated last ${dropped} illegal move(s)`,
      );
      kept.push(line);
    } else {
      report.dropped += 1;
      report.notes.push(
        `drill[${i}]: dropped — only ${legalUpTo} legal move(s) before illegal SAN`,
      );
    }
  }
  return { kept, report };
}

/** Punish repair (most complex — multi-part lesson with several
 *  SAN fields). Drop policy:
 *  - illegal setupMoves / inaccuracy / punishment → drop the lesson
 *    (these are load-bearing; can't continue without them)
 *  - illegal individual distractor → drop just that distractor
 *  - 0 distractors remaining → drop the lesson (MC needs alternatives)
 *  - illegal followup move → truncate followup at the failing index */
export function repairPunishStage(
  data: PunishLesson[],
): { kept: PunishLesson[]; report: StageRepairReport } {
  const kept: PunishLesson[] = [];
  const report: StageRepairReport = { dropped: 0, fixed: 0, notes: [] };
  for (let i = 0; i < data.length; i += 1) {
    const lesson = data[i];
    // Resolve the setup FEN. Puzzle-DB-derived lessons carry an
    // explicit setupFen; LLM-emitted lessons replay setupMoves from
    // the standard start. Either way we end up with a single FEN to
    // probe the inaccuracy / punishment / distractors against.
    let setupFen: string;
    if (lesson.setupFen) {
      try {
        setupFen = new Chess(lesson.setupFen).fen();
      } catch {
        report.dropped += 1;
        report.notes.push(`punish[${i}]: dropped — invalid setupFen`);
        continue;
      }
    } else {
      const setupChess = replayAll(lesson.setupMoves ?? []);
      if (!setupChess) {
        report.dropped += 1;
        report.notes.push(`punish[${i}]: dropped — illegal setupMoves`);
        continue;
      }
      setupFen = setupChess.fen();
    }
    // Apply inaccuracy to get the post-inaccuracy FEN.
    let postInaccuracyFen: string;
    try {
      const probe = new Chess(setupFen);
      probe.move(stripSanAnnotations(lesson.inaccuracy));
      postInaccuracyFen = probe.fen();
    } catch {
      report.dropped += 1;
      report.notes.push(
        `punish[${i}]: dropped — illegal inaccuracy "${lesson.inaccuracy}"`,
      );
      continue;
    }
    // Apply punishment to get the post-punish FEN.
    let postPunishFen: string;
    try {
      const probe = new Chess(postInaccuracyFen);
      probe.move(stripSanAnnotations(lesson.punishment));
      postPunishFen = probe.fen();
    } catch {
      report.dropped += 1;
      report.notes.push(
        `punish[${i}]: dropped — illegal punishment "${lesson.punishment}"`,
      );
      continue;
    }
    // Filter distractors.
    const validDistractors = (lesson.distractors ?? []).filter((d) => {
      const probe = new Chess(postInaccuracyFen);
      try {
        probe.move(stripSanAnnotations(d.san));
        return true;
      } catch {
        return false;
      }
    });
    const droppedDist = (lesson.distractors?.length ?? 0) - validDistractors.length;
    if (droppedDist > 0) {
      report.fixed += 1;
      report.notes.push(`punish[${i}]: dropped ${droppedDist} illegal distractor(s)`);
    }
    if (validDistractors.length === 0) {
      report.dropped += 1;
      report.notes.push(
        `punish[${i}]: dropped — 0 valid distractors after pruning (MC needs alternatives)`,
      );
      continue;
    }
    lesson.distractors = validDistractors;
    // Truncate followup at first illegal move.
    if (lesson.followup && lesson.followup.length > 0) {
      const probe = new Chess(postPunishFen);
      let legalUpTo = 0;
      for (let j = 0; j < lesson.followup.length; j += 1) {
        try {
          probe.move(stripSanAnnotations(lesson.followup[j].san));
          legalUpTo = j + 1;
        } catch {
          break;
        }
      }
      if (legalUpTo < lesson.followup.length) {
        const dropped = lesson.followup.length - legalUpTo;
        lesson.followup = lesson.followup.slice(0, legalUpTo);
        report.fixed += 1;
        report.notes.push(`punish[${i}]: truncated ${dropped} illegal followup move(s)`);
      }
    }
    kept.push(lesson);
  }
  return { kept, report };
}

/** Extract the destination square from a SAN string. Returns null
 *  for castle moves (special — no single dest). Strips check/mate
 *  marks and promotion suffixes before matching the trailing square.
 *  Used by repairNarrationArrows to detect "this arrow just shows
 *  the move that's already animating." */
function sanDestSquare(san: string): string | null {
  if (san === 'O-O' || san === 'O-O-O' || san === '0-0' || san === '0-0-0') {
    return null;
  }
  const stripped = san.replace(/[+#!?]+$/, '');
  const m = stripped.match(/([a-h][1-8])(?:=[QRBN])?$/);
  return m ? m[1] : null;
}

/** Drop narration arrows that are redundant or invalid:
 *  - from === to (LLM no-op "highlight this square" gestures —
 *    Hampe-Allgaier audit caught three of these failing validation)
 *  - to === the move's destination square (the move is already
 *    animating from start→dest; an arrow drawn at that same dest
 *    just clutters the board — production audit (build bdc447a)
 *    caught Bishop's Opening drawing a green arrow on Bc4 showing
 *    the bishop's destination square it was just animated TO).
 *  Mutates in place. Returns the count dropped. */
export function repairNarrationArrows(tree: WalkthroughTree): number {
  let dropped = 0;
  function walk(node: WalkthroughTreeNode): void {
    if (node.narration && node.san !== null) {
      const dest = sanDestSquare(node.san);
      for (const seg of node.narration) {
        if (seg.arrows) {
          const before = seg.arrows.length;
          seg.arrows = seg.arrows.filter((a) => {
            if (a.from === a.to) return false;
            // Drop arrows where the END is the move's destination
            // (showing where the piece just moved TO). Note: arrows
            // FROM the destination toward another square (e.g.
            // c4→f7 to show "now this bishop eyes f7") are kept —
            // those convey new information beyond the move itself.
            if (dest && a.to === dest) return false;
            return true;
          });
          dropped += before - seg.arrows.length;
        }
      }
    }
    for (const child of node.children) {
      walk(child.node);
    }
  }
  walk(tree.root);
  return dropped;
}

export function repairForkLabels(tree: WalkthroughTree): number {
  let filled = 0;
  function walk(node: WalkthroughTreeNode): void {
    if (node.children.length > 1) {
      for (const child of node.children) {
        if (!child.label || !child.label.trim()) {
          child.label = child.node.san ?? '';
          filled += 1;
        }
        if (!child.forkSubtitle || !child.forkSubtitle.trim()) {
          // Derive from the child's first idea sentence — it's a coach
          // explanation so the first sentence usually states the plan.
          // Falls back to the SAN if the idea is empty.
          const idea = child.node.idea ?? '';
          const firstSentence = idea.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
          // Cap to keep the chip from getting unwieldy on the fork picker.
          const subtitle = firstSentence.length > 80
            ? firstSentence.slice(0, 79) + '…'
            : firstSentence;
          child.forkSubtitle = subtitle || (child.node.san ?? '—');
          filled += 1;
        }
      }
    }
    for (const child of node.children) {
      walk(child.node);
    }
  }
  walk(tree.root);
  return filled;
}

/** Drop leafOutros keys that don't correspond to any actual leaf
 *  path in the tree. Production audit (build 998f5c4) caught
 *  "Pirc Defense: Austrian Attack" failing both gen attempts because
 *  two leafOutros keys referenced paths the LLM emitted in its outro
 *  draft but never built into the actual tree. The text is harmless
 *  metadata — orphan keys do nothing at runtime — but the validator
 *  was failing the WHOLE tree over them. Drop the orphans, keep the
 *  rest. Returns count of keys dropped. */
export function repairLeafOutros(tree: WalkthroughTree): number {
  if (!tree.leafOutros) return 0;
  const validLeafPaths = new Set<string>();
  function collect(node: WalkthroughTreeNode, path: string[]): void {
    const here = node.san !== null ? [...path, node.san] : path;
    if (node.children.length === 0) {
      validLeafPaths.add(here.join(' '));
      return;
    }
    for (const c of node.children) collect(c.node, here);
  }
  collect(tree.root, []);
  let dropped = 0;
  for (const key of Object.keys(tree.leafOutros)) {
    if (!validLeafPaths.has(key)) {
      delete tree.leafOutros[key];
      dropped += 1;
    }
  }
  return dropped;
}

/** Walk the tree and prune any subtree rooted at an illegal SAN —
 *  keep the parent node but drop the bad child wrapper entirely.
 *  Production audit (build 59282db) caught "Italian Game:
 *  Blackburne-Kostić Gambit" failing because deep in a punish line
 *  the LLM emitted Be6 from a position where neither bishop could
 *  reach e6 (geometric hallucination). Rather than fail the whole
 *  tree over one bad branch, prune the bad branch and let the rest
 *  of the lesson ship. Returns count of subtrees pruned. */
export function repairTreeIllegalSubtrees(tree: WalkthroughTree): number {
  let pruned = 0;
  const startFen =
    tree.startFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  function walk(node: WalkthroughTreeNode, parentFen: string): void {
    let currentFen = parentFen;
    if (node.san !== null) {
      const probe = new Chess(parentFen);
      try {
        probe.move(stripSanAnnotations(node.san));
      } catch {
        // Caller prunes — we never enter here directly. Children of an
        // illegal node can't be replayed because the FEN is unknown,
        // so dump them too.
        node.children = [];
        return;
      }
      currentFen = probe.fen();
    }
    // Drop child wrappers whose root SAN is illegal at currentFen, then
    // recurse into surviving children to prune deeper illegality.
    const kept: typeof node.children = [];
    for (const child of node.children) {
      const childSan = child.node.san;
      if (childSan === null) {
        kept.push(child);
        continue;
      }
      const probe = new Chess(currentFen);
      try {
        probe.move(stripSanAnnotations(childSan));
        kept.push(child);
      } catch {
        pruned += 1;
      }
    }
    node.children = kept;
    for (const child of node.children) {
      walk(child.node, currentFen);
    }
  }
  walk(tree.root, startFen);
  return pruned;
}

/** Catch-all content cleanup for the long tail of small validator
 *  errors that shouldn't fail an entire 30-60s LLM gen. Handles:
 *
 *  - Empty `idea` on a non-root node — fill with the SAN itself so
 *    the empty-idea + idea-mentions-SAN checks both pass. The lesson
 *    is shallower for that one move but doesn't fail the gen.
 *  - Empty `narration` array — delete the field (the validator says
 *    "omit the field instead" so we comply).
 *  - Empty narration segment text — drop the segment; if all
 *    segments were empty, delete the narration field entirely.
 *  - Invalid algebraic arrow.from / arrow.to / highlight.square —
 *    drop just that arrow / highlight. Validator only accepts a-h+1-8.
 *  - Empty `openingName` — fall back to the requested name.
 *  - Empty `eco` — fall back to "?" (the field is required to be
 *    non-empty but the LLM occasionally omits ECO for niche openings).
 *
 *  Returns aggregate counts so audit can spot patterns. */
export function repairTreeContent(
  tree: WalkthroughTree,
  requestedName: string,
): {
  ideasFilled: number;
  narrationsDropped: number;
  segmentsDropped: number;
  arrowsDropped: number;
  highlightsDropped: number;
  treeFieldsFilled: number;
} {
  const out = {
    ideasFilled: 0,
    narrationsDropped: 0,
    segmentsDropped: 0,
    arrowsDropped: 0,
    highlightsDropped: 0,
    treeFieldsFilled: 0,
  };
  const SQUARE_RE = /^[a-h][1-8]$/;
  // Tree-level fields.
  if (!tree.openingName.trim()) {
    tree.openingName = requestedName;
    out.treeFieldsFilled += 1;
  }
  if (!tree.eco.trim()) {
    tree.eco = '?';
    out.treeFieldsFilled += 1;
  }
  function walk(node: WalkthroughTreeNode): void {
    if (node.san !== null && !node.idea.trim()) {
      // The validator's empty-idea check is hard-error; the
      // mention-SAN check is a warning. Use a sentence-form template
      // with the SAN embedded so narration is at least readable
      // ("Bare SAN" was unusable — TTS would say just "e4" with no
      // context). Word count is low (~7 words) which still trips the
      // "short idea" warning, but warnings don't fail the gen.
      const piece = node.san[0];
      const isPiece = ['N', 'B', 'R', 'Q', 'K'].includes(piece);
      node.idea = isPiece
        ? `${node.san} continues development for ${node.movedBy ?? 'the side to move'}.`
        : `${node.san} — the standard reply in this line.`;
      out.ideasFilled += 1;
    }
    if (node.narration !== undefined) {
      // Drop empty-text segments; drop arrows/highlights with bad squares.
      const cleanSegs = [];
      for (const seg of node.narration) {
        if (!seg.text.trim()) {
          out.segmentsDropped += 1;
          continue;
        }
        if (seg.arrows) {
          const before = seg.arrows.length;
          seg.arrows = seg.arrows.filter(
            (a) => SQUARE_RE.test(a.from) && SQUARE_RE.test(a.to),
          );
          out.arrowsDropped += before - seg.arrows.length;
        }
        if (seg.highlights) {
          const before = seg.highlights.length;
          seg.highlights = seg.highlights.filter((h) =>
            SQUARE_RE.test(h.square),
          );
          out.highlightsDropped += before - seg.highlights.length;
        }
        cleanSegs.push(seg);
      }
      if (cleanSegs.length === 0) {
        delete node.narration;
        out.narrationsDropped += 1;
      } else {
        node.narration = cleanSegs;
      }
    }
    for (const child of node.children) walk(child.node);
  }
  walk(tree.root);
  return out;
}

/** Pull the first N SAN values from a generated tree by walking
 *  root.children depth-first along the leftmost path. Used in audit
 *  logs so we can SEE what the LLM produced — the most diagnostic
 *  signal when validation fails is "did the LLM put Black on top?"
 *  Returns up to maxDepth SANs from the leftmost spine. */
function firstSansAlongLeftSpine(
  tree: WalkthroughTree,
  maxDepth: number,
): string[] {
  const sans: string[] = [];
  let node = tree.root;
  while (node.children.length > 0 && sans.length < maxDepth) {
    const next = node.children[0].node;
    sans.push(next.san ?? '<null>');
    node = next;
  }
  return sans;
}

/** Snapshot the LLM's structural shape into one short string for
 *  audit triage: childCount + first SANs along the leftmost spine.
 *  At a glance you can see "Pirc tree shape: rootKids=1, spine=d6,d4,Nf6"
 *  and immediately know the LLM put Black on top. */
function describeTreeShape(tree: WalkthroughTree): string {
  const rootKidCount = tree.root.children.length;
  const spine = firstSansAlongLeftSpine(tree, 6).join(',');
  const firstMover = tree.root.children[0]?.node.movedBy ?? '<missing>';
  return `rootKids=${rootKidCount}, firstMover=${firstMover}, spine=${spine}`;
}

/** Single generation attempt — calls the LLM, parses, validates.
 *  No retry; the wrapper `generateOpening` does the retry. */
/** JSON Schema for the WalkthroughTree, used as the input schema in
 *  Anthropic tool-use mode. The API validates the LLM's output
 *  against this schema server-side, eliminating the entire class of
 *  client-side JSON parse errors that have plagued niche-opening
 *  gens. Keep this synced with the WalkthroughTree TypeScript type
 *  in src/types/walkthroughTree.ts (only the fields the LLM emits;
 *  optional fields like leafOutros are allowed but not required). */
const WALKTHROUGH_TREE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['openingName', 'eco', 'studentSide', 'intro', 'outro', 'root'],
  properties: {
    openingName: { type: 'string' },
    eco: { type: 'string' },
    studentSide: { type: 'string', enum: ['white', 'black'] },
    intro: { type: 'string' },
    outro: { type: 'string' },
    leafOutros: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    root: { $ref: '#/$defs/treeNode' },
  },
  $defs: {
    treeNode: {
      type: 'object',
      required: ['children'],
      properties: {
        san: { type: ['string', 'null'] },
        movedBy: { type: ['string', 'null'], enum: ['white', 'black', null] },
        idea: { type: 'string' },
        narration: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string' },
              arrows: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['from', 'to'],
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    color: { type: 'string' },
                  },
                },
              },
              highlights: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['square'],
                  properties: {
                    square: { type: 'string' },
                    color: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        children: {
          type: 'array',
          items: {
            type: 'object',
            required: ['node'],
            properties: {
              label: { type: 'string' },
              forkSubtitle: { type: 'string' },
              node: { $ref: '#/$defs/treeNode' },
            },
          },
        },
      },
    },
  },
};

async function generateOnce(
  name: string,
  retryContext?: string,
  mode: 'learn' | 'face' = 'learn',
): Promise<GenerationResult> {
  const systemPrompt = buildSystemPrompt(name, mode);
  const userMessage = retryContext
    ? `Generate the WalkthroughTree for: ${name}

Your previous attempt failed:
${retryContext}

CRITICAL on this retry:
- Output ONLY raw JSON. First character must be \`{\`, last must be \`}\`. The validator checks that the LAST character of your response is \`}\` — if your output is truncated mid-JSON, parsing fails.
- DO NOT include concepts/findMove/drill/punish — they are generated separately. Including them is the #1 cause of truncation.
- Keep idea text 15-25 words PER MOVE — short. Don't forecast future moves. Include 1-3 arrows per node showing strategic intent.
- Aim for 3 forks total, each ~6-8 plies deep. NOT 4-5 forks.
- No markdown fences. No prose. No comments. No trailing commas.

Fix the issues above and produce a SHORTER, valid tree.`
    : `Generate the WalkthroughTree for: ${name}`;

  // PRIMARY PATH: Anthropic tool-use mode. The LLM is forced to
  // emit a JSON object matching WALKTHROUGH_TREE_SCHEMA and the API
  // validates it server-side. Eliminates the entire class of parse
  // errors (smart quotes, control chars, unbalanced braces, unquoted
  // keys, truncation mid-string) that have plagued niche openings
  // like Najdorf / Pirc / Blackburne-Kostić. Production audit (build
  // e86aa19): "THIS IS GETTING OLD" — text-mode kept failing in
  // ways the parse-recovery pipeline couldn't catch. Tool-use is the
  // structural fix.
  //
  // Falls through to legacy text-mode path on tool-use failure
  // (e.g. no Anthropic key configured, network error). Either path
  // produces a tree we run through the same validation + repair
  // pipeline downstream — the only difference is HOW we got the
  // raw object.
  let tree: WalkthroughTree | null = null;
  let rawResponse = '';
  let parseResult: ParseResult = { tree: null };
  try {
    const toolResult = await getCoachStructuredResponse(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      'chat_response',
      32768,
      'emit_walkthrough_tree',
      `Emit the walkthrough tree for the requested opening. The tree must follow WalkthroughTree schema exactly. Every children array must contain {node: ...} wrappers, never bare nodes.`,
      WALKTHROUGH_TREE_SCHEMA,
    );
    // The API guarantees `toolResult` matches WALKTHROUGH_TREE_SCHEMA
    // — but we still run our own assertTreeShape because (a) JSON
    // Schema can't express "every child has a `node` key whose
    // children are also valid trees" recursively in all SDK versions,
    // and (b) downstream walkers depend on every node having a
    // `children` array (assertTreeShape now auto-fills empty
    // children, see commit 59282db).
    assertTreeShape(toolResult);
    tree = toolResult as WalkthroughTree;
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `tool-use gen succeeded for "${name}"${retryContext ? ' (retry)' : ''}`,
    });
  } catch (toolErr) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `tool-use failed for "${name}" — falling back to text mode: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`,
    });
    // Fallthrough to text-mode path.
    try {
      rawResponse = await getCoachChatResponse(
        [{ role: 'user', content: userMessage }],
        systemPrompt,
        undefined, // no streaming
        'chat_response',
        // 32768 max tokens — Claude Opus 4's full output budget. User
        // feedback (build 12d9ff3): "We also need to go deeper into
        // lines. This is becoming an issue." The walkthrough has been
        // stopping at 5-7 plies in branches because the prompt + DB
        // book source + tree JSON were splitting 16K tokens across
        // multiple branches. Bumping to 32K gives each branch real
        // room to land at the middlegame.
        32768,
        undefined,
        'anthropic',
      );
    } catch (err) {
      return {
        ok: false,
        reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (rawResponse.startsWith('⚠️')) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOnce',
        summary: `LLM provider error for "${name}"${retryContext ? ' (retry)' : ''}`,
        details: rawResponse.slice(0, 500),
      });
      return { ok: false, reason: rawResponse };
    }

    parseResult = parseGeneratedTree(rawResponse);
    tree = parseResult.tree;
  }
  if (!tree) {
    // Detect truncation explicitly — if the last non-whitespace char
    // isn't `}`, the response was cut off mid-stream (most likely
    // hit max_tokens). That's a different remedy than malformed JSON
    // (e.g. trailing comma) so flag it separately in the trail.
    const trimmed = rawResponse.trimEnd();
    const looksTruncated = trimmed.length > 0 && trimmed[trimmed.length - 1] !== '}';
    const reason = looksTruncated
      ? 'JSON parse failed — response truncated (does not end with `}`); LLM exceeded token budget'
      : `JSON parse failed — ${parseResult.parseError ?? 'unknown error'}`;
    // Around the parse error position, dump the surrounding 200 chars
    // — that's the diagnostic the audit needs. Production audit (build
    // 23c484d) showed a retry response ending in `}` but not parsing,
    // and we couldn't see what broke without the error message + locale.
    // Production audit (build c95ccc9) caught Philidor failing with
    // iOS Safari's "Expected '}'" message — no position number, so the
    // position-based window didn't fire and we were blind to which
    // region broke. Fall back to dumping the LAST 500 chars (where
    // structural-tail errors usually live).
    let errorContext = '';
    const posMatch = parseResult.parseError?.match(/position (\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const start = Math.max(0, pos - 100);
      const end = Math.min(rawResponse.length, pos + 100);
      errorContext = `\n--- 200 chars around position ${pos} ---\n${rawResponse.slice(start, end)}`;
    } else if (rawResponse.length > 500) {
      errorContext = `\n--- last 500 chars (no position in error message) ---\n${rawResponse.slice(-500)}`;
    }
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `${looksTruncated ? 'truncated response' : 'JSON parse failed'} for "${name}"${retryContext ? ' (retry)' : ''}`,
      details:
        `responseLength=${rawResponse.length} endsWith=${JSON.stringify(trimmed.slice(-50))}\n` +
        `parseError: ${parseResult.parseError ?? '<none>'}` +
        errorContext +
        `\n--- raw response (first 1500 chars) ---\n${rawResponse.slice(0, 1500)}`,
    });
    return { ok: false, reason };
  }

  // Auto-repair cosmetic schema mistakes the LLM keeps making
  // (missing label / forkSubtitle on fork children). Production
  // audit (build 23c484d) caught Pirc validation failing on 4
  // missing-label/subtitle errors that were trivially derivable
  // from the SAN. Fixing in code beats begging the LLM to remember.
  const repaired = repairForkLabels(tree);
  if (repaired > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `auto-repaired ${repaired} missing label/forkSubtitle entries for "${name}"`,
    });
  }
  // Strip PGN annotation marks from every SAN. The validator already
  // strips before its chess.js calls so validation passes, but the
  // RUNTIME drill / punish / walkthrough animation will fail to advance
  // if the cached data has "g4?" instead of "g4".
  const sansNormalized = normalizeTreeSans(tree);
  if (sansNormalized > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `stripped ${sansNormalized} SAN annotation marks for "${name}"`,
    });
  }
  // Drop no-op arrows (from === to). Production audit (build 41154ec)
  // caught Hampe-Allgaier validation failing on 3 same-square arrows.
  // Visual is pointless and validation rejects them; auto-drop is
  // strictly better than re-rolling the whole gen.
  const noopArrowsDropped = repairNarrationArrows(tree);
  if (noopArrowsDropped > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `dropped ${noopArrowsDropped} no-op (from===to) arrows for "${name}"`,
    });
  }

  // Prune subtrees rooted at an illegal SAN. The rest of the lesson
  // is usually fine — failing the whole tree over one bad child wastes
  // a 30-60s LLM call. Production audit (build 59282db).
  const illegalSubtreesPruned = repairTreeIllegalSubtrees(tree);
  // Sanity: pruning must not produce a degenerate tree. If the root
  // has no children left, there's no lesson to ship — fail fast and
  // let the caller retry. Same for a 1-deep "lesson" (root → one leaf
  // with no continuation) — that's not pedagogically usable.
  const rootHasNoChildren = tree.root.children.length === 0;
  const onlyOneShallowChild =
    tree.root.children.length === 1 &&
    tree.root.children[0].node.children.length === 0;
  if (rootHasNoChildren || onlyOneShallowChild) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `tree is degenerate after pruning for "${name}" (rootChildren=${tree.root.children.length}, pruned=${illegalSubtreesPruned})`,
    });
    return {
      ok: false,
      reason: `tree degenerate after pruning ${illegalSubtreesPruned} illegal subtree(s)`,
    };
  }
  if (illegalSubtreesPruned > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `pruned ${illegalSubtreesPruned} subtree(s) at illegal SAN for "${name}"`,
    });
  }

  // Drop leafOutros keys that don't correspond to actual leaf paths.
  // Pure metadata cleanup; the runtime never reads orphan keys.
  // Production audit (build 998f5c4): Pirc Austrian Attack failed
  // because two leafOutros keys referenced paths the LLM drafted in
  // outro text but never built into the tree.
  const orphanLeafOutros = repairLeafOutros(tree);
  if (orphanLeafOutros > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `dropped ${orphanLeafOutros} orphan leafOutros key(s) for "${name}"`,
    });
  }

  // Catch-all content cleanup: empty ideas, empty narration, invalid
  // squares, missing tree-level fields. Closes the long tail of
  // single-validator-rule failures that shouldn't fail the whole gen.
  const contentRepairs = repairTreeContent(tree, name);
  const contentTotal =
    contentRepairs.ideasFilled +
    contentRepairs.narrationsDropped +
    contentRepairs.segmentsDropped +
    contentRepairs.arrowsDropped +
    contentRepairs.highlightsDropped +
    contentRepairs.treeFieldsFilled;
  if (contentTotal > 0) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary:
        `repaired tree content for "${name}" — ` +
        `ideasFilled=${contentRepairs.ideasFilled} ` +
        `narrationsDropped=${contentRepairs.narrationsDropped} ` +
        `segmentsDropped=${contentRepairs.segmentsDropped} ` +
        `arrowsDropped=${contentRepairs.arrowsDropped} ` +
        `highlightsDropped=${contentRepairs.highlightsDropped} ` +
        `treeFieldsFilled=${contentRepairs.treeFieldsFilled}`,
    });
  }

  const structural = validateWalkthroughTree(tree);
  const legality = validateMoveLegality(tree);
  // CRITICAL: validate the walkthrough tree's own SANs are legal
  // from their parent positions. Production audit (build c2bc340)
  // caught the LLM generating a Pirc tree where the first child's
  // san='d6' (Black's move) — illegal from the standard starting
  // position because White moves first. The tree shipped, got
  // cached, narration played but the board never advanced because
  // chess.js silently rejected each move. Without this gate, broken
  // trees ship and cache.
  const treeLegality = validateTreeMoveLegality(tree);
  const allIssues = [...structural, ...legality, ...treeLegality];
  const errors = allIssues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const formatted = formatIssues(errors);
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOnce',
      summary: `validation failed for "${name}"${retryContext ? ' (retry)' : ''} — ${errors.length} errors`,
      // Include the parsed tree shape (so we know if the LLM put Black
      // on top, missed root, etc.) and the first 1500 chars of issues.
      // Without this, "validation failed" is opaque and we can't
      // diagnose without re-running.
      details:
        `shape: ${describeTreeShape(tree)}\n` +
        `issues:\n${formatted.slice(0, 2500)}`,
    });
    return {
      ok: false,
      reason: 'validation failed',
      issues: formatted,
    };
  }

  return {
    ok: true,
    tree,
    issues:
      allIssues.length > 0
        ? formatIssues(allIssues.filter((i) => i.severity === 'warning'))
        : undefined,
  };
}

/** Generate a walkthrough tree for the given opening name. Tries
 *  once; on validation failure, tries once more with the error
 *  messages fed back. Returns null on total failure. */
export interface GenerateOpeningOptions {
  /** When 'face', the LLM is instructed to teach the OPPOSITE side
   *  the main-line counter against the named opening. The resulting
   *  tree's openingName will be the counter (e.g. "English Attack vs
   *  Najdorf"), not the original variation. Default 'learn'. */
  mode?: 'learn' | 'face';
  /** 'full' = the standard lesson with branch extensions to
   *  middlegame, post-walkthrough quiz / drill / punish stages, and
   *  longer per-move narrations. 'tour' = a quick playthrough — same
   *  spine + fork branches (so variation choice still works) but
   *  shorter narrations, shorter branch extensions, and no
   *  post-walkthrough stage gens. User: "Add a quick walk through
   *  mode from coach." Default 'full'. */
  pace?: 'full' | 'tour';
}

/** Schema for the narration-only LLM call. Inverts the gen
 *  architecture: code provides the move sequence (legal by DB
 *  construction) and the FENs (correct by chess.js replay); the LLM
 *  only writes one short sentence per move plus intro/outro.
 *
 *  v2 extension: when the canonical opening has sibling DB entries
 *  that extend its PGN (e.g. Najdorf has English Attack, Adams
 *  Attack, Bg5 Main Line, Opocensky etc), code surfaces them as
 *  fork branches at the end of the spine and asks the LLM for a
 *  one-sentence teaser idea per branch. */
const NARRATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intro', 'outro', 'ideas'],
  properties: {
    intro: { type: 'string' },
    outro: { type: 'string' },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' },
          arrows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['from', 'to'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
          },
        },
      },
    },
    branchIdeas: { type: 'array', items: { type: 'string' } },
    // For each fork branch, ideas for the EXTENSION moves that walk
    // the line into middlegame. Outer index matches branches[]; inner
    // index matches branches[i].extensionMoves[]. User: "ALL lines
    // extend to here [middlegame]." Without this every branch was
    // just the one divergent move, dropping the student off at the
    // moment the variation gets named with no idea what to play next.
    branchExtensionIdeas: {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            arrows: {
              type: 'array',
              items: {
                type: 'object',
                required: ['from', 'to'],
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

interface NarrationIdea {
  text: string;
  arrows?: { from: string; to: string }[];
}

interface NarrationOutput {
  intro: string;
  outro: string;
  ideas: NarrationIdea[];
  branchIdeas?: string[];
  branchExtensionIdeas?: NarrationIdea[][];
}

/** PRIMARY gen path: build the walkthrough tree skeleton from the
 *  Lichess DB's canonical PGN (deterministic — moves are legal by
 *  DB construction, FENs are correct by chess.js replay), then ask
 *  the LLM for ONE short sentence per move plus an intro and outro.
 *  Same end-state as the legacy free-form tree gen but with all the
 *  failure modes structurally eliminated:
 *    - No invalid SANs (DB guarantees them).
 *    - No JSON tree shape errors (the schema is tiny + flat).
 *    - No truncation mid-tree (output is N short strings, not a
 *      deeply-nested tree).
 *    - Token usage is roughly N × 25 words, far smaller than the
 *      old 30-50K-char tree responses.
 *
 *  Returns null when the opening isn't in the DB (caller should
 *  fall through to the legacy free-form gen path). */
// Helper for sibling DB extensions (deep-dive forks) is in
// openingDetectionService — we use it here without re-importing the
// raw openings-lichess.json data.


async function generateOpeningFromDbNarration(
  name: string,
  pace: 'full' | 'tour' = 'full',
  /** Optional FACE-mode metadata. When provided, the resulting
   *  tree's studentSide is FLIPPED (the student plays the OPPOSITE
   *  side from the canonical opening — they're learning the counter,
   *  not the opening itself), and the openingName is prefixed with
   *  "Facing: " so the UI doesn't confuse it for a normal lesson.
   *  Caller passes the original opening's display name so the prose
   *  can frame the lesson as a counter to that opening. */
  faceContext?: { originalDisplayName: string },
): Promise<WalkthroughTree | null> {
  const entry = resolveOpeningEntry(name);
  if (!entry || entry.moves.length === 0) return null;

  // Use the SHORTEST canonical PGN as the spine. The DB carries
  // multiple rows for popular openings at different depths (Najdorf
  // at 10/11/12/13/14 plies); the bare entry is the natural spine
  // and leaves the most room for fork branches at the end. The
  // longer-depth rows ARE valid lines but they're better surfaced
  // as DB-grounded deep-dive targets, not the default walkthrough.
  const shortPgn = findShortestCanonicalPgn(entry.canonicalName);
  const spineMoves = shortPgn
    ? shortPgn.split(/\s+/).filter(Boolean)
    : entry.moves;

  // 1. Replay the PGN, collect each move's SAN + post-move FEN.
  type Position = { san: string; fen: string; ply: number; movedBy: 'white' | 'black' };
  const positions: Position[] = [];
  const c = new Chess();
  for (let i = 0; i < spineMoves.length; i += 1) {
    try {
      c.move(stripSanAnnotations(spineMoves[i]));
    } catch {
      return null; // DB entry corrupt — extremely rare, abort
    }
    positions.push({
      san: spineMoves[i],
      fen: c.fen(),
      ply: i,
      movedBy: i % 2 === 0 ? 'white' : 'black',
    });
  }

  // 1b. Find sibling extensions to inject as deep-dive fork branches
  //     at the end of the spine. For Najdorf this surfaces English
  //     Attack, Adams Attack, Bg5 Main Line, Opocensky / Scheveningen
  //     under Be2, etc. — the actual deep-dive choices a student
  //     would expect.
  const rawBranches: ForkBranch[] = findSiblingExtensionBranches(
    entry.canonicalName,
    spineMoves.join(' '),
  );
  // Tour mode caps branch extensions tighter so the lesson stays
  // snappy. Full mode runs each branch to the END of the Lichess DB
  // entry (no truncation — `findSiblingExtensionBranches` returns
  // every ply the DB carries); tour shortens to 3 plies so each
  // branch is a quick taste, not a deep walkthrough.
  const TOUR_EXT_CAP = 3;
  const branches: ForkBranch[] = pace === 'tour'
    ? rawBranches.map((b) => ({
        ...b,
        extensionMoves: b.extensionMoves.slice(0, TOUR_EXT_CAP),
      }))
    : rawBranches;

  // 2. Single LLM call: ask for narration text only.
  // Student side: in normal mode, derive from the canonical name.
  // In FACE mode the student plays the OPPOSITE side (they're
  // learning the counter to the named opening, not the opening
  // itself), so flip.
  const baseStudentSide = inferStudentSideFromName(entry.canonicalName);
  const studentSide = faceContext
    ? (baseStudentSide === 'white' ? 'black' : 'white')
    : baseStudentSide;
  const moveLabels = positions
    .map((p, idx) => {
      const moveNum = Math.floor(p.ply / 2) + 1;
      const dotted = p.movedBy === 'white' ? `${moveNum}.` : `${moveNum}…`;
      return `${idx + 1}. ${dotted}${p.san}  (after this move FEN: ${p.fen})`;
    })
    .join('\n');
  // Branches sit at the position AFTER the canonical's last move.
  // Same FEN = positions[last].fen. Whose turn is determined by the
  // total ply count's parity.
  const branchLabels = branches
    .map((b, idx) => {
      const extInfo =
        b.extensionMoves.length > 0
          ? ` extending into middlegame with: ${b.extensionMoves.join(' ')}`
          : '';
      return `${idx + 1}. "${b.label}" (entry move: ${b.san}) — ${b.count} sub-line${b.count === 1 ? '' : 's'} in DB${extInfo}`;
    })
    .join('\n');
  const lessonFraming = faceContext
    ? `a walkthrough of "${entry.canonicalName}" — the canonical White (or attacking side) counter to "${faceContext.originalDisplayName}". The student is the side PLAYING this counter (learning to face the named opening from the opposite perspective), not the side being countered.`
    : `a walkthrough of "${entry.canonicalName}".`;
  const systemPrompt = `You are an expert chess coach narrating ${lessonFraming} Output ONLY a JSON object matching the schema. The move sequence and positions are PROVIDED — do NOT invent or alter them. Your only job is to write short coach commentary plus optional visualization arrows.

For each move in the line, return:
- text: ONE sentence (max ${pace === 'tour' ? 12 : 25} words) explaining the IDEA behind the move. First-person, second-person, conversational. Mention the SAN or its spoken form somewhere. ${pace === 'tour' ? 'TOUR MODE: keep narrations TIGHT — the student wants a quick playthrough, not a lecture.' : ''}Examples:
  - "1.e4 grabs the center and frees the king's bishop and queen."
  - "1...c5 — Black declines the symmetry and aims for asymmetric play on the queenside."
  - "5.Nc3 develops the knight, defends e4, and prepares Bc4 or Qe2."
- arrows (OPTIONAL, 0-3 per move): the user wants arrows ONLY for two purposes:
  (a) THREATS — squares the moved piece NOW attacks / pressures / eyes (Bc4 → f7, Nf3 → e5, c5 → d4).
  (b) LOOK-AHEAD — the next critical square on the line we're walking (Re1 → e8 because the rook will land there in 2 moves; Nc3 → d5 because the knight is going to d5 next).
  Do NOT draw the move's own from→to (the board animates that — drawing it again is noise). Do NOT draw retrospective arrows. Skip arrows entirely when neither category fits (O-O, generic developing moves).
- Use squares in algebraic notation only (e.g. "e4", "f7"). Empty arrows array is fine; do NOT invent arrows just to fill the field.

The student is playing as ${studentSide}. Frame ideas from that perspective when relevant.

Also produce:
- intro: 2-3 sentences framing the lesson
- outro: 1-2 sentences inviting the next step (drill / face the variation / try a deeper line)
${branches.length > 0 ? `- branchIdeas: ONE sentence (max 20 words) for EACH branch the student might dive into next. Mention the named line and its strategic flavor (sharp / positional / pawn-storm / quiet etc).
- branchExtensionIdeas: a 2D array. For EACH branch (in the same order as branches[]), emit an array of EXACTLY ONE idea object per extension move provided. If a branch has 6 extension moves you MUST emit 6 idea objects in its inner array — no fewer. This is the most-undersized field in past gens and the student ends up reading template prose instead of your prose; do not skimp.
  - text rules: same as the spine ideas (max ${pace === 'tour' ? 12 : 25} words, mention the SAN, do NOT forecast future moves).
  - arrow rules (CRITICAL): arrows on the EXTENSION moves should ONLY show:
      (a) THREATS — squares the moved piece NOW attacks/pressures (Bc4 → f7), or
      (b) LOOK-AHEAD — the next critical square on the line you're walking (Re1 → e8 if the rook is going to lift, Nc3 → d5 if the knight is heading to d5 next).
    Do NOT draw the move's own from→to (the board animates that). Skip arrows when nothing useful to show.
  Example: for "English Attack" with extension "Ng4 Bg5 Qa5+", emit 3 idea objects narrating those three plies.` : ''}`;
  const userPrompt = `Opening: ${entry.canonicalName} (${entry.eco})
Student plays: ${studentSide}
Total moves in spine: ${positions.length}

Moves with post-move FENs:
${moveLabels}
${branches.length > 0 ? `\nBranches available at the end of the spine (the student picks one to dive deeper):\n${branchLabels}\n\nFor each branch, write ONE short sentence describing what kind of line it is.` : ''}

Emit a JSON object with intro (string), outro (string), ideas (array of ${positions.length} objects { text, arrows? }, one per spine move in order)${branches.length > 0 ? `, and branchIdeas (array of ${branches.length} strings, one per branch in order)` : ''}.`;

  let narration: NarrationOutput;
  try {
    const result = await getCoachStructuredResponse(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      'chat_response',
      // Each idea is ~25 words ≈ 35 tokens. N moves + intro + outro
      // + JSON envelope ≈ N×40 + 200. Cap at 4K which fits ~95 ideas
      // (more than any realistic walkthrough).
      4096,
      'emit_walkthrough_narration',
      'Emit short coach narrations (one sentence per provided move) plus an intro and outro for the line.',
      NARRATION_SCHEMA,
    );
    narration = result as NarrationOutput;
  } catch (err) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOpeningFromDbNarration',
      summary: `narration LLM call failed for "${name}" — falling back to template ideas: ${err instanceof Error ? err.message : String(err)}`,
    });
    // Template fallback: each move gets a generic sentence with
    // its SAN. Same as buildFallbackTreeFromDb logic.
    narration = {
      intro: `${entry.canonicalName} — book moves from the Lichess opening database. Quick walkthrough of the canonical line.`,
      outro: `That's the canonical book line for the ${entry.canonicalName}. Drill the moves to lock them in, or ask for a deeper variation.`,
      ideas: positions.map((p) => ({ text: synthesizeIdeaFromSan(p.san, p.movedBy, p.ply) })),
    };
  }

  // 3. Build the tree from the bottom up using the LLM's ideas.
  //    Branches (if any) become the children of the spine's LAST
  //    node, so when the user reaches the end of the canonical line
  //    they see fork tiles for each named extension. Tapping a tile
  //    fires the deep-dive flow that resolves the canonical name and
  //    starts a fresh focused walkthrough.
  type ChildWrap = { node: WalkthroughTreeNode; label?: string; forkSubtitle?: string };
  const SQUARE_RE = /^[a-h][1-8]$/;
  const branchChildren: ChildWrap[] = branches.map((b, idx) => {
    // The branch's first move belongs to the side whose turn it is
    // after the canonical's last ply. Position[i].ply = i, so after
    // the last spine move the next ply is positions.length (odd =
    // Black moved last → White to move; even = White moved last →
    // Black to move).
    const branchMovedBy: 'white' | 'black' =
      positions.length % 2 === 0 ? 'white' : 'black';
    const teaser =
      narration.branchIdeas?.[idx]?.trim() ||
      `${b.san} — ${b.label} (${b.count} sub-line${b.count === 1 ? '' : 's'} in the database).`;
    // Walk extension moves bottom-up to build the branch's chain.
    // Each extension ply gets its own node. User: "ALL lines extend
    // to here [middlegame]." Without these extensions every branch
    // dropped off at the moment the variation gets named — no plan,
    // no middlegame transition.
    const extIdeas = narration.branchExtensionIdeas?.[idx] ?? [];
    let extChildren: ChildWrap[] = [];
    for (let j = b.extensionMoves.length - 1; j >= 0; j -= 1) {
      const extSan = b.extensionMoves[j];
      // Branch ply 0 is the branch's first move (b.san), so the
      // extension's first move is ply 1 from the branch's perspective.
      // From the spine's perspective the extension's j-th ply is at
      // ply positions.length + 1 + j. Whose turn is determined by
      // that absolute ply count's parity.
      const absolutePly = positions.length + 1 + j;
      const extMovedBy: 'white' | 'black' =
        absolutePly % 2 === 0 ? 'black' : 'white';
      const ideaEntry = extIdeas[j];
      const text =
        (typeof ideaEntry === 'object' && ideaEntry?.text?.trim()) ||
        synthesizeIdeaFromSan(extSan, extMovedBy, absolutePly - 1);
      const rawArrows =
        typeof ideaEntry === 'object' && Array.isArray(ideaEntry?.arrows)
          ? ideaEntry.arrows
          : [];
      const arrows = rawArrows.filter(
        (a) => SQUARE_RE.test(a.from) && SQUARE_RE.test(a.to) && a.from !== a.to,
      );
      const node: WalkthroughTreeNode = {
        san: extSan,
        movedBy: extMovedBy,
        idea: text,
        children: extChildren,
      };
      if (arrows.length > 0) node.narration = [{ text, arrows }];
      extChildren = [{ node }];
    }
    return {
      label: b.label,
      forkSubtitle: teaser,
      node: {
        san: b.san,
        movedBy: branchMovedBy,
        idea: teaser,
        children: extChildren,
      },
    };
  });
  let nextChildren: ChildWrap[] = branchChildren;
  for (let i = positions.length - 1; i >= 0; i -= 1) {
    const p = positions[i];
    const ideaEntry = narration.ideas[i];
    const text =
      (typeof ideaEntry === 'object' && ideaEntry?.text?.trim()) ||
      // Tolerate legacy string-shaped entries (older cached gens
      // pre-arrows extension might still produce them).
      (typeof ideaEntry === 'string' ? (ideaEntry as string).trim() : '') ||
      synthesizeIdeaFromSan(p.san, p.movedBy, p.ply);
    const rawArrows =
      typeof ideaEntry === 'object' && Array.isArray(ideaEntry?.arrows)
        ? ideaEntry.arrows
        : [];
    // Drop arrows with non-algebraic squares or from===to no-ops.
    // The downstream repairNarrationArrows pass would clean these
    // up too, but doing it here keeps the tree tight at build time.
    const arrows = rawArrows.filter(
      (a) => SQUARE_RE.test(a.from) && SQUARE_RE.test(a.to) && a.from !== a.to,
    );
    const node: WalkthroughTreeNode = {
      san: p.san,
      movedBy: p.movedBy,
      idea: text,
      children: nextChildren,
    };
    if (arrows.length > 0) {
      node.narration = [{ text, arrows }];
    }
    nextChildren = [{ node }];
  }
  // In Face mode, surface the canonical counter's name with a
  // "Facing: <original>" prefix so the UI shows what the student is
  // learning to play AGAINST. Cache key prefixing handled by the
  // caller in CoachTeachPage (existing Face: prefix logic).
  const displayName = faceContext
    ? `${entry.canonicalName} (facing ${faceContext.originalDisplayName})`
    : entry.canonicalName;
  return {
    openingName: displayName,
    eco: entry.eco,
    studentSide,
    intro: narration.intro?.trim() || `${displayName} — let's walk through the main line.`,
    outro: narration.outro?.trim() || `Drill the moves to lock them in.`,
    root: { san: null, movedBy: null, idea: '', children: nextChildren },
  };
}

/** DB-only fallback walkthrough builder. When both LLM gen attempts
 *  fail (parse errors, validation failures, etc.), we DON'T fail the
 *  user-facing experience. We synthesize a minimal linear walkthrough
 *  from the Lichess DB's canonical PGN with template-based narration.
 *  The user still gets a lesson — basic, but functional — and they
 *  can /clearcache later to retry the LLM gen.
 *
 *  The fallback tree is marked with fallbackOnly=true (extension on
 *  WalkthroughTree's optional metadata) so the UI can surface a
 *  "regenerate full lesson" prompt later. Cache stores it like a
 *  normal tree so subsequent loads are instant. */
function buildFallbackTreeFromDb(
  name: string,
): WalkthroughTree | null {
  const entry = resolveOpeningEntry(name);
  if (!entry || entry.moves.length === 0) return null;
  // Replay the PGN to validate moves before building. If the DB
  // entry's PGN is malformed (extremely rare — the DB is curated),
  // bail out and let the caller fall through.
  const c = new Chess();
  for (const san of entry.moves) {
    try {
      c.move(stripSanAnnotations(san));
    } catch {
      return null;
    }
  }
  const studentSide = inferStudentSideFromName(entry.canonicalName);
  // Build a chain of nodes from leaf back to root. Each node carries
  // a template idea referencing the SAN — short but readable, far
  // better than "e4" alone.
  type ChildWrap = { node: WalkthroughTreeNode };
  let nextChildren: ChildWrap[] = [];
  for (let i = entry.moves.length - 1; i >= 0; i -= 1) {
    const san = entry.moves[i];
    const movedBy: 'white' | 'black' = i % 2 === 0 ? 'white' : 'black';
    const idea = synthesizeIdeaFromSan(san, movedBy, i);
    const node: WalkthroughTreeNode = {
      san,
      movedBy,
      idea,
      children: nextChildren,
    };
    nextChildren = [{ node }];
  }
  const tree: WalkthroughTree = {
    openingName: entry.canonicalName,
    eco: entry.eco,
    studentSide,
    intro: `${entry.canonicalName} — book moves from the Lichess opening database. This is a quick walkthrough of the canonical line; full coach commentary will load on the next session.`,
    outro: `That's the canonical book line for the ${entry.canonicalName}. Drill the moves to lock them in, or ask for a deeper variation.`,
    root: {
      san: null,
      movedBy: null,
      idea: '',
      children: nextChildren,
    },
  };
  return tree;
}

/** Same logic as inferStudentSide in src/data/openingWalkthroughs/index.ts
 *  but local so this module doesn't import from a sibling. */
function inferStudentSideFromName(name: string): 'white' | 'black' {
  const lower = name.toLowerCase();
  if (/\bdefen[cs]e\b/.test(lower)) return 'black';
  const blackKeywords = [
    'sicilian', 'french', 'caro-kann', 'caro kann', 'pirc',
    'modern', 'alekhine', 'scandinavian', 'scandi',
    "king's indian", 'kings indian', "queen's indian", 'queens indian',
    'nimzo', 'grunfeld', 'grünfeld', 'benoni', 'benko',
    'dutch', 'philidor', 'petroff', 'petrov', 'slav',
  ];
  for (const kw of blackKeywords) if (lower.includes(kw)) return 'black';
  return 'white';
}

/** Build a short idea sentence for a SAN at the given ply index.
 *  Keeps the spoken narration meaningful even without LLM gen. */
function synthesizeIdeaFromSan(
  san: string,
  movedBy: 'white' | 'black',
  plyIndex: number,
): string {
  const moveNumber = Math.floor(plyIndex / 2) + 1;
  const prefix = movedBy === 'white' ? `${moveNumber}.${san}` : `${moveNumber}…${san}`;
  const piece = san[0];
  if (san === 'O-O' || san === '0-0') {
    return `${prefix} — ${movedBy === 'white' ? 'White' : 'Black'} castles kingside, tucking the king behind the wall and connecting the rooks.`;
  }
  if (san === 'O-O-O' || san === '0-0-0') {
    return `${prefix} — ${movedBy === 'white' ? 'White' : 'Black'} castles queenside, an aggressive choice that activates the rook on the d-file.`;
  }
  if (piece === 'N') return `${prefix} — knight develops toward the center; standard opening principle.`;
  if (piece === 'B') return `${prefix} — bishop activates and eyes the long diagonal; supports the central squares.`;
  if (piece === 'R') return `${prefix} — rook lifts to a more active square, often preparing a file battle.`;
  if (piece === 'Q') return `${prefix} — queen joins the action; mind the early development principles.`;
  if (piece === 'K') return `${prefix} — king step; usually a sign castling has happened or the position is in a late-opening transition.`;
  // Pawn move (lowercase first char).
  return `${prefix} — pawn move shaping the center and clearing lines for the pieces behind.`;
}

export async function generateOpening(
  name: string,
  options?: GenerateOpeningOptions,
): Promise<GenerationResult> {
  const mode = options?.mode ?? 'learn';
  const pace = options?.pace ?? 'full';
  void logAppAudit({
    kind: 'coach-surface-migrated',
    category: 'subsystem',
    source: 'openingGenerator.generateOpening',
    summary: `generation requested for "${name}" (mode=${mode}, pace=${pace})`,
  });

  // PRIMARY PATH: trust the Lichess DB as the source of truth. Code
  // builds the tree skeleton (legal moves from DB, FENs from chess.js
  // replay); the LLM only writes per-move narration text. User's
  // word: "Have the LLM trust the structure. It is the source of
  // truth. Sounds like the LLM is trying to verify the structure
  // before running narration. It shouldn't have to do that if the
  // brain is pulling straight from the DB."
  //
  // FACE mode — the student is learning the counter to the named
  // opening, not the opening itself. We resolve the canonical
  // counter from the Lichess DB (the most-popular sibling
  // extension is by definition the main-line counter — for Sicilian
  // Dragon it's the Yugoslav Attack at Be3, for Najdorf it's the
  // Bg5 Main Line, etc) and run THAT through the same DB-narration
  // pipeline as learn mode. studentSide gets flipped automatically
  // (see faceContext handling inside generateOpeningFromDbNarration).
  // User: "I want that narration fix built!" — applies the same
  // architectural inversion that fixed learn mode.
  if (mode === 'face') {
    try {
      const original = resolveOpeningEntry(name);
      if (original) {
        const shortPgn =
          findShortestCanonicalPgn(original.canonicalName) ??
          original.moves.join(' ');
        const counters = findSiblingExtensionBranches(
          original.canonicalName,
          shortPgn,
        );
        if (counters.length > 0) {
          // counters[] is sorted by popularity descending; the first
          // is the main-line counter.
          const counter = counters[0];
          const fromDb = await generateOpeningFromDbNarration(
            counter.fullName,
            pace,
            { originalDisplayName: original.canonicalName },
          );
          if (fromDb) {
            void logAppAudit({
              kind: 'coach-surface-migrated',
              category: 'subsystem',
              source: 'openingGenerator.generateOpening',
              summary: `face mode resolved "${name}" → counter "${counter.fullName}" via DB-narration`,
            });
            return { ok: true, tree: fromDb };
          }
        } else {
          void logAppAudit({
            kind: 'coach-surface-migrated',
            category: 'subsystem',
            source: 'openingGenerator.generateOpening',
            summary: `face mode found no DB counter for "${name}" — falling back to legacy free-form gen`,
          });
        }
      }
    } catch (err) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOpening',
        summary: `face DB-narration path threw for "${name}" — falling back: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (mode === 'learn') {
    try {
      const fromDb = await generateOpeningFromDbNarration(name, pace);
      if (fromDb) {
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'openingGenerator.generateOpening',
          summary: `generation OK via DB-narration path for "${name}"`,
        });
        return { ok: true, tree: fromDb };
      }
    } catch (err) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOpening',
        summary: `DB-narration path threw for "${name}" — falling back to free-form gen: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const first = await generateOnce(name, undefined, mode);
  if (first.ok) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOpening',
      summary: `generation OK on first try for "${name}"`,
    });
    return first;
  }

  // One retry with the failure context. Cheap insurance; LLM often
  // recovers when shown its own validation errors.
  const second = await generateOnce(name, first.issues ?? first.reason, mode);
  if (second.ok) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOpening',
      summary: `generation OK on retry for "${name}"`,
    });
    return second;
  }

  void logAppAudit({
    kind: 'llm-error',
    category: 'subsystem',
    source: 'openingGenerator.generateOpening',
    summary: `generation failed both attempts for "${name}"`,
    // The per-attempt logAppAudit calls inside generateOnce already
    // captured the raw response / tree shape / full issue list. This
    // top-level summary just chains the attempt summaries so the trail
    // is readable end-to-end without joining audit entries by hand.
    details:
      `first attempt reason: ${first.reason}\n` +
      `first attempt issues: ${(first.issues ?? '<none>').slice(0, 1000)}\n` +
      `second attempt reason: ${second.reason}\n` +
      `second attempt issues: ${(second.issues ?? '<none>').slice(0, 1000)}`,
  });

  // DB-only fallback: when both LLM attempts fail, synthesize a basic
  // linear walkthrough from the Lichess DB's canonical PGN. The user
  // still gets a usable lesson — short narration templates are far
  // better than a blank screen and an error toast. Production audit
  // (build 421fa8f): "THIS IS GETTING OLD" — Najdorf failed both
  // attempts AGAIN. Stop punishing the user for LLM flakiness on
  // niche openings.
  const fallbackTree = buildFallbackTreeFromDb(name);
  if (fallbackTree) {
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.generateOpening',
      summary: `LLM gen failed twice for "${name}" — shipped DB-only fallback walkthrough (${fallbackTree.root.children.length > 0 ? 'has root child' : 'no root child'})`,
    });
    return { ok: true, tree: fallbackTree };
  }
  return second;
}

// ───────────────────────────────────────────────────────────────────
// BACKGROUND STAGE GENERATION
// ───────────────────────────────────────────────────────────────────
// User asked: "Can it generate the next level of teaching in
// background while user is doing the walkthrough?" Yes — and it
// solves three problems at once:
//   1. Reliability: 4 focused LLM calls (one per stage) instead of
//      one giant call. Each is small enough to validate strictly.
//   2. Hidden latency: the walkthrough takes 2-5 minutes; the
//      stages generate in parallel during that window.
//   3. Validation time: each stage gets focused validation, not a
//      compromise across 5 sections at once.
//
// Flow:
//   1. Main gen produces the walkthrough tree (blocking, ~30-60s).
//   2. Walkthrough starts; user engages.
//   3. generateMissingStagesInBackground fires the 4 focused calls
//      in parallel, fire-and-forget.
//   4. As each stage validates, it merges into the cached tree
//      (Dexie put with the new stage).
//   5. Stage menu re-reads the cache when entered → shows whatever
//      stages have completed.

/** The four optional stages the LLM can generate in focused calls. */
type OptionalStage = 'concepts' | 'findMove' | 'drill' | 'punish';

/** Per-stage system prompt — focused on ONE stage at a time so the
 *  LLM has plenty of token budget to generate quality content. */
/** Compute the FEN at the end of an opening's canonical PGN. Lets
 *  the stage prompt anchor the LLM at the actual position where
 *  punish setupMoves typically branch from, so it stops inventing
 *  illegal moves like "Bxf7+" when the bishop isn't on a diagonal
 *  to f7. Returns null if the PGN can't be replayed (the validator
 *  will catch it later anyway). */
function computeEndOfBookFen(openingName?: string): string | null {
  if (!openingName) return null;
  const entry = resolveOpeningEntry(openingName);
  if (!entry || entry.moves.length === 0) return null;
  try {
    const c = new Chess();
    for (const san of entry.moves) c.move(stripSanAnnotations(san));
    return c.fen();
  } catch {
    return null;
  }
}

function buildStagePositionBlock(openingName?: string): string {
  const entry = openingName ? resolveOpeningEntry(openingName) : null;
  if (!entry || entry.moves.length === 0) return '';
  const endFen = computeEndOfBookFen(openingName);
  if (!endFen) return '';
  // Trim PGN to a readable form for the prompt.
  const pgn = entry.moves.join(' ');
  return `

OPENING POSITION CONTEXT:
- Canonical name: ${entry.canonicalName}
- ECO: ${entry.eco}
- Moves to reach the end-of-book position: ${pgn}
- FEN at the end of those moves: ${endFen}

Use this position as your anchor. Stage entries' setup paths (findMove.path, drill.moves prefixes, punish.setupMoves) typically branch from this position or earlier in the line. Verify each SAN against the actual piece placement at the relevant FEN before emitting it.`;
}

function buildStageSystemPrompt(stage: OptionalStage, openingName?: string): string {
  const schemas: Record<OptionalStage, string> = {
    concepts: `Output a JSON array of ConceptCheckQuestion objects:
interface ConceptCheckQuestion {
  prompt: string;            // Big-idea question, e.g. "Why does the Vienna play 2.Nc3 instead of 2.Nf3?"
  multiSelect?: boolean;     // true if multiple choices are correct
  choices: { text: string; correct: boolean; explanation: string }[];
}
Aim for 3-5 questions. Test the IDEA behind the opening, not memorization. Mix single-select and multi-select. Multi-select questions need 2+ correct choices.`,

    findMove: `Output a JSON array of FindMoveQuestion objects:
interface FindMoveQuestion {
  path: string[];            // SAN sequence from the standard start position to the position being quizzed
  prompt: string;            // Question, e.g. "White to play. What's the move?"
  candidates: { san: string; label: string; correct: boolean; explanation: string }[];
}
Aim for 3-5 puzzles. Each candidate's SAN must be LEGAL from the path's resulting FEN. Exactly one candidate is correct. Each label is a brief intent ("Bc4 — eyes f7"). Test recognition at branch points and key moments of the opening.`,

    drill: `Output a JSON array of DrillLine objects:
interface DrillLine {
  name: string;              // Display name
  subtitle?: string;
  moves: string[];           // Full SAN sequence from the standard start
  studentSide?: 'white' | 'black';  // Defaults to 'white'
}
Aim for 3-5 lines. Each is a full opening line through to a clear middlegame transition (~10-15 plies). All SANs must be legal sequences from the starting position. studentSide should match the opening (white for openings; black for defenses like Sicilian/French/Caro-Kann/Pirc).`,

    punish: `Output a JSON array of PunishLesson objects:
interface PunishLesson {
  name: string;              // Display name
  setupMoves: string[];      // SAN sequence to the position BEFORE the inaccuracy
  inaccuracy: string;        // Opponent's bad move (SAN, legal from setup position)
  whyBad: string;            // 2-3 sentences explaining the principle violated
  punishment: string;        // The student's punishing move (SAN, legal from post-inaccuracy)
  whyPunish: string;         // 2-3 sentences explaining why it works
  distractors: { san: string; label: string; explanation: string }[];  // 2-3 LEGAL alternatives that don't punish
  followup?: { san: string; idea: string }[];  // Optional winning continuation
}
Aim for 3-5 lessons. Each setupMoves+inaccuracy+punishment+distractors must be LEGAL chess from the start position. Teach common amateur mistakes the student will face in real games.`,
  };

  return `You are an expert chess coach generating ONE specific stage of an opening lesson. Output is RAW JSON — no markdown fences, no prose, no comments, no trailing commas. The first character must be \`[\` and the last must be \`]\`.

Schema:
${schemas[stage]}

CRITICAL:
- All chess moves must be LEGAL from their parent positions. The validation harness will reject illegal SANs.
- DO NOT include PGN annotation marks (!, ?, !!, ??, !?, ?!) in any SAN string. Use "g4" not "g4?", "Nf6" not "Nf6??". Production audit caught the LLM doing this for punish.inaccuracy and the bare \`?\` made chess.js reject the move.
- DO NOT prefix SANs with move numbers ("1.", "1...", etc.). Just the move: "e4", not "1.e4".
- LEGAL-MOVE TRAPS (production audit caught these — DO NOT repeat):
  • FIANCHETTO PREP: Bg7 / Bg2 / Bb7 / Bb2 require the pawn move FIRST (g6 / g3 / b6 / b3). The bishop's destination square must be EMPTY. Pirc move-order is ...d6, ...Nf6, ...g6, THEN ...Bg7.
  • QUEENSIDE CASTLING (O-O-O): the b1 / b8 knight must be DEVELOPED. Castling cannot pass through a piece. If Nb1 is still on its starting square, you cannot O-O-O.
  • KINGSIDE CASTLING (O-O): both the f1 bishop AND the g1 knight (or f8 / g8 for Black) must be developed.
  • Pawns move FORWARD only. e4-to-e3 is illegal.
- Coach voice: first-person, conversational, pedagogically clear.
${stage === 'concepts' ? `- Single-select questions (multiSelect omitted or false) need EXACTLY ONE correct choice. If 2+ choices are correct, set multiSelect: true on that question.\n` : ''}${stage === 'findMove' ? `- Each question needs 2+ candidates. EXACTLY ONE is correct. The path SANs must be a legal sequence from the standard starting position.\n` : ''}${stage === 'drill' ? `- Trace the FULL move sequence with chess.js mentally before emitting. Each move must be legal from the position the prior moves create. studentSide MUST match the opening — black for Sicilian, French, Caro-Kann, Pirc, KID, Nimzo-Indian, Modern, Alekhine, Scandinavian, etc.; white for Italian, Vienna, Spanish, Queen's Gambit, etc.\n` : ''}${stage === 'punish' ? `- setupMoves + inaccuracy + punishment + each distractor + each followup move must ALL be legal in sequence. Distractors are LEGAL alternatives that don't punish as well — they are NOT illegal moves. Each lesson needs at least 2 distractors.
- CRITICAL — STAY ON THE OPENING: setupMoves MUST match the canonical PGN of "${openingName}" exactly for the first N plies (where N = the canonical PGN's ply count). Production audit (build 1304700) caught the LLM emitting Dragon punishes (5...g6) under the Najdorf banner (5...a6) — same family but a different sub-variation. The OPENING POSITION CONTEXT block below shows the exact moves; do NOT substitute a different sub-line just because you find traps there easier to write.
- The inaccuracy is what the OPPONENT plays AFTER the canonical line is reached. setupMoves usually ends RIGHT AT the canonical spine's end FEN (or at most 1-2 plies deeper on a known main-line continuation).
\n` : ''}- Output JSON only. Validation pipeline rejects anything else.${buildBookSourceBlock(openingName)}${buildStagePositionBlock(openingName)}`;
}

// ─── DB-narration stage generators ──────────────────────────────────
// Mirror of the walkthrough's DB-narration inversion: code provides
// the move sequences (legal by DB construction) and chess.js confirms
// FENs; the LLM only writes labels and short prose. Eliminates the
// "illegal SAN" repair class for `drill` and `findMove` stages
// entirely. `concepts` is already prose-only (no moves to invert) and
// `punish` is tactical (its moves are by definition NOT in the DB),
// so neither gets a DB path here.
//
// The fallback is the existing free-form LLM stage gen if a DB path
// can't produce enough entries (e.g. a niche opening with no sibling
// extensions). All audit logs tag which path produced the stage.

const DRILL_LABEL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'subtitle'],
        properties: {
          name: { type: 'string' },
          subtitle: { type: 'string' },
        },
      },
    },
  },
};

interface DrillLabelOutput {
  lines: { name: string; subtitle: string }[];
}

const FIND_MOVE_LABEL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prompt', 'candidates'],
        properties: {
          prompt: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'explanation'],
              properties: {
                label: { type: 'string' },
                explanation: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

interface FindMoveLabelOutput {
  questions: {
    prompt: string;
    candidates: { label: string; explanation: string }[];
  }[];
}

/** Generate `drill` stage entries by pulling top sibling sub-variations
 *  from the Lichess DB (with their middlegame extensions) and asking
 *  the LLM ONLY for a display name + subtitle per line. Eliminates
 *  every "illegal SAN" failure mode for this stage. Returns null when
 *  the DB doesn't have enough sub-variations to populate a useful set
 *  — the caller falls back to the free-form LLM gen path. */
async function generateDrillFromDb(
  openingName: string,
): Promise<DrillLine[] | null> {
  const entry = resolveOpeningEntry(openingName);
  if (!entry || entry.moves.length === 0) return null;
  const shortPgn = findShortestCanonicalPgn(entry.canonicalName);
  const spineMoves = shortPgn ? shortPgn.split(/\s+/).filter(Boolean) : entry.moves;
  const branches = findSiblingExtensionBranches(
    entry.canonicalName,
    spineMoves.join(' '),
  );
  if (branches.length === 0) return null;
  const studentSide = inferStudentSideFromName(entry.canonicalName);
  const picked = branches.slice(0, 5);
  // Build the line skeletons from the DB (legal by construction).
  const lines = picked.map((b) => ({
    branchSan: b.san,
    branchLabel: b.label,
    moves: [...spineMoves, b.san, ...b.extensionMoves],
  }));

  const systemPrompt = `You are an expert chess coach labelling drill lines. For EACH line below, output:
- name: 4-8 words. Lead with the canonical sub-variation name (e.g. "English Attack — Najdorf Sicilian").
- subtitle: 3-7 words capturing the strategic flavor (e.g. "Sharp kingside pawn-storm" or "Quiet positional setup").

The move sequences come from the Lichess opening database — DO NOT alter them, do NOT repeat them in the labels. Output ONLY via the tool.`;

  const userPrompt = `Opening: ${entry.canonicalName} (${entry.eco})
Student plays: ${studentSide}

Lines (in order — emit one { name, subtitle } per line):
${lines
  .map(
    (l, i) =>
      `${i + 1}. "${l.branchLabel}" — entry move ${l.branchSan}; full sequence: ${l.moves.join(' ')}`,
  )
  .join('\n')}

Emit a JSON object: { lines: [ ${lines.length} entries, in the same order ] }.`;

  let labels: DrillLabelOutput;
  try {
    const result = await getCoachStructuredResponse(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      'chat_response',
      1024,
      'emit_drill_labels',
      'Emit display labels for opening drill lines.',
      DRILL_LABEL_SCHEMA,
    );
    labels = result as DrillLabelOutput;
  } catch (err) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateDrillFromDb',
      summary: `drill-label LLM call failed for "${openingName}" — using template names: ${err instanceof Error ? err.message : String(err)}`,
    });
    labels = {
      lines: lines.map((l) => ({
        name: `${entry.canonicalName} — ${l.branchLabel}`,
        subtitle: l.branchLabel,
      })),
    };
  }

  return lines.map((l, i) => {
    const lab = labels.lines?.[i];
    return {
      name: (lab?.name?.trim()) || `${entry.canonicalName} — ${l.branchLabel}`,
      subtitle: (lab?.subtitle?.trim()) || l.branchLabel,
      moves: l.moves,
      studentSide,
    };
  });
}

/** Generate `findMove` stage entries by walking the canonical spine
 *  and picking branchpoints — positions where multiple DB-named
 *  openings diverge. The "correct" candidate is the canonical SAN
 *  (the move that keeps the student in their named opening); the
 *  distractors are sibling SANs that lead to DIFFERENT named
 *  openings. The LLM only writes the prompt + per-candidate label
 *  and explanation. No SANs are LLM-emitted, eliminating the legal-
 *  move bug class for this stage. */
async function generateFindMoveFromDb(
  openingName: string,
): Promise<FindMoveQuestion[] | null> {
  const entry = resolveOpeningEntry(openingName);
  if (!entry || entry.moves.length === 0) return null;
  const shortPgn = findShortestCanonicalPgn(entry.canonicalName);
  const spineMoves = shortPgn
    ? shortPgn.split(/\s+/).filter(Boolean)
    : entry.moves;
  const studentSide = inferStudentSideFromName(entry.canonicalName);

  // Walk the spine. At each ply where the studentSide moves, query
  // the DB for sibling SANs at that ply. If 2+, it's a branchpoint.
  type Branchpoint = {
    pathBeforeMove: string[];
    correctSan: string;
    distractors: { san: string; openingName: string; eco: string }[];
    movedBy: 'white' | 'black';
    plyIndex: number;
  };
  const branchpoints: Branchpoint[] = [];
  for (let i = 0; i < spineMoves.length; i += 1) {
    const movedBy: 'white' | 'black' = i % 2 === 0 ? 'white' : 'black';
    if (movedBy !== studentSide) continue;
    const prefix = spineMoves.slice(0, i);
    const continuations = findContinuationsAtPly(prefix);
    if (continuations.size < 2) continue;
    const correctSan = spineMoves[i];
    if (!continuations.has(correctSan)) continue; // safety
    const distractors: Branchpoint['distractors'] = [];
    for (const [san, info] of continuations) {
      if (san === correctSan) continue;
      distractors.push({ san, openingName: info.name, eco: info.eco });
    }
    if (distractors.length === 0) continue;
    // Cap at 3 distractors. Prefer ones whose representative opening
    // has the SHORTEST name (the bare-line entries — Sicilian, French,
    // etc. — make cleaner distractors than deep sub-variations).
    distractors.sort((a, b) => a.openingName.length - b.openingName.length);
    branchpoints.push({
      pathBeforeMove: prefix,
      correctSan,
      distractors: distractors.slice(0, 3),
      movedBy,
      plyIndex: i,
    });
  }
  if (branchpoints.length === 0) return null;
  // Cap at 5 branchpoints. Prefer the ones DEEPEST in the spine
  // (later plies — those are the more specific decisions of the
  // named opening, the ones the student actually needs to memorize).
  branchpoints.sort((a, b) => b.plyIndex - a.plyIndex);
  const picked = branchpoints.slice(0, 5).reverse(); // re-order earliest-first for narrative flow

  const systemPrompt = `You are an expert chess coach writing find-the-move puzzles. For each branchpoint below, output:
- prompt: ONE sentence framing the question. Mention whose turn and the strategic context. Examples:
  • "Black has just played 4...Nc6. What's White's signature move to enter the Italian?"
  • "After 1.e4 c5 2.Nf3, what does Black play to set up a Najdorf-style structure?"
- candidates: for EACH candidate (in the SAME ORDER as given), write:
    label: 2-6 words tagging the move's idea ("eyes f7", "claims the center", "entering the Spanish")
    explanation: ONE sentence explaining why it's right or what other opening it heads into.

The SANs and the correct answer are GIVEN — DO NOT alter them, do NOT add candidates, do NOT change the order. Just label + explain. Output ONLY via the tool.`;

  const userPrompt = `Opening: ${entry.canonicalName} (${entry.eco})
Student plays: ${studentSide}

Branchpoints (emit one question per branchpoint, in order):
${picked
  .map((bp, i) => {
    const moveNum = Math.floor(bp.plyIndex / 2) + 1;
    const dotted = bp.movedBy === 'white' ? `${moveNum}.` : `${moveNum}…`;
    const path = bp.pathBeforeMove.length > 0
      ? bp.pathBeforeMove.join(' ')
      : '(starting position)';
    const candidatesList = [
      { san: bp.correctSan, isCorrect: true, opening: entry.canonicalName },
      ...bp.distractors.map((d) => ({
        san: d.san,
        isCorrect: false,
        opening: d.openingName,
      })),
    ];
    return `${i + 1}. After ${path} — ${bp.movedBy} to move ${dotted}? Candidates (in order):
${candidatesList.map((c, j) => `   ${String.fromCharCode(97 + j)}) ${c.san} → ${c.opening}${c.isCorrect ? ' [CORRECT]' : ''}`).join('\n')}`;
  })
  .join('\n\n')}

Emit a JSON object: { questions: [ ${picked.length} entries, in the same order, each with prompt + candidates labels in the same order as listed above ] }.`;

  let labels: FindMoveLabelOutput;
  try {
    const result = await getCoachStructuredResponse(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      'chat_response',
      2048,
      'emit_findmove_labels',
      'Emit prompt + candidate labels for find-the-move puzzles.',
      FIND_MOVE_LABEL_SCHEMA,
    );
    labels = result as FindMoveLabelOutput;
  } catch (err) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateFindMoveFromDb',
      summary: `findMove-label LLM call failed for "${openingName}" — using template labels: ${err instanceof Error ? err.message : String(err)}`,
    });
    labels = {
      questions: picked.map(() => ({
        prompt: '',
        candidates: [],
      })),
    };
  }

  // Map back to FindMoveQuestion[].
  return picked.map((bp, i) => {
    const moveNum = Math.floor(bp.plyIndex / 2) + 1;
    const dotted = bp.movedBy === 'white' ? `${moveNum}.` : `${moveNum}…`;
    const labelEntry = labels.questions?.[i];
    const fallbackPrompt = `${bp.movedBy === 'white' ? 'White' : 'Black'} to play ${dotted} What's the move?`;
    const candidates = [
      {
        san: bp.correctSan,
        label: labelEntry?.candidates?.[0]?.label?.trim() || `${bp.correctSan} — ${entry.canonicalName}`,
        correct: true,
        explanation:
          labelEntry?.candidates?.[0]?.explanation?.trim() ||
          `${bp.correctSan} is the canonical move into the ${entry.canonicalName}.`,
      },
      ...bp.distractors.map((d, j) => ({
        san: d.san,
        label:
          labelEntry?.candidates?.[j + 1]?.label?.trim() ||
          `${d.san} — ${d.openingName}`,
        correct: false,
        explanation:
          labelEntry?.candidates?.[j + 1]?.explanation?.trim() ||
          `${d.san} heads into the ${d.openingName} instead — a different opening.`,
      })),
    ];
    return {
      path: bp.pathBeforeMove,
      prompt: labelEntry?.prompt?.trim() || fallbackPrompt,
      candidates,
    };
  });
}

// ─── Punish-stage DB inversion ──────────────────────────────────────
// Pulls real opening-tagged tactical puzzles from the Lichess puzzle
// database (`src/data/puzzles.json`, 15K curated entries) and turns
// them into PunishLesson objects. Code provides every move (the
// puzzle's UCI sequence converted to SAN) and every distractor
// (chess.js legal moves at the post-inaccuracy FEN, scored to prefer
// captures/checks/developing moves so they look tempting). The LLM
// only writes:
//   - lesson `name` (4-8 words tying it to the opening + the tactic)
//   - `whyBad` (2 sentences on the opponent's mistake — the SETUP)
//   - `whyPunish` (2 sentences on why the tactic works — the IDEA)
//   - per-distractor `label` + `explanation`
//   - per-followup `idea`
//
// David's principle: "the DB is the brain." Punish lessons are
// grounded in real master-game puzzles tagged with the opening, with
// the puzzle's themes (mate, fork, sacrifice, hangingPiece) telling
// the LLM what tactical motif it's narrating. The opening's family
// (Italian → Bxf7+ themes; Caro-Kann → tempo/structure punishments)
// shapes the prose framing. No moves are LLM-emitted.

interface RawPuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
  openingTags: string | string[] | null;
  popularity: number;
  nbPlays: number;
}

const PUNISH_PUZZLE_THEMES = new Set([
  'mate', 'mateIn1', 'mateIn2', 'mateIn3',
  'fork', 'pin', 'skewer', 'discoveredAttack',
  'hangingPiece', 'trappedPiece', 'sacrifice',
  'attraction', 'deflection', 'doubleAttack',
  'kingsideAttack', 'queensideAttack', 'attackingF2F7',
  'xRayAttack',
]);

const PUNISH_LABEL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'whyBad', 'whyPunish', 'distractors'],
        properties: {
          name: { type: 'string' },
          whyBad: { type: 'string' },
          whyPunish: { type: 'string' },
          distractors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'explanation'],
              properties: {
                label: { type: 'string' },
                explanation: { type: 'string' },
              },
            },
          },
          followupIdeas: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

interface PunishLabelOutput {
  lessons: {
    name: string;
    whyBad: string;
    whyPunish: string;
    distractors: { label: string; explanation: string }[];
    followupIdeas?: string[];
  }[];
}

/** Tags from the Lichess puzzle DB use underscore-separated names
 *  ("Italian_Game", "Sicilian_Defense_Najdorf_Variation"). Our
 *  canonical names use ":" + spaces. Convert and match generously:
 *  the puzzle tag must equal one of the canonical-derived forms OR
 *  start with one of them + "_" (so a "Najdorf" lesson catches both
 *  the bare Najdorf and any sub-variation like "Najdorf_English_Attack"). */
function puzzleTagsMatchOpening(
  puzzleTags: string[],
  canonicalName: string,
): boolean {
  // Lichess tag normalization: strip apostrophes ("King's" → "Kings",
  // "Bishop's" → "Bishops"), turn ":" + spaces into "_". Spot-checked
  // against the DB: tags use "Bishops_Opening" / "Kings_Gambit"
  // / "Queens_Gambit_Declined" — no apostrophes anywhere.
  const normalize = (s: string): string =>
    s.replace(/['']/g, '').replace(/[: ]+/g, '_');
  const candidates = new Set<string>();
  // Full canonical: "Sicilian Defense: Najdorf Variation"
  candidates.add(normalize(canonicalName));
  // Drop the colon-suffix: "Sicilian Defense" / "Bishop's Opening"
  const colonIdx = canonicalName.indexOf(':');
  if (colonIdx > 0) {
    candidates.add(normalize(canonicalName.slice(0, colonIdx).trim()));
  }
  // For Najdorf/Dragon/etc named after the colon, also try the
  // sub-variation name alone — Lichess sometimes tags only the
  // family ("Sicilian_Defense") without the variation, but we want
  // to match family-tagged puzzles for variation lessons too.
  for (const tag of puzzleTags) {
    for (const cand of candidates) {
      if (tag === cand) return true;
      if (tag.startsWith(cand + '_')) return true;
    }
  }
  return false;
}

function tagsOfPuzzle(p: RawPuzzle): string[] {
  if (!p.openingTags) return [];
  if (Array.isArray(p.openingTags)) return p.openingTags;
  return String(p.openingTags).split(/\s+/).filter(Boolean);
}

/** Convert a UCI move string ("e2e4", "e7e8q") to SAN by playing it
 *  on the given Chess instance. Mutates `chess` (advances the
 *  position). Returns the SAN string, or null if illegal. */
function uciToSan(chess: Chess, uci: string): string | null {
  if (uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  try {
    const move = chess.move({ from, to, promotion });
    return move.san;
  } catch {
    return null;
  }
}

/** Score a candidate distractor SAN at the post-inaccuracy FEN to
 *  pick "tempting but wrong" alternatives. Captures + checks +
 *  developing moves rank high. Edge pawn moves and king shuffles
 *  rank low. The puzzle solution itself is excluded by the caller. */
function scoreDistractor(san: string): number {
  let score = 0;
  if (san.includes('x')) score += 3; // capture
  if (san.includes('+') || san.includes('#')) score += 2; // check
  // Knight or bishop development (uppercase first char, dest is in
  // central or near-central squares).
  if (/^[NB]/.test(san)) {
    const dest = san.match(/[a-h][1-8]/g)?.slice(-1)[0];
    if (dest) {
      const file = dest[0];
      const rank = parseInt(dest[1], 10);
      // d4-e5 / d5-e4 central squares get +2; c-d-e-f files +1;
      // edge files (a/h) get -1.
      if (['d', 'e'].includes(file) && rank >= 3 && rank <= 6) score += 2;
      else if (['c', 'd', 'e', 'f'].includes(file)) score += 1;
      else if (['a', 'h'].includes(file)) score -= 1;
    }
  }
  // King move that isn't castling = bad sign.
  if (/^K[a-h]/.test(san) && !san.startsWith('O-O')) score -= 2;
  // a- or h-file pawn push without capture = unlikely to be tempting.
  if (/^[ah][2-7]$/.test(san)) score -= 2;
  return score;
}

interface PreparedPunishLesson {
  setupFen: string;
  inaccuracy: string;
  punishment: string;
  followup: { san: string }[];
  distractors: { san: string }[];
  themes: string[];
  rating: number;
}

/** Walk one Lichess puzzle into a PunishLesson skeleton.
 *  Returns null when the puzzle's UCI sequence doesn't replay
 *  cleanly or when we can't generate at least 2 distractors. */
function preparePunishFromPuzzle(p: RawPuzzle): PreparedPunishLesson | null {
  const uciMoves = p.moves.split(/\s+/).filter(Boolean);
  if (uciMoves.length < 2) return null; // need at least inaccuracy + punishment
  const chess = new Chess(p.fen);
  // moves[0] = inaccuracy (opponent's bad move from puzzle.fen)
  const inaccuracy = uciToSan(chess, uciMoves[0]);
  if (!inaccuracy) return null;
  const postInaccuracyFen = chess.fen();
  // moves[1] = punishment (student's reply)
  const punishment = uciToSan(chess, uciMoves[1]);
  if (!punishment) return null;
  // moves[2..] = followup
  const followup: { san: string }[] = [];
  for (let i = 2; i < uciMoves.length; i += 1) {
    const san = uciToSan(chess, uciMoves[i]);
    if (!san) break;
    followup.push({ san });
  }
  // Distractors: chess.js legal moves at post-inaccuracy FEN, score
  // and pick top 3 (excluding the punishment itself).
  const probe = new Chess(postInaccuracyFen);
  const legal = probe.moves();
  const candidates = legal
    .filter((san) => san !== punishment)
    .map((san) => ({ san, score: scoreDistractor(san) }))
    .sort((a, b) => b.score - a.score);
  const distractors = candidates.slice(0, 3).map((c) => ({ san: c.san }));
  if (distractors.length < 2) return null; // need at least 2 alternatives
  return {
    setupFen: p.fen,
    inaccuracy,
    punishment,
    followup,
    distractors,
    themes: p.themes,
    rating: p.rating,
  };
}

/** Generate `punish` stage entries by mining the Lichess puzzle DB.
 *  Filters to puzzles tagged with the canonical opening's name
 *  family AND carrying punish-style tactical themes. Each surviving
 *  puzzle becomes a PunishLesson skeleton (positions + moves +
 *  distractors all from data); the LLM only labels the prose. */
async function generatePunishFromDb(
  openingName: string,
): Promise<PunishLesson[] | null> {
  const entry = resolveOpeningEntry(openingName);
  if (!entry || entry.moves.length === 0) return null;

  const puzzles = puzzleData as RawPuzzle[];
  const matching = puzzles.filter((p) => {
    const tags = tagsOfPuzzle(p);
    if (tags.length === 0) return false;
    if (!puzzleTagsMatchOpening(tags, entry.canonicalName)) return false;
    if (!p.themes.some((t) => PUNISH_PUZZLE_THEMES.has(t))) return false;
    if (p.popularity < 70) return false;
    if (p.nbPlays < 80) return false;
    return true;
  });
  if (matching.length === 0) return null;
  // Sort: popularity desc, then rating asc (easier first for teaching).
  matching.sort((a, b) => {
    if (b.popularity !== a.popularity) return b.popularity - a.popularity;
    return a.rating - b.rating;
  });

  // Walk top candidates; keep first 5 that prepare cleanly.
  const prepared: PreparedPunishLesson[] = [];
  for (const p of matching) {
    if (prepared.length >= 5) break;
    const lesson = preparePunishFromPuzzle(p);
    if (lesson) prepared.push(lesson);
  }
  if (prepared.length < 2) return null; // not enough to make a stage

  // Single LLM call: ask for prose labels for all lessons. The LLM
  // sees the SANs, the FENs, the themes, and the opening context; it
  // writes coach prose tying each tactic back to the opening's
  // strategic character.
  const studentSide = inferStudentSideFromName(entry.canonicalName);
  const systemPrompt = `You are an expert chess coach narrating punish lessons rooted in the "${entry.canonicalName}" opening. The student plays ${studentSide}. For each lesson below, output:
- name: 4-8 words tying the lesson to the opening + the tactic. Examples:
  • "Italian: Knight grabs f7 — fork on the queen"
  • "Caro-Kann: Careless Ngf6?? — Nd6 is mate"
  • "Sicilian: Loose d6 invites the bishop sack"
- whyBad: 1-2 sentences on WHY the opponent's move loses. Tie it back to the opening's character (Italian's Bc4-and-Ng5 pressure on f7, Caro-Kann's solid-but-tempo-sensitive structure, Sicilian's tactical density on the queenside, etc.).
- whyPunish: 1-2 sentences on the punishing IDEA — sacrifice for tempo, fork the queen, exploit the loose bishop, etc. Reference the puzzle's themes when natural ("a classic Bxf7+ sac that wins the queen by deflection").
- distractors: for EACH distractor (in the SAME ORDER given), write a short label (2-5 words) and a 1-sentence explanation of why it doesn't work or doesn't punish as well.
- followupIdeas: ONE short sentence per followup move (in order) describing the tactical thread — "rook lifts to win the queen", "the king is dragged into the open", etc.

The SANs and FENs are GIVEN by the puzzle database — DO NOT alter them, do NOT add or reorder distractors, do NOT invent moves. Just write the prose. Output ONLY via the tool.`;

  const lessonsBlock = prepared
    .map((l, i) => {
      const themesLine = l.themes.slice(0, 6).join(', ');
      return `Lesson ${i + 1} (rating ${l.rating}; themes: ${themesLine}):
  setupFen: ${l.setupFen}
  Opponent's mistake (inaccuracy): ${l.inaccuracy}
  Punishing move: ${l.punishment}
  Distractors (in order — write label + explanation for each):
${l.distractors.map((d, j) => `    ${String.fromCharCode(97 + j)}) ${d.san}`).join('\n')}
  Followup moves after the punishment (in order):
${l.followup.length > 0 ? l.followup.map((f, j) => `    ${j + 1}. ${f.san}`).join('\n') : '    (none)'}`;
    })
    .join('\n\n');

  const userPrompt = `Opening: ${entry.canonicalName} (${entry.eco})
Canonical line: ${entry.moves.join(' ')}
Student plays: ${studentSide}

${prepared.length} lessons to label (in order):

${lessonsBlock}

Emit a JSON object: { lessons: [ ${prepared.length} entries, in the same order, each with { name, whyBad, whyPunish, distractors[${prepared.map((l) => l.distractors.length).join('/')}], followupIdeas? } ] }.`;

  let labels: PunishLabelOutput;
  try {
    const result = await getCoachStructuredResponse(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      'chat_response',
      // Each lesson's prose ≈ 80-120 tokens × 5 lessons ≈ 600 tokens
      // plus distractor explanations ≈ 60 tokens × 15 = 900 tokens.
      // 3K cap is generous.
      3072,
      'emit_punish_labels',
      'Emit prose labels for puzzle-derived punish lessons.',
      PUNISH_LABEL_SCHEMA,
    );
    labels = result as PunishLabelOutput;
  } catch (err) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generatePunishFromDb',
      summary: `punish-label LLM call failed for "${openingName}" — using template prose: ${err instanceof Error ? err.message : String(err)}`,
    });
    labels = {
      lessons: prepared.map(() => ({
        name: '',
        whyBad: '',
        whyPunish: '',
        distractors: [],
        followupIdeas: [],
      })),
    };
  }

  return prepared.map((l, i) => {
    const lab = labels.lessons?.[i];
    const themePrimary = l.themes.find((t) => PUNISH_PUZZLE_THEMES.has(t)) ?? 'tactical';
    const fallbackName = `${entry.canonicalName} — ${themePrimary} trap`;
    return {
      name: (lab?.name?.trim()) || fallbackName,
      setupFen: l.setupFen,
      // Keep the canonical PGN as setupMoves for context display
      // (the runtime ignores it when setupFen is set, but stage
      // metadata + canonical-pinning stay coherent).
      setupMoves: entry.moves,
      inaccuracy: l.inaccuracy,
      whyBad: (lab?.whyBad?.trim()) || `${l.inaccuracy} drops the thread of the opening — the position now has a tactical hole.`,
      punishment: l.punishment,
      whyPunish: (lab?.whyPunish?.trim()) || `${l.punishment} exploits the resulting weakness; a classic ${themePrimary} motif.`,
      distractors: l.distractors.map((d, j) => ({
        san: d.san,
        label: (lab?.distractors?.[j]?.label?.trim()) || `${d.san} — alternative`,
        explanation:
          (lab?.distractors?.[j]?.explanation?.trim()) ||
          `${d.san} is legal but doesn't capitalize on the inaccuracy as sharply as ${l.punishment}.`,
      })),
      followup: l.followup.map((f, j) => ({
        san: f.san,
        idea: (lab?.followupIdeas?.[j]?.trim()) || `${f.san} — continues the winning sequence.`,
      })),
    } satisfies PunishLesson;
  });
}

/** Parse a stage array from raw LLM output. Mirrors the recovery
 *  pipeline used for tree parses (parseGeneratedTree): markdown
 *  fences, line comments, trailing commas, then on failure a second
 *  attempt with preprocessForParse (smart quotes, control chars,
 *  unquoted object keys). Production audit (build 9dedf2a): stage
 *  gen was failing silently with the same iOS Safari parse errors
 *  the tree gen had recovery for, but parseStageArray bypassed it. */
function parseStageArray<T>(raw: string): T[] | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket < 0 || lastBracket < firstBracket) return null;
  let jsonText = text.slice(firstBracket, lastBracket + 1);
  jsonText = jsonText.replace(/^\s*\/\/[^\n]*$/gm, '');
  jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
  function tryParse(t: string): T[] | null {
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
      return null;
    }
  }
  const first = tryParse(jsonText);
  if (first !== null) return first;
  const preprocessed = preprocessForParse(jsonText);
  if (preprocessed !== jsonText) {
    const second = tryParse(preprocessed);
    if (second !== null) return second;
  }
  return null;
}

/** Generate one stage's data via a focused LLM call. Optional
 *  retryContext lets the caller wrap with a retry that feeds back
 *  the prior failure (e.g. "0 lessons survived per-entry repair"). */
async function generateOneStage(
  openingName: string,
  stage: OptionalStage,
  retryContext?: string,
): Promise<{ ok: boolean; data?: unknown[]; reason?: string }> {
  // DB-narration path for drill + findMove. Code provides legal
  // moves from the Lichess DB; LLM only labels them. Eliminates
  // the "illegal SAN" repair class for these stages entirely.
  // Skip on retry — if the DB path produced an empty/invalid set
  // the first time, the legacy LLM gen path is the fallback. Other
  // stages (concepts, punish) still go through the prose-only LLM
  // gen below, since concepts has no SANs and punish's tactical
  // moves aren't in the opening DB.
  if (!retryContext && stage === 'drill') {
    try {
      const drillData = await generateDrillFromDb(openingName);
      if (drillData && drillData.length >= 2) {
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'openingGenerator.generateOneStage',
          summary: `drill via DB-narration path for "${openingName}" — ${drillData.length} lines`,
        });
        return { ok: true, data: drillData };
      }
    } catch (err) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOneStage',
        summary: `drill DB path failed for "${openingName}" — falling back to free-form LLM gen`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!retryContext && stage === 'findMove') {
    try {
      const findMoveData = await generateFindMoveFromDb(openingName);
      if (findMoveData && findMoveData.length >= 2) {
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'openingGenerator.generateOneStage',
          summary: `findMove via DB-narration path for "${openingName}" — ${findMoveData.length} questions`,
        });
        return { ok: true, data: findMoveData };
      }
    } catch (err) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOneStage',
        summary: `findMove DB path failed for "${openingName}" — falling back to free-form LLM gen`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!retryContext && stage === 'punish') {
    try {
      const punishData = await generatePunishFromDb(openingName);
      if (punishData && punishData.length >= 2) {
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'openingGenerator.generateOneStage',
          summary: `punish via Lichess-puzzle-DB path for "${openingName}" — ${punishData.length} lessons (real opening-tagged tactical puzzles)`,
        });
        return { ok: true, data: punishData };
      }
    } catch (err) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.generateOneStage',
        summary: `punish DB path failed for "${openingName}" — falling back to free-form LLM gen`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const systemPrompt = buildStageSystemPrompt(stage, openingName);
  const userMessage = retryContext
    ? `Generate the ${stage} array for the opening: ${openingName}.\n\nYour previous attempt failed:\n${retryContext}\n\nProduce a new attempt that addresses the failures above. Keep moves SIMPLE and conservative — verify each SAN is legal from its parent position. Output JSON only.`
    : `Generate the ${stage} array for the opening: ${openingName}.`;
  let raw: string;
  try {
    raw = await getCoachChatResponse(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      undefined,
      'chat_response',
      // 4096 tokens per stage is plenty — focused content fits
      // easily and keeps cost down compared to the full 16K main call.
      4096,
      undefined,
      'anthropic',
    );
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.startsWith('⚠️')) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOneStage',
      summary: `LLM provider error for "${openingName}" / ${stage}${retryContext ? ' (retry)' : ''}`,
      details: raw.slice(0, 500),
    });
    return { ok: false, reason: raw };
  }
  const data = parseStageArray<unknown>(raw);
  if (!data) {
    void logAppAudit({
      kind: 'llm-error',
      category: 'subsystem',
      source: 'openingGenerator.generateOneStage',
      summary: `stage JSON parse failed for "${openingName}" / ${stage}${retryContext ? ' (retry)' : ''}`,
      details: `raw response (first 1500 chars): ${raw.slice(0, 1500)}`,
    });
    return { ok: false, reason: 'failed to parse stage JSON' };
  }
  return { ok: true, data };
}

/** Merge a freshly-generated stage into the cached tree. Atomic via
 *  Dexie's transaction. If another stage's merge happens concurrently,
 *  Dexie serializes them — last write wins on a per-field basis but
 *  since each call writes a DIFFERENT field, no conflict. */
async function mergeStageIntoCache(
  openingName: string,
  stage: OptionalStage,
  data: unknown[],
): Promise<{ merged: boolean; keptCount: number; reason?: string }> {
  try {
    const normalized = normalizeOpeningName(openingName);
    const cached = await db.cachedOpenings.get(normalized);
    if (!cached) return { merged: false, keptCount: 0, reason: 'no cached opening to merge into' };
    // Strip PGN annotation marks from any SAN strings in the stage
    // payload BEFORE validation. Production audit (build 23c484d)
    // caught Pirc punish failing on inaccuracy="g4?" / "Bg5?" /
    // "f4?" — chess.js rejected the bare `?`. Mutating cleans both
    // the validation pass and the cached runtime data.
    normalizeStageSans(stage, data);
    // Per-entry repair: drop bad individual entries instead of
    // failing the whole stage. Production audit (build 23c484d)
    // showed Pirc punish discarded wholesale on 6 errors when really
    // only 2-3 lessons were broken — losing the salvageable ones too.
    let repairedData: unknown[] = data;
    let repairReport: StageRepairReport | null = null;
    if (stage === 'concepts') {
      const r = repairConceptsStage(data as ConceptCheckQuestion[]);
      repairedData = r.kept;
      repairReport = r.report;
    } else if (stage === 'findMove') {
      const r = repairFindMoveStage(data as FindMoveQuestion[]);
      repairedData = r.kept;
      repairReport = r.report;
    } else if (stage === 'drill') {
      const r = repairDrillStage(data as DrillLine[]);
      repairedData = r.kept;
      repairReport = r.report;
    } else if (stage === 'punish') {
      // Pin punish lessons to the canonical opening: drop any whose
      // setupMoves diverge from the canonical PGN prefix. Production
      // audit (build 1304700): the LLM emitted Dragon punish lessons
      // (5...g6) under the Najdorf banner (5...a6) — same family,
      // different sub-variation, traps would never overlap with the
      // walkthrough spine. The stage-gen prompt now warns against
      // this, but we belt-and-suspenders here too in case the LLM
      // drifts anyway.
      const canonicalEntry = resolveOpeningEntry(openingName);
      const canonicalPlies = canonicalEntry?.moves ?? [];
      const onCanonical = (data as PunishLesson[]).filter((lesson) => {
        if (canonicalPlies.length === 0) return true; // can't enforce
        // Puzzle-DB-derived lessons (setupFen present) are already
        // pinned to the opening by the Lichess openingTags filter
        // upstream — no need to enforce setupMoves equality. The
        // setupMoves field on these lessons is the canonical PGN
        // for context display only; the actual board position comes
        // from the puzzle FEN.
        if (lesson.setupFen) return true;
        const setup = lesson.setupMoves ?? [];
        // Setup must be at LEAST canonical-length and start with the
        // canonical prefix verbatim (after stripping annotation marks).
        if (setup.length < canonicalPlies.length) return false;
        for (let k = 0; k < canonicalPlies.length; k += 1) {
          if (
            stripSanAnnotations(setup[k]) !==
            stripSanAnnotations(canonicalPlies[k])
          ) {
            return false;
          }
        }
        return true;
      });
      const droppedOffCanonical = data.length - onCanonical.length;
      const r = repairPunishStage(onCanonical);
      repairedData = r.kept;
      repairReport = r.report;
      if (droppedOffCanonical > 0) {
        repairReport.dropped += droppedOffCanonical;
        repairReport.notes.unshift(
          `punish: dropped ${droppedOffCanonical} lesson(s) whose setupMoves diverged from "${openingName}" canonical PGN`,
        );
      }
    }
    if (repairReport && (repairReport.dropped > 0 || repairReport.fixed > 0)) {
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'openingGenerator.mergeStageIntoCache',
        summary: `repaired ${stage} for "${openingName}" — ${repairReport.fixed} fixed, ${repairReport.dropped} dropped (${repairedData.length} kept)`,
        details: repairReport.notes.slice(0, 8).join('\n'),
      });
    }
    if (repairedData.length === 0) {
      const reason = repairReport
        ? `all ${stage} entries dropped during per-entry repair: ${repairReport.notes.slice(0, 4).join('; ')}`
        : `0 ${stage} entries after repair`;
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.mergeStageIntoCache',
        summary: `no salvageable ${stage} entries for "${openingName}" after repair`,
      });
      return { merged: false, keptCount: 0, reason };
    }
    const updatedTree: WalkthroughTree = {
      ...cached.tree,
      [stage]: repairedData,
    };
    // Re-validate the merged tree to catch corruption.
    const issues = validateMoveLegality(updatedTree);
    const errors = issues.filter((i) => i.severity === 'error' && i.path[0] === stage);
    if (errors.length > 0) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'openingGenerator.mergeStageIntoCache',
        summary: `discarded background-generated ${stage} for "${openingName}" — ${errors.length} legality errors`,
        // Production audit (build 3965c09) showed N-error counts but
        // no SAN detail, so we couldn't tell which moves were illegal
        // or where the LLM was confused. Capture the full issue list
        // (capped) so the next audit triage has the SAN + FEN context.
        details: formatIssues(errors).slice(0, 2500),
      });
      return {
        merged: false,
        keptCount: 0,
        reason: `${errors.length} validation errors after repair: ${formatIssues(errors).slice(0, 800)}`,
      };
    }
    await db.cachedOpenings.put({
      ...cached,
      tree: updatedTree,
      generatedAt: cached.generatedAt, // preserve original timestamp
    });
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'openingGenerator.mergeStageIntoCache',
      summary: `merged ${stage} (${repairedData.length} entries) into cached "${openingName}"`,
    });
    return { merged: true, keptCount: repairedData.length };
  } catch (err) {
    void logAppAudit({
      kind: 'dexie-error',
      category: 'subsystem',
      source: 'openingGenerator.mergeStageIntoCache',
      summary: `failed to merge ${stage} for "${openingName}"`,
      details: err instanceof Error ? err.message : String(err),
    });
    return {
      merged: false,
      keptCount: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Determine which optional stages are missing from a tree (for
 *  background-fill targeting). Empty arrays count as missing — we
 *  want SOMETHING for each stage, not a hollow shell. */
export function getMissingStages(tree: WalkthroughTree): OptionalStage[] {
  const missing: OptionalStage[] = [];
  if (!tree.concepts || tree.concepts.length === 0) missing.push('concepts');
  if (!tree.findMove || tree.findMove.length === 0) missing.push('findMove');
  if (!tree.drill || tree.drill.length === 0) missing.push('drill');
  if (!tree.punish || tree.punish.length === 0) missing.push('punish');
  return missing;
}

/** Fire-and-forget background generation for missing stages. Called
 *  AFTER the main tree is generated and cached. The 4 stages run in
 *  parallel; each successful one merges into the cached tree as it
 *  completes. Failures are silent — the user gets whatever finishes
 *  by the time they reach the stage menu. Idempotent: calling again
 *  for stages already present is a no-op (the `missing` filter
 *  excludes them). */
export async function generateMissingStagesInBackground(
  openingName: string,
  tree: WalkthroughTree,
  onStageMerged?: (stage: 'concepts' | 'findMove' | 'drill' | 'punish') => void,
): Promise<void> {
  const missing = getMissingStages(tree);
  if (missing.length === 0) return;
  void logAppAudit({
    kind: 'coach-surface-migrated',
    category: 'subsystem',
    source: 'openingGenerator.generateMissingStagesInBackground',
    summary: `kicking off ${missing.length} background stage gens for "${openingName}": ${missing.join(', ')}`,
  });
  // Promise.all runs them in parallel. We swallow the result —
  // individual failures don't block other stages.
  await Promise.all(
    missing.map(async (stage) => {
      const first = await generateOneStage(openingName, stage);
      if (!first.ok || !first.data) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'openingGenerator.generateMissingStagesInBackground',
          summary: `background stage gen failed for "${openingName}" / ${stage}: ${first.reason ?? 'unknown'}`,
        });
        return;
      }
      const merge = await mergeStageIntoCache(openingName, stage, first.data);
      if (merge.merged) {
        // Notify caller — the walkthrough is likely already running
        // and needs to refresh its in-memory tree so newly-arrived
        // punish lessons / drill lines / quiz questions become
        // available for trap-prompt and stage menus. Production audit
        // (build bc1eb69): "I never saw the punish lines" — root
        // cause was that the walkthrough's tree was a snapshot at
        // start() time, never updated when stages merged later.
        try { onStageMerged?.(stage); } catch { /* swallow */ }
        return;
      }
      // First attempt produced data but everything got dropped during
      // per-entry repair (e.g. all 5 punish lessons had illegal
      // setupMoves / inaccuracy / punishment). Try ONE more time with
      // the failure context fed back so the LLM can produce a simpler,
      // more conservative attempt. Production goal: punish stage
      // surfaces reliably for any opening, not just easy ones.
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'openingGenerator.generateMissingStagesInBackground',
        summary: `retrying ${stage} for "${openingName}" — first attempt yielded 0 kept entries`,
      });
      const retry = await generateOneStage(openingName, stage, merge.reason);
      if (!retry.ok || !retry.data) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'openingGenerator.generateMissingStagesInBackground',
          summary: `background stage gen retry failed for "${openingName}" / ${stage}: ${retry.reason ?? 'unknown'}`,
        });
        return;
      }
      const retryMerge = await mergeStageIntoCache(openingName, stage, retry.data);
      if (!retryMerge.merged) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'openingGenerator.generateMissingStagesInBackground',
          summary: `${stage} retry merge failed for "${openingName}": ${retryMerge.reason ?? 'unknown'}`,
        });
      } else {
        try { onStageMerged?.(stage); } catch { /* swallow */ }
      }
    }),
  );
}
