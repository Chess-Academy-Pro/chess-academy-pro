/**
 * useTeachWalkthrough
 * -------------------
 * Drives an in-place walkthrough of a `WalkthroughTree` on the
 * /coach/teach surface. Replaces the old "navigate to a separate
 * walkthrough page" flow that lost the chat panel.
 *
 * State machine (the `phase` field):
 *   - 'idle'      : nothing active; start(tree) to begin.
 *   - 'narrating' : board shows current node's FEN, voice speaks
 *                   `node.idea`. When voice resolves, transition to
 *                   one of: linear-advance (auto next), 'fork', 'leaf'.
 *   - 'fork'      : board paused at a branch point; tap targets shown.
 *                   pickFork(idx) → narrating(child).
 *   - 'leaf'      : board paused at the end of a chosen branch.
 *                   backtrackToLastFork() restores the last fork.
 *                   playItOut() handed back to caller via callback.
 *   - 'paused'    : user (or brain) interrupted mid-narration. Voice
 *                   stopped, board frozen at current FEN. resume()
 *                   re-narrates the same node's idea.
 *
 * The hook OWNS chess.js — it walks SANs from the root through the
 * current path to compute FEN. Exposes the FEN to the component so
 * the board renders the correct position. Caller does not provide
 * FENs in the data file.
 *
 * Voice integration: speaks `idea` via `voiceService.speakForced`,
 * with a backup timer that advances even if TTS hangs. Same pattern
 * `walkthroughRunner.runStep` uses; inlined here because the tree
 * runner has different transition logic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { stripSanAnnotations } from '../data/openingWalkthroughs/validate';
import { voiceService } from '../services/voiceService';
import { logAppAudit } from '../services/appAuditor';
import { markStageComplete } from '../services/openingProgress';
import { getCachedOpening } from '../services/openingGenerator';
import { useAppStore } from '../stores/appStore';
import { resolveCoachNarration } from '../utils/coachNarration';
import type {
  WalkthroughTree,
  WalkthroughTreeNode,
  WalkthroughTreeChild,
  PunishLesson,
  NarrationArrow,
  NarrationHighlight,
} from '../types/walkthroughTree';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Convert a SAN to a friendly spoken form. Used for the punish-
 *  walkthrough fork subtitles so all options look uniform — none
 *  reads as a tell. "Qxg4" → "Queen takes g4", "Nf3" → "Knight to
 *  f3", "h3" → "h3", "O-O" → "Castle". */
function sanToFriendly(san: string): string {
  if (san === 'O-O') return 'Castle short';
  if (san === 'O-O-O') return 'Castle long';
  const pieceMap: Record<string, string> = {
    N: 'Knight',
    B: 'Bishop',
    R: 'Rook',
    Q: 'Queen',
    K: 'King',
  };
  const first = san[0];
  if (first in pieceMap) {
    const captures = san.includes('x');
    const dest = san.match(/[a-h][1-8]/g)?.slice(-1)[0];
    if (dest) {
      return `${pieceMap[first]} ${captures ? 'takes' : 'to'} ${dest}`;
    }
  }
  // Pawn move — just return the SAN.
  return san;
}

/** Determine which side a move belongs to based on its index in a
 *  zero-indexed sequence starting from white's first move. */
function sideAtIndex(plyIndex: number): 'white' | 'black' {
  return plyIndex % 2 === 0 ? 'white' : 'black';
}

/** Build a one-shot WalkthroughTree from a PunishLesson. Reuses the
 *  walkthrough engine to play the punish lesson with the same UI as
 *  the opening walkthrough — animated moves with narration, fork
 *  picker at the punishment moment, leaf at the end with the
 *  whyPunish takeaway. Per the user's morning iteration: "Punishment
 *  lines need to be in walk through style following the same pattern
 *  we teach the opening in."
 *
 *  Tree shape:
 *    root → setup1 (silent, fast advance) → setup2 → ... → setupN
 *      → inaccuracy (highlighted red, whyBad narrated)
 *      → FORK[ punishment, distractor1, distractor2, ... ]
 *           punishment → followup1 → ... → leaf (whyPunish outro)
 *           distractor → leaf (distractor explanation)
 */
export function buildPunishWalkthroughTree(
  lesson: PunishLesson,
  parentOpening: WalkthroughTree,
): WalkthroughTree {
  // Build leaf nodes for each distractor (single node, dead-end).
  const distractorChildren: WalkthroughTreeChild[] = lesson.distractors.map(
    (d) => ({
      label: d.san,
      forkSubtitle: sanToFriendly(d.san),
      node: {
        san: d.san,
        movedBy: 'white',
        idea: `${d.san} — ${d.label}. ${d.explanation}\n\nThe actual punishment was ${lesson.punishment}: ${lesson.whyPunish}`,
        narration: [
          {
            text: `${sanToFriendly(d.san)}. Not the move.`,
            arrows: [],
          },
          {
            text: d.explanation,
          },
          {
            text: `The actual punishment was ${sanToFriendly(lesson.punishment)}. ${lesson.whyPunish}`,
          },
        ],
        children: [],
      },
    }),
  );

  // Build the punishment subtree: punishment node → followup chain → leaf.
  // followupSide alternates from the move AFTER punishment.
  // Punishment is white's move, so followup[0] is black's, followup[1] white's, etc.
  let punishmentLeafContinuation: WalkthroughTreeNode | null = null;
  if (lesson.followup && lesson.followup.length > 0) {
    // Build followup from the END backwards so we can chain children.
    let current: WalkthroughTreeNode | null = null;
    for (let i = lesson.followup.length - 1; i >= 0; i -= 1) {
      const fm = lesson.followup[i];
      const node: WalkthroughTreeNode = {
        san: fm.san,
        movedBy: i % 2 === 0 ? 'black' : 'white',
        idea: fm.idea,
        narration: [{ text: fm.idea }],
        children: current ? [{ node: current }] : [],
      };
      current = node;
    }
    punishmentLeafContinuation = current;
  }

  const punishmentChild: WalkthroughTreeChild = {
    label: lesson.punishment,
    forkSubtitle: sanToFriendly(lesson.punishment),
    node: {
      san: lesson.punishment,
      movedBy: 'white',
      idea: lesson.whyPunish,
      narration: [
        {
          text: `${sanToFriendly(lesson.punishment)}.`,
        },
        {
          text: lesson.whyPunish,
        },
      ],
      children: punishmentLeafContinuation
        ? [{ node: punishmentLeafContinuation }]
        : [],
    },
  };

  // Combine: punishment first (correct answer), then distractors.
  // Sort alphabetically by SAN so the punishment isn't always at
  // index 0 — same anti-tell measure as the quiz panel.
  const forkChildren = [punishmentChild, ...distractorChildren].sort((a, b) =>
    (a.label ?? '').localeCompare(b.label ?? ''),
  );

  // Inaccuracy node: animates the opponent's bad move, narrates
  // whyBad with red highlight, then forks to the candidate moves.
  // Side determination: when setupFen is present, the FEN itself
  // tells us whose turn it is — parse the side-to-move character.
  // Otherwise count from the start position by ply parity of
  // setupMoves.length.
  const inaccuracySide: 'white' | 'black' = lesson.setupFen
    ? (lesson.setupFen.split(' ')[1] === 'b' ? 'black' : 'white')
    : sideAtIndex(lesson.setupMoves.length);
  const opponentLabel = inaccuracySide === 'white' ? 'White' : 'Black';
  const inaccuracyNode: WalkthroughTreeNode = {
    san: lesson.inaccuracy,
    movedBy: inaccuracySide,
    idea: lesson.whyBad,
    narration: [
      {
        text: `Now ${opponentLabel} plays ${sanToFriendly(lesson.inaccuracy)}.`,
        highlights: [{ square: 'a1', color: 'red' }], // placeholder; will be overridden
      },
      {
        text: lesson.whyBad,
      },
      {
        text: 'What is your punishment?',
      },
    ],
    children: forkChildren,
  };

  // Two paths to position the board at the inaccuracy:
  //   (a) setupFen is provided (puzzle-DB-derived lessons). The
  //       built tree's startFen carries the position directly; the
  //       inaccuracy node sits as the root child with no setup
  //       animation — the student starts at the puzzle position
  //       with the lesson's intro framing the opening context.
  //   (b) setupMoves SAN sequence (LLM-emitted lessons). Animate
  //       each setup move quickly with empty idea so the position
  //       builds visibly from the standard start.
  let rootChild: WalkthroughTreeNode = inaccuracyNode;
  if (!lesson.setupFen) {
    for (let i = lesson.setupMoves.length - 1; i >= 0; i -= 1) {
      const san = lesson.setupMoves[i];
      const movedBy = sideAtIndex(i);
      rootChild = {
        san,
        movedBy,
        idea: '',
        children: [{ node: rootChild }],
      };
    }
  }

  // Root wrapper.
  const root: WalkthroughTreeNode = {
    san: null,
    movedBy: null,
    idea: '',
    children: [{ node: rootChild }],
  };

  return {
    openingName: `${parentOpening.openingName}: ${lesson.name}`,
    eco: parentOpening.eco,
    // Inherit board orientation from the parent opening so a black-
    // side opening's punish lessons keep Black on bottom.
    studentSide: parentOpening.studentSide,
    // When setupFen is set, the walkthrough loads from that FEN
    // directly. Otherwise the walkthrough animates setupMoves from
    // the standard start.
    startFen: lesson.setupFen,
    intro: lesson.setupFen
      ? `${lesson.name}. ${opponentLabel} has just played a careless move out of the opening — find the punishment.`
      : `${lesson.name}. Watch the position set up, then find the punishment.`,
    outro: lesson.whyPunish,
    root,
  };
}

/** Words per minute used for the backup-timer heuristic. Matches
 *  `walkthroughRunner` so the lesson rhythm is consistent.
 *
 *  Production audit (build 23c484d) showed 132-194 char Pirc
 *  narrations spaced 13-15s apart — the backup timer was firing
 *  while Polly was still mid-sentence and `transitionAfter()` was
 *  starting the NEXT move's speak() which stopped the in-flight
 *  audio. The 1.6x multiplier under-estimates Polly's real time
 *  because:
 *    1. chess SAN expands when spoken ("Bc5" → "bishop to c5") —
 *       roughly 50% more syllables than the raw text suggests.
 *    2. Polly Ruth runs ~140-150 wpm for chess prose, not 180.
 *    3. Multi-segment narration adds inter-segment fetch latency
 *       (~200-400ms each).
 *  Bumping multiplier 1.6 → 3.0 and MIN 1500 → 3000 gives the
 *  voice promise time to resolve first (which is the intended
 *  primary gate per CLAUDE.md). Backup remains a safety net for
 *  hung-TTS cases. */
const BACKUP_WPM = 180;
const MIN_BACKUP_MS = 3000;
const MAX_BACKUP_MS = 45_000;
const POST_NARRATION_BUFFER_MS = 400;

function clampBackupMs(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const base = (wordCount / BACKUP_WPM) * 60_000;
  return Math.max(MIN_BACKUP_MS, Math.min(MAX_BACKUP_MS, base * 3.0));
}

/**
 * Policy-gated speak for the Learn walkthrough. Reads the user's
 * unified `coachNarration` preference on every call so a Settings
 * change mid-walkthrough takes effect on the very next step.
 *
 * - 'full'   → speak `text` via speakForced (current behavior preserved)
 * - 'brief'  → speak `shortText` when caller passed one; otherwise
 *              silent-reading-pace fallback. Authors opt into Brief
 *              narration per node/segment by populating shortIdea /
 *              shortText (see WalkthroughTreeNode + NarrationSegment).
 *              We deliberately do NOT auto-truncate `text` — random
 *              first-sentence cuts can land on a setup instead of
 *              the punchline, which is worse than silence.
 * - 'silent' → no audio. Returns a Promise that resolves at the
 *              same reading-pace voice would have settled, so the
 *              walkthrough's voice-promise-gated advance pacing is
 *              preserved.
 */
async function speakWalkthroughText(
  text: string,
  shortText?: string,
): Promise<void> {
  const prefs = useAppStore.getState().activeProfile?.preferences;
  const verbosity = resolveCoachNarration(prefs);
  if (verbosity === 'full') {
    return voiceService.speakForced(text);
  }
  if (verbosity === 'brief' && shortText && shortText.trim().length > 0) {
    return voiceService.speakForced(shortText);
  }
  // 'silent', or 'brief' without a short variant on this node.
  await new Promise<void>((resolve) => setTimeout(resolve, clampBackupMs(text)));
}

export type WalkthroughPhase =
  | 'idle'
  | 'choose-mode'  // returning student: chooser between walkthrough + stages
  | 'narrating'
  | 'fork'
  | 'trap-prompt'    // inline-trap intro narrated; user picks See/Continue
  | 'trap-playing'   // trap line animating on the board
  | 'leaf'
  | 'paused'
  | 'stage-menu'  // post-leaf hub; pick which stage to do next
  | 'quiz'        // concept-check OR find-the-move OR punish (all MC)
  | 'drill';      // woodpecker — interactive board, play the line

/** Which post-walkthrough stage the user is currently in. */
export type StageKind = 'concepts' | 'findMove' | 'drill' | 'punish';

export interface UseTeachWalkthroughReturn {
  /** Current state-machine phase. */
  phase: WalkthroughPhase;
  /** True iff phase !== 'idle'. */
  isActive: boolean;
  /** The tree currently being walked, or null when idle. */
  tree: WalkthroughTree | null;
  /** The current node (the position the board shows). null when idle. */
  currentNode: WalkthroughTreeNode | null;
  /** FEN of the current position. Always valid; STARTING_FEN when idle
   *  or at root. */
  fen: string;
  /** Children of the current node, exposed for fork tap-target
   *  rendering. Empty array when not at a fork. */
  forkOptions: WalkthroughTreeChild[];
  /** True when the current node is a leaf (line ends here). */
  isLeaf: boolean;
  /** True when the user can back up to a previous fork in the path. */
  canBacktrack: boolean;
  /** SAN-joined path from root to current node — useful for outro
   *  lookup and audit trails. */
  pathSans: string[];
  /** Default leaf outro for the current leaf, with tree-level
   *  override applied if `leafOutros[pathKey]` exists. */
  leafOutro: string | null;
  /** Currently visible arrows on the board, set by the active
   *  narration segment. Empty when no segment is active or when
   *  the current segment has no arrows. Caller passes these to
   *  the NarrationArrowOverlay component. */
  narrationArrows: NarrationArrow[];
  /** Currently visible square highlights, same semantics as
   *  `narrationArrows`. */
  narrationHighlights: NarrationHighlight[];

  // ─── Stage 2-5 state (post-walkthrough pedagogy) ────────────
  /** Which stage is active. null when in walkthrough/leaf/menu. */
  activeStage: StageKind | null;
  /** Index into the active stage's question/line array. */
  stageIndex: number;
  /** For 'quiz' phase: which choice the student picked, or null
   *  if they haven't answered yet. */
  quizSelected: number | null;
  /** For 'quiz' phase: true after the student picks, before they
   *  hit "next". */
  quizShowingFeedback: boolean;
  /** For 'drill' phase: ply index into the drill line. */
  drillMoveIndex: number;
  /** For 'drill' phase: FEN at the current drill position. */
  drillFen: string;
  /** For 'drill' phase: when the student plays a wrong move, this
   *  holds the attempted SAN + the expected SAN so the UI can show
   *  feedback. null when no mistake pending. */
  drillWrongMove: { tried: string; expected: string } | null;
  /** For 'drill' phase: true once the entire drill line has been
   *  played correctly. */
  drillComplete: boolean;

  /** Begin walking the given tree. Idempotent — calling start() twice
   *  with the same tree restarts from root. */
  start: (
    tree: WalkthroughTree,
    options?: { showChooser?: boolean },
  ) => void;
  /** Pause mid-narration (user typed in chat / asked a question).
   *  Voice stops; board freezes; phase = 'paused'. */
  pause: () => void;
  /** Resume from paused state. Re-narrates the current node's idea. */
  resume: () => void;
  /** Tap a fork option. Advances down the chosen branch. */
  pickFork: (childIndex: number) => void;
  /** Back up to the most recent fork on the path. The board jumps to
   *  that position, phase becomes 'fork', tap targets reappear. */
  backtrackToLastFork: () => void;
  /** End the walkthrough entirely. Phase → 'idle'. */
  stop: () => void;
  /** Skip the current narration and immediately transition (linear
   *  → next, fork → exposed, leaf → exposed). Useful for "I get it,
   *  next" tap. */
  skipNarration: () => void;

  // ─── Stage 2-5 actions ──────────────────────────────────────
  /** From a leaf, transition to the stage-menu hub. */
  enterStageMenu: () => void;
  /** Start a stage from the menu. For drill, also pass the line index
   *  via selectDrillLine after; quiz stages start at index 0. */
  startStage: (stage: StageKind) => void;
  /** For drill: select which line (from tree.drill[]) to grind. */
  selectDrillLine: (lineIndex: number) => void;
  /** For quiz stages (concepts/findMove/punish): student picks a
   *  choice index. Reveals the explanation; does NOT auto-advance. */
  pickQuizChoice: (choiceIndex: number) => void;
  /** For quiz stages: advance to next question (or back to menu when
   *  all questions are done). */
  nextQuizQuestion: () => void;
  /** For drill: student attempted a SAN move on the board. Returns
   *  whether it matched the expected next move. On match, the hook
   *  auto-advances drillFen + drillMoveIndex (and plays opponent's
   *  reply if next ply is opponent's). On mismatch, sets
   *  drillWrongMove and the UI shows the correction. */
  attemptDrillMove: (san: string) => { ok: boolean };
  /** Attempt a Find-the-Move answer via the BOARD: the student
   *  drags a piece on the rendered position; we route to
   *  pickQuizChoice if the SAN matches a candidate. Returns the
   *  matched candidate index, or null if no candidate matches. */
  attemptFindMoveAnswer: (san: string) => { matchedIndex: number | null };
  /** Dismiss the wrong-move feedback and let the student try again
   *  from the same drill position. */
  acknowledgeDrillMistake: () => void;
  /** Restart the current drill line from move 0. */
  restartDrill: () => void;
  /** Skip the walkthrough entirely and land at the stage-menu hub
   *  for the given tree. Optional autoSelectStage transitions
   *  immediately into that specific stage (concepts / findMove /
   *  drill / punish) instead of showing the menu. Used when the
   *  student types "drill Vienna" / "punish Vienna" / etc. — the
   *  surface routing detects the stage keyword and jumps directly.
   *  Eliminates the "I have to play the whole opening every time
   *  just to drill" complaint. */
  startAtStageMenu: (tree: WalkthroughTree, autoSelectStage?: StageKind) => void;
  /** Re-start the walkthrough from move 1 from any phase. Used by
   *  the "Watch walkthrough again" CTA on the stage menu. */
  restartWalkthrough: () => void;
  /** From any stage, return to the stage-menu hub. */
  backToStageMenu: () => void;
  /** Start a specific punish lesson as a self-contained walkthrough.
   *  Saves the current opening tree as the parent, then runs the
   *  punish lesson through the same animation engine. */
  startPunishLesson: (lessonIndex: number) => void;
  /** Exit a punish walkthrough back to the parent opening's stage
   *  menu. Restores the parent tree without re-narrating the intro. */
  exitPunishToMenu: () => void;
  /** True when we're inside a punish-walkthrough sub-flow. UI uses
   *  this to render the "Back to lessons" button instead of the
   *  default "End walkthrough" on the leaf panel. */
  isInPunishLesson: boolean;
  /** Refresh the optional stages (concepts / findMove / drill /
   *  punish) from Dexie cache. Used after background generation so
   *  newly-completed stages appear in the stage menu without a full
   *  page reload. Walkthrough state (pathNodes, phase) is unaffected. */
  mergeStagesFromCache: () => Promise<void>;

  // ─── Inline trap-prompt state ────────────────────────────────
  /** The PunishLesson currently being introduced (phase ===
   *  'trap-prompt') or animated (phase === 'trap-playing'). null
   *  when no trap is active. */
  pendingTrap: PunishLesson | null;
  /** Board FEN during 'trap-playing' phase. The board renderer
   *  prefers this over `fen` when set, so the trap detour shows
   *  on-board without mutating walkthrough path state. null when
   *  no trap is animating. */
  trapFen: string | null;
  /** Number of traps remaining in the current fork's queue (after
   *  the current one). UI uses this to label the Continue button
   *  ("Continue, skip these N mistakes"). */
  trapsQueuedAfter: number;
  /** User accepted the trap intro — start animating the bad move /
   *  punishment / followup. */
  acceptTrap: () => void;
  /** User declined the trap intro — move to the next queued trap
   *  (if any) or transition to the fork picker. */
  skipTrap: () => void;
}

/** Find punish lessons whose setupMoves match the walkthrough's
 *  current path EXACTLY. These are "common mistakes here" — the
 *  next move from this position is the inaccuracy. Returns [] when
 *  the tree has no punish data or no exact-match lessons. Used by
 *  the inline trap-prompt feature: when the walkthrough hits a
 *  fork node whose pathSans matches a punish lesson's setupMoves,
 *  the coach intros the trap before showing the fork picker. */
/** Exported for tests under `_findMatchingTraps` — internal use only. */
export function _findMatchingTraps(
  pathSans: string[],
  punishLessons: PunishLesson[] | undefined,
): PunishLesson[] {
  return findMatchingTraps(pathSans, punishLessons);
}
function findMatchingTraps(
  pathSans: string[],
  punishLessons: PunishLesson[] | undefined,
): PunishLesson[] {
  if (!punishLessons || punishLessons.length === 0) return [];
  return punishLessons.filter((lesson) => {
    // Puzzle-DB-derived punishes carry setupFen (the actual lesson
    // FEN — a mid-game position from a real puzzle) and store the
    // canonical opening's PGN in setupMoves only for context-display
    // and canonical-pinning purposes. Their inaccuracy / punishment
    // SANs are LEGAL only from setupFen, not from the walkthrough's
    // current position. Auto-narrating them during the walkthrough
    // ("a common mistake here is Rxe4") is wrong because Rxe4 isn't
    // playable at the walkthrough FEN. They surface via the punish
    // stage menu instead, where startPunishLesson loads setupFen.
    // Production audit (build 3a27027): every Italian Classical
    // walkthrough fired 5 trap-prompts at the spine's leaf with
    // illegal-from-this-position SANs; user couldn't make sense of
    // it. Filter them out here.
    if (lesson.setupFen) return false;
    return (
      lesson.setupMoves.length === pathSans.length &&
      lesson.setupMoves.every((m, i) => m === pathSans[i])
    );
  });
}

/** Compute the FEN at a node by walking chess.js through the SAN
 *  path from the root. Returns the start FEN (or standard starting
 *  position) if the path is empty. Middlegame pattern trees pass a
 *  non-default startFen so the position lands mid-game. */
function fenForPath(pathSans: string[], startFen?: string): string {
  const baseFen = startFen ?? STARTING_FEN;
  if (pathSans.length === 0) return baseFen;
  const chess = startFen ? new Chess(startFen) : new Chess();
  for (const san of pathSans) {
    try {
      chess.move(san);
    } catch {
      // Bad data — already caught by validate.ts; bail gracefully.
      return baseFen;
    }
  }
  return chess.fen();
}

/** Find the most recent ancestor of the current node whose children
 *  count is > 1. Returns the index in `pathNodes` (so caller can
 *  trim path to that point), or -1 if no fork above. */
function findLastForkIndex(pathNodes: WalkthroughTreeNode[]): number {
  for (let i = pathNodes.length - 1; i >= 0; i--) {
    if (pathNodes[i].children.length > 1) return i;
  }
  return -1;
}

export function useTeachWalkthrough(): UseTeachWalkthroughReturn {
  const [tree, setTree] = useState<WalkthroughTree | null>(null);
  const [phase, setPhase] = useState<WalkthroughPhase>('idle');
  // pathNodes[0] is always the root when active. The current node
  // is pathNodes[pathNodes.length - 1].
  const [pathNodes, setPathNodes] = useState<WalkthroughTreeNode[]>([]);
  // Arrow + highlight state, set by the currently-speaking
  // narration segment (or empty when not narrating).
  const [narrationArrows, setNarrationArrows] = useState<NarrationArrow[]>([]);
  const [narrationHighlights, setNarrationHighlights] = useState<
    NarrationHighlight[]
  >([]);

  // Mirror tree into a ref so closures inside narrateAndAdvance can
  // read fresh tree.punish without forcing the useCallback to
  // re-create on every tree update (which would invalidate other
  // hooks that depend on narrateAndAdvance identity).
  const treeRef = useRef<WalkthroughTree | null>(null);
  treeRef.current = tree;

  // ─── Stage 2-5 state (post-walkthrough pedagogy) ───────────
  const [activeStage, setActiveStage] = useState<StageKind | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [quizSelected, setQuizSelected] = useState<number | null>(null);
  const [quizShowingFeedback, setQuizShowingFeedback] = useState(false);
  const [drillMoveIndex, setDrillMoveIndex] = useState(0);
  const [drillFen, setDrillFen] = useState(STARTING_FEN);
  const [drillWrongMove, setDrillWrongMove] = useState<
    { tried: string; expected: string } | null
  >(null);
  const [drillComplete, setDrillComplete] = useState(false);

  // ─── Inline trap-prompt state (offered at fork nodes) ────────
  // When the walkthrough reaches a fork whose pathSans matches one
  // or more punish-lesson setupMoves exactly, we queue those
  // lessons and narrate the first one's intro before showing the
  // fork picker. The user accepts (animates the trap detour, then
  // either chains to the next queued trap or proceeds to the fork
  // picker) or skips (advances to the next queued trap, then to
  // the fork picker).
  const [trapQueue, setTrapQueue] = useState<PunishLesson[]>([]);
  const [trapIndex, setTrapIndex] = useState(0);
  const [trapFen, setTrapFen] = useState<string | null>(null);

  // When inside a punish-walkthrough sub-flow, this holds the
  // ORIGINAL opening tree so we can return to it when the lesson
  // ends. Non-null = we're inside a punish walkthrough.
  const [parentOpeningTree, setParentOpeningTree] =
    useState<WalkthroughTree | null>(null);

  // Active narration cancel + backup timer refs.
  const cancelNarrationRef = useRef<(() => void) | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When transitionAfter detects a matching punish-lesson trap, the
  // original "what would happen next" (linear advance / fork picker /
  // leaf) gets stashed here so acceptTrap / skipTrap can resume the
  // walkthrough flow once the trap line finishes. Without this, every
  // trap-completed node fell through to setPhase('fork') even if the
  // node was a linear advance — interrupting the walkthrough mid-line.
  const deferredTransitionRef = useRef<(() => void) | null>(null);

  const cleanupNarration = useCallback((): void => {
    if (cancelNarrationRef.current) {
      cancelNarrationRef.current();
      cancelNarrationRef.current = null;
    }
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    voiceService.stop();
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      cleanupNarration();
    };
  }, [cleanupNarration]);

  // Mark walkthrough stage complete when student reaches a leaf.
  // Fires once per leaf-arrival; the markStageComplete service is
  // idempotent so re-marks are harmless.
  useEffect(() => {
    if (phase === 'leaf' && tree?.openingName) {
      void markStageComplete(tree.openingName, 'walkthrough');
    }
  }, [phase, tree]);

  const currentNode = pathNodes.length > 0 ? pathNodes[pathNodes.length - 1] : null;
  const pathSans = useMemo(
    () => pathNodes.filter((n) => n.san !== null).map((n) => n.san as string),
    [pathNodes],
  );
  const fen = useMemo(
    () => {
      // When in a quiz stage with a question that specifies a path,
      // the board should show THAT position — not where the
      // walkthrough left off. Production audit (build c95ccc9) caught
      // the find-the-move stage rendering with the walkthrough's
      // last-move FEN (move 8 in Pirc), making the question
      // "White to play" against a position 8 moves deep — wrong board.
      if (activeStage === 'findMove') {
        const q = tree?.findMove?.[stageIndex];
        if (q && q.path && q.path.length > 0) {
          return fenForPath(q.path, tree?.startFen);
        }
        if (q) return tree?.startFen ?? STARTING_FEN;
      }
      if (activeStage === 'concepts') {
        const q = tree?.concepts?.[stageIndex];
        if (q && q.path && q.path.length > 0) {
          return fenForPath(q.path, tree?.startFen);
        }
        // Concepts often lack a path; fall back to start position
        // rather than leaving the walkthrough's leaf FEN visible.
        if (q) return tree?.startFen ?? STARTING_FEN;
      }
      return fenForPath(pathSans, tree?.startFen);
    },
    [pathSans, tree?.startFen, tree?.findMove, tree?.concepts, activeStage, stageIndex],
  );
  const isLeaf = currentNode !== null && currentNode.children.length === 0;
  const forkOptions =
    currentNode !== null && currentNode.children.length > 1 ? currentNode.children : [];
  const canBacktrack = findLastForkIndex(pathNodes) >= 0;
  const leafOutro = useMemo(() => {
    if (!isLeaf || !tree) return null;
    const key = pathSans.join(' ');
    return tree.leafOutros?.[key] ?? tree.outro;
  }, [isLeaf, tree, pathSans]);

  /** Speak the given node's idea, then transition based on its
   *  children. Linear → push child onto path + recurse. Fork → set
   *  phase to 'fork'. Leaf → set phase to 'leaf'.
   *
   *  Two narration paths:
   *    1. `node.narration` (segmented) — speaks each segment in
   *       sequence, setting arrows/highlights to that segment's
   *       values BEFORE speaking. Awaitable promise from the voice
   *       service drives sequential speech; arrows fire AS the
   *       coach mentions the move (the user's "real-time arrows
   *       in time with narration" requirement).
   *    2. `node.idea` (single block) — fallback when `narration` is
   *       omitted. No arrows. Same backup-timer pattern as before. */
  const narrateAndAdvance = useCallback(
    (path: WalkthroughTreeNode[]): void => {
      cleanupNarration();
      const node = path[path.length - 1];
      setPhase('narrating');
      setPathNodes(path);
      // Clear arrows from any prior node — fresh canvas for this one.
      setNarrationArrows([]);
      setNarrationHighlights([]);

      // Common transition logic — runs after the narration finishes
      // (segmented OR single-block). Linear → recurse to next node;
      // fork → check for matching trap lessons first (offer trap
      // prompt before the fork picker if any), else show fork picker;
      // leaf → set phase 'leaf'.
      const transitionAfter = (): void => {
        cancelNarrationRef.current = null;
        if (advanceTimerRef.current) {
          clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = null;
        }

        // Default transition (no traps) — what we'd do without
        // trap-prompt interception. Captured here so the trap-flow
        // can defer to it after the user skips/finishes the trap.
        const defaultTransition = (): void => {
          if (node.children.length === 0) {
            setPhase('leaf');
          } else if (node.children.length === 1) {
            advanceTimerRef.current = setTimeout(() => {
              advanceTimerRef.current = null;
              narrateAndAdvance([...path, node.children[0].node]);
            }, POST_NARRATION_BUFFER_MS);
          } else {
            setPhase('fork');
          }
        };

        // Check for trap lessons matching THIS position (after the
        // current node's move was just played). Match condition:
        // lesson.setupMoves === current path SANs exactly (the next
        // move WOULD BE the inaccuracy from this position).
        //
        // Production audit (build 12d9ff3) caught the Vienna's
        // 4 punish lessons sitting at [e4 e5 Nc3 Nf6 f4 exf4 e5] —
        // but that position is a LINEAR ADVANCE in the tree (single
        // child Ng8), so the trap-prompt skipped right past it.
        // Trap detection now runs at every transition (linear AND
        // fork AND leaf), then defers to the default transition
        // when the trap-flow ends.
        const sansSoFar = path
          .filter((n) => n.san !== null)
          .map((n) => n.san as string);
        const allPunish = treeRef.current?.punish ?? [];
        const matches = findMatchingTraps(sansSoFar, allPunish);
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'useTeachWalkthrough.transitionAfter',
          summary: `pos@[${sansSoFar.join(' ')}] (children=${node.children.length}) — ${matches.length}/${allPunish.length} punish lesson(s) match`,
          details:
            allPunish.length === 0
              ? 'tree has no punish lessons'
              : allPunish
                  .slice(0, 5)
                  .map(
                    (p) =>
                      `[${p.setupMoves.join(' ')}] inaccuracy=${p.inaccuracy}`,
                  )
                  .join('\n'),
        });
        if (matches.length > 0) {
          // Park the default transition so the trap-flow can run it
          // after the user is done. acceptTrap / skipTrap pop the
          // queue and call this when no traps remain.
          deferredTransitionRef.current = defaultTransition;
          setTrapQueue(matches);
          setTrapIndex(0);
          const first = matches[0];
          const intro = `Hold on — a common mistake here is ${first.inaccuracy}. ${first.whyBad} Want to see it now, or keep going with the walkthrough?`;
          const shortIntro = first.shortWhyBad
            ? `Watch out — ${first.inaccuracy} is a mistake. ${first.shortWhyBad}`
            : undefined;
          void speakWalkthroughText(intro, shortIntro).catch(() => undefined);
          setPhase('trap-prompt');
          return;
        }
        defaultTransition();
      };

      // ── Path 1: segmented narration with arrows ──────────────
      if (node.narration && node.narration.length > 0) {
        const segments = node.narration;
        // Use a ref-shaped object so cancellation crosses the
        // for-loop, the timeout, and the cancelNarrationRef closure
        // without ESLint thinking the boolean is invariant.
        const ctrl = { cancelled: false };
        cancelNarrationRef.current = (): void => {
          ctrl.cancelled = true;
          if (advanceTimerRef.current) {
            clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = null;
          }
        };
        // Backup timer covers the WHOLE node — sum of all segment
        // budgets — so a hung TTS layer can't strand us mid-node.
        const totalText = segments.map((s) => s.text).join(' ');
        const backupMs = clampBackupMs(totalText);
        advanceTimerRef.current = setTimeout(() => {
          if (ctrl.cancelled) return;
          ctrl.cancelled = true;
          transitionAfter();
        }, backupMs);

        void (async () => {
          for (const segment of segments) {
            if (ctrl.cancelled) return;
            // Set arrows + highlights BEFORE speaking the segment so
            // the visual lands at the same moment Polly starts saying
            // the words. (Segment without `arrows` clears them; segment
            // with empty array clears them too.)
            setNarrationArrows(segment.arrows ?? []);
            setNarrationHighlights(segment.highlights ?? []);
            try {
              await speakWalkthroughText(segment.text, segment.shortText);
            } catch {
              // Voice errored — keep going so the narration arc
              // completes; backup timer is a safety net.
            }
          }
          if (ctrl.cancelled) return;
          // Clear arrows once the node finishes — next node sets
          // fresh arrows on its first segment.
          setNarrationArrows([]);
          setNarrationHighlights([]);
          transitionAfter();
        })();
        return;
      }

      // ── Path 2: single-block narration on `idea` ─────────────
      const idea = node.idea.trim();
      if (!idea) {
        // Root node — no narration, just transition based on children.
        if (node.children.length === 1) {
          narrateAndAdvance([...path, node.children[0].node]);
        } else if (node.children.length > 1) {
          setPhase('fork');
        } else {
          setPhase('leaf');
        }
        return;
      }

      // Voice + backup timer + post-narration buffer, then transition.
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        transitionAfter();
      };

      cancelNarrationRef.current = (): void => {
        // Caller-side cancel: don't transition; let caller manage phase.
        settled = true;
        if (advanceTimerRef.current) {
          clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = null;
        }
      };

      // Backup safety timer.
      const backupMs = clampBackupMs(idea);
      const backupTimer = setTimeout(() => {
        if (settled) return;
        settle();
      }, backupMs);
      advanceTimerRef.current = backupTimer;

      // Primary gate: voice completion.
      speakWalkthroughText(idea, node.shortIdea)
        .then(() => {
          if (settled) return;
          settle();
        })
        .catch(() => {
          // Voice errored — backup timer will catch it.
        });
    },
    [cleanupNarration],
  );

  const start = useCallback(
    (
      newTree: WalkthroughTree,
      options?: { showChooser?: boolean },
    ): void => {
      // Returning visitor flow: if the page passed showChooser=true
      // (because completion data shows the walkthrough was already
      // done on this opening), land in the chooser phase instead of
      // auto-playing the walkthrough. The student picks "Walk through
      // again" or "Pick what to learn" with explicit tap targets.
      // First-time visits skip this entirely.
      if (options?.showChooser) {
        cleanupNarration();
        setTree(newTree);
        setPathNodes([]);
        setNarrationArrows([]);
        setNarrationHighlights([]);
        setPhase('choose-mode');
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'useTeachWalkthrough.start',
          summary: `chooser shown for "${newTree.openingName}" (previously completed)`,
        });
        return;
      }
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'useTeachWalkthrough.start',
        summary: `walkthrough started: ${newTree.openingName}`,
      });
      cleanupNarration();
      setTree(newTree);
      // Speak the intro first if it exists, then start the tree at root.
      if (newTree.intro.trim()) {
        // Treat the intro as a virtual narration: play it before the
        // tree's first move. We fake this by speaking it then
        // transitioning into narrateAndAdvance starting at the root.
        setPathNodes([newTree.root]);
        setPhase('narrating');
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          cancelNarrationRef.current = null;
          if (advanceTimerRef.current) {
            clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = null;
          }
          // After intro: walk into the root's children.
          if (newTree.root.children.length === 1) {
            narrateAndAdvance([newTree.root, newTree.root.children[0].node]);
          } else if (newTree.root.children.length > 1) {
            setPhase('fork');
          } else {
            setPhase('leaf');
          }
        };
        cancelNarrationRef.current = (): void => {
          settled = true;
          if (advanceTimerRef.current) {
            clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = null;
          }
        };
        const backupMs = clampBackupMs(newTree.intro);
        advanceTimerRef.current = setTimeout(() => {
          if (settled) return;
          settle();
        }, backupMs);
        speakWalkthroughText(newTree.intro, newTree.shortIntro)
          .then(() => {
            if (settled) return;
            // Add the post-narration buffer.
            advanceTimerRef.current = setTimeout(() => {
              advanceTimerRef.current = null;
              settle();
            }, POST_NARRATION_BUFFER_MS);
          })
          .catch(() => {
            // Voice errored — backup timer will catch it.
          });
      } else {
        // No intro — jump straight to the root's first child.
        narrateAndAdvance([newTree.root]);
      }
    },
    [cleanupNarration, narrateAndAdvance],
  );

  const pause = useCallback((): void => {
    cleanupNarration();
    setPhase('paused');
  }, [cleanupNarration]);

  const resume = useCallback((): void => {
    if (phase !== 'paused' || pathNodes.length === 0) return;
    // Re-narrate from the current node.
    narrateAndAdvance(pathNodes);
  }, [phase, pathNodes, narrateAndAdvance]);

  const pickFork = useCallback(
    (childIndex: number): void => {
      if (pathNodes.length === 0) return;
      const node = pathNodes[pathNodes.length - 1];
      if (node.children.length <= 1) return;
      if (childIndex < 0 || childIndex >= node.children.length) return;
      const choice = node.children[childIndex];
      void logAppAudit({
        kind: 'coach-tool-callback-rejected',
        category: 'subsystem',
        source: 'useTeachWalkthrough.pickFork',
        // Reusing this kind opportunistically — there's no
        // dedicated walkthrough-fork-picked audit yet. The summary
        // distinguishes it.
        summary: `walkthrough fork picked: ${choice.label ?? '(unlabeled)'}`,
      });
      narrateAndAdvance([...pathNodes, choice.node]);
    },
    [pathNodes, narrateAndAdvance],
  );

  const backtrackToLastFork = useCallback((): void => {
    const idx = findLastForkIndex(pathNodes);
    if (idx < 0) return;
    cleanupNarration();
    setPathNodes(pathNodes.slice(0, idx + 1));
    setPhase('fork');
  }, [pathNodes, cleanupNarration]);

  // Move to the next queued trap (if any) or fall through to the
  // fork picker. Used by both skipTrap and the post-acceptTrap
  // continuation. Pulled out so both share the same logic.
  const advancePastTrap = useCallback((): void => {
    setTrapIndex((prev) => {
      const next = prev + 1;
      const queue = trapQueue;
      if (next < queue.length) {
        const lesson = queue[next];
        const intro = `Another common mistake here is ${lesson.inaccuracy}. ${lesson.whyBad} Want to see this one too?`;
        const shortIntro = lesson.shortWhyBad
          ? `Also watch out — ${lesson.inaccuracy}. ${lesson.shortWhyBad}`
          : undefined;
        void speakWalkthroughText(intro, shortIntro).catch(() => undefined);
        setPhase('trap-prompt');
        return next;
      }
      // No more traps queued — resume the walkthrough's intended
      // transition for the node where the traps fired (linear advance
      // / fork picker / leaf). transitionAfter stashed this in the
      // ref before kicking off the trap-flow.
      setTrapQueue([]);
      setTrapFen(null);
      const deferred = deferredTransitionRef.current;
      deferredTransitionRef.current = null;
      if (deferred) {
        deferred();
      } else {
        // Fallback when no deferred transition was captured (legacy
        // entry point or edge case) — old behavior of jumping to fork.
        setPhase('fork');
      }
      return 0;
    });
  }, [trapQueue]);

  const skipTrap = useCallback((): void => {
    voiceService.stop();
    advancePastTrap();
  }, [advancePastTrap]);

  const acceptTrap = useCallback((): void => {
    if (trapQueue.length === 0) return;
    const lesson = trapQueue[trapIndex];
    if (!lesson) {
      setPhase('fork');
      return;
    }
    voiceService.stop();
    setPhase('trap-playing');
    // Animate the bad-move → punishment → followup sequence on the
    // board via trapFen overrides. Each step waits for the voice
    // promise to resolve before the next animates, so narration
    // and animation stay in sync. After the sequence, snap back
    // (trapFen → null reverts the board to fenForPath(pathSans))
    // and either prompt the next queued trap or show fork picker.
    void (async (): Promise<void> => {
      try {
        const startFen = fenForPath(
          lesson.setupMoves,
          treeRef.current?.startFen,
        );
        const c = new Chess(startFen);
        const speakAndWait = async (text: string, shortText?: string): Promise<void> => {
          if (!text.trim()) return;
          try {
            await speakWalkthroughText(text, shortText);
          } catch {
            // Voice errors don't block the animation arc.
          }
        };
        // 1. Inaccuracy.
        try {
          c.move(lesson.inaccuracy);
        } catch {
          // Repair should have caught this, but bail safely if not.
          setTrapFen(null);
          setPhase('fork');
          return;
        }
        setTrapFen(c.fen());
        await speakAndWait(
          `${lesson.inaccuracy} — ${lesson.whyBad}`,
          lesson.shortWhyBad ? `${lesson.inaccuracy} — ${lesson.shortWhyBad}` : undefined,
        );
        // 2. Punishment.
        try {
          c.move(lesson.punishment);
        } catch {
          setTrapFen(null);
          advancePastTrap();
          return;
        }
        setTrapFen(c.fen());
        await speakAndWait(
          `${lesson.punishment} — ${lesson.whyPunish}`,
          lesson.shortWhyPunish ? `${lesson.punishment} — ${lesson.shortWhyPunish}` : undefined,
        );
        // 3. Followup (optional).
        if (lesson.followup && lesson.followup.length > 0) {
          for (const fm of lesson.followup) {
            try {
              c.move(fm.san);
            } catch {
              break;
            }
            setTrapFen(c.fen());
            await speakAndWait(
              `${fm.san} — ${fm.idea}`,
              fm.shortIdea ? `${fm.san} — ${fm.shortIdea}` : undefined,
            );
          }
        }
        // 4. Snap back; advance to next queued trap or fork picker.
        setTrapFen(null);
        advancePastTrap();
      } catch {
        setTrapFen(null);
        setPhase('fork');
      }
    })();
  }, [trapQueue, trapIndex, advancePastTrap]);

  const stop = useCallback((): void => {
    cleanupNarration();
    setTree(null);
    setPathNodes([]);
    setPhase('idle');
    setNarrationArrows([]);
    setNarrationHighlights([]);
    setTrapQueue([]);
    setTrapIndex(0);
    setTrapFen(null);
    deferredTransitionRef.current = null;
  }, [cleanupNarration]);

  const skipNarration = useCallback((): void => {
    if (phase !== 'narrating') return;
    if (cancelNarrationRef.current) {
      cancelNarrationRef.current();
      cancelNarrationRef.current = null;
    }
    voiceService.stop();
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    // Manually transition based on current node's children.
    if (pathNodes.length === 0) return;
    const node = pathNodes[pathNodes.length - 1];
    if (node.children.length === 0) {
      setPhase('leaf');
    } else if (node.children.length === 1) {
      narrateAndAdvance([...pathNodes, node.children[0].node]);
    } else {
      setPhase('fork');
    }
  }, [phase, pathNodes, narrateAndAdvance]);

  // ─── Stage 2-5 methods ─────────────────────────────────────
  const resetStageState = useCallback((): void => {
    setActiveStage(null);
    setStageIndex(0);
    setQuizSelected(null);
    setQuizShowingFeedback(false);
    setDrillMoveIndex(0);
    setDrillFen(STARTING_FEN);
    setDrillWrongMove(null);
    setDrillComplete(false);
  }, []);

  /** Pull the latest version of the current opening from Dexie cache
   *  and merge in any optional stages (concepts / findMove / drill /
   *  punish) that have been background-generated since the tree was
   *  first loaded. The walkthrough state (pathNodes, phase, etc.)
   *  stays unchanged — only the optional arrays update. Called when
   *  the student opens the stage menu so background-completed stages
   *  appear as cards if they finished while the walkthrough played. */
  const mergeStagesFromCache = useCallback(async (): Promise<void> => {
    if (!tree?.openingName) return;
    try {
      const fresh = await getCachedOpening(tree.openingName);
      if (!fresh) return;
      // Only merge if the cache has data we don't.
      const haveConcepts = (tree.concepts?.length ?? 0) > 0;
      const haveFindMove = (tree.findMove?.length ?? 0) > 0;
      const haveDrill = (tree.drill?.length ?? 0) > 0;
      const havePunish = (tree.punish?.length ?? 0) > 0;
      const cacheConcepts = (fresh.concepts?.length ?? 0) > 0;
      const cacheFindMove = (fresh.findMove?.length ?? 0) > 0;
      const cacheDrill = (fresh.drill?.length ?? 0) > 0;
      const cachePunish = (fresh.punish?.length ?? 0) > 0;
      if (
        (cacheConcepts && !haveConcepts) ||
        (cacheFindMove && !haveFindMove) ||
        (cacheDrill && !haveDrill) ||
        (cachePunish && !havePunish)
      ) {
        setTree((prev) =>
          prev
            ? {
                ...prev,
                concepts: cacheConcepts ? fresh.concepts : prev.concepts,
                findMove: cacheFindMove ? fresh.findMove : prev.findMove,
                drill: cacheDrill ? fresh.drill : prev.drill,
                punish: cachePunish ? fresh.punish : prev.punish,
              }
            : prev,
        );
      }
    } catch {
      // Cache fetch failures are non-fatal; user just sees what they had.
    }
  }, [tree]);

  const enterStageMenu = useCallback((): void => {
    cleanupNarration();
    resetStageState();
    setPhase('stage-menu');
    // Pick up any background-generated stages that completed while
    // the walkthrough played. Non-blocking; the menu renders with
    // current data immediately and re-renders when the merge resolves.
    void mergeStagesFromCache();
  }, [cleanupNarration, resetStageState, mergeStagesFromCache]);

  /** Skip the walkthrough entirely and load straight into the stage
   *  menu (or a specific stage if autoSelectStage is provided). Used
   *  by the surface routing's stage-keyword detection ("drill Vienna"
   *  / "Vienna punish" / etc.) so a returning student doesn't have
   *  to sit through the walkthrough to access drills/punishes/etc. */
  const startAtStageMenu = useCallback(
    (newTree: WalkthroughTree, autoSelectStage?: StageKind): void => {
      cleanupNarration();
      setTree(newTree);
      setPathNodes([]);
      setNarrationArrows([]);
      setNarrationHighlights([]);
      resetStageState();
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'useTeachWalkthrough.startAtStageMenu',
        summary: `skipped walkthrough; landed at ${autoSelectStage ?? 'stage-menu'} for "${newTree.openingName}"`,
      });
      if (autoSelectStage) {
        setActiveStage(autoSelectStage);
        setStageIndex(0);
        setQuizSelected(null);
        setQuizShowingFeedback(false);
        setPhase(autoSelectStage === 'drill' ? 'drill' : 'quiz');
      } else {
        setPhase('stage-menu');
        void mergeStagesFromCache();
      }
    },
    [cleanupNarration, resetStageState, mergeStagesFromCache],
  );

  /** Re-run the walkthrough from move 1. Used by the chooser's
   *  "Walk through it again" button. Doesn't re-show the chooser —
   *  forces straight into narrating phase. */
  const restartWalkthrough = useCallback((): void => {
    if (!tree) return;
    // Re-call start without showChooser to force the walkthrough.
    start(tree);
  }, [tree, start]);

  const backToStageMenu = useCallback((): void => {
    cleanupNarration();
    setActiveStage(null);
    setStageIndex(0);
    setQuizSelected(null);
    setQuizShowingFeedback(false);
    setDrillWrongMove(null);
    setDrillComplete(false);
    setPhase('stage-menu');
  }, [cleanupNarration]);

  const startStage = useCallback(
    (stage: StageKind): void => {
      cleanupNarration();
      setActiveStage(stage);
      setStageIndex(0);
      setQuizSelected(null);
      setQuizShowingFeedback(false);
      if (stage === 'drill') {
        // Drill needs a line selection; UI shows the line picker
        // while phase is 'drill' but stageIndex/drillFen are stale
        // until selectDrillLine is called.
        setDrillMoveIndex(0);
        setDrillFen(STARTING_FEN);
        setDrillComplete(false);
        setPhase('drill');
      } else {
        setPhase('quiz');
      }
    },
    [cleanupNarration],
  );

  const selectDrillLine = useCallback(
    (lineIndex: number): void => {
      if (!tree?.drill || lineIndex < 0 || lineIndex >= tree.drill.length) {
        return;
      }
      setStageIndex(lineIndex);
      setDrillMoveIndex(0);
      setDrillFen(STARTING_FEN);
      setDrillWrongMove(null);
      setDrillComplete(false);
    },
    [tree],
  );

  const pickQuizChoice = useCallback((choiceIndex: number): void => {
    setQuizSelected(choiceIndex);
    setQuizShowingFeedback(true);
  }, []);

  const nextQuizQuestion = useCallback((): void => {
    if (!tree || !activeStage) return;
    const arr =
      activeStage === 'concepts' ? tree.concepts
      : activeStage === 'findMove' ? tree.findMove
      : activeStage === 'punish' ? tree.punish
      : null;
    if (!arr) return;
    const next = stageIndex + 1;
    if (next >= arr.length) {
      // Stage complete — record progress, then back to menu.
      if (tree.openingName) {
        void markStageComplete(tree.openingName, activeStage);
      }
      backToStageMenu();
    } else {
      setStageIndex(next);
      setQuizSelected(null);
      setQuizShowingFeedback(false);
    }
  }, [tree, activeStage, stageIndex, backToStageMenu]);

  /** Attempt a Find-the-Move answer via the BOARD instead of tapping
   *  a multiple-choice tile. The student drags a piece on the
   *  rendered position; we look up the candidate whose SAN matches
   *  (case-insensitive after stripping annotation marks) and route
   *  to pickQuizChoice with that candidate's index. Returns the
   *  matched index, or null if no candidate matches. User: "Find
   *  the move should be able to move the piece on the board as
   *  another way to get the right answer." */
  const attemptFindMoveAnswer = useCallback(
    (san: string): { matchedIndex: number | null } => {
      if (!tree?.findMove || phase !== 'quiz' || activeStage !== 'findMove') {
        return { matchedIndex: null };
      }
      if (stageIndex < 0 || stageIndex >= tree.findMove.length) {
        return { matchedIndex: null };
      }
      if (quizSelected !== null) {
        return { matchedIndex: null };
      }
      const q = tree.findMove[stageIndex];
      const norm = stripSanAnnotations(san).toLowerCase();
      const idx = q.candidates.findIndex(
        (c) => stripSanAnnotations(c.san).toLowerCase() === norm,
      );
      if (idx < 0) return { matchedIndex: null };
      setQuizSelected(idx);
      setQuizShowingFeedback(true);
      return { matchedIndex: idx };
    },
    [tree, phase, activeStage, stageIndex, quizSelected],
  );

  /** Attempt a drill move. Returns ok=true on match (advances state),
   *  ok=false on mismatch (sets drillWrongMove for UI feedback). */
  const attemptDrillMove = useCallback(
    (san: string): { ok: boolean } => {
      if (!tree?.drill || phase !== 'drill') return { ok: false };
      if (stageIndex < 0 || stageIndex >= tree.drill.length) {
        return { ok: false };
      }
      const line = tree.drill[stageIndex];
      const studentSide = line.studentSide ?? 'white';
      // Determine which moves in the line are the student's.
      // Even-indexed moves (0, 2, 4...) are white's; odd are black's.
      // If studentSide is 'white', student plays even indices.
      if (drillMoveIndex < 0 || drillMoveIndex >= line.moves.length) {
        return { ok: false };
      }
      const expected = line.moves[drillMoveIndex];

      if (san !== expected) {
        setDrillWrongMove({ tried: san, expected });
        return { ok: false };
      }

      // Correct! Advance the drillFen by playing this move.
      const probe = new Chess(drillFen);
      try {
        probe.move(san);
      } catch {
        return { ok: false };
      }
      let nextFen = probe.fen();
      let nextIndex = drillMoveIndex + 1;

      // If the next move is the OPPONENT's, auto-play it.
      const isStudentMove = (idx: number): boolean => {
        const isWhitesMove = idx % 2 === 0;
        return studentSide === 'white' ? isWhitesMove : !isWhitesMove;
      };

      while (nextIndex < line.moves.length && !isStudentMove(nextIndex)) {
        const opponentSan = line.moves[nextIndex];
        try {
          probe.move(opponentSan);
          nextFen = probe.fen();
          nextIndex += 1;
        } catch {
          break;
        }
      }

      setDrillFen(nextFen);
      setDrillMoveIndex(nextIndex);
      setDrillWrongMove(null);

      if (nextIndex >= line.moves.length) {
        setDrillComplete(true);
        if (tree.openingName) {
          void markStageComplete(tree.openingName, 'drill');
        }
      }

      return { ok: true };
    },
    [tree, phase, stageIndex, drillMoveIndex, drillFen],
  );

  const acknowledgeDrillMistake = useCallback((): void => {
    setDrillWrongMove(null);
  }, []);

  const restartDrill = useCallback((): void => {
    setDrillMoveIndex(0);
    setDrillFen(STARTING_FEN);
    setDrillWrongMove(null);
    setDrillComplete(false);
  }, []);

  /** Start a specific punish lesson as a self-contained walkthrough.
   *  Saves the current (parent) tree, then `start()`s a freshly-built
   *  punish walkthrough tree. The walkthrough plays the setup, the
   *  inaccuracy, and pauses at a fork for the student to pick the
   *  punishment from candidates. After the leaf (whichever path),
   *  the leaf panel offers "Back to lessons" to call exitPunishToMenu. */
  const startPunishLesson = useCallback(
    (lessonIndex: number): void => {
      if (!tree?.punish) return;
      if (lessonIndex < 0 || lessonIndex >= tree.punish.length) return;
      const lesson = tree.punish[lessonIndex];
      const punishTree = buildPunishWalkthroughTree(lesson, tree);
      // Stash the parent so we can return to it on exit.
      setParentOpeningTree(tree);
      // Track which lesson we're on so the "next/prev" UI can advance.
      setStageIndex(lessonIndex);
      // Run the punish tree through the same engine as the opening
      // walkthrough — animations, narration, fork picker, leaf panel.
      start(punishTree);
    },
    [tree, start],
  );

  /** Exit a punish walkthrough back to the stage menu of the parent
   *  opening. Restores the parent tree and resets walkthrough state
   *  so the student lands at the stage menu (with checkmarks
   *  reflecting the latest progress). */
  const exitPunishToMenu = useCallback((): void => {
    const parent = parentOpeningTree;
    if (!parent) {
      // Not inside a punish lesson — fall back to stage-menu transition.
      backToStageMenu();
      return;
    }
    cleanupNarration();
    setParentOpeningTree(null);
    // Restore the parent tree's state. We can't call start() on
    // parent because that would re-narrate the intro; instead, set
    // the tree directly and jump to stage-menu phase.
    setTree(parent);
    setPathNodes([]);
    setNarrationArrows([]);
    setNarrationHighlights([]);
    setActiveStage(null);
    setStageIndex(0);
    setQuizSelected(null);
    setQuizShowingFeedback(false);
    setPhase('stage-menu');
    // Mark punish stage complete on this lesson exit. (This means
    // completing ANY punish lesson marks the stage done; if you want
    // "complete all" instead, change this to count lessons answered.)
    if (parent.openingName) {
      void markStageComplete(parent.openingName, 'punish');
    }
  }, [parentOpeningTree, backToStageMenu, cleanupNarration]);

  return {
    phase,
    isActive: phase !== 'idle',
    tree,
    currentNode,
    fen,
    forkOptions,
    isLeaf,
    canBacktrack,
    pathSans,
    leafOutro,
    narrationArrows,
    narrationHighlights,
    activeStage,
    stageIndex,
    quizSelected,
    quizShowingFeedback,
    drillMoveIndex,
    drillFen,
    drillWrongMove,
    drillComplete,
    start,
    pause,
    resume,
    pickFork,
    backtrackToLastFork,
    stop,
    skipNarration,
    enterStageMenu,
    startAtStageMenu,
    restartWalkthrough,
    startStage,
    selectDrillLine,
    pickQuizChoice,
    nextQuizQuestion,
    attemptDrillMove,
    attemptFindMoveAnswer,
    acknowledgeDrillMistake,
    restartDrill,
    backToStageMenu,
    startPunishLesson,
    exitPunishToMenu,
    isInPunishLesson: parentOpeningTree !== null,
    mergeStagesFromCache,
    pendingTrap: trapQueue[trapIndex] ?? null,
    trapFen,
    trapsQueuedAfter: Math.max(0, trapQueue.length - trapIndex - 1),
    acceptTrap,
    skipTrap,
  };
}
