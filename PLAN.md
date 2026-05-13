# Endgame UX & Coach surface — running plan

Living document. Captures the open audit findings, the agreed 7-phase
work plan, and the status of each item. Updated as work lands.

When a new session opens, **read this file first** — it carries the
context the previous session would otherwise have to reconstruct from
a fading auto-summary.

## Current main HEAD reference

As of the last update, main has shipped:
- PR #443–446: review-tab ship-1..ship-9 fixes (pre-Phase work).
- PR #447: endgame UX audit (winning-side, play-past-critical,
  Stockfish recap, keystone voice narration).
- PR #448: scroll-hint bar v3 (spotlight + glow + comet).
- PR #449: drill 3-puzzle cap removed + force narration.
- PR #450: PLAN.md + standing rule to write plan docs for large fixes.
- PR #451: Phase 1.1 keystone extension + back-button regression test.
- PR #452: HOTFIX — reverted Phase 1.1 (OOM cascade) + narration trim.
- PR #453: Phase 8 — Stockfish crash hygiene.
- PR #454: recap opt-in + multi-thread persistence + build widget +
  memory snapshots.
- PR #455: Phase 4 — ImportGamesButton on Insights, Review,
  From-Your-Games.

---

## Open findings (running list)

Ordered by audit-trail discovery, not by priority. Priority lives in
the phase plan below.

### Endgame surfaces

1. ~~**Activate-the-King keystone extension regression.**~~ Reverted
   in PR #452 because PR #451's gate widening triggered the
   Stockfish OOM cascade. Will re-enable as a follow-up commit once
   Phase 8 (PR #453) has been live long enough to confirm the crash
   hygiene holds under sustained use.
2. **Endgame narration substrate divergence.** Endgame uses a
   direct `voiceService.speakForced()` call per position. The rest
   of the app (openings walkthrough) uses `useStrictNarration` for
   streaming sentence-by-sentence playback, route-change cleanup,
   pause-on-chat, manual-nav cancel. Endgame skipped that and
   inherits all of:
   - Endgame-mating delayed narration (whole-text Polly fetch
     before any audio starts).
   - Narration doesn't stop when you leave the tab.
   - Eval Lab completion has no spoken outro.
   - "Why is narration coded differently per tab" — that's the
     architectural disease.
3. **Endgame board parity.** Endgame uses `ConsistentChessboard`
   (static mode); teach/play use the legacy `ChessBoard` (or some
   richer primitive). Different rendering pipelines produce:
   - Animation pacing: pieces snap instead of sliding between moves.
   - Black and white visually move at the same time (no separation
     between student move and opponent reply).
   - No "whose turn" visual cue during opponent reply.
   - **No click / piece-move sound** when the student drops a
     piece on an endgame board. The legacy ChessBoard pipes through
     `usePieceSound()`; ConsistentChessboard static mode doesn't.
     David: "this wouldn't be an issue if the same board was being
     used."
   - Possibly the bishop sprite bug below.
4. **Bishop sprite broken** — `bB` / `wB` alt text shows where the
   bishop image should render. Confirmed on teach, play, mating,
   calc. Cross-cutting piece-set asset path bug.
5. **Back button on Endgame goes to Dashboard**, should go to the
   Coach hub (one level up, not two). Likely `navigate('/')` where
   it should be `navigate('/coach')`.
6. **Game review puzzle hint button missing.** Surface: From-Your-
   Games game-review puzzle with Black king in check. The puzzle
   asks for a "better move than Kf8" but accepts no legal move.
   Two issues:
   - The acceptance gate is exact-match-only; should accept any
     move within an eval threshold of the engine's pick.
   - No hint button to reveal the expected square.

### Coach hub / visual signature

7. **Gold bar (ScrollHintBar) self-hides after scroll.** Once
   `discovered=true` it never returns. You want it as a permanent
   visual signature, not a transient hint. Fix: strip the
   `discovered` + `overflow` guards from the gold-track rendering,
   keep the comet-sweep animation gated only when overflow exists.
8. **Gold bar under Adaptive/Fixed tier sub-toggle** in the
   keystone subview. Same component, applied to the sub-toggle.
9. **Bottom-nav active tab glow** — currently a top-side colored
   line only. You want left-side + bottom-side glow that blends
   into the bottom navbar background.
10. **Coach hub tile glow parity** with Openings tab tiles. Openings
    tiles have strong full-perimeter colored glows per opening;
    Coach hub tiles have dimmer/inconsistent glows. Fix: lift the
    per-tile glow recipe from Openings into a shared utility.
11. **Upload Games CTA missing** on Weaknesses (Game Insights) and
    Review tabs. Both surfaces tell the user to import games but
    provide no entry point to the import flow.

### Data / content

12. **"Recognition only" mating patterns** — Damiano's Mate,
    Lolli's Mate, and possibly others. The Lichess puzzle DB has
    no themes for these named patterns, so we have no drill set.
    Resolution path open — see Phase 7 below.

---

## 7-phase work plan

Each phase = one PR. PRs ship independently to main. After each
phase, this file gets ticked.

### Phase 1 — Quick wins [STATUS: 1.1 REVERTED, 1.2 done, 1.3 deferred]

- [x] **REVERTED** (#1) **Activate-the-King keystone extension** —
  shipped in PR #451 (`extendToObviousWin: isDrill ||
  positionHasPlayableLine`), then **rolled back** within hours
  because the audit log on build `dbaee3b` showed it triggered a
  cascade of Stockfish WASM OOM crashes:
    - 64 `Uncaught [object ErrorEvent]` events fired in ~100ms.
    - `WebAssembly.instantiate(): Out of memory` thrown twice.
    - Sticky single-thread fallback locked in for the session.
    - Polly TTS fetch timed out (signal cooldown collateral).
    - David's tab eventually crashed.
  Disease (not symptom): Stockfish workers aren't pooled —
  every position eval spawns a new worker, WASM heap leaks per
  worker. The keystone extension multiplied the eval load 4–8x
  per playout, which surfaced the underlying leak. Until the
  pooling refactor (new Phase 8 below) lands, keystones end at
  the last curated move (the pre-Phase-1 behaviour).
- [x] (#5) **Back button on Endgame** — verified already routes to
  `/coach/home` (the Coach hub). Locked in with a new regression
  test (`CoachEndgamePage.test.tsx`). If the user still reports
  landing on Dashboard, the cause is likely browser back-button
  (not the in-app arrow) skipping intermediate history, or stale
  deploy on device. Needs concrete repro steps to investigate
  further.
- [ ] (#4) **Bishop sprite missing** — DEFERRED. URL construction
  in `pieceSetService.tsx` looks correct, all 12 pieces map
  identically, underlying SVGs exist on the CDN. Root cause not
  visible without browser DevTools (Network tab on the failing
  bishop request). Probable suspects: CORS / 403 specific to
  bishop file, bad cache, or react-chessboard renderer override.
  Will pick up when we can get a Network-tab dump from David.

### Phase 2 — Narration substrate [STATUS: shipped this PR]

Initial plan was "route endgame through `useStrictNarration`."
Reading that hook end-to-end revealed it's a STEP-RUNNER for
walkthroughs (N discrete steps, auto-advance gated on voice
promise) — endgame surfaces are user-driven (play a move → see
explanation → move on, one narration per landing, no auto-advance).
Wrong substrate.

**Built instead:** `src/hooks/useNarration.ts` — minimal
lifecycle-disciplined hook. Takes a `text` string and optional
`enabled` flag; speaks via `speakForced` whenever text changes;
stops on text-empty or unmount (which means route changes cancel
narration for free). Returns `{ replay, stop }` for manual control.
Same supersession-token pattern as `useStrictNarration` so stale
`.then()` callbacks from a superseded call can't re-trigger speak.

**Migrated:**
- `EndgameLessonTab.tsx` keystone narration — was hand-rolling the
  useEffect + speakForced + cleanup. Now one hook call.
- `CoachEndgamePage.tsx` `CuratedMatingLessonView` — pattern intro
  narration. Same simplification. Switched from `speak()` to the
  hook's `speakForced` semantics so pattern narration matches
  keystone narration (both are opt-in lesson content).
- `EvalLabQuiz.tsx` `Summary` — ADDED outro narration. Previously
  silent (David's audit: "no outro narration"). Now speaks a
  concrete short line — "{perfect} of {total}. {percent} percent
  perfect. {grade}." — when the summary lands.

**What this fixes vs. the original plan:**
- ✅ Narration doesn't stop on route change → hook's unmount
  cleanup is the single source of truth.
- ✅ Eval Lab missing outro → new useNarration call in `Summary`.
- ✅ "Why is narration coded differently per tab" → three surfaces
  now share the hook.
- ⚠️ "Streaming" / "delayed narration" — NOT addressed here. The
  60-second delay David saw was the Stockfish recap monopolizing
  the engine, not narration. Already fixed by Phase 9's recap
  opt-in (PR #454). This phase doesn't add streaming-sentence
  playback; the speakForced underlying still fetches whole-text
  from Polly. Streaming would require a different `voiceService`
  path and isn't part of Phase 2's scope.

Tests: 10 new in `useNarration.test.tsx` (mount-speak, text-change
re-speak, stop on empty, stop on unmount, enabled=false inert,
replay/stop manual control, stale-token supersession). All
existing tests in EndgameLessonTab + EvalLabQuiz still pass.

### Phase 3 — Board substrate parity [STATUS: shipped this PR]

Original framing was "migrate endgame surfaces to the controlled-mode
primitive teach/play uses." Auditing the call sites showed the real
divergence is narrower than that: endgame surfaces drive their own
chess state via `useEndgamePlayout` and pass FEN strings into static-
mode `ConsistentChessboard`. The static path was missing three pieces
of chrome the controlled path gets for free: move sound, last-move
highlight, and check-square red.

A full rewire (lift endgame state into `useChessGame`) would touch
`useEndgamePlayout` (the path the PLAN explicitly says to leave
intact) and risks a repeat of the earlier stash-drop. Inverted the
approach: enriched the static board itself so every static-mode
caller picks up the same chrome from FEN deltas alone. No data-flow
rewiring at call sites — the parity comes "for free."

**Built:** `src/utils/boardMoveDetect.ts` — `detectMoveFromFen(prev,
next)` returns `{ from, to, sound }` by piece-map diff. Recognises
quiet moves, captures, castling, en passant, and promotions; returns
null for position resets so a "load next puzzle" doesn't trigger a
move sound. 11 unit tests.

**Enriched `ConsistentChessboard` (static mode):**
- On FEN change, calls `detectMoveFromFen` and (if a move is detected)
  plays the right `usePieceSound().playMoveSound(...)` and sets the
  cyan last-move highlight on from/to squares.
- Derives the in-check king square from the new FEN and applies the
  red radial gradient — same recipe `ControlledChessBoard` uses.
- Three new opt-out props: `enableMoveSound`, `showLastMoveHighlight`,
  `showCheckHighlight` (all default true).

**Opt-outs:** `PlayableLinePlayer` (demo + memory phase) — it already
pumps its own `playMoveSound(san)` calls. Set `enableMoveSound={false}`
on both boards to avoid doubling up.

**What this fixes from the audit:**
- ✅ (#3) Piece-move sound when the student drops a piece on an
  endgame board — was missing; now matches teach/play.
- ✅ (#3) Last-move cyan highlight on endgame surfaces — was missing.
- ✅ (#3) Check-square red signal — was missing on endgame and on
  kid-mode boards (now uniform everywhere).
- ⚠️ (#3) Animation pacing — both static and controlled use
  `BOARD_ANIMATION_MS = 200`. If pieces still appear to "snap" it's
  almost certainly the parent remounting the board on tab switch,
  not a duration difference; out of scope for Phase 3.
- ⚠️ (#4) Bishop sprite — still deferred (needs a DevTools Network
  dump). Both modes already use the same `buildPieceRenderer` path,
  so the bug isn't a static/controlled divergence.

Other static-mode callers (Kid games, ModelGameViewer, CheckpointQuiz,
all endgame surfaces) now inherit move sound + last-move highlight +
check red automatically. Tests cover sound firing on detected moves,
suppression on position resets, opt-out flags, and check-highlight
behavior (17 ConsistentChessboard tests).

### Phase 4 — Upload Games affordance [STATUS: done]
One component, drop-in across three surfaces.

- [x] Built `<ImportGamesButton>` (`src/components/Games/ImportGamesButton.tsx`).
  Compact + primary variants; both route to `/games/import`.
- [x] (#11) Game Insights (`/weaknesses`) — compact button in header +
  primary CTA on the empty state (when `overview.totalGames === 0`).
- [x] (#11) Review list (`/coach/review`) — compact button added to
  header. Empty-state already had an Import-games link from prior work.
- [x] (#11) "From Your Games" sub-tab — primary CTA added to the
  empty-state stack alongside the existing "Back to endgames" button.
- [x] Test coverage: ImportGamesButton.test.tsx (navigate, variants,
  label override). Existing FromYourGamesTab + GameInsightsPage tests
  still pass.

### Phase 5 — Visual signature consistency [STATUS: shipped this PR]
The "make-the-app-feel-cohesive" pass.

- [x] (#7) **Gold bar permanent** — `ScrollHintBar` no longer
  returns null on `!overflow || discovered`. The gold track now
  renders unconditionally; the comet sweep is gated to `overflow &&
  !discovered` so the motion still earns its keep. Exposed via
  `data-comet="true|false"` for diagnostics.
- [x] (#8) **Gold bar on Adaptive/Fixed tier toggle** — added a
  `<ScrollHintBar>` after the Adaptive/Fixed row in
  `EndgameLessonTab` (PositionRunner header), spotlit at 0.25 / 0.75
  to follow the active button. Same for the tier sub-row (4
  buttons), spotlight follows the active tier.
- [x] (#9) **Bottom-nav active tab glow** — replaced the
  `borderTop: 2px solid <color>` top-line with a left+bottom corner
  glow that bleeds into the nav background. Recipe: 2px L-shape
  border, soft inset shadows on both lit edges, a 225° linear-
  gradient background fading from the corner, and a soft outer
  drop-shadow. Matches the Openings tab's left+bottom 2px signature
  but with inset shadows so the glow fades into the surface instead
  of cutting it with a hard line.
- [-] (#10) **Coach hub tile glow parity with Openings** — audit was
  misdiagnosed. `CoachHomePage.neonBorderStyle` and
  `OpeningCard`'s inline border style are byte-for-byte equivalent:
  same `border-l/b: 2px` + `border-t/r: 1px` asymmetric L-shape, same
  `scaledShadow(rgb, gB)` triple-stack glow, same `glowBrightness`
  brightness scaling. If the visual signature still feels off it's
  per-tile color choice or geometry, not the glow recipe — both call
  sites already go through the same primitives. Leaving as-is until
  there's a concrete failing case.

**Audit instrumentation (David's "add in audit tools" call):**
- New audit kind `route-changed` — fires on every URL change from
  `AppLayout`. Joins with `coach-hub-tile-clicked` etc. so navigation
  flow is reconstructable from the audit log alone.
- New audit kind `scroll-hint-state` — fires when the gold-bar comet
  state flips. Diagnoses "the bar isn't moving" reports.
- New audit kind `asset-load-error` — wired into `pieceSetService`'s
  per-piece `<img onError>` handler (shipped as a follow-up). Now
  produces an audit entry per failed sprite — the Phase 1.3 bishop-
  sprite report will have a concrete trail (URL, set, piece key) the
  next time it reproduces, instead of needing a DevTools Network
  dump.

### Phase 6 — Game review hint button [STATUS: shipped this PR]

Reading `FromYourGamesTab` end-to-end showed the hint button (#6
first half) already exists — wired to `playout.revealHint`, gated on
`playout.hintMove && !playout.hintRevealed`. The audit's framing was
correct that the surface needed work, but the missing piece was the
acceptance gate, not the hint UI.

The Kf8-in-check dead end traces to `useEndgamePlayout.playMove`'s
strict exact-SAN check: when the position record carries a single
`bestMove` (e.g., `Re8`), every other reasonable defensive move
(`Kg8`, `Ke8`, …) flashes red. The audit log on those reports shows
the user dropped a legal good move and got nothing back.

**Built:** `useAcceptableMoves(fen, toleranceCp)` — runs
`stockfishEngine.analyzePosition(fen, depth=12)` (returns top 3 PV
lines via the existing MultiPV config), normalises to the student's
perspective, and emits SANs of every line whose cp loss vs the best
line is ≤ tolerance (default 30 cp). Cached by the engine's LRU.

**Added:** `EndgamePlayoutOptions.acceptableSans?: string[]` — extra
SANs the playout treats as curated-correct alongside `expectedSan`.
Keystones leave it undefined → strict exact match preserved.

**Wired:** `FromYourGamesTab.Lesson` passes the hook's result as
`acceptableSans`. Eval kicks off on position mount; until it returns
(~200-500ms) the gate stays in strict mode, then opens up to the
within-tolerance set. No UI hiccup at the call site.

Tests: 6 new for `useAcceptableMoves` (loading, enabled=false,
tolerance inclusion/exclusion, black-to-move sign flip, engine
failure). Existing `useEndgamePlayout` (13) and `FromYourGamesTab`
(3) tests still pass. Typecheck clean.

### Phase 7 — Mating pattern DB augmentation [STATUS: shipped this PR]

Picked option (a) — hand-author. Swept the picker: 13 patterns were
"Recognition only" (no `puzzleThemeTag` + no `lessonPositions[].solution`).
10 are named patterns; 3 are piece-mate fundamentals (Two-Bishop,
Queen+Bishop, Queen+Knight) which need open-board endgame play, not
mate-in-N puzzles — out of Phase 7 scope.

For each of the 10 named patterns, took the existing recognition-
reference FEN from the pychess study data and:
- mate-in-1 positions: brute-force enumerated legal moves, kept the
  one(s) producing `#`.
- mate-in-2 positions: recursive search via chess.js (find a White
  move such that EVERY Black reply allows a mate-in-1).

Wrote `solution[]` arrays into `mating-patterns.json` for:

| Pattern | Position | Solution |
|---|---|---|
| Damiano's Mate | m1 | `Qh7#` |
| Damiano's Mate | m2 | `Rh8+ Nxh8 Qg7#` |
| Lolli's Mate | m1 | `Qg7#` |
| Anderssen's Mate | m1 | `Rh8#` |
| Cozio's Mate | m2 | `Qh6+ Kg3 Qh2#` |
| Pawn Mate | m1 | `b5#` |
| Pawn Mate | m2 | `Qe8+ Nge7 d5#` |
| Greco's Mate | m1 | `Qh5#` |
| Max Lange's Mate | m1 | `Qg8#` |
| Réti's Mate | m1 | `Bd8#` |
| Légal's Mate | m1 | `Nd5#` |
| Triangle Mate | m1 | `Qe5#` |

Also caught a pre-existing bug: `double-bishop-mate` had a 2-SAN
solution that didn't mate (`Qxf3+ Bxf3`). Restored the third ply
(`Bxf3#`) — verified via the same recursive search.

**Tests:** 2 new in `endgameService.test.ts`:
- every `lessonPosition.solution` is a legal SAN sequence ending in
  checkmate (20 solutions verified, includes the existing 9 + my 11)
- no `named-pattern` remains Recognition-only (`piece-mate` excluded)

**Net effect:** the picker now opens a `CuratedMatingLessonView`
(playable, voice-narrated) for 10 patterns that previously showed
"Recognition only" with a static board. The 3 remaining piece-mate
fundamentals are tracked separately — they want a different surface
(open-board play vs Stockfish), not a 1-2 move puzzle.

### Phase 7b — Multi-position nav [STATUS: shipped]

Picker now sorts solved positions shallow→deep and passes them all
into `CuratedMatingLessonView`, which walks them with a Prev/Next
strip + a "Try the mate-in-N" CTA on the completion screen. Filled
three suppressed shorter-mate references that the deeper positions
were shadowing.

### Phase 7c — Free-play foundations [STATUS: infra shipped]

`useEndgamePlayout` now starts in `student-to-move` (not `complete`)
when `solution` is empty AND `stockfishFallback === true`. This is
the foundation for piece-mate fundamental drills (K+Q vs K, K+B+B
vs K, K+Q+B vs K, K+Q+N vs K) where there's no curated line — the
student drives the lone king to mate against Stockfish defense.

The UI wiring (picker → free-play mode + win detection at mate / 50-
move draw / position repetition) is a separate follow-up — wants a
small UX call on:
- How to time out a stuck student (50-move rule? Stockfish-suggested
  "I can finish it for you" button?)
- Where the lone-king starting position lives (random per-attempt,
  or always the curated `lessonPositions[0]`?)
- Whether to grade student technique (moves to mate vs optimal)

### Phase 8 — Stockfish crash hygiene [STATUS: shipped in PR #453]

Initial hypothesis (worker-pooling) was wrong. Reading
`stockfishEngine.ts` end-to-end revealed:

- The engine IS already a singleton (one worker per tab).
- The OOM cascade is caused by THREE distinct bugs that compound,
  not by worker leakage:

**Bug A — Worker error flood.** When the multi-thread bundle
crashes internally it emits 60+ `ErrorEvent`s. The `worker.onerror`
handler triggers exactly one early-failure fallback (good) but
doesn't `event.preventDefault()` (bad), so subsequent errors bubble
to `window.onerror`, get captured by `installGlobalErrorHooks`, and
trigger 60+ `logAppAudit` writes to IndexedDB. That's what's
blocking the main thread.

**Bug B — WASM heap not reclaimed before fallback.**
`worker.terminate()` is synchronous, but WASM page reclamation is
async. The single-thread fallback spawns IMMEDIATELY and tries to
allocate before the browser has freed the multi-thread heap → OOM.

**Bug C — No retry budget on single-thread spawn failure.** When
single-thread also fails to allocate, the engine marks itself
permanently unavailable. Most OOMs are transient memory pressure
that recovers seconds later.

**Fixes (all in `stockfishEngine.ts`):**
1. `event.preventDefault()` + `return true` in `worker.onerror`.
2. ~100ms delay between `terminate()` and single-thread spawn.
3. One retry-with-backoff (~500ms) on single-thread OOM.
4. Audit-log dedup: collapse multiple worker errors in the same
   crash window into one summary entry.

Scope: ~30 lines in one file + tests. Single PR.

When that lands, re-enable Phase 1.1's keystone extension as a
follow-up commit (the OOM cascade was the only reason it had to
revert).

---

## Decisions log

| Date | Decision | Status |
|------|----------|--------|
| TBD  | Phase 7 data source | Pending David's call |

---

### Phase 9 — UX speed + audit visibility [STATUS: shipped in PR #454]

- Recap moved behind a "Show accuracy breakdown" button (was
  auto-firing 10 Stockfish evals = 60s freeze per playout).
- 5s per-call timeout in `buildEndgameRecap` so a hung Stockfish
  call doesn't lock the spinner forever.
- Recap depth dropped 12 → 8.
- Multi-thread fallback flag persisted to `localStorage` so a fresh
  page load doesn't re-probe a known-broken multi-thread bundle.
- `BuildVersionWidget` — small corner indicator showing the running
  bundle hash + "refresh" hint when SW has a newer build.
- Periodic `memory-snapshot` audit kind, ~every 30s, so the next
  crash report shows heap ramp up to the crash, not just silence.

### Phase 10 — Repo hygiene [STATUS: in progress this PR]

- vitest config now excludes `src/test/benchmarks/**` from the
  default test run (perf benchmarks need a real worker + bundle;
  they were the loudest source of red on `npm test`).
- CLAUDE.md "Deployment Policy" rewritten to match the actual
  harness workflow (branch + PR + immediate merge, not direct
  push to main). Old text said "no PRs, push directly to main"
  but the harness 403s direct pushes, so every session got
  confused, created a branch, then accumulated branch litter.
- PLAN.md synced to current main HEAD.
- Branch hygiene (deleting 300+ stale `claude/*` branches) is
  STILL OPEN — the harness blocks `git push --delete` too, so
  this needs the GitHub UI / direct-API access David has but a
  session doesn't. Tracking as a known carry-over.

## Sequencing logic

- **Phase 1 first** because tiny wins build momentum and prove the
  deploy chain is healthy.
- **Phase 2 before Phase 6** because the hint button speaks, and
  we want narration on the new substrate.
- **Phase 3 before Phase 5** because the visual signature pass may
  need to know what board chrome looks like under the new primitive.
- **Phase 4 standalone** — can interleave anywhere; doesn't touch
  shared code.
- **Phase 7 last** — biggest unknown, biggest decision needed.

Total: roughly 3 days of focused work spread across 7 PRs.

---

## Next-session pickup

When a new session opens against a partially-completed plan:

1. **Read this file first.** It's faster than re-deriving context
   from the previous session's summary.
2. Check the `[STATUS]` markers on each phase. Anything `pending`
   is up for grabs; anything `in progress` should be finished
   before starting something else.
3. Run `git log --oneline -10` to see what's actually landed since
   this file was last edited.
4. If a phase is partially done (e.g., one of three checkboxes
   checked), prefer finishing it before starting a new phase.
