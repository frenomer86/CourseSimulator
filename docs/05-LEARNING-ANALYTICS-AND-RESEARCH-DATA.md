# Learning Analytics, Operational Logging and Research Data

Version 1, 18 October 2026. Extends the [product spec](03-PRODUCT-SPEC.md). Defines what the
platform records about its own operation and about how people learn on it, which standards
the records follow, how privacy law is met, and how researchers in computer science and IT
education can request the data later.

The design goal is a research-grade dataset of how students learn practical computing on
low-end devices in Africa, collected lawfully, with consent, in a form other researchers can
use and cite, without ever exposing who a learner is.

## 1. Three kinds of data, kept apart

| Stream | What it is | Standard | Who sees it | Retention |
| --- | --- | --- | --- | --- |
| **Operational telemetry** | Errors, latency, request logs, server health | OpenTelemetry (traces, metrics, logs); structured JSON logs | Platform admins only | 30 days raw, 13 months aggregated |
| **Learning events** | What a learner did in a tutorial, check, lab, forum, group or competition | xAPI 1.0.3 statements (IEEE 9274.1.1-2023), with a platform profile; exportable to 1EdTech Caliper 1.2 and PSLC DataShop formats | The learner (own data), lecturers (their class, aggregated), researchers (pseudonymised, by approval) | Identified: account lifetime plus 12 months. Pseudonymised research copy: 10 years |
| **Research datasets** | Curated, de-identified releases built from learning events plus survey instruments | FAIR principles; DDI-Codebook metadata; DataCite DOI; CSV and Parquet | Approved researchers under a data use agreement; aggregate tables public | Indefinite, versioned |

Operational telemetry never carries user identifiers beyond a short-lived request id.
Learning events are stored under a **research id** that is separate from the account id
(section 4). Research datasets are derived; nothing is ever released from the live tables.

## 2. Standards followed

**Event format.** Every learning event is an xAPI statement: actor, verb, object, result,
context, timestamp. xAPI is the standard the learning-analytics field already stores and
shares, so the dataset can be loaded into any Learning Record Store and compared with other
studies. The platform defines an xAPI profile (a published vocabulary of its verbs, activity
types and context extensions) so that every event has one meaning. Where a verb exists in the
ADL or cmi5 vocabularies it is reused rather than invented.

**Educational data mining formats.** Lab attempts are also exportable in the PSLC DataShop
"student-step" and "transaction" formats (student, problem, step, outcome, hints, duration),
which is the form most knowledge-tracing and learning-curve research expects.

**Operational logging.** OpenTelemetry for traces and metrics; logs as single-line JSON with
timestamp, level, service, request id, event, and no personal data. Errors go to an error
tracker with personal fields scrubbed before sending.

**Privacy and security.** Ghana Data Protection Act 2012 (Act 843) as the governing law; GDPR
as the design bar because the platform will have users and researchers abroad; ISO/IEC 29100
privacy framework for terminology and roles; ISO/IEC 27001 controls for the VPS; ISO/IEC 20889
for de-identification techniques.

**Learning analytics ethics.** The Jisc Code of Practice for Learning Analytics and the
DELICATE checklist (Determination, Explain, Legitimate, Involve, Consent, Anonymise, Technical,
External) are the two instruments the field uses to audit a learning-analytics deployment;
section 5 is written to satisfy both.

**Research data.** FAIR (findable, accessible, interoperable, reusable); DDI-Codebook for the
variable-level documentation; DataCite metadata and a DOI for each released version; a data
use agreement for safeguarded releases; CC BY 4.0 for aggregate open releases.

## 3. What is recorded

Events are written from the browser to an append-only ingestion endpoint. The client batches
them, queues offline, and retries. Each event carries the content id (course slug, unit,
topic, lab id, level), the research id, a session id, device class (phone, tablet, desktop),
connection class (from the Network Information API: 2g, 3g, 4g, wifi, unknown), locale, and the
app version. Timestamps are client time with a server-received time beside them.

| Area | Verbs (xAPI) | Object | Result and context extensions |
| --- | --- | --- | --- |
| Session | launched, terminated | the app | session id, device class, connection class, PWA installed or not, offline flag |
| Navigation | viewed | course, unit, topic, tutorial page | dwell time, referrer page |
| Tutorial | progressed, completed, interacted | tutorial, inline simulator | position reached, simulator inputs changed (count, not values) |
| Topic check | attempted, answered, passed, failed | check item, check | item id, response choice, correct or not, time per item, attempt number, score |
| Lab | launched, attempted, asked-for-hint, submitted, passed, failed, abandoned | lab (with level) | check results per named check, hint index, attempt number, time on task, number of edits, snapshot id |
| Lab work | saved (snapshot) | lab circuit, program, query or configuration | a hash and a stored copy of the artefact at each submission; intermediate snapshots every N edits for Advanced labs |
| Errors | experienced | runtime error, engine error | error class, message with values stripped |
| Help seeking | viewed, asked, answered | tutorial from a lab, forum thread, group message | link from lab to the thread; message length only, never text, in the research stream |
| Community | joined, left, posted, replied, voted, shared | group, forum thread, resource | counts and ids only |
| Competition | registered, submitted, scored, awarded | competition, problem | score, rank, team id, time to first correct |
| Facilitator | created, assigned, shared | class, assignment, authored lab | ids only |
| Consent | consented, withdrew | research participation, each purpose | version of the notice, purposes ticked |

Not recorded: message and post text in the research stream, free-text answers unless the
learner ticked that purpose, IP addresses beyond the operational request log, precise
location, device identifiers, keystroke timing, and anything from pages outside the app.

Lab snapshots are the most valuable research object (they show how a solution evolved) and
the most sensitive (code can contain names). They are stored, but released only after the
de-identification pass in section 6 and only for learners who ticked that purpose.

## 4. Identity separation

```
users (id)       ──┐
profiles (id, username, display_name, ...)   identified world
                   │
                   │  research_id = HMAC-SHA256(secret_salt, user id)
                   │  (salt kept only on the VPS, outside the database, rotated per release)
                   ▼
learning_events (research_id, ...)           pseudonymous world
research releases (release_id, participant_id = HMAC(release_salt, research_id))
```

- Lecturer dashboards and the learner's own history resolve research id back to a person
  through one API endpoint that checks consent and role and writes to the access log.
  Researchers never get that endpoint.
- Each released dataset re-keys participants with a release-specific salt, so two releases
  cannot be joined on identity without the project's cooperation.
- Erasure: deleting an account deletes the profile and the mapping. Events already in the
  pseudonymous stream are kept only if the learner consented to research use; otherwise they
  are deleted with the account. Already-published releases are not recalled, which the consent
  notice states.

## 5. Consent and privacy compliance

**Lawful basis.** Operating the service (accounts, progress, groups) rests on the contract
with the user. Learning analytics shown to the learner's own lecturer rests on legitimate
interest of the institution, disclosed in the notice. Use for research is **separate,
optional, opt-in consent**, asked after sign-up in its own screen, never bundled, with the
default off. Declining has no effect on access to any course, lab or competition.

**Consent record.** For each user: notice version, timestamp, each purpose separately
(research use of learning events; research use of lab snapshots; research use of forum and
message metadata; being contacted for follow-up studies), and withdrawal time. Withdrawal is
one click in settings and stops future collection into the research stream immediately.

**Children.** Age band is asked at sign-up. Under 18: research consent requires a guardian or
institution consent flow; otherwise the user is excluded from the research stream and from
public leaderboards by default. This follows Act 843's special treatment of children and the
GDPR approach.

**Act 843 obligations the project must meet.**
- Register the platform operator as a data controller with the Data Protection Commission.
- Publish a privacy notice naming the controller, purposes, categories, recipients, retention,
  rights and complaint route; keep every past version.
- Honour access, correction, objection and erasure requests within the statutory time; provide
  a self-service export of the learner's own data.
- Keep a record of processing activities and a data protection impact assessment for the
  learning-analytics and research purposes; review it yearly.
- Report breaches to the Commission and affected users; keep an incident runbook.
- Appoint a named data protection contact.

**Research ethics.** Any study using the data needs approval from the researcher's
institutional ethics committee; the project's own thesis study needs approval before the pilot.
Approval letters are stored with the data access request.

**Security on the VPS.** Encryption at rest for the database volume and backups; TLS only
(Caddy); authorisation in the API so lecturers see only their classes; the research schema
readable only by a separate database role used by the export job; an audit log of every export
and every re-identifying lookup; nightly encrypted off-site backups; quarterly access review.

**Transparency to learners.** A "your data" page shows what has been recorded about them, what
their lecturer can see, whether they are in the research stream, and lets them download or
delete it. Learning-analytics dashboards for lecturers show class patterns and flag
struggling students, with the DELICATE rule that analytics inform a human and never make an
automatic decision about a student.

## 6. Research data access

**Tiers.**

| Tier | Content | Access |
| --- | --- | --- |
| Open | Aggregate tables: completion rates, time-on-task distributions, hint usage, error frequencies by topic, by device and connection class, by country; minimum cell size 10; differential-privacy noise on small cells | Public download with DOI, CC BY 4.0 |
| Safeguarded | Pseudonymised event-level data and de-identified lab snapshots | Approved request plus signed data use agreement |
| Controlled | Anything linking to institution, class or free text; survey responses with open answers | Approved request, DUA, access only inside a project-run analysis environment, outputs checked before leaving |

**Request process.**
1. Researcher submits a form: name, institution, ethics approval, research question,
   variables needed, tier, analysis plan, data destruction date.
2. A data access committee (the project lead, one educator, one person independent of the
   project) decides within 30 days against written criteria: public benefit, proportionality,
   researcher capability, security of the receiving environment.
3. A data use agreement is signed: no re-identification attempts, no linking with other data,
   no onward sharing, secure storage, destruction on the agreed date, acknowledgement of the
   dataset by DOI, and return of a summary of findings to the platform.
4. The export job builds the release: filter to consented participants, re-key identities,
   apply the de-identification pass, generate the DDI codebook and DataCite record, log the
   release.
5. The release is delivered through an expiring download or the controlled environment; the
   request, decision and release are listed in a public register.

**De-identification pass.** Drop direct identifiers; generalise dates to week and times to
hour; generalise country to region when a cell has fewer than 10 participants; remove
institution and class unless the tier allows; scan lab snapshots and free text for names,
emails, phone numbers, student numbers and Ghana Card patterns and replace them with tokens;
check k-anonymity (k = 5) on quasi-identifiers (device class, country, age band, course);
suppress or generalise until it holds.

**Documentation shipped with every release.** README, DDI-Codebook XML for every variable,
the xAPI profile version, the consent notice version the participants saw, a changelog from
the previous release, and the citation.

## 7. Database additions

Add to `apps/api/migrations` as the next numbered migration. Sketch:

```sql
create schema analytics;

create table analytics.consents (
  user_id        uuid primary key references users (id) on delete cascade,
  notice_version text not null,
  research_events   boolean not null default false,
  research_snapshots boolean not null default false,
  research_social   boolean not null default false,
  contact_followup  boolean not null default false,
  guardian_consent  boolean not null default false,
  consented_at   timestamptz not null default now(),
  withdrawn_at   timestamptz
);

create table analytics.consent_history (like analytics.consents including all, id bigserial primary key);

-- Append-only, partitioned by month. No foreign key to profiles on purpose.
create table analytics.learning_events (
  id            bigserial,
  research_id   text not null,
  session_id    uuid not null,
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  verb          text not null,
  object_type   text not null,
  object_id     text not null,
  course_slug   text,
  unit_index    smallint,
  topic_index   smallint,
  lab_id        text,
  lab_level     text,
  result        jsonb,
  context       jsonb,
  device_class  text,
  connection_class text,
  app_version   text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table analytics.lab_snapshots (
  id            bigserial primary key,
  research_id   text not null,
  lab_id        text not null,
  taken_at      timestamptz not null,
  reason        text not null,          -- submit | autosave | pass
  sha256        text not null,
  artefact      jsonb not null,         -- circuit, program text, query, config
  deidentified  boolean not null default false
);

create table analytics.releases (
  id           uuid primary key default gen_random_uuid(),
  version      text not null,
  tier         text not null,
  requested_by text not null,
  approved_by  text[] not null,
  dua_signed_at timestamptz,
  release_salt_id text not null,
  built_at     timestamptz,
  doi          text,
  notes        text
);

create table analytics.access_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  action     text not null,            -- export | reidentify | delete | consent_change
  target     text,
  detail     jsonb
);
```

Access rules, enforced in the API and mirrored with Postgres roles: learners read only rows
whose research id matches their own; lecturers read aggregates through views scoped to their
classes; the export job's database role reads everything in `analytics`; nothing writes to
`learning_events` except the ingestion endpoint and the deletion job.

## 8. Client and server pieces to build

- **Event SDK** in `packages/lab-runtime`: `track(verb, object, result, context)` that stamps
  session, device, connection and version, validates against the xAPI profile JSON schema,
  batches 20 events or 10 seconds, stores in IndexedDB when offline, and drops the research
  fields when consent is off.
- **Ingestion endpoint** in `apps/api` (Fastify) that validates, assigns the research id,
  writes to the partition, and never logs the payload.
- **Consent screens** at first login and in settings, with the notice served from the repo
  as versioned Markdown.
- **Your-data page**: view, export (JSON and CSV), delete.
- **Lecturer analytics view**: per-class funnel per topic, time on task, hint use, common
  failing checks, struggling-student flag with a human-in-the-loop note.
- **Export job**: a script that builds a release from a request record, runs the
  de-identification pass, writes CSV and Parquet, the DDI codebook and DataCite JSON, and
  logs the release.
- **Operational telemetry**: OpenTelemetry collector on the VPS, metrics dashboard, log
  rotation at 30 days, error tracker with scrubbing.
- **Documents**: privacy notice, consent text, data protection impact assessment, record of
  processing, data access policy and request form, data use agreement template, incident
  runbook. Keep them in `docs/governance/`.

## 9. Checklist before the pilot

1. Controller registered with the Data Protection Commission; data protection contact named.
2. Privacy notice and separate research consent live, versioned, with under-18 path.
3. xAPI profile published in the repo and the SDK validating against it.
4. Research id salt stored outside the database and backed up separately.
5. Events, snapshots, consents and access log tables deployed with RLS.
6. Your-data page working, including delete.
7. Ethics approval for the thesis study obtained and filed.
8. Backups encrypted, tested by a restore; TLS; access review done.
9. Data access policy, request form, DUA template and committee members published.
10. First open aggregate release produced from pilot data as a dry run of the export job.
