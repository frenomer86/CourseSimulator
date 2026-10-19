# Community and competitions

How the community phase of [03-PRODUCT-SPEC.md](03-PRODUCT-SPEC.md) (sections 5, 6 and the
facilitator parts of 7) is built: the tables, the API routes, the pages, the access rules and
the learning events. Everything lives in the app's own API (`apps/api`) and web app (`apps/web`);
nothing depends on a third-party service.

## Data

Migration `apps/api/migrations/0003_community.sql` ports
[reference/community-and-competition-schema.sql](reference/community-and-competition-schema.sql)
to the app's own `users` table. The reference file was written for Supabase, so its
`auth.users` references and row-level-security policies are gone; the same rules are enforced
in the route handlers (listed under *Access rules* below) and covered by API tests.

| Area | Tables |
| --- | --- |
| Roles | `profiles.platform_role` (`learner`, `facilitator`, `moderator`, `admin`), `facilitator_requested_at`, `facilitator_verified`, `bio` |
| Groups | `groups` (with a `join_code`), `group_members`, `group_messages`, `group_tasks` |
| Sharing | `resources` (link, note, solution share; in a group or a course's public library) |
| Forum | `forum_categories` (General, Help, Careers, Lecturers, plus one per course), `forum_threads`, `forum_posts`, `post_votes` |
| Messages | `conversations`, `conversation_members`, `direct_messages`, `blocks` |
| Inbox and safety | `notifications`, `reports` |
| Competitions | `competitions`, `competition_problems`, `competition_teams`, `competition_participants`, `competition_submissions`, `competition_scores` (kept by the `recompute_competition_score` trigger), the `competition_team_standings` view, `awards` |

The facilitator role is **self-declared** for now: any signed-in learner can switch it on from
their profile. The request time is recorded and `facilitator_verified` stays false until a
verification step exists. Moderators and admins are set directly in the database.

## API

All routes need a signed-in session (`Authorization: Bearer <token>`) and live under `/api`.
Shapes are mirrored in `apps/web/src/lib/community.ts`.

**Role**
`POST /me/facilitator` declare, `DELETE /me/facilitator` step down.

**Groups** (`apps/api/src/community.ts`)
`GET /groups?scope=mine|public&q=` · `POST /groups` · `GET /groups/by-code/:code` (preview) ·
`POST /groups/join {code}` · `GET|PATCH|DELETE /groups/:id` · `POST /groups/:id/code` (new code) ·
`POST /groups/:id/join` (public groups) · `POST /groups/:id/leave` ·
`GET /groups/:id/members` · `PATCH|DELETE /groups/:id/members/:userId` ·
`GET|POST /groups/:id/messages` · `DELETE /groups/:id/messages/:mid` ·
`GET|POST /groups/:id/tasks` · `GET|DELETE /groups/:id/tasks/:taskId` (the GET returns per-member
completion to the owner and admins).

**Resources**
`GET /resources?groupId=|courseSlug=|labId=` · `POST /resources` · `DELETE /resources/:id`.

**Forum** (`apps/api/src/forum.ts`)
`GET /forum/categories` · `GET /forum/threads?category&labId&course&unit&topic&q&unsolved` ·
`POST /forum/threads` · `GET|PATCH /forum/threads/:id` · `POST /forum/threads/:id/posts` ·
`POST /forum/threads/:id/accept {postId|null}` · `PATCH|DELETE /forum/posts/:id` ·
`PUT /forum/posts/:id/vote {value: 1|-1|0}` · `POST /forum/posts/:id/endorse {endorsed}`.

**Direct messages** (`apps/api/src/messages.ts`)
`GET /conversations` · `POST /conversations {userId}` (finds or opens the one-to-one) ·
`GET|POST /conversations/:id/messages` · `GET /me/blocks` · `PUT|DELETE /me/blocks/:userId`.

**Inbox, reports, people**
`GET /me/notifications` · `POST /me/notifications/read {ids?}` · `POST /reports` ·
`GET /people/:username` (public profile with awards; never the email).

**Competitions** (`apps/api/src/competitions.ts`)
`GET /competitions?scope=open|mine|group&groupId=` · `POST /competitions` (starts as a draft) ·
`GET /competitions/:id` (problems only when live, scoring, finished, or you are the creator) ·
`PATCH /competitions/:id` (publish with `status: "scheduled"`, cancel, edit) ·
`POST /competitions/:id/register {teamId?|teamName?}` ·
`GET /competitions/active?labId=|checkId=` (live contests you are in that include this content) ·
`POST /competitions/:id/submissions {ordinal, passed, hintsUsed}` ·
`GET /competitions/:id/board` · `GET /me/awards`.

Status follows the clock: a published contest becomes `live` at `starts_at` and `finished` at
`ends_at` the next time anyone reads it, so no scheduler is needed. Finishing happens once
(awards are written inside the same transaction that claims the transition).

**Realtime** (`apps/api/src/realtime.ts`): `GET /api/ws` upgrades to a WebSocket. The client
sends `{type:"auth", token}` first, then `{type:"join"|"leave", groupId}` and
`{type:"message", groupId, body}`. The server pushes `presence` (display name and avatar only,
one entry per person), `message`, `message-deleted`, `dm` and `notification` frames. A REST-posted
message reaches open tabs too. In development Vite proxies the upgrade (`ws: true`).

## Access rules (enforced in the handlers, each with a test)

- Groups: public ones are visible to everyone signed in; invite-only ones only to members
  (others get 404). Anyone creates a group and becomes owner. Owner or admin edits, changes
  roles (never the owner's) and removes members; only the owner deletes. Joining is by code
  (any visibility) or directly for public groups. An owner who leaves hands over to the
  longest-standing admin, else member; an empty group is removed.
- Chat: members only; 1 to 4000 characters; authors, group admins and moderators remove
  (soft delete). Messages from people you have blocked are not shown to you, in history or live.
- Tasks: a facilitator who is owner or admin sets and removes them; members see the list and
  their own completion; owner and admins see everyone's. Completion is read from passed lab
  results and check attempts, so finishing the work anywhere counts.
- Resources: group resources to members; course libraries to everyone signed in; solution
  shares only to the owner and to learners who have passed the same lab (and only someone who
  passed can share one). Owner, group admin or moderator removes.
- Forum: the Lecturers category is for facilitators. Anyone creates threads and replies unless
  the thread is locked. Authors or moderators edit; moderators lock and pin. The asker or a
  facilitator accepts an answer; facilitators endorse. Votes are the voter's own.
- Direct messages: between people who share a group. Blocked users cannot message the blocker
  (and the blocker is told to unblock first). Under-18 accounts message only inside class groups.
- Competitions: drafts are visible to their creator only; open contests to everyone; group
  contests and quests to group members. Open contests are created by facilitators; group ones
  by the group owner, an admin or a facilitator in the group. Problems are hidden until live.
  Registration while scheduled or live; submissions only while live and inside the window, by
  registered participants. Boards, scores and awards are public.

## Scoring

Each problem scores once, on the first passing run. Hints cut a problem's points by
`hint_penalty` (default 20%) each, to at most 80% off. Ties are broken by finishing time (last
accepted solve since the start) plus `wrong_run_penalty_s` (default 5 minutes) per failed run
before the pass. Team score = top three members' points, plus 10% when every member scored.
A quest is complete when the group's solves reach `rules.goal`.

Awards at the end: gold, silver, bronze (top three individuals, or every member of the top
three teams), first solve per problem, most helpful (accepted forum answers during the
window), top contributor per team, and quest complete for everyone who solved something.
They show in the trophy case on profiles and beside names on the board.

## Pages (`apps/web/src/pages`)

| Route | Page |
| --- | --- |
| `/community` | Your groups, join by code, create a group, open groups |
| `/groups/:id` | Group page: chat with the online rail, members, resources, tasks, contests; code and join link; settings |
| `/groups/join/:code` | The join link a facilitator shares |
| `/forum`, `/forum/c/:category`, `/forum/new`, `/forum/threads/:id` | Categories, thread list with search and "unanswered", ask (with a similar-threads prompt), thread view |
| `/messages`, `/messages/:id` | Conversations and a one-to-one thread, with block |
| `/competitions`, `/competitions/new`, `/competitions/:id` | Contest lists and trophy case; create; detail with countdown, problems, registration, live board (polled every 15 s), awards |
| `/inbox` | Notifications: replies, mentions, accepted answers, tasks and deadlines, contest news, messages |
| `/people/:username` | Public profile: role, level, contributions, trophy case; message, block, report |
| `/profile` | Facilitator switch and trophy case added |

Lab pages show *Questions about this lab* and, once passed, *Solutions from others*. A lab or
topic check opened during a live contest shows a banner and records every run as a submission.
Course pages link to the course forum and study groups.

## Learning events

The web app records, through `track()` in `apps/web/src/lib/telemetry.ts`, with ids and counts
only (never text): `joined`, `left` and `created` on `group`; `posted` on `group-message`;
`asked`, `replied`, `voted` and `viewed` on `forum-thread`; `shared` on `resource`;
`registered`, `scored` and `awarded` on `competition`; `submitted`, `passed` and `failed` on
`problem`; `assigned` and `completed` on `assignment`. The vocabulary is the profile in
`packages/lab-runtime/src/xapiProfile.ts`. Direct messages are not tracked.

## Tests

`apps/api/src/community.test.ts`, `forum.test.ts` and `competitions.test.ts` run against an
in-memory Postgres (PGlite) and cover every rule above, including the WebSocket (presence,
room messages, non-members refused) and the scoring trigger, team standings view and awards.
