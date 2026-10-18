/**
 * Mastery rules and the progress snapshot format shared by the app store, the export/import
 * feature and the tests. Topics are identified by course slug plus 1-based unit and topic
 * numbers, which is also how the content files key them.
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

/** The higher of two mastery states. Merging two devices' progress resolves this way. */
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

/* ------------------------------------------------------------------------------------- */
/* Progress records and the snapshot that export/import moves between devices.            */

export interface LabProgress {
  passed: boolean;
  bestScore: number;
  attempts: number;
  hintsUsed: number;
  lastAttemptAt: string;
  completedAt?: string;
}

export interface TopicProgress {
  mastery: Mastery;
  /** Best topic-check score, 0..100. */
  bestCheckScore?: number;
  updatedAt: string;
}

export interface CheckProgress {
  attempts: number;
  bestScore: number;
  passed: boolean;
  lastAttemptAt: string;
}

export interface ProgressRecords {
  labs: Record<string, LabProgress>;
  topics: Record<string, TopicProgress>;
  checks: Record<string, CheckProgress>;
}

export interface ProgressSnapshot extends ProgressRecords {
  format: 'cslab-progress';
  version: 1;
  exportedAt: string;
  profile?: { displayName: string; avatarUrl?: string };
}

function later(a: string | undefined, b: string | undefined): string {
  if (!a) return b ?? '';
  if (!b) return a;
  return a > b ? a : b;
}

/** Merges two sets of records, keeping the best of each: passed wins, scores and mastery take the max. */
export function mergeProgress(a: ProgressRecords, b: ProgressRecords): ProgressRecords {
  const labs: Record<string, LabProgress> = { ...a.labs };
  for (const [id, r] of Object.entries(b.labs)) {
    const p = labs[id];
    labs[id] = p
      ? {
          passed: p.passed || r.passed,
          bestScore: Math.max(p.bestScore, r.bestScore),
          attempts: Math.max(p.attempts, r.attempts),
          hintsUsed: Math.max(p.hintsUsed, r.hintsUsed),
          lastAttemptAt: later(p.lastAttemptAt, r.lastAttemptAt),
          completedAt: p.completedAt && r.completedAt ? (p.completedAt < r.completedAt ? p.completedAt : r.completedAt) : (p.completedAt ?? r.completedAt),
        }
      : r;
  }
  const checks: Record<string, CheckProgress> = { ...a.checks };
  for (const [key, r] of Object.entries(b.checks)) {
    const p = checks[key];
    checks[key] = p
      ? {
          attempts: Math.max(p.attempts, r.attempts),
          bestScore: Math.max(p.bestScore, r.bestScore),
          passed: p.passed || r.passed,
          lastAttemptAt: later(p.lastAttemptAt, r.lastAttemptAt),
        }
      : r;
  }
  const topics: Record<string, TopicProgress> = { ...a.topics };
  for (const [key, r] of Object.entries(b.topics)) {
    const p = topics[key];
    if (!p) {
      topics[key] = r;
      continue;
    }
    const best = Math.max(p.bestCheckScore ?? 0, r.bestCheckScore ?? 0);
    topics[key] = {
      mastery: maxMastery(p.mastery, r.mastery),
      bestCheckScore: best > 0 ? best : undefined,
      updatedAt: later(p.updatedAt, r.updatedAt),
    };
  }
  return { labs, topics, checks };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Checks an imported file loosely enough to accept older exports, strictly enough to reject junk. */
export function validateProgressSnapshot(raw: unknown): raw is ProgressSnapshot {
  if (!isRecord(raw)) return false;
  if (raw.format !== 'cslab-progress' || raw.version !== 1) return false;
  if (!isRecord(raw.labs) || !isRecord(raw.topics) || !isRecord(raw.checks)) return false;
  for (const v of Object.values(raw.labs)) {
    if (!isRecord(v) || typeof v.passed !== 'boolean' || typeof v.bestScore !== 'number' || typeof v.attempts !== 'number') return false;
  }
  for (const v of Object.values(raw.topics)) {
    if (!isRecord(v) || !MASTERY_ORDER.includes(v.mastery as Mastery)) return false;
  }
  for (const v of Object.values(raw.checks)) {
    if (!isRecord(v) || typeof v.passed !== 'boolean' || typeof v.bestScore !== 'number') return false;
  }
  if (raw.profile !== undefined && (!isRecord(raw.profile) || typeof raw.profile.displayName !== 'string')) return false;
  return true;
}

/** A summary of what an import would add, for the confirmation message. */
export function describeSnapshot(s: ProgressRecords): { labsPassed: number; topicsProficient: number; checksPassed: number } {
  return {
    labsPassed: Object.values(s.labs).filter((l) => l.passed).length,
    topicsProficient: Object.values(s.topics).filter((t) => masteryRank(t.mastery) >= 2).length,
    checksPassed: Object.values(s.checks).filter((c) => c.passed).length,
  };
}
