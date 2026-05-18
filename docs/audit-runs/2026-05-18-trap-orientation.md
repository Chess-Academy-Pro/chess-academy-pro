# Trap Orientation Audit — 2026-05-18

Source: `scripts/audit-trap-orientation.mjs`
Inputs: `src/data/pro-repertoires.json` (`trapLines[]` and `warningLines[]`),
        `src/data/trap-line-classifications.json` (kind sidecar)
Companion: `scripts/audit-repertoire-orientation.mjs` — same checks for `repertoire.json`.

This is the trap-orientation contract per `CLAUDE.md`:
- `trapLines[]` (kind=trap) — opponent makes a natural slip, **student**
  plays the principled refutation, and the PGN ends with student
  +material or mate.
- `trapLines[]` (kind=mistake) — student gains a positional/structural
  edge from the opponent's slip; ≥ 0 material at end.
- `trapLines[]` (kind=theme) — long maneuvering middlegame plan.
- `warningLines[]` — STUDENT falls into a trap and is punished.

## Snapshot

- **128 trap entries audited** (123 trap, 5 warning)
- **109 clean**, **19 flagged**

| Category | Count |
|---|---|
| INVERTED_MATE | 0 |
| INVERTED_MATERIAL | 1 |
| TOOTHLESS_WARNING | 0 |
| WEAK_TRAP | 17 |
| STUDENT_NOT_PUNISHER | 8 |
| UNCLASSIFIED | 1 |
| PGN_PARSE_ERROR | 0 |

## Highlights

### INVERTED_MATERIAL — student ends DOWN material (1)

- `pro-hikaru-english::Premature ...d4 Closing Center` —
  student plays white, ends -3 material. PGN: `c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 d3 O-O Be3 f5 Rc1 Be6 Na4 Nxa4`.
  Last move (Nxa4 by opponent) leaves student down 3.

### STUDENT_NOT_PUNISHER — trap PGN ends on opponent's move (8)

Among them:
- `pro-gothamchess-scandinavian::Bf5 e6 Bb4 Pin Trap` — ends with O-O by opponent
- `pro-gothamchess-qgd::Nb4-c2 Fork Threat` — ends with O-O by opponent
- `pro-carlsen-catalan::Queen Trapped on Diagonal` — ends with Qd7 by opponent
- `pro-carlsen-qgd::Bishop Catch with h6-g5` — ends with quiet move by opponent

### UNCLASSIFIED — missing from sidecar (1)

- `pro-naroditsky-grunfeld::Exchange Qa4+ Counter` — no entry in
  `trap-line-classifications.json`; default falls to bare-trap rendering.

## Fix strategy

These are CONTENT bugs in the JSON files. Fixes require:
1. **INVERTED_MATERIAL** — either extend PGN to where student wins
   material, or reclassify (mistake / theme) if the line really IS
   structural.
2. **STUDENT_NOT_PUNISHER** — append one more move (the student's
   punishment) so the line ends on the punishing side.
3. **WEAK_TRAP** — reclassify as `mistake` (positional) or `theme`
   (long maneuvering) in `trap-line-classifications.json`.
4. **UNCLASSIFIED** — add the entry to the sidecar with the
   correct kind.

See the JSON sidecar at `src/data/trap-line-classifications.json`
for the schema and existing classifications.
