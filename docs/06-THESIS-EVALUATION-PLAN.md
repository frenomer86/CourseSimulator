# Thesis Evaluation Plan

Version 1, 19 October 2026. Expands section 9 of the [blueprint](01-BLUEPRINT.md) into a
study that can be approved by an ethics committee, pre-registered, run during one teaching
block, and written up. It uses the analytics stream defined in
[05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md](05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md) and
the consent machinery already built, so the pilot is also the first research release.

## 1. Research questions and hypotheses

| | Question | Hypothesis | Primary measure |
| --- | --- | --- | --- |
| RQ1 | Does learning with the simulator improve practical competence in a computing course for students with little access to hardware? | H1: post-test scores and practical task scores are higher after use, and higher than a comparison group taught with existing labs, with at least a medium effect (d ≥ 0.5). | Concept and practical test, pre and post; practical task rubric |
| RQ2 | Does it improve confidence (self-efficacy) in doing practical work? | H2: self-efficacy rises from pre to post, more than in the comparison group. | Self-efficacy scale |
| RQ3 | Is the platform usable and acceptable on the devices and networks students actually have? | H3: mean SUS ≥ 68 overall and ≥ 60 on the phone and 2G/3G subgroup; TAM usefulness and ease-of-use means above the scale midpoint. | SUS, TAM, technical measurements |
| RQ4 | How do students actually use it: time on task, attempts, hints, errors, help seeking, and do these patterns predict gains? | H4: hint use and attempt counts fall across successive labs (learning curves); time on task and labs passed predict normalised gain. | Analytics stream |
| RQ5 | Which lab level and guidance style produce the most learning per minute? | Exploratory: compare Beginner (guided), Intermediate and Advanced labs on gain per minute and on abandonment. | Analytics stream plus tests |
| RQ6 | Can lecturers adopt it to set and mark practical tasks? | Exploratory: lecturers can author a task and read class analytics without support; grader agreement with lecturer marking is high (kappa ≥ 0.8). | Facilitator interviews, grader agreement study |

## 2. Study design

**Core design.** Quasi-experimental, non-equivalent groups, pre-test and post-test. Two intact
class groups of the same course at the partner institution: the **simulator group** uses the
platform for the unit's practical work; the **comparison group** does the existing practical
work (demonstrations, shared bench time, or paper exercises, whichever the course currently
does). Both sit the same tests in the same week. Random assignment of individuals is not
possible in a timetabled course, so the pre-test is used as a covariate to adjust for group
differences.

**If only one class is available.** Use a within-subjects crossover: two units of the course,
A and B, of similar difficulty; half the class does A on the simulator and B traditionally,
the other half the reverse; tests after each unit. This controls for group differences at
the cost of carry-over effects, which are reduced by a week's gap.

**Second cohort.** Independent learners who sign up on the public site form a natural
observational cohort for RQ3 to RQ5. They take the same in-app checks but no classroom tests.
They are analysed separately and never pooled with the classroom study.

**Mixed methods.** Quantitative tests and analytics are explained with interviews and focus
groups; the two are integrated at the interpretation stage (convergent design).

**Pilot course.** Digital Logic Design, because its engine and six labs exist. The unit under
study is combinational logic through adders (syllabus units 2 to 4). A second course
(Computer Networking I or Programming with C) is added when its engine ships, which also lets
RQ2 of the blueprint (which engine types help most) be addressed.

## 3. Participants

- **Classroom study.** One cohort taking the pilot course, two groups of 30 to 60. A power
  analysis for ANCOVA with pre-test covariate, alpha 0.05, power 0.80, d = 0.5 needs about
  64 per group for an independent comparison; with the pre-test explaining 40 percent of
  post-test variance the requirement drops to about 40 per group. If the cohort is smaller,
  report the achieved power and treat results as a pilot estimate.
- **Facilitators.** Two to four lecturers or teaching assistants for RQ6.
- **Inclusion.** Enrolled in the course; aged 18 or over, or with guardian consent through
  the institution; owns or can borrow any phone or laptop.
- **Recruitment.** Briefing in class by someone other than the course assessor; written
  information sheet; consent to the study is separate from the in-app research consent and
  from course participation. Grades are never affected by taking part or not.
- **Incentives.** Data bundles to cover the pilot's usage (budgeted per participant),
  disclosed to the ethics committee.

## 4. Instruments

| Instrument | Content | When | Notes |
| --- | --- | --- | --- |
| **Concept and practical test** | 20 items blueprinted to the unit's topics: number representation, gates and Boolean simplification, combinational blocks (muxes, adders), reading and predicting a circuit, finding a fault. Two parallel forms (A, B) counterbalanced. | Week 1 and week 6 | Written with the course lecturer; piloted on a previous cohort or senior students; item analysis (difficulty 0.3 to 0.8, discrimination > 0.2); reliability by KR-20 ≥ 0.7 |
| **Practical task** | One timed task: build and verify a specified circuit (half adder plus enable) on paper or breadboard for the comparison group and in the simulator for the simulator group, marked with a common rubric (correctness, verification, explanation). | Week 6 | Two markers blind to group; inter-rater agreement by kappa |
| **Self-efficacy scale** | 8 items, 7-point, adapted from established computing self-efficacy scales, about confidence to design, build and debug circuits. | Weeks 1 and 6 | Cronbach's alpha reported |
| **System Usability Scale** | Standard 10 items. | Week 6, simulator group and independent learners | Score 0 to 100; benchmark 68; adjective rating |
| **Technology Acceptance Model** | Perceived usefulness (6), perceived ease of use (6), behavioural intention (3), 7-point. | Week 6 | Means, alpha; regression of intention on usefulness and ease |
| **Interviews and focus groups** | Semi-structured, 30 minutes: what helped, what confused, device and data problems, guidance level, competition and group features, comparison with real equipment. 12 to 16 students sampled across high and low gain and device class; all facilitators. | Weeks 6 and 7 | Audio recorded with consent, transcribed, anonymised |
| **Analytics stream** | xAPI events already collected (section 5). | Continuous | Research consent required |
| **Technical measurements** | Section 7. | Before and during the pilot | |

All instruments are stored in `docs/evaluation/instruments/` once written, with the test forms
kept out of the public repository until the study ends.

## 5. Analytics measures and their event sources

Every measure below is computed from the xAPI profile already published from
`packages/lab-runtime` (verbs such as launched, attempted, asked-for-hint, submitted,
passed, failed, abandoned, saved; objects such as lab, topic-check, check-item).

| Measure | Definition | Events |
| --- | --- | --- |
| Time on task | Sum of lab sessions from launched to passed, abandoned or terminated, capped at 10 minutes of inactivity | lab launched, passed, abandoned; app terminated |
| Attempts to pass | Number of submitted events before the first passed for a lab | lab submitted, passed |
| Hint rate | asked-for-hint per attempt | asked-for-hint, submitted |
| Error profile | Which named checks fail most, per lab and per topic | lab failed (result lists failing checks) |
| Abandonment | Labs launched but never passed within the unit | lab launched, passed |
| Learning curve | Error rate on a skill versus opportunity number, with skills tagged per check | lab submitted, failed, passed |
| Check mastery | First-attempt correctness on topic-check items; retake count | check-item answered, check passed |
| Persistence | Return sessions per week; days active | app launched |
| Help seeking | Tutorial views launched from a lab; forum threads opened from a lab (when the forum exists) | viewed with context lab id; asked |
| Device and network | Share of sessions by device class and connection class; measures above split by these | every event's context |
| Offline use | Events queued offline and later synced | received_at minus occurred_at; offline flag |

Gain per minute (RQ5) is normalised gain divided by time on task, per student and per lab
level.

## 6. Procedure and timeline

| Week | Activity |
| --- | --- |
| −4 | Ethics approval, Data Protection Commission registration confirmed, instruments piloted, pre-registration posted (OSF or AsPredicted), technical baseline measured |
| −1 | Briefing, consent, device and connectivity survey, accounts created, in-app research consent |
| 1 | Pre-test (form A or B), self-efficacy; both groups |
| 2 to 5 | Teaching of the unit as normal; simulator group does labs 1 to 6 on the platform (Beginner first, then Intermediate, Advanced optional); comparison group does existing practicals; weekly check of analytics for technical problems only |
| 6 | Post-test (the other form), self-efficacy, practical task, SUS, TAM |
| 6 to 7 | Interviews and focus groups; facilitator interviews; grader agreement study |
| 8 to 10 | Analysis, member checking of themes with a few participants, first open aggregate release built from the pilot data as the export job's dry run |
| 11 to 14 | Writing: results, discussion, thesis chapters |

The simulator group gets access to the comparison group's materials, and the comparison group
gets platform access, after week 6, so no one is disadvantaged.

## 7. Technical evaluation protocol

Measured before the pilot and sampled during it, on three device classes: a low-end Android
phone (2 GB RAM), a mid-range phone, and a laptop; on three connections: throttled 2G
(250 kbit/s, 300 ms), 3G (1.5 Mbit/s, 100 ms) and Wi-Fi.

- Cold and warm load time to interactive for the home page, a course page and a lab.
- Memory and frame rate while simulating the largest lab circuit.
- Offline: complete a lab with the network off, reconnect, confirm progress and events sync.
- Data use per lab session in kilobytes.
- Grader accuracy: the automatic checks versus two lecturers marking the same 60 artefacts;
  agreement by Cohen's kappa and a list of disagreements.
- Reliability during the pilot: uptime, error rate, failed event uploads from the
  operational logs.

## 8. Analysis plan

Pre-registered before week 1. Analysis scripts in R or Python live in `docs/evaluation/analysis/`
and run against the released dataset, not the live database.

**Learning (RQ1, RQ2).**
- Normalised gain g = (post − pre) / (max − pre) per student; report mean g and its interval.
- Primary test: ANCOVA on post-test with group as factor and pre-test as covariate; check
  homogeneity of slopes. Report adjusted means, F, p, partial eta squared, and Cohen's d or
  Hedges' g with 95 percent intervals.
- Within-group pre to post: paired t-test, or Wilcoxon signed-rank if not normal (Shapiro-Wilk).
- Practical task: Mann-Whitney U on rubric totals; kappa for markers.
- Self-efficacy: same as test scores; alpha for the scale.
- Missing data: report attrition by group; intention-to-treat with multiple imputation as a
  sensitivity check.

**Usability and acceptance (RQ3).**
- SUS mean, standard deviation, percentile against the published benchmark, by device and
  connection class (Kruskal-Wallis across classes).
- TAM: descriptives, alpha, and a regression of intention on usefulness and ease of use.
- Technical measures reported as tables against targets (load under 5 s on 3G, lab usable on
  2 GB phones, offline sync success above 95 percent).

**Behaviour (RQ4, RQ5).**
- Descriptives of each analytics measure; learning curves plotted as error rate versus
  opportunity per skill, with a power-law or additive factors model fit.
- Regression of normalised gain on time on task, labs passed, hint rate and attempts,
  controlling for pre-test and device class.
- Lab-level comparison: gain per minute and abandonment by Beginner, Intermediate, Advanced.
- Sequence mining of common paths (which lab, hint, tutorial, retry) for the interview
  discussion.

**Qualitative.**
- Reflexive thematic analysis of transcripts (familiarise, code, theme, review, define,
  write), two coders on a subset, codebook and agreement reported. Themes integrated with the
  quantitative results in a joint display.

**Adoption (RQ6).** Facilitator interviews analysed thematically; grader agreement kappa;
count of tasks authored and analytics views used.

## 9. Validity threats and what is done about them

| Threat | Mitigation |
| --- | --- |
| Non-equivalent groups | Pre-test covariate; report baseline differences; crossover design if one class |
| Novelty and Hawthorne effects | A five-week exposure, not a single session; comparison group gets equal attention; ask about novelty in interviews |
| Test-retest learning | Parallel forms counterbalanced |
| Teacher effect | Same lecturer teaches both groups; the lecturer is not the assessor of the study |
| Differential attrition | Track reasons; intention-to-treat |
| Device inequality | Device loan pool for the pilot; device class as a covariate; subgroup analysis |
| Experimenter bias in marking | Blind marking, two markers, rubric |
| Analytics gaps from offline use and consent refusal | Offline queue; report consent rate and compare consenters with non-consenters on test scores |
| Small sample | Report achieved power; treat as pilot; intervals over p-values |
| Generalisation | One course, one institution: state limits; the independent-learner cohort gives a second context |

## 10. Ethics and data management

- Approval from the researcher's institutional ethics committee before week −1; the
  application includes this document, the information sheet, consent forms, instruments and
  the privacy notice.
- Two consents: study participation (paper or form, held by the researcher) and in-app
  research use of learning data (the platform's own opt-in consent). A student may do the
  course on the platform with neither.
- Data handling follows the analytics specification: research ids, not names, in the analysis
  dataset; test scores joined to analytics only through a key file kept encrypted and
  destroyed at the end of the study; interview recordings deleted after transcription and
  checking; transcripts anonymised.
- The platform operator is registered as a data controller with the Data Protection
  Commission before any pilot data is collected.
- Outputs: a pre-registration, the thesis, a de-identified dataset released through the
  platform's data access process (open aggregates publicly, event-level data under the data
  use agreement), and the instruments and analysis scripts under an open licence.

## 11. Thesis chapter map

| Chapter | Draws on |
| --- | --- |
| Introduction and problem | Blueprint sections 1 to 2; hardware access data from the partner institution |
| Literature review | Simulation-based learning in computing, learning analytics, educational data mining, low-resource contexts |
| Design and implementation | Blueprint, product spec, design research, analytics specification, engines and labs |
| Methodology | This document |
| Results | Sections 5 to 8 outputs: tests, SUS and TAM, analytics, technical measures, themes |
| Discussion | Joint display of quantitative and qualitative results; answers to RQ1 to RQ6; limits |
| Conclusion and future work | Sustainability plan, second-course study, platform roadmap |

## 12. Before the pilot starts

1. Ethics approval filed; controller registration confirmed.
2. Tests written, piloted, item-analysed; forms A and B finalised; rubric agreed with markers.
3. Self-efficacy, SUS, TAM and interview guides finalised and translated where needed.
4. Pre-registration posted with this plan and the analysis scripts' skeleton.
5. Technical baseline measured and recorded.
6. Device loan pool and data bundles arranged.
7. Export job able to produce the dataset the analysis scripts expect (dry run on test data).
8. Comparison group's materials and the post-study access swap prepared.
