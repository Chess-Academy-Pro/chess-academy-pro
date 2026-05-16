# 2026-05-16 — Coach × Master-Play Integration (WO-COACH-MASTER-INTEGRATION)

**Branch:** `claude/coach-master-integration`
**WO source:** chat handoff 2026-05-16 ("WO-COACH-MASTER-INTEGRATION — DB-grounded coach…")
**Why this WO:** Runtime instrument of CLAUDE.md gate G3 — "no chess content invented from memory." Today the coach can hallucinate move SANs, master-game frequencies, player attributions, and "what masters play" claims. This WO closes that gap with four cooperating layers (watcher / pre-inject / tool / claim-validator) wired across every coach-invoking surface.

---

## Open findings (running list — append as you go)

- [ ] No master-play lookup exists yet. `lichessExplorerService.fetchLichessExplorer` is the only path to master games and it is per-call, network-bound, and not pre-warmed.
- [ ] `src/data/openings-lichess-extended.json` is a 3-byte empty placeholder (`[]`). Parallel workstream `claude/openings-db-enrichment` is populating it. Our code MUST treat empty-file as "all local misses" with graceful fallback to live Lichess.
- [ ] `getCoachStructuredResponse` already exists for FORCED tool use. For Layer C we need OPTIONAL tool use + multi-turn tool-result loop, which is new code — not just a wrapper over the existing helper.
- [ ] `getKidLlmResponse` (coachApi.ts:1002) is the kid lane. Stays UNTOUCHED. Watcher must not mount on `/kid/*`; tool schema must NOT include `lookup_master_play` for kid calls.

---

## Architecture spine

```
              [game state change]
                      │
                      ▼
        ┌─────────────────────────┐
        │  masterPlayWatcher.ts   │  Layer A: silently prefetches
        │  (subscribes to FEN +   │  current FEN + top-3 children,
        │   walkthrough advances) │  populates LRU cache.
        └────────────┬────────────┘
                     │
                     ▼
           ┌──────────────────┐
           │  masterPlayCache │  in-memory LRU, keyed by position-FEN
           └────────┬─────────┘
                    │ (sync read)
                    ▼
   ┌────────────────────────────────────┐
   │   coachApi: getCoachChatResponse   │
   │                                    │
   │   Layer B: pre-injection           │  ← intent-detect user msg
   │   (reads cache for current FEN +   │     for move-question
   │    look-ahead, injects             │
   │    masterPlayContext into system   │
   │    prompt)                         │
   │                                    │
   │   Layer C: tool available          │  ← LLM may call
   │   (lookup_master_play schema,      │     lookup_master_play(fen)
   │    multi-turn tool-result loop)    │     for follow-up positions
   │                                    │
   │   Layer D: claim validator gate    │  ← scans output, regenerate
   │   (post-response, up to 2 retries) │     if ungrounded; stock
   │                                    │     fallback after budget
   └────────────────┬───────────────────┘
                    │
                    ▼
           [response to user]

              [cache miss locally]
                      │
                      ▼ (only if navigator.onLine)
        ┌─────────────────────────┐
        │  lichessExplorerService │  ~200-600 ms latency
        └────────────┬────────────┘
                     │
                     ▼
              [populate cache, return]
```

---

## Files

### New services
- `src/services/masterPlayLookup.ts` — resolver. Lazy-loads `openings-lichess-extended.json`. Local→live routing via `lichessExplorerService`. Position-FEN normalization (strip halfmove + fullmove). Emits `master-play-lookup` audit events.
- `src/services/masterPlayCache.ts` — in-memory LRU (~1000-entry cap) + in-flight promise map for dedup. Sync `get(fen)`, async `awaitInFlight(fen)`.
- `src/services/masterPlayWatcher.ts` — subscribes to coach-surface game state. On every FEN change, prefetches current + top-3 children. Throttle (max 6 concurrent), dedup against cache + in-flight map. Kid routes explicitly excluded — surface registry. Emits `master-play-prefetch`.
- `src/services/claimValidator.ts` — post-response scanner. Extracts SAN tokens, numeric claims (percentages, game counts, ratings), named entities (players, years, openings), comparative phrases. Each validated against the most recent master-play context. Returns `{ ok, violations: [...] }`. Emits `claim-validator-trip` per violation.
- `src/hooks/useMasterPlayWatcher.ts` — React hook. Mount on coach surfaces (not kid). Reads game state via existing hooks/stores, drives `masterPlayWatcher.update()`.

### Test fixtures
- `src/test/fixtures/masters-test-db.json` — synthetic mini-DB with ~10 positions for unit/integration tests. Covers Italian Game, Pirc Defence, Ruy Lopez, Sicilian Najdorf.

### Audit
- `scripts/audit-coach-master-integration.mjs` — cross-surface Playwright audit. Sandbox runbook (local dev server + pre-installed Chromium).

### Edits
- `src/services/coachApi.ts` — pipeline integration:
  - Layer B: intent-detect at entry of `getCoachChatResponse`; if move-question, read cache for current FEN + look-ahead children, inject `masterPlayContext` block into system prompt.
  - Layer C: when intent is move-question, take the **non-streaming tool-aware path** (new helper `callChatWithOptionalTool`) so the LLM can call `lookup_master_play(fen)` for follow-up positions. Multi-turn loop: LLM emits tool_use → we execute via `masterPlayLookup` → send tool_result → LLM emits final text. Streaming surface unchanged for non-move-question turns.
  - Layer D: post-response, call `claimValidator.validate(response, contextThisTurn)`. On violation: regenerate with strengthened system addendum (max 2 retries). On budget exhaustion: emit `master-play-enforcement-fallback`, return stock "I can't verify which moves are sound — try analyzing with the engine."
  - System-prompt addendum (always-on when masterPlayContext present): "When recommending moves, discussing what to play, citing frequencies/ratings/player names/years, or making comparative claims about master practice — you MUST ground each such claim in the masterPlayContext data provided (or call lookup_master_play for additional positions). Never invent or guess move popularity, game counts, ratings, player attributions, or 'what masters play' figures. If the data isn't available, say so explicitly."
- `src/services/appAuditor.ts` — extend `AuditKind` union: `master-play-prefetch`, `master-play-lookup`, `claim-validator-trip`, `master-play-enforcement-fallback`.

### Surface wiring (10 coach surfaces, kid excluded)
- `/coach/teach` — `CoachTeachPage` (Learn with Coach)
- `/coach/play` — `CoachGamePage`
- `/coach/chat` — `CoachChatPage`
- `/coach/review` — review surfaces
- `/coach/plan` — `CoachPlanPage`
- `/coach/analyse` — `CoachAnalysePage`
- `/coach/train` — training recommendations
- `/coach/home` — hub-level asks via SmartSearchBar
- `/openings/:id` — walkthrough chat panel
- `SmartSearchBar → ask coach` — global

### Docs
- `docs/AUDIT_INDEX.md` — new row pointing at the audit script.
- `CLAUDE.md` — three updates:
  1. §DON'T BREAK THESE — add coach grounding pipeline as a runtime instrument of G3.
  2. §audit-stream G2 runtime-paths list — add the four new audit kinds.
  3. §Post-Deploy Audit matrix — add the new audit script under "coach surfaces (any)".

---

## Phased plan (within one PR `claude/coach-master-integration`)

The WO spec is large enough that some phases ship as scope-deferred to v1.1 if v1 ships solid and v1.1 ships next session. Marked accordingly.

### Phase 1 — Foundations (v1) — **in progress**
Status markers: `pending` / `in progress` / `done` / `deferred`

| Step | Status | Notes |
|---|---|---|
| Branch + PLAN.md committed to main | in progress | this file |
| `masterPlayCache.ts` + unit tests | pending | LRU + in-flight dedup |
| `masterPlayLookup.ts` + unit tests | pending | local→live, offline guard, audit emit |
| `masters-test-db.json` fixture | pending | ~10 positions for unit/integration |
| `claimValidator.ts` + unit tests | pending | SAN/numeric/entity/comparative |
| `masterPlayWatcher.ts` + unit tests | pending | throttle, dedup, kid-excluded |
| `appAuditor.ts` — extend `AuditKind` | pending | 4 new kinds |

### Phase 2 — Brain integration (v1) — **pending**

| Step | Status | Notes |
|---|---|---|
| Layer B (pre-injection) into `getCoachChatResponse` | pending | intent regex + cache read + prompt-block builder |
| Layer D (claim validator + retry) into `getCoachChatResponse` | pending | scan → 2 retries → stock fallback |
| `coachApi.master-integration.test.ts` (Layer B + D) | pending | uses fixture, real services, no `vi.mock` of new services |

### Phase 3 — Tool-use (Layer C) (v1) — **pending**

| Step | Status | Notes |
|---|---|---|
| `callChatWithOptionalTool` helper (Anthropic non-streaming) | pending | not forced; handles tool_use blocks |
| Multi-turn tool-result loop (Anthropic) | pending | LLM emits tool_use → execute → send tool_result → final text |
| `callChatWithOptionalTool` helper (DeepSeek non-streaming) | pending | OpenAI-compatible function-calling, optional |
| Multi-turn tool-result loop (DeepSeek) | pending | same shape |
| Integration tests for tool path (both providers) | pending | use fixture; assert tool called, result returned |

### Phase 4 — Surface wiring (v1, scope-by-surface) — **pending**

| Surface | Status | Notes |
|---|---|---|
| `/coach/chat` | pending | start here — smallest surface |
| `/coach/teach` | pending | inline chat panel — verify walkthrough state doesn't fight watcher |
| `/coach/play` | pending | live game — frequent FEN updates |
| `/coach/review` | pending | LATER if time |
| `/coach/plan` | pending | LATER |
| `/coach/analyse` | pending | LATER |
| `/coach/train` | pending | LATER |
| `/coach/home` | pending | LATER |
| `/openings/:id` | pending | LATER |
| `SmartSearchBar` | pending | LATER — global, may be deferred to v1.1 |

### Phase 5 — Audit (v1) — **pending**

| Step | Status | Notes |
|---|---|---|
| `audit-coach-master-integration.mjs` skeleton | pending | mirrors `audit-coach-chat.mjs` |
| Per-surface scenarios (Chat / Teach / Play) | pending | watcher proof, intent variants, follow-up, validator-trip, negative, offline, stock-fallback |
| Kid counter-tests | pending | NO master-play events on `/kid/*` |
| Provider scenarios (Anthropic + DeepSeek) | pending | force each path |
| Performance budget scenarios | pending | cache-hit ratio + latency p95 |
| Wire into `docs/AUDIT_INDEX.md` and CLAUDE.md matrix | pending |

### Phase 6 — Ship (v1) — **pending**

| Step | Status | Notes |
|---|---|---|
| `npm run typecheck` clean | pending |
| `npm run lint` clean | pending |
| `vitest run` new tests green; baseline regressions unchanged | pending |
| Local Playwright audit green for wired surfaces | pending |
| Open PR | pending |
| Squash-merge | pending |
| Post-deploy audit against prod | pending |
| `GET /api/audit-stream` confirms new event kinds firing in prod | pending |

---

## Decisions log

- **2026-05-16 — Streaming surface unchanged for non-move-question turns.** Move-question intent (regex match) triggers the non-streaming tool-aware path. Casual chat keeps the existing streaming surface. Rationale: streaming + multi-turn tool use is significantly more complex than non-streaming + multi-turn. Move questions are lower-frequency than chitchat and the latency hit is acceptable; the upside is a vastly simpler implementation that still satisfies all four enforcement layers.
- **2026-05-16 — Look-ahead depth = 1 ply, 3 candidates (constant `MASTER_PLAY_LOOKAHEAD_DEPTH`).** Matches WO. Configurable knob for future tuning. Walkthrough surfaces optionally prefetch the entire remaining sequence (positions deterministic).
- **2026-05-16 — In-memory LRU only; no Dexie persistence.** v1 scope per WO. Cold-start latency tax acceptable; revisit if telemetry shows pain.
- **2026-05-16 — Empty `openings-lichess-extended.json` (parallel workstream not merged) treated as universal local-miss.** No errors, no warnings — silent fallback to live Lichess. This decouples our merge from theirs.
- **2026-05-16 — Provider tool schemas mirror existing helpers.** Anthropic uses `tools: [{ name, description, input_schema }]` without `tool_choice` for optional use. DeepSeek uses `tools: [{ type: 'function', function: {...} }]` without `tool_choice`. Both providers natively support optional tools.

---

## Sequencing logic — why this order

1. **Cache + Lookup + ClaimValidator + fixture first** — all four are leaves with no upward dependencies. Can be built and unit-tested in isolation. The fixture lets every later test use the same canonical data.
2. **Watcher next** — depends on Cache + Lookup but no `coachApi` changes. Unit-testable in isolation.
3. **Layer B + D in coachApi** before Layer C — pre-injection alone catches a huge fraction of move questions (the LLM has the data inline; it doesn't need to call the tool). Claim validator catches the LLM lying about it. Together, these two layers cover ~80% of the user-visible value with much less code surface than Layer C.
4. **Layer C last (but in v1)** — tool-use loop is the most invasive change to `coachApi.ts`. Doing it last means the integration tests for Layers B + D are stable when we touch the new code path.
5. **Surface wiring after brain integration** — surfaces just call `useMasterPlayWatcher(surface)`; the heavy lifting is in services + coachApi. Adding surfaces is mechanical.
6. **Audit script last** — surfaces must be wired before the audit can exercise them.

---

## Next-session pickup (if work pauses mid-WO)

1. Check this file's phase status markers — find the next `pending` row.
2. `git checkout claude/coach-master-integration && git pull origin claude/coach-master-integration`.
3. `npm run typecheck` to confirm the branch is in a buildable state before continuing.
4. Continue from the next pending step. Update phase markers as you complete steps.
5. When all v1 phases done: open PR, squash-merge, post-deploy audit, archive this plan to `docs/plans/<merge-date>-coach-master-integration-final.md`.

---

## Out of scope (deferred / separate WO)

Per the WO's "Out of scope" section — explicitly NOT in this plan:
- Stockfish-paired evaluation alongside master statistics in coach prose
- Games-attribution DB for player/year claims (separate Lichess-dump-derived DB)
- Deeper than 10-ply enrichment of the local DB (controlled by parallel workstream)
- Cross-session cache persistence (Dexie-backed)
- Master-play stats visible in the openings tab UI
- Strategic prose validation (LLM-judge pass for non-SAN recommendations)
- In-game live-tournament data
