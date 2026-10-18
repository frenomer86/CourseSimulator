/**
 * Progress sync with the account.
 *
 * - The device is the source of truth; the queue in the progress store replays in order.
 * - Items carry a client attempt id, so a batch sent twice (a lost response, a retry) never
 *   duplicates a row.
 * - On sign-in the account's records are merged into the device (best of both), every topic
 *   state is queued once, and the queue is flushed, so neither side ends up behind the other.
 */

import { create } from 'zustand';
import { api, ApiError, type SyncResponse } from './api';
import { useProgress } from '../store/progress';
import { useAuth } from '../store/auth';

export type SyncPhase = 'idle' | 'syncing' | 'waiting' | 'error';

interface SyncStatus {
  phase: SyncPhase;
  pending: number;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export const useSyncStatus = create<SyncStatus>()(() => ({ phase: 'idle', pending: 0, lastError: null, lastSyncedAt: null }));

const BATCH = 200;
let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 2000;

const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine);
const signedIn = () => useAuth.getState().status === 'signed-in';
const pending = () => useProgress.getState().queue.length;

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    void flush();
  }, backoffMs);
}

/** Sends queued items in batches. Stops at the first failure and retries with backoff. */
export async function flush(): Promise<void> {
  if (!signedIn() || flushing) return;
  if (pending() === 0) {
    useSyncStatus.setState({ phase: 'idle', pending: 0 });
    return;
  }
  if (!online()) {
    useSyncStatus.setState({ phase: 'waiting', pending: pending() });
    return;
  }
  flushing = true;
  useSyncStatus.setState({ phase: 'syncing', lastError: null, pending: pending() });
  try {
    while (pending() > 0 && signedIn()) {
      const items = useProgress.getState().queue.slice(0, BATCH);
      const res = await api<SyncResponse>('/me/progress/sync', { method: 'POST', body: { items }, timeoutMs: 30_000 });
      useProgress.getState().dequeue(res.accepted);
      useProgress.getState().importRecords(res.records);
      useAuth.getState().applyProfile(res.profile);
      if (res.accepted.length === 0) break; // nothing moved; avoid a hot loop
    }
    backoffMs = 2000;
    useSyncStatus.setState({ phase: 'idle', pending: pending(), lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // The session is gone; keep the queue for the next sign-in.
      useSyncStatus.setState({ phase: 'idle', pending: pending() });
    } else {
      useSyncStatus.setState({ phase: 'error', lastError: err instanceof Error ? err.message : String(err), pending: pending() });
      scheduleRetry();
    }
  } finally {
    flushing = false;
  }
}

/** Pulls the account's records, merges them, then pushes everything the device knows. */
export async function pullAndMerge(): Promise<void> {
  if (!signedIn()) return;
  try {
    const records = await api<SyncResponse['records']>('/me/progress', { timeoutMs: 20_000 });
    useProgress.getState().importRecords(records);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      useSyncStatus.setState({ phase: 'error', lastError: err instanceof Error ? err.message : String(err), pending: pending() });
      scheduleRetry();
      return;
    }
  }
  useProgress.getState().enqueueAllTopics();
  await flush();
}

/** Wires auth, connectivity and the queue together. Call once at startup. */
export function startSync(): () => void {
  let lastUserId: string | null = null;
  const unsubAuth = useAuth.subscribe((s) => {
    const id = s.status === 'signed-in' ? (s.user?.id ?? 'unknown') : null;
    if (id && id !== lastUserId) {
      lastUserId = id;
      void pullAndMerge();
    } else if (!id) {
      lastUserId = null;
      useSyncStatus.setState({ phase: 'idle', pending: pending(), lastError: null });
    }
  });

  let lastLen = pending();
  useSyncStatus.setState({ pending: lastLen });
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const unsubQueue = useProgress.subscribe((s) => {
    if (s.queue.length === lastLen) return;
    lastLen = s.queue.length;
    useSyncStatus.setState({ pending: lastLen });
    if (lastLen > 0) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void flush(), 600);
    }
  });

  const onOnline = () => void flush();
  const onOffline = () => useSyncStatus.setState({ phase: 'waiting', pending: pending() });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  return () => {
    unsubAuth();
    unsubQueue();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (retryTimer) clearTimeout(retryTimer);
    if (debounce) clearTimeout(debounce);
  };
}

/**
 * Signs out safely: flushes first; if something is still unsent, the caller decides. On a
 * shared device the local progress and name are cleared too, because they are the account's.
 */
export async function signOutAndClear(confirmUnsynced: (pending: number) => boolean): Promise<boolean> {
  await flush();
  const left = pending();
  if (left > 0 && !confirmUnsynced(left)) return false;
  await useAuth.getState().signOut();
  useProgress.getState().reset();
  useSyncStatus.setState({ phase: 'idle', pending: 0, lastError: null });
  return true;
}
