#!/usr/bin/env node
/**
 * Audit-pgn-db-anchor — universal G3 enforcement.
 *
 * Walks EVERY PGN-bearing field across every opening data source:
 *   • src/data/repertoire.json       (main pgn + variations[] + trapLines[] + warningLines[])
 *   • src/data/pro-repertoires.json  (same shape under .openings[])
 *   • src/data/gambits.json          (same shape)
 *   • src/data/model-games.json      (main pgn only)
 *
 * Reference databases (Lichess-licensed, treated as canonical):
 *   • src/data/openings-lichess.json          (3,641 named openings)
 *   • src/data/openings-lichess-extended.json (currently empty — placeholder)
 *
 * Rule (David's gate G3, restated 2026-05-16):
 *   IF IT'S NOT IN THE DATABASE THEN IT DOESN'T GET PUT ON THE
 *   BOARD. Every authored PGN must match a DB entry's prefix
 *   end-to-end. Any ply beyond the longest DB-anchored prefix is
 *   invented and must be deleted from the board.
 *
 * Per-PGN output:
 *   anchorPly        — longest k such that prefix(P, k) ∈ DB prefix set
 *   invented         — pgnLength - anchorPly (>0 = invented suffix)
 *   canExtendBy      — max additional plies available from some DB
 *                      entry whose PGN starts with prefix(P, anchorPly)
 *   extensionExample — the DB entry name + suffix moves we could use
 *
 * Categories:
 *   CLEAN_NO_EXTEND     — anchored end-to-end, no further DB plies
 *   CLEAN_EXTENDABLE    — anchored end-to-end, DB has +N more plies
 *   PARTIAL_INVENTED    — first A plies match DB, last L-A plies invented
 *   NO_ANCHOR           — anchorPly < 3 (line never enters canonical
 *                         territory at all)
 *   PGN_PARSE_ERROR     — chess.js refused to load
 *
 * Run: `node scripts/audit-pgn-db-anchor.mjs`
 */
import { Chess } from 'chess.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/pgn-db-anchor-${stamp}`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // ─── Load reference databases ──────────────────────────────────
  const dbFiles = ['openings-lichess.json', 'openings-lichess-extended.json'];
  const dbEntries = [];
  for (const f of dbFiles) {
    try {
      const raw = JSON.parse(await readFile(`src/data/${f}`, 'utf8'));
      const arr = Array.isArray(raw) ? raw : Object.values(raw);
      for (const e of arr) {
        if (e?.pgn) dbEntries.push({ source: f, name: e.name ?? '(unnamed)', pgn: e.pgn });
      }
      console.log(`[load] ${f}: ${arr.length} entries`);
    } catch (err) {
      console.log(`[load] ${f}: skipped (${err.message})`);
    }
  }

  // Index every prefix once. prefixIndex maps "ply-joined PGN" → array
  // of DB entries whose full PGN starts with that prefix. We need the
  // actual entries (not just a Set) so we can suggest extensions.
  const prefixIndex = new Map(); // prefix → [{ source, name, fullPgn, fullLen }]
  for (const e of dbEntries) {
    const moves = e.pgn.split(' ');
    for (let k = 1; k <= moves.length; k++) {
      const pref = moves.slice(0, k).join(' ');
      let arr = prefixIndex.get(pref);
      if (!arr) {
        arr = [];
        prefixIndex.set(pref, arr);
      }
      arr.push({ source: e.source, name: e.name, fullPgn: e.pgn, fullLen: moves.length });
    }
  }
  console.log(`[load] ${prefixIndex.size} unique prefixes across all DBs\n`);

  // ─── Load audit-target data sources ────────────────────────────
  const sources = [
    { file: 'repertoire.json', shape: 'array' },
    { file: 'pro-repertoires.json', shape: 'object.openings' },
    { file: 'gambits.json', shape: 'array' },
    { file: 'model-games.json', shape: 'array', mainOnly: true },
  ];

  const entries = []; // { source, openingId, role, name, pgn }
  for (const { file, shape, mainOnly } of sources) {
    const raw = JSON.parse(await readFile(`src/data/${file}`, 'utf8'));
    const arr = shape === 'array' ? raw : raw.openings;
    for (const o of arr) {
      const openingId = o.id ?? o.openingId ?? o.name ?? '(no-id)';
      if (o.pgn) {
        entries.push({
          source: file,
          openingId,
          role: 'main',
          name: o.name ?? openingId,
          pgn: o.pgn,
        });
      }
      if (mainOnly) continue;
      for (const v of o.variations ?? []) {
        if (v.pgn) entries.push({ source: file, openingId, role: 'variation', name: v.name, pgn: v.pgn });
      }
      for (const t of o.trapLines ?? []) {
        if (t.pgn) entries.push({ source: file, openingId, role: 'trap', name: t.name, pgn: t.pgn });
      }
      for (const w of o.warningLines ?? []) {
        if (w.pgn) entries.push({ source: file, openingId, role: 'warning', name: w.name, pgn: w.pgn });
      }
    }
  }

  // ─── Audit each entry ──────────────────────────────────────────
  const results = [];
  for (const e of entries) {
    const moves = e.pgn.split(' ').filter(Boolean);
    const pgnLength = moves.length;

    // 1. chess.js validity
    let parseError = null;
    try {
      new Chess().loadPgn(e.pgn);
    } catch (err) {
      parseError = String(err?.message ?? err).slice(0, 100);
    }

    // 2. longest DB-anchored prefix
    let anchorPly = 0;
    for (let k = moves.length; k >= 1; k--) {
      if (prefixIndex.has(moves.slice(0, k).join(' '))) {
        anchorPly = k;
        break;
      }
    }
    const invented = pgnLength - anchorPly;

    // 3. extension candidates from the anchor point
    let canExtendBy = 0;
    let extensionExample = null;
    if (anchorPly > 0) {
      const anchorPrefix = moves.slice(0, anchorPly).join(' ');
      const candidates = prefixIndex.get(anchorPrefix) ?? [];
      // Look for DB entries longer than our anchor that extend cleanly.
      // "Extend cleanly" = DB entry's PGN starts with anchorPrefix, has more plies.
      for (const c of candidates) {
        const extra = c.fullLen - anchorPly;
        if (extra > canExtendBy) {
          canExtendBy = extra;
          const extraMoves = c.fullPgn.split(' ').slice(anchorPly).join(' ');
          extensionExample = { name: c.name, extraPly: extra, extraMoves };
        }
      }
    }

    let category;
    if (parseError) category = 'PGN_PARSE_ERROR';
    else if (anchorPly < 3) category = 'NO_ANCHOR';
    else if (invented > 0) category = 'PARTIAL_INVENTED';
    else if (canExtendBy > 0) category = 'CLEAN_EXTENDABLE';
    else category = 'CLEAN_NO_EXTEND';

    results.push({
      source: e.source,
      openingId: e.openingId,
      role: e.role,
      name: e.name,
      pgn: e.pgn,
      pgnLength,
      anchorPly,
      invented,
      canExtendBy,
      category,
      extensionExample,
      parseError,
    });
  }

  // ─── Summary ───────────────────────────────────────────────────
  const byCat = {};
  const bySource = {};
  for (const r of results) {
    byCat[r.category] = (byCat[r.category] ?? 0) + 1;
    bySource[r.source] = bySource[r.source] ?? {};
    bySource[r.source][r.category] = (bySource[r.source][r.category] ?? 0) + 1;
  }

  console.log('═══ Summary ═══════════════════════════════════════════════');
  console.log(`Total PGNs audited: ${results.length}`);
  console.log('');
  console.log('By category:');
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log('');
  console.log('By source × category:');
  console.log('  source                          ' + ['CLEAN_NO_EXTEND', 'CLEAN_EXTENDABLE', 'PARTIAL_INVENTED', 'NO_ANCHOR', 'PGN_PARSE_ERROR'].map(c => c.padStart(18)).join(''));
  for (const [src, cats] of Object.entries(bySource)) {
    const row = ['CLEAN_NO_EXTEND', 'CLEAN_EXTENDABLE', 'PARTIAL_INVENTED', 'NO_ANCHOR', 'PGN_PARSE_ERROR']
      .map(c => String(cats[c] ?? 0).padStart(18))
      .join('');
    console.log(`  ${src.padEnd(32)}${row}`);
  }
  console.log('');

  // Highlight the worst offenders
  const noAnchor = results.filter((r) => r.category === 'NO_ANCHOR');
  const partial = results.filter((r) => r.category === 'PARTIAL_INVENTED');
  const extendable = results.filter((r) => r.category === 'CLEAN_EXTENDABLE');

  if (noAnchor.length) {
    console.log(`─── NO_ANCHOR (${noAnchor.length}) — line never enters canonical DB territory ───`);
    for (const r of noAnchor.slice(0, 20)) {
      console.log(`  • [${r.source}/${r.role}] ${r.openingId}::${r.name}`);
      console.log(`    pgn (${r.pgnLength}p, anchor=${r.anchorPly}): ${r.pgn.slice(0, 120)}${r.pgn.length > 120 ? '…' : ''}`);
    }
    if (noAnchor.length > 20) console.log(`  … and ${noAnchor.length - 20} more (see report.json)`);
    console.log('');
  }

  if (partial.length) {
    console.log(`─── PARTIAL_INVENTED (${partial.length}) — first A plies match DB, rest is invented ───`);
    // Sort by amount-invented descending so the worst show first
    const sorted = [...partial].sort((a, b) => b.invented - a.invented);
    for (const r of sorted.slice(0, 20)) {
      console.log(`  • [${r.source}/${r.role}] ${r.openingId}::${r.name}`);
      console.log(`    pgn: ${r.pgn}`);
      console.log(`    anchor=${r.anchorPly}/${r.pgnLength}, ${r.invented} invented plies`);
    }
    if (sorted.length > 20) console.log(`  … and ${sorted.length - 20} more`);
    console.log('');
  }

  // Top extendables — show 10 examples
  if (extendable.length) {
    console.log(`─── CLEAN_EXTENDABLE (${extendable.length}) — DB has more we could use ───`);
    const top = [...extendable].sort((a, b) => b.canExtendBy - a.canExtendBy).slice(0, 10);
    for (const r of top) {
      console.log(`  • [${r.source}/${r.role}] ${r.openingId}::${r.name}`);
      console.log(`    current (${r.pgnLength}p): ${r.pgn.slice(0, 100)}${r.pgn.length > 100 ? '…' : ''}`);
      console.log(`    could extend +${r.canExtendBy}p via "${r.extensionExample.name}": ${r.extensionExample.extraMoves}`);
    }
    console.log(`  … (${extendable.length} total extendable lines in report.json)`);
    console.log('');
  }

  const summary = {
    totalPgns: results.length,
    byCategory: byCat,
    bySource,
    auditedFiles: sources.map((s) => s.file),
    referenceDbs: dbFiles,
    dbPrefixCount: prefixIndex.size,
  };

  await writeFile(
    join(OUT_DIR, 'report.json'),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log(`\nReport: ${OUT_DIR}/report.json`);
}

main().catch((err) => {
  console.error('[pgn-db-anchor] fatal:', err);
  process.exit(1);
});
