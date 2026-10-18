import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LabResult } from '@cslab/lab-runtime';

export interface LabProgress {
  passed: boolean;
  bestScore: number;
  attempts: number;
  hintsUsed: number;
  lastAttemptAt: string;
  completedAt?: string;
}

interface ProgressState {
  labs: Record<string, LabProgress>;
  /** Saved simulator state per lab so learners can resume. */
  workspaces: Record<string, unknown>;
  recordResult: (result: LabResult, hintsUsed: number) => void;
  saveWorkspace: (labId: string, state: unknown) => void;
  clearWorkspace: (labId: string) => void;
  reset: () => void;
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      labs: {},
      workspaces: {},
      recordResult: (result, hintsUsed) =>
        set((s) => {
          const prev = s.labs[result.labId];
          const passed = (prev?.passed ?? false) || result.passed;
          return {
            labs: {
              ...s.labs,
              [result.labId]: {
                passed,
                bestScore: Math.max(prev?.bestScore ?? 0, result.score),
                attempts: (prev?.attempts ?? 0) + 1,
                hintsUsed: Math.max(prev?.hintsUsed ?? 0, hintsUsed),
                lastAttemptAt: result.completedAt,
                completedAt: prev?.completedAt ?? (result.passed ? result.completedAt : undefined),
              },
            },
          };
        }),
      saveWorkspace: (labId, state) => set((s) => ({ workspaces: { ...s.workspaces, [labId]: state } })),
      clearWorkspace: (labId) =>
        set((s) => {
          const next = { ...s.workspaces };
          delete next[labId];
          return { workspaces: next };
        }),
      reset: () => set({ labs: {}, workspaces: {} }),
    }),
    { name: 'cslab-progress-v1' },
  ),
);
