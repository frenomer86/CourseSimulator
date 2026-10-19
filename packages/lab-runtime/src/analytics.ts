/**
 * Learning-event SDK (xAPI-shaped), framework-free.
 *
 * - `track()` stamps session, device, connection and app version, validates against the
 *   profile, and queues the event.
 * - Events are sent in batches of `batchSize` or every `flushIntervalMs`, whichever first.
 * - A pluggable `storage` keeps the queue across reloads (the web app uses IndexedDB).
 * - When `enabled()` is false (no account, or the deployment has no API) nothing is queued,
 *   so a guest never accumulates data that could never be sent.
 * - Sending never throws into the app; failures are kept and retried with backoff.
 */

import {
  ALLOWED,
  CONNECTION_CLASSES,
  DEVICE_CLASSES,
  OBJECT_TYPE_NAMES,
  VERB_NAMES,
  type ConnectionClass,
  type DeviceClass,
  type ObjectType,
  type Verb,
} from './xapiProfile';
import type { LabLevel } from './index';

export interface EventObject {
  type: ObjectType;
  id: string;
  course?: string;
  unit?: number;
  topic?: number;
  labId?: string;
  labLevel?: LabLevel;
}

export interface LearningEvent {
  id: string;
  occurredAt: string;
  verb: Verb;
  objectType: ObjectType;
  objectId: string;
  course?: string;
  unit?: number;
  topic?: number;
  labId?: string;
  labLevel?: LabLevel;
  result?: Record<string, unknown>;
  context?: Record<string, unknown>;
  sessionId: string;
  deviceClass: DeviceClass;
  connectionClass: ConnectionClass;
  appVersion: string;
  locale?: string;
}

export const MAX_EVENT_BYTES = 20_000;

/** Returns a list of problems; empty when the event is valid. */
export function validateEvent(e: LearningEvent): string[] {
  const problems: string[] = [];
  if (!e.id) problems.push('missing id');
  if (!e.occurredAt || Number.isNaN(Date.parse(e.occurredAt))) problems.push('bad occurredAt');
  if (!VERB_NAMES.includes(e.verb)) problems.push(`unknown verb "${e.verb}"`);
  if (!OBJECT_TYPE_NAMES.includes(e.objectType)) problems.push(`unknown object type "${e.objectType}"`);
  else if (VERB_NAMES.includes(e.verb) && !ALLOWED[e.objectType].includes(e.verb)) problems.push(`verb "${e.verb}" is not allowed on "${e.objectType}"`);
  if (!e.objectId || e.objectId.length > 300) problems.push('bad objectId');
  if (!e.sessionId) problems.push('missing sessionId');
  if (!DEVICE_CLASSES.includes(e.deviceClass)) problems.push('bad deviceClass');
  if (!CONNECTION_CLASSES.includes(e.connectionClass)) problems.push('bad connectionClass');
  if (!e.appVersion) problems.push('missing appVersion');
  if (e.unit !== undefined && !(Number.isInteger(e.unit) && e.unit >= 1)) problems.push('bad unit');
  if (e.topic !== undefined && !(Number.isInteger(e.topic) && e.topic >= 1)) problems.push('bad topic');
  const size = JSON.stringify({ r: e.result ?? null, c: e.context ?? null }).length;
  if (size > MAX_EVENT_BYTES) problems.push(`result and context too large (${size} bytes)`);
  return problems;
}

export interface QueueStorage {
  load(): Promise<LearningEvent[]>;
  save(events: LearningEvent[]): Promise<void>;
}

export function memoryStorage(): QueueStorage {
  let kept: LearningEvent[] = [];
  return {
    async load() {
      return kept;
    },
    async save(events) {
      kept = events;
    },
  };
}

export interface TrackerOptions {
  sessionId: string;
  deviceClass: DeviceClass;
  connectionClass: () => ConnectionClass;
  appVersion: string;
  locale?: string;
  /** Delivers one batch; must throw (reject) on failure so the batch is retried. */
  send: (events: LearningEvent[]) => Promise<void>;
  /** False while there is nobody to attribute events to; such events are dropped. */
  enabled: () => boolean;
  storage?: QueueStorage;
  newId: () => string;
  now?: () => Date;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueue?: number;
  onError?: (message: string) => void;
}

export interface Tracker {
  /** Loads anything persisted from a previous page. Safe to call once. */
  init(): Promise<void>;
  track(verb: Verb, object: EventObject, result?: Record<string, unknown>, context?: Record<string, unknown>): LearningEvent | null;
  flush(): Promise<void>;
  pending(): number;
  /** Stops timers; queued events stay in storage for next time. */
  stop(): void;
}

export function createTracker(opts: TrackerOptions): Tracker {
  const storage = opts.storage ?? memoryStorage();
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 20;
  const flushIntervalMs = opts.flushIntervalMs ?? 10_000;
  const maxQueue = opts.maxQueue ?? 1000;
  let queue: LearningEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let stopped = false;
  let backoffMs = 2_000;

  const persist = () => storage.save(queue).catch(() => {});

  const scheduleFlush = (ms: number) => {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, ms);
  };

  const scheduleRetry = () => {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      backoffMs = Math.min(backoffMs * 2, 60_000);
      void flush();
    }, backoffMs);
  };

  async function flush(): Promise<void> {
    if (sending || stopped || queue.length === 0 || !opts.enabled()) return;
    sending = true;
    try {
      while (queue.length > 0 && opts.enabled()) {
        const batch = queue.slice(0, Math.max(batchSize, 1) * 5);
        await opts.send(batch);
        const sent = new Set(batch.map((e) => e.id));
        queue = queue.filter((e) => !sent.has(e.id));
        await persist();
      }
      backoffMs = 2_000;
    } catch (err) {
      opts.onError?.(err instanceof Error ? err.message : String(err));
      scheduleRetry();
    } finally {
      sending = false;
    }
  }

  return {
    async init() {
      try {
        const kept = await storage.load();
        if (kept.length) {
          const ids = new Set(queue.map((e) => e.id));
          queue = [...kept.filter((e) => !ids.has(e.id)), ...queue];
          scheduleFlush(1_000);
        }
      } catch {
        /* storage unavailable: memory only */
      }
    },

    track(verb, object, result, context) {
      if (!opts.enabled()) return null;
      const event: LearningEvent = {
        id: opts.newId(),
        occurredAt: now().toISOString(),
        verb,
        objectType: object.type,
        objectId: object.id,
        course: object.course,
        unit: object.unit,
        topic: object.topic,
        labId: object.labId,
        labLevel: object.labLevel,
        result,
        context,
        sessionId: opts.sessionId,
        deviceClass: opts.deviceClass,
        connectionClass: opts.connectionClass(),
        appVersion: opts.appVersion,
        locale: opts.locale,
      };
      const problems = validateEvent(event);
      if (problems.length) {
        opts.onError?.(`dropped event ${verb} ${object.type}: ${problems.join('; ')}`);
        return null;
      }
      queue.push(event);
      if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
      void persist();
      if (queue.length >= batchSize) void flush();
      else scheduleFlush(flushIntervalMs);
      return event;
    },

    flush,

    pending() {
      return queue.length;
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
  };
}

/** Classifies a viewport width. */
export function deviceClassFor(width: number, touch: boolean): DeviceClass {
  if (!Number.isFinite(width) || width <= 0) return 'unknown';
  if (width < 768) return 'phone';
  if (width < 1100 && touch) return 'tablet';
  return 'desktop';
}

/** Maps the Network Information API's effectiveType (or absence) to a class. */
export function connectionClassFor(effectiveType: string | undefined, onWifiHint?: boolean): ConnectionClass {
  if (onWifiHint) return 'wifi';
  switch (effectiveType) {
    case 'slow-2g':
    case '2g':
      return '2g';
    case '3g':
      return '3g';
    case '4g':
      return '4g';
    default:
      return 'unknown';
  }
}
