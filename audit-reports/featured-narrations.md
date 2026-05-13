# Featured-Narrations Audit Report

Generated: 2026-05-13T21:08:19.381Z
Elapsed: 39384ms

Scope: 40 openings from `repertoire.json` + 80 pro entries from
`pro-repertoires.json`. Empty subline annotations are skipped per
user request — this audit covers content-only records.

## Confidence

- **piece-on-square** — high signal. Templated annotations slot a
  wrong piece name into capture sentences ("captures the knight on
  e5" when e5 holds a pawn). Almost all hits are real bugs.
- **templated-filler** — high signal. These annotations match the
  same generic patterns that `walkthroughNarration.ts` silently
  drops at runtime — i.e. the user never hears them, contributing
  to the perceived narration ↔ board desync.
- **hanging-piece / check-claim / mate-claim** — medium signal.
  Few hits; review individually.
- **illegal-arrow** — high signal when present (board would
  display an arrow that is not a legal move).
- *illegal-san is intentionally not run* — too noisy on legitimate
  references to past / future / thematic moves.

## Collection

| Bucket | Count |
|---|---:|
| Repertoire main-line moves (total / empty) | 769 / 0 |
| Repertoire subline moves (total / empty) | 18294 / 8786 |
| Repertoire variation explanations audited | 309 |
| Pro entries with annotation file | 13 |
| Pro standalone entries (inline only) | 67 |
| Pro overview blurbs audited | 80 |
| Pro variation explanations audited | 236 |
| **Total non-empty records audited** | **15020** |

## Findings by kind

| Kind | Count |
|---|---:|
| templated-filler | 4534 |
| piece-on-square | 3 |
| mate-claim | 1 |
| **TOTAL** | **4538** |

## Findings by source

| Source | Count |
|---|---:|
| rep-subline | 3426 |
| pro-subline | 1110 |
| repertoire-variation | 2 |

## Top openings by finding count

| Opening | Findings |
|---|---:|
| sicilian-sveshnikov | 154 |
| scotch-game | 139 |
| sicilian-alapin | 131 |
| four-knights-game | 128 |
| sicilian-najdorf | 125 |
| pro-carlsen-sicilian-najdorf | 125 |
| vienna-game | 122 |
| italian-game | 118 |
| ruy-lopez | 109 |
| benko-gambit | 109 |
| pro-carlsen-ruy-lopez | 109 |
| pro-caruana-ruy-lopez | 109 |
| pro-firouzja-ruy-lopez | 109 |
| pro-praggnanandhaa-ruy-lopez | 109 |
| trompowsky-attack | 105 |
| semi-slav | 105 |
| dutch-defence | 105 |
| pro-naroditsky-semi-slav | 105 |
| london-system | 103 |
| nimzo-indian | 100 |
| kings-gambit | 99 |
| sicilian-dragon | 99 |
| caro-kann | 99 |
| pro-gothamchess-caro-kann | 99 |
| pro-chesswithakeem-kings-gambit | 99 |

## piece-on-square (3)

| Source | Opening | Subline / Variation | Move# | SAN | Detail |
|---|---|---|---:|---|---|
| rep-subline | benoni-defence | Dubov: Modern Benoni (e4 System) | 12 | g6 | claims bishop on g7, square is empty |
| rep-subline | birds-opening | From's Gambit Refutation | 15 | Bg3 | claims bishop on h4, square is empty |
| rep-subline | birds-opening | Stonewall Kingside Attack | 19 | exd4 | claims pawn on e3, square is empty |

## mate-claim (1)

| Source | Opening | Subline / Variation | Move# | SAN | Detail |
|---|---|---|---:|---|---|
| repertoire-variation | sicilian-dragon | Yugoslav Attack Main Line | 36 | Rxc3 | narration claims checkmate, position is not mate |

## templated-filler (4534)

| Source | Opening | Subline / Variation | Move# | SAN | Detail |
|---|---|---|---:|---|---|
| rep-subline | italian-game | Giuoco Pianissimo | 14 | Ba7 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Evans Gambit | 8 | Bxb4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Evans Gambit | 10 | Ba5 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Evans Gambit | 11 | d4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Evans Gambit | 12 | exd4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Italian: Hungarian Defense | 3 | Nf3 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Italian: Hungarian Defense | 4 | Nc6 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Italian: Hungarian Defense | 12 | dxe5 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Italian: Hungarian Defense | 16 | Nf6 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Italian: Hungarian Defense | 19 | Nc3 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Two Knights Defense | 7 | d4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Two Knights Defense | 8 | exd4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Two Knights Defense | 10 | Nxe4 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Two Knights Defense | 12 | d5 | matches a runtime-suppressed generic pattern |
| rep-subline | italian-game | Two Knights Defense | 13 | Bxd5 | matches a runtime-suppressed generic pattern |
| … | … | (4519 more in JSON) | | | |
