/**
 * Shapes shared with the web app (apps/web/src/lib/api.ts mirrors these). Kept here by hand so
 * the API has no runtime dependency on the browser packages.
 */

export type Mastery = 'not_started' | 'attempted' | 'proficient' | 'mastered';
export type LabLevel = 'beginner' | 'intermediate' | 'advanced';
export type AgeBand = 'under_18' | '18_plus' | 'undisclosed';

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Profile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  ageBand: AgeBand;
  showOnBoards: boolean;
  xp: number;
  level: number;
}

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
  bestCheckScore?: number;
  updatedAt: string;
}

export interface CheckProgress {
  attempts: number;
  bestScore: number;
  passed: boolean;
  lastAttemptAt: string;
}

/** The same shape the browser keeps, so the client merges it with one function. */
export interface ProgressRecords {
  labs: Record<string, LabProgress>;
  topics: Record<string, TopicProgress>;
  checks: Record<string, CheckProgress>;
}

export function levelFromXp(xp: number): number {
  return Math.max(1, Math.floor(Math.sqrt(xp / 50)) + 1);
}

export const XP = { beginner: 10, intermediate: 25, advanced: 50, check: 15 } as const;
