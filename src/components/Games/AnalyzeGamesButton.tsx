/**
 * AnalyzeGamesButton — shared CTA that kicks off background Stockfish
 * analysis on the user's unanalyzed imported games.
 *
 * Sibling to `ImportGamesButton`: drops into every surface where the
 * user might want to (re-)analyze their games. The button:
 *   - shows a live count of unanalyzed games when idle ("Analyze 12 games")
 *   - reflects in-flight progress when a run is happening ("Analyzing 3/12…")
 *   - hides entirely when there's nothing to analyze AND the variant is
 *     `compact` (so headers don't show dead buttons). The `primary`
 *     variant always renders (with a disabled "All games analyzed"
 *     state) so empty-state CTAs stay structurally consistent with
 *     ImportGamesButton.
 *
 * Two visual variants mirror ImportGamesButton:
 *   - 'primary'   — full-width pill, loud. Used on empty states.
 *   - 'compact'   — small inline pill. Used on populated headers
 *                   (next to ImportGamesButton).
 *
 * The actual Stockfish work lives in `gameAnalysisService.runBackgroundAnalysis`
 * — fire-and-forget, owns the worker pool, reports progress into the
 * global Zustand store (`appStore.backgroundAnalysisRunning` +
 * `backgroundAnalysisProgress`). A persistent top-of-app banner
 * surfaces the run across every tab so navigation doesn't kill it.
 */
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { db } from '../../db/schema';
import { gameNeedsAnalysis, runBackgroundAnalysis } from '../../services/gameAnalysisService';
import { useAppStore } from '../../stores/appStore';
import { logAppAudit } from '../../services/appAuditor';

interface AnalyzeGamesButtonProps {
  variant?: 'primary' | 'compact';
  className?: string;
  /** Optional override label suffix. The button always prepends the
   *  appropriate verb/count (e.g. "Analyze 12 games"); the label
   *  param is for callers that want a custom action verb. */
  label?: string;
  /** Which surface initiated the click. Threaded into the audit-log
   *  trail so the audit-stream can tell "user tapped analyze from
   *  the Review list" vs "from the Weakness Overview" vs "from
   *  Settings." */
  source?: string;
}

export function AnalyzeGamesButton({
  variant = 'compact',
  className = '',
  label,
  source,
}: AnalyzeGamesButtonProps): JSX.Element | null {
  const bgRunning = useAppStore((s) => s.backgroundAnalysisRunning);
  const bgProgress = useAppStore((s) => s.backgroundAnalysisProgress);
  const [unanalyzedCount, setUnanalyzedCount] = useState<number | null>(null);

  // Refresh the unanalyzed count on mount + whenever a background
  // run finishes (so the button can drop to "All games analyzed"
  // without a manual refresh). Cheap — single Dexie scan, runs in
  // milliseconds.
  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const games = await db.games.toArray();
        if (cancelled) return;
        const needing = games.filter((g) => !g.isMasterGame && gameNeedsAnalysis(g)).length;
        setUnanalyzedCount(needing);
      } catch {
        if (!cancelled) setUnanalyzedCount(0);
      }
    }
    void refresh();
    return () => { cancelled = true; };
  }, [bgRunning]);

  const handleClick = (): void => {
    if (bgRunning) return;
    void logAppAudit({
      kind: 'weakness-report-analyze-kickoff',
      category: 'subsystem',
      source: source ? `AnalyzeGamesButton.${source}` : 'AnalyzeGamesButton',
      summary: `analyze kickoff from ${source ?? 'unknown'} — ${unanalyzedCount ?? '?'} unanalyzed`,
    });
    runBackgroundAnalysis();
  };

  const isAnalyzing = bgRunning;
  const hasWork = (unanalyzedCount ?? 0) > 0;

  // Compact variant + no work to do → render nothing. Empty headers
  // shouldn't carry buttons that don't do anything.
  if (variant === 'compact' && !hasWork && !isAnalyzing) {
    return null;
  }

  const buttonText = isAnalyzing
    ? bgProgress
      ? `Analyzing ${bgProgress}`
      : 'Analyzing…'
    : hasWork
      ? `${label ?? 'Analyze'} ${unanalyzedCount ?? ''} game${unanalyzedCount === 1 ? '' : 's'}`.trim()
      : 'All games analyzed';

  const disabled = isAnalyzing || (!hasWork && variant === 'primary');

  if (variant === 'primary') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-500/15 border-2 border-violet-500/40 text-violet-300 text-sm font-semibold hover:bg-violet-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        data-testid="analyze-games-cta"
      >
        <Sparkles size={16} className={isAnalyzing ? 'animate-pulse' : ''} />
        {buttonText}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/40 text-violet-300 text-xs font-medium hover:bg-violet-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      data-testid="analyze-games-cta"
    >
      <Sparkles size={12} className={isAnalyzing ? 'animate-pulse' : ''} />
      {buttonText}
    </button>
  );
}
