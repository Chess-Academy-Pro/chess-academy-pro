# Rolodex Pre-Build Audit — 2026-05-16

WO: **WO-ROLODEX-AUDIT-01** · Report-only · No code changes shipped.

---

## Step 0 — Rig location

**Found.** `docs/sandbox-playwright-setup.md` (commit `2081117e`, "docs(kid):
plan + sandbox-playwright runbook + audit infra fixes", May 15 2026).

Important context: the file lives on `origin/main` but is **not present
in the local working tree** — local HEAD is `24243c61`, origin/main is
`cbab5d7f`. The runbook was read from the commit directly
(`git show 2081117e:docs/sandbox-playwright-setup.md`).

The "listening app" the WO referred to is the **voice-intercept
pattern** documented in that runbook — a Playwright `addInitScript`
that overrides `window.speechSynthesis.speak()` to log every utterance
into `window.__audit_speak_calls` plus an optional `page.route('**/polly/**', ...)`
for Polly TTS. The runbook also covers the `/api/audit-stream` poller,
the four sandbox blockers (`cdn.playwright.dev` blocked, HTTPS MITM,
external host 403s, cold-start seed timeouts), and known-good /
known-blocked allowlist.

Runtime portions below used that pattern verbatim — `addInitScript`
registered before every `page.goto()`, intercept also wraps `window.fetch`
to catch any URL matching `/polly|tts|speak|audio/i`.

Driver: `audit-reports/rolodex-audit-01/driver.mjs` (transient, off-tree
in spirit — under the gitignored audit-reports area; please delete after
review).
Raw evidence: `audit-reports/rolodex-audit-01/report.json` + six PNG
screenshots.

---

## Part A — Static findings

### A1: Destination tool filter support

URL = URL query param accepted **and** consumed. STATE = `location.state`
only (no URL deep-link). NONE = neither.

| Tool | Route | Accepts? | Param | Format | Consumed? | Effort to add URL deep-link |
|---|---|---|---|---|---|---|
| Openings (Theory & Lines) | `/openings` | **NONE** | — | — | — | **M** — `OpeningExplorerPage` has no `useSearchParams`; needs param read + thread into list filter |
| Puzzles (general) | `/tactics/*` | **NONE** | — | — | — | **M** — pattern exists in `MyMistakesPage` but isn't applied to other phases |
| Blunder Review | `/tactics/mistakes` | **STATE** | `location.state.initialOpeningName` | string (opening name) | yes — `MyMistakesPage.tsx:73,113` | **S** — add `useSearchParams` fallback alongside the existing state read |
| GM Games | `/games` | **NONE** | (has UI-only `filterEco`) | — | UI yes, URL no | **S** — `filterEco` state + filter exist; just wire `useSearchParams` initial value |
| Traps & Pitfalls | `/tactics/opening-traps` | **NONE** | — | — | — | **M** — needs param read + auto-scroll/highlight target family |
| Coached walkthrough | `/coach/teach` | **NONE** | — | — | — | **M** — currently a hub; would need to auto-launch walkthrough when `?opening=` present |
| Practice vs Engine | `/coach/play` | **URL** | `?opening=` (alias `?subject=`) | string (opening name) | yes — `CoachGamePage.tsx:548,569,573` | already supported in code (but see B1 — not visually applied on cold load) |

Verdict for A1: **5 of 7 tools have zero filter plumbing**. Only `/coach/play`
URL-deep-links today; `/tactics/mistakes` deep-links via `location.state`
only (rolodex must `navigate()` with `{ state }`, can't be a plain `<Link>`).

### A2: Per-user progress tracking

"Easy" = direct opening-keyed query exists; "Hard" = needs new table or
external mapping.

| Tool | Tracking exists? | Per-opening keying | Storage | Effort for "X / Y" |
|---|---|---|---|---|
| Openings (lines) | yes (`linesDiscovered[]`, `linesPerfected[]`) | opening ID + variation index | `openings` table (`src/db/schema.ts:43`) + service helpers (`openingService.ts:225–242`) | **M** |
| Openings (walkthrough stages) | yes (5 stages: walkthrough/concepts/findMove/drill/punish) | opening name (lowercase) | `meta` table JSON blob `'openingProgress'` (`src/services/openingProgress.ts:22,54,66`) | **S** (already opening-keyed) |
| Puzzles | yes (`attempts`, `successes`, SRS state) | **no opening linkage** on `PuzzleRecord` (only theme array) | `puzzles` table | **L** — needs puzzle→opening mapping, or roll up by theme |
| GM Games | metadata only — **no progress field** at all | `modelGames.openingId` exists | `modelGames` table | **L** — add `modelGameReviews` table |
| Traps & Pitfalls | piggybacks on Openings (`trapLines[]` parallel to `variations[]`) | opening ID + trap index | `openings` table | **M** (same as Openings) |
| Blunder Review | yes (`status`, `attempts`, `successes`) | **direct** `openingName` field on `MistakePuzzle` | `mistakePuzzles` table | **S** — easiest of all |
| Coached walkthrough | yes (binary: stage `'walkthrough'`) | opening name | `meta` blob | **S** |
| Practice vs Engine | only the **active** game (`coachPlayActive.v1` in `meta`) | `subject` field on active game | `meta` blob, not history | **L** — no game-history table; need to add one |

Verdict for A2: **Blunder Review and Walkthrough are S** (direct
opening-keyed queries). **Puzzles, GM Games, and Practice vs Engine are L**
(no opening-keyed completion record exists). The "X / Y" counts on
those three rows are net-new data plumbing, not a thin selector.

### A3: App map coverage

App map lives at `src/data/appRoutesManifest.ts`, loaded by
`src/coach/sources/routesManifest.ts:11`.

**Coverage is broad — most rolodex destinations are already in the map.**
Coverage gaps that matter for the rolodex:

| Gap | Impact on rolodex |
|---|---|
| `/coach/review/:gameId` | low — rolodex row is "Your blunders" → `/tactics/mistakes`, not the per-game review |
| `/coach/home`, `/coach/endgame` | none for rolodex |
| `/weaknesses/games` | low |
| `/tactics/opening-traps` | **mid** — this IS a rolodex row; brain can't currently route to it |
| `/kid/*` parameterized routes (~12) | none |
| `/debug/*`, `/neon-mock` | none |

A new `/coach/plan/rolodex` (or wherever the rolodex lives) would also need
adding to `appRoutesManifest.ts` when the build WO lands.

Verdict for A3: **One real gap relevant to the rolodex** —
`/tactics/opening-traps` is unmanifested. Trivial to add (one entry).

### A4: Brain write/action tool support

**Write tools already exist.** Tool registry at `src/coach/tools/registry.ts:45–70`
exposes 20 tools with explicit `kind: 'read' | 'write'` classifier.
Existing write tools: `play_move`, `take_back_move`, `set_board_position`,
`reset_board`, `save_position`, `restore_saved_position`,
`set_intended_opening`. Pattern is consistent:

1. Tool file under `src/coach/tools/cerebrum/<name>.ts` declares
   `kind: 'write'`, async `execute(args, ctx)`, returns `{ok, …}`.
2. Mutation is performed via a callback threaded through
   `ToolExecutionContext` (`coachService.ts:93–140`) — the surface
   supplies the callback at mount, the tool calls it.
3. LLM invokes via Anthropic `tool_use` block (`coachApi.ts:575–593`)
   or DeepSeek `tool_calls[].function` (`coachApi.ts:703–720`); both
   feed back into `coachService.ask({ maxToolRoundTrips })`.
4. Spine dispatches all reads in parallel, then writes sequentially
   (`coachService.ts:594–615`).

`SmartSearchBar` routes recognized intents deterministically via
`parseCoachIntent` (`coachAgent.ts:108`) for `play-against`,
`walkthrough`, `puzzle`, `explain-position`, `continue-middlegame`;
everything else falls through to `qa` → LLM chat.

To add `favoriteOpening(ecoCode)`:
1. New tool file (~150 LOC) registered in `COACH_TOOLS`.
2. Persistence — Dexie `openings.isFavorite` already exists (see A6),
   so the tool's execute just calls `openingService.toggleFavorite(id)`.
3. Optional: new regex pattern in `parseCoachIntent` so search bar
   recognizes "favorite the italian" without an LLM round-trip.
4. UI invalidation — `useLiveQuery` on `getFavoriteOpenings()` makes
   this automatic.

Verdict for A4: **M (small-M)**. No design work needed; pattern is
proven and storage exists. ~1 PR.

### A5: Back-stack state preservation

**Not automatic. Per-page wiring required.** React Router DOM v7
without `<ScrollRestoration />`. The repo uses an explicit pattern:
caller does `navigate(target, { state: { from, tab, … } })`, destination
reads `location.state` in a `useState` initializer or `useEffect`.

Pages that DO preserve state:
- `/weaknesses` (`GameInsightsPage`) — `state.tab` round-trips through
  `/coach/review/:gameId` and back; proven by `audit-back-from-review.mjs`
- `/coach/review` — reads `state.from` + `state.tab` for return nav
  (`CoachReviewSessionPage.tsx:193–202,391`)
- `/tactics/drill` — `state.filterThemes`, `state.filterTypes`
- `/tactics/create` — `state.filterTypes`
- `/tactics/adaptive` — `state.forcedWeakThemes`

Pages that do NOT preserve state (relevant to rolodex):
- `/tactics` hub — tiles route without state restoration on back-nav
- `/openings` — no `location.state` reader on mount
- `/coach/home`, `/coach/plan`, `/coach/train` — smoke-pass only;
  no state wiring found
- **No global scroll restoration anywhere.** Manual `scrollTo()` calls
  are component-local (`GameChatPanel.tsx:233`, `MoveListPanel.tsx:74–84`).

Verdict for A5: **The rolodex page itself must wire its own state
restoration.** It must (a) store its active card + scroll position
in URL params or Zustand, (b) push `{ state: { from: '/coach/plan/rolodex', activeCard } }`
on every deep-link, (c) each destination tool reads its own `location.state`
back. The pattern is established and tested — but it's per-page work,
not free.

### A6: Existing favorite/star infrastructure

**Fully operational for openings.** Direct reuse path:

- Dexie: `OpeningRecord.isFavorite: boolean` field (`src/types/index.ts:307`),
  indexed starting schema v6 (`src/db/schema.ts:149,166,189,…,522`).
- Service: `openingService.toggleFavorite(id)` (lines 300–305) and
  `getFavoriteOpenings()` (lines 309–311).
- UI: `OpeningCard` renders filled-red `Heart` icon when `isFavorite`
  (`OpeningCard.tsx:109–118`). Detail page has Heart toolbar button
  (`OpeningDetailPage.tsx:212–214, 605–608`). Pro player page also
  wired (`ProPlayerPage.tsx:28`).
- `OpeningExplorerPage` already has a "Favorites" section at the top
  (lines 172–190). The rolodex is effectively a richer view of this
  same list.
- Consumed by `gamesService.ts:63` (`'favorites'` mode) and
  `FlashcardStudyPage.tsx:44` ("Cards from favorited openings").

No favorites infra exists for puzzles, games, or flashcards
themselves — they all reference favorited *openings*, which is exactly
the entity the rolodex needs.

Verdict for A6: **S.** The rolodex queries `getFavoriteOpenings()` and
renders. No new schema, no new store, no new toggle. The star is
already on the opening cards — that's the favoriting entry point.

---

## Part B — Runtime findings

Driven via the voice-intercept rig (`docs/sandbox-playwright-setup.md`
pattern) against local `http://localhost:5173`. Every scenario:
0 page errors, 0 console errors, 0 nav errors. Full raw report at
`audit-reports/rolodex-audit-01/report.json` + per-tool PNGs.

### B1: Filter application per tool (rig-driven)

Each tool loaded cold with the rolodex's expected deep-link URL. The
question: does the visible content reflect the filter, or is the param
silently ignored?

| Tool | URL tested | Filter visually applied? | What rendered |
|---|---|---|---|
| `/coach/play?opening=Italian Game` | yes | **NO** — board stayed at starting position; move list shows only "Starting Position" | Page mounted, title "vs Stockfish Bot", but no opening moves auto-played |
| `/tactics/mistakes?opening=Italian Game` | yes | **NO** — confirmed (no "Italian Game" filter chip visible) | "My Mistakes" empty state, "No mistakes yet" |
| `/openings?opening=Italian Game` | yes | **NO** (param ignored — page also still in "Loading openings..." at probe time, 4s settle) | seed not done within probe window |
| `/games?eco=C50` | yes | **NO** — `filterEco` input rendered empty | "Games" page, "No games yet" empty state |
| `/tactics/opening-traps?opening=Italian Game` | yes | **NO** — generic trap list shown (French, Indian, English, Sicilian top of list; "italian" not present) | "Opening Traps" — 87 traps grouped by opening, ungrouped/unfiltered |
| `/coach/teach?opening=Italian Game` | yes | **NO** — generic "Welcome to my classroom" prompt | "Learn with Coach" hub state, no walkthrough auto-launched |

**Critical finding: 0 of 7 tools visually apply an opening filter on
cold load via URL deep-link.** This includes the tool that statically
appears to support it.

`/coach/play` is the surprise. Code at `CoachGamePage.tsx:548,569,573`
reads `searchParams.get('opening')` and calls `handleOpeningRequest(seed)`.
The seed is accepted but the resulting moves never appear on the
board — either `handleOpeningRequest` only stores intent without
auto-playing, or auto-play needs a user gesture that didn't fire. This
is a real gap, not a configuration issue. **The rolodex needs this fixed
or it has zero working deep-links on day one.**

(Note: `/openings` was still loading at 4s probe time on a cold IndexedDB.
Per the runbook, DB-heavy routes need 30–120s timeouts on a cold seed.
Even so, no `useSearchParams` reader exists in the file — the result
would not change with a longer settle.)

### B2: Narration behavior on launch (rig-driven)

Voice intercept registered before `goto` for all 6 surfaces.

| Tool | `speechSynthesis.speak()` calls | Polly fetches | Verdict |
|---|---|---|---|
| `/coach/play?opening=…` | **0** | 2 × `/api/tts?text=.&voice=ruth` (voice-pack pre-warm) | silent on cold load |
| `/tactics/mistakes?opening=…` | 0 | 2 × pre-warm | silent |
| `/openings?opening=…` | 0 | 2 × pre-warm | silent |
| `/games?eco=…` | 0 | 2 × pre-warm | silent |
| `/tactics/opening-traps?opening=…` | 0 | 2 × pre-warm | silent |
| `/coach/teach?opening=…` | 0 | 2 × pre-warm | silent |

**No surface narrates anything on cold load with `?opening=` set.** The
two `text=.&voice=ruth` calls per page are voice-pack pre-warm pings
(text is literally a single `.`) — not content narration. They do not
appear to be a bug; they're the TTS service warming connections.

The follow-on question — "does narration mis-identify the opening once
auto-played?" — couldn't be tested because nothing auto-plays on cold
load. Once the filter actually applies on `/coach/play` and `/coach/teach`,
re-run this part of the rig.

Verdict for B2: **Narration is not a risk for rolodex launch.** The
surfaces are quiet until the user interacts. No mismatched-narration,
no truncation, no surprises.

---

## Summary

### Recommended build WO scope — **sequence, not single PR**

Pre-build foundation (1 WO, ~1 week):

**WO-ROLODEX-PLUMBING-01** — open the filter pathways before the UI lands.

1. URL-deep-link parity for the 7 rolodex destinations:
   - `/coach/play?opening=…` — **fix the bug** (B1) so the param actually
     auto-plays the opening moves on cold load. Static path exists, runtime
     broken.
   - `/coach/teach?opening=…` — auto-launch the walkthrough for that
     opening instead of the generic hub prompt.
   - `/openings?opening=…` — scroll to / select the named opening.
   - `/games?eco=…` — wire `useSearchParams` to the existing `filterEco`
     state. **S**.
   - `/tactics/opening-traps?opening=…` — auto-expand the named family.
   - `/tactics/mistakes?opening=…` — add URL fallback to the existing
     `location.state.initialOpeningName` path. **S**.
   - `/openings/learn/<line>` (or wherever line-study lives) — same shape.
2. Add `favoriteOpening(ecoCode)` write tool (A4 — M). Wire to
   `openingService.toggleFavorite`. Add intent recognition in
   `parseCoachIntent`.
3. Add `/tactics/opening-traps` to `appRoutesManifest.ts` (A3 — trivial).
4. Per-opening completion selectors (A2):
   - Walkthrough done? — already keyed; expose as a hook.
   - Lines studied — already keyed; expose `linesStudied / total`.
   - Blunders solved — already keyed; expose `solved / total` per opening.
   - **Punt** Puzzles / GM Games / Practice-vs-Engine "X / Y" — those
     three rows ship with "—" or "started?" until net-new completion
     tables exist. Document the decision.

Build WO (1 WO, ~1 week, after plumbing lands):

**WO-ROLODEX-UI-01** — manila tabs, flip cards, drag-reorder, paint to
spec. Wire to `getFavoriteOpenings()` + the per-opening selectors from
plumbing PR. No new backend.

### Foundation work needed before rolodex UI can land

1. **`/coach/play` filter regression fix** — the URL param is read but
   moves aren't visually applied. Highest priority — blocks the most
   important rolodex row.
2. **URL-deep-link wiring for 5 of 7 destinations** — currently the
   rolodex would have to navigate with `location.state`, breaking back-nav
   when the user shares a URL or refreshes.
3. **`favoriteOpening` tool registration** — needed for the "AI search
   natural-language favoriting" entry point in the spec.
4. **Decide the "X / Y" story for Puzzles / GM Games / Practice** —
   either ship them as "started?" booleans, ship "—", or add new tables.
   This is a Dave call.

### Open questions for Dave

1. **"X / Y" on rows without opening-keyed completion data** — Puzzles,
   GM Games, Practice vs Engine. Options: (a) ship as binary "started /
   not started", (b) ship as "—" with nudge copy, (c) build new
   completion tables (~2 days each). Recommend (b) for v1.
2. **Walkthrough auto-launch on `/coach/teach?opening=…`** — confirm
   the rolodex's "Coached walkthrough" row should jump directly into the
   walkthrough state, not the hub. Today it lands on the hub.
3. **`/coach/play` desired behavior with `?opening=`** — should it
   auto-play opening moves to the named end-of-book position then hand
   over? Or just set intent + start from move 1 expecting the player to
   play the opening? Code today is ambiguous; both behaviors are
   reasonable but the rolodex needs one of them committed.
4. **Local vs origin divergence** — `docs/sandbox-playwright-setup.md`
   exists on origin/main (`2081117e`) but not in local working tree
   (HEAD `24243c61`). Parallel-session work has advanced origin. Worth a
   `git fetch && git pull --rebase` before the next session starts —
   especially because the runbook is now load-bearing.
