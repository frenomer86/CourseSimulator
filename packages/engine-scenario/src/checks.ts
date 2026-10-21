/**
 * Check handlers for scenario labs, under the "scenario.*" namespace.
 *
 *   scenario.finished  {}                                  reached an ending
 *   scenario.reached   { nodes: [...] }                    ended at one of these nodes
 *   scenario.flags     { all?: [...], none?: [...] }       flags collected / avoided
 *   scenario.score     { min?, max? }                      score within bounds
 *   scenario.chose     { choices?: [...], avoided?: [...] } decisions taken / not taken
 *   scenario.examined  { evidence: [...] }                 evidence items opened
 *   scenario.rubric    { prompt, patterns: [...], required?, minWords?, message? }
 *                      a written answer mentions at least `required` of the patterns
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { wordCount, type ScenarioState } from './scenario.js';

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** The engine needs to know whether the learner is at an ending; the UI passes it in the state. */
export interface ScenarioCheckState extends ScenarioState {
  finished: boolean;
}

export function createScenarioChecks(): CheckRegistry<ScenarioCheckState> {
  return new CheckRegistry<ScenarioCheckState>()
    .register('scenario.finished', (state, spec) =>
      state.finished ? pass(spec, 'You followed the case through to an ending.') : fail(spec, 'Keep going: the case has not reached an ending yet.'),
    )

    .register('scenario.reached', (state, spec) => {
      const nodes = list(spec.nodes);
      if (!state.finished) return fail(spec, 'Keep going: the case has not reached an ending yet.');
      return nodes.includes(state.current)
        ? pass(spec, String(spec.success ?? 'You reached one of the good endings.'))
        : fail(spec, String(spec.message ?? 'This ending is not the one the case is aiming for. Start again and reconsider your decisions.'));
    })

    .register('scenario.flags', (state, spec) => {
      const all = list(spec.all);
      const none = list(spec.none);
      const missing = all.filter((f) => !state.flags.includes(f));
      const present = none.filter((f) => state.flags.includes(f));
      if (missing.length === 0 && present.length === 0) return pass(spec, String(spec.success ?? 'Your decisions covered what this check looks for.'));
      return fail(spec, String(spec.message ?? 'Your decisions missed something this check looks for.'), { missing, present });
    })

    .register('scenario.score', (state, spec) => {
      const min = spec.min === undefined ? -Infinity : Number(spec.min);
      const max = spec.max === undefined ? Infinity : Number(spec.max);
      if (state.score >= min && state.score <= max) return pass(spec, String(spec.success ?? `Your decisions scored ${state.score}.`));
      return fail(spec, String(spec.message ?? `Your decisions scored ${state.score}; this check needs at least ${min}.`));
    })

    .register('scenario.chose', (state, spec) => {
      const taken = new Set(state.path.map((s) => s.choice));
      const choices = list(spec.choices);
      const avoided = list(spec.avoided);
      const missing = choices.filter((c) => !taken.has(c));
      const wrong = avoided.filter((c) => taken.has(c));
      if (missing.length === 0 && wrong.length === 0) return pass(spec, String(spec.success ?? 'You made the decisions this check looks for.'));
      return fail(spec, String(spec.message ?? 'One of your decisions is not what this check looks for.'), { missing, wrong });
    })

    .register('scenario.examined', (state, spec) => {
      const wanted = list(spec.evidence);
      const missing = wanted.filter((e) => !state.viewed.includes(e));
      if (missing.length === 0) return pass(spec, String(spec.success ?? 'You examined the evidence before deciding.'));
      return fail(spec, String(spec.message ?? `Open and read every piece of evidence before deciding (${missing.length} not yet examined).`), { missing });
    })

    .register('scenario.rubric', (state, spec) => {
      const text = state.answers[String(spec.prompt)] ?? '';
      const minWords = Number(spec.minWords ?? 0);
      const patterns = list(spec.patterns);
      const required = Math.min(patterns.length, Number(spec.required ?? patterns.length));
      const words = wordCount(text);
      if (words < minWords) return fail(spec, `Write at least ${minWords} words (you have ${words}).`);
      // Whole words only, so a short pattern such as "IT" does not match inside "with".
      const hits = patterns.filter((p) => new RegExp(`\\b(?:${p})\\b`, 'i').test(text));
      if (hits.length >= required) return pass(spec, String(spec.success ?? 'Your answer covers the points this check looks for.'));
      return fail(spec, String(spec.message ?? `Your answer covers ${hits.length} of the ${required} points this check looks for. Read the case material again.`), {
        covered: hits.length,
        required,
      });
    });
}
