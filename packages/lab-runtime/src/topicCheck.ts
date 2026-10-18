/**
 * Topic checks: small auto-graded item pools stored as JSON under
 * content/courses/<course>/checks/<unit>-<topic>.json. Grading runs in the browser.
 */

export interface CheckItemBase {
  id: string;
  /** Markdown. */
  prompt: string;
  /** Shown after grading. Markdown. */
  explanation?: string;
}

export interface ChoiceItem extends CheckItemBase {
  type: 'choice';
  options: string[];
  /** Index into options. */
  answer: number;
}

export interface MultiItem extends CheckItemBase {
  type: 'multi';
  options: string[];
  /** Indices into options; every one must be chosen and nothing else. */
  answer: number[];
}

export interface NumericItem extends CheckItemBase {
  type: 'numeric';
  answer: number;
  /** Absolute tolerance. Defaults to 0. */
  tolerance?: number;
  /** Shown after the input, e.g. "V" or "bits". */
  unit?: string;
}

export interface TextItem extends CheckItemBase {
  type: 'text';
  /** A regular expression the trimmed answer must match in full. */
  pattern: string;
  /** Regex flags, e.g. "i". */
  flags?: string;
  placeholder?: string;
}

export type CheckItem = ChoiceItem | MultiItem | NumericItem | TextItem;

export interface TopicCheckSpec {
  course: string;
  unit: number;
  topic: number;
  title: string;
  /** How many items a sitting draws from the pool (clamped to 5..8). */
  draw?: number;
  /** Percent needed to pass. Defaults to 65 (four of six). */
  passMark?: number;
  items: CheckItem[];
}

/** What the learner entered: an option index, a set of indices, or raw text. */
export type CheckAnswer = number | number[] | string | null | undefined;

export interface ItemGrade {
  id: string;
  correct: boolean;
  /** True when the learner left it blank. */
  blank: boolean;
}

export interface CheckGrade {
  score: number; // 0..100, rounded to 2 dp
  passed: boolean;
  correct: number;
  total: number;
  items: ItemGrade[];
}

export const CHECK_MIN_ITEMS = 5;
export const CHECK_MAX_ITEMS = 8;
export const DEFAULT_PASS_MARK = 65;

export function validateTopicCheckSpec(raw: unknown): raw is TopicCheckSpec {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  if (typeof s.course !== 'string' || typeof s.title !== 'string') return false;
  if (!Number.isInteger(s.unit) || !Number.isInteger(s.topic)) return false;
  if (!Array.isArray(s.items) || s.items.length < CHECK_MIN_ITEMS) return false;
  const ids = new Set<string>();
  for (const it of s.items as Array<Record<string, unknown>>) {
    if (!it || typeof it.id !== 'string' || typeof it.prompt !== 'string') return false;
    if (ids.has(it.id)) return false;
    ids.add(it.id);
    switch (it.type) {
      case 'choice':
        if (!Array.isArray(it.options) || it.options.length < 2) return false;
        if (!Number.isInteger(it.answer) || (it.answer as number) < 0 || (it.answer as number) >= it.options.length) return false;
        break;
      case 'multi': {
        if (!Array.isArray(it.options) || it.options.length < 2) return false;
        if (!Array.isArray(it.answer) || it.answer.length === 0) return false;
        const n = it.options.length;
        if (!(it.answer as unknown[]).every((a) => Number.isInteger(a) && (a as number) >= 0 && (a as number) < n)) return false;
        break;
      }
      case 'numeric':
        if (typeof it.answer !== 'number' || !Number.isFinite(it.answer)) return false;
        if (it.tolerance !== undefined && (typeof it.tolerance !== 'number' || it.tolerance < 0)) return false;
        break;
      case 'text':
        if (typeof it.pattern !== 'string') return false;
        try {
          new RegExp(it.pattern, (it.flags as string | undefined) ?? '');
        } catch {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Deterministic PRNG so a sitting can be reproduced from its seed (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a sitting from the pool: between 5 and 8 items, shuffled, no repeats. */
export function drawItems(spec: TopicCheckSpec, seed: number = Date.now()): CheckItem[] {
  const want = Math.max(CHECK_MIN_ITEMS, Math.min(CHECK_MAX_ITEMS, spec.draw ?? 6));
  const count = Math.min(want, spec.items.length);
  const random = rng(seed);
  const pool = spec.items.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** Parses "1 101", "0b1101", "0x2D", "1,024", "3.5e2" and plain numbers. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/[\s,_]/g, '');
  if (s === '') return null;
  if (/^0b[01]+$/i.test(s)) return parseInt(s.slice(2), 2);
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  return null;
}

export function isBlank(item: CheckItem, answer: CheckAnswer): boolean {
  if (answer === null || answer === undefined) return true;
  switch (item.type) {
    case 'choice':
      return typeof answer !== 'number';
    case 'multi':
      return !Array.isArray(answer) || answer.length === 0;
    case 'numeric':
    case 'text':
      return typeof answer !== 'string' || answer.trim() === '';
  }
}

export function gradeItem(item: CheckItem, answer: CheckAnswer): ItemGrade {
  const blank = isBlank(item, answer);
  if (blank) return { id: item.id, correct: false, blank };
  let correct = false;
  switch (item.type) {
    case 'choice':
      correct = answer === item.answer;
      break;
    case 'multi': {
      const got = [...new Set(answer as number[])].sort((a, b) => a - b);
      const want = [...new Set(item.answer)].sort((a, b) => a - b);
      correct = got.length === want.length && got.every((v, i) => v === want[i]);
      break;
    }
    case 'numeric': {
      const n = parseNumber(answer as string);
      correct = n !== null && Math.abs(n - item.answer) <= (item.tolerance ?? 0) + 1e-9;
      break;
    }
    case 'text': {
      const re = new RegExp(`^(?:${item.pattern})$`, item.flags ?? '');
      correct = re.test((answer as string).trim());
      break;
    }
  }
  return { id: item.id, correct, blank };
}

export function gradeCheck(
  items: CheckItem[],
  answers: Record<string, CheckAnswer>,
  passMark = DEFAULT_PASS_MARK,
): CheckGrade {
  const grades = items.map((it) => gradeItem(it, answers[it.id]));
  const correct = grades.filter((g) => g.correct).length;
  const total = items.length;
  const score = total === 0 ? 0 : Math.round((correct / total) * 10000) / 100;
  return { score, passed: total > 0 && score >= passMark, correct, total, items: grades };
}
