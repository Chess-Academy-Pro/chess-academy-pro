/**
 * audit-openings-narration.test.ts
 *
 * Regression gate for the openings narration audit. Runs the
 * `scripts/audit-openings-narration.mjs` auditor and fails the build
 * if any error class exceeds the baseline captured at the time of
 * the May-2026 cleanup pass.
 *
 * Baseline (set after Waves 2/3a/5/6):
 *   piece-on-square-mismatch  ≤ 1100  (1067 deferred to LLM run)
 *   san-mismatch              ≤ 80    (64 deferred to editorial)
 *   opening-id-pgn-drift      ≤ 5     (1 pro-* file handled by resolver)
 *   annotation-overflow       === 0
 *
 * Any class that drops to 0 below should stay at 0. If you legitimately
 * add new annotation data and one of the baselines needs to move, run
 * `node scripts/audit-openings-narration.mjs` locally and update the
 * thresholds below to the new max.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const REPO = join(__dirname, '..');
const SCRIPT = join(REPO, 'scripts/audit-openings-narration.mjs');

const BASELINE: Record<string, number> = {
  'piece-on-square-mismatch': 1100,
  'san-mismatch': 80,
  'opening-id-pgn-drift': 5,
  'annotation-overflow': 0,
  'unparseable': 0,
};

describe('openings narration audit', () => {
  it('reports stay at or below the May-2026 cleanup baseline', () => {
    // Run the auditor; --json keeps the report machine-readable.
    let stdout: string;
    try {
      stdout = execSync(`node ${SCRIPT} --json`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    } catch (err: unknown) {
      // The auditor exits 1 when errors are present; that's expected
      // here. We only care that it produced a parseable report.
      const e = err as { stdout?: string };
      stdout = e.stdout ?? '';
    }
    const report = JSON.parse(stdout);
    const counts: Record<string, number> = report.byClass ?? {};
    for (const [cls, limit] of Object.entries(BASELINE)) {
      const observed = counts[cls] ?? 0;
      expect(
        observed,
        `regression in audit error class "${cls}": baseline ${limit}, observed ${observed}. ` +
          `Run "node scripts/audit-openings-narration.mjs" locally to investigate.`,
      ).toBeLessThanOrEqual(limit);
    }
  }, /* timeout */ 120_000);
});
