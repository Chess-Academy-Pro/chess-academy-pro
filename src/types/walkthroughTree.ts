/**
 * WalkthroughTree — tree-shaped opening lesson with branch points.
 *
 * Distinct from `WalkthroughSession` (a flat ordered list of steps).
 * Openings are not linear — they have forks (e.g. the Vienna at move
 * 2 has three popular Black responses), and a real coach pauses at
 * each fork and asks the student which line to explore. The flat
 * Session shape can't represent that; this Tree shape can.
 *
 * Runtime: `useTeachWalkthrough` walks the tree node-by-node. When
 * `node.children.length > 1`, it pauses and renders tap targets;
 * when `=== 1`, it advances automatically; when `=== 0`, it's a
 * leaf — the coach delivers the leaf's outro and offers to back up
 * to the last fork or take the position into a real game.
 *
 * The data file declares MOVES only (SAN). FENs are computed at
 * runtime by walking chess.js through the move sequence — no
 * hand-written FENs to typo, no per-edit re-validation.
 */

/** A single node in the walkthrough tree. Represents the position
 *  AFTER `san` was played from the parent's position. The root
 *  (start position) has `san: null`. */
export interface WalkthroughTreeNode {
  /** SAN of the move that landed on this node. `null` only at the
   *  root (the pre-1.e4 starting position). */
  san: string | null;
  /** Who made the move. `null` only at the root. */
  movedBy: 'white' | 'black' | null;
  /** Coach's spoken explanation of THIS move, narrated as it
   *  animates onto the board. Written in the coach's own voice —
   *  no length cap, no template. The voice service speaks it via
   *  Polly; the chat panel renders it as the coach's message.
   *  Used as the FALLBACK narration when `narration` is omitted. */
  idea: string;
  /** Optional one-sentence variant of `idea` used by the "Brief"
   *  setting of Coach Narration (Settings → Coach → Coach Narration).
   *  Keep it ≤ 28 words, preserve the key chess idea (tactical
   *  pattern, evaluation, threat, action's consequence). When unset,
   *  Brief mode falls back to silent reading-pace for this node so
   *  random truncation never lands on the wrong sentence. Generated
   *  by `scripts/generate-short-narrations.mjs` for annotation JSONs;
   *  hand-written for static trees (e.g. vienna.ts). */
  shortIdea?: string;
  /** Optional segmented narration with per-segment arrows and
   *  highlights. When present, the runtime speaks each segment's
   *  text in order via voice service, setting arrows/highlights
   *  to that segment's values BEFORE speaking — so the arrows
   *  appear AS the moves are mentioned. When omitted, `idea` is
   *  spoken as a single block with no arrows. Authors only need
   *  this when they want real-time arrow timing on a node. */
  narration?: NarrationSegment[];
  /** Children of this node. `length === 0` means leaf (line ends
   *  here). `length === 1` means linear continuation (auto-advance
   *  after `idea` is narrated). `length > 1` means BRANCH — pause,
   *  show tap targets, wait for student to pick. */
  children: WalkthroughTreeChild[];
}

/** A single narration segment — one beat of speech with its own
 *  arrows + highlights. The runtime speaks segments in order; arrows
 *  set on a segment appear BEFORE its text starts speaking and stay
 *  visible until the next segment runs (or the node transitions).
 *
 *  Authoring guideline: split `idea` into segments at natural sentence
 *  boundaries where the prose mentions a square or a move. Put the
 *  arrow on the segment that NAMES the destination — e.g. for "push
 *  the pawn forward to f4 to start the gambit", the arrow `f2→f4`
 *  goes on that segment. The student sees the arrow draw exactly as
 *  the coach says "f4". */
export interface NarrationSegment {
  /** Text spoken in this segment. Combine across segments to form
   *  the full prose. */
  text: string;
  /** Optional one-sentence variant of `text` used by the Brief
   *  Coach Narration setting. Same authoring guideline as
   *  `WalkthroughTreeNode.shortIdea`: ≤ 28 words, preserve the key
   *  chess idea. When unset on a segment, Brief mode plays it
   *  silent — never auto-truncates, so the user never hears half a
   *  setup sentence with the punchline missing. */
  shortText?: string;
  /** Arrows visible during this segment. Replaces any arrows from
   *  the previous segment. Empty array (or omitted) clears arrows
   *  on this segment. */
  arrows?: NarrationArrow[];
  /** Square highlights visible during this segment. Same semantics
   *  as `arrows`. Useful for "weak square" callouts. */
  highlights?: NarrationHighlight[];
}

/** A drawn arrow on the board — animates from `from` to `to` over
 *  ~550ms via Framer Motion's pathLength. Color names map to the
 *  app's accent palette; default is green ("here's the plan"). */
export interface NarrationArrow {
  /** Source square in algebraic notation, e.g. "f2". */
  from: string;
  /** Destination square in algebraic notation, e.g. "f4". */
  to: string;
  /** Arrow color. Default 'green'. Use 'red' for warnings ("don't
   *  play this"), 'blue' for plans ("future move"), 'yellow' for
   *  attention ("look here"). */
  color?: 'green' | 'red' | 'blue' | 'yellow';
}

/** A square highlight — fills the square with a translucent color
 *  while the segment is active. */
export interface NarrationHighlight {
  /** Square in algebraic notation, e.g. "f7". */
  square: string;
  /** Highlight color. Default 'yellow'. */
  color?: 'green' | 'red' | 'blue' | 'yellow';
}

/** A child of a node. The `label` and `forkSubtitle` are only
 *  consumed when the parent has multiple children (branch point);
 *  they're ignored on linear continuations. */
export interface WalkthroughTreeChild {
  /** Tap-target text shown at a branch point. Should name the move
   *  AND the strategic identity ("3.f4 — Vienna Gambit"). Required
   *  when the parent is a branch (children.length > 1); optional
   *  on linear continuations. */
  label?: string;
  /** Tap-target sub-text shown at a branch point. One short clause
   *  framing the choice ("Sacrifice the f-pawn for a kingside
   *  attack"). Required when the parent is a branch; optional on
   *  linear continuations. */
  forkSubtitle?: string;
  /** The subtree rooted at this child. */
  node: WalkthroughTreeNode;
}

/** A complete opening walkthrough tree, registered by name in
 *  `src/data/openingWalkthroughs/index.ts`. */
export interface WalkthroughTree {
  /** Canonical opening name (matches the brain's intendedOpening
   *  memory and Lichess explorer responses). */
  openingName: string;
  /** ECO code (e.g. "C25" for Vienna). Used for opening-detection
   *  cross-reference. */
  eco: string;
  /** Coach's intro narration — spoken once at the start of the
   *  walkthrough, before any move animates. Sets context for the
   *  opening's character. */
  intro: string;
  /** Optional Brief-mode variant of `intro`. ≤ 28 words, preserves
   *  the opening's framing. When unset, Brief mode plays the intro
   *  silently (reading pace) rather than auto-truncating `intro`. */
  shortIntro?: string;
  /** Default outro spoken at any leaf that doesn't override it.
   *  Reaches the student at the end of a chosen branch — should
   *  invite backtrack-to-fork or play-it-out. */
  outro: string;
  /** Optional per-leaf outro override map, keyed by a leaf path
   *  (the SAN moves from root joined by spaces). Used when a
   *  particular branch deserves a custom takeaway message. */
  leafOutros?: Record<string, string>;
  /** Which side the student is learning to play. White for openings
   *  like Vienna / Italian / Ruy Lopez / Queen's Gambit; Black for
   *  defenses (Sicilian / French / Caro-Kann / Pirc / King's Indian
   *  / etc.). Drives board orientation — Black-student openings
   *  render with Black on bottom so the moves animate from the
   *  student's perspective. Defaults to white if omitted. */
  studentSide?: 'white' | 'black';
  /** Optional starting FEN for trees that begin mid-game rather than
   *  from the standard starting position. Required for middlegame
   *  pattern lessons (Greek gift sacrifice, IQP play, etc.) where
   *  the student is studying a position several moves into a game.
   *  When omitted, the tree starts from the standard chess start
   *  position. The engine's fen-from-path computation honors this. */
  startFen?: string;
  /** The root node — the pre-move starting position. Its `idea` is
   *  ignored (the intro covers the framing); only its children
   *  matter (the first moves of the opening). */
  root: WalkthroughTreeNode;

  // ─── Stage 2: Concept check (after walkthrough) ───────────────
  /** Optional concept-check questions — short MC quizzes on the BIG
   *  IDEAS, not the moves. Forces the student to verbalize the
   *  reasoning before drilling motor memory. Pedagogy: recall of
   *  conceptual frame BEFORE recognition or motor recall. */
  concepts?: ConceptCheckQuestion[];

  // ─── Stage 3: Find the move (recognition) ─────────────────────
  /** Optional "find the move" puzzles — show a position, give 3-4
   *  candidate moves with brief intent labels, student picks. Builds
   *  pattern recognition. Pedagogy: recognition before recall. */
  findMove?: FindMoveQuestion[];

  // ─── Stage 4: Drill the line (woodpecker) ─────────────────────
  /** Optional drill lines — full sequences the student plays from
   *  the start position against an automatic opponent. Wrong move
   *  → reset to that position, retry. Pedagogy: motor recall under
   *  low cognitive load. */
  drill?: DrillLine[];

  // ─── Stage 5: Punish inaccuracies ─────────────────────────────
  /** Optional punish-mistake lessons — opponent plays a sub-optimal
   *  move; student finds the punishment. Mix of MC + play-on-board.
   *  Pedagogy: pattern recognition under novel input. */
  punish?: PunishLesson[];
}

// ─── Stage 2 types ────────────────────────────────────────────────

/** A single concept-check question. The "concept" is the BIG IDEA
 *  behind a move or line, not the move itself — e.g. "Why Nc3 instead
 *  of Nf3 in the Vienna?" with reasoning-based answers. Multiple
 *  choices may be correct (multiSelect mode) when the IDEA has
 *  multiple facets. */
export interface ConceptCheckQuestion {
  /** Optional SAN path from root, so the board can show the position
   *  the question is about. Empty / omitted → board stays at the
   *  starting position. */
  path?: string[];
  /** The conceptual question text. */
  prompt: string;
  /** MC choices. */
  choices: ConceptCheckChoice[];
  /** True when more than one choice is correct (e.g. "Why Nc3? —
   *  pick all that apply"). Default false. */
  multiSelect?: boolean;
}

/** A single MC choice on a concept-check question. */
export interface ConceptCheckChoice {
  /** Choice text shown on the tap target. */
  text: string;
  /** True when this choice is correct. */
  correct: boolean;
  /** Coach's explanation, shown after the student picks this choice
   *  (whether correct or not). Spoken via voice + rendered in chat. */
  explanation: string;
}

// ─── Stage 3 types ────────────────────────────────────────────────

/** A "find the move" puzzle — recognition-stage MC. Show position,
 *  ask "what's the move?", offer 3-4 candidates each labeled with
 *  the IDEA behind the move. Student picks; coach explains why the
 *  correct one is correct AND why each distractor is inferior. */
export interface FindMoveQuestion {
  /** SAN path from root to the position being quizzed. */
  path: string[];
  /** Question prompt, e.g. "White to play. What's the move?" */
  prompt: string;
  /** Candidate moves. Exactly one is correct. */
  candidates: FindMoveCandidate[];
}

/** A single candidate move on a find-the-move puzzle. */
export interface FindMoveCandidate {
  /** SAN of the candidate move. */
  san: string;
  /** Short intent label shown on the tap target — e.g. "Bc4 —
   *  develops + eyes f7". */
  label: string;
  /** True when this is the best move. Only one candidate per
   *  question should be correct. */
  correct: boolean;
  /** Coach's explanation shown after pick (correct: why it's right;
   *  incorrect: why this is inferior). */
  explanation: string;
}

// ─── Stage 4 types ────────────────────────────────────────────────

/** A drill line — a sequence of SAN moves the student plays from
 *  the starting position. The student plays their side; the runtime
 *  auto-plays the opponent's moves. Wrong move → "the move is X,
 *  here's why" → reset to that position. After a clean playthrough,
 *  the line restarts so the student grinds it until automatic. */
export interface DrillLine {
  /** Display name shown on the line-picker tap target. */
  name: string;
  /** Subtitle, e.g. "Vienna Gambit accepted — main line". */
  subtitle?: string;
  /** Full SAN sequence from the starting position. The student
   *  plays the moves on their side; the runtime auto-plays the
   *  others. Length must match the depth they should drill to. */
  moves: string[];
  /** Which side the student plays. Default: 'white'. */
  studentSide?: 'white' | 'black';
}

// ─── Stage 5 types ────────────────────────────────────────────────

/** A punish-inaccuracy lesson — opponent plays a sub-optimal move,
 *  student finds the punishment. Two-part flow: first MC ("which
 *  move punishes this?") then a follow-up walkthrough of the
 *  resulting line so the student sees the win materialize. */
export interface PunishLesson {
  /** Display name on the lesson-picker tap target — e.g. "Vienna:
   *  Black plays 2…d6? — punish the loose center". */
  name: string;
  /** Pedagogical kind. Drives the colored chip on the lesson tile
   *  AND whether downstream surfaces (line picker, leaf prompts)
   *  treat the entry as a tactical trap vs a counting blunder vs a
   *  positional theme.
   *  - 'trap'    : opponent's natural-looking move has a CONCRETE
   *                tactical refutation (forced material/mate within
   *                ~3 plies). Bright-red chip.
   *  - 'mistake' : counting / structural blunder, no forced tactic
   *                — punishment is "now you're better" via principle.
   *                Orange chip.
   *  - 'theme'   : long maneuvering middlegame plan. Blue chip.
   *  When omitted, runtime defaults to 'mistake' (safe — won't
   *  surface as a red TRAP if a curator forgets to tag).
   *  See also `pro-repertoires.json` trapLines + their sidecar
   *  classification file `trap-line-classifications.json`; same
   *  taxonomy applies. User audit (build 79f3a20): "How would you
   *  organize this mess of data I have now vomited through the
   *  app?" — three-kind taxonomy is the answer. */
  kind?: 'trap' | 'mistake' | 'theme';
  /** Optional FEN to load directly as the lesson's starting position
   *  (the position right BEFORE the inaccuracy). Used by puzzle-DB-
   *  derived punish lessons where the position comes from a real
   *  game's mid-opening state that can't always be reached by
   *  replaying SAN from the start. When present, the runtime uses
   *  this FEN as the walkthrough's startFen and skips the
   *  setupMoves animation — jumps straight to "Black has just played
   *  the canonical opening; now they play this mistake". `setupMoves`
   *  is still set to the canonical opening PGN so the lesson knows
   *  what context to narrate. */
  setupFen?: string;
  /** SAN path UP TO the position right BEFORE the inaccuracy. The
   *  opponent's bad move (`inaccuracy` field) is the next move
   *  played in the runtime. When `setupFen` is set, this serves as
   *  contextual / canonical-pinning info but is NOT replayed. */
  setupMoves: string[];
  /** The opponent's sub-optimal move (SAN). Played by the runtime
   *  as part of the lesson setup. */
  inaccuracy: string;
  /** Coach's explanation of why the inaccuracy is bad — sets up the
   *  "find the punishment" question. */
  whyBad: string;
  /** Optional Brief-mode variant of `whyBad`. ≤ 28 words, preserves
   *  the key tactical/positional reason. Brief-mode trap intros
   *  splice this into the constructed prompt; when unset, Brief
   *  silences the intro. */
  shortWhyBad?: string;
  /** The punishing move (SAN). The student should pick this on the
   *  MC. */
  punishment: string;
  /** Coach's explanation of why the punishment works. Shown after
   *  the student picks (or after they reveal the answer). */
  whyPunish: string;
  /** Optional Brief-mode variant of `whyPunish`. Same authoring
   *  guideline as `shortWhyBad`. */
  shortWhyPunish?: string;
  /** Distractor candidates that don't punish as well. Combined with
   *  the punishment, these become the MC choices (in random order
   *  at runtime). */
  distractors: PunishDistractor[];
  /** Optional follow-up moves to play out so the student sees the
   *  winning continuation. Each move comes with the coach's idea
   *  text, narrated as the move animates. */
  followup?: { san: string; idea: string; shortIdea?: string }[];
}

/** A distractor candidate on a punish-inaccuracy MC question. Looks
 *  plausible but is inferior to the actual punishment. */
export interface PunishDistractor {
  /** SAN of the inferior move. */
  san: string;
  /** Short label shown on the tap target. */
  label: string;
  /** Coach's explanation of why this is inferior. Shown after the
   *  student picks this incorrectly. */
  explanation: string;
}

/** Result of resolving a branch path through the tree. Used by the
 *  runtime to track "where am I now" and "how did I get here." */
export interface WalkthroughTreePosition {
  /** The current node in the tree (the position the board shows). */
  node: WalkthroughTreeNode;
  /** SANs played from root to reach this node — useful for FEN
   *  computation, audit trails, and leaf-outro lookup. */
  pathSans: string[];
  /** Path of nodes from root to current. `path[0]` is always root. */
  pathNodes: WalkthroughTreeNode[];
  /** Index of the most recent ancestor that was a fork (children
   *  length > 1), or -1 if no fork on the path. Used for
   *  "back up to last fork" navigation. */
  lastForkIndex: number;
}
