import { describe, expect, it } from 'vitest';
import { deriveMastery, maxMastery, parseTopicKey, topicKey } from './progress';

describe('mastery', () => {
  it('resolves to the highest state', () => {
    expect(maxMastery('attempted', 'proficient')).toBe('proficient');
    expect(maxMastery('mastered', 'proficient')).toBe('mastered');
    expect(maxMastery(undefined, 'attempted')).toBe('attempted');
    expect(maxMastery(null, undefined)).toBe('not_started');
  });

  it('derives mastery from labs and checks per the spec', () => {
    expect(deriveMastery({})).toBe('not_started');
    expect(deriveMastery({ attempted: true })).toBe('attempted');
    expect(deriveMastery({ passedLevels: ['beginner'] })).toBe('attempted');
    expect(deriveMastery({ checkPassed: true, bestCheckScore: 70 })).toBe('proficient');
    expect(deriveMastery({ passedLevels: ['intermediate'], checkPassed: true, bestCheckScore: 83 })).toBe('proficient');
    expect(deriveMastery({ passedLevels: ['intermediate'], checkPassed: true, bestCheckScore: 100 })).toBe('mastered');
    expect(deriveMastery({ passedLevels: ['advanced'] })).toBe('mastered');
  });

  it('round-trips topic keys', () => {
    const key = topicKey('digital-logic-design', 2, 3);
    expect(key).toBe('digital-logic-design:2:3');
    expect(parseTopicKey(key)).toEqual({ course: 'digital-logic-design', unit: 2, topic: 3 });
    expect(parseTopicKey('nonsense')).toBeNull();
  });
});
