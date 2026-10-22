/**
 * Every E10 case-study lab must be solvable: playing the best path (reading all evidence, answering every
 * prompt with the reference note, taking the highest-scoring choice at each step) passes every check, and the
 * untouched starter does not. The first scenario batch was verified in the browser and is listed as legacy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { choose, createScenarioChecks, currentNode, isFinished, setAnswer, startScenario, viewEvidence, type ScenarioCheckState, type ScenarioSpec } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');
const LEGACY = new Set(['fundamentals-of-computer-science', 'it-project-management', 'legal-and-ethical-issues-in-computing']);

/** Reference written answers, keyed by lab id then prompt id. */
const NOTES: Record<string, Record<string, string>> = {
  'responsible-ai-i1-the-loan-model': {
    note: 'The model wrongly rejects creditworthy applicants in District B three times as often as in District A, so rural customers are harmed. Before launch we need representative rural training data, an audit of proxy features such as distance to branch, a retrain, and a re-evaluation by group with monitoring and an appeal route afterwards.',
  },
};

function allLabs(): LabSpec[] {
  const out: LabSpec[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec;
      if (raw.engine === 'E10') out.push(raw);
    }
  }
  return out;
}

function bestPath(lab: LabSpec): ScenarioCheckState {
  const spec = lab.config.scenario as ScenarioSpec;
  let s = startScenario(spec);
  for (let guard = 0; guard < 100 && !isFinished(spec, s); guard++) {
    const node = currentNode(spec, s);
    for (const e of node.evidence ?? []) s = viewEvidence(s, e.id);
    for (const p of node.prompts ?? []) s = setAnswer(s, p.id, NOTES[lab.id]?.[p.id] ?? '');
    const best = [...(node.choices ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (!best) throw new Error(`node ${node.id} has no choices and is not an ending`);
    s = choose(spec, s, best.id);
  }
  return { ...s, finished: isFinished(spec, s) };
}

describe('E10 lab content', () => {
  const checks = createScenarioChecks();
  const labs = allLabs();
  it('finds the scenario labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(12);
  });
  for (const lab of labs) {
    if (LEGACY.has(lab.course)) continue;
    describe(lab.id, () => {
      it('does not pass untouched', async () => {
        const r = await checks.run(lab, { ...startScenario(lab.config.scenario as ScenarioSpec), finished: false });
        expect(r.passed).toBe(false);
      });
      it('passes on the best path', async () => {
        const r = await checks.run(lab, bestPath(lab));
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
      it('attaches to a real syllabus topic', () => {
        expect(typeof lab.unit).toBe('number');
        expect(typeof lab.topicIndex).toBe('number');
      });
    });
  }
});
