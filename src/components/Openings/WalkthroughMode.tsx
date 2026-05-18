import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { Chess } from 'chess.js';
import { motion } from 'framer-motion';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { VoiceDebugPanel } from './VoiceDebugPanel';
import { useChessGame } from '../../hooks/useChessGame';
import { EngineLines } from '../Board/EngineLines';
import { LichessLines } from '../Board/LichessLines';
import { AnalysisToggles } from '../Board/AnalysisToggles';
import { BoardControls } from '../Board/BoardControls';
import { useSettings } from '../../hooks/useSettings';
import { AnnotationCard } from './AnnotationCard';
import { voiceService } from '../../services/voiceService';
import { unlockAudioContext } from '../../services/audioContextManager';
import { stockfishEngine } from '../../services/stockfishEngine';
import { fetchCloudEval } from '../../services/lichessExplorerService';
import { loadSubLineAnnotations, loadAnnotationsForPgn } from '../../services/annotationService';
import { useBoardContext } from '../../hooks/useBoardContext';
import { useStrictNarration } from '../../hooks/useStrictNarration';
import { trimToSentences, isGenericAnnotationText } from '../../services/walkthroughNarration';
import { generateWalkthroughNarrations } from '../../services/walkthroughLlmNarrator';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import type { OpeningRecord, OpeningVariation, OpeningMoveAnnotation, AnalysisLine, LichessCloudEval } from '../../types';
import { ArrowRight, Play, Pause, Info } from 'lucide-react';

export interface WalkthroughModeProps {
  opening: OpeningRecord;
  variationIndex?: number;
  customLine?: OpeningVariation;
  subLineKey?: string; // e.g. 'variation-0', 'trap-1', 'warning-0'
  onExit: () => void;
}

interface MoveInfo {
  san: string;
  from: string;
  to: string;
}

type AutoPlaySpeed = 'learn' | 'study' | 'review' | 'drill';

// Words-per-minute reading speed used by the arrow-stagger fallback timer
// (when TTS boundary events aren't available).
const READING_WPM: Record<AutoPlaySpeed, number> = {
  learn: 120,
  study: 160,
  review: 250,
  drill: 999,
};

// Post-narration buffer before advancing to the next move in auto-play.
// The strict-narration hook honors voice completion as the primary timer; this
// is just a quiet pause between moves.
const POST_NARRATION_MS: Record<AutoPlaySpeed, number> = {
  learn: 600,
  study: 300,
  review: 200,
  drill: 0,
};

// Whether arrows should stagger in progressively or appear all at once
const STAGGER_ARROWS: Record<AutoPlaySpeed, boolean> = {
  learn: true,
  study: true,
  review: false,
  drill: false,
};

// Whether narration should be spoken
const NARRATE: Record<AutoPlaySpeed, boolean> = {
  learn: true,
  study: true,
  review: true,
  drill: false,
};

/** How many sentences to show/speak for each speed. null = full text. */
const SENTENCE_LIMIT: Record<AutoPlaySpeed, number | null> = {
  learn: null,     // Full annotation
  study: 3,        // Slightly trimmed
  review: 1,       // Just the key point
  drill: null,     // Hidden entirely
};

export function WalkthroughMode({
  opening,
  variationIndex,
  customLine,
  subLineKey,
  onExit,
}: WalkthroughModeProps): JSX.Element {
  // Read voice prefs from Zustand (synchronous — avoids async DB read that
  // would break iOS Safari's user-gesture context for Web Speech API).
  const activeProfile = useAppStore((s) => s.activeProfile);
  const voiceEnabled = activeProfile?.preferences.voiceEnabled ?? true;

  const isVariation = variationIndex !== undefined && variationIndex >= 0;
  const variation = customLine ?? (isVariation ? opening.variations?.[variationIndex] : undefined);
  const activePgn = variation ? variation.pgn : opening.pgn;

  // Parse PGN into move list
  const expectedMoves = useMemo((): MoveInfo[] => {
    const tokens = activePgn.trim().split(/\s+/).filter(Boolean);
    const chess = new Chess();
    const moves: MoveInfo[] = [];
    for (const san of tokens) {
      try {
        const move = chess.move(san);
        moves.push({ san, from: move.from, to: move.to });
      } catch {
        break;
      }
    }
    return moves;
  }, [activePgn]);

  const [annotations, setAnnotations] = useState<OpeningMoveAnnotation[] | null>(null);

  // Ref for TTS boundary callback — updated per annotation
  const boundaryHandlerRef = useRef<((charIndex: number) => void) | null>(null);
  const [autoPlaySpeed, setAutoPlaySpeed] = useState<AutoPlaySpeed>('learn');
  const [showSpeedInfo, setShowSpeedInfo] = useState(false);

  // ─── Strict narration ──────────────────────────────────────────────────────
  // The hook owns currentStep + isAutoPlaying. It speaks each step's narration
  // and only advances after the speech promise resolves — no parallel timers.
  // Steps: 0 = overview (no narration), 1..N = the N moves of the line.

  // applyStep is a no-op because the FEN is derived from currentMoveIndex
  // (== hook.currentStep) via fenAtIndex, so React updates the board for free
  // when the hook updates its index. We pass an empty function rather than
  // omitting the prop so the contract is explicit.
  const applyStep = useCallback((_idx: number) => { /* board derives from hook state */ }, []);

  // Resolve the annotation entry that pairs with a given ply (1-indexed
  // step from useStrictNarration: step 0 is the overview, step N is the
  // N-th move). Shared by both the voice narrator (`getNarrationFor`)
  // and the on-screen card (`baseAnnotation`) so they NEVER show
  // different narration for the same step — caught in 2026-05-18
  // audit where the SAN-first card lookup returned ply-3 narration on
  // the ply-19 card because both plies played `d5`.
  //
  // Resolution order:
  //   1. annotations[i] when its SAN matches the played SAN at ply i+1
  //      (the common case: stubs are 1:1 with the PGN).
  //   2. SAN-first with OCCURRENCE COUNTING — the N-th occurrence of
  //      `playedSan` in expectedMoves[0..idx] maps to the N-th
  //      occurrence in `annotations`. Without counting, repeated
  //      SANs (Naroditsky Alapin trap-0: Black ply-3 d5 AND White
  //      ply-19 d5) collapsed to the first occurrence on every later
  //      hit.
  //   3. Bare annotations[i] when SAN doesn't agree.
  //   4. null when nothing fits — caller decides whether to silence
  //      voice or render a synthesised placeholder.
  const resolveAnnotationForStep = useCallback(
    (step: number): OpeningMoveAnnotation | null => {
      if (step <= 0 || !annotations) return null;
      const idx = step - 1;
      const playedSan = expectedMoves[idx]?.san;
      const byIdx = annotations[idx];
      if (byIdx && playedSan && byIdx.san === playedSan) return byIdx;
      if (playedSan) {
        let targetOccurrence = 0;
        for (let i = 0; i <= idx; i += 1) {
          if (expectedMoves[i]?.san === playedSan) targetOccurrence += 1;
        }
        let seen = 0;
        for (const ann of annotations) {
          if (ann.san === playedSan) {
            seen += 1;
            if (seen === targetOccurrence) return ann;
          }
        }
        const bySan = annotations.find((a) => a.san === playedSan);
        if (bySan) return bySan;
      }
      return byIdx ?? null;
    },
    [annotations, expectedMoves],
  );

  const getNarrationFor = useCallback((idx: number): string => {
    // Audit-log every empty return so silent rapid-fire bugs surface
    // in the in-app audit log with a specific reason — no need to
    // open DevTools to triage.
    const logEmpty = (reason: string, detail?: string): '' => {
      void import('../../services/appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'walkthrough-narration-empty',
          category: 'subsystem',
          source: 'WalkthroughMode.getNarrationFor',
          summary: `step ${idx}: ${reason}`,
          details: detail,
        });
      }).catch(() => { /* never break narration on a log failure */ });
      return '';
    };

    if (idx === 0) return '';
    if (!NARRATE[autoPlaySpeed]) return logEmpty('drill mode (NARRATE flag is false)', `autoPlaySpeed=${autoPlaySpeed}`);
    if (!annotations) return logEmpty('annotations not loaded yet', `total=null`);
    // Pair the spoken narration with the SAME annotation entry the
    // on-screen card uses — see `resolveAnnotationForStep`. Bare
    // `annotations[idx-1]` would silently drift on lines with
    // repeated SANs (Naroditsky Alapin trap-0).
    const ann = resolveAnnotationForStep(idx);
    if (!ann) return logEmpty('no annotation at this index', `idx=${idx} of ${annotations.length}`);
    const fullText = ann.narration ?? ann.annotation;
    if (!fullText) return logEmpty('annotation has no text', `narration=${ann.narration === undefined ? 'undef' : `"${(ann.narration ?? '').slice(0, 20)}"`} annotation=${!ann.annotation ? '<empty>' : `"${ann.annotation.slice(0, 20)}"`}`);

    // Suppress synthesised PGN-only stubs and generic templated filler.
    // Without this gate, the first plies of any opening whose curated
    // annotations are missing get their bare SAN ("e4", "c5", "Nf3")
    // spoken aloud during the ~7s window before the LLM enricher
    // finishes — caught in 2026-05-18 audit (findings 59/62/65: bare
    // SAN textLength=2 spoken). Silence is acceptable per §Narration
    // Voice Rules; the LLM-enriched real narration arrives on the next
    // step transition once the parallel enrichment promise resolves.
    if (isGenericAnnotationText(fullText)) {
      return logEmpty('generic/bare-SAN stub — narrator will replace shortly', `text="${fullText.slice(0, 30)}"`);
    }

    const limit = SENTENCE_LIMIT[autoPlaySpeed];
    if (limit !== null) {
      const out = ann.shortNarration ?? trimToSentences(fullText, limit);
      if (!out) return logEmpty('sentence-trim produced empty', `limit=${limit} from "${fullText.slice(0, 30)}"`);
      return out;
    }
    return fullText;
  }, [annotations, autoPlaySpeed, resolveAnnotationForStep]);

  const narration = useStrictNarration({
    stepCount: expectedMoves.length + 1, // +1 for overview at step 0
    applyStep,
    getNarration: getNarrationFor,
    postNarrationDelayMs: POST_NARRATION_MS[autoPlaySpeed],
    voiceEnabled,
  });

  const currentMoveIndex = narration.currentStep;
  const isAutoPlaying = narration.isAutoPlaying;

  // Annotations load asynchronously from IndexedDB. If the user is already on
  // a move that needs narration when the load completes, re-trigger speech for
  // the current step so the freshly-loaded text gets spoken.
  const annotationsLoadedRef = useRef(false);
  useEffect(() => {
    if (annotations && !annotationsLoadedRef.current) {
      annotationsLoadedRef.current = true;
      if (currentMoveIndex > 0) {
        narration.replay();
      }
    }
  }, [annotations, currentMoveIndex, narration]);

  // Do NOT auto-load Kokoro here — the 87 MB WASM model causes OOM crashes
  // on iOS Safari. Kokoro only loads when the user explicitly taps
  // "Download Voice Model" in Settings > Coach > HD Voice.

  // Analysis toggle overrides
  const { settings } = useSettings();
  // Default to ON in walkthrough mode — students learning openings benefit
  // from seeing eval shift across each move. Toggle still respects user
  // input via AnalysisToggles.
  const [evalBarOverride, setEvalBarOverride] = useState<boolean | null>(true);
  const [engineLinesOverride, setEngineLinesOverride] = useState<boolean | null>(null);
  const showEvalBarEffective = evalBarOverride ?? settings.showEvalBar;
  const showEngineLinesEffective = engineLinesOverride ?? settings.showEngineLines;

  // Stockfish eval state
  const [latestEval, setLatestEval] = useState<number | null>(null);
  const [latestIsMate, setLatestIsMate] = useState(false);
  const [latestMateIn, setLatestMateIn] = useState<number | null>(null);
  const [latestTopLines, setLatestTopLines] = useState<AnalysisLine[]>([]);

  // Lichess cloud eval state
  const [lichessOverride, setLichessOverride] = useState<boolean | null>(null);
  const showLichessEffective = lichessOverride ?? false;
  const [cloudEval, setCloudEval] = useState<LichessCloudEval | null>(null);

  // Track last move highlight
  const lastMove = useMemo((): { from: string; to: string } | null => {
    if (currentMoveIndex === 0) return null;
    const prev = expectedMoves[currentMoveIndex - 1] as { from: string; to: string } | undefined;
    return prev ? { from: prev.from, to: prev.to } : null;
  }, [currentMoveIndex, expectedMoves]);

  // Compute FEN at a given move index
  const fenAtIndex = useCallback(
    (idx: number): string => {
      const chess = new Chess();
      for (let i = 0; i < idx && i < expectedMoves.length; i++) {
        try {
          chess.move(expectedMoves[i].san);
        } catch {
          break;
        }
      }
      return chess.fen();
    },
    [expectedMoves],
  );

  const currentFen = useMemo(() => fenAtIndex(currentMoveIndex), [fenAtIndex, currentMoveIndex]);

  // Controlled chess game for the board
  const game = useChessGame(currentFen, opening.color);

  // Sync game position whenever the derived FEN changes (move navigation / auto-play)
  useEffect(() => {
    if (game.fen !== currentFen) {
      game.loadFen(currentFen);
    }
  }, [currentFen, game]);

  // Publish board context for global coach drawer
  const turn = currentFen.split(' ')[1] === 'b' ? 'b' : 'w';
  const prevMove = currentMoveIndex > 0 ? expectedMoves[currentMoveIndex - 1] : undefined;
  const ctxLastMove = prevMove ? { from: prevMove.from, to: prevMove.to, san: prevMove.san } : undefined;
  const ctxHistory = expectedMoves.slice(0, currentMoveIndex).map((m) => m.san);
  useBoardContext(currentFen, activePgn, Math.floor(currentMoveIndex / 2) + 1, opening.color, turn, ctxLastMove, ctxHistory);

  // Synthesise a minimal annotation array from the active PGN. Used as
  // a last-resort when neither index nor name-based lookup finds a
  // matching subline — the contract between repertoire.json variations
  // and src/data/annotations/<id>.json subLines is broken in 34/40
  // openings (variations get added to repertoire without matching
  // annotation subLines). Without this fallback, those variations play
  // silent rapid-fire because annotations stays null forever.
  //
  // Each stub's annotation is just the bare SAN (no trailing
  // punctuation) so it matches the bare-SAN GENERIC_ANNOTATION_PATTERN
  // entry. That makes needsFill below see it as filler and call the
  // LLM enricher, which writes a real narration into the `narration`
  // field. End result: From's Gambit Declined goes from no annotations
  // (silent) → bare-SAN stubs (matches board, sounds robotic) → real
  // LLM-generated narration (matches board, sounds like teaching).
  const synthesisedFromPgn = useMemo((): OpeningMoveAnnotation[] => {
    return expectedMoves.map((m) => ({
      san: m.san,
      annotation: m.san,
    }));
  }, [expectedMoves]);

  // Load annotations — sub-line-specific if key provided, otherwise main line
  useEffect(() => {
    const guard: { cancelled: boolean } = { cancelled: false };
    void voiceService.warmup();

    // Kick off the LLM narration call IMMEDIATELY in parallel with the
    // annotation file load. The LLM call takes ~7s while loadSubLine
    // returns within a few ms; running them in parallel saves the
    // sequential tail. Combined with the pre-warm fired by
    // OpeningDetailPage when the variation card is selected, the LLM
    // result usually lands by the time the user hits Play, so we skip
    // the bare-SAN stub window entirely on first visit.
    // Pass curator context (opening overview + key ideas + variation
    // explanation) to the LLM narrator. Without these, the LLM
    // hallucinates per-move text that often contradicts the actual
    // variation's strategic point — e.g. the 2026-05-17 audit caught
    // a Fantasy Caro walkthrough recommending Nxe4 recapture (a
    // Classical Caro move) because the LLM had no idea which Caro
    // variation it was narrating. With curator context, the LLM sees
    // the curator's framing ("the whole point is fxe4 opening the
    // f-file") and aligns its per-move text accordingly.
    const llmPromise = generateWalkthroughNarrations({
      openingName: opening.name,
      variationName: variation?.name,
      pgn: activePgn,
      openingOverview: opening.overview ?? undefined,
      openingKeyIdeas: opening.keyIdeas ?? undefined,
      variationExplanation: variation?.explanation,
    }).catch(() => null as null | { narrations: string[]; fromCache: boolean });

    void (async () => {
      const effectiveKey = subLineKey ?? (isVariation ? `variation-${variationIndex}` : undefined);
      let data: OpeningMoveAnnotation[] | null;
      if (effectiveKey) {
        data = await loadSubLineAnnotations(opening.id, effectiveKey, variation?.name, activePgn);
      } else {
        data = await loadAnnotationsForPgn(opening.id, activePgn);
      }
      if (guard.cancelled) return;
      // Last-resort fallback: synthesise from the PGN so the user never
      // hits silent rapid-fire even when curated annotations are missing.
      // The LLM enricher below will replace these stubs with real text.
      if (!data || data.length === 0) {
        if (synthesisedFromPgn.length === 0) {
          setAnnotations(null);
          return;
        }
        data = synthesisedFromPgn;
        const stubCount = data.length;
        void import('../../services/appAuditor').then(({ logAppAudit }) => {
          void logAppAudit({
            kind: 'walkthrough-narration-empty',
            category: 'subsystem',
            source: 'WalkthroughMode.loadAnnotations',
            summary: `synthesised PGN-only stubs for ${opening.id}/${effectiveKey ?? 'main'}`,
            details: `variation="${variation?.name ?? '<none>'}" plies=${stubCount}`,
          });
        }).catch(() => {/* never break */});
      } else if (data.length < expectedMoves.length) {
        // PARTIAL annotations: the loader found a subline but it walks
        // FEWER plies than the active PGN. Without topping up, moves
        // past the annotation's end hit the per-move "Continuing this
        // line: X is a known theory move" fallback (caught on the
        // 2026-05-17 Fantasy Caro audit). Top up with synthesised
        // stubs so the LLM enricher loop below fills them with real
        // narration that matches the actual position.
        const hadCount = data.length;
        const topUp = synthesisedFromPgn.slice(hadCount);
        const missingCount = topUp.length;
        const newTotal = hadCount + missingCount;
        data = [...data, ...topUp];
        const pgnLen = expectedMoves.length;
        void import('../../services/appAuditor').then(({ logAppAudit }) => {
          void logAppAudit({
            kind: 'walkthrough-narration-empty',
            category: 'subsystem',
            source: 'WalkthroughMode.loadAnnotations',
            summary: `topped-up annotations for ${opening.id}/${effectiveKey ?? 'main'}`,
            details: `variation="${variation?.name ?? '<none>'}" had=${hadCount} pgn=${pgnLen} stubsAdded=${missingCount} newTotal=${newTotal}`,
          });
        }).catch(() => {/* never break */});
      }
      // Show raw annotations immediately so the UI isn't blocked while the
      // LLM narrator does its work. Pre-fetch audio based on whatever text
      // we have right now; we'll prefetch again once enrichment completes.
      setAnnotations(data);
      void voiceService.prefetchAudio(data.map(a => a.narration ?? a.annotation));

      // Enrich any missing or generic-filler narrations via a batched LLM
      // call. Cached in Dexie, so repeat visits resolve instantly. Curated
      // real content is preserved. This is what gives trap/warning and
      // variation walkthroughs the same teaching depth as the dynamic
      // coach-session walkthroughs.
      //
      // We treat `annotation` as a fallback for `narration` because the
      // curated JSON files write to `annotation` only. Without this
      // fallback the LLM would override good curated annotations with
      // its own (potentially filler) output, leaving sublines silent
      // when the LLM result trips isGenericAnnotationText at playback.
      const needsFill = data.some((a) => {
        const text = (a.narration ?? a.annotation ?? '').trim();
        return !text || isGenericAnnotationText(text);
      });
      if (!needsFill) return;

      // Use the parallel-fetched LLM result kicked off above. If
      // OpeningDetailPage pre-warmed this variation, the cache hit
      // returns immediately and the user never sees bare-SAN stubs.
      const llmResult = await llmPromise;
      if (guard.cancelled) return;
      if (!llmResult) {
        console.warn('[WalkthroughMode] LLM narration fill failed');
        return;
      }
      const narrations = llmResult.narrations;
      const enriched: OpeningMoveAnnotation[] = data.map((ann, i) => {
        const existing = (ann.narration ?? ann.annotation ?? '').trim();
        if (existing && !isGenericAnnotationText(existing)) return ann;
        const fromLlm = narrations[i]?.trim();
        if (!fromLlm || isGenericAnnotationText(fromLlm)) return ann;
        return { ...ann, narration: fromLlm };
      });
      setAnnotations(enriched);
      void voiceService.prefetchAudio(enriched.map((a) => a.narration ?? a.annotation));
    })();
    return () => { guard.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tracked for dedicated audit; intentional dep list.
  }, [opening.id, opening.name, activePgn, subLineKey, isVariation, variationIndex, variation?.name]);

  // Analyze each position with Stockfish so the eval bar reflects
  // whatever's on the board. Re-runs whenever the displayed FEN changes
  // (advance, rewind, jump). Failures used to be swallowed silently —
  // now they surface to the console so a stuck-at-0.0 eval bar can be
  // diagnosed.
  useEffect(() => {
    const guard = { cancelled: false };
    void (async () => {
      try {
        const analysis = await stockfishEngine.analyzePosition(currentFen, 14);
        if (!guard.cancelled) {
          setLatestEval(analysis.evaluation);
          setLatestIsMate(analysis.isMate);
          setLatestMateIn(analysis.mateIn);
          setLatestTopLines(analysis.topLines);
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[WalkthroughMode] stockfish analyze failed:', err);
        }
      }
    })();
    return () => { guard.cancelled = true; };
  }, [currentFen]);

  // Lichess cloud eval on position change
  useEffect(() => {
    if (!showLichessEffective) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchCloudEval(currentFen, 3);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelled) setCloudEval(result);
      } catch { /* Cloud eval not available */ }
    })();
    return () => { cancelled = true; };
  }, [currentFen, showLichessEffective]);

  // Current annotation for the move that was just played — enhanced
  // with DB narrations. Goes through the SHARED `resolveAnnotationForStep`
  // helper so the on-screen card and the spoken narration are always
  // fed from the same annotation entry. Synthesised "this is theory"
  // placeholder kicks in when the helper returns null (moves past the
  // end of the annotation array).
  const baseAnnotation = useMemo((): OpeningMoveAnnotation | null => {
    if (!annotations) return null;
    if (currentMoveIndex === 0) return null;
    const idx = currentMoveIndex - 1;
    const resolved = resolveAnnotationForStep(currentMoveIndex);
    if (resolved) return resolved;
    const playedSan = expectedMoves[idx]?.san;
    if (playedSan) {
      return {
        san: playedSan,
        annotation: `Continuing this line: ${playedSan} is a known theory move.`,
      };
    }
    return null;
  }, [annotations, currentMoveIndex, expectedMoves, resolveAnnotationForStep]);

  // The displayed annotation is the base annotation (curated JSON +
  // LLM enrichment). The legacy `enhanceWithNarration` override was
  // REMOVED here on 2026-05-17 because the FEN-keyed
  // `db.openingNarrations` seed table was leaking cross-family
  // narration: every walkthrough that started 1.e4 (Caro, Sicilian,
  // French, Pirc) pulled the seeded "Italian Game with e4" text
  // because all share the same FEN after 1.e4. The seed system
  // pre-dates `walkthroughLlmNarrator` — with the LLM narrator now
  // generating per-variation prose from curator context, the
  // FEN-keyed seed is strictly inferior and harmful here.
  const currentAnnotation = baseAnnotation;

  // ─── Real-time arrow/highlight reveal via TTS boundary events ────────────

  const [visibleArrowCount, setVisibleArrowCount] = useState(0);
  const [visibleHighlightCount, setVisibleHighlightCount] = useState(0);
  const fallbackTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const boundaryActive = useRef(false);

  // Compute the character position in the annotation where each arrow/highlight
  // should appear. Items are spaced evenly across the text length.
  const computeCharTriggers = useCallback((
    annotationText: string,
    arrowCount: number,
    highlightCount: number,
  ): { arrowCharPos: number[]; highlightCharPos: number[] } => {
    const totalLen = annotationText.length;
    const totalItems = arrowCount + highlightCount;
    if (totalItems === 0) return { arrowCharPos: [], highlightCharPos: [] };

    const arrowCharPos: number[] = [];
    for (let i = 0; i < arrowCount; i++) {
      // First item triggers at position 0 (immediate), rest spaced evenly
      arrowCharPos.push(Math.floor((i / totalItems) * totalLen));
    }
    const highlightCharPos: number[] = [];
    for (let i = 0; i < highlightCount; i++) {
      highlightCharPos.push(Math.floor(((arrowCount + i) / totalItems) * totalLen));
    }
    return { arrowCharPos, highlightCharPos };
  }, []);

  // When annotation changes, set up boundary-driven reveals with timer fallback
  useEffect(() => {
    // Clear previous fallback timers
    for (const t of fallbackTimers.current) clearTimeout(t);
    fallbackTimers.current = [];
    boundaryActive.current = false;
    setVisibleArrowCount(0);
    setVisibleHighlightCount(0);

    if (!currentAnnotation) return;

    const arrows = currentAnnotation.arrows ?? [];
    const highlights = currentAnnotation.highlights ?? [];
    if (arrows.length === 0 && highlights.length === 0) return;

    // At Review/Drill speed, show all arrows and highlights immediately
    if (!STAGGER_ARROWS[autoPlaySpeed]) {
      setVisibleArrowCount(arrows.length);
      setVisibleHighlightCount(highlights.length);
      return;
    }

    const text = currentAnnotation.annotation;
    const { arrowCharPos, highlightCharPos } = computeCharTriggers(
      text, arrows.length, highlights.length,
    );

    // Track which items have been revealed (to avoid duplicates)
    const revealedArrows = new Set<number>();
    const revealedHighlights = new Set<number>();

    // TTS boundary handler — called as each word is spoken
    const onBoundary = (charIndex: number): void => {
      boundaryActive.current = true;

      // Reveal any arrows whose trigger position has been passed
      for (let i = 0; i < arrowCharPos.length; i++) {
        if (!revealedArrows.has(i) && charIndex >= arrowCharPos[i]) {
          revealedArrows.add(i);
          setVisibleArrowCount((prev) => Math.max(prev, i + 1));
        }
      }
      // Reveal any highlights whose trigger position has been passed
      for (let i = 0; i < highlightCharPos.length; i++) {
        if (!revealedHighlights.has(i) && charIndex >= highlightCharPos[i]) {
          revealedHighlights.add(i);
          setVisibleHighlightCount((prev) => Math.max(prev, i + 1));
        }
      }
    };

    // Store the boundary handler so the TTS effect can use it
    boundaryHandlerRef.current = onBoundary;

    // Fallback: if TTS boundary events don't fire (some browsers),
    // use timer-based stagger after a short delay
    const fallbackDelay = 800; // wait to see if boundary events start
    const fallbackTimer = setTimeout(() => {
      if (boundaryActive.current) return; // boundary events are working

      // Timer-based fallback: space evenly across reading time
      const wordCount = text.split(/\s+/).length;
      const wordsPerSec = READING_WPM[autoPlaySpeed] / 60;
      const readingTimeSec = wordCount / wordsPerSec;
      const totalItems = arrows.length + highlights.length;

      arrows.forEach((_, i) => {
        const delaySec = (i / totalItems) * readingTimeSec;
        if (delaySec <= 0) {
          setVisibleArrowCount((prev) => Math.max(prev, i + 1));
        } else {
          const timer = setTimeout(() => {
            setVisibleArrowCount((prev) => Math.max(prev, i + 1));
          }, delaySec * 1000);
          fallbackTimers.current.push(timer);
        }
      });

      highlights.forEach((_, i) => {
        const delaySec = ((arrows.length + i) / totalItems) * readingTimeSec;
        if (delaySec <= 0) {
          setVisibleHighlightCount((prev) => Math.max(prev, i + 1));
        } else {
          const timer = setTimeout(() => {
            setVisibleHighlightCount((prev) => Math.max(prev, i + 1));
          }, delaySec * 1000);
          fallbackTimers.current.push(timer);
        }
      });
    }, fallbackDelay);
    fallbackTimers.current.push(fallbackTimer);

    return () => {
      for (const t of fallbackTimers.current) clearTimeout(t);
      fallbackTimers.current = [];
      boundaryHandlerRef.current = null;
    };
  }, [currentAnnotation, computeCharTriggers, autoPlaySpeed]);

  // Convert visible arrows/highlights to board format. Returns [] (not
  // undefined) when no arrows so ConsistentChessboard's controlled
  // arrow path still fires — without this, switching from a step with
  // arrows to one without leaves the previous step's arrows on the
  // board (react-chessboard treats missing prop as uncontrolled).
  const boardArrows = useMemo(() => {
    if (!currentAnnotation?.arrows || visibleArrowCount === 0) return [];
    return currentAnnotation.arrows.slice(0, visibleArrowCount).map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: a.color ?? 'rgba(0, 180, 80, 0.8)',
    }));
  }, [currentAnnotation, visibleArrowCount]);

  const boardHighlights = useMemo(() => {
    if (!currentAnnotation?.highlights || visibleHighlightCount === 0) return undefined;
    return currentAnnotation.highlights.slice(0, visibleHighlightCount).map((h) => ({
      square: h.square,
      color: h.color ?? 'rgba(255, 255, 0, 0.4)',
    }));
  }, [currentAnnotation, visibleHighlightCount]);

  // Current move number and color for display
  const displayMoveNumber = currentMoveIndex === 0
    ? 1
    : Math.floor((currentMoveIndex - 1) / 2) + 1;
  const displayIsWhite = currentMoveIndex === 0 || (currentMoveIndex - 1) % 2 === 0;
  const displayActualSan = currentMoveIndex > 0
    ? expectedMoves[currentMoveIndex - 1]?.san
    : undefined;

  const cycleSpeed = useCallback(() => {
    setAutoPlaySpeed((prev) => {
      const order: AutoPlaySpeed[] = ['learn', 'study', 'review', 'drill'];
      const idx = order.indexOf(prev);
      return order[(idx + 1) % order.length];
    });
  }, []);

  // Voice speed comes from the user's global preference in Settings,
  // NOT from the walkthrough speed tier. The tier controls lesson pace
  // (content amount, timing, arrows) while Settings controls how the
  // voice sounds.

  // Navigation handlers — all delegate to the strict-narration hook so that
  // every transition cancels in-flight speech and supersedes any pending
  // auto-advance via the hook's token counter.
  const handleFirst = useCallback(() => narration.goToStep(0), [narration]);
  const handlePrev = useCallback(() => {
    unlockAudioContext();
    narration.prev();
  }, [narration]);
  const handleNext = useCallback(() => {
    unlockAudioContext();
    narration.next();
  }, [narration]);
  const handleLast = useCallback(
    () => narration.goToStep(expectedMoves.length),
    [narration, expectedMoves.length],
  );
  const toggleAutoPlay = useCallback(() => {
    unlockAudioContext();
    narration.toggleAutoPlay();
  }, [narration]);

  const progress = expectedMoves.length > 0
    ? Math.round((currentMoveIndex / expectedMoves.length) * 100)
    : 0;

  const title = variation ? variation.name : opening.name;

  const header = (
    <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
      <div className="flex items-center gap-3">
        <button
          onClick={onExit}
          className="p-1.5 rounded-lg hover:bg-theme-surface"
          data-testid="walkthrough-back"
        >
          <ArrowRight size={16} className="text-theme-text rotate-180" />
        </button>
        <div>
          <p className="text-sm font-semibold text-theme-text">Walkthrough: {title}</p>
          <p className="text-xs text-theme-text-muted">{opening.eco} &middot; {opening.style}</p>
        </div>
      </div>
      <AnalysisToggles
        showEvalBar={showEvalBarEffective}
        onToggleEvalBar={() => setEvalBarOverride((prev) => !(prev ?? settings.showEvalBar))}
        showEngineLines={showEngineLinesEffective}
        onToggleEngineLines={() => setEngineLinesOverride((prev) => !(prev ?? settings.showEngineLines))}
        showLichessLines={showLichessEffective}
        onToggleLichessLines={() => setLichessOverride((prev) => !(prev ?? false))}
      />
    </div>
  );

  const aboveBoard = (
    <div className="px-4 pt-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] text-theme-text-muted uppercase font-medium">
          Move {currentMoveIndex} / {expectedMoves.length}
        </span>
      </div>
      <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-theme-accent rounded-full"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3 }}
          data-testid="walkthrough-progress"
        />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard
      game={game}
      interactive={false}
      showFlipButton={false}
      showUndoButton={false}
      showResetButton={false}
      showVoiceMic={false}
      showEvalBar={showEvalBarEffective}
      evaluation={latestEval}
      isMate={latestIsMate}
      mateIn={latestMateIn}
      highlightSquares={lastMove}
      arrows={boardArrows}
      annotationHighlights={boardHighlights}
    />
  );

  const belowBoard = (showEngineLinesEffective && latestTopLines.length > 0) || (showLichessEffective && cloudEval) ? (
    <>
      {showEngineLinesEffective && latestTopLines.length > 0 && (
        <EngineLines lines={latestTopLines} fen={currentFen} className="mt-1" />
      )}
      {showLichessEffective && cloudEval && (
        <LichessLines cloudEval={cloudEval} fen={currentFen} className="mt-1" />
      )}
    </>
  ) : undefined;

  const controls = (
    <div className="flex flex-col gap-2">
      <BoardControls
        onFirst={handleFirst}
        onPrev={handlePrev}
        onNext={handleNext}
        onLast={handleLast}
        canGoPrev={currentMoveIndex > 0}
        canGoNext={currentMoveIndex < expectedMoves.length}
        extraLeft={
          <button
            onClick={toggleAutoPlay}
            className="p-2 rounded-lg border text-theme-text hover:bg-theme-surface transition-colors"
            style={{ borderColor: 'var(--color-border)' }}
            aria-label={isAutoPlaying ? 'Pause' : 'Play'}
            data-testid="walkthrough-play-pause"
          >
            {isAutoPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
        }
      />
      <div className="relative flex items-center justify-center gap-2">
        <span className="text-[9px] text-theme-text-muted uppercase tracking-wide">
          Voice Narration
        </span>
        <button
          onClick={cycleSpeed}
          className="px-2.5 py-1 rounded-lg border text-xs font-medium hover:bg-theme-surface transition-colors"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
          aria-label={`Speed: ${autoPlaySpeed}`}
          data-testid="walkthrough-speed-toggle"
        >
          {autoPlaySpeed.charAt(0).toUpperCase() + autoPlaySpeed.slice(1)}
        </button>
        <button
          onClick={() => setShowSpeedInfo((v) => !v)}
          className="p-1 rounded-full hover:bg-theme-surface transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          aria-label="Speed info"
          data-testid="walkthrough-speed-info-btn"
        >
          <Info size={13} />
        </button>
        {showSpeedInfo && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowSpeedInfo(false)}
            />
            <div
              className="absolute bottom-full right-0 mb-2 w-64 rounded-xl border p-3 shadow-xl z-50 text-xs leading-relaxed"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text)',
              }}
              data-testid="walkthrough-speed-info-popup"
            >
              <p className="font-semibold mb-1.5">Voice Narration Speed</p>
              <ul className="space-y-1.5">
                <li><span className="font-medium">Learn</span> — Slow and thorough. Full explanations read aloud, arrows appear progressively, long pauses to absorb.</li>
                <li><span className="font-medium">Study</span> — Same content but faster pacing.</li>
                <li><span className="font-medium">Review</span> — Quick refresher. Annotations trimmed, arrows appear all at once, minimal pauses.</li>
                <li><span className="font-medium">Drill</span> — Just the moves. No narration, no voice. Pure repetition.</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const belowControls = autoPlaySpeed !== 'drill' ? (
    currentMoveIndex === 0 && opening.overview ? (
      <div
        className="rounded-2xl backdrop-blur-xl bg-theme-surface/90 border border-white/15 p-4 shadow-lg"
        data-testid="walkthrough-overview"
      >
        <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wide mb-2">
          Overview
        </p>
        <p className="text-sm text-theme-text leading-relaxed">{opening.overview}</p>
      </div>
    ) : (
      <AnnotationCard
        annotation={currentAnnotation}
        moveNumber={displayMoveNumber}
        isWhite={displayIsWhite}
        visible={currentMoveIndex > 0}
        actualSan={displayActualSan}
      />
    )
  ) : undefined;

  // Show the diagnostic panel on any non-production deploy or when
  // ?debug=1 is in the URL. Production hostname omits it so end-users
  // never see it.
  const showDebugPanel =
    typeof window !== 'undefined' &&
    (window.location.search.includes('debug=1') ||
      (window.location.hostname.includes('vercel.app') &&
        !window.location.hostname.startsWith('chess-academy-pro.')));

  return (
    <>
      <ChessLessonLayout
        data-testid="walkthrough-mode"
        header={header}
        aboveBoard={aboveBoard}
        board={board}
        belowBoard={belowBoard}
        controls={controls}
        belowControls={belowControls}
      />
      {showDebugPanel && <VoiceDebugPanel />}
    </>
  );
}
