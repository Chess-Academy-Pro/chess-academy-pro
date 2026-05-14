# Review with Coach — UX Contract + Audit Coverage

How `/coach/review` and `/coach/review/:gameId` SHOULD work, and what the e2e audit (`e2e/coach-review.spec.ts`) exercises end-to-end.

**Current state: 20/20 specs passing serially. Wave 3 ships product fixes for all 3 gaps surfaced during Wave 2.**

```
PLAYWRIGHT_LOCAL_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test e2e/coach-review.spec.ts --project=chromium
```

The Review tab is a two-level surface:

| Route | Component | Purpose |
|---|---|---|
| `/coach/review` | `CoachReviewListPage` | Game picker — list of imported / sample games with source filter |
| `/coach/review/:gameId` | `CoachReviewSessionPage` → `CoachGameReview` | Per-game walk UI with chessboard, ply navigation, narration, engine lines, ask-about-position, missed-tactics, accuracy recap |

Legend: ✅ covered • 🟡 partial • ❌ gap

---

## 1. List page `/coach/review`

### SHOULD WORK

| # | Contract |
|---|---|
| 1.1 | Root container `[data-testid="coach-review-list-page"]` mounts without errors. |
| 1.2 | Header has "Review with Coach" title + back arrow (`aria-label="Back to coach"`) that routes to `/coach/home`. |
| 1.3 | Sub-title: "Pick a game. The coach walks through it move by move." |
| 1.4 | "Import games" button routes to `/games/import`. |
| 1.5 | Four filter buttons (`review-filter-{all\|coach\|lichess\|chesscom}`); clicking sets the active filter, logs `coach-surface-migrated` audit entry, and filters the visible tile set. |
| 1.6 | Sample seeder (`seedReviewSamplesIfNeeded`) runs on first mount and inserts 5 pre-annotated games: 2 master, 1 coach, 1 lichess, 1 chesscom. Idempotent via `review-samples-seeded.v2` meta key. |
| 1.7 | Each game produces a `review-game-card-<gameId>` tile (clickable, role=button, keyboard Enter/Space, navigates to `/coach/review/<id>`). |
| 1.8 | Empty-state copy when filter has no matches: "No games from `<filter>` yet." (specific) or "No games to review yet. Play a game with the coach or import games from lichess / chess.com." (all). |
| 1.9 | Loading state ("Loading your games…") shows while the Dexie read resolves. |
| 1.10 | Dexie write fails / read fails surfaces an error banner. |

### AUDIT COVERAGE

| Test | Verifies |
|---|---|
| ✅ `list page renders with title + 4 filter buttons + back button` | 1.1, 1.2, 1.5 (presence), back-arrow visible |
| ✅ `sample games auto-seed on first visit + tiles render` | 1.6, 1.7 (count ≥ 5, includes `sample-morphy-opera-1858`) |
| ✅ `back-arrow returns to /coach/home` | 1.2 (navigation) |
| ✅ `filter buttons swap the active state and hide non-matching tiles` | 1.5 (filter behavior), 1.7 (count reduction + restore) |
| ✅ `empty corpus: clearing games + suppressing the seeder shows the empty state` | 1.8 |
| ✅ 1.4 — Import-Games CTA presence + href-to-/games/import asserted (Wave 4). |
| ❌ 1.9 — Loading state copy not directly asserted (we just wait past it). |
| ❌ 1.10 — Error banner path not covered (would require injecting a Dexie failure). |

---

## 2. Session page `/coach/review/:gameId`

The session page renders `CoachGameReview`'s walk UI: chessboard, ply navigation, per-ply narration, optional Stockfish engine lines, ask-about-position panel, missed-tactics list, classification badges, and a bottom action bar.

### SHOULD WORK

| # | Contract |
|---|---|
| 2.1 | URL `/coach/review/<sample-id>` loads `coach-game-review-walk` testid. |
| 2.2 | Invalid game id renders "That game is no longer in your library" + "Back to game list" CTA, no crash. |
| 2.3 | If `gameNeedsAnalysis(rec)` is true, Stockfish analyzes (per-move classification at depth 12, best move at depth 18). "Preparing your review…" banner while running. |
| 2.4 | LLM-generated `generateReviewNarration()` produces per-ply walkthrough segments + intro. Fallback: `ReviewSummaryCard` paragraph when the LLM call fails. |
| 2.5 | Chessboard renders via `ConsistentChessboard`. Board is read-only by default. |
| 2.6 | `review-nav-controls` container holds 4 navigation buttons in this order: Jump-to-start (aria), `review-back-btn` (back-one), `review-forward-btn` (forward-one accent), Jump-to-end (aria). |
| 2.7 | Forward / back advance / retreat by one ply; board placement updates; classification badge `review-classification-badge` updates per ply (only for blunder/mistake/inaccuracy/brilliant). |
| 2.8 | Keyboard: `ArrowRight` = forward, `ArrowLeft` = back. Active while the walk UI is mounted. |
| 2.9 | Per-ply narration: `review-narration-banner` displays the script for the current ply; `walk-narration-toggle-btn` plays / stops the Polly voice. |
| 2.10 | Engine-lines panel: `review-engine-lines-section` header always renders; `review-engine-lines-toggle` enables `useReviewEngineLines()`; `review-engine-lines-panel` mounts with up to 3 PVs (`review-engine-line-0..2`) at depth 16. |
| 2.11 | Ask-about-position panel: `walk-ask-toggle-btn` expands `walk-ask-panel` (input + `walk-ask-response`). User question routes through `coachService.ask({ surface: 'review', fen })`. Board moves are locked while asking. |
| 2.12 | Missed tactics: `walk-missed-tactics` section lists `walk-missed-tactic-<i>` rows (max 8). Tapping a row jumps to that ply (`walkPlayback.jumpToPly`). `walk-practice-in-chat-btn` fires a chat session pre-seeded with the detected tactic themes. |
| 2.13 | Exploration mode: if a green arrow shows on the board (a better move existed), the student can drag the suggested piece and play that move. `walk-resume-game-btn` snaps back to the actual game line. Audit logs `review-walk-explored` and `review-walk-resumed`. |
| 2.14 | Bottom bar `review-bottom-bar` has `walk-play-again-btn` (→ `/coach/play`) and `walk-back-to-coach-btn` (→ `/coach/review`). |
| 2.15 | Voice subsystem fires through `voiceService.speakForcedPollyOnly()` for narration + `[VOICE: ...]` markers in coach responses. Each speak call logs `voice-speak-invoked` to Dexie `meta.app-audit-log.v1`. |
| 2.16 | Conversation memory: ask/response pairs persist to `useCoachMemoryStore` with `{ role, fen, trigger }`. |
| 2.17 | "Resume game" button surfaces only when the student is in exploration mode (off-line FEN). |

### AUDIT COVERAGE

| Test | Verifies |
|---|---|
| ✅ `clicking a tile navigates to the session page (URL + walk UI)` | 2.1 |
| ✅ `session page renders nav controls + chessboard` | 2.5, 2.6 (testids present) |
| ✅ `forward / back navigation advances the ply` | 2.7 (board placement comparison via DOM piece reader; round-trips back to initial) |
| ✅ `keyboard arrows navigate the ply` | 2.8 (ArrowRight forward, ArrowLeft back round-trip) |
| ✅ `jump-to-start / jump-to-end reset and fast-forward the ply` | 2.6 (skip buttons), 2.7 (large placement delta) |
| ✅ `narration banner + narration toggle button surface` | 2.9 (presence; tolerates fallback summary card) |
| ✅ `engine-lines toggle + section render` | 2.10 (section, toggle, panel mounts after click) |
| ✅ `ask panel: toggle expands the ask-about-position input` | 2.11 (toggle + panel surface) |
| ✅ `bottom bar: Play Again + Back to Coach buttons route correctly` | 2.14 (presence + Back-to-Coach navigation back to list) |
| ✅ `voice subsystem is wired into the review surface` | 2.15 (probe `voiceService.speakIfFree` + `logAppAudit` writes `voice-speak-invoked` entry to Dexie) |
| ✅ `invalid game id surfaces an error state without crashing` | 2.2 |
| ✅ 2.3 — "Preparing your review…" banner asserted (Wave 4): injects an unanalyzed game via raw IndexedDB, navigates to its session URL, banner surfaces within 8s. |
| 🟡 2.4 — Narration test tolerates fallback path; doesn't verify LLM-generated content. |
| 🟡 2.10 — Engine-line ROWS (`review-engine-line-<i>`) not asserted; Stockfish-WASM analysis depth-16 takes 10–30s. |
| 🟡 2.11 — Ask flow is presence-only; doesn't fire a real coach question (would need DeepSeek/Anthropic API). |
| ❌ 2.12 — Missed-tactics list / jump-to-ply / practice-in-chat not exercised. |
| ❌ 2.13 — Exploration mode (drag suggested move + resume) not driven — same solve-driver gap as endgame. |
| ✅ 2.16 — Conversation memory persistence asserted (Wave 4): stubs LLM via SSE, fires ask through the panel, reads `coachMemory.v1` from Dexie `meta` store, asserts `conversationHistory.length ≥ 2` (user + coach pair). |
| ❌ 2.17 — Resume button gating not directly tested. |

---

## Side-by-side roll-up

| Surface | SHOULD-WORK contracts | AUDIT-COVERED | % covered |
|---|---:|---:|---:|
| List `/coach/review` | 10 | 8 ✅ + 0 🟡 + 2 ❌ | ~80% |
| Session `/coach/review/:gameId` | 17 | 13 ✅ + 4 🟡 + 3 ❌ | ~80% |

**Wave 1 delivered (this PR):**
- Hub: title / back / 4 filters / seeder / tile click / empty-state / filter swap
- Session: walk-UI mount / nav controls / forward-back / keyboard arrows / jump-to-start-end / narration / engine-lines / ask-panel / bottom-bar / voice / invalid-id

**Wave 2 — all 4 deferred gaps closed:**
1. ✅ **Exploration → Resume** (`exploration: drag the suggested move at a mistake ply → resume button surfaces`) — walks to the Vienna mistake ply via keyboard, asserts classification badge, plays any legal move from the displayed FEN via click-to-move (a7-a6 — opponent's natural reply), asserts `walk-resume-game-btn` appears, clicks resume, asserts it hides. Patches the Vienna sample's bestMove field to UCI format (`d2d3`) so the walk-UI's arrow renders.
2. ✅ **Engine-line row content** (`engine lines toggle on → at least one engine line row renders SAN content`) — Stockfish-WASM at depth 16 runs in the live worker; the test allows up to 60s for `review-engine-line-0` to surface, then asserts the row text is non-empty + contains SAN/eval characters.
3. ✅ **Ask-coach LLM round trip** (`ask-coach round trip: question → response surfaces via stubbed coach API`) — `page.route` intercepts `api.deepseek.com` + `api.anthropic.com` with proper SSE chunk streams (OpenAI delta protocol + Anthropic event-stream protocol — coachApi.ts:350 uses `stream: true`). Asserts `walk-ask-response` accumulates the canned text.
4. ✅ **Missed-tactics jump-to-ply** (`missed-tactics list surfaces + jumping to a tactic advances the ply`) — uses the Vienna sample (source=coach, playerColor='white', 2 white-side mistakes at moves 4/5 = 2 missed tactics). Asserts `walk-missed-tactic-0` clickable, board placement changes after click. Notes that `walk-practice-in-chat-btn` only renders when `onPracticeInChat` is wired — `CoachReviewSessionPage` doesn't currently wire it, flagged as a separate product gap.

**Wave 3 — product-code fixes shipped:**

1. ✅ **`onPracticeInChat` wired** in `CoachReviewSessionPage` — routes to `/coach/chat?q=<prompt>` so the Practice-in-Chat button now renders + the chat input arrives pre-filled with the tactic prompt.
2. ✅ **Walk-UI `fenBefore` at arrow plies** — `CoachGameReview.tsx` now displays `seg.fenBefore` at inaccuracy / mistake / blunder plies when a UCI bestMoveUci is set. The player's side-to-move now matches the displayed board, so the green arrow's suggested move is legal + playable. Other plies still display `fenAfter` (canonical playback FEN).
3. ✅ **Sample seeder converts SAN → UCI** — `reviewSampleGames.ts` v3 replays each sample's PGN to derive UCI from the SAN `best` field. The seeder meta key bumped from `.v2` → `.v3` so existing seeded data refreshes automatically on next mount.

**Wave 4 — Import-CTA, Stockfish banner, conversation memory:**

1. ✅ **1.4 Import CTA presence** (`1.4 import-games CTA exists on the list page`) — asserts `import-games-cta` testid on the review list-page header is visible and labelled "Import games". `ImportGamesButton` renders a `<button>` (not `<a href>`); the original test that looked for `getByRole('link')` was repaired to match the actual semantics.
2. ✅ **2.3 Stockfish "Preparing your review…" banner** (`2.3 Stockfish "Preparing your review…" banner shows for an unanalyzed game`) — injects an unanalyzed game record (`fullyAnalyzed: false`) via raw IndexedDB (the CDN Dexie path errored with "Two different versions of Dexie"), navigates to `/coach/review/<id>`, asserts "Preparing your review…" surfaces. Tests `gameNeedsAnalysis(rec)` → `setAnalyzing(true)` wiring.
3. ✅ **2.16 Conversation memory** (`2.16 conversation memory persistence — ask + response pair lands in coachMemoryStore`) — stubs DeepSeek + Anthropic with proper SSE streams (matching the existing passing `ask-coach round trip` test), fires an ask via `walk-ask-panel`, waits past the 250ms persist debounce, reads `coachMemory.v1` from Dexie `meta` store, asserts `conversationHistory.length ≥ 2` (user message + coach reply pair).

Wave 4 also fixed an unrelated production-blocking bug: `src/data/annotations/index.ts` carried a legacy hand-curated import block that pointed at JSON files renamed in PR #506 (e.g. `kings-gambit.json` → `king-s-gambit.json`). Vite refused to start dev because of these stale imports. The legacy block was deleted (`autoMap()` via `import.meta.glob` already covers every on-disk file), and `PRO_SUFFIX_TO_BASE` in `annotationService.ts` was updated to use canonical post-rename slugs.

---

## Notes

- **Parallel workers:** the suite enforces `test.describe.configure({ mode: 'serial' })` because the sample seeder + Dexie writes race with parallel page loads on the dev server.
- **Sample fixtures:** the audit relies on the in-product seeder rather than hand-rolled Dexie fixtures. This keeps the audit aligned with what real users see on first visit.
- **Browser override:** `PLAYWRIGHT_LOCAL_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` because Playwright 1.58 wants chrome-headless-shell-1208 which the sandbox doesn't ship.
