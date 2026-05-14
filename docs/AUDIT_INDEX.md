# Audit Index

Single manifest for every UI/surface audit in the app. New audits add a
row here when they ship. Open audits get a status flag so parallel
sessions don't double-drive the same surface.

The pattern across audits is consistent:
- **UX contract** doc — what the surface MUST do, hand-written contract
- **Audit script** — Playwright drive against the deployed app
  (`scripts/audit-<surface>.mjs`), green or fail per surface
- **E2E spec** — Vitest/Playwright spec under `e2e/` for build-time
  regression
- **Audit reports** — `audit-reports/<surface>-<iso>/` (gitignored,
  generated per run)

Status legend: ✅ shipped · 🟡 partial · 🚧 in flight (another session) ·
❌ untouched · — N/A on this surface.

---

## Coverage matrix

| Surface | Status | UX contract | Audit script | E2E spec | Notes |
|---|---|---|---|---|---|
| Settings | ✅ | — | — | — | PR #502, #503 + Coach Narration unification (2026-05) |
| Learn-with-Coach (`/coach/teach`) | ✅ | — | — | — | PR #499 + Phase 1+2 narration overhaul. Locked at tag `learn-stable-2026-05-08`. |
| Endgame (`/coach/endgame`) | ✅ | [`docs/endgame-ux-contract.md`](endgame-ux-contract.md) | — | `e2e/coach-endgame.spec.ts` | PR #500. 24 specs passing, 2 skipped. |
| Opening Traps (`/openings/traps`) | ✅ | — | — | — | PR #494 + classification taxonomy (`trap` / `mistake` / `theme`). |
| Coach Review (`/coach/review`) | ✅ | [`docs/review-with-coach-ux-contract.md`](review-with-coach-ux-contract.md) | [`scripts/audit-coach-review.mjs`](../scripts/audit-coach-review.mjs) | `e2e/coach-review.spec.ts` | PR #496, #501 + Wave 4 (2026-05-14). 23/23 specs green. |
| Tactics (`/tactics/*`) | ✅ | — | [`scripts/audit-tactics.mjs`](../scripts/audit-tactics.mjs) | — | 33 scenarios, 111 checks. 8 bugs fixed during audit. |
| Play-with-Coach (`/coach/play`) | ✅ | — | [`scripts/audit-coach-play.mjs`](../scripts/audit-coach-play.mjs) | — | 17 unit tests for resolvers. `narrationDensity` reads `resolveLlmNarrationDensity`. |
| Coach Chat (`/coach/chat`) | ✅ | [`docs/coach-chat-ux-contract.md`](coach-chat-ux-contract.md) | [`scripts/audit-coach-chat.mjs`](../scripts/audit-coach-chat.mjs) | `src/components/Coach/CoachChatPage.test.tsx` | 2026-05-14. Memory-mirror bug fixed (fast-paths now write to `useCoachMemoryStore`). 15/15 prod audit + 18/18 unit tests. |
| Coach Chat — sister surfaces (memory-mirror class sweep) | ✅ | [`docs/coach-chat-ux-contract.md` §Bug Log 2026-05-14 (sister surfaces)](coach-chat-ux-contract.md) | reuses `audit-coach-chat.mjs` pattern; per-surface drives pending | each surface's own `.test.tsx` | 2026-05-14. Same class fixed across `GameChatPanel.tsx` (10 sites), `VoiceChatMic.tsx` (4), `CoachTeachPage.tsx` (5), `CoachGamePage.tsx` (2). 21 total. |
| Weaknesses (`/weaknesses`) | 🟡 | — | — | — | PR #508 partial — review-link surface + ECO names in mistake/tactic rows. Full audit pending. |
| Openings explorer (`/openings`) | 🚧 | — | — | — | In flight on another session (artefacts at `audit-reports/openings-ui-*`). Coordinate before driving. |
| Coach Analyse (`/coach/analyse`) | 🟡 | — | [`scripts/audit-untouched-surfaces.mjs`](../scripts/audit-untouched-surfaces.mjs) | `CoachAnalysePage.test.tsx` | 2026-05-14. Smoke pass — FEN input + Load button visible, no pageerrors on mount. Deep flow (paste FEN, get explanation streamed) still pending. |
| Coach Plan (`/coach/plan`) | 🟡 | — | [`scripts/audit-untouched-surfaces.mjs`](../scripts/audit-untouched-surfaces.mjs) | `CoachSessionPlanPage.test.tsx` | 2026-05-14. Smoke pass — page mounts cleanly. Plan-load + start-session click-through still pending. |
| Coach Train (`/coach/train`) | 🟡 | — | [`scripts/audit-untouched-surfaces.mjs`](../scripts/audit-untouched-surfaces.mjs) | `CoachTrainPage.test.tsx` | 2026-05-14. Smoke pass — training heading + one of loading / no-recs / recommendations state. Recommendation click-through pending. |
| Coach Hub (`/coach/home`) | 🟡 | — | [`scripts/audit-untouched-surfaces.mjs`](../scripts/audit-untouched-surfaces.mjs) | `e2e/coach-full-audit.spec.ts` (14 tests) | 2026-05-14. Smoke pass added — 14 tiles render. Per-tile interactive drives still pending. |
| Dashboard + SmartSearchBar (`/`) | ✅ | — | [`scripts/audit-dashboard.mjs`](../scripts/audit-dashboard.mjs) | `DashboardPage.test.tsx`, `DashboardPage.a11y.test.tsx` | 2026-05-14. 17/17 prod audit: root mount, 4 tiles + Import Games, SmartSearchBar typing → dropdown, ask-coach option, all 5 tile nav routes, clear-input. |
| Kid Mode (`/kid`) | 🟡 | — | [`scripts/audit-untouched-surfaces.mjs`](../scripts/audit-untouched-surfaces.mjs) | — | 2026-05-14. Smoke pass — 4 main cards render + Journey card nav works. Fairy-tale / Puzzle Quest / Play Games / Mini-Games sub-flows pending. |
| iOS-specific (AVAudioSession, Bluetooth, mic) | — | — | — | — | Device-only, can't headless audit. |

---

## How to add a new audit

1. **Read the surface end-to-end.** No skimming. Cite line numbers.
2. **Write a UX contract doc** — `docs/<surface>-ux-contract.md`.
   Sections: `SHOULD WORK` (numbered contracts), `AUDIT COVERAGE`
   (what tests verify each contract).
3. **Write a Playwright drive script** —
   `scripts/audit-<surface>.mjs`, mirror
   [`audit-coach-review.mjs`](../scripts/audit-coach-review.mjs) /
   [`audit-coach-chat.mjs`](../scripts/audit-coach-chat.mjs). Single
   Chromium session, SPA nav via clicks, audit-stream POST intercept,
   per-surface `record()` with `expectations` array.
4. **Run against prod.** Identify failed expectations. Fix product
   bugs (don't just patch the test). Add build-time tests for
   data-shape regressions.
5. **Add an E2E spec** (`e2e/<surface>.spec.ts`) when the surface
   warrants Playwright-level CI coverage.
6. **Add `audit-reports/<surface>-*/` to `.gitignore`.**
7. **Add a row to the matrix above.** Status, links, date.
8. **Commit + push.** Vercel auto-deploys; if `git push` fails (PAT
   403), `vercel --prod` is the fallback.

## Audit philosophy (locked in)

- **Surface-mount-only checks are banned.** Every interactive
  affordance must do something visible; verify the visible outcome.
- **Animations: poll-until-stable, not fixed sleep.**
- **For multi-move flows: track WHOSE COLOR moved.**
- **Pull audit-stream events per scenario** to verify expected
  events fired (and unexpected events did not).
- **Sweep, don't spot-fix.** When a bug surfaces, grep the codebase
  for every other instance of the same pattern before declaring done.
- **BEST fix.** Wire dead things, scrap redundancies, don't ship
  cosmetic patches.
