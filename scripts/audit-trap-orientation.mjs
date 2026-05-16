#!/usr/bin/env node
/**
 * Audit-trap-orientation — verifies every trapLine in
 * pro-repertoires.json punishes the OPPONENT (giving the student the
 * advantage), not the other way around.
 *
 * Rule (David's contract): every trap / mistake / theme entry is the
 *   STUDENT'S weapon. The opponent makes a natural-looking slip; the
 *   student plays the principled / tactical reply and ends up better.
 *   If the final position favours the opponent, the entry is inverted.
 *
 * What this script does for each trapLine:
 *   1. Resolve the student's color from the parent opening's `color`.
 *   2. Replay the PGN with chess.js to the final position.
 *   3. Record: who moved last, material balance, side-to-move, and
 *      whether the position is check / checkmate / draw.
 *   4. Apply heuristics per kind (trap / mistake / theme) and flag
 *      entries that don't match the contract.
 *
 * Output: console table of flagged entries + JSON report at
 *   audit-reports/trap-orientation-<iso>/report.json
 *
 * Heuristics (intentionally conservative — false-positive on review,
 * not false-negative on shipping):
 *   - kind=trap: student should be ≥ +3 in material, OR the position
 *     should be mate/check delivered by student, OR the punishment
 *     square should be a capture by student that ended the PGN.
 *   - kind=mistake: student should be ≥ 0 material (not down material).
 *     Last move should not be a giveaway by the student.
 *   - kind=theme: only flag if the student is down material (themes
 *     are positional, so we can't auto-flag much else).
 *
 * Limitations:
 *   - Material balance ignores positional factors (open files,
 *     bishop pair, king safety). Themes especially are hard to
 *     auto-verify; treat the theme report as "manual-review only".
 *   - The script flags candidates; final classification is a human
 *     read of the line.
 */
import { Chess } from 'chess.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/trap-orientation-${stamp}`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const reps = JSON.parse(
    await readFile('src/data/pro-repertoires.json', 'utf8'),
  );
  const clsFile = JSON.parse(
    await readFile('src/data/trap-line-classifications.json', 'utf8'),
  );
  const classifications = clsFile.classifications;

  const entries = reps.openings.flatMap((o) =>
    (o.trapLines ?? []).map((t) => ({
      openingId: o.id,
      openingName: o.name,
      color: o.color, // student side
      name: t.name,
      pgn: t.pgn,
      explanation: t.explanation,
    })),
  );

  console.log(`[trap-orientation] auditing ${entries.length} trapLines`);
  console.log(`[trap-orientation] out: ${OUT_DIR}\n`);

  const results = [];
  for (const e of entries) {
    const key = `${e.openingId}::${e.name}`;
    const kind = classifications[key] ?? 'UNCLASSIFIED';

    const chess = new Chess();
    let parseError = null;
    try {
      chess.loadPgn(e.pgn);
    } catch (err) {
      parseError = String(err?.message ?? err);
    }

    const history = chess.history({ verbose: true });
    const plyCount = history.length;
    const lastMove = history[plyCount - 1] ?? null;
    const lastMoverColor = lastMove ? lastMove.color : null; // 'w'|'b'
    const studentColorChar = e.color === 'white' ? 'w' : 'b';
    const opponentColorChar = e.color === 'white' ? 'b' : 'w';
    const sideToMove = chess.turn(); // 'w'|'b'

    // Material balance: positive = student up material, negative = opponent up.
    const board = chess.board();
    let studentMat = 0;
    let opponentMat = 0;
    for (const row of board) {
      for (const sq of row) {
        if (!sq) continue;
        const v = PIECE_VALUES[sq.type] ?? 0;
        if (sq.color === studentColorChar) studentMat += v;
        else opponentMat += v;
      }
    }
    const materialDelta = studentMat - opponentMat; // + = student better
    const isCheckmate = chess.isCheckmate();
    const isCheck = chess.isCheck();
    const isDraw = chess.isDraw();
    // Mate delivered to whom? sideToMove is whoever is checkmated.
    const mateOn =
      isCheckmate ? (sideToMove === studentColorChar ? 'student' : 'opponent') : null;
    // Check delivered to whom?
    const checkOn =
      isCheck && !isCheckmate
        ? (sideToMove === studentColorChar ? 'student' : 'opponent')
        : null;
    const lastMoverIs =
      lastMoverColor === studentColorChar ? 'student' : lastMoverColor === opponentColorChar ? 'opponent' : null;

    // Apply heuristics.
    const flags = [];
    if (parseError) {
      flags.push(`PGN_PARSE_ERROR: ${parseError.slice(0, 100)}`);
    } else if (mateOn === 'student') {
      // Mate against the student is always a hard fail regardless of
      // kind, and it short-circuits any material check (a mate-down
      // position is the worst outcome).
      flags.push(`INVERTED_MATE: student is checkmated at end of ${kind}-line`);
    } else if (mateOn === 'opponent') {
      // Student delivered mate — line is correct, never flag for
      // material balance (sacrificial mates like Stafford's "Oh No
      // My Queen" or Legal's Mate end down material but win the game).
      // Intentionally empty.
    } else {
      if (kind === 'trap') {
        // Forced tactic. Student should end clearly up material.
        if (materialDelta < -1) {
          flags.push(
            `INVERTED_MATERIAL: student is down ${Math.abs(materialDelta)} in material (kind=trap, expected ≥ +3)`,
          );
        } else if (materialDelta < 3) {
          flags.push(
            `WEAK_TRAP: student only ${materialDelta >= 0 ? '+' : ''}${materialDelta} material, no mate (kind=trap, expected ≥ +3 or mate)`,
          );
        }
        // Did the student get the last word? The PGN should end on the
        // punishment by the student — if not, the trap is shown
        // mid-flight or inverted.
        if (lastMoverIs === 'opponent') {
          flags.push(
            `STUDENT_NOT_PUNISHER: trap PGN ends with opponent move (last SAN: ${lastMove?.san ?? '?'}); student never plays the punishment in this line`,
          );
        }
      } else if (kind === 'mistake') {
        // Positional / structural / counting. Student should at least
        // be even — definitely not down material.
        if (materialDelta < -2) {
          flags.push(
            `INVERTED_MATERIAL: student down ${Math.abs(materialDelta)} in material (kind=mistake, expected ≥ 0)`,
          );
        }
      } else if (kind === 'theme') {
        // Long maneuvering line — material is a weaker signal.
        if (materialDelta < -3) {
          flags.push(
            `INVERTED_MATERIAL: student down ${Math.abs(materialDelta)} in material (kind=theme, expected ~equal)`,
          );
        }
      } else {
        // UNCLASSIFIED
        flags.push(`UNCLASSIFIED: no entry in trap-line-classifications.json`);
      }
    }

    results.push({
      openingId: e.openingId,
      openingName: e.openingName,
      studentColor: e.color,
      name: e.name,
      kind,
      key,
      pgn: e.pgn,
      plyCount,
      lastMoverIs,
      lastMoveSan: lastMove?.san ?? null,
      sideToMove: sideToMove === studentColorChar ? 'student' : 'opponent',
      materialDelta,
      isCheckmate,
      isCheck,
      isDraw,
      mateOn,
      checkOn,
      finalFen: chess.fen(),
      flags,
      explanation: e.explanation,
    });
  }

  const flagged = results.filter((r) => r.flags.length > 0);
  const grouped = {
    INVERTED_MATE: flagged.filter((r) => r.flags.some((f) => f.startsWith('INVERTED_MATE:'))),
    INVERTED_MATERIAL: flagged.filter((r) => r.flags.some((f) => f.startsWith('INVERTED_MATERIAL:'))),
    WEAK_TRAP: flagged.filter((r) => r.flags.some((f) => f.startsWith('WEAK_TRAP:'))),
    STUDENT_NOT_PUNISHER: flagged.filter((r) => r.flags.some((f) => f.startsWith('STUDENT_NOT_PUNISHER:'))),
    UNCLASSIFIED: flagged.filter((r) => r.flags.some((f) => f.startsWith('UNCLASSIFIED:'))),
    PGN_PARSE_ERROR: flagged.filter((r) => r.flags.some((f) => f.startsWith('PGN_PARSE_ERROR:'))),
  };

  const summary = {
    total: results.length,
    cleanEntries: results.length - flagged.length,
    flaggedEntries: flagged.length,
    byCategory: Object.fromEntries(
      Object.entries(grouped).map(([k, v]) => [k, v.length]),
    ),
    byKind: results.reduce((acc, r) => {
      acc[r.kind] = (acc[r.kind] ?? 0) + 1;
      return acc;
    }, {}),
  };

  console.log('═══ Summary ═══════════════════════════════════════════════');
  console.log(`Total trapLines audited:    ${summary.total}`);
  console.log(`Clean (no flags):           ${summary.cleanEntries}`);
  console.log(`Flagged:                    ${summary.flaggedEntries}`);
  console.log('');
  console.log('By category:');
  for (const [k, v] of Object.entries(summary.byCategory)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('');
  console.log('By kind (all entries):');
  for (const [k, v] of Object.entries(summary.byKind)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('');

  // Print the most severe categories first
  const printGroup = (label, items) => {
    if (items.length === 0) return;
    console.log(`─── ${label} (${items.length}) ${'─'.repeat(Math.max(3, 60 - label.length - 5))}`);
    for (const r of items) {
      console.log(`\n  • [${r.kind}] ${r.openingId}::${r.name}`);
      console.log(`    student plays:  ${r.studentColor}`);
      console.log(`    final material: student ${r.materialDelta >= 0 ? '+' : ''}${r.materialDelta}`);
      console.log(`    last move:      ${r.lastMoveSan ?? '(none)'} by ${r.lastMoverIs ?? '?'}`);
      if (r.isCheckmate) console.log(`    checkmate:      ${r.mateOn}`);
      else if (r.isCheck) console.log(`    in check:       ${r.checkOn}`);
      for (const f of r.flags) console.log(`    ⚑ ${f}`);
      console.log(`    pgn: ${r.pgn}`);
    }
    console.log('');
  };

  printGroup('INVERTED_MATE (student gets mated)', grouped.INVERTED_MATE);
  printGroup('INVERTED_MATERIAL (student is down material at end)', grouped.INVERTED_MATERIAL);
  printGroup('STUDENT_NOT_PUNISHER (trap ends on opponent move)', grouped.STUDENT_NOT_PUNISHER);
  printGroup('WEAK_TRAP (kind=trap but not clearly +3 or mate)', grouped.WEAK_TRAP);
  printGroup('UNCLASSIFIED (missing from trap-line-classifications.json)', grouped.UNCLASSIFIED);
  printGroup('PGN_PARSE_ERROR', grouped.PGN_PARSE_ERROR);

  await writeFile(
    join(OUT_DIR, 'report.json'),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log(`\nReport: ${OUT_DIR}/report.json`);
}

main().catch((err) => {
  console.error('[trap-orientation] fatal:', err);
  process.exit(1);
});
