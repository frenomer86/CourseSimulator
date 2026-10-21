/**
 * Checks for maths labs, under the "math.*" namespace. The learner's answers live in
 * state.answers (text) and state.tables (filled truth tables).
 *
 *   math.number     { id, expected, tolerance?, question }       a number (fractions and pi allowed)
 *   math.expr       { id, expected, variables?, domain?, question }   an expression equivalent to expected
 *   math.logic      { id, expected, question }                   a formula equivalent to expected
 *   math.truthTable { id, formula, question }                    the filled table matches the formula's
 *   math.set        { id, expected: [...], question }            a set with exactly these members
 *   math.matrix     { id, expected: [[...]], tolerance?, question }
 *   math.relation   { expr, equals, using: [ids], tolerance?, question }   an equation over several answers
 *   math.text       { id, pattern, flags?, question }
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { evaluate, expressionsEquivalent, parseExpr, parseNumber, round } from './expr.js';
import { formulasEquivalent, parseFormula, truthTable } from './logic.js';
import { parseMatrix, parseSet, sameMatrix, sameSet, showMatrix } from './structures.js';

export interface MathsState {
  answers: Record<string, string>;
  tables: Record<string, Array<boolean | null>>;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}
const BLANK = 'Answer this question first.';

export function createMathsChecks(): CheckRegistry<MathsState> {
  const answer = (state: MathsState, spec: CheckSpec) => (state.answers[String(spec.id)] ?? '').trim();

  return new CheckRegistry<MathsState>()
    .register('math.number', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      const got = parseNumber(text);
      if (got === null) return fail(spec, 'Enter a number (fractions such as 3/4 and expressions such as pi/6 are fine).');
      const expected = Number(spec.expected);
      const tol = typeof spec.tolerance === 'number' ? spec.tolerance : 1e-6;
      if (Math.abs(got - expected) <= tol + 1e-12) return pass(spec, String(spec.success ?? `Right: ${round(expected)}.`));
      return fail(spec, String(spec.message ?? `Not quite: ${round(got)} is not the value this check expects.`));
    })

    .register('math.expr', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      const problem = expressionsEquivalent(text, String(spec.expected), {
        variables: spec.variables as string[] | undefined,
        domain: spec.domain as [number, number] | undefined,
        tolerance: typeof spec.tolerance === 'number' ? spec.tolerance : undefined,
      });
      return problem ? fail(spec, `Not yet: ${problem}.`) : pass(spec, String(spec.success ?? 'Your expression is equivalent to the expected one.'));
    })

    .register('math.logic', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      const problem = formulasEquivalent(text, String(spec.expected));
      return problem ? fail(spec, `Not yet: ${problem}.`) : pass(spec, String(spec.success ?? 'Your formula has the same truth table as the expected one.'));
    })

    .register('math.truthTable', async (state, spec) => {
      const table = state.tables[String(spec.id)] ?? [];
      let expected;
      try {
        expected = truthTable(parseFormula(String(spec.formula)));
      } catch (err) {
        return fail(spec, `This check's formula is invalid: ${err instanceof Error ? err.message : String(err)}. This is a content error, not yours.`);
      }
      const rows = expected.rows;
      if (table.length < rows.length || table.some((v) => v === null || v === undefined)) return fail(spec, 'Fill in every row of the truth table.');
      for (let i = 0; i < rows.length; i++) {
        if (table[i] !== rows[i].output) {
          const assign = expected.variables.map((v, k) => `${v} = ${rows[i].inputs[k] ? 'T' : 'F'}`).join(', ');
          return fail(spec, `Row ${i + 1} (${assign}) is wrong.`);
        }
      }
      return pass(spec, String(spec.success ?? 'Every row of the table is right.'));
    })

    .register('math.set', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      const got = parseSet(text);
      const expected = (spec.expected as unknown[]).map(String).map((m) => (Number.isNaN(Number(m)) ? m : String(Number(m))));
      if (sameSet(got, expected)) return pass(spec, String(spec.success ?? `Right: {${expected.join(', ')}}.`));
      const missing = expected.filter((m) => !got.map((g) => g.toLowerCase()).includes(m.toLowerCase()));
      const extra = got.filter((g) => !expected.map((m) => m.toLowerCase()).includes(g.toLowerCase()));
      const parts = [];
      if (missing.length) parts.push(`missing ${missing.join(', ')}`);
      if (extra.length) parts.push(`${extra.join(', ')} should not be there`);
      return fail(spec, `Not quite: ${parts.join('; ')}.`);
    })

    .register('math.matrix', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      let got;
      try {
        got = parseMatrix(text);
      } catch (err) {
        return fail(spec, err instanceof Error ? err.message : String(err));
      }
      const expected = spec.expected as number[][];
      if (sameMatrix(got, expected, typeof spec.tolerance === 'number' ? spec.tolerance : 1e-6)) return pass(spec, String(spec.success ?? `Right: ${showMatrix(expected)}.`));
      if (got.length !== expected.length || got[0].length !== expected[0].length) return fail(spec, `The matrix should be ${expected.length}×${expected[0].length}, yours is ${got.length}×${got[0].length}.`);
      return fail(spec, String(spec.message ?? 'Not quite: at least one entry differs.'));
    })

    .register('math.relation', async (state, spec) => {
      const using = (spec.using as string[]) ?? [];
      const env: Record<string, number> = {};
      for (const id of using) {
        const v = parseNumber(state.answers[id] ?? '');
        if (v === null) return fail(spec, `Answer ${id} with a number first.`);
        env[id] = v;
      }
      let value: number;
      try {
        value = evaluate(parseExpr(String(spec.expr)), env);
      } catch (err) {
        return fail(spec, `This check's expression is invalid: ${err instanceof Error ? err.message : String(err)}. This is a content error, not yours.`);
      }
      const tol = typeof spec.tolerance === 'number' ? spec.tolerance : 1e-6;
      if (Math.abs(value - Number(spec.equals)) <= tol) return pass(spec, String(spec.success ?? `Your values satisfy ${spec.expr} = ${spec.equals}.`));
      return fail(spec, String(spec.message ?? `With your values, ${spec.expr} = ${round(value)}, not ${spec.equals}.`));
    })

    .register('math.text', async (state, spec) => {
      const text = answer(state, spec);
      if (!text) return fail(spec, BLANK);
      const re = new RegExp(`^(?:${String(spec.pattern)})$`, (spec.flags as string | undefined) ?? 'i');
      return re.test(text) ? pass(spec, String(spec.success ?? 'Right.')) : fail(spec, String(spec.message ?? 'Not quite.'));
    });
}
