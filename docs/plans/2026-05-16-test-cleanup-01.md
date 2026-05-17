# WO-TEST-CLEANUP-01 — Test Suite Cleanup + API Credit Leak Fix

**Status:** Step 0 done · Part A pending
**Type:** Test/infrastructure cleanup — bug fixes only, no new features
**Owner:** Claude Code
**Auto deploy:** ON after all tests pass

---

## Why this WO exists

PLUMBING-01 retrospective surfaced two test-suite problems blocking clean signal going forward:

1. **API credit leak (priority pin).** Six test files hit the live Anthropic API on every test run, burning real credits. Four leak visibly (assertions fail with "anthropic failed, trying fallback"), two leak silently (assertions pass, credits still burned). CI runs and local dev runs both bill the production key.

2. **Pre-existing test failures (12 carry-over).** Tests rotting on `main` for ~3 days, all traced to recent PRs that shipped without updating their tests. Most cluster into shared-root buckets: 5 hint-flow failures (likely one fix), 3 Settings testid sweep failures (one fix), 5 individual smalls.

Goal: clean test suite, mocked brain boundary, no API leaks, no rotting failures. Future WOs run against a green baseline.

---

## Step 0 — Pre-WO requirement (DONE)

Land envelope.test.ts one-line fix as standalone PR.

`src/coach/__tests__/envelope.test.ts` asserted `env.toolbelt.length === 22`. PR-D added `favoriteOpeningTool`, registry has 23 tools. Bumped assertion 22 → 23.

**Shipped:** PR #564 merged at `0da5753d` on 2026-05-16. WO begins from a baseline where envelope is the only fix new since the PLUMBING-01 retro — all 13 other failures still red until this WO ships them.

---

## Reference docs

- `/docs/plans/2026-05-16-rolodex-plumbing.md` — PLUMBING-01 retro + deferred items
- Triage delta posted 2026-05-16 evening (14 failures, 6 API-leak sites)
- `/docs/plans/parallel-session-interference-log.md` — running log of parallel-session moves so we can diagnose at the source after enough data lands

---

## Scope

### Part A — API credit leak fix (priority pin)

**Goal:** Zero `"anthropic failed, trying fallback"` events across a full test run. Zero live API calls from any test under any condition.

**Mock boundaries (both required):**

1. `coachService.ask` — modern brain call path. Mock at `src/coach/coachService.ts`. Pattern: `vi.mock('.../coachService', () => ({ coachService: { ask: vi.fn() } }))`.

2. `coachApi.ts` top-level exports — legacy direct call path. Mock `getCoachCommentary`, `getCoachChatResponse`, and any other top-level functions in `src/services/coachApi.ts` that wrap API calls.

Both boundaries because the leak surfaces split between modern brain calls and older direct `coachApi` calls.

**Files to fix (6 total):**

Visible leakers (failing tests):
- `src/components/Kid/GameChapterPage.test.tsx`
- `src/components/Kid/JourneyChapterPage.test.tsx`
- `src/components/Openings/PracticeMode.test.tsx`
- `src/components/Tactics/TacticSetupBoard.test.tsx`

Silent leakers (passing tests, hidden credit burn):
- `src/components/Openings/WalkthroughIntegration.test.tsx`
- `src/services/walkthroughResolver.test.ts`

**Pattern to match — reference implementations (paths verified on main HEAD `0da5753d`):**

Five test files already mock cleanly at the correct boundary. Use them as the reference implementation:

- `src/services/puzzlesFamilyFallbackNotify.test.ts` — mocks `coachService.ask` via `vi.mock('../coach/coachService', () => ({ coachService: { ask: vi.fn() } }))`
- `src/components/Coach/CoachGamePage.test.tsx` — mocks both `coachService` and `coachApi.ts` top-level exports
- `src/components/Coach/CoachTeachPage.test.tsx` — mocks `coachService` for the streaming-tool path
- `src/components/Coach/CoachChatPage.test.tsx` — mocks `coachService` for the standalone chat path
- `src/coach/__tests__/coachService.test.ts` — unit-tests the service itself with provider mocks (lower level — the canonical "what does an LLM-free coachService call look like" reference)

Copy the pattern. Don't invent a new one.

### Part B — Hint-flow quintet (shared-root investigation)

**Status (2026-05-16):** Original 5-failure hypothesis was wrong about
the shared root. After PR-B1 work the failures decomposed cleanly:

- 3 surface tests (GameChapterPage, JourneyChapterPage,
  TacticSetupBoard) — caused by Part A's empty-string
  `coachService.ask` mock breaking the `{nudgeText && (...)}`
  conditional render. Fixed in **PR-B1 (#570)** by giving the mock
  non-empty text.
- PracticeMode — caused by Part A's Anthropic API leak. Resolved
  as a side effect of **Part A (#568)** before Part B ran.
- `useHintSystem.test.ts` Tier 3 — pure inter-file pollution
  (passes in isolation, fails in full suite). Different class of
  problem entirely; PR #511 was NOT the cause despite the original
  hypothesis.

**PR-B1 (merged):** 3 surface tests fixed. Test debt cleared down to
the one inter-file pollution case.

**PR-B2 (deferred):** `useHintSystem.test.ts` Tier 3 investigation
moved to known-issue status. Test passes in isolation, source code
is correct, failure is full-suite-only — textbook deferrable test
debt. Defer rationale was context-window preservation for
WO-ROLODEX-UI-01 (the biggest creative build of this arc gets a
fresh CC session).

**Handoff:** `docs/audits/usehintsystem-pollution-investigation-notes.md`
— captures what's known, the rejected hypotheses (PR #511 ruled
out), the leading theory for next session (coachMemoryStore module
cache via the mock factory's `await import` at line 87), the
bisection approach, and Dave's `vi.resetModules()` defensive
workaround for any new test added to the polluted suite.

### Part C — Settings testid sweep (shared root)

**Failures:**
- `SettingsPage.test.tsx` · "renders all board display controls" — `board-orientation-toggle` missing
- `SettingsPage.test.tsx` · "renders feedback and game behavior controls" — `move-confirmation-toggle` missing
- `SettingsPage.test.tsx` · "master all-off does NOT disable sound" — same `move-confirmation-toggle` missing

**Hypothesis:** PR #528 (May 15) restructured Settings UI and removed/renamed these testids. Tests not updated.

**Fix:** Inspect current SettingsPage component, identify what the testids became (or whether the controls moved). Update test selectors to match current UI. Pure test-side reconciliation expected — no Settings code changes unless an actual bug is found.

### Part D — Individual smalls

Each is its own small fix. No shared roots expected.

1. **`stockfishEngine.test.ts`** — "selects multi-thread when capabilities are present" — engine UCI handshake sequence changed in PR #526. Update mock to match new sequence.
2. **`PersonalityPanel.test.tsx`** — "voice override persists only when it differs from per-personality default" — persistence data shape changed in PR #523. Test expects only-overrides map, code now stores all-personalities map. Update test assertion to match current shape.
3. **`VoiceSettingsPanel.test.tsx`** — "shows Cloud Voice (AI) section" — UI copy/structure changed in `d5842b87` (May 13). Update test to match current UI text.
4. **`ChessLessonLayout.test.tsx`** — "reserves bottom-nav clearance by default" — CSS class regex doesn't match new class from PR #528 layout reorganization. Update regex to match current class.
5. **`useTeachWalkthrough.test.tsx`** — "Brief mode speaks shortIdea instead of idea when present" — 5000ms timeout. Either timing drift or env (real API call leaking — covered by Part A mock work). Diagnose first: if Part A's mocks resolve it, no separate fix needed. Otherwise investigate hook restructure.

### Part E — Diagnosability side observation (no fixes, just inventory)

PLUMBING-01 retro flagged `.catch(() => undefined)` patterns in coach infrastructure swallowing real failures silently. Specific case: `CoachGamePage` rolodex-entry-beat audit-log writes never landed in `db.meta('app-audit-log.v1')` despite code path executing.

**Not in scope to fix all of them.** Just inventory:

1. Search the codebase for `\.catch\(\(\) => undefined\)` and similar swallow patterns
2. List occurrences with file:line + brief context (what call is being silenced)
3. Flag the 3-5 highest-risk ones (silenced calls on user-visible paths, audit infrastructure, brain calls)
4. Add report to `/docs/audits/silent-catch-inventory.md`

Output is a finding, not a fix. Future WO can act on it. Worth doing now because this WO touches a lot of test/infra files and CC will already have the codebase loaded.

---

## Out of scope (do NOT build in this WO)

- Fixing every silent-catch found in Part E — inventory only
- New tests (unless required to verify a fix works)
- Refactoring the brain/coachApi architecture
- Touching test infrastructure (vitest config, setup files) unless required to land a fix
- Anything PLUMBING-01 deferred (GM Games progress tables, Kid pool re-tagging, bulk puzzle re-tagging, etc.)
- WO-ROLODEX-UI-01 prep work

---

## Acceptance (felt experience)

Three things must be true when this WO ships:

**1. Zero API leaks across a full test run.** Run `npm run test:run`. Search the stderr/stdout for `"anthropic failed"` or `"trying fallback"`. Zero occurrences. Run twice — once cold, once warm. Both clean.

**2. Test suite is fully green.** Same `npm run test:run` reports 0 failures. All 13 pre-existing failures resolved (envelope already done in Step 0 + 13 from this WO).

**3. The silent-catch inventory exists.** `/docs/audits/silent-catch-inventory.md` posted, top 3-5 risks flagged, no fixes attempted.

---

## Pre-commit gates

- `npm run typecheck` clean
- `npm run lint` clean (warnings allowed at current baseline ~226)
- `npm run test:run` — 0 failures
- API leak audit: search test output for `"anthropic failed"`, `"trying fallback"`, `"credit balance"` — zero hits
- Web search for current best-practice patterns on `vitest` mocking at module boundaries, especially `vi.mock` hoisting and `vi.fn()` reset patterns. Add any standard patterns we're missing.
- Fix pre-existing TS/lint errors in any file touched (per `CLAUDE.md`)
- **Standing rule from PR-D miss:** any change to `src/coach/tools/registry.ts` triggers a full `npm run test:run` before commit (catches transitive regressions like the envelope toolbelt-count drift).
- Auto commit + push + deploy

---

## Stop and ask Dave if

- The hint-quintet investigation reveals 5 separate bugs instead of one shared root (decide whether to fix all 5 or defer some)
- Part A's mock work requires changes to `coachService` or `coachApi.ts` source files (mocks should not require source changes; if they do, something's off)
- A "fix" requires changing real behavior (e.g., bringing back a removed testid). Tests reconcile to source, not the reverse, unless real bug found
- The silent-catch inventory surfaces a critical bug (something currently broken in production that we didn't know about). Stop and flag before continuing
- Any individual fix balloons past ~30 minutes — could indicate misdiagnosis

---

## PR strategy

CC's call on PR splitting. Suggested shape:

- **PR-1:** Part A — API leak fix (6 files mocked, zero credit burn). This is the priority pin; ship first.
- **PR-2:** Part B — hint-flow quintet (investigate first, then fix).
- **PR-3:** Part C — Settings testid sweep.
- **PR-4:** Part D — individual smalls.
- **PR-5:** Part E — silent-catch inventory (docs only).

5 PRs is more than ideal but each is small and the boundaries are clean. Open to PR-3 + PR-4 combining if both ship same day.

Pause-before-push rhythm carries from PLUMBING-01. Any load-bearing change (mock boundary decisions, shared-root diagnosis) pauses for review before commit.

---

## One thing

Every test run from now on is free, fast, and trustworthy. No more credits burned on CI. No more rotting failures. Future WOs land on green. That's it.
