# Analytics audit — what the app tracks and how it's used

Living document. Last updated 2026-05-14.

David's framing: "this app needs to track as much user playing
data as possible. it is the analytic backbone that innervates the
brain. include analytic audit to see what data is tracked and
how it is used."

This file is BOTH the static structural record AND the spec for
the in-app `AnalyticsAuditPanel` (Settings → Diagnostics) that
makes the same view live-verifiable.

---

## TL;DR

- **The backbone already exists.** `src/services/appAuditor.ts`
  runs a structured audit log: 100+ named `AuditKind`s, in-memory
  + Dexie-meta persistence (`app-audit-log.v1`, 300-entry cap),
  optional streaming to `/api/audit-stream`, global error hooks,
  console backdoor `__AUDIT__`. Every emit goes through
  `logAppAudit(...)`.
- **What's missing is coverage and a query layer.** The audit
  log is a forensic stream, not a metrics pipe. To "innervate the
  brain" we need (a) more emit sites on the moments the coach
  actually cares about (hint reasoning, dwell, attempts) and (b)
  a typed query layer so consumers can ask
  `hintsRequestedInLast(7d)` instead of `getAppAuditLog().filter(...)`.
- **One persistence table is orphaned.** `db.sessions` is written
  by `sessionGenerator.ts:69` and never read by any surface or
  service. Either delete or wire it up.

## How to read this document

Each section maps **surface → captured data → who consumes it →
gap**. "Consumer" matters — capture without consumption is
audit-stream-only forensics, not analytics. Gap rows drive the
build plan in the last section.

---

## 1) Persistence inventory

19 Dexie tables. The interesting ones for analytics:

| Table | Writes | Reads | Status |
|---|---|---|---|
| `db.games` | imports, finished coach play | CoachGamePage, CoachReviewSessionPage, gameReviewService, gameInsightsService | live |
| `db.mistakePuzzles` | `tacticalProfileService`, post-import classify | MistakesTab, FromYourGamesTab, weakness report | live |
| `db.endgameProgress` | endgame playout hooks | FromYourGamesTab, CoachEndgamePage | live (but trail-less — only `mastered` boolean + `totalWrongAttempts` counter) |
| `db.classifiedTactics` | game analysis | TacticsTab, drill surfaces | live |
| `db.openingWeakSpots` | teach tracker | teach surfaces, weakness analysis | live |
| `db.openings`, `db.flashcards`, `db.cachedOpenings`, `db.modelGames`, `db.middlegamePlans`, `db.generatedContent`, `db.openingNarrations`, `db.setupPuzzles`, `db.puzzles` | various | various | live |
| `db.profiles` | App boot + Settings | every surface | live |
| `db.meta` | `appAuditor` (audit log persistence), config | audit panel, console backdoor | live |
| **`db.sessions`** | `sessionGenerator.ts:69` per session end | **NOTHING** | **DEAD CAPTURE** — collects durationMinutes, xpEarned, coachSummary, but no consumer queries it. |

**Action:** Either wire `db.sessions` into the dashboard / coach
context, or delete the writer. Recommend wiring — session-shape
data is exactly the cross-surface signal the brain needs.

---

## 2) `AuditKind` taxonomy (existing)

Grouped by category. Counts are emit-site files, rounded.

| Category | Kinds | Emit-site files |
|---|---|---|
| `narration` | `piece-on-square`, `hanging-piece`, `check-claim`, `mate-claim`, `illegal-san`, `sanitizer-leak` | ~5 |
| `runtime` | `uncaught-error`, `unhandled-rejection` | global hooks |
| `subsystem · coach-spine` | `coach-brain-{ask-received, envelope-assembled, provider-called, tool-called, tool-skipped, tool-threw, intent-routed, answer-returned}`, `coach-intent-router-input`, `coach-brain-tool-parse-result`, `coach-llm-model-selected`, `coach-surface-migrated` | well-covered |
| `subsystem · coach-move` | `coach-move-{fastpath, llm-fallback, emergency-pick, stockfish-bypassed, fx-emitted, fx-cancellation-ignored, mate-floor-triggered, quality-floor-triggered}` | well-covered |
| `subsystem · coach-narration` | `coach-move-narration-{fired, skipped}`, `coach-narration-spoken`, `coach-move-personality-applied` | well-covered |
| `subsystem · voice/tts` | `voice-speak-{invoked, silenced}`, `voice-transcript-received`, `voice-route-result`, `voice-callback-{invoked, result, game-state-after}`, `tts-failure`, `tts-concurrent-speak`, `polly-fallback` | well-covered |
| `subsystem · review/walkthrough` | `review-{opened, narration-spoken, nav, segments-generated, segments-parse-failed, walk-explored, walk-resumed, walk-skipped, playback-step}`, `review-engine-lines-{toggled, analysis-started, analysis-complete, candidate-explored}` | well-covered |
| `subsystem · stockfish` | `stockfish-{cache-hit, cache-miss, prefetch-fired, variant-resolved, variant-fallback, error}` | well-covered |
| `subsystem · opening/intent` | `coach-opening-{intent-set, consulted, cleared, auto-detected, teaching-active}`, `coach-memory-intent-{set, consulted, cleared}` | well-covered |
| `subsystem · hint (CURRENT)` | `coach-memory-hint-requested`, `coach-memory-hint-recorded` | **THIN — no reason, no latency, no effectiveness** |
| `subsystem · phase` | `phase-transition-{detected, suppressed}`, `phase-narration-{latency, fallback-shown}`, `narration-latency` | well-covered |
| `subsystem · weakness` | `weakness-report-{refresh, analyze-kickoff, search-routed, search-fallback}` | live, GameInsightsPage only |
| `subsystem · misc` | `bad-fen`, `llm-{error, response}`, `dexie-error`, `lichess-{error, health-probe-result}`, `network-error`, `auto-import-{completed, failed}`, `tool-call-error`, `commentary-skipped`, `verbosity-resolved`, `live-coach-trigger-{fired, suppressed}`, `coach-{drawer-state, drawer-handoff, hub-tile-clicked, tool-callback-rejected}`, `walkthrough-narration-empty`, `narration-stockfish-cache-hit`, `asset-load-error` | various |
| `app` | `app-boot`, `memory-snapshot` (~30s), `route-changed`, `scroll-hint-state`, `engine-lines-layout-state`, `error-boundary`, `navigation-error`, `fen-desync` | well-covered |

**No dead AuditKinds** identified — every defined kind has at
least one emit site. But several kinds capture `details` payloads
that nothing downstream queries (raw error blobs, FEN dumps, LLM
preview prefixes) — those are forensic, not analytic.

---

## 3) Surface → capture → gap

### `/coach/play` (CoachGamePage.tsx, ~2250 lines)

**Captures today.** `quiz-started/resolved/cancelled`,
`walkthrough-started-from-coach`, `phase-transition-detected/suppressed`,
`coach-move-narration-{fired, skipped}`,
`coach-opening-{auto-detected, teaching-active}`,
`coach-move-fastpath`, `coach-surface-migrated`,
`coach-move-fx-emitted`, `coach-move-{mate-floor, quality-floor}-triggered`,
`coach-move-personality-applied`, `coach-turn-checkpoint`,
`coach-tactic-alert-spoken`, `coach-memory-*` (when memory active).
Persistence: `db.games.get(reviewGameId)` for review-mode history;
game moves in-memory only (chess.js state) until finalize writes
a GameRecord. `db.sessions` written on exit but never read.

**Consumed by.** coach brain (envelope), gameInsightsService
(post-game).

**Gaps.**
- **Time-on-position** — no per-move timestamp. No way to compute
  dwell-time-by-phase. **High value** for "student is stuck" detection.
- **Hint latency** — `coach-memory-hint-requested` fires but no time
  delta from position-enter → tap.
- **Drag vs click per move** — `moveMethod` is a preference; no
  per-game audit of which method was actually used.
- **Time-to-first-move** + **time-between-moves**.
- **Narration mute/replay events** — no signal.

### `/coach/teach` (CoachTeachPage.tsx)

**Captures today.** `coach-tool-callback-rejected` (3 sites for
invalid teaching-board moves), `coach-surface-migrated` (7 sites
on walkthrough submission), `coach-voice-marker-extracted`. No
direct persistence.

**Consumed by.** coach brain (envelope for context).

**Gaps.**
- **Walkthrough step interactions** — no audit on "Next" tap or skip-ahead.
- **`findMove` retry count per step** — only final pass logged.
- **Narration engagement** — no read-time or replay capture.

### `/coach/review` + `/coach/review/:gameId`

**Captures today.** `coach-surface-migrated`, `stockfish-error`,
`review-{opened, narration-spoken, nav, segments-generated,
segments-parse-failed, walk-explored, walk-resumed, walk-skipped,
playback-step}`, `review-engine-lines-{toggled, analysis-started,
analysis-complete, candidate-explored}`,
`engine-lines-layout-state`. Reads `db.games`.

**Consumed by.** coach brain (review context).

**Gaps.**
- **Engine-line dwell** — toggle fires but no panel-open duration.
- **Walk-step dwell** — no per-position timing.
- **Candidate exploration depth** — count fires, depth doesn't.

### `/coach/chat`

**Captures today.** Full coach-spine kinds plus
`chat-panel-message-received`, `tool-call-error`,
`coach-surface-migrated`. No persistence (in-memory chat history).

**Gaps.**
- **Conversation length** before session end.
- **User satisfaction** — no thumbs-up/down feedback.
- **Envelope composition** — assembled audits exist but don't
  capture WHICH context was included.

### `/tactics/*` (puzzle surfaces)

**Captures today.** `coach-surface-migrated` (walk-mode if active),
`coach-memory-hint-{requested, recorded}`.
Persistence: SRS fields on `db.puzzles` (rating, srsDueDate);
`db.mistakePuzzles.{attempts, successes, status}` for mistake-replay.

**Consumed by.** weaknessAnalyzer, MistakesTab, adaptive engine.

**Gaps.**
- **Wrong-attempt-per-puzzle trail** — `attempts` counter rolls up
  but no individual `move-attempt` audit captures what they tried.
  The puzzle theme is the cleanest weakness signal we have and
  we're aggregating it into a single number.
- **Hint reveal reason** — student tap vs auto-reveal vs coach
  initiative. Not captured.
- **Time-to-first-move + time-to-solution latency.**

### Endgame surfaces (`CoachEndgamePage.tsx`, `FromYourGamesTab.tsx`, `EndgameLessonTab`)

**Captures today.** Minimal — CoachEndgamePage emits
`coach-surface-migrated` on load. Persistence:
`db.endgameProgress.{mastered, timesPlayed, totalWrongAttempts,
lastPlayedAt}`. FromYourGamesTab queries `db.mistakePuzzles` for
endgame mistakes.

**Consumed by.** FromYourGamesTab, the endgame UI itself.

**Gaps.**
- **Move sequence per attempt** — only the `mastered` boolean and
  a counter. No "attempt 1: pawn-to-e4 wrong, attempt 2: knight-to-c3
  correct" trail. Same data, vastly different coach value.
- **Time-to-solution** — `lastPlayedAt` is the completion stamp,
  not a duration.
- **Lesson engagement** — no pause / replay / skip audits.

### Dashboard / hub (CoachHomePage, GameInsightsPage, DashboardPage)

**Captures today.** GameInsightsPage emits the four
`weakness-report-*` kinds (PR #504 + #505 + #508 lineage).
Reads `db.games` + `db.mistakePuzzles`. No `db.sessions` query.

**Gaps.**
- **Scroll depth** on insights — global gold-bar only.
- **Tab switches** within Insights (Overview / Openings / Mistakes /
  Tactics) — `route-changed` fires on URL change but tab swaps
  inside the page don't change the URL.
- **Time-on-dashboard** before drilling into play.
- **Filter / sort interactions** — none.

### Hint buttons (HintButton.tsx, useHintSystem.ts)

**Captures today.** `coach-memory-hint-requested` (on click) +
`coach-memory-hint-recorded` (on reveal). Tier 0/1/2/3 state in
parent.

**Gaps (David's CAPS-emphasized priority).**
- **Reveal reason** — student tap, auto-reveal-on-timeout, coach
  initiative. Not captured.
- **Time-to-reveal** — when did they ask, relative to entering the
  position?
- **Hint effectiveness** — did the next move succeed? No
  hint-attribution on subsequent move audit.

### Global voice/audio (VoiceChatMic.tsx, voiceService.ts)

**Captures today.** `voice-speak-invoked`, `voice-speak-silenced`,
`voice-transcript-received`, `voice-route-result`,
`voice-callback-*`, `tts-concurrent-speak`, `tts-failure`,
`polly-fallback`, `coach-narration-spoken`.

**Gaps.**
- **Mute / unmute mid-session** — no audit.
- **Replay count** per narration block.
- **STT confidence** — STT returns it; we don't capture.
- **Voice switch event** (preference change).

---

## 4) Gap priorities (build plan)

Ordered by signal-to-noise for the coach brain.

### Tier 1 — confessed weakness signals (David's CAPS bucket)

- [ ] **Hint reveal (extended)**: new kind `hint-revealed` carrying
  `{ source, surface, reason: 'student-tap'|'auto-reveal'|'coach-initiative',
  tier: 0|1|2|3, timeToRevealMs, fen, tacticType?, phase?, openingEco? }`.
  Wire on every Hint button surface. Effectiveness joined at query time
  with the next move-attempt on the same fen.
- [ ] **Move attempts (per try, not roll-up)**: new kind
  `move-attempt` carrying `{ surface, fen, attemptedSan, correctSan?, isCorrect,
  moveMethod: 'drag'|'click', timeFromPositionEnterMs, sourceId? }`. Fires
  on every move input in puzzles, walkthroughs, endgame playouts. Lets the
  coach see "fork puzzles take 4 attempts on average" without losing the trail.
- [ ] **Position dwell**: new kind `position-dwell` carrying
  `{ surface, fen, dwellMs, exitReason: 'moved'|'navigated'|'session-end' }`.
  Fires when leaving a position (move or nav). Cheap timer on position-enter,
  emit on exit.

### Tier 2 — high-volume engagement signals

- [ ] **Drag vs click per move**: extend `move-attempt` (above) so we
  don't need a separate kind. ControlledChessBoard already knows.
- [ ] **Engine-lines dwell**: emit `engine-lines-dwell` with duration
  on toggle-close.
- [ ] **Insights tab switch**: emit `insights-tab-switched` with
  `{ fromTab, toTab }`.
- [ ] **Endgame playout move trail**: extend `endgameProgress` with a
  `recentAttempts[]` column (last 5 attempts; rolling) AND emit
  `endgame-playout-attempt` for the live audit-stream view.

### Tier 3 — narration interaction

- [ ] **`narration-replay`** — student replayed last narration block.
- [ ] **`narration-muted` / `narration-unmuted`** — voice toggle audit.

### Tier 4 — session shape

- [ ] **Wire `db.sessions`**: dashboard summarizes
  `sessions-this-week`, surface-time-distribution. OR delete the writer.
- [ ] **`session-shape`** kind on session end: surfaces visited, time
  per surface, dominant phase.

### Tier 5 — second-pass additions (post-review with David)

Folded in after a strength/weakness brainstorm. Ordered roughly by
unlock-per-build-cost.

**Symmetric (both weakness and strength).**

- [ ] **Cross-surface tactic gap.** Join puzzle accuracy with
  in-game accuracy on the SAME `TacticType`. Today both exist
  but no consumer joins them. A user 90% on fork puzzles but 30%
  in games has a TRANSFER problem (pattern known, board awareness
  weak). Inverse — high game, low puzzle — means strong board
  sense, blind to named patterns. Build in `analyticsService.ts`
  as `tacticTransferGap(window)`. No new emit sites required —
  it's a join over existing data.
- [ ] **Color/proficiency mismatch.** "Plays White 70%, wins 40%
  as White; plays Black 30%, wins 65%." Existing
  `OverviewInsights.winRate{White,Black}` carries the numbers;
  no surface calls out the inversion. Build in `analyticsService.ts`
  as `colorProficiencyMismatch()`. No new emit sites.
- [ ] **First-try mastery, aggregated.** Today only
  `endgameProgress.mastered`. Extend the concept: walkthroughs,
  mistake puzzles, tactic puzzles. New flag `firstTryMastered`
  on each domain (cheap derive — `attempts === 1 && successes >= 1`).
  Surface a single aggregate "% first-try" strength score. Wire
  in tier 1 alongside `move-attempt` (the data is in attempts).

**Strength signals (the under-served half — most of the existing
report is weakness-coded).**

- [ ] **Comeback wins** — game won from ≤-200cp evaluation. Inverse
  of the existing `thrownWins`. Same scan path; opposite sign. Add
  to `MistakeInsights` (yes, despite the name) so the symmetric
  signal lives next to its counterpart.
- [ ] **Adaptive puzzle ELO slope.** Dashboard shows snapshot; the
  trend over 30/60d is the signal. New `puzzleRatingTrend(window)`
  query. Pure derive over `db.puzzles.userRating` history (need
  to start logging rating-changed if we don't already — `[ ]` audit
  this).
- [ ] **Tactic-type breadth** — count of DISTINCT `TacticType`
  values the student has ever found in their own games (brilliant /
  great-tagged moves). Cheap derive over `db.games.annotations`.
- [ ] **Brilliant-move distribution variance** — same total brilliants
  spread across many games (general sharpness) vs. clustered in 2-3
  (peak / off-day). Compute coefficient-of-variation across games.
- [ ] **Quick wins vs. grind wins** — games won in ≤20 moves
  (tactical kill strength) vs. ≥60 moves (endgame conversion
  strength). Distinct strengths; surface both with separate counts.

**Weakness signals (gap fills not in Tier 1-4).**

- [ ] **Skip rate.** Different from wrong — engagement weakness,
  not skill weakness. Audit `puzzle-skipped` on skip button taps.
- [ ] **Repeat-of-mistake.** Same wrong move pattern recurring
  across days. Cheap join over `db.mistakePuzzles` — if a student
  re-plays a mistake puzzle and gets it wrong AGAIN, that's a
  `repeat-mistake` audit emission. Likely sparse in absolute terms,
  but every recurrence is high-signal.
- [ ] **Decision reversal.** Drag-and-drop preview: piece picked
  up, legal-move dots seen, piece put back without playing the
  move. The hesitation IS the signal. Wire in
  `ControlledChessBoard`: emit `move-reversed` on drag-cancel.
- [ ] **Lesson abandonment.** Started walkthrough N times, finished
  M. Per-lesson completion rate. Audit `walkthrough-{started,
  completed, abandoned}` with `lessonId`. Abandon = exit before
  reaching the final step.
- [ ] **Coach question topics.** `coach-brain-ask-received` audits
  fire today but we don't categorize what the student asks. Add a
  best-effort topic classifier (regex over the user prompt: opening
  name, tactic type, "why did X", "what is Y") and emit
  `coach-question-topic` alongside the existing ask audit.

**Metacognitive — the highest coach-leverage row.**

- [ ] **Asked-and-failed vs. no-ask-and-correct.** Today's
  `hint-revealed` (Tier 1) will tell us when they ask. Pair it with
  the subsequent move's outcome via the `move-attempt` audit (also
  Tier 1) to derive metacognitive accuracy:
    - Ask + subsequent move correct: **calibrated competence**.
    - Ask + subsequent move wrong: **false confidence absent**
      (knows they don't know).
    - No-ask + subsequent move correct: **confident competence**.
    - No-ask + subsequent move wrong: **UNKNOWN UNKNOWN**
      (doesn't know they don't know) — the highest-leverage
      weakness row to surface, because the student literally can't
      diagnose it themselves.
  Build in `analyticsService.metacognitiveCalibration(window)` —
  joins the two Tier-1 streams; no new emit site needed beyond
  what Tier 1 already adds.

### Defer

- STT confidence (low signal; noisy).
- Conversation-length-before-close (coach chat usage is bursty; not a
  weakness signal).
- Scroll depth (low coach value vs. cost of instrumentation).
- Time-of-day performance (requires multi-week data; revisit in 60d).
- Repertoire depth vs. breadth narrative (cosmetic framing; data
  already exists in OpeningInsights).

---

## 5) Query layer — `analyticsService.ts`

The audit log is currently consumed via `getAppAuditLog()` (returns
markdown) or `__AUDIT__` (console). Neither is shapely for code
consumers. Build a typed service:

```ts
// Quick-shape sketch — actual API in src/services/analyticsService.ts
interface AnalyticsWindow { sinceMs: number; nowMs?: number; }

export function recentHintActivity(w: AnalyticsWindow): {
  count: number;
  byReason: Record<HintRevealReason, number>;
  byTactic: Record<TacticType, number>;
  avgLatencyMs: number;
  effectivenessPct: number; // % of hints followed by correct move
};

export function positionDwellByPhase(w: AnalyticsWindow): {
  opening: { avgMs: number; samples: number };
  middlegame: { avgMs: number; samples: number };
  endgame: { avgMs: number; samples: number };
};

export function moveAttemptsPerPuzzle(w: AnalyticsWindow): {
  meanAttempts: number;
  distribution: { attempts: number; count: number }[];
  byTactic: Record<TacticType, number>;
};

export function surfaceCoverage(w: AnalyticsWindow): {
  rows: { surface: string; kindsEmitted: number; lastSeen: number | null }[];
  totalEvents: number;
};

export function deadCaptureProbes(): {
  kind: string;
  rationale: string;
  status: 'orphan-table' | 'no-consumer' | 'forensic-only';
}[];
```

All read from `getAppAuditLog()` (in-memory + persisted) + relevant
Dexie tables. No new persistence — just shapely queries.

---

## 6) `AnalyticsAuditPanel` (in-app)

Lives at Settings → About → Diagnostics, sibling to the existing
`NarrationAuditPanel`. Renders:

- **Coverage table** — rows = surface, cells = kinds emitted in
  last 24h + last-seen. Red row when zero in 24h. This is the
  primary "show me the data flow" view David asked for.
- **Live counters** — recentHintActivity, positionDwellByPhase,
  moveAttemptsPerPuzzle (last 7d / last 30d toggle).
- **Dead-capture warnings** — `deadCaptureProbes()` result, with
  links to fix. Today: `db.sessions` orphan.
- **Copy markdown for Claude** — same export pattern the existing
  audit panel uses, so the audit-stream → Claude loop carries
  the analytics view too.

---

## 7) Post-build self-audit checklist

After landing the build, audit-of-the-audit verifies:

- [ ] Every new `AuditKind` added has at least one emit site AND at
  least one consumer (panel row or service query). Zero dead capture.
- [ ] Every emit site is fire-and-forget (no awaits on hot path).
  Verify by grep: `await logAppAudit` should not appear in
  user-interaction handlers.
- [ ] `analyticsService.ts` functions return defined shapes when
  the audit log is empty (no crashes on a fresh profile).
- [ ] `AnalyticsAuditPanel` opens and renders on a fresh profile
  with zero data (loading + empty state).
- [ ] Typecheck and lint clean on changed files.
- [ ] Audit-stream pulls (via `/api/audit-stream?since=…`) show the
  new kinds firing from a manual test session.

---

## Pickup notes for the next session

If this work pauses mid-build:

1. **Tier 1 emit sites are the only items where order matters.** Build
   `move-attempt` first (most surfaces consume it); `hint-revealed`
   second; `position-dwell` third (cheapest, single timer pattern).
2. **The query layer is purely additive** — even half-built it
   doesn't break anything. Ship per-function if needed.
3. **The panel can ship as a stub** with TODOs in each section
   pointing at the analytics-service functions still to write.
4. **Do NOT add a new persistence table** unless the audit-log
   capacity (300 entries in memory, persisted to meta) proves
   insufficient. Most queries fit comfortably; if they don't,
   bump the cap before introducing a new store.
