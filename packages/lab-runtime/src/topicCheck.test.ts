import { describe, expect, it } from 'vitest';
import {
  drawItems,
  gradeCheck,
  gradeItem,
  parseNumber,
  validateTopicCheckSpec,
  type CheckItem,
  type TopicCheckSpec,
} from './topicCheck';

const items: CheckItem[] = [
  { id: 'c1', type: 'choice', prompt: 'Pick', options: ['a', 'b', 'c'], answer: 1 },
  { id: 'm1', type: 'multi', prompt: 'Pick all', options: ['a', 'b', 'c', 'd'], answer: [0, 2] },
  { id: 'n1', type: 'numeric', prompt: 'Number', answer: 45 },
  { id: 'n2', type: 'numeric', prompt: 'Approx', answer: 3.3, tolerance: 0.05, unit: 'V' },
  { id: 't1', type: 'text', prompt: 'Binary', pattern: '0*101101' },
  { id: 't2', type: 'text', prompt: 'Hex', pattern: '(0x)?2d', flags: 'i' },
  { id: 'c2', type: 'choice', prompt: 'Pick', options: ['x', 'y'], answer: 0 },
  { id: 'c3', type: 'choice', prompt: 'Pick', options: ['x', 'y'], answer: 0 },
  { id: 'c4', type: 'choice', prompt: 'Pick', options: ['x', 'y'], answer: 0 },
  { id: 'c5', type: 'choice', prompt: 'Pick', options: ['x', 'y'], answer: 0 },
];

const spec: TopicCheckSpec = { course: 'demo', unit: 1, topic: 1, title: 'Demo', draw: 6, items };

describe('validateTopicCheckSpec', () => {
  it('accepts a well-formed pool', () => {
    expect(validateTopicCheckSpec(spec)).toBe(true);
  });
  it('rejects pools with fewer than five items, duplicate ids or bad answers', () => {
    expect(validateTopicCheckSpec({ ...spec, items: items.slice(0, 4) })).toBe(false);
    expect(validateTopicCheckSpec({ ...spec, items: [...items, items[0]] })).toBe(false);
    expect(validateTopicCheckSpec({ ...spec, items: [...items.slice(1), { ...items[0], answer: 7 }] })).toBe(false);
    expect(validateTopicCheckSpec({ ...spec, items: [...items.slice(1), { id: 'bad', type: 'text', prompt: 'p', pattern: '(' }] })).toBe(false);
  });
});

describe('drawItems', () => {
  it('draws the requested number without repeats and is reproducible by seed', () => {
    const a = drawItems(spec, 42);
    const b = drawItems(spec, 42);
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a).toHaveLength(6);
    expect(new Set(a.map((i) => i.id)).size).toBe(6);
  });
  it('clamps the draw to between 5 and 8 and to the pool size', () => {
    expect(drawItems({ ...spec, draw: 2 }, 1)).toHaveLength(5);
    expect(drawItems({ ...spec, draw: 20 }, 1)).toHaveLength(8);
    expect(drawItems({ ...spec, draw: 8, items: items.slice(0, 6) }, 1)).toHaveLength(6);
  });
  it('varies between seeds so retakes differ', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => drawItems(spec, s).map((i) => i.id).join(','));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe('parseNumber', () => {
  it('reads decimal, binary, hex and spaced digits', () => {
    expect(parseNumber('45')).toBe(45);
    expect(parseNumber(' 1 0110 ')).toBe(10110);
    expect(parseNumber('0b101101')).toBe(45);
    expect(parseNumber('0x2D')).toBe(45);
    expect(parseNumber('-3.5')).toBe(-3.5);
    expect(parseNumber('1,024')).toBe(1024);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

describe('gradeItem', () => {
  it('grades multiple choice', () => {
    expect(gradeItem(items[0], 1).correct).toBe(true);
    expect(gradeItem(items[0], 0).correct).toBe(false);
    expect(gradeItem(items[0], undefined)).toEqual({ id: 'c1', correct: false, blank: true });
  });
  it('grades multiple select as an exact set', () => {
    expect(gradeItem(items[1], [2, 0]).correct).toBe(true);
    expect(gradeItem(items[1], [0]).correct).toBe(false);
    expect(gradeItem(items[1], [0, 2, 3]).correct).toBe(false);
    expect(gradeItem(items[1], []).blank).toBe(true);
  });
  it('grades numeric with and without tolerance', () => {
    expect(gradeItem(items[2], '45').correct).toBe(true);
    expect(gradeItem(items[2], '0b101101').correct).toBe(true);
    expect(gradeItem(items[2], '44').correct).toBe(false);
    expect(gradeItem(items[3], '3.26').correct).toBe(true);
    expect(gradeItem(items[3], '3.4').correct).toBe(false);
    expect(gradeItem(items[3], 'three').correct).toBe(false);
  });
  it('grades text by full-match pattern', () => {
    expect(gradeItem(items[4], ' 101101 ').correct).toBe(true);
    expect(gradeItem(items[4], '00101101').correct).toBe(true);
    expect(gradeItem(items[4], '1011010').correct).toBe(false);
    expect(gradeItem(items[5], '0x2d').correct).toBe(true);
    expect(gradeItem(items[5], '2D').correct).toBe(true);
    expect(gradeItem(items[5], '2E').correct).toBe(false);
  });
});

describe('gradeCheck', () => {
  it('scores as a percentage and applies the pass mark', () => {
    const drawn = items.slice(0, 6);
    const grade = gradeCheck(drawn, { c1: 1, m1: [0, 2], n1: '45', n2: '3.3', t1: '101101', t2: 'zz' });
    expect(grade.correct).toBe(5);
    expect(grade.total).toBe(6);
    expect(grade.score).toBe(83.33);
    expect(grade.passed).toBe(true);
    expect(gradeCheck(drawn, { c1: 1, m1: [0, 2], n1: '45' }).passed).toBe(false);
    expect(gradeCheck(drawn, { c1: 1, m1: [0, 2], n1: '45', n2: '3.3' }, 60).passed).toBe(true);
  });
});
