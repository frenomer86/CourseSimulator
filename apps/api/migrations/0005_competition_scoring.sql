-- Fix two competition scoring bugs in 0003_community.sql (docs/06-COMMUNITY-AND-COMPETITIONS.md):
--   1. Each problem scores on its first passing run; a later pass with fewer hints must not erase
--      the hint penalty from the first pass.
--   2. The 10% "every member scored" team bonus counts every registered team member in
--      competition_participants, not only members who already have a row in competition_scores.

create or replace function recompute_competition_score(p_comp uuid, p_user uuid) returns void
language plpgsql as $$
declare
  c record;
  pts int := 0; solved int := 0; penalty int := 0; finish int := 0;
  team uuid;
  contrib jsonb;
begin
  select * into c from competitions where id = p_comp;
  select team_id into team from competition_participants where competition_id = p_comp and user_id = p_user;

  with first_pass as (
    select distinct on (s.ordinal) s.ordinal, s.id as pass_id, s.submitted_at as at, s.hints_used as hints
      from competition_submissions s
     where s.competition_id = p_comp and s.user_id = p_user and s.passed
     order by s.ordinal, s.submitted_at asc, s.id asc
  ), wrong as (
    select s.ordinal, count(*) as n
      from competition_submissions s
      join first_pass f on f.ordinal = s.ordinal
     where s.competition_id = p_comp and s.user_id = p_user and not s.passed
       and (s.submitted_at < f.at or (s.submitted_at = f.at and s.id < f.pass_id))
     group by s.ordinal
  )
  select coalesce(sum(round(p.points * (1 - least(0.8, f.hints * c.hint_penalty)))), 0)::int,
         count(*)::int,
         coalesce(sum(coalesce(w.n, 0)), 0)::int * c.wrong_run_penalty_s,
         coalesce(max(extract(epoch from (f.at - c.starts_at)))::int, 0),
         jsonb_build_object(
           'beginner', count(*) filter (where p.kind = 'lab' and p.level = 'beginner'),
           'intermediate', count(*) filter (where p.kind = 'lab' and p.level = 'intermediate'),
           'advanced', count(*) filter (where p.kind = 'lab' and p.level = 'advanced'),
           'checks', count(*) filter (where p.kind = 'check'))
    into pts, solved, penalty, finish, contrib
    from first_pass f
    join competition_problems p on p.competition_id = p_comp and p.ordinal = f.ordinal
    left join wrong w on w.ordinal = f.ordinal;

  contrib := contrib
    || jsonb_build_object('answers', (select count(*) from forum_posts fp join forum_threads t on t.accepted_post_id = fp.id
                                       where fp.author_id = p_user and fp.created_at between c.starts_at and c.ends_at))
    || jsonb_build_object('resources', (select count(*) from resources r
                                         where r.owner_id = p_user and r.created_at between c.starts_at and c.ends_at));

  insert into competition_scores (competition_id, user_id, team_id, points, solved, penalty_s, finish_s, contributions, updated_at)
  values (p_comp, p_user, team, pts, solved, penalty, finish + penalty, contrib, now())
  on conflict (competition_id, user_id) do update
    set points = excluded.points, solved = excluded.solved, penalty_s = excluded.penalty_s,
        finish_s = excluded.finish_s, team_id = excluded.team_id, contributions = excluded.contributions, updated_at = now();
end $$;

create or replace view competition_team_standings as
with ranked as (
  select s.competition_id, s.team_id, s.user_id, s.points, s.finish_s,
         row_number() over (partition by s.competition_id, s.team_id order by s.points desc, s.finish_s asc) as rn
    from competition_scores s
   where s.team_id is not null
), sizes as (
  select p.competition_id, p.team_id,
         count(*) as members,
         count(*) filter (where coalesce(s.points, 0) > 0) as scorers
    from competition_participants p
    left join competition_scores s on s.competition_id = p.competition_id and s.user_id = p.user_id
   where p.team_id is not null
   group by 1, 2
)
select r.competition_id, r.team_id, t.name,
       coalesce(sum(r.points) filter (where r.rn <= 3), 0)::int as base_points,
       case when z.members > 0 and z.members = z.scorers then round(coalesce(sum(r.points) filter (where r.rn <= 3), 0) * 1.10)
            else coalesce(sum(r.points) filter (where r.rn <= 3), 0) end::int as points,
       coalesce(max(r.finish_s) filter (where r.rn <= 3), 0)::int as finish_s,
       z.members::int as members, z.scorers::int as scorers
  from ranked r
  join sizes z on z.competition_id = r.competition_id and z.team_id = r.team_id
  join competition_teams t on t.id = r.team_id
 group by r.competition_id, r.team_id, t.name, z.members, z.scorers;
