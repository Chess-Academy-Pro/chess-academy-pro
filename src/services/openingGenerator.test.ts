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
  repairLeafOutros,
  repairTreeIllegalSubtrees,
  repairTreeContent,
  assertTreeShape,
  repairNarrationArrows,
  stripMoveRecitationLeadIn,
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

describe('repairLeafOutros', () => {
  it('drops keys that do not match any leaf path; keeps matching ones', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '',
          children: [
            { node: { san: 'e5', movedBy: 'black', idea: '', children: [] } },
          ],
        },
      },
    ]);
    tree.leafOutros = {
      'e4 e5': 'real leaf',
      'e4 e5 Nf3 Nc6': 'orphan — these moves never appear in the tree',
    };
    const dropped = repairLeafOutros(tree);
    expect(dropped).toBe(1);
    expect(tree.leafOutros).toEqual({ 'e4 e5': 'real leaf' });
  });

  it('returns 0 when leafOutros is undefined', () => {
    const tree = makeTree([]);
    expect(repairLeafOutros(tree)).toBe(0);
  });
});

describe('repairTreeIllegalSubtrees', () => {
  it('prunes a child whose root SAN is illegal at the parent FEN', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '',
          children: [
            { node: { san: 'e5', movedBy: 'black', idea: '', children: [] } },
            // Bg7 is illegal at the position after 1.e4 — bishop is
            // locked behind the g7 pawn — should be pruned.
            { node: { san: 'Bg7', movedBy: 'black', idea: '', children: [] } },
          ],
        },
      },
    ]);
    const pruned = repairTreeIllegalSubtrees(tree);
    expect(pruned).toBe(1);
    expect(tree.root.children[0].node.children).toHaveLength(1);
    expect(tree.root.children[0].node.children[0].node.san).toBe('e5');
  });

  it('prunes deep illegal SAN, keeps the legal ancestor branch', () => {
    // After 1.e4 e5 2.Nf3, the LLM emits an illegal Be6 that should be
    // dropped while the rest of the line survives.
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '',
          children: [
            {
              node: {
                san: 'e5',
                movedBy: 'black',
                idea: '',
                children: [
                  {
                    node: {
                      san: 'Nf3',
                      movedBy: 'white',
                      idea: '',
                      children: [
                        // Be6 illegal — black has no bishop that can reach
                        // e6 from the starting position with this prefix.
                        { node: { san: 'Be6', movedBy: 'black', idea: '', children: [] } },
                        { node: { san: 'Nc6', movedBy: 'black', idea: '', children: [] } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const pruned = repairTreeIllegalSubtrees(tree);
    expect(pruned).toBe(1);
    const nf3 = tree.root.children[0].node.children[0].node.children[0].node;
    expect(nf3.children).toHaveLength(1);
    expect(nf3.children[0].node.san).toBe('Nc6');
  });

  it('returns 0 for a fully-legal tree', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '',
          children: [
            { node: { san: 'e5', movedBy: 'black', idea: '', children: [] } },
          ],
        },
      },
    ]);
    expect(repairTreeIllegalSubtrees(tree)).toBe(0);
  });
});

describe('repairTreeContent', () => {
  it('fills empty ideas with a sentence-form template containing the SAN', () => {
    const tree = makeTree([
      { node: { san: 'e4', movedBy: 'white', idea: '', children: [] } },
    ]);
    const r = repairTreeContent(tree, 'Test Opening');
    expect(r.ideasFilled).toBe(1);
    // Template is sentence-form, contains the SAN, and is not just the bare SAN.
    expect(tree.root.children[0].node.idea).toContain('e4');
    expect(tree.root.children[0].node.idea.length).toBeGreaterThan(2);
  });

  it('fills empty tree-level fields with fallbacks', () => {
    const tree = makeTree([]);
    tree.openingName = '';
    tree.eco = '';
    const r = repairTreeContent(tree, 'Requested Name');
    expect(r.treeFieldsFilled).toBe(2);
    expect(tree.openingName).toBe('Requested Name');
    expect(tree.eco).toBe('?');
  });

  it('drops empty narration segments and removes narration when all empty', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          narration: [{ text: '' }, { text: '   ' }],
          children: [],
        },
      },
    ]);
    const r = repairTreeContent(tree, 'X');
    expect(r.segmentsDropped).toBe(2);
    expect(r.narrationsDropped).toBe(1);
    expect(tree.root.children[0].node.narration).toBeUndefined();
  });

  it('keeps non-empty segments and drops only the empty ones', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          narration: [{ text: '' }, { text: 'good text' }],
          children: [],
        },
      },
    ]);
    const r = repairTreeContent(tree, 'X');
    expect(r.segmentsDropped).toBe(1);
    expect(r.narrationsDropped).toBe(0);
    expect(tree.root.children[0].node.narration).toEqual([
      { text: 'good text' },
    ]);
  });

  it('drops arrows + highlights with invalid algebraic squares', () => {
    const tree = makeTree([
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: '1.e4',
          narration: [
            {
              text: 'play e4',
              arrows: [
                { from: 'e2', to: 'e4' },
                { from: 'i9', to: 'e4' }, // invalid from
                { from: 'e2', to: 'z3' }, // invalid to
              ],
              highlights: [
                { square: 'd5' },
                { square: 'q9' }, // invalid
              ],
            },
          ],
          children: [],
        },
      },
    ]);
    const r = repairTreeContent(tree, 'X');
    expect(r.arrowsDropped).toBe(2);
    expect(r.highlightsDropped).toBe(1);
    const seg = tree.root.children[0].node.narration?.[0];
    expect(seg?.arrows).toEqual([{ from: 'e2', to: 'e4' }]);
    expect(seg?.highlights).toEqual([{ square: 'd5' }]);
  });

  it('returns all-zero counts on a clean tree', () => {
    const tree = makeTree([
      { node: { san: 'e4', movedBy: 'white', idea: '1.e4 center', children: [] } },
    ]);
    const r = repairTreeContent(tree, 'X');
    expect(r).toEqual({
      ideasFilled: 0,
      narrationsDropped: 0,
      segmentsDropped: 0,
      arrowsDropped: 0,
      highlightsDropped: 0,
      treeFieldsFilled: 0,
    });
  });
});

// ─── Punish-DB inversion data invariants ────────────────────────────
// Locks in the contract that the Lichess puzzle DB has enough
// opening-tagged tactical puzzles for the popular openings. If
// puzzles.json is rotated and a popular opening drops below the
// threshold, this test fails loudly so we don't silently regress
// punish coverage.

describe('Lichess puzzle DB coverage for punish-stage inversion', () => {
  // Re-implement the filter from generatePunishFromDb (kept private
  // to its module). Matches exactly: openingTags + tactical themes
  // + popularity ≥ 70 + nbPlays ≥ 80. If the prod filter changes,
  // mirror it here.
  const PUNISH_THEMES = new Set([
    'mate', 'mateIn1', 'mateIn2', 'mateIn3',
    'fork', 'pin', 'skewer', 'discoveredAttack',
    'hangingPiece', 'trappedPiece', 'sacrifice',
    'attraction', 'deflection', 'doubleAttack',
    'kingsideAttack', 'queensideAttack', 'attackingF2F7',
    'xRayAttack',
  ]);

  interface Puzzle {
    fen: string;
    moves: string;
    rating: number;
    themes: string[];
    openingTags: string | string[] | null;
    popularity: number;
    nbPlays: number;
  }

  function tagsOf(p: Puzzle): string[] {
    if (!p.openingTags) return [];
    if (Array.isArray(p.openingTags)) return p.openingTags;
    return p.openingTags.split(/\s+/).filter(Boolean);
  }

  function tagsMatch(tags: string[], canonical: string): boolean {
    const normalize = (s: string): string =>
      s.replace(/['']/g, '').replace(/[: ]+/g, '_');
    const cands = new Set([normalize(canonical)]);
    const colon = canonical.indexOf(':');
    if (colon > 0) cands.add(normalize(canonical.slice(0, colon).trim()));
    return tags.some((t) =>
      Array.from(cands).some((c) => t === c || t.startsWith(c + '_')),
    );
  }

  function countMatching(canonical: string): number {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require('../data/puzzles.json') as Puzzle[];
    return data.filter((p) => {
      const tags = tagsOf(p);
      if (!tags.length) return false;
      if (!tagsMatch(tags, canonical)) return false;
      if (!p.themes.some((t) => PUNISH_THEMES.has(t))) return false;
      if (p.popularity < 70) return false;
      if (p.nbPlays < 80) return false;
      return true;
    }).length;
  }

  it('Italian Game has at least 50 punish candidates', () => {
    expect(countMatching('Italian Game')).toBeGreaterThanOrEqual(50);
  });

  it("Bishop's Opening apostrophe handling: matches Bishops_Opening tag", () => {
    // Apostrophe-stripping is critical — the DB tag is "Bishops_Opening"
    // (no apostrophe). If normalization regresses this drops to 0.
    expect(countMatching("Bishop's Opening")).toBeGreaterThanOrEqual(20);
  });

  it("King's Gambit apostrophe handling: matches Kings_Gambit_* tags", () => {
    expect(countMatching("King's Gambit")).toBeGreaterThanOrEqual(40);
  });

  it('Caro-Kann Defense has at least 50 punish candidates', () => {
    expect(countMatching('Caro-Kann Defense')).toBeGreaterThanOrEqual(50);
  });

  it('Pirc Defense has enough candidates to populate a stage', () => {
    expect(countMatching('Pirc Defense')).toBeGreaterThanOrEqual(10);
  });

  it('Sicilian Najdorf matches via family tag (Sicilian_Defense)', () => {
    // Lichess tags rarely carry the variation in the openingTag —
    // they tag at the family level. The matcher's "drop colon-suffix"
    // candidate captures this case.
    expect(countMatching('Sicilian Defense: Najdorf Variation')).toBeGreaterThanOrEqual(50);
  });
});

describe('stripMoveRecitationLeadIn', () => {
  it('strips the audited "After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — symmetrical opening" pattern', () => {
    // The exact failure mode the user called out: the intro recites
    // 4 plies then finally says something useful. Strip the recitation,
    // keep the substance.
    const intro =
      'After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — symmetrical opening with classical setup.';
    expect(stripMoveRecitationLeadIn(intro)).toBe(
      'symmetrical opening with classical setup.',
    );
  });

  it('strips a leading "Following 1.d4..." sentence', () => {
    const intro =
      'Following 1.d4 d5 2.c4. White offers the queen-pawn gambit. Black has many ways to handle it.';
    const result = stripMoveRecitationLeadIn(intro);
    expect(result).toContain('queen-pawn gambit');
    expect(result).not.toMatch(/1\.d4/);
  });

  it('leaves move-free intros untouched', () => {
    const intro =
      'The Italian Game targets the weak f7 square with the bishop.';
    expect(stripMoveRecitationLeadIn(intro)).toBe(intro);
  });

  it('returns "" when the entire intro is move recitation', () => {
    const intro = 'After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5.';
    expect(stripMoveRecitationLeadIn(intro)).toBe('');
  });

  it('handles black-move ellipsis notation (1...e5)', () => {
    const intro =
      'After 1...e5 — Black mirrors the center push. Solid and well-trodden.';
    const result = stripMoveRecitationLeadIn(intro);
    expect(result).not.toMatch(/1\.\.\./);
    expect(result).toContain('Solid and well-trodden');
  });

  it('returns "" for empty / whitespace input', () => {
    expect(stripMoveRecitationLeadIn('')).toBe('');
    expect(stripMoveRecitationLeadIn('   ')).toBe('');
  });
});

describe('repairNarrationArrows on DB-narration shaped trees', () => {
  it('drops the arrow that points AT the move\'s own destination square', () => {
    // Production audit (build 088b57a): user reported "the first
    // pawn push has a forward and diagonal arrow." The forward
    // arrow is the LLM redundantly drawing e2→e4 — the same vector
    // the board is already animating. repairNarrationArrows must
    // strip it whether the tree came from the legacy free-form gen
    // (where this was already wired) or the new DB-narration path
    // (where this fix is freshly applied).
    const tree: WalkthroughTree = {
      openingName: 'Test',
      eco: 'X00',
      intro: 'i',
      outro: 'o',
      root: {
        san: null,
        movedBy: null,
        idea: '',
        children: [
          {
            node: {
              san: 'e4',
              movedBy: 'white',
              idea: '1.e4',
              narration: [
                {
                  text: '1.e4',
                  arrows: [
                    { from: 'e2', to: 'e4' },  // redundant — drop
                    { from: 'e4', to: 'd5' },  // threat — keep
                    { from: 'a1', to: 'a1' },  // no-op — drop
                  ],
                },
              ],
              children: [],
            },
          },
        ],
      },
    };
    const dropped = repairNarrationArrows(tree);
    expect(dropped).toBe(2);
    const kept = tree.root.children[0].node.narration?.[0].arrows ?? [];
    expect(kept).toEqual([{ from: 'e4', to: 'd5' }]);
  });
});
