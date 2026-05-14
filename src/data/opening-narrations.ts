import type { OpeningNarration } from '../types';

/**
 * Curated high-quality opening narrations following the 3-part structure:
 *   1. Name the opening and variation
 *   2. Explain the move's concrete strategic/tactical purpose
 *   3. Give one actionable idea for the next few moves
 *
 * Each entry has 2-3 alternate narrations for variety.
 */
export const CURATED_NARRATIONS: OpeningNarration[] = [
  // ─── Italian Game (1.e4 e5 2.Nf3 Nc6 3.Bc4) ────────────────────────────
  {
    id: 'italian-e4',
    openingName: 'Italian Game',
    variation: '',
    moveSan: 'e4',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    narrations: [
      'This is the starting move of the Italian Game. The e4 pawn claims the center and opens diagonals for both the queen and the f1 bishop. Look to follow up with Nf3 to attack the e5 square and develop toward Bc4.',
      'We\'re beginning the Italian Game with e4, seizing central space and freeing the light-squared bishop on f1. This pawn controls d5 and f5, limiting Black\'s options. Plan to play Nf3 next, targeting e5 while developing your kingside.',
    ],
    approved: true,
  },
  {
    id: 'italian-e5',
    openingName: 'Italian Game',
    variation: '',
    moveSan: 'e5',
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    narrations: [
      'Black mirrors White\'s center claim in the Italian Game. The e5 pawn contests the d4 and f4 squares, establishing a symmetrical pawn center. White should now play Nf3 to pressure e5 and begin kingside development.',
      'In the Italian Game, Black responds with e5, matching White\'s central presence and opening the diagonal for the dark-squared bishop. Both sides now have equal central tension. Next, White plays Nf3 to attack Black\'s e5 pawn and develop with tempo.',
    ],
    approved: true,
  },
  {
    id: 'italian-nf3',
    openingName: 'Italian Game',
    variation: '',
    moveSan: 'Nf3',
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    narrations: [
      'Still in the Italian Game — Nf3 develops the knight to its best square while attacking Black\'s e5 pawn. This forces Black to defend e5, typically with Nc6. From here, White will play Bc4 to target the f7 square, the weakest point in Black\'s position.',
      'This is the Italian Game taking shape. Nf3 puts immediate pressure on e5 and clears the way for kingside castling. Black will almost certainly play Nc6 to defend, and then White aims Bc4 at f7 — the classic Italian idea.',
    ],
    approved: true,
  },
  {
    id: 'italian-nc6',
    openingName: 'Italian Game',
    variation: '',
    moveSan: 'Nc6',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    narrations: [
      'Black develops Nc6 in the Italian Game, defending the e5 pawn while bringing a piece toward the center. The knight on c6 also eyes the d4 and b4 squares. White should now play Bc4, aiming at f7 and entering the heart of the Italian.',
      'Nc6 is Black\'s most natural defense in the Italian Game — it protects e5 and develops a piece simultaneously. Now White plays Bc4, pointing the bishop at the f7 pawn, which sets up the Italian Game\'s signature attacking themes.',
    ],
    approved: true,
  },
  {
    id: 'italian-bc4',
    openingName: 'Italian Game',
    variation: '',
    moveSan: 'Bc4',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    narrations: [
      'This is the defining move of the Italian Game. Bc4 places the bishop on its most aggressive diagonal, targeting f7 — the weakest point near Black\'s king. From here, White can prepare c3 and d4 to build a strong pawn center, or castle first for king safety.',
      'We\'re now in the Italian Game proper. The bishop on c4 bears down on f7, creating latent tactical threats. White\'s plan is to castle quickly, then push c3 and d4 to claim the center with tempo against Black\'s pieces.',
    ],
    approved: true,
  },

  // ─── Sicilian Najdorf (1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6) ─
  {
    id: 'sicilian-c5',
    openingName: 'Sicilian Defense',
    variation: 'Najdorf',
    moveSan: 'c5',
    fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    narrations: [
      'This is the Sicilian Defense. Black plays c5 to fight for the d4 square without mirroring White\'s center — creating an asymmetrical, combative position from move one. White should play Nf3 followed by d4 to open the center and try to exploit the lead in development.',
      'We\'re entering the Sicilian Defense with c5, Black\'s sharpest reply to e4. Instead of contesting e4 directly, Black attacks d4 from the flank, guaranteeing an unbalanced game. White\'s main plan is Nf3 and d4, opening lines while ahead in development.',
    ],
    approved: true,
  },
  {
    id: 'sicilian-d6',
    openingName: 'Sicilian Defense',
    variation: 'Najdorf',
    moveSan: 'd6',
    fen: 'rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3',
    narrations: [
      'This is the Najdorf Variation of the Sicilian Defense taking shape. Black plays d6 to support the c5 pawn and prepare ...Nf6, keeping the position flexible. White should push d4 now to open the center before Black finishes development.',
      'In the Sicilian Najdorf, d6 solidifies Black\'s pawn chain and prepares to develop the knight to f6 with tempo against e4. This move signals Black wants a complex middlegame. White answers with d4 to break open the center immediately.',
    ],
    approved: true,
  },
  {
    id: 'sicilian-nf6-najdorf',
    openingName: 'Sicilian Defense',
    variation: 'Najdorf',
    moveSan: 'Nf6',
    fen: 'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5',
    narrations: [
      'This is the Najdorf Sicilian. Nf6 attacks the e4 pawn directly, forcing White to decide how to defend it — usually with Nc3. The knight on f6 is perfectly placed, controlling d5 and preparing ...a6 to enter the main Najdorf. Look for Nc3 from White, then play ...a6.',
      'We\'re in the Sicilian Najdorf — Nf6 puts pressure on e4 and is the most active developing choice. White typically responds Nc3 to protect e4, after which Black plays the signature ...a6 to prepare queenside expansion with ...b5 and ...Bb7.',
    ],
    approved: true,
  },
  {
    id: 'sicilian-a6-najdorf',
    openingName: 'Sicilian Defense',
    variation: 'Najdorf',
    moveSan: 'a6',
    fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6',
    narrations: [
      'This is the defining move of the Najdorf Variation. The pawn on a6 prevents Nb5 and Bb5, while preparing a future ...b5 queenside expansion. From here, Black will develop with ...e5 or ...e6 depending on White\'s setup, aiming for a complex middlegame with chances on both flanks.',
      'We\'ve reached the tabiya of the Sicilian Najdorf — a6 is the signature move that gives the variation its name. It stops Bb5 pins and Nb5 jumps while setting up ...b5 to grab space on the queenside. Black will choose between ...e5 (sharp) and ...e6 (solid) based on White\'s next move.',
    ],
    approved: true,
  },

  // ─── Ruy Lopez (1.e4 e5 2.Nf3 Nc6 3.Bb5) ──────────────────────────────
  {
    id: 'ruy-bb5',
    openingName: 'Ruy Lopez',
    variation: '',
    moveSan: 'Bb5',
    fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    narrations: [
      'This is the Ruy Lopez, one of the oldest and deepest openings in chess. Bb5 pins the c6 knight to the king, indirectly pressuring the e5 pawn. White\'s long-term plan is to build a pawn center with c3 and d4 after castling, slowly squeezing Black\'s position.',
      'We\'re entering the Ruy Lopez with Bb5, targeting the knight that defends e5. While White doesn\'t capture on c6 immediately, the threat creates long-term pressure. Plan to castle, then play c3 and d4 to build an ideal pawn center.',
    ],
    approved: true,
  },
  {
    id: 'ruy-a6',
    openingName: 'Ruy Lopez',
    variation: 'Morphy Defense',
    moveSan: 'a6',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
    narrations: [
      'This is the Morphy Defense in the Ruy Lopez. Black plays a6 to ask the bishop an important question — retreat to a4 or exchange on c6? The bishop usually goes to a4, maintaining tension. Black\'s idea is to later play ...b5 and ...Bb7, developing the queenside.',
      'We\'re in the Morphy Defense of the Ruy Lopez — a6 challenges White\'s bishop immediately. After Ba4, Black has gained the option of ...b5 to chase the bishop further. This is the most popular line in the Ruy Lopez and leads to rich strategic play.',
    ],
    approved: true,
  },
  {
    id: 'ruy-nf6',
    openingName: 'Ruy Lopez',
    variation: 'Morphy Defense',
    moveSan: 'Nf6',
    fen: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5',
    narrations: [
      'In the Ruy Lopez Morphy Defense, Nf6 counterattacks the e4 pawn while developing a piece. This forces White to decide: defend e4 passively, or castle and allow Black to capture? White typically castles here, entering the famous Closed Ruy Lopez after ...Be7 and Re1.',
      'This is the Morphy Defense of the Ruy Lopez — Nf6 strikes at e4, creating immediate counterplay. White usually castles kingside, accepting the tension. After ...Be7, White plays Re1 to shore up e4, leading to one of chess\'s most strategically rich positions.',
    ],
    approved: true,
  },

  // ─── French Defence (1.e4 e6 2.d4 d5) ──────────────────────────────────
  {
    id: 'french-e6',
    openingName: 'French Defense',
    variation: '',
    moveSan: 'e6',
    fen: 'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    narrations: [
      'This is the French Defence. Black plays e6 to prepare ...d5, challenging White\'s e4 pawn with a solid pawn chain. The trade-off: the light-squared bishop on c8 gets hemmed in behind the e6 pawn. White should play d4 to claim the center before Black strikes with ...d5.',
      'We\'re entering the French Defence with e6, a solid but ambitious response to e4. Black intends ...d5 next, creating tension in the center. The price is the c8 bishop gets blocked — solving this "French bishop problem" is Black\'s key strategic challenge.',
    ],
    approved: true,
  },
  {
    id: 'french-d5',
    openingName: 'French Defense',
    variation: '',
    moveSan: 'd5',
    fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3',
    narrations: [
      'This is the critical moment in the French Defence — d5 directly challenges White\'s e4 pawn, creating central tension. White must choose: push e5 (Advance), capture exd5 (Exchange), or defend with Nc3 (Classical/Winawer). Each choice leads to a fundamentally different type of game.',
      'We\'ve reached the heart of the French Defence. The d5 pawn attacks e4, and White\'s response defines the entire game. After Nc3, Black can play ...Nf6 (Classical) or ...Bb4 (Winawer), each with distinct strategic themes.',
    ],
    approved: true,
  },

  // ─── Caro-Kann (1.e4 c6 2.d4 d5) ───────────────────────────────────────
  {
    id: 'caro-c6',
    openingName: 'Caro-Kann Defense',
    variation: '',
    moveSan: 'c6',
    fen: 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    narrations: [
      'This is the Caro-Kann Defence. Black plays c6 to prepare ...d5 next move, challenging e4 from a position where the light-squared bishop stays free (unlike the French). White should play d4 to establish a classical center before Black strikes.',
      'We\'re entering the Caro-Kann with c6, preparing ...d5 to attack e4 while keeping the c8 bishop unblocked. Compared to the French Defence\'s ...e6, this is a more solid approach. White responds with d4, and after ...d5, the central battle begins.',
    ],
    approved: true,
  },
  {
    id: 'caro-d5',
    openingName: 'Caro-Kann Defense',
    variation: '',
    moveSan: 'd5',
    fen: 'rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3',
    narrations: [
      'This is the Caro-Kann taking shape — d5 attacks White\'s e4 pawn with the c6 pawn already supporting it. White typically plays Nc3 or Nd2 to defend e4, leading to the Classical or Short Variation. Black\'s advantage is the free light-squared bishop, which will develop actively to f5 or g4.',
      'In the Caro-Kann, d5 creates immediate tension in the center. Unlike the French, Black\'s bishop on c8 has a clear path to f5 or g6. After White plays Nc3, the mainline continues ...dxe4 Nxe4 Bf5, reaching one of the most solid positions in chess for Black.',
    ],
    approved: true,
  },

  // ─── Queen's Gambit (1.d4 d5 2.c4) ─────────────────────────────────────
  {
    id: 'qg-d4',
    openingName: "Queen's Gambit",
    variation: '',
    moveSan: 'd4',
    fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
    narrations: [
      'This is the start of the Queen\'s Gambit. White plays d4 to claim central space and prepare c4, offering a pawn to lure Black\'s d5 pawn away from the center. The d4 pawn controls e5 and c5, laying the foundation for White\'s queenside strategy.',
      'We\'re opening with d4, the first step toward the Queen\'s Gambit. This pawn grabs central territory and prepares c4 on the next move. Unlike e4 openings, d4 games tend to be more strategic with slower piece development.',
    ],
    approved: true,
  },
  {
    id: 'qg-c4',
    openingName: "Queen's Gambit",
    variation: '',
    moveSan: 'c4',
    fen: 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2',
    narrations: [
      'This is the Queen\'s Gambit — c4 attacks Black\'s d5 pawn, offering to trade a flank pawn for a center pawn. It\'s not a true sacrifice because Black can\'t hold the c4 pawn long-term. Black must choose: accept with ...dxc4, decline with ...e6, or play the Slav with ...c6.',
      'We\'ve reached the Queen\'s Gambit. The c4 pawn challenges d5, and White is happy if Black captures — trading a c-pawn for a d-pawn gives White a strong central majority. Black\'s most popular responses are ...e6 (QGD) to hold d5 solidly, or ...c6 (Slav) to support d5 with a pawn.',
    ],
    approved: true,
  },

  // ─── London System (1.d4 Nf6 2.Nf3 g6 3.Bf4) ──────────────────────────
  {
    id: 'london-bf4',
    openingName: 'London System',
    variation: '',
    moveSan: 'Bf4',
    fen: 'rnbqkb1r/pppppp1p/5np1/8/3P1B2/5N2/PPP1PPPP/RN1QKB1R b KQkq - 3 3',
    narrations: [
      'This is the London System. Bf4 develops the dark-squared bishop outside the pawn chain before playing e3, which is the hallmark of the London. The bishop on f4 controls the e5 square and supports a future e3-c3-Bd3 setup. Plan to play e3, Bd3, and castle kingside for a solid, easy-to-play position.',
      'We\'re in the London System — Bf4 is the signature move, placing the bishop on its ideal diagonal before locking it in with e3. From here, White builds a fortress with e3, Bd3, Nbd2, and O-O. The position is solid and hard to crack, with long-term pressure on the dark squares.',
    ],
    approved: true,
  },

  // ─── King's Indian Defence (1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6) ──────
  {
    id: 'kid-bg7',
    openingName: "King's Indian Defense",
    variation: '',
    moveSan: 'Bg7',
    fen: 'rnbqk2r/ppppppbp/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 1 4',
    narrations: [
      'This is the King\'s Indian Defence. Bg7 fianchettoes the bishop, aiming it at the center along the long a1-h8 diagonal. Black concedes space in the center but builds a springboard for a kingside attack with ...e5 and ...f5. Plan to play ...d6 next, then ...O-O and ...e5 to strike at White\'s center.',
      'We\'re developing the King\'s Indian Defence — Bg7 puts the bishop on its most powerful diagonal, where it pressures d4 and controls the long diagonal. Black\'s strategy is to let White build a big center, then blow it up with ...e5 or ...c5 later.',
    ],
    approved: true,
  },
  {
    id: 'kid-d6',
    openingName: "King's Indian Defense",
    variation: '',
    moveSan: 'd6',
    fen: 'rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP3PPP/R1BQKBNR w KQkq - 0 5',
    narrations: [
      'In the King\'s Indian Defence, d6 supports the e5 pawn push that Black is preparing. This move completes the hypermodern setup — Black has no center pawns yet but aims to strike with ...e5 or ...c5. White typically plays Nf3 and Be2, preparing to castle and consolidate the center.',
      'This is the King\'s Indian structure forming — d6 prepares the crucial ...e5 break while keeping the position flexible. Black\'s entire strategy revolves around timing ...e5 correctly, then launching a kingside attack with ...f5. Castle first, then look for the right moment to strike.',
    ],
    approved: true,
  },
];
