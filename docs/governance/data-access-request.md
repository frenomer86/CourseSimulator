# Research data access request

Send the completed form to the project's data protection contact. The data access committee
(project lead, one educator, one person independent of the project) answers within 30 days
against the criteria in [docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md](../05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md),
section 6: public benefit, proportionality, researcher capability and security of the
receiving environment. Approved requests and releases are listed in a public register.

## 1. Requester

- Name, position, institution, email:
- Co-investigators (name, institution):
- Ethics approval: committee, reference number, date (attach the letter):

## 2. Study

- Title:
- Research question(s):
- Why this dataset answers them (two or three sentences):
- Planned outputs (thesis, paper, report) and expected dates:

## 3. Data requested

- Tier: open aggregates / safeguarded event-level / controlled (see section 6 of the design):
- Date range of events:
- Courses, units or labs of interest (or all):
- Variables needed (refer to the xAPI profile in `packages/lab-runtime/src/xapiProfile.ts` and the event columns in `apps/api/migrations/0002_analytics.sql`):
- Formats: CSV / xAPI JSON lines:

## 4. Analysis plan

- Methods (describe briefly; attach a pre-registration if there is one):
- Software and where the analysis will run:
- Will the data be linked with any other dataset? (Linking is not permitted without a
  separate agreement.)

## 5. Security and retention

- Where the data will be stored (encrypted disk, access-controlled server):
- Who will have access (named people only):
- Destruction date and method:

## 6. Undertakings

By signing, the requester agrees to the data use agreement in
[data-use-agreement.md](data-use-agreement.md), including: no attempt to re-identify any
participant; no onward sharing; secure storage; destruction on the agreed date; citation of
the dataset; and a short summary of findings returned to the project.

Signature, name, date:

---

For the committee: decision, date, conditions, release id, export parameters (date range,
format), name of the person who ran the export.
