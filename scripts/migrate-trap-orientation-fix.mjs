#!/usr/bin/env node
/**
 * One-shot data migration:
 *   1. Move 4 truly-inverted trapLines into warningLines (anti-traps
 *      the student should AVOID, not weapons they deploy).
 *   2. Delete the 3 Noah's Ark Trap entries from White Ruy Lopez
 *      repertoires (Noah's Ark is a Black weapon — wrong-side content).
 *   3. Add 3 new White-perspective Ruy Lopez weapons drawn from the
 *      Lichess opening DB canonical entries.
 *   4. Update trap-line-classifications.json: drop the inverted +
 *      deleted entries, add the 5 previously-unclassified entries,
 *      and add classifications for the 3 new white-side weapons.
 *
 * Run once: `node scripts/migrate-trap-orientation-fix.mjs`. Idempotent
 * (re-running is a no-op once changes are applied).
 */
import { readFile, writeFile } from 'node:fs/promises';

const REPS_PATH = 'src/data/pro-repertoires.json';
const CLS_PATH = 'src/data/trap-line-classifications.json';

const INVERTED = [
  // These end with the student literally losing material in the PGN.
  // The lines correctly show "what happens if you fall into X" — i.e.
  // they're warnings, not weapons. Reframe by moving to warningLines.
  ['pro-gothamchess-caro-kann', 'Advance Variation Qb6 Fork'],
  ['pro-firouzja-grunfeld', 'Nxc3 Qa5+ Exchange Trick'],
  ['pro-ericrosen-englund', 'Englund Queen Trap'],
  ['pro-chesswithakeem-scotch', 'Bc5 Fork Setup'],
];

const NOAHS_ARK = [
  // Noah's Ark Trap is a BLACK weapon: Black uses ...b5/...c5/...c4
  // to entomb the white light-squared bishop on b3. Listing it as
  // a trapLine on WHITE Ruy Lopez repertoires is reversed — the
  // student playing white would be the VICTIM, not the trap-setter.
  ['pro-carlsen-ruy-lopez', "Noah's Ark Trap"],
  ['pro-firouzja-ruy-lopez', "Noah's Ark Trap"],
  ['pro-praggnanandhaa-ruy-lopez', "Noah's Ark Trap"],
];

// Replacement white-side Ruy Lopez weapons. PGNs drawn from
// openings-lichess.json canonical entries (per CLAUDE.md "DB is the
// source of truth" rule). The explanation field describes the
// punishment that follows when the position is reached.
const NEW_WHITE_RL_TRAPS = {
  'pro-carlsen-ruy-lopez': {
    name: 'Berlin Tarrasch Trap',
    pgn: 'e4 e5 Nf3 Nc6 Bb5 d6 d4 Bd7 Nc3 Nf6 O-O Be7 Re1 O-O',
    explanation:
      "After Black castles too early in the Steinitz/Berlin setup, White wins a piece with 8.Bxc6 Bxc6 9.dxe5 dxe5 10.Qxd8 Raxd8 11.Nxe5 Bxe4 12.Nxe4 Nxe4 13.Nd3 — Black's knight on e4 has no good retreat. A classical 19th-century opening trap documented under Ruy Lopez: Berlin Defense, Tarrasch Trap (ECO C66).",
    classification: 'mistake',
    // Reasoning: the win materializes 5+ plies after the canonical
    // line ends. Per the kind taxonomy, only forced gains within ~3
    // plies merit a red TRAP tile; this is a "now you're better via
    // accurate play" punishment, so mistake-class is more honest.
  },
  'pro-firouzja-ruy-lopez': {
    name: 'Open Tarrasch Trap',
    pgn:
      'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4 d4 b5 Bb3 d5 dxe5 Be6 c3 Be7 Re1 O-O Nd4 Qd7 Nxe6 fxe6 Rxe4',
    explanation:
      "In the Open Spanish, Black's 9...Be7 (instead of the correct 9...Bc5) allows the Tarrasch Trap. After 11.Nd4 Qd7 12.Nxe6 fxe6 13.Rxe4, the rook lift wins material: if 13...dxe4 then 14.Qxd7 wins the queen, and 13...Bd6 14.Rxe6 keeps White up a clear pawn with active pieces. ECO C83.",
    classification: 'trap',
  },
  'pro-praggnanandhaa-ruy-lopez': {
    name: "Bird's Defense Refutation",
    pgn: 'e4 e5 Nf3 Nc6 Bb5 Nd4 Nxd4 exd4 O-O',
    explanation:
      "Bird's Defense (3...Nd4) is a known dubious sideline: trading the knight on d4 leaves Black with a doubled isolated d-pawn and a tempo deficit. After 4.Nxd4 exd4 5.O-O, White finishes development unmolested while Black still has to solve the cramped d-pawn. ECO C61 (Ruy Lopez: Bird Variation).",
    classification: 'mistake',
  },
};

const NEW_UNCLASSIFIED = {
  // Previously missing from trap-line-classifications.json; identified
  // by audit-trap-orientation.mjs.
  'pro-dubov-italian::Dubov\'s Queen Sacrifice': 'trap',
  'pro-ericrosen-london::Premature ...e5 Refuted': 'mistake',
  'pro-annacramling-qgd::Premature ...Qxd4 Punished': 'mistake',
  'pro-annacramling-cow::Premature White Attack Punished by ...e5': 'theme',
  'pro-chesswithakeem-caro-kann::Premature h4 by White Punished': 'theme',
};

async function main() {
  const reps = JSON.parse(await readFile(REPS_PATH, 'utf8'));
  const clsFile = JSON.parse(await readFile(CLS_PATH, 'utf8'));

  let movedToWarnings = 0;
  let deletedNoah = 0;
  let addedNew = 0;
  const removedClassifications = [];

  // ─── 1. Move INVERTED entries from trapLines to warningLines ────
  for (const [openingId, trapName] of INVERTED) {
    const op = reps.openings.find((o) => o.id === openingId);
    if (!op) throw new Error(`opening not found: ${openingId}`);
    op.trapLines = op.trapLines ?? [];
    op.warningLines = op.warningLines ?? [];

    const idx = op.trapLines.findIndex((t) => t.name === trapName);
    if (idx === -1) continue; // already moved (idempotency)
    const [entry] = op.trapLines.splice(idx, 1);
    op.warningLines.push(entry);
    movedToWarnings++;

    const key = `${openingId}::${trapName}`;
    if (clsFile.classifications[key]) {
      delete clsFile.classifications[key];
      removedClassifications.push(key);
    }
  }

  // ─── 2. Delete NOAH'S ARK entries from white repertoires ────────
  for (const [openingId, trapName] of NOAHS_ARK) {
    const op = reps.openings.find((o) => o.id === openingId);
    if (!op) throw new Error(`opening not found: ${openingId}`);
    const idx = (op.trapLines ?? []).findIndex((t) => t.name === trapName);
    if (idx === -1) continue;
    op.trapLines.splice(idx, 1);
    deletedNoah++;

    const key = `${openingId}::${trapName}`;
    if (clsFile.classifications[key]) {
      delete clsFile.classifications[key];
      removedClassifications.push(key);
    }
  }

  // ─── 3. Add replacement white-side traps ────────────────────────
  for (const [openingId, replacement] of Object.entries(NEW_WHITE_RL_TRAPS)) {
    const op = reps.openings.find((o) => o.id === openingId);
    if (!op) throw new Error(`opening not found: ${openingId}`);
    op.trapLines = op.trapLines ?? [];
    // Idempotency: skip if a trap by this name already exists.
    if (op.trapLines.some((t) => t.name === replacement.name)) continue;
    op.trapLines.push({
      name: replacement.name,
      pgn: replacement.pgn,
      explanation: replacement.explanation,
    });
    addedNew++;

    const key = `${openingId}::${replacement.name}`;
    clsFile.classifications[key] = replacement.classification;
  }

  // ─── 4. Add previously-unclassified entries ─────────────────────
  let addedClassifications = 0;
  for (const [key, kind] of Object.entries(NEW_UNCLASSIFIED)) {
    if (clsFile.classifications[key]) continue;
    clsFile.classifications[key] = kind;
    addedClassifications++;
  }

  // ─── Write back ─────────────────────────────────────────────────
  await writeFile(REPS_PATH, JSON.stringify(reps, null, 2) + '\n');
  await writeFile(CLS_PATH, JSON.stringify(clsFile, null, 2) + '\n');

  console.log('Migration complete:');
  console.log(`  inverted entries moved to warningLines:  ${movedToWarnings}`);
  console.log(`  Noah's Ark entries deleted:              ${deletedNoah}`);
  console.log(`  new white-side traps added:              ${addedNew}`);
  console.log(`  unclassified entries classified:         ${addedClassifications}`);
  console.log(`  classifications removed (with deletes):  ${removedClassifications.length}`);
  for (const k of removedClassifications) console.log(`    - ${k}`);
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
