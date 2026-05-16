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

**Audit stream — pull live runtime events on demand.** When David is
debugging a reproducible runtime issue on the live build (Vercel
production), the app can stream audit events to `/api/audit-stream`
and Claude can pull them with `GET /api/audit-stream?since=<ms>` +
`x-audit-secret` header. Use it like this:

- **Default to proactive.** The whole point of this feature is to
  close the loop without David copy-pasting. After any push that
  touches a runtime path that emits audits — coach brain, walkthrough
  runtime, voice, navigation, tool calls, stage gen, uncaught errors
  — pull the recent events automatically once enough time has passed
  that David would have exercised it. Don't ask permission every time.
- **Pull immediately when David says:** "test it", "I just reproduced
  X", "check the live build", "what just happened", or names a runtime
  symptom — fetch first, ask questions after.
- **Empty pulls are fine.** Just say "no events since `<timestamp>`,
  app probably not open" and move on. Cheap and non-noisy.
- **Skip pulling only for:** pure content / data-JSON / CSS / test /
  docs / build-config changes that can't emit any audits. Before-push
  gating is still tests + typecheck + lint, not audit stream.
- **What you'll see:** every `logAppAudit()` call. ~58 source files
  emit them. Stream carries the same payload as the local Dexie log.
- **Limits:** 24h TTL on the server, newest 1000 entries kept, only
  fires while the app is open. It's a live-watch buffer, not a durable
  log — the Dexie log on-device is still the source of truth.
- **Endpoint:** `GET /api/audit-stream?since=<ms>` with
  `x-audit-secret` header. Save the secret to memory so you don't have
  to re-ask each session.

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

**`/coach/teach` (Learn with Coach) is the standard.** Every
lesson-shaped surface in the app — middlegame studies, endgame
modules, opening drills, kid puzzles when they grow up — should
match its patterns: two-column flex (board + inline chat at md+,
stacked on mobile), DB-anchored generation, voice-promise gated
auto-advance, inline Chat + Tips buttons (no global FAB), and
the 11-phase walkthrough state machine in `useTeachWalkthrough`.
When you build a new lesson surface, copy `CoachTeachPage`'s
spine; don't reinvent it.

**Architecture spine:**
- **DB-narration is the only generation path** for walkthroughs.
  `generateOpeningFromDbNarration` is the entry point. The LLM never
  emits move sequences, FENs, or schema structure — only prose.
  `chess.js` computes FENs from DB-sourced SANs deterministically.
- **Provider routing: Anthropic-first, DeepSeek fallback.** As of
  2026-05-14 (David's call) Anthropic (Sonnet/Haiku) is the primary
  on every surface because the pedagogy quality is noticeably better
  than DeepSeek. The spine's `resolveProviderName()` defaults to
  `'anthropic'`; `getProviderConfig()` in `coachApi.ts` prefers the
  Anthropic env key when present. On 401/429/quota errors the
  existing fallback chain at `coachApi.ts:782`
  (`getFallbackConfig`) transparently retries the request on
  DeepSeek — no surface code needs to handle this. A user with ONLY
  a DeepSeek key still gets DeepSeek. Surfaces should NOT pin
  either provider via `providerOverride` — let the spine pick and
  the coachApi layer handle the fallback. Pinning either provider
  defeats the auto-fallback.
- **Tool-use fallback chain stays intact**: Anthropic tool-use →
  DeepSeek tool-use → text-mode → DB-only synthesis. Every layer
  is required. Anthropic does the heavy lifting now; DeepSeek
  catches Anthropic-quota / schema misses; text-mode handles
  transient tool-use bugs; DB-only-synth ships a walkthrough even
  when both LLMs fail. Don't remove a layer.
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
- **`ChessLessonLayout` for single-column lesson surfaces.**
  Caps board height on short viewports, reserves bottom-nav +
  safe-area inset. `/coach/teach` itself uses a **two-column
  flex** (board left, chat panel right at `md:` and up; stacked
  on mobile) — this is the STANDARD shape for lesson surfaces
  that bundle a live chat alongside the board. New surfaces that
  match Learn-with-Coach's shape (board + chat) should copy the
  same two-column flex with `pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]`
  mobile padding. New surfaces without inline chat (walkthrough-
  only / middlegame study / opening drill) should use
  `ChessLessonLayout`. Either way, the board goes through
  `ConsistentChessboard`.
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

**Trap-data taxonomy (commits `79f3a20`, `d575c84`, `2204166`).**
Two parallel arrays per opening — `trapLines[]` (student weapons)
and `warningLines[]` (student anti-traps to avoid) — with three
kinds inside `trapLines[]` that drive whether the entry surfaces
as a bright-red TRAP tile or stays internal as a softer chip:

**The orientation contract (David's rule, audit 2026-05-16):**
- `trapLines[]` — STUDENT WEAPONS. The OPPONENT makes a natural-
  looking slip; the student plays the principled / tactical reply
  and ends up better. The PGN should end with the student gaining
  material, delivering mate, or accumulating decisive positional
  advantage. **`scripts/audit-trap-orientation.mjs` enforces this**
  and `src/data/pro-repertoires-orientation.test.ts` is the build-
  time gate. Inverted entries (where the PGN literally shows the
  student losing material) get moved to `warningLines[]`.
- `warningLines[]` — STUDENT ANTI-TRAPS. The line shows what
  happens if THE STUDENT falls into a trap — the student is the
  one who slips and gets punished. Used to scare the student off
  the bad move. PGN ends with the student down material or
  positionally lost. Used to live empty; pre-existing schema +
  UI support since `OpeningDetailPage` carries a "train warnings"
  button that walks these lines. Audit script flags
  `TOOTHLESS_WARNING` when a warning line accidentally rewards
  the student (then it should be in `trapLines[]` instead).

**Three kinds inside `trapLines[]`** (sidecar
`src/data/trap-line-classifications.json`):
- `trap`    : opponent's natural-looking move has a CONCRETE
              tactical refutation (forced material/mate within ~3
              plies). Bright-red chip. Examples: Legal's Mate,
              Nb5-Nc7 fork, Stafford "Oh No My Queen", Qb6-Nb5
              queen trap, Open Tarrasch Trap. ONLY these reach
              the line picker as red TRAP tiles.
              **Sacrificial attacks** where the win is positional
              accumulation (Fried Liver, Milner-Barry Greek gift,
              Bxf7 sacs) do NOT belong here — they're `mistake`.
              Reclassified 2026-05-16 after audit flagged them as
              "trap PGN ends with student down material."
- `mistake` : counting / structural blunder, no forced tactic —
              "now you're better" via principle. Amber chip.
              Examples: doubled pawns from a6 Bxc6, gambit accepted
              with structural edge, knight chases that lose tempo,
              sacrificial gambits where the win is positional.
- `theme`   : long maneuvering middlegame plan. Blue chip.
              Examples: Berlin Wall bishop pair, KID kingside storm,
              Stonewall fortress, Catalan diagonal pressure.

**Side-of-the-board check.** Before adding a new trapLine, ask:
*who plays the bad move, who plays the punishment?* The
punishment-side must match the opening's `color` (the side the
student plays). Noah's Ark Trap (Black's c5-c4 entombing White's
Bb3) was wrongly listed under three WHITE Ruy Lopez repertoires
(Carlsen, Firouzja, Praggnanandhaa) — student-side mismatch.
Removed 2026-05-16; replaced with Berlin Tarrasch Trap, Open
Tarrasch Trap, and Bird's Defense Refutation (all canonical
white-side Ruy Lopez lines from `openings-lichess.json`).

Two data sources, same taxonomy:
- `pro-repertoires.json > trapLines[]` and `warningLines[]` —
  classified via the sidecar file
  `src/data/trap-line-classifications.json` (keyed
  `<openingId>::<trapName>` → kind). Sidecar so the curated
  source JSON stays untouched. `warningLines[]` carry no
  classification (the role IS the classification).
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

## 🧒 Kids section — non-negotiables

The kid section (`/kid/*`) is for David's young brother. Adult-app
patterns DON'T automatically apply — and adult-app personalities
(edgy / drill-sergeant / profanity) must NEVER bleed in. The full
plan is at `docs/plans/2026-05-15-kids-section.md`; this is the
durable contract list any session touching kid surfaces must hold.

1. **LLM only writes prose, never plays moves.** chess.js validates
   every move. Same rule as `/coach/teach`.
2. **LLM never selects which puzzle/level the kid sees.** Puzzle
   selection is deterministic: filter `puzzles.json` by piece +
   rating band + theme; pick first N. The LLM only writes hint and
   encouragement text.
3. **No coach personality leaks into kid mode.** Every kid LLM
   call goes through `getKidLlmResponse` (in `coachApi.ts`), which
   passes `skipPersonality: true` to `getCoachChatResponse` and
   prepends a kid-safety system prompt. **Importing
   `getCoachChatResponse` directly from a `Kid/` file is banned.**
4. **Voice is Ruth, default tone, no exceptions.** `voiceService`
   calls from kid surfaces pass `personality: 'default'` explicitly.
5. **Narration constraints — kid carve-out.** Praise IS allowed in
   kid mode, but **only on milestones**: chapter complete, level
   cleared, all-stars run, puzzle session summary. Per-move praise
   ("Great move!", "Excellent!" after every click) is banned —
   tunes out. Restate the move's *effect* instead ("the knight is
   safe now").
6. **No SAN in kid-facing text.** Spelled-out moves only.
7. **No timer pressure** unless a game's whole point is the timer
   (e.g. Color Wars). Untimed by default.
8. **Adaptive difficulty per-piece, persisted in Dexie**, never
   lost on session end.
9. **Every kid hub looks the same.** Identical shape across all 6
   pieces. No `setView` rendering — everything routes.
10. **Kid mode never reads from or writes to coach state.**
    `useBoardContext` removed from `KidPiecePage` and
    `GameChapterPage`. The only Zustand keys kid mode reads:
    `activeProfile`, `activeTheme`, `setActiveTheme`.
11. **Bottom-nav phantom padding removed.** `pb-[calc(6.5rem+...)]`
    → `pb-6` everywhere under `/kid` since no bottom nav renders
    there (KidLayout is a sibling of AppLayout).
12. **`KidChessboard` is the only board** under `/kid/*`. Other
    primitives are banned. `KidChessboard` wraps
    `ConsistentChessboard` and removes eval bar, move list, PGN,
    arrows-on-hover — simpler is better for kids.
13. **CC0 only.** Lichess puzzle data only. No copyrighted
    ChessKid content. No fabricated sidelines.
14. **The 6 pieces own their hubs.** Names: `pawn-games`,
    `rook-games`, `knight-games`, `bishop-games`, `queen-games`,
    `king-games`. Pre-existing `/kid/mini-games` is being renamed
    to `/kid/pawn-games`.
15. **Sandbox levels step in 5-level bands.** No continuous ELO
    adaptation for sandbox games — only for puzzles.
    Bands: 1-5 easy, 6-10 medium, 11-15 hard, 16-20 expert.
16. **Every puzzle has a `movingPiece` tag.** Filtering by piece
    requires it. Build step computes it from chess.js applied to
    the puzzle's UCI move (Lichess `moves` field is UCI not SAN
    — filtering by SAN first-char returns 100% pawn for everything).
17. **The DB is the source of truth in kid mode. The LLM only
    writes prose.** Same contract as
    `generateOpeningFromDbNarration`. Puzzle positions and
    solutions come from `puzzles.json` + the 100-400 training
    pool. Sandbox levels come from `*Levels.ts` config files.
    The LLM is ONLY ever asked for hint text and encouragement,
    never FENs, never moves, never level layouts. Every LLM
    output is sanitized; on any anomaly fall back to static
    templates. **An LLM hallucinating chess content in kid mode
    is a P0 bug.**

When you touch any file under `src/components/Kid/`, any service
named `*Kid*.ts`, any data file used by kid surfaces, or any route
matching `/kid/*` — check the relevant non-negotiables before you
push. The Phase 11 audit script (`scripts/audit-kid-llm-hallucination.mjs`,
once it lands) is the runtime gate; this list is the design gate.

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
Three primitives, three jobs:

- **`ConsistentChessboard`** (`src/components/Chessboard/ConsistentChessboard.tsx`)
  — the single facade for live interactive boards and static
  inline boards.
  - Controlled mode: `<ConsistentChessboard game={useChessGame()} ... />`
    forwards to `ControlledChessBoard`. Used by `/coach/teach` and
    `/coach/play` for the free-play board.
  - Static mode: `<ConsistentChessboard fen={fen | piecePositionMap} ... />`
    for inline display-only boards (kid games, model-game viewers,
    endgame previews, search-result thumbnails).
- **`Board/ChessBoard`** (`src/components/Board/ChessBoard.tsx`)
  — the chess.js-validating wrapper used inside walkthroughs.
  Owns its own `Chess` instance built from `initialFen` and
  emits `onMove(MoveResult)` with a parsed SAN. Required for
  the walkthrough's `drill` and `findMove` phases where the
  student plays a move on the board and the runtime needs the
  SAN back. Do NOT use this outside walkthrough / lesson
  surfaces — for static display use `ConsistentChessboard`.
- **`react-chessboard`** — never imported directly outside the
  two primitives above.

Theming (piece set, square colors, glow, animation duration, border) is centralized in `useBoardTheme()` (`src/hooks/useBoardTheme.ts`). Do NOT pass piece set / square color / animation overrides at the call site — they are pinned by the hook for visual consistency.

`/coach/teach` is the canonical lesson surface (see "Learn-with-Coach
is the standard" above). It uses a **two-column flex** (board left,
chat panel right at md+, stacked on mobile) with
`pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]` for mobile
bottom-nav clearance. New lesson surfaces with inline chat copy
this shape directly. New lesson surfaces WITHOUT inline chat
(pure walkthrough, middlegame study, opening drill) use
`ChessLessonLayout` (`src/components/Layout/ChessLessonLayout.tsx`)
for single-column rhythm: fixed gap above controls, board-height
cap on short viewports, mobile bottom-nav clearance.

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
- **Playwright Worker-URL detection (gotcha):** `performance.getEntriesByType('resource')` does NOT reliably capture Web Worker source URLs — it'll miss `new Worker('/foo.js')` requests, so a spec watching for which Stockfish variant loaded gets an empty list and false-negatives. Use `page.on('request', ...)` instead — it fires for every HTTP request the page (or any spawned worker) makes. Captured in `e2e/stockfish-ios-fix.spec.ts` after v3 failed: subscribe at test start, collect URLs into a local array, assert against the captured list at the end. Same pattern for any future spec that needs to verify "did the right worker / chunk / wasm bundle load."

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
- **`src/components/Chessboard/ConsistentChessboard.tsx`** — the
  board facade for live-game interactive surfaces (controlled
  mode) AND static inline display boards (static mode). Pins
  piece set / square colors / arrow colors / animation timing
  via `useBoardTheme`. Use this on `/coach/teach`'s free-play
  state, `/coach/play`'s live board, and every static thumbnail.
- **`src/components/Board/ChessBoard.tsx`** — the chess.js-
  validating walkthrough board. Owns its `Chess` instance,
  emits `onMove(MoveResult)` with parsed SAN. Required for the
  walkthrough runtime's `drill` and `findMove` phases (student
  plays a move on the board, runtime needs the SAN back).
- **`src/components/Layout/ChessLessonLayout.tsx`** — single-
  column lesson wrapper with safe-area and thumb-zone spacing.
  Caps the board height so the control row never scrolls
  off-screen on mobile. Use for lesson surfaces WITHOUT inline
  chat. Lesson surfaces WITH inline chat (the `/coach/teach`
  shape) use a two-column flex instead — see the Boards and
  Lesson Layouts section above.

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

**Land every change on `main` as fast as possible.** David doesn't
want preview-deploy latency — every commit ships.

**Workflow (Claude Code via the harness):**

1. Run tests, typecheck, lint — fix any failures.
2. Branch from `main` as `claude/<short-topic>` (the harness blocks
   direct pushes to `main` with 403, so branch + PR is the
   functional equivalent of "push to main").
3. Open a PR with `mcp__github__create_pull_request` (not draft).
4. Merge it immediately with `mcp__github__merge_pull_request`
   (squash). Vercel picks up the merged commit and deploys.
5. iOS / TestFlight builds are produced locally via Capacitor when
   needed.

**Branch hygiene:** delete `claude/*` branches after their PR
merges. The harness blocks `git push --delete origin <branch>`, so
clean-up needs the GitHub UI or a follow-up tooling pass. Don't let
old branches accumulate — a fresh session looking at the branch
list gets buried in stale Claude branches and can't tell what's
current.

**Don't ask for permission to push or merge.** Just do it. Asking
adds round-trips David doesn't want.

**Auth for `git push` from Claude sessions.** Dave keeps a GitHub
Personal Access Token labeled **"Claude Code repo token"** in his
GitHub settings (`Settings → Developer settings → Personal access
tokens`). It needs either:

- Classic PAT with `repo` scope, OR
- Fine-grained PAT with `dyahnke-pro/chess-academy-pro` selected and
  `Contents: Read and write` permission

The token value is **not** stored in the repo — it lives in Claude's
per-project memory (see `audit_stream.md` / sibling memory files).
Workflow when `git push` returns 401 / 403:

1. Check Claude memory for the current token.
2. If absent / stale, ask Dave to paste it (he can copy from the
   labeled PAT in GitHub settings or rotate and generate a fresh
   one).
3. Use it via `git push https://dyahnke-pro:<TOKEN>@github.com/dyahnke-pro/chess-academy-pro.git main`
   or `gh auth login --with-token` if that path works in the sandbox.
4. Save the new value back to memory (never commit it).

If `git push` keeps failing, fall back to `vercel --prod` to push the
deployment without going through GitHub — the git history will then
be local-only until the push resolves.

**Parallel Claude sessions are common.** Dave often runs multiple
Claude sessions in parallel on this repo, each auditing a different
tab (settings, endgame, coach-teach, opening-traps, review, tactics,
etc.). They commit locally AND push to `origin` via merged PRs.
Consequences:

- Before pushing, ALWAYS run `git fetch origin && git log HEAD..origin/main`
  to see if other sessions have advanced origin.
- If origin has moved, the rebase will conflict on any file the
  other sessions also touched. SettingsPage, useTeachWalkthrough,
  coach narration paths, endgame JSONs are hot spots.
- If you find a local commit you didn't make (some other "feat(...)"
  on your HEAD), it's from another session on this machine — leave
  it alone unless Dave says otherwise.
- The safe fallback when origin diverges is `vercel --prod` to ship
  the deployment + report the divergence to Dave so he can resolve
  the merge with full context. Don't force-push or `reset --hard
  origin/main` blindly — you'd lose another session's work.
- Coordinate via Dave when working surfaces another session might
  also be on. He'll say "audit running on X tab" if there's a
  conflict in flight; stand down on those files until clear.

## Post-Deploy Audit (MANDATORY — run after EVERY build)

**Non-negotiable.** After every push that lands on `main` and
triggers a Vercel deploy, run the relevant Playwright audit script
against the LIVE production URL and confirm all scenarios green
before claiming the work is done. Unit tests + typecheck + lint
are NOT sufficient — they don't catch deploy-pipeline issues
(wrong bundle aliased, env vars scoped to the wrong environment,
function cold-start regressions, CDN cache serving stale assets).

This rule comes from the 2026-05-14 back-button-fix incident:
unit tests passed, code was correct, but the production alias
lagged behind main and the fix wasn't live. The audit-back-from-
review.mjs script caught the gap; nothing in the local test suite
could have. Lesson: **trust the audit, not the test pass.**

### The standard post-deploy ritual

After every `git push origin main`:

1. **Wait for Vercel to finish building.** Check with
   `npx vercel ls | head -5` — the latest Production-target row
   should be Ready and newer than the previous one. If a prior
   deploy is still "Building", wait. Don't audit a stale bundle.
2. **Confirm the live bundle is the one you just shipped.**
   `curl -s https://chess-academy-pro.vercel.app/ | grep -oE
   '/assets/index-[A-Za-z0-9]+\.js' | head -1` — the hash should
   change after each push. If it doesn't, the alias hasn't moved.
3. **Pull the audit stream** (lightweight sanity check). Empty
   pulls are fine; what you're checking for is the endpoint
   itself responding 200 with `storage: "redis"` or `"memory"`
   (NOT `error: "server misconfigured: AUDIT_STREAM_SECRET not
   set"` — that means you aliased a Preview deployment to the
   production URL by mistake, and the Preview env lacks the
   secret).
4. **Run the audit script(s) for every surface you touched.**
   This is the load-bearing step. The matrix:

   | If you changed… | Run |
   |---|---|
   | `/coach/review/*` | `scripts/audit-coach-review.mjs` + `scripts/audit-back-from-review.mjs` |
   | `/coach/play` | `scripts/audit-coach-play.mjs` |
   | `/coach/chat` | `scripts/audit-coach-chat.mjs` |
   | `/coach/teach` (Learn) | (no script yet — write one if you're shipping a real change here) |
   | `/coach/home` + tile nav | `scripts/audit-untouched-surfaces.mjs` |
   | `/coach/plan` (Training Plan) | `scripts/audit-coach-plan.mjs` |
   | `/coach/analyse` / `/train` | `scripts/audit-untouched-surfaces.mjs` |
   | `/tactics/*` | `scripts/audit-tactics.mjs` |
   | `/weaknesses` (or its tab/row → review flow) | `scripts/audit-weaknesses.mjs` |
   | `/openings/*` | `scripts/audit-openings-ui.mjs` (coordinate — often 🚧 in flight) |
   | `/` (dashboard) + SmartSearchBar | `scripts/audit-dashboard.mjs` |
   | settings toggles | `scripts/audit-settings-behavior.mjs` |
   | Cross-surface UI scaffolding | run multiple of the above |

   Every script in `scripts/audit-*.mjs` targets the live prod URL
   by default (override with `AUDIT_SMOKE_URL` for local).

5. **All scenarios must be green.** If any fail:
   - Dig into the failure FIRST. Don't dismiss as flake without
     reproducing twice.
   - Real regressions: fix + push + re-audit. Don't claim done.
   - Genuine flakes (cold-start timing, transient network): bump
     the relevant timeout in the script and re-run, then commit
     the timeout fix.
   - Skipped scenarios are NOT failures (e.g. "no mistake-row
     entries on fresh prod context" is by design — the script
     seeds synthetic data where it can, but some flows can't be
     fully exercised cold).
6. **Save the report.** Each audit drops a JSON report under
   `audit-reports/<surface>-<iso>/report.json`. Reference it
   when reporting back to David ("all 20 scenarios green, report
   at `audit-reports/weaknesses-...`").

### Writing a new audit script

If you touched a surface that has no audit script and the change
isn't pure content / styling / docs / tests, **write the audit
script** as part of the same PR. Use existing scripts as templates:
- `scripts/audit-weaknesses.mjs` — modern reference. Per-scenario
  try/catch, structured report, synthetic-data seeding via
  `page.evaluate` + IndexedDB, scenario chain that can skip when
  preconditions aren't met.
- `scripts/audit-back-from-review.mjs` — focused regression-class
  audit (one specific contract, ~10 scenarios). Good for back-
  button-style contracts.
- `scripts/audit-coach-review.mjs` — large surface, many
  expectations, the `expectation` kind pattern (`visible` /
  `invisible` / `count-gte` / `url-matches` / `audit-present`).

Add the new script to the matrix above AND to `docs/AUDIT_INDEX.md`
the same commit.

### Deploy-pipeline gotchas (the ones we've actually hit)

- **Vercel free tier caps at 100 deploys/day.** When the cap hits,
  `vercel --prod` returns `Resource is limited`. GitHub auto-deploy
  is sometimes affected too. If you hit the cap, the only options
  are (a) wait ~24h, (b) re-alias an existing successful deploy
  via `npx vercel alias <preview-url> chess-academy-pro.vercel.app`,
  (c) push an empty commit and pray.
- **Aliasing a Preview deployment to the production URL breaks
  any env var scoped Production-only.** `AUDIT_STREAM_SECRET` is
  Production-only by design. If you alias a Preview, the
  audit-stream endpoint returns `error: "server misconfigured…"`.
  Roll back the alias by re-aliasing the prior Production deploy
  (`npx vercel ls` → find the most recent `Environment` =
  Production row, alias that one).
- **Vercel CDN caches the index.html briefly.** If
  `curl -I .../` returns `x-vercel-cache: HIT` and the
  `last-modified` is older than your push, give it 30-60s and
  re-curl with a cache-buster (`?cache_bust=$(date +%s)`).
- **Production alias can lag behind main by 5-30 min when Vercel
  is rate-limited or queued.** Always verify the deployed bundle
  hash matches your latest commit BEFORE auditing — running an
  audit against the old bundle wastes time chasing a "regression"
  that doesn't exist yet because your code isn't shipped.

## Before Finishing a Session

1. All tests pass (`npm run test:run`)
2. No TypeScript errors (`npm run typecheck`)
3. No lint errors (`npm run lint`)
4. **Post-deploy audit ran AND all scenarios green** (see
   "Post-Deploy Audit (MANDATORY)" above) — this is the load-
   bearing step, not the test suite.
5. Update MANIFEST.md — mark completed work orders, note any blockers
6. If you created new files, verify they follow the file organization rules above
7. Merge and deploy (see Deployment Policy above)
8. If you wrote a new audit script, add it to the matrix in
   "Post-Deploy Audit" and to `docs/AUDIT_INDEX.md`.
