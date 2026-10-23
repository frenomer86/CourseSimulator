/**
 * Expected values here were worked out by hand (automata, weighted search, game trees, rules)
 * or by a separate Python implementation of the same documented tie-breaking (grids, alignment),
 * not by running this code.
 */
import { describe, expect, it } from 'vitest';
import { runAlgorithm, type AlgorithmInput, type GameTree } from './index.js';

export const DIV3: AlgorithmInput['automaton'] = {
  states: ['r0', 'r1', 'r2'],
  alphabet: ['0', '1'],
  start: 'r0',
  accept: ['r0'],
  transitions: [
    ['r0', '0', 'r0'],
    ['r0', '1', 'r1'],
    ['r1', '0', 'r2'],
    ['r1', '1', 'r0'],
    ['r2', '0', 'r1'],
    ['r2', '1', 'r2'],
  ],
};

export const ROADS: AlgorithmInput['weighted'] = {
  nodes: ['Accra', 'Koforidua', 'Kumasi', 'Techiman', 'Yeji', 'Tamale'],
  edges: [
    ['Accra', 'Kumasi', 250],
    ['Accra', 'Koforidua', 85],
    ['Koforidua', 'Kumasi', 190],
    ['Kumasi', 'Techiman', 120],
    ['Kumasi', 'Yeji', 230],
    ['Koforidua', 'Yeji', 330],
    ['Techiman', 'Tamale', 270],
    ['Yeji', 'Tamale', 180],
  ],
  heuristic: { Accra: 520, Koforidua: 470, Kumasi: 380, Techiman: 260, Yeji: 170, Tamale: 0 },
};

const leaf = (name: string, value: number): GameTree => ({ name, value });
export const GAME: GameTree = {
  name: 'A',
  children: [
    { name: 'B', children: [leaf('B1', 4), leaf('B2', 7), leaf('B3', 9)] },
    { name: 'C', children: [leaf('C1', 3), leaf('C2', 8), leaf('C3', 5)] },
    { name: 'D', children: [leaf('D1', 6), leaf('D2', 2), leaf('D3', 9)] },
  ],
};

export const MAIZE = {
  facts: ['yellow_leaves', 'lower_leaves_first', 'sandy_soil', 'heavy_rain_last_week'],
  rules: [
    { if: ['yellow_leaves', 'lower_leaves_first'], then: 'nitrogen_deficiency_suspected' },
    { if: ['heavy_rain_last_week'], then: 'waterlogging_risk' },
    { if: ['sandy_soil', 'heavy_rain_last_week'], then: 'nitrate_leaching' },
    { if: ['nitrogen_deficiency_suspected', 'nitrate_leaching'], then: 'nitrogen_deficiency' },
    { if: ['nitrogen_deficiency'], then: 'apply_urea_split_dose' },
    { if: ['waterlogging_risk', 'clay_soil'], then: 'dig_drainage_channels' },
    { if: ['purple_leaves'], then: 'phosphorus_deficiency' },
  ],
  goal: 'apply_urea_split_dose',
};

export const WAREHOUSE = ['S.......', '........', '..####..', '.....#..', '.....#..', '.......G'];

describe('finite automaton', () => {
  it('tracks the remainder mod 3 of a binary number', () => {
    const t = runAlgorithm('dfa', { automaton: DIV3, word: '1101' });
    expect(t.metrics.final).toBe('r1');
    expect(t.metrics.accepted).toBe(false);
    expect(t.metrics.path).toEqual(['r0', 'r1', 'r0', 'r0', 'r1']);
    expect(runAlgorithm('dfa', { automaton: DIV3, word: '1001' }).metrics.accepted).toBe(true);
    expect(runAlgorithm('dfa', { automaton: DIV3, word: '10010' }).metrics).toMatchObject({ accepted: true, length: 5 });
  });
  it('rejects symbols outside the alphabet and gets stuck without a transition', () => {
    expect(() => runAlgorithm('dfa', { automaton: DIV3, word: '12' })).toThrow(/alphabet/);
    const partial = { ...DIV3!, transitions: DIV3!.transitions.filter(([f, s]) => !(f === 'r1' && s === '0')) };
    expect(runAlgorithm('dfa', { automaton: partial, word: '10' }).metrics).toMatchObject({ accepted: false, final: '(stuck)' });
  });
});

describe('weighted search', () => {
  it('A* expands four towns and finds the 595 km route', () => {
    const t = runAlgorithm('astar', { weighted: ROADS, start: 'Accra', goal: 'Tamale' });
    expect(t.metrics.order).toEqual(['Accra', 'Koforidua', 'Yeji', 'Tamale']);
    expect(t.metrics.distance).toBe(595);
    expect(t.metrics.path).toEqual(['Accra', 'Koforidua', 'Yeji', 'Tamale']);
    expect(t.metrics['f:Kumasi']).toBe(630);
  });
  it('Dijkstra expands every town before reaching Tamale', () => {
    const t = runAlgorithm('dijkstra', { weighted: ROADS, start: 'Accra', goal: 'Tamale' });
    expect(t.metrics.order).toEqual(['Accra', 'Koforidua', 'Kumasi', 'Techiman', 'Yeji', 'Tamale']);
    expect(t.metrics.expanded).toBe(6);
    expect(t.metrics.distance).toBe(595);
    expect(t.metrics['g:Techiman']).toBe(370);
  });
});

describe('grid search', () => {
  it('BFS and A* find the same 12-move path; A* expands far fewer cells', () => {
    const bfs = runAlgorithm('gridBfs', { grid: WAREHOUSE });
    const astar = runAlgorithm('gridAstar', { grid: WAREHOUSE });
    expect(bfs.metrics).toMatchObject({ expanded: 42, pathLength: 12, reached: true });
    expect(astar.metrics).toMatchObject({ expanded: 13, pathLength: 12, reached: true });
    expect(astar.metrics.path).toEqual(['0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '0,6', '0,7', '1,7', '2,7', '3,7', '4,7', '5,7']);
  });
  it('reports an unreachable goal', () => {
    expect(runAlgorithm('gridBfs', { grid: ['S#G'] }).metrics.reached).toBe(false);
  });
});

describe('game trees', () => {
  it('minimax evaluates all nine leaves', () => {
    const t = runAlgorithm('minimax', { tree: GAME });
    expect(t.metrics).toMatchObject({ value: 4, best: 'B', evaluated: 9, 'value:B': 4, 'value:C': 3, 'value:D': 2 });
  });
  it('alpha-beta gets the same value from six leaves', () => {
    const t = runAlgorithm('alphabeta', { tree: GAME });
    expect(t.metrics).toMatchObject({ value: 4, best: 'B', evaluated: 6, prunedCount: 3 });
    expect(t.metrics.pruned).toEqual(['C2', 'C3', 'D3']);
  });
});

describe('alignment', () => {
  it('Needleman-Wunsch scores and aligns two sequences', () => {
    const t = runAlgorithm('needlemanWunsch', { seqA: 'GATTACA', seqB: 'GCATGCA', scoring: { match: 1, mismatch: -1, gap: -1 } });
    expect(t.metrics).toMatchObject({ score: 2, alignA: 'G-ATTACA', alignB: 'GCA-TGCA', matches: 5, gaps: 2, 'cell:3,3': 0 });
    const u = runAlgorithm('needlemanWunsch', { seqA: 'ACGTTA', seqB: 'ACTTA', scoring: { match: 1, mismatch: -1, gap: -2 } });
    expect(u.metrics).toMatchObject({ score: 3, alignA: 'ACGTTA', alignB: 'AC-TTA', 'cell:2,2': 2 });
  });
});

describe('rules', () => {
  it('forward chaining fires an irrelevant rule on the way to the goal', () => {
    const t = runAlgorithm('forwardChaining', MAIZE);
    expect(t.metrics.rulesFired).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    expect(t.metrics).toMatchObject({ newFacts: 5, goalReached: true });
  });
  it('backward chaining only proves what the goal needs', () => {
    const t = runAlgorithm('backwardChaining', MAIZE);
    expect(t.metrics.rulesUsed).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(t.metrics.asked).toEqual(['apply_urea_split_dose', 'nitrogen_deficiency', 'nitrogen_deficiency_suspected', 'yellow_leaves', 'lower_leaves_first', 'nitrate_leaching', 'sandy_soil', 'heavy_rain_last_week']);
    expect(t.metrics).toMatchObject({ proved: true, askedCount: 8, newFacts: 4 });
  });
});
