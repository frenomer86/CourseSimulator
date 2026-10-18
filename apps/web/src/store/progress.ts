/**
 * Local progress: the source of truth on this device.
 *
 * Everything the learner does is written here first, synchronously, so labs and checks work
 * offline and as a guest. Each write also appends to `queue`; the sync layer (lib/sync.ts)
 * drains the queue to Supabase when the learner is signed in and online, and merges server
 * state back in on sign-in by keeping the highest mastery and best scores.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  deriveMastery,
  maxMastery,
  topicKey,
  type LabLevel,
  type LabResult,
  type LabSpec,
  type Mastery,
} from '@cslab/lab-runtime';
import { accountsEnabled, newClientId } from '../lib/supabase';
import { LABS } from '../lib/catalogue';

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

export interface LabResultItem {
  kind: 'lab_result';
  id: string; // client_attempt_id
  at: string;
  labId: string;
  course: string;
  level: LabLevel;
  passed: boolean;
  score: number;
  hintsUsed: number;
  checks: LabResult['checks'];
  artifact?: unknown;
}

export interface CheckAttemptItem {
  kind: 'check_attempt';
  id: string; // client_attempt_id
  at: string;
  course: string;
  unit: number;
  topic: number;
  score: number;
  passed: boolean;
  answers: unknown;
}

export interface TopicProgressItem {
  kind: 'topic_progress';
  /** The topic key; a newer item for the same key replaces an older queued one. */
  id: string;
  at: string;
  course: string;
  unit: number;
  topic: number;
  mastery: Mastery;
  bestCheckScore?: number;
}

export type SyncItem = LabResultItem | CheckAttemptItem | TopicProgressItem;

const MAX_QUEUE = 2000;

export interface ServerSnapshot {
  labs: Array<{ labId: string; passed: boolean; score: number; hintsUsed: number; at: string }>;
  topics: Array<{ course: string; unit: number; topic: number; mastery: Mastery; bestCheckScore: number | null; at: string }>;
  checks: Array<{ course: string; unit: number; topic: number; score: number; passed: boolean; at: string }>;
}

export interface ProgressState {
  /** The account this progress belongs to, or null for a guest. */
  ownerId: string | null;
  labs: Record<string, LabProgress>;
  topics: Record<string, TopicProgress>;
  checks: Record<string, CheckProgress>;
  /** Saved simulator state per lab so learners can resume. */
  workspaces: Record<string, unknown>;
  queue: SyncItem[];

  recordResult: (lab: LabSpec, result: LabResult, hintsUsed: number, artifact?: unknown) => void;
  recordCheck: (course: string, unit: number, topic: number, score: number, passed: boolean, answers: unknown) => void;
  saveWorkspace: (labId: string, state: unknown) => void;
  clearWorkspace: (labId: string) => void;
  /** Removes queue items the sync layer has written. */
  dequeue: (ids: string[]) => void;
  /** Merges what the account already holds, keeping the higher of each value. */
  mergeServer: (snapshot: ServerSnapshot) => void;
  setOwner: (ownerId: string | null) => void;
  reset: () => void;
}

const EMPTY = { ownerId: null, labs: {}, topics: {}, checks: {}, workspaces: {}, queue: [] as SyncItem[] };

function pushQueue(queue: SyncItem[], item: SyncItem): SyncItem[] {
  // Offline guest mode (no Supabase configured) never queues: nothing could ever drain it.
  if (!accountsEnabled) return queue;
  let next = item.kind === 'topic_progress' ? queue.filter((q) => !(q.kind === 'topic_progress' && q.id === item.id)) : queue;
  next = [...next, item];
  if (next.length > MAX_QUEUE) next = next.slice(next.length - MAX_QUEUE);
  return next;
}

function raiseTopic(
  state: Pick<ProgressState, 'topics' | 'queue'>,
  course: string,
  unit: number,
  topic: number,
  mastery: Mastery,
  bestCheckScore: number | undefined,
  at: string,
): Pick<ProgressState, 'topics' | 'queue'> {
  const key = topicKey(course, unit, topic);
  const prev = state.topics[key];
  const nextMastery = maxMastery(prev?.mastery, mastery);
  const nextScore = Math.max(prev?.bestCheckScore ?? 0, bestCheckScore ?? 0);
  const score = nextScore > 0 ? nextScore : prev?.bestCheckScore;
  if (prev && prev.mastery === nextMastery && (prev.bestCheckScore ?? 0) === (score ?? 0)) return state;
  const entry: TopicProgress = { mastery: nextMastery, bestCheckScore: score, updatedAt: at };
  return {
    topics: { ...state.topics, [key]: entry },
    queue: pushQueue(state.queue, {
      kind: 'topic_progress',
      id: key,
      at,
      course,
      unit,
      topic,
      mastery: nextMastery,
      bestCheckScore: score,
    }),
  };
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      ...EMPTY,

      recordResult: (lab, result, hintsUsed, artifact) =>
        set((s) => {
          const prev = s.labs[lab.id];
          const passed = (prev?.passed ?? false) || result.passed;
          const labs = {
            ...s.labs,
            [lab.id]: {
              passed,
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
            checks: result.checks,
            artifact,
          });
          let topics = s.topics;
          if (lab.unit && lab.topicIndex) {
            const key = topicKey(lab.course, lab.unit, lab.topicIndex);
            const check = s.checks[key];
            const mastery = deriveMastery({
              attempted: true,
              passedLevels: result.passed ? [lab.level] : [],
              checkPassed: check?.passed,
              bestCheckScore: check?.bestScore,
            });
            const raised = raiseTopic({ topics, queue }, lab.course, lab.unit, lab.topicIndex, mastery, undefined, result.completedAt);
            topics = raised.topics;
            queue = raised.queue;
          }
          return { labs, topics, queue };
        }),

      recordCheck: (course, unit, topic, score, passed, answers) =>
        set((s) => {
          const at = new Date().toISOString();
          const key = topicKey(course, unit, topic);
          const prev = s.checks[key];
          const checks = {
            ...s.checks,
            [key]: {
              attempts: (prev?.attempts ?? 0) + 1,
              bestScore: Math.max(prev?.bestScore ?? 0, score),
              passed: (prev?.passed ?? false) || passed,
              lastAttemptAt: at,
            },
          };
          const queue = pushQueue(s.queue, {
            kind: 'check_attempt',
            id: newClientId(),
            at,
            course,
            unit,
            topic,
            score,
            passed,
            answers,
          });
          // An Intermediate lab already passed on this topic plus a perfect check means mastered.
          const passedLevels = labsPassedOnTopic(s.labs, course, unit, topic);
          const mastery = deriveMastery({
            attempted: true,
            checkPassed: checks[key].passed,
            bestCheckScore: checks[key].bestScore,
            passedLevels,
          });
          const raised = raiseTopic({ topics: s.topics, queue }, course, unit, topic, mastery, checks[key].bestScore, at);
          return { checks, topics: raised.topics, queue: raised.queue };
        }),

      saveWorkspace: (labId, state) => set((s) => ({ workspaces: { ...s.workspaces, [labId]: state } })),
      clearWorkspace: (labId) =>
        set((s) => {
          const next = { ...s.workspaces };
          delete next[labId];
          return { workspaces: next };
        }),

      dequeue: (ids) =>
        set((s) => {
          const gone = new Set(ids);
          return { queue: s.queue.filter((q) => !gone.has(q.id)) };
        }),

      mergeServer: (snap) =>
        set((s) => {
          const labs = { ...s.labs };
          const labCounts = new Map<string, number>();
          for (const r of snap.labs) {
            const prev = labs[r.labId];
            const n = (labCounts.get(r.labId) ?? 0) + 1;
            labCounts.set(r.labId, n);
            labs[r.labId] = {
              passed: (prev?.passed ?? false) || r.passed,
              bestScore: Math.max(prev?.bestScore ?? 0, r.score),
              attempts: Math.max(prev?.attempts ?? 0, n),
              hintsUsed: Math.max(prev?.hintsUsed ?? 0, r.hintsUsed),
              lastAttemptAt: later(prev?.lastAttemptAt, r.at),
              completedAt: prev?.completedAt ?? (r.passed ? r.at : undefined),
            };
          }
          const checks = { ...s.checks };
          const checkCounts = new Map<string, number>();
          for (const c of snap.checks) {
            const key = topicKey(c.course, c.unit, c.topic);
            const prev = checks[key];
            const n = (checkCounts.get(key) ?? 0) + 1;
            checkCounts.set(key, n);
            checks[key] = {
              attempts: Math.max(prev?.attempts ?? 0, n),
              bestScore: Math.max(prev?.bestScore ?? 0, c.score),
              passed: (prev?.passed ?? false) || c.passed,
              lastAttemptAt: later(prev?.lastAttemptAt, c.at),
            };
          }
          const topics = { ...s.topics };
          for (const t of snap.topics) {
            const key = topicKey(t.course, t.unit, t.topic);
            const prev = topics[key];
            const mastery = maxMastery(prev?.mastery, t.mastery);
            const best = Math.max(prev?.bestCheckScore ?? 0, t.bestCheckScore ?? 0);
            topics[key] = {
              mastery,
              bestCheckScore: best > 0 ? best : undefined,
              updatedAt: later(prev?.updatedAt, t.at),
            };
          }
          // Anything local that is higher than the server copy must still be uploaded.
          let queue = s.queue;
          const serverTopics = new Map(snap.topics.map((t) => [topicKey(t.course, t.unit, t.topic), t]));
          for (const [key, local] of Object.entries(topics)) {
            const remote = serverTopics.get(key);
            const higher =
              !remote ||
              maxMastery(remote.mastery, local.mastery) !== remote.mastery ||
              (local.bestCheckScore ?? 0) > (remote.bestCheckScore ?? 0);
            if (higher && local.mastery !== 'not_started') {
              const parts = key.split(':');
              const topic = Number(parts.pop());
              const unit = Number(parts.pop());
              const course = parts.join(':');
              queue = pushQueue(queue, {
                kind: 'topic_progress',
                id: key,
                at: local.updatedAt,
                course,
                unit,
                topic,
                mastery: local.mastery,
                bestCheckScore: local.bestCheckScore,
              });
            }
          }
          return { labs, checks, topics, queue };
        }),

      setOwner: (ownerId) => set({ ownerId }),
      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'cslab-progress-v1',
      version: 2,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<ProgressState>;
        if (version < 2) {
          return { ...EMPTY, labs: p.labs ?? {}, workspaces: p.workspaces ?? {} } as ProgressState;
        }
        return persisted as ProgressState;
      },
    },
  ),
);

function later(a: string | undefined, b: string): string {
  return a && a > b ? a : b;
}

function labsPassedOnTopic(labs: Record<string, LabProgress>, course: string, unit: number, topic: number): LabLevel[] {
  return LABS
    .filter((l) => l.course === course && l.unit === unit && l.topicIndex === topic && labs[l.id]?.passed)
    .map((l) => l.level);
}

/** Mastery for a topic as the UI should show it: stored state, or derived from labs for older data. */
export function topicMastery(state: Pick<ProgressState, 'topics' | 'labs' | 'checks'>, course: string, unit: number, topic: number): Mastery {
  const key = topicKey(course, unit, topic);
  const stored = state.topics[key]?.mastery;
  const check = state.checks[key];
  const derived = deriveMastery({
    passedLevels: labsPassedOnTopic(state.labs, course, unit, topic),
    attempted: LABS.some((l) => l.course === course && l.unit === unit && l.topicIndex === topic && state.labs[l.id]),
    checkPassed: check?.passed,
    bestCheckScore: check?.bestScore,
  });
  return maxMastery(stored, derived);
}
