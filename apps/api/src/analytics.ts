/**
 * Learning analytics: research consent, event ingestion, and the learner's own data.
 * See docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md.
 *
 * Identity separation: events are stored under research_id = HMAC-SHA256(salt, user id). The
 * salt lives in the environment (RESEARCH_SALT), never in the database. Only two places map
 * a person to a research id: ingestion (to write) and the learner's own data routes (to read
 * back), and the latter is logged.
 */

import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { iso, num, type Db, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import { makeRateLimiter } from './auth.js';

/* Mirrors packages/lab-runtime/src/xapiProfile.ts (the API keeps no dependency on browser packages). */
const VERBS = [
  'launched', 'terminated', 'viewed', 'progressed', 'completed', 'interacted', 'attempted', 'answered', 'passed', 'failed',
  'asked-for-hint', 'submitted', 'abandoned', 'saved', 'experienced', 'asked', 'joined', 'left', 'posted', 'replied', 'voted',
  'shared', 'registered', 'scored', 'awarded', 'created', 'assigned', 'consented', 'withdrew',
] as const;
const OBJECT_TYPES = [
  'app', 'course', 'unit', 'topic', 'tutorial', 'check', 'check-item', 'lab', 'lab-artefact', 'error', 'forum-thread', 'group',
  'group-message', 'resource', 'competition', 'problem', 'class', 'assignment', 'consent',
] as const;

/** Matches the "Version N" line at the top of docs/governance/privacy-notice.md. */
export const CURRENT_NOTICE_VERSION = '1';

const MAX_PAYLOAD = 20_000;
const MAX_BATCH = 200;
const MAX_SKEW_PAST_MS = 30 * 24 * 3600 * 1000;
const MAX_SKEW_FUTURE_MS = 5 * 60 * 1000;

export function researchIdFor(salt: string, userId: string): string {
  return createHmac('sha256', salt).update(userId).digest('base64url');
}

/* ----------------------------------------------------------------------------- schemas */

const consentBody = z.object({
  noticeVersion: z.string().min(1).max(20),
  researchEvents: z.boolean(),
  researchSnapshots: z.boolean(),
  researchSocial: z.boolean(),
  contactFollowup: z.boolean(),
  guardianConsent: z.boolean().default(false),
});
export type ConsentInput = z.infer<typeof consentBody>;

const jsonRecord = z.record(z.string(), z.unknown());
const eventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  verb: z.enum(VERBS),
  objectType: z.enum(OBJECT_TYPES),
  objectId: z.string().min(1).max(300),
  course: z.string().max(200).optional(),
  unit: z.number().int().min(1).max(1000).optional(),
  topic: z.number().int().min(1).max(1000).optional(),
  labId: z.string().max(200).optional(),
  labLevel: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  result: jsonRecord.optional(),
  context: jsonRecord.optional(),
  sessionId: z.string().uuid(),
  deviceClass: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  connectionClass: z.enum(['2g', '3g', '4g', 'wifi', 'unknown']),
  appVersion: z.string().min(1).max(40),
  locale: z.string().max(20).optional(),
});
const eventsBody = z.object({ events: z.array(eventSchema).min(1).max(MAX_BATCH) });
export type EventInput = z.infer<typeof eventSchema>;

/* ----------------------------------------------------------------------------- consent */

export interface Consent {
  noticeVersion: string;
  researchEvents: boolean;
  researchSnapshots: boolean;
  researchSocial: boolean;
  contactFollowup: boolean;
  guardianConsent: boolean;
  consentedAt: string;
  withdrawnAt: string | null;
}

interface ConsentRow {
  notice_version: string;
  research_events: boolean;
  research_snapshots: boolean;
  research_social: boolean;
  contact_followup: boolean;
  guardian_consent: boolean;
  consented_at: unknown;
  withdrawn_at: unknown;
}

function toConsent(r: ConsentRow): Consent {
  return {
    noticeVersion: r.notice_version,
    researchEvents: r.research_events,
    researchSnapshots: r.research_snapshots,
    researchSocial: r.research_social,
    contactFollowup: r.contact_followup,
    guardianConsent: r.guardian_consent,
    consentedAt: iso(r.consented_at),
    withdrawnAt: r.withdrawn_at ? iso(r.withdrawn_at) : null,
  };
}

export async function loadConsent(q: Queryable, userId: string): Promise<Consent | null> {
  const r = await q.query<ConsentRow>('select * from analytics.consents where user_id = $1', [userId]);
  return r.rows[0] ? toConsent(r.rows[0]) : null;
}

/** Effective research flags right now (withdrawn means nothing is consented). */
function effective(c: Consent | null) {
  const live = !!c && !c.withdrawnAt;
  return { events: live && c!.researchEvents, snapshots: live && c!.researchSnapshots };
}

/* ----------------------------------------------------------------------------- partitions */

const ensured = new Set<string>();

/** Creates the monthly partition that `at` falls into, once per process. */
async function ensurePartition(db: Db, at: Date): Promise<void> {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const key = `${y}_${String(m + 1).padStart(2, '0')}`;
  if (ensured.has(key)) return;
  const from = new Date(Date.UTC(y, m, 1)).toISOString();
  const to = new Date(Date.UTC(y, m + 1, 1)).toISOString();
  await db.exec(
    `create table if not exists analytics.learning_events_${key} partition of analytics.learning_events for values from ('${from}') to ('${to}')`,
  );
  ensured.add(key);
}

/** Clamps client clocks: no older than 30 days, no later than 5 minutes ahead. */
function clampTime(at: string, now: Date): Date {
  const t = Date.parse(at);
  const min = now.getTime() - MAX_SKEW_PAST_MS;
  const max = now.getTime() + MAX_SKEW_FUTURE_MS;
  return new Date(Math.min(Math.max(t, min), max));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/* ----------------------------------------------------------------------------- your data */

export interface DataSummary {
  researchId: string;
  consent: Consent | null;
  events: { total: number; firstAt: string | null; lastAt: string | null; byVerb: Array<{ verb: string; count: number }>; inResearchStream: number };
  snapshots: { total: number; inResearchStream: number };
}

async function summary(db: Db, rid: string, consent: Consent | null): Promise<DataSummary> {
  const totals = await db.query<{ total: unknown; first_at: unknown; last_at: unknown; research: unknown }>(
    'select count(*) as total, min(occurred_at) as first_at, max(occurred_at) as last_at, count(*) filter (where research_consented) as research from analytics.learning_events where research_id = $1',
    [rid],
  );
  const byVerb = await db.query<{ verb: string; count: unknown }>(
    'select verb, count(*) as count from analytics.learning_events where research_id = $1 group by verb order by count desc, verb',
    [rid],
  );
  const snaps = await db.query<{ total: unknown; research: unknown }>(
    'select count(*) as total, count(*) filter (where research_consented) as research from analytics.lab_snapshots where research_id = $1',
    [rid],
  );
  const t = totals.rows[0];
  return {
    researchId: rid,
    consent,
    events: {
      total: num(t.total),
      firstAt: t.first_at ? iso(t.first_at) : null,
      lastAt: t.last_at ? iso(t.last_at) : null,
      byVerb: byVerb.rows.map((r) => ({ verb: r.verb, count: num(r.count) })),
      inResearchStream: num(t.research),
    },
    snapshots: { total: num(snaps.rows[0].total), inResearchStream: num(snaps.rows[0].research) },
  };
}

interface EventRow {
  client_id: string;
  occurred_at: unknown;
  received_at: unknown;
  verb: string;
  object_type: string;
  object_id: string;
  course_slug: string | null;
  unit_index: number | null;
  topic_index: number | null;
  lab_id: string | null;
  lab_level: string | null;
  result: unknown;
  context: unknown;
  session_id: string;
  device_class: string;
  connection_class: string;
  app_version: string;
  locale: string | null;
  research_consented: boolean;
}

const EVENT_COLUMNS =
  'client_id, occurred_at, received_at, verb, object_type, object_id, course_slug, unit_index, topic_index, lab_id, lab_level, result, context, session_id, device_class, connection_class, app_version, locale, research_consented';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: EventRow[]): string {
  const header = EVENT_COLUMNS.split(', ');
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      header
        .map((col) => {
          const v = (r as unknown as Record<string, unknown>)[col];
          return csvCell(col === 'occurred_at' || col === 'received_at' ? iso(v) : v);
        })
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/* ----------------------------------------------------------------------------- deletion */

/**
 * Runs before an account is deleted. Events and snapshots the learner consented to research
 * for are kept (the notice says so); everything else goes with the account.
 */
export async function purgeOnAccountDelete(q: Queryable, salt: string, userId: string): Promise<{ eventsDeleted: number; snapshotsDeleted: number }> {
  const rid = researchIdFor(salt, userId);
  const consent = await loadConsent(q, userId);
  const eff = effective(consent);
  const ev = eff.events
    ? await q.query('delete from analytics.learning_events where research_id = $1 and not research_consented', [rid])
    : await q.query('delete from analytics.learning_events where research_id = $1', [rid]);
  const sn = eff.snapshots
    ? await q.query('delete from analytics.lab_snapshots where research_id = $1 and not research_consented', [rid])
    : await q.query('delete from analytics.lab_snapshots where research_id = $1', [rid]);
  await q.query('insert into analytics.access_log (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)', [
    userId,
    'delete',
    rid,
    JSON.stringify({ reason: 'account_deleted', eventsDeleted: ev.rowCount, snapshotsDeleted: sn.rowCount, keptForResearch: eff.events }),
  ]);
  return { eventsDeleted: ev.rowCount, snapshotsDeleted: sn.rowCount };
}

/* ----------------------------------------------------------------------------- routes */

export interface AnalyticsDeps {
  db: Db;
  researchSalt: string;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function registerAnalytics(app: FastifyInstance, deps: AnalyticsDeps): void {
  const { db, researchSalt, requireAuth } = deps;
  const ingestLimit = makeRateLimiter(120, 60 * 1000);

  app.get('/api/me/consent', { preHandler: requireAuth }, async (req) => ({
    noticeVersion: CURRENT_NOTICE_VERSION,
    consent: await loadConsent(db, req.userId!),
  }));

  app.put('/api/me/consent', { preHandler: requireAuth }, async (req) => {
    const body = consentBody.parse(req.body);
    const userId = req.userId!;
    const anyResearch = body.researchEvents || body.researchSnapshots || body.researchSocial || body.contactFollowup;
    const age = await db.query<{ age_band: string }>('select age_band from profiles where user_id = $1', [userId]);
    const under18 = age.rows[0]?.age_band === 'under_18';
    if (under18 && anyResearch && !body.guardianConsent) {
      throw new HttpError(400, 'guardian_required', 'Because you are under 18, a parent, guardian or your institution must agree before your data can be used for research.');
    }
    const rid = researchIdFor(researchSalt, userId);
    const consent = await db.transaction(async (tx) => {
      const prev = await loadConsent(tx, userId);
      const withdrawing = !anyResearch && !!prev && (prev.researchEvents || prev.researchSnapshots || prev.researchSocial || prev.contactFollowup);
      await tx.query(
        `insert into analytics.consents (user_id, notice_version, research_events, research_snapshots, research_social, contact_followup, guardian_consent, consented_at, withdrawn_at)
         values ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         on conflict (user_id) do update set
           notice_version = excluded.notice_version, research_events = excluded.research_events, research_snapshots = excluded.research_snapshots,
           research_social = excluded.research_social, contact_followup = excluded.contact_followup, guardian_consent = excluded.guardian_consent,
           consented_at = case when excluded.research_events or excluded.research_snapshots or excluded.research_social or excluded.contact_followup then now() else analytics.consents.consented_at end,
           withdrawn_at = excluded.withdrawn_at`,
        [userId, body.noticeVersion, body.researchEvents, body.researchSnapshots, body.researchSocial, body.contactFollowup, body.guardianConsent, anyResearch ? null : withdrawing || prev?.withdrawnAt ? new Date() : null],
      );
      await tx.query(
        `insert into analytics.consent_history (research_id, notice_version, research_events, research_snapshots, research_social, contact_followup, guardian_consent)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [rid, body.noticeVersion, body.researchEvents, body.researchSnapshots, body.researchSocial, body.contactFollowup, body.guardianConsent],
      );
      await tx.query('insert into analytics.access_log (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)', [
        userId,
        'consent_change',
        rid,
        JSON.stringify({ noticeVersion: body.noticeVersion, anyResearch, withdrawing }),
      ]);
      return loadConsent(tx, userId);
    });
    return { noticeVersion: CURRENT_NOTICE_VERSION, consent };
  });

  app.post('/api/events', { preHandler: requireAuth }, async (req) => {
    const userId = req.userId!;
    if (!ingestLimit(`ev:${userId}`)) throw new HttpError(429, 'rate_limited', 'Too many event batches. Slow down.');
    const { events } = eventsBody.parse(req.body);
    const rid = researchIdFor(researchSalt, userId);
    const consent = effective(await loadConsent(db, userId));
    const now = new Date();
    const accepted: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];

    for (const e of events) {
      const size = JSON.stringify({ r: e.result ?? null, c: e.context ?? null }).length;
      if (size > MAX_PAYLOAD) {
        rejected.push({ id: e.id, reason: 'payload too large' });
        continue;
      }
      const at = clampTime(e.occurredAt, now);
      await ensurePartition(db, at);

      let result = e.result ?? null;
      if (e.verb === 'saved' && e.objectType === 'lab-artefact' && e.result && 'artefact' in e.result) {
        const artefact = e.result.artefact;
        const hash = sha256(artefact);
        const reason = typeof e.context?.reason === 'string' ? e.context.reason : 'submit';
        await db.query(
          'insert into analytics.lab_snapshots (research_id, lab_id, taken_at, reason, sha256, artefact, research_consented) values ($1, $2, $3, $4, $5, $6::jsonb, $7)',
          [rid, e.labId ?? e.objectId, at.toISOString(), reason, hash, JSON.stringify(artefact ?? null), consent.snapshots],
        );
        const { artefact: _dropped, ...rest } = e.result;
        void _dropped;
        result = { ...rest, sha256: hash, reason };
      }

      const r = await db.query(
        `insert into analytics.learning_events
           (client_id, research_id, session_id, occurred_at, verb, object_type, object_id, course_slug, unit_index, topic_index, lab_id, lab_level,
            result, context, device_class, connection_class, app_version, locale, research_consented)
         values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19)
         on conflict (client_id, occurred_at) do nothing`,
        [
          e.id, rid, e.sessionId, at.toISOString(), e.verb, e.objectType, e.objectId, e.course ?? null, e.unit ?? null, e.topic ?? null,
          e.labId ?? null, e.labLevel ?? null, result === null ? null : JSON.stringify(result), e.context ? JSON.stringify(e.context) : null,
          e.deviceClass, e.connectionClass, e.appVersion, e.locale ?? null, consent.events,
        ],
      );
      void r;
      accepted.push(e.id);
    }
    return { accepted, rejected };
  });

  app.get('/api/me/data', { preHandler: requireAuth }, async (req) => {
    const userId = req.userId!;
    const rid = researchIdFor(researchSalt, userId);
    const consent = await loadConsent(db, userId);
    const recent = await db.query<EventRow>(
      `select ${EVENT_COLUMNS} from analytics.learning_events where research_id = $1 order by occurred_at desc limit 50`,
      [rid],
    );
    await db.query('insert into analytics.access_log (actor, action, target) values ($1, $2, $3)', [userId, 'reidentify', rid]);
    return {
      ...(await summary(db, rid, consent)),
      noticeVersion: CURRENT_NOTICE_VERSION,
      recent: recent.rows.map((r) => ({
        id: r.client_id,
        occurredAt: iso(r.occurred_at),
        verb: r.verb,
        objectType: r.object_type,
        objectId: r.object_id,
        course: r.course_slug,
        unit: r.unit_index,
        topic: r.topic_index,
        labId: r.lab_id,
        labLevel: r.lab_level,
        result: r.result,
        inResearchStream: r.research_consented,
      })),
    };
  });

  app.get('/api/me/data/export', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.userId!;
    const format = (req.query as { format?: string }).format === 'csv' ? 'csv' : 'json';
    const rid = researchIdFor(researchSalt, userId);
    const rows = await db.query<EventRow>(`select ${EVENT_COLUMNS} from analytics.learning_events where research_id = $1 order by occurred_at limit 50000`, [rid]);
    const snaps = await db.query<{ lab_id: string; taken_at: unknown; reason: string; sha256: string; artefact: unknown }>(
      'select lab_id, taken_at, reason, sha256, artefact from analytics.lab_snapshots where research_id = $1 order by taken_at limit 5000',
      [rid],
    );
    await db.query('insert into analytics.access_log (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)', [
      userId,
      'export',
      rid,
      JSON.stringify({ format, events: rows.rowCount, snapshots: snaps.rowCount, self: true }),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="my-learning-events-${stamp}.csv"`);
      return reply.send(toCsv(rows.rows));
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="my-learning-data-${stamp}.json"`);
    return reply.send(
      JSON.stringify(
        {
          format: 'cslab-learning-data',
          version: 1,
          exportedAt: new Date().toISOString(),
          consent: await loadConsent(db, userId),
          events: rows.rows.map((r) => ({ ...r, occurred_at: iso(r.occurred_at), received_at: iso(r.received_at) })),
          snapshots: snaps.rows.map((s) => ({ ...s, taken_at: iso(s.taken_at) })),
        },
        null,
        2,
      ),
    );
  });

  app.delete('/api/me/data', { preHandler: requireAuth }, async (req) => {
    const userId = req.userId!;
    const rid = researchIdFor(researchSalt, userId);
    const out = await db.transaction(async (tx) => {
      const ev = await tx.query('delete from analytics.learning_events where research_id = $1', [rid]);
      const sn = await tx.query('delete from analytics.lab_snapshots where research_id = $1', [rid]);
      await tx.query('insert into analytics.access_log (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)', [
        userId,
        'delete',
        rid,
        JSON.stringify({ reason: 'learner_request', eventsDeleted: ev.rowCount, snapshotsDeleted: sn.rowCount }),
      ]);
      return { eventsDeleted: ev.rowCount, snapshotsDeleted: sn.rowCount };
    });
    return out;
  });
}
