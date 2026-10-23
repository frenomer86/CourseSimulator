/**
 * Builders every course's templates share: Markdown-safe lab instructions, the case-study (E10)
 * builder and a short template constructor.
 */

import type { CheckSpec, LabLevel } from '@cslab/lab-runtime';
import type { BuiltTask, TaskTemplate, Variant } from './types.js';

/** Markdown treats "\\" as an escaped backslash, which would turn \\SERVER\share into \SERVER\share. Double them outside code spans. */
export function mdSafe(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\\\\/g, '\\\\\\\\')))
    .join('');
}

/** Instructions in the house layout: the situation, numbered steps and useful commands. */
export function lab(parts: { situation: string; steps: string[]; tips?: string[] }): string {
  return mdSafe([`## The situation`, '', parts.situation, '', '## Do this', '', ...parts.steps.map((s, i) => `${i + 1}. ${s}`), ...(parts.tips?.length ? ['', '## Useful commands', '', ...parts.tips.map((t) => (t.includes('\n') ? `\n\`\`\`\n${t}\n\`\`\`\n` : `- \`${t}\``))] : [])].join('\n'));
}

/** A template constructor bound to one course and an id prefix ("sa2" → sa2-u3t2-b-slug). */
export function templateMaker(course: string, prefix: string) {
  return (unit: number, topicIndex: number, level: LabLevel, slug: string, title: string, engine: string, minutes: number, summary: string, build: (v: Variant) => BuiltTask): TaskTemplate => ({ id: `${prefix}-u${unit}t${topicIndex}-${level[0]}-${slug}`, course, unit, topicIndex, level, title, engine, estimatedMinutes: minutes, summary, build });
}

export interface Step {
  title: string;
  text: string;
  evidence?: Array<{ title: string; text: string; kind?: string }>;
  choices: Array<{ text: string; right?: boolean; feedback: string }>;
}

/** A case study: a run of decisions, each with optional evidence, shuffled choices and feedback. */
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
