/**
 * reviewSampleGames — seed 5 famous, pre-annotated sample games into
 * the local Dexie `games` table on first visit to /coach/review so
 * the user can test the Review-with-Coach surface immediately
 * without having to play or import anything first.
 *
 * Each sample ships with hand-curated per-ply annotations (eval +
 * classification) so the cards show real game-style badges and the
 * post-game-review walkthrough has anchors for the LLM narration to
 * latch onto. `fullyAnalyzed: true` short-circuits the in-page
 * analyze-on-load path so the user sees a card and clicks straight
 * through.
 *
 * Idempotent: gated on a meta flag so repeated visits don't re-seed,
 * and individual rows are upserted (the same id always overwrites the
 * same record). Manually deleting a sample from the games library
 * won't bring it back unless the meta flag is also reset.
 */
import { db } from '../db/schema';
import type { GameRecord, MoveAnnotation, MoveClassification } from '../types';
import { logAppAudit } from './appAuditor';

// .v2 — bumped when `bestMoveEval` was added to MoveAnnotation. Old
// .v1-seeded sample records carry no `bestMoveEval`, which would leave
// the Missed Tactics / Missed Opportunities surfaces empty on samples.
// Bumping the key forces a re-seed on next mount; `bulkPut` at the
// same ids overwrites cleanly.
const SAMPLES_SEEDED_META_KEY = 'review-samples-seeded.v2';

interface SampleAnnotation {
  /** 1-indexed full move number, matching MoveAnnotation.moveNumber. */
  m: number;
  c: 'white' | 'black';
  san: string;
  /** Centipawn eval after this move, from White's perspective. */
  eval: number;
  best?: string;
  classification?: MoveClassification;
  comment?: string;
}

interface SampleGame {
  id: string;
  pgn: string;
  white: string;
  black: string;
  result: GameRecord['result'];
  date: string;
  event: string;
  eco: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  source: GameRecord['source'];
  annotations: SampleAnnotation[];
}

/** Five famous, instructive games. Short enough that the per-move
 *  walkthrough in /coach/review feels brisk; varied enough that the
 *  game-style classifier produces a mix of style badges. */
const SAMPLE_GAMES: SampleGame[] = [
  {
    id: 'sample-morphy-opera-1858',
    pgn:
      '[Event "Paris Opera Game"]\n' +
      '[Site "Paris FRA"]\n' +
      '[Date "1858.??.??"]\n' +
      '[White "Morphy, Paul"]\n' +
      '[Black "Duke of Brunswick & Count Isouard"]\n' +
      '[Result "1-0"]\n\n' +
      '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 ' +
      '8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 ' +
      '14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0',
    white: 'Paul Morphy',
    black: 'Duke of Brunswick & Count Isouard',
    result: '1-0',
    date: '1858-11-02',
    event: 'Paris Opera',
    eco: 'C41',
    whiteElo: null,
    blackElo: null,
    source: 'master',
    annotations: [
      { m: 1, c: 'white', san: 'e4', eval: 25, classification: 'good' },
      { m: 1, c: 'black', san: 'e5', eval: 30, classification: 'good' },
      { m: 2, c: 'white', san: 'Nf3', eval: 35, classification: 'good' },
      { m: 2, c: 'black', san: 'd6', eval: 60, classification: 'inaccuracy', comment: 'Philidor — passive.', best: 'Nc6' },
      { m: 3, c: 'white', san: 'd4', eval: 80, classification: 'good' },
      { m: 3, c: 'black', san: 'Bg4', eval: 200, classification: 'mistake', comment: 'Pinning before developing knights leaves Black thin on the kingside.', best: 'exd4' },
      { m: 4, c: 'white', san: 'dxe5', eval: 220, classification: 'good' },
      { m: 4, c: 'black', san: 'Bxf3', eval: 250, classification: 'good' },
      { m: 5, c: 'white', san: 'Qxf3', eval: 240, classification: 'good' },
      { m: 5, c: 'black', san: 'dxe5', eval: 260, classification: 'good' },
      { m: 6, c: 'white', san: 'Bc4', eval: 280, classification: 'good' },
      { m: 6, c: 'black', san: 'Nf6', eval: 300, classification: 'good' },
      { m: 7, c: 'white', san: 'Qb3', eval: 320, classification: 'great', comment: 'Double attack on b7 and f7.' },
      { m: 7, c: 'black', san: 'Qe7', eval: 380, classification: 'inaccuracy', best: 'Qd7' },
      { m: 8, c: 'white', san: 'Nc3', eval: 360, classification: 'good' },
      { m: 8, c: 'black', san: 'c6', eval: 400, classification: 'good' },
      { m: 9, c: 'white', san: 'Bg5', eval: 420, classification: 'great' },
      { m: 9, c: 'black', san: 'b5', eval: 800, classification: 'blunder', comment: 'Loses on the spot. Black needed Qc7 to defend.', best: 'Qc7' },
      { m: 10, c: 'white', san: 'Nxb5', eval: 850, classification: 'brilliant', comment: 'Knight sac to demolish the queenside.' },
      { m: 10, c: 'black', san: 'cxb5', eval: 870, classification: 'good' },
      { m: 11, c: 'white', san: 'Bxb5+', eval: 900, classification: 'good' },
      { m: 11, c: 'black', san: 'Nbd7', eval: 920, classification: 'good' },
      { m: 12, c: 'white', san: 'O-O-O', eval: 1100, classification: 'great' },
      { m: 12, c: 'black', san: 'Rd8', eval: 1200, classification: 'good' },
      { m: 13, c: 'white', san: 'Rxd7', eval: 1500, classification: 'brilliant', comment: 'Second sacrifice — peeling defenders off d7.' },
      { m: 13, c: 'black', san: 'Rxd7', eval: 1550, classification: 'good' },
      { m: 14, c: 'white', san: 'Rd1', eval: 1800, classification: 'great' },
      { m: 14, c: 'black', san: 'Qe6', eval: 2200, classification: 'mistake', best: 'Qe7' },
      { m: 15, c: 'white', san: 'Bxd7+', eval: 2400, classification: 'good' },
      { m: 15, c: 'black', san: 'Nxd7', eval: 2500, classification: 'good' },
      { m: 16, c: 'white', san: 'Qb8+', eval: 9999, classification: 'brilliant', comment: 'The killer.' },
      { m: 16, c: 'black', san: 'Nxb8', eval: 9999, classification: 'good' },
      { m: 17, c: 'white', san: 'Rd8#', eval: 9999, classification: 'great', comment: 'Mate.' },
    ],
  },
  {
    id: 'sample-fischer-byrne-1956',
    pgn:
      '[Event "Rosenwald Memorial"]\n' +
      '[Site "New York"]\n' +
      '[Date "1956.10.17"]\n' +
      '[White "Byrne, Donald"]\n' +
      '[Black "Fischer, Robert J."]\n' +
      '[Result "0-1"]\n\n' +
      '1. Nf3 Nf6 2. c4 g6 3. Nc3 Bg7 4. d4 O-O 5. Bf4 d5 6. Qb3 dxc4 7. Qxc4 c6 ' +
      '8. e4 Nbd7 9. Rd1 Nb6 10. Qc5 Bg4 11. Bg5 Na4 12. Qa3 Nxc3 13. bxc3 Nxe4 ' +
      '14. Bxe7 Qb6 15. Bc4 Nxc3 16. Bc5 Rfe8+ 17. Kf1 Be6 0-1',
    white: 'Donald Byrne',
    black: 'Bobby Fischer',
    result: '0-1',
    date: '1956-10-17',
    event: 'Game of the Century',
    eco: 'D92',
    whiteElo: 2400,
    blackElo: 2200,
    source: 'master',
    annotations: [
      { m: 1, c: 'white', san: 'Nf3', eval: 20, classification: 'good' },
      { m: 1, c: 'black', san: 'Nf6', eval: 25, classification: 'good' },
      { m: 2, c: 'white', san: 'c4', eval: 30, classification: 'good' },
      { m: 2, c: 'black', san: 'g6', eval: 35, classification: 'good' },
      { m: 3, c: 'white', san: 'Nc3', eval: 30, classification: 'good' },
      { m: 3, c: 'black', san: 'Bg7', eval: 30, classification: 'good' },
      { m: 4, c: 'white', san: 'd4', eval: 35, classification: 'good' },
      { m: 4, c: 'black', san: 'O-O', eval: 40, classification: 'good' },
      { m: 5, c: 'white', san: 'Bf4', eval: 50, classification: 'good' },
      { m: 5, c: 'black', san: 'd5', eval: 55, classification: 'good' },
      { m: 6, c: 'white', san: 'Qb3', eval: 70, classification: 'good' },
      { m: 6, c: 'black', san: 'dxc4', eval: 80, classification: 'good' },
      { m: 7, c: 'white', san: 'Qxc4', eval: 75, classification: 'good' },
      { m: 7, c: 'black', san: 'c6', eval: 60, classification: 'good' },
      { m: 8, c: 'white', san: 'e4', eval: 90, classification: 'good' },
      { m: 8, c: 'black', san: 'Nbd7', eval: 100, classification: 'good' },
      { m: 9, c: 'white', san: 'Rd1', eval: 110, classification: 'inaccuracy', best: 'Be2', comment: 'Slightly slow — Be2 develops with tempo.' },
      { m: 9, c: 'black', san: 'Nb6', eval: 100, classification: 'good' },
      { m: 10, c: 'white', san: 'Qc5', eval: 120, classification: 'good' },
      { m: 10, c: 'black', san: 'Bg4', eval: 110, classification: 'good' },
      { m: 11, c: 'white', san: 'Bg5', eval: 140, classification: 'inaccuracy', best: 'Be2' },
      { m: 11, c: 'black', san: 'Na4', eval: 80, classification: 'brilliant', comment: 'The 13-year-old Fischer launches the storm.' },
      { m: 12, c: 'white', san: 'Qa3', eval: 100, classification: 'mistake', best: 'Nxa4', comment: 'Walks into the queen sac.' },
      { m: 12, c: 'black', san: 'Nxc3', eval: 60, classification: 'good' },
      { m: 13, c: 'white', san: 'bxc3', eval: 80, classification: 'good' },
      { m: 13, c: 'black', san: 'Nxe4', eval: -200, classification: 'great', comment: 'Pawn taken with tempo.' },
      { m: 14, c: 'white', san: 'Bxe7', eval: -180, classification: 'mistake', best: 'Bxc7', comment: 'Allows Black\'s tactical thunder.' },
      { m: 14, c: 'black', san: 'Qb6', eval: -400, classification: 'brilliant', comment: 'The famous queen sac is ON.' },
      { m: 15, c: 'white', san: 'Bc4', eval: -380, classification: 'good' },
      { m: 15, c: 'black', san: 'Nxc3', eval: -600, classification: 'great' },
      { m: 16, c: 'white', san: 'Bc5', eval: -800, classification: 'good' },
      { m: 16, c: 'black', san: 'Rfe8+', eval: -1200, classification: 'brilliant', comment: 'The killing check.' },
      { m: 17, c: 'white', san: 'Kf1', eval: -1400, classification: 'good' },
      { m: 17, c: 'black', san: 'Be6', eval: -1800, classification: 'brilliant', comment: 'Closing the trap.' },
    ],
  },
  {
    id: 'sample-vienna-amateur-1',
    pgn:
      '[Event "Casual game"]\n' +
      '[Site "Online"]\n' +
      '[Date "2025.10.12"]\n' +
      '[White "You"]\n' +
      '[Black "Coach"]\n' +
      '[Result "0-1"]\n\n' +
      '1. e4 e5 2. Nc3 Nc6 3. Bc4 Bc5 4. Qg4 Nd4 5. Qxg7 Qf6 6. Qxf6 Nxf6 ' +
      '7. d3 Nxc2+ 8. Kd1 Nxa1 9. Nf3 d6 10. Bg5 Be6 11. Bxe6 fxe6 12. b3 Nxb3 ' +
      '13. axb3 Nxe4 14. Nxe4 0-1',
    white: 'You',
    black: 'Coach',
    result: '0-1',
    date: '2025-10-12',
    event: 'Practice game',
    eco: 'C25',
    whiteElo: 1450,
    blackElo: 1500,
    source: 'coach',
    annotations: [
      { m: 1, c: 'white', san: 'e4', eval: 25, classification: 'good' },
      { m: 1, c: 'black', san: 'e5', eval: 30, classification: 'good' },
      { m: 2, c: 'white', san: 'Nc3', eval: 30, classification: 'good', comment: 'Vienna Game.' },
      { m: 2, c: 'black', san: 'Nc6', eval: 25, classification: 'good' },
      { m: 3, c: 'white', san: 'Bc4', eval: 30, classification: 'good' },
      { m: 3, c: 'black', san: 'Bc5', eval: 35, classification: 'good' },
      { m: 4, c: 'white', san: 'Qg4', eval: -150, classification: 'mistake', best: 'd3', comment: 'Premature queen sortie.' },
      { m: 4, c: 'black', san: 'Nd4', eval: -180, classification: 'great', comment: 'Threatens c2 + activates the knight.' },
      { m: 5, c: 'white', san: 'Qxg7', eval: -400, classification: 'blunder', best: 'd3', comment: 'Greedy — opens lines for Black\'s attack.' },
      { m: 5, c: 'black', san: 'Qf6', eval: -420, classification: 'great', comment: 'Defends g7 and develops with tempo.' },
      { m: 6, c: 'white', san: 'Qxf6', eval: -300, classification: 'inaccuracy', best: 'Qh6' },
      { m: 6, c: 'black', san: 'Nxf6', eval: -320, classification: 'good' },
      { m: 7, c: 'white', san: 'd3', eval: -350, classification: 'good' },
      { m: 7, c: 'black', san: 'Nxc2+', eval: -700, classification: 'great', comment: 'Fork on the king + rook.' },
      { m: 8, c: 'white', san: 'Kd1', eval: -800, classification: 'good' },
      { m: 8, c: 'black', san: 'Nxa1', eval: -1100, classification: 'good' },
      { m: 9, c: 'white', san: 'Nf3', eval: -1100, classification: 'good' },
      { m: 9, c: 'black', san: 'd6', eval: -1100, classification: 'good' },
      { m: 10, c: 'white', san: 'Bg5', eval: -1200, classification: 'inaccuracy' },
      { m: 10, c: 'black', san: 'Be6', eval: -1300, classification: 'good' },
      { m: 11, c: 'white', san: 'Bxe6', eval: -1300, classification: 'good' },
      { m: 11, c: 'black', san: 'fxe6', eval: -1300, classification: 'good' },
      { m: 12, c: 'white', san: 'b3', eval: -1500, classification: 'inaccuracy' },
      { m: 12, c: 'black', san: 'Nxb3', eval: -1700, classification: 'good' },
      { m: 13, c: 'white', san: 'axb3', eval: -1700, classification: 'good' },
      { m: 13, c: 'black', san: 'Nxe4', eval: -1900, classification: 'great' },
      { m: 14, c: 'white', san: 'Nxe4', eval: -2200, classification: 'good' },
    ],
  },
  {
    id: 'sample-italian-amateur-2',
    pgn:
      '[Event "Casual game"]\n' +
      '[Site "Online"]\n' +
      '[Date "2025.11.03"]\n' +
      '[White "You"]\n' +
      '[Black "lichess opponent"]\n' +
      '[Result "1-0"]\n\n' +
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 ' +
      '8. O-O Bxc3 9. d5 Bf6 10. Re1 Ne7 11. Rxe4 d6 12. Bg5 Bxg5 13. Nxg5 O-O ' +
      '14. Nxh7 Kxh7 15. Qh5+ Kg8 16. Rh4 f6 17. Qh7+ Kf7 18. Qg6+ 1-0',
    white: 'You',
    black: 'lichess_opponent',
    result: '1-0',
    date: '2025-11-03',
    event: 'Online blitz',
    eco: 'C54',
    whiteElo: 1450,
    blackElo: 1470,
    source: 'lichess',
    annotations: [
      { m: 1, c: 'white', san: 'e4', eval: 25, classification: 'good' },
      { m: 1, c: 'black', san: 'e5', eval: 30, classification: 'good' },
      { m: 2, c: 'white', san: 'Nf3', eval: 35, classification: 'good' },
      { m: 2, c: 'black', san: 'Nc6', eval: 30, classification: 'good' },
      { m: 3, c: 'white', san: 'Bc4', eval: 30, classification: 'good', comment: 'Italian Game.' },
      { m: 3, c: 'black', san: 'Bc5', eval: 35, classification: 'good' },
      { m: 4, c: 'white', san: 'c3', eval: 40, classification: 'good' },
      { m: 4, c: 'black', san: 'Nf6', eval: 45, classification: 'good' },
      { m: 5, c: 'white', san: 'd4', eval: 50, classification: 'good' },
      { m: 5, c: 'black', san: 'exd4', eval: 60, classification: 'good' },
      { m: 6, c: 'white', san: 'cxd4', eval: 70, classification: 'good' },
      { m: 6, c: 'black', san: 'Bb4+', eval: 90, classification: 'good' },
      { m: 7, c: 'white', san: 'Nc3', eval: 110, classification: 'good' },
      { m: 7, c: 'black', san: 'Nxe4', eval: 130, classification: 'good' },
      { m: 8, c: 'white', san: 'O-O', eval: 150, classification: 'good' },
      { m: 8, c: 'black', san: 'Bxc3', eval: 170, classification: 'good' },
      { m: 9, c: 'white', san: 'd5', eval: 200, classification: 'great', comment: 'Italian Gambit attack — opens lines for the rook.' },
      { m: 9, c: 'black', san: 'Bf6', eval: 220, classification: 'good' },
      { m: 10, c: 'white', san: 'Re1', eval: 250, classification: 'good' },
      { m: 10, c: 'black', san: 'Ne7', eval: 270, classification: 'good' },
      { m: 11, c: 'white', san: 'Rxe4', eval: 300, classification: 'good' },
      { m: 11, c: 'black', san: 'd6', eval: 320, classification: 'good' },
      { m: 12, c: 'white', san: 'Bg5', eval: 380, classification: 'great' },
      { m: 12, c: 'black', san: 'Bxg5', eval: 450, classification: 'inaccuracy', best: 'O-O' },
      { m: 13, c: 'white', san: 'Nxg5', eval: 480, classification: 'good' },
      { m: 13, c: 'black', san: 'O-O', eval: 600, classification: 'mistake', best: 'h6', comment: 'Castled into the attack.' },
      { m: 14, c: 'white', san: 'Nxh7', eval: 700, classification: 'brilliant', comment: 'Greek-gift sac — Kxh7 walks into the mating attack.' },
      { m: 14, c: 'black', san: 'Kxh7', eval: 750, classification: 'good' },
      { m: 15, c: 'white', san: 'Qh5+', eval: 800, classification: 'good' },
      { m: 15, c: 'black', san: 'Kg8', eval: 850, classification: 'good' },
      { m: 16, c: 'white', san: 'Rh4', eval: 1100, classification: 'great' },
      { m: 16, c: 'black', san: 'f6', eval: 1300, classification: 'good' },
      { m: 17, c: 'white', san: 'Qh7+', eval: 1400, classification: 'good' },
      { m: 17, c: 'black', san: 'Kf7', eval: 1450, classification: 'good' },
      { m: 18, c: 'white', san: 'Qg6+', eval: 9999, classification: 'great', comment: 'Black resigned — mate in 2.' },
    ],
  },
  {
    id: 'sample-london-amateur-3',
    pgn:
      '[Event "Casual game"]\n' +
      '[Site "Online"]\n' +
      '[Date "2025.11.20"]\n' +
      '[White "You"]\n' +
      '[Black "chesscom_opp"]\n' +
      '[Result "1/2-1/2"]\n\n' +
      '1. d4 d5 2. Nf3 Nf6 3. Bf4 c5 4. e3 Nc6 5. c3 Bf5 6. Nbd2 e6 7. Bd3 Bxd3 ' +
      '8. Qxd3 Be7 9. O-O O-O 10. h3 Rc8 11. Rfe1 Qb6 12. Qb1 cxd4 13. exd4 Nh5 ' +
      '14. Bg3 Nxg3 15. fxg3 Bd6 16. Re3 Rfe8 17. Rae1 Rcd8 18. Ne5 Bxe5 ' +
      '19. dxe5 d4 20. cxd4 Nxd4 21. Rxe6 Nxe6 22. Rxe6 fxe6 1/2-1/2',
    white: 'You',
    black: 'chesscom_opp',
    result: '1/2-1/2',
    date: '2025-11-20',
    event: 'Online rapid',
    eco: 'D02',
    whiteElo: 1500,
    blackElo: 1520,
    source: 'chesscom',
    annotations: [
      { m: 1, c: 'white', san: 'd4', eval: 20, classification: 'good' },
      { m: 1, c: 'black', san: 'd5', eval: 25, classification: 'good' },
      { m: 2, c: 'white', san: 'Nf3', eval: 30, classification: 'good' },
      { m: 2, c: 'black', san: 'Nf6', eval: 30, classification: 'good' },
      { m: 3, c: 'white', san: 'Bf4', eval: 35, classification: 'good', comment: 'London System.' },
      { m: 3, c: 'black', san: 'c5', eval: 40, classification: 'good' },
      { m: 4, c: 'white', san: 'e3', eval: 35, classification: 'good' },
      { m: 4, c: 'black', san: 'Nc6', eval: 40, classification: 'good' },
      { m: 5, c: 'white', san: 'c3', eval: 35, classification: 'good' },
      { m: 5, c: 'black', san: 'Bf5', eval: 30, classification: 'good' },
      { m: 6, c: 'white', san: 'Nbd2', eval: 25, classification: 'good' },
      { m: 6, c: 'black', san: 'e6', eval: 20, classification: 'good' },
      { m: 7, c: 'white', san: 'Bd3', eval: 30, classification: 'good' },
      { m: 7, c: 'black', san: 'Bxd3', eval: 35, classification: 'good' },
      { m: 8, c: 'white', san: 'Qxd3', eval: 30, classification: 'good' },
      { m: 8, c: 'black', san: 'Be7', eval: 35, classification: 'good' },
      { m: 9, c: 'white', san: 'O-O', eval: 30, classification: 'good' },
      { m: 9, c: 'black', san: 'O-O', eval: 35, classification: 'good' },
      { m: 10, c: 'white', san: 'h3', eval: 25, classification: 'good' },
      { m: 10, c: 'black', san: 'Rc8', eval: 30, classification: 'good' },
      { m: 11, c: 'white', san: 'Rfe1', eval: 25, classification: 'good' },
      { m: 11, c: 'black', san: 'Qb6', eval: 30, classification: 'good' },
      { m: 12, c: 'white', san: 'Qb1', eval: 20, classification: 'good' },
      { m: 12, c: 'black', san: 'cxd4', eval: 25, classification: 'good' },
      { m: 13, c: 'white', san: 'exd4', eval: 25, classification: 'good' },
      { m: 13, c: 'black', san: 'Nh5', eval: 30, classification: 'good' },
      { m: 14, c: 'white', san: 'Bg3', eval: 35, classification: 'good' },
      { m: 14, c: 'black', san: 'Nxg3', eval: 40, classification: 'good' },
      { m: 15, c: 'white', san: 'fxg3', eval: 30, classification: 'good' },
      { m: 15, c: 'black', san: 'Bd6', eval: 35, classification: 'good' },
      { m: 16, c: 'white', san: 'Re3', eval: 25, classification: 'good' },
      { m: 16, c: 'black', san: 'Rfe8', eval: 30, classification: 'good' },
      { m: 17, c: 'white', san: 'Rae1', eval: 20, classification: 'good' },
      { m: 17, c: 'black', san: 'Rcd8', eval: 25, classification: 'good' },
      { m: 18, c: 'white', san: 'Ne5', eval: 30, classification: 'good' },
      { m: 18, c: 'black', san: 'Bxe5', eval: 35, classification: 'good' },
      { m: 19, c: 'white', san: 'dxe5', eval: 30, classification: 'good' },
      { m: 19, c: 'black', san: 'd4', eval: 35, classification: 'good' },
      { m: 20, c: 'white', san: 'cxd4', eval: 30, classification: 'good' },
      { m: 20, c: 'black', san: 'Nxd4', eval: 35, classification: 'good' },
      { m: 21, c: 'white', san: 'Rxe6', eval: 0, classification: 'good', comment: 'Forcing the perpetual.' },
      { m: 21, c: 'black', san: 'Nxe6', eval: 0, classification: 'good' },
      { m: 22, c: 'white', san: 'Rxe6', eval: 0, classification: 'good' },
      { m: 22, c: 'black', san: 'fxe6', eval: 0, classification: 'good', comment: 'Drawn endgame.' },
    ],
  },
];

function expandAnnotations(annots: SampleAnnotation[]): MoveAnnotation[] {
  // `bestMoveEval` for each entry = the prior annotation's `eval`
  // (i.e., the eval of the position BEFORE this move was played). For
  // the very first entry, the pre-move position is the starting
  // position which the engine treats as ~0.0. Same cp/White-POV unit
  // as `evaluation` so detectMisses / detectMissedTactics can compute
  // the swing the moving side conceded.
  let prevEval = 0;
  return annots.map((a) => {
    const annotation: MoveAnnotation = {
      moveNumber: a.m,
      color: a.c,
      san: a.san,
      evaluation: a.eval,
      bestMove: a.best ?? null,
      bestMoveEval: prevEval,
      classification: a.classification ?? 'good',
      comment: a.comment ?? null,
    };
    prevEval = a.eval;
    return annotation;
  });
}

function buildGameRecord(s: SampleGame): GameRecord {
  return {
    id: s.id,
    pgn: s.pgn,
    white: s.white,
    black: s.black,
    result: s.result,
    date: s.date,
    event: s.event,
    eco: s.eco,
    whiteElo: s.whiteElo,
    blackElo: s.blackElo,
    source: s.source,
    annotations: expandAnnotations(s.annotations),
    coachAnalysis: null,
    isMasterGame: s.source === 'master',
    openingId: null,
    fullyAnalyzed: true,
  };
}

/** Idempotent — first call inserts the 5 samples and sets a meta
 *  flag; subsequent calls are no-ops. Designed to be invoked from
 *  /coach/review on mount so the user has something to click into
 *  immediately on the preview deploy. */
export async function seedReviewSamplesIfNeeded(): Promise<{ seeded: number }> {
  try {
    const flag = await db.meta.get(SAMPLES_SEEDED_META_KEY);
    if (flag?.value === 'true') {
      return { seeded: 0 };
    }
    const records = SAMPLE_GAMES.map(buildGameRecord);
    await db.games.bulkPut(records);
    await db.meta.put({ key: SAMPLES_SEEDED_META_KEY, value: 'true' });
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'reviewSampleGames.seedReviewSamplesIfNeeded',
      summary: `seeded ${records.length} sample games for /coach/review`,
      details: JSON.stringify({ ids: records.map((r) => r.id) }),
    });
    return { seeded: records.length };
  } catch (err) {
    void logAppAudit({
      kind: 'lichess-error',
      category: 'subsystem',
      source: 'reviewSampleGames.seedReviewSamplesIfNeeded',
      summary: `seed failed: ${err instanceof Error ? err.message : String(err)}`,
      details: JSON.stringify({}),
    });
    return { seeded: 0 };
  }
}
