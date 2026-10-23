/** Case-study (E10) templates: a run of decisions, each with evidence, choices and feedback. */

import type { CheckSpec } from '@cslab/lab-runtime';
import type { BuiltTask, Variant } from '../types';
import { mdSafe } from './kit';

export interface Step {
  title: string;
  text: string;
  evidence?: Array<{ title: string; text: string; kind?: string }>;
  choices: Array<{ text: string; right?: boolean; feedback: string }>;
}

export function caseStudy(v: Variant, o: { intro: string; steps: Step[]; ending: { title: string; text: string }; hints: string[]; realityNote: string; pass?: number }): BuiltTask {
  const evidenceIds: string[] = [];
  const nodes = o.steps.map((s, i) => {
    const id = `s${i + 1}`;
    const next = i + 1 < o.steps.length ? `s${i + 2}` : 'end';
    const evidence = (s.evidence ?? []).map((e, k) => {
      const eid = `${id}e${k + 1}`;
      evidenceIds.push(eid);
      return { id: eid, kind: e.kind ?? 'document', title: e.title, text: mdSafe(e.text) };
    });
    const choices = v.some(s.choices, s.choices.length).map((c, k) => ({ id: `${id}c${k + 1}`, text: c.text, next, score: c.right ? 2 : 0, flags: c.right ? [`${id}-right`] : [], feedback: mdSafe(c.feedback) }));
    return { id, title: s.title, text: mdSafe(s.text), ...(evidence.length ? { evidence } : {}), choices };
  });
  nodes.push({ id: 'end', title: o.ending.title, text: mdSafe(o.ending.text), end: true, outcome: 'good' } as never);
  const need = Math.ceil(o.steps.length * (o.pass ?? 0.8));
  const checks: CheckSpec[] = [
    { type: 'scenario.finished', label: 'You worked through the case' },
    ...(evidenceIds.length ? [{ type: 'scenario.examined', label: 'You read the evidence before deciding', evidence: evidenceIds }] : []),
    { type: 'scenario.score', label: `At least ${need} of the ${o.steps.length} decisions are right`, min: need * 2, message: `Fewer than ${need} of the ${o.steps.length} decisions were right. Read the feedback and run the case again.` },
  ];
  return { instructions: mdSafe(o.intro), hints: o.hints, checks, config: { scenario: { start: 's1', nodes } }, initialState: {}, realityNote: o.realityNote };
}
