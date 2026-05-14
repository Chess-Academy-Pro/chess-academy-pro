/**
 * Envelope assembly + formatter tests (WO-BRAIN-01).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/appAuditor', () => ({
  logAppAudit: vi.fn(() => Promise.resolve()),
}));

import {
  assembleEnvelope,
  formatEnvelopeAsSystemPrompt,
  formatEnvelopeAsUserMessage,
} from '../envelope';
import { __resetCoachMemoryStoreForTests, useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { getToolDefinitions } from '../tools/registry';

beforeEach(() => {
  __resetCoachMemoryStoreForTests();
});

describe('assembleEnvelope', () => {
  it('produces all six parts with non-empty values', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: {
        surface: 'ping',
        ask: 'hello',
        liveState: { surface: 'ping' },
      },
    });
    expect(env.identity).toBeTruthy();
    expect(env.memory).toBeTruthy();
    expect(env.appMap.length).toBeGreaterThan(5);
    expect(env.liveState.surface).toBe('ping');
    expect(env.toolbelt.length).toBe(22);
    expect(env.ask).toBe('hello');
  });

  it('throws when ask is empty', () => {
    expect(() =>
      assembleEnvelope({
        toolbelt: getToolDefinitions(),
        input: { surface: 'ping', ask: '   ', liveState: { surface: 'ping' } },
      }),
    ).toThrow(/ask missing/);
  });

  it('throws when toolbelt is empty', () => {
    expect(() =>
      assembleEnvelope({
        toolbelt: [],
        input: { surface: 'ping', ask: 'hello', liveState: { surface: 'ping' } },
      }),
    ).toThrow(/toolbelt missing/);
  });

  it('reads intendedOpening from the live store', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
    });
    expect(env.memory.intendedOpening?.name).toBe('Caro-Kann Defense');
  });

  it('appends REVIEW_MODE_ADDITION on surface=review by default', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: { surface: 'review', ask: 'q', liveState: { surface: 'review' } },
    });
    expect(env.identity).toMatch(/REVIEW MODE/);
    expect(env.identity).toMatch(/\[VOICE: \.\.\.\]/);
  });

  it('skips REVIEW_MODE_ADDITION when suppressSurfaceMode=true so JSON-only prep calls don\'t fight the marker mandate', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      suppressSurfaceMode: true,
      input: { surface: 'review', ask: 'q', liveState: { surface: 'review' } },
    });
    expect(env.identity).not.toMatch(/REVIEW MODE/);
    // Memory + live-state still load.
    expect(env.liveState.surface).toBe('review');
    expect(env.memory).toBeTruthy();
  });

  it('skips TEACH_MODE_ADDITION when suppressSurfaceMode=true on surface=teach', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      suppressSurfaceMode: true,
      input: { surface: 'teach', ask: 'q', liveState: { surface: 'teach' } },
    });
    expect(env.identity).not.toMatch(/TEACH MODE/);
  });

  it('skips PHASE_NARRATION_ADDITION when suppressSurfaceMode=true on surface=phase-narration', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      suppressSurfaceMode: true,
      input: {
        surface: 'phase-narration',
        ask: 'q',
        liveState: { surface: 'phase-narration' },
      },
    });
    // PHASE_NARRATION_ADDITION's distinctive header.
    expect(env.identity).not.toMatch(/ACTION-FIRST RULE/);
  });

  it('suppressToolbelt=true assembles an envelope with an empty toolbelt', () => {
    // Root-cause fix for chesscom-971406909: the Review summary card
    // leaked `[[ACTION:record_blunder ...]]` because the toolbelt
    // preamble told the brain to emit tool tags. Prose-only callers
    // can now opt out of the toolbelt entirely.
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      suppressToolbelt: true,
      input: { surface: 'review', ask: 'q', liveState: { surface: 'review' } },
    });
    expect(env.toolbelt).toHaveLength(0);
  });

  it('suppressToolbelt=true relaxes the empty-toolbelt constitution check', () => {
    // The constitution normally throws on an empty toolbelt; with
    // suppressToolbelt the caller is explicitly opting out, so the
    // assembly succeeds with no tools.
    expect(() =>
      assembleEnvelope({
        toolbelt: [],
        suppressToolbelt: true,
        input: { surface: 'review', ask: 'q', liveState: { surface: 'review' } },
      }),
    ).not.toThrow();
  });
});

describe('formatEnvelopeAsSystemPrompt', () => {
  it('includes identity, app map, and toolbelt sections', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
    });
    const prompt = formatEnvelopeAsSystemPrompt(env);
    // WO-COACH-OPERATOR-FOUNDATION-01: identity rewritten to
    // operator-mode body; no longer "Danya"-prefixed.
    expect(prompt).toMatch(/OPERATOR MODE/);
    expect(prompt).toMatch(/\[App map\]/);
    expect(prompt).toMatch(/\[Toolbelt\]/);
    expect(prompt).toMatch(/stockfish_eval/);
    expect(prompt).toMatch(/set_intended_opening/);
  });

  it('threads personality + dial settings into the assembled identity (WO-COACH-PERSONALITIES PR B)', () => {
    const env = assembleEnvelope({
      personality: 'drill-sergeant',
      profanity: 'hard',
      mockery: 'hard',
      flirt: 'none',
      toolbelt: getToolDefinitions(),
      input: { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
    });
    const prompt = formatEnvelopeAsSystemPrompt(env);
    // OPERATOR contract still present.
    expect(prompt).toMatch(/OPERATOR MODE/);
    // Personality body landed.
    expect(prompt).toMatch(/Drill Sergeant/);
    expect(prompt).toMatch(/Full Metal Jacket/);
    // Dial clauses match the requested levels.
    expect(prompt).toMatch(/PROFANITY DIAL: HARD/);
    expect(prompt).toMatch(/MOCKERY DIAL: HARD/);
    expect(prompt).toMatch(/FLIRT DIAL: NONE/);
  });

  it('suppressToolbelt=true drops the [Toolbelt] block from the system prompt', () => {
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      suppressToolbelt: true,
      input: { surface: 'review', ask: 'q', liveState: { surface: 'review' } },
    });
    const prompt = formatEnvelopeAsSystemPrompt(env);
    // The Toolbelt heading, its preamble, and the descriptive tool
    // listings should all be gone. (The OPERATOR_CLOSING identity
    // block still mentions the `[[ACTION:...]]` syntax for legacy
    // operator-mode surfaces — that's independent of the toolbelt
    // block and outside this fix's scope.)
    expect(prompt).not.toMatch(/\[Toolbelt\]/);
    expect(prompt).not.toMatch(/You can call tools by emitting a tag/);
    expect(prompt).not.toMatch(/Log a blunder pattern/);
    // Identity and app map still ship.
    expect(prompt).toMatch(/OPERATOR MODE/);
    expect(prompt).toMatch(/\[App map\]/);
  });

  it('omitted personality settings produce the same prompt as the legacy default path', () => {
    const legacy = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
    });
    const explicit = assembleEnvelope({
      personality: 'default',
      profanity: 'none',
      mockery: 'none',
      flirt: 'none',
      toolbelt: getToolDefinitions(),
      input: { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
    });
    expect(formatEnvelopeAsSystemPrompt(legacy)).toBe(
      formatEnvelopeAsSystemPrompt(explicit),
    );
  });
});

describe('formatEnvelopeAsUserMessage', () => {
  it('includes memory, live state, and ask sections', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Sicilian Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: {
        surface: 'ping',
        ask: 'What opening do I have set?',
        liveState: { surface: 'ping', currentRoute: '/coach/play' },
      },
    });
    const msg = formatEnvelopeAsUserMessage(env);
    expect(msg).toMatch(/\[Coach memory\]/);
    expect(msg).toMatch(/Sicilian Defense/);
    expect(msg).toMatch(/\[Live state\]/);
    expect(msg).toMatch(/Surface: ping/);
    expect(msg).toMatch(/Current route: \/coach\/play/);
    expect(msg).toMatch(/\[Ask\]/);
    expect(msg).toMatch(/What opening do I have set\?/);
  });

  it('includes recent conversation history when present (BRAIN-04 punt #3)', () => {
    // Append a back-and-forth from a chat surface — both user and
    // coach roles should land in the envelope's memory block.
    const store = useCoachMemoryStore.getState();
    store.appendConversationMessage({
      surface: 'chat-in-game',
      role: 'user',
      text: "Why did you play Bxh6?",
      trigger: null,
    });
    store.appendConversationMessage({
      surface: 'chat-in-game',
      role: 'coach',
      text: "It opens the king position and trades a bishop for the defender.",
      trigger: null,
    });
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: {
        surface: 'game-chat',
        ask: 'What was the followup plan?',
        liveState: { surface: 'game-chat' },
      },
    });
    const msg = formatEnvelopeAsUserMessage(env);
    expect(msg).toMatch(/Recent conversation/);
    expect(msg).toMatch(/chat-in-game\/user/);
    expect(msg).toMatch(/Why did you play Bxh6\?/);
    expect(msg).toMatch(/chat-in-game\/coach/);
    expect(msg).toMatch(/opens the king position/);
  });

  it('renders recent hint requests as a compact summary (BRAIN-05b)', () => {
    // Three hint events at plies 12, 14, 16 with tiers 1 / 2 / 3.
    // Envelope should render: "Recent hint requests: 3 in the last
    // 10 plies (T1, T1→T2, T1→T2→T3)" — the per-record verbose
    // format from BRAIN-01..04 is replaced by this single summary
    // line so the envelope stays compact even when the user taps a
    // lot of hints.
    const store = useCoachMemoryStore.getState();
    store.recordHintRequest({
      gameId: 'g1', moveNumber: 6, ply: 12,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      bestMoveUci: 'e2e4', bestMoveSan: 'e4', tier: 1,
    });
    store.recordHintRequest({
      gameId: 'g1', moveNumber: 7, ply: 14,
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      bestMoveUci: 'e7e5', bestMoveSan: 'e5', tier: 2,
    });
    store.recordHintRequest({
      gameId: 'g1', moveNumber: 8, ply: 16,
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      bestMoveUci: 'g1f3', bestMoveSan: 'Nf3', tier: 3,
    });
    const env = assembleEnvelope({
      toolbelt: getToolDefinitions(),
      input: { surface: 'hint', ask: 'tier 1 hint please', liveState: { surface: 'hint' } },
    });
    const msg = formatEnvelopeAsUserMessage(env);
    expect(msg).toMatch(
      /Recent hint requests: 3 in the last 10 plies \(T1, T1→T2, T1→T2→T3\)/,
    );
    // Per-record verbose format from BRAIN-01..04 is gone — should
    // not see "ply 12 tier=1" anywhere in the envelope.
    expect(msg).not.toMatch(/ply 12 tier=/);
  });
});
