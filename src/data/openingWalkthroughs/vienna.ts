/**
 * Vienna Game (ECO C25–C29) — hand-crafted opening walkthrough tree.
 *
 * ─── LEGACY ARCHITECTURE — DO NOT EXTEND ────────────────────────
 *
 * This is the ONLY hand-crafted static walkthrough left in the
 * codebase. New openings should NOT clone this pattern — they
 * route through `generateOpeningFromDbNarration` in
 * `services/openingGenerator.ts`, which builds the tree skeleton
 * from `openings-lichess.json` (moves are legal by DB construction)
 * and asks the LLM only to write narration text. That's the
 * post-inversion pattern documented in CLAUDE.md's DON'T BREAK
 * section.
 *
 * Why is this file still here?
 *   1. The Vienna walkthrough is the user's primary opening and
 *      this hand-crafted version has been heavily tested. Removing
 *      it would replace tested content with LLM-generated content
 *      whose quality hasn't been validated for parity.
 *   2. The 5 punish lessons (Stage 5: Ng4? / Nh5? / Nd5? / Ne4? /
 *      Nxe4?) are written with chess-coach precision that the
 *      DB-mined puzzle path can't currently match.
 *   3. CoachTeachPage.tsx's resolver still calls
 *      `resolveWalkthroughTree(name)` as Tier 1 — falling back to
 *      DB cache then runtime gen. That order means Vienna users
 *      hit this static tree before the DB path runs.
 *
 * Migration path (Tier 3 of the trap-data taxonomy cleanup,
 * deferred):
 *   1. Run a parity audit comparing the hand-crafted Vienna tree
 *      against `generateOpeningFromDbNarration('Vienna Game')`
 *      output. Score: narration quality, punish-stage coverage,
 *      arrow placement.
 *   2. If parity is acceptable, remove `VIENNA_GAME` from
 *      `index.ts` and let Vienna requests fall through to the DB
 *      path. Keep this file as a template / reference for future
 *      hand-crafted authoring if needed.
 *   3. If parity is NOT acceptable, identify the gap (likely the
 *      hand-written `idea` prose) and tighten the DB-narration
 *      prompt to close it.
 *
 * Voice/style for the existing content: this is the coach speaking.
 * Plain language, real teaching content, no length cap, no
 * template. Each `idea` reads like how a strong coach actually
 * explains the move to a 1200-1600 player who said "teach me the
 * Vienna." Names squares, names ideas, calls out what to watch for.
 *
 * Tree shape:
 *   start → 1.e4 → 1...e5 → 2.Nc3 → FORK on Black's response
 *     ├── 2...Nf6 → FORK on White's third
 *     │   ├── 3.f4 (Vienna Gambit, sharp) → 3...d5 / 3...exf4 paths
 *     │   └── 3.Bc4 (Italian-style, quieter) → center fork trick
 *     ├── 2...Nc6 (most common amateur)
 *     └── 2...Bc5 (Italian-style as Black)
 *
 * FENs are computed at runtime by walking chess.js through the SANs
 * — see useTeachWalkthrough. So this file declares moves only.
 */
import type { WalkthroughTree } from '../../types/walkthroughTree';

export const VIENNA_GAME: WalkthroughTree = {
  openingName: 'Vienna Game',
  eco: 'C25',
  studentSide: 'white',
  intro:
    "The Vienna Game. It's the King's Pawn opening's quieter, sharper cousin — quieter because we develop a knight before the bishop, sharper because we keep the f-pawn free for an attack. Most beginners learn the Italian or the Spanish; the Vienna is what you play when you want the same classical pressure but with a tactical engine humming under the hood. Let me walk you through it.",
  outro:
    "That's a typical position you'd see in this branch. Want to back up to the last decision and see the other line? Or take this position into a real game against me?",
  leafOutros: {
    // Vienna Gambit accepted main line — after 4.e5 every Black knight
    // square except Ng8 hangs material to the open d1-h5 diagonal. The
    // gambit is honestly bad for Black; we ship White's huge advantage.
    'e4 e5 Nc3 Nf6 f4 exf4 e5 Ng8 Nf3':
      "And there it is — the Vienna Gambit accepted, the truth of the line. Black's knight is buried back on g8, having spent two tempi for nothing. We have a huge lead in development, the open f-file (the f-pawn we gave up clears the file for our rook on f1), and the f4-pawn (Black's prize) is just a target waiting to be picked off. From here White's plan: Bc4 eyeing f7, castle, take f4 with the c1-bishop, then attack down the f-file. Black is just worse — at master level the gambit accepted is considered theoretically bad for Black, which is why most strong Black players play the Falkbeer (3...d5) instead. Now you know why.",
    // Falkbeer Variation modern challenge — 5.Qf3 attacks the e4-knight
    // directly, forcing Black to commit on move five. Sharper than 5.Nf3
    // (the older calm move) and the line preferred by modern theory.
    'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Qf3':
      "And there's the modern Falkbeer challenge. Queen on f3, Black's knight on e4 with no defenders, Black forced to commit. The line goes deep from here — Black's main responses are 5...Nxc3 (the trade, leading to a balanced middlegame with doubled c-pawns for white), 5...f5 (sharp defense, weakens the king but holds the knight), or 5...Nc5 (passive retreat, white develops with tempo). All three are real and worth knowing, but the position TO know is THIS one — because the queen on f3 is what makes the gambit declined sharp instead of comfortable for Black. Now you know why most strong Black players don't decline the Vienna Gambit; they take with exf4 and grind out the resulting positions.",
    // Center fork trick line through to the typical middlegame.
    // Open position with bishop pair vs piece coordination — clean
    // educational moment.
    'e4 e5 Nc3 Nf6 Bc4 Nxe4 Nxe4 d5 Bxd5 Qxd5 d3 Nc6 Nf3 Bf5 O-O O-O-O d4':
      "Material is even — you traded the bishop for the pawn, then Black recovered the knight with the d5 fork. Black walked out with the bishop pair (a small long-term plus). We've now reached the typical center fork trick middlegame: opposite-side castled kings (white short, black long), Black's bishop pair vs White's piece coordination, the d4 break opening lines. Both sides have a clear plan. This is exactly why most Vienna players prefer 4.d3 instead of 4.Nf3 against the 2...Nc6 line — to avoid this whole sequence. Now you know the trap. Back up and try 3.Bc4 against 2...Nc6 instead, or play this position out against me?",
    // 2...Bc5 calm Italian-Vienna — symmetrical Italian structure
    // with the Vienna's Nc3 as the asymmetry. Reached when Black
    // mirrors with the bishop early and we develop normally.
    'e4 e5 Nc3 Bc5 Nf3 Nf6 Be2 Nc6 d3 d6 O-O O-O':
      "And there's the calm Italian-Vienna. Both kings castled, e4-pawn doubly defended (Nc3 + d3) so the center fork trick is dead. The asymmetry — what we have over a normal Italian — is the knight already on c3 ready for Nd5 or supporting d4. From here you have three real plans: Be3 to challenge the dark-bishop, Nd5 to plant a knight in the heart of Black's position, or h3 + g4 to start a slow kingside attack. All real, all winnable. Want to play it out?",
    // Italian-Vienna middlegame — both kings castled, doubled
    // e-pawns the cost of opening the f-file, dark-square bishop
    // gone on both sides. This is a position you should know cold:
    // the textbook Vienna setup with a clear plan.
    'e4 e5 Nc3 Nc6 Bc4 Nf6 d3 Bc5 Be3 Bxe3 fxe3 d6 Nf3 O-O O-O Bg4 h3':
      "And there it is — the Vienna middlegame in its purest form. Both kings castled, dark-square bishops traded off (which suits us — we have the open f-file as compensation for the doubled e-pawns), the c4-bishop still pointing at f7. From here Black has to decide whether to trade on f3 (giving us the queen on f3 hitting f7 and ready to swing) or retreat to h5 (and we play g4 to chase it further). Either way, our middlegame plan is set: double the rooks on the f-file, push d4 to break the center when ready, swing the queen to h5 or g3. This is the position to know cold. Want to play it out from here as a real game?",
  },

  // ─── Stage 2: Concept check questions ─────────────────────────
  // Big-idea quizzes after the walkthrough. Tests whether the
  // student internalized the WHY, not just the moves.
  concepts: [
    {
      prompt:
        "Why does the Vienna play 2.Nc3 instead of the more natural 2.Nf3? (Pick all that apply.)",
      multiSelect: true,
      choices: [
        {
          text: "It develops a piece toward the center.",
          correct: true,
          explanation:
            "Yes — Nc3 develops a knight to a useful central square. Same as any opening principle.",
        },
        {
          text: "It defends the e4-pawn.",
          correct: true,
          explanation:
            "Right — Nc3 supports e4 in case Black tries ...Nf6 attacking it. We have a defender ready.",
        },
        {
          text: "It leaves the f-pawn free for a later f4 push.",
          correct: true,
          explanation:
            "This is the BIG ONE. In the Italian (Nf3), the f-pawn is locked behind the knight forever. In the Vienna, f4 is on the table from move 3 onward.",
        },
        {
          text: "It directly threatens to win Black's knight.",
          correct: false,
          explanation:
            "No — Nc3 doesn't attack any Black piece on move 2. The threat comes later through the f4 break or central tactics, never on move 2 itself.",
        },
      ],
    },
    {
      prompt: "What's the central idea behind the Vienna Gambit (3.f4)?",
      choices: [
        {
          text: "Open lines for an attack on Black's king side.",
          correct: true,
          explanation:
            "Exactly. We sacrifice the f-pawn to open the f-file (after exf4 captures away our f-pawn), free the dark-squared bishop, and create attacking chances along the f-file and the d1-h5 diagonal. Material for activity.",
        },
        {
          text: "Lock the center pawn structure.",
          correct: false,
          explanation:
            "Opposite of what happens — the gambit OPENS the center, not closes it. Lockdowns are for slower openings like the French or the Old Indian.",
        },
        {
          text: "Force Black to trade queens immediately.",
          correct: false,
          explanation:
            "No queen trade is forced. The gambit is about activity for material, not exchanges.",
        },
        {
          text: "Win the e5-pawn after exf4.",
          correct: false,
          explanation:
            "We're not playing for material — we're SACRIFICING the f-pawn. Winning e5 isn't the point; activity is.",
        },
      ],
    },
    {
      prompt:
        "Why do most Vienna players prefer 4.d3 instead of 4.Nf3 against the 2...Nc6 line?",
      choices: [
        {
          text: "To kill the center fork trick (3.Bc4 Nxe4 4.Nxe4 d5) before it starts.",
          correct: true,
          explanation:
            "Right. After 4.d3, the e4-pawn has TWO defenders (the c3-knight AND the d3-pawn), so 4...Nxe4 just loses a piece. With 4.Nf3, e4 has only one defender, and Black's Nxe4 → d5 fork costs us the bishop pair.",
        },
        {
          text: "To prepare a quick queenside castle.",
          correct: false,
          explanation:
            "We castle short in the Vienna, not long. d3 isn't related to castling preparation.",
        },
        {
          text: "Because Nf3 blocks the f-pawn.",
          correct: false,
          explanation:
            "True statement, but not why we play d3 here. We CAN play Nf3 in many Vienna lines (the 2...Bc5 branch, for example). The d3 specifically defends e4.",
        },
        {
          text: "To threaten d4 next move.",
          correct: false,
          explanation:
            "We're not really threatening d4 — d3 is a one-move-at-a-time defensive move. The threat is the absence of the fork trick.",
        },
      ],
    },
    {
      prompt:
        "When can White safely push f4 in the Vienna with Black's bishop on c5?",
      choices: [
        {
          text: "After we trade off Black's c5-bishop (e.g. with Be3 Bxe3 fxe3).",
          correct: true,
          explanation:
            "Exactly. Pushing f4 with a Black bishop on c5 alive is a blunder — it opens the long a7-g1 diagonal and our knight on g1 hangs to ...Bxg1. So we trade the bishop FIRST. Be3 challenges it head-on; if Black trades, we recapture with the f-pawn opening the f-file as a bonus.",
        },
        {
          text: "Anytime after move 3 — Nc3 supports f4 indirectly.",
          correct: false,
          explanation:
            "Not safe — Nc3 doesn't address the Bc5 diagonal threat. With Bc5 alive, f4 hangs the knight on g1.",
        },
        {
          text: "Only after Black castles short.",
          correct: false,
          explanation:
            "Black's castling doesn't change the c5-bishop's diagonal attack. The bishop has to move or trade BEFORE we push f4.",
        },
        {
          text: "Never — the Vienna can't push f4 against ...Bc5.",
          correct: false,
          explanation:
            "Too pessimistic — we CAN push f4 once the c5-bishop is gone. We just have to trade it first.",
        },
      ],
    },
  ],

  // ─── Stage 3: Find the move (recognition) ──────────────────────
  // Tests pattern recognition before motor recall. Each candidate
  // gets an idea-label so the student is choosing between concepts,
  // not just memorizing a SAN.
  findMove: [
    {
      path: ['e4', 'e5'],
      prompt: "White to play. Which move starts the Vienna?",
      candidates: [
        {
          san: 'Nc3',
          label: 'Nc3 — Vienna setup',
          correct: true,
          explanation:
            "Yes — the defining Vienna move. Develops, defends e4, and crucially leaves the f-pawn free for a future f4 break.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — Italian/Spanish setup',
          correct: false,
          explanation:
            "Solid move, but it locks the f-pawn behind the knight. You're now in Italian/Spanish territory, not the Vienna. The whole point of the Vienna is keeping f4 available.",
        },
        {
          san: 'Bc4',
          label: 'Bc4 — Italian-style bishop first',
          correct: false,
          explanation:
            "Skips the knight development. Bishop's a fine square but you've lost a tempo for the Vienna structure.",
        },
        {
          san: 'd4',
          label: 'd4 — Center Game',
          correct: false,
          explanation:
            "That's the Center Game (or Scotch with the wrong move order). Different opening, different ideas.",
        },
      ],
    },
    {
      path: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4'],
      prompt:
        "Black just took the gambit pawn with exf4. What does White play next?",
      candidates: [
        {
          san: 'e5',
          label: 'e5 — kick the f6-knight first',
          correct: true,
          explanation:
            "Correct! Push e5 BEFORE developing. The knight on f6 has to move, and every square except Ng8 hangs material to our queen along the open d1-h5 diagonal. This is the foundational Vienna Gambit move-order lesson.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — defend against Qh4+ first',
          correct: false,
          explanation:
            "The right idea (we do need to neutralize Qh4+) but the wrong move ORDER. Push e5 first to kick the knight; THEN play Nf3 once Black's knight has moved. Playing Nf3 first lets Black develop normally while you've gained nothing on tempo.",
        },
        {
          san: 'd4',
          label: 'd4 — open the center',
          correct: false,
          explanation:
            "Doesn't address Qh4+ and doesn't gain tempo. The center push is right idea, wrong moment.",
        },
        {
          san: 'Bc4',
          label: 'Bc4 — develop the bishop',
          correct: false,
          explanation:
            "Solid developing move but it lets Black's f6-knight stay aggressively placed. The kicking move e5 has to come first; develop after.",
        },
      ],
    },
    {
      path: ['e4', 'e5', 'Nc3', 'Nf6', 'Bc4', 'Nxe4', 'Nxe4', 'd5', 'Bxd5', 'Qxd5'],
      prompt:
        "Black just played Qxd5. Their queen attacks our e4-knight! What's White's only good move?",
      candidates: [
        {
          san: 'd3',
          label: 'd3 — defend the knight in place',
          correct: true,
          explanation:
            "Right — the d3-pawn supports the knight. Black can't take Nxe4 because we'd recapture with the pawn. We keep the piece and continue developing.",
        },
        {
          san: 'Nc3',
          label: 'Nc3 — retreat the knight',
          correct: false,
          explanation:
            "Looks safe but actually loses material! Once the knight retreats, the d5-queen has a clean diagonal all the way to g2. Qxg2 wins our pawn AND attacks the rook on h1. The defend-in-place move (d3) is the only safe one.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop and ignore',
          correct: false,
          explanation:
            "Just hangs the e4-knight. Black plays Qxe4+ winning a clean piece. Always check what your opponent's last move attacks before developing.",
        },
        {
          san: 'Qf3',
          label: 'Qf3 — challenge the queen',
          correct: false,
          explanation:
            "Active but doesn't defend e4. Black trades queens and is up a piece. The defend-in-place pawn move is much simpler.",
        },
      ],
    },
    {
      path: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5', 'Nh5'],
      prompt:
        "Black just played 4...Nh5 trying to defend f4. What's the punishment?",
      candidates: [
        {
          san: 'Qxh5',
          label: 'Qxh5 — queen takes the knight',
          correct: true,
          explanation:
            "Yes! The d1-queen marches all the way down the open diagonal: d1 → e2 → f3 → g4 → h5, every square empty after the f-pawn left. Free knight. Black has no recapture. This is the Vienna Gambit's recurring lesson — when a pawn move opens a diagonal, recount what's on it.",
        },
        {
          san: 'Bc4',
          label: 'Bc4 — develop the bishop',
          correct: false,
          explanation:
            "Develops but ignores the free knight on h5. When you have a free piece, take it. Development continues after the capture.",
        },
        {
          san: 'g4',
          label: 'g4 — kick the knight',
          correct: false,
          explanation:
            "Misses the win. The knight just retreats (Nf6 back home or Ng7) and you've spent a tempo on a kick when you could have just captured.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop normally',
          correct: false,
          explanation:
            "Misses the free piece. Always look for captures FIRST when it's your move. Development is automatic; tactics aren't.",
        },
      ],
    },
    {
      path: ['e4', 'e5', 'Nc3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5'],
      prompt:
        "Black just played Bc5. Now we want to push f4 eventually — what should White play first?",
      candidates: [
        {
          san: 'Be3',
          label: 'Be3 — challenge the c5-bishop',
          correct: true,
          explanation:
            "Right. Pushing f4 directly with Bc5 alive opens the long a7-g1 diagonal and our knight on g1 hangs to Bxg1. So we trade the bishop first. After Bxe3 fxe3, the f-pawn already moved (recapture), the bishop is gone, AND we have the open f-file for free.",
        },
        {
          san: 'f4',
          label: 'f4 — push directly',
          correct: false,
          explanation:
            "Loses material! After f4, the f2-square clears and Black plays Bxg1 winning our knight. ALWAYS check the long diagonals before pushing pawns that open them.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop the knight',
          correct: false,
          explanation:
            "Solid but it locks the f-pawn behind the knight forever. You've just turned your Vienna into an Italian. The whole reason we played Nc3 was to keep f4 available.",
        },
        {
          san: 'h3',
          label: 'h3 — kingside expansion',
          correct: false,
          explanation:
            "Premature — h3 is useful later (preventing ...Bg4 once Black develops the bishop) but right now we have a more pressing concern: the c5-bishop's diagonal threatens our king position.",
        },
      ],
    },
  ],

  // ─── Stage 4: Drill the line (woodpecker) ──────────────────────
  // Full SAN sequences from the starting position. The student plays
  // White; the runtime auto-plays Black. Wrong move resets to that
  // position. Five lines = the five branches we taught, drillable
  // until automatic.
  drill: [
    {
      name: 'Italian-Vienna (vs 2...Nc6)',
      subtitle: 'Most common amateur reply — through to middlegame',
      moves: [
        'e4', 'e5', 'Nc3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5',
        'Be3', 'Bxe3', 'fxe3', 'd6', 'Nf3', 'O-O', 'O-O', 'Bg4', 'h3',
      ],
    },
    {
      name: 'Vienna Gambit Declined (Falkbeer, modern)',
      subtitle: '1.e4 e5 2.Nc3 Nf6 3.f4 d5 — through 5.Qf3',
      moves: [
        'e4', 'e5', 'Nc3', 'Nf6', 'f4', 'd5', 'fxe5', 'Nxe4', 'Qf3',
      ],
    },
    {
      name: 'Vienna Gambit Accepted',
      subtitle: 'When Black takes the bait — Ng8 forced',
      moves: [
        'e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5', 'Ng8', 'Nf3',
      ],
    },
    {
      name: 'Center Fork Trick — White defends correctly',
      subtitle: 'Through opposite-side castled middlegame',
      moves: [
        'e4', 'e5', 'Nc3', 'Nf6', 'Bc4', 'Nxe4', 'Nxe4', 'd5',
        'Bxd5', 'Qxd5', 'd3', 'Nc6', 'Nf3', 'Bf5', 'O-O', 'O-O-O', 'd4',
      ],
    },
    {
      name: 'Calm Italian-Vienna (vs 2...Bc5)',
      subtitle: 'Symmetric Italian-style with Vienna asymmetry',
      moves: [
        'e4', 'e5', 'Nc3', 'Bc5', 'Nf3', 'Nf6', 'Be2', 'Nc6',
        'd3', 'd6', 'O-O', 'O-O',
      ],
    },
  ],

  // ─── Stage 5: Punish inaccuracies ──────────────────────────────
  // The "book in front of the LLM" stage. For each common amateur
  // mistake: the SETUP that leads to the mistake, WHY the mistake is
  // bad (the principle, not just the tactic), the PUNISHMENT, why
  // it works (the principle again), distractor moves that look
  // plausible but miss, and the FOLLOWUP showing how the win
  // materializes. This is where intermediate players become advanced.
  punish: [
    {
      name: "4...Ng4? — the active retreat that hangs",
      kind: 'trap',
      setupMoves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5'],
      inaccuracy: 'Ng4',
      whyBad:
        "Black thinks the knight on g4 is 'active' — eyeing f2, supporting a future Qh4+ check. But Black missed a critical fact: when the f-pawn left f2 (way back on move 3), the d1-queen got an open diagonal pointing right at the kingside. d1 → e2 → f3 → g4 — every square empty. The knight on g4 is just a piece sitting at the end of that diagonal with NO defender. The 'active retreat' is actually an active hang. This is a recurring trap throughout chess: when a pawn move opens a line, immediately recount the attackers and defenders along that newly-opened line. Black neglected to.",
      punishment: 'Qxg4',
      whyPunish:
        "Queen takes knight, end of discussion. Black has no recapture — no Black piece attacks g4 right now. We go from down a pawn (the gambit) to up a clean knight. The recurring chess principle: ALWAYS look for captures first when it's your move. Tactics live ahead of strategy. The lesson Black needs to learn from this game is the diagonal-counting habit.",
      distractors: [
        {
          san: 'Nf3',
          label: 'Nf3 — develop and shut Qh4+',
          explanation:
            "Misses the free piece. Right idea on the SECOND-best move (Nf3 IS what we'd play if Black retreated to Ng8), but here we have a tactic. Always look for captures first.",
        },
        {
          san: 'd4',
          label: 'd4 — push for the center',
          explanation:
            "Walks past the free knight. The center push is right idea for the Vienna, wrong moment when there's a free piece on the board.",
        },
        {
          san: 'h3',
          label: 'h3 — kick the knight',
          explanation:
            "Why kick a piece you can capture? After h3, the knight retreats and you've spent a tempo for nothing instead of winning material.",
        },
      ],
      followup: [
        {
          san: 'd5',
          idea:
            "Black's only counter-shot is something desperate like ...d5 trying to open lines. Doesn't matter — you're a piece up.",
        },
        {
          san: 'd3',
          idea:
            'Solid response — defend e4, finish development, convert the piece advantage.',
        },
      ],
    },
    {
      name: "4...Nh5? — same diagonal, same fate",
      kind: 'trap',
      setupMoves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5'],
      inaccuracy: 'Nh5',
      whyBad:
        "Black tries Nh5 with the same idea as Ng4 — defend f4, prepare g6/Bg7 setup. And the same lesson applies, sharper this time: the d1-queen's diagonal extends ALL the way to h5. d1 → e2 → f3 → g4 → h5, four empty squares. The knight on h5 is at the very end of that diagonal, undefended, asking to be taken. The structural lesson is the same as Ng4 but it's worth seeing twice — when an opening pawn move clears a long diagonal, that's the FIRST thing to check before committing pieces nearby.",
      punishment: 'Qxh5',
      whyPunish:
        "Queen marches all the way to h5 and takes the knight. No recapture. Free piece, same as Ng4. Two examples of the same principle: in any Vienna Gambit accepted, if Black puts a knight on g4 OR h5, the d1-queen wins it. The principle generalizes: open diagonals in YOUR favor are the strongest piece-winning weapons in chess.",
      distractors: [
        {
          san: 'g4',
          label: 'g4 — kick before taking',
          explanation:
            "g4 attacks the knight, but we can just take it directly with the queen. Don't waste a tempo on a kick when capture is available.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop',
          explanation:
            "Misses the free piece AGAIN. The lesson keeps repeating: captures first, development second.",
        },
        {
          san: 'd3',
          label: 'd3 — defend e4',
          explanation:
            "Solid-looking move that ignores the free knight. Always look for captures FIRST.",
        },
      ],
      followup: [
        {
          san: 'd6',
          idea:
            "Black tries to develop and hope. Doesn't matter — you're up a piece.",
        },
        {
          san: 'Nf3',
          idea:
            'Now develop — bring the second knight out, prepare Bc4 and castling. Consolidate.',
        },
      ],
    },
    {
      name: "4...Nd5? — another knight square that just loses",
      kind: 'trap',
      setupMoves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5'],
      inaccuracy: 'Nd5',
      whyBad:
        "Different square, different attacker, same loss. Black centralizes the knight on d5 hoping for activity, but Nd5 is attacked by our c3-knight AND has zero defenders (Black's d-pawn is still on d7, blocking the queen from defending vertically). The lesson: when you move a piece to a square, count BOTH the attackers (who can take it) and the defenders (who can recapture). One attacker + zero defenders = lost piece.",
      punishment: 'Nxd5',
      whyPunish:
        "Knight takes knight cleanly. Black has no recapture: ...Qxd5 is illegal (d7-pawn blocks), no other pieces reach d5. Up a knight, the rest is conversion. The lesson sticks: in the Vienna Gambit accepted line, the f-pawn's departure opened diagonals AND your own c3-knight controls the central squares. Black's knight has nowhere to go.",
      distractors: [
        {
          san: 'Nf3',
          label: 'Nf3 — develop',
          explanation:
            "Misses the free knight. Develops, but Black's knight on d5 was just sitting there asking to be taken. Captures first, every time.",
        },
        {
          san: 'd4',
          label: 'd4 — push for center',
          explanation:
            "Push misses the free piece. The center push is right idea for the Vienna long-term, wrong moment when there's a free knight on d5.",
        },
        {
          san: 'Bc4',
          label: 'Bc4 — develop the bishop',
          explanation:
            "Misses the free knight. Always look for captures first when it's your move.",
        },
      ],
      followup: [
        {
          san: 'Qe7',
          idea:
            "Black tries Qe7 hoping to trade some pieces. Whatever — you're a knight up.",
        },
        {
          san: 'Nf3',
          idea:
            'Develop the second knight, prepare castling. Convert the piece.',
        },
      ],
    },
    {
      name: "4...Ne4? — last of the failed knight tries",
      kind: 'trap',
      setupMoves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4', 'e5'],
      inaccuracy: 'Ne4',
      whyBad:
        "Black moves the knight to e4 hoping to attack our c3-knight. But Black missed: their knight on e4 is itself attacked by our c3-knight, and Black has zero defenders for it. So Black is offering a knight trade where THEY lose the piece, not us. This is the fourth variation of the same lesson: every Black knight square except Ng8 in this position hangs to White's superior piece coordination.",
      punishment: 'Nxe4',
      whyPunish:
        "Knight takes knight, end of story. Black has no recapture (no piece attacks e4). We've now seen four flavors of the same principle in this exact position: Ng4 hangs to the queen, Nh5 hangs to the queen, Nd5 hangs to the c3-knight, Ne4 hangs to the c3-knight. Black's ONLY non-losing move was Ng8 — pure passive retreat. That's why the Vienna Gambit accepted is theoretically refuted at master level.",
      distractors: [
        {
          san: 'd3',
          label: 'd3 — kick the knight',
          explanation:
            "Yes, d3 attacks the knight, BUT capture is available. Why kick when you can take? Always check captures first.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop the second knight',
          explanation:
            "Develops nicely but ignores the free knight on e4. Always check for captures FIRST. The four-times-in-a-row lesson.",
        },
        {
          san: 'Bc4',
          label: 'Bc4 — develop the bishop',
          explanation:
            "Develops the bishop but ignores the free knight. The lesson, four times in a row: captures first.",
        },
      ],
    },
    {
      name: "6...Nxe4? — the 'free pawn' that wasn't",
      kind: 'mistake',
      setupMoves: [
        'e4', 'e5', 'Nc3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5',
        'Be3', 'Bxe3', 'fxe3',
      ],
      inaccuracy: 'Nxe4',
      whyBad:
        "Black sees the e4-pawn 'unprotected' and grabs it with the f6-knight. Classic amateur blunder, and it teaches the most important counting principle in chess. Black counted ONE attacker on e4 (their own f6-knight) — but missed that e4 has TWO defenders: the c3-knight AND the d3-pawn. With more defenders than attackers, the pawn is poison. This is the universal opening lesson: BEFORE you grab a 'free' pawn, count attackers, count defenders. If defenders ≥ attackers, the pawn isn't free — it's a hook to win YOUR piece.",
      punishment: 'Nxe4',
      whyPunish:
        "Knight takes knight. Black is now down a piece for a single pawn — a catastrophic trade. The structural lesson: 'Looks free' is not a chess concept. 'Has more attackers than defenders' is. This SAME principle applies in the middlegame, the endgame, and tactical puzzles for the rest of your chess life. Internalize it now.",
      distractors: [
        {
          san: 'dxe4',
          label: 'Pawn takes (dxe4)',
          explanation:
            "Also wins the knight, but it removes our d3-pawn from the position. Knight recapture is cleaner: it keeps our pawn structure intact and our knight stays in the center. Always prefer the cleaner recapture.",
        },
        {
          san: 'Bxf7+',
          label: 'Bxf7+ — counter-sacrifice',
          explanation:
            "Loses a bishop for one pawn — a panic move that makes the position WORSE. When you have a free piece coming, just take it. Don't get fancy.",
        },
        {
          san: 'Nf3',
          label: 'Nf3 — develop and ignore',
          explanation:
            "Develops the kingside knight but ignores the free piece on e4. Captures first, every time.",
        },
      ],
      followup: [
        {
          san: 'd6',
          idea:
            "Black tries to develop and pretend nothing happened. Doesn't matter — you're up a piece.",
        },
        {
          san: 'Nf3',
          idea:
            'Develop the kingside knight, prepare castling. Convert the material advantage with simple, accurate play.',
        },
        {
          san: 'O-O',
          idea:
            "Black plays it later — castle, exchange pieces if you can, simplify to a winning endgame. A piece up at this stage is a comfortably winning advantage.",
        },
      ],
    },
  ],

  root: {
    san: null,
    movedBy: null,
    idea: '',
    children: [
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea:
            "1.e4 — King's pawn forward, claiming the center and opening lines for the bishop on f1 and the queen on d1. Standard fundamentals. The Vienna won't show its colors until move 2, so for now this just looks like every other 1.e4 game.",
          children: [
            {
              node: {
                san: 'e5',
                movedBy: 'black',
                idea:
                  "Black mirrors with 1...e5, contesting the center directly. This is the most principled response — Black says 'I'm not letting you set up shop in the center without a fight.' Other Black moves (the Sicilian, the French, the Caro-Kann) are for a different lesson.",
                children: [
                  {
                    node: {
                      san: 'Nc3',
                      movedBy: 'white',
                      idea:
                        "2.Nc3 — and here's where the Vienna actually starts. The natural move at this point is Nf3 (the Italian and the Spanish both go there), but we play Nc3 instead. Why? Three reasons. One: it develops a piece. Two: it defends e4 in case Black later threatens it. Three — and this is the big one — it leaves the f-pawn FREE. In the Italian, after Nf3, the f-pawn is locked behind the knight forever; you can never push f4 without first moving the knight. In the Vienna, f4 is on the table from move three onward. That's the whole opening: a kingside pawn storm waiting to happen.",
                      narration: [
                        {
                          text: "2.Nc3 — and here's where the Vienna actually starts. The natural move at this point is Nf3 — the Italian and the Spanish both go there.",
                          arrows: [{ from: 'g1', to: 'f3', color: 'red' }],
                        },
                        {
                          text: "But we play Nc3 instead. Why? Three reasons. One — it develops a piece.",
                          arrows: [{ from: 'b1', to: 'c3', color: 'green' }],
                        },
                        {
                          text: "Two — it defends e4 in case Black later threatens it.",
                          arrows: [{ from: 'c3', to: 'e4', color: 'blue' }],
                        },
                        {
                          text: "Three, and this is the big one — it leaves the f-pawn free. In the Italian, after Nf3, the f-pawn is locked behind the knight forever. You can never push f4 without first moving the knight back.",
                          highlights: [{ square: 'f2', color: 'yellow' }],
                        },
                        {
                          text: "In the Vienna, f4 is on the table from move three onward. That's the whole opening — a kingside pawn storm waiting to happen.",
                          arrows: [{ from: 'f2', to: 'f4', color: 'green' }],
                        },
                      ],
                      children: [
                        // ─── FORK 1: Black's response to 2.Nc3 ───
                        {
                          label: '2…Nf6',
                          forkSubtitle:
                            "Hits e4 — invites the gambit",
                          node: {
                            san: 'Nf6',
                            movedBy: 'black',
                            idea:
                              "2...Nf6 — Black develops a knight AND attacks our e4 pawn at the same time. This is the most theoretically critical response. Black is daring you to either defend e4 or play the gambit. Both choices are real, and they lead to very different games. Pick your appetite.",
                            children: [
                              // ─── FORK 2: White's third move ───
                              {
                                label: '3.f4 — Vienna Gambit',
                                forkSubtitle:
                                  "Sacrifice the f-pawn for a kingside attack",
                                node: {
                                  san: 'f4',
                                  movedBy: 'white',
                                  idea:
                                    "3.f4 — the Vienna Gambit. Right out of the gate, we're offering the f-pawn. The point: if Black takes with exf4, the f-file opens for my rook on f1, my queen can swing to e2 or h5, my dark-squared bishop comes alive, and I get a serious lead in development for the price of one pawn. If Black declines with d5 (the principled refutation attempt), the position gets sharp in a different way. Either way, you're playing for an attack from move three — there's no quiet middlegame in this line.",
                                  narration: [
                                    {
                                      text: "3.f4 — the Vienna Gambit. Right out of the gate, we're offering the f-pawn.",
                                      arrows: [{ from: 'f2', to: 'f4', color: 'green' }],
                                    },
                                    {
                                      text: "The point — if Black takes with exf4, the f-file opens up for our rook.",
                                      arrows: [
                                        { from: 'e5', to: 'f4', color: 'red' },
                                        { from: 'f1', to: 'f8', color: 'blue' },
                                      ],
                                    },
                                    {
                                      text: "My queen can swing to e2 or h5.",
                                      arrows: [
                                        { from: 'd1', to: 'e2', color: 'green' },
                                        { from: 'd1', to: 'h5', color: 'green' },
                                      ],
                                    },
                                    {
                                      text: "My dark-squared bishop comes alive on the long diagonal.",
                                      arrows: [{ from: 'c1', to: 'h6', color: 'green' }],
                                    },
                                    {
                                      text: "I get a serious lead in development for the price of one pawn. If Black declines with d5, the principled refutation, the position gets sharp in a different way. Either way, you're playing for an attack from move three — there's no quiet middlegame in this line.",
                                    },
                                  ],
                                  children: [
                                    // ─── FORK 3: Black accepts or declines ───
                                    {
                                      label: '3…d5 — counter-gambit',
                                      forkSubtitle:
                                        "Theoretical refutation: hit back in the center",
                                      node: {
                                        san: 'd5',
                                        movedBy: 'black',
                                        idea:
                                          "3...d5 — the classical refutation attempt. Black ignores my pawn offer and counters in the center. The reasoning: my e4 pawn is defended once (by the knight on c3), but it's now attacked twice (by the f6-knight and the d5-pawn). Something has to give. This is the Falkbeer-style response, and it's Black's most respected try.",
                                        children: [
                                          {
                                            node: {
                                              san: 'fxe5',
                                              movedBy: 'white',
                                              idea:
                                                "4.fxe5 — I take the e-pawn first. The reason I don't play 4.exd5 is simple: after 4.exd5 Nxd5, Black's knight lands on a strong central square hitting my c3-knight, and I'm playing for nothing. Taking with the f-pawn keeps the tension and forces Black to figure out what to do about the knight that's now attacked.",
                                              children: [
                                                {
                                                  node: {
                                                    san: 'Nxe4',
                                                    movedBy: 'black',
                                                    idea:
                                                      "4...Nxe4 — Black grabs my e4 pawn with the knight. This is the only move; anything else loses material. We're now in the main line of the Vienna Gambit Falkbeer Variation, and theory has been worked out for over a century.",
                                                    children: [
                                                      {
                                                        node: {
                                                          san: 'Qf3',
                                                          movedBy: 'white',
                                                          idea:
                                                            "5.Qf3 — the modern challenge. Queen straight to f3 — and now Black's e4-knight is staring down the barrel of a queen attack with NO defender. Black's options narrow fast: trade with Nxc3 (cleanest), defend with f5 (creates king-safety problems), retreat with Nc5 (loses tempo). Qf3 is the more challenging line than the older 5.Nf3 because it forces the question on move five — Black has to commit to something concrete instead of developing freely. This is the position to know cold.",
                                                          narration: [
                                                            {
                                                              text: '5.Qf3 — the modern challenge.',
                                                              arrows: [{ from: 'd1', to: 'f3', color: 'green' }],
                                                            },
                                                            {
                                                              text: "Queen straight to f3, attacking the e4-knight directly.",
                                                              arrows: [{ from: 'f3', to: 'e4', color: 'red' }],
                                                              highlights: [{ square: 'e4', color: 'red' }],
                                                            },
                                                            {
                                                              text: "Black has no defender for the knight. Their options are narrow — trade with Nxc3, defend with f5 weakening the king, or retreat with Nc5 losing tempo.",
                                                            },
                                                            {
                                                              text: 'This is the more challenging modern line — forces Black to commit on move five instead of developing freely.',
                                                            },
                                                          ],
                                                          children: [],
                                                        },
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                    {
                                      label: '3…exf4 — gambit accepted',
                                      forkSubtitle:
                                        "Take the pawn, hold tight, ride the storm",
                                      node: {
                                        san: 'exf4',
                                        movedBy: 'black',
                                        idea:
                                          "3...exf4 — Black takes the bait. Now I'm down a pawn but my plan writes itself: push e5 right now to kick the f6-knight, develop fast with tempo, deal with the Qh4+ threat that's lurking on the open e1-h4 diagonal, and build pressure on the kingside. Black has to spend moves figuring out where to put the knight and how to give back the pawn safely.",
                                        narration: [
                                          {
                                            text: '3...exf4 — Black takes the bait.',
                                            arrows: [{ from: 'e5', to: 'f4', color: 'red' }],
                                          },
                                          {
                                            text: "I'm down a pawn but my plan writes itself.",
                                          },
                                          {
                                            text: "And there's something serious to see: with my f-pawn gone, the diagonal from e1 to h4 is wide open. Black is one move from Qh4+ check, and that would split my king from castling rights for the rest of the game.",
                                            arrows: [{ from: 'd8', to: 'h4', color: 'red' }],
                                            highlights: [
                                              { square: 'h4', color: 'red' },
                                              { square: 'e1', color: 'red' },
                                            ],
                                          },
                                          {
                                            text: 'So I need to do TWO things in the next couple of moves: push e5 to kick the f6-knight, and get a knight to f3 to neutralize the Qh4+ check. Order matters. Push first.',
                                            arrows: [
                                              { from: 'e4', to: 'e5', color: 'green' },
                                              { from: 'g1', to: 'f3', color: 'blue' },
                                            ],
                                          },
                                        ],
                                        children: [
                                          {
                                            node: {
                                              san: 'e5',
                                              movedBy: 'white',
                                              idea:
                                                "4.e5 — push first to kick the knight. Pawn from e4 to e5 attacks the f6-knight, forcing it to move. The knight has only awkward squares: Ng8 (back home, lost a tempo for nothing), Nh5 (sidelined), Nd5 (gets traded by Nxd5), or Ng4 (the active try, eyeing f2 and supporting a future Qh4+). At club level you'll see Ng4 most often. Note that Qh4+ is still threatened on the next move because the e1-h4 diagonal is still open — that's our problem to solve next.",
                                              narration: [
                                                {
                                                  text: '4.e5 — push first to kick the knight.',
                                                  arrows: [{ from: 'e4', to: 'e5', color: 'green' }],
                                                },
                                                {
                                                  text: 'Pawn from e4 to e5 attacks the f6-knight, forcing it to move.',
                                                  arrows: [{ from: 'e5', to: 'f6', color: 'red' }],
                                                  highlights: [{ square: 'f6', color: 'red' }],
                                                },
                                                {
                                                  text: "The knight has only awkward squares. Ng8 — back home, lost a tempo for nothing. Nh5 — sidelined. Nd5 — gets traded. Ng4 — the active try, eyeing f2 and supporting a future Qh4+. At club level you will see Ng4 most often.",
                                                  arrows: [{ from: 'f6', to: 'g4', color: 'yellow' }],
                                                },
                                                {
                                                  text: 'Important: Qh4+ is still threatened on the next move because the e1-h4 diagonal is still open. That is our problem to solve next.',
                                                  arrows: [{ from: 'd8', to: 'h4', color: 'red' }],
                                                },
                                              ],
                                              children: [
                                                {
                                                  node: {
                                                    san: 'Ng8',
                                                    movedBy: 'black',
                                                    idea:
                                                      "4...Ng8 — Black retreats all the way back to the starting square. This is the cleanest move at amateur level — and Stockfish actually agrees it's the best survival move for Black. Why? Every other knight move loses material to a queen capture along the open diagonal: Ng4 hangs to Qxg4, Nh5 hangs to Qxh5 (along d1-h5), Nd5 hangs to Nxd5 (our knight takes), Ne4 hangs to Nxe4. The d1-queen has a clear shot at the kingside now that the f-pawn is gone. So Black retreats with two tempi spent (Nf6 then Ng8) and we have a huge lead in development. The gambit accepted is honestly bad for Black — this is part of why it's not played at master level.",
                                                    narration: [
                                                      {
                                                        text: '4...Ng8 — Black retreats all the way back to the starting square.',
                                                        arrows: [{ from: 'f6', to: 'g8', color: 'green' }],
                                                      },
                                                      {
                                                        text: 'Cleanest move at amateur level — and Stockfish agrees it is the best survival move.',
                                                      },
                                                      {
                                                        text: 'Every other knight square loses material to my queen along the now-open d1-h5 diagonal.',
                                                        arrows: [{ from: 'd1', to: 'h5', color: 'red' }],
                                                      },
                                                      {
                                                        text: 'Ng4 hangs to Qxg4, Nh5 hangs to Qxh5, Nd5 gets traded by my c3-knight, Ne4 hangs to Nxe4. All terrible.',
                                                        highlights: [
                                                          { square: 'g4', color: 'red' },
                                                          { square: 'h5', color: 'red' },
                                                          { square: 'd5', color: 'red' },
                                                          { square: 'e4', color: 'red' },
                                                        ],
                                                      },
                                                      {
                                                        text: 'So Black retreats with two tempi spent. I have a huge lead in development. The gambit accepted is honestly bad for Black — this is part of why it is not played at master level.',
                                                      },
                                                    ],
                                                    children: [
                                                      {
                                                        node: {
                                                          san: 'Nf3',
                                                          movedBy: 'white',
                                                          idea:
                                                            "5.Nf3 — develop and shut the door on Qh4+. Knight from g1 to f3 controls h4, which would otherwise be the only Black counter (Qh4+ would split my king from castling rights). With both knights out, the f-pawn captured but the f-file open for my rook on f1, and Black's pieces still on their starting squares, my plan writes itself: Bc4 next, castle, then attack. The pawn on f4 is a black weakness I'll target with the c1-bishop or recapture later.",
                                                          narration: [
                                                            {
                                                              text: '5.Nf3 — develop and shut the door on Qh4+.',
                                                              arrows: [{ from: 'g1', to: 'f3', color: 'green' }],
                                                            },
                                                            {
                                                              text: 'Knight from g1 to f3 controls h4 — Qh4+ would otherwise be devastating, splitting my king from castling.',
                                                              arrows: [{ from: 'f3', to: 'h4', color: 'blue' }],
                                                              highlights: [{ square: 'h4', color: 'blue' }],
                                                            },
                                                            {
                                                              text: "With both knights out and Black's pieces still on the starting rank, my plan writes itself. Bc4 next, castle, then attack. The pawn on f4 is a black weakness I will target later.",
                                                              arrows: [
                                                                { from: 'f1', to: 'c4', color: 'yellow' },
                                                                { from: 'e1', to: 'g1', color: 'blue' },
                                                              ],
                                                            },
                                                          ],
                                                          children: [],
                                                        },
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                              {
                                label: '3.Bc4 — quiet Italian-style',
                                forkSubtitle:
                                  "Develop calmly — but watch for the center fork trick",
                                node: {
                                  san: 'Bc4',
                                  movedBy: 'white',
                                  idea:
                                    "3.Bc4 — Italian-style development. The bishop eyes f7, the weakest square in Black's camp. This is the safer, calmer Vienna — but there's a famous trap here, and you need to know it. Watch what Black plays next.",
                                  narration: [
                                    {
                                      text: "3.Bc4 — Italian-style development.",
                                      arrows: [{ from: 'f1', to: 'c4', color: 'green' }],
                                    },
                                    {
                                      text: "The bishop eyes f7, the weakest square in Black's camp.",
                                      arrows: [{ from: 'c4', to: 'f7', color: 'blue' }],
                                      highlights: [{ square: 'f7', color: 'red' }],
                                    },
                                    {
                                      text: "This is the safer, calmer Vienna — but there's a famous trap here, and you need to know it. Watch what Black plays next.",
                                    },
                                  ],
                                  children: [
                                    {
                                      node: {
                                        san: 'Nxe4',
                                        movedBy: 'black',
                                        idea:
                                          "3...Nxe4 — and there it is. The center fork trick. Black sacrifices the knight for the e-pawn, and the moment I recapture, Black plays d5 forking my bishop and my recaptured knight. It looks devastating. It's actually equal — but it forces a precise sequence from me, and if I don't know it, I lose material. This is exactly why most Vienna players prefer 3.d3 in this position; it kills the trick before it starts.",
                                        children: [
                                          {
                                            node: {
                                              san: 'Nxe4',
                                              movedBy: 'white',
                                              idea:
                                                "4.Nxe4 — I have to recapture. Letting Black just have the pawn is worse. Now Black plays the punchline.",
                                              children: [
                                                {
                                                  node: {
                                                    san: 'd5',
                                                    movedBy: 'black',
                                                    idea:
                                                      "4...d5 — the fork. The pawn attacks my bishop on c4 AND my knight on e4. Both are hit, only one can move. If I move the bishop, Black takes the knight; if I move the knight, Black takes the bishop. So what do I do?",
                                                    children: [
                                                      {
                                                        node: {
                                                          san: 'Bxd5',
                                                          movedBy: 'white',
                                                          idea:
                                                            "5.Bxd5 — I trade. The bishop takes the pawn; Black recovers the piece by taking the bishop with the queen. After 5...Qxd5, I'm even on material — I lost a pawn early, then traded bishop for pawn, then bishop for bishop's worth via the knight trade. Net: equal. But Black walked out of it with the bishop pair, which is a small long-term advantage.",
                                                          children: [
                                                            {
                                                              node: {
                                                                san: 'Qxd5',
                                                                movedBy: 'black',
                                                                idea:
                                                                  "5...Qxd5 — Black recaptures with the queen. The queen comes out early, which is normally a mistake, but here it can't be hit easily — White doesn't have a knight or bishop ready to attack it for free. From this position both sides develop normally, and the center fork trick has effectively equalized for Black with the bishop pair as a small long-term plus. Let me show you how the typical middlegame unfolds.",
                                                                narration: [
                                                                  {
                                                                    text: '5...Qxd5 — Black recaptures with the queen.',
                                                                    arrows: [{ from: 'd8', to: 'd5', color: 'green' }],
                                                                  },
                                                                  {
                                                                    text: "The queen comes out early — normally a mistake, but here it can't be hit easily.",
                                                                    highlights: [{ square: 'd5', color: 'yellow' }],
                                                                  },
                                                                  {
                                                                    text: "Both sides develop from here. Let me show you the typical middlegame.",
                                                                  },
                                                                ],
                                                                children: [
                                                                  {
                                                                    node: {
                                                                      san: 'd3',
                                                                      movedBy: 'white',
                                                                      idea:
                                                                        "6.d3 — defend the knight in place. Pawn from d2 to d3 supports the e4-knight against Black's queen. Crucial: if I had instead retreated with 6.Nc3, the d5-queen would suddenly have a clean diagonal to g2 — Qxg2 wins my pawn AND attacks the rook on h1. So I keep the knight on e4, defend it with d3, and develop normally from here.",
                                                                      narration: [
                                                                        {
                                                                          text: '6.d3 — defend the knight in place.',
                                                                          arrows: [{ from: 'd2', to: 'd3', color: 'green' }],
                                                                        },
                                                                        {
                                                                          text: 'Pawn supports the e4-knight against the queen on d5.',
                                                                          arrows: [{ from: 'd3', to: 'e4', color: 'blue' }],
                                                                          highlights: [{ square: 'e4', color: 'blue' }],
                                                                        },
                                                                        {
                                                                          text: 'Crucial — if I had instead retreated the knight with Nc3, the d5-queen would have a clean diagonal all the way to g2.',
                                                                          arrows: [{ from: 'd5', to: 'g2', color: 'red' }],
                                                                          highlights: [{ square: 'g2', color: 'red' }],
                                                                        },
                                                                        {
                                                                          text: 'Qxg2 would win the pawn AND attack my rook on h1. So I keep the knight on e4 and defend it with the d-pawn instead.',
                                                                        },
                                                                      ],
                                                                      children: [
                                                                        {
                                                                          node: {
                                                                            san: 'Nc6',
                                                                            movedBy: 'black',
                                                                            idea:
                                                                              "6...Nc6 — Black develops and defends e5. Knight to c6 supports the e5-pawn (which our pieces will eventually pressure) and prepares queenside castling.",
                                                                            narration: [
                                                                              {
                                                                                text: '6...Nc6 — Black develops and defends e5.',
                                                                                arrows: [{ from: 'b8', to: 'c6', color: 'green' }],
                                                                              },
                                                                              {
                                                                                text: 'Knight to c6, supporting e5 and preparing queenside castling.',
                                                                                arrows: [{ from: 'c6', to: 'e5', color: 'blue' }],
                                                                              },
                                                                            ],
                                                                            children: [
                                                                              {
                                                                                node: {
                                                                                  san: 'Nf3',
                                                                                  movedBy: 'white',
                                                                                  idea:
                                                                                    "7.Nf3 — bring the second knight out. Knight from g1 to f3, preparing to castle. The position is now standard: my e4-knight is defended, my king's knight is developing, and Black is about to develop the queenside bishop and castle.",
                                                                                  narration: [
                                                                                    {
                                                                                      text: '7.Nf3 — bring the second knight out.',
                                                                                      arrows: [{ from: 'g1', to: 'f3', color: 'green' }],
                                                                                    },
                                                                                    {
                                                                                      text: 'Preparing to castle.',
                                                                                      arrows: [{ from: 'e1', to: 'g1', color: 'blue' }],
                                                                                    },
                                                                                  ],
                                                                                  children: [
                                                                                    {
                                                                                      node: {
                                                                                        san: 'Bf5',
                                                                                        movedBy: 'black',
                                                                                        idea:
                                                                                          "7...Bf5 — Black develops and pins. Bishop from c8 to f5 attacks our e4-knight along the b1-h7 diagonal. The knight is now attacked by both the bishop AND the queen — defended only by our d3-pawn. We can't move the knight without losing material to Bxe4 or Qxe4. The right move: get out of the way with castling, then deal with the pressure later.",
                                                                                        narration: [
                                                                                          {
                                                                                            text: '7...Bf5 — Black develops and pins.',
                                                                                            arrows: [{ from: 'c8', to: 'f5', color: 'green' }],
                                                                                          },
                                                                                          {
                                                                                            text: 'Bishop to f5 attacks our e4-knight along the b1-h7 diagonal.',
                                                                                            arrows: [{ from: 'f5', to: 'e4', color: 'red' }],
                                                                                            highlights: [{ square: 'e4', color: 'red' }],
                                                                                          },
                                                                                          {
                                                                                            text: 'The knight is attacked twice but defended once — by d3. We castle and figure it out.',
                                                                                          },
                                                                                        ],
                                                                                        children: [
                                                                                          {
                                                                                            node: {
                                                                                              san: 'O-O',
                                                                                              movedBy: 'white',
                                                                                              idea:
                                                                                                "8.O-O — castle. King to g1, rook to f1. We've reached the typical center fork trick middlegame. Material is even, both sides developed, the e4-knight situation is tense but stable. From here white can play Re1 to add another defender, or Nh4 to kick the f5-bishop, or just continue developing with c3 and Bc1-d2. Black has the bishop pair (a small long-term plus) but White has piece coordination.",
                                                                                              narration: [
                                                                                                {
                                                                                                  text: '8.O-O — castle.',
                                                                                                  arrows: [{ from: 'e1', to: 'g1', color: 'green' }],
                                                                                                },
                                                                                                {
                                                                                                  text: 'King to g1, rook to f1.',
                                                                                                  arrows: [{ from: 'h1', to: 'f1', color: 'blue' }],
                                                                                                },
                                                                                                {
                                                                                                  text: "We've reached the typical center fork trick middlegame. Material even, both sides developed, the e4-knight tense but stable.",
                                                                                                  highlights: [
                                                                                                    { square: 'g1', color: 'green' },
                                                                                                  ],
                                                                                                },
                                                                                                {
                                                                                                  text: 'White can add a defender with Re1, kick the bishop with Nh4, or just keep developing. Black has the bishop pair as a small long-term plus.',
                                                                                                  arrows: [
                                                                                                    { from: 'f1', to: 'e1', color: 'yellow' },
                                                                                                    { from: 'f3', to: 'h4', color: 'yellow' },
                                                                                                  ],
                                                                                                },
                                                                                              ],
                                                                                              children: [
                                                                                                {
                                                                                                  node: {
                                                                                                    san: 'O-O-O',
                                                                                                    movedBy: 'black',
                                                                                                    idea:
                                                                                                      "8...O-O-O — Black castles long. King to c8, rook to d8 — tucked away on the queenside, rook lands on the open d-file with the queen still on d6. Aggressive choice; Black is set up for opposite-side attacks. The middlegame begins.",
                                                                                                    narration: [
                                                                                                      {
                                                                                                        text: '8...O-O-O — Black castles long.',
                                                                                                        arrows: [{ from: 'e8', to: 'c8', color: 'green' }],
                                                                                                      },
                                                                                                      {
                                                                                                        text: 'King to c8, rook to d8 — tucked away on the queenside.',
                                                                                                        arrows: [{ from: 'a8', to: 'd8', color: 'blue' }],
                                                                                                      },
                                                                                                      {
                                                                                                        text: 'Aggressive choice — Black is set up for opposite-side attacks. The middlegame begins.',
                                                                                                      },
                                                                                                    ],
                                                                                                    children: [
                                                                                                      {
                                                                                                        node: {
                                                                                                          san: 'd4',
                                                                                                          movedBy: 'white',
                                                                                                          idea:
                                                                                                            "9.d4 — challenge the center. Pawn from d3 to d4 (we played d3 on move 6 to defend the knight; now it advances) hits Black's e5-pawn directly. Black has to decide: trade with exd4 (opening the position for the bishop pair, slightly favoring Black), defend with Bd6, or let us take with dxe5. This is the typical middlegame moment in the center fork trick line — open position, bishop pair vs piece coordination, opposite-side castled kings, both sides have plans. From here it's real chess.",
                                                                                                          narration: [
                                                                                                            {
                                                                                                              text: '9.d4 — challenge the center.',
                                                                                                              arrows: [{ from: 'd3', to: 'd4', color: 'green' }],
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'Pawn from d3 to d4, hitting the e5-pawn directly.',
                                                                                                              arrows: [{ from: 'd4', to: 'e5', color: 'red' }],
                                                                                                              highlights: [{ square: 'e5', color: 'red' }],
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'Black has to decide — trade with exd4 to open lines for the bishop pair, defend, or let us take with dxe5.',
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'This is the typical middlegame moment — opposite-side castled kings, open position, bishop pair versus our piece coordination. From here it is real chess.',
                                                                                                            },
                                                                                                          ],
                                                                                                          children: [],
                                                                                                        },
                                                                                                      },
                                                                                                    ],
                                                                                                  },
                                                                                                },
                                                                                              ],
                                                                                            },
                                                                                          },
                                                                                        ],
                                                                                      },
                                                                                    },
                                                                                  ],
                                                                                },
                                                                              },
                                                                            ],
                                                                          },
                                                                        },
                                                                      ],
                                                                    },
                                                                  },
                                                                ],
                                                              },
                                                            },
                                                          ],
                                                        },
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                        {
                          label: '2…Nc6',
                          forkSubtitle:
                            "Most common amateur response — leads to quieter Italian-like positions",
                          node: {
                            san: 'Nc6',
                            movedBy: 'black',
                            idea:
                              "2...Nc6 — the most common move you'll face at amateur level. Black develops naturally and defends e5. The position is calmer than after 2...Nf6 — there's no immediate threat, no gambit on offer. We'll set up Italian-style and choose between a slow positional game or push f4 later.",
                            children: [
                              {
                                node: {
                                  san: 'Bc4',
                                  movedBy: 'white',
                                  idea:
                                    "3.Bc4 — Italian setup. The bishop slides to its best diagonal, eyeing f7. We're playing a Vienna-Italian hybrid — same bishop placement as the Italian, but with the knight on c3 (not f3) so f4 is still on the table. We're keeping our options open.",
                                  children: [
                                    {
                                      node: {
                                        san: 'Nf6',
                                        movedBy: 'black',
                                        idea:
                                          "3...Nf6 — Black develops the second knight and threatens our e4 pawn. Now we hit the critical Vienna decision against the 2...Nc6 line: do we play 4.d3 (kill the center fork trick before it starts) or 4.Nf3 (allow the trick and accept equality)? Strong players play d3.",
                                        children: [
                                          {
                                            node: {
                                              san: 'd3',
                                              movedBy: 'white',
                                              idea:
                                                "4.d3 — the move. Defends e4 with a pawn, kills the center fork trick (no Nxe4 because the pawn has it covered), and prepares to push f4 in a few moves once we've castled. The position is quiet but White is comfortable. From here it's classical Italian-style chess — get the king safe, play f4 when the timing's right, point everything at the kingside.",
                                              narration: [
                                                {
                                                  text: '4.d3 — the move. Defends e4 with a pawn,',
                                                  arrows: [{ from: 'd2', to: 'd3', color: 'green' }],
                                                  highlights: [{ square: 'e4', color: 'blue' }],
                                                },
                                                {
                                                  text: 'kills the center fork trick — Black can no longer take e4 with the knight because this pawn has it covered.',
                                                  highlights: [
                                                    { square: 'e4', color: 'blue' },
                                                    { square: 'd3', color: 'green' },
                                                  ],
                                                },
                                                {
                                                  text: 'And it prepares to push f4 once we have castled.',
                                                  arrows: [{ from: 'f2', to: 'f4', color: 'yellow' }],
                                                },
                                                {
                                                  text: "The position is quiet, White is comfortable. From here it's classical Italian-style chess — get the king safe, play f4 when the timing's right, point everything at the kingside.",
                                                  arrows: [
                                                    { from: 'e1', to: 'g1', color: 'blue' },
                                                    { from: 'f2', to: 'f4', color: 'green' },
                                                  ],
                                                },
                                              ],
                                              children: [
                                                {
                                                  node: {
                                                    san: 'Bc5',
                                                    movedBy: 'black',
                                                    idea:
                                                      "4...Bc5 — Black mirrors our Italian setup. Bishop to c5 hits f2 (the same target our bishop on c4 has on f7) and Black is set up to castle short. Very textbook. But this bishop is also doing something dangerous — it's on the long a7-g1 diagonal, and right now g1 is occupied by our knight and f2 is empty after the d3 push hasn't happened... wait, f2 IS still occupied by our pawn. Good. As long as we don't push f4 with this bishop alive on c5, we're fine. Pushing f4 here would lose to Bxg1 — Black just takes our knight. The fix: trade the bishop FIRST.",
                                                    narration: [
                                                      {
                                                        text: '4...Bc5 — Black mirrors our Italian setup.',
                                                        arrows: [{ from: 'f8', to: 'c5', color: 'green' }],
                                                      },
                                                      {
                                                        text: 'Bishop to c5 hits f2 — the same target our bishop on c4 has on f7.',
                                                        arrows: [
                                                          { from: 'c5', to: 'f2', color: 'red' },
                                                          { from: 'c4', to: 'f7', color: 'red' },
                                                        ],
                                                        highlights: [
                                                          { square: 'f2', color: 'red' },
                                                          { square: 'f7', color: 'red' },
                                                        ],
                                                      },
                                                      {
                                                        text: "But here's the trap. The bishop is on the long a7-g1 diagonal. If we ever push f4 — clearing f2 — that diagonal opens up to our knight on g1, and Black plays Bxg1 winning the piece.",
                                                        arrows: [
                                                          { from: 'c5', to: 'g1', color: 'red' },
                                                        ],
                                                        highlights: [
                                                          { square: 'g1', color: 'red' },
                                                        ],
                                                      },
                                                      {
                                                        text: 'So we trade this bishop FIRST. Be3 challenges it head-on — if Black trades, we recapture with the f-pawn, opening the f-file as a bonus.',
                                                        arrows: [{ from: 'c1', to: 'e3', color: 'blue' }],
                                                      },
                                                    ],
                                                    children: [
                                                      {
                                                        node: {
                                                          san: 'Be3',
                                                          movedBy: 'white',
                                                          idea:
                                                            "5.Be3 — challenge the bishop. Bishop from c1 to e3, offering the trade and getting the dangerous c5-bishop off the long diagonal. Black's choice: trade with Bxe3 (most common — keeps it simple) or retreat with Bb6 (keeping the bishop, but losing tempo). Either way our plan is the same — recapture with the f-pawn if there's a trade, or push f4 safely later if the bishop moves.",
                                                          narration: [
                                                            {
                                                              text: '5.Be3 — challenge the bishop.',
                                                              arrows: [{ from: 'c1', to: 'e3', color: 'green' }],
                                                            },
                                                            {
                                                              text: "Bishop from c1 to e3, offering the trade and getting Black's c5-bishop off the long diagonal where it threatens our knight.",
                                                              arrows: [{ from: 'e3', to: 'c5', color: 'red' }],
                                                            },
                                                            {
                                                              text: "Black's choice — trade with Bxe3, the most common reply, or retreat with Bb6 keeping the bishop but losing a tempo. Either way our plan is the same.",
                                                            },
                                                          ],
                                                          children: [
                                                            {
                                                              node: {
                                                                san: 'Bxe3',
                                                                movedBy: 'black',
                                                                idea:
                                                                  "5...Bxe3 — Black takes the trade. Bishop from c5 captures on e3. Now I get to choose how to recapture, and the answer is the f-pawn — fxe3 — which opens the f-file for our rook AND removes the danger of Bxg1.",
                                                                narration: [
                                                                  {
                                                                    text: '5...Bxe3 — Black takes the trade.',
                                                                    arrows: [{ from: 'c5', to: 'e3', color: 'green' }],
                                                                  },
                                                                  {
                                                                    text: 'Bishop from c5 captures on e3. Now I choose how to recapture.',
                                                                  },
                                                                ],
                                                                children: [
                                                                  {
                                                                    node: {
                                                                      san: 'fxe3',
                                                                      movedBy: 'white',
                                                                      idea:
                                                                        "6.fxe3 — and there's the move. F-pawn captures back on e3. We've doubled our e-pawns and that's slightly ugly, BUT — and this is the whole point of the recapture — the f-file is now wide open. Our rook on h1 can swing to f1; our queen can use the file; the king will castle short and live behind a still-intact pawn shield on g2-h2. The doubled e-pawns are a minor structural concession; the open f-file is a major attacking asset.",
                                                                      narration: [
                                                                        {
                                                                          text: '6.fxe3 — and there is the move. F-pawn captures back on e3.',
                                                                          arrows: [{ from: 'f2', to: 'e3', color: 'green' }],
                                                                        },
                                                                        {
                                                                          text: "We have doubled our e-pawns and that's slightly ugly. But the f-file is now wide open.",
                                                                          highlights: [
                                                                            { square: 'e3', color: 'yellow' },
                                                                            { square: 'e4', color: 'yellow' },
                                                                          ],
                                                                        },
                                                                        {
                                                                          text: 'Rook on h1 can swing to f1. Queen can use the file. The doubled pawns are a minor concession — the open f-file is a major attacking asset.',
                                                                          arrows: [{ from: 'h1', to: 'f1', color: 'blue' }],
                                                                        },
                                                                      ],
                                                                      children: [
                                                                        {
                                                                          node: {
                                                                            san: 'd6',
                                                                            movedBy: 'black',
                                                                            idea:
                                                                              "6...d6 — Black plays it safe. Pawn to d6 supports e5, opens the c8-bishop's diagonal, and waits to see what we commit to. The center is locked: our pawn on e4 against theirs on e5. From here we develop normally — knight to f3, castle short, prepare the f-file pressure.",
                                                                            narration: [
                                                                              {
                                                                                text: '6...d6 — Black plays it safe. Pawn to d6,',
                                                                                arrows: [{ from: 'd7', to: 'd6', color: 'green' }],
                                                                              },
                                                                              {
                                                                                text: 'supports e5 and opens the c8-bishop diagonal so it can develop.',
                                                                                arrows: [
                                                                                  { from: 'd6', to: 'e5', color: 'blue' },
                                                                                  { from: 'c8', to: 'h3', color: 'yellow' },
                                                                                ],
                                                                              },
                                                                            ],
                                                                            children: [
                                                                              {
                                                                                node: {
                                                                                  san: 'Nf3',
                                                                                  movedBy: 'white',
                                                                                  idea:
                                                                                    "7.Nf3 — bring the second knight out. Knight from g1 to f3, where it pressures e5 (third attacker on the pawn) and supports a future castle. With both knights, both bishops, and the kingside cleared, we're one move from castling.",
                                                                                  narration: [
                                                                                    {
                                                                                      text: '7.Nf3 — bring the second knight out.',
                                                                                      arrows: [{ from: 'g1', to: 'f3', color: 'green' }],
                                                                                    },
                                                                                    {
                                                                                      text: 'Knight from g1 to f3, pressuring e5 — a third attacker on the pawn.',
                                                                                      arrows: [{ from: 'f3', to: 'e5', color: 'red' }],
                                                                                      highlights: [{ square: 'e5', color: 'red' }],
                                                                                    },
                                                                                    {
                                                                                      text: "We're one move from castling.",
                                                                                      arrows: [{ from: 'e1', to: 'g1', color: 'blue' }],
                                                                                    },
                                                                                  ],
                                                                                  children: [
                                                                                    {
                                                                                      node: {
                                                                                        san: 'O-O',
                                                                                        movedBy: 'black',
                                                                                        idea:
                                                                                          "7...O-O — Black castles first. King to g8, rook to f8. Standard procedure; nothing special about it. Our turn to do the same.",
                                                                                        narration: [
                                                                                          {
                                                                                            text: '7...O-O — Black castles first.',
                                                                                            arrows: [{ from: 'e8', to: 'g8', color: 'green' }],
                                                                                          },
                                                                                          {
                                                                                            text: 'King to g8, rook to f8. Our turn.',
                                                                                          },
                                                                                        ],
                                                                                        children: [
                                                                                          {
                                                                                            node: {
                                                                                              san: 'O-O',
                                                                                              movedBy: 'white',
                                                                                              idea:
                                                                                                "8.O-O — and we follow. King to g1, rook to f1. The rook lands directly on the open f-file — every move of this opening has been pointing toward this exact configuration. We're now in the middlegame with a textbook Vienna setup: open f-file, knights on c3 and f3, bishop on c4 eyeing f7, kings safely castled, doubled e-pawns the only structural blemish. Black's only critical decision left is whether to challenge our bishop with Bg4.",
                                                                                              narration: [
                                                                                                {
                                                                                                  text: '8.O-O — and we follow. King to g1,',
                                                                                                  arrows: [{ from: 'e1', to: 'g1', color: 'green' }],
                                                                                                },
                                                                                                {
                                                                                                  text: 'rook to f1 — directly on the open f-file. Every move of this opening has been pointing toward this exact configuration.',
                                                                                                  arrows: [{ from: 'h1', to: 'f1', color: 'green' }],
                                                                                                  highlights: [{ square: 'f1', color: 'blue' }],
                                                                                                },
                                                                                                {
                                                                                                  text: "We're now in the middlegame. Open f-file, knights on c3 and f3, bishop on c4 eyeing f7, both kings castled. Doubled e-pawns the only structural blemish — and worth it.",
                                                                                                  highlights: [
                                                                                                    { square: 'g1', color: 'green' },
                                                                                                    { square: 'g8', color: 'green' },
                                                                                                  ],
                                                                                                },
                                                                                              ],
                                                                                              children: [
                                                                                                {
                                                                                                  node: {
                                                                                                    san: 'Bg4',
                                                                                                    movedBy: 'black',
                                                                                                    idea:
                                                                                                      "8...Bg4 — Black pins our knight. Bishop from c8 to g4, pinning Nf3 against our queen on d1. The threat is to play Nxe4 next — since the knight on f3 is pinned, it can't recapture. Our answer is h3 — kick the bishop, force the trade or the retreat.",
                                                                                                    narration: [
                                                                                                      {
                                                                                                        text: '8...Bg4 — Black pins our knight.',
                                                                                                        arrows: [{ from: 'c8', to: 'g4', color: 'green' }],
                                                                                                      },
                                                                                                      {
                                                                                                        text: 'Bishop to g4, pinning the f3-knight against our queen on d1.',
                                                                                                        arrows: [{ from: 'g4', to: 'd1', color: 'red' }],
                                                                                                        highlights: [
                                                                                                          { square: 'f3', color: 'red' },
                                                                                                          { square: 'd1', color: 'red' },
                                                                                                        ],
                                                                                                      },
                                                                                                      {
                                                                                                        text: 'The threat is Nxe4 — since the f3-knight is pinned, it cannot recapture. We answer with h3.',
                                                                                                        arrows: [{ from: 'f6', to: 'e4', color: 'yellow' }],
                                                                                                      },
                                                                                                    ],
                                                                                                    children: [
                                                                                                      {
                                                                                                        node: {
                                                                                                          san: 'h3',
                                                                                                          movedBy: 'white',
                                                                                                          idea:
                                                                                                            "9.h3 — kick the bishop. Pawn to h3 forces Bxf3 (the trade) or Bh5 (retreat, then we play g4 next to chase it further). If they trade, we recapture with the queen — Qxf3 — and our queen lands on a powerful kingside square pointing at f7 and ready to swing. The middlegame plan from here: queen and rook on the f-file, knight to d5 if Black ever lets us, push the d-pawn or the e-pawn for a central break. This is where opening theory ends and real chess begins.",
                                                                                                          narration: [
                                                                                                            {
                                                                                                              text: '9.h3 — kick the bishop.',
                                                                                                              arrows: [{ from: 'h2', to: 'h3', color: 'green' }],
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'Pawn to h3 forces the trade with Bxf3, or the retreat to h5.',
                                                                                                              arrows: [
                                                                                                                { from: 'g4', to: 'f3', color: 'red' },
                                                                                                                { from: 'g4', to: 'h5', color: 'yellow' },
                                                                                                              ],
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'If they trade, we recapture with the queen — Qxf3 — and the queen lands on a powerful kingside square pointing at f7.',
                                                                                                              arrows: [
                                                                                                                { from: 'd1', to: 'f3', color: 'green' },
                                                                                                                { from: 'f3', to: 'f7', color: 'red' },
                                                                                                              ],
                                                                                                            },
                                                                                                            {
                                                                                                              text: 'Middlegame plan from here. Queen and rook on the f-file. Knight to d5 if Black lets us. Push the d-pawn or the e-pawn for a central break. This is where opening theory ends and real chess begins.',
                                                                                                              arrows: [
                                                                                                                { from: 'c3', to: 'd5', color: 'blue' },
                                                                                                                { from: 'd3', to: 'd4', color: 'green' },
                                                                                                              ],
                                                                                                            },
                                                                                                          ],
                                                                                                          children: [],
                                                                                                        },
                                                                                                      },
                                                                                                    ],
                                                                                                  },
                                                                                                },
                                                                                              ],
                                                                                            },
                                                                                          },
                                                                                        ],
                                                                                      },
                                                                                    },
                                                                                  ],
                                                                                },
                                                                              },
                                                                            ],
                                                                          },
                                                                        },
                                                                      ],
                                                                    },
                                                                  },
                                                                ],
                                                              },
                                                            },
                                                          ],
                                                        },
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                        {
                          label: '2…Bc5',
                          forkSubtitle:
                            "Italian-style as Black — develop and fight for d4",
                          node: {
                            san: 'Bc5',
                            movedBy: 'black',
                            idea:
                              "2...Bc5 — Black plays Italian-style as Black, developing the bishop to its most active square and aiming at the f2 pawn. This is rarer than the knight moves but solid. We respond with normal development and look for f4 later, same as the other lines.",
                            children: [
                              {
                                node: {
                                  san: 'Nf3',
                                  movedBy: 'white',
                                  idea:
                                    "3.Nf3 — develop the second knight. Yes, this commits the f-pawn behind the knight for now, but after 2...Bc5 the gambit f4 doesn't work anyway: pushing f4 with Black's bishop on c5 opens the long a7-g1 diagonal and the knight on g1 hangs to ...Bxg1. With the bishop already pointed at our king, we develop calmly instead and aim for a normal Italian-style middlegame.",
                                  narration: [
                                    {
                                      text: '3.Nf3 — develop the second knight.',
                                      arrows: [{ from: 'g1', to: 'f3', color: 'green' }],
                                    },
                                    {
                                      text: "Pushing f4 with Black's bishop on c5 doesn't work — clearing f2 opens the long a7-g1 diagonal, and our knight on g1 hangs to Bxg1.",
                                      arrows: [{ from: 'c5', to: 'g1', color: 'red' }],
                                      highlights: [{ square: 'g1', color: 'red' }],
                                    },
                                    {
                                      text: 'So we develop calmly instead — Italian-style, knight to f3, normal pieces out, aim for a normal middlegame.',
                                    },
                                  ],
                                  children: [
                                    {
                                      node: {
                                        san: 'Nf6',
                                        movedBy: 'black',
                                        idea:
                                          "3...Nf6 — Black develops symmetrically. Knight from g8 to f6, attacking our e4 pawn. Standard reply.",
                                        narration: [
                                          {
                                            text: '3...Nf6 — Black develops symmetrically.',
                                            arrows: [{ from: 'g8', to: 'f6', color: 'green' }],
                                          },
                                          {
                                            text: 'Knight to f6, attacking our e4 pawn.',
                                            arrows: [{ from: 'f6', to: 'e4', color: 'red' }],
                                            highlights: [{ square: 'e4', color: 'red' }],
                                          },
                                        ],
                                        children: [
                                          {
                                            node: {
                                              san: 'Be2',
                                              movedBy: 'white',
                                              idea:
                                                "4.Be2 — modest bishop development, and crucially this AVOIDS the center fork trick. If we played Bc4 here instead, Black would play Nxe4! — and after we recapture with our c3-knight, Black plays d5 forking our bishop on c4 and the knight on e4. Same trick we teach against the 2...Nc6 line. By playing Be2 first, no target on c4. We'll defend e4 with d3 next move so any Nxe4 grab loses material outright.",
                                              narration: [
                                                {
                                                  text: '4.Be2 — modest bishop development.',
                                                  arrows: [{ from: 'f1', to: 'e2', color: 'green' }],
                                                },
                                                {
                                                  text: 'Critically — this AVOIDS the center fork trick. If we played Bc4 here, Black would play Nxe4 then d5 forking the bishop and our recaptured knight.',
                                                  arrows: [
                                                    { from: 'f1', to: 'c4', color: 'red' },
                                                    { from: 'f6', to: 'e4', color: 'red' },
                                                  ],
                                                },
                                                {
                                                  text: 'By playing Be2 first, no target on c4. We defend e4 with d3 next move so any Nxe4 grab just loses material.',
                                                  arrows: [{ from: 'd2', to: 'd3', color: 'yellow' }],
                                                  highlights: [{ square: 'e4', color: 'blue' }],
                                                },
                                              ],
                                              children: [
                                                {
                                                  node: {
                                                    san: 'Nc6',
                                                    movedBy: 'black',
                                                    idea:
                                                      "4...Nc6 — Black develops the queen's knight. Standard, defends e5, no surprises.",
                                                    narration: [
                                                      {
                                                        text: "4...Nc6 — Black develops the queen's knight.",
                                                        arrows: [{ from: 'b8', to: 'c6', color: 'green' }],
                                                      },
                                                      {
                                                        text: 'Defends e5. Standard.',
                                                        arrows: [{ from: 'c6', to: 'e5', color: 'blue' }],
                                                      },
                                                    ],
                                                    children: [
                                                      {
                                                        node: {
                                                          san: 'd3',
                                                          movedBy: 'white',
                                                          idea:
                                                            "5.d3 — defend e4 with the pawn. Now the e4-pawn has TWO defenders (the c3-knight AND this d3-pawn) so any Nxe4 ideas are off the table for good. We can also push d4 later if conditions allow. The position is set up for a calm Italian-Vienna middlegame.",
                                                          narration: [
                                                            {
                                                              text: '5.d3 — defend e4 with the pawn.',
                                                              arrows: [{ from: 'd2', to: 'd3', color: 'green' }],
                                                            },
                                                            {
                                                              text: 'Two defenders on e4 now — the c3-knight AND this pawn.',
                                                              arrows: [
                                                                { from: 'c3', to: 'e4', color: 'blue' },
                                                                { from: 'd3', to: 'e4', color: 'blue' },
                                                              ],
                                                              highlights: [{ square: 'e4', color: 'green' }],
                                                            },
                                                            {
                                                              text: "Black can't even think about Nxe4 — it just hangs the knight to a recapture.",
                                                            },
                                                          ],
                                                          children: [
                                                            {
                                                              node: {
                                                                san: 'd6',
                                                                movedBy: 'black',
                                                                idea:
                                                                  "5...d6 — Black supports e5 and opens the c8-bishop's diagonal. Solid choice. Black wants to castle next.",
                                                                narration: [
                                                                  {
                                                                    text: '5...d6 — Black supports e5,',
                                                                    arrows: [{ from: 'd7', to: 'd6', color: 'green' }],
                                                                  },
                                                                  {
                                                                    text: "and opens the c8-bishop's diagonal.",
                                                                    arrows: [{ from: 'c8', to: 'h3', color: 'yellow' }],
                                                                  },
                                                                ],
                                                                children: [
                                                                  {
                                                                    node: {
                                                                      san: 'O-O',
                                                                      movedBy: 'white',
                                                                      idea:
                                                                        "6.O-O — castle short. King to safety, rook to f1. The bishop on c5 still aims at the long diagonal but our f2-pawn blocks any pressure on g1. We're set up for a calm middlegame from here — what we have over a normal Italian is the knight already on c3, ready for Nd5 or supporting an eventual d4 break.",
                                                                      narration: [
                                                                        {
                                                                          text: '6.O-O — castle short.',
                                                                          arrows: [{ from: 'e1', to: 'g1', color: 'green' }],
                                                                        },
                                                                        {
                                                                          text: "The bishop on c5 aims at our king's destination but our f2-pawn blocks any pressure on g1.",
                                                                          highlights: [{ square: 'f2', color: 'green' }],
                                                                        },
                                                                        {
                                                                          text: 'What we have over a normal Italian is the knight already on c3, ready for Nd5 or supporting d4.',
                                                                          arrows: [{ from: 'c3', to: 'd5', color: 'yellow' }],
                                                                        },
                                                                      ],
                                                                      children: [
                                                                        {
                                                                          node: {
                                                                            san: 'O-O',
                                                                            movedBy: 'black',
                                                                            idea:
                                                                              "6...O-O — Black castles too. Both kings safe; we've reached the calm Italian-Vienna middlegame. Symmetrical pawn structure (e4-d3 vs e5-d6), both bishops on c-squares (c4 and c5), both knights developed. The position is balanced and quiet. From here White picks: Be3 (challenge the bishop, lead to the same f-file lesson as the Nc6 line), Nd5 (knight outpost — hits f6 and c7), or h3 (preparing g4 push to attack the kingside). All three are real plans. Want to play it out?",
                                                                            narration: [
                                                                              {
                                                                                text: '6...O-O — Black castles too.',
                                                                                arrows: [{ from: 'e8', to: 'g8', color: 'green' }],
                                                                              },
                                                                              {
                                                                                text: "Both kings safe — we've reached the calm Italian-Vienna middlegame.",
                                                                                highlights: [
                                                                                  { square: 'g1', color: 'green' },
                                                                                  { square: 'g8', color: 'green' },
                                                                                ],
                                                                              },
                                                                              {
                                                                                text: 'Symmetrical pawn structure, both bishops on c-squares, both knights out.',
                                                                              },
                                                                              {
                                                                                text: 'From here White picks. Be3 to challenge the bishop. Nd5 for a knight outpost. h3 preparing a kingside g4 push.',
                                                                                arrows: [
                                                                                  { from: 'c1', to: 'e3', color: 'blue' },
                                                                                  { from: 'c3', to: 'd5', color: 'yellow' },
                                                                                  { from: 'h2', to: 'h3', color: 'green' },
                                                                                ],
                                                                              },
                                                                              {
                                                                                text: 'All three are real plans. This is where opening theory ends and real chess begins.',
                                                                              },
                                                                            ],
                                                                            children: [],
                                                                          },
                                                                        },
                                                                      ],
                                                                    },
                                                                  },
                                                                ],
                                                              },
                                                            },
                                                          ],
                                                        },
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};
