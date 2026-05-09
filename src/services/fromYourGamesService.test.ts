import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/schema';
import { mineEndgamePositions } from './fromYourGamesService';
import type { GameRecord, MoveAnnotation } from '../types';

/** "From Your Games" mining contract:
 *  1. Returns mistakes/blunders only (inaccuracies excluded)
 *  2. Returns endgame-phase moves only (queens off OR move ≥30)
 *  3. Sorted by severity (largest eval drop first)
 *  4. Skips games without `fullyAnalyzed=true`
 *  5. Builds correct FENs by replaying PGN ply-by-ply
 *  6. Caps at the requested limit
 */

const SAMPLE_PGN_QUEEN_OFF =
  // Queens trade on move 6 (Qxd4 Qxd4 7.Nxd4). Move 15 is a
  // queens-off endgame phase test point.
  '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6 dxc6 5.d4 exd4 6.Qxd4 Qxd4 ' +
  '7.Nxd4 Bd7 8.Bf4 O-O-O 9.Nc3 Nf6 10.O-O-O Re8 11.f3 c5 ' +
  '12.Nde2 Bf5 13.Nd5 Nxd5 14.exd5 Bxc2 15.Kxc2 *';

function buildGame(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: 'g1',
    pgn: SAMPLE_PGN_QUEEN_OFF,
    white: 'You',
    black: 'Opponent',
    result: '1/2-1/2',
    date: '2026-03-14',
    event: 'Lichess',
    eco: null,
    whiteElo: 1200,
    blackElo: 1200,
    source: 'lichess',
    annotations: null,
    coachAnalysis: null,
    isMasterGame: false,
    openingId: null,
    fullyAnalyzed: true,
    ...overrides,
  };
}

function blunderAnnotation(
  moveNumber: number,
  color: 'white' | 'black',
  san: string,
  evaluation: number,
): MoveAnnotation {
  return {
    moveNumber,
    color,
    san,
    evaluation,
    bestMove: 'better',
    classification: 'blunder',
    comment: null,
  };
}

describe('mineEndgamePositions', () => {
  beforeEach(async () => {
    await db.games.clear();
  });

  it('returns nothing when there are no games', async () => {
    const result = await mineEndgamePositions();
    expect(result).toEqual([]);
  });

  it('skips games not flagged fullyAnalyzed by default', async () => {
    await db.games.add(
      buildGame({
        annotations: [blunderAnnotation(15, 'white', 'Re5', 200)],
        fullyAnalyzed: false,
      }),
    );
    const result = await mineEndgamePositions();
    expect(result).toEqual([]);
  });

  it('includes blunder annotations in queens-off positions', async () => {
    await db.games.add(
      buildGame({
        annotations: [
          // Baseline: black's 14th move (ply 27). Eval +300cp for
          // white = white is winning before the blunder.
          {
            moveNumber: 14,
            color: 'black',
            san: 'Bxc2',
            evaluation: 300,
            bestMove: null,
            classification: 'good',
            comment: null,
          },
          // Blunder: white's 15th move (ply 28) drops to +50cp.
          // -250cp drop counts as a blunder.
          blunderAnnotation(15, 'white', 'Kxc2', 50),
        ],
      }),
    );
    const result = await mineEndgamePositions();
    expect(result.length).toBeGreaterThan(0);
    const top = result[0];
    expect(top.classification).toBe('blunder');
    expect(top.evalDrop).toBeLessThan(0);
  });

  it('excludes inaccuracies — only mistake/blunder qualify', async () => {
    await db.games.add(
      buildGame({
        annotations: [
          {
            moveNumber: 15,
            color: 'white',
            san: 'Nxd5',
            evaluation: -200,
            bestMove: 'Nxg7',
            classification: 'inaccuracy',
            comment: null,
          },
        ],
      }),
    );
    const result = await mineEndgamePositions();
    expect(result).toEqual([]);
  });

  it('caps results to the requested limit', async () => {
    // Five blunders on different game records.
    for (let i = 0; i < 5; i += 1) {
      await db.games.add(
        buildGame({
          id: `g-${i}`,
          annotations: [
            {
              moveNumber: 14,
              color: 'black',
              san: 'Bxc2',
              evaluation: 200 - i * 100,
              bestMove: null,
              classification: 'good',
              comment: null,
            },
            blunderAnnotation(15, 'white', 'Kxc2', -50 - i * 100),
          ],
        }),
      );
    }
    const result = await mineEndgamePositions({ limit: 3 });
    expect(result.length).toBe(3);
  });

  it('sorts by severity — largest eval drop first', async () => {
    await db.games.add(
      buildGame({
        id: 'g-mild',
        annotations: [
          {
            moveNumber: 14,
            color: 'black',
            san: 'Bxc2',
            evaluation: 100,
            bestMove: null,
            classification: 'good',
            comment: null,
          },
          blunderAnnotation(15, 'white', 'Kxc2', -50), // -150 drop
        ],
      }),
    );
    await db.games.add(
      buildGame({
        id: 'g-severe',
        annotations: [
          {
            moveNumber: 14,
            color: 'black',
            san: 'Bxc2',
            evaluation: 300,
            bestMove: null,
            classification: 'good',
            comment: null,
          },
          blunderAnnotation(15, 'white', 'Kxc2', -500), // -800 drop
        ],
      }),
    );
    const result = await mineEndgamePositions();
    expect(result[0].gameId).toBe('g-severe');
  });
});
