import { describe, expect, it } from 'vitest';
import {
  deriveMastery,
  describeSnapshot,
  maxMastery,
  mergeProgress,
  parseTopicKey,
  topicKey,
  validateProgressSnapshot,
  type ProgressRecords,
  type ProgressSnapshot,
} from './progress';

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

const device: ProgressRecords = {
  labs: { lab1: { passed: false, bestScore: 0.5, attempts: 2, hintsUsed: 1, lastAttemptAt: '2026-10-01T10:00:00Z' } },
  topics: { 'c:1:1': { mastery: 'attempted', updatedAt: '2026-10-01T10:00:00Z' } },
  checks: { 'c:1:1': { attempts: 1, bestScore: 50, passed: false, lastAttemptAt: '2026-10-01T10:00:00Z' } },
};

const file: ProgressSnapshot = {
  format: 'cslab-progress',
  version: 1,
  exportedAt: '2026-10-05T09:00:00Z',
  profile: { displayName: 'Ama' },
  labs: {
    lab1: { passed: true, bestScore: 1, attempts: 1, hintsUsed: 0, lastAttemptAt: '2026-10-03T10:00:00Z', completedAt: '2026-10-03T10:00:00Z' },
    lab2: { passed: true, bestScore: 1, attempts: 3, hintsUsed: 2, lastAttemptAt: '2026-10-04T10:00:00Z', completedAt: '2026-10-04T10:00:00Z' },
  },
  topics: {
    'c:1:1': { mastery: 'proficient', bestCheckScore: 83, updatedAt: '2026-10-03T10:00:00Z' },
    'c:1:2': { mastery: 'mastered', updatedAt: '2026-10-04T10:00:00Z' },
  },
  checks: { 'c:1:1': { attempts: 2, bestScore: 83, passed: true, lastAttemptAt: '2026-10-03T10:00:00Z' } },
};

describe('mergeProgress', () => {
  it('keeps the best of both sides and never lowers anything', () => {
    const merged = mergeProgress(device, file);
    expect(merged.labs.lab1).toEqual({
      passed: true,
      bestScore: 1,
      attempts: 2,
      hintsUsed: 1,
      lastAttemptAt: '2026-10-03T10:00:00Z',
      completedAt: '2026-10-03T10:00:00Z',
    });
    expect(merged.labs.lab2.passed).toBe(true);
    expect(merged.topics['c:1:1']).toEqual({ mastery: 'proficient', bestCheckScore: 83, updatedAt: '2026-10-03T10:00:00Z' });
    expect(merged.topics['c:1:2'].mastery).toBe('mastered');
    expect(merged.checks['c:1:1']).toEqual({ attempts: 2, bestScore: 83, passed: true, lastAttemptAt: '2026-10-03T10:00:00Z' });
    // The other direction gives the same result.
    expect(mergeProgress(file, device)).toEqual(merged);
  });

  it('describes a snapshot', () => {
    expect(describeSnapshot(file)).toEqual({ labsPassed: 2, topicsProficient: 2, checksPassed: 1 });
  });
});

describe('validateProgressSnapshot', () => {
  it('accepts a real export and rejects other files', () => {
    expect(validateProgressSnapshot(file)).toBe(true);
    expect(validateProgressSnapshot({ ...file, format: 'something-else' })).toBe(false);
    expect(validateProgressSnapshot({ ...file, topics: { x: { mastery: 'expert' } } })).toBe(false);
    expect(validateProgressSnapshot({ ...file, labs: [] })).toBe(false);
    expect(validateProgressSnapshot('{}')).toBe(false);
    expect(validateProgressSnapshot(null)).toBe(false);
  });
});
