# useHintSystem.test.ts Tier 3 inter-file pollution — known issue

**Status:** Deferred 2026-05-16 from WO-TEST-CLEANUP-01 Part B-2.
Test debt, not production code defect. Safe to skip until a future
session has bandwidth.

**Failing test:**
`src/hooks/useHintSystem.test.ts` — `"uses HINT_TIER_3_ADDITION on
third tap and renders an arrow"`

**Behavior:**
- Passes in isolation:
  `npm run test:run src/hooks/useHintSystem.test.ts` — green.
- Fails only when run as part of the full suite:
  `npm run test:run` — fails on the Tier 3 arrow assertion.

This is the textbook signature of inter-file pollution: a sibling
test file mutates shared module state, the mutation survives into
`useHintSystem.test.ts`, and the Tier 3 assertion breaks on the
inherited state.

## Why this isn't a P0

The test passes in isolation. The source code is correct (Tier 3
arrow rendering, `isLegalMove` guard, `HINT_TIER_3_ADDITION`, and
`hintState.arrows` all behave correctly in production and in the
isolated test). The failure is a test-suite-level interference
pattern, not a real regression. Nothing user-facing breaks.

The full suite is a CI signal. Until this is fixed the suite is
red — but the red is for a known cause that doesn't represent a
real bug. Document it, move on, fix when bandwidth allows.

## What we already know (from PR-B1 #570 diagnosis work)

1. **PR #511 (May 14 analytics backbone) is NOT the cause.**
   The original WO Part B hypothesis suspected PR #511's
   "hint-revealed audit emit" addition. PR-B1's bisection
   confirmed PR #511 was purely additive — didn't touch Tier 3
   arrow rendering, `isLegalMove` guard, `HINT_TIER_3_ADDITION`,
   or `hintState.arrows`. Future investigators: don't re-blame
   #511; the rabbit hole has been walked.

2. **The 5-failure Part B hypothesis was wrong about the shared
   root.** Part B originally bundled 5 failures under one
   suspected cause. The actual breakdown:
   - 3 surface tests (GameChapterPage, JourneyChapterPage,
     TacticSetupBoard) — caused by Part A's empty-string mock,
     fixed in PR-B1 (#570) by giving the mock non-empty text.
   - PracticeMode — caused by Part A's API leak, resolved as a
     Part A side effect (PR #568) before Part B ran.
   - useHintSystem.test.ts Tier 3 — this issue. Different root
     entirely (inter-file pollution, not the audit-emit path).

3. **`useHintSystem.test.ts` itself looks clean.** All boundaries
   are mocked at file scope: `voiceService`, `stockfishEngine`,
   `stockfishFenCache`, `appAuditor`, `coachService`. The
   `beforeEach` resets all in-memory arrays and calls
   `__resetCoachMemoryStoreForTests()` + deletes the Dexie
   `coachMemory.v1` key. `afterEach` runs `vi.clearAllMocks()`.
   On paper, isolation is correct — which is consistent with the
   isolation pass.

## Workaround for future test additions

Per Dave 2026-05-16: any future test added to a suite that fails
when run alongside `useHintSystem.test.ts` should use
`vi.resetModules()` in a `beforeEach` as a defensive measure:

```ts
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // ... other resets
});
```

This forces vitest to re-evaluate all `import` graphs per test,
which clears whatever module-level state the polluter is leaking.
It costs some test-run time but trades that against the
inter-file flake. Defensive, not investigative — doesn't identify
the polluter, just keeps new tests from joining the failure set.

## Leading theory for the actual investigation (not verified)

The `coachService.ask` mock at `useHintSystem.test.ts:86-133` does
an `await import('../stores/coachMemoryStore')` inside the mock
factory and calls
`useCoachMemoryStore.getState().recordHintRequest(args)`. That
import resolves to whatever the module cache currently holds. If
another test file has mocked or mutated `coachMemoryStore` in a
way that vitest doesn't fully reset between files, the mock
factory picks up the polluted version.

Candidate polluters to bisect first (test files that touch
coach memory state):

- `src/stores/coachMemoryStore.test.ts` — directly exercises the
  store
- `src/coach/__tests__/*.test.ts` — anything that asks the brain
  and triggers `record_hint_request` via the cerebrum tool
- `src/components/Coach/*.test.tsx` — surfaces that read coach
  memory
- `src/components/Coach/CoachChatPage.test.tsx` — known to mock
  coachService in similar shape

This is a hypothesis, not a diagnosis. Verify before fixing.

## Bisection approach when this gets picked back up

Standard inter-file pollution bisection:

1. Run `useHintSystem.test.ts` alone — confirm green
   (`npm run test:run src/hooks/useHintSystem.test.ts`).
2. Run the full suite — confirm red on the Tier 3 test
   (`npm run test:run`).
3. Binary-split: run useHintSystem with half the other test
   files, see which half causes red. Repeat on the failing half
   until one specific other file (or pair) is the polluter.
4. Once the polluter is identified, decide between:
   - **Fix the polluter** (add proper cleanup so it doesn't leak)
     — preferred if the leak is fixable in a few lines.
   - **Fix the victim** (add `vi.resetModules()` to
     useHintSystem.test.ts's `beforeEach`) — preferred if the
     polluter is hard to clean up or the leak is structural.
5. Verify by running the full suite and confirming Tier 3 is
   green.

Estimated effort: 1-2 hours including verification. Not a 2-day
expedition; just defer-eligible because there's no user-facing
harm.

## Pointers

- Reference: PR #570 (PR-B1) for the diagnosis-leading-here.
- Reference: WO doc `docs/plans/2026-05-16-test-cleanup-01.md`
  Part B section (now marked deferred).
- Reference: `src/hooks/useHintSystem.test.ts` — the failing
  test file.
- Reference: `src/hooks/useHintSystem.ts` — the source under test
  (verified correct).
- Reference: `src/stores/coachMemoryStore.ts` +
  `__resetCoachMemoryStoreForTests` — the suspected state-leak
  point.

## Why this doc exists

WO-TEST-CLEANUP-01 PR-B2 was scoped as a 2-hour bisection
investigation with the option to defer. Dave called the defer
2026-05-16 to preserve context-window budget for WO-ROLODEX-UI-01
(the biggest creative build of this arc, which gets a fresh
session). This doc is the handoff package: future-us reads it
cold and has a non-zero starting point.
