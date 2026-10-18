# Design Research — what the best educational platforms do, and what we borrow

Reviewed 18 October 2026. The goal is not to copy any one site but to take the mechanic
each one is known for, judge whether it serves learning (not only engagement), and adapt
it to students on cheap phones and metered data in Ghana and across Africa.

## 1. Platform by platform

### Khan Academy — mastery, not completion
- Content is organised **course → unit → skill**. Progress is tracked per skill with
  mastery levels (familiar, proficient, mastered) rather than a binary "done".
- Each unit has a **unit test** and each course a **course challenge** that samples skills
  across the whole course, so mastery can decay and be re-proven.
- **Streaks are weekly**, not daily: a streak continues when you reach proficiency in at
  least one new skill that week. Skill points raise a course level; badges at levels 5,
  10, 15, 25, 50, 75, 100.
- Lesson: a weekly streak is far kinder to students with intermittent connectivity than
  Duolingo's daily one. Mastery per topic gives lecturers a real signal.

### Brilliant — learn by doing, guided when stuck
- No lectures; every lesson is an **interactive problem** with immediate feedback.
  Visual models that update as you drag.
- Hints are **progressive and diagnostic**: the tutor asks a guiding question, then shows a
  visual hint, aiming to find where you are stuck rather than revealing the answer.
- Short daily lessons, XP, streaks and **weekly leagues**.
- Lesson: this is exactly the Beginner tier the brief asks for ("has some guidance"). Our
  hints already reveal in steps; add a diagnostic first hint tied to the failing check.

### Duolingo — leagues and quests, with a known failure mode
- **Leagues**: tiers from Bronze to Diamond; weekly XP decides promotion (top 10),
  staying (next 15) and demotion (bottom 5) in cohorts of about 30.
- **Friend quests**: a randomly paired buddy and a five-day cooperative goal with a
  shared reward, the cooperative counterweight to leagues.
- Documented failure: leagues reward **volume over difficulty**; people grind easy items
  for XP. Critics also note engagement is optimised ahead of learning.
- Lesson: adopt leagues and co-op quests, but weight points by difficulty, award each lab's
  points once, and cap daily points from Beginner labs.

### LeetCode — timed contests and ratings
- **Weekly and biweekly contests**: a fixed problem set in about 90 minutes, a live
  leaderboard, ranking by score then by finishing time with wrong-answer penalties.
- A persistent **contest rating** updated after each contest; badges for rating
  percentiles (for example top 5%). A rating predictor keeps people watching.
- Lesson: this is our "general competition" format. Postgres can hold a per-contest
  scoreboard; a simple polling refresh is enough at our scale.

### Kaggle — team competitions and contribution tiers
- Competitions allow **teams** (merging individuals), a public leaderboard during the
  event and a private one for the final result.
- Progression tiers (Novice to Grandmaster) are earned separately in four
  **contribution categories**: competitions, datasets, notebooks and discussion. Helpful
  posts and shared resources count, not only wins.
- Lesson: this is the model for "all participating members displayed with their scores
  and contributions and awards". Score the group, but show each member's contribution
  across labs solved, answers given and resources shared.

### freeCodeCamp — free, project-based, forum-centred
- Entirely free; certifications are earned by **building required projects**, not by
  watching. Community lives in a Discourse forum with help categories, plus chat.
- Lesson: certificates tied to Advanced labs and a capstone, not to time spent.

### Codecademy — structured paths with instant feedback
- Lessons alternate short explanation with an exercise in the same screen; a reference
  panel sits beside the editor; career paths sequence courses.
- Lesson: the tutorial and the exercise belong on one screen; our lab layout already does
  this, and tutorials should too.

### Exercism — mentoring and community solutions
- After completing an exercise, learners can see **community solutions** and request a
  mentor's review of their iteration.
- Lesson: after an Advanced lab passes, show other learners' circuits or code (opt-in) and
  let lecturers or peers comment. This is the "share ideas" feature with substance.

### Coursera and edX — discussion attached to content
- Every lesson item has its own discussion thread; forums are organised by week and
  item, with upvotes and instructor-endorsed answers.
- Lesson: forum threads should be attachable to a course, a unit or a specific lab so
  questions appear where the stuck student is.

### Stack Overflow and Discourse — reputation and solved markers
- Accepted answers, upvotes, tags, "solved" markers, reputation that unlocks moderation
  privileges, and a "similar questions" prompt before posting.
- Lesson: accepted answers feed the contribution score; reputation gates moderation.

### Discord — presence and rooms
- Online member list per server, voice/text rooms, roles. Students already use it for
  study groups.
- Lesson: "who is online" per group, not globally, protects privacy and matches how
  students actually organise.

### Nand2Tetris — build the whole thing
- From NAND gate to a working computer, each project a required step.
- Lesson: our Digital Logic path should end with a datapath built from the student's own
  earlier components, and other courses should have a similar capstone chain.

## 2. Evidence from Ghanaian universities

Studies of Moodle, Sakai and Zoom use at Ghanaian universities (University of Ghana, UEW,
KNUST, Kings University College; 2010 to 2025) report the same barriers: high data
costs, poor connectivity, few computers, low awareness, and low participation unless the
institution makes use part of the course. Design responses:

- Every page under a strict size budget; simulators run offline after the first load.
- Lecturer-created classes with assignments so institutions can make participation count.
- No feature should require a desktop; the phone is the primary device.
- Avoid video as the core medium; interactive text and simulation are cheaper in data.

## 3. What we borrow, feature by feature

| Our feature | Borrowed from | How we adapt it |
| --- | --- | --- |
| Course → unit → topic hierarchy with per-topic mastery | Khan Academy | Mastery = topic check passed; "mastered" when the Advanced lab passes |
| Task after every topic | Khan Academy, Codecademy | Short auto-graded topic check (5 to 8 items), retakable, feeds mastery |
| Tutorials | Brilliant, Codecademy | Interactive text with embedded mini-simulators, no video required |
| Beginner guidance | Brilliant | Step-by-step walkthrough plus a diagnostic first hint tied to the failing check |
| Weekly streak | Khan Academy | Continues when a new topic reaches proficiency that week |
| XP and levels | Brilliant, Duolingo | Difficulty-weighted; each lab's points awarded once; Beginner labs capped per day |
| General competition | LeetCode | Timed contest with a problem set, live board, speed tiebreak, contest rating |
| Group competition | Kaggle, Duolingo friend quests | Team score plus per-member contribution breakdown; co-op quests inside groups |
| Leagues (seasons) | Duolingo, Brilliant | Weekly cohorts of 30 with promotion and demotion, difficulty-weighted |
| Awards | LeetCode badges, Kaggle tiers | Medals per contest, tiers per contribution category, course certificates |
| Groups with presence | Discord | Online member list per group; chat; resource library |
| Forum | Coursera, Discourse, Stack Overflow | Threads attachable to course, unit or lab; accepted answers; upvotes; solved |
| Community solutions | Exercism | After passing an Advanced lab, opt in to show your solution; peers comment |
| Certificates | freeCodeCamp | Earned by passing the Advanced labs and a capstone, not by time |
| Lecturer classes and assignments | Moodle practice in Ghana | Class codes, deadlines, grade export, so institutions can require participation |

## 4. Visual design direction (unchanged, sharpened)

The bench aesthetic stays: cool grey work surface, white instrument panels, green signal
for HIGH and progress, gold for hints and awards, red for faults. Borrowed layout ideas:

- **Khan Academy's unit page**: a vertical list of topics with a mastery marker each, and a
  unit test at the bottom. Our course page becomes this.
- **Brilliant's lesson screen**: one problem, one canvas, one feedback strip. Our lab page
  already follows it; tutorials will too.
- **LeetCode's contest page**: problem list on the left, timer and rank in the header, a
  live board on a tab.
- **Kaggle's team page**: members with per-category contribution bars.
- **Discord's member rail**: online members with a green dot, grouped by role.

## Sources

Khan Academy support: [Course and Unit Mastery](https://support.khanacademy.org/hc/articles/115002552631-What-are-Course-and-Unit-Mastery-), [streaks and course levels](https://support.khanacademy.org/hc/articles/360054115071).
Brilliant: [brilliant.org](https://brilliant.org), [Headway review](https://makeheadway.com/blog/brilliant-review/).
Duolingo: [leagues and leaderboards](https://blog.duolingo.com/duolingo-leagues-leaderboards/), [social features teardown](https://desirabilitylab.com/backfill/backfill-2023-278-duolingo-social-features), [product teardown](https://prodlab.substack.com/p/product-teardown-duolingo).
LeetCode: [contest overview](https://leetcode.doocs.org/en/contest/), [leaderboard system design](https://dev.to/himanshudevgupta/system-design-designing-leetcode-at-scale-45op).
freeCodeCamp, Codecademy, Exercism: [comparison](https://scrimba.com/articles/codecademy-vs-freecodecamp/), [alternatives](https://www.boot.dev/blog/education/code-academy-alternatives), [Exercism](https://best-of-web.builder.io/library/exercism/exercism).
Forum design: [MOOC discussion forum study, Frontiers in Education 2023](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2023.1223409/epub); [EdTech accessibility guide 2026](https://www.flowninja.com/fr/blog/accessibility-and-ux-in-edtech-website-design).
Supabase presence and chat: [Broadcast and Presence authorization](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization).
Ghana: [Moodle, Sakai and Zoom at Ghanaian public universities (2024)](https://www.emerald.com/insight/content/doi/10.1108/IJEM-01-2024-0059/full/html), [UEW e-learning shift](https://link.springer.com/article/10.1007/s44217-025-00527-1), [University of Ghana faculty perceptions](https://ugspace.ug.edu.gh/items/5c3c2637-d257-4e61-807f-63be37311558), [Kings University College Moodle use](https://ugspace.ug.edu.gh/items/54bd81c7-89f4-4c3f-9a03-d144682ce2b0), [KNUST Moodle case (MIT LINC 2010)](https://linc.mit.edu/linc2010/proceedings/session6Kabutey.pdf).
