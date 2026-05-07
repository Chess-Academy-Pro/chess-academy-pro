/**
 * Tests for the auto-repair logic in openingGenerator. The full
 * generator path (LLM call → parse → validate → cache) is integration-
 * level and not covered here; this file locks in the surgical helpers
 * that are pure functions of the parsed tree.
 */
import { describe, it, expect } from 'vitest';
import {
  repairForkLabels,
  repairConceptsStage,
  repairFindMoveStage,
  repairDrillStage,
  repairPunishStage,
  assertTreeShape,
} from './openingGenerator';
import type {
  WalkthroughTree,
  ConceptCheckQuestion,
  FindMoveQuestion,
  DrillLine,
  PunishLesson,
} from '../types/walkthroughTree';

function makeTree(rootChildren: WalkthroughTree['root']['children']): WalkthroughTree {
  return {
    openingName: 'Test',
    eco: 'X00',
    intro: 'i',
    outro: 'o',
    root: {
      san: null,
      movedBy: null,
      idea: '',
      children: rootChildren,
    },
  };
}

describe('repairForkLabels', () => {
  it('fills missing label + forkSubtitle on a 2-child fork', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          children: [
            {
              node: {
                san: 'e5',
                movedBy: 'black',
                idea: 'classical reply. Mirrors the king pawn.',
                children: [],
              },
            },
            {
              node: {
                san: 'c5',
                movedBy: 'black',
                idea: 'Sicilian. Asymmetric counter.',
                children: [],
              },
            },
          ],
        },
      },
    ]);

    const filled = repairForkLabels(tree);

    expect(filled).toBe(4);
    const forkChildren = tree.root.children[0].node.children;
    expect(forkChildren[0].label).toBe('e5');
    expect(forkChildren[0].forkSubtitle).toBe('classical reply.');
    expect(forkChildren[1].label).toBe('c5');
    expect(forkChildren[1].forkSubtitle).toBe('Sicilian.');
  });

  it('leaves existing labels untouched', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          children: [
            {
              label: 'Open',
              forkSubtitle: 'symmetric',
              node: {
                san: 'e5',
                movedBy: 'black',
                idea: '...',
                children: [],
              },
            },
            {
              node: {
                san: 'c5',
                movedBy: 'black',
                idea: 'Sicilian.',
                children: [],
              },
            },
          ],
        },
      },
    ]);

    const filled = repairForkLabels(tree);

    expect(filled).toBe(2);
    const forkChildren = tree.root.children[0].node.children;
    expect(forkChildren[0].label).toBe('Open');
    expect(forkChildren[0].forkSubtitle).toBe('symmetric');
    expect(forkChildren[1].label).toBe('c5');
  });

  it('does not touch single-child (linear) sequences', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          children: [
            {
              node: {
                san: 'e5',
                movedBy: 'black',
                idea: '...',
                children: [],
              },
            },
          ],
        },
      },
    ]);

    const filled = repairForkLabels(tree);

    expect(filled).toBe(0);
  });

  it('caps long subtitles to 80 chars with ellipsis', () => {
    const longIdea = 'A'.repeat(200) + '. tail';
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          children: [
            {
              node: { san: 'e5', movedBy: 'black', idea: longIdea, children: [] },
            },
            {
              node: { san: 'c5', movedBy: 'black', idea: 'short.', children: [] },
            },
          ],
        },
      },
    ]);

    repairForkLabels(tree);
    const subtitle = tree.root.children[0].node.children[0].forkSubtitle ?? '';
    expect(subtitle.length).toBe(80);
    expect(subtitle.endsWith('…')).toBe(true);
  });
});

describe('repairConceptsStage', () => {
  it('promotes single-select with 2+ correct to multiSelect', () => {
    const data: ConceptCheckQuestion[] = [
      {
        prompt: 'Q?',
        choices: [
          { text: 'a', correct: true, explanation: '' },
          { text: 'b', correct: true, explanation: '' },
          { text: 'c', correct: false, explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairConceptsStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].multiSelect).toBe(true);
    expect(report.fixed).toBe(1);
    expect(report.dropped).toBe(0);
  });

  it('drops questions with no correct choice', () => {
    const data: ConceptCheckQuestion[] = [
      {
        prompt: 'Q?',
        choices: [
          { text: 'a', correct: false, explanation: '' },
          { text: 'b', correct: false, explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairConceptsStage(data);
    expect(kept.length).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('strips illegal path but keeps the question', () => {
    const data: ConceptCheckQuestion[] = [
      {
        prompt: 'Q?',
        path: ['e4', 'Bg7'], // illegal: bishop locked behind g-pawn
        choices: [
          { text: 'a', correct: true, explanation: '' },
          { text: 'b', correct: false, explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairConceptsStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].path).toEqual([]);
    expect(report.fixed).toBe(1);
  });
});

describe('repairFindMoveStage', () => {
  it('drops illegal candidates and keeps the question if 2+ remain', () => {
    const data: FindMoveQuestion[] = [
      {
        path: ['e4', 'e5'],
        prompt: 'White to move.',
        candidates: [
          { san: 'Nf3', label: '', correct: true, explanation: '' },
          { san: 'Nc3', label: '', correct: false, explanation: '' },
          { san: 'Bg2', label: '', correct: false, explanation: '' }, // illegal
        ],
      },
    ];
    const { kept, report } = repairFindMoveStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].candidates.length).toBe(2);
    expect(kept[0].candidates.every((c) => c.san !== 'Bg2')).toBe(true);
    expect(report.fixed).toBe(1);
  });

  it('drops question if illegal path', () => {
    const data: FindMoveQuestion[] = [
      {
        path: ['e4', 'Bg7'],
        prompt: 'Q',
        candidates: [
          { san: 'Nf3', label: '', correct: true, explanation: '' },
          { san: 'Nc3', label: '', correct: false, explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairFindMoveStage(data);
    expect(kept.length).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('keeps only first correct when multiple are marked correct', () => {
    const data: FindMoveQuestion[] = [
      {
        path: [],
        prompt: 'Q',
        candidates: [
          { san: 'e4', label: '', correct: true, explanation: '' },
          { san: 'd4', label: '', correct: true, explanation: '' },
          { san: 'Nf3', label: '', correct: false, explanation: '' },
        ],
      },
    ];
    const { kept } = repairFindMoveStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].candidates.filter((c) => c.correct).length).toBe(1);
    expect(kept[0].candidates[0].correct).toBe(true);
    expect(kept[0].candidates[1].correct).toBe(false);
  });
});

describe('repairDrillStage', () => {
  it('keeps fully legal lines unchanged', () => {
    const data: DrillLine[] = [
      { name: 'A', moves: ['e4', 'e5', 'Nf3', 'Nc6'] },
    ];
    const { kept, report } = repairDrillStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(report.fixed).toBe(0);
  });

  it('truncates illegal-tail when legal prefix has 4+ moves', () => {
    const data: DrillLine[] = [
      { name: 'A', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bg7' /* illegal */] },
    ];
    const { kept, report } = repairDrillStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(report.fixed).toBe(1);
  });

  it('drops lines that are too short before becoming illegal', () => {
    const data: DrillLine[] = [
      { name: 'A', moves: ['e4', 'Bg7' /* illegal at ply 2 */] },
    ];
    const { kept, report } = repairDrillStage(data);
    expect(kept.length).toBe(0);
    expect(report.dropped).toBe(1);
  });
});

describe('repairPunishStage', () => {
  it('keeps a fully legal lesson', () => {
    const data: PunishLesson[] = [
      {
        name: 'A',
        setupMoves: ['e4', 'e5', 'Nf3'],
        inaccuracy: 'f6',
        whyBad: '',
        punishment: 'Nxe5',
        whyPunish: '',
        distractors: [
          { san: 'Nc3', label: '', explanation: '' },
          { san: 'd4', label: '', explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairPunishStage(data);
    expect(kept.length).toBe(1);
    expect(report.fixed).toBe(0);
    expect(report.dropped).toBe(0);
  });

  it('drops only the bad distractor, keeps the lesson', () => {
    const data: PunishLesson[] = [
      {
        name: 'A',
        setupMoves: ['e4', 'e5', 'Nf3'],
        inaccuracy: 'f6',
        whyBad: '',
        punishment: 'Nxe5',
        whyPunish: '',
        distractors: [
          { san: 'Nc3', label: '', explanation: '' },
          { san: 'd4', label: '', explanation: '' },
          { san: 'Bg7', label: '', explanation: '' }, // illegal
        ],
      },
    ];
    const { kept, report } = repairPunishStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].distractors.length).toBe(2);
    expect(report.fixed).toBe(1);
  });

  it('drops the lesson when inaccuracy is illegal', () => {
    const data: PunishLesson[] = [
      {
        name: 'A',
        setupMoves: ['e4', 'e5'],
        inaccuracy: 'Bg7', // illegal
        whyBad: '',
        punishment: 'Nf3',
        whyPunish: '',
        distractors: [
          { san: 'd4', label: '', explanation: '' },
          { san: 'Nc3', label: '', explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairPunishStage(data);
    expect(kept.length).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('drops the lesson when 0 valid distractors remain', () => {
    const data: PunishLesson[] = [
      {
        name: 'A',
        setupMoves: ['e4', 'e5', 'Nf3'],
        inaccuracy: 'f6',
        whyBad: '',
        punishment: 'Nxe5',
        whyPunish: '',
        distractors: [
          { san: 'Bg7', label: '', explanation: '' }, // all illegal
          { san: 'Bb7', label: '', explanation: '' },
        ],
      },
    ];
    const { kept, report } = repairPunishStage(data);
    expect(kept.length).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('truncates followup at the first illegal move', () => {
    const data: PunishLesson[] = [
      {
        name: 'A',
        setupMoves: ['e4', 'e5', 'Nf3'],
        inaccuracy: 'f6',
        whyBad: '',
        punishment: 'Nxe5',
        whyPunish: '',
        distractors: [
          { san: 'Nc3', label: '', explanation: '' },
          { san: 'd4', label: '', explanation: '' },
        ],
        followup: [
          { san: 'fxe5', idea: '' },
          { san: 'Qh5+', idea: '' },
          { san: 'Bg7', idea: '' }, // illegal here
          { san: 'Qxh7', idea: '' },
        ],
      },
    ];
    const { kept, report } = repairPunishStage(data);
    expect(kept.length).toBe(1);
    expect(kept[0].followup?.length).toBe(2);
    expect(report.fixed).toBe(1);
  });
});

describe('assertTreeShape', () => {
  function makeShell(rootChildren: unknown): unknown {
    return {
      openingName: 'X',
      eco: 'A00',
      studentSide: 'white',
      intro: '',
      outro: '',
      leafOutros: {},
      root: {
        san: null,
        movedBy: null,
        idea: '',
        children: rootChildren,
      },
    };
  }

  it('passes a well-formed minimal tree', () => {
    const tree = makeShell([
      { node: { san: 'e4', movedBy: 'white', idea: 'center', children: [] } },
    ]);
    expect(() => assertTreeShape(tree as never)).not.toThrow();
  });

  it('treats a node missing children as a leaf (auto-fills empty array)', () => {
    // Production audit (build 998f5c4): "Italian Game: Rousseau Gambit"
    // failed both gen attempts because the deepest LLM-emitted node
    // omitted `children: []`. We now tolerate it as a leaf.
    const tree = makeShell([
      { node: { san: 'e4', movedBy: 'white', idea: 'center' } }, // no children
    ]);
    expect(() => assertTreeShape(tree as never)).not.toThrow();
    const e4 = (tree.root as { children: { node: { children: unknown[] } }[] })
      .children[0].node;
    expect(e4.children).toEqual([]);
  });

  it('throws when children is the wrong type (non-array, non-nullish)', () => {
    const tree = makeShell([
      { node: { san: 'e4', movedBy: 'white', idea: 'center', children: 'oops' } },
    ]);
    expect(() => assertTreeShape(tree as never)).toThrow(/children.*not an array/);
  });

  it('throws when a child wrapper is missing .node', () => {
    const tree = makeShell([{}]);
    expect(() => assertTreeShape(tree as never)).toThrow(/missing \.node/);
  });

  it('throws when root is missing', () => {
    const tree = { openingName: 'X' };
    expect(() => assertTreeShape(tree as never)).toThrow(/root missing/);
  });

  it('reports the path to a broken node', () => {
    const tree = makeShell([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '',
          children: [
            { node: { san: 'e5', movedBy: 'black', idea: '', children: 'bad' } },
          ],
        },
      },
    ]);
    expect(() => assertTreeShape(tree as never)).toThrow(/e4.*e5/);
  });
});
