import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FromYourGamesTab } from './FromYourGamesTab';
import { db } from '../../db/schema';

describe('FromYourGamesTab', () => {
  beforeEach(async () => {
    await db.games.clear();
  });

  it('renders the loading state initially', () => {
    render(<FromYourGamesTab onExit={() => undefined} />);
    expect(screen.getByText(/Mining your games/i)).toBeInTheDocument();
  });

  it('renders the empty state when no games are mineable', async () => {
    render(<FromYourGamesTab onExit={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText('From Your Games')).toBeInTheDocument();
    });
    expect(screen.getByText(/No mineable endgame mistakes yet/i)).toBeInTheDocument();
    expect(screen.getByText('Back to endgames')).toBeInTheDocument();
  });

  it('shows the picker when mined positions exist', async () => {
    await db.games.add({
      id: 'g-test',
      pgn:
        '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6 dxc6 5.d4 exd4 6.Qxd4 Qxd4 ' +
        '7.Nxd4 Bd7 8.Bf4 O-O-O 9.Nc3 Nf6 10.O-O-O Re8 11.f3 c5 ' +
        '12.Nde2 Bf5 13.Nd5 Nxd5 14.exd5 Bxc2 15.Kxc2 *',
      white: 'You',
      black: 'paulrudd',
      result: '0-1',
      date: '2026-03-14',
      event: 'Lichess',
      eco: null,
      whiteElo: 1200,
      blackElo: 1200,
      source: 'lichess',
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
        {
          moveNumber: 15,
          color: 'white',
          san: 'Kxc2',
          evaluation: 50,
          bestMove: 'better',
          classification: 'blunder',
          comment: null,
        },
      ],
      coachAnalysis: null,
      isMasterGame: false,
      openingId: null,
      fullyAnalyzed: true,
    });
    render(<FromYourGamesTab onExit={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('from-your-games-tile-0')).toBeInTheDocument();
    });
    expect(screen.getByText(/1 endgame mistake mined/i)).toBeInTheDocument();
    expect(screen.getByText('BLUNDER')).toBeInTheDocument();
  });
});
