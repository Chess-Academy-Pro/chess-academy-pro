import { describe, it, expect } from 'vitest';
import { reconstructMovesFromGame } from './gameReconstructionService';
import type { GameRecord, MoveAnnotation } from '../types/index';

function buildGameRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: 'game-1',
    pgn: '1. e4 e5 2. Nf3 Nc6',
    white: 'Player',
    black: 'AI Coach',
    result: '*',
    date: '2024-01-01',
    event: 'Coach Game',
    eco: null,
    whiteElo: null,
    blackElo: null,
    source: 'coach',
    annotations: null,
    coachAnalysis: null,
    isMasterGame: false,
    openingId: null,
    ...overrides,
  };
}

describe('reconstructMovesFromGame', () => {
  it('reconstructs a simple 4-move PGN with correct SANs and moveNumbers', () => {
    const game = buildGameRecord({ pgn: '1. e4 e5 2. Nf3 Nc6' });
    const moves = reconstructMovesFromGame(game);

    expect(moves).toHaveLength(4);
    expect(moves[0].san).toBe('e4');
    expect(moves[0].moveNumber).toBe(1);
    expect(moves[1].san).toBe('e5');
    expect(moves[1].moveNumber).toBe(2);
    expect(moves[2].san).toBe('Nf3');
    expect(moves[2].moveNumber).toBe(3);
    expect(moves[3].san).toBe('Nc6');
    expect(moves[3].moveNumber).toBe(4);
  });

  it('generates valid FEN for each move', () => {
    const game = buildGameRecord({ pgn: '1. e4 e5 2. Nf3 Nc6' });
    const moves = reconstructMovesFromGame(game);

    // After 1. e4
    expect(moves[0].fen).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    );
    // After 1...e5
    expect(moves[1].fen).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
    );
    // After 2. Nf3
    expect(moves[2].fen).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'
    );
    // After 2...Nc6
    expect(moves[3].fen).toBe(
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'
    );
  });

  it('merges annotations (evaluation, bestMove, classification, comment)', () => {
    // Evals are CENTIPAWNS (White POV) — the unit MoveAnnotation
    // standardised on when `bestMoveEval` was added. Reconstruction
    // passes the value through unchanged now (no more pawn→cp `* 100`).
    const annotations: MoveAnnotation[] = [
      {
        moveNumber: 1,
        color: 'white',
        san: 'e4',
        evaluation: 30,
        bestMove: 'd4',
        bestMoveEval: 0,
        classification: 'good',
        comment: 'Solid opening move',
      },
      {
        moveNumber: 1,
        color: 'black',
        san: 'e5',
        evaluation: 10,
        bestMove: 'c5',
        bestMoveEval: 30,
        classification: 'book',
        comment: 'Classical response',
      },
    ];

    const game = buildGameRecord({
      pgn: '1. e4 e5',
      annotations,
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves[0].evaluation).toBe(30);
    expect(moves[0].bestMove).toBe('d4');
    expect(moves[0].classification).toBe('good');
    expect(moves[0].commentary).toBe('Solid opening move');

    expect(moves[1].evaluation).toBe(10);
    expect(moves[1].bestMove).toBe('c5');
    expect(moves[1].classification).toBe('book');
    expect(moves[1].commentary).toBe('Classical response');
  });

  it('uses defaults when no annotations exist', () => {
    const game = buildGameRecord({
      pgn: '1. d4 d5',
      annotations: null,
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves[0].evaluation).toBeNull();
    expect(moves[0].bestMove).toBeNull();
    expect(moves[0].classification).toBeNull();
    expect(moves[0].commentary).toBe('');

    expect(moves[1].evaluation).toBeNull();
    expect(moves[1].bestMove).toBeNull();
    expect(moves[1].classification).toBeNull();
    expect(moves[1].commentary).toBe('');
  });

  it('sets isCoachMove correctly when player is black (AI Coach is white)', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3 Nc6',
      white: 'AI Coach',
      black: 'Player',
    });

    const moves = reconstructMovesFromGame(game);

    // White moves are coach moves when player is black
    expect(moves[0].isCoachMove).toBe(true);  // 1. e4 (white = coach)
    expect(moves[1].isCoachMove).toBe(false); // 1...e5 (black = player)
    expect(moves[2].isCoachMove).toBe(true);  // 2. Nf3 (white = coach)
    expect(moves[3].isCoachMove).toBe(false); // 2...Nc6 (black = player)
  });

  it('sets isCoachMove correctly when player is white', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3 Nc6',
      white: 'Player',
      black: 'AI Coach',
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves[0].isCoachMove).toBe(false); // 1. e4 (white = player)
    expect(moves[1].isCoachMove).toBe(true);  // 1...e5 (black = coach)
    expect(moves[2].isCoachMove).toBe(false); // 2. Nf3 (white = player)
    expect(moves[3].isCoachMove).toBe(true);  // 2...Nc6 (black = coach)
  });

  it('chains preMoveEval from previous move evaluations', () => {
    // Centipawn evals, same contract as the merge test above.
    const annotations: MoveAnnotation[] = [
      {
        moveNumber: 1,
        color: 'white',
        san: 'e4',
        evaluation: 30,
        bestMove: null,
        bestMoveEval: 0,
        classification: 'good',
        comment: null,
      },
      {
        moveNumber: 1,
        color: 'black',
        san: 'e5',
        evaluation: -10,
        bestMove: null,
        bestMoveEval: 30,
        classification: 'book',
        comment: null,
      },
      {
        moveNumber: 2,
        color: 'white',
        san: 'Nf3',
        evaluation: 50,
        bestMove: null,
        bestMoveEval: -10,
        classification: 'good',
        comment: null,
      },
    ];

    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3',
      annotations,
    });

    const moves = reconstructMovesFromGame(game);

    // First move has no previous eval
    expect(moves[0].preMoveEval).toBeNull();
    // Second move's preMoveEval = first move's evaluation (30 cp)
    expect(moves[1].preMoveEval).toBe(30);
    // Third move's preMoveEval = second move's evaluation (-10 cp)
    expect(moves[2].preMoveEval).toBe(-10);
  });

  it('returns empty array for PGN with illegal moves (chess.js rejects the whole PGN)', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Qh8 Nc6', // Qh8 is illegal from starting position after 1.e4 e5
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves).toHaveLength(0);
  });

  it('parses PGN with headers (imported Chess.com/Lichess games)', () => {
    const game = buildGameRecord({
      pgn: `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.01.15"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
[ECO "C65"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`,
      white: 'Alice',
      black: 'Bob',
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves).toHaveLength(6);
    expect(moves[0].san).toBe('e4');
    expect(moves[5].san).toBe('a6');
  });

  it('respects explicit playerColor for imported games where user played black', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3 Nc6',
      white: 'Opponent',
      black: 'User',
    });

    // Without playerColor, heuristic defaults to playerIsWhite=true (white
    // player isn't an AI name), so black moves would be mis-marked as coach
    // moves. With playerColor='black', the user's moves are correctly kept.
    const moves = reconstructMovesFromGame(game, 'black');

    expect(moves[0].isCoachMove).toBe(true);  // opponent's e4
    expect(moves[1].isCoachMove).toBe(false); // user's e5
    expect(moves[3].isCoachMove).toBe(false); // user's Nc6
  });

  it('returns empty array for empty PGN', () => {
    const game = buildGameRecord({ pgn: '' });
    const moves = reconstructMovesFromGame(game);
    expect(moves).toHaveLength(0);
  });

  it('returns empty array for whitespace-only PGN', () => {
    const game = buildGameRecord({ pgn: '   ' });
    const moves = reconstructMovesFromGame(game);
    expect(moves).toHaveLength(0);
  });

  it('sets expanded=false and bestMoveEval=null on all moves', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3 Nc6',
      annotations: [
        {
          moveNumber: 1,
          color: 'white',
          san: 'e4',
          evaluation: 0.3,
          bestMove: 'd4',
          classification: 'good',
          comment: 'Test',
        },
      ],
    });

    const moves = reconstructMovesFromGame(game);

    for (const move of moves) {
      expect(move.expanded).toBe(false);
      expect(move.bestMoveEval).toBeNull();
    }
  });

  it('handles PGN without move numbers', () => {
    const game = buildGameRecord({ pgn: 'e4 e5 Nf3 Nc6' });
    const moves = reconstructMovesFromGame(game);

    expect(moves).toHaveLength(4);
    expect(moves[0].san).toBe('e4');
    expect(moves[3].san).toBe('Nc6');
  });

  it('handles longer games correctly', () => {
    const game = buildGameRecord({
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7',
    });

    const moves = reconstructMovesFromGame(game);

    expect(moves).toHaveLength(10);
    expect(moves[8].san).toBe('O-O');
    expect(moves[9].san).toBe('Be7');
    expect(moves[9].moveNumber).toBe(10);
  });
});
