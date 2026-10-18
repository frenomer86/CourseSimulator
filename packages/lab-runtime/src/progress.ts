/**
 * Mastery rules shared by the app store, the sync layer and the tests.
 * Topics are identified by course slug plus 1-based unit and topic numbers,
 * which is also how the database (topic_progress) and the content files key them.
 */

import type { LabLevel } from './index';

export type Mastery = 'not_started' | 'attempted' | 'proficient' | 'mastered';

export const MASTERY_ORDER: Mastery[] = ['not_started', 'attempted', 'proficient', 'mastered'];

export const MASTERY_LABEL: Record<Mastery, string> = {
  not_started: 'Not started',
  attempted: 'Attempted',
  proficient: 'Proficient',
  mastered: 'Mastered',
};

export function masteryRank(m: Mastery | undefined | null): number {
  return m ? MASTERY_ORDER.indexOf(m) : 0;
}

/** The higher of two mastery states. Conflicts between devices resolve this way. */
export function maxMastery(a: Mastery | undefined | null, b: Mastery | undefined | null): Mastery {
  return masteryRank(a) >= masteryRank(b) ? (a ?? 'not_started') : (b ?? 'not_started');
}

export function topicKey(course: string, unit: number, topic: number): string {
  return `${course}:${unit}:${topic}`;
}

export function parseTopicKey(key: string): { course: string; unit: number; topic: number } | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  return { course: m[1], unit: Number(m[2]), topic: Number(m[3]) };
}

export interface TopicEvidence {
  /** Best topic-check score so far, 0..100. */
  bestCheckScore?: number;
  /** Whether any topic check was passed. */
  checkPassed?: boolean;
  /** Lab levels passed on this topic. */
  passedLevels?: LabLevel[];
  /** Whether anything at all was attempted (a lab run or a check). */
  attempted?: boolean;
}

/**
 * Derives mastery from the evidence per the product spec:
 *   attempted   any lab attempt or check attempt
 *   proficient  topic check passed
 *   mastered    Advanced lab passed, or Intermediate lab passed plus a check at 100%
 */
export function deriveMastery(e: TopicEvidence): Mastery {
  const levels = e.passedLevels ?? [];
  if (levels.includes('advanced')) return 'mastered';
  if (levels.includes('intermediate') && (e.bestCheckScore ?? 0) >= 100) return 'mastered';
  if (e.checkPassed) return 'proficient';
  if (e.attempted || levels.length > 0 || (e.bestCheckScore ?? 0) > 0) return 'attempted';
  return 'not_started';
}
