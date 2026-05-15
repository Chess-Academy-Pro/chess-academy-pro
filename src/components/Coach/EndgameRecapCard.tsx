/**
 * EndgameRecapCard — Stockfish-driven post-playout accuracy recap.
 *
 * David's audit cycle (ccd0057): the auto-run recap was firing 10
 * Stockfish evals on every playout completion, taking ~60 s on
 * degraded single-thread Stockfish to render the breakdown. That's
 * unacceptable UX for what is curiosity-grade detail.
 *
 * Reworked: don't auto-run. Show a "Show accuracy breakdown" button.
 * Only kick off the analysis when the user explicitly opts in.
 * The "Played perfectly / Line played out" signal that's already on
 * the parent PlayoutStatus is the meaningful feedback most users
 * need; the per-move breakdown is opt-in.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, BarChart3 } from 'lucide-react';
import type { StudentMoveRecord } from '../../hooks/useEndgamePlayout';
import {
  buildEndgameRecap,
  type EndgameRecap,
  type RecapClassification,
} from '../../services/endgameRecapService';
import { voiceService } from '../../services/voiceService';

interface EndgameRecapCardProps {
  studentMoves: StudentMoveRecord[];
  studentSide: 'white' | 'black';
}

const CLASSIFICATION_COLOR: Record<RecapClassification, string> = {
  best: 'text-green-400',
  inaccuracy: 'text-amber-400',
  mistake: 'text-orange-400',
  blunder: 'text-red-400',
};

const CLASSIFICATION_LABEL: Record<RecapClassification, string> = {
  best: 'Best',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

type RecapPhase =
  | { kind: 'idle' }      // initial — show the opt-in button
  | { kind: 'loading' }   // user tapped, evals in flight
  | { kind: 'ready'; recap: EndgameRecap }
  | { kind: 'error'; message: string };

export function EndgameRecapCard({
  studentMoves,
  studentSide,
}: EndgameRecapCardProps): JSX.Element | null {
  const [phase, setPhase] = useState<RecapPhase>({ kind: 'idle' });
  // De-dupe the spoken narration so React StrictMode's double-effect
  // and ordinary re-renders don't trigger a second speak() — each
  // fresh recap build (different narration text) speaks once.
  const lastSpokenRef = useRef<string | null>(null);

  // Reset to idle when the student-move log changes (new playout /
  // reset / different position).
  useEffect(() => {
    setPhase({ kind: 'idle' });
    lastSpokenRef.current = null;
  }, [studentMoves]);

  const runRecap = (): void => {
    if (studentMoves.length === 0) return;
    setPhase({ kind: 'loading' });
    const cancelled = false;
    buildEndgameRecap(studentMoves, studentSide)
      .then((r) => {
        if (cancelled) return;
        if (!r) {
          setPhase({ kind: 'idle' });
          return;
        }
        setPhase({ kind: 'ready', recap: r });
        if (lastSpokenRef.current !== r.narration) {
          lastSpokenRef.current = r.narration;
          void voiceService.speak(r.narration);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Recap failed',
        });
      });
    return; // cancel signal handled by the inner closure
  };

  if (studentMoves.length === 0) return null;

  if (phase.kind === 'idle') {
    return (
      <button
        type="button"
        onClick={runRecap}
        className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-cyan-400 hover:text-cyan-300 self-start"
        data-testid="endgame-recap-show"
      >
        <BarChart3 size={12} />
        Show accuracy breakdown
      </button>
    );
  }

  if (phase.kind === 'loading') {
    return (
      <div
        className="flex items-center gap-2 text-[11px] text-theme-text-muted mt-1"
        data-testid="endgame-recap-loading"
      >
        <Loader2 size={12} className="animate-spin" />
        <span>Analyzing your moves…</span>
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div
        className="flex items-center gap-2 text-[11px] text-amber-400 mt-1"
        data-testid="endgame-recap-error"
      >
        <AlertCircle size={12} />
        <span>Recap unavailable: {phase.message}</span>
      </div>
    );
  }

  const { recap } = phase;
  const acc = Math.round(recap.accuracy);
  const pillCounts: Array<[RecapClassification, number]> = [
    ['best', recap.counts.best],
    ['inaccuracy', recap.counts.inaccuracy],
    ['mistake', recap.counts.mistake],
    ['blunder', recap.counts.blunder],
  ];

  return (
    <div
      className="mt-1.5 rounded-lg border border-theme-border bg-theme-surface/60 p-2.5"
      data-testid="endgame-recap-card"
    >
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-cyan-400" />
          <span className="text-xs font-semibold text-theme-text">
            {acc}% accuracy
          </span>
          <span className="text-[10px] text-theme-text-muted">
            · {recap.moves.length} {recap.moves.length === 1 ? 'move' : 'moves'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {pillCounts.map(([kind, n]) =>
          n > 0 ? (
            <span
              key={kind}
              className={`text-[10px] px-1.5 py-0.5 rounded bg-theme-bg/50 ${CLASSIFICATION_COLOR[kind]}`}
              data-testid={`recap-pill-${kind}`}
            >
              {n} {CLASSIFICATION_LABEL[kind].toLowerCase()}
              {n === 1 ? '' : kind === 'inaccuracy' ? '' : 's'}
            </span>
          ) : null,
        )}
      </div>
      <p className="text-[11px] text-theme-text-muted leading-snug">
        {recap.narration}
      </p>
    </div>
  );
}
