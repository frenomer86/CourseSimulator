/**
 * The task bank: lazily loaded course modules of task templates, and the builder that turns a
 * template id plus a variant number into a lab. Task ids look like "<template-id>" (variant chosen
 * by the caller) or "<template-id>~<n>" (variant n).
 */

import type { LabSpec } from '@cslab/lab-runtime';
import { Variant, type BuiltTask, type TaskTemplate, type TemplateMeta } from './types.js';

export * from './types.js';

/** Course slug → module loader. Each module exports TEMPLATES. */
const LOADERS: Record<string, () => Promise<{ TEMPLATES: TaskTemplate[] }>> = {
  'systems-administration-i': () => import('./sa1/index.js'),
  'systems-administration-ii': () => import('./sa2/index.js'),
  'scripting-and-it-automation': () => import('./sia/index.js'),
  'version-control-and-devops': () => import('./vcd/index.js'),
};

export const TASK_COURSES = Object.keys(LOADERS);

export async function loadCourse(course: string): Promise<TaskTemplate[]> {
  const load = LOADERS[course];
  return load ? (await load()).TEMPLATES : [];
}

export function parseTaskId(id: string): { template: string; variant?: number } {
  const m = /^(.*)~(\d+)$/.exec(id);
  return m ? { template: m[1], variant: Number(m[2]) } : { template: id };
}

export const DEFAULT_VARIANTS = 30;

export function metaOf(t: TaskTemplate): TemplateMeta {
  const { build: _build, variants, ...rest } = t;
  void _build;
  return { ...rest, variants: variants ?? DEFAULT_VARIANTS };
}

/** Builds variant `n` (1-based) of a template as a complete lab with id `id`. */
export function buildTask(t: TaskTemplate, n: number, id = n === 1 ? t.id : `${t.id}~${n}`): LabSpec & { solution?: string[]; variant: number; variants: number } {
  const variants = t.variants ?? DEFAULT_VARIANTS;
  const v = new Variant(t.id, ((n - 1) % variants) + 1);
  const b: BuiltTask = t.build(v);
  return {
    id,
    course: t.course,
    unit: t.unit,
    topicIndex: t.topicIndex,
    level: t.level,
    engine: t.engine,
    title: b.title ?? t.title,
    estimatedMinutes: t.estimatedMinutes,
    instructions: b.instructions,
    hints: b.hints,
    checks: b.checks,
    config: b.config ?? {},
    initialState: b.initialState ?? {},
    ...(b.realityNote ? { realityNote: b.realityNote } : {}),
    ...(b.solution ? { solution: b.solution } : {}),
    variant: v.n,
    variants,
  } as LabSpec & { solution?: string[]; variant: number; variants: number };
}

/** The variant a learner gets when opening a task without ~n: stable per learner. */
export function variantFor(templateId: string, learnerKey: string | undefined, variants = DEFAULT_VARIANTS): number {
  if (!learnerKey) return 1;
  let h = 2166136261;
  for (const c of `${templateId}|${learnerKey}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % variants) + 1;
}
