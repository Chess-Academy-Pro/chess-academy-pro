# Rolodex Plumbing — WO-ROLODEX-PLUMBING-01

**Status: COMPLETE (2026-05-16).** All 4 PRs merged · Vercel green.
This doc is now archival — see the retrospective at the bottom for
what landed, what was deferred, what surprised us, and the
confidence read for WO-ROLODEX-UI-01.

---

Living plan doc for the foundation work that lets the Training Plan
rolodex UI ship in a follow-up WO. Append-and-update — status flags
track per item.

**Companion docs:**
- `/docs/audits/rolodex-audit-01.md` — pre-build audit (deep-link gaps, app map, brain action support, back-stack, favorites infra)
- `/docs/audits/puzzle-opening-coverage.md` — puzzle ↔ opening coverage (21% tagged, 13 Lichess name mismatches, 201 rolodex-ready openings)
- `/docs/sandbox-playwright-setup.md` — Playwright rig + voice intercept (load-bearing for the runtime gates)

---

## Phased plan

| PR | Items | Status | Merge SHA | PR # |
|---|---|---|---|---|
| **A.** Cleanup + alias data | 6, 8, 9, 12 | **live** | `a216b347` | [#558](https://github.com/dyahnke-pro/chess-academy-pro/pull/558) |
| **B.** Deep-link parity | 1, 2, 3, 4 | **live** | `8cf70cd9` | [#559](https://github.com/dyahnke-pro/chess-academy-pro/pull/559) |
| **C.** Selectors + family-fallback | 7, 11, 13 | **live** | `8ff16092` | [#561](https://github.com/dyahnke-pro/chess-academy-pro/pull/561) |
| **D.** Brain action — favoriteOpening | 5 | **live** | `ede0fce9` | [#562](https://github.com/dyahnke-pro/chess-academy-pro/pull/562) |

Also-ran: [#557](https://github.com/dyahnke-pro/chess-academy-pro/pull/557) — test-cleanup one-liners that landed alongside as a separate tiny PR to keep PR-A scope clean (4 data-drift fixes carved out of the audit triage; balance of 13 deferred to WO-TEST-CLEANUP-01).

Status legend: pending · in progress · merged · live (Vercel green + audited).

Sequencing logic: PR A lands low-risk data + cleanup so PR B/C have a stable
base. PR B is the highest-risk piece (the `/coach/play` regression
diagnosis + cold-load deep-link parity); ship it alone so a rollback is
clean. PR C depends on PR A's alias map. PR D is independent — could ship
in parallel with C but serial is safer for review.

After PR B: status checkpoint with Dave before PR C kicks off (PR B
is the biggest behavior change).

---

## Decisions log

Dated, append-only. Anything that needs Dave's call lands here first.

- **2026-05-16 — `mode=middlegame` does NOT cap plies.** Dave's call.
  Engine plays the full PGN of the favorited opening, however long it
  is. No cap at 10. Simpler model: the favorited opening's PGN IS the
  end of book by definition. (Earlier proposal had a 10-ply cap;
  reversed before any code was written.)

  **Worst-case observed:** *Ruy Lopez: Marshall Attack, Main Line,
  Spassky Variation* (C89) at 36 plies, ~24.5s animation at the
  current 700ms-per-move pacing. Second-worst: *Semi-Slav Defense:
  Meran Variation, Rellstab Attack* (D49) at 29 plies, ~19.6s.
  Typical openings the user actually favorites land at 5-15 plies
  (~3-10s). This is intentional — the user explicitly chose a deep
  variation; the build-up IS the lesson, not noise to skip past. If
  future user feedback says 24s is too long, the lever is the
  per-move pacing (currently 700ms — chosen to stay under
  `makeCoachMove`'s 800ms timer so AI never fires during book play).

  **Known issue (deferred):** Audit-log writes from `CoachGamePage`
  entry-beat path don't appear in `db.meta('app-audit-log.v1')`
  despite the code path executing (verified via console.log capture
  through Playwright). Other audit events from the same page
  (`app-boot`, `coach-memory-intent-set`) land cleanly. The
  `.catch(() => undefined)` in `logAppAudit`'s serialized write chain
  swallows errors silently — exactly the failure mode where you
  can't diagnose from logs. The PR-B e2e audit assertion fell back
  to chat-mirror as the trigger signal (always reliable);
  voice-side wiring is pinned at the unit-test level
  (`CoachGamePage.test.tsx` › `rolodex entry beat`) so the "voice
  silently dies, chat works" regression is still caught — just at
  a different boundary. Worth investigating when next touching
  audit infrastructure (instrument the chain's catch, or add a
  per-write success/failure return to `logAppAudit`).

- **2026-05-16 — Family-fallback coach voice = fire-and-forget on row tap.**
  Navigate immediately; voice plays when the brain responds.
  Mitigates the "Stop and ask Dave if family-fallback voice introduces
  visible latency" condition in the WO. If Dave wants the row to dwell
  while the brain thinks, switch to blocking; otherwise async wins.
- **2026-05-16 — Family resolution derived from name, not a new field.**
  `OpeningRecord` has no `parentName` / `familyId`. Helper:
  `getOpeningFamily(name) = name.split(':')[0].trim()`. Lives in
  `openingService.ts`.
- **2026-05-16 — Aliases map keyed by DB family name, values are
  Lichess token arrays.** Same shape covers both "Lichess rename"
  (Russian_Game → Petrov's Defense) and "Lichess parent has no DB row"
  (Kings_Gambit_Declined). See item 12.

---

## Inferred / pending decisions (no override yet)

- **PR A as one commit, or split out the alias map?** Currently
  planned as one PR. Alias map is data-only; cleanup is doc-only.
  Combined PR keeps round-trips down.
- **`favoriteOpening` tool callable from chat AND search bar?**
  WO scope says both. Search bar uses `parseCoachIntent` fast-path;
  chat goes through the LLM tool-use loop. Plan to wire both in PR D.

---

## Item status

| # | Item | PR | Status | Notes |
|---|---|---|---|---|
| 1 | Fix `/coach/play` cold-load filter regression | B | **done** | Static read at `CoachGamePage.tsx:548,569,573`. Diagnose root cause before patching. |
| 2 | Add `mode` parameter (`from-start` / `middlegame`) | B | **done** | No ply cap (decision above). |
| 3 | URL deep-link wiring for 5 destinations | B | **done** | Uses item 11's selector for `/tactics/*?opening=`. |
| 4 | `/tactics/mistakes` URL fallback | B | **done** | Add `useSearchParams` fallback to existing `location.state` path. |
| 5 | `favoriteOpening` write tool + intent regex | D | **done** | Pattern: `src/coach/tools/cerebrum/<name>.ts` (see `play_move`). |
| 6 | `/tactics/opening-traps` → `appRoutesManifest.ts` | A | **done** | Trivial. |
| 7 | Per-opening completion selectors (4 hooks + placeholder) | C | **done** | Pulls from `openings.linesDiscovered`, `openings.linesPerfected`, `meta.openingProgress`, `mistakePuzzles.openingName`. |
| 8 | Delete transient audit driver | A | **done** | `audit-reports/rolodex-audit-01/driver.mjs` + `audit-reports/puzzle-opening-coverage/coverage.mjs`. |
| 9 | App-map sweep | A | **done** | Confirm no other gaps now that we're adding query params. |
| 10 | Puzzle coverage report | — | done | Shipped as `docs/audits/puzzle-opening-coverage.md`. |
| 11 | Family-fallback Puzzles selector + brain LLM call | C | **done** | Returns `{count, source, family?}`. |
| 12 | Lichess alias map | A | **done** | 8 useful entries (~133 puzzles recovered). |
| 13 | Wire fallback awareness into Puzzles row only | C | **done** | Family-fallback architecturally confined to `puzzlesByOpening.ts` — other 4 hooks do exact-name lookups only. |

---

## Pre-commit gates per PR

Every PR must satisfy:
- `npm run typecheck` clean
- `npm run lint` clean
- `npm run test:run` green
- Pre-existing TS/lint errors in any touched file get fixed in the same PR (per CLAUDE.md)
- `git add <file>` per file — never `-A` / `.` (parallel session has untracked / modified files we must not sweep up)

Per acceptance criterion 1, the **final** PR adds runtime audit script
+ run against all 7 deep-link URLs via the rig. PR B alone covers the
deep-link wiring; PR C extends with the family-fallback test path.

---

## Parallel-session signal (recorded for next session pickup)

At start of work, local working tree had:
- Modified (not by this session): `CLAUDE.md`, `docs/AUDIT_INDEX.md`, `src/data/pro-repertoires.test.ts`
- Untracked (not by this session): `docs/plans/2026-05-16-trap-orientation.md`, `scripts/audit-repertoire-orientation.mjs`, `src/data/repertoire-orientation-baseline.json`, `src/data/repertoire-orientation.test.ts`

That's another session mid-work on trap orientation / repertoire data.
Zero file overlap with this WO's touch list. Strategy:
1. Branch from current HEAD (`c632d0e8`).
2. Stage with explicit `git add <file>`; never `git add -A`.
3. Their dirty files stay in their working tree.

---

## Pickup notes for the next session

If this session ends before all 4 PRs ship:

1. **Where are we?** Check the "PR" status column above. Each PR has a
   branch name; `git branch -a` will show what's merged vs in flight.
2. **What changed?** Each merged PR updates the corresponding row to
   `merged` then `live` after the Vercel deploy is audit-green.
3. **What's the runtime check?** Acceptance criterion 1 in the WO —
   the 7 deep-link URLs. The final PR ships a Playwright script for
   it; until then, the transient driver pattern (off-tree, per
   `docs/sandbox-playwright-setup.md`) is the gate.
4. **Don't touch the parallel session's work.** See above.

---

## Retrospective — 2026-05-16

PLUMBING-01 shipped same-day across 4 phased PRs. 31 files changed,
~3,400 lines of code + tests + docs. Total green test count added:
~190.

### What landed

- **Item 1** — Rolodex entry beat on `/coach/play` (4-variant stem
  rotation, deterministic-by-opening, voice + chat-mirror).
- **Item 2** — `?mode=from-start|middlegame` URL param, no ply cap
  (Dave's call), 700ms pacing under `makeCoachMove`'s 800ms timer.
- **Item 3** — URL deep-link wiring for 5 destinations
  (`/openings`, `/coach/teach`, `/tactics/opening-traps`, `/games`,
  `/tactics/mistakes`). The 7 acceptance URLs all green via the
  rig.
- **Item 4** — `/tactics/mistakes?opening=` URL fallback alongside
  the existing `location.state` path.
- **Item 5** — `favoriteOpeningTool` (cerebrum, kind: write) with
  idempotency guard against the `toggleFavorite` flip-back trap.
  AI search fast-path in `parseCoachIntent` (2 regex patterns).
  SmartSearchBar wired through chip-tap + voice paths.
- **Item 6** — `/tactics/opening-traps` added to
  `appRoutesManifest.ts`.
- **Item 7** — 6 progress hooks (4 tracked: walkthrough · lines ·
  traps · mistakes; 1 family-fallback: puzzles; 1 placeholder for
  GM Games / Practice).
- **Item 8** — Transient audit drivers deleted.
- **Item 9** — App-map sweep confirmed.
- **Item 10** — Puzzle coverage report (`docs/audits/puzzle-opening-coverage.md`).
- **Item 11** — Family-fallback Puzzles selector + brain LLM call
  (`requestPuzzlesFamilyFallbackVoice`, fire-and-forget, full brain
  with no template fast-path, librarian-vs-coach tone anchor).
- **Item 12** — `OPENING_TAG_ALIASES` (8 entries, ~128 puzzles
  recovered; Petrov's Defense ↔ Russian_Game is the biggest single
  win at 49).
- **Item 13** — Architectural enforcement that family-fallback
  lives only in the Puzzles selector.

### What we deferred (named, with reasons)

- **Trap-completion tracking on `OpeningRecord`.** `useOpeningTrapsProgress`
  ships with `completed: 0` and total = `trapLines.length`. The
  underlying data model has no `trapsPerfected[]` parallel to
  `linesPerfected[]`. TODO marker in the hook + decision-log entry.
  *Reason:* infra change, M effort, not blocking the rolodex UI's
  v1 render (the chip shows "N traps available" cleanly).
- **GM Games / Practice from move 1 / Practice middlegame
  per-opening progress.** Ship as `{ status: 'not-tracked-yet' }`
  via `useOpeningProgressPlaceholder`. *Reason:* no per-opening
  data substrate exists on those rows. New Dexie tables required
  (~L effort each). Out of scope per WO item 7's explicit
  "ship as not-tracked" guidance.
- **Kid-Mode puzzles by opening.** The `training-puzzles.json`
  sub-rating-400 pool has 0 `openingTags` — entirely untagged.
  *Reason:* needs an engine pass to re-tag 300 puzzles. Separate WO.
- **Bulk re-tagging of the 11,793 untagged Lichess puzzles.**
  *Reason:* would require an engine pass; family-fallback covers
  most of the practical gap without it.
- **Rate-limit on the family-fallback brain call.** Every row tap
  fires a fresh LLM round-trip. *Reason:* Dave's "firehose-first"
  v1 stance. Memoization keyed on `${opening}::${family}::${count}`
  is a 20-LOC add when needed.
- **`'rolodex'` `CoachSurface` value.** The family-fallback brain
  call tags surface as `'standalone-chat'` (closest existing).
  Adding `'rolodex'` would touch `envelope.ts` and its handlers.
  *Reason:* out of scope for a data-plumbing PR; standalone-chat
  produces the right register.
- **9 of 13 pre-existing test failures.** Carved 4 one-liners into
  #557 (test-cleanup); deferred the remaining 9 (Settings testid
  sweep, Kid/PracticeMode hint flow, useTeachWalkthrough timing,
  Stockfish UCI mock drift, etc.) to WO-TEST-CLEANUP-01.
- **Audit-log Dexie write-chain investigation.** The
  `rolodex-entry-beat` audit doesn't appear in
  `db.meta('app-audit-log.v1')` despite the code path executing;
  other audits from the same page (e.g. `coach-memory-intent-set`)
  land cleanly. `.catch(() => undefined)` in the write chain
  swallows errors silently. *Reason:* unknown root cause, ~30 min
  spent without resolution. Voice-side coverage moved to unit-
  test boundary instead. Documented in decisions log; worth a
  look when next touching audit infrastructure.

### What surprised us

- **The audit's "regression" was a spec question, not a bug.** The
  pre-build audit framed `/coach/play?opening=` as a regression
  ("intent captured but moves never appear on board"). PR-B's
  pre-coding investigation revealed the brain DOES see the intent
  (envelope confirmed via runtime LLM request body capture); the
  moves don't appear because that's correct behavior for
  `mode=from-start` — the student plays from move 1 themselves.
  The actual missing piece was the *entry-beat narration* on cold
  load, which is more "felt-experience signature" than
  "regression fix." Reframed item 1 from fix-the-bug to add-the-
  signature.

- **The Dexie audit-log silent-failure.** Real-time anomaly Dave's
  audit-stream rig wouldn't have caught: the code path runs
  (verified via Playwright console-log capture), the chat mirror
  appears (verified visually), but the corresponding audit row
  never lands in `db.meta`. Wasted 30 min trying to instrument
  the cause before pivoting to unit-test the wiring at the
  voice-service boundary instead. The audit-log path needs an
  instrumentation pass — the swallowing `.catch` is exactly the
  failure mode where you can't diagnose from production traces.

- **Parallel-session interference was real and active.** Throughout
  the session, another Claude session (working
  `claude/coach-master-integration`) repeatedly:
  - Checked out their branch in MY working tree (mid-session)
  - Stashed my work with labels like *"OTHER-SESSION rolodex+coachgametest
    WIP — DO NOT pop on coach-master-integration branch"*
  - Left untracked files (`masterPlayLookup.ts`, etc.) that
    caused my typecheck to fail until I removed them

  Recovery cost ~20 min total across the session. Dave's
  "git status sanity before every commit" rule caught all
  attempted leakage — zero parallel files made it into any of
  my 4 PRs. The protocol works but it's annoying tax. If this
  becomes routine, a session-isolation wrapper (separate
  worktree per Claude session) would be a cleaner fix than
  per-commit vigilance.

- **Voice-service routing is fragile in the audit env.** Headless
  Chromium has `speechSynthesis` but no audio engine; Polly
  fetches return 401 without creds. The fallback chain between
  them is non-deterministic in this env (sometimes speak fires,
  sometimes content-Polly fires, sometimes neither). The Dexie
  audit-log path WAS supposed to be the orthogonal signal — and
  that's what failed (see above). Chat-mirror became the reliable
  e2e signal; voice-wiring coverage moved to unit tests where
  it's deterministic.

- **`useNarration` actually IGNORES voiceEnabled.** Initial
  recommendation to Dave was wrong (`useNarration` "respects
  voiceEnabled pref"). It uses `voiceService.speakForced`
  internally — explicitly bypasses the pref. The hook's own
  header comment spells this out. Caught via code-review pre-
  coding; Dave reversed his "respect voiceEnabled" call to
  "use speakForced" once the precedent was clear (endgame
  surfaces have used speakForced since PR #447 — the
  established pattern is "user opted into the lesson, narration
  IS the lesson").

### Confidence read for WO-ROLODEX-UI-01

**High confidence** the rolodex UI can land cleanly on this
plumbing. Specific reasons:

- All 7 deep-link URLs from the acceptance criterion are verified
  green via the audit script. Tap a card row → land on the right
  destination → filter visually applied. This is the single
  biggest UI risk, and it's already pinned at the e2e tier.
- Progress hooks have the right shape — `{completed, total,
  loading}` for tracked rows, `{status: 'not-tracked-yet'}` for
  placeholder. UI conditionals are trivially uniform per row.
- `favoriteOpeningTool` is idempotent — the UI can wire a star
  toggle that re-favorites on every tap without worrying about
  flip-back.
- Family-fallback selector returns `{count, source, family?}` in
  one synchronous call. Memoized per opening name — 35 selector
  calls on a 5-favorite × 7-row rolodex mount cost ~50ms once,
  microseconds thereafter.
- Brain voice on family-fallback is fire-and-forget — UI
  navigation never blocks on the LLM round-trip.

**Two specific risks worth flagging for the UI WO:**

1. **The audit-stream gap (deferred above) means voice-side
   regressions in the rolodex UI won't be caught by an e2e
   script — only by unit tests of the wiring.** PR-B's
   entry-beat tests are the template. The UI WO should pin
   voiceService.speakForced calls at the unit-test boundary
   for any rolodex-side narration.

2. **The brain voice on family-fallback uses
   `'standalone-chat'` surface tag.** If the UI WO finds the
   register feels off (too conversational, not card-row-ish),
   adding a `'rolodex'` surface to `CoachSurface` + a matching
   `envelope.ts` branch is the proper fix. Out of scope for
   PLUMBING-01; flagged so the UI session can decide.

**Estimated UI WO scope:** ~3-5 days, one PR, no plumbing
discoveries expected. The hard part is the manila-tabs ↔ desktop-
two-column responsive shape and the long-press drag-reorder; the
data is fully wired.

### Order of operations for next sessions

1. **WO-TEST-CLEANUP-01** (priority pin — Anthropic API leak is
   billing real credits per test run). Drafted from the triage
   in `audit-reports/` + the deferred-failures list above.
2. **WO-ROLODEX-UI-01** — the actual rolodex UI on this plumbing.
