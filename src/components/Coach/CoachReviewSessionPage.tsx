/**
 * CoachReviewSessionPage — review a previously played game with the
 * teaching coach.
 *
 * The actual review surface IS the existing `CoachGameReview` — same
 * layout, same big nav buttons, same eval bar, same MoveListPanel,
 * same auto-review controls, same accuracy/material bars. We just
 * adapt a `GameRecord` (chess.com / lichess / coach game) into the
 * `CoachGameMove[] + KeyMoment[]` shape `CoachGameReview` already
 * understands.
 *
 * The "new teaching style" merger is handled at the envelope level —
 * `REVIEW_MODE_ADDITION` in `src/coach/envelope.ts` fires whenever
 * `surface === 'review'`, so both the new picker entry point AND the
 * post-game review path (after a finished coach game) get the same
 * Stockfish-grounded, [VOICE: ...]-marker pedagogy automatically.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Chess } from 'chess.js';
import { CoachGameReview } from './CoachGameReview';
import { db } from '../../db/schema';
import { gameNeedsAnalysis, analyzeSingleGame } from '../../services/gameAnalysisService';
import { useAppStore } from '../../stores/appStore';
import { logAppAudit } from '../../services/appAuditor';
import type {
  GameRecord,
  CoachGameMove,
  KeyMoment,
  MoveAnnotation,
  MoveClassification,
} from '../../types';

interface AdaptedReviewProps {
  moves: CoachGameMove[];
  keyMoments: KeyMoment[];
  playerColor: 'white' | 'black';
  result: string;
  openingName: string | null;
  playerName: string;
  playerRating: number;
  opponentRating: number;
  pgn: string;
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function inferPlayerColor(
  game: GameRecord,
  identity: { profileName?: string; chessComUsername?: string; lichessUsername?: string },
): 'white' | 'black' {
  if (game.source === 'coach') {
    if (game.black.toLowerCase().includes('coach') || game.black.toLowerCase().includes('bot')) {
      return 'white';
    }
    if (game.white.toLowerCase().includes('coach') || game.white.toLowerCase().includes('bot')) {
      return 'black';
    }
  }
  // Imports use the platform username, NOT the app profile name.
  // The previous version only checked profileName which silently
  // misclassified every imported game where the app name ≠ the
  // platform handle — board rendered from White's POV regardless of
  // which side the student actually played. Reported by David
  // (his app name is "David", chess.com handle is different).
  // Now check ALL three identity sources, exact match first
  // (handles "user (1200)" display names without false positives).
  const candidates: string[] = [];
  if (identity.chessComUsername) candidates.push(identity.chessComUsername.toLowerCase());
  if (identity.lichessUsername) candidates.push(identity.lichessUsername.toLowerCase());
  if (identity.profileName) candidates.push(identity.profileName.toLowerCase());
  const whiteName = game.white.toLowerCase();
  const blackName = game.black.toLowerCase();
  for (const c of candidates) {
    if (whiteName === c) return 'white';
    if (blackName === c) return 'black';
  }
  // Loose-substring fallback for display names with embedded
  // ratings or tags. Less precise than exact match but catches
  // import sources that decorate the username.
  for (const c of candidates) {
    if (whiteName.includes(c)) return 'white';
    if (blackName.includes(c)) return 'black';
  }
  return 'white';
}

function annotationFor(
  annotations: MoveAnnotation[] | null,
  moveNumber: number,
  color: 'white' | 'black',
): MoveAnnotation | null {
  if (!annotations) return null;
  return (
    annotations.find((a) => a.moveNumber === moveNumber && a.color === color) ?? null
  );
}

function adaptGameRecord(
  game: GameRecord,
  playerColor: 'white' | 'black',
): AdaptedReviewProps | null {
  const chess = new Chess();
  try {
    chess.loadPgn(game.pgn);
  } catch {
    return null;
  }
  const history = chess.history();
  if (history.length === 0) return null;

  // Re-walk to capture FEN after each ply.
  const replay = new Chess();
  const moves: CoachGameMove[] = [];
  let prevEval: number | null = null;
  for (let i = 0; i < history.length; i += 1) {
    const san = history[i];
    const moveResult = replay.move(san);
    if (!moveResult) break;
    const fullMove = Math.floor(i / 2) + 1;
    const color: 'white' | 'black' = i % 2 === 0 ? 'white' : 'black';
    const annot = annotationFor(game.annotations, fullMove, color);
    const evaluation = annot?.evaluation ?? null;
    const isCoachMove = color !== playerColor;
    // CoachGameMove.moveNumber is PLY-indexed (1=White's first ply,
    // 2=Black's response, …) so accuracyService and
    // getClassificationCounts can derive color via `moveNumber % 2 === 1`.
    // Confirmed by CoachGamePage.tsx:1620 where it uses moveCountRef
    // (incremented per ply) for the same field.
    moves.push({
      moveNumber: i + 1,
      san: moveResult.san,
      fen: replay.fen(),
      isCoachMove,
      commentary: annot?.comment ?? '',
      evaluation,
      classification: (annot?.classification as MoveClassification | null) ?? null,
      expanded: false,
      bestMove: annot?.bestMove ?? null,
      // Propagate the annotation's `bestMoveEval` (centipawns, White POV)
      // so the review's Missed Tactics + Missed Opportunities surfaces
      // can compute the swing the player conceded. Pre-fix annotations
      // are flagged for re-analysis by `gameNeedsAnalysis`, so by the
      // time we read here the field is reliably populated.
      bestMoveEval: annot?.bestMoveEval ?? null,
      preMoveEval: prevEval,
    });
    prevEval = evaluation;
  }

  const keyMoments: KeyMoment[] = (game.annotations ?? [])
    .filter(
      (a) =>
        a.classification === 'blunder' ||
        a.classification === 'brilliant' ||
        a.classification === 'mistake',
    )
    .slice(0, 8)
    .map((a) => {
      const idx = (a.moveNumber - 1) * 2 + (a.color === 'white' ? 0 : 1);
      const fen = moves[idx]?.fen ?? STARTING_FEN;
      return {
        moveNumber: a.moveNumber,
        fen,
        explanation: a.comment ?? '',
        type:
          a.classification === 'brilliant'
            ? ('brilliant' as const)
            : a.classification === 'blunder'
            ? ('blunder' as const)
            : ('turning_point' as const),
      };
    });

  return {
    moves,
    keyMoments,
    playerColor,
    result: game.result,
    openingName: game.eco ? game.eco : null,
    playerName: playerColor === 'white' ? game.white : game.black,
    playerRating: playerColor === 'white' ? game.whiteElo ?? 1500 : game.blackElo ?? 1500,
    opponentRating: playerColor === 'white' ? game.blackElo ?? 1500 : game.whiteElo ?? 1500,
    pgn: game.pgn,
  };
}

export function CoachReviewSessionPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  // Where to send the user when they tap Back. Callers (Weaknesses
  // tabs, Games drilldown, Coach Review list) pass `state.from` so
  // back routes to the page the user actually came from rather than
  // a hard-coded `/coach/review`. The optional `tab` rides along
  // for surfaces like GameInsightsPage that need to restore which
  // sub-tab was active. Falls back to the review list when no
  // state is present (e.g. deep-link / direct URL load).
  const navState = (location.state ?? null) as
    | { from?: string; tab?: string }
    | null;
  const backTarget = navState?.from ?? '/coach/review';
  const backState = navState?.tab ? { tab: navState.tab } : undefined;
  const { gameId } = useParams<{ gameId: string }>();
  // Deep-link support: `/coach/review/:gameId?move=N` jumps the
  // review to ply N on first paint. Used by Insights tab rows
  // (costliest-mistake / worst-miss / best-sequence) so tapping a
  // specific move lands the user at that exact ply instead of the
  // start of the game. `move` is a 1-indexed ply number — we
  // normalize to the 0-indexed `initialMoveIndex` contract that
  // CoachGameReview already accepts.
  const [searchParams] = useSearchParams();
  const moveParam = searchParams.get('move');
  const parsedMove = moveParam !== null ? Number(moveParam) : NaN;
  const initialMoveIndex = Number.isFinite(parsedMove) && parsedMove >= 1
    ? Math.floor(parsedMove) - 1
    : -1;
  const { activeProfile } = useAppStore();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!gameId) {
        setLoadError('No game id in URL.');
        return;
      }
      try {
        const rec = await db.games.get(gameId);
        if (cancelled) return;
        if (!rec) {
          setLoadError('That game is no longer in your library.');
          return;
        }
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'CoachReviewSessionPage.load',
          summary: `loaded game id=${rec.id} source=${rec.source} moves=${rec.annotations?.length ?? 0}`,
          details: JSON.stringify({ gameId, source: rec.source, fullyAnalyzed: rec.fullyAnalyzed }),
        });
        // Block rendering until analysis is complete so the user
        // never sees the partial "0% accuracy" intermediate state. For
        // pre-analyzed games (samples + previously-reviewed games)
        // gameNeedsAnalysis() returns false and we render
        // immediately. For fresh imports we silently run Stockfish,
        // then render — and the autoStartReview path fires the
        // walkthrough straight away on first paint.
        if (gameNeedsAnalysis(rec)) {
          setAnalyzing(true);
          try {
            await analyzeSingleGame(rec.id);
            if (cancelled) return;
            const refreshed = await db.games.get(rec.id);
            if (cancelled) return;
            setGame(refreshed ?? rec);
          } catch (err) {
            if (cancelled) return;
            void logAppAudit({
              // analyzeSingleGame is Stockfish-driven, not Lichess —
              // mis-categorised as lichess-error on this branch. Fixed
              // per audit item #28.
              kind: 'stockfish-error',
              category: 'subsystem',
              source: 'CoachReviewSessionPage.analyze',
              summary: `analyzeSingleGame failed: ${err instanceof Error ? err.message : String(err)}`,
              details: JSON.stringify({ gameId }),
            });
            setGame(rec);
          } finally {
            if (!cancelled) setAnalyzing(false);
          }
        } else {
          setGame(rec);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  const playerColor = useMemo(
    () => (game ? inferPlayerColor(game, {
      profileName: activeProfile?.name,
      chessComUsername: activeProfile?.preferences.chessComUsername,
      lichessUsername: activeProfile?.preferences.lichessUsername,
    }) : 'white'),
    [
      game,
      activeProfile?.name,
      activeProfile?.preferences.chessComUsername,
      activeProfile?.preferences.lichessUsername,
    ],
  );

  const adapted = useMemo(
    () => (game ? adaptGameRecord(game, playerColor) : null),
    [game, playerColor],
  );

  // Audit-driven: if game loaded from Dexie but adaptGameRecord
  // returned null (PGN unparseable, history empty), the page would
  // sit on "Loading game…" indefinitely. Surface a concrete error
  // with a "Back" CTA instead so the user can recover. Production
  // repro: sample-london-amateur-3 shipped with an illegal 8.Qxd3
  // that chess.js rejected — caught by audit-coach-review.mjs.
  useEffect(() => {
    if (!game || adapted || loadError || analyzing) return;
    void logAppAudit({
      kind: 'stockfish-error',
      category: 'subsystem',
      source: 'CoachReviewSessionPage.adapt',
      summary: `adaptGameRecord returned null for game ${game.id} — PGN unparseable or history empty`,
      details: JSON.stringify({ gameId: game.id, pgnLength: game.pgn.length }),
    });
    setLoadError(
      'We could not replay this game from its PGN. Pick a different game from the list, or import a fresh one.',
    );
  }, [game, adapted, loadError, analyzing]);

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center p-6 gap-3 flex-1">
        <p className="text-sm text-red-400">{loadError}</p>
        <button
          onClick={() => navigate('/coach/review')}
          className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-xs font-medium"
        >
          Back to game list
        </button>
      </div>
    );
  }

  if (!game || !adapted) {
    return (
      <div className="flex items-center justify-center p-6 flex-1 gap-2 text-theme-text-muted text-sm">
        <Loader2 size={16} className="animate-spin" />
        {analyzing ? 'Preparing your review…' : 'Loading game…'}
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0">
      {/* `autoStartReview` was previously passed here, forcing
          `reviewPhase` to initialize to `'analysis'`. That made
          sense in the old design where analysis was the dominant
          review surface. Today the walk phase IS the review
          experience (big yellow Next, interactive arrow, narrated
          per ply, key-moment nav). Auto-starting analysis (a) shows
          the wrong layout and (b) gates out the walk-phase prep
          effect entirely — the per-ply commentary segments never
          generate because the effect early-returns on
          `reviewPhase !== 'summary'`. Production audit on build
          088fe97 confirmed: zero coach-brain-ask-received entries on
          /coach/review/game-* loads. Removing the prop lets walk
          phase render and the prep scan fire on mount. */}
      <CoachGameReview
        // key forces a fresh mount when the user navigates
        // from /coach/review/A → /coach/review/B. Without it, walk
        // narration state, aiCommentaryCache, and other refs from
        // game A leak into game B until the prep effect overwrites
        // (and the cache stays game-A-keyed against game-B's move
        // indices). Audit-driven (Coach-tab full audit, item #9).
        // The move-param suffix forces a remount when the user taps
        // a different deep-linked ply on the same game (e.g. moving
        // from one costliest-mistake row to another) so
        // `initialMoveIndex` re-applies on mount.
        key={`${gameId}:${initialMoveIndex}`}
        // ship-5: forward gameId so `useReviewPlayback` can scope hint
        // callouts to this specific game (no cross-game leakage via
        // useCoachMemoryStore.hintRequests).
        gameId={gameId}
        moves={adapted.moves}
        keyMoments={adapted.keyMoments}
        playerColor={adapted.playerColor}
        result={adapted.result}
        openingName={adapted.openingName}
        playerName={adapted.playerName}
        playerRating={adapted.playerRating}
        opponentRating={adapted.opponentRating}
        onPlayAgain={() => navigate('/coach/play')}
        onBackToCoach={() => navigate(backTarget, { state: backState })}
        onPracticeInChat={(prompt) => {
          // Route to /coach/chat with the tactic prompt seeded as a
          // URL query param. CoachChatPage reads `?q=` and pre-fills
          // the chat input so the user lands on a populated draft
          // they can immediately send.
          void navigate(`/coach/chat?q=${encodeURIComponent(prompt)}`);
        }}
        pgn={adapted.pgn}
        initialMoveIndex={initialMoveIndex}
      />
    </div>
  );
}
