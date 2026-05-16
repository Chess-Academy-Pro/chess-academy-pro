# Rolodex Plumbing — WO-ROLODEX-PLUMBING-01

Living plan doc for the foundation work that lets the Training Plan
rolodex UI ship in a follow-up WO. Append-and-update — status flags
track per item.

**Companion docs:**
- `/docs/audits/rolodex-audit-01.md` — pre-build audit (deep-link gaps, app map, brain action support, back-stack, favorites infra)
- `/docs/audits/puzzle-opening-coverage.md` — puzzle ↔ opening coverage (21% tagged, 13 Lichess name mismatches, 201 rolodex-ready openings)
- `/docs/sandbox-playwright-setup.md` — Playwright rig + voice intercept (load-bearing for the runtime gates)

---

## Phased plan

| PR | Items | Status | Branch |
|---|---|---|---|
| **A.** Cleanup + alias data | 6, 8, 9, 12 | pending | `claude/rolodex-plumbing-a` |
| **B.** Deep-link parity | 1, 2, 3, 4 | pending | `claude/rolodex-plumbing-b` |
| **C.** Selectors + family-fallback | 7, 11, 13 | pending | `claude/rolodex-plumbing-c` |
| **D.** Brain action — favoriteOpening | 5 | pending | `claude/rolodex-plumbing-d` |

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
| 1 | Fix `/coach/play` cold-load filter regression | B | pending | Static read at `CoachGamePage.tsx:548,569,573`. Diagnose root cause before patching. |
| 2 | Add `mode` parameter (`from-start` / `middlegame`) | B | pending | No ply cap (decision above). |
| 3 | URL deep-link wiring for 5 destinations | B | pending | Uses item 11's selector for `/tactics/*?opening=`. |
| 4 | `/tactics/mistakes` URL fallback | B | pending | Add `useSearchParams` fallback to existing `location.state` path. |
| 5 | `favoriteOpening` write tool + intent regex | D | pending | Pattern: `src/coach/tools/cerebrum/<name>.ts` (see `play_move`). |
| 6 | `/tactics/opening-traps` → `appRoutesManifest.ts` | A | pending | Trivial. |
| 7 | Per-opening completion selectors (4 hooks + placeholder) | C | pending | Pulls from `openings.linesDiscovered`, `openings.linesPerfected`, `meta.openingProgress`, `mistakePuzzles.openingName`. |
| 8 | Delete transient audit driver | A | pending | `audit-reports/rolodex-audit-01/driver.mjs` + `audit-reports/puzzle-opening-coverage/coverage.mjs`. |
| 9 | App-map sweep | A | pending | Confirm no other gaps now that we're adding query params. |
| 10 | Puzzle coverage report | — | done | Shipped as `docs/audits/puzzle-opening-coverage.md`. |
| 11 | Family-fallback Puzzles selector + brain LLM call | C | pending | Returns `{count, source, family?}`. |
| 12 | Lichess alias map | A | pending | 8 useful entries (~133 puzzles recovered). |
| 13 | Wire fallback awareness into Puzzles row only | C | pending | Other rows stay simple this WO. |

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
