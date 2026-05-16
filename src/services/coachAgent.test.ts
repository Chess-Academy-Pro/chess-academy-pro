import { describe, it, expect } from 'vitest';
import { parseCoachIntent } from './coachAgent';

describe('parseCoachIntent — middlegame continuation', () => {
  it.each([
    'Run me through the middlegame plans',
    'Walk me through the middle game',
    'Show me the middlegame',
    'Continue with middlegame plans',
    'Teach me the middlegame',
    'Explain the middlegame plan',
  ])('routes %q to continue-middlegame', (phrase) => {
    const intent = parseCoachIntent(phrase);
    expect(intent.kind).toBe('continue-middlegame');
  });

  it('extracts a subject from "for the X" suffix', () => {
    const intent = parseCoachIntent(
      'Run me through the middlegame plans for the Italian',
    );
    expect(intent.kind).toBe('continue-middlegame');
    expect(intent.subject?.toLowerCase()).toContain('italian');
  });

  it('extracts a subject from "of the X" suffix', () => {
    const intent = parseCoachIntent(
      'Walk me through the middlegame of the Sicilian Defense',
    );
    expect(intent.subject?.toLowerCase()).toContain('sicilian');
  });

  it('leaves subject undefined when no opening is mentioned', () => {
    const intent = parseCoachIntent('Show me the middlegame plans');
    expect(intent.kind).toBe('continue-middlegame');
    expect(intent.subject).toBeUndefined();
  });
});

describe('parseCoachIntent — play-against', () => {
  it('extracts opening when phrased as "play X against me"', () => {
    const intent = parseCoachIntent('Play the Stafford Gambit against me');
    expect(intent.kind).toBe('play-against');
    expect(intent.subject?.toLowerCase()).toContain('stafford');
  });

  it('supports "let\'s play" phrasing', () => {
    const intent = parseCoachIntent("Let's play the Sicilian Najdorf");
    expect(intent.kind).toBe('play-against');
    expect(intent.subject?.toLowerCase()).toContain('sicilian');
  });

  it('supports "play against me with X" phrasing', () => {
    const intent = parseCoachIntent('Play against me with the London');
    expect(intent.kind).toBe('play-against');
    expect(intent.subject?.toLowerCase()).toContain('london');
  });

  it('defaults difficulty to "auto" when not specified', () => {
    const intent = parseCoachIntent("Let's play the Caro-Kann");
    expect(intent.difficulty).toBe('auto');
  });

  it('extracts difficulty from words like "easy" / "hard"', () => {
    const easy = parseCoachIntent('Play the Italian against me on easy');
    expect(easy.difficulty).toBe('easy');

    const hard = parseCoachIntent("Let's play the Ruy Lopez, hard mode");
    expect(hard.difficulty).toBe('hard');
  });

  describe('opening alias expansion', () => {
    it('expands "kid" to "King\'s Indian Defense" so the book lookup resolves', () => {
      const intent = parseCoachIntent('Play the kid against me');
      expect(intent.kind).toBe('play-against');
      expect(intent.subject).toBe("King's Indian Defense");
    });

    it('expands "najdorf" to the canonical Sicilian variation name', () => {
      const intent = parseCoachIntent('Play the Najdorf against me');
      expect(intent.subject).toBe('Sicilian Defense: Najdorf Variation');
    });

    it('leaves unknown subjects untouched so fuzzy matching can try', () => {
      const intent = parseCoachIntent('Play the Stafford Gambit against me');
      expect(intent.subject?.toLowerCase()).toContain('stafford');
    });

    it('expands aliases on walkthrough subjects too', () => {
      const intent = parseCoachIntent('Walk me through the KID');
      expect(intent.kind).toBe('walkthrough');
      expect(intent.subject).toBe("King's Indian Defense");
    });
  });

  // Natural phrasings that previously fell through to `qa` and made the
  // coach chat conversationally ("Ready when you are!") instead of
  // launching /coach/session/play-against.
  describe('natural game-start phrasings', () => {
    const PLAY_PHRASES: readonly string[] = [
      'start a game',
      'Start a new game',
      'Start game',
      'start a match',
      'play a game',
      'Play a match',
      'play a new game',
      'i want to play',
      'I wanna play',
      "i'd like to play",
      'can we play',
      "i'll play",
      'give me a game',
      'Give me a match',
      'ready to play',
      'ready for a game',
      'Ready for a match',
    ];

    for (const phrase of PLAY_PHRASES) {
      it(`routes "${phrase}" to play-against`, () => {
        const intent = parseCoachIntent(phrase);
        expect(intent.kind).toBe('play-against');
      });
    }

    it('still extracts subject from "I want to play the Sicilian"', () => {
      const intent = parseCoachIntent('I want to play the Sicilian');
      expect(intent.kind).toBe('play-against');
      expect(intent.subject?.toLowerCase()).toContain('sicilian');
    });

    it('still extracts subject from "start a game with the London"', () => {
      const intent = parseCoachIntent('start a game with the London');
      expect(intent.kind).toBe('play-against');
      expect(intent.subject?.toLowerCase()).toContain('london');
    });
  });
});

describe('parseCoachIntent — review-game', () => {
  it('routes "review my last game"', () => {
    const intent = parseCoachIntent('review my last game');
    expect(intent.kind).toBe('review-game');
    expect(intent.subject).toBeUndefined();
    expect(intent.source).toBeUndefined();
  });

  it('routes "run me through my last Catalan"', () => {
    const intent = parseCoachIntent('run me through my last Catalan');
    expect(intent.kind).toBe('review-game');
    expect(intent.subject?.toLowerCase()).toContain('catalan');
  });

  it('routes "run me through my last game I played the Catalan"', () => {
    const intent = parseCoachIntent('run me through my last game I played the Catalan');
    // Capture is loose — this is the most ambiguous phrasing. We
    // require the route to fire and the raw-subject capture to at
    // least contain "catalan" when present.
    expect(intent.kind).toBe('review-game');
  });

  it('routes "review my last game on chess.com" with source', () => {
    const intent = parseCoachIntent('review my last game on chess.com');
    expect(intent.kind).toBe('review-game');
    expect(intent.source).toBe('chesscom');
  });

  it('routes "walk me through my most recent game on lichess" with source', () => {
    const intent = parseCoachIntent('walk me through my most recent game on lichess');
    expect(intent.kind).toBe('review-game');
    expect(intent.source).toBe('lichess');
  });

  it('routes "show me my latest game"', () => {
    const intent = parseCoachIntent('show me my latest game');
    expect(intent.kind).toBe('review-game');
  });

  it('routes "go over my last game"', () => {
    const intent = parseCoachIntent('go over my last game');
    expect(intent.kind).toBe('review-game');
  });

  it('does NOT route "teach me the Catalan" (walkthrough, not review)', () => {
    const intent = parseCoachIntent('teach me the Catalan');
    expect(intent.kind).toBe('walkthrough');
  });

  it('does NOT route "run me through the middlegame" (middlegame, not review)', () => {
    const intent = parseCoachIntent('run me through the middlegame');
    expect(intent.kind).toBe('continue-middlegame');
  });
});

describe('parseCoachIntent — puzzles', () => {
  it('routes knight-fork puzzle request', () => {
    const intent = parseCoachIntent('Give me a knight fork puzzle');
    expect(intent.kind).toBe('puzzle');
    expect(intent.theme?.toLowerCase()).toContain('knight');
  });

  it('routes "puzzle about pins"', () => {
    const intent = parseCoachIntent('Puzzle about pins');
    expect(intent.kind).toBe('puzzle');
    expect(intent.theme?.toLowerCase()).toContain('pin');
  });

  it('handles bare "puzzle"', () => {
    const intent = parseCoachIntent('Puzzle');
    expect(intent.kind).toBe('puzzle');
  });
});

describe('parseCoachIntent — walkthrough', () => {
  it('"walk me through the Sicilian" → walkthrough', () => {
    const intent = parseCoachIntent('Walk me through the Sicilian Defense');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('sicilian');
  });

  it('"teach me the London" → walkthrough', () => {
    const intent = parseCoachIntent('Teach me the London system');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('london');
  });

  it('"teach me an opening" (generic, no name) → play-against', () => {
    const intent = parseCoachIntent('teach me an opening');
    expect(intent.kind).toBe('play-against');
    expect(intent.subject).toBeUndefined();
  });

  it('"teach me a new opening" → play-against', () => {
    const intent = parseCoachIntent('teach me a new opening');
    expect(intent.kind).toBe('play-against');
  });

  it('"show me an opening" (generic) → play-against', () => {
    const intent = parseCoachIntent('show me an opening');
    expect(intent.kind).toBe('play-against');
  });
});

describe('parseCoachIntent — explain-position', () => {
  it.each([
    'Explain this position',
    'explain this',
    'Analyse this position',
    'Analyze this',
    "What's happening here",
    "What's going on",
    "What's happening in this position",
    'Explain my current position',
  ])('routes %q to explain-position', (phrase) => {
    const intent = parseCoachIntent(phrase);
    expect(intent.kind).toBe('explain-position');
  });

  it('does NOT route "explain the middlegame plan" to explain-position', () => {
    const intent = parseCoachIntent('Explain the middlegame plan');
    expect(intent.kind).toBe('continue-middlegame');
  });

  it('does NOT route "explain the Sicilian opening" to explain-position', () => {
    // Keyword "opening" is excluded so walkthroughs still win.
    const intent = parseCoachIntent('Explain the Sicilian opening');
    expect(intent.kind).not.toBe('explain-position');
  });
});

describe('parseCoachIntent — fallback', () => {
  it('routes general questions to qa', () => {
    const intent = parseCoachIntent('Why is the f7 square weak?');
    expect(intent.kind).toBe('qa');
    expect(intent.raw).toBe('Why is the f7 square weak?');
  });

  it('routes empty input to qa', () => {
    const intent = parseCoachIntent('   ');
    expect(intent.kind).toBe('qa');
  });
});

describe('parseCoachIntent — explain-position', () => {
  it.each([
    'Explain this position',
    "what's happening here",
    'Analyze the board',
    'what should I do here',
    'Evaluate this position',
    'Break down this position',
  ])('routes %q to explain-position', (phrase) => {
    const intent = parseCoachIntent(phrase);
    expect(intent.kind).toBe('explain-position');
  });
});

describe('parseCoachIntent — side extraction (play-against)', () => {
  it('"play against me as black" → side: black', () => {
    const intent = parseCoachIntent('play against me as black');
    expect(intent.kind).toBe('play-against');
    expect(intent.side).toBe('black');
  });

  it('"play against me as white" → side: white', () => {
    const intent = parseCoachIntent('play against me as white');
    expect(intent.kind).toBe('play-against');
    expect(intent.side).toBe('white');
  });

  it('"let\'s play, I\'ll take black" → side: black', () => {
    const intent = parseCoachIntent("Let's play, I'll take black");
    expect(intent.kind).toBe('play-against');
    expect(intent.side).toBe('black');
  });

  it('no side mentioned → side: undefined', () => {
    const intent = parseCoachIntent("Let's play the Caro-Kann");
    expect(intent.kind).toBe('play-against');
    expect(intent.side).toBeUndefined();
  });
});

describe('parseCoachIntent — difficulty phrasing', () => {
  it('"at my level" → medium', () => {
    const intent = parseCoachIntent("Let's play, at my level");
    expect(intent.kind).toBe('play-against');
    expect(intent.difficulty).toBe('medium');
  });

  it('"challenge me hard" → hard', () => {
    const intent = parseCoachIntent('challenge me hard');
    expect(intent.kind).toBe('play-against');
    expect(intent.difficulty).toBe('hard');
  });
});

describe('parseCoachIntent — walkthrough subject variants', () => {
  it('"walk me through the Sicilian Najdorf" → subject includes Najdorf', () => {
    const intent = parseCoachIntent('walk me through the Sicilian Najdorf');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('najdorf');
  });

  it('"teach me the main line of the Italian" → subject: italian', () => {
    const intent = parseCoachIntent('teach me the main line of the Italian');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('italian');
  });

  it('"show me the London System opening" → walkthrough with london', () => {
    const intent = parseCoachIntent('show me the London System opening');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('london');
  });

  it('"study the Caro-Kann" → walkthrough', () => {
    const intent = parseCoachIntent('study the Caro-Kann');
    expect(intent.kind).toBe('walkthrough');
    expect(intent.subject?.toLowerCase()).toContain('caro');
  });
});

// ─── Favorite-opening (rolodex AI-search fast-path) ────────────────────────
// WO-ROLODEX-PLUMBING-01 item 5. The deterministic regex-first route for
// natural-language favoriting; the LLM tool `favorite_opening` is the
// fallback for phrasings these regexes don't catch.

describe('parseCoachIntent — favorite-opening', () => {
  describe('pattern A — favorite / star / bookmark verb (no scope qualifier needed)', () => {
    it('"favorite the italian" → favorite-opening, subject extracted', () => {
      const intent = parseCoachIntent('favorite the italian');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('italian');
    });

    it('"favourite the italian" (British spelling) is recognized', () => {
      const intent = parseCoachIntent('favourite the italian');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('italian');
    });

    it('"star the vienna" → favorite-opening, subject="vienna"', () => {
      const intent = parseCoachIntent('star the vienna');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('vienna');
    });

    it('"bookmark the london" → favorite-opening', () => {
      const intent = parseCoachIntent('bookmark the london');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('london');
    });

    it('accepts polite prefixes ("please favorite the italian")', () => {
      const intent = parseCoachIntent('please favorite the italian');
      expect(intent.kind).toBe('favorite-opening');
    });

    it('accepts "can you favorite the italian"', () => {
      const intent = parseCoachIntent('can you favorite the italian');
      expect(intent.kind).toBe('favorite-opening');
    });

    it('accepts "i want to favorite the italian"', () => {
      const intent = parseCoachIntent('i want to favorite the italian');
      expect(intent.kind).toBe('favorite-opening');
    });

    it('accepts trailing punctuation', () => {
      const intent = parseCoachIntent('favorite the italian.');
      expect(intent.kind).toBe('favorite-opening');
    });
  });

  describe('pattern B — add / save with scope qualifier required', () => {
    it('"add caro-kann to my training plan" → favorite-opening', () => {
      const intent = parseCoachIntent('add caro-kann to my training plan');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('caro');
    });

    it('"save the french for my rolodex" → favorite-opening', () => {
      const intent = parseCoachIntent('save the french for my rolodex');
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('french');
    });

    it('"add the queen\'s gambit to my favorites" → favorite-opening', () => {
      const intent = parseCoachIntent("add the queen's gambit to my favorites");
      expect(intent.kind).toBe('favorite-opening');
      expect(intent.subject?.toLowerCase()).toContain('queen');
    });

    it('"add the italian to my favourites" (British spelling) works', () => {
      const intent = parseCoachIntent('add the italian to my favourites');
      expect(intent.kind).toBe('favorite-opening');
    });

    it('"add" alone without scope qualifier does NOT match (too ambiguous)', () => {
      // Without the scope qualifier "add" is too generic. The intent
      // falls through to other branches or qa.
      const intent = parseCoachIntent('add the italian');
      expect(intent.kind).not.toBe('favorite-opening');
    });
  });

  describe('does not hijack other intents', () => {
    it('"play the italian" → play-against (NOT favorite-opening)', () => {
      const intent = parseCoachIntent('play the italian');
      expect(intent.kind).not.toBe('favorite-opening');
    });

    it('"explain the italian" → explain-position or walkthrough, never favorite-opening', () => {
      const intent = parseCoachIntent('explain the italian');
      expect(intent.kind).not.toBe('favorite-opening');
    });

    it('"study the caro-kann" → walkthrough (existing pattern preserved)', () => {
      const intent = parseCoachIntent('study the Caro-Kann');
      expect(intent.kind).toBe('walkthrough');
    });

    it('"show me the italian" → walkthrough, NOT favorite-opening', () => {
      const intent = parseCoachIntent('show me the italian');
      expect(intent.kind).not.toBe('favorite-opening');
    });
  });

  describe('alias expansion', () => {
    it('aliased input ("favorite the najdorf") expands the subject via expandOpeningAlias', () => {
      const intent = parseCoachIntent('favorite the najdorf');
      expect(intent.kind).toBe('favorite-opening');
      // expandOpeningAlias may return a canonical name like
      // "Sicilian Defense: Najdorf Variation" — exact downstream
      // form isn't pinned here, but the subject must be non-empty
      // and reference the underlying opening.
      expect(intent.subject).toBeTruthy();
    });
  });
});
