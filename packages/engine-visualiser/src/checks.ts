/**
 * Checks for visualiser labs, under the "viz.*" namespace. Expected values are never typed
 * by the author: they are computed from the trace of the algorithm on the lab's input, so the
 * learner has to read the visualiser, and the content stays correct if the input changes.
 *
 *   viz.metric  { id, algorithm, metric, question }            answer = trace.metrics[metric]
 *   viz.state   { id, algorithm, what: "values" | "var", name?, at: { step } | { var, value, position? }, question }
 *   viz.final   { id, algorithm, what: "values" | "order" | "stack" | "queue", question }
 *   viz.input   { algorithm, metric, equals? | min? | max?, length?, distinct?, question }
 *               the learner's current input must give a trace with that property
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { runAlgorithm, type AlgorithmInput, type Metric, type Step, type Trace } from './trace.js';

export interface VizState {
  input: AlgorithmInput;
  answers: Record<string, string>;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

/** "5, 3, 8", "[5,3,8]", "5 → 3 → 8", "Ho, Hohoe" all become lists of trimmed tokens. */
export function parseList(text: string): string[] {
  return text
    .replace(/[[\]{}()]/g, ' ')
    .split(/[,;→>\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function showMetric(v: Metric | undefined): string {
  if (v === undefined) return '?';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/** True when the learner's text means the expected value. */
export function answerMatches(answer: string, expected: Metric): boolean {
  const a = answer.trim();
  if (a === '') return false;
  if (Array.isArray(expected)) {
    const got = parseList(a);
    if (got.length !== expected.length) return false;
    return got.every((g, i) => (typeof expected[i] === 'number' ? Number(g) === expected[i] : g.toLowerCase() === String(expected[i]).toLowerCase()));
  }
  if (typeof expected === 'boolean') return /^(yes|true|found|y)$/i.test(a) === expected || /^(no|false|not found|n)$/i.test(a) === !expected;
  if (typeof expected === 'number') return Number(a.replace(/,/g, '')) === expected;
  return a.toLowerCase() === expected.toLowerCase();
}

function safeTrace(id: string, input: AlgorithmInput): Trace | string {
  try {
    return runAlgorithm(id, input);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function stepAt(trace: Trace, at: unknown): Step | undefined {
  if (!at || typeof at !== 'object') return undefined;
  const a = at as { step?: number; var?: string; value?: unknown; position?: 'first' | 'last' };
  if (typeof a.step === 'number') return trace.steps[a.step - 1];
  if (a.var) {
    const matches = trace.steps.filter((s) => s.vars[a.var!] === a.value);
    return a.position === 'first' ? matches[0] : matches[matches.length - 1];
  }
  return undefined;
}

function expectedFor(spec: CheckSpec, trace: Trace): Metric | undefined {
  switch (spec.type) {
    case 'viz.metric':
      return trace.metrics[String(spec.metric)];
    case 'viz.final': {
      const what = String(spec.what);
      if (what === 'values') return trace.metrics.values as number[] | undefined;
      if (what === 'order') return trace.metrics.order as string[] | undefined;
      if (what === 'stack' || what === 'queue') return trace.metrics.final as number[] | undefined;
      return undefined;
    }
    case 'viz.state': {
      const s = stepAt(trace, spec.at);
      if (!s) return undefined;
      if (spec.what === 'values') return s.values;
      const v = s.vars[String(spec.name)];
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined;
    }
  }
  return undefined;
}

export function createVisualiserChecks(): CheckRegistry<VizState> {
  const answerCheck = async (state: VizState, spec: CheckSpec): Promise<CheckResult> => {
    const input = (spec.input as AlgorithmInput | undefined) ?? state.input;
    const trace = safeTrace(String(spec.algorithm), input);
    if (typeof trace === 'string') return fail(spec, `The algorithm could not run on this input: ${trace}`);
    const expected = expectedFor(spec, trace);
    if (expected === undefined) return fail(spec, 'This question has no answer in the trace. This is a content error, not yours.');
    const answer = state.answers[String(spec.id)] ?? '';
    if (answer.trim() === '') return fail(spec, 'Answer this question first. Step through the visualiser to find it.');
    if (answerMatches(answer, expected)) return pass(spec, String(spec.success ?? `Right: ${showMetric(expected)}.`));
    return fail(spec, String(spec.message ?? 'Not quite. Step through the visualiser again and watch the variables.'), { expected });
  };

  return new CheckRegistry<VizState>()
    .register('viz.metric', answerCheck)
    .register('viz.state', answerCheck)
    .register('viz.final', answerCheck)
    .register('viz.input', async (state, spec) => {
      const trace = safeTrace(String(spec.algorithm), state.input);
      if (typeof trace === 'string') return fail(spec, `Your input cannot be used: ${trace}`);
      const vals = state.input.values ?? [];
      if (typeof spec.length === 'number' && vals.length !== spec.length) return fail(spec, `Use exactly ${spec.length} values (you have ${vals.length}).`);
      if (spec.distinct === true && new Set(vals).size !== vals.length) return fail(spec, 'The values must all be different.');
      if (spec.sorted === true && vals.some((v, i) => i > 0 && v < vals[i - 1])) return fail(spec, 'Binary search needs the list in ascending order.');
      const metric = String(spec.metric);
      const value = trace.metrics[metric];
      if (typeof value !== 'number') return fail(spec, `The trace has no number called ${metric}. This is a content error, not yours.`);
      if (typeof spec.equals === 'number' && value !== spec.equals) return fail(spec, String(spec.message ?? `With your input, ${metric} is ${value}; it needs to be exactly ${spec.equals}.`));
      if (typeof spec.min === 'number' && value < spec.min) return fail(spec, String(spec.message ?? `With your input, ${metric} is ${value}; it needs to be at least ${spec.min}.`));
      if (typeof spec.max === 'number' && value > spec.max) return fail(spec, String(spec.message ?? `With your input, ${metric} is ${value}; it needs to be at most ${spec.max}.`));
      return pass(spec, String(spec.success ?? `Your input gives ${metric} = ${value}.`));
    });
}
