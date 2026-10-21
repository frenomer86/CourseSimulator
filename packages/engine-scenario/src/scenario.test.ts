import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import {
  choiceAvailable,
  choose,
  createScenarioChecks,
  isFinished,
  reachableNodes,
  setAnswer,
  startScenario,
  validateScenario,
  viewEvidence,
  type ScenarioCheckState,
  type ScenarioSpec,
} from './index.js';

const spec: ScenarioSpec = {
  start: 'inbox',
  nodes: [
    {
      id: 'inbox',
      title: 'An email arrives',
      text: 'The bursar forwards you an email.',
      evidence: [{ id: 'email', title: 'The email', text: 'From: bank-secure@gnail.com ...', kind: 'email' }],
      choices: [
        { id: 'open', text: 'Open the attachment', next: 'infected', score: -3, flags: ['opened'] },
        { id: 'report', text: 'Report it to IT', next: 'reported', score: 3, flags: ['reported'], requires: ['email'], feedback: 'Good call.' },
      ],
    },
    { id: 'infected', title: 'Ransomware', text: 'Files are encrypted.', end: true, outcome: 'bad' },
    {
      id: 'reported',
      title: 'IT replies',
      text: 'Write what you will tell the bursar.',
      prompts: [{ id: 'advice', label: 'Your advice', minWords: 5 }],
      choices: [{ id: 'done', text: 'Send it', next: 'safe', score: 1 }],
    },
    { id: 'safe', title: 'All clear', text: 'Nothing was lost.', end: true, outcome: 'good' },
  ],
};

const checks = createScenarioChecks();
const lab = (specs: LabSpec['checks']): LabSpec<ScenarioCheckState> => ({
  id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E10', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1,
});
const withFinished = (s: ReturnType<typeof startScenario>): ScenarioCheckState => ({ ...s, finished: isFinished(spec, s) });

describe('scenario graph', () => {
  it('validates a well-formed scenario and rejects broken links', () => {
    expect(validateScenario(spec)).toBe(true);
    expect(validateScenario({ ...spec, start: 'nowhere' })).toBe(false);
    expect(validateScenario({ ...spec, nodes: [{ id: 'a', title: 'A', text: 'x', choices: [{ id: 'c', text: 't', next: 'missing' }] }] })).toBe(false);
    expect(validateScenario({ start: 'a', nodes: [{ id: 'a', title: 'A', text: 'dead end, not an ending' }] })).toBe(false);
    expect(reachableNodes(spec)).toEqual(new Set(['inbox', 'infected', 'reported', 'safe']));
  });

  it('gates choices on evidence, applies effects and records the path', () => {
    let s = startScenario(spec);
    const report = spec.nodes[0].choices![1];
    expect(choiceAvailable(report, s)).toBe(false);
    expect(choose(spec, s, 'report')).toBe(s); // not available yet
    s = viewEvidence(s, 'email');
    expect(choiceAvailable(report, s)).toBe(true);
    s = choose(spec, s, 'report');
    expect(s.current).toBe('reported');
    expect(s.score).toBe(3);
    expect(s.flags).toEqual(['reported']);
    expect(s.lastFeedback).toBe('Good call.');
    expect(s.path).toEqual([{ node: 'inbox', choice: 'report' }]);
    s = setAnswer(s, 'advice', 'Never open attachments from unknown senders; call the bank.');
    s = choose(spec, s, 'done');
    expect(isFinished(spec, s)).toBe(true);
    expect(s.score).toBe(4);
    expect(choose(spec, s, 'anything')).toBe(s);
  });
});

describe('scenario content in content/courses', () => {
  const root = join(__dirname, '../../../content/courses');
  const labs: Array<{ file: string; lab: LabSpec }> = [];
  for (const course of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory())) {
    for (const f of readdirSync(join(root, course)).filter((f) => f.endsWith('.json'))) {
      const lab = JSON.parse(readFileSync(join(root, course, f), 'utf8')) as LabSpec;
      if (lab.engine === 'E10') labs.push({ file: `${course}/${f}`, lab });
    }
  }
  for (const { file, lab } of labs) {
    it(`${file} has a valid, fully reachable scenario whose checks refer to real ids`, () => {
      const s = lab.config?.scenario;
      expect(validateScenario(s), 'scenario validates').toBe(true);
      const sc = s as ScenarioSpec;
      const reachable = reachableNodes(sc);
      for (const n of sc.nodes) expect(reachable.has(n.id), `node ${n.id} is reachable`).toBe(true);
      expect(sc.nodes.some((n) => n.end), 'has an ending').toBe(true);
      const choiceIds = new Set(sc.nodes.flatMap((n) => (n.choices ?? []).map((c) => c.id)));
      const evidenceIds = new Set(sc.nodes.flatMap((n) => (n.evidence ?? []).map((e) => e.id)));
      const promptIds = new Set(sc.nodes.flatMap((n) => (n.prompts ?? []).map((p) => p.id)));
      const flagIds = new Set(sc.nodes.flatMap((n) => (n.choices ?? []).flatMap((c) => c.flags ?? [])));
      for (const n of sc.nodes) for (const c of n.choices ?? []) for (const r of c.requires ?? []) expect(evidenceIds.has(r), `requires ${r}`).toBe(true);
      for (const c of lab.checks) {
        for (const id of [...((c.nodes as string[] | undefined) ?? [])]) expect(sc.nodes.some((n) => n.id === id), `check node ${id}`).toBe(true);
        for (const id of [...((c.choices as string[] | undefined) ?? []), ...((c.avoided as string[] | undefined) ?? [])]) expect(choiceIds.has(id), `check choice ${id}`).toBe(true);
        for (const id of [...((c.all as string[] | undefined) ?? []), ...((c.none as string[] | undefined) ?? [])]) expect(flagIds.has(id), `check flag ${id}`).toBe(true);
        for (const id of (c.evidence as string[] | undefined) ?? []) expect(evidenceIds.has(id), `check evidence ${id}`).toBe(true);
        if (c.prompt) expect(promptIds.has(String(c.prompt)), `check prompt ${String(c.prompt)}`).toBe(true);
      }
    });
  }
});

describe('scenario checks', () => {
  const good = (() => {
    let s = viewEvidence(startScenario(spec), 'email');
    s = choose(spec, s, 'report');
    s = setAnswer(s, 'advice', 'Never open attachments from unknown senders. Call the bank on the number on your card and report it to IT.');
    return withFinished(choose(spec, s, 'done'));
  })();
  const bad = withFinished(choose(spec, startScenario(spec), 'open'));

  it('judges endings, flags, scores and decisions', async () => {
    const r = await checks.run(
      lab([
        { type: 'scenario.finished', label: 'finished' },
        { type: 'scenario.reached', label: 'safe', nodes: ['safe'] },
        { type: 'scenario.flags', label: 'reported', all: ['reported'], none: ['opened'] },
        { type: 'scenario.score', label: 'score', min: 4 },
        { type: 'scenario.chose', label: 'chose', choices: ['report'], avoided: ['open'] },
        { type: 'scenario.examined', label: 'read', evidence: ['email'] },
      ]),
      good,
    );
    expect(r.passed).toBe(true);
    const r2 = await checks.run(lab([{ type: 'scenario.reached', label: 'safe', nodes: ['safe'] }, { type: 'scenario.flags', label: 'f', none: ['opened'] }, { type: 'scenario.examined', label: 'e', evidence: ['email'] }]), bad);
    expect(r2.checks.map((c) => c.passed)).toEqual([false, false, false]);
    expect(r2.checks[2].message).toMatch(/1 not yet examined/);
    const unfinished = await checks.run(lab([{ type: 'scenario.finished', label: 'f' }]), withFinished(startScenario(spec)));
    expect(unfinished.checks[0].message).toMatch(/not reached an ending/);
  });

  it('grades written answers against a rubric', async () => {
    const rubric = { type: 'scenario.rubric', label: 'advice', prompt: 'advice', patterns: ['attachment', 'bank', 'report|IT'], required: 2, minWords: 8 };
    expect((await checks.run(lab([rubric]), good)).passed).toBe(true);
    const short = await checks.run(lab([rubric]), { ...good, answers: { advice: 'Do not open it.' } });
    expect(short.checks[0].message).toBe('Write at least 8 words (you have 4).');
    const thin = await checks.run(lab([rubric]), { ...good, answers: { advice: 'Please be more careful in future with the emails you receive at work.' } });
    expect(thin.checks[0].message).toMatch(/covers 0 of the 2 points/);
  });
});
