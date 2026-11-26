import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionClassFor, createTracker, deviceClassFor, memoryStorage, validateEvent, type LearningEvent } from './analytics';
import { ALLOWED, OBJECT_TYPE_NAMES, VERB_NAMES, xapiProfileDocument } from './xapiProfile';

const base = (over: Partial<LearningEvent> = {}): LearningEvent => ({
  id: 'e1',
  occurredAt: '2026-10-18T10:00:00.000Z',
  verb: 'passed',
  objectType: 'lab',
  objectId: 'digital-logic-design-b1',
  sessionId: 's1',
  deviceClass: 'phone',
  connectionClass: '3g',
  appVersion: '0.1.0',
  ...over,
});

describe('xAPI profile', () => {
  it('allows only known verbs per object type and every verb appears somewhere', () => {
    const used = new Set(Object.values(ALLOWED).flat());
    for (const v of VERB_NAMES) expect(used.has(v), `verb ${v} unused`).toBe(true);
    for (const t of OBJECT_TYPE_NAMES) expect(ALLOWED[t].length).toBeGreaterThan(0);
    const doc = xapiProfileDocument();
    expect(doc.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(doc.verbs).length).toBe(VERB_NAMES.length);
  });
});

describe('validateEvent', () => {
  it('accepts a well-formed event', () => {
    expect(validateEvent(base())).toEqual([]);
  });
  it('rejects verbs that do not fit the object', () => {
    expect(validateEvent(base({ verb: 'posted' }))).toContain('verb "posted" is not allowed on "lab"');
  });
  it('rejects oversized payloads and bad fields', () => {
    expect(validateEvent(base({ result: { big: 'x'.repeat(30_000) } }))[0]).toMatch(/too large/);
    expect(validateEvent(base({ unit: 0 }))).toContain('bad unit');
    expect(validateEvent(base({ deviceClass: 'watch' as never }))).toContain('bad deviceClass');
  });
});

describe('createTracker', () => {
  let sent: LearningEvent[][];
  let fail: boolean;
  let n: number;
  const make = (over: Partial<Parameters<typeof createTracker>[0]> = {}) =>
    createTracker({
      sessionId: 's1',
      deviceClass: 'phone',
      connectionClass: () => '3g',
      appVersion: '0.1.0',
      enabled: () => true,
      newId: () => `id${++n}`,
      send: async (batch) => {
        if (fail) throw new Error('offline');
        sent.push(batch);
      },
      batchSize: 3,
      flushIntervalMs: 1_000,
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    fail = false;
    n = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends when the batch size is reached', async () => {
    const t = make();
    t.track('viewed', { type: 'course', id: 'c' });
    t.track('viewed', { type: 'unit', id: 'u' });
    expect(sent.length).toBe(0);
    t.track('launched', { type: 'lab', id: 'l', labLevel: 'beginner' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    expect(sent[0].map((e) => e.verb)).toEqual(['viewed', 'viewed', 'launched']);
    expect(t.pending()).toBe(0);
  });

  it('sends after the interval when the batch is small', async () => {
    const t = make();
    t.track('viewed', { type: 'course', id: 'c' });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent.length).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(sent.length).toBe(1);
  });

  it('keeps events and retries after a failed send', async () => {
    const t = make();
    fail = true;
    t.track('viewed', { type: 'course', id: 'c' });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sent.length).toBe(0);
    expect(t.pending()).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.length).toBe(1);
    expect(t.pending()).toBe(0);
  });

  it('drops everything while disabled and invalid events always', () => {
    const errors: string[] = [];
    const t = make({ enabled: () => false, onError: (m) => errors.push(m) });
    expect(t.track('viewed', { type: 'course', id: 'c' })).toBeNull();
    const t2 = make({ onError: (m) => errors.push(m) });
    expect(t2.track('posted', { type: 'lab', id: 'l' })).toBeNull();
    expect(errors.some((m) => m.includes('not allowed'))).toBe(true);
    expect(t2.pending()).toBe(0);
  });

  it('restores a persisted queue on init', async () => {
    const storage = memoryStorage();
    const first = make({ storage });
    first.track('viewed', { type: 'course', id: 'c' });
    first.stop();
    const second = make({ storage });
    await second.init();
    expect(second.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sent.length).toBe(1);
  });

  it('clears queued and persisted events on clear()', async () => {
    const storage = memoryStorage();
    fail = true;
    const first = make({ storage });
    first.track('viewed', { type: 'course', id: 'c' });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(first.pending()).toBe(1);
    await first.clear();
    expect(first.pending()).toBe(0);
    fail = false;
    const second = make({ storage });
    await second.init();
    expect(second.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.length).toBe(0);
  });

  it('refuses to flush events queued for a different user', async () => {
    const storage = memoryStorage();
    let currentUser: string | null = 'user-a';
    fail = true;
    const first = make({ storage, userId: () => currentUser });
    first.track('viewed', { type: 'course', id: 'c' });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(first.pending()).toBe(1);
    expect(sent.length).toBe(0);

    // Another user signs in on the same device while user-a's events are still queued.
    currentUser = 'user-b';
    fail = false;
    await first.flush();
    expect(sent.length).toBe(0);
    expect(first.pending()).toBe(0);

    // Same protection across page reloads from persisted storage.
    currentUser = 'user-a';
    fail = true;
    first.track('viewed', { type: 'unit', id: 'u' });
    await vi.advanceTimersByTimeAsync(1_100);
    first.stop();

    currentUser = 'user-b';
    fail = false;
    const second = make({ storage, userId: () => currentUser });
    await second.init();
    await second.flush();
    expect(sent.length).toBe(0);
    expect(second.pending()).toBe(0);

    // User B's own new events still flush normally.
    second.track('viewed', { type: 'course', id: 'c2' });
    await second.flush();
    expect(sent.length).toBe(1);
    expect(sent[0].map((e) => e.objectId)).toEqual(['c2']);
  });
});

describe('device and connection classes', () => {
  it('classifies widths and network hints', () => {
    expect(deviceClassFor(360, true)).toBe('phone');
    expect(deviceClassFor(900, true)).toBe('tablet');
    expect(deviceClassFor(1400, false)).toBe('desktop');
    expect(deviceClassFor(NaN, false)).toBe('unknown');
    expect(connectionClassFor('slow-2g')).toBe('2g');
    expect(connectionClassFor('4g')).toBe('4g');
    expect(connectionClassFor(undefined)).toBe('unknown');
    expect(connectionClassFor('4g', true)).toBe('wifi');
  });
});
