# Structural Audit Report

Generated: 2026-05-13T19:56:34.582Z
Total scripted-move records scanned: **43141**

## Counts

| Finding | Count |
|---|---:|
| Bare / empty annotations | 11728 |
| Filler annotations | 0 |
| Illegal moves (PGN won't parse) | 0 |
| SAN ↔ replay drift | 0 |
| Illegal arrows | 0 |
| Classification ↔ text sanity | 0 |
| Templated-phrase clusters (≥25 reuses) | 50 |

## Templated-phrase clusters

Phrases appearing ≥ 25 times across the corpus — likely filler the
regex list hasn't learned yet. Candidates for new patterns.

| Count | Phrase | Sample opening |
|---:|---|---|
| 139 | we're opening with the queen's pawn immediately staking a claim to the central e and c squares while | amazon-attack-siberian-attack |
| 138 | d stakes a claim in the center central pawns control space and restrict the opponent's piece activit | albin-countergambit |
| 134 | we're opening with the queen's pawn immediately staking a claim to the central e and c squares while | benko-gambit-accepted-central-storming-variation |
| 92 | white moves the bishop to e the bishop on e controls key diagonal squares and maintains active piece | alekhine-defence |
| 89 | black moves the bishop to e the bishop on e controls key diagonal squares and maintains active piece | alekhine-defence |
| 87 | e stakes a claim in the center central pawns control space and restrict the opponent's piece activit | albin-countergambit |
| 83 | black moves the knight to d the knight on d improves black's piece coordination and flexibility | alekhine-defence |
| 83 | black brings the knight to its natural square on f the knight on f improves black's piece coordinati | gambit-benko-gambit |
| 80 | black activates the knight on f the knight on f improves black's piece coordination and flexibility | alekhine-defence |
| 79 | white activates the knight on f the knight on f improves white's piece coordination and flexibility | alekhine-defence |
| 78 | black deploys the knight to f the knight on f improves black's piece coordination and flexibility | alekhine-defence |
| 74 | g pushes on the kingside this pawn advance gains space and can support a future attack toward the en | albin-countergambit |
| 73 | white places the knight on the active f square the knight on f improves white's piece coordination a | alekhine-defence |
| 71 | black places the knight on the active f square the knight on f improves black's piece coordination a | alekhine-defence |
| 70 | white deploys the knight to f the knight on f improves white's piece coordination and flexibility | alekhine-defence |
| 68 | white develops the knight to c the knight on c improves white's piece coordination and flexibility | alekhine-defence |
| 68 | white develops the knight to f the knight on f improves white's piece coordination and flexibility | alekhine-defence |
| 68 | black moves the bishop to d the bishop on d controls key diagonal squares and maintains active piece | alekhine-defence |
| 67 | black develops the knight to f the knight on f improves black's piece coordination and flexibility | alekhine-defence |
| 66 | white moves the knight to c the knight on c improves white's piece coordination and flexibility | alekhine-defence |
| 61 | white moves the rook to e the rook takes up a powerful position on the e-file pressuring black's pos | alekhine-defence |
| 60 | white brings the knight to its natural square on f the knight on f improves white's piece coordinati | alekhine-defence |
| 59 | white moves the knight to d the knight on d improves white's piece coordination and flexibility | alekhine-defence |
| 57 | white moves the bishop to d the bishop on d controls key diagonal squares and maintains active piece | gambit-benko-gambit |
| 55 | black moves the rook to e the rook takes up a powerful position on the e-file pressuring white's pos | alekhine-defence |
| 54 | white moves the queen to d the queen takes up an influential position on d eyeing multiple targets | alekhine-defence |
| 53 | exd stakes a claim in the center central pawns control space and restrict the opponent's piece activ | albin-countergambit |
| 53 | white deploys the knight to c the knight on c improves white's piece coordination and flexibility | gambit-benko-gambit |
| 51 | white brings the knight to its natural square on c the knight on c improves white's piece coordinati | alekhine-defence |
| 50 | white captures the pawn on d white improves piece placement heading into the critical phase of the g | alekhine-defence |
| 50 | white moves the bishop to g the bishop on g controls key diagonal squares and maintains active piece | gambit-benko-gambit |
| 50 | white moves the rook to d the rook takes up a powerful position on the d-file pressuring black's pos | gambit-benko-gambit |
| 46 | white places the knight on the active c square the knight on c improves white's piece coordination a | gambit-benko-gambit |
| 45 | f pushes on the kingside this pawn advance gains space and can support a future attack toward the en | albin-countergambit |
| 45 | black moves the knight to c the knight on c improves black's piece coordination and flexibility | alekhine-defence |
| 45 | black captures the pawn on d black improves piece placement heading into the critical phase of the g | alekhine-defence |
| 45 | white moves the knight to d the knight reaches a powerful central outpost on d controlling multiple  | gambit-benko-gambit |
| 44 | black places the knight on the active c square the knight on c improves black's piece coordination a | alekhine-defence |
| 44 | black moves the knight to f the knight on f improves black's piece coordination and flexibility | alekhine-defence |
| 44 | white activates the knight on c the knight on c improves white's piece coordination and flexibility | gambit-benko-gambit |
| 42 | white moves the knight to f the knight on f improves white's piece coordination and flexibility | alekhine-defence |
| 41 | black moves the knight to a the knight on a improves black's piece coordination and flexibility | alekhine-defence |
| 41 | black moves the bishop to f the bishop on f controls key diagonal squares and maintains active piece | alekhine-defence |
| 41 | we're opening with the queen's pawn immediately staking a claim to the center and controlling the im | dutch-defense |
| 40 | black deploys the knight to c the knight on c improves black's piece coordination and flexibility | budapest-gambit |
| 40 | black moves the bishop to g the bishop on g controls key diagonal squares and maintains active piece | caro-kann |
| 39 | dxe stakes a claim in the center central pawns control space and restrict the opponent's piece activ | albin-countergambit |
| 39 | cxd stakes a claim in the center central pawns control space and restrict the opponent's piece activ | benoni-defence |
| 38 | re places the rook on a central file where it will be most active rooks belong on open or semi-open  | albin-countergambit |
| 38 | nxe  this capture changes the character of the position be alert | albin-countergambit |

## Bare-annotation breakdown by opening (top 20)

| Opening | Bare-annotation count |
|---|---:|
| gambit-benko-gambit | 482 |
| sicilian-najdorf | 397 |
| marshall-attack | 358 |
| sicilian-sveshnikov | 336 |
| kings-indian-defence | 320 |
| sicilian-dragon | 318 |
| dutch-defence | 308 |
| albin-countergambit | 303 |
| london-system | 297 |
| grunfeld-defence | 295 |
| sicilian-alapin | 294 |
| smith-morra-gambit | 283 |
| semi-slav | 282 |
| scotch-game | 273 |
| catalan-opening | 262 |
| kings-gambit | 262 |
| stafford-gambit | 262 |
| danish-gambit | 258 |
| englund-gambit | 250 |
| reti-opening | 250 |
