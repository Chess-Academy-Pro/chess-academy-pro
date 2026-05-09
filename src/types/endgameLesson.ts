/** Hand-authored endgame lesson data shared across the endgame
 *  surface tabs (Principles, Pawn, Rook, etc.). Same architectural
 *  contract as the rest of the app: positions and moves come from
 *  data; prose narration is hand-crafted by the curator (Claude
 *  authoring, David approving). The runtime LLM never authors here —
 *  it only voices the prose via Polly TTS.
 *
 *  Per CLAUDE.md "Do not break my app" + "lines only come from
 *  databases": every FEN is verified legal via chess.js at build
 *  time (see endgame-content.test.ts), every reference position
 *  comes from named chess theory (Capablanca, Dvoretsky, classical
 *  studies), every solution sequence is replay-checked. */

/** A single hand-authored endgame lesson — the canonical unit
 *  across Principles / Pawn / Rook / Drawing-Patterns surfaces. */
export interface EndgameLesson {
  /** URL-safe slug used as cache key + route param. */
  id: string;
  /** Display name as it appears in the picker tile. */
  name: string;
  /** Pedagogical category. Drives which surface tab the lesson
   *  appears on. */
  category:
    | 'principle'         // One of the 7 universal endgame principles
    | 'pawn-concept'      // Opposition, key squares, the rule of the square
    | 'pawn-technique'    // Triangulation, outflanking, breakthrough
    | 'rook-position'     // Lucena, Philidor, active rook
    | 'drawn-pattern'     // Wrong-rook-pawn bishop, OCB, fortress
    | 'piece-mate';       // K+Q / K+R / K+BN technique drills
  /** Suggested learn-order (low → high). The UI surfaces the
   *  number on the tile but never blocks tiles by completion. */
  order: number;
  /** Hand-authored narration. Read aloud via Polly TTS at lesson
   *  start. Same voice across every lesson — concrete squares,
   *  geometric mechanism, no chess clichés ('strong move', 'good
   *  piece'), source-cited where applicable. */
  narration: EndgameLessonNarration;
  /** Canonical reference positions illustrating the lesson.
   *  Hand-curated, every FEN chess.js-legal, every solution
   *  sequence replay-checked. */
  positions: EndgameLessonPosition[];
  /** Optional Lichess puzzle DB theme tags for the practice corpus
   *  appended after the reference positions. Multi-move mate themes
   *  filter applied automatically (we don't want mate-in-1 in a
   *  technique lesson). */
  practiceThemes?: string[];
}

export interface EndgameLessonNarration {
  /** Geometric setup — what's on the board, what we're looking
   *  at. 2-3 sentences, no length cap but kept tight. */
  intro: string;
  /** The rule / principle stated cleanly in one sentence. */
  rule: string;
  /** The mechanism — WHY the rule works. 3-5 sentences. This is
   *  the section users say is most important; the 'why' separates
   *  pattern memorization from real understanding. */
  why: string;
  /** Optional historical / theoretical source. Capablanca,
   *  Dvoretsky, Tarrasch, Nimzowitsch, Réti, Saavedra, Philidor,
   *  Lucena — cite who said it. Builds authority. */
  history?: string;
  /** Optional practical pointer — one-sentence "use this when..." */
  tip?: string;
}

export interface EndgameLessonPosition {
  /** Standard FEN. Verified chess.js-legal at build time. */
  fen: string;
  /** Title shown on the position card — names the position
   *  (e.g. "Direct opposition gained") not its eval. */
  title: string;
  /** 2-4 sentences explaining what's happening here, what to
   *  notice, and how it illustrates the lesson principle.
   *  Hand-authored with the same voice as the lesson narration. */
  explanation: string;
  /** Result with best play. */
  result: 'white-wins' | 'black-wins' | 'draw';
  /** Optional best first move (SAN) for technique demonstrations. */
  bestMove?: string;
  /** Optional full solution sequence (SAN). When present, the UI
   *  can step through the answer move by move with narration. */
  solution?: string[];
  /** Optional source citation — book, study, named position. */
  source?: string;
}
