# Curriculum research and restructure

Research notes for the 2026-10 restructure of the CS Virtual Lab curriculum to the shape leading universities use,
at bachelor's, master's and doctoral level. University names appear only in these notes, never in the app's data or UI.

- One note per programme (linked below). Each has per-level comparison tables for 3 to 5 universities, the common
  core, prerequisite chains, representative week-by-week schedules, a gap analysis and the proposed structure, with
  sources. Where a page could only be read through a search summary, the note says so.
- [task-bank-sizing.md](task-bank-sizing.md): topics x levels x templates needed per course, and which engine
  carries each topic.

## What changed in the data

| | Before | After |
| --- | ---: | ---: |
| Courses | 116 (all bachelor's) | 230 (155 bachelor's, 67 master's, 8 doctoral) |
| Programme levels | bachelor's only, 12 to 21 courses | bachelor's, master's and doctoral for all 17 |
| Bachelor's courses per programme | 12 to 21 (Computer Science 53) | 35 to 40 (Computer Science 59) |
| Weekly layout | unit week ranges only | 13 weeks per course: topics, an exercise and tasks at three levels with an engine |

- `data/programmes.json`: 114 new courses in `newCourses` (each with a `level`), and every programme now has
  `levels.bachelor | master | phd` with `award`, `years`, `core` (suggested order), `electives`,
  `electivesRequired` and `milestones` (qualifying exam, proposal, thesis and so on). The generator derives the
  programme's flat `courses` list (used by the existing pages) from the bachelor's core then electives.
- `data/syllabi/<slug>.json`: 114 new files, and a `schedule` added to all 116 existing ones. Each week is
  `{ week, title, topics: ["unit.topic", ...], exercise, tasks: [{ level, topic, engine, title }] }`.
- `data/courses.json` (generated): new `level` on each course and `weeks` (number of teaching weeks). The schedule
  itself stays in the syllabus file and the web app loads it per course, so the catalogue bundle stays small.
- `scripts/build-courses.mjs` validates every schedule (12 or 13 weeks, valid topic refs, every topic taught,
  all three levels each week, known engines) and every programme level.

## Unit and topic positions (no remapping needed)

No existing unit or topic was reordered, renamed or removed, so labs, topic checks and task templates that attach
by 1-based `unit` and `topicIndex` are unaffected. The only change to existing units is the `weeks` label of the last
unit in 11 courses that ran to week 14; it now ends at week 13:

| Course | Unit | Old weeks | New weeks |
| --- | ---: | --- | --- |
| circuit-analysis | 10 | 13-14 | 13 |
| control-systems | 9 | 14 | 13 |
| data-wrangling-and-preparation | 8 | 14 | 13 |
| digital-signal-processing | 9 | 13-14 | 13 |
| requirements-engineering | 9 | 14 | 13 |
| responsible-ai | 8 | 14 | 13 |
| secure-software-development | 9 | 14 | 13 |
| signals-and-systems | 9 | 14 | 13 |
| software-architecture-and-design-patterns | 8 | 13-14 | 13 |
| software-testing-and-quality-assurance | 9 | 14 | 13 |
| vlsi-design | 9 | 13-14 | 13 |

## Structure per programme

Counts are core + elective pool, with the number of electives a student takes in brackets. Master's and doctoral
elective pools include some advanced bachelor's courses, as taught master's programmes commonly allow.

| Programme | Bachelor's | Master's | Doctoral |
| --- | --- | --- | --- |
| [Computer Science](computer-science.md) | 29 + 30 (8) | 5 + 11 (5) | 2 + 7 (3) |
| [Computer Engineering](computer-engineering.md) | 28 + 11 (6) | 5 + 10 (4) | 3 + 5 (3) |
| [Software Engineering](software-engineering.md) | 30 + 10 (4) | 5 + 8 (4) | 3 + 7 (3) |
| [Data Analytics](data-analytics.md) | 23 + 12 (6) | 6 + 8 (4) | 4 + 5 (3) |
| [Data Science](data-science.md) | 26 + 10 (6) | 6 + 8 (4) | 4 + 5 (3) |
| [Information Systems](information-systems.md) | 27 + 12 (6) | 6 + 9 (4) | 4 + 5 (3) |
| [Machine Learning](machine-learning.md) | 25 + 13 (6) | 7 + 9 (3) | 4 + 6 (3) |
| [Cloud Computing](cloud-computing.md) | 27 + 12 (5) | 5 + 10 (4) | 3 + 6 (3) |
| [Bioinformatics](bioinformatics.md) | 25 + 12 (6) | 6 + 9 (4) | 5 + 5 (3) |
| [Health Informatics](health-informatics.md) | 26 + 12 (6) | 6 + 9 (4) | 5 + 5 (3) |
| [Robotics](robotics.md) | 26 + 12 (6) | 6 + 7 (4) | 4 + 5 (3) |
| [Cybersecurity](cybersecurity.md) | 29 + 10 (4) | 5 + 8 (4) | 3 + 6 (3) |
| [Artificial Intelligence](artificial-intelligence.md) | 25 + 12 (6) | 6 + 10 (4) | 3 + 7 (3) |
| [Information Technology](information-technology.md) | 25 + 10 (5) | 6 + 8 (4) | 3 + 6 (3) |
| [Networking and Telecommunications](networking-and-telecommunications.md) | 27 + 12 (6) | 5 + 10 (4) | 3 + 7 (3) |
| [Game Development](game-development.md) | 21 + 15 (6) | 6 + 9 (4) | 3 + 6 (3) |
| [Financial Technology](financial-technology.md) | 26 + 12 (5) | 6 + 9 (4) | 4 + 6 (3) |

## How the per-programme proposals were merged

Each note's "proposed structure" is that programme's proposal before de-duplication. Shared titles were created
once, and these near-duplicates were folded together:

| Proposed in the notes | Created as |
| --- | --- |
| Doctoral Research Seminar in <field> (17 programmes) | Doctoral Research Seminar (shared, field-neutral) |
| Cloud Engineering / Information Systems / Financial Technology Capstone Project | Computing Capstone Project |
| Computer Engineering Capstone Project, Robotics Capstone Project, Telecommunications Engineering Project | Engineering Capstone Project |
| Systems Integration and Enterprise Architecture | Enterprise Architecture and Integration |
| Enterprise Architecture and Digital Transformation | Strategic Management of Information Technology |
| Cloud Architecture and FinOps | Advanced Cloud Architecture and Virtualisation |
| Optimisation and Prescriptive Analytics | Advanced Optimisation (with a prescriptive-analytics unit) |
| Advanced Research Design for Information Systems, Empirical Research Methods for Interactive Systems | Advanced Research Design and Empirical Methods |
| Advanced Topics in Computer Architecture | Advanced Computer Architecture (with a research-paper strand) |
| Electromagnetics for Engineers | Electromagnetics, Antennas and RF Engineering |

A course proposed at different levels by different programmes takes the lowest level (for example Probabilistic
Graphical Models is a master's course that the robotics doctorate also uses).
