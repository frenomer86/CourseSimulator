/**
 * Every task template must attach to a real syllabus topic and be solvable in every variant we
 * sample: the starting state fails its checks and the reference solution passes them. Run with
 * UPDATE_TASK_META=1 to rewrite meta.json after adding templates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLabSpec, type LabSpec } from '@cslab/lab-runtime';
import { createShellChecks, runLines, systemFromInitial, type ShellState } from '@cslab/engine-shell';
import { choose, createScenarioChecks, currentNode, isFinished, startScenario, viewEvidence, type ScenarioCheckState, type ScenarioSpec } from '@cslab/engine-scenario';
import { buildTask, loadCourse, metaOf, TASK_COURSES, type TaskTemplate } from './index.js';

const ROOT = join(__dirname, '..', '..', '..');
const courses = JSON.parse(readFileSync(join(ROOT, 'data', 'courses.json'), 'utf8')) as { courses?: unknown[] } | unknown[];
const COURSE_LIST = (Array.isArray(courses) ? courses : (courses.courses ?? Object.values(courses))) as Array<{ slug: string; syllabus?: Array<{ topics?: unknown[] }> }>;

const all: TaskTemplate[] = [];
for (const c of TASK_COURSES) all.push(...(await loadCourse(c)));

function bestPath(lab: LabSpec): ScenarioCheckState {
  const spec = lab.config.scenario as ScenarioSpec;
  let s = startScenario(spec);
  for (let guard = 0; guard < 100 && !isFinished(spec, s); guard++) {
    const node = currentNode(spec, s);
    for (const e of node.evidence ?? []) s = viewEvidence(s, e.id);
    const best = [...(node.choices ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (!best) throw new Error(`node ${node.id} has no choices`);
    s = choose(spec, s, best.id);
  }
  return { ...s, finished: isFinished(spec, s) };
}

describe('task bank', () => {
  it('has templates with unique ids', () => {
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('meta.json matches the templates', () => {
    const meta = all.map(metaOf);
    const file = join(__dirname, '..', 'meta.json');
    if (process.env.UPDATE_TASK_META) writeFileSync(file, JSON.stringify(meta, null, 1) + '\n');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(meta);
  });

  it('Systems Administration I has beginner, intermediate and advanced tasks for every topic', () => {
    const course = COURSE_LIST.find((c) => c.slug === 'systems-administration-i')!;
    const missing: string[] = [];
    (course.syllabus ?? []).forEach((u, ui) =>
      (u.topics ?? []).forEach((_t, ti) => {
        for (const level of ['beginner', 'intermediate', 'advanced'])
          if (!all.some((t) => t.course === course.slug && t.unit === ui + 1 && t.topicIndex === ti + 1 && t.level === level)) missing.push(`u${ui + 1}t${ti + 1} ${level}`);
      }),
    );
    expect(missing).toEqual([]);
  });

  const shell = createShellChecks();
  const scenario = createScenarioChecks();

  for (const t of all) {
    describe(t.id, () => {
      it('attaches to a real topic', () => {
        const course = COURSE_LIST.find((c) => c.slug === t.course);
        expect(course, `course ${t.course}`).toBeDefined();
        expect(course!.syllabus?.[t.unit - 1]?.topics?.[t.topicIndex - 1], `u${t.unit} t${t.topicIndex}`).toBeDefined();
      });
      const variants = t.variants ?? 30;
      for (const n of [...new Set([1, 2, 3, variants])]) {
        it(`variant ${n}: valid, fails as given, passes with the reference solution`, async () => {
          const lab = buildTask(t, n);
          expect(validateLabSpec(lab), 'valid lab spec').toBe(true);
          if (t.engine === 'E4') {
            const start = systemFromInitial(lab.initialState);
            const before = await shell.run(lab as LabSpec<ShellState>, { system: start, history: [] });
            expect(before.passed, 'starter must not pass').toBe(false);
            const sys = systemFromInitial(lab.initialState);
            const out = runLines(sys, lab.solution ?? []);
            const r = await shell.run(lab as LabSpec<ShellState>, { system: sys, history: sys.history });
            const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
            if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}\n--- transcript ---\n${out.slice(-3000)}`);
          } else if (t.engine === 'E10') {
            const spec = lab.config.scenario as ScenarioSpec;
            const before = await scenario.run(lab, { ...startScenario(spec), finished: false } as ScenarioCheckState);
            expect(before.passed).toBe(false);
            const r = await scenario.run(lab, bestPath(lab));
            const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
            if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
          } else throw new Error(`no solver for engine ${t.engine}`);
        });
      }
      it('variants differ', () => {
        if ((t.variants ?? 30) < 2) return;
        const sig = (n: number) => { const x = buildTask(t, n); return JSON.stringify([x.instructions, x.initialState, x.config]); };
        const a = sig(1);
        const b = sig(2);
        expect(a === b, 'variant 1 and 2 are identical').toBe(false);
      });
    });
  }
});
