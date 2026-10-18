-- CS Virtual Lab: initial schema (Postgres 15+, Supabase).
-- Content (courses, units, topics, labs, checks) lives in the app bundle and is referenced
-- by stable string ids. This database stores people, what they do, and what they share.
-- Access control is row-level security; the policies below are the source of truth.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.platform_role as enum ('learner', 'moderator', 'admin');
create type public.institution_role as enum ('student', 'lecturer', 'institution_admin');
create type public.mastery as enum ('not_started', 'attempted', 'proficient', 'mastered');
create type public.lab_level as enum ('beginner', 'intermediate', 'advanced');
create type public.group_kind as enum ('study', 'class', 'team');
create type public.group_role as enum ('owner', 'admin', 'member');
create type public.group_visibility as enum ('public', 'invite');
create type public.resource_kind as enum ('link', 'note', 'file', 'solution');
create type public.competition_kind as enum ('general', 'group', 'league', 'quest');
create type public.competition_status as enum ('draft', 'scheduled', 'live', 'scoring', 'finished', 'cancelled');
create type public.award_kind as enum ('gold', 'silver', 'bronze', 'first_solve', 'most_helpful', 'top_contributor', 'tier');
create type public.report_status as enum ('open', 'actioned', 'dismissed');
create type public.age_band as enum ('under_18', '18_plus', 'undisclosed');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null check (char_length(display_name) between 1 and 60),
  avatar_url    text,
  bio           text check (char_length(bio) <= 500),
  country       text,
  age_band      public.age_band not null default 'undisclosed',
  platform_role public.platform_role not null default 'learner',
  show_on_boards boolean not null default true,
  xp            integer not null default 0 check (xp >= 0),
  level         integer not null default 1 check (level >= 1),
  streak_weeks  integer not null default 0,
  last_proficient_week date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.institutions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text,
  country     text not null default 'GH',
  website     text,
  storage_quota_mb integer not null default 2048,
  created_at  timestamptz not null default now()
);

create table public.institution_members (
  institution_id uuid not null references public.institutions (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  role           public.institution_role not null default 'student',
  verified       boolean not null default false,
  programme      text,
  year_of_study  smallint check (year_of_study between 1 and 6),
  created_at     timestamptz not null default now(),
  primary key (institution_id, user_id)
);

create table public.classes (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid references public.institutions (id) on delete set null,
  lecturer_id    uuid not null references public.profiles (id) on delete cascade,
  course_slug    text not null,
  name           text not null,
  join_code      text unique not null default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  term           text,
  archived       boolean not null default false,
  created_at     timestamptz not null default now()
);

create table public.class_members (
  class_id   uuid not null references public.classes (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (class_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Learning
-- ---------------------------------------------------------------------------
create table public.topic_progress (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  course_slug  text not null,
  unit_index   smallint not null,
  topic_index  smallint not null,
  mastery      public.mastery not null default 'not_started',
  best_check_score numeric(5,2) check (best_check_score between 0 and 100),
  updated_at   timestamptz not null default now(),
  primary key (user_id, course_slug, unit_index, topic_index)
);

create table public.lab_results (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  lab_id       text not null,
  course_slug  text not null,
  level        public.lab_level not null,
  passed       boolean not null,
  score        numeric(4,3) not null check (score between 0 and 1),
  hints_used   smallint not null default 0,
  duration_s   integer,
  checks       jsonb not null default '[]'::jsonb,
  -- the simulator state that produced the result (circuit, code...), for review and sharing
  artifact     jsonb,
  client_attempt_id uuid unique,          -- idempotency for the offline sync queue
  created_at   timestamptz not null default now()
);
create index on public.lab_results (user_id, lab_id);
create index on public.lab_results (lab_id, passed);

create table public.check_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  course_slug  text not null,
  unit_index   smallint not null,
  topic_index  smallint,                   -- null = unit assessment
  score        numeric(5,2) not null check (score between 0 and 100),
  passed       boolean not null,
  answers      jsonb not null default '[]'::jsonb,
  client_attempt_id uuid unique,
  created_at   timestamptz not null default now()
);
create index on public.check_attempts (user_id, course_slug, unit_index, topic_index);

create table public.xp_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  amount     integer not null,
  reason     text not null,                -- 'lab:beginner', 'check', 'answer_accepted', ...
  ref        text,                          -- lab id, post id, etc.
  created_at timestamptz not null default now(),
  unique (user_id, reason, ref)             -- each thing earns XP once
);

create table public.badges (
  id          text primary key,             -- 'streak_5', 'course_level_10', 'first_advanced'
  name        text not null,
  description text not null,
  icon        text
);

create table public.user_badges (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  badge_id   text not null references public.badges (id) on delete cascade,
  earned_at  timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create table public.certificates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  course_slug text not null,
  issued_at   timestamptz not null default now(),
  verify_code text unique not null default encode(gen_random_bytes(8), 'hex'),
  unique (user_id, course_slug)
);

create table public.assignments (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid not null references public.classes (id) on delete cascade,
  title       text not null,
  items       jsonb not null,               -- [{kind:'lab'|'check'|'tutorial', id:...}]
  due_at      timestamptz,
  created_at  timestamptz not null default now()
);

create table public.assignment_submissions (
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  completed_items jsonb not null default '[]'::jsonb,
  grade         numeric(5,2),
  submitted_at  timestamptz not null default now(),
  primary key (assignment_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Community
-- ---------------------------------------------------------------------------
create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  kind        public.group_kind not null default 'study',
  name        text not null check (char_length(name) between 3 and 80),
  description text check (char_length(description) <= 1000),
  visibility  public.group_visibility not null default 'public',
  course_slug text,
  class_id    uuid references public.classes (id) on delete cascade,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      public.group_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.group_messages (
  id         bigint generated always as identity primary key,
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 4000),
  reply_to   bigint references public.group_messages (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on public.group_messages (group_id, created_at desc);

create table public.resources (
  id          uuid primary key default gen_random_uuid(),
  kind        public.resource_kind not null,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  group_id    uuid references public.groups (id) on delete cascade,      -- null = course public library
  course_slug text,
  lab_id      text,                                                      -- for solution shares
  title       text not null check (char_length(title) between 1 and 160),
  body        text,                                                      -- note text or description
  url         text,
  storage_path text,                                                     -- Supabase Storage object
  size_bytes  integer,
  payload     jsonb,                                                     -- shared circuit/code
  created_at  timestamptz not null default now(),
  check (group_id is not null or course_slug is not null)
);
create index on public.resources (group_id, created_at desc);
create index on public.resources (course_slug, created_at desc);

create table public.forum_categories (
  id          text primary key,            -- course slug, or 'general', 'help', 'careers', 'lecturers'
  name        text not null,
  description text,
  lecturers_only boolean not null default false,
  sort_order  integer not null default 100
);

create table public.forum_threads (
  id          uuid primary key default gen_random_uuid(),
  category_id text not null references public.forum_categories (id),
  author_id   uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 5 and 200),
  body        text not null check (char_length(body) <= 20000),
  tags        text[] not null default '{}',
  -- optional anchor into content so the thread appears beside the lab or topic
  course_slug text,
  unit_index  smallint,
  topic_index smallint,
  lab_id      text,
  accepted_post_id uuid,
  locked      boolean not null default false,
  pinned      boolean not null default false,
  views       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.forum_threads (category_id, updated_at desc);
create index on public.forum_threads (lab_id) where lab_id is not null;

create table public.forum_posts (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.forum_threads (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 20000),
  parent_id   uuid references public.forum_posts (id) on delete set null,
  lecturer_endorsed boolean not null default false,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  deleted_at  timestamptz
);
create index on public.forum_posts (thread_id, created_at);
alter table public.forum_threads
  add constraint forum_threads_accepted_fk foreign key (accepted_post_id) references public.forum_posts (id) on delete set null;

create table public.post_votes (
  post_id  uuid not null references public.forum_posts (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  value    smallint not null check (value in (-1, 1)),
  primary key (post_id, user_id)
);

create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

create table public.direct_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 4000),
  created_at      timestamptz not null default now()
);
create index on public.direct_messages (conversation_id, created_at desc);

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null,                -- 'reply', 'mention', 'accepted', 'invite', 'deadline', 'contest'
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, read_at, created_at desc);

create table public.reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_kind text not null,               -- 'thread', 'post', 'group_message', 'dm', 'resource', 'profile'
  target_id   text not null,
  reason      text not null,
  status      public.report_status not null default 'open',
  handled_by  uuid references public.profiles (id),
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Competitions
-- ---------------------------------------------------------------------------
create table public.competitions (
  id             uuid primary key default gen_random_uuid(),
  kind           public.competition_kind not null,
  status         public.competition_status not null default 'draft',
  title          text not null,
  description    text,
  course_slug    text,                     -- optional focus
  institution_id uuid references public.institutions (id) on delete set null, -- restrict to institution
  class_id       uuid references public.classes (id) on delete cascade,        -- restrict to class
  group_id       uuid references public.groups (id) on delete cascade,         -- quests live inside a group
  created_by     uuid not null references public.profiles (id),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  team_min       smallint not null default 1,
  team_max       smallint not null default 1,
  hint_penalty   numeric(3,2) not null default 0.20,
  wrong_run_penalty_s integer not null default 300,
  rules          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.competition_problems (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  ordinal        smallint not null,
  kind           text not null,            -- 'lab' or 'check'
  content_id     text not null,            -- lab id or check id
  points         integer not null,
  primary key (competition_id, ordinal)
);

create table public.competition_teams (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  group_id       uuid references public.groups (id) on delete set null,
  name           text not null,
  created_at     timestamptz not null default now(),
  unique (competition_id, name)
);

create table public.competition_participants (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  team_id        uuid references public.competition_teams (id) on delete set null,
  joined_at      timestamptz not null default now(),
  primary key (competition_id, user_id)
);

create table public.competition_submissions (
  id             bigint generated always as identity primary key,
  competition_id uuid not null references public.competitions (id) on delete cascade,
  ordinal        smallint not null,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  passed         boolean not null,
  hints_used     smallint not null default 0,
  lab_result_id  bigint references public.lab_results (id) on delete set null,
  submitted_at   timestamptz not null default now(),
  foreign key (competition_id, ordinal) references public.competition_problems (competition_id, ordinal) on delete cascade
);
create index on public.competition_submissions (competition_id, user_id, ordinal);

-- Maintained by trigger: one row per participant, recomputed on each submission.
create table public.competition_scores (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  team_id        uuid references public.competition_teams (id) on delete set null,
  points         integer not null default 0,
  solved         smallint not null default 0,
  penalty_s      integer not null default 0,
  finish_s       integer not null default 0,   -- time of last accepted solve since start + penalties
  contributions  jsonb not null default '{}'::jsonb, -- {beginner:n, intermediate:n, advanced:n, answers:n, resources:n}
  updated_at     timestamptz not null default now(),
  primary key (competition_id, user_id)
);
create index on public.competition_scores (competition_id, points desc, finish_s asc);

create table public.awards (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  competition_id uuid references public.competitions (id) on delete cascade,
  team_id        uuid references public.competition_teams (id) on delete set null,
  kind           public.award_kind not null,
  label          text not null,
  awarded_at     timestamptz not null default now()
);
create index on public.awards (user_id, awarded_at desc);

create table public.contest_ratings (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  competition_id uuid not null references public.competitions (id) on delete cascade,
  rating_before  integer not null,
  rating_after   integer not null,
  rank           integer not null,
  primary key (user_id, competition_id)
);

create table public.leagues (
  id         uuid primary key default gen_random_uuid(),
  tier       smallint not null check (tier between 1 and 5),   -- 1 Bronze .. 5 Diamond
  week_start date not null,
  created_at timestamptz not null default now()
);

create table public.league_members (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  weekly_xp integer not null default 0,
  outcome   text,                            -- 'promoted', 'stayed', 'demoted' once the week closes
  primary key (league_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Helpers and triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger topic_progress_updated before update on public.topic_progress for each row execute function public.set_updated_at();
create trigger forum_threads_updated before update on public.forum_threads for each row execute function public.set_updated_at();

-- Create a profile row when a user signs up (username derived from email, unique suffix if taken).
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '_', 'g'));
  candidate text;
  n int := 0;
begin
  base := substr(coalesce(nullif(base, ''), 'user'), 1, 20);
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;
  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data ->> 'display_name', candidate));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Award XP once per (reason, ref) and keep profile totals and level in step.
create or replace function public.award_xp(p_user uuid, p_amount int, p_reason text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.xp_events (user_id, amount, reason, ref) values (p_user, p_amount, p_reason, p_ref)
  on conflict do nothing;
  if found then
    update public.profiles
       set xp = xp + p_amount,
           level = greatest(1, floor(sqrt((xp + p_amount) / 50.0))::int + 1)
     where id = p_user;
  end if;
end $$;

-- A passed lab awards XP by level and raises topic mastery.
create or replace function public.on_lab_result() returns trigger language plpgsql security definer set search_path = public as $$
declare
  pts int := case new.level when 'beginner' then 10 when 'intermediate' then 25 else 50 end;
begin
  if new.passed then
    perform public.award_xp(new.user_id, pts, 'lab:' || new.level::text, new.lab_id);
  end if;
  return new;
end $$;

create trigger lab_results_xp after insert on public.lab_results for each row execute function public.on_lab_result();

-- Recompute a participant's contest score from their submissions.
create or replace function public.recompute_competition_score(p_comp uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c record;
  pts int := 0; solved int := 0; penalty int := 0; finish int := 0;
  team uuid;
begin
  select * into c from public.competitions where id = p_comp;
  select team_id into team from public.competition_participants where competition_id = p_comp and user_id = p_user;

  with first_pass as (
    select s.ordinal, min(s.submitted_at) as at, min(s.hints_used) as hints
      from public.competition_submissions s
     where s.competition_id = p_comp and s.user_id = p_user and s.passed
     group by s.ordinal
  ), wrong as (
    select s.ordinal, count(*) as n
      from public.competition_submissions s
      join first_pass f on f.ordinal = s.ordinal
     where s.competition_id = p_comp and s.user_id = p_user and not s.passed and s.submitted_at < f.at
     group by s.ordinal
  )
  select coalesce(sum(round(p.points * (1 - least(0.8, f.hints * c.hint_penalty)))), 0)::int,
         count(*)::int,
         coalesce(sum(coalesce(w.n, 0)), 0)::int * c.wrong_run_penalty_s,
         coalesce(max(extract(epoch from (f.at - c.starts_at)))::int, 0)
    into pts, solved, penalty, finish
    from first_pass f
    join public.competition_problems p on p.competition_id = p_comp and p.ordinal = f.ordinal
    left join wrong w on w.ordinal = f.ordinal;

  insert into public.competition_scores (competition_id, user_id, team_id, points, solved, penalty_s, finish_s, updated_at)
  values (p_comp, p_user, team, pts, solved, penalty, finish + penalty, now())
  on conflict (competition_id, user_id) do update
    set points = excluded.points, solved = excluded.solved, penalty_s = excluded.penalty_s,
        finish_s = excluded.finish_s, team_id = excluded.team_id, updated_at = now();
end $$;

create or replace function public.on_competition_submission() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_competition_score(new.competition_id, new.user_id);
  return new;
end $$;

create trigger competition_submissions_score after insert on public.competition_submissions
  for each row execute function public.on_competition_submission();

-- Team standings: top-3 member scores plus a 10% bonus when every member scored.
create or replace view public.competition_team_standings as
with ranked as (
  select s.competition_id, s.team_id, s.user_id, s.points,
         row_number() over (partition by s.competition_id, s.team_id order by s.points desc) as rn
    from public.competition_scores s
   where s.team_id is not null
), sizes as (
  select competition_id, team_id, count(*) as members, count(*) filter (where points > 0) as scorers
    from public.competition_scores where team_id is not null group by 1, 2
)
select r.competition_id, r.team_id, t.name,
       sum(r.points) filter (where r.rn <= 3) as base_points,
       case when z.members = z.scorers then round(sum(r.points) filter (where r.rn <= 3) * 1.10) else sum(r.points) filter (where r.rn <= 3) end as points,
       z.members, z.scorers
  from ranked r
  join sizes z on z.competition_id = r.competition_id and z.team_id = r.team_id
  join public.competition_teams t on t.id = r.team_id
 group by r.competition_id, r.team_id, t.name, z.members, z.scorers;

-- Public leaderboard view that respects the opt-out flag.
create or replace view public.public_leaderboard as
select p.username, p.display_name, p.avatar_url, p.xp, p.level, p.streak_weeks
  from public.profiles p
 where p.show_on_boards
 order by p.xp desc;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.institutions enable row level security;
alter table public.institution_members enable row level security;
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.topic_progress enable row level security;
alter table public.lab_results enable row level security;
alter table public.check_attempts enable row level security;
alter table public.xp_events enable row level security;
alter table public.badges enable row level security;
alter table public.user_badges enable row level security;
alter table public.certificates enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;
alter table public.resources enable row level security;
alter table public.forum_categories enable row level security;
alter table public.forum_threads enable row level security;
alter table public.forum_posts enable row level security;
alter table public.post_votes enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.direct_messages enable row level security;
alter table public.blocks enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public.competitions enable row level security;
alter table public.competition_problems enable row level security;
alter table public.competition_teams enable row level security;
alter table public.competition_participants enable row level security;
alter table public.competition_submissions enable row level security;
alter table public.competition_scores enable row level security;
alter table public.awards enable row level security;
alter table public.contest_ratings enable row level security;
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;

create or replace function public.is_admin() returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and platform_role = 'admin');
$$;
create or replace function public.is_moderator() returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and platform_role in ('moderator', 'admin'));
$$;
create or replace function public.is_group_member(g uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = auth.uid());
$$;
create or replace function public.is_group_admin(g uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = auth.uid() and role in ('owner', 'admin'));
$$;
create or replace function public.is_class_lecturer(c uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.classes where id = c and lecturer_id = auth.uid());
$$;
create or replace function public.is_class_member(c uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.class_members where class_id = c and user_id = auth.uid());
$$;
create or replace function public.is_lecturer() returns boolean language sql stable as $$
  select exists (select 1 from public.institution_members where user_id = auth.uid() and role in ('lecturer', 'institution_admin') and verified);
$$;
create or replace function public.is_conversation_member(c uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.conversation_members where conversation_id = c and user_id = auth.uid());
$$;

-- Profiles: public read of safe columns is done through views; owners update their own row.
create policy profiles_read on public.profiles for select using (true);
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid() and platform_role = (select platform_role from public.profiles where id = auth.uid()));

create policy institutions_read on public.institutions for select using (true);
create policy institutions_admin on public.institutions for all using (public.is_admin());

create policy inst_members_read on public.institution_members for select using (user_id = auth.uid() or public.is_admin()
  or exists (select 1 from public.institution_members m where m.institution_id = institution_members.institution_id and m.user_id = auth.uid() and m.role = 'institution_admin' and m.verified));
create policy inst_members_join on public.institution_members for insert with check (user_id = auth.uid() and role = 'student' and not verified);
create policy inst_members_manage on public.institution_members for update using (public.is_admin()
  or exists (select 1 from public.institution_members m where m.institution_id = institution_members.institution_id and m.user_id = auth.uid() and m.role = 'institution_admin' and m.verified));

create policy classes_read on public.classes for select using (lecturer_id = auth.uid() or public.is_class_member(id) or public.is_admin());
create policy classes_create on public.classes for insert with check (lecturer_id = auth.uid() and public.is_lecturer());
create policy classes_manage on public.classes for update using (lecturer_id = auth.uid() or public.is_admin());

create policy class_members_read on public.class_members for select using (user_id = auth.uid() or public.is_class_lecturer(class_id) or public.is_admin());
create policy class_members_join on public.class_members for insert with check (user_id = auth.uid());
create policy class_members_leave on public.class_members for delete using (user_id = auth.uid() or public.is_class_lecturer(class_id));

-- Learning data: owner reads and writes; lecturers read their students'.
create policy topic_progress_own on public.topic_progress for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy topic_progress_lecturer on public.topic_progress for select using (
  exists (select 1 from public.class_members cm join public.classes c on c.id = cm.class_id where cm.user_id = topic_progress.user_id and c.lecturer_id = auth.uid()));
create policy lab_results_own on public.lab_results for select using (user_id = auth.uid());
create policy lab_results_insert on public.lab_results for insert with check (user_id = auth.uid());
create policy lab_results_lecturer on public.lab_results for select using (
  exists (select 1 from public.class_members cm join public.classes c on c.id = cm.class_id where cm.user_id = lab_results.user_id and c.lecturer_id = auth.uid()));
create policy check_attempts_own on public.check_attempts for select using (user_id = auth.uid());
create policy check_attempts_insert on public.check_attempts for insert with check (user_id = auth.uid());
create policy xp_events_own on public.xp_events for select using (user_id = auth.uid());
create policy badges_read on public.badges for select using (true);
create policy user_badges_read on public.user_badges for select using (true);
create policy certificates_read on public.certificates for select using (true);
create policy assignments_read on public.assignments for select using (public.is_class_member(class_id) or public.is_class_lecturer(class_id));
create policy assignments_manage on public.assignments for all using (public.is_class_lecturer(class_id)) with check (public.is_class_lecturer(class_id));
create policy submissions_own on public.assignment_submissions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy submissions_lecturer on public.assignment_submissions for select using (
  exists (select 1 from public.assignments a where a.id = assignment_id and public.is_class_lecturer(a.class_id)));

-- Groups
create policy groups_read on public.groups for select using (visibility = 'public' or public.is_group_member(id) or public.is_admin());
create policy groups_create on public.groups for insert with check (created_by = auth.uid());
create policy groups_manage on public.groups for update using (public.is_group_admin(id) or public.is_admin());
create policy groups_delete on public.groups for delete using (exists (select 1 from public.group_members where group_id = id and user_id = auth.uid() and role = 'owner') or public.is_admin());
create policy group_members_read on public.group_members for select using (public.is_group_member(group_id) or exists (select 1 from public.groups g where g.id = group_id and g.visibility = 'public'));
create policy group_members_join on public.group_members for insert with check (
  user_id = auth.uid() and (exists (select 1 from public.groups g where g.id = group_id and g.visibility = 'public') or public.is_group_admin(group_id)));
create policy group_members_leave on public.group_members for delete using (user_id = auth.uid() or public.is_group_admin(group_id));
create policy group_members_role on public.group_members for update using (public.is_group_admin(group_id));
create policy group_messages_read on public.group_messages for select using (public.is_group_member(group_id));
create policy group_messages_send on public.group_messages for insert with check (user_id = auth.uid() and public.is_group_member(group_id));
create policy group_messages_delete on public.group_messages for update using (user_id = auth.uid() or public.is_group_admin(group_id) or public.is_moderator());

-- Resources: group resources to members; course libraries public; solution shares only to peers who passed the same lab.
create policy resources_read on public.resources for select using (
  (group_id is not null and public.is_group_member(group_id))
  or (group_id is null and kind <> 'solution')
  or (group_id is null and kind = 'solution' and (owner_id = auth.uid() or exists (select 1 from public.lab_results r where r.user_id = auth.uid() and r.lab_id = resources.lab_id and r.passed)))
);
create policy resources_create on public.resources for insert with check (owner_id = auth.uid() and (group_id is null or public.is_group_member(group_id)));
create policy resources_manage on public.resources for all using (owner_id = auth.uid() or public.is_moderator() or (group_id is not null and public.is_group_admin(group_id)));

-- Forum
create policy forum_categories_read on public.forum_categories for select using (not lecturers_only or public.is_lecturer() or public.is_admin());
create policy forum_threads_read on public.forum_threads for select using (
  exists (select 1 from public.forum_categories c where c.id = category_id and (not c.lecturers_only or public.is_lecturer() or public.is_admin())));
create policy forum_threads_create on public.forum_threads for insert with check (author_id = auth.uid());
create policy forum_threads_edit on public.forum_threads for update using (author_id = auth.uid() or public.is_moderator());
create policy forum_posts_read on public.forum_posts for select using (exists (select 1 from public.forum_threads t where t.id = thread_id));
create policy forum_posts_create on public.forum_posts for insert with check (author_id = auth.uid() and not exists (select 1 from public.forum_threads t where t.id = thread_id and t.locked));
create policy forum_posts_edit on public.forum_posts for update using (author_id = auth.uid() or public.is_moderator());
create policy post_votes_all on public.post_votes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy post_votes_read on public.post_votes for select using (true);

-- Direct messages
create policy conversations_read on public.conversations for select using (public.is_conversation_member(id));
create policy conversations_create on public.conversations for insert with check (true);
create policy conversation_members_read on public.conversation_members for select using (public.is_conversation_member(conversation_id));
create policy conversation_members_add on public.conversation_members for insert with check (
  user_id = auth.uid() or public.is_conversation_member(conversation_id));
create policy direct_messages_read on public.direct_messages for select using (public.is_conversation_member(conversation_id));
create policy direct_messages_send on public.direct_messages for insert with check (
  sender_id = auth.uid() and public.is_conversation_member(conversation_id)
  and not exists (select 1 from public.blocks b join public.conversation_members m on m.conversation_id = direct_messages.conversation_id
                   where b.blocker_id = m.user_id and b.blocked_id = auth.uid()));
create policy blocks_own on public.blocks for all using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());
create policy notifications_own on public.notifications for select using (user_id = auth.uid());
create policy notifications_mark on public.notifications for update using (user_id = auth.uid());
create policy reports_create on public.reports for insert with check (reporter_id = auth.uid());
create policy reports_read on public.reports for select using (reporter_id = auth.uid() or public.is_moderator());
create policy reports_handle on public.reports for update using (public.is_moderator());

-- Competitions
create policy competitions_read on public.competitions for select using (
  status <> 'draft' and (
    (institution_id is null and class_id is null and group_id is null)
    or (class_id is not null and (public.is_class_member(class_id) or public.is_class_lecturer(class_id)))
    or (group_id is not null and public.is_group_member(group_id))
    or (institution_id is not null and exists (select 1 from public.institution_members m where m.institution_id = competitions.institution_id and m.user_id = auth.uid()))
  ) or created_by = auth.uid() or public.is_admin());
create policy competitions_create on public.competitions for insert with check (created_by = auth.uid() and (public.is_lecturer() or public.is_admin() or (group_id is not null and public.is_group_admin(group_id))));
create policy competitions_manage on public.competitions for update using (created_by = auth.uid() or public.is_admin());
-- Problems are hidden until the contest is live.
create policy competition_problems_read on public.competition_problems for select using (
  exists (select 1 from public.competitions c where c.id = competition_id and (c.status in ('live', 'scoring', 'finished') or c.created_by = auth.uid())));
create policy competition_problems_manage on public.competition_problems for all using (
  exists (select 1 from public.competitions c where c.id = competition_id and (c.created_by = auth.uid() or public.is_admin())));
create policy competition_teams_read on public.competition_teams for select using (true);
create policy competition_teams_create on public.competition_teams for insert with check (true);
create policy competition_participants_read on public.competition_participants for select using (true);
create policy competition_participants_join on public.competition_participants for insert with check (
  user_id = auth.uid() and exists (select 1 from public.competitions c where c.id = competition_id and c.status in ('scheduled', 'live') and now() < c.ends_at));
create policy competition_participants_team on public.competition_participants for update using (user_id = auth.uid());
create policy competition_submissions_own on public.competition_submissions for select using (user_id = auth.uid()
  or exists (select 1 from public.competitions c where c.id = competition_id and c.created_by = auth.uid()));
create policy competition_submissions_insert on public.competition_submissions for insert with check (
  user_id = auth.uid()
  and exists (select 1 from public.competition_participants p where p.competition_id = competition_submissions.competition_id and p.user_id = auth.uid())
  and exists (select 1 from public.competitions c where c.id = competition_id and c.status = 'live' and now() between c.starts_at and c.ends_at));
create policy competition_scores_read on public.competition_scores for select using (true);
create policy awards_read on public.awards for select using (true);
create policy contest_ratings_read on public.contest_ratings for select using (true);
create policy leagues_read on public.leagues for select using (true);
create policy league_members_read on public.league_members for select using (true);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into public.forum_categories (id, name, description, lecturers_only, sort_order) values
  ('general', 'General', 'Anything about learning Computer Science', false, 1),
  ('help', 'Help', 'Stuck on a lab or topic? Ask here', false, 2),
  ('careers', 'Careers', 'Internships, jobs, projects and portfolios', false, 3),
  ('lecturers', 'Lecturers', 'For verified lecturers and teachers', true, 4);

insert into public.badges (id, name, description, icon) values
  ('first_lab', 'First light', 'Passed your first lab', 'lamp'),
  ('first_advanced', 'Challenge taker', 'Passed your first Advanced lab', 'bolt'),
  ('streak_5', 'Five weeks', 'Reached proficiency in a new topic five weeks in a row', 'flame'),
  ('streak_10', 'Ten weeks', 'Ten weeks of steady progress', 'flame'),
  ('streak_25', 'Twenty-five weeks', 'A full semester and more', 'flame'),
  ('helper_10', 'Helper', 'Ten accepted forum answers', 'hand'),
  ('sharer_10', 'Sharer', 'Ten resources shared with others', 'gift'),
  ('contest_first', 'Contest debut', 'Took part in your first contest', 'trophy'),
  ('course_complete', 'Course complete', 'Earned a course certificate', 'scroll');
