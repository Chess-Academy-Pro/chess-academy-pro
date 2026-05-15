import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { PieceSoundPanel } from './PieceSoundPanel';
import { db } from '../../db/schema';
import { useAppStore } from '../../stores/appStore';
import { buildUserProfile } from '../../test/factories';
import { soundService } from '../../services/soundService';

vi.spyOn(soundService, 'play').mockImplementation(() => {});
const setCustomizationSpy = vi.spyOn(soundService, 'setCustomization');

describe('PieceSoundPanel', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useAppStore.getState().reset();
    useAppStore.getState().setActiveProfile(buildUserProfile());
    setCustomizationSpy.mockClear();
  });

  it('renders all four sliders + reset + test buttons', () => {
    render(<PieceSoundPanel />);
    expect(screen.getByTestId('piece-sound-pitch')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-tone')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-waveform')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-length')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-reset')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-test-move')).toBeInTheDocument();
    expect(screen.getByTestId('piece-sound-test-all')).toBeInTheDocument();
  });

  it('all sliders default to 50 when profile has no custom values', () => {
    render(<PieceSoundPanel />);
    expect((screen.getByTestId('piece-sound-pitch')).value).toBe('50');
    expect((screen.getByTestId('piece-sound-tone')).value).toBe('50');
    expect((screen.getByTestId('piece-sound-waveform')).value).toBe('50');
    expect((screen.getByTestId('piece-sound-length')).value).toBe('50');
  });

  it('moving a slider applies the customization to soundService immediately (live preview)', () => {
    render(<PieceSoundPanel />);
    fireEvent.change(screen.getByTestId('piece-sound-pitch'), { target: { value: '80' } });
    expect(setCustomizationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pitch: 80 }),
    );
  });

  it('Test move button triggers soundService.play with type=move', () => {
    const playSpy = soundService.play as unknown as ReturnType<typeof vi.fn>;
    playSpy.mockClear();
    render(<PieceSoundPanel />);
    fireEvent.click(screen.getByTestId('piece-sound-test-move'));
    expect(playSpy).toHaveBeenCalledWith('move');
  });

  it('Reset button restores all sliders to 50', () => {
    render(<PieceSoundPanel />);
    fireEvent.change(screen.getByTestId('piece-sound-pitch'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('piece-sound-tone'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('piece-sound-reset'));
    expect((screen.getByTestId('piece-sound-pitch')).value).toBe('50');
    expect((screen.getByTestId('piece-sound-tone')).value).toBe('50');
  });

  it('debounced persistence writes slider values to the active profile', async () => {
    render(<PieceSoundPanel />);
    fireEvent.change(screen.getByTestId('piece-sound-pitch'), { target: { value: '70' } });
    fireEvent.change(screen.getByTestId('piece-sound-length'), { target: { value: '30' } });
    // Wait past the 250 ms debounce.
    await waitFor(
      () => {
        const profile = useAppStore.getState().activeProfile;
        expect(profile?.preferences.pieceSoundPitch).toBe(70);
        expect(profile?.preferences.pieceSoundLength).toBe(30);
      },
      { timeout: 1000 },
    );
  });
});
