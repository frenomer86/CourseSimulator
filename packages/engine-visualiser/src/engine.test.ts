import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { answerMatches, createVisualiserChecks, parseList, parseValues, runAlgorithm, type VizState } from './index.js';

const checks = createVisualiserChecks();
const lab = (specs: LabSpec['checks']): LabSpec<VizState> => ({
  id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E6', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1,
});

describe('traces', () => {
  it('linear and binary search count comparisons and find the index', () => {
    const values = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91];
    const lin = runAlgorithm('linearSearch', { values, target: 72 });
    expect(lin.metrics).toMatchObject({ comparisons: 9, index: 8, found: true });
    const bin = runAlgorithm('binarySearch', { values, target: 72 });
    expect(bin.metrics).toMatchObject({ comparisons: 3, index: 8, found: true });
    expect(runAlgorithm('binarySearch', { values, target: 16 }).metrics.comparisons).toBe(1);
    expect(runAlgorithm('binarySearch', { values, target: 7 }).metrics).toMatchObject({ found: false, index: -1 });
    expect(bin.steps[0].line).toBe(1);
    expect(bin.steps.every((s) => s.line >= 1 && s.line <= bin.pseudocode.length)).toBe(true);
  });

  it('bubble sort records passes, swaps and the array after each pass', () => {
    const t = runAlgorithm('bubbleSort', { values: [5, 1, 4, 2, 8] });
    expect(t.metrics).toMatchObject({ swaps: 4, passes: 3, comparisons: 9, values: [1, 2, 4, 5, 8] });
    const afterPass1 = [...t.steps].reverse().find((s) => s.vars.pass === 1)!;
    expect(afterPass1.values).toEqual([1, 4, 2, 5, 8]);
    expect(runAlgorithm('bubbleSort', { values: [5, 4, 3, 2, 1] }).metrics.swaps).toBe(10);
    expect(runAlgorithm('bubbleSort', { values: [1, 2, 3] }).metrics.passes).toBe(1);
  });

  it('selection and insertion sort', () => {
    expect(runAlgorithm('selectionSort', { values: [29, 10, 14, 37, 13] }).metrics).toMatchObject({ swaps: 3, comparisons: 10, values: [10, 13, 14, 29, 37] });
    expect(runAlgorithm('insertionSort', { values: [29, 10, 14, 37, 13] }).metrics).toMatchObject({ shifts: 5, values: [10, 13, 14, 29, 37] });
    expect(runAlgorithm('insertionSort', { values: [1, 2, 3, 4] }).metrics.shifts).toBe(0);
  });

  it('stack and queue operations', () => {
    const ops = ['add 1', 'add 2', 'remove', 'add 3', 'peek', 'remove', 'remove', 'remove'];
    expect(runAlgorithm('stack', { ops }).metrics).toMatchObject({ final: [], removed: [2, 3, 1], maxSize: 2, errors: 1 });
    expect(runAlgorithm('queue', { ops }).metrics).toMatchObject({ final: [], removed: [1, 2, 3], maxSize: 2, errors: 1 });
    expect(() => runAlgorithm('stack', { ops: ['fly 3'] })).toThrow(/Cannot understand/);
  });

  it('breadth-first and depth-first search visit in alphabetical neighbour order', () => {
    const graph = { nodes: ['Ho', 'Hohoe', 'Kpando', 'Keta', 'Aflao', 'Sogakope', 'Jasikan'], edges: [['Ho', 'Hohoe'], ['Ho', 'Kpando'], ['Ho', 'Sogakope'], ['Hohoe', 'Jasikan'], ['Hohoe', 'Kpando'], ['Sogakope', 'Keta'], ['Keta', 'Aflao']] as Array<[string, string]> };
    const b = runAlgorithm('bfs', { graph, start: 'Ho' });
    expect(b.metrics.order).toEqual(['Ho', 'Hohoe', 'Kpando', 'Sogakope', 'Jasikan', 'Keta', 'Aflao']);
    expect(b.metrics['depth:Aflao']).toBe(3);
    const d = runAlgorithm('dfs', { graph, start: 'Ho' });
    expect(d.metrics.order).toEqual(['Ho', 'Hohoe', 'Jasikan', 'Kpando', 'Sogakope', 'Keta', 'Aflao']);
    expect(() => runAlgorithm('bfs', { graph, start: 'Accra' })).toThrow(/not a node/);
  });

  it('parses values and lists', () => {
    expect(parseValues('5, 3,8 1')).toEqual([5, 3, 8, 1]);
    expect(() => parseValues('5, x')).toThrow();
    expect(parseList('[1, 2, 3]')).toEqual(['1', '2', '3']);
    expect(parseList('Ho → Hohoe → Kpando')).toEqual(['Ho', 'Hohoe', 'Kpando']);
    expect(answerMatches(' 9 ', 9)).toBe(true);
    expect(answerMatches('1,4,2,5,8', [1, 4, 2, 5, 8])).toBe(true);
    expect(answerMatches('ho, hohoe', ['Ho', 'Hohoe'])).toBe(true);
    expect(answerMatches('yes', true)).toBe(true);
    expect(answerMatches('no', true)).toBe(false);
  });
});

describe('viz.* checks', () => {
  const input = { values: [5, 1, 4, 2, 8] };
  it('grades answers computed from the trace', async () => {
    const spec = lab([
      { type: 'viz.metric', label: 'swaps', id: 'q1', algorithm: 'bubbleSort', metric: 'swaps', question: 'How many swaps?' },
      { type: 'viz.state', label: 'after pass 1', id: 'q2', algorithm: 'bubbleSort', what: 'values', at: { var: 'pass', value: 1 }, question: 'Array after pass 1?' },
      { type: 'viz.final', label: 'final', id: 'q3', algorithm: 'bubbleSort', what: 'values', question: 'Final array?' },
    ]);
    const good = await checks.run(spec, { input, answers: { q1: '4', q2: '1 4 2 5 8', q3: '[1,2,4,5,8]' } });
    expect(good.passed).toBe(true);
    const bad = await checks.run(spec, { input, answers: { q1: '3', q2: '', q3: '1,2,4,5,8' } });
    expect(bad.checks[0].passed).toBe(false);
    expect(bad.checks[1].message).toMatch(/Answer this question first/);
    expect(bad.checks[2].passed).toBe(true);
  });

  it('viz.input judges the learner-made input', async () => {
    const spec = lab([{ type: 'viz.input', label: 'ten swaps', algorithm: 'bubbleSort', metric: 'swaps', equals: 10, length: 5, distinct: true }]);
    expect((await checks.run(spec, { input: { values: [9, 7, 5, 3, 1] }, answers: {} })).passed).toBe(true);
    expect((await checks.run(spec, { input: { values: [1, 2, 3, 4, 5] }, answers: {} })).checks[0].message).toMatch(/swaps is 0; it needs to be exactly 10/);
    expect((await checks.run(spec, { input: { values: [9, 7, 5, 3] }, answers: {} })).checks[0].message).toMatch(/exactly 5 values/);
    expect((await checks.run(spec, { input: { values: [5, 5, 5, 5, 5] }, answers: {} })).checks[0].message).toMatch(/all be different/);
  });
});
