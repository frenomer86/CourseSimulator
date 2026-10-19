/**
 * Learning events (xAPI-shaped) from the browser to the app's API.
 *
 * - Built on the event SDK in @cslab/lab-runtime: validated against the platform's xAPI
 *   profile, batched, kept in IndexedDB while offline, retried with backoff.
 * - Only a signed-in learner produces events (there is nobody to attribute them to otherwise),
 *   and the server decides, from the consent record, whether each event may enter the
 *   research stream. See docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md.
 */

import {
  connectionClassFor,
  createTracker,
  deviceClassFor,
  memoryStorage,
  type EventObject,
  type LearningEvent,
  type QueueStorage,
  type Verb,
} from '@cslab/lab-runtime';
import { api, newClientId } from './api';
import { useAuth } from '../store/auth';

const SESSION_KEY = 'cslab-session-id';
const APP_OBJECT: EventObject = { type: 'app', id: 'cs-virtual-lab' };

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newClientId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return newClientId();
  }
}

/** The pending queue as one record in IndexedDB; falls back to memory where IndexedDB is unavailable. */
function indexedDbStorage(): QueueStorage {
  if (typeof indexedDB === 'undefined') return memoryStorage();
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('cslab-telemetry', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction('queue', mode);
          const r = fn(tx.objectStore('queue'));
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          tx.oncomplete = () => db.close();
        }),
    );
  return {
    load: () =>
      run<unknown>('readonly', (s) => s.get('pending'))
        .then((v) => (Array.isArray(v) ? (v as LearningEvent[]) : []))
        .catch(() => []),
    save: (events) => run('readwrite', (s) => s.put(events, 'pending')).then(() => undefined),
  };
}

type NetworkInformation = { effectiveType?: string; type?: string };

export const tracker = createTracker({
  sessionId: sessionId(),
  deviceClass: deviceClassFor(window.innerWidth, 'ontouchstart' in window || navigator.maxTouchPoints > 0),
  connectionClass: () => {
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    return connectionClassFor(c?.effectiveType, c?.type === 'wifi' || c?.type === 'ethernet');
  },
  appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  locale: (navigator.language || '').slice(0, 20) || undefined,
  enabled: () => useAuth.getState().status === 'signed-in',
  send: async (events) => {
    await api('/events', { method: 'POST', body: { events }, timeoutMs: 20_000 });
  },
  storage: indexedDbStorage(),
  newId: newClientId,
  onError: (m) => {
    if (import.meta.env.DEV) console.warn('[telemetry]', m);
  },
});

/** Records one learning event. Does nothing for guests. */
export function track(verb: Verb, object: EventObject, result?: Record<string, unknown>, context?: Record<string, unknown>): void {
  tracker.track(verb, object, result, context);
}

/** Seconds since a timestamp, rounded, for duration fields. */
export function secondsSince(startMs: number): number {
  return Math.max(0, Math.round((Date.now() - startMs) / 1000));
}

let started = false;

/** Wires the tracker to the page lifecycle and the account. Call once at startup. */
export function startTelemetry(): void {
  if (started) return;
  started = true;
  void tracker.init();

  let launched = false;
  const launch = () => {
    if (launched) return;
    launched = true;
    track('launched', APP_OBJECT, undefined, {
      pwa: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
      offline: !navigator.onLine,
      referrer: document.referrer ? new URL(document.referrer).hostname : undefined,
    });
  };
  if (useAuth.getState().status === 'signed-in') launch();
  useAuth.subscribe((s) => {
    if (s.status === 'signed-in') {
      launch();
      void tracker.flush();
    }
  });

  window.addEventListener('online', () => void tracker.flush());
  window.addEventListener('pagehide', () => {
    track('terminated', APP_OBJECT);
    void tracker.flush();
  });
}
