import type { LabSpec, TopicCheckSpec } from '@cslab/lab-runtime';
import { LEVEL_ORDER, validateLabSpec, validateTopicCheckSpec } from '@cslab/lab-runtime';
import coursesData from '@data/courses.json';

export interface SyllabusUnit {
  title: string;
  weeks?: string;
  topics: string[];
}

export interface Course {
  slug: string;
  title: string;
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
}

/** A programme of study: an ordered list of courses. A course can belong to several programmes. */
export interface Programme {
  slug: string;
  title: string;
  description: string;
  outcomes: string[];
  /** Programmes the platform added beyond the ones first asked for. */
  recommended: boolean;
  courses: string[];
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
  return PROGRAMMES.filter((p) => p.courses.includes(slug));
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

export const LABS: LabSpec[] = Object.values(labModules)
  .filter(validateLabSpec)
  .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.id.localeCompare(b.id));

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
  return LABS.find((l) => l.id === id);
}

export function nextLab(current: LabSpec): LabSpec | undefined {
  const list = labsForCourse(current.course);
  const i = list.findIndex((l) => l.id === current.id);
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
