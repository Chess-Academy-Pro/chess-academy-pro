/**
 * Tests for withTimeout. WO-COACH-RESILIENCE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from '../withTimeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with { ok: true, value } when the promise wins', async () => {
    const promise = Promise.resolve(42);
    const result = await withTimeout(promise, 1000, 'test-label');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('resolves with { ok: false, reason: "timeout", label } when the timer wins', async () => {
    const promise = new Promise<string>(() => { /* never resolve */ });
    const resultPromise = withTimeout(promise, 500, 'never-wins');
    vi.advanceTimersByTime(500);
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: 'timeout', label: 'never-wins' });
  });

  it('clears the timer when the promise resolves first (no leak)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const promise = Promise.resolve('done');
    const result = await withTimeout(promise, 5000, 'fast-promise');
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the timer when the promise rejects first', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const promise = Promise.reject(new Error('boom'));
    await expect(withTimeout(promise, 5000, 'fast-reject')).rejects.toThrow('boom');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('propagates rejections — does not swallow them as timeout', async () => {
    const promise = Promise.reject(new Error('upstream failure'));
    await expect(withTimeout(promise, 1000, 'will-reject')).rejects.toThrow('upstream failure');
  });

  it('wraps non-Error throws into Error before propagating', async () => {
    // Deliberate non-Error reject value — verifies the wrap-into-Error
    // behavior described in the test name.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const promise = Promise.reject('a string error');
    await expect(withTimeout(promise, 1000, 'string-reject')).rejects.toThrow('a string error');
  });

  it('the timeout label travels with the result for audit logging', async () => {
    const promise = new Promise<string>(() => { /* never */ });
    const resultPromise = withTimeout(promise, 100, 'specific-call-site-label');
    vi.advanceTimersByTime(100);
    const result = await resultPromise;
    if (result.ok) throw new Error('expected timeout');
    expect(result.label).toBe('specific-call-site-label');
  });
});
