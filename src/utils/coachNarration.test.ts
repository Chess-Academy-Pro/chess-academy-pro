import { describe, expect, it } from 'vitest';
import {
  resolveCoachNarration,
  coachNarrationToLength,
  resolvePhaseNarrationVerbosity,
} from './coachNarration';

describe('resolveCoachNarration', () => {
  it('returns full for undefined prefs', () => {
    expect(resolveCoachNarration(undefined)).toBe('full');
    expect(resolveCoachNarration(null)).toBe('full');
  });

  it('returns full when no setting and no legacy gating', () => {
    expect(resolveCoachNarration({})).toBe('full');
  });

  it('respects explicit coachNarration over legacy fields', () => {
    expect(
      resolveCoachNarration({
        coachNarration: 'silent',
        coachCommentaryVerbosity: 'every-move',
      }),
    ).toBe('silent');
    expect(
      resolveCoachNarration({
        coachNarration: 'brief',
        phaseNarrationVerbosity: 'full',
      }),
    ).toBe('brief');
    expect(
      resolveCoachNarration({
        coachNarration: 'full',
        coachVerbosity: 'none',
      }),
    ).toBe('full');
  });

  it('derives silent when any legacy field is at its silent value', () => {
    expect(
      resolveCoachNarration({ coachCommentaryVerbosity: 'off' }),
    ).toBe('silent');
    expect(
      resolveCoachNarration({ phaseNarrationVerbosity: 'off' }),
    ).toBe('silent');
    expect(resolveCoachNarration({ coachVerbosity: 'none' })).toBe('silent');
  });

  it('derives brief when any legacy field is at its brief-equivalent', () => {
    expect(
      resolveCoachNarration({ coachCommentaryVerbosity: 'key-moments' }),
    ).toBe('brief');
    expect(
      resolveCoachNarration({ phaseNarrationVerbosity: 'brief' }),
    ).toBe('brief');
    expect(resolveCoachNarration({ coachVerbosity: 'fast' })).toBe('brief');
  });

  it('biases toward quieter end when signals conflict', () => {
    // Silent wins over brief.
    expect(
      resolveCoachNarration({
        coachCommentaryVerbosity: 'off',
        phaseNarrationVerbosity: 'brief',
      }),
    ).toBe('silent');
    // Brief wins over full.
    expect(
      resolveCoachNarration({
        coachCommentaryVerbosity: 'every-move',
        phaseNarrationVerbosity: 'brief',
      }),
    ).toBe('brief');
  });

  it('returns full when only loud legacy values are present', () => {
    expect(
      resolveCoachNarration({
        coachCommentaryVerbosity: 'every-move',
        phaseNarrationVerbosity: 'full',
        coachVerbosity: 'unlimited',
      }),
    ).toBe('full');
  });
});

describe('coachNarrationToLength', () => {
  it('maps the unified setting to NarrationLength', () => {
    expect(coachNarrationToLength('silent')).toBe('silent');
    expect(coachNarrationToLength('brief')).toBe('short');
    expect(coachNarrationToLength('full')).toBe('full');
  });
});

describe('resolvePhaseNarrationVerbosity', () => {
  it('defaults to standard for empty/undefined prefs', () => {
    expect(resolvePhaseNarrationVerbosity(undefined)).toBe('standard');
    expect(resolvePhaseNarrationVerbosity(null)).toBe('standard');
    expect(resolvePhaseNarrationVerbosity({})).toBe('standard');
  });

  it('maps unified coachNarration to phase verbosity', () => {
    expect(resolvePhaseNarrationVerbosity({ coachNarration: 'silent' })).toBe('off');
    expect(resolvePhaseNarrationVerbosity({ coachNarration: 'brief' })).toBe('brief');
    expect(resolvePhaseNarrationVerbosity({ coachNarration: 'full' })).toBe('standard');
  });

  it('coachNarration wins over legacy phaseNarrationVerbosity', () => {
    expect(
      resolvePhaseNarrationVerbosity({
        coachNarration: 'silent',
        phaseNarrationVerbosity: 'full',
      }),
    ).toBe('off');
    expect(
      resolvePhaseNarrationVerbosity({
        coachNarration: 'brief',
        phaseNarrationVerbosity: 'full',
      }),
    ).toBe('brief');
  });

  it('falls back to legacy phaseNarrationVerbosity when unified unset', () => {
    expect(
      resolvePhaseNarrationVerbosity({ phaseNarrationVerbosity: 'off' }),
    ).toBe('off');
    expect(
      resolvePhaseNarrationVerbosity({ phaseNarrationVerbosity: 'brief' }),
    ).toBe('brief');
    expect(
      resolvePhaseNarrationVerbosity({ phaseNarrationVerbosity: 'full' }),
    ).toBe('full');
  });
});
