/**
 * appAuditor
 * ----------
 * Unified rolling-window audit log for the whole app. Captures four
 * classes of issue:
 *
 *   1. Narration factual errors (piece-on-square, check/mate, etc.) —
 *      emitted by `narrationAuditor.recordAudit()`.
 *   2. Uncaught runtime errors — global `window.onerror` / unhandled
 *      promise rejections. Installed by `installGlobalErrorHooks()` on
 *      app boot.
 *   3. Subsystem failures — TTS cascades, bad FENs, LLM errors,
 *      Stockfish timeouts, Lichess failures, Dexie writes. Logged
 *      explicitly by the owning service at the failure point.
 *   4. App state anomalies — React error boundary catches, navigation
 *      failures, FEN desyncs.
 *
 * Every entry lands in the same Dexie `meta` key under a rolling
 * window (`APP_AUDIT_LOG_MAX_ENTRIES`). The debug panel (Settings →
 * About → Narration audit) reads the whole log and exports it as a
 * markdown report via "Copy for Claude".
 *
 * Contract: every writer must be fire-and-forget.
 *   void logAppAudit({ ... });
 * The logger swallows its own errors — a failing audit write must
 * never break the feature path that raised it.
 */
import { db } from '../db/schema';

const APP_AUDIT_LOG_META_KEY = 'app-audit-log.v1';
const APP_AUDIT_LOG_MAX_ENTRIES = 300;

export type AuditCategory = 'narration' | 'runtime' | 'subsystem' | 'app';

export type AuditKind =
  // Narration (from narrationAuditor)
  | 'piece-on-square'
  | 'hanging-piece'
  | 'check-claim'
  | 'mate-claim'
  | 'illegal-san'
  | 'sanitizer-leak'
  // Runtime errors
  | 'uncaught-error'
  | 'unhandled-rejection'
  // Subsystem failures
  | 'tts-failure'
  | 'polly-fallback'
  | 'bad-fen'
  | 'stockfish-error'
  | 'llm-error'
  | 'lichess-error'
  | 'dexie-error'
  | 'network-error'
  // App state
  | 'error-boundary'
  | 'navigation-error'
  | 'fen-desync'
  // Voice instrumentation (WO-LEGACY-VOICE-01)
  | 'voice-speak-invoked'
  | 'voice-speak-silenced'
  // Walkthrough narration diagnostic — fires when getNarrationFor
  // returns empty so silent rapid-fire bugs can be triaged from the
  // audit log alone.
  | 'walkthrough-narration-empty'
  // Phase-transition narration trail (WO-PHASE-FIX-02)
  | 'phase-transition-detected'
  | 'phase-transition-suppressed'
  // Narration latency (WO-POLISH-03)
  | 'narration-latency'
  // Phase narration latency (WO-PHASE-LAG-01)
  | 'phase-narration-latency'
  // Walk-the-game review trail (WO-REVIEW-02)
  | 'review-opened'
  | 'review-narration-spoken'
  | 'review-nav'
  // Additional review trail (WO-REVIEW-02a)
  | 'review-segments-generated'
  | 'review-segments-parse-failed'
  // Walk-mode exploration (better-move arrow → student plays it →
  // "Resume game" snap-back). Fires when the student drags a piece
  // on the arrow-active board, and again when they tap Resume (or
  // navigate away → auto-resume).
  | 'review-walk-explored'
  | 'review-walk-resumed'
  // User explicitly tapped the big green "Start" button on the
  // review summary card to enter the walk-phase UI (replaces the
  // prior auto-enter-on-prep behavior).
  | 'review-walk-started'
  // "Show me" punishment-line playout on review screen — Stockfish
  // auto-plays 1-4 plies from seg.fenAfter so the student sees why
  // their move was a mistake/blunder. Silent v1, standard cadence.
  | 'review-show-me-started'
  | 'review-show-me-finished'
  // Engine lines on the review screen (WO-REVIEW-02b)
  | 'review-engine-lines-analysis-started'
  | 'review-engine-lines-analysis-complete'
  | 'review-engine-lines-toggled'
  | 'review-engine-candidate-explored'
  // Position-narration Stockfish cache (WO-PHASE-PROSE-01)
  | 'narration-stockfish-cache-hit'
  // Coach opening intent (WO-COACH-OPENING-INTENT-01)
  | 'coach-opening-intent-set'
  | 'coach-opening-intent-consulted'
  | 'coach-opening-intent-cleared'
  // Unified coach memory (WO-COACH-MEMORY-UNIFY-01). Mirrors the
  // coach-opening-intent-* kinds but fires from the new store actions;
  // the old kinds stay defined for backward compatibility with
  // historical audit logs.
  | 'coach-memory-intent-set'
  | 'coach-memory-intent-consulted'
  | 'coach-memory-intent-cleared'
  | 'coach-memory-position-saved'
  | 'coach-memory-position-cleared'
  | 'coach-memory-position-restored'
  | 'coach-voice-marker-extracted'
  // Progressive hint tiers (WO-HINT-REDESIGN-01)
  | 'coach-memory-hint-requested'
  | 'coach-memory-hint-recorded'
  // Live coach interjections (WO-LIVE-COACH-01)
  | 'coach-memory-conversation-appended'
  | 'live-coach-trigger-fired'
  | 'live-coach-trigger-suppressed'
  // Coach Brain spine (WO-BRAIN-01)
  | 'coach-brain-ask-received'
  | 'coach-brain-envelope-assembled'
  | 'coach-brain-provider-called'
  | 'coach-brain-tool-called'
  // Coach-tab full audit #19 — split for filterability. The
  // catch-all `coach-brain-tool-called` covers successful
  // dispatches; these two distinguish (a) tool requests the spine
  // didn't even attempt because the tool was excluded by the
  // resilience-fallback caller or didn't exist in the registry,
  // and (b) tool requests that THREW (vs returned ok=false; the
  // latter has tool-call-error already).
  | 'coach-brain-tool-skipped'
  | 'coach-brain-tool-threw'
  | 'coach-llm-model-selected'
  | 'coach-brain-intent-routed'
  | 'coach-intent-router-input'
  | 'coach-brain-tool-parse-result'
  | 'chat-panel-message-received'
  | 'coach-brain-answer-returned'
  // (WO-FOUNDATION-02 trace harness deleted — was emitting ~9 audits
  // per spine call, doubling audit log size with no production
  // value once the cerebrum-dispatch question was answered. Removed
  // per Coach-tab full audit item #30. Source-tagged audits like
  // coach-brain-* + coach-tool-callback-rejected cover the same
  // observability needs without the noise.)
  // Surface migration trail (WO-BRAIN-02 onwards). Fired once per call
  // from a surface that has been migrated to coachService.ask. Used in
  // production logs to confirm the migrated path is the one running.
  | 'coach-surface-migrated'
  // Coach-hub navigation (WO-COACH-UNIFY-01 audit item #15). Fires
  // when the user taps a tile on the Coach hub so a "I went to
  // Coach but ended up somewhere else" report has a trail.
  | 'coach-hub-tile-clicked'
  // GlobalCoachDrawer state transitions (WO-COACH-UNIFY-01 audit
  // item #16). Open / close / minimize / handoff-to-play are all
  // observable via this kind.
  | 'coach-drawer-state'
  | 'coach-drawer-handoff'
  // Tool callback rejections at the surface layer (WO-COACH-UNIFY-01
  // audit item #12). Distinguishes "spine rejected SAN" from
  // "surface rejected SAN" — the latter is what fires when the
  // SOVEREIGNTY check or chess.js refuses a move.
  | 'coach-tool-callback-rejected'
  // Walk-phase prep skipped (WO-COACH-UNIFY-01 audit item #26).
  // Distinguishes empty-segments / parse-failed / adapt-failed
  // from "still loading" so a "review never showed walk UI"
  // report has a concrete reason.
  | 'review-walk-skipped'
  // Biweekly chess.com / lichess auto-import scheduler.
  | 'auto-import-completed'
  | 'auto-import-failed'
  // Stockfish performance instrumentation (WO-STOCKFISH-SWAP-AND-PERF).
  | 'stockfish-cache-hit'
  | 'stockfish-cache-miss'
  | 'stockfish-prefetch-fired'
  // Stockfish multi-thread / single-thread variant resolution
  // (WO-STOCKFISH-SAB-FALLBACK).
  | 'stockfish-variant-resolved'
  // Stockfish runtime fallback — multi-thread bundle was selected
  // (capabilities present) but failed at runtime, so the engine
  // re-spawned the single-threaded bundle. Capped at one attempt
  // per session. (WO-STOCKFISH-RUNTIME-FALLBACK).
  | 'stockfish-variant-fallback'
  // Coach-turn resilience — three-tier fallback chain that ensures
  // the coach never hangs mid-game when Stockfish stalls or any
  // other tool dispatch hangs. (WO-COACH-RESILIENCE).
  // Level 1: primary 15 s ask timed out; retrying without
  // stockfish_eval (the most common stall vector when the engine is
  // hung).
  | 'coach-move-stockfish-bypassed'
  // Level 2: Level 1 also timed out; retrying with NO data tools
  // and a system addendum telling the brain to play from its own
  // chess knowledge.
  | 'coach-move-llm-fallback'
  // Level 3: Level 2 also timed out; picking a deterministic legal
  // move from chess.js so the game never freezes. Last-resort.
  | 'coach-move-emergency-pick'
  // WO-DEEP-DIAGNOSTICS — diagnostic-only kinds added so the next
  // production cycle's audit log can definitively answer "which build
  // was the user on?", "what is Lichess actually returning?", "did
  // the voice intent dispatch reach the surface callback?".
  // -------------------------------------------------------------
  // App-boot snapshot. Fired once on first mount with: buildId, PWA
  // standalone-mode flag, SW state, navigator.onLine, user-agent.
  | 'app-boot'
  // Periodic JS-heap pressure snapshot (every 30 s from App.tsx).
  // Lets a post-crash audit-log dump show memory ramp in the
  // seconds leading up to a tab kill, not just the silence right
  // before the renderer died.
  | 'memory-snapshot'
  // Lichess health probe. Fires from a Settings → debug button OR
  // when fetchLichessExplorer / fetchCloudEval throws — captures the
  // exact error shape (name, message, cause, navigator.onLine, the
  // attempted URL, and the headers actually sent).
  | 'lichess-health-probe-result'
  // Voice flow trace. One entry per stage so a "voice take-back
  // didn't take back" report has a complete causal chain.
  | 'voice-transcript-received'
  | 'voice-route-result'
  | 'voice-callback-invoked'
  | 'voice-callback-result'
  | 'voice-game-state-after'
  // WO-REAL-FIXES — phase narration deterministic fallback. Fires
  // when the LLM call times out / errors and we render a built-in
  // transition template instead of leaving the user with silence.
  | 'phase-narration-fallback-shown'
  // Opening-tour wiring (WO-COACH-TOUR-WIRING). One entry per quiz
  // lifecycle stage so a "the coach asked me to play Nf3 and then
  // ignored my move" report has a complete causal chain. Also fires
  // when the coach kicks off a walkthrough from the chat surface.
  | 'quiz-started'
  | 'quiz-resolved'
  | 'quiz-cancelled'
  | 'walkthrough-started-from-coach'
  // WO-COACH-PERSONALITIES (PR B). Fires when the user picks a new
  // personality OR adjusts a dial in Settings — joined with the
  // existing coach-brain-envelope-assembled audits so a "why does the
  // coach sound different in this build?" report can be answered
  // by walking the timeline.
  | 'coach-personality-changed'
  // WO-COACH-OPPONENT-FX. Fires every time the coach commits a move on
  // the board. Confirms the coach-move FX path (sound + last-move
  // highlight) ran — joined with the absence/presence of a matching
  // voice/sound event in the next audit window to diagnose which leg
  // of the FX is missing if the user reports silence.
  | 'coach-move-fx-emitted'
  // WO-COACH-MATE-FLOOR. Fires when the coach's mate-floor safety
  // check vetoed the LLM's pick because it walked into a forced mate
  // (≤ 2 plies). Override is the engine bestmove. Counting these in
  // production tells us how often the LLM picks losing moves — a
  // high rate means the prompt or rating-tier calibration needs work.
  | 'coach-move-mate-floor-triggered'
  // WO-COACH-RATING-FLOOR. Fires when the coach's quality-floor safety
  // check vetoed the LLM's pick because the centipawn loss vs the
  // engine's bestmove exceeded the student's rating-tier threshold.
  // Counting these tells us whether the cp-loss thresholds are tuned
  // correctly per tier (too many at intermediate = floor too tight;
  // too few at master = floor too loose).
  | 'coach-move-quality-floor-triggered'
  // WO-COACH-PERSONALITY-VOICE. One entry per Polly speak() call with
  // the resolved voice + active personality + dial settings. Captures
  // the cross-product of voice × personality × dials in production so
  // we can see which combinations users actually run (and whether any
  // pairing produces empirically bad output we should warn about).
  // Joins with the existing `voice-speak-invoked` audit on timestamp
  // for the full picture.
  | 'coach-narration-spoken'
  // WO-COACH-FX-DIAG. Diagnostic checkpoints inside the coach-turn
  // flow so the next audit log can pinpoint exactly where the FX
  // path breaks. Joined with the existing coach-move-fx-emitted
  // audit: if a checkpoint fires "reached applyCoachMove" but no
  // coach-move-fx-emitted follows, the bug is inside applyCoachMove
  // itself; if a "cancelled-at" checkpoint fires before the FX, the
  // coach-turn cleanup is firing too aggressively. Temporary —
  // remove once the FX-missing root cause is fixed and verified.
  | 'coach-turn-checkpoint'
  // Per-move narration audit (WO-MOVE-NARRATION-REENABLE). Fires from
  // CoachGamePage (blunder + non-blunder branches), narrateMove() in
  // coachAgentRunner, and CoachPlaySessionView whenever a move-level
  // speak is dispatched — and from the gating branch that skipped it
  // (verbosity 'off' / empty commentary / narrationMode disabled).
  // Joined with voice-speak-invoked so a "I have commentary on but
  // hear nothing after my move" report has a complete causal chain.
  | 'coach-move-narration-fired'
  | 'coach-move-narration-skipped'
  // Opening auto-detection trail (WO-CONVERSATIONAL-OPENING-COACH).
  // Fires once per move from CoachGamePage when detectOpening() runs
  // against the SAN history. Captures: detected eco/name/plyCount,
  // resolution source (URL subject vs committed intent vs auto-detect
  // vs nothing), and the resulting `inOpeningTeaching` decision. Use
  // these to debug "why didn't the coach name my opening?" reports —
  // either the detection trie missed the line (opening-auto-detected
  // absent) or teaching mode didn't activate (opening-teaching-active
  // absent).
  | 'coach-opening-auto-detected'
  | 'coach-opening-teaching-active'
  // Diagnostic audits added to identify root causes for user-reported
  // bugs WITHOUT guessing the fix. Each one captures the inputs that
  // would otherwise require speculation. Once the audit log shows the
  // failure mode for each, the next PR can fix from evidence.
  // -----------------------------------------------------------------
  // Review playback step trail. Fires from useReviewPlayback.commitPly
  // every time the ply changes — captures from-ply, to-ply, nav source
  // (goForward / goBack / goToStart / goToEnd / jumpToPly), the SAN at
  // the destination, and whether speech was requested. Diagnoses
  // "review skips two pieces" reports: if `to - from > 1` from a
  // goForward call, the bug is concrete.
  | 'review-playback-step'
  // Engine-lines layout state. Fires from CoachGameReview when the
  // engine-lines panel is toggled — captures viewport orientation,
  // viewport width/height, board container width before/after the
  // toggle. Diagnoses "showing lines shrinks the board" reports by
  // making the dimension diff measurable instead of subjective.
  | 'engine-lines-layout-state'
  // Verbosity resolution trail. Fires inside coachMoveCommentary when
  // the LLM call is dispatched — captures what verbosity value was
  // received vs the user's profile preference. Diagnoses "Settings
  // verbosity dial doesn't work" reports by making the propagation
  // path visible (settings → preference → arg → LLM).
  | 'verbosity-resolved'
  // TTS overlap detection. Fires from voiceService.speakInternal when
  // a new speak() arrives while a previous utterance is still playing.
  // Captures the new utterance preview, the previous-tier (polly /
  // web-speech / voice-pack), and the caller source if available.
  // Diagnoses "two voices at once" reports — every overlap leaves a
  // record so we can see which surfaces are racing.
  | 'tts-concurrent-speak'
  // Tool-call error capture. Fires from coach/coachService.ask when a
  // tool invocation returns an error — captures tool name + full error
  // text + arguments. Diagnoses tool dispatch issues like the
  // "aiColor must be 'white' or 'black'" we saw on local_opening_book
  // by surfacing the exact arg that failed.
  | 'tool-call-error'
  // Move-commentary skip reasons. Fires from every early-return in
  // generateMoveCommentary so the previously-silent paths
  // (`offline`, `verbosity===none`, empty history, ⚠️ banner, LLM
  // exception, empty-after-trim) leave a record. Evidence-driven —
  // saves a debug round-trip the next time `coach-move-narration-skipped
  // reason=empty-commentary` shows up: the new audit names exactly
  // which path returned empty. Joins with the existing
  // `coach-move-narration-skipped` on timestamp + fen.
  | 'commentary-skipped'
  // LLM response trail (move commentary). Fires inside
  // coachMoveCommentary.getLlmCommentary right after
  // getCoachChatResponse returns. Captures length, preview, latency,
  // and the personality+dial values that were sent in the prompt.
  // Closes the observability gap between `verbosity-resolved` (LLM
  // dispatched) and `commentary-skipped` (we returned empty) — if
  // the LLM is returning short / generic / non-personality output
  // despite the dials being set, this audit shows it directly
  // instead of forcing inference from "voice was bland."
  | 'llm-response'
  // Personality dials reaching the move-commentary prompt
  // (WO-PERSONALITY-IN-COMMENTARY). Mirrors coach-narration-spoken at
  // the prompt-assembly side so we can confirm in production logs that
  // profanity=hard / mockery=hard actually flowed into the LLM call —
  // not just into the TTS layer.
  | 'coach-move-personality-applied'
  // WO-PLAN-B coach-move fast path. Fires when the coach-turn skips
  // the LLM spine entirely and uses opening book / Stockfish bestmove
  // directly. Replaces 8s of multi-trip LLM tool dance with ~250ms of
  // deterministic move selection. Spine still runs as fallback if the
  // fast path can't produce a legal move.
  | 'coach-move-fastpath'
  // Coach FX cancellation race — fires when the coach-turn effect was
  // aborted (game.fen changed, useEffect re-fired) AFTER chess.js was
  // already mutated. We commit the FX path anyway to keep
  // gameState.moves in sync with the chess instance and to ensure the
  // last-move highlight, sound, narration, and move-list entry land
  // on the coach's move.
  | 'coach-move-fx-cancellation-ignored'
  // WO-NARR-POLICY-01 — proactive tactic alert spoken after the coach
  // sets up a threat on the board. Stockfish-driven (no LLM round-trip),
  // fires under verbosity in {'key-moments', 'every-move'}.
  | 'coach-tactic-alert-spoken'
  // Phase 5 visual-signature audits. Captured so a "this UI feels broken"
  // report has a concrete trail of what the user saw.
  // ---
  // route-changed: fires on every URL change. Lets a session reconstruct
  // navigation flow from the audit log alone (e.g., "user clicked the
  // Coach tab and ended up at /weaknesses" — was it a NavLink that
  // routed wrong, or a programmatic redirect?).
  | 'route-changed'
  // scroll-hint-state: fires when the gold-bar comet activates or
  // deactivates (overflow-detected, scroll-discovered, end-reached).
  // Diagnoses "the gold bar isn't moving" reports.
  | 'scroll-hint-state'
  // asset-load-error: fires when a piece sprite or other static asset
  // fails to load. Hooked into ConsistentChessboard's overlay path so
  // the Phase 1.3 bishop-sprite report has a Network-tab-like trail
  // even from a non-DevTools session.
  | 'asset-load-error'
  // /weaknesses (Game Insights) observability trail. The surface was
  // observability-blind before this audit — zero audit hooks meant
  // the audit stream couldn't see when the student refreshed the
  // report, kicked off background analysis, or routed a search
  // query. Each of these now fires a distinct kind so a "I tapped
  // analyze and nothing happened" report has a record.
  | 'weakness-report-refresh'
  | 'weakness-report-analyze-kickoff'
  | 'weakness-report-search-routed'
  | 'weakness-report-search-fallback'
  // ─── Tactics tab (TACTICS_SHOULD_WORK.md) ────────────────────────────
  // Mirrors the F1 fix from PR #504 (zero `logAppAudit` calls in
  // /weaknesses) — same disease applied across all 11 tactics
  // surfaces. The audit-stream live-watch couldn't see any tactics
  // interactions before this. One generic kind covers every surface
  // and step; the `source` field carries the specific surface +
  // action so downstream consumers can slice.
  | 'tactics-surface-event'
  // ─── Analytics backbone (ANALYTICS_AUDIT.md, Tier 1-3) ───────────────
  // The audit log already captures forensic events; these kinds carry
  // the *analytic* signal a coach brain or weakness/strength report
  // needs. Each is fire-and-forget on the user's interaction path.
  //
  // Tier 1 — confessed weakness signals.
  // `move-attempt`: emitted on EVERY move input across puzzle,
  //   walkthrough, endgame playout, and coach-play surfaces. Carries
  //   { surface, fen, attemptedSan, correctSan?, isCorrect,
  //     moveMethod: 'drag'|'click', timeFromPositionEnterMs,
  //     sourceId? (puzzleId/lessonId/gameId), tacticType?, phase? }.
  //   Drives moveAttemptsPerPuzzle, decision-reversal joins, hint
  //   effectiveness joins.
  | 'move-attempt'
  // `hint-revealed`: extended hint-system audit superseding the older
  //   `coach-memory-hint-{requested,recorded}` (kept for compat).
  //   Carries { source, surface, reason: 'student-tap'|'auto-reveal'|
  //   'coach-initiative', tier: 0|1|2|3, timeToRevealMs, fen,
  //   tacticType?, phase?, openingEco? }. Effectiveness joined at
  //   query time with the next move-attempt on the same FEN.
  | 'hint-revealed'
  // `position-dwell`: time spent on a position before leaving it
  //   (moved away, navigated, session-end). Cheap timer pattern —
  //   emit on exit, not entry. Carries { surface, fen, dwellMs,
  //   exitReason: 'moved'|'navigated'|'session-end' }.
  | 'position-dwell'
  // Tier 2 — high-volume engagement.
  // `engine-lines-dwell`: emitted when the engine-lines panel closes,
  //   with the duration it was open. Joins with the existing
  //   `review-engine-lines-toggled` for open-event metadata.
  | 'engine-lines-dwell'
  // `insights-tab-switched`: emitted on /weaknesses tab swap. The
  //   global `route-changed` audit doesn't see in-page tab state.
  | 'insights-tab-switched'
  // `endgame-playout-attempt`: emitted per attempt inside an endgame
  //   playout. Replaces the rollup-only `endgameProgress.totalWrongAttempts`
  //   with a per-attempt trail. Carries { lessonId, attemptedSan,
  //   isCorrect, attemptIndex, fen }.
  | 'endgame-playout-attempt'
  // Tier 3 — narration interaction.
  // `narration-replay`: student tapped replay on the last narration block.
  | 'narration-replay'
  // `narration-muted` / `narration-unmuted`: voice toggle audit.
  | 'narration-muted'
  | 'narration-unmuted'
  // Tier 4 — session shape.
  // `session-shape`: emitted on session end with surfaces visited +
  //   time per surface + dominant phase. Companion to db.sessions which
  //   is currently orphaned (write-only).
  | 'session-shape'
  // Tier 5 — second-pass additions (post-review).
  // `move-reversed`: drag-and-drop reversal — piece picked up, legal-move
  //   dots shown, piece returned without playing. The hesitation IS the
  //   signal. Carries { surface, fen, pickedUpSquare }.
  | 'move-reversed'
  // `puzzle-skipped`: skip button engaged. Different from wrong — an
  //   engagement weakness, not a skill weakness.
  | 'puzzle-skipped'
  // `repeat-mistake`: emitted when a previously-recorded mistake puzzle
  //   is attempted AGAIN and the student plays the SAME wrong move.
  //   Highest-signal weakness row — "you make the same mistake twice."
  | 'repeat-mistake'
  // `lesson-started` / `lesson-completed` / `lesson-abandoned`: per-
  //   walkthrough lifecycle. Abandon = exit before the final step.
  | 'lesson-started'
  | 'lesson-completed'
  | 'lesson-abandoned'
  // `coach-question-topic`: best-effort topic classification on
  //   `coach-brain-ask-received`. Captures what the student asks about
  //   — their questions reveal their gaps better than their moves.
  | 'coach-question-topic'
  // `analytics-self-audit`: emitted by the in-app AnalyticsAuditPanel
  //   when the user opens the coverage view. Lets the audit stream see
  //   that David is actively inspecting the analytic surface.
  | 'analytics-self-audit';

export interface AuditEntry {
  timestamp: number;
  kind: AuditKind;
  category: AuditCategory;
  /** One-line summary — what went wrong. */
  summary: string;
  /** Origin file or subsystem label for triage. */
  source: string;
  /** Longer details (stack trace, FEN dump, raw response, etc.). */
  details?: string;
  /** Current FEN when relevant (narration / position / stockfish). */
  fen?: string;
  /** Extra free-form context from the caller. */
  context?: string;
  /** Route at capture time, for repro. */
  route?: string;
  /** WO-DEEP-DIAGNOSTICS — auto-stamped by logAppAudit. The build
   *  this entry was generated under (`<git-sha>+<unix-ms>`).
   *  Production reports answer "which build was the user on?" by
   *  reading this field instead of guessing from timestamps. */
  buildId?: string;
}

/** Build identifier injected at vite-build time. Falls back to
 *  'unknown' in test / SSR contexts where the define isn't applied.
 *  Exported so the BuildVersionWidget (and any debug surface) can
 *  display the running bundle hash without rummaging in audit rows. */
export function getBuildId(): string {
  try {
     
    return typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Serializing chain for read-modify-write. Each logAppAudit call
 *  attaches its work to the chain so two concurrent calls can never
 *  interleave the read+push+put steps. Without this serialization,
 *  fire-and-forget writes (`void logAppAudit(...)`) raced and only
 *  the last writer's entry survived — the production audit log was
 *  silently losing every audit that fired alongside another (e.g.
 *  `coach-move-narration-fired` was always overwritten by the
 *  `voice-speak-invoked` audit emitted microseconds later from
 *  voiceService.speakInternal). Verified by appAuditor.test.ts —
 *  20 concurrent calls now persist all 20 entries; pre-fix only 1
 *  survived. Fire-and-forget callers continue to work unchanged. */
let auditWriteChain: Promise<void> = Promise.resolve();

/** Log one entry. Fire-and-forget. Also streams the entry to
 *  `/api/audit-stream` when the user has opted in by setting
 *  `auditStreamUrl` + `auditStreamSecret` in localStorage. Stream
 *  failures are silent; the local Dexie log is still written. */
export async function logAppAudit(
  entry: Omit<AuditEntry, 'timestamp' | 'route' | 'buildId'>,
): Promise<void> {
  const filled: AuditEntry = {
    ...entry,
    timestamp: Date.now(),
    route: typeof window !== 'undefined' ? window.location?.pathname : undefined,
    buildId: getBuildId(),
  };
  const next = auditWriteChain.then(async () => {
    try {
      const current = await readLog();
      current.push(filled);
      const trimmed = current.slice(-APP_AUDIT_LOG_MAX_ENTRIES);
      await db.meta.put({
        key: APP_AUDIT_LOG_META_KEY,
        value: JSON.stringify(trimmed),
      });
    } catch {
      /* swallow — auditor failures must not affect the feature path */
    }
  });
  // Re-assign so the next caller chains onto the latest. Swallow the
  // chain's own errors here so a single failed write doesn't poison
  // every subsequent audit.
  auditWriteChain = next.catch(() => undefined);
  await next;
  // Opt-in remote stream — used for live-watch sessions where Claude
  // polls the backend for new entries. Off by default.
  void streamAuditEntry(filled);
}

// ─── Audit-stream config (Dexie-backed, was localStorage) ────────────
//
// CLAUDE.md "Do NOT — Use localStorage for anything (use Dexie)" rule.
// The audit-stream URL + secret moved from localStorage to
// `profile.preferences.auditStreamUrl` / `auditStreamSecret`. To keep
// `streamAuditEntry` cheap on the hot path (it runs on every
// `logAppAudit` call), we cache the values in a module-level variable.
// `NarrationAuditPanel` writes via `setAuditStreamConfig` which updates
// both Dexie AND the cache atomically; `App.init()` hydrates the cache
// once at boot via `loadAuditStreamConfig()`. Until that resolves,
// `streamAuditEntry` is a no-op — same effective behavior as
// "localStorage was empty," which is the default state.

interface AuditStreamConfig {
  url: string;
  secret: string;
}

let cachedStreamConfig: AuditStreamConfig | null = null;
let streamConfigHydrated = false;

/** Read the config from Dexie + populate the in-memory cache. Also
 *  performs a one-time migration of any existing `localStorage`
 *  values from the pre-Dexie era — if both keys are present in
 *  localStorage AND the Dexie profile has no values yet, copy them
 *  over and clear the localStorage entries. Idempotent: re-runs on
 *  boot are safe. */
export async function loadAuditStreamConfig(): Promise<AuditStreamConfig | null> {
  try {
    const profile = await db.profiles.get('main');
    let url = profile?.preferences.auditStreamUrl ?? null;
    let secret = profile?.preferences.auditStreamSecret ?? null;

    // One-time migration from localStorage. The old code stashed the
    // values under bare keys; copy them across, clear the originals,
    // never touch localStorage again.
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const legacyUrl = localStorage.getItem('auditStreamUrl');
      const legacySecret = localStorage.getItem('auditStreamSecret');
      if (legacyUrl || legacySecret) {
        if (!url && legacyUrl) url = legacyUrl;
        if (!secret && legacySecret) secret = legacySecret;
        if (profile && (legacyUrl || legacySecret)) {
          try {
            profile.preferences.auditStreamUrl = url;
            profile.preferences.auditStreamSecret = secret;
            await db.profiles.put(profile);
          } catch {
            /* swallow — migration failure must not affect boot */
          }
        }
        try {
          localStorage.removeItem('auditStreamUrl');
          localStorage.removeItem('auditStreamSecret');
        } catch {
          /* swallow — localStorage may throw in private browsing */
        }
      }
    }

    streamConfigHydrated = true;
    cachedStreamConfig = url && secret ? { url, secret } : null;
    flushPreHydrationQueue();
    return cachedStreamConfig;
  } catch {
    streamConfigHydrated = true;
    cachedStreamConfig = null;
    // Even with no config the boot-window audits still need to be
    // dropped (not held forever), so flush the queue — the flush
    // routine itself short-circuits on null cfg.
    flushPreHydrationQueue();
    return null;
  }
}

/** Update both Dexie + the in-memory cache. The only writer is the
 *  NarrationAuditPanel; we expose this rather than letting the panel
 *  reach into the cache directly. */
export async function setAuditStreamConfig(url: string, secret: string): Promise<void> {
  cachedStreamConfig = url && secret ? { url, secret } : null;
  streamConfigHydrated = true;
  // Late config-set after boot also triggers a flush in case any
  // audits queued before this point (rare but possible).
  flushPreHydrationQueue();
  try {
    const profile = await db.profiles.get('main');
    if (!profile) return;
    profile.preferences.auditStreamUrl = url || null;
    profile.preferences.auditStreamSecret = secret || null;
    await db.profiles.put(profile);
  } catch {
    /* swallow — config write failures must not affect the panel */
  }
}

/** Clear the audit-stream config from both Dexie + the in-memory cache. */
export async function clearAuditStreamConfig(): Promise<void> {
  cachedStreamConfig = null;
  streamConfigHydrated = true;
  try {
    const profile = await db.profiles.get('main');
    if (!profile) return;
    profile.preferences.auditStreamUrl = null;
    profile.preferences.auditStreamSecret = null;
    await db.profiles.put(profile);
  } catch {
    /* swallow */
  }
}

/** Synchronous read of the cached config. Used by `streamAuditEntry`
 *  on the hot audit-log path. Returns null until `loadAuditStreamConfig`
 *  has resolved at least once (same as the legacy "localStorage was
 *  empty" state — streaming is opt-in and best-effort). */
export function getAuditStreamConfig(): AuditStreamConfig | null {
  return cachedStreamConfig;
}

/** Whether the cache has been hydrated from Dexie at least once.
 *  Exposed for tests; production callers shouldn't need to gate on
 *  this. */
export function isAuditStreamConfigHydrated(): boolean {
  return streamConfigHydrated;
}

/** Pre-hydration replay queue. Audits emitted before
 *  `loadAuditStreamConfig()` finishes hydrating `cachedStreamConfig`
 *  used to be dropped silently — that meant every audit fired during
 *  the boot window (the first ~5–10s of TacticsPage mount, route
 *  changes, etc.) was invisible to the audit-stream live-watch.
 *  Surfaced by the tactics audit run: scenarios 02-hub-render and
 *  03-hub-search-typing showed 0 captured events while later
 *  scenarios all worked. Queue up to N pre-hydration emits and
 *  flush them once the config lands.
 */
const PREHYDRATE_QUEUE_LIMIT = 100;
const preHydrationQueue: AuditEntry[] = [];

async function streamAuditEntry(entry: AuditEntry): Promise<void> {
  if (typeof window === 'undefined') return;
  const cfg = cachedStreamConfig;
  if (!cfg) {
    // Boot window: hydration hasn't completed yet. Queue for replay
    // unless we've already hit the cap (defends against an
    // unbounded backlog when audit-stream is opt-out for this
    // session).
    if (!streamConfigHydrated && preHydrationQueue.length < PREHYDRATE_QUEUE_LIMIT) {
      preHydrationQueue.push(entry);
    }
    return;
  }
  try {
    await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-audit-secret': cfg.secret,
      },
      body: JSON.stringify(entry),
      // Best-effort: don't block on slow networks.
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* silent — the local Dexie log is still the source of truth */
  }
}

/** Flush any audits queued during the boot window. Called from
 *  `loadAuditStreamConfig` (and `setAuditStreamConfig`) once the
 *  in-memory cache lands. Idempotent. */
function flushPreHydrationQueue(): void {
  if (preHydrationQueue.length === 0) return;
  const drained = preHydrationQueue.splice(0, preHydrationQueue.length);
  for (const entry of drained) {
    void streamAuditEntry(entry);
  }
}

/** Read the full log, newest-last ordering preserved. */
export async function getAppAuditLog(): Promise<AuditEntry[]> {
  return readLog();
}

/** Clear the log. */
export async function clearAppAuditLog(): Promise<void> {
  try {
    await db.meta.delete(APP_AUDIT_LOG_META_KEY);
  } catch {
    /* no-op */
  }
}

async function readLog(): Promise<AuditEntry[]> {
  try {
    const record = await db.meta.get(APP_AUDIT_LOG_META_KEY);
    if (!record) return [];
    // Legacy (pre-stringify) may have an array directly; accept defensively.
    if (Array.isArray(record.value)) return record.value as AuditEntry[];
    if (typeof record.value !== 'string') return [];
    const parsed: unknown = JSON.parse(record.value);
    return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Register a console back-door on `window.__AUDIT__` so the log is
 * reachable from DevTools even when the Settings UI isn't:
 *
 *   await __AUDIT__.dump()       // full entries
 *   await __AUDIT__.copy()       // copies the markdown report to clipboard
 *   await __AUDIT__.clear()      // empty the log
 *   __AUDIT__.count()            // last-read count (updated on dump/copy)
 *
 * Idempotent. Safe to call multiple times. Installed on app boot.
 */
export function installConsoleBackdoor(): void {
  if (typeof window === 'undefined') return;
  const api = {
    dump: async (): Promise<AuditEntry[]> => {
      const log = await getAppAuditLog();
      (api as unknown as { count: () => number }).count = () => log.length;
       
      console.log('[appAuditor] dump:', log.length, 'entries', log);
      return log;
    },
    copy: async (): Promise<void> => {
      const log = await getAppAuditLog();
      const md = formatAuditLogAsMarkdown(log);
      try {
        await navigator.clipboard.writeText(md);
         
        console.log('[appAuditor] copied', log.length, 'entries to clipboard');
      } catch (err) {
         
        console.warn('[appAuditor] clipboard write failed:', err);
         
        console.log(md);
      }
    },
    clear: async (): Promise<void> => {
      await clearAppAuditLog();
       
      console.log('[appAuditor] cleared');
    },
    count: () => -1,
  };
  (window as unknown as { __AUDIT__: typeof api }).__AUDIT__ = api;
}

/** Minimal markdown serializer for the back-door `__AUDIT__.copy()`
 *  helper. Mirrors the UI panel's `formatLogAsMarkdown` without
 *  pulling the panel component into this service. */
function formatAuditLogAsMarkdown(log: AuditEntry[]): string {
  if (log.length === 0) return '# App audit log\n\n_No findings._\n';
  const blocks = [...log].reverse().map((entry, i) => {
    const ts = new Date(entry.timestamp).toISOString();
    return [
      `### Finding ${i + 1} — [${entry.category}/${entry.kind}]`,
      `- timestamp: \`${ts}\``,
      `- source: \`${entry.source}\``,
      entry.buildId ? `- build: \`${entry.buildId}\`` : '',
      entry.route ? `- route: \`${entry.route}\`` : '',
      entry.fen ? `- FEN: \`${entry.fen}\`` : '',
      entry.context ? `- context: \`${entry.context}\`` : '',
      ``,
      `**${entry.summary}**`,
      entry.details ? '\n```\n' + entry.details + '\n```' : '',
    ].filter(Boolean).join('\n');
  });
  return ['# App audit log', '', `Total: **${log.length}** entries.`, '', '## Findings', '', blocks.join('\n\n')].join('\n');
}

/**
 * Install global error hooks on app boot. Returns a cleanup function
 * that detaches them — the production app never cleans up, but tests
 * need teardown to avoid cross-test pollution.
 *
 * Hooks are idempotent: calling twice is safe (replaces prior handlers).
 */
export function installGlobalErrorHooks(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  // Per-source rate limiter. When the same error message repeats from
  // the same source within ERROR_BURST_WINDOW_MS, only the first one
  // is fully logged + a single "burst" summary at the end. Without
  // this, an error-loop (Stockfish-wasm OOM caught 895k pageerrors in
  // a single audit run on 2026-05-14, AUDIT_HANDOFF.md §"Open prod
  // bug") would write a million Dexie rows + audit-stream POSTs in
  // seconds, blocking the main thread.
  const ERROR_BURST_WINDOW_MS = 5_000;
  const MAX_EVENTS_PER_BURST = 5; // first 5 verbatim, then coalesce
  type BurstState = { firstAt: number; count: number; lastLoggedAt: number };
  const bursts = new Map<string, BurstState>();

  const burstKey = (kind: string, summary: string): string => `${kind}::${summary.slice(0, 120)}`;

  function emitWithRateLimit(payload: {
    kind: AuditEntry['kind'];
    category: AuditEntry['category'];
    source: string;
    summary: string;
    details?: string;
  }): void {
    const now = Date.now();
    const key = burstKey(payload.kind, payload.summary);
    const state = bursts.get(key);
    if (!state || now - state.firstAt > ERROR_BURST_WINDOW_MS) {
      // Fresh burst window — log + reset counter.
      bursts.set(key, { firstAt: now, count: 1, lastLoggedAt: now });
      void logAppAudit(payload);
      return;
    }
    state.count += 1;
    // Within burst: log the first MAX_EVENTS_PER_BURST verbatim, then
    // suppress until the window closes. When it closes, emit ONE
    // coalesced summary so we don't lose the signal entirely.
    if (state.count <= MAX_EVENTS_PER_BURST) {
      state.lastLoggedAt = now;
      void logAppAudit(payload);
    } else if (state.count === MAX_EVENTS_PER_BURST + 1) {
      // First time we suppress in this burst — schedule the coalesced
      // summary for when the window closes. setTimeout is scheduled
      // ONCE per burst (because state.count crosses the threshold
      // exactly once).
      const burstStart = state.firstAt;
      setTimeout(() => {
        const final = bursts.get(key);
        if (!final || final.firstAt !== burstStart) return;
        const suppressed = final.count - MAX_EVENTS_PER_BURST;
        bursts.delete(key);
        if (suppressed <= 0) return;
        void logAppAudit({
          ...payload,
          summary: `${payload.summary} (×${final.count}, burst-coalesced)`,
          details: `${suppressed} additional ${payload.kind} events suppressed within ${ERROR_BURST_WINDOW_MS}ms window. ${payload.details ? `\n${payload.details}` : ''}`.trim(),
        });
      }, ERROR_BURST_WINDOW_MS - (now - state.firstAt));
    }
    // Else: silently drop — the coalesced summary is already scheduled.
  }

  const onError = (event: ErrorEvent): void => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    emitWithRateLimit({
      kind: 'uncaught-error',
      category: 'runtime',
      source: event.filename ?? 'window.onerror',
      summary: message || 'Unknown error',
      details: [
        stack,
        event.filename ? `file: ${event.filename}:${event.lineno}:${event.colno}` : '',
      ].filter(Boolean).join('\n'),
    });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as unknown;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    emitWithRateLimit({
      kind: 'unhandled-rejection',
      category: 'runtime',
      source: 'window.onunhandledrejection',
      summary: message || 'Unhandled promise rejection',
      details: stack,
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    bursts.clear();
  };
}
