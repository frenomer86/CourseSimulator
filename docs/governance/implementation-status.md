# Research data: what is built and what is still design

Maps [docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md](../05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md)
to the code as of 19 October 2026. "Built" means implemented in `apps/api`, `apps/web` or
`packages/lab-runtime` with tests; "design" means specified in the document but not yet in code.

| Area (design section) | Status | Where |
| --- | --- | --- |
| Three streams kept apart: operational, learning events, research releases (1) | Built for the first two: request logs carry no bodies and redact auth headers; learning events live in the `analytics` schema with no foreign key to accounts | `apps/api/src/app.ts` logger, `apps/api/migrations/0002_analytics.sql` |
| xAPI profile: fixed verbs (ADL reused), activity types, extensions, allowed pairs (2) | Built and published from the runtime package | `packages/lab-runtime/src/xapiProfile.ts` |
| Event SDK: stamps session, device, connection, version; validates; batches 20 or 10 s; offline queue; drops when nobody is signed in (8) | Built with tests; the web app keeps the queue in IndexedDB | `packages/lab-runtime/src/analytics.ts`, `apps/web/src/lib/telemetry.ts` |
| Events recorded today (3) | Built: app launched and terminated; course and unit viewed; lab launched, hint asked, submitted, passed or failed, reset; lab artefact saved at each check; topic-check items answered, check passed or failed; consent given or withdrawn | page hooks in `apps/web/src/pages/*.tsx`, `ResearchCard.tsx` |
| Tutorial, forum, group, competition and facilitator events (3) | Design (those features do not exist yet); verbs already in the profile | |
| Ingestion endpoint: validates, clamps clocks, assigns the research id, monthly partitions, never logs payloads (8) | Built | `POST /api/events` in `apps/api/src/analytics.ts` |
| Identity separation by HMAC research id with the salt outside the database (4) | Built; `RESEARCH_SALT` is required in production | `researchIdFor()`, `server.ts` |
| Consent: separate, opt-in, per purpose, notice version, history, withdrawal, under-18 guardian confirmation (5) | Built | `analytics.consents`, `consent_history`, `PUT /api/me/consent`, `ResearchCard.tsx`, sign-up option |
| Research flag captured at ingest time, so withdrawal stops future inclusion at once (5) | Built | `learning_events.research_consented` |
| Lab snapshots stored with a hash; only the hash kept in the event (3, 7) | Built; de-identification scan before release is design | `analytics.lab_snapshots` |
| Your-data page: view counts and recent events, download JSON and CSV, delete (5) | Built | `/profile/data`, `GET /api/me/data`, `GET /api/me/data/export`, `DELETE /api/me/data` |
| Account deletion keeps only research-consented records (4) | Built | `purgeOnAccountDelete()` |
| Access log of every self-export, re-identifying lookup, deletion and consent change (5) | Built | `analytics.access_log` |
| Releases register and release-specific re-keying (4, 6) | Table exists; the export job that builds a release is design | `analytics.releases` |
| De-identification pass, k-anonymity check, DDI codebook, DataCite record, Parquet (6) | Design | |
| Lecturer analytics views with a human-in-the-loop note (5, 8) | Design (no classes yet) | |
| OpenTelemetry traces and metrics, error tracker with scrubbing (2) | Design; Docker rotates the JSON request logs | `docker-compose.yml` |
| Privacy notice, data access request form, data use agreement (8) | Built as documents here; the notice renders in the app at `/research-data` | `docs/governance/` |
| DPIA, record of processing, incident runbook, controller registration, data access committee, public register (5, 9) | Organisational; to be written before the pilot | |

## Before the pilot

Work through section 9 of the design document. The technical items already in place are the
profile, the SDK validation, the salt outside the database, the tables with an access log, and
the your-data page with delete. Still to do: the export job (first open aggregate release as a
dry run), ethics approval, controller registration, the committee and the public register.
