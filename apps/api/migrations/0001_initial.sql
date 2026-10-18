-- CS Virtual Lab API: accounts, profiles and learning progress.
-- Content (courses, units, topics, labs, checks) lives in the app bundle and is referenced by
-- stable string ids. This database stores people and what they have done.

create type mastery as enum ('not_started', 'attempted', 'proficient', 'mastered');
create type lab_level as enum ('beginner', 'intermediate', 'advanced');
create type age_band as enum ('under_18', '18_plus', 'undisclosed');

create function mastery_rank(m mastery) returns int language sql immutable as $$
  select case m when 'not_started' then 0 when 'attempted' then 1 when 'proficient' then 2 else 3 end
$$;

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,                       -- stored lower-cased
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Opaque bearer tokens; only a hash is stored.
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table profiles (
  user_id        uuid primary key references users (id) on delete cascade,
  username       text unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name   text not null check (char_length(display_name) between 1 and 60),
  avatar_url     text,
  age_band       age_band not null default 'undisclosed',
  show_on_boards boolean not null default true,
  xp             integer not null default 0 check (xp >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table topic_progress (
  user_id          uuid not null references users (id) on delete cascade,
  course_slug      text not null,
  unit_index       smallint not null,
  topic_index      smallint not null,
  mastery          mastery not null default 'not_started',
  best_check_score numeric(5,2) check (best_check_score between 0 and 100),
  updated_at       timestamptz not null default now(),
  primary key (user_id, course_slug, unit_index, topic_index)
);

create table lab_results (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references users (id) on delete cascade,
  lab_id            text not null,
  course_slug       text not null,
  level             lab_level not null,
  passed            boolean not null,
  score             numeric(4,3) not null check (score between 0 and 1),
  hints_used        smallint not null default 0,
  checks            jsonb not null default '[]'::jsonb,
  client_attempt_id uuid not null unique,                  -- idempotency for the offline queue
  created_at        timestamptz not null default now()
);
create index lab_results_user_lab_idx on lab_results (user_id, lab_id);

create table check_attempts (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references users (id) on delete cascade,
  course_slug       text not null,
  unit_index        smallint not null,
  topic_index       smallint not null,
  score             numeric(5,2) not null check (score between 0 and 100),
  passed            boolean not null,
  client_attempt_id uuid not null unique,
  created_at        timestamptz not null default now()
);
create index check_attempts_user_topic_idx on check_attempts (user_id, course_slug, unit_index, topic_index);
