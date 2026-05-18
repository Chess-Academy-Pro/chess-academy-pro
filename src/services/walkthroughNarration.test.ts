import { describe, it, expect } from 'vitest';
import {
  pickNarrationText,
  pickCoachHint,
  pickEvaluation,
  trimToSentences,
  isGenericAnnotationText,
} from './walkthroughNarration';
import type { OpeningMoveAnnotation } from '../types';

const STEP_FULL: OpeningMoveAnnotation = {
  san: 'e4',
  annotation: 'White grabs the center. This is a classical opening choice. It opens lines for the bishop.',
  narration: 'White grabs the center with the king pawn. This frees the bishop and queen.',
  shortNarration: 'White takes the center.',
};

const STEP_NO_NARRATION: OpeningMoveAnnotation = {
  san: 'Nf3',
  annotation: 'A flexible developing move. The knight attacks e5. White prepares to castle.',
};

describe('pickNarrationText', () => {
  it('returns empty for silent length', () => {
    expect(pickNarrationText(STEP_FULL, 'silent')).toBe('');
  });

  it('returns empty for null step', () => {
    expect(pickNarrationText(null, 'full')).toBe('');
  });

  it('uses narration field when present for full length', () => {
    expect(pickNarrationText(STEP_FULL, 'full')).toBe(STEP_FULL.narration);
  });

  it('falls back to annotation when narration is absent for full length', () => {
    expect(pickNarrationText(STEP_NO_NARRATION, 'full')).toBe(STEP_NO_NARRATION.annotation);
  });

  it('uses shortNarration field when present for short length', () => {
    expect(pickNarrationText(STEP_FULL, 'short')).toBe(STEP_FULL.shortNarration);
  });

  it('trims annotation to 1 sentence when shortNarration is absent', () => {
    const out = pickNarrationText(STEP_NO_NARRATION, 'short');
    expect(out).toBe('A flexible developing move.');
  });

  it('trims narration (not annotation) when narration is present and shortNarration is not', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'Display version. Display version two.',
      narration: 'Spoken version. Spoken version two.',
    };
    expect(pickNarrationText(step, 'short')).toBe('Spoken version.');
  });
});

describe('pickNarrationText — short-form derivation', () => {
  it('breaks a long single sentence at the first comma when over 28 words', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation:
        'This is the classical king pawn opening where White grabs central space early, opens lines for the bishop and queen, and stakes out real estate in the center so pieces can develop harmoniously.',
    };
    const out = pickNarrationText(step, 'short');
    expect(out).toBe('This is the classical king pawn opening where White grabs central space early.');
  });

  it('leaves short single sentences alone', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'White plays the king pawn.',
    };
    expect(pickNarrationText(step, 'short')).toBe('White plays the king pawn.');
  });

  it('returns empty string when both narration and annotation are missing', () => {
    const step: OpeningMoveAnnotation = { san: 'e4', annotation: '' };
    expect(pickNarrationText(step, 'full')).toBe('');
    expect(pickNarrationText(step, 'short')).toBe('');
  });
});

describe('pickCoachHint', () => {
  it('prefers an explicit coachHint field', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'x',
      coachHint: 'Attack f7 before castling.',
      plans: ['Develop the knight'],
    };
    expect(pickCoachHint(step)).toBe('Attack f7 before castling.');
  });

  it('falls back to the first plan when coachHint is absent', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'x',
      plans: ['Develop knights quickly', 'Castle short'],
    };
    expect(pickCoachHint(step)).toBe('Develop knights quickly');
  });

  it('returns null when no hint source is available', () => {
    const step: OpeningMoveAnnotation = { san: 'e4', annotation: 'x' };
    expect(pickCoachHint(step)).toBeNull();
  });

  it('returns null when coachHint is whitespace and plans is empty', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'x',
      coachHint: '   ',
      plans: [],
    };
    expect(pickCoachHint(step)).toBeNull();
  });

  it('returns null for a null step', () => {
    expect(pickCoachHint(null)).toBeNull();
  });
});

describe('pickEvaluation', () => {
  it('returns the numeric evaluation when present', () => {
    const step: OpeningMoveAnnotation = {
      san: 'e4',
      annotation: 'x',
      evaluation: 28,
    };
    expect(pickEvaluation(step)).toBe(28);
  });

  it('returns null when evaluation is absent', () => {
    const step: OpeningMoveAnnotation = { san: 'e4', annotation: 'x' };
    expect(pickEvaluation(step)).toBeNull();
  });

  it('returns null for a null step', () => {
    expect(pickEvaluation(null)).toBeNull();
  });
});

describe('trimToSentences', () => {
  it('returns the input unchanged when fewer sentences than the cap', () => {
    expect(trimToSentences('One sentence.', 2)).toBe('One sentence.');
  });

  it('keeps only the first N sentences', () => {
    expect(trimToSentences('A. B. C. D.', 2)).toBe('A. B.');
  });

  it('handles question marks and exclamation marks as sentence terminators', () => {
    expect(trimToSentences('A! B? C.', 2)).toBe('A! B?');
  });

  it('returns input unchanged if no sentence terminators found', () => {
    expect(trimToSentences('no terminator', 1)).toBe('no terminator');
  });
});

describe('isGenericAnnotationText — subline generator filler', () => {
  // Each of these is a literal sentence emitted by
  // scripts/generate-subline-annotations.mjs for a warning or trap line.
  // The LLM narrator relies on this detector to know which slots are
  // "fillable" — miss a template here and the user sees robotic
  // "This is the natural continuation" style narration on playback.
  const FILLER_LINES: readonly string[] = [
    // Warning openers
    'White plays Nf3. This is the natural continuation that leads into the warning line.',
    'Black plays d5. This is the natural continuation that leads into the warning line.',
    'White captures with dxe5. This sequence leads to the dangerous line.',
    'Black castles. The position looks normal so far.',
    // Warning mid-line
    'cxd4 — this capture changes the character of the position. Be alert.',
    'Qh5+! Check forces a response. This is where the danger begins.',
    // Warning payoff
    'Nxf7! This is the position you must avoid. White has a dangerous attack. Know this pattern so you can sidestep it earlier.',
    'Qxf7. The damage is done — this is the result you want to prevent. Remember where the critical decision point was earlier in the line.',
    'Nxe5. This is the uncomfortable position that results from this line. Now that you\u2019ve seen it, you\u2019ll know to avoid the pitfall.',
    'Bxf7! This is the move that causes all the trouble.',
    'Qxh7+! Check \u2014 and the position is very dangerous for the defending side.',
    'Nxe5. The position is now very difficult. This is the warning \u2014 don\u2019t let your opponent reach this.',
    'Nc3. We\u2019re approaching the critical position. Pay close attention to the next moves \u2014 this is where the danger lies.',
    // Trap setup
    'Black castles, preparing for the middlegame while the trap is being set.',
    'White captures with dxe5. This exchange is part of the trap setup.',
    'White plays Nc3, establishing the position. The key moment is approaching.',
    'White gives check with Qh5! This is a critical moment in the trap.',
    'Black castles. The position looks safe, but danger lurks.',
    // Trap payoff
    'Qxf7#! And this is the final blow. White delivers check and wins material. This is why the Lasker Trap is so dangerous \u2014 memorize this pattern!',
    'Nxe5! White wins material. The trap is complete. Remember this pattern \u2014 your opponents will fall for it.',
    'Qd8#! The trap is sprung. White has a winning position. This is the key takeaway from the Fried Liver.',
    'Nxf7! Now the trap is revealed. White wins material with this capture.',
    'Qxf7+! Check! The trap is sprung \u2014 there\u2019s no good defense here.',
    'Bxf7+! This is the critical move that springs the trap. The opponent is in serious trouble.',
    'Nxe5. This is where the trap begins. The next two moves are the key sequence you need to memorize.',
    // User-reported (fall-through from earlier pattern list):
    'White plays Nf3. The critical moment is approaching.',
    'Black plays d5 and the trap is being set.',
    'Nc3 — the trap is being set in motion.',
    'White plays Bc4, developing normally. The opponent might not see what\u2019s coming.',
    'Black plays e5 — the opponent won\u2019t see what\u2019s coming.',
    'White plays d4. This is a critical moment in the trap.',
    'Nf3. This is a critical moment where precise play is essential.',
    // Bare "Side plays SAN." fallback
    'White plays Nf3.',
    'Black plays d5.',
    // 2026-05-18 deep-walk audit — hardcoded-piece templates that
    // describe the wrong piece on the wrong square. The offline
    // generator embedded these on plies where the actual move is
    // a totally different piece (e.g. "White moves the bishop to e3"
    // on a g4 pawn push, "Black develops the queen to h4" on a Ne7
    // knight move). Suppress so the LLM enricher can replace.
    'White moves the bishop to e3. The bishop on e3 controls key diagonal squares and maintains active piece play.',
    'White moves the queen to f2. The queen takes up an influential position on f2, eyeing multiple targets.',
    'Black develops the queen to h4. The queen takes up an influential position on h4, eyeing multiple targets. This also checks the king, creating tactical pressure.',
    'White takes on h4, removing Black’s queen. The queen takes up an influential position on h4, eyeing multiple targets.',
    "Black moves the rook to e8. The rook takes up a powerful position on the e-file, pressuring White's position.",
    'White wins the piece on d8, removing Black’s queen. This also gives check, disrupting the opponent’s coordination. The queen takes up an influential position on d8, eyeing multiple targets.',
    'Black wins the piece on g5, removing White’s knight. The bishop on g5 controls key diagonal squares and maintains active piece play.',
    'fxe5 captures the pawn. This exchange is thematic in the Najdorf: Poisoned Pawn — it defines the resulting pawn structure and piece activity.',
    'Black develops the bishop to a safe square, preparing to castle kingside. The bishop on e7 is somewhat passive but solid, defending the kingside and maintaining flexibility.',
    'Black castles kingside, bringing the king to safety and activating the rook. this move completes Black’s basic development and prepares to challenge White’s central control.',
    // 2026-05-18 round 2 of generator-template suppression — sentences
    // that appear 5-69× across distinct sublines (generator filler).
    'The knight reaches a powerful central outpost on d4, controlling multiple key squares.',
    "The rook takes up a powerful position on the e-file, pressuring Black's position.",
    'This is a key positional idea.',
    'From here, understanding the strategic plans — piece placement, pawn breaks, and targets — is essential.',
    "cxd4 completes the variation. The resulting position after this capture offers Black clear targets and plans. Study this structure — you'll see it often in the Milner-Barry.",
    'black brings the bishop to its natural square on a5. the bishop on a5 controls key diagonal squares and maintains active piece play.',
    'white deploys the knight to f5. the knight reaches a powerful central outpost on f5, controlling multiple key squares.',
    "White castles kingside, bringing the king to safety while activating the rook for the upcoming attack. This calm move ignores Black's material gain and focuses on rapid piece coordination.",
  ];

  for (const line of FILLER_LINES) {
    it(`detects filler: ${line.slice(0, 60)}\u2026`, () => {
      expect(isGenericAnnotationText(line)).toBe(true);
    });
  }

  it('does NOT flag real curated commentary', () => {
    // Real content that mentions squares, motifs, or plans — must stay.
    const CURATED: readonly string[] = [
      'The knight on f3 eyes e5 and blunts a future Bg4 pin while clearing the way for short castling.',
      'Nf3 defends e5 and prepares to meet ...Nc6 with a timely d4, seizing the full center.',
      'Black chooses the Scandinavian, immediately challenging White\u2019s e-pawn to dissolve the classical center.',
      '0-0 hides the king on the g1 diagonal and connects the rooks along the back rank.',
    ];
    for (const text of CURATED) {
      expect(isGenericAnnotationText(text)).toBe(false);
    }
  });

  it('returns false for empty/whitespace input', () => {
    expect(isGenericAnnotationText(undefined)).toBe(false);
    expect(isGenericAnnotationText('')).toBe(false);
    expect(isGenericAnnotationText('   ')).toBe(false);
  });
});
