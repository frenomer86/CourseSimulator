/**
 * Task templates: one template per (topic, level) idea, producing as many variants as it needs.
 * Each variant is a complete lab (LabSpec) built from a seeded random source, so the same id and
 * variant number always give the same task, and different students can get different values.
 */

import type { CheckSpec, LabLevel } from '@cslab/lab-runtime';

export interface TemplateMeta {
  id: string;
  course: string;
  unit: number;
  topicIndex: number;
  level: LabLevel;
  title: string;
  engine: string;
  estimatedMinutes: number;
  variants: number;
  summary: string;
}

export interface BuiltTask {
  title?: string;
  instructions: string;
  hints: string[];
  checks: CheckSpec[];
  config?: Record<string, unknown>;
  initialState?: Record<string, unknown>;
  realityNote?: string;
  /** Terminal labs: the reference transcript the content test runs. Not shown to learners. */
  solution?: string[];
}

export interface TaskTemplate extends Omit<TemplateMeta, 'variants'> {
  variants?: number;
  build(v: Variant): BuiltTask;
}

/* ----------------------------------------------------------------------------- variants */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVEN = ['Ama', 'Kofi', 'Kwame', 'Abena', 'Yaw', 'Akosua', 'Kwesi', 'Efua', 'Kojo', 'Adwoa', 'Kwabena', 'Afua', 'Yaa', 'Kweku', 'Esi', 'Fiifi', 'Selorm', 'Elikem', 'Dzifa', 'Mawuli', 'Nana', 'Akua', 'Fatima', 'Abdul', 'Zainab', 'Ibrahim', 'Aisha', 'Musah', 'Naa', 'Nii', 'Korkor', 'Delali', 'Edem', 'Sena', 'Yayra', 'Baaba', 'Ekow', 'Araba', 'Kobina', 'Adjoa'];
const SURNAME = ['Mensah', 'Boateng', 'Owusu', 'Asante', 'Osei', 'Agyeman', 'Amoah', 'Darko', 'Tetteh', 'Quaye', 'Addo', 'Ansah', 'Appiah', 'Badu', 'Frimpong', 'Gyamfi', 'Kusi', 'Nkansah', 'Opoku', 'Sarpong', 'Yeboah', 'Agbeko', 'Kpodo', 'Dzokoto', 'Abdulai', 'Iddrisu', 'Mahama', 'Alhassan', 'Lamptey', 'Ankrah', 'Quartey', 'Annan', 'Sackey', 'Arthur', 'Essien', 'Bonsu', 'Acheampong', 'Antwi', 'Ofori', 'Wiredu'];
const DEPTS = ['Finance', 'Registry', 'Library', 'Procurement', 'Human Resources', 'Estates', 'Admissions', 'Examinations', 'Health Services', 'Internal Audit', 'Research', 'Student Affairs'];
const FACULTIES = ['Applied Sciences', 'Engineering', 'Business', 'Health Sciences', 'Built Environment', 'Art and Design', 'Education', 'Agriculture'];
const CITIES = ['Accra', 'Kumasi', 'Tamale', 'Ho', 'Takoradi', 'Cape Coast', 'Koforidua', 'Sunyani', 'Bolgatanga', 'Wa'];
const PRINTERS = ['HP Universal Printing PCL 6', 'Canon Generic Plus PCL6', 'Kyocera Classic Universaldriver PCL6', 'Xerox Global Print Driver PCL6'];

export interface Person {
  given: string;
  surname: string;
  name: string;
  sam: string;
}

export class Variant {
  readonly n: number;
  private rnd: () => number;
  private usedSams = new Set<string>();

  constructor(templateId: string, n: number) {
    this.n = n;
    this.rnd = mulberry32(hash(`${templateId}#${n}`));
  }

  random(): number {
    return this.rnd();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.rnd() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rnd() * items.length)];
  }
  /** `k` distinct items. */
  some<T>(items: readonly T[], k: number): T[] {
    const copy = [...items];
    const out: T[] = [];
    while (out.length < k && copy.length) out.push(copy.splice(Math.floor(this.rnd() * copy.length), 1)[0]);
    return out;
  }
  person(): Person {
    for (;;) {
      const given = this.pick(GIVEN);
      const surname = this.pick(SURNAME);
      const sam = `${given[0]}${surname}`.toLowerCase();
      if (this.usedSams.has(sam)) continue;
      this.usedSams.add(sam);
      return { given, surname, name: `${given} ${surname}`, sam };
    }
  }
  people(k: number): Person[] {
    return Array.from({ length: k }, () => this.person());
  }
  dept(): string {
    return this.pick(DEPTS);
  }
  depts(k: number): string[] {
    return this.some(DEPTS, k);
  }
  faculties(k: number): string[] {
    return this.some(FACULTIES, k);
  }
  city(): string {
    return this.pick(CITIES);
  }
  cities(k: number): string[] {
    return this.some(CITIES, k);
  }
  driver(): string {
    return this.pick(PRINTERS);
  }
  /** A /24 network as "10.A.B". */
  net(): string {
    return `10.${this.int(1, 60)}.${this.int(0, 250)}`;
  }
  /** A password that meets the default complexity rules. */
  password(): string {
    return `${this.pick(['Kente', 'Volta', 'Akwaaba', 'Sankofa', 'Adinkra', 'Gye', 'Nyame', 'Ashanti'])}@${this.int(2024, 2030)}!`;
  }
}

/** Short alias for building checks. */
export type Check = CheckSpec;
