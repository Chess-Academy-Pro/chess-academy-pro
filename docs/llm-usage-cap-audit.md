# LLM usage-cap audit — chokepoints + design decisions

**Status:** audit only. Not implemented. Beta will collect real per-user
usage data before David decides on cap thresholds and behavior.

**Goal:** when the moment comes, we want to add per-user (or per-account)
LLM rate-limiting and monthly-spend caps with ONE chokepoint, not a
scatter of feature-flag gates across every surface. This doc names that
chokepoint and lists the decisions David has to make.

---

## TL;DR

- All LLM traffic funnels through **`src/services/coachApi.ts`**.
- Inside, four functions actually hit the wire: `callDeepSeek`,
  `callDeepSeekStream`, `callAnthropic`, `callAnthropicStream`. Plus
  two tool-use variants: `callAnthropicWithTool`, `callDeepseekWithTool`.
- Each of them calls **`recordApiUsage(task, model, inputTokens, outputTokens)`**
  in `src/services/coachCostService.ts` after the response returns.
  That's already where token usage gets persisted.
- The cap hook lives **right next to `recordApiUsage`** but on the
  pre-call side: a new `checkUsageCap(task, model, estimatedMaxTokens)`
  that throws `UsageCapExceededError` before we send the request. The
  six call sites above each `await checkUsageCap(...)` at the top of
  the function, before constructing the client.
- A single error type means every surface can catch it and render a
  consistent "you've hit your cap" UI without each one re-implementing
  the check.

That's the whole architecture. The implementation work is mostly
deciding policy (cap thresholds, soft-vs-hard, billing window) and
plumbing the error to the UI — not finding more chokepoints.

---

## Why it's already single-chokepoint

When we audited LLM call sites, every entry point — coach chat, hint
button, walkthrough narration generator, opening overview generator,
stage gen (concepts/findMove/drill/punish), middlegame planner,
sideline explainer, smart search, intent classifier, kid puzzle
narration, model-game commentary, weakness report — eventually calls
one of:

| Function | File | Purpose |
|---|---|---|
| `callDeepSeek` | `src/services/coachApi.ts:432` | Plain DeepSeek chat |
| `callDeepSeekStream` | `src/services/coachApi.ts:374` | Streaming DeepSeek |
| `callAnthropic` | `src/services/coachApi.ts:514` | Plain Anthropic Messages |
| `callAnthropicStream` | `src/services/coachApi.ts:476` | Streaming Anthropic |
| `callAnthropicWithTool` | `src/services/coachApi.ts:555` | Anthropic tool-use |
| `callDeepseekWithTool` | `src/services/coachApi.ts:665` | DeepSeek tool-use |

Nothing outside `coachApi.ts` constructs an `OpenAI` or `Anthropic`
client. ESLint enforces this implicitly because the SDKs are only
imported from that file (per CLAUDE.md "Do NOT" rule: `Import from
'openai' anywhere except 'src/services/coachApi.ts'`).

**Verification:** `grep -rn "messages\.create\|chat\.completions\.create"
src/` should only hit `coachApi.ts`. Confirmed clean today.

---

## The hook (proposed shape, not yet written)

```ts
// src/services/llmUsageCap.ts (NEW)

export class UsageCapExceededError extends Error {
  constructor(
    public readonly kind: 'daily-cost' | 'monthly-cost' | 'daily-requests',
    public readonly currentValue: number,
    public readonly capValue: number,
  ) {
    super(`LLM usage cap exceeded (${kind}): ${currentValue} / ${capValue}`);
    this.name = 'UsageCapExceededError';
  }
}

/** Called before every wire-level LLM request. Throws if the user
 *  would breach a cap. Caps are read from the user profile so each
 *  user has their own thresholds. */
export async function checkUsageCap(
  task: string,
  model: string,
  estimatedMaxTokens: number,
): Promise<void> {
  // 1. Read profile.preferences.{monthlyBudgetCap, dailyRequestCap?,
  //    dailyCostCap?}.
  // 2. Read today's + this-month's accumulated spend + request count.
  // 3. Add the estimated cost of this call (max-tokens × output price
  //    for the given model). Compare against caps.
  // 4. Throw UsageCapExceededError if any cap is breached.
  // 5. Optionally log a soft-warning audit event when within 80% of cap.
}
```

Each of the six wire-level functions adds one line at the top:

```ts
async function callDeepSeek(apiKey, model, messages, maxTokens, task) {
  await checkUsageCap(task, model, maxTokens);  // ← only new line
  const client = new OpenAI({ ... });
  // ... unchanged
}
```

`UsageCapExceededError` bubbles up through every existing chain
(`getCoachChatResponse`, `getCoachStructuredResponse`, etc.) and the
surfaces catch it the same way they catch any thrown error today —
just with a specific rendering ("You've hit your monthly cap — bump
it in Settings or wait until the cycle resets").

---

## What's already half-wired

We already have part of this scaffolding from an earlier "cost
awareness" pass:

- `UserProfile.preferences.monthlyBudgetCap: number | null` — surfaced
  in Settings. Defaults to `null` (no cap).
- `UserProfile.preferences.estimatedSpend: number` — incremented by
  `recordApiUsage` after each call.
- `getMonthlySpend()` and `getBudgetStatus()` in `coachCostService.ts`
  expose the running spend and cap-percent. **Currently informational
  only — nothing gates on them.**
- Settings page (`SettingsPage.tsx:707, 781, 895`) lets the user set
  the cap and see "Estimated spend this month: $X.XX". No enforcement.

So when David decides to flip the switch, we're already halfway home:
the spend tracker is live, the budget setting exists, the UI surfaces
the number. We just need:

1. The pre-call check (new `llmUsageCap.ts` module).
2. UI to render `UsageCapExceededError` cleanly (a banner or modal in
   AppLayout would catch it globally for any uncaught case; surfaces
   that already do their own error handling can render an inline state).
3. A reset mechanism — when does the "monthly" counter zero out?
   `estimatedSpend` is never reset today; it's a lifetime accumulator
   despite the field name. (See "Decisions" #3 below.)

---

## Decisions David needs to make (before implementing)

### 1. Hard cap vs soft cap vs both?

- **Hard cap:** request throws, surface shows "you've hit your cap."
- **Soft cap:** 80% threshold → toast warning, but call proceeds.
  Hard cap fires at 100%.
- **Recommendation:** both. Soft warning at 80% so the user has
  agency to adjust before getting blocked mid-task. Hard cap at 100%.

### 2. What dimension(s) to cap?

Options (any subset):
- **Monthly $ spend** — what `monthlyBudgetCap` already represents.
- **Daily request count** — protects against runaway loops (a bug
  that keeps re-firing chat queries shouldn't burn $50 in a day).
- **Daily $ spend** — same protection, finer-grained.
- **Per-task quotas** — "10 chat responses per day; unlimited hints."
  More complex, probably premature.

**Recommendation:** monthly $ + daily request count. Two dimensions
catch both "I'm spending too much over time" and "something is
clearly looping right now."

### 3. When does the cycle reset?

- **Calendar month** (1st of month, 00:00 user local): simplest. Bills
  align with calendar.
- **Rolling 30-day window**: fairer (no "spend it all in the last
  week of the month" effect) but harder to explain.
- **Subscription renewal date**: only matters once paid plans exist.

**Recommendation:** calendar month for v1, switch to renewal-aligned
when paid plans go live. Bonus: zero `estimatedSpend` on the 1st via
a check inside `recordApiUsage` against a stored `currentBillingMonth`
field. Cheap to add.

### 4. What does the user see when they hit the cap?

Two views:

- **In-surface error** (chat field, hint button, walkthrough kickoff):
  inline message "You've hit your monthly cap. Adjust in Settings."
- **Global modal**: a one-time modal the first time a session hits
  the cap, with quick actions (raise cap, view usage breakdown).

**Recommendation:** in-surface inline. Modals are intrusive and the
user is already aware they're using LLM features when they hit one.

### 5. Pre-call cost estimation: precise or rough?

Pre-call we know `model` and `max_tokens`. We DON'T know input-token
count until we tokenize the prompt (and SDK adds system message,
tool schemas, etc.). Options:

- **Worst case:** assume max_tokens for both input AND output, use
  that for cap check. Conservative, may over-block.
- **Heuristic:** estimate `inputTokens = systemPrompt.length / 3` +
  message lengths. Reasonable approximation.
- **Post-hoc only:** don't pre-check; only cap on accumulated spend
  AFTER the call. Cheap to implement but allows one over-cap call.

**Recommendation:** heuristic for daily-request cap (no estimation
needed, just count). Post-hoc accumulation check for $ caps — the
worst case is one extra call past the cap, which is fine. This also
sidesteps the "tokenize on every call" perf hit.

### 6. Beta data we need to collect before deciding thresholds

This is the audit's headline conclusion: **we don't know what to set
the caps to yet.** From a single-user app to a multi-user paid app
we need to see real usage curves before committing to numbers.

Things to log per user during beta:
- Daily request count + breakdown by `task` (which features burn the
  most calls?).
- Daily $ cost + monthly accumulator.
- Distribution of `max_tokens` vs actual `output_tokens` (overshoot
  ratio — informs whether worst-case pre-check would over-block).
- Time-of-day distribution (any runaway loops show as spikes).

`recordApiUsage` already writes one Dexie meta row per call with
task/model/tokens. We just need a beta-only "phone home" pipe (or
ask testers to export their usage via Settings) to aggregate across
users. Sketch:

```ts
// In Settings, add an "Export usage data" button that dumps the
// last 30 days of api_usage_* meta entries as JSON. Testers send
// the JSON to a Sheet / Notion / Supabase table. We eyeball the
// p50/p95/p99 of daily spend and pick thresholds from there.
```

That's the work to do BEFORE writing `llmUsageCap.ts`.

---

## Open implementation notes

- **Provider fallback bypasses the cap if naïve.** The fallback chain
  at `coachApi.ts:782` re-calls a different provider if Anthropic
  401s/429s. If we check the cap once at the entry point, the
  retry-on-DeepSeek call wouldn't re-check. Fix: have the cap-check
  live inside the wire-level functions (`callDeepSeek`, etc.), not
  at the higher-level orchestration. That's what the proposed shape
  above already does.
- **Walkthrough generation is multi-call.** A single "Teach me Sicilian"
  request fires N LLM calls (one per move). If the user blows the cap
  halfway through, the walkthrough is left half-rendered. Two options:
  (a) check the cap once up-front for the full estimated cost; (b) let
  individual calls fail and partial-render. (b) is simpler and
  probably fine for v1 — the walkthrough already has fallback prose
  for un-narrated moves.
- **Audit-stream events should fire on every cap event** (soft warning
  + hard block) so we can spot users hitting caps in production. Add a
  `kind: 'llm-cap-event'` audit category.
- **Server-side caps too?** The `/api/audit-stream`, `/api/lichess-explorer`
  endpoints don't call LLMs directly, but if we ever add a server-
  side LLM gateway (e.g. to keep API keys off the client), the cap
  check has to live there. Out of scope for v1.

---

## Verification when implementation lands

A new test file `src/services/llmUsageCap.test.ts` should cover:
- No cap set → checkUsageCap is a no-op.
- Monthly cap reached → throws `UsageCapExceededError(kind: 'monthly-cost')`.
- Daily request count exceeded → throws with kind `'daily-requests'`.
- Soft-warning threshold (80%) emits an audit but doesn't throw.
- Cycle reset on the 1st zeros out the monthly counter.
- Multiple concurrent calls don't race past the cap (a sequential
  reservation pattern via the Dexie counter is enough; Dexie writes
  are serialized per-store).

And an e2e Playwright spec that sets a $0.01 cap in Settings, fires
two coach chat queries, asserts the second one shows the cap-exceeded
UI.

---

## Bottom line

**Architecture is ready. Policy isn't.** The chokepoint is six
functions in one file. The hook is one new module + one line per
function. The blocker is beta usage data to know where to set the
thresholds. Don't ship the cap until we have a week or two of
multi-user data.
