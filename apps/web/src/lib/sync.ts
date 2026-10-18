/**
 * Progress sync: drains the local queue to Supabase and merges the account's state on sign-in.
 *
 * - Local store first; the queue replays in order whenever the learner is signed in and online.
 * - lab_results and check_attempts carry a client_attempt_id, so a replayed insert that already
 *   landed is detected by the unique index (23505) and dropped from the queue.
 * - topic_progress is read-then-upserted with the higher mastery, so two devices never
 *   lower each other.
 * - On sign-in the server copy is merged into the local store by keeping the highest mastery and
 *   best score, and anything local that is higher goes back out through the queue.
 */

import { create } from 'zustand';
import { maxMastery, type Mastery } from '@cslab/lab-runtime';
import { describeError, supabase } from './supabase';
import { useProgress, type ServerSnapshot, type SyncItem } from '../store/progress';
import { initAuth, useAuth, type AuthUser } from '../store/auth';

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'waiting' | 'error';

interface SyncStatus {
  phase: SyncPhase;
  pending: number;
  lastError: string | null;
  lastSyncedAt: string | null;
  /** True while the first merge after sign-in is running. */
  merging: boolean;
}

export const useSyncStatus = create<SyncStatus>()(() => ({
  phase: supabase ? 'idle' : 'off',
  pending: 0,
  lastError: null,
  lastSyncedAt: null,
  merging: false,
}));

let currentUser: AuthUser | null = null;
let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 2000;

function online(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function setStatus(patch: Partial<SyncStatus>) {
  useSyncStatus.setState(patch);
}

function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === '23505';
}

async function writeItem(item: SyncItem, userId: string): Promise<void> {
  if (!supabase) return;
  switch (item.kind) {
    case 'lab_result': {
      const { error } = await supabase.from('lab_results').insert({
        user_id: userId,
        lab_id: item.labId,
        course_slug: item.course,
        level: item.level,
        passed: item.passed,
        score: Math.round(item.score * 1000) / 1000,
        hints_used: item.hintsUsed,
        checks: item.checks,
        artifact: item.artifact ?? null,
        client_attempt_id: item.id,
      });
      if (error && !isUniqueViolation(error)) throw error;
      return;
    }
    case 'check_attempt': {
      const { error } = await supabase.from('check_attempts').insert({
        user_id: userId,
        course_slug: item.course,
        unit_index: item.unit,
        topic_index: item.topic,
        score: Math.round(item.score * 100) / 100,
        passed: item.passed,
        answers: item.answers,
        client_attempt_id: item.id,
      });
      if (error && !isUniqueViolation(error)) throw error;
      return;
    }
    case 'topic_progress': {
      const { data: existing, error: readError } = await supabase
        .from('topic_progress')
        .select('mastery, best_check_score')
        .eq('user_id', userId)
        .eq('course_slug', item.course)
        .eq('unit_index', item.unit)
        .eq('topic_index', item.topic)
        .maybeSingle();
      if (readError) throw readError;
      const mastery: Mastery = maxMastery(existing?.mastery, item.mastery);
      const best = Math.max(Number(existing?.best_check_score ?? 0), item.bestCheckScore ?? 0);
      if (existing && existing.mastery === mastery && Number(existing.best_check_score ?? 0) === best) return;
      const { error } = await supabase.from('topic_progress').upsert(
        {
          user_id: userId,
          course_slug: item.course,
          unit_index: item.unit,
          topic_index: item.topic,
          mastery,
          best_check_score: best > 0 ? best : null,
        },
        { onConflict: 'user_id,course_slug,unit_index,topic_index' },
      );
      if (error) throw error;
      return;
    }
  }
}

/** Writes queued items in order. Stops at the first failure and retries later. */
export async function flush(): Promise<void> {
  if (!supabase || !currentUser || flushing) return;
  const userId = currentUser.id;
  if (!online()) {
    setStatus({ phase: 'waiting', pending: useProgress.getState().queue.length });
    return;
  }
  flushing = true;
  setStatus({ phase: 'syncing', lastError: null });
  try {
    for (;;) {
      const item = useProgress.getState().queue[0];
      if (!item) break;
      if (currentUser?.id !== userId) break; // account changed mid-flush
      await writeItem(item, userId);
      useProgress.getState().dequeue([item.id]);
      setStatus({ pending: useProgress.getState().queue.length });
    }
    backoffMs = 2000;
    setStatus({ phase: 'idle', pending: useProgress.getState().queue.length, lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    setStatus({ phase: 'error', lastError: describeError(err), pending: useProgress.getState().queue.length });
    scheduleRetry();
  } finally {
    flushing = false;
  }
}

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    void flush();
  }, backoffMs);
}

/** Pulls the account's progress and merges it locally (highest mastery wins). */
export async function mergeFromServer(userId: string): Promise<void> {
  if (!supabase) return;
  setStatus({ merging: true });
  try {
    const [labs, topics, checks] = await Promise.all([
      supabase.from('lab_results').select('lab_id, passed, score, hints_used, created_at').eq('user_id', userId).order('created_at'),
      supabase
        .from('topic_progress')
        .select('course_slug, unit_index, topic_index, mastery, best_check_score, updated_at')
        .eq('user_id', userId),
      supabase
        .from('check_attempts')
        .select('course_slug, unit_index, topic_index, score, passed, created_at')
        .eq('user_id', userId)
        .not('topic_index', 'is', null)
        .order('created_at'),
    ]);
    const failed = labs.error ?? topics.error ?? checks.error;
    if (failed) throw failed;
    const snapshot: ServerSnapshot = {
      labs: (labs.data ?? []).map((r) => ({
        labId: r.lab_id,
        passed: r.passed,
        score: Number(r.score),
        hintsUsed: r.hints_used,
        at: r.created_at,
      })),
      topics: (topics.data ?? []).map((r) => ({
        course: r.course_slug,
        unit: r.unit_index,
        topic: r.topic_index,
        mastery: r.mastery,
        bestCheckScore: r.best_check_score === null ? null : Number(r.best_check_score),
        at: r.updated_at,
      })),
      checks: (checks.data ?? []).map((r) => ({
        course: r.course_slug,
        unit: r.unit_index,
        topic: r.topic_index as number,
        score: Number(r.score),
        passed: r.passed,
        at: r.created_at,
      })),
    };
    useProgress.getState().mergeServer(snapshot);
    setStatus({ lastError: null });
  } catch (err) {
    setStatus({ phase: 'error', lastError: describeError(err) });
    scheduleRetry();
  } finally {
    setStatus({ merging: false });
  }
}

/**
 * Wires auth, connectivity and the store together. Call once at startup; returns a stop function.
 */
export function startSync(): () => void {
  if (!supabase) return () => {};

  const stopAuth = initAuth((user) => {
    const progress = useProgress.getState();
    currentUser = user;
    if (user) {
      // Progress left by a different account on this device is not this learner's.
      if (progress.ownerId && progress.ownerId !== user.id) progress.reset();
      useProgress.getState().setOwner(user.id);
      void mergeFromServer(user.id).then(() => flush());
    } else {
      setStatus({ phase: 'idle', pending: progress.queue.length });
    }
  });

  const onOnline = () => void flush();
  const onOffline = () => setStatus({ phase: 'waiting', pending: useProgress.getState().queue.length });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  let lastLen = useProgress.getState().queue.length;
  setStatus({ pending: lastLen });
  const unsub = useProgress.subscribe((s) => {
    if (s.queue.length !== lastLen) {
      lastLen = s.queue.length;
      setStatus({ pending: lastLen });
      if (lastLen > 0 && !useSyncStatus.getState().merging) void flush();
    }
  });

  return () => {
    stopAuth();
    unsub();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (retryTimer) clearTimeout(retryTimer);
  };
}

/**
 * Signs out safely: flushes first and, if something is still unsent, lets the caller decide.
 * Local progress is cleared afterwards because the device may be shared.
 */
export async function signOutAndClear(confirmUnsynced: (pending: number) => boolean): Promise<{ error?: string }> {
  await flush();
  const pending = useProgress.getState().queue.length;
  if (pending > 0 && !confirmUnsynced(pending)) return {};
  const res = await useAuth.getState().signOut();
  if (res.error) return res;
  currentUser = null;
  useProgress.getState().reset();
  setStatus({ phase: 'idle', pending: 0, lastError: null });
  return {};
}
