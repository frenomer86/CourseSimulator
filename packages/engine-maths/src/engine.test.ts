import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import {
  binomial,
  bisection,
  createMathsChecks,
  describeData,
  determinant,
  euclid,
  evaluate,
  expressionsEquivalent,
  formulasEquivalent,
  inverse,
  isTautology,
  matMul,
  modInverse,
  modPow,
  parseExpr,
  parseFormula,
  parseMatrix,
  parseNumber,
  parseSet,
  sameMatrix,
  setOps,
  showFormula,
  truthTable,
  type MathsState,
} from './index.js';

describe('expressions', () => {
  it('parses precedence, implicit multiplication, functions and constants', () => {
    const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2x + 3(x + 1)', { x: 2 })).toBe(13);
    expect(ev('x y', { x: 3, y: 4 })).toBe(12);
    expect(ev('sin(pi/2) + e^0')).toBeCloseTo(2);
    expect(ev('sqrt(16) / 2')).toBe(2);
    expect(() => parseExpr('2 +')).toThrow();
    expect(() => parseExpr('sin x')).toThrow();
  });
  it('decides equivalence numerically and reports a counterexample', () => {
    expect(expressionsEquivalent('(x+1)^2', 'x^2 + 2x + 1')).toBeNull();
    expect(expressionsEquivalent('3x^2 - 2', '3*x^2-2')).toBeNull();
    expect(expressionsEquivalent('sin(x)*x', 'x sin(x)')).toBeNull();
    expect(expressionsEquivalent('x^2', 'x^3')).toMatch(/at x = .* your expression gives/);
    expect(expressionsEquivalent('(x^2-1)/(x-1)', 'x+1')).toBeNull();
    expect(expressionsEquivalent('y+1', 'x+1')).toMatch(/uses "y"/);
    expect(expressionsEquivalent('2 +', 'x')).toMatch(/ends too early/);
  });
  it('parses numbers with fractions and constants', () => {
    expect(parseNumber('3/4')).toBe(0.75);
    expect(parseNumber('pi/6')).toBeCloseTo(Math.PI / 6);
    expect(parseNumber('1,024')).toBe(1024);
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('logic', () => {
  it('parses many spellings and builds textbook-order truth tables', () => {
    const t = truthTable(parseFormula('p -> q'));
    expect(t.variables).toEqual(['p', 'q']);
    expect(t.rows.map((r) => r.output)).toEqual([true, false, true, true]);
    expect(truthTable(parseFormula('not (p and q)')).rows.map((r) => r.output)).toEqual([false, true, true, true]);
    expect(showFormula(parseFormula('~(p & q) <-> (~p | ~q)'))).toBe('¬(p ∧ q) ↔ (¬p ∨ ¬q)');
    expect(isTautology(parseFormula('~(p & q) <-> (~p | ~q)'))).toBe(true);
    expect(isTautology(parseFormula('p -> q -> p'))).toBe(true);
    expect(() => parseFormula('p &')).toThrow();
  });
  it('decides equivalence with a counterexample', () => {
    expect(formulasEquivalent('~p | q', 'p -> q')).toBeNull();
    expect(formulasEquivalent('¬p ∨ ¬q', '¬(p ∧ q)')).toBeNull();
    expect(formulasEquivalent('p & q', 'p | q')).toBe('when p = T, q = F, your formula is false but it should be true');
    expect(formulasEquivalent('p & r', 'p & q')).toMatch(/uses "r"/);
    expect(formulasEquivalent('(p -> q) <-> (~q -> ~p)', 'T')).toBeNull();
    expect(formulasEquivalent('(p -> q) <-> (q -> p)', 'T')).toMatch(/should be true/);
    expect(formulasEquivalent('p & ~p', 'F')).toBeNull();
  });
});

describe('structures', () => {
  it('sets', () => {
    expect(parseSet('{1, 2, 3}')).toEqual(['1', '2', '3']);
    expect(parseSet('3 1 2 2')).toEqual(['3', '1', '2']);
    expect(parseSet('{}')).toEqual([]);
    expect(setOps.union(['1', '2'], ['2', '3'])).toEqual(['1', '2', '3']);
    expect(setOps.difference(['1', '2', '3'], ['2'])).toEqual(['1', '3']);
    expect(setOps.powerSetSize(['a', 'b', 'c'])).toBe(8);
  });
  it('matrices', () => {
    const a = parseMatrix('[[1,2],[3,4]]');
    const b = parseMatrix('5 6; 7 8');
    expect(matMul(a, b)).toEqual([[19, 22], [43, 50]]);
    expect(determinant(a)).toBe(-2);
    expect(sameMatrix(inverse(a), [[-2, 1], [1.5, -0.5]])).toBe(true);
    expect(determinant(parseMatrix('2 0 0; 0 3 0; 0 0 4'))).toBe(24);
    expect(() => inverse(parseMatrix('1 2; 2 4'))).toThrow(/singular/);
    expect(() => parseMatrix('1 2; 3')).toThrow();
  });
  it('number theory and numerics', () => {
    const e = euclid(240, 46);
    expect(e.gcd).toBe(2);
    expect(e.steps.map((s) => s.r)).toEqual([10, 6, 4, 2, 0]);
    expect(240 * e.x + 46 * e.y).toBe(2);
    expect(modInverse(7, 26)).toBe(15);
    expect(modInverse(4, 8)).toBeNull();
    expect(modPow(7, 128, 13)).toBe(3);
    const r = bisection((x) => x ** 3 - x - 2, 1, 2, 1e-3);
    expect(r.root).toBeCloseTo(1.5214, 3);
    expect(r.steps.length).toBe(10);
    expect(describeData([2, 4, 4, 4, 5, 5, 7, 9])).toMatchObject({ mean: 5, median: 4.5, sd: 2 });
    expect(binomial(5, 2, 0.3)).toBeCloseTo(0.3087, 4);
  });
});

describe('math.* checks', () => {
  const checks = createMathsChecks();
  const lab = (specs: LabSpec['checks']): LabSpec<MathsState> => ({
    id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E7', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1,
  });
  it('grades numbers, expressions, formulas, sets, matrices, relations and tables', async () => {
    const spec = lab([
      { type: 'math.number', label: 'n', id: 'a', expected: 0.75 },
      { type: 'math.expr', label: 'e', id: 'b', expected: '3x^2 - 2' },
      { type: 'math.logic', label: 'l', id: 'c', expected: '~p | ~q' },
      { type: 'math.set', label: 's', id: 'd', expected: [1, 2, 3] },
      { type: 'math.matrix', label: 'm', id: 'e', expected: [[19, 22], [43, 50]] },
      { type: 'math.relation', label: 'r', expr: '240*x + 46*y', equals: 2, using: ['x', 'y'] },
      { type: 'math.truthTable', label: 't', id: 'tt', formula: 'p -> q' },
    ]);
    const good = await checks.run(spec, {
      answers: { a: '3/4', b: '3*x*x - 2', c: 'not (p and q)', d: '{3, 1, 2}', e: '19 22; 43 50', x: '-9', y: '47' },
      tables: { tt: [true, false, true, true] },
    });
    expect(good.checks.filter((c) => !c.passed).map((c) => c.message)).toEqual([]);
    const bad = await checks.run(spec, { answers: { a: '0.7', b: 'x^2', c: 'p | q', d: '{1, 2}', e: '1 2; 3 4', x: '1', y: '1' }, tables: { tt: [true, true, true, true] } });
    expect(bad.checks.map((c) => c.passed)).toEqual([false, false, false, false, false, false, false]);
    expect(bad.checks[3].message).toBe('Not quite: missing 3.');
    expect(bad.checks[6].message).toMatch(/Row 2 \(p = T, q = F\) is wrong/);
    const blank = await checks.run(spec, { answers: {}, tables: {} });
    expect(blank.checks[0].message).toBe('Answer this question first.');
  });
});
