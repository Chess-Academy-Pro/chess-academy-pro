import { type Page } from '@playwright/test';
import { Chess } from 'chess.js';

/**
 * Helpers for endgame e2e specs that need to drive real chess moves
 * against the live board. The endgame surfaces don't expose the
 * current FEN via DOM, so we reconstruct it by reading `[data-square]
 * img[alt]` (react-chessboard's customPieces emits `<img alt="wK">`
 * style elements).
 *
 * `sideToMove` cannot be read from DOM — pass it in based on lesson
 * context. For mating-pattern lessons in the fork phase it's always
 * `studentSide`.
 */

/** Read piece positions from the DOM. Returns a square→piece map
 *  using react-chessboard's "wK"/"bN" notation. */
export async function readPiecesFromDom(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const out: Record<string, string> = {};
    document.querySelectorAll('[data-square]').forEach((sq) => {
      const square = (sq as HTMLElement).dataset.square;
      if (!square) return;
      const img = sq.querySelector('img');
      const alt = img?.getAttribute('alt');
      if (alt) out[square] = alt;
    });
    return out;
  });
}

/** Convert a piece map to FEN-position (no side/castling/etc.). */
function piecesToFenPlacement(pieces: Record<string, string>): string {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const square = `${String.fromCharCode(97 + f)}${rank}`;
      const p = pieces[square];
      if (!p) {
        empty += 1;
      } else {
        if (empty > 0) { row += empty.toString(); empty = 0; }
        // "wK" → "K", "bN" → "n"
        const letter = p[1].toUpperCase();
        row += p[0] === 'w' ? letter : letter.toLowerCase();
      }
    }
    if (empty > 0) row += empty.toString();
    rows.push(row);
  }
  return rows.join('/');
}

/** Build a chess.js instance from the live board. Castling rights are
 *  permissive (`KQkq`) so moves through them aren't blocked by stale
 *  FEN bits — this matters for the endgame surfaces because we never
 *  test castling here, only piece moves. */
export async function buildChessFromBoard(
  page: Page,
  sideToMove: 'w' | 'b',
): Promise<Chess> {
  const pieces = await readPiecesFromDom(page);
  const placement = piecesToFenPlacement(pieces);
  const fen = `${placement} ${sideToMove} KQkq - 0 1`;
  const c = new Chess();
  try {
    c.load(fen);
  } catch {
    // Castling rights may be invalid for the given placement (kings
    // not on home squares, rooks moved, etc.). Retry with no castling.
    c.load(`${placement} ${sideToMove} - - 0 1`);
  }
  return c;
}

/** Drive a click-to-move on the live board. */
export async function clickMove(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`[data-square="${from}"]`).first().click({ force: true });
  await page.locator(`[data-square="${to}"]`).first().click({ force: true });
}
