import { describe, it, expect } from 'vitest';
import { resolveVerbosity, shouldCallLlmForMove } from './coachCommentaryPolicy';
import { buildUserProfile } from '../test/factories';
import type { MoveClassification } from '../types';

describe('resolveVerbosity', () => {
  it('defaults to key-moments when the preference is unset', () => {
    const profile = buildUserProfile();
    delete profile.preferences.coachCommentaryVerbosity;
    expect(resolveVerbosity(profile)).toBe('key-moments');
  });

  it('defaults to key-moments when no profile is provided', () => {
    expect(resolveVerbosity(null)).toBe('key-moments');
    expect(resolveVerbosity(undefined)).toBe('key-moments');
  });

  it('honors an explicit preference', () => {
    const every = buildUserProfile();
    every.preferences.coachCommentaryVerbosity = 'every-move';
    expect(resolveVerbosity(every)).toBe('every-move');

    const off = buildUserProfile();
    off.preferences.coachCommentaryVerbosity = 'off';
    expect(resolveVerbosity(off)).toBe('off');
  });

  it('coachNarration overrides the legacy coachCommentaryVerbosity', () => {
    const silent = buildUserProfile();
    silent.preferences.coachNarration = 'silent';
    silent.preferences.coachCommentaryVerbosity = 'every-move';
    expect(resolveVerbosity(silent)).toBe('off');

    const brief = buildUserProfile();
    brief.preferences.coachNarration = 'brief';
    brief.preferences.coachCommentaryVerbosity = 'every-move';
    expect(resolveVerbosity(brief)).toBe('key-moments');

    const full = buildUserProfile();
    full.preferences.coachNarration = 'full';
    full.preferences.coachCommentaryVerbosity = 'off';
    expect(resolveVerbosity(full)).toBe('every-move');
  });
});

describe('shouldCallLlmForMove', () => {
  const everything: MoveClassification[] = [
    'brilliant',
    'great',
    'good',
    'book',
    'inaccuracy',
    'mistake',
    'blunder',
  ];

  it('off mode never calls the LLM', () => {
    for (const c of everything) {
      expect(shouldCallLlmForMove('off', c)).toBe(false);
    }
  });

  it('every-move mode always calls the LLM', () => {
    for (const c of everything) {
      expect(shouldCallLlmForMove('every-move', c)).toBe(true);
    }
  });

  it('key-moments mode fires only on blunder / mistake / brilliant / great', () => {
    expect(shouldCallLlmForMove('key-moments', 'blunder')).toBe(true);
    expect(shouldCallLlmForMove('key-moments', 'mistake')).toBe(true);
    expect(shouldCallLlmForMove('key-moments', 'brilliant')).toBe(true);
    expect(shouldCallLlmForMove('key-moments', 'great')).toBe(true);
  });

  it('key-moments mode skips routine classifications', () => {
    expect(shouldCallLlmForMove('key-moments', 'good')).toBe(false);
    expect(shouldCallLlmForMove('key-moments', 'book')).toBe(false);
    expect(shouldCallLlmForMove('key-moments', 'inaccuracy')).toBe(false);
  });
});
