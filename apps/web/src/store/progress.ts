/**
 * Local progress: everything the learner has done, kept in this browser.
 *
 * The app is self-contained, so this store is the only record. Learners can export it as a
 * file from the profile page and import it on another device; imports merge by keeping the
 * best of each value (see mergeProgress in @cslab/lab-runtime).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  deriveMastery,
  maxMastery,
  mergeProgress,
  topicKey,
  type CheckProgress,
  type LabLevel,
  type LabProgress,
  type LabResult,
  type LabSpec,
  type Mastery,
  type ProgressRecords,
  type TopicProgress,
} from '@cslab/lab-runtime';
import { LABS } from '../lib/catalogue';

export type { LabProgress, TopicProgress, CheckProgress };

export interface ProgressState extends ProgressRecords {
  /** Saved simulator state per lab so learners can resume. */
  workspaces: Record<string, unknown>;

  recordResult: (lab: LabSpec, result: LabResult, hintsUsed: number) => void;
  recordCheck: (course: string, unit: number, topic: number, score: number, passed: boolean) => void;
  saveWorkspace: (labId: string, state: unknown) => void;
  clearWorkspace: (labId: string) => void;
  /** Merges records from an exported file, keeping the best of each value. */
  importRecords: (records: ProgressRecords) => void;
  reset: () => void;
}

const EMPTY: ProgressRecords & { workspaces: Record<string, unknown> } = { labs: {}, topics: {}, checks: {}, workspaces: {} };

function raiseTopic(
  topics: Record<string, TopicProgress>,
  key: string,
  mastery: Mastery,
  bestCheckScore: number | undefined,
  at: string,
): Record<string, TopicProgress> {
  const prev = topics[key];
  const nextMastery = maxMastery(prev?.mastery, mastery);
  const best = Math.max(prev?.bestCheckScore ?? 0, bestCheckScore ?? 0);
  const score = best > 0 ? best : undefined;
  if (prev && prev.mastery === nextMastery && (prev.bestCheckScore ?? 0) === (score ?? 0)) return topics;
  return { ...topics, [key]: { mastery: nextMastery, bestCheckScore: score, updatedAt: at } };
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      ...EMPTY,

      recordResult: (lab, result, hintsUsed) =>
        set((s) => {
          const prev = s.labs[lab.id];
          const labs = {
            ...s.labs,
            [lab.id]: {
              passed: (prev?.passed ?? false) || result.passed,
              bestScore: Math.max(prev?.bestScore ?? 0, result.score),
              attempts: (prev?.attempts ?? 0) + 1,
              hintsUsed: Math.max(prev?.hintsUsed ?? 0, hintsUsed),
              lastAttemptAt: result.completedAt,
              completedAt: prev?.completedAt ?? (result.passed ? result.completedAt : undefined),
            },
          };
          let topics = s.topics;
          if (lab.unit && lab.topicIndex) {
            const key = topicKey(lab.course, lab.unit, lab.topicIndex);
            const check = s.checks[key];
            const mastery = deriveMastery({
              attempted: true,
              passedLevels: labsPassedOnTopic(labs, lab.course, lab.unit, lab.topicIndex),
              checkPassed: check?.passed,
              bestCheckScore: check?.bestScore,
            });
            topics = raiseTopic(topics, key, mastery, undefined, result.completedAt);
          }
          return { labs, topics };
        }),

      recordCheck: (course, unit, topic, score, passed) =>
        set((s) => {
          const at = new Date().toISOString();
          const key = topicKey(course, unit, topic);
          const prev = s.checks[key];
          const entry: CheckProgress = {
            attempts: (prev?.attempts ?? 0) + 1,
            bestScore: Math.max(prev?.bestScore ?? 0, score),
            passed: (prev?.passed ?? false) || passed,
            lastAttemptAt: at,
          };
          const checks = { ...s.checks, [key]: entry };
          const mastery = deriveMastery({
            attempted: true,
            checkPassed: entry.passed,
            bestCheckScore: entry.bestScore,
            passedLevels: labsPassedOnTopic(s.labs, course, unit, topic),
          });
          return { checks, topics: raiseTopic(s.topics, key, mastery, entry.bestScore, at) };
        }),

      saveWorkspace: (labId, state) => set((s) => ({ workspaces: { ...s.workspaces, [labId]: state } })),
      clearWorkspace: (labId) =>
        set((s) => {
          const next = { ...s.workspaces };
          delete next[labId];
          return { workspaces: next };
        }),

      importRecords: (records) => set((s) => mergeProgress(s, records)),

      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'cslab-progress-v1',
      version: 3,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<ProgressState>;
        if (version < 2) return { ...EMPTY, labs: p.labs ?? {}, workspaces: p.workspaces ?? {} } as ProgressState;
        // Version 2 carried a sync queue and an owner id; both are gone.
        return { labs: p.labs ?? {}, topics: p.topics ?? {}, checks: p.checks ?? {}, workspaces: p.workspaces ?? {} } as ProgressState;
      },
      partialize: (s) => ({ labs: s.labs, topics: s.topics, checks: s.checks, workspaces: s.workspaces }) as ProgressState,
    },
  ),
);

function labsPassedOnTopic(labs: Record<string, LabProgress>, course: string, unit: number, topic: number): LabLevel[] {
  return LABS.filter((l) => l.course === course && l.unit === unit && l.topicIndex === topic && labs[l.id]?.passed).map((l) => l.level);
}

/** Mastery for a topic as the UI should show it: stored state, or derived from labs for older data. */
export function topicMastery(state: ProgressRecords, course: string, unit: number, topic: number): Mastery {
  const key = topicKey(course, unit, topic);
  const check = state.checks[key];
  const derived = deriveMastery({
    passedLevels: labsPassedOnTopic(state.labs, course, unit, topic),
    attempted: LABS.some((l) => l.course === course && l.unit === unit && l.topicIndex === topic && state.labs[l.id]),
    checkPassed: check?.passed,
    bestCheckScore: check?.bestScore,
  });
  return maxMastery(state.topics[key]?.mastery, derived);
}

/** The records alone, for export. */
export function currentRecords(): ProgressRecords {
  const { labs, topics, checks } = useProgress.getState();
  return { labs, topics, checks };
}
