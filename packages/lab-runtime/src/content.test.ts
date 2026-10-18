/**
 * Every topic check and lab in content/ must validate, and every check must be passable
 * with its own answer key (so a typo in a key cannot lock a topic).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLabSpec } from './index';
import { drawItems, gradeCheck, type CheckAnswer, type CheckItem, type TopicCheckSpec, validateTopicCheckSpec } from './topicCheck';

const CONTENT = join(__dirname, '../../../content/courses');

function keyedAnswer(item: CheckItem): CheckAnswer {
  switch (item.type) {
    case 'choice':
      return item.answer;
    case 'multi':
      return item.answer;
    case 'numeric':
      return String(item.answer);
    case 'text':
      return (item as { example?: string }).example ?? sampleFromPattern(item.pattern);
  }
}

/** Finds a string matching a simple pattern by trying the explanation's code spans or literal alternatives. */
function sampleFromPattern(pattern: string): string {
  // Patterns in our content are literals, optional prefixes (0*, (0x)?, 0?) or alternations of literals.
  const first = pattern.split('|')[0];
  return first
    .replace(/\(0x\)\?/g, '')
    .replace(/0\*/g, '')
    .replace(/0\?/g, '')
    .replace(/\\s\*|\\s\?/g, ' ')
    .replace(/\[·\*\]\?/g, '')
    .replace(/\[([^\]])[^\]]*\]/g, '$1')
    .replace(/\\\./g, '.')
    .replace(/0\*$/, '');
}

const courses = readdirSync(CONTENT).filter((d) => statSync(join(CONTENT, d)).isDirectory());

describe('lab content', () => {
  for (const course of courses) {
    const dir = join(CONTENT, course);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      it(`${course}/${f} is a valid lab spec`, () => {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        expect(validateLabSpec(raw)).toBe(true);
        expect(raw.course).toBe(course);
      });
    }
  }
});

describe('topic check content', () => {
  for (const course of courses) {
    const dir = join(CONTENT, course, 'checks');
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const spec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TopicCheckSpec;
      it(`${course}/checks/${f} validates and matches its file name`, () => {
        expect(validateTopicCheckSpec(spec)).toBe(true);
        expect(spec.course).toBe(course);
        expect(f).toBe(`${spec.unit}-${spec.topic}.json`);
        expect(spec.items.length).toBeGreaterThanOrEqual(8);
      });
      it(`${course}/checks/${f} passes with its own answer key, on several draws`, () => {
        for (const seed of [1, 2, 3, 4, 5]) {
          const items = drawItems(spec, seed);
          const answers = Object.fromEntries(items.map((it) => [it.id, keyedAnswer(it)]));
          const grade = gradeCheck(items, answers, spec.passMark);
          const wrong = grade.items.filter((g) => !g.correct).map((g) => g.id);
          expect(wrong, `items whose key does not match their own pattern: ${wrong.join(', ')}`).toEqual([]);
          expect(grade.passed).toBe(true);
          expect(grade.score).toBe(100);
        }
      });
      it(`${course}/checks/${f} gives a wrong answer no credit`, () => {
        const items = drawItems(spec, 7);
        const answers: Record<string, CheckAnswer> = Object.fromEntries(
          items.map((it) => [it.id, it.type === 'choice' ? (it.answer + 1) % it.options.length : it.type === 'multi' ? [] : 'nonsense']),
        );
        const grade = gradeCheck(items, answers, spec.passMark);
        expect(grade.correct).toBe(0);
        expect(grade.passed).toBe(false);
      });
    }
  }
});
