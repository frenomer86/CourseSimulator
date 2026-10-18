# Product Specification — CS Virtual Lab as a learning platform

Version 1, 18 October 2026. Extends the [blueprint](01-BLUEPRINT.md) from a lab simulator
into a hosted learning platform with accounts, progress, community and competitions.
Design choices are justified in [04-DESIGN-RESEARCH.md](04-DESIGN-RESEARCH.md).

## 1. Users and roles

| Role | Who | What they can do beyond a learner |
| --- | --- | --- |
| **Learner** | Anyone who signs up; not affiliated to an institution | Everything in sections 3 to 6 |
| **Student** | A learner who joined an institution class with a class code | Appears in the lecturer's class view; receives assignments |
| **Lecturer / teacher** | Verified by an institution admin, or by a platform admin for independent tutors | Creates classes and assignments, sees class progress, exports grades, runs class competitions, moderates class forums, authors labs and topic checks |
| **Institution admin** | One or more per institution | Verifies lecturers, manages institution profile |
| **Moderator** | Trusted learners by reputation, or appointed | Handles reports, locks threads, removes content |
| **Platform admin** | The project team | Everything |

One account can hold several roles (a lecturer is also a learner). Roles are stored per
user, with institution-scoped roles stored per institution membership.

## 2. Content hierarchy

```
Course (53, by name)
└── Unit (from the detailed syllabus, 7 to 10 per course)
    └── Topic (4 to 7 per unit)
        ├── Tutorial          interactive explanation, mini-simulators inline, 5 to 15 min
        ├── Topic check       5 to 8 auto-graded items, retakable; passing = proficient
        └── Labs              Beginner (guided), Intermediate (task + hints), Advanced (challenge)
    └── Unit assessment       samples every topic in the unit
└── Course capstone           an Advanced project chaining earlier labs; earns the certificate
```

Content stays in the repository as data (JSON and Markdown) and is deployed with the app.
The database stores only what people do with it, keyed by stable content ids
(course slug, unit index, topic index, lab id). Lecturer-authored content is the exception
and lives in the database with the same shape.

## 3. Progress and mastery

- **Topic mastery** has four states: not started, attempted, proficient (topic check
  passed), mastered (Advanced lab passed, or Intermediate lab plus topic check at 100%).
- **Unit and course progress** are derived: a unit is complete when all topics are at least
  proficient and the unit assessment is passed; a course certificate requires all units
  complete plus the capstone.
- **XP**: Beginner lab 10, Intermediate 25, Advanced 50, topic check 15, unit assessment
  40, accepted forum answer 10, shared resource 5 (with a daily cap of 30 XP from Beginner
  labs and from resources). Each lab's XP is awarded once; repeats give no XP.
- **Levels** from XP; **weekly streak** continues when a new topic reaches proficient that
  week; **badges** for streak lengths, course levels, first passes, helpfulness.
- Progress is stored locally first (offline) and synced to the account when online, with a
  queue that replays writes in order. Conflicts resolve to the highest mastery.

## 4. Tutorials and topic checks

- Tutorials are Markdown with embedded components: a mini circuit, a code snippet that runs,
  a plot, a small quiz. Written in the Brilliant style: one idea, then do something.
- Topic check item types: multiple choice, multiple select, numeric with tolerance, short
  text matched by pattern, order-the-steps, and "fix this circuit/code" (reuses the lab
  engines). Items are drawn from a pool so retakes differ.
- Lecturers can author tutorials and checks for their class; approved ones can be
  promoted to the shared catalogue.

## 5. Community

### Groups
- Types: **study group** (anyone creates, open or invite-only), **class group** (created
  automatically with a lecturer's class), **competition team** (lives for the competition).
- Each group has: members with roles (owner, admin, member), a **chat room**, a **resource
  library** (links, notes, uploaded files up to 10 MB each with an institution-level
  quota), pinned posts, and a **who-is-online rail** showing members currently connected.
- Presence uses realtime channels scoped to the group; it carries only display name and
  avatar, never email or ids.

### Forum
- Categories: one per course, plus General, Help, Careers, and Lecturers (restricted).
- Threads can be **attached to a course, a unit, a topic or a specific lab**, so a stuck
  student sees relevant questions beside the lab and can ask from there.
- Replies, upvotes, tags, an **accepted answer** chosen by the asker or a lecturer, a
  solved marker, and a "similar threads" prompt before posting.
- Lecturer-endorsed answers are highlighted.

### Direct messages
- One-to-one conversations between members who share a group or class, or who have
  accepted a contact request. Learners can block anyone; minors' accounts (declared age
  under 18) can message only within their class groups.

### Sharing ideas and resources
- Any member can share a resource to a group or to a course's public library: link, note,
  file, or a **solution share** (a passed Advanced lab's circuit or code, opt-in, visible
  only to others who have also passed it).
- Shares, accepted answers and helpful votes feed the **contribution score**.

### Notifications
- In-app inbox: replies, mentions, accepted answers, group invites, assignment deadlines,
  competition start and results. Email digests are optional and off by default.

## 6. Competitions

### Formats
1. **General contest** (individual, LeetCode style): a problem set of 3 to 6 labs or
   checks, a window of 60 to 120 minutes, open to everyone or to an institution. Score =
   sum of problem points; ties broken by total finishing time with a penalty per failed
   check run. Live board during the contest; final board and a **contest rating** update
   afterwards.
2. **Group contest** (team, Kaggle style): teams of 2 to 5 from an existing group or
   formed for the event. Team score = sum of the top 3 members' scores plus a
   collaboration bonus when every member scores. Runs for 1 to 14 days.
3. **League season** (ongoing, Duolingo style): weekly cohorts of up to 30 learners with
   similar levels; difficulty-weighted XP decides promotion (top 20%), staying, and
   demotion (bottom 15%). Tiers: Bronze, Silver, Gold, Platinum, Diamond.
4. **Co-op quest** (inside a group): a five-day shared goal such as "the group passes 20
   Intermediate labs"; everyone who contributed earns the reward.

### What is displayed
- Every participant (or team and its members) with rank, score, and a **contribution
  breakdown**: labs solved by level, checks passed, forum answers accepted during the
  event, resources shared during the event.
- Awards: gold, silver, bronze per contest; "first solve" per problem; "most helpful"
  (accepted answers); "top contributor" per team; tier badges from cumulative results.
- Profiles show a trophy case and contest rating history.

### Fairness
- Problems are drawn from a hidden pool and released at the start; solutions are not shown
  until the contest ends. Each problem scores once per participant. Hint use reduces
  points by 20% per hint. Lecturers can restrict a contest to their class and review
  submissions.

## 7. Lecturer tools

- Create a class with a join code; see each student's mastery per topic and lab results.
- Assign tutorials, checks and labs with deadlines; export grades as CSV.
- Run a class contest or quest; moderate the class forum and group.
- Author labs, tutorials and checks with the same JSON format as the catalogue.

## 8. Safety, privacy and moderation

- Minimal data: email, display name, optional institution and programme, declared age band.
- Ghana Data Protection Act 843 and GDPR: consent at sign-up, export and delete account
  from settings, data stored in a named region, no selling of data.
- Reporting on any post, message or resource; moderators and lecturers act; audit log.
- Profanity filter on public posts; rate limits on posting and messaging; new accounts
  cannot post links for 24 hours.
- Presence and leaderboards show display names only; a user can opt out of public boards.

## 9. Architecture

```
PWA (React) ──── Supabase JS ────┐
  offline queue                  │
  simulators (WASM/JS)           ▼
                     Supabase project (one region)
                     ├── Postgres  (schema in supabase/migrations)
                     ├── Auth      (email + password, magic link, Google; institution SSO later)
                     ├── Realtime  (presence per group, chat broadcast, live boards)
                     ├── Storage   (resource files, avatars; signed URLs)
                     └── Edge Functions (contest scoring, league rollover, digests)
Static host (Cloudflare Pages / Vercel) serves the PWA and the content bundle.
```

- **Why Supabase first**: Postgres with row-level security gives one place for all data
  and access rules; Realtime presence and broadcast cover "who is online" and chat with
  no extra servers; the free tier covers a departmental pilot; everything is standard
  Postgres, so self-hosting later is a migration of config, not code.
- **Access control** is row-level security in the database, not application code, so the
  rules in [supabase/migrations](../supabase/migrations) are the single source of truth.
- **Leaderboards**: a `competition_scores` table maintained by triggers on submissions;
  the client polls every 15 seconds during a live contest. No Redis at this scale.
- **Offline**: the local store remains the source of truth for the simulator state; the
  account holds results and mastery.

## 10. Data model (summary)

Identity: `profiles`, `institutions`, `institution_members`, `classes`, `class_members`.
Learning: `topic_progress`, `lab_results`, `check_attempts`, `xp_events`, `badges`,
`user_badges`, `certificates`, `assignments`, `assignment_submissions`.
Community: `groups`, `group_members`, `group_messages`, `resources`, `forum_categories`,
`forum_threads`, `forum_posts`, `post_votes`, `conversations`, `conversation_members`,
`direct_messages`, `notifications`, `reports`, `blocks`.
Competition: `competitions`, `competition_problems`, `competition_participants`,
`competition_teams`, `competition_team_members`, `competition_submissions`,
`competition_scores`, `awards`, `leagues`, `league_members`, `contest_ratings`.

The full schema with constraints and policies is in
[supabase/migrations/0001_initial.sql](../supabase/migrations/0001_initial.sql).

## 11. Delivery plan (revised)

| Phase | Scope | Outcome |
| --- | --- | --- |
| 1a (done) | Catalogue, Digital Logic simulator, six labs, offline PWA | Demo-able |
| 1b | Accounts, profiles, progress sync, topic structure from syllabi, topic checks, tutorials for Digital Logic | A learner can sign up and keep progress across devices |
| 1c | Remaining Phase 1 engines (code runner, network, SQL, visualiser, maths) with labs | Pilot-ready for Year 1 and 2 |
| 2 | Groups with chat, presence and resources; forum; direct messages; notifications | Community live |
| 3 | General contests, group contests, leagues, quests, awards, profiles with trophies | Competitions live |
| 4 | Lecturer tools, institutions, assignments, grade export, moderation tools | Institution adoption |
| 5 | Remaining engines and courses, certificates, localisation, self-host option | Full platform |
