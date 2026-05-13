# CLAUDE.md — Chess Academy Pro

This file is loaded automatically in every Claude Code session. Follow these instructions exactly.

## 👋 The user

The user is **David**. Address him by name when relevant. Single-user
app, built for him. No multi-tenancy, no other accounts.

## 🧠 Operate at full depth (non-negotiable)

David has a very high IQ and is impatient with surface-level work.
**Match or exceed his level of thinking on every coding task, audit,
debug, design conversation, and PR review.** Surface-level answers
waste his time and his money. Concretely:

1. **Sweep, don't spot-fix.** When David shows you a bug, treat it
   as one sample from a class of bugs. Before declaring done, grep
   the codebase for every other instance of the same pattern. If
   `require('chess.js')` crashed once, grep `require\(` everywhere
   else first. If one component has a stale dep array, audit the
   whole file's effects. "I fixed the one he showed me" is not the
   bar.
2. **Symptom vs disease — name both, treat the disease.** Before
   you patch, write one sentence naming the structural cause. If
   fix N+1 in a sequence treats the same symptom from a different
   angle, the disease is architectural — stop and invert (the same
   lesson from `openingGenerator.ts`). Don't ship the next bandaid.
3. **Read the whole thing.** No skimming, no sampling a 2,500-line
   file and guessing at the rest. If you need to audit a surface,
   read every file end-to-end first. Cite line numbers. If the file
   is too large to hold in context, read it in passes and keep
   notes — don't fake comprehension.
4. **Restate the request before answering.** One sentence, in your
   own words. If your restatement is shallow ("user wants me to fix
   the bug"), your answer will be shallow. If it's structural
   ("user wants me to find every require() in non-test source
   because we just hit one in production and there may be more"),
   your work will be too.
5. **"Pushed to a branch" is not "shipped."** Confirm the fix is on
   `main` and Vercel has redeployed before claiming a production
   bug is fixed. CLAUDE.md says push directly to main — follow it.
   When a PR is required by the harness, merge it; don't leave it
   in draft and walk away.
6. **Don't claim done you can't verify.** If you can't run the UI
   yourself, say so explicitly ("typecheck + tests pass; I can't
   open the browser, so confirm visually"). Don't pretend.
7. **Don't narrate uncertainty as confidence.** If you're guessing
   at the architecture, say so. If you're confident, prove it with
   file:line citations. The middle ground — confident-sounding
   prose with no anchors — is the failure mode that wastes the
   most time.
8. **Match the depth of David's prompt.** A one-line question gets
   a tight, considered answer (not three paragraphs of hedging). A
   "audit this surface and tell me what's broken" request gets a
   structured deep audit with grounded fixes ranked by impact, not
   a checklist of generics.

This standing order overrides any tendency to be cautious, brief,
or "helpful and harmless" in a way that produces shallow work. The
shallow-work failure mode IS the harm here. Use full reasoning
budget every time.

## ⏰ Standing notes

**The DB is the source of truth — the LLM only writes prose.**
The Lichess opening database (`src/data/openings-lichess.json`,
3,000+ entries) is the canonical source for move sequences, FENs,
and structure. The LLM should NEVER be asked to invent or validate
chess structure when the DB already has it. Concretely:

- Walkthroughs: spine + branch moves come from the DB. chess.js
  computes FENs deterministically. The LLM is called ONCE per
  opening to write narration text per move (intro, outro, ideas,
  branch-extension ideas) — that's it. See
  `generateOpeningFromDbNarration` in `src/services/openingGenerator.ts`.
- This pattern was hard-won (build a48b721, 2026-05-08): the prior
  approach asked the LLM to emit the entire WalkthroughTree as
  free-form JSON and we spent hours patching parse errors / illegal
  moves / truncation symptoms. The disease was structural — we were
  asking the LLM for data we already had. When fix N+1 in a
  sequence treats the same symptom differently, the disease is
  structural, not symptomatic. Stop and look at the architecture.
- Face mode (commit 5ba9d0f → next commit) now uses the same
  inversion: code resolves the canonical counter from the DB
  (most-popular sibling extension under the named opening — for
  Sicilian Dragon that's the Yugoslav Attack, for Najdorf the Bg5
  Main Line, for French Winawer the 4.e5 Advance) and runs THAT
  through generateOpeningFromDbNarration with studentSide flipped.
- Apply the same principle elsewhere: stage gen (concepts /
  findMove / drill / punish) should likewise pull positions and
  legal moves from the DB / chess.js, asking the LLM only for
  pedagogy. That's the next inversion target.
- **The Lichess DB IS the canon.** If a named opening or sub-line
  doesn't exist in `openings-lichess.json`, IT DOESN'T EXIST. We
  don't invent sub-variations. We don't pull from external master
  game DBs to fabricate sidelines. We don't ask the LLM to fill
  gaps. ~72% of the 3,641 entries are terminal (zero sub-variations)
  — that's fine; those are linear walkthroughs by design. The
  user's word: "If the lichess db does not have side lines then
  they don't exist. We don't make stuff up and we certainly don't
  break what we have just built!"

**iOS AVAudioSession patch — DONE.** Lives in
`ios-patches/App/AppDelegate.swift` and is copied over the Capacitor
default by `npm run setup:ios`. Sets category `.playAndRecord` with
`.mixWithOthers`, `.allowBluetooth`, `.defaultToSpeaker` so Polly TTS
and Web Speech mic input survive Bluetooth route changes and the
ringer switch. Keep the patch in sync when `cap sync` regenerates
`ios/` — see `ios-patches/README.md`.

## 🔒 DON'T BREAK THESE — Learn build, locked 2026-05-08

The /coach/teach (Learn with Coach) surface works end-to-end at commit
`6bad90c` (tag: `learn-stable-2026-05-08`). It took many hard-won
inversions to get here. Each item below is a contract that another
session might inadvertently break — when you touch this code, verify
each is still satisfied.

**Architecture spine:**
- **DB-narration is the only generation path** for walkthroughs.
  `generateOpeningFromDbNarration` is the entry point. The LLM never
  emits move sequences, FENs, or schema structure — only prose.
  `chess.js` computes FENs from DB-sourced SANs deterministically.
- **Provider fallback chain**: DeepSeek tool-use → Anthropic tool-use
  → text-mode → DB-only synthesis. Every layer is required.
  DeepSeek is the cost-default; Anthropic catches schema misses;
  text-mode handles transient tool-use bugs; DB-only-synth ships a
  walkthrough even when both LLMs fail. Don't remove a layer.
- **Lichess DB is canonical.** No fabricated sidelines. If a name
  isn't in `openings-lichess.json`, it doesn't exist for our app.

**Resolver / picker contracts (`openingDetectionService.ts`):**
- `NAME_ALIASES` is the only place to map shorthand and ambiguous
  inputs. Every audited typo / shorthand / ambiguity has an entry
  here. Don't introduce string-cleaning logic that bypasses it.
- **Terminal-short filter** (≤8 plies + no DB extension): hides ~1000
  useless namesake-only entries from name resolution, line pickers,
  related entries, and sibling-extension forks. `detectOpening` and
  `findOpeningByPgnPrefix` stay UNFILTERED — those identify positions,
  they don't pick lessons. If you add a new user-facing entry-point
  function, gate the candidate pool through `isTeachableEntry`.
- **Branch extensions extend to middlegame.** `findSiblingExtensionBranches`
  pulls up to 6 plies of continuation per branch from the longest DB
  entry under that branch. Every walkthrough fork tile must land in
  middlegame territory, not at the moment of divergence.
- **Face mode inversion**: code resolves the canonical counter via
  the most-popular DB sibling extension; that PGN runs through
  `generateOpeningFromDbNarration` with `studentSide` flipped.

**Walkthrough runtime contracts:**
- **Stage cache polling at the `leaf` phase** (not just the leaf
  CHOOSER). Without this the "Continue Learning" button never
  surfaces when stage gen completes after the user reaches a leaf.
- **Walkthrough-aware FEN priority for chat**: when the brain is
  asked a question mid-walkthrough, it sees the displayed FEN, not
  the starting FEN. Don't reset the chat FEN to `gameRef.current.fen`
  on every turn.
- **Auto-pause walkthrough on chat**: voice + auto-advance pause when
  the user types a question; the brain confirms before resuming.
- **Find-the-Move accepts board moves** via `attemptFindMoveAnswer`,
  not just typed SAN.
- **Voice-promise resolution is the single source of truth for
  auto-advance.** No fallback timers that race `voiceService.speak()`.

**UI contracts:**
- **Inline Chat button on every chessboard surface** (top-right, next
  to Tips). NO global FAB — `showCoachFab = false` in `AppLayout`.
- **`ConsistentChessboard` is the only board** in lesson views.
  Never render `react-chessboard` or `ControlledChessBoard` directly.
- **`ChessLessonLayout` wraps every lesson page.** Caps board height
  on short viewports, reserves bottom-nav + safe-area inset.
- **Hub tile labels**: "Learn with Coach" / "Play with Coach". Don't
  rename to legacy "Teach" / "Play".

**Plan tracker (Play with Coach, but lives in the same brain):**
- `intendedOpening` adheres to the canonical name from
  `resolveOpeningEntry`. The coach calls out the move student
  diverges from their declared opening — once per session, on the
  first divergence, no spam.

**Infrastructure:**
- **Lichess Explorer goes through `/api/lichess-explorer`** — never
  call `explorer.lichess.ovh` directly from the client. The Edge
  function carries a UA fallback chain because Lichess's CDN 401s
  iOS Safari's default UA.

**Trap-data taxonomy (commits `79f3a20`, `d575c84`).** Three kinds
across every "punish-style" lesson — drives whether the entry
surfaces as a bright-red TRAP tile or stays internal as a softer
chip:
- `trap`    : opponent's natural-looking move has a CONCRETE
              tactical refutation (forced material/mate within ~3
              plies). Bright-red chip. Examples: Noah's Ark Trap,
              Legal's Mate, Nb5-Nc7 fork, Stafford "Oh No My
              Queen", Qb6-Nb5 queen trap. ONLY these reach the
              line picker as red TRAP tiles.
- `mistake` : counting / structural blunder, no forced tactic —
              "now you're better" via principle. Amber chip.
              Examples: doubled pawns from a6 Bxc6, gambit accepted
              with structural edge, knight chases that lose tempo.
- `theme`   : long maneuvering middlegame plan. Blue chip.
              Examples: Berlin Wall bishop pair, KID kingside storm,
              Stonewall fortress, Catalan diagonal pressure.

Two data sources, same taxonomy:
- `pro-repertoires.json > trapLines[]` — classified via the
  sidecar file `src/data/trap-line-classifications.json` (keyed
  `<openingId>::<trapName>` → kind). Sidecar so the curated
  source JSON stays untouched.
- `vienna.ts > punish[]` — embedded `kind` field on each
  `PunishLesson`. New static walkthroughs (if any are ever added)
  should set this field directly.

When in doubt, default to `mistake` — never accidentally surface
an unvetted entry as a red TRAP.

**Stage gen — fully inverted for every stage with moves (commit `2094ce5`).**
The DB is the brain for all four stages; LLM only writes prose.
- `drill` (commit `1927ab9`): top 5 sibling-extension branches →
  spine + branch + middlegame extension. LLM emits `{ name, subtitle }`
  per line.
- `findMove` (commit `1927ab9`): walks the spine; at studentSide-move
  plies where 2+ DB openings diverge, the canonical SAN is "correct"
  and sibling SANs (sorted by representative-opening name length)
  are distractors. LLM emits `{ prompt, candidates: [{ label,
  explanation }] }`. `findContinuationsAtPly` in
  `openingDetectionService.ts` is the branchpoint query.
- `punish` (commit `2094ce5`): mines `src/data/puzzles.json`
  (Lichess puzzle DB, 15K curated, CC0) for puzzles tagged with the
  canonical opening's name family AND carrying punish-style themes
  (mate, fork, pin, skewer, sacrifice, hangingPiece, attraction,
  deflection, kingsideAttack, attackingF2F7, xRayAttack). Each
  puzzle becomes a `PunishLesson` skeleton with positions and moves
  straight from the puzzle's UCI sequence. Distractors are scored
  chess.js legal moves (captures + checks + central minor-piece
  development rank high; edge pawn pushes + king shuffles rank low).
  LLM emits `{ name, whyBad, whyPunish, distractors[], followupIdeas[] }`.
  - Schema addition: `PunishLesson.setupFen?: string` — optional
    starting FEN for puzzle-derived lessons. Runtime sets it as
    the built tree's `startFen` and skips the `setupMoves` animation.
  - All three DB paths fire BEFORE the legacy LLM gen; if DB has too
    little material the legacy path still runs. Don't reorder.

Only `concepts` remains LLM-only — by design, since it's
prose-question-with-prose-answers and has no SANs to invert.

## Project Overview

Chess Academy Pro is an AI-powered chess training PWA built with React + TypeScript + Vite. It wraps as a native iOS app via Capacitor and is distributed through TestFlight. The app features an LLM-powered chess coach (Claude API), Stockfish WASM analysis, spaced repetition puzzles, opening training, and adaptive difficulty.

**Single user app** — built for one person (the developer's brother). No multi-tenancy, no auth beyond optional Supabase cloud sync.

## Tech Stack (exact versions)

- React 19.2.4 + ReactDOM 19.2.4
- TypeScript 5.9.3 (strict mode)
- Vite 7.3.1 + @vitejs/plugin-react 5.1.4
- Tailwind CSS 4.2.1
- React Router DOM 7.13.1
- chess.js 1.4.0
- react-chessboard 5.10.0
- stockfish 18.0.5 (WASM, Web Worker)
- Dexie.js 4.3.0 (IndexedDB)
- Zustand 5.0.11 (state management)
- Recharts 3.7.0
- Framer Motion 12.34.4
- openai 6.27.0 (DeepSeek provider, baseURL: https://api.deepseek.com)
- @anthropic-ai/sdk (Anthropic provider)
- Lucide React 0.576.0 (icons)
- Capacitor 8.1.0 (core + cli + ios)

## Code Conventions

### TypeScript
- **Strict mode always.** No `any` types. Use `unknown` + type guards when types are uncertain.
- Prefer `interface` over `type` for object shapes. Use `type` for unions/intersections.
- All function parameters and return types must be explicitly typed.
- Use `const` by default. Use `let` only when reassignment is needed. Never `var`.

### React
- Functional components only. No class components.
- Use named exports, not default exports.
- Component files: PascalCase (`PuzzleTrainer.tsx`).
- Hook files: camelCase prefixed with `use` (`useChessEngine.ts`).
- One component per file. Co-locate styles, hooks, and types when small.
- Prefer composition over prop drilling. Use Zustand for shared state.

### File Organization
```
src/
  components/     # React components grouped by feature
  hooks/          # Custom React hooks
  stores/         # Zustand stores
  services/       # Business logic, API clients, engine wrapper
  data/           # Static JSON data (openings, puzzles, etc.)
  types/          # Shared TypeScript interfaces/types
  utils/          # Pure utility functions
  test/           # Test setup, mocks, helpers
```

### Styling
- Tailwind CSS utility classes only. No CSS modules, no styled-components, no inline styles.
- Use Tailwind's design system (spacing, colors, typography) consistently.
- Theme colors defined in Tailwind config and referenced by semantic names.
- Responsive: mobile-first. Use `sm:`, `md:`, `lg:` breakpoints.

### UI Design Language (IMPORTANT)
**All hub/landing pages must match the Dashboard pattern.** This means:
- Centered title at top
- `SmartSearchBar` below title (on all non-playing pages)
- **2-column grid** of big tap targets: `grid grid-cols-2 gap-3 flex-1 content-center max-w-lg mx-auto w-full`
- Each section button: `border-2 rounded-2xl`, tinted bg (`bg-{color}-500/10`), tinted border (`border-{color}-500/30`), centered icon + bold label
- First item spans 2 columns (`col-span-2 py-10`), rest are `aspect-square`
- Each section owns a color (Tailwind opacity classes, not CSS variables)
- Container: `flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6`
  (the `pb-[calc(...)]` reserves room for the fixed mobile bottom nav
  PLUS the iOS home-indicator safe-area inset; `pb-20` alone clips
  the last row on iPhones with the gesture bar)
- Content constrained to `max-w-lg mx-auto`

**When "clean up" or "make it match" is requested, match BOTH structure AND visual.** Don't just reorganize information flow — replicate the actual layout, grid, card style, spacing, and interaction patterns of the reference page. Study the reference's exact JSX, Tailwind classes, and component hierarchy before writing new code.

### Boards and Lesson Layouts (IMPORTANT)
Every board in the app must go through `ConsistentChessboard` (`src/components/Chessboard/ConsistentChessboard.tsx`). Two modes:
- **Controlled:** `<ConsistentChessboard game={useChessGame()} ... />` — for interactive lesson/coach/play screens.
- **Static:** `<ConsistentChessboard fen={fenStringOrPositionMap} ... />` — for inline boards that own their own chess instance (Kid games, model-game viewers).

Theming (piece set, square colors, glow, animation duration, border) is centralized in `useBoardTheme()` (`src/hooks/useBoardTheme.ts`). Do NOT pass piece set / square color / animation overrides at the call site — they are pinned by the hook for visual consistency.

Any "lesson with a board" screen (walkthrough, dynamic coach session, middlegame study) should use `ChessLessonLayout` (`src/components/Layout/ChessLessonLayout.tsx`). It guarantees: fixed gap above controls, board-height cap on short viewports, and mobile bottom-nav clearance via `env(safe-area-inset-bottom)`.

### Strict Narration Timing (IMPORTANT)
Lesson playback (TTS + auto-advance) must use `useStrictNarration` (`src/hooks/useStrictNarration.ts`) for low-level control, or `useWalkthroughRunner` (`src/hooks/useWalkthroughRunner.ts`) for full-session orchestration over a `WalkthroughSession`. Voice-promise resolution is the single source of truth for advance — do NOT add fallback timers that race with `voiceService.speak()`. Manual navigation cancels in-flight speech and supersedes pending callbacks via the hook's token counter.

Spoken text comes from `pickNarrationText(annotation, length)` (`src/services/walkthroughNarration.ts`). New annotations should populate the optional `narration` and `shortNarration` fields on `OpeningMoveAnnotation` so the spoken script can diverge from the displayed annotation when needed; otherwise the helper falls back to the display text.

### Narration Voice Rules (IMPORTANT)

Every spoken line in the app — whether hand-authored in JSON or
generated in code templates — must follow these rules. The voice
is the *position* teaching the student, not the interface
explaining itself. Violations make a 30-puzzle session feel
robotic and tune out fast.

1. **Concrete over generic.** "The rook attacks the c7-pawn"
   beats "this is a good move." Every spoken sentence either
   names a square, a piece, or a chess concept the student can
   look at. If it doesn't, it's filler.
2. **Never reference the interface.** No "tap a different move,"
   "click Practice more," "press Next," "use the chat button."
   The voice doesn't know about buttons; it knows about the
   position.
3. **Don't restate the board.** If the rook just moved to h7,
   don't speak "Rook to h7." The student saw it. Voice carries
   only what the *picture* doesn't.
4. **Silence is acceptable.** An empty `idea` string means no
   narration. Use it for routine moves (auto-played opponent
   replies, intermediate student moves in a long sequence). Save
   voice for the moments that change the student's understanding
   — the principle, the named pattern, the surprise.
5. **Ban acknowledgments.** "Correct!" / "Great job!" /
   "Excellent!" / "Well done!" — never. The position changing in
   the student's favor IS the acknowledgment. Praise rings hollow
   after the third puzzle.
6. **Ban first-person and meta.** "I think..." / "Let me
   show you..." / "Now we'll see..." / "Watch the forced reply"
   — never. The narrator is the position, not a tutor character.
7. **Name the pattern, not the move.** On a mating-pattern leaf,
   speak "Anastasia's mate" not "Bxh7 mate" — the SAN is on the
   board; the *name* is the takeaway. Same principle anywhere a
   named theoretical idea applies (Lucena, Philidor, Vancura,
   triangulation, opposition, …).
8. **Drill positions stay silent.** DB-sourced drills (puzzles
   loaded by theme from `puzzles.json`) are *practice*, not
   teaching. The board is the lesson at that point. Voice
   resumes only when the student returns to a hand-authored
   keystone.
9. **Vary stems.** When a phrase MUST repeat (transitions
   between puzzles, e.g.), alternate stems rather than copying
   the same opener verbatim. Curators should write 3-5 variants
   and rotate; code templates should not be the source of
   frequently-spoken text.
10. **No length floor.** Two words beats two sentences when two
    words is what the position needs.

Code templates that violate these rules are bugs. When in doubt,
prefer silence.

### State Management
- **Zustand** for global app state (user profile, settings, current session, theme).
- **React state** (`useState`) for local component state only.
- **Dexie.js** for persistent data (puzzles, games, SRS cards, opening progress).
- Never duplicate state between Zustand and Dexie — Zustand holds runtime state, Dexie holds persistent data.

### Naming
- Variables/functions: `camelCase`
- Components: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase` (e.g., `PuzzleRecord`, `CoachPersonality`)
- Files: match what they export (`PuzzleTrainer.tsx`, `useStockfish.ts`, `srsEngine.ts`)
- Test files: co-located as `ComponentName.test.tsx` or `moduleName.test.ts`

## Testing Requirements

- All new features MUST have corresponding tests.
- Run `npm test` before committing. All tests must pass.
- Run `npm run lint` before committing. No errors allowed.
- Test files live next to source files: `Foo.tsx` -> `Foo.test.tsx`

### Test Stack
- **Vitest 4.0.18** — unit + component tests
- **React Testing Library 16.3.2** — component rendering + interaction
- **MSW 2.12.10** — API mocking (Lichess, Chess.com, Claude API)
- **fake-indexeddb 6.2.5** — IndexedDB mocking (auto-loaded in setup)
- **Playwright 1.58.2** — E2E tests

### Test Commands
```bash
npm test              # Vitest in watch mode
npm run test:run      # Vitest single run
npm run test:coverage # Vitest with coverage
npm run test:e2e      # Playwright
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
```

### Mocking Conventions
- **Stockfish:** Mock via `src/test/mocks/stockfish-worker.ts` — returns canned UCI responses. For `stockfishEngine.ts` tests, use `vi.stubGlobal('Worker', ...)` with a class mock.
- **IndexedDB:** Auto-mocked via `fake-indexeddb/auto` in vitest setup. Use `db.delete(); db.open()` in `beforeEach` for test isolation.
- **External APIs:** MSW handlers in `src/test/mocks/handlers.ts`. Use `server.use()` for per-test handler overrides.
- **Web Speech API:** Stubbed in `src/test/setup.ts`. When using `vi.resetModules()`, re-stub `SpeechSynthesisUtterance` as a class (not a function) to preserve constructor behavior.
- **AudioContext:** Conditionally stubbed in `src/test/setup.ts` using `if (typeof globalThis.AudioContext === 'undefined')` so test-level stubs take precedence.
- **chess.js:** Do NOT mock — use the real library in tests
- **Framer Motion:** Wrap with `<MotionConfig transition={{ duration: 0 }}>` in test utils

### Test Data Factories
Use `src/test/factories.ts` for all test data. Available builders:
- `buildUserProfile()`, `buildPuzzleRecord()`, `buildOpeningRecord()`, `buildGameRecord()`
- `buildFlashcardRecord()`, `buildSessionRecord()`, `buildCoachGameState()`, `buildChatMessage()`, `buildBadHabit()`
- Each accepts `Partial<T>` overrides and returns valid defaults with auto-incrementing IDs.
- Call `resetFactoryCounter()` in `beforeEach` if test relies on predictable IDs.

### Testing Best Practices
- **Component tests:** Mock service imports with `vi.mock()`, use `renderWithProviders` (or `render` from `src/test/utils.tsx`), use `waitFor` for async state updates.
- **Zustand store tests:** Test directly via `useAppStore.getState()` + action calls. Call `reset()` in `beforeEach` for isolation. No React rendering needed.
- **DB integration tests:** Use real fake-indexeddb, not mocks. Test index queries (`where().equals()`, `where().between()`) against actual Dexie operations.
- **Module isolation:** Use `vi.resetModules()` + dynamic `await import()` only when testing singleton modules that need fresh instances per test (e.g., `speechService`).
- **Accessibility tests:** Use `vitest-axe` for automated checks (`axe(container)` returns `{ violations }`) + manual ARIA attribute assertions. Keep axe tests focused on simple components to avoid timeouts.
- **E2E tests:** Playwright config in `playwright.config.ts`. Tests in `e2e/` directory. Use `data-testid` selectors for reliability.

## Git Conventions

- Commit messages: imperative mood, max 72 chars first line
- Format: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`
- One logical change per commit
- Do NOT commit `.env` files, API keys, or `node_modules`

## Standing Orders for Work Orders

These rules apply to every work order. They don't get "completed" —
they must be satisfied whenever the WO touches the listed surface.

- **Any WO changing Supabase schema MUST produce a migration file + RLS policies.**
- **Any WO adding a Dexie store MUST bump version + add upgrade function.**
- **Any WO adding a new route MUST register it in `router.tsx` AND add a nav entry.**
- **Any WO adding a new UI surface MUST include loading, empty, and error states.**
- **Any WO adding a user-facing feature MUST declare: feature flag name, nav entry, activation cue, post-completion route.**
- **Any WO gating on a user flag MUST specify retroactive handling for existing users.**
- **Any WO adding events MUST document PostHog event names + properties.**

## Do NOT

- Use `any` type
- Use default exports
- Use CSS-in-JS or inline styles
- Use class components
- Add comments for self-evident code
- Add features not specified in the current work order
- Skip tests
- Use `localStorage` for anything (use Dexie/IndexedDB)
- Import from `openai` anywhere except `src/services/coachApi.ts`
- Run Stockfish anywhere except through `src/services/stockfishEngine.ts`

## Agent Coach Pattern (WO-AGENT-COACH)

All lesson-style surfaces — opening walkthroughs, middlegame plans,
coach-run drills, play-against sessions — share the same substrate.
When you add a new lesson flow, reuse these primitives:

### Shared components
- **`src/components/Chessboard/ConsistentChessboard.tsx`** — the only
  board wrapper for lesson views. Narrow API (`fen`, `arrows`,
  `highlights`, `interactive`, `onMove`, `maxWidth`) over the existing
  `ControlledChessBoard`. Keeps piece style / colors / arrow colors /
  animation timing identical everywhere. Do not render
  `ControlledChessBoard` or `react-chessboard` directly in new lesson
  screens.
- **`src/components/Layout/ChessLessonLayout.tsx`** — header / board /
  controls / footer slots with safe-area and thumb-zone spacing. Caps
  the board height so the control row never scrolls off-screen on
  mobile. Wrap every lesson page with this.

### Shared types / services
- **`src/types/walkthrough.ts`** — `WalkthroughStep` (narration
  embedded with the move) and `WalkthroughSession`. This is the
  canonical lesson data shape.
- **`src/services/walkthroughAdapter.ts`** — `buildStepsFromPgn()` /
  `buildSession()` convert legacy PGN + parallel annotation arrays
  into `WalkthroughStep[]`. chess.js is the truth for SAN/fenAfter;
  mismatches warn in dev.
- **`src/services/walkthroughRunner.ts`** + **`src/hooks/useWalkthroughRunner.ts`**
  drive playback with strict voice-gated timing. Board updates
  instantly on step change; auto-advance is gated on
  `voiceService.speak()` resolving; a word-count backup timer is a
  safety net only. Use this hook for any new auto-advancing lesson.
- **`src/services/coachAgent.ts`** — `parseCoachIntent()` routes
  natural-language coach queries to `continue-middlegame`,
  `play-against`, `puzzle`, `walkthrough`, or `qa`. Deterministic
  regex-first so sessions start instantly without an LLM round-trip.
- **`src/services/middlegamePlanner.ts`** — resolves a middlegame
  plan (by openingId or subject) from `middlegame-plans.json` into a
  `WalkthroughSession`. **Keeps the plan's critical-position FEN so
  opening→middlegame board context carries over — do not reset.**
- **`src/services/coachPlaySession.ts`** — rating-matched Stockfish
  config (with explicit easy/medium/hard override). Always resolve
  via `resolveConfig(difficulty, rating)`.

### Routing
- **`/coach/session/:kind`** (`CoachSessionPage.tsx`) — the entry
  point for any coach-initiated lesson. URL query carries context
  (`?subject=...&orientation=...&difficulty=...`). `SmartSearchBar`
  surfaces an "Start session" top-of-dropdown suggestion whenever
  `parseCoachIntent` matches a routable kind.

### Rules of thumb
- Never render `react-chessboard` or `ControlledChessBoard` directly
  in a new lesson view — use `ConsistentChessboard`.
- Never build your own play/pause/advance timers — use
  `useWalkthroughRunner`.
- Never hard-code Stockfish strength — go through
  `coachPlaySession.resolveConfig`.
- Never pass narration in a parallel array — embed it on the
  `WalkthroughStep`.

## Plan docs for large fixes (standing order)

**For any non-trivial multi-step fix, write a `PLAN.md`-style
document at the start of the work and commit it to `main` before
diving in.** This is non-negotiable for any change that:

- spans 3+ files,
- touches multiple surfaces,
- needs a sequence of PRs to ship safely,
- or carries decisions David needs to make.

Why: the auto-summary that compresses old messages loses nuance —
exact tool results, screenshots, the architectural reasoning behind
ordering. A planning doc preserves that durably so the next session
can resume cleanly without re-deriving context.

The doc lives at `PLAN.md` (single file, append-and-update; archive
to `docs/plans/<date>-<topic>.md` when a major chunk lands and a
new plan starts). It should include:

- **Open findings** — the running list of audit items with one-line
  diagnoses, not just symptoms.
- **Phased plan** — each phase as one PR, with status markers
  (`pending` / `in progress` / `done`).
- **Decisions log** — anything that needs David's call, dated.
- **Sequencing logic** — why this order and not another.
- **Next-session pickup** — short instructions for resuming.

Update the file as work lands. Tick checkboxes. Move decisions to
the log. Don't let it rot.

## Deployment Policy

**Push every build directly to `main`. No feature branches, no PRs, no
preview deploys.** Dave wants every change to land on production
immediately. Workflow:

1. Run tests, typecheck, lint — fix any failures
2. Commit with a clear message on `main`
3. `git push origin main` — Vercel picks it up and deploys
4. iOS/TestFlight builds are produced locally via Capacitor when needed

Do NOT create feature branches, do NOT open PRs, do NOT merge through
the UI. The previous "branch + PR + merge" flow is retired — Vercel
preview builds add latency without value for a single-developer app.

Never ask "want me to merge?" / "want me to push?" — just push to main.

## Before Finishing a Session

1. All tests pass (`npm run test:run`)
2. No TypeScript errors (`npm run typecheck`)
3. No lint errors (`npm run lint`)
4. Update MANIFEST.md — mark completed work orders, note any blockers
5. If you created new files, verify they follow the file organization rules above
6. Merge and deploy (see Deployment Policy above)
