import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/schema';
import {
  logAppAudit,
  getAppAuditLog,
  clearAppAuditLog,
  installGlobalErrorHooks,
  installConsoleBackdoor,
} from './appAuditor';

describe('appAuditor', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('starts with an empty log', async () => {
    expect(await getAppAuditLog()).toEqual([]);
  });

  it('persists a single entry with timestamp + route auto-filled', async () => {
    await logAppAudit({
      kind: 'bad-fen',
      category: 'subsystem',
      source: 'test',
      summary: 'Invalid FEN',
      fen: 'garbage',
    });
    const log = await getAppAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: 'bad-fen',
      category: 'subsystem',
      source: 'test',
      summary: 'Invalid FEN',
      fen: 'garbage',
    });
    expect(typeof log[0].timestamp).toBe('number');
  });

  it('appends multiple entries preserving insertion order', async () => {
    await logAppAudit({ kind: 'bad-fen', category: 'subsystem', source: 'a', summary: 'one' });
    await logAppAudit({ kind: 'polly-fallback', category: 'subsystem', source: 'b', summary: 'two' });
    await logAppAudit({ kind: 'uncaught-error', category: 'runtime', source: 'c', summary: 'three' });
    const log = await getAppAuditLog();
    expect(log.map((e) => e.summary)).toEqual(['one', 'two', 'three']);
  });

  it('clearAppAuditLog resets the log to empty', async () => {
    await logAppAudit({ kind: 'bad-fen', category: 'subsystem', source: 's', summary: 'x' });
    await clearAppAuditLog();
    expect(await getAppAuditLog()).toEqual([]);
  });

  it('caps at 300 entries (rolling window)', async () => {
    for (let i = 0; i < 310; i++) {
      await logAppAudit({
        kind: 'bad-fen',
        category: 'subsystem',
        source: 'bulk',
        summary: `entry ${i}`,
      });
    }
    const log = await getAppAuditLog();
    expect(log.length).toBe(300);
    // Oldest 10 should have been evicted
    expect(log[0].summary).toBe('entry 10');
    expect(log[log.length - 1].summary).toBe('entry 309');
  });

  it('survives JSON parse failures by returning an empty log', async () => {
    // Directly corrupt the stored value to simulate schema drift
    await db.meta.put({ key: 'app-audit-log.v1', value: 'not valid json' });
    expect(await getAppAuditLog()).toEqual([]);
  });

  it('persists all entries when many logAppAudit calls fire concurrently (no read-modify-write race)', async () => {
    // Regression: production audit logs were missing the audits that
    // fire alongside `voiceService.speak()` (e.g. `coach-move-narration-fired`
    // beside `voice-speak-invoked`). Each `logAppAudit` call did
    // `await readLog(); push; await db.meta.put(...)`. When multiple
    // calls fire `void`-style without awaiting, they all read the same
    // pre-write log and each one's put overwrites the others —
    // last-writer-wins. Only one entry survives per concurrent batch.
    // This test fires 20 concurrent calls and asserts all 20 survive.
    const concurrent = Array.from({ length: 20 }, (_, i) =>
      logAppAudit({
        kind: 'bad-fen',
        category: 'subsystem',
        source: 'concurrent',
        summary: `entry ${i}`,
      }),
    );
    await Promise.all(concurrent);
    const log = await getAppAuditLog();
    expect(log.length).toBe(20);
    // Every entry should be present (order is insertion order modulo
    // serialization choice, but the SET must be complete).
    const summaries = new Set(log.map((e) => e.summary));
    for (let i = 0; i < 20; i++) {
      expect(summaries.has(`entry ${i}`)).toBe(true);
    }
  });

  describe('installGlobalErrorHooks', () => {
    // The hooks attach directly to `window.addEventListener('error', ...)`
    // — which fires even when dispatchEvent synthesises an error. We
    // install an intercepting handler ABOVE the hook that calls
    // `preventDefault()` so the simulated event doesn't bubble out to
    // vitest's own unhandled-error sink and fail the run.
    let swallow: (e: Event) => void;
    beforeEach(() => {
      swallow = (e: Event): void => {
        e.preventDefault();
      };
      window.addEventListener('error', swallow, true);
      window.addEventListener('unhandledrejection', swallow, true);
    });
    afterEach(() => {
      window.removeEventListener('error', swallow, true);
      window.removeEventListener('unhandledrejection', swallow, true);
    });

    it('captures uncaught window errors', async () => {
      const uninstall = installGlobalErrorHooks();
      try {
        const event = new ErrorEvent('error', {
          message: 'simulated failure',
          filename: 'foo.tsx',
          lineno: 42,
          colno: 7,
          error: new Error('simulated failure'),
        });
        window.dispatchEvent(event);
        await new Promise((r) => setTimeout(r, 10));
        const log = await getAppAuditLog();
        expect(log.some((e) => e.kind === 'uncaught-error' && e.summary === 'simulated failure')).toBe(true);
      } finally {
        uninstall();
      }
    });

    it('captures unhandled promise rejections', async () => {
      const uninstall = installGlobalErrorHooks();
      try {
        const event = new Event('unhandledrejection') as PromiseRejectionEvent;
        Object.defineProperty(event, 'reason', { value: new Error('rejected') });
        window.dispatchEvent(event);
        await new Promise((r) => setTimeout(r, 10));
        const log = await getAppAuditLog();
        expect(log.some((e) => e.kind === 'unhandled-rejection' && e.summary === 'rejected')).toBe(true);
      } finally {
        uninstall();
      }
    });

    it('cleanup detaches listeners', async () => {
      const uninstall = installGlobalErrorHooks();
      uninstall();
      const event = new ErrorEvent('error', {
        message: 'after uninstall',
        error: new Error('after uninstall'),
      });
      window.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 10));
      const log = await getAppAuditLog();
      expect(log.some((e) => e.summary === 'after uninstall')).toBe(false);
    });

    it('rate-limits a burst of identical errors so 100k events do not write 100k rows', async () => {
      // Regression guard for the audit-found Stockfish-wasm OOM
      // error-loop (2026-05-14 AUDIT_HANDOFF.md): when a runaway loop
      // fires the same error 100k+ times in seconds, the global hook
      // used to write a row per event. After fix: first
      // MAX_EVENTS_PER_BURST (5) are logged verbatim, the rest are
      // suppressed for the burst window, and a single coalesced
      // "×N burst-coalesced" summary lands when the window closes.
      const uninstall = installGlobalErrorHooks();
      try {
        const BURST = 50;
        for (let i = 0; i < BURST; i++) {
          window.dispatchEvent(new ErrorEvent('error', {
            message: 'burst-loop',
            error: new Error('burst-loop'),
          }));
        }
        await new Promise((r) => setTimeout(r, 50));
        const log = await getAppAuditLog();
        const matches = log.filter((e) => e.summary === 'burst-loop');
        // Pre-fix: 50 rows (1-to-1). Post-fix: capped at 5 verbatim.
        expect(matches.length).toBeLessThanOrEqual(5);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      } finally {
        uninstall();
      }
    });
  });

  describe('installConsoleBackdoor', () => {
    interface AuditApi {
      dump: () => Promise<unknown[]>;
      copy: () => Promise<void>;
      clear: () => Promise<void>;
      count: () => number;
    }
    const getBackdoor = (): AuditApi =>
      (window as unknown as { __AUDIT__: AuditApi }).__AUDIT__;

    it('exposes __AUDIT__ on window', () => {
      installConsoleBackdoor();
      expect(typeof getBackdoor().dump).toBe('function');
      expect(typeof getBackdoor().copy).toBe('function');
      expect(typeof getBackdoor().clear).toBe('function');
      expect(typeof getBackdoor().count).toBe('function');
    });

    it('dump() returns the full log', async () => {
      await logAppAudit({ kind: 'bad-fen', category: 'subsystem', source: 't', summary: 'x' });
      installConsoleBackdoor();
      const log = await getBackdoor().dump();
      expect(Array.isArray(log)).toBe(true);
      expect(log).toHaveLength(1);
    });

    it('clear() empties the log', async () => {
      await logAppAudit({ kind: 'bad-fen', category: 'subsystem', source: 't', summary: 'x' });
      installConsoleBackdoor();
      await getBackdoor().clear();
      const after = await getAppAuditLog();
      expect(after).toEqual([]);
    });

    it('copy() writes markdown to the clipboard', async () => {
      await logAppAudit({
        kind: 'bad-fen',
        category: 'subsystem',
        source: 't',
        summary: 'Invalid FEN',
      });
      installConsoleBackdoor();
      let captured = '';
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (s: string) => { captured = s; } },
        configurable: true,
      });
      try {
        await getBackdoor().copy();
        expect(captured).toContain('# App audit log');
        expect(captured).toContain('Invalid FEN');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
      }
    });
  });
});
