# Tactics tab — SHOULD-WORK contract

Living document. Last updated 2026-05-14.

David's framing: "tell me how the app SHOULD work, and the audit is
getting the app working like it SHOULD. not just function. but
proper function."

Audit pattern matches the existing `endgame tab full audit + SHOULD-WORK contract`
(#500) and `review-with-coach full-play audit + SHOULD-WORK contract`
(#496). For each tactics surface, this doc captures:

- **PURPOSE** — one sentence on what it's for.
- **SHOULD-WORK** — the proper behavior the audit must verify.
- **MUST-NOT** — known anti-patterns that count as bugs.
- **AUDIT TRAIL** — the `logAppAudit` kinds the surface must emit so
  the stream can confirm correct flow.

11 surfaces total. Routes registered in `src/App.tsx:255-265`.

---

## 1. `/tactics` (TacticsPage) — the hub

**Purpose.** Hub for every tactical training mode + 10 themed
drill cards.

**SHOULD-WORK.**
- Renders **with** loading state when `activeProfile === null` (not
  silently empty as today — `TacticsPage:83`).
- All 4 fixed buttons (My Profile, Daily Training, Setup, Random
  Mix) navigate to their targets within 300 ms of tap.
- 10 theme cards visible and tappable on first paint. Each card
  routes to `/tactics/drill` with `state.filterThemes` matching the
  card's theme.
- "Opening Traps" is the one special-case card — routes to
  `/tactics/opening-traps`, not `/tactics/drill`.
- "My Weaknesses" routes to `/tactics/weakness-themes`.
- "My Mistakes" routes to `/tactics/mistakes`.
- SmartSearchBar above the grid responds to intent queries.
- Neon glow on hover/focus matches the global brightness preference.

**MUST-NOT.**
- Render an empty document when the profile is loading.
- Route any theme card to `/tactics/drill` with no `filterThemes` —
  drill would then run unfiltered, which is the Random Mix flow.

**AUDIT TRAIL.** `route-changed` on entry; `coach-hub-tile-clicked`
on each navigation (already emitted, verify present).

---

## 2. `/tactics/profile` (TacticalProfilePage)

**Purpose.** Show theme-by-theme tactical accuracy across the 10
canonical themes; one-tap CTA to drill the weakest.

**SHOULD-WORK.**
- "Back" button routes to `/tactics`.
- Header summary: 3 stats (total puzzles attempted, overall
  accuracy %, themes practiced count) — populated within 800 ms.
- 10 theme rows render in stable order (alphabetical or weakest-
  first, never random). Each row tappable; tap routes to
  `/tactics/drill` filtered to that theme.
- "Train Your Weakest" button routes to drill filtered to the
  theme with the lowest accuracy among themes with ≥1 attempt; if
  no attempts yet, picks the first unattempted theme alphabetically.
- Refresh button re-fetches `getThemeSkills()` and updates the rows
  in place — does NOT navigate away.

**MUST-NOT.**
- Surface "0 themes practiced" while individual rows show attempts
  > 0 (state drift between summary and rows).
- Leave the refresh icon spinning after the refresh completes.

**AUDIT TRAIL.** `tactical-profile-loaded`, `tactical-profile-refresh`.
*Gap*: neither kind is emitted today — add in F-series fix.

---

## 3. `/tactics/drill` (TacticDrillPage)

**Purpose.** 10-puzzle adaptive drill, optionally theme-filtered;
puzzle rating ramps via Elo deltas.

**SHOULD-WORK.**
- Loads first puzzle within 1500 ms of entry. Loading spinner
  visible during the gap.
- Theme filter from `location.state.filterThemes` honored — when
  drilling "Forks" the puzzle queue must contain only fork puzzles.
- After a correct solve, the next puzzle is already prefetched so
  the transition is < 300 ms.
- Rating delta after each puzzle reflects the constants documented
  in `TacticDrillPage:22-25`: clean-fast +100, clean +75, assisted
  +30, fail -50. Stats panel updates within 200 ms of the grade.
- "Drill Again" on the summary screen restarts a fresh 10-puzzle
  queue with the same theme filter; does NOT carry leftover state.
- "View Profile" navigates to `/tactics/profile`.

**MUST-NOT.**
- Show "10/10" before the user has completed 10 puzzles.
- Apply the FAIL_PENALTY when the user used the hint button — that's
  an assisted solve, not a failure.

**AUDIT TRAIL.** `puzzle-loaded`, `puzzle-graded` (with rating
delta), `drill-completed`. *Gap*: none of these emit today.

---

## 4. `/tactics/setup` (TacticSetupPage)

**Purpose.** Multi-move setup puzzles — find 1-3 quiet prep moves
that make a tactic inevitable.

**SHOULD-WORK.**
- Difficulty selector (Beginner 1 move / Intermediate 2 / Advanced 3)
  visible before the first puzzle. Selecting a difficulty starts the
  queue.
- The TacticSetupBoard accepts only legal moves for the side to move.
- Progress bar advances by exactly 1/N after each puzzle is graded.
- Prev/Next arrows are user-driven (NOT auto-advance) — comment
  at `TacticSetupPage:58` is intentional and IS the SHOULD-WORK.
- Summary screen renders "Train Again" (loops with same difficulty)
  and "Back to Tactics" (returns to `/tactics`).
- Empty-state CTA ("Import Games") visible when the puzzle queue is
  empty.

**MUST-NOT.**
- Auto-advance after a correct solve.
- Allow the difficulty selector to be visible mid-session (would
  desync the queue).

**AUDIT TRAIL.** `setup-puzzle-loaded`, `setup-puzzle-graded`.

---

## 5. `/tactics/create` (TacticCreatePage)

**Purpose.** Replay the lead-up to a game mistake, then ask the
user to find the tactic.

**SHOULD-WORK.**
- Replay phase auto-plays game moves at 1000 ms cadence, drops to
  600 ms after 15 moves (`TacticCreatePage:35`).
- Voice narration runs in sync with replay — the subtitle text
  matches `createReplayNarration()` output.
- Play/Skip/Pause buttons work mid-replay; Skip jumps to the
  solving phase immediately.
- Solving phase: MistakePuzzleBoard accepts user moves; on correct
  move shows positive feedback for 2.5 s before advancing.
- Context depth (replay length) starts at 8 moves, ramps on
  consecutive solves, RESETS to 8 on any failure.
- Voice narration stops cleanly on route change (no leaked TTS).

**MUST-NOT.**
- Continue narrating after the user has navigated away.
- Ramp context depth past a 20-move ceiling (sanity bound).

**AUDIT TRAIL.** `tactic-create-replay-started`,
`tactic-create-replay-skipped`, `tactic-create-solved`,
`tactic-create-failed`, `voice-speak-invoked`.

---

## 6. `/tactics/mistakes` (MyMistakesPage)

**Purpose.** Browse + drill imported-game mistakes; filter by phase,
classification, source, status.

**SHOULD-WORK.**
- "Re-analyze Games" button starts a Stockfish sweep with a visible
  progress bar (current / total).
- Phase tabs (All / Opening / Middlegame / Endgame) show accurate
  counts that match the filtered list length.
- 3 dropdowns (Classification / Source / Status) filter the list
  in place; selections persist across solve → list-view round-trips.
- Opening-name filter badge is clearable.
- Tapping a puzzle row enters solve mode (MistakePuzzleBoard).
- Delete (trash icon) removes the puzzle from `db.mistakePuzzles`
  AND from the list within 200 ms; no orphan rows.
- Sort: newest-first; games >1 year sink to the bottom
  (`MyMistakesPage:99-108`).
- Analysis progress bar CLEARS after completion; terminal warnings
  (e.g., "set your chess.com username") show as a separate persistent
  notice — they should NOT remain inside the progress-bar slot.

**MUST-NOT.**
- Preserve a stale progress bar after analysis completes.
- Show "0 mistakes" while filters are active (must say "0 match
  current filters" so the user knows to clear them).

**AUDIT TRAIL.** `mistakes-page-loaded`, `mistakes-reanalyze-started`,
`mistakes-reanalyze-completed`, `mistake-puzzle-deleted`.

---

## 7. `/tactics/adaptive` (AdaptivePuzzlePage)

**Purpose.** Adaptive puzzle trainer with fixed-delta rating;
auto-starts when arrived with `state.forcedWeakThemes`.

**SHOULD-WORK.**
- Select phase: 3 difficulty buttons (easy / medium / hard) visible.
- Auto-start: when entered with `state.forcedWeakThemes` (from
  LichessDashboard), bypasses select phase with "medium" difficulty
  AND the weak themes pre-filtered.
- During solving, right sidebar (AdaptiveSessionPanel) shows live
  session stats and "End Session" link.
- Checkpoint at every 10 puzzles offers "End Session" or
  "Keep Going".
- Rating delta after each puzzle: clean +20, assisted +5,
  failed -20 (`AdaptivePuzzlePage:32-34`). Player rating badge in
  top right updates within 200 ms.
- "End Session" early returns to a summary screen with stats.
- "Back to Select" from summary returns to the difficulty picker.

**MUST-NOT.**
- Skip the checkpoint after exactly 10 puzzles.
- Show the difficulty selector during a session.

**AUDIT TRAIL.** `adaptive-session-started`, `adaptive-checkpoint-reached`,
`adaptive-session-summary`.

---

## 8. `/tactics/classic` (PuzzleTrainerPage) — Daily Training

**Purpose.** Standard SRS-based puzzle trainer + timed-blitz mode.

**SHOULD-WORK.**
- Mode selector visible on entry: 3 buttons (Daily Challenge,
  Untimed, Timed Blitz).
- Daily Challenge mode: skips the SRS grading phase (`:84-86`); user
  sees correct/incorrect feedback and advances.
- Untimed mode: shows SRS grading buttons after each solve.
- Timed Blitz mode: 30 s timer per puzzle (`:174`); timeout grades
  as failed.
- Back button: from mode_select → `/tactics`; from any other phase
  → back to mode_select.
- Skip button advances without grading.
- Session complete screen shows: emoji, solved count, failed count,
  rating change.

**MUST-NOT.**
- Allow Daily Challenge to ever surface the SRS grading panel.
- Allow Timed Blitz to advance without grading the timeout as a fail.

**AUDIT TRAIL.** `classic-mode-selected`, `puzzle-loaded`,
`puzzle-graded`, `srs-grade-recorded` (untimed only),
`classic-session-completed`.

---

## 9. `/tactics/weakness` (WeaknessPuzzlePage)

**Purpose.** Curated 20-puzzle queue mixing game-mistake puzzles
and tactical-theme puzzles targeting identified weaknesses.

**SHOULD-WORK.**
- Loading state visible until the queue resolves.
- Each puzzle displays a source badge: "From Your Game" (mistake)
  or "Tactical Theme" (curated).
- Board component switches based on source: MistakePuzzleBoard for
  mistake puzzles, PuzzleBoard for theme puzzles.
- Prev/Next navigation is user-driven (no auto-advance, per
  `WeaknessPuzzlePage:92` comment).
- Progress bar reflects position in the 20-puzzle queue.
- Summary screen: "Play Again" loops a fresh queue;
  "Back to Report" returns to `/weaknesses` (Game Insights).

**MUST-NOT.**
- Show MistakePuzzleBoard for a curated-theme puzzle (mixed boards
  desync the state machine).
- Auto-advance.

**AUDIT TRAIL.** `weakness-queue-loaded`, `weakness-puzzle-graded`,
`weakness-session-completed`.

---

## 10. `/tactics/weakness-themes` (WeaknessThemesPage)

**Purpose.** Detect weakness patterns from mistakes, surface them
ranked by severity, drill any theme.

**SHOULD-WORK.**
- Theme cards show: theme name, specific pattern, frequency, average
  centipawn loss, "Practice" button.
- Severity badges: high / medium / low based on cp loss thresholds.
- "Mixed Weakness Training" button starts a session drilling all
  themes.
- Back button is context-aware (`:118-122`): from drilling → back
  to themes; from themes → back to `/tactics`.
- Drilling phase: MistakePuzzleBoard + progress bar + theme badge.
- Summary screen messaging differs by mode: mixed-mode says
  "across all themes"; theme-filtered says "for [theme]" (`:342-346`).

**MUST-NOT.**
- Skip the severity badge — every theme must be ranked.
- Route the back button to `/tactics` during the drilling phase.

**AUDIT TRAIL.** `weakness-themes-detected`,
`weakness-theme-drill-started`, `weakness-theme-drill-completed`.

---

## 11. `/tactics/lichess` (LichessDashboardPage)

**Purpose.** Lichess puzzle stats + theme breakdown + "Train
Weaknesses" CTA into AdaptivePuzzlePage.

**SHOULD-WORK.**
- Back button routes to `/tactics` **NOT** `/weaknesses` (the
  current `:130` value is wrong — fixed in commit `07afe6fa`
  per the recent fix log, but verify still correct).
- No-token state: render an empty UI with a clear CTA to Settings
  + a link to create a token at lichess.org (`:59-98`).
- With token: load and render 3 overall stats boxes (total puzzles,
  win rate, recent win rate) within 1.5 s.
- Days selector (7/14/30/60/90) triggers a re-fetch with the new
  param.
- Theme breakdown sorted by win rate ascending; each row shows
  name, win %, first-wins/total, progress bar.
- "Train Weaknesses" card shows the 5 weakest themes and routes to
  `/tactics/adaptive` with `state.forcedWeakThemes` set.

**MUST-NOT.**
- Route the back button to `/weaknesses` (legacy).
- Render the token-required UI while the token is still being
  decrypted (must show a loading state).

**AUDIT TRAIL.** `lichess-dashboard-loaded`, `lichess-dashboard-error`,
`lichess-train-weaknesses-clicked`.

---

## Cross-surface invariants

These rules apply to every tactics surface:

1. **Loading state** — every surface that fetches data on mount
   renders a loading indicator until data lands. Never blank-screen.
2. **Empty state** — every surface that can be empty shows a CTA
   to populate (Import Games, Solve Puzzles, etc.) — never just
   "No data".
3. **Error state** — every fetch-on-mount surface handles errors
   with a visible message + retry, never silent fail.
4. **Back-button target** — every nested route (everything except
   `/tactics`) has a back button that routes UP one level, not to
   the dashboard.
5. **Audit hooks** — every load completion, every grade, every
   summary screen emits at least one `logAppAudit` with the source
   and outcome. (See the "AUDIT TRAIL" rows above.)
6. **Mobile safe-area** — every surface uses
   `pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]` so the bottom
   nav doesn't clip content.
7. **Voice cleanup** — any surface that calls `voiceService.speak()`
   stops it on route change. No leaked TTS across navigation.

---

## Verification matrix — SHOULD-WORK clauses × audit coverage

| Clause | Existing audit | Gap |
|---|---|---|
| All 11 surfaces reachable from `/tactics` | ✓ (33 scenarios) | — |
| Animation completion verified by board diff | ✓ (poll-until-stable) | — |
| View-Opening final snap | ✓ via scenario 23 | — |
| Adaptive back-button in select phase | ✓ (real bug caught) | — |
| LichessDashboard back-button target | ✓ (per fix log) | — |
| Audit-stream emit verification | partial | **GAP**: surfaces 2 (Profile), 3 (Drill), 4 (Setup), 6 (Mistakes), 7 (Adaptive), 8 (Classic), 9 (Weakness), 10 (WeaknessThemes) need new `logAppAudit` kinds (see AUDIT TRAIL rows). |
| Voice cleanup on route change | not verified | **GAP**: surfaces 5 (Create) needs new spec |
| Loading state on every fetch | not verified | **GAP**: spec must screenshot pre-first-paint states |
| Empty-state CTA presence | partial | **GAP**: explicit assertion per surface |
| Filter persistence across solve/list (Mistakes) | not verified | **GAP**: new scenario needed |
| Mobile safe-area bottom padding | not verified | **GAP**: visual regression check |

---

## Pickup notes

If this audit pauses mid-execution:

1. The audit script lives at `scripts/audit-tactics.mjs` — run via
   `node scripts/audit-tactics.mjs`. Reports land in
   `audit-reports/tactics-<timestamp>/`.
2. The script targets the deployed Vercel prod URL by default; set
   `AUDIT_SMOKE_URL=http://localhost:5173` to run locally.
3. The audit-stream secret is hard-coded in the script
   (`AUDIT_STREAM_SECRET` env var) — also in `audit_stream.md`
   per CLAUDE.md.
4. New audit-stream kinds named in this doc's AUDIT TRAIL rows are
   **NOT YET EMITTED** — they're the build plan for F1 fixes.
5. Always extend the audit script when a new SHOULD-WORK clause is
   added; never let the contract drift from what's verified.
