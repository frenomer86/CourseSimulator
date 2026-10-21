/**
 * Check handlers for code labs, registered under the "code.*" namespace. Each receives the
 * learner's program (language and source) and runs it through the runner for that language.
 *
 *   code.runs      { stdin? }                                   finishes without an error
 *   code.stdout    { stdin?, expected, match?, tolerance? }     output matches
 *   code.cases     { cases: [{ stdin, expected, match? }], tolerance? }   several inputs
 *   code.function  { name, cases: [{ args, expected }], tolerance? }     call a function
 *   code.script    { script }                                   an assertion script passes
 *   code.source    { pattern, flags?, mustMatch, message? }     the source text itself
 *
 * `match` is one of: "lines" (default: trim each line, ignore blank lines and trailing spaces),
 * "exact", "contains", "numbers" (every number in the output, in order, within tolerance).
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { functionHarness, parseOutcomes, scriptHarness, splitHarnessOutput, type FunctionCase } from './harness.js';
import { DEFAULT_TIMEOUT_MS, type CodeLanguage, type CodeRunner, type CodeState, type RunResult } from './types.js';

export type MatchMode = 'lines' | 'exact' | 'contains' | 'numbers';

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

export function normaliseLines(s: string): string[] {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/^\s+/g, ''))
    .filter((l) => l.length > 0);
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

export function numbersIn(s: string): number[] {
  return (s.match(NUMBER_RE) ?? []).map(Number);
}

function expectedText(expected: unknown): string {
  return Array.isArray(expected) ? expected.map(String).join('\n') : String(expected ?? '');
}

/** Compares program output with what the lab expects. Returns null on success or a sentence on failure. */
export function compareOutput(actual: string, expected: unknown, mode: MatchMode = 'lines', tolerance = 0): string | null {
  const want = expectedText(expected);
  switch (mode) {
    case 'exact':
      return actual.replace(/\r\n/g, '\n').replace(/\n$/, '') === want.replace(/\n$/, '') ? null : `expected exactly ${JSON.stringify(want)} but got ${JSON.stringify(actual)}`;
    case 'contains':
      return actual.includes(want) ? null : `the output should contain ${JSON.stringify(want)}`;
    case 'numbers': {
      const got = numbersIn(actual);
      const exp = Array.isArray(expected) ? expected.map(Number) : numbersIn(want);
      if (got.length < exp.length) return `expected ${exp.length} number${exp.length === 1 ? '' : 's'} (${exp.join(', ')}) in the output but found ${got.length}`;
      for (let i = 0; i < exp.length; i++) {
        if (Math.abs(got[i] - exp[i]) > tolerance + 1e-9) return `the ${ordinal(i + 1)} number printed should be ${exp[i]} but was ${got[i]}`;
      }
      return null;
    }
    case 'lines':
    default: {
      const got = normaliseLines(actual);
      const exp = normaliseLines(want);
      for (let i = 0; i < Math.max(got.length, exp.length); i++) {
        if (i >= exp.length) return `there is extra output after the expected lines: ${JSON.stringify(got[i])}`;
        if (i >= got.length) return `the output stopped early; line ${i + 1} should be ${JSON.stringify(exp[i])}`;
        if (got[i] !== exp[i]) return `line ${i + 1} should be ${JSON.stringify(exp[i])} but was ${JSON.stringify(got[i])}`;
      }
      return null;
    }
  }
}

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;
}

function describeError(r: RunResult): string {
  if (r.timedOut) return 'The program did not finish in time. Look for a loop that never ends.';
  // The last meaningful traceback line, skipping caret markers such as "    ^^^".
  const lines = (r.stderr || r.error || '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[\^~\s]+$/.test(l));
  const tail = lines[lines.length - 1] ?? '';
  return r.error ? `The program stopped with an error: ${tail || r.error}` : 'The program stopped with an error.';
}

export function deepEqual(a: unknown, b: unknown, tolerance = 0): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b) ? true : Math.abs(a - b) <= tolerance + 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i], tolerance));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerance));
  }
  return a === b;
}

/** A case whose expected value is { "$error": "ValueError" } expects the call to raise that error ("" = any). */
function expectedError(expected: unknown): string | null {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$error' in (expected as object)) {
    return String((expected as { $error: unknown }).$error ?? '');
  }
  return null;
}

function showValue(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
}

export interface Runners {
  get(language: CodeLanguage): CodeRunner | undefined;
}

export function createCodeChecks(runners: Runners): CheckRegistry<CodeState> {
  const runner = (state: CodeState, spec: CheckSpec): CodeRunner | CheckResult => {
    const r = runners.get(state.language);
    return r ?? fail(spec, `No runner is available for ${state.language}. Try reloading the page.`);
  };
  const timeout = (spec: CheckSpec) => (typeof spec.timeoutMs === 'number' ? spec.timeoutMs : DEFAULT_TIMEOUT_MS);

  return new CheckRegistry<CodeState>()
    .register('code.runs', async (state, spec) => {
      const r = runner(state, spec);
      if ('passed' in r) return r;
      const res = await r.run(state.source, String(spec.stdin ?? ''), timeout(spec));
      return res.error || res.timedOut ? fail(spec, describeError(res), res) : pass(spec, 'The program ran to the end without errors.');
    })

    .register('code.stdout', async (state, spec) => {
      const r = runner(state, spec);
      if ('passed' in r) return r;
      const res = await r.run(state.source, String(spec.stdin ?? ''), timeout(spec));
      if (res.error || res.timedOut) return fail(spec, describeError(res), res);
      const problem = compareOutput(res.stdout, spec.expected, (spec.match as MatchMode) ?? 'lines', Number(spec.tolerance ?? 0));
      return problem ? fail(spec, `Not yet: ${problem}.`, res) : pass(spec, 'The output is exactly right.');
    })

    .register('code.cases', async (state, spec) => {
      const r = runner(state, spec);
      if ('passed' in r) return r;
      const cases = (spec.cases as Array<{ stdin?: string; expected: unknown; match?: MatchMode; name?: string }>) ?? [];
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const res = await r.run(state.source, String(c.stdin ?? ''), timeout(spec));
        const label = c.name ?? `input ${JSON.stringify(String(c.stdin ?? '').trim())}`;
        if (res.error || res.timedOut) return fail(spec, `For ${label}: ${describeError(res)}`, res);
        const problem = compareOutput(res.stdout, c.expected, c.match ?? (spec.match as MatchMode) ?? 'lines', Number(spec.tolerance ?? 0));
        if (problem) return fail(spec, `For ${label}: ${problem}.`, { case: i, ...res });
      }
      return pass(spec, `All ${cases.length} inputs give the right output.`);
    })

    .register('code.function', async (state, spec) => {
      const r = runner(state, spec);
      if ('passed' in r) return r;
      const name = String(spec.name ?? '');
      const cases = (spec.cases as FunctionCase[]) ?? [];
      const tolerance = Number(spec.tolerance ?? 0);
      if (!new RegExp(`\\b${name}\\s*(?:=|\\()|\\bdef\\s+${name}\\b|\\bfunction\\s+${name}\\b`).test(state.source)) {
        return fail(spec, `Define a function called ${name} first.`);
      }
      const res = await r.run(state.source + functionHarness(state.language, name, cases), String(spec.stdin ?? ''), timeout(spec));
      if (res.timedOut) return fail(spec, describeError(res), res);
      const { payload } = splitHarnessOutput(res.stdout);
      const outcomes = parseOutcomes(payload);
      if (!outcomes) return fail(spec, res.error ? describeError(res) : `Could not call ${name}. Make sure it is defined at the top level and the program runs without errors.`, res);
      for (let i = 0; i < cases.length; i++) {
        const o = outcomes[i];
        const call = `${name}(${cases[i].args.map(showValue).join(', ')})`;
        if (!o) return fail(spec, `${call} did not return a result.`);
        const wantError = expectedError(cases[i].expected);
        if (wantError !== null) {
          if (!('error' in o)) return fail(spec, `${call} should raise ${wantError || 'an error'} but returned ${showValue(o.value)}.`);
          if (wantError && !o.error.startsWith(wantError)) return fail(spec, `${call} should raise ${wantError} but raised ${o.error}.`);
          continue;
        }
        if ('error' in o) return fail(spec, `${call} raised an error: ${o.error}`);
        if (!deepEqual(o.value, cases[i].expected, tolerance)) return fail(spec, `${call} should return ${showValue(cases[i].expected)} but returned ${showValue(o.value)}.`);
      }
      return pass(spec, `${name} gives the right answer for all ${cases.length} cases.`);
    })

    .register('code.script', async (state, spec) => {
      const r = runner(state, spec);
      if ('passed' in r) return r;
      const res = await r.run(state.source + scriptHarness(state.language, String(spec.script ?? '')), String(spec.stdin ?? ''), timeout(spec));
      if (res.timedOut) return fail(spec, describeError(res), res);
      const { payload } = splitHarnessOutput(res.stdout);
      if (payload === 'ok') return pass(spec, String(spec.success ?? 'The checks on your code all passed.'));
      const tail = (res.stderr || res.error || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
      const assertion = /AssertionError:?\s*(.*)$/.exec(tail)?.[1]?.trim();
      return fail(spec, assertion ? `Not yet: ${assertion}` : describeError(res), res);
    })

    .register('code.source', async (state, spec) => {
      const re = new RegExp(String(spec.pattern), (spec.flags as string | undefined) ?? '');
      const found = re.test(state.source);
      const mustMatch = spec.mustMatch !== false;
      if (found === mustMatch) return pass(spec, String(spec.success ?? 'Your code uses what this lab asks for.'));
      return fail(spec, String(spec.message ?? (mustMatch ? 'Your code is missing something this lab asks you to use.' : 'Your code uses something this lab asks you to avoid.')));
    });
}
