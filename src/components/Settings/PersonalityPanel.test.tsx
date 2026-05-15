import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { PersonalityPanel } from './PersonalityPanel';
import { db } from '../../db/schema';
import { buildUserProfile } from '../../test/factories';
import * as appAuditor from '../../services/appAuditor';
import type { UserProfile } from '../../types';

const logAppAuditSpy = vi.spyOn(appAuditor, 'logAppAudit').mockImplementation(async () => {});

describe('PersonalityPanel', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    logAppAuditSpy.mockClear();
  });

  function setup(): { profile: UserProfile; setProfile: ReturnType<typeof vi.fn> } {
    const profile = buildUserProfile();
    const setProfile = vi.fn();
    render(<PersonalityPanel profile={profile} setProfile={setProfile} />);
    return { profile, setProfile };
  }

  it('renders the row with current personality summary', () => {
    setup();
    expect(screen.getByTestId('personality-row')).toBeInTheDocument();
    // Default profile → "Default · all dials off"
    expect(screen.getByText(/Default · all dials off/i)).toBeInTheDocument();
  });

  it('opens the modal panel on row click', () => {
    setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    expect(screen.getByTestId('personality-panel')).toBeInTheDocument();
    // All 5 picker cards present.
    expect(screen.getByTestId('personality-card-default')).toBeInTheDocument();
    expect(screen.getByTestId('personality-card-soft')).toBeInTheDocument();
    expect(screen.getByTestId('personality-card-edgy')).toBeInTheDocument();
    expect(screen.getByTestId('personality-card-flirtatious')).toBeInTheDocument();
    expect(screen.getByTestId('personality-card-drill-sergeant')).toBeInTheDocument();
  });

  it('selecting a personality auto-seeds the dial defaults', () => {
    setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-drill-sergeant'));
    // Drill sergeant defaults: profanity=hard, mockery=hard, flirt=none.
    expect(screen.getByTestId('dial-profanity-hard')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dial-mockery-hard')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dial-flirt-none')).toHaveAttribute('aria-checked', 'true');
  });

  it('user can override a dial after picking a personality', () => {
    setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-drill-sergeant'));
    fireEvent.click(screen.getByTestId('dial-flirt-medium'));
    expect(screen.getByTestId('dial-flirt-medium')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dial-flirt-none')).toHaveAttribute('aria-checked', 'false');
  });

  it('auto-saves picker change to the profile + fires the audit (WO-AUTOSAVE-01)', async () => {
    const profile = buildUserProfile();
    // Seed Dexie so the .update() call has a row to mutate. setup()
    // uses fresh profiles, but it doesn't insert them into Dexie —
    // for this test we want to verify the persisted side as well.
    await db.profiles.put(profile);
    const setProfile = vi.fn();
    render(<PersonalityPanel profile={profile} setProfile={setProfile} />);
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-edgy'));
    // Auto-save is debounced 250ms. waitFor polls until the parent
    // setProfile was called with the persisted preferences.
    await waitFor(() => {
      expect(setProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            coachPersonality: 'edgy',
            coachProfanity: 'medium',
            coachMockery: 'hard',
            coachFlirt: 'none',
          }),
        }),
      );
    });
    // Persisted to Dexie too.
    const stored = await db.profiles.get(profile.id);
    expect(stored?.preferences.coachPersonality).toBe('edgy');
    // Audit fired with the before / after summary.
    expect(logAppAuditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'coach-personality-changed',
        category: 'subsystem',
      }),
    );
  });

  it('Done button closes the modal (settings already auto-persisted)', async () => {
    const { setProfile } = setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-flirtatious'));
    // Wait for auto-save to fire.
    await waitFor(() => expect(setProfile).toHaveBeenCalled());
    // Done closes the modal — there's no longer a Cancel-discards path.
    fireEvent.click(screen.getByTestId('personality-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('personality-panel')).not.toBeInTheDocument();
    });
  });

  it('Reset dials resets to current draft personality defaults', () => {
    setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-drill-sergeant'));
    // Override a dial.
    fireEvent.click(screen.getByTestId('dial-profanity-none'));
    expect(screen.getByTestId('dial-profanity-none')).toHaveAttribute('aria-checked', 'true');
    // Reset → drill sergeant default = hard.
    fireEvent.click(screen.getByTestId('personality-reset-dials'));
    expect(screen.getByTestId('dial-profanity-hard')).toHaveAttribute('aria-checked', 'true');
  });

  it('row summary updates after auto-save', async () => {
    const profile = buildUserProfile();
    let saved: UserProfile = profile;
    const setProfile = vi.fn((p: UserProfile) => {
      saved = p;
    });
    const { rerender } = render(<PersonalityPanel profile={profile} setProfile={setProfile} />);
    fireEvent.click(screen.getByTestId('personality-row'));
    fireEvent.click(screen.getByTestId('personality-card-edgy'));
    await waitFor(() => expect(setProfile).toHaveBeenCalled());
    // Close the modal so only the row summary remains in the DOM
    // (otherwise the picker card label collides with the row text).
    fireEvent.click(screen.getByTestId('personality-done'));
    await waitFor(() => expect(screen.queryByTestId('personality-panel')).not.toBeInTheDocument());
    rerender(<PersonalityPanel profile={saved} setProfile={setProfile} />);
    const row = screen.getByTestId('personality-row');
    expect(row.textContent).toMatch(/Edgy/);
    expect(row.textContent).toMatch(/P:Medium M:Hard F:None/);
  });

  it('voice picker per personality renders with sensible defaults (WO-COACH-PERSONALITY-VOICE)', () => {
    setup();
    fireEvent.click(screen.getByTestId('personality-row'));
    // All 5 voice pickers present with default voice pre-selected.
    expect((screen.getByTestId('personality-voice-default')).value).toBe('ruth');
    expect((screen.getByTestId('personality-voice-soft')).value).toBe('joanna');
    expect((screen.getByTestId('personality-voice-edgy')).value).toBe('stephen');
    expect((screen.getByTestId('personality-voice-flirtatious')).value).toBe('ruth');
    expect((screen.getByTestId('personality-voice-drill-sergeant')).value).toBe('matthew');
  });

  it('voice override persists only when it differs from the per-personality default', async () => {
    const profile = buildUserProfile();
    await db.profiles.put(profile);
    const setProfile = vi.fn();
    render(<PersonalityPanel profile={profile} setProfile={setProfile} />);
    fireEvent.click(screen.getByTestId('personality-row'));
    // Override edgy to Ruth (default was Stephen).
    fireEvent.change(screen.getByTestId('personality-voice-edgy'), { target: { value: 'ruth' } });
    // Auto-save fires after the 250ms debounce.
    await waitFor(() => expect(setProfile).toHaveBeenCalled());
    // Persisted map contains ONLY the edgy override; defaults aren't
    // serialized so future default changes auto-apply.
    const stored = await db.profiles.get(profile.id);
    expect(stored?.preferences.coachPersonalityVoices).toEqual({ edgy: 'ruth' });
  });
});
