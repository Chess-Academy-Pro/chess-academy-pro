# Trap-orientation cleanup — repertoire.json + pro-repertoires.json

Plan doc for the trap/warning orientation sweep triggered 2026-05-16
when the screenshot of `pirc-defence` → "Austrian Attack e5 Trick"
showed a walkthrough ending at 10.Nf3 with Black's queen attacked on
e5. The line was invented (no DB anchor past ply 8) and the lesson
stopped mid-disaster.

When a new session opens, read this file first — the audit reports
referenced below live under `audit-reports/` (gitignored, regenerate
with the scripts in §Audit scripts).

## TL;DR

- 432 trap/warning entries across two files.
- **190 (44%) are flagged** by the orientation audit.
- 2 are hard-fail INVERTED_MATE (student literally gets checkmated).
- 37 are PGN_NOT_IN_DB (invented per gate G3).
- The existing audit + build-time test only cover `pro-repertoires.json`;
  `repertoire.json` (the older, larger file) is uncovered.

## Open findings (running list)

### Source of truth — audit script

The dedicated audit script for repertoire.json is
[scripts/audit-repertoire-orientation.mjs](../../scripts/audit-repertoire-orientation.mjs).
It mirrors the contracts in
[scripts/audit-trap-orientation.mjs](../../scripts/audit-trap-orientation.mjs)
but adds a `PGN_NOT_IN_DB` flag — line must have a ≥6-ply prefix
matching some entry in `openings-lichess.json`. Run both:

```bash
node scripts/audit-trap-orientation.mjs
node scripts/audit-repertoire-orientation.mjs
```

Latest results (2026-05-16):

| Source | Entries | Clean | Flagged |
|---|---|---|---|
| `repertoire.json` | 265 | 99 | 166 |
| `pro-repertoires.json` | 167 | 143 | 24 |
| **Total** | **432** | **242** | **190 (44%)** |

| Category | Count |
|---|---|
| WEAK_TRAP (student not clearly winning) | 132 |
| STUDENT_NOT_PUNISHER (PGN ends on opp move) | 49 |
| PGN_NOT_IN_DB (invented, G3 violation) | 37 |
| INVERTED_MATERIAL (student down material) | 26 |
| TOOTHLESS_WARNING (warning ends with student winning) | 6 |
| INVERTED_MATE (student gets checkmated) | 2 |

### INVERTED_MATE entries (hard-fail — fix in Phase 2)

Both are filed as white-side trapLines, but the PGN ends with Black
mating the student. These are Black weapons that got listed as White
"refutations" — they belong in `warningLines[]`.

1. `italian-game::Blackburne Shilling Gambit Refutation` — ends `Nf3#`.
2. `ruy-lopez::Fishing Pole Trap` — ends `Qh1#`.

### The triggering case

`pirc-defence::Austrian Attack e5 Trick` (repertoire.json:1421):
- PGN: `e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 e5 dxe5 fxe5 Nd5 Nxd5 Qxd5 c3 Qxe5+ Be2 Nc6 Nf3`
- Final position: Black queen on e5 attacked by Nf3. Black is +1 pawn (e5)
  but the line stops at the moment the queen looks en prise. UX: looks
  like Black hangs the queen.
- DB anchor: 8 plies (Austrian Attack mainline `e4 d6 d4 Nf6 Nc3 g6 f4 Bg7`),
  but ply 9 (e5) is invented — no canonical e5 push before O-O in
  `openings-lichess.json`.
- Likely Phase 3 action: delete; replace with a DB-anchored Austrian
  Attack line if one exists, otherwise leave the slot empty.

### PGN_NOT_IN_DB hot spots (G3 violations)

| Opening | # invented lines |
|---|---|
| london-system | 9 |
| trompowsky-attack | 6 |
| kings-indian-attack | 5 |
| reti-opening | 4 |
| birds-opening | 3 |
| caro-kann | 2 |
| dutch-defence | 2 |
| (single offenders) italian-game, vienna-game, scandinavian-defence, philidor-defence, slav-defence, english-opening | 1 each |

Pattern: systems-based openings (London, Trompowsky, KIA, Reti, Bird)
have the worst coverage. Lichess DB coverage thins out past the named
main lines for these openings, so the authoring shortcut was to
fabricate. Expected Phase 3 outcome: most of these need to be deleted
outright (no DB equivalent exists).

## Phased plan

### Phase 1 — Close the gate (this PR) — `pending`

Goal: make the bug class impossible to add NEW violations to, without
changing any data. Lets us see the full inventory before deciding
delete-vs-fix.

1. ✅ Write the audit script for `repertoire.json` (sibling to the
   pro-repertoires one). Done in this commit.
2. ✅ Run both audits and snapshot the current offender set. Done.
3. Add `src/data/repertoire-orientation.test.ts` — Vitest build-time
   gate. Uses a JSON allowlist (`src/data/repertoire-orientation-baseline.json`)
   of currently-known offender keys; fails CI if any flagged entry
   isn't in the allowlist. Day-1 baseline has 166 entries; shrinks as
   Phases 2-4 ship.
4. Add the new script to `docs/AUDIT_INDEX.md` matrix and CLAUDE.md
   post-deploy matrix.
5. Add a hard-fail assertion (no allowlist for these categories):
   - INVERTED_MATE: 0 allowed.
   - PGN_NOT_IN_DB: allowlisted but logged.
   - TOOTHLESS_WARNING: 0 allowed... actually 6 today; allowlist them.

   Compromise: hard-fail for INVERTED_MATE only initially (just 2,
   both targeted in Phase 2). Everything else baselined.

Out of scope this phase: data changes, deletions, renames.

### Phase 2 — Fix INVERTED_MATE (next PR) — `pending`

Move `Blackburne Shilling Gambit Refutation` and `Fishing Pole Trap`
from `italian-game.trapLines[]` and `ruy-lopez.trapLines[]` to the
respective `warningLines[]`. Flip the prose ("when YOU play X, here's
what happens"). Verify with the audit script that the entries move
from INVERTED_MATE → TOOTHLESS_WARNING-cleared (because the line
genuinely shows the student losing, which is what a warning is for).

### Phase 3 — Delete PGN_NOT_IN_DB (next PR) — `pending`

37 entries. For each:
- Look for a DB-anchored equivalent line under the same parent
  opening. If found, replace; if not, delete (per G3, the line
  doesn't exist for us).
- London (9) and Trompowsky (6) will likely lose most of their
  trapLines. That's correct — invented content was the gap-filler.

### Phase 4 — Sweep WEAK_TRAP + STUDENT_NOT_PUNISHER + INVERTED_MATERIAL — `pending`

The bulk grind, 175 entries. Three buckets:
- **Extend by one ply** — when STUDENT_NOT_PUNISHER applies and there
  IS a DB-anchored continuation where the student plays the punisher,
  add that ply.
- **Promote to warningLines[]** — when the line genuinely shows the
  student losing, the entry is mis-filed; move it.
- **Delete** — when the line shows roughly equal material with no
  tactical edge, the entry isn't a trap.

Group by opening, work in batches; each batch is its own PR; each
PR's commit shrinks the baseline allowlist.

### Phase 5 — Tighten the gate — `pending`

Once baseline is empty, drop the allowlist mechanism. The audit
becomes a pure hard-fail. New trap content must be DB-anchored AND
orientation-correct from the start.

## Decisions log

- **2026-05-16 — Sibling script, not unified.** Kept
  `audit-repertoire-orientation.mjs` separate from
  `audit-trap-orientation.mjs` even though the rules overlap.
  Reason: pro-repertoires uses a kind-classification sidecar
  (trap/mistake/theme); repertoire.json doesn't have one and
  treats every trapLine as kind=trap by default. The taxonomy
  divergence is documented in CLAUDE.md and intentional.
- **2026-05-16 — Allowlist baseline, not hard-fail.** Adding the
  test as hard-fail today would break CI with 166 offenders and
  pressure us to disable it. Allowlist baseline closes the
  regression door while keeping CI green; the allowlist shrinks
  through Phases 2-4 and is removed in Phase 5.
- **2026-05-16 — `PGN_NOT_IN_DB` requires ≥6-ply DB prefix.** 6
  plies is the point where named openings start diverging
  meaningfully. A line whose first 6 plies don't appear anywhere
  in the 3,641-entry DB is by definition invented.

## Sequencing logic

Phases are ordered by **harm reduction per line of work**:
1. Phase 1 first — prevents the bug class from growing further.
   Cheap, no data risk.
2. Phase 2 next — the 2 INVERTED_MATE entries are the worst UX
   (student literally gets mated). Easy fix (just move them).
3. Phase 3 third — 37 invented lines violate G3 (the strongest
   contract in CLAUDE.md). Each deletion eliminates a fabricated-
   chess-content lesson.
4. Phase 4 last — the bulk grind, but each individual entry is
   lower harm than the Phase 2-3 cases.

## Next-session pickup

If you're resuming this work cold:
1. Re-run both audit scripts. The flag counts should match the
   numbers in §Audit script unless someone landed Phase 2+.
2. Check the baseline file `src/data/repertoire-orientation-baseline.json` —
   the keys still in it are the unfixed entries.
3. Pick a batch from the next pending phase. Keep PR scope tight.
4. After every data change, re-run the audit; the baseline allowlist
   should shrink (delete any keys that now pass).

## Out of scope

- Surfaces that consume trap content (OpeningDetailPage, train-traps,
  trap-walkthrough/trap-learn/trap-practice/trap-play view modes) are
  NOT changed by this plan. They render whatever is in the data — fix
  the data, surface fixes itself.
- The stage-gen / drill / findMove / punish DB-anchoring work
  (commits `1927ab9`, `2094ce5`) is orthogonal; this plan only
  touches the static repertoire data.
- pro-repertoires.json's `trap-line-classifications.json` sidecar is
  unchanged. Repertoire.json gets its own enforcement; the two
  systems stay decoupled.
