import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { CoachHomePage } from './CoachHomePage';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('CoachHomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders coach home page container', () => {
    render(<CoachHomePage />);
    expect(screen.getByTestId('coach-home-page')).toBeInTheDocument();
  });

  it('does not show the legacy "Work with Coach" tile (folded into Learn / Training Plan)', () => {
    render(<CoachHomePage />);
    expect(screen.queryByTestId('coach-action-train')).not.toBeInTheDocument();
  });

  it('shows "Play" action card', () => {
    render(<CoachHomePage />);
    const card = screen.getByTestId('coach-action-play');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Play');
  });

  it('shows "Learn" action card', () => {
    render(<CoachHomePage />);
    const card = screen.getByTestId('coach-action-teach');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Learn');
  });

  it('shows "Game Insights" action card', () => {
    render(<CoachHomePage />);
    const card = screen.getByTestId('coach-action-report');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Game Insights');
  });

  it('shows secondary actions: Training Plan, Analyse, Review', () => {
    render(<CoachHomePage />);

    const plan = screen.getByTestId('coach-action-plan');
    expect(plan).toBeInTheDocument();
    expect(plan).toHaveTextContent('Training Plan');

    const analyse = screen.getByTestId('coach-action-analyse');
    expect(analyse).toBeInTheDocument();
    expect(analyse).toHaveTextContent('Analyse');

    const review = screen.getByTestId('coach-action-review');
    expect(review).toBeInTheDocument();
    expect(review).toHaveTextContent('Review');
  });

  it('does NOT show a Chat tile — chat is inline on every board', () => {
    render(<CoachHomePage />);
    expect(screen.queryByTestId('coach-action-chat')).not.toBeInTheDocument();
  });

  it('shows the Endgame tile as a primary (col-span-2 layout)', () => {
    render(<CoachHomePage />);
    const tile = screen.getByTestId('coach-action-endgame');
    expect(tile).toBeInTheDocument();
    expect(tile).toHaveTextContent('Endgame');
    // The wide-primary variant uses col-span-2 to peer visually
    // with the Learn/Play pair above.
    expect(tile.className).toMatch(/col-span-2/);
  });

  it('navigates to /coach/play when "Play" is clicked', () => {
    render(<CoachHomePage />);
    fireEvent.click(screen.getByTestId('coach-action-play'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/play');
  });

  it('navigates to /coach/report when "Game Insights" is clicked', () => {
    render(<CoachHomePage />);
    fireEvent.click(screen.getByTestId('coach-action-report'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/report');
  });

  it('navigates to /coach/plan when "Training Plan" is clicked', () => {
    render(<CoachHomePage />);
    fireEvent.click(screen.getByTestId('coach-action-plan'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/plan');
  });

  it('navigates to /coach/analyse when "Analyse" is clicked', () => {
    render(<CoachHomePage />);
    fireEvent.click(screen.getByTestId('coach-action-analyse'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/analyse');
  });

  it('navigates to /coach/endgame when "Endgame" is clicked', () => {
    render(<CoachHomePage />);
    fireEvent.click(screen.getByTestId('coach-action-endgame'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/endgame');
  });
});
