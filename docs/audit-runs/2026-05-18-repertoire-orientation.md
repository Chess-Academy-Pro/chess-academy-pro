# Repertoire Orientation Audit — 2026-05-18

Source: `scripts/audit-repertoire-orientation.mjs`
Inputs: `src/data/repertoire.json` (`trapLines[]` and `warningLines[]`)

Same trap-orientation contract as the pro-repertoires audit, applied
to the main 40-opening repertoire. **Much higher flag density** — the
repertoire content has not yet been through the orientation cleanup
pass that pro-repertoires went through.

## Snapshot

- **259 entries audited** (141 trapLines + 118 warningLines)
- **98 clean**, **161 flagged (62%)**

| Category | Count |
|---|---|
| INVERTED_MATE | 0 |
| INVERTED_MATERIAL | 8 |
| TOOTHLESS_WARNING | 5 |
| WEAK_TRAP | 128 |
| STUDENT_NOT_PUNISHER | 60 |
| PGN_NOT_IN_DB | 34 |
| PGN_PARSE_ERROR | 0 |

## INVERTED_MATERIAL — student ends DOWN material (8)

These are the most damaging — they teach students to enter losing
positions as if they were traps.

- `italian-game::Fried Liver Attack` — white -5 material. PGN
  continues into Black's full counter-defense where Black equalizes.
  Truncate at the trap point (e.g. after Nxf7 Kxf7 Qf3+ Ke6 Nc3
  Nb4) instead of running to move 13.
- `italian-game::Giuoco Piano Queen Trap` — white -2
- `kings-gambit::Allgaier: King Hunt Continuation` — white -3
- `kings-gambit::Muzio: Total Development Lead` — white -6
- `budapest-gambit::Fajarowicz e-file Ambush` — black -4
- (3 more — see JSON report)

## TOOTHLESS_WARNING — student NOT punished (5)

`warningLines[]` are supposed to END with the student in trouble.
Five entries end with the student materially fine or better — they
should either be:
- moved to `trapLines[]` (kind=mistake or theme) since they actually
  reward the student, OR
- extended to include the punishment they're supposed to warn about.

## PGN_NOT_IN_DB — violates CLAUDE.md G3 (34)

34 PGNs don't anchor to any ≥6-ply prefix in `openings-lichess.json`.
These violate the "Lichess DB is canonical" rule. Either the PGN
contains a non-canonical move sequence, or the entry should be moved
to a properly-recognized opening.

## Fix strategy

This is a large data-curation effort. The reference is
`docs/plans/2026-05-16-trap-orientation.md` which tracks the
multi-phase cleanup. The pro-repertoires file went through Phase 1
and has only 19 remaining flags; repertoire.json hasn't gone through
yet and has 161.
