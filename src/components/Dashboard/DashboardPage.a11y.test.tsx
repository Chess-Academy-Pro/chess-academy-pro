import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test/utils';
import { useAppStore } from '../../stores/appStore';
import { buildUserProfile } from '../../test/factories';

vi.mock('../../services/sessionGenerator', () => ({
  updateStreak: vi.fn().mockResolvedValue({ currentStreak: 5, longestStreak: 10 }),
}));

vi.mock('../../services/dataLoader', () => ({
  seedDatabase: vi.fn().mockResolvedValue(undefined),
}));

const { DashboardPage } = await import('./DashboardPage');

describe('DashboardPage a11y', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    const profile = buildUserProfile({
      id: 'main',
      name: 'TestPlayer',
      currentStreak: 5,
    });
    useAppStore.getState().setActiveProfile(profile);
  });

  it('has h1 heading with app title', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toBeInTheDocument();
      expect(heading.textContent).toContain('Chess Academy Pro');
    });
  });

  it('shows all section buttons', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Openings')).toBeInTheDocument();
      // The Coach tile label was simplified from "Play with Coach" to
      // just "Coach" — see DashboardPage SECTIONS list.
      expect(screen.getByText('Coach')).toBeInTheDocument();
      expect(screen.getByText('Tactics')).toBeInTheDocument();
      expect(screen.getByText('Weaknesses')).toBeInTheDocument();
    });
  });

  it('dashboard has data-testid', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
  });
});
