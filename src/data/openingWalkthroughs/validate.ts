/**
 * Validation harness for WalkthroughTree data files.
 *
 * Articulates the "what makes a good opening walkthrough" rules into
 * automated checks. Encoded so any LLM (or human) producing a new
 * opening can verify their work via:
 *
 *   const issues = validateWalkthroughTree(MY_OPENING);
 *   const errors = issues.filter(i => i.severity === 'error');
 *   if (errors.length > 0) <fail>;
 *
 * What this does NOT cover:
 *   - Move QUALITY (engine-level "is this the best move?"). That's
 *     in `auditMoveQuality.ts`, which runs Stockfish in Node and is
 *     too slow for the regular test suite.
 *   - Move LEGALITY (does chess.js accept the SAN from the parent
 *     position?). That's already in `vienna.test.ts` and runs in
 *     the regular test suite — kept separate for historical reasons.
 *
 * What this DOES cover:
 *   - Tree-level fields are present (openingName, eco, intro, outro)
 *   - Every non-root node has a non-empty idea
 *   - Every node's idea references its SAN or the spoken form (e.g.
 *     "Nc3" or "knight to c3")
 *   - Branch points (children > 1) require label + forkSubtitle on
 *     every child
 *   - If narration is present: segments are non-empty, arrow/highlight
 *     squares are valid algebraic notation
 *   - leafOutros keys correspond to real leaf paths
 *   - Word count sanity (idea ~20-300 words; warns outside)
 */
import { Chess } from 'chess.js';
import type {
  WalkthroughTree,
  WalkthroughTreeNode,
  NarrationSegment,
} from '../../types/walkthroughTree';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Strip PGN annotation marks (!, ?, !!, ??, !?, ?!) from a SAN string
 *  before passing to chess.js. chess.js's `move()` rejects SAN with
 *  trailing annotation marks, but the LLM frequently includes them
 *  (e.g. "g4?" to mean "the bad move g4"). Production audit (build
 *  23c484d) caught Pirc punish lessons failing on inaccuracy="g4?",
 *  inaccuracy="Bg5?", inaccuracy="f4?" — chess.js rejected all three
 *  purely because of the `?`. Stripping at the chess.js boundary
 *  preserves the LLM's intent (the move IS bad) while letting it
 *  parse. Also strips a leading 1./1.../etc. move-number prefix in
 *  case the LLM includes those (rare but seen in punish setupMoves). */
export function stripSanAnnotations(san: string): string {
  return san
    .replace(/^\d+\.+\s*/, '') // "1." or "1..." prefix
    .replace(/[!?]+\s*$/, '')  // trailing annotation marks
    .trim();
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Tree path to the offending node, joined with the SAN moves. */
  path: string[];
  message: string;
}

const SQUARE_RE = /^[a-h][1-8]$/;
const PIECE_NAMES: Record<string, string> = {
  N: 'knight',
  B: 'bishop',
  R: 'rook',
  Q: 'queen',
  K: 'king',
};

/** Convert SAN to its spoken form so we can check the prose mentions
 *  the move. "Nc3" → "knight to c3", "Bxd5" → "bishop to d5" (the
 *  capture marker doesn't change the spoken square), "O-O" stays
 *  "O-O" (we expect the literal castle notation OR "castle"/"castles"
 *  in prose, handled in the check itself). */
export function spokenForm(san: string): string {
  if (san === 'O-O' || san === 'O-O-O') return san;
  const first = san[0];
  if (first in PIECE_NAMES) {
    const rest = san.slice(1);
    const destMatch = rest.match(/[a-h][1-8]/g);
    if (destMatch && destMatch.length > 0) {
      return `${PIECE_NAMES[first]} to ${destMatch[destMatch.length - 1]}`;
    }
  }
  // Pawn move — the SAN itself is just the destination square (e.g.
  // "e4") or "exd5" for capture. Just return it.
  return san;
}

/** Does the prose mention this SAN or its spoken form? Lowercase
 *  comparison; tolerates the prose using either notation. Castle
 *  moves are recognized via "castle"/"castles"/"castling" or the
 *  literal "O-O". */
function ideaMentionsSan(idea: string, san: string): boolean {
  const lower = idea.toLowerCase();
  if (san === 'O-O' || san === 'O-O-O') {
    return /\bcastle/.test(lower) || lower.includes(san.toLowerCase());
  }
  if (lower.includes(san.toLowerCase())) return true;
  if (lower.includes(spokenForm(san).toLowerCase())) return true;
  // For pawn moves like "e4" — also accept "e-pawn" or "to e4".
  if (/^[a-h][1-8]$/.test(san)) {
    if (lower.includes(`to ${san.toLowerCase()}`)) return true;
    if (lower.includes(`-${san[0]}${san[1]}`)) return true;
  }
  return false;
}

function isValidSquare(sq: string): boolean {
  return SQUARE_RE.test(sq);
}

/** Walk the tree depth-first, collecting issues. */
function walkTree(
  node: WalkthroughTreeNode,
  pathSans: string[],
  issues: ValidationIssue[],
): void {
  // Non-root nodes have content rules.
  if (node.san !== null) {
    const here = [...pathSans, node.san];

    // Idea must be non-empty.
    if (!node.idea.trim()) {
      issues.push({
        severity: 'error',
        path: here,
        message: `node has empty idea`,
      });
    } else {
      // Idea should mention the move played.
      if (!ideaMentionsSan(node.idea, node.san)) {
        issues.push({
          severity: 'warning',
          path: here,
          message: `idea does not mention "${node.san}" or its spoken form ("${spokenForm(node.san)}")`,
        });
      }
      // Word count sanity.
      const words = node.idea.trim().split(/\s+/).length;
      if (words < 15) {
        issues.push({
          severity: 'warning',
          path: here,
          message: `idea is short (${words} words); aim for ~30-200`,
        });
      } else if (words > 300) {
        issues.push({
          severity: 'warning',
          path: here,
          message: `idea is long (${words} words); aim for ~30-200`,
        });
      }
    }

    // Narration segments.
    if (node.narration !== undefined) {
      validateNarration(node.narration, here, issues);
    }
  }

  // Branch-point rules.
  if (node.children.length > 1) {
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      const branchPath = [...pathSans, node.san ?? '(root)'];
      if (!child.label || !child.label.trim()) {
        issues.push({
          severity: 'error',
          path: branchPath,
          message: `branch child #${i} missing label`,
        });
      }
      if (!child.forkSubtitle || !child.forkSubtitle.trim()) {
        issues.push({
          severity: 'error',
          path: branchPath,
          message: `branch child #${i} missing forkSubtitle`,
        });
      }
    }
  }

  // Recurse.
  for (const child of node.children) {
    const childPath = node.san === null ? pathSans : [...pathSans, node.san];
    walkTree(child.node, childPath, issues);
  }
}

function validateNarration(
  segments: NarrationSegment[],
  pathSans: string[],
  issues: ValidationIssue[],
): void {
  if (segments.length === 0) {
    issues.push({
      severity: 'error',
      path: pathSans,
      message: `narration is an empty array (omit the field instead)`,
    });
    return;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!seg.text.trim()) {
      issues.push({
        severity: 'error',
        path: pathSans,
        message: `narration segment #${i} text is empty`,
      });
    }
    if (seg.arrows) {
      for (let j = 0; j < seg.arrows.length; j += 1) {
        const arr = seg.arrows[j];
        if (!isValidSquare(arr.from)) {
          issues.push({
            severity: 'error',
            path: pathSans,
            message: `narration[${i}].arrows[${j}].from "${arr.from}" is not valid algebraic`,
          });
        }
        if (!isValidSquare(arr.to)) {
          issues.push({
            severity: 'error',
            path: pathSans,
            message: `narration[${i}].arrows[${j}].to "${arr.to}" is not valid algebraic`,
          });
        }
        if (arr.from === arr.to) {
          issues.push({
            severity: 'error',
            path: pathSans,
            message: `narration[${i}].arrows[${j}] has from===to (${arr.from})`,
          });
        }
      }
    }
    if (seg.highlights) {
      for (let j = 0; j < seg.highlights.length; j += 1) {
        const hl = seg.highlights[j];
        if (!isValidSquare(hl.square)) {
          issues.push({
            severity: 'error',
            path: pathSans,
            message: `narration[${i}].highlights[${j}].square "${hl.square}" is not valid algebraic`,
          });
        }
      }
    }
  }
}

function collectLeafPaths(
  node: WalkthroughTreeNode,
  pathSans: string[],
): Set<string> {
  const result = new Set<string>();
  // The path that reaches THIS node (including its own SAN, except
  // for the root which has san: null).
  const here = node.san === null ? pathSans : [...pathSans, node.san];
  if (node.children.length === 0) {
    result.add(here.join(' '));
    return result;
  }
  for (const child of node.children) {
    for (const p of collectLeafPaths(child.node, here)) {
      result.add(p);
    }
  }
  return result;
}

/** Run all structural + style validation rules against a tree. */
export function validateWalkthroughTree(
  tree: WalkthroughTree,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Tree-level fields.
  if (!tree.openingName.trim()) {
    issues.push({
      severity: 'error',
      path: [],
      message: 'openingName is empty',
    });
  }
  if (!tree.eco.trim()) {
    issues.push({ severity: 'error', path: [], message: 'eco is empty' });
  }
  if (!tree.intro.trim()) {
    issues.push({ severity: 'warning', path: [], message: 'intro is empty' });
  }
  if (!tree.outro.trim()) {
    issues.push({ severity: 'warning', path: [], message: 'outro is empty' });
  }

  // Walk the tree.
  walkTree(tree.root, [], issues);

  // leafOutros keys must correspond to real leaf paths.
  if (tree.leafOutros) {
    const leafPaths = collectLeafPaths(tree.root, []);
    for (const key of Object.keys(tree.leafOutros)) {
      if (!leafPaths.has(key)) {
        issues.push({
          severity: 'error',
          path: [key],
          message: `leafOutros key "${key}" does not match any leaf path in the tree`,
        });
      }
    }
  }

  return issues;
}

/** Try a SAN sequence from the starting position. Returns the
 *  resulting Chess instance on success, or an error message on the
 *  first illegal move. */
function tryReplay(
  sans: string[],
  startFen?: string,
): { fen: string } | { error: string; failedAt: number; failedSan: string } {
  const c = startFen ? new Chess(startFen) : new Chess();
  for (let i = 0; i < sans.length; i += 1) {
    try {
      c.move(stripSanAnnotations(sans[i]));
    } catch {
      return { error: `illegal move`, failedAt: i, failedSan: sans[i] };
    }
  }
  return { fen: c.fen() };
}

/** Walk the tree depth-first and return any SANs that don't legally
 *  resolve from their parent FEN. Honors the tree's optional
 *  startFen so middlegame pattern trees that begin mid-game validate
 *  correctly. Used by per-data tests (vienna.test.ts and middlegame
 *  pattern tests) to catch typos before runtime. */
export function validateTreeMoveLegality(
  tree: WalkthroughTree,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const startFen = tree.startFen;
  function walk(node: WalkthroughTreeNode, parentFen: string, path: string[]): void {
    if (node.san !== null) {
      const probe = startFen ? new Chess(parentFen) : new Chess(parentFen);
      try {
        probe.move(stripSanAnnotations(node.san));
      } catch {
        issues.push({
          severity: 'error',
          path: [...path, node.san],
          message: `SAN "${node.san}" illegal from FEN ${parentFen}`,
        });
        return;
      }
      const childFen = probe.fen();
      for (const child of node.children) {
        walk(child.node, childFen, [...path, node.san]);
      }
    } else {
      for (const child of node.children) {
        walk(child.node, parentFen, path);
      }
    }
  }
  walk(
    tree.root,
    startFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    [],
  );
  return issues;
}

/** Validate that every SAN sequence in the optional fields
 *  (concepts/findMove/drill/punish) is legal from the starting
 *  position. The tree's `root` is validated separately by
 *  vienna.test.ts (kept there for historical reasons + because the
 *  tree-walking logic is more complex). */
export function validateMoveLegality(
  tree: WalkthroughTree,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // findMove: path is a legal SAN sequence; each candidate's SAN is
  // legal from the path's resulting FEN.
  if (tree.findMove) {
    for (let i = 0; i < tree.findMove.length; i += 1) {
      const q = tree.findMove[i];
      const replay = tryReplay(q.path);
      if ('error' in replay) {
        issues.push({
          severity: 'error',
          path: ['findMove', String(i), 'path'],
          message: `path illegal at index ${replay.failedAt} ("${replay.failedSan}")`,
        });
        continue;
      }
      // Test each candidate from the resulting FEN.
      for (let j = 0; j < q.candidates.length; j += 1) {
        const cand = q.candidates[j];
        const probe = new Chess(replay.fen);
        try {
          probe.move(stripSanAnnotations(cand.san));
        } catch {
          issues.push({
            severity: 'error',
            path: ['findMove', String(i), 'candidates', String(j)],
            message: `candidate "${cand.san}" is illegal from path FEN`,
          });
        }
      }
      // Exactly one candidate should be marked correct.
      const correctCount = q.candidates.filter((c) => c.correct).length;
      if (correctCount !== 1) {
        issues.push({
          severity: 'error',
          path: ['findMove', String(i)],
          message: `expected exactly 1 correct candidate, got ${correctCount}`,
        });
      }
    }
  }

  // drill: each line's moves are a legal SAN sequence from start.
  if (tree.drill) {
    for (let i = 0; i < tree.drill.length; i += 1) {
      const line = tree.drill[i];
      if (!line.name.trim()) {
        issues.push({
          severity: 'error',
          path: ['drill', String(i)],
          message: 'drill line has empty name',
        });
      }
      if (line.moves.length === 0) {
        issues.push({
          severity: 'error',
          path: ['drill', String(i), 'moves'],
          message: 'drill line has empty moves array',
        });
        continue;
      }
      const replay = tryReplay(line.moves);
      if ('error' in replay) {
        issues.push({
          severity: 'error',
          path: ['drill', String(i), 'moves'],
          message: `drill moves illegal at index ${replay.failedAt} ("${replay.failedSan}")`,
        });
      }
    }
  }

  // punish: setupMoves legal, inaccuracy legal from setup,
  // punishment legal from setup+inaccuracy, distractors legal from
  // setup+inaccuracy, followup moves legal from setup+inaccuracy+punishment.
  if (tree.punish) {
    for (let i = 0; i < tree.punish.length; i += 1) {
      const lesson = tree.punish[i];
      if (!lesson.name.trim()) {
        issues.push({
          severity: 'error',
          path: ['punish', String(i)],
          message: 'punish lesson has empty name',
        });
      }

      // setup — when setupFen is provided, use it directly (puzzle-DB
      // derived lessons start from a real-game mid-opening FEN that
      // can't always be reached by replaying SAN). Otherwise replay
      // the setupMoves SAN sequence from the standard start.
      let setupFen: string;
      if (lesson.setupFen) {
        try {
          // Validate by constructing — Chess() throws on malformed FEN.
          setupFen = new Chess(lesson.setupFen).fen();
        } catch {
          issues.push({
            severity: 'error',
            path: ['punish', String(i), 'setupFen'],
            message: `setupFen is not a valid FEN`,
          });
          continue;
        }
      } else {
        const setupReplay = tryReplay(lesson.setupMoves);
        if ('error' in setupReplay) {
          issues.push({
            severity: 'error',
            path: ['punish', String(i), 'setupMoves'],
            message: `setupMoves illegal at index ${setupReplay.failedAt} ("${setupReplay.failedSan}")`,
          });
          continue;
        }
        setupFen = setupReplay.fen;
      }

      // inaccuracy
      let postInaccuracyFen: string | null = null;
      try {
        const probe = new Chess(setupFen);
        probe.move(stripSanAnnotations(lesson.inaccuracy));
        postInaccuracyFen = probe.fen();
      } catch {
        issues.push({
          severity: 'error',
          path: ['punish', String(i), 'inaccuracy'],
          message: `inaccuracy "${lesson.inaccuracy}" illegal from setup FEN`,
        });
      }

      if (postInaccuracyFen) {
        // punishment
        let postPunishFen: string | null = null;
        try {
          const probe = new Chess(postInaccuracyFen);
          probe.move(stripSanAnnotations(lesson.punishment));
          postPunishFen = probe.fen();
        } catch {
          issues.push({
            severity: 'error',
            path: ['punish', String(i), 'punishment'],
            message: `punishment "${lesson.punishment}" illegal from post-inaccuracy FEN`,
          });
        }

        // distractors — legal alternatives to the punishment
        for (let j = 0; j < lesson.distractors.length; j += 1) {
          const d = lesson.distractors[j];
          try {
            const probe = new Chess(postInaccuracyFen);
            probe.move(stripSanAnnotations(d.san));
          } catch {
            issues.push({
              severity: 'error',
              path: ['punish', String(i), 'distractors', String(j)],
              message: `distractor "${d.san}" illegal from post-inaccuracy FEN`,
            });
          }
        }

        // followup
        if (postPunishFen && lesson.followup) {
          const probe = new Chess(postPunishFen);
          for (let j = 0; j < lesson.followup.length; j += 1) {
            const fm = lesson.followup[j];
            try {
              probe.move(stripSanAnnotations(fm.san));
            } catch {
              issues.push({
                severity: 'error',
                path: ['punish', String(i), 'followup', String(j)],
                message: `followup move "${fm.san}" illegal from prior position`,
              });
              break;
            }
          }
        }
      }
    }
  }

  // concepts: optional path is legal.
  if (tree.concepts) {
    for (let i = 0; i < tree.concepts.length; i += 1) {
      const q = tree.concepts[i];
      if (q.path && q.path.length > 0) {
        const replay = tryReplay(q.path);
        if ('error' in replay) {
          issues.push({
            severity: 'error',
            path: ['concepts', String(i), 'path'],
            message: `path illegal at index ${replay.failedAt} ("${replay.failedSan}")`,
          });
        }
      }
      // multiSelect → at least one correct; single-select → exactly one.
      const correctCount = q.choices.filter((c) => c.correct).length;
      if (q.multiSelect) {
        if (correctCount === 0) {
          issues.push({
            severity: 'error',
            path: ['concepts', String(i)],
            message: 'multiSelect question has zero correct choices',
          });
        }
      } else {
        if (correctCount !== 1) {
          issues.push({
            severity: 'error',
            path: ['concepts', String(i)],
            message: `single-select question has ${correctCount} correct choices, expected exactly 1`,
          });
        }
      }
    }
  }

  // Suppress the unused variable lint by referencing STARTING_FEN
  // (we use it indirectly via `new Chess()` which initializes to it).
  void STARTING_FEN;

  return issues;
}

/** Pretty-print issues for console output. */
export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'No issues.';
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const lines: string[] = [];
  lines.push(`${errors.length} errors, ${warnings.length} warnings`);
  for (const issue of issues) {
    const prefix = issue.severity === 'error' ? 'ERROR' : 'warn ';
    const path = issue.path.length === 0 ? '<root>' : issue.path.join(' ');
    lines.push(`  [${prefix}] ${path}: ${issue.message}`);
  }
  return lines.join('\n');
}
