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
- PR #458: Phase 2 — useNarration hook + 3 surface migrations.
- PR #459: Phase 3 — static-board chrome parity (sound + last-move + check).
- PR #460: Phase 5 — visual signature parity + audit hooks.
- PR #461: Phase 6 — eval-tolerant gate on From-Your-Games.
- PR #462: asset-load-error audit wired on piece sprites.
- PR #463: integration tests for acceptableSans gate.
- PR #464: Phase 7 — hand-author solutions for 10 mating patterns.
- PR #465: Phase 7b — multi-position nav in CuratedMatingLessonView.
- PR #466: Phase 7c — free-play mode foundations.
- PR #467: Phase 7d — piece-mate fundamentals wired into free-play.
- PR #468–481: stale-test sweep (Settings a11y, Dashboard label, hint
  race, walkthrough mock target, weakness analyzer fixture, mistake
  puzzle tactic mock, teach-walkthrough cross-test contamination,
  coach-review forward-click warmup, calculation react-chessboard
  jsdom mock, endgame-data illegal moves repair).

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

### Phase 7d — Piece-mate fundamentals wired [STATUS: shipped]

Picker now routes `category === 'piece-mate'` patterns into
`CuratedMatingLessonView` in free-play mode when there's no curated
solution. View takes a `freePlay` prop that forwards
`stockfishFallback: true` + `extendToObviousWin: true` +
`fallbackPliesToPlay: 50` to the playout. In-progress narration
swaps to "Drive the king to mate. / Stockfish defends. Any legal
move is fine — find mate."

The playout's `playOpponentReply` already detects `isGameOver()`
and marks phase `complete` on checkmate (line 302-305), so the
completion screen surfaces naturally when the student delivers
mate. The 50-ply fallback cap protects against stuck-student
infinite loops (insufficient material / 50-move rule).

After 7d, no named-pattern or piece-mate-fundamental surfaces as
Recognition-only. The static recognition-only board path still
exists but is now unreachable (kept as the safety fallback for
any future pattern that ships without enough data).

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

---

# Cross-app weakness tracking — new plan (2026-05-14)

## The ask

> "weaknesses needs to be tied to the rest of the app so it can
>  identify weaknesses while the user is playing in other tabs.
>  play against coach, learn with coach, puzzles, **HINT BUTTON**,
>  all data needs to track back into weakness tab for analysis
>  and reporting back to user." — David

Today `/weaknesses` is fed by ONE signal: imported games +
Stockfish per-move classification (`gameInsightsService.ts`). The
ask is to turn it into a **single sink for every weakness signal
the app already produces** — not just imported-game blunders.

Disease, not symptom: every surface has its own intuition about
when the user struggled (wrong puzzle move, hint tap, walkthrough
findMove flip, coach play blunder), but those signals stay
trapped in their respective surfaces. The weakness profile is
fractured. Coach brain reads ONE shard, /weaknesses reads
ANOTHER, the user sees a third. Unify them.

## Audit — what exists today

- `db.games` — imported + finished coach play sessions. Stockfish
  classifies post-game. Feeds /weaknesses Mistakes/Tactics tabs.
- `db.mistakePuzzles` — generated from blunders in `db.games`.
  Feeds MistakesTab.
- `weaknessAnalyzer.ts` — `computeWeaknessProfile()` +
  `getStoredWeaknessProfile()`. Already used by coach brain
  (`coachContextSnapshot`, `coachChatService`,
  `coachTrainingService`, `coachActionDispatcher`) but NOT
  surfaced on /weaknesses. Big gap.
- `puzzles.json` — Lichess curated 15K, themes already tagged.
  Tactics surface and walkthrough `punish` stage use it. Wrong-
  move and hint-tap events here are **the cleanest weakness
  signal in the app** — the theme IS the weakness category. We
  ignore it entirely today.
- Walkthrough `findMove` phase — wrong answers logged but not
  routed to weakness analytics.
- Hint buttons — multiple surfaces (`/coach/play` Tips,
  `/coach/teach` Hint, puzzle Hint, mistake-puzzle Hint, endgame
  Hint, FromYourGames Hint). None emit a structured weakness-
  signal event.

## A-E phased plan

Each phase = one PR. Ship independently; each lights up more of
the loop before the next.

### Phase A — Signal persistence layer [STATUS: pending]

The foundation. Without it, every emitter and every consumer is
ad-hoc.

- New Dexie store `db.weaknessSignals` (bump schema version + add
  upgrade function per CLAUDE.md standing order).
- Schema (all fields denormalized for cheap aggregation queries):
  ```ts
  interface WeaknessSignal {
    id: string;
    createdAt: number;           // epoch ms
    source: 'puzzle' | 'walkthrough-findmove' | 'coach-play' |
            'coach-review' | 'endgame' | 'hint-tap' |
            'game-analysis';
    kind: 'wrong-move' | 'hint-used' | 'classification' |
          'self-mistake-recovery';
    // What the user struggled with — exactly one of these is set
    tacticType?: TacticType;     // pin / fork / skewer / ...
    phase?: GamePhase;           // opening / middlegame / endgame
    openingEco?: string | null;  // C24 etc.
    openingName?: string | null; // resolved via getOpeningNameByEco
    // Severity / weight
    cpLoss?: number;             // when measurable
    classification?: MoveClassification;  // when classified
    // Context for drilldown
    sourceId?: string;           // puzzle id / gameId / lessonId
    movePly?: number;            // 1-indexed
    fen?: string;
    notes?: string;
  }
  ```
- New service `weaknessSignalService.ts`:
  - `emitWeaknessSignal(partial: Omit<WeaknessSignal, 'id'|'createdAt'>)`
  - `queryWeaknessSignals(filters)` — by date range, source, tactic, phase, opening
- Audit-hook coverage on every emit (audit kind:
  `weakness-signal-emitted`).
- **Lightweight by default.** No await on the hot path —
  `emitWeaknessSignal` is fire-and-forget. Worst case a missed
  write on tab close is acceptable; chasing every signal isn't
  worth blocking the UI.

### Phase B — Hint-tap instrumentation across the app [STATUS: pending]

David's CAPS emphasis. Single instrumentation pattern, six
surfaces. Highest signal-to-noise — a hint tap is a *confessed*
weakness, not an inferred one.

Tag every hint tap with:
- which surface (`source` field above)
- WHY the user tapped (auto / manual / stuck — best-effort
  heuristic per surface; default 'manual' if unknown)
- what the position is about (tacticType / phase / openingEco
  pulled from the surrounding context)

Surfaces to wire (in order of impact):

1. **Tactics puzzles** (`/tactics/play`) — the puzzle's
   `themes[]` is the tacticType set. Emit on hint tap +
   wrong-move (Phase D will consume).
2. **Walkthrough Hint** (`/coach/teach`) — surface-mode aware;
   tag with the active walkthrough's opening + phase.
3. **Mistake puzzle Hint** — already knows the source mistake's
   tacticType + phase.
4. **Coach play Tips** (`/coach/play`) — phase = current phase,
   no tacticType (too noisy in live play).
5. **Endgame Hint** — tag phase: 'endgame'.
6. **From-Your-Games Hint** — phase from puzzle position.

### Phase C — Wrong-answer signal emitters [STATUS: pending]

Mistakes and findMove failures.

- **Puzzles** (`puzzleService.handlePuzzleAttempt` or similar):
  emit `wrong-move` with the puzzle's themes as tacticType.
- **Walkthrough findMove**: emit on wrong answer with the
  branchpoint's opening context.
- **Coach review self-recovery**: when a user re-plays one of
  their own mistakes and gets it wrong AGAIN, emit
  `self-mistake-recovery` with `cpLoss` from the original. This
  is a structural insight — "you make the same mistake twice"
  is more useful than "you blundered once".
- **In-game classifications** already flow via post-game
  Stockfish analysis. Either replicate into `db.weaknessSignals`
  on game-analysis completion (cheap denorm) OR teach the
  consumer to join `db.games.annotations` with the new table.
  Prefer denorm — keeps the analyzer single-source-of-truth.

### Phase D — Aggregate layer [STATUS: pending]

`weaknessAnalyzer.ts` extended to consume `db.weaknessSignals`
alongside `db.games`. Produces a unified weakness profile:

- per-tactic-type (count, avg cpLoss, last-seen, hint-rate)
- per-phase (count, hint-rate)
- per-opening (cross-references existing OpeningInsights)
- per-source (so we know if puzzles say "fork weak" but games
  say "fork strong" — surface the inconsistency)
- per-difficulty-tier on puzzles (the user is stronger on 1200-
  rated puzzles than 1500-rated ones in the same theme)

Existing consumers (`coachContextSnapshot`, etc.) keep working
because the analyzer's output shape grows additively.

### Phase E — Surface to /weaknesses and the Coach [STATUS: pending]

Close the loop. Three new surfaces, ranked by user value:

1. **Tactics tab on /weaknesses** — extend `TacticsTab` to
   include puzzle-derived signals, not just brilliant/missed
   in games. Add a "Hint reliance by tactic" row.
2. **Cross-surface inconsistency callouts** — when a user is
   90% on a tactic in puzzles but 30% in games, that's a
   transfer problem worth naming. New section "Drill it, but
   can't play it" (or similar copy).
3. **Coach proactive prompts** — when the coach starts a play
   session, surface the top 1-3 weaknesses from the unified
   profile so the brain can use them (e.g., "you've been
   missing pins this week — want me to set up a position?").
   Hooks into the existing `coachContextSnapshot`.

A **new "Patterns" or "Hint Reliance" tab** is tempting but I'd
defer it until after Phase E.1 — if extending Tactics/Mistakes
covers the use cases, don't add a fifth tab.

## Sequencing logic

- **A first** — every other phase is blocked on it. Foundation.
- **B before C** — hint taps are higher signal-to-noise than
  wrong-move attribution (which has more edge cases: was it a
  fingerslip? a guess? a real miss?). Get the cleanest signal
  flowing first, then layer in the noisier ones.
- **D before E** — surfaces shouldn't grow their own
  aggregation logic; centralize in the analyzer.
- **E can sub-ship** — E.1 (TacticsTab extension) lands
  independently of E.2 / E.3.

## Decisions to make (move to Decisions log when answered)

- **Where to surface hint reliance?** Sub-section on each tab,
  or new "Patterns / Habits" tab? Default: extend existing tabs.
- **What's the lookback window?** Last 30 days for active
  weakness? Lifetime for "trend reversed" callouts? Default:
  30d for active surface, 90d available via toggle.
- **Decay** — should a fork-miss from 6 months ago count?
  Default: linear decay over 60 days, zero weight beyond.
- **Cross-device sync** — does Supabase sync need to carry
  `db.weaknessSignals`? Default: yes (mirrors the other
  user-data tables). Adds rows to the sync schema; check
  Phase A migration covers it.

## Risks

- **Dexie migration**: adding a store is low-risk additive, but
  the upgrade function still has to be reversible. Test on a
  fresh profile + a profile with existing /weaknesses data.
- **Hot-path performance**: `emitWeaknessSignal` from a hint
  button must be sub-ms. No awaits, no network.
- **Coach brain blast radius**: Phase D touches
  `weaknessAnalyzer.ts` which feeds the coach. Add `getStored`
  back-compat path; don't break existing consumers.
- **False-positive hint signals**: a user who taps hint to learn
  faster gets tagged as weak. The 'why' field (auto/manual/
  stuck) mitigates but the heuristic for inferring 'stuck' is
  fragile. Start with `'manual'` as default; refine if signal
  is noisy.

## Pickup notes

When the next session resumes this work:

1. Confirm Phase A migration on a fresh `db.delete()` profile +
   on a profile carrying existing weakness data.
2. Phase B is six call sites. Don't try to do them all in one
   PR — bundle 2-3 per PR so individual rollbacks are cheap.
3. Phase E.3 (Coach proactive prompts) is the highest-payoff
   but biggest blast radius — let A-D ship and bake before
   touching the coach context layer.
