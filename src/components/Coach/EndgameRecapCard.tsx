/**
 * EndgameRecapCard — Stockfish-driven post-playout accuracy recap.
 *
 * David's Photo 3 audit: a short recap of move accuracy, written
 * AND narrated, with no LLM authorship. Stockfish provides the eval
 * deltas per move, the existing winPercent + accuracyFromWinDelta
 * + harmonic-mean pipeline (ship-2) does the math, and a small bank
 * of templated narration stems renders the spoken summary.
 *
 * The card mounts on playout completion, kicks off the async
 * Stockfish analysis, and speaks the narration once the data lands.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
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

export function EndgameRecapCard({
  studentMoves,
  studentSide,
}: EndgameRecapCardProps): JSX.Element | null {
  const [recap, setRecap] = useState<EndgameRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // De-dupe the spoken narration so React StrictMode's double-effect
  // and ordinary re-renders don't trigger a second speak() — each
  // fresh recap build (different narration text) speaks once.
  const lastSpokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRecap(null);
    setError(null);
    if (studentMoves.length === 0) {
      lastSpokenRef.current = null;
      return;
    }

    buildEndgameRecap(studentMoves, studentSide)
      .then((r) => {
        if (cancelled) return;
        if (!r) return;
        setRecap(r);
        if (lastSpokenRef.current !== r.narration) {
          lastSpokenRef.current = r.narration;
          void voiceService.speak(r.narration);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Recap failed');
      });

    return () => {
      cancelled = true;
    };
  }, [studentMoves, studentSide]);

  if (studentMoves.length === 0) return null;

  if (error) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-amber-400 mt-1">
        <AlertCircle size={12} />
        <span>Recap unavailable: {error}</span>
      </div>
    );
  }

  if (!recap) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-theme-text-muted mt-1">
        <Loader2 size={12} className="animate-spin" />
        <span>Analyzing your moves…</span>
      </div>
    );
  }

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
