/**
 * Regression tests for the speakQueuedForced dead-code bug PLUS the
 * canned welcome-line shape on /coach/teach.
 *
 * Speech-chain regression context (build bb550b3+): production audit
 * showed only the first sentence reaching Polly because sentences 2+
 * were dispatched through `voiceService.speakQueuedForced`, which
 * gates on `WEB_SPEECH_FALLBACK_ENABLED = false` — i.e. silently
 * drops the call. The fix chains every sentence through `speakForced`
 * via `speechChainRef`. These tests lock that behavior by driving a
 * student message and asserting that every streamed sentence reaches
 * speakForced (none through speakQueuedForced).
 *
 * Welcome-line regression context (build 75791d7+): the kickoff used
 * to fire an LLM call to generate a greeting; now it speaks a canned
 * "Welcome to my classroom — what would you like to learn today?"
 * directly via Polly. The student speaks first; the LLM is only
 * invoked once they reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '../../test/utils';
import { CoachTeachPage } from './CoachTeachPage';
import { useAppStore } from '../../stores/appStore';
import { buildUserProfile } from '../../test/factories';
import { db } from '../../db/schema';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSpeakForced = vi.fn().mockResolvedValue(undefined);
const mockSpeakQueuedForced = vi.fn();
const mockStop = vi.fn();
const mockSpeak = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speakForced: (text: string) => mockSpeakForced(text),
    // CoachTeachPage's chain uses the Polly-only variant (no Web
    // Speech fallback). Both spies count as "Polly path" for the
    // regression assertion: every sentence reaches Polly, none
    // get dropped to the dead speakQueuedForced.
    speakForcedPollyOnly: (text: string) => mockSpeakForced(text),
    speakQueuedForced: (text: string) => mockSpeakQueuedForced(text),
    speak: (text: string) => mockSpeak(text),
    stop: () => mockStop(),
    warmup: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../coach/coachService', () => ({
  coachService: {
    ask: vi.fn(),
  },
}));

vi.mock('../../services/gameAnalysisService', () => ({
  analyzeRecentGames: vi.fn().mockResolvedValue(0),
  gameNeedsAnalysis: vi.fn().mockReturnValue(false),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

import { coachService } from '../../coach/coachService';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CoachTeachPage — Polly dispatch (regression for speakQueuedForced bug)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete();
    await db.open();
    useAppStore.getState().reset();
    useAppStore.getState().setActiveProfile(buildUserProfile({ name: 'Player' }));
    mockSpeakForced.mockResolvedValue(undefined);
  });

  /** Drive a student message through the chat input. Used by every
   *  test below to invoke the LLM — kickoff is now a canned greeting
   *  with no LLM call, so streaming has to be triggered by user input. */
  async function sendStudentMessage(text: string): Promise<void> {
    const input = await screen.findByTestId('chat-text-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest('form')!);
  }

  it('speaks the canned welcome line on mount via speakForced (no LLM call)', async () => {
    vi.mocked(coachService.ask).mockResolvedValue({ text: '', toolCallIds: [], provider: 'anthropic' });
    render(<CoachTeachPage />);

    await waitFor(() => {
      const spoken = mockSpeakForced.mock.calls.map((c) => c[0] as string);
      expect(spoken.some((s) => s.toLowerCase().includes('welcome to my classroom'))).toBe(true);
    }, { timeout: 4000 });

    // Student speaks first now — kickoff itself never invokes the brain.
    expect(coachService.ask).not.toHaveBeenCalled();
    expect(mockSpeakQueuedForced).not.toHaveBeenCalled();
  });

  it('speaks the [VOICE: ...] marker contents and nothing else', async () => {
    // Brain emits a VOICE summary up-front + long teaching text below.
    // Voice channel speaks the marker contents only — never the long
    // chat-only prose. This is the contract the user asked for: a
    // spoken summary covering positional info, structure, plans;
    // depth lives in the chat bubble.
    const voiceSummary = "e4 frees the bishop and queen. I'll mirror with e5 — symmetric center, both sides develop knights and castle short.";
    const longChat = "Vienna Game proper kicks in once white plays Nc3 — knight to c3 supports a future d4 push and eyes the d5/f5 squares. Black's main responses are Nf6 mirroring development or Nc6 with a more positional setup. Master games show ~55% white scoring at club level, dropping to balance at master strength.";
    const fullText = `[VOICE: ${voiceSummary}] ${longChat}`;

    vi.mocked(coachService.ask).mockImplementation(async (_input, options) => {
      options?.onChunk?.(fullText);
      return { text: fullText, toolCallIds: [], provider: 'anthropic' };
    });

    render(<CoachTeachPage />);
    // NB: ask phrased as a Q so the surface-level walkthrough router
    // (which intercepts "teach me / walk me through / show me [opening]")
    // doesn't bypass the brain — this test exercises the brain path.
    await sendStudentMessage('Why does white play 2.Nc3 in this line?');

    await waitFor(() => {
      const spoken = mockSpeakForced.mock.calls.map((c) => c[0] as string);
      // The VOICE summary reaches Polly.
      expect(spoken.some((s) => s.includes('symmetric center'))).toBe(true);
    }, { timeout: 4000 });

    // The long chat-only prose did NOT reach Polly. Match on a
    // distinctive phrase that only appears in the chat-side text.
    const allSpoken = mockSpeakForced.mock.calls.map((c) => c[0] as string).join(' || ');
    expect(allSpoken).not.toContain('Master games show');
    expect(allSpoken).not.toContain('club level');
    expect(mockSpeakQueuedForced).not.toHaveBeenCalled();
  });

  it('falls back to first sentence when the brain omits the [VOICE:] marker', async () => {
    // Defensive fallback: if the brain forgets to wrap its voice
    // summary, the surface speaks the first sentence so the student
    // isn't left in silence.
    const fullText = 'Pulling the Vienna explorer data right now. The position has 5 master-level games on this exact line.';

    vi.mocked(coachService.ask).mockImplementation(async (_input, options) => {
      options?.onChunk?.(fullText);
      return { text: fullText, toolCallIds: [], provider: 'anthropic' };
    });

    render(<CoachTeachPage />);
    // Non-routable ask (doesn't match the surface-level walkthrough
    // router) so this test exercises the brain path.
    await sendStudentMessage('What does Stockfish say about this position?');

    await waitFor(() => {
      const spoken = mockSpeakForced.mock.calls.map((c) => c[0] as string);
      expect(spoken.some((s) => s.includes('Pulling the Vienna explorer data'))).toBe(true);
    }, { timeout: 4000 });

    // The second sentence is NOT spoken under the fallback — only
    // the first sentence is the rescue. The brain is supposed to
    // emit [VOICE:] for the full summary.
    const allSpoken = mockSpeakForced.mock.calls.map((c) => c[0] as string).join(' || ');
    expect(allSpoken).not.toContain('5 master-level games');
    expect(mockSpeakQueuedForced).not.toHaveBeenCalled();
  });

  it('routes "Teach me the Vienna" to the in-place walkthrough WITHOUT calling the brain (build 2ab2726 audit fix)', async () => {
    // Brain audit (build 2ab2726) showed the LLM hallucinating that
    // it had called start_walkthrough_for_opening — its [VOICE:]
    // marker said "the walkthrough is queued but keeps hitting a
    // dead loop" — while actually chaining 3× set_board_position
    // calls. The walkthrough never fired. Fix: surface-level
    // pattern-match this kind of ask and call walkthrough.start()
    // directly, never invoking the brain.
    render(<CoachTeachPage />);
    await sendStudentMessage('Teach me the Vienna.');

    // The brain was NOT invoked at all — surface short-circuited.
    expect(coachService.ask).not.toHaveBeenCalled();
    // The user's ask AND the canned acknowledgement both rendered
    // in the transcript so the conversation is honest.
    await waitFor(() => {
      expect(screen.getByText("Teach me the Vienna.")).toBeInTheDocument();
      expect(screen.getByText(/let's walk through the Vienna Game/i)).toBeInTheDocument();
    });
  });

  it('does NOT set providerOverride at the surface (let the spine pick + fall back)', async () => {
    // Test history: this used to assert `providerOverride.name === 'anthropic'`
    // because Learn-with-Coach pinned Anthropic. CLAUDE.md 2026-05-14
    // changed the policy — Anthropic is the spine's default primary
    // and the coachApi layer auto-falls-back to DeepSeek on 401/429.
    // Surfaces must NOT pin either provider; pinning defeats the
    // auto-fallback. This test enforces the policy at the surface
    // contract level: regardless of which provider ends up serving the
    // call, /coach/teach should hand the spine a clean options bag
    // with no providerOverride.
    vi.mocked(coachService.ask).mockImplementation(async (_input, options) => {
      options?.onChunk?.('[VOICE: Pulling the position.] Detailed analysis follows.');
      return {
        text: '[VOICE: Pulling the position.] Detailed analysis follows.',
        toolCallIds: [],
        provider: 'anthropic',
      };
    });

    render(<CoachTeachPage />);
    await sendStudentMessage('Why is white better in this position?');

    await waitFor(() => {
      expect(coachService.ask).toHaveBeenCalled();
    }, { timeout: 4000 });

    for (const call of vi.mocked(coachService.ask).mock.calls) {
      const opts = call[1] as { providerOverride?: { name: string } } | undefined;
      expect(opts?.providerOverride).toBeUndefined();
    }
  });
});
