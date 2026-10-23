import type { LabSpec, TopicCheckSpec } from '@cslab/lab-runtime';
import { LEVEL_ORDER, validateLabSpec, validateTopicCheckSpec } from '@cslab/lab-runtime';
import coursesData from '@data/courses.json';
import taskMeta from '@cslab/task-bank/meta.json';
import { buildTask, loadCourse, parseTaskId, variantFor, type TemplateMeta } from '@cslab/task-bank';

export interface SyllabusUnit {
  title: string;
  weeks?: string;
  topics: string[];
}

/** One suggested simulation task for a week, at one of the three lab levels. `topic` is a "unit.topic" ref. */
export interface ScheduleTask {
  level: LabSpec['level'];
  topic: string;
  engine: string;
  title: string;
}

/** One teaching week: its syllabus topics as 1-based "unit.topic" refs, an exercise idea and simulation tasks. */
export interface ScheduleWeek {
  week: number;
  title: string;
  topics: string[];
  exercise: string;
  tasks: ScheduleTask[];
}

export type Tier = 'bachelor' | 'master' | 'phd';
export const TIER_ORDER: Tier[] = ['bachelor', 'master', 'phd'];
export const TIER_LABEL: Record<Tier, string> = { bachelor: "Bachelor's", master: "Master's", phd: 'Doctoral' };

export interface Course {
  slug: string;
  title: string;
  level: Tier;
  area: string;
  year: number;
  semester: number;
  engines: string[];
  topics: string[];
  phase: number;
  source: string;
  description?: string;
  modelledOn?: string[];
  outcomes?: string[];
  syllabus?: SyllabusUnit[];
  /** Number of teaching weeks; the schedule itself is loaded with loadSchedule. */
  weeks?: number;
}

/** One level of a programme: the award, its core courses, an elective pool and the non-course milestones. */
export interface ProgrammeLevel {
  award: string;
  years: number | string;
  core: string[];
  electives: string[];
  electivesRequired: number;
  milestones: string[];
}

/** A programme of study: an ordered list of courses. A course can belong to several programmes. */
export interface Programme {
  slug: string;
  title: string;
  description: string;
  outcomes: string[];
  /** Programmes the platform added beyond the ones first asked for. */
  recommended: boolean;
  /** The bachelor's courses: core first, then electives. */
  courses: string[];
  levels?: Record<Tier, ProgrammeLevel>;
}

interface CatalogueFile {
  areas: Record<string, string>;
  years: Record<string, string>;
  programmes: Programme[];
  courses: Course[];
}

const catalogue = coursesData as unknown as CatalogueFile;

export const AREAS: Record<string, string> = catalogue.areas;
export const AREA_ORDER = Object.keys(AREAS);
export const COURSES: Course[] = catalogue.courses;

export function courseBySlug(slug: string): Course | undefined {
  return COURSES.find((c) => c.slug === slug);
}

export const PROGRAMMES: Programme[] = catalogue.programmes;

export function programmeBySlug(slug: string): Programme | undefined {
  return PROGRAMMES.find((p) => p.slug === slug);
}

/** The programmes that include a course, in catalogue order. */
export function programmesForCourse(slug: string): Programme[] {
  return PROGRAMMES.filter((p) => programmeCourses(p).includes(slug));
}

/** Every course a programme uses, across all its levels. */
export function programmeCourses(p: Programme): string[] {
  if (!p.levels) return p.courses;
  const levels = p.levels;
  return [...new Set(TIER_ORDER.flatMap((t) => [...levels[t].core, ...levels[t].electives]))];
}

/* Weekly schedules live in data/syllabi/<slug>.json and load per course, so the catalogue bundle stays small. */
const scheduleModules = import.meta.glob('@data/syllabi/*.json', { import: 'schedule' }) as Record<
  string,
  () => Promise<ScheduleWeek[] | undefined>
>;

export async function loadSchedule(slug: string): Promise<ScheduleWeek[] | undefined> {
  const entry = Object.entries(scheduleModules).find(([file]) => file.endsWith(`/${slug}.json`));
  return entry ? entry[1]() : undefined;
}

/** A schedule ref ("2.3") resolved to its topic text. */
export function topicByRef(course: Course, ref: string): string | undefined {
  const [u, t] = ref.split('.').map(Number);
  return course.syllabus?.[u - 1]?.topics[t - 1];
}

export function coursesByArea(): Array<{ area: string; name: string; courses: Course[] }> {
  return AREA_ORDER.map((area) => ({
    area,
    name: AREAS[area],
    courses: COURSES.filter((c) => c.area === area).sort(
      (a, b) => a.year - b.year || a.semester - b.semester || a.title.localeCompare(b.title),
    ),
  }));
}

/* Labs are JSON files under content/courses/<course-slug>/. */
const labModules = import.meta.glob('@content/courses/*/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>;

/*
 * Task templates (packages/task-bank) add many generated tasks per topic. meta.json lists them for the
 * catalogue as light stubs; the full task (instructions, starting state, checks) is built on demand,
 * per variant, when a learner opens it. Ids are "<template>" (the learner's own variant) or
 * "<template>~<n>" (variant n).
 */
export interface TaskStub extends LabSpec {
  template: true;
  variants: number;
  summary: string;
}

const TASK_STUBS: TaskStub[] = (taskMeta as TemplateMeta[]).map((m) => ({
  id: m.id,
  course: m.course,
  unit: m.unit,
  topicIndex: m.topicIndex,
  topic: courseBySlug(m.course)?.syllabus?.[m.unit - 1]?.topics[m.topicIndex - 1] ?? m.title,
  level: m.level,
  engine: m.engine as LabSpec['engine'],
  title: m.title,
  instructions: m.summary,
  hints: [],
  checks: [],
  estimatedMinutes: m.estimatedMinutes,
  template: true,
  variants: m.variants,
  summary: m.summary,
}));

export const LABS: LabSpec[] = [...Object.values(labModules).filter(validateLabSpec), ...TASK_STUBS].sort(
  (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.id.localeCompare(b.id),
);

export function isTemplated(lab: LabSpec): lab is TaskStub {
  return (lab as Partial<TaskStub>).template === true;
}

/** The template id behind a task id ("x~7" → "x"); other lab ids are returned unchanged. */
export function baseLabId(id: string): string {
  return parseTaskId(id).template;
}

/**
 * Builds the full task for a templated lab id. Without "~n" the learner gets their own stable variant;
 * the built lab keeps the id it was opened with, so progress and group assignments use that id.
 */
export async function loadTemplatedLab(id: string, learnerKey: string | undefined): Promise<(LabSpec & { variant: number; variants: number }) | undefined> {
  const { template, variant } = parseTaskId(id);
  const stub = TASK_STUBS.find((s) => s.id === template);
  if (!stub) return undefined;
  const templates = await loadCourse(stub.course);
  const t = templates.find((x) => x.id === template);
  if (!t) return undefined;
  const n = variant ?? variantFor(template, learnerKey, stub.variants);
  const built = buildTask(t, n, id);
  delete (built as { solution?: string[] }).solution;
  return { ...built, topic: stub.topic };
}

export function labsForCourse(slug: string): LabSpec[] {
  return LABS.filter((l) => l.course === slug);
}

/** Labs attached to a syllabus topic (1-based unit and topic numbers). */
export function labsForTopic(slug: string, unit: number, topic: number): LabSpec[] {
  return LABS.filter((l) => l.course === slug && l.unit === unit && l.topicIndex === topic);
}

export function labsForUnit(slug: string, unit: number): LabSpec[] {
  return LABS.filter((l) => l.course === slug && l.unit === unit);
}

export function labById(id: string): LabSpec | undefined {
  const exact = LABS.find((l) => l.id === id);
  if (exact) return exact;
  const base = baseLabId(id);
  const stub = base !== id ? TASK_STUBS.find((s) => s.id === base) : undefined;
  return stub ? { ...stub, id } : undefined;
}

export function nextLab(current: LabSpec): LabSpec | undefined {
  const list = labsForCourse(current.course);
  const id = baseLabId(current.id);
  const i = list.findIndex((l) => l.id === id);
  return i >= 0 ? list[i + 1] : undefined;
}

/* Topic checks are JSON files under content/courses/<course-slug>/checks/<unit>-<topic>.json. */
const checkModules = import.meta.glob('@content/courses/*/checks/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>;

export const CHECKS: TopicCheckSpec[] = Object.values(checkModules).filter(validateTopicCheckSpec);

export function checkForTopic(slug: string, unit: number, topic: number): TopicCheckSpec | undefined {
  return CHECKS.find((c) => c.course === slug && c.unit === unit && c.topic === topic);
}

/** The syllabus unit at a 1-based position, with its number. */
export function unitOf(course: Course, unit: number): (SyllabusUnit & { number: number }) | undefined {
  const u = course.syllabus?.[unit - 1];
  return u ? { ...u, number: unit } : undefined;
}

export const ENGINE_NAMES: Record<string, string> = {
  E1: 'Code runner',
  E2: 'Circuit bench',
  E3: 'Network simulator',
  E4: 'Virtual machine',
  E5: 'Database engine',
  E6: 'Step visualiser',
  E7: 'Maths lab',
  E8: 'Hardware bench',
  E9: 'Diagram studio',
  E10: 'Case scenarios',
  E11: 'Phone emulator',
  E12: 'Cloud console',
};
