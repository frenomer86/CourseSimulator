/**
 * Local progress: the source of truth on this device.
 *
 * Every result is written here first, synchronously, so labs and checks work offline and
 * without an account. Each write also appends to `queue`; the sync layer (lib/sync.ts) sends
 * the queue to the account when the learner is signed in and online, and merges what the
 * account holds by keeping the best of each value (mergeProgress in @cslab/lab-runtime).
 * The same merge serves the export/import file on the profile page.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  deriveMastery,
  maxMastery,
  mergeProgress,
  parseTopicKey,
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
import { newClientId, type SyncItem } from '../lib/api';

export type { LabProgress, TopicProgress, CheckProgress };

const MAX_QUEUE = 1000;

export interface ProgressState extends ProgressRecords {
  /** Saved simulator state per lab so learners can resume. */
  workspaces: Record<string, unknown>;
  /** Writes not yet confirmed by the account. Kept for guests too, so signing up later uploads them. */
  queue: SyncItem[];

  recordResult: (lab: LabSpec, result: LabResult, hintsUsed: number) => void;
  recordCheck: (course: string, unit: number, topic: number, score: number, passed: boolean) => void;
  saveWorkspace: (labId: string, state: unknown) => void;
  clearWorkspace: (labId: string) => void;
  /** Merges records from the account or an exported file, keeping the best of each value. */
  importRecords: (records: ProgressRecords) => void;
  /** Removes queue items the account has accepted. */
  dequeue: (ids: string[]) => void;
  /** Queues every known topic state, so a merge never leaves the account behind the device. */
  enqueueAllTopics: () => void;
  reset: () => void;
}

const EMPTY = { labs: {}, topics: {}, checks: {}, workspaces: {}, queue: [] as SyncItem[] };

function pushQueue(queue: SyncItem[], item: SyncItem): SyncItem[] {
  let next = item.kind === 'topic_progress' ? queue.filter((q) => !(q.kind === 'topic_progress' && q.id === item.id)) : queue;
  next = [...next, item];
  if (next.length > MAX_QUEUE) next = next.slice(next.length - MAX_QUEUE);
  return next;
}

function raiseTopic(
  state: { topics: Record<string, TopicProgress>; queue: SyncItem[] },
  course: string,
  unit: number,
  topic: number,
  mastery: Mastery,
  bestCheckScore: number | undefined,
  at: string,
): { topics: Record<string, TopicProgress>; queue: SyncItem[] } {
  const key = topicKey(course, unit, topic);
  const prev = state.topics[key];
  const nextMastery = maxMastery(prev?.mastery, mastery);
  const best = Math.max(prev?.bestCheckScore ?? 0, bestCheckScore ?? 0);
  const score = best > 0 ? best : undefined;
  if (prev && prev.mastery === nextMastery && (prev.bestCheckScore ?? 0) === (score ?? 0)) return state;
  return {
    topics: { ...state.topics, [key]: { mastery: nextMastery, bestCheckScore: score, updatedAt: at } },
    queue: pushQueue(state.queue, { kind: 'topic_progress', id: key, at, course, unit, topic, mastery: nextMastery, bestCheckScore: score }),
  };
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
          let queue = pushQueue(s.queue, {
            kind: 'lab_result',
            id: newClientId(),
            at: result.completedAt,
            labId: lab.id,
            course: lab.course,
            level: lab.level,
            passed: result.passed,
            score: result.score,
            hintsUsed,
            checks: result.checks.map((c) => ({ label: c.label, passed: c.passed })),
          });
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
            ({ topics, queue } = raiseTopic({ topics, queue }, lab.course, lab.unit, lab.topicIndex, mastery, undefined, result.completedAt));
          }
          return { labs, topics, queue };
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
          const queue = pushQueue(s.queue, { kind: 'check_attempt', id: newClientId(), at, course, unit, topic, score, passed });
          const mastery = deriveMastery({
            attempted: true,
            checkPassed: entry.passed,
            bestCheckScore: entry.bestScore,
            passedLevels: labsPassedOnTopic(s.labs, course, unit, topic),
          });
          const raised = raiseTopic({ topics: s.topics, queue }, course, unit, topic, mastery, entry.bestScore, at);
          return { checks, topics: raised.topics, queue: raised.queue };
        }),

      saveWorkspace: (labId, state) => set((s) => ({ workspaces: { ...s.workspaces, [labId]: state } })),
      clearWorkspace: (labId) =>
        set((s) => {
          const next = { ...s.workspaces };
          delete next[labId];
          return { workspaces: next };
        }),

      importRecords: (records) => set((s) => mergeProgress(s, records)),

      dequeue: (ids) =>
        set((s) => {
          const gone = new Set(ids);
          return { queue: s.queue.filter((q) => !gone.has(q.id)) };
        }),

      enqueueAllTopics: () =>
        set((s) => {
          let queue = s.queue;
          for (const [key, t] of Object.entries(s.topics)) {
            const parsed = parseTopicKey(key);
            if (!parsed || t.mastery === 'not_started') continue;
            queue = pushQueue(queue, {
              kind: 'topic_progress',
              id: key,
              at: t.updatedAt,
              course: parsed.course,
              unit: parsed.unit,
              topic: parsed.topic,
              mastery: t.mastery,
              bestCheckScore: t.bestCheckScore,
            });
          }
          return { queue };
        }),

      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'cslab-progress-v1',
      version: 4,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<ProgressState>;
        if (version < 2) return { ...EMPTY, labs: p.labs ?? {}, workspaces: p.workspaces ?? {} } as ProgressState;
        return {
          labs: p.labs ?? {},
          topics: p.topics ?? {},
          checks: p.checks ?? {},
          workspaces: p.workspaces ?? {},
          queue: Array.isArray(p.queue) ? p.queue : [],
        } as ProgressState;
      },
      partialize: (s) => ({ labs: s.labs, topics: s.topics, checks: s.checks, workspaces: s.workspaces, queue: s.queue }) as ProgressState,
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
