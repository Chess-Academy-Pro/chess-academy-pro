# Endgame UX & Coach surface — running plan

Living document. Captures the open audit findings, the agreed 7-phase
work plan, and the status of each item. Updated as work lands.

When a new session opens, **read this file first** — it carries the
context the previous session would otherwise have to reconstruct from
a fading auto-summary.

---

## Open findings (running list)

Ordered by audit-trail discovery, not by priority. Priority lives in
the phase plan below.

### Endgame surfaces

1. **Activate-the-King keystone extension regression.** Curated
   solution ends at move 6 ("Kc5"), but the position isn't yet an
   obvious win. Disease: `extendToObviousWin` is gated to drills
   only on main; my PR #447 originally enabled it for keystones too
   but the rebase resolution kept main's narrower version. Fix: flip
   to `extendToObviousWin: isDrill || isPlayable` on the keystone
   playout.
2. **Endgame narration substrate divergence.** Endgame uses a
   direct `voiceService.speakForced()` call per position. The rest
   of the app (openings walkthrough) uses `useStrictNarration` for
   streaming sentence-by-sentence playback, route-change cleanup,
   pause-on-chat, manual-nav cancel. Endgame skipped that and
   inherits all of:
   - Endgame-mating delayed narration (whole-text Polly fetch
     before any audio starts).
   - Narration doesn't stop when you leave the tab.
   - Eval Lab completion has no spoken outro.
   - "Why is narration coded differently per tab" — that's the
     architectural disease.
3. **Endgame board parity.** Endgame uses `ConsistentChessboard`
   (static mode); teach/play use the legacy `ChessBoard` (or some
   richer primitive). Different rendering pipelines produce:
   - Animation pacing: pieces snap instead of sliding between moves.
   - Black and white visually move at the same time (no separation
     between student move and opponent reply).
   - No "whose turn" visual cue during opponent reply.
   - **No click / piece-move sound** when the student drops a
     piece on an endgame board. The legacy ChessBoard pipes through
     `usePieceSound()`; ConsistentChessboard static mode doesn't.
     David: "this wouldn't be an issue if the same board was being
     used."
   - Possibly the bishop sprite bug below.
4. **Bishop sprite broken** — `bB` / `wB` alt text shows where the
   bishop image should render. Confirmed on teach, play, mating,
   calc. Cross-cutting piece-set asset path bug.
5. **Back button on Endgame goes to Dashboard**, should go to the
   Coach hub (one level up, not two). Likely `navigate('/')` where
   it should be `navigate('/coach')`.
6. **Game review puzzle hint button missing.** Surface: From-Your-
   Games game-review puzzle with Black king in check. The puzzle
   asks for a "better move than Kf8" but accepts no legal move.
   Two issues:
   - The acceptance gate is exact-match-only; should accept any
     move within an eval threshold of the engine's pick.
   - No hint button to reveal the expected square.

### Coach hub / visual signature

7. **Gold bar (ScrollHintBar) self-hides after scroll.** Once
   `discovered=true` it never returns. You want it as a permanent
   visual signature, not a transient hint. Fix: strip the
   `discovered` + `overflow` guards from the gold-track rendering,
   keep the comet-sweep animation gated only when overflow exists.
8. **Gold bar under Adaptive/Fixed tier sub-toggle** in the
   keystone subview. Same component, applied to the sub-toggle.
9. **Bottom-nav active tab glow** — currently a top-side colored
   line only. You want left-side + bottom-side glow that blends
   into the bottom navbar background.
10. **Coach hub tile glow parity** with Openings tab tiles. Openings
    tiles have strong full-perimeter colored glows per opening;
    Coach hub tiles have dimmer/inconsistent glows. Fix: lift the
    per-tile glow recipe from Openings into a shared utility.
11. **Upload Games CTA missing** on Weaknesses (Game Insights) and
    Review tabs. Both surfaces tell the user to import games but
    provide no entry point to the import flow.

### Data / content

12. **"Recognition only" mating patterns** — Damiano's Mate,
    Lolli's Mate, and possibly others. The Lichess puzzle DB has
    no themes for these named patterns, so we have no drill set.
    Resolution path open — see Phase 7 below.

---

## 7-phase work plan

Each phase = one PR. PRs ship independently to main. After each
phase, this file gets ticked.

### Phase 1 — Quick wins [STATUS: 1.1 REVERTED, 1.2 done, 1.3 deferred]

- [x] **REVERTED** (#1) **Activate-the-King keystone extension** —
  shipped in PR #451 (`extendToObviousWin: isDrill ||
  positionHasPlayableLine`), then **rolled back** within hours
  because the audit log on build `dbaee3b` showed it triggered a
  cascade of Stockfish WASM OOM crashes:
    - 64 `Uncaught [object ErrorEvent]` events fired in ~100ms.
    - `WebAssembly.instantiate(): Out of memory` thrown twice.
    - Sticky single-thread fallback locked in for the session.
    - Polly TTS fetch timed out (signal cooldown collateral).
    - David's tab eventually crashed.
  Disease (not symptom): Stockfish workers aren't pooled —
  every position eval spawns a new worker, WASM heap leaks per
  worker. The keystone extension multiplied the eval load 4–8x
  per playout, which surfaced the underlying leak. Until the
  pooling refactor (new Phase 8 below) lands, keystones end at
  the last curated move (the pre-Phase-1 behaviour).
- [x] (#5) **Back button on Endgame** — verified already routes to
  `/coach/home` (the Coach hub). Locked in with a new regression
  test (`CoachEndgamePage.test.tsx`). If the user still reports
  landing on Dashboard, the cause is likely browser back-button
  (not the in-app arrow) skipping intermediate history, or stale
  deploy on device. Needs concrete repro steps to investigate
  further.
- [ ] (#4) **Bishop sprite missing** — DEFERRED. URL construction
  in `pieceSetService.tsx` looks correct, all 12 pieces map
  identically, underlying SVGs exist on the CDN. Root cause not
  visible without browser DevTools (Network tab on the failing
  bishop request). Probable suspects: CORS / 403 specific to
  bishop file, bad cache, or react-chessboard renderer override.
  Will pick up when we can get a Network-tab dump from David.

### Phase 2 — Narration substrate (~½ day, 1 PR) [STATUS: pending]
Pipe endgame surfaces through `useStrictNarration` (the substrate
the openings walkthrough already uses).

Drops in one move:
- (#2) Endgame-mating delayed narration → streaming.
- (#2) Doesn't-stop-on-route-change → useStrictNarration owns
  lifecycle.
- (#2) Eval Lab missing outro → wire result text through
  `pickNarrationText()`.
- (#2) "Why is narration coded differently per tab" → one
  substrate, one set of rules.

Risk: `useStrictNarration` may have prereqs endgame doesn't meet.
Read it end-to-end first; if incompatible, extract the streaming +
lifecycle pieces into a shared hook.

### Phase 3 — Board substrate parity (~½ day, 1 PR) [STATUS: pending]
Migrate endgame surfaces off the static `ConsistentChessboard` path
to the same primitive teach/play uses.

Drops:
- (#3) Animation pacing — pieces slide visibly between moves.
- (#3) Side-to-move visual distinction inherited from teach/play.
- (#3) Same-side-moves-at-once visual cue.
- (#4) May fix bishop sprite as side effect if it's a piece-set
  config divergence.

Risk: tried earlier in a previous session and the rewrite was lost
via a stash drop. Go surgical this time: just swap the chessboard
rendering primitive at the call sites; leave `useEndgamePlayout`
intact.

### Phase 4 — Upload Games affordance (~2 hrs, 1 PR) [STATUS: pending]
One component, drop-in across three surfaces.

- [ ] Build `<ImportGamesButton>` that routes to the existing
  import flow.
- [ ] (#11) Weaknesses (Game Insights) — inline empty-state CTA +
  header action.
- [ ] (#11) Review tab — inline empty-state CTA + header action.
- [ ] (#11) "From Your Games" sub-tab — same treatment.

### Phase 5 — Visual signature consistency (~½ day, 1 PR) [STATUS: pending]
The "make-the-app-feel-cohesive" pass.

- [ ] (#7) Gold bar permanent — strip `discovered` + `overflow`
  guards from `ScrollHintBar` so the gold track always renders.
  Keep the comet sweep gated to overflow only.
- [ ] (#8) Gold bar on Adaptive/Fixed tier toggle in keystone
  subview.
- [ ] (#9) Bottom-nav active tab glow (left + bottom blend).
- [ ] (#10) Coach hub tile glow parity with Openings.

Will likely need David's eye after first attempt to dial magnitudes.

### Phase 6 — Game review hint button (~2 hrs, 1 PR) [STATUS: pending]
Depends on Phase 2 (narration substrate) so the hint reveal speech
cooperates.

- [ ] (#6) Hint button on `/coach/review` puzzle surface, reusing
  the same affordance keystones have (revealed move highlighted on
  the board).
- [ ] (#6) Broaden the acceptance gate — accept any move within an
  eval threshold of the engine's pick. Fixes the Kf8-in-check dead
  end.

### Phase 7 — Mating pattern DB augmentation [STATUS: NEEDS DECISION]
Open question on data source:

- **(a)** Hand-author 5–10 positions per missing pattern from
  public mate-manual references (Renaud-Kahn, Polgár). Fully under
  our control, no third-party dep. Slowest per pattern, fastest to
  ship overall.
- **(b)** Parse Lichess Studies (CC0) tagged with the pattern name.
  More positions, more code to write, depends on third-party data
  quality.
- **(c)** ChessTempo — paid/restrictive license. Likely off the
  table.

Recommended: (a) for the first wave (top 5 missing patterns),
revisit (b) if more is wanted later. **Awaiting David's pick.**

Patterns currently "Recognition only":
- Damiano's Mate
- Lolli's Mate
- (others — needs full sweep of the picker)

### Phase 8 — Stockfish worker pooling [STATUS: pending, NEW — added after Phase 1.1 revert]

The Phase 1.1 audit revealed a latent leak in
`stockfishEngine.ts`: every position eval can spawn a new worker
without proper termination of the previous one, accumulating WASM
heap until OOM. Phase 1.1 multiplied eval count per playout, which
surfaced the leak immediately; reverting 1.1 doesn't fix the
underlying bug — it just keeps it below the OOM threshold.

Goal: route all Stockfish requests through a SINGLE pooled
worker for the lifetime of the tab. Serialize eval requests.
Properly terminate + respawn on cooldown or crash, with bounded
retry. Drops worker spawn count from O(plays) to O(1).

When that lands, re-enable Phase 1.1's keystone extension.

---

## Decisions log

| Date | Decision | Status |
|------|----------|--------|
| TBD  | Phase 7 data source | Pending David's call |

---

## Sequencing logic

- **Phase 1 first** because tiny wins build momentum and prove the
  deploy chain is healthy.
- **Phase 2 before Phase 6** because the hint button speaks, and
  we want narration on the new substrate.
- **Phase 3 before Phase 5** because the visual signature pass may
  need to know what board chrome looks like under the new primitive.
- **Phase 4 standalone** — can interleave anywhere; doesn't touch
  shared code.
- **Phase 7 last** — biggest unknown, biggest decision needed.

Total: roughly 3 days of focused work spread across 7 PRs.

---

## Next-session pickup

When a new session opens against a partially-completed plan:

1. **Read this file first.** It's faster than re-deriving context
   from the previous session's summary.
2. Check the `[STATUS]` markers on each phase. Anything `pending`
   is up for grabs; anything `in progress` should be finished
   before starting something else.
3. Run `git log --oneline -10` to see what's actually landed since
   this file was last edited.
4. If a phase is partially done (e.g., one of three checkboxes
   checked), prefer finishing it before starting a new phase.
