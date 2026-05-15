import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoardGlowSettings, BoardGlowButton } from './BoardGlowSettings';
import { useAppStore } from '../../stores/appStore';
import { buildUserProfile } from '../../test/factories';

// Wrap with MemoryRouter for any hook that might need it
import { MemoryRouter } from 'react-router-dom';

function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('BoardGlowButton', () => {
  it('renders the glow settings button', () => {
    const onClick = vi.fn();
    renderWithProviders(<BoardGlowButton onClick={onClick} />);
    const btn = screen.getByTestId('board-glow-btn');
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('Board Glow Settings');
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    renderWithProviders(<BoardGlowButton onClick={onClick} />);
    fireEvent.click(screen.getByTestId('board-glow-btn'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('BoardGlowSettings', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    useAppStore.getState().setActiveProfile(buildUserProfile());
  });

  it('renders the master dimmer slider', () => {
    renderWithProviders(<BoardGlowSettings />);
    expect(screen.getByTestId('dimmer-master')).toBeDefined();
  });

  it('renders the mock chess board preview with pieces', () => {
    renderWithProviders(<BoardGlowSettings />);
    const board = screen.getByTestId('mock-chess-board');
    expect(board).toBeDefined();
    // Board should contain piece images
    const pieces = board.querySelectorAll('img');
    expect(pieces.length).toBe(32); // full starting position
  });

  it('renders board glow color presets', () => {
    renderWithProviders(<BoardGlowSettings />);
    expect(screen.getByTestId('neon-preset-board-glow-color-cyan')).toBeDefined();
    expect(screen.getByTestId('neon-preset-board-glow-color-purple')).toBeDefined();
  });

  it('renders piece glow color pickers', () => {
    renderWithProviders(<BoardGlowSettings />);
    expect(screen.getByTestId('neon-preset-white-pieces-green')).toBeDefined();
    expect(screen.getByTestId('neon-preset-black-pieces-purple')).toBeDefined();
  });

  it('renders reset button', () => {
    renderWithProviders(<BoardGlowSettings />);
    expect(screen.getByTestId('glow-reset-btn')).toBeDefined();
  });

  it('auto-saves after changing brightness', async () => {
    renderWithProviders(<BoardGlowSettings />);
    const slider = screen.getByTestId('dimmer-master');
    fireEvent.change(slider, { target: { value: '150' } });
    // Auto-save shows status after debounce
    await waitFor(() => {
      expect(screen.getByTestId('glow-save-status')).toBeDefined();
    }, { timeout: 2000 });
  });

  it('clicking a preset color triggers auto-save', async () => {
    renderWithProviders(<BoardGlowSettings />);
    const purpleBtn = screen.getByTestId('neon-preset-board-glow-color-purple');
    fireEvent.click(purpleBtn);
    await waitFor(() => {
      expect(screen.getByTestId('glow-save-status')).toBeDefined();
    }, { timeout: 2000 });
  });
});
