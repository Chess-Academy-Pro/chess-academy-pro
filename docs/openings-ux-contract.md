# Openings Tab — UX Contract + Audit Coverage

How `/openings` SHOULD work, and what the e2e audit
(`e2e/openings.spec.ts`) currently exercises.

The hub is at **`/openings`** (component:
`src/components/Openings/OpeningExplorerPage.tsx`). It exposes 4
sub-tabs through a four-up grid:

| Sub-tab | Value | Component | Substrate |
|---|---|---|---|
| Most Common | `tab-repertoire` | inline grid in `OpeningExplorerPage` | `getRepertoireOpenings` (Dexie) |
| Pro | `tab-pro` | `ProRepertoiresTab` | `getPlayers()` + `pro-repertoires.json` |
| Gambits | `tab-gambits` | `GambitsTab` | `gambits.json` (seeded into `db.openings` with `isGambit: true`) |
| All | `tab-all` | inline ECO accordion in `OpeningExplorerPage` | `getOpeningsByEcoLetter` (Dexie, grouped A-E) |

Detail surfaces:

| Route | Component | Used for |
|---|---|---|
| `/openings/:id` | `OpeningDetailPage` | Repertoire / gambit / ECO entries |
| `/openings/pro/:playerId` | `ProPlayerPage` | One pro player's repertoire (white + black) |
| `/openings/pro/:playerId/:id` | `OpeningDetailPage` (pro context) | Pro-specific opening — back routes to `/openings/pro/:playerId` |

---

## 1. Hub-level contract

**SHOULD WORK**
- `/openings` mounts `opening-explorer` without errors regardless of
  Dexie seed state — `seedDatabase()` is called inside the page's
  loader before render.
- All 4 tab buttons are visible and clickable
  (`tab-repertoire` / `tab-pro` / `tab-gambits` / `tab-all`).
- A `SmartSearchBar` lives below the tab strip and filters whichever
  panel is active. Empty search returns the full set; non-empty
  search yields an `id` set used to narrow `OpeningCard` rendering.
- On Most Common: Favorites section appears only when ≥ 1 favorite
  exists; otherwise the panel shows `My White Openings` and
  `My Black Openings` headers gated on color.
- On Pro: a `pro-repertoires-tab` panel renders one
  `pro-player-card-<id>` per entry in `getPlayers()`, sorted by the
  service's defined order, with per-player opening counts.
- On Gambits: the panel mounts a row per `db.openings` row with
  `isGambit === true`.
- On All: 5 collapsed ECO groups (`eco-group-A` through `eco-group-E`)
  with chevron toggle (`eco-toggle-<letter>`). Expanding loads that
  letter's openings into the group lazily on first toggle.

**AUDIT COVERAGE**
- ✅ `explorer loads with all 4 tabs and search bar`
- ✅ `Most Common tab shows repertoire openings grouped by color`
- ✅ `Pro tab shows player cards`
- ✅ `Gambits tab mounts without errors`
- ✅ `All tab shows ECO letter groups; expanding loads openings`
- ✅ `search bar filters repertoire openings`

---

## 2. Detail page (Watch / Learn / Practice / Play)

**SHOULD WORK**
- `/openings/:id` mounts `opening-detail` after `getOpeningById` resolves.
- Header renders the opening name, ECO chip, color chip, optional
  style chip, mastery ring (`MasteryRing`), `back-button`, and
  `favorite-btn`.
- `back-button` routes to `/openings` from the standard route OR
  `/openings/pro/:playerId` from the pro route (see §3).
- Four mode buttons below the header:
  - `walkthrough-btn` → mounts `WalkthroughMode` (testid `walkthrough-mode`)
  - `learn-btn` → mounts `DrillMode` (testid `drill-mode`)
  - `practice-btn` → mounts `PracticeMode` (testid `practice-mode`)
  - `play-btn` → mounts `OpeningPlayMode`
- Per-section narration buttons (`narrate-<sectionId>`) fire
  `narrateOpeningSection` via `voiceService.speak`.
- `lines-discovered` / `lines-perfected` counters mount when
  `getTotalLines(opening) > 0`.
- `WoodpeckerStats` block renders only when `woodpeckerReps > 0`
  (`wp-reps` / `wp-speed`).
- `CheckpointQuiz` renders below Key Ideas while
  `currentQuiz && !quizCompleted`; advances `quizIndex` and finally
  flips `quizCompleted`.
- `MiddlegamePlansSection` shows `play-plan-<id>` chips only when
  plans exist for the opening's id; the empty stub testid is
  `middlegame-plans-empty`.
- `ModelGamesSection` shows `model-game-card-<id>` rows when
  `getModelGamesForOpening(opening.id)` returns ≥ 1.
- `CommonMistakesSection` mounts when the static
  `common-mistakes.json` has entries keyed to the opening's name.
- `Traps` block shows `train-traps-btn` only when `opening.trapLines`
  has ≥ 1 entry. Each line renders as
  `trap-line-<i>` with action testids
  `trap-walkthrough-<i>` / `trap-learn-<i>` /
  `trap-practice-<i>` / `trap-play-<i>`.
- `Warning Lines` block follows the same pattern with `warning-*`
  testids.
- `Variations` block (`variation-<i>` rows) shows up to 4 action
  buttons per variation: `variation-walkthrough-<i>`,
  `variation-learn-<i>`, `variation-practice-<i>`,
  `variation-play-<i>`. Status chips (`Discovered`/`Perfected`,
  frequency, danger) render from `opening.linesDiscovered` /
  `linesPerfected` and the variation's metadata.

**AUDIT COVERAGE**
- ✅ `detail page renders header, mastery ring, and 4 mode buttons`
- ✅ `detail page back-button routes to /openings`
- ✅ `detail page Overview + Key Ideas sections render when present`
- ✅ `detail page shows Variations with action buttons`
- ✅ `clicking a variation walkthrough enters walkthrough mode`
- ✅ `clicking the top-level Watch button enters walkthrough mode`
- ✅ `clicking the top-level Learn button enters drill mode`
- ✅ `clicking the top-level Practice button enters practice mode`
- ✅ `favorite toggle round-trips through Dexie`
- ✅ `train-traps button surfaces when the opening has trap lines`
- ⚠️ Not yet covered: `CheckpointQuiz` full happy-path
  (choice → correct → advance → completion).
- ⚠️ Not yet covered: `MiddlegamePlansSection` play-plan launches
  `MiddlegamePractice`.
- ⚠️ Not yet covered: `WoodpeckerStats` mount after completing a
  drill cycle (`drill-mode` finishes → `wp-reps` increments).
- ⚠️ Not yet covered: `CommonMistakesSection` chip-toggle expands the
  miniboard explanation.

---

## 3. Pro flow

**SHOULD WORK**
- `tab-pro` mounts `pro-repertoires-tab`; each row is a
  `pro-player-card-<playerId>` with the player's initials, FIDE
  rating, and a counted-opening badge.
- Clicking a player card navigates to `/openings/pro/<playerId>` →
  mounts `pro-player-page`.
- `pro-player-page` header shows back-button (`/openings`), player
  initials, name + title, FIDE + style chips, and the description.
- The page renders two sections: `White Repertoire` and
  `Black Repertoire`. Each section lists `opening-card-<id>` entries
  routing to `/openings/pro/<playerId>/<id>`.
- The pro-context detail page uses the same `OpeningDetailPage`
  component but `useLocation().pathname` includes `/openings/pro/`,
  so the back-button routes to `/openings/pro/<playerId>` instead of
  `/openings`.

**AUDIT COVERAGE**
- ✅ `Pro tab → player → detail → back routes correctly` (full path:
  Pro tab → player card → opening card → detail back → player back)
- ⚠️ Not yet covered: per-player white/black section split asserts the
  correct colors land in the correct section (current test only
  asserts the cards mount in some order).

---

## 4. Walkthrough / Drill / Practice substrate

Each top-level mode button on the detail page mounts a separate
component. They all share board substrate but their controls differ:

| Component | testid | Substrate | Notes |
|---|---|---|---|
| `WalkthroughMode` | `walkthrough-mode` | `useWalkthroughRunner` over `WalkthroughSession` | Auto-advance gated on voice-promise (see CLAUDE.md "Strict Narration Timing") |
| `DrillMode` | `drill-mode` | `ChessBoard` with chess.js validation | Free-form "Learn" — guess the move, hint on demand |
| `PracticeMode` | `practice-mode` | `ChessBoard` | Prompt-driven, shows `practice-prompt` |
| `TrainMode` | `train-mode` | `ChessBoard` | Used for `train-traps-btn` / `train-warnings-btn` flows |
| `OpeningPlayMode` | (no testid on root) | `useChessGame` + Stockfish via `coachPlaySession` | Full Play vs Engine launched from `play-btn` |

**SHOULD WORK**
- `walkthrough-mode` exposes `walkthrough-back`,
  `walkthrough-progress`, `walkthrough-play-pause`,
  `walkthrough-speed-toggle`, `walkthrough-overview` controls.
- All four mode views have a back-control that returns to
  `opening-detail` without unmounting Dexie state.

**AUDIT COVERAGE**
- ✅ `walkthrough-mode play/pause + speed controls render`
- ⚠️ Not yet covered: full walkthrough playout (step through to the
  end, confirm the runner advances on voice-promise resolution).
- ⚠️ Not yet covered: `DrillMode` happy-path (guess all moves, hit
  `learn-complete`).
- ⚠️ Not yet covered: `PracticeMode` prompt cycle.
- ⚠️ Not yet covered: `TrainMode` for traps (`train-traps-btn` →
  `train-mode` → finish all positions).
- ⚠️ Not yet covered: `OpeningPlayMode` Stockfish reply against a
  student move.

---

## 5. Narration content (audited offline)

Two static narration corpora feed the openings tab:

### 5.1 `src/data/annotations/*.json` (per-opening move annotations)
- Used by `WalkthroughMode` via `annotationService.ts`.
- Audited by `scripts/audit-openings-narration.mjs` against the
  canonical `openings-lichess.json` move sequences.
- Vitest gate: `scripts/audit-openings-narration.test.ts` — fails CI
  when error counts exceed the baseline.
- Current baseline (May 2026 cleanup):
  - `piece-on-square-mismatch` ≤ 1100 (1067 deferred to LLM run)
  - `san-mismatch` ≤ 80 (64 deferred to editorial)
  - `opening-id-pgn-drift` ≤ 0
  - `annotation-overflow` ≤ 0
  - `unparseable` ≤ 0

### 5.2 `src/data/opening-narrations.ts` (curated multi-variant narrations)
- Used by `dataLoader.loadOpeningNarrations` → `db.openingNarrations`.
- Audited by `scripts/audit-curated-narrations.mjs`:
  - Verifies every entry's FEN parses cleanly through chess.js.
  - Replays each canonical PGN whose name matches `openingName` +
    `variation` and confirms the FEN at the moment of `moveSan`
    matches the curated FEN.
  - Greps the narration prose for interface references
    (tap/click/press/button/chat) and acknowledgments
    (Great/Excellent/Correct/Well done) — flagged but not fatal per
    the voice rules.
- Current state: 0 structural errors, 0 voice flags.

### 5.3 `openings-lichess-extended.json`
- Mining-script output (`scripts/extend-openings-from-lichess.mjs`)
  that deepens each canonical entry to ~36 plies via the Lichess
  Explorer masters DB.
- Currently empty (`[]`); the runtime treats this as canonical-only.
- The script is resumable — re-running from scratch costs ~1h of
  Lichess Explorer calls and produces a useful extension corpus.

---

## 6. Run instructions

E2E suite:
```bash
PLAYWRIGHT_LOCAL_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test e2e/openings.spec.ts --project=chromium
```

Narration auditors:
```bash
node scripts/audit-openings-narration.mjs          # annotation corpus
node scripts/audit-curated-narrations.mjs          # curated TS corpus
```

Regression gate (runs both auditors via the audit-openings-narration
Vitest test):
```bash
npm run test:run -- scripts/audit-openings-narration.test.ts
```
