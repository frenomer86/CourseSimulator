-- Learning analytics and research data (docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md).
-- Identified world: users, profiles. Pseudonymous world: everything in the analytics schema,
-- keyed by research_id = HMAC-SHA256(salt kept outside the database, user id).
-- Nothing in analytics references users by foreign key, on purpose.

create schema if not exists analytics;

-- One row per user: the current consent. Cascades away with the account.
create table analytics.consents (
  user_id            uuid primary key references users (id) on delete cascade,
  notice_version     text not null,
  research_events    boolean not null default false,
  research_snapshots boolean not null default false,
  research_social    boolean not null default false,
  contact_followup   boolean not null default false,
  guardian_consent   boolean not null default false,
  consented_at       timestamptz not null default now(),
  withdrawn_at       timestamptz
);

-- Every change, kept under the research id so the audit survives account deletion.
create table analytics.consent_history (
  id                 bigserial primary key,
  research_id        text not null,
  notice_version     text not null,
  research_events    boolean not null,
  research_snapshots boolean not null,
  research_social    boolean not null,
  contact_followup   boolean not null,
  guardian_consent   boolean not null,
  recorded_at        timestamptz not null default now()
);
create index consent_history_rid_idx on analytics.consent_history (research_id, recorded_at);

-- Append-only learning events (xAPI-shaped), partitioned by month of occurrence.
-- The API creates each month's partition on first use; the default partition is a safety net.
create table analytics.learning_events (
  id                 bigserial,
  client_id          uuid not null,               -- idempotency for retried batches
  research_id        text not null,
  session_id         uuid not null,
  occurred_at        timestamptz not null,
  received_at        timestamptz not null default now(),
  verb               text not null,
  object_type        text not null,
  object_id          text not null,
  course_slug        text,
  unit_index         smallint,
  topic_index        smallint,
  lab_id             text,
  lab_level          text,
  result             jsonb,
  context            jsonb,
  device_class       text not null,
  connection_class   text not null,
  app_version        text not null,
  locale             text,
  -- captured at ingest: was research use consented at that moment?
  research_consented boolean not null default false,
  primary key (id, occurred_at),
  unique (client_id, occurred_at)
) partition by range (occurred_at);

create table analytics.learning_events_default partition of analytics.learning_events default;

create index learning_events_rid_idx on analytics.learning_events (research_id, occurred_at);
create index learning_events_content_idx on analytics.learning_events (course_slug, unit_index, topic_index, occurred_at);
create index learning_events_lab_idx on analytics.learning_events (lab_id, occurred_at) where lab_id is not null;

-- The artefact a learner produced (circuit, program, query, configuration) at each submission.
create table analytics.lab_snapshots (
  id                 bigserial primary key,
  research_id        text not null,
  lab_id             text not null,
  taken_at           timestamptz not null,
  reason             text not null,               -- submit | autosave | pass
  sha256             text not null,
  artefact           jsonb not null,
  research_consented boolean not null default false,
  deidentified       boolean not null default false
);
create index lab_snapshots_rid_idx on analytics.lab_snapshots (research_id, taken_at);
create index lab_snapshots_lab_idx on analytics.lab_snapshots (lab_id, taken_at);

-- Research releases built by the export job.
create table analytics.releases (
  id               uuid primary key default gen_random_uuid(),
  version          text not null,
  tier             text not null,                 -- open | safeguarded | controlled
  requested_by     text not null,
  approved_by      text[] not null default '{}',
  dua_signed_at    timestamptz,
  release_salt_id  text not null,
  built_at         timestamptz,
  doi              text,
  notes            text,
  created_at       timestamptz not null default now()
);

-- Every export, re-identifying lookup, deletion and consent change.
create table analytics.access_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  actor    uuid,
  action   text not null,                         -- export | reidentify | delete | consent_change | ingest_rejected
  target   text,
  detail   jsonb
);
create index access_log_at_idx on analytics.access_log (at);
