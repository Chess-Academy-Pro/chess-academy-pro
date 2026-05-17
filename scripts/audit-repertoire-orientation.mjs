#!/usr/bin/env node
/**
 * Audit-repertoire-orientation — parallel to audit-trap-orientation.mjs,
 * but scans `src/data/repertoire.json` instead of pro-repertoires.json.
 *
 * Why a sibling script: repertoire.json predates the trap-line
 * taxonomy + classifications sidecar. Every trapLine there is treated
 * as `kind: trap` (forced tactical material gain) by default — the
 * existing audit's sidecar lookup would mark them all UNCLASSIFIED,
 * drowning the real signal.
 *
 * Rules:
 *   • trapLines (kind=trap): student must end ≥ +3 material OR have
 *     delivered mate. Last move must be by the student (otherwise
 *     PGN stops mid-flight).
 *   • warningLines: student must NOT end up winning — these are
 *     "don't do X" lines that scare the student off the bad move.
 *
 * Also flags PGN_NOT_IN_DB when the trap/warning PGN's spine doesn't
 * have any prefix in src/data/openings-lichess.json (per CLAUDE.md G3:
 * no chess content invented from memory).
 */
import { Chess } from 'chess.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/repertoire-orientation-${stamp}`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const reps = JSON.parse(
    await readFile('src/data/repertoire.json', 'utf8'),
  );
  const db = JSON.parse(
    await readFile('src/data/openings-lichess.json', 'utf8'),
  );
  const dbArr = Array.isArray(db) ? db : Object.values(db);
  const dbPgns = new Set(dbArr.filter((e) => e?.pgn).map((e) => e.pgn));

  // For G3 anchoring: does the PGN spine (up to some ply) exist in the DB?
  // We don't require an exact match — we require that *some prefix* of
  // the trap PGN matches a DB entry. That gives the line a canonical
  // anchor; anything past the anchor is theoretical extension/tactic.
  const dbPrefixSet = new Set();
  for (const e of dbArr) {
    if (!e?.pgn) continue;
    const moves = e.pgn.split(' ');
    for (let k = 1; k <= moves.length; k++) {
      dbPrefixSet.add(moves.slice(0, k).join(' '));
    }
  }
  // Require at least 6-ply DB anchor — that's the point where named
  // openings start to diverge meaningfully. A trap whose first 6 plies
  // never appear in the DB is, by definition, invented.
  function findDbAnchor(pgn) {
    const moves = pgn.split(' ');
    let bestK = 0;
    for (let k = moves.length; k >= 1; k--) {
      const prefix = moves.slice(0, k).join(' ');
      if (dbPrefixSet.has(prefix)) {
        bestK = k;
        break;
      }
    }
    return bestK; // ply count of longest DB-anchored prefix
  }

  const entries = reps.flatMap((o) => [
    ...(o.trapLines ?? []).map((t) => ({
      role: 'trap',
      openingId: o.id,
      openingName: o.name,
      color: o.color,
      name: t.name,
      pgn: t.pgn,
      explanation: t.explanation,
    })),
    ...(o.warningLines ?? []).map((t) => ({
      role: 'warning',
      openingId: o.id,
      openingName: o.name,
      color: o.color,
      name: t.name,
      pgn: t.pgn,
      explanation: t.explanation,
    })),
  ]);

  const trapCount = entries.filter((e) => e.role === 'trap').length;
  const warningCount = entries.filter((e) => e.role === 'warning').length;
  console.log(`[repertoire-orientation] auditing ${entries.length} entries (${trapCount} trapLines + ${warningCount} warningLines)`);
  console.log(`[repertoire-orientation] DB has ${dbArr.length} openings, ${dbPrefixSet.size} unique prefixes`);
  console.log(`[repertoire-orientation] out: ${OUT_DIR}\n`);

  const results = [];
  for (const e of entries) {
    const kind = e.role === 'warning' ? 'warning' : 'trap';

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
    const lastMoverColor = lastMove ? lastMove.color : null;
    const studentColorChar = e.color === 'white' ? 'w' : 'b';
    const opponentColorChar = e.color === 'white' ? 'b' : 'w';
    const sideToMove = chess.turn();

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
    const materialDelta = studentMat - opponentMat;
    const isCheckmate = chess.isCheckmate();
    const isCheck = chess.isCheck();
    const isDraw = chess.isDraw();
    const mateOn = isCheckmate
      ? sideToMove === studentColorChar
        ? 'student'
        : 'opponent'
      : null;
    const checkOn =
      isCheck && !isCheckmate
        ? sideToMove === studentColorChar
          ? 'student'
          : 'opponent'
        : null;
    const lastMoverIs =
      lastMoverColor === studentColorChar
        ? 'student'
        : lastMoverColor === opponentColorChar
          ? 'opponent'
          : null;

    const dbAnchorPly = findDbAnchor(e.pgn);

    const flags = [];
    if (parseError) {
      flags.push(`PGN_PARSE_ERROR: ${parseError.slice(0, 100)}`);
    } else {
      if (e.role === 'warning') {
        if (mateOn === 'opponent') {
          flags.push(`TOOTHLESS_WARNING: warning ends in student-delivered mate — should be in trapLines`);
        } else if (materialDelta > 2) {
          flags.push(`TOOTHLESS_WARNING: warning ends with student up ${materialDelta} material — should be in trapLines`);
        }
      } else if (mateOn === 'student') {
        flags.push(`INVERTED_MATE: student is checkmated at end of ${kind}-line`);
      } else if (mateOn === 'opponent') {
        // student delivered mate — fine
      } else {
        if (materialDelta < -1) {
          flags.push(
            `INVERTED_MATERIAL: student is down ${Math.abs(materialDelta)} in material (kind=trap, expected ≥ +3)`,
          );
        } else if (materialDelta < 3) {
          flags.push(
            `WEAK_TRAP: student only ${materialDelta >= 0 ? '+' : ''}${materialDelta} material, no mate (kind=trap, expected ≥ +3 or mate)`,
          );
        }
        if (lastMoverIs === 'opponent') {
          flags.push(
            `STUDENT_NOT_PUNISHER: trap PGN ends with opponent move (last SAN: ${lastMove?.san ?? '?'}); student never plays the punishment in this line`,
          );
        }
      }
      if (dbAnchorPly < 6) {
        flags.push(
          `PGN_NOT_IN_DB: longest DB-anchored prefix is only ${dbAnchorPly} plies (G3 violation: line appears invented)`,
        );
      }
    }

    results.push({
      role: e.role,
      openingId: e.openingId,
      openingName: e.openingName,
      studentColor: e.color,
      name: e.name,
      kind,
      pgn: e.pgn,
      plyCount,
      lastMoverIs,
      lastMoveSan: lastMove?.san ?? null,
      sideToMove: sideToMove === studentColorChar ? 'student' : 'opponent',
      materialDelta,
      dbAnchorPly,
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
    TOOTHLESS_WARNING: flagged.filter((r) => r.flags.some((f) => f.startsWith('TOOTHLESS_WARNING:'))),
    WEAK_TRAP: flagged.filter((r) => r.flags.some((f) => f.startsWith('WEAK_TRAP:'))),
    STUDENT_NOT_PUNISHER: flagged.filter((r) => r.flags.some((f) => f.startsWith('STUDENT_NOT_PUNISHER:'))),
    PGN_NOT_IN_DB: flagged.filter((r) => r.flags.some((f) => f.startsWith('PGN_NOT_IN_DB:'))),
    PGN_PARSE_ERROR: flagged.filter((r) => r.flags.some((f) => f.startsWith('PGN_PARSE_ERROR:'))),
  };

  const summary = {
    total: results.length,
    cleanEntries: results.length - flagged.length,
    flaggedEntries: flagged.length,
    byCategory: Object.fromEntries(
      Object.entries(grouped).map(([k, v]) => [k, v.length]),
    ),
  };

  console.log('═══ Summary ═══════════════════════════════════════════════');
  console.log(`Total entries audited:      ${summary.total}`);
  console.log(`Clean (no flags):           ${summary.cleanEntries}`);
  console.log(`Flagged:                    ${summary.flaggedEntries}`);
  console.log('');
  console.log('By category:');
  for (const [k, v] of Object.entries(summary.byCategory)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('');

  const printGroup = (label, items) => {
    if (items.length === 0) return;
    console.log(`─── ${label} (${items.length}) ${'─'.repeat(Math.max(3, 60 - label.length - 5))}`);
    for (const r of items) {
      console.log(`\n  • [${r.kind}] ${r.openingId}::${r.name}`);
      console.log(`    student plays:  ${r.studentColor}`);
      console.log(`    final material: student ${r.materialDelta >= 0 ? '+' : ''}${r.materialDelta}`);
      console.log(`    last move:      ${r.lastMoveSan ?? '(none)'} by ${r.lastMoverIs ?? '?'}`);
      console.log(`    DB anchor ply:  ${r.dbAnchorPly}/${r.plyCount}`);
      if (r.isCheckmate) console.log(`    checkmate:      ${r.mateOn}`);
      else if (r.isCheck) console.log(`    in check:       ${r.checkOn}`);
      for (const f of r.flags) console.log(`    ⚑ ${f}`);
      console.log(`    pgn: ${r.pgn}`);
    }
    console.log('');
  };

  printGroup('INVERTED_MATE (student gets mated)', grouped.INVERTED_MATE);
  printGroup('INVERTED_MATERIAL (student is down material at end)', grouped.INVERTED_MATERIAL);
  printGroup('PGN_NOT_IN_DB (invented line — G3 violation)', grouped.PGN_NOT_IN_DB);
  printGroup('TOOTHLESS_WARNING (warning entry ends with student winning)', grouped.TOOTHLESS_WARNING);
  printGroup('STUDENT_NOT_PUNISHER (trap ends on opponent move)', grouped.STUDENT_NOT_PUNISHER);
  printGroup('WEAK_TRAP (kind=trap but not clearly +3 or mate)', grouped.WEAK_TRAP);
  printGroup('PGN_PARSE_ERROR', grouped.PGN_PARSE_ERROR);

  await writeFile(
    join(OUT_DIR, 'report.json'),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log(`\nReport: ${OUT_DIR}/report.json`);
}

main().catch((err) => {
  console.error('[repertoire-orientation] fatal:', err);
  process.exit(1);
});
