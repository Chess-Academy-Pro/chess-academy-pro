/**
 * coachService tests (WO-BRAIN-01).
 *
 * The provider is mocked; these tests verify:
 *   - the spine assembles a six-part envelope
 *   - it dispatches tool calls the provider returned
 *   - it audit-logs the lifecycle (5 expected entries)
 *   - it short-circuits unknown tool names cleanly
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auditCalls: { kind: string; summary: string }[] = [];
vi.mock('../../services/appAuditor', () => ({
  logAppAudit: vi.fn((entry: { kind: string; summary: string }) => {
    auditCalls.push({ kind: entry.kind, summary: entry.summary });
    return Promise.resolve();
  }),
}));

import { coachService } from '../coachService';
import {
  __resetCoachMemoryStoreForTests,
  useCoachMemoryStore,
} from '../../stores/coachMemoryStore';
import type { Provider, ProviderResponse } from '../types';

beforeEach(() => {
  auditCalls.length = 0;
  __resetCoachMemoryStoreForTests();
});

function mockProvider(response: ProviderResponse): Provider {
  return {
    name: 'deepseek',
    call: vi.fn(() => Promise.resolve(response)),
  };
}

describe('coachService.ask', () => {
  it('returns text + provider when no tool calls fired', async () => {
    const answer = await coachService.ask(
      { surface: 'ping', ask: 'say hello', liveState: { surface: 'ping' } },
      {
        providerOverride: mockProvider({
          text: 'Hello.',
          toolCalls: [],
        }),
      },
    );
    expect(answer.text).toBe('Hello.');
    expect(answer.provider).toBe('deepseek');
    expect(answer.toolCallIds).toHaveLength(0);
  });

  it('emits the five-stage audit lifecycle', async () => {
    await coachService.ask(
      { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
      { providerOverride: mockProvider({ text: 'A.', toolCalls: [] }) },
    );
    // WO-FOUNDATION-02 trace harness mixes trace-* audits between the
    // five lifecycle stages. Filter to coach-brain-* only so the
    // lifecycle assertion stays focused on canonical pipeline stages.
    const kinds = auditCalls
      .map((c) => c.kind)
      .filter((k) => k.startsWith('coach-brain-'));
    expect(kinds).toEqual([
      'coach-brain-ask-received',
      'coach-brain-envelope-assembled',
      'coach-brain-tool-parse-result',
      'coach-brain-provider-called',
      'coach-brain-answer-returned',
    ]);
  });

  it('dispatches set_intended_opening when the provider returns the tool call', async () => {
    const provider = mockProvider({
      text: 'Sure, locking in the Caro-Kann.',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'set_intended_opening',
          args: { name: 'Caro-Kann Defense', color: 'black' },
        },
      ],
    });
    const answer = await coachService.ask(
      { surface: 'ping', ask: 'play caro-kann', liveState: { surface: 'ping' } },
      { providerOverride: provider },
    );
    expect(answer.toolCallIds).toContain('tc-1');
    const stored = useCoachMemoryStore.getState().intendedOpening;
    expect(stored?.name).toBe('Caro-Kann Defense');
    expect(stored?.color).toBe('black');
    const toolAudits = auditCalls.filter((c) => c.kind === 'coach-brain-tool-called');
    expect(toolAudits.length).toBeGreaterThan(0);
    // Audit-driven (#20, #21): coach-brain-tool-called audit should
    // include a result preview so paste-back logs surface what the
    // tool actually did. set_intended_opening's preview is `<color>
    // <name>` on success.
    const setOpeningAudit = toolAudits.find((c) => c.summary.startsWith('set_intended_opening'));
    expect(setOpeningAudit?.summary).toContain('black Caro-Kann Defense');
  });

  it('logs but does not throw on unknown tool names', async () => {
    const provider = mockProvider({
      text: 'mystery',
      toolCalls: [{ id: 'tc-1', name: 'not_a_real_tool', args: {} }],
    });
    const answer = await coachService.ask(
      { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
      { providerOverride: provider },
    );
    expect(answer.toolCallIds).toHaveLength(0);
    expect(
      auditCalls.some(
        (c) => c.kind === 'coach-brain-tool-skipped' && /unknown/i.test(c.summary),
      ),
    ).toBe(true);
  });

  it('throws if surface is missing on liveState (envelope guard)', async () => {
    const provider = mockProvider({ text: 'x', toolCalls: [] });
    await expect(
      coachService.ask(
        { surface: 'ping', ask: 'q', liveState: { surface: '' as unknown as 'ping' } },
        { providerOverride: provider },
      ),
    ).rejects.toThrow(/surface is required/);
  });

  // WO-COACH-GROUNDING (PR #338 part C): the spine default stays at 1 so
  // narrative-only callers (e.g. ping, short hint asks) keep their existing
  // single-trip behavior. Chat surfaces opt in to 3 explicitly via the
  // CoachServiceOptions.maxToolRoundTrips field.
  it('default round-trip budget is 1 — provider is called once when no tools fire', async () => {
    const call = vi.fn(() => Promise.resolve({ text: 'A.', toolCalls: [] }));
    const provider: Provider = { name: 'deepseek', call };
    await coachService.ask(
      { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
      { providerOverride: provider },
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('default round-trip budget caps at 1 even when the first turn emits a tool call', async () => {
    // First (and only) turn emits a tool. With budget=1, the spine
    // dispatches the tool but does not loop back for a synthesis turn,
    // so the provider is only called once.
    const responses: ProviderResponse[] = [
      {
        text: 'looking up',
        toolCalls: [
          { id: 'tc-1', name: 'set_intended_opening', args: { name: 'Caro-Kann Defense', color: 'black' } },
        ],
      },
      // Sentinel — should never be reached at budget=1.
      { text: 'should not reach', toolCalls: [] },
    ];
    const call = vi.fn(() => Promise.resolve(responses.shift() ?? { text: '', toolCalls: [] }));
    const provider: Provider = { name: 'deepseek', call };
    await coachService.ask(
      { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
      { providerOverride: provider },
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('honors maxToolRoundTrips=3 — loops back through the provider after tools resolve', async () => {
    const responses: ProviderResponse[] = [
      {
        text: 'turn 1: calling tool',
        toolCalls: [
          { id: 'tc-1', name: 'set_intended_opening', args: { name: 'Caro-Kann Defense', color: 'black' } },
        ],
      },
      {
        text: 'turn 2: calling another tool',
        toolCalls: [
          { id: 'tc-2', name: 'set_intended_opening', args: { name: 'Sicilian Defense', color: 'black' } },
        ],
      },
      // Final turn — no tools, just a narrative answer.
      { text: 'turn 3: final', toolCalls: [] },
    ];
    const call = vi.fn(() => Promise.resolve(responses.shift() ?? { text: '', toolCalls: [] }));
    const provider: Provider = { name: 'deepseek', call };
    const answer = await coachService.ask(
      { surface: 'ping', ask: 'q', liveState: { surface: 'ping' } },
      { providerOverride: provider, maxToolRoundTrips: 3 },
    );
    expect(call).toHaveBeenCalledTimes(3);
    expect(answer.text).toContain('turn 3');
  });
});
