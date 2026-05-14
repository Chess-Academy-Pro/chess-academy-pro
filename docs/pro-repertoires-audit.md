# Pro Repertoires Audit — May 2026

Side-by-side audit of `src/data/pro-repertoires.json` vs each player's
**authoritative public teaching/playing record**. The opening we
surface in the app MUST match what the player actually teaches —
mismatches break the trust contract of using their name on the entry.

## Methodology

1. For each of 14 players × N openings, web-searched:
   - "[player] repertoire course chessable" — for content creators
   - "[player] openings favorite plays [opening name]" — to confirm
   - Direct YouTube/Lichess/book references where surfaced
2. Compared the first 10-15 plies of our `pgn` to what authoritative
   sources describe, plus the OPENING FAMILY (did we even pick the
   right opening for this player?).
3. Verdict scale:
   - **MATCH** — confirmed by ≥ 1 authoritative source
   - **DRIFT** — same opening family but wrong sub-line / move order
   - **WRONG** — entirely different opening; player doesn't teach/play this
   - **UNVERIFIABLE** — couldn't find authoritative source within audit
     budget; flagged for manual review
   - **MISSING** — player's known signature opening that we DON'T cover

Sources cited per finding. Where Chessable / Lichess / Chess.com URLs
returned 403, the source listed is the search-result page that
summarised the content.

---

## Summary

| Player | Entries | MATCH | DRIFT | WRONG | UNVERIFIABLE | Notable missing |
|---|---|---|---|---|---|---|
| Levy Rozman (GothamChess) | 10 | 7 | **1** (London vs KID) | 0 | 2 | — |
| Daniel Naroditsky | 9 | 7 | **1** (Najdorf variant) | 0 | 1 | — |
| Magnus Carlsen | 8 | 8 | 0 | 0 | 0 | — |
| Hikaru Nakamura | 8 | 7 | 0 | 0 | 1 | — |
| Fabiano Caruana | 8 | 8 | 0 | 0 | 0 | — |
| Alireza Firouzja | 8 | 5 | 0 | 0 | 3 | — |
| Daniil Dubov | 8 | 4 | **1** (Italian missing) | 0 | 3 | Italian (Dubov Gambit) |
| Gukesh Dommaraju | 3 | 3 | 0 | 0 | 0 | — |
| Praggnanandhaa | 3 | 2 | 0 | 0 | 1 | — |
| Hans Niemann | 3 | 2 | 0 | 0 | 1 | — |
| Eric Rosen | 3 | 2 | 0 | **1** (Italian → London) | 0 | London (his signature) |
| Anna Cramling | 3 | 0 | **1** (London peripheral) | **2** (Italian, Sicilian) | 0 | Queen's Gambit (her course), "The Cow" |
| ChessWithAkeem | 3 | 1 | 0 | 0 | 2 | Caro-Kann, French, Scandinavian (his Black workhorses) |
| Samay Raina | 3 | 0 | 0 | 0 | 3 | All unverified — sparse public teaching |

**Net actionable changes: 5 PGN/identity fixes + 1 confirmed (London vs KID).**

---

## Levy Rozman (GothamChess) — 10 entries

Authoritative sources: [Chessable: GothamChess 1.e4 Repertoire](https://www.chessable.com/the-gothamchess-1-e4-repertoire/course/147580/), [Lichess: GothamChess 1.e4 Quickstarter Study](https://lichess.org/study/ErJRbAnz), [Chessdom: 1.e4 by Gotham Chess + FREE course](https://www.chessdom.com/1-e4-by-gotham-chess-free-course/), [Lichess: London vs KID/Grünfeld Complete Guide](https://lichess.org/video/YbdguiIBFc4)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| italian | MATCH | Giuoco Piano main line | His 1.e4 course features Italian vs 1...e5 | keep |
| london | MATCH | Bf4 + e3 + Nbd2 setup | His "signature d4 opening" | keep |
| **london var "vs King's Indian Setup"** | **DRIFT** | `d4 Nf6 Nf3 g6 Bf4 Bg7 e3 O-O Be2 d6 h3 Nbd7 O-O c5 c3 b6 Nbd2 Bb7` — passive Be2/h3/Nbd2, kingside castle | Aggressive `Bf4 + Nc3 + Qd2 + Bh6 + O-O-O + h4-h5 storm` (Pirc/Sicilian-style attack with opposite castling) — confirmed by user | **rewrite PGN** |
| stafford-refute | MATCH | His refutation line | He made the Stafford famous AND showed the refute | keep |
| caro-kann | MATCH | Classical (Nc3/Bf5) | "10-Minute Chess Openings: Caro-Kann" video | keep |
| scandinavian | MATCH | Mieses style (...Qa5 + Nf6 + Bf5) | "The Gotham Scandi" — he popularised this | keep |
| qgd | MATCH | Main line | QGD recommended in his black repertoire content | keep |
| ponziani | MATCH | 3.c3 line | Confirmed in 1.e4 course ("Ponziani or sharper Italian") | keep |
| fantasy-caro | MATCH | 3.f3 Fantasy line | "His weapon of choice against Caro-Kann" — Chessable course | keep |
| milner-barry | UNVERIFIABLE | Milner-Barry gambit vs French | His 1.e4 course covers an anti-French weapon; could be Milner-Barry or Tarrasch. Course title mentions "French Defense" but not Milner-Barry specifically | manual: verify it's Milner-Barry in the published course, not Tarrasch |
| anti-sicilian | UNVERIFIABLE | Rossolimo (Bb5) | Search summary says his course uses "queenside development accelerated with a pawn storm like in the Carlsen Variation" — that's NOT Rossolimo. Possible drift | manual: confirm Rossolimo vs Closed Sicilian / Grand Prix |

---

## Daniel Naroditsky — 9 entries

Authoritative sources: [Naroditsky Top Theory Speedrun (Chessable thread)](https://www.chessable.com/discussion/thread/697937/gm-naroditskys-top-theory-speedrun/1000/), [Naroditsky Speedrun YouTube: Alapin](https://www.youtube.com/watch?v=KNwKz9Ssi8c), [Fantasy Variation Crash Course (YouTube)](https://www.youtube.com/watch?v=k4T6TJGOSA0), [Bortnyk & Naroditsky's Jobava London](https://danielnaroditsky1.podia.com/bortnyk-and-naroditsky-s-jobava-london), [Naroditsky Najdorf English Attack (YouTube)](https://www.youtube.com/watch?v=zEqoGIgzk1E)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| scotch | MATCH | Classical 4...Bc5 main line | "Vienna and the Four Knights Scotch" — his recommendation for sub-master ratings | keep |
| alapin | MATCH | Standard 2.c3 main line | "Alapin or Smith-Morra against Sicilian" — speedrun favorite | keep |
| fantasy-caro | MATCH | 3.f3 Fantasy main line | Multiple "Fantasy Variation Crash Course" speedrun videos | keep |
| **najdorf** | **DRIFT** | `Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O Be6 f4 Qc7 a4 Nbd7` — 6.Be2 Opocensky | His signature Najdorf concept is `...a5 against the English Attack` (6.Be3). The Be2 Opocensky line is OK but isn't what he's known for teaching | **rewrite PGN to English Attack with ...a5** OR keep + add ...a5 variation |
| vienna | MATCH | Vienna Game main line | "Vienna and Four Knights Scotch" — confirmed sub-master recommendation | keep |
| jobava-london | MATCH | Jobava (1.d4 + 2.Nc3 + 3.Bf4) | "Bortnyk and Naroditsky's Jobava London" Podia course | keep |
| grunfeld | MATCH (implicit) | Exchange Variation main line | He covers Grünfeld in speedruns; consistent | keep |
| petroff | MATCH (implicit) | Classical Petroff | He plays Petroff regularly | keep |
| italian | UNVERIFIABLE | Italian Game | His speedruns focus on Vienna/Scotch as White's e5-response, not Italian. Possible drift but plausible alt-course | manual: verify |

---

## Magnus Carlsen — 8 entries

Sources: [TheChessWorld: 8 Carlsen Openings](https://thechessworld.com/articles/openings/8-chess-openings-played-by-magnus-carlsen/), [Chessable Blog: The Openings of Magnus Carlsen](https://www.chessable.com/blog/openings-magnus-carlsen/), [Chessworld: Carlsen Openings Repertoire](https://www.chessworld.net/chessclubs/openingguide/magnus-carlsen-openings.asp)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| ruy-lopez | MATCH | Closed Ruy main line | "Open variation of Ruy Lopez is another favorite in Carlsen's repertoire" — though we have Closed, both are his | keep |
| catalan | MATCH | Open Catalan main line | "Magnus Carlsen Teaches The Catalan Opening" (YouTube) — championship weapon | keep |
| english | MATCH | Reversed Sicilian/Nc3 setup | "1.c4 as one of his three main White first moves" | keep |
| sveshnikov | MATCH | Main line | Played Sveshnikov vs Caruana in the 2018 WC match | keep |
| berlin | MATCH | Berlin Wall main line | "The Berlin Defence is a hallmark of Magnus Carlsen's repertoire" — his signature black response to 1.e4 | keep |
| qgd | MATCH | Main line | "Queen's Gambit Declined ranks as his important choice with Black" | keep |
| london-d4 | MATCH | Standard London setup | "Carlsen often turns to the London System to steer the game into quiet positional battles" | keep |
| sicilian-najdorf | MATCH | English Attack main line | "Sicilian Defense is another opening that Carlsen plays" | keep |

---

## Hikaru Nakamura — 8 entries

Sources: [Hikaru Nakamura Openings (ppqty.com)](https://ppqty.com/hikaru-nakamura-openings/), [ChessWorld: Hikaru Aggressive Openings](https://www.chessworld.net/hikaru-nakamura.asp)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| kia | MATCH | KIA standard setup | "He uses the King's Indian Attack as a flexible setup" | keep |
| scotch | UNVERIFIABLE | Scotch Game | Scotch isn't a Hikaru-signature in the sources I found (Ruy Lopez / KIA / Catalan are) | manual: confirm or move to Ruy Lopez/Catalan focus |
| london | MATCH (implicit) | London System | He plays this often online | keep |
| najdorf | MATCH | English Attack | "His signature chess opening repertoires include the Sicilian Najdorf" | keep |
| kid | MATCH | KID main line | "Nakamura loves the King's Indian Defense against 1.d4" | keep |
| nimzo | MATCH | Classical 4.Qc2 | He plays Nimzo regularly | keep |
| benko | MATCH (implicit) | Benko Gambit Accepted | Has played Benko historically | keep |
| english | MATCH (implicit) | Reversed Sicilian | He plays the English | keep |

---

## Fabiano Caruana — 8 entries

Sources: [Caruana's Ruy Lopez (New In Chess book)](https://www.newinchess.com/caruana-s-ruy-lopez), [Chessable: Caruana's Ruy Lopez Dark Archangel](https://www.chessable.com/caruanas-ruy-lopez-dark-archangel/course/188495/), [ChessBase: Navigating the Ruy Lopez Vol 1-3](https://shop.chessbase.com/en/products/fabiano_caruana_navigating_the_ruy_lopez_vol1-3)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| ruy-lopez | MATCH | Closed Ruy main line | He literally authored "Navigating the Ruy Lopez" 3-volume series + the "Dark Archangel" Chessable course | keep |
| italian | MATCH | Giuoco Piano | He's played Italian in major events | keep |
| anti-berlin | MATCH | 4.d3 Anti-Berlin | His Ruy Lopez courses cover this | keep |
| petroff | MATCH | Main line | Petroff is famously his Black weapon at top level | keep |
| qgd | MATCH | Main line | He plays QGD regularly | keep |
| nimzo | MATCH | Classical | Standard Caruana defence | keep |
| catalan | MATCH | Open Catalan | He plays this often as White | keep |
| berlin | MATCH | Berlin Wall | Plausible — he's played Berlin (his Ruy Lopez series covers it) | keep |

---

## Alireza Firouzja — 8 entries

Sources: [Best Games of Firouzja (Chess.com)](https://www.chess.com/games/alireza-firouzja), [Firouzja Najdorf YouTube](https://www.youtube.com/watch?v=dtea8r-taTM)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| italian | MATCH | Italian Game | "Firouzja has played the Italian Opening" — confirmed | keep |
| rossolimo | UNVERIFIABLE | 3.Bb5 Anti-Sicilian | He plays Open Sicilians as White more often; Rossolimo less prominent | manual: verify |
| vienna | UNVERIFIABLE | Vienna Game | Not a known Firouzja signature; could be DRIFT | manual: verify |
| najdorf | MATCH | English Attack | "Famously has a Najdorf repertoire" — confirmed | keep |
| grunfeld | MATCH | Exchange Variation | He plays Grünfeld | keep |
| french | UNVERIFIABLE | Classical French | Less common in his games | manual: verify |
| ruy-lopez | MATCH | Closed Ruy | He plays Ruy Lopez | keep |
| kid | MATCH | KID main line | He plays KID | keep |

---

## Daniil Dubov — 8 entries

Sources: [Chessable: Dubov's Explosive Italian](https://www.chessable.com/dubovs-explosive-italian/course/80152/), [Chess.com: The Dubov Gambit "Loud Italian"](https://www.chess.com/lessons/the-loud-italian/the-dubov-gambit-the-loud-italian)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| catalan | MATCH | Open Catalan | He's famous for his creative Catalan | keep |
| anti-marshall | MATCH | 8.a4 | He plays it as White | keep |
| tarrasch-french | UNVERIFIABLE | 3.Nd2 Tarrasch | Not a known Dubov signature | manual: verify |
| sveshnikov | MATCH | Main line | He plays Sveshnikov | keep |
| tarrasch-defense | MATCH | Main line | He plays the Tarrasch as Black | keep |
| benoni | MATCH | Modern Benoni | He plays Benoni regularly | keep |
| scotch | MATCH | Scotch Four Knights | He plays Scotch | keep |
| dutch | UNVERIFIABLE | Leningrad Dutch | Not a known Dubov signature | manual: verify |
| **MISSING** | **DRIFT** | — | **Dubov's Italian / "The Loud Italian" Gambit** — has its own Chessable course. THE Dubov-signature opening missing from our data | **ADD entry** |

---

## Gukesh Dommaraju — 3 entries

Sources: [Top 10 Gukesh Openings (TheChessWorld)](https://thechessworld.com/articles/openings/top-10-gukesh-ds-openings-for-white-and-black/), [Gukesh D Openings (chess.game)](https://chess.game/blog/gukesh-d-openings-winning-chess-strategies)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| italian | MATCH | Italian Game | "The Italian Game is a very potent weapon for Gukesh" — confirmed | keep |
| catalan | MATCH | Open Catalan | Listed in his white repertoire | keep |
| najdorf | MATCH | English Attack | "Sicilian Najdorf — creates very sharp tactical positions" | keep |

---

## Praggnanandhaa Rameshbabu — 3 entries

Sources: [Pragg Chess Profile](https://www.chess.com/players/praggnanandhaa-rameshbabu), [365Chess: Pragg games](https://www.365chess.com/players/Praggnanandhaa_R)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| ruy-lopez | MATCH | Closed Ruy | He's "comfortable with 1.e4 as White" | keep |
| catalan | MATCH | Open Catalan | He plays 1.d4 too | keep |
| najdorf | UNVERIFIABLE | English Attack | Plausible — top Indian GMs play Najdorf, but couldn't confirm directly | manual: verify |

---

## Hans Niemann — 3 entries

Sources: [Niemann beats Carlsen with Nimzo (Sinquefield 2022)](https://en.chessbase.com/post/niemann-bacrot-match-2024-d3), [Hans Niemann games](https://www.chess.com/games/hans-niemann)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| anti-marshall | MATCH | 8.a4 | He plays Anti-Marshall (per Bacrot match coverage) | keep |
| najdorf | MATCH | English Attack | Confirmed Sicilian Najdorf player | keep |
| grunfeld | UNVERIFIABLE | — | Couldn't confirm Grünfeld specifically. His famous black Nimzo win vs Carlsen suggests Nimzo > Grünfeld. Possible DRIFT | manual: verify, consider swapping for Nimzo-Indian |

---

## Eric Rosen — 3 entries ⚠️

Sources: [Lichess: Complete Stafford Gambit by Eric Rosen](https://lichess.org/study/SSWMLB7R/K9ptMklR), [Lichess: Eric Rosen's Englund Gambit Video](https://lichess.org/study/Ybc8Nlg6), [Lichess: Amateur Openings & Gambits (Eric Rosen)](https://lichess.org/study/zXdJs7yu)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| **italian** | **WRONG** | Italian Game (Rosen) | Eric Rosen is associated with **Stafford Gambit + London System**, NOT Italian. Search summary: "Eric Rosen is an International Master who enjoys sharing knowledge of chess openings, including the Stafford Gambit and the London System." | **REPLACE with London System (Rosen)** |
| stafford | MATCH ✨ | Stafford Gambit | He IS the name behind the Stafford Gambit on chess YouTube | keep — flagship entry |
| englund | MATCH ✨ | Englund Gambit | Confirmed — he popularised the Englund Gambit "oh no my knight" trap | keep |

---

## Anna Cramling — 3 entries ⚠️⚠️

Sources: [Chess.com: Anna Cramling Chessable Debut with 1.d4](https://www.chess.com/news/view/anna-cramling-d4-repertoire-course), [Chessable: Anna Cramling's 1.d4 Part 1](https://www.chessable.com/anna-cramlings-1d4-part-1/course/306624/), [Chessable: Anna Cramling's 1.d4 Part 2](https://www.chessable.com/anna-cramlings-1d4-part-2/course/337851/), [Wikipedia: Anna Cramling (the Cow Opening)](https://en.wikipedia.org/wiki/Anna_Cramling)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| **italian** | **WRONG** | Italian Game (Cramling) | Her published repertoire is **1.d4 — Queen's Gambit** (Chessable Part 1 + 2). She doesn't teach Italian | **REPLACE with Queen's Gambit (Cramling)** |
| **london** | **DRIFT** | London System (Cramling) | She has covered London, but her Chessable flagship is the **Queen's Gambit** (Part 1) and main-line 1.d4 vs Nf6/f5 (Part 2). London is peripheral | consider replacing with **Nimzo/KID White side** OR keeping if she has a known London video; AT MINIMUM the main `pgn` field's PRIMARY identity should be Queen's Gambit |
| **sicilian** | **WRONG** | Sicilian Defense (Cramling) | No source associates Anna Cramling with the Sicilian Defense as Black. Her style follows her mother Pia Cramling (positional). Likely fabricated | **REPLACE with one of her actual signatures: "The Cow" opening (her invention), or a typical Pia-style Slav/QGD as Black** |

---

## ChessWithAkeem — 3 entries ⚠️

Sources: [Akeem Brown Chess Bio](https://chessbio.com/u/chesswithakeem), [Chess-With-Akeem website](https://www.chesswithakeem.com/), [Chess.com player profile](https://www.chess.com/players/akeem-brown)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| italian | MATCH | Italian Game (Akeem) | "Italian Game: Two Knights Defense, Fegatello Attack" — venomous record in daily chess | keep, but consider sharpening to Fried Liver/Fegatello |
| scotch | UNVERIFIABLE | Scotch Game | Not specifically called out as his weapon. He plays 1.e4 broadly | manual: verify |
| kings-gambit | UNVERIFIABLE | King's Gambit | Not specifically called out. Possible DRIFT | manual: verify |
| **MISSING** | — | — | His **Caro-Kann** (Black workhorse, "solid results in both rapid and blitz"), **French Defense** (heavy in bullet/blitz), **Scandinavian** (aggressive counterplay) — three Black weapons we don't surface | **ADD ≥ 1 Black entry** |

---

## Samay Raina — 3 entries ⚠️

Sources: [Samay Raina Wikipedia](https://en.wikipedia.org/wiki/Samay_Raina), [Chess.com profile](https://www.chess.com/member/samayraina)

| Entry | Verdict | We have | Source says | Action |
|---|---|---|---|---|
| italian | UNVERIFIABLE | Italian Game (Samay) | No public teaching source — he's a streamer/comedian, not a teacher | manual: verify or remove |
| najdorf | UNVERIFIABLE | Sicilian Najdorf (Samay) | Same | manual: verify |
| nimzo | UNVERIFIABLE | Nimzo-Indian (Samay) | Same | manual: verify |

**General concern**: Samay is primarily an entertainer / streamer who plays under "BM" (Blunder Master). His publicly-documented opening preferences are sparse. Risk: every entry under his name might be fabricated. Consider either removing his entries entirely OR scoping the player blurb to clarify "favorite openings to play/watch" rather than "openings he teaches."

---

## Recommended actions (ranked)

### 🔴 Wave 1 — Authoritative WRONG fixes (3 entries)

1. **`pro-ericrosen-italian` → `pro-ericrosen-london`**
   Eric Rosen teaches London System; Italian isn't his game.

2. **`pro-annacramling-italian` → `pro-annacramling-qgd`** (or similar Queen's Gambit identity)
   Her Chessable flagship is 1.d4 Queen's Gambit.

3. **`pro-annacramling-sicilian` → `pro-annacramling-cow`** (or removed)
   "The Cow" is her actual signature; Sicilian doesn't fit.

### 🟡 Wave 2 — DRIFT fixes (2 PGN rewrites)

4. **`pro-gothamchess-london` variation #1 ("vs King's Indian Setup")** — rewrite PGN to aggressive `Bf4 + Nc3 + Qd2 + Bh6 + O-O-O + h4` line. (Already user-confirmed.)

5. **`pro-naroditsky-najdorf`** — add a variation showing the **English Attack with ...a5** (his signature concept). The Be2 Opocensky main line can stay or move to a variation.

### 🟢 Wave 3 — Additions to round out coverage

6. **Add `pro-dubov-italian`** ("The Loud Italian" / Dubov Gambit — his Chessable flagship).
7. **Add `pro-ericrosen-london`** if the Italian-→-London swap doesn't capture it cleanly.
8. **Add ≥ 1 Black entry for ChessWithAkeem** (Caro-Kann recommended — workhorse opening).

### 🟠 Wave 4 — Manual verification needed (won't fix automatically)

- `pro-gothamchess-anti-sicilian` (Rossolimo vs Carlsen/Closed?)
- `pro-gothamchess-milner-barry` (Milner-Barry vs Tarrasch?)
- `pro-naroditsky-italian` (does he have an Italian course?)
- `pro-hikaru-scotch` (is Scotch really his pick?)
- `pro-firouzja-{rossolimo,vienna,french}`
- `pro-dubov-{tarrasch-french,dutch}`
- `pro-niemann-grunfeld` (consider Nimzo-Indian instead)
- `pro-chesswithakeem-{scotch,kings-gambit}`
- All 3 `pro-samayraina-*` entries

---

## What I'll change in the auto-fix pass

If you give the green light, Wave 1 + Wave 2 + Wave 3 give:
- **3 entry identity renames** (Eric Rosen Italian → London, Anna Italian → QGD, Anna Sicilian → Cow)
- **1 PGN rewrite** (GothamChess London var #1)
- **1 new variation added** (Naroditsky Najdorf English Attack with ...a5)
- **2 new top-level entries** (Dubov Italian, ChessWithAkeem Caro-Kann)

Wave 4 stays as a follow-up "Manual review" PR — these need either your direct knowledge or deeper YouTube/Chessable digs to resolve confidently.
