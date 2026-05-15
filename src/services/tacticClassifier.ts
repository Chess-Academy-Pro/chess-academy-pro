import { Chess, type Square, type Color, type PieceSymbol } from 'chess.js';
import type {
  TacticClassification,
  TacticPattern,
  MoveQuality,
  HangingPiece,
  UpcomingTactic,
} from '../types/tacticTypes';
import { PIECE_NAMES } from '../types/tacticTypes';

// ─── Constants ──────────────────────────────────────────────────────────────

const PIECE_VALUE: Record<string, number> = {
  p: 1, n: 3, b: 3, r: 5, q: 9, k: 100,
};

const BISHOP_DIRS: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// ─── Geometry Helpers ───────────────────────────────────────────────────────

function squareToCoords(sq: Square): [number, number] {
  return [sq.charCodeAt(0) - 97, parseInt(sq[1]) - 1];
}

function coordsToSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Square;
}

function pieceValue(type: PieceSymbol): number {
  return PIECE_VALUE[type] ?? 0;
}

function oppositeColor(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function pieceName(type: string): string {
  return PIECE_NAMES[type] ?? type;
}

function squareLabel(sq: string): string {
  return sq;
}

// ─── Board Inspection Helpers ───────────────────────────────────────────────

/**
 * Trace a ray from a square in a given direction, returning pieces found.
 */
function traceRay(
  chess: Chess,
  fromSquare: Square,
  dir: [number, number],
  maxPieces: number = 2,
): Array<{ square: Square; type: PieceSymbol; color: Color }> {
  const [startFile, startRank] = squareToCoords(fromSquare);
  const pieces: Array<{ square: Square; type: PieceSymbol; color: Color }> = [];
  let file = startFile + dir[0];
  let rank = startRank + dir[1];

  while (file >= 0 && file <= 7 && rank >= 0 && rank <= 7) {
    const sq = coordsToSquare(file, rank);
    if (!sq) break;
    const piece = chess.get(sq);
    if (piece) {
      pieces.push({ square: sq, type: piece.type, color: piece.color });
      if (pieces.length >= maxPieces) break;
    }
    file += dir[0];
    rank += dir[1];
  }

  return pieces;
}

/**
 * Get squares attacked by a piece at a given square.
 */
function getAttackedSquares(chess: Chess, square: Square): Square[] {
  const piece = chess.get(square);
  if (!piece) return [];

  const fenParts = chess.fen().split(' ');
  fenParts[1] = piece.color;
  fenParts[3] = '-';

  try {
    const testChess = new Chess(fenParts.join(' '));
    const moves = testChess.moves({ square, verbose: true });
    const attacked = new Set<string>();
    for (const m of moves) {
      attacked.add(m.to);
    }
    return Array.from(attacked) as Square[];
  } catch {
    return [];
  }
}

/**
 * Check if a square is defended by any piece of the given color.
 */
function isDefended(chess: Chess, square: Square, byColor: Color): boolean {
  try {
    const fenParts = chess.fen().split(' ');
    fenParts[1] = byColor;
    fenParts[3] = '-';
    const testChess = new Chess(fenParts.join(' '));

    // Check pawn defense via diagonal geometry
    const targetFile = square.charCodeAt(0) - 97;
    const targetRank = parseInt(square[1], 10) - 1;
    const pawnRankOffset = byColor === 'w' ? -1 : 1;
    const pawnSourceRank = targetRank + pawnRankOffset;
    for (const df of [-1, 1]) {
      const pawnSourceFile = targetFile + df;
      const pawnSq = coordsToSquare(pawnSourceFile, pawnSourceRank);
      if (pawnSq) {
        const boardRow = 7 - pawnSourceRank;
        const p = testChess.board()[boardRow][pawnSourceFile];
        if (p && p.color === byColor && p.type === 'p') {
          return true;
        }
      }
    }

    const board = testChess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.color === byColor && p.type !== 'p') {
          const sq = coordsToSquare(c, 7 - r);
          if (!sq) continue;
          const moves = testChess.moves({ square: sq, verbose: true });
          if (moves.some((m) => m.to === square)) return true;
        }
      }
    }
  } catch {
    // Fall back to false
  }
  return false;
}

/**
 * Count attackers of a square by the given color.
 */
function countAttackers(chess: Chess, square: Square, byColor: Color): number {
  try {
    const fenParts = chess.fen().split(' ');
    fenParts[1] = byColor;
    fenParts[3] = '-';
    const testChess = new Chess(fenParts.join(' '));
    let count = 0;

    // Check pawn attackers
    const targetFile = square.charCodeAt(0) - 97;
    const targetRank = parseInt(square[1], 10) - 1;
    const pawnRankOffset = byColor === 'w' ? -1 : 1;
    const pawnSourceRank = targetRank + pawnRankOffset;
    for (const df of [-1, 1]) {
      const pawnSourceFile = targetFile + df;
      const pawnSq = coordsToSquare(pawnSourceFile, pawnSourceRank);
      if (pawnSq) {
        const boardRow = 7 - pawnSourceRank;
        const p = testChess.board()[boardRow][pawnSourceFile];
        if (p && p.color === byColor && p.type === 'p') count++;
      }
    }

    const board = testChess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.color === byColor && p.type !== 'p') {
          const sq = coordsToSquare(c, 7 - r);
          if (!sq) continue;
          const moves = testChess.moves({ square: sq, verbose: true });
          if (moves.some((m) => m.to === square)) count++;
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// ─── Move Quality Classification ────────────────────────────────────────────

/**
 * Classify move quality from the perspective of the side that moved.
 * Positive evalSwing = the move improved the position (good).
 * Negative evalSwing = the move worsened the position (bad).
 */
function classifyMoveQuality(evalSwing: number): MoveQuality {
  if (evalSwing >= 200) return 'brilliant';
  if (evalSwing >= 100) return 'great';
  if (evalSwing >= -50) return 'good';
  if (evalSwing >= -100) return 'inaccuracy';
  if (evalSwing >= -200) return 'mistake';
  return 'blunder';
}

// ─── Tactic Detectors ───────────────────────────────────────────────────────

/**
 * Detect fork: the moved piece attacks 2+ enemy pieces of value >= knight.
 * Also counts the king as a target if in check.
 */
function detectFork(
  chessAfter: Chess,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  const attackedSquares = getAttackedSquares(chessAfter, toSquare);
  const targets: Array<{ square: Square; type: PieceSymbol }> = [];

  for (const sq of attackedSquares) {
    const piece = chessAfter.get(sq);
    if (piece && piece.color !== movingColor && pieceValue(piece.type) >= 3) {
      targets.push({ square: sq, type: piece.type });
    }
  }

  // King counts as a fork target if in check
  if (chessAfter.isCheck() && targets.length >= 1) {
    // Find the king square
    const enemyColor = oppositeColor(movingColor);
    const board = chessAfter.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.type === 'k' && p.color === enemyColor) {
          const kingSq = coordsToSquare(c, 7 - r);
          if (kingSq && !targets.some((t) => t.square === kingSq)) {
            targets.push({ square: kingSq, type: 'k' });
          }
        }
      }
    }
  }

  if (targets.length < 2) return null;

  const movedPiece = chessAfter.get(toSquare);
  const movedName = movedPiece ? pieceName(movedPiece.type) : 'piece';
  const targetDescs = targets.map(
    (t) => `${pieceName(t.type)} on ${squareLabel(t.square)}`,
  );

  return {
    type: 'fork',
    involvedSquares: [toSquare, ...targets.map((t) => t.square)],
    description: `${capitalize(movedName)} on ${squareLabel(toSquare)} forks ${targetDescs.join(' and ')}`,
  };
}

/**
 * Detect pin: a sliding piece pins an enemy piece against a more valuable piece behind it.
 */
function detectPin(
  chessAfter: Chess,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  const piece = chessAfter.get(toSquare);
  if (!piece) return null;
  if (piece.type !== 'b' && piece.type !== 'r' && piece.type !== 'q') return null;

  const dirs =
    piece.type === 'b' ? BISHOP_DIRS
    : piece.type === 'r' ? ROOK_DIRS
    : [...BISHOP_DIRS, ...ROOK_DIRS];

  for (const dir of dirs) {
    const piecesOnRay = traceRay(chessAfter, toSquare, dir);
    if (piecesOnRay.length < 2) continue;

    const first = piecesOnRay[0];
    const second = piecesOnRay[1];

    if (
      first.color === oppositeColor(movingColor) &&
      second.color === oppositeColor(movingColor) &&
      pieceValue(second.type) > pieceValue(first.type)
    ) {
      return {
        type: 'pin',
        involvedSquares: [toSquare, first.square, second.square],
        description: `${capitalize(pieceName(piece.type))} on ${squareLabel(toSquare)} pins ${pieceName(first.type)} on ${squareLabel(first.square)} against ${pieceName(second.type)} on ${squareLabel(second.square)}`,
      };
    }
  }

  return null;
}

/**
 * Detect skewer: attacking a valuable piece that must move, exposing a less valuable piece behind.
 */
function detectSkewer(
  chessAfter: Chess,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  const piece = chessAfter.get(toSquare);
  if (!piece) return null;
  if (piece.type !== 'b' && piece.type !== 'r' && piece.type !== 'q') return null;

  const dirs =
    piece.type === 'b' ? BISHOP_DIRS
    : piece.type === 'r' ? ROOK_DIRS
    : [...BISHOP_DIRS, ...ROOK_DIRS];

  for (const dir of dirs) {
    const piecesOnRay = traceRay(chessAfter, toSquare, dir);
    if (piecesOnRay.length < 2) continue;

    const first = piecesOnRay[0];
    const second = piecesOnRay[1];

    if (
      first.color === oppositeColor(movingColor) &&
      second.color === oppositeColor(movingColor) &&
      pieceValue(first.type) > pieceValue(second.type) &&
      pieceValue(second.type) >= 1
    ) {
      return {
        type: 'skewer',
        involvedSquares: [toSquare, first.square, second.square],
        description: `${capitalize(pieceName(piece.type))} on ${squareLabel(toSquare)} skewers ${pieceName(first.type)} on ${squareLabel(first.square)} with ${pieceName(second.type)} on ${squareLabel(second.square)} behind it`,
      };
    }
  }

  return null;
}

/**
 * Detect discovered attack: the moving piece uncovers an attack from a friendly piece behind it.
 */
function detectDiscovery(
  chessAfter: Chess,
  fromSquare: Square,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  const allDirs = [...BISHOP_DIRS, ...ROOK_DIRS];

  for (const dir of allDirs) {
    // Look backwards from the from-square to find a friendly slider
    const behindPieces = traceRay(
      chessAfter,
      fromSquare,
      [-dir[0], -dir[1]] as [number, number],
    );
    if (behindPieces.length === 0) continue;

    const behind = behindPieces[0];
    if (behind.color !== movingColor) continue;

    const canSlide =
      behind.type === 'q' ||
      (behind.type === 'b' && BISHOP_DIRS.some((d) => d[0] === dir[0] && d[1] === dir[1])) ||
      (behind.type === 'r' && ROOK_DIRS.some((d) => d[0] === dir[0] && d[1] === dir[1]));
    if (!canSlide) continue;

    // Look forward along the ray for an enemy piece
    const forwardPieces = traceRay(chessAfter, fromSquare, dir);
    for (const fp of forwardPieces) {
      if (fp.square === toSquare) continue;
      if (fp.color === oppositeColor(movingColor) && pieceValue(fp.type) >= 3) {
        return {
          type: 'discovery',
          involvedSquares: [fromSquare, behind.square, fp.square],
          description: `Moving from ${squareLabel(fromSquare)} to ${squareLabel(toSquare)} reveals ${pieceName(behind.type)} on ${squareLabel(behind.square)} attacking ${pieceName(fp.type)} on ${squareLabel(fp.square)}`,
        };
      }
      break; // Blocked by first piece
    }
  }

  return null;
}

/**
 * Detect double check: two pieces deliver check simultaneously.
 */
function detectDoubleCheck(
  chessAfter: Chess,
  movingColor: Color,
): TacticPattern | null {
  if (!chessAfter.isCheck()) return null;

  const enemyColor = oppositeColor(movingColor);
  const board = chessAfter.board();
  let kingSq: Square | null = null;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'k' && p.color === enemyColor) {
        kingSq = coordsToSquare(c, 7 - r);
      }
    }
  }
  if (!kingSq) return null;

  try {
    const fenParts = chessAfter.fen().split(' ');
    fenParts[1] = movingColor;
    fenParts[3] = '-';
    const testChess = new Chess(fenParts.join(' '));

    const checkers: Square[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.color !== movingColor) continue;
        const sq = coordsToSquare(c, 7 - r);
        if (!sq) continue;
        const moves = testChess.moves({ square: sq, verbose: true });
        if (moves.some((m) => m.to === kingSq)) {
          checkers.push(sq);
        }
      }
    }

    if (checkers.length >= 2) {
      const checkerDescs = checkers.map((sq) => {
        const p = chessAfter.get(sq);
        return p ? `${pieceName(p.type)} on ${squareLabel(sq)}` : squareLabel(sq);
      });
      return {
        type: 'double_check',
        involvedSquares: [...checkers, kingSq],
        description: `Double check from ${checkerDescs.join(' and ')}`,
      };
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * Detect back rank threat: rook or queen checks along the back rank with the king trapped.
 */
function detectBackRank(
  chessAfter: Chess,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  if (!chessAfter.isCheck()) return null;

  const piece = chessAfter.get(toSquare);
  if (!piece) return null;
  if (piece.type !== 'r' && piece.type !== 'q') return null;

  const enemyColor = oppositeColor(movingColor);
  const board = chessAfter.board();
  let kingSq: Square | null = null;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'k' && p.color === enemyColor) {
        kingSq = coordsToSquare(c, 7 - r);
      }
    }
  }
  if (!kingSq) return null;

  const kingRank = kingSq[1];
  if (kingRank !== '1' && kingRank !== '8') return null;
  if (toSquare[1] !== kingRank) return null;

  const legalMoves = chessAfter.moves({ verbose: true });
  const kingMoves = legalMoves.filter((m) => m.piece === 'k');
  if (kingMoves.length > 1) return null;

  return {
    type: 'back_rank',
    involvedSquares: [toSquare, kingSq],
    description: `${capitalize(pieceName(piece.type))} on ${squareLabel(toSquare)} delivers back rank check against king on ${squareLabel(kingSq)}`,
  };
}

/**
 * Detect removal of guard: capturing or deflecting a defender so a target becomes undefended.
 * Uses chess.js isAttacked() to correctly detect defense of squares occupied by friendly pieces.
 */
function detectRemovalOfGuard(
  chessBefore: Chess,
  chessAfter: Chess,
  toSquare: Square,
  movingColor: Color,
): TacticPattern | null {
  const capturedTarget = chessBefore.get(toSquare);
  if (!capturedTarget || capturedTarget.color === movingColor) return null;

  const enemyColor = oppositeColor(movingColor);

  try {
    // Use isAttacked to check which squares the captured piece was defending.
    // This correctly handles defense of squares occupied by friendly pieces,
    // unlike moves() which only returns legal moves to unoccupied/enemy squares.
    const board = chessBefore.board();

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.color !== enemyColor) continue;
        const sq = coordsToSquare(c, 7 - r);
        if (!sq || sq === toSquare) continue;
        if (pieceValue(p.type) < 3) continue;

        // Was this piece defended before (by the enemy side)?
        const fenPartsBefore = chessBefore.fen().split(' ');
        fenPartsBefore[1] = enemyColor;
        fenPartsBefore[3] = '-';
        const testBefore = new Chess(fenPartsBefore.join(' '));
        const defendedBefore = testBefore.isAttacked(sq, enemyColor);

        if (!defendedBefore) continue;

        // Is this piece still defended after the capture?
        const fenPartsAfter = chessAfter.fen().split(' ');
        fenPartsAfter[1] = enemyColor;
        fenPartsAfter[3] = '-';
        const testAfter = new Chess(fenPartsAfter.join(' '));
        const defendedAfter = testAfter.isAttacked(sq, enemyColor);

        if (!defendedAfter) {
          return {
            type: 'removal_of_guard',
            involvedSquares: [toSquare, sq],
            description: `Capturing ${pieceName(capturedTarget.type)} on ${squareLabel(toSquare)} removes the guard of ${pieceName(p.type)} on ${squareLabel(sq)}`,
          };
        }
      }
    }
  } catch {
    // Fall through
  }

  return null;
}

// ─── Hanging Piece Detection ────────────────────────────────────────────────

/**
 * Find all hanging pieces (attacked with no defender) for both sides.
 */
export function findHangingPieces(chess: Chess): HangingPiece[] {
  const hanging: HangingPiece[] = [];
  const board = chess.board();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece.type === 'k') continue;

      const sq = coordsToSquare(c, 7 - r);
      if (!sq) continue;

      const enemyColor = oppositeColor(piece.color);
      const attackers = countAttackers(chess, sq, enemyColor);
      if (attackers === 0) continue;

      const defended = isDefended(chess, sq, piece.color);
      if (!defended) {
        hanging.push({
          square: sq,
          piece: piece.type,
          color: piece.color,
        });
      }
    }
  }

  return hanging;
}

// ─── Main Classifier ────────────────────────────────────────────────────────

/**
 * Classify a position based on the move played, using chess.js board inspection
 * and Stockfish eval deltas.
 *
 * @param fenBefore - FEN of the position before the move
 * @param fenAfter - FEN of the position after the move
 * @param moveSan - The move in SAN notation (e.g., "Nd5")
 * @param evalBefore - Stockfish eval in centipawns before the move (from side-to-move perspective)
 * @param evalAfter - Stockfish eval in centipawns after the move (from side-to-move perspective)
 * @returns Structured tactic classification
 */
export function classifyPosition(
  fenBefore: string,
  fenAfter: string,
  moveSan: string,
  evalBefore: number,
  evalAfter: number,
): TacticClassification {
  // Eval swing from the moving side's perspective.
  // evalBefore is from the side-to-move's view before the move.
  // evalAfter is from the side-to-move's view after the move (opponent's perspective).
  // So a good move means evalBefore was X, and after the move the opponent sees -Y,
  // meaning the mover's position improved by (evalBefore - (-evalAfter)) = evalBefore + evalAfter...
  // Actually, the convention: evalAfter is from the NEW side-to-move (the opponent).
  // The mover's eval after = -evalAfter. So swing = -evalAfter - evalBefore.
  // Positive swing = the move improved the mover's position.
  const evalSwing = -evalAfter - evalBefore;
  const moveQuality = classifyMoveQuality(evalSwing);

  const tactics: TacticPattern[] = [];

  try {
    const chessBefore = new Chess(fenBefore);
    const chessAfter = new Chess(fenAfter);

    // Determine the move's from/to squares by playing the SAN on the before position
    const testChess = new Chess(fenBefore);
    const moveResult = testChess.move(moveSan);

    const fromSquare = moveResult.from;
    const toSquare = moveResult.to;
    const movingColor = moveResult.color;

    // === Detect all applicable tactics (collect all, not just first) ===

    const doubleCheck = detectDoubleCheck(chessAfter, movingColor);
    if (doubleCheck) tactics.push(doubleCheck);

    const backRank = detectBackRank(chessAfter, toSquare, movingColor);
    if (backRank) tactics.push(backRank);

    const fork = detectFork(chessAfter, toSquare, movingColor);
    if (fork) tactics.push(fork);

    const pin = detectPin(chessAfter, toSquare, movingColor);
    if (pin) tactics.push(pin);

    const skewer = detectSkewer(chessAfter, toSquare, movingColor);
    if (skewer) tactics.push(skewer);

    const discovery = detectDiscovery(chessAfter, fromSquare, toSquare, movingColor);
    if (discovery) tactics.push(discovery);

    if (moveResult.captured) {
      const removalOfGuard = detectRemovalOfGuard(
        chessBefore,
        chessAfter,
        toSquare,
        movingColor,
      );
      if (removalOfGuard) tactics.push(removalOfGuard);
    }

    // If no tactics found, add 'none'
    if (tactics.length === 0) {
      tactics.push({
        type: 'none',
        involvedSquares: [],
        description: 'No tactical pattern detected',
      });
    }

    // Detect hanging pieces in the resulting position
    const hangingPieces = findHangingPieces(chessAfter);

    return { evalSwing, moveQuality, tactics, hangingPieces };
  } catch {
    // Invalid position or move — return minimal classification
    return {
      evalSwing,
      moveQuality,
      tactics: [{ type: 'none', involvedSquares: [], description: 'No tactical pattern detected' }],
      hangingPieces: [],
    };
  }
}

// ─── Upcoming Tactic Scanner ───────────────────────────────────────────────

/**
 * Scan Stockfish PV lines 2-4 moves deep to find tactics before they happen.
 * Returns tactics tagged with whether the player or opponent benefits.
 *
 * @param fen - Current position FEN
 * @param topLines - Stockfish top PV lines (UCI move arrays + eval)
 * @param playerColor - Which color the student plays ('w' | 'b')
 * @param maxDepth - How many half-moves deep to scan (default 4)
 */
export function scanUpcomingTactics(
  fen: string,
  topLines: Array<{ moves: string[]; evaluation: number; mate: number | null }>,
  playerColor: 'w' | 'b',
  maxDepth: number = 4,
): UpcomingTactic[] {
  const upcoming: UpcomingTactic[] = [];
  const seenDescriptions = new Set<string>();

  for (const line of topLines) {
    if (line.moves.length < 2) continue;

    try {
      const chess = new Chess(fen);
      const lineDepth = Math.min(line.moves.length, maxDepth);
      const sanLine: string[] = [];

      for (let i = 0; i < lineDepth; i++) {
        const uci = line.moves[i];
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;

        const fenBefore = chess.fen();
        let moveResult;
        try {
          moveResult = chess.move({ from: from as Square, to: to as Square, promotion });
        } catch {
          break;
        }
        if (!moveResult) break;

        sanLine.push(moveResult.san);
        const fenAfter = chess.fen();
        const movingColor = moveResult.color;

        // Run tactic detectors on this step
        const stepTactics = detectTacticsAtStep(
          fenBefore,
          fenAfter,
          moveResult.from,
          moveResult.to,
          movingColor,
        );

        for (const pattern of stepTactics) {
          if (seenDescriptions.has(pattern.description)) continue;
          seenDescriptions.add(pattern.description);

          const beneficiary = movingColor === playerColor ? 'player' : 'opponent';
          upcoming.push({
            beneficiary,
            depthAhead: i + 1,
            pattern,
            fen: fenAfter,
            line: [...sanLine],
          });
        }
      }
    } catch {
      continue;
    }
  }

  return upcoming;
}

/**
 * Run all tactic detectors on a single move step without eval classification.
 */
function detectTacticsAtStep(
  fenBefore: string,
  fenAfter: string,
  fromSquare: Square,
  toSquare: Square,
  movingColor: Color,
): TacticPattern[] {
  const tactics: TacticPattern[] = [];

  try {
    const chessBefore = new Chess(fenBefore);
    const chessAfter = new Chess(fenAfter);

    const doubleCheck = detectDoubleCheck(chessAfter, movingColor);
    if (doubleCheck) tactics.push(doubleCheck);

    const backRank = detectBackRank(chessAfter, toSquare, movingColor);
    if (backRank) tactics.push(backRank);

    const fork = detectFork(chessAfter, toSquare, movingColor);
    if (fork) tactics.push(fork);

    const pin = detectPin(chessAfter, toSquare, movingColor);
    if (pin) tactics.push(pin);

    const skewer = detectSkewer(chessAfter, toSquare, movingColor);
    if (skewer) tactics.push(skewer);

    const discovery = detectDiscovery(chessAfter, fromSquare, toSquare, movingColor);
    if (discovery) tactics.push(discovery);

    const captured = chessBefore.get(toSquare);
    if (captured && captured.color !== movingColor) {
      const removalOfGuard = detectRemovalOfGuard(chessBefore, chessAfter, toSquare, movingColor);
      if (removalOfGuard) tactics.push(removalOfGuard);
    }
  } catch {
    // Invalid position — skip
  }

  return tactics;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
