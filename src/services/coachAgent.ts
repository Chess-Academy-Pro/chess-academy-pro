/**
 * coachAgent
 * ----------
 * Parses natural-language coach requests into structured intents the
 * UI can route on. Fast-path regexes cover the most common phrasings;
 * anything else falls through to `kind: 'qa'` which the existing
 * coach chat handles.
 *
 * Keeping a deterministic regex layer (vs. always asking the LLM)
 * means lessons start instantly and never misroute on a malformed
 * model response.
 *
 * See CLAUDE.md → "Agent Coach Pattern".
 */

import { expandOpeningAlias } from './openingAliases';

export type CoachIntentKind =
  | 'continue-middlegame'
  | 'play-against'
  | 'puzzle'
  | 'walkthrough'
  | 'explain-position'
  | 'review-game'
  | 'favorite-opening'
  | 'qa';

export type CoachDifficulty = 'easy' | 'medium' | 'hard' | 'auto';

export type GameSourceFilter = 'chesscom' | 'lichess';

export interface CoachIntent {
  kind: CoachIntentKind;
  /** Opening / theme / puzzle type extracted from the query. */
  subject?: string;
  /** Difficulty hint for play-against and puzzle sessions. */
  difficulty?: CoachDifficulty;
  /** Puzzle theme, e.g. "knight fork", "back rank". */
  theme?: string;
  /** For play-against: which colour the student wants. */
  side?: 'white' | 'black';
  /** For review-game: which import source to filter by. */
  source?: GameSourceFilter;
  /** For review-game: 'narrate' wants a move-by-move auto-playing
   *  session with voice; 'review' (default) opens the interactive
   *  review view. */
  mode?: 'narrate' | 'review';
  /** Original raw user query. */
  raw: string;
}

/** Generic "I want to learn an opening, you pick" phrasings — no
 *  specific opening named. Matches the full user query (lowercased),
 *  not just a captured subject fragment. Routes to play-against so
 *  the student lands on the live board where the coach can propose
 *  and start one; the walkthrough player needs a concrete opening
 *  match and would otherwise fall back to a stub. */
const GENERIC_OPENING_REQUEST_RE =
  /^(?:please\s+)?(?:can\s+you\s+)?(?:teach|show|give)\s+me\s+(?:a|an|another|a\s+new|a\s+different|a\s+random|some)\s+(?:new\s+|different\s+|random\s+)?(?:opening|openings|opening\s+theory)\b[\s!.?]*$/i;

const DIFFICULTY_WORDS: Record<string, CoachDifficulty> = {
  easy: 'easy',
  beginner: 'easy',
  gentle: 'easy',
  medium: 'medium',
  normal: 'medium',
  hard: 'hard',
  tough: 'hard',
  strong: 'hard',
  max: 'hard',
  maximum: 'hard',
};

function extractDifficulty(text: string): CoachDifficulty | undefined {
  const lower = text.toLowerCase();
  // "at my level" → medium is a natural-language shortcut that wouldn't
  // otherwise match the word map below.
  if (/\bat my level\b/.test(lower)) return 'medium';
  for (const [word, level] of Object.entries(DIFFICULTY_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(lower)) return level;
  }
  return undefined;
}

function extractSide(text: string): 'white' | 'black' | undefined {
  const lower = text.toLowerCase();
  // Explicit "as black/white"
  const asMatch = lower.match(/\bas\s+(black|white)\b/);
  if (asMatch) return asMatch[1] as 'white' | 'black';
  // "I'll take/play black" or "I want black"
  const takeMatch = lower.match(
    /\bi\s*(?:'|wi)?ll\s+(?:take|play|be)\s+(black|white)\b/,
  );
  if (takeMatch) return takeMatch[1] as 'white' | 'black';
  const wantMatch = lower.match(/\bi\s+want\s+(?:to\s+play\s+)?(black|white)\b/);
  if (wantMatch) return wantMatch[1] as 'white' | 'black';
  const takeShort = lower.match(/\bi\s+take\s+(black|white)\b/);
  if (takeShort) return takeShort[1] as 'white' | 'black';
  return undefined;
}

/**
 * Parse a user query into a CoachIntent.
 *
 * Pure, synchronous, and deterministic — safe to call on every input
 * keystroke to show live intent previews in the search bar.
 */
export function parseCoachIntent(query: string): CoachIntent {
  const raw = query.trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return { kind: 'qa', raw };
  }

  // -1. Favorite-opening intent — "favorite the italian", "star the
  //     vienna", "add caro-kann to my training plan", "bookmark the
  //     french for my rolodex". Wires the rolodex's natural-language
  //     favoriting path (WO-ROLODEX-PLUMBING-01 item 5).
  //
  //     Pattern A: `<verb> [the] <subject>` where verb is one of
  //       favorite / favourite / star / bookmark. The verb is
  //       distinctive enough that no scope qualifier is needed —
  //       "favorite this" or "favorite the X" reliably means
  //       favoriting an opening.
  //
  //     Pattern B: `add <subject> to [my] (training plan|rolodex|
  //       favorites|favourites)` — "add" alone is too ambiguous
  //       (add a move, add a tag, etc.), so we require the scope
  //       qualifier.
  //
  //     Runs FIRST so a phrasing like "star the vienna" isn't
  //     hijacked by a downstream branch matching "vienna" as a
  //     play / walkthrough target.
  {
    const favA = lower.match(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+|i\s+want\s+to\s+|i'?d\s+like\s+to\s+)?(?:favorite|favourite|star|bookmark)\s+(?:the\s+)?(.+?)\s*\.?\s*$/,
    );
    const favB = lower.match(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+|i\s+want\s+to\s+|i'?d\s+like\s+to\s+)?(?:add|save)\s+(?:the\s+)?(.+?)\s+(?:to|for|in)\s+(?:my\s+)?(?:training\s+plan|rolodex|favorites|favourites)\s*\.?\s*$/,
    );
    const m = favA ?? favB;
    if (m) {
      const subjectRaw = m[1];
      const cleaned = cleanSubject(subjectRaw);
      if (cleaned.length > 0) {
        return {
          kind: 'favorite-opening',
          subject: expandOpeningAlias(cleaned),
          raw,
        };
      }
    }
  }

  // 0. "Explain this position" / "what's happening here" / "analyze
  //    this". Must come before the middlegame branch so "explain the
  //    middlegame plan" still routes to continue-middlegame.
  //
  // The user is asking us to explain a position they are looking at.
  // The FEN itself comes from either a URL `?fen=` param or the
  // persistent `lastBoardSnapshot` in the store — coachAgent just
  // detects the intent, it doesn't resolve the position.
  if (
    !/(middle\s*game|middlegame|opening|endgame)/.test(lower) &&
    (
      /^(what'?s?\s+(going\s+on|happening)\s+(here|in\s+this\s+position)?)/.test(lower) ||
      /explain\s+(this|the\s+current|my\s+current)\s+position/.test(lower) ||
      /explain\s+this\b/.test(lower) ||
      /analy[sz]e\s+(this|the\s+current|my\s+current)\s+position/.test(lower) ||
      /analy[sz]e\s+this\b/.test(lower) ||
      /what'?s?\s+going\s+on\b/.test(lower) ||
      /what'?s?\s+happening\b/.test(lower)
    )
  ) {
    return { kind: 'explain-position', raw };
  }

  // 0.5 Review-game requests — "review my last game", "run me through
  //     my last Catalan", "walk me through my most recent game on
  //     chess.com". Runs BEFORE middlegame / walkthrough because those
  //     greedy patterns would otherwise hijack "run me through my last
  //     Catalan". Two-step: verb + time-marker test, then pull out
  //     source and subject separately (one combined regex gets brittle
  //     fast across the phrasings people actually use).
  const REVIEW_VERBS_RE =
    /\b(?:review|run\s+(?:me\s+)?through|walk\s+(?:me\s+)?through|show\s+me|go\s+(?:over|through)|narrate|recap|replay|analy[sz]e|insights?\s+(?:from|on|about))\b/;
  const NARRATE_VERBS_RE = /\b(?:narrate|recap|replay)\b/;
  const LAST_MARKER_RE = /\b(?:last|most\s+recent|latest|previous)\b/;
  if (REVIEW_VERBS_RE.test(lower) && LAST_MARKER_RE.test(lower)) {
    const mode: 'narrate' | 'review' = NARRATE_VERBS_RE.test(lower) ? 'narrate' : 'review';
    // Source — "on chess.com" / "on lichess". Handle the optional dot.
    let source: GameSourceFilter | undefined;
    const sourceMatch = lower.match(/\bon\s+(chess\.?com|lichess)\b/);
    if (sourceMatch) {
      source = sourceMatch[1].replace(/\./g, '') === 'chesscom' ? 'chesscom' : 'lichess';
    }
    // Subject — take everything after the time marker, strip filler
    // words, accept whatever's left as the opening name. Empty string
    // means "the user didn't specify an opening".
    const afterMarker = lower.replace(/^.*?\b(?:last|most\s+recent|latest|previous)\b\s*/, '');
    const subjectRaw = afterMarker
      .replace(/\bgame\s+i\s+played\b/g, '')
      .replace(/\b(?:the\s+)?game\b/g, '')
      .replace(/\bon\s+(?:chess\.?com|lichess)\b/g, '')
      .replace(/\bi\s+played\b/g, '')
      .replace(/\b(?:in|of|from|with|the)\b/g, '')
      .replace(/[?.!]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cleanedSubject = subjectRaw.length > 0 ? cleanSubject(subjectRaw) : '';
    return {
      kind: 'review-game',
      subject: cleanedSubject ? expandOpeningAlias(cleanedSubject) : undefined,
      source,
      mode,
      raw,
    };
  }

  // 1. "Run me through the middlegame plans" / "show me middlegame" /
  //    "continue with middlegame" etc. Also captures an optional subject
  //    like "for the Italian" / "of the Sicilian" / "in the King's Indian"
  //    so downstream resolution can find a matching DB plan instead of
  //    falling back to a generic Stockfish line.
  if (
    /(middle\s*game|middlegame)/.test(lower) &&
    /(run|walk|show|teach|plan|continue|through|explain)/.test(lower)
  ) {
    const subjectMatch =
      lower.match(/middle\s*game\b[^.?!]*?\b(?:for|of|in|from)\s+(?:the\s+)?([a-z][a-z\s'-]+)/) ||
      lower.match(/(?:for|of|in|from)\s+(?:the\s+)?([a-z][a-z\s'-]+?)\s+middle\s*game/);
    const subject = subjectMatch ? cleanSubject(subjectMatch[1]) : '';
    return {
      kind: 'continue-middlegame',
      subject: subject ? expandOpeningAlias(subject) : undefined,
      raw,
    };
  }

  // 2. Explain-position: "explain this position", "what's happening here",
  //    "analyze the board", "break down this position", "evaluate this".
  //    Runs BEFORE play-against so phrases like "what should I do here"
  //    don't get swallowed.
  if (
    /\b(explain|analy[sz]e|evaluate|break\s+down)\b.*\b(position|board)\b/.test(lower) ||
    /\bwhat(?:'s| is)\s+(?:happening|going on)\s+here\b/.test(lower) ||
    /\bwhat\s+should\s+i\s+(?:do|play)\s+here\b/.test(lower) ||
    /\bevaluate\s+this\b/.test(lower)
  ) {
    return { kind: 'explain-position', raw };
  }

  // 3. "Play X against me" / "play against me with X" / "play the Stafford"
  //    Also covers "challenge me", "let's play", "start a game",
  //    "wanna play", "give me a game", "play a match", etc.
  //    Order matters: more specific patterns first so the subject
  //    capture doesn't swallow the wrong text.
  const playMatch =
    lower.match(/play\s+(?:the\s+)?(.+?)\s+against\s+me/) ||
    lower.match(/play\s+against\s+me(?:\s+with\s+(?:the\s+)?(.+))?/) ||
    // "let's play [,.]? [subject]" — allow comma/period between "play" and
    // the rest so "let's play, I'll take black" still routes.
    lower.match(/let'?s\s+play\b[\s,.]*(?:the\s+)?(.+)?/) ||
    lower.match(/challenge\s+me(?:\s+with\s+(?:the\s+)?(.+))?/) ||
    // "start a game" / "start game" / "start a match"
    lower.match(/\bstart\s+(?:a\s+)?(?:new\s+)?(?:game|match)(?:\s+(?:with|against)\s+(?:the\s+)?(.+))?/) ||
    // "play a game" / "play a match" / "play me" with optional subject
    lower.match(/\bplay\s+(?:a\s+)?(?:new\s+)?(?:game|match)(?:\s+(?:with|against)\s+(?:the\s+)?(.+))?/) ||
    // "want to play" / "wanna play" / "i'd like to play" — optional subject
    lower.match(/\b(?:want\s+to|wanna|would\s+like\s+to|i'?d\s+like\s+to|can\s+we)\s+play\b(?:\s+(?:the\s+)?(.+))?/) ||
    // "i'll play" — same idea, e.g. "i'll play the sicilian"
    lower.match(/\bi'?ll\s+play\b(?:\s+(?:the\s+)?(.+))?/) ||
    // "give me a game" / "give me a match"
    lower.match(/\bgive\s+me\s+(?:a\s+)?(?:game|match)(?:\s+(?:with|against)\s+(?:the\s+)?(.+))?/) ||
    // "ready to play" / "ready for a game"
    lower.match(/\bready\s+(?:to\s+play|for\s+(?:a\s+)?(?:game|match))\b/);
  if (playMatch) {
    const rawSubject = playMatch[1] ? cleanSubject(playMatch[1]) : '';
    let side = extractSide(lower);
    const difficulty = extractDifficulty(lower) ?? 'auto';
    // Strip side/difficulty phrases from the subject so "play against me
    // as black easy" doesn't produce subject "as black easy".
    let subject = stripSideAndDifficulty(rawSubject) || undefined;
    // "Play Black against me" / "Play white against me" — the captured
    // "subject" is actually the COACH's color. User plays the opposite.
    if (subject && /^(black|white)$/i.test(subject)) {
      const coachColor = subject.toLowerCase() as 'white' | 'black';
      side = coachColor === 'white' ? 'black' : 'white';
      subject = undefined;
    }
    // Expand common abbreviations ("kid" → "King's Indian Defense")
    // so the opening-book lookup downstream actually resolves.
    if (subject) {
      subject = expandOpeningAlias(subject);
    }
    return {
      kind: 'play-against',
      subject,
      difficulty,
      side,
      raw,
    };
  }

  // 4. Puzzle requests: "give me a knight-fork puzzle", "puzzle about pins"
  const puzzleMatch =
    lower.match(/(?:give\s+me\s+)?(?:a\s+|an\s+)?(.+?)\s+puzzle/) ||
    lower.match(/puzzle\s+(?:about|on|for)\s+(.+)/) ||
    (/^\s*(?:a\s+)?puzzle\s*$/.test(lower) ? ['puzzle', ''] : null);
  if (puzzleMatch && /puzzle/.test(lower)) {
    const theme = cleanSubject(puzzleMatch[1] || '');
    return {
      kind: 'puzzle',
      theme: theme || undefined,
      difficulty: extractDifficulty(lower),
      raw,
    };
  }

  // 4.5 "Teach me an opening" / "show me a new opening" — generic
  //    requests with no specific opening name. Must come BEFORE the
  //    walkthrough regex below, which would otherwise capture a
  //    fragment subject ("an", "a new") that the walkthrough player
  //    can't resolve. Route to play-against so the student lands on
  //    the live board where the coach can suggest and start one.
  if (GENERIC_OPENING_REQUEST_RE.test(lower)) {
    return {
      kind: 'play-against',
      difficulty: extractDifficulty(lower) ?? 'auto',
      side: extractSide(lower),
      raw,
    };
  }

  // 5. Walkthrough requests. Ordered from most specific to least so
  //    "show me the London System opening" picks up the "opening"
  //    suffix variant first.
  const walkthroughMatch =
    lower.match(/walk\s+(?:me\s+)?through\s+(?:the\s+)?(.+)/) ||
    lower.match(/teach\s+me\s+(?:the\s+main\s+line\s+of\s+)?(?:the\s+)?(.+)/) ||
    lower.match(/show\s+me\s+(?:the\s+)?(.+?)(?:\s+opening)?$/) ||
    lower.match(/study\s+(?:the\s+)?(.+)/);
  if (walkthroughMatch) {
    const subject = cleanSubject(walkthroughMatch[1]);
    if (subject) {
      return { kind: 'walkthrough', subject: expandOpeningAlias(subject), raw };
    }
  }

  // Fallthrough: treat as a regular Q&A chat message.
  return { kind: 'qa', raw };
}

/**
 * Strip trailing punctuation/filler from an extracted subject phrase.
 * Keeps multi-word subjects like "stafford gambit" intact but removes
 * trailing words like "please" and punctuation.
 */
function cleanSubject(subject: string): string {
  return subject
    .replace(/[?.!,]+$/g, '')
    .replace(/\b(please|now|today|against me|right now|real quick)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove side ("as black"), difficulty, and leftover filler from a
 * subject phrase extracted from a play-against query.
 */
function stripSideAndDifficulty(subject: string): string {
  let out = subject.toLowerCase();
  out = out.replace(
    /\bas\s+(black|white)\b|\bi\s*(?:'|wi)?ll\s+(?:take|play|be)\s+(?:black|white)\b|\bi\s+want\s+(?:to\s+play\s+)?(?:black|white)\b/gi,
    '',
  );
  for (const word of Object.keys(DIFFICULTY_WORDS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  }
  out = out.replace(/\bat my level\b/gi, '');
  out = out.replace(/[,;.]/g, ' ').replace(/\s+/g, ' ').trim();
  // Drop trailing filler words.
  out = out.replace(/\b(with|the|a|an|please)\b\s*$/i, '').trim();
  return out;
}
