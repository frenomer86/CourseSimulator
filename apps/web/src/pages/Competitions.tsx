import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LEVEL_LABEL } from '@cslab/lab-runtime';
import { COURSES, courseBySlug, labById, unitOf } from '../lib/catalogue';
import {
  AWARD_GLYPH,
  AWARD_LABEL,
  competitions,
  formatDuration,
  formatWhen,
  groups,
  type Board,
  type Competition,
  type CompetitionView,
  type Problem,
  type Standing,
  type TaskItem,
} from '../lib/community';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';
import { BTN, BTN_SMALL, BTN_SOFT, Breadcrumb, CARD, Empty, errorText, LoadState, PersonChip, SignedInOnly, Tabs, useLoad } from '../components/Community';
import { Field, Notice } from '../components/Form';
import { ContentPicker } from './Group';

const STATUS_LABEL: Record<Competition['status'], string> = {
  draft: 'Draft',
  scheduled: 'Starts soon',
  live: 'Live now',
  scoring: 'Scoring',
  finished: 'Finished',
  cancelled: 'Cancelled',
};
const KIND_LABEL: Record<Competition['kind'], string> = { general: 'Open contest', group: 'Team contest', league: 'League', quest: 'Co-op quest' };

function StatusPill({ status }: { status: Competition['status'] }) {
  const tone =
    status === 'live' ? 'bg-high text-white border-high' : status === 'scheduled' ? 'bg-gold-soft text-gold-deep border-gold/40' : status === 'draft' ? 'bg-bench text-ink-soft border-line' : 'bg-surface text-ink-soft border-line';
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{STATUS_LABEL[status]}</span>;
}

export function CompetitionCard({ competition: c }: { competition: Competition }) {
  const course = c.courseSlug ? courseBySlug(c.courseSlug) : undefined;
  return (
    <li>
      <Link to={`/competitions/${c.id}`} className="block h-full rounded-lg border border-line bg-surface p-4 hover:border-ink-faint">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-snug">{c.title}</h3>
          <StatusPill status={c.status} />
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          {KIND_LABEL[c.kind]} · {c.problemCount} problem{c.problemCount === 1 ? '' : 's'} · {c.participants} taking part{course && ` · ${course.title}`}
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          {c.status === 'live' ? `Ends ${formatWhen(c.endsAt)}` : c.status === 'finished' ? `Ended ${formatWhen(c.endsAt)}` : `Starts ${formatWhen(c.startsAt)}`}
        </p>
      </Link>
    </li>
  );
}

/* ----------------------------------------------------------------------------- list */

export function CompetitionsPage() {
  return (
    <SignedInOnly what="contests">
      <CompetitionsHome />
    </SignedInOnly>
  );
}

function CompetitionsHome() {
  const [tab, setTab] = useState<'open' | 'mine'>('open');
  const open = useLoad(() => competitions.open(), []);
  const mine = useLoad(() => competitions.mine(), []);
  const profile = useAuth((s) => s.profile);
  const awards = useLoad(() => competitions.myAwards(), []);
  const list = (tab === 'open' ? open : mine).data ?? [];
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { label: 'Contests' }]} />
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Contests</h1>
          <p className="mt-1 text-ink-soft max-w-[60ch]">Timed problem sets drawn from the labs and checks. Every participant is shown with their score and what they contributed.</p>
        </div>
        {profile?.platformRole === 'facilitator' || profile?.platformRole === 'admin' || profile?.platformRole === 'moderator' ? (
          <Link to="/competitions/new" className={BTN}>
            Run an open contest
          </Link>
        ) : (
          <p className="text-sm text-ink-soft max-w-[36ch]">Team contests and quests are run from inside a group. Open contests are run by facilitators.</p>
        )}
      </div>
      <div className="mt-6">
        <Tabs tabs={[{ id: 'open', label: 'Open to everyone', count: open.data?.length }, { id: 'mine', label: 'Mine', count: mine.data?.length }]} value={tab} onChange={setTab} />
        <div className="mt-4">
          <LoadState loading={(tab === 'open' ? open : mine).loading} error={(tab === 'open' ? open : mine).error}>
            {list.length === 0 ? (
              <Empty>{tab === 'open' ? 'No open contests right now. Check back soon, or run one if you are a facilitator.' : 'You have not taken part in a contest yet.'}</Empty>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{list.map((c) => <CompetitionCard key={c.id} competition={c} />)}</ul>
            )}
          </LoadState>
        </div>
      </div>
      {awards.data && awards.data.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">Your trophy case</h2>
          <TrophyCase awards={awards.data} />
        </section>
      )}
    </div>
  );
}

export function TrophyCase({ awards }: { awards: Array<{ id: number; kind: string; label: string; competitionId: string | null; awardedAt: string }> }) {
  if (awards.length === 0) return <p className="mt-2 text-sm text-ink-soft">No awards yet. Take part in a contest to earn one.</p>;
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {awards.map((a) => (
        <li key={a.id} className="rounded-lg border border-line bg-surface px-3 py-2.5 flex items-center gap-3">
          <span className="text-2xl" aria-hidden>
            {AWARD_GLYPH[a.kind] ?? '🏅'}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium leading-snug">{a.label}</span>
            <span className="block text-xs text-ink-faint">
              {AWARD_LABEL[a.kind] ?? a.kind} · {formatWhen(a.awardedAt)}
              {a.competitionId && (
                <>
                  {' · '}
                  <Link to={`/competitions/${a.competitionId}`} className="underline underline-offset-2 hover:text-ink">
                    board
                  </Link>
                </>
              )}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------- detail */

export function CompetitionPage() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly what="contests">
      <CompetitionDetail key={id} id={id} />
    </SignedInOnly>
  );
}

function problemTitle(p: Problem): string {
  if (p.kind === 'lab') return labById(p.contentId)?.title ?? p.contentId;
  const [slug, u, t] = p.contentId.split(':');
  const course = courseBySlug(slug);
  const unit = course ? unitOf(course, Number(u)) : undefined;
  return unit?.topics[Number(t) - 1] ? `Check: ${unit.topics[Number(t) - 1]}` : `Check ${p.contentId}`;
}

function problemLink(p: Problem, compId: string): string {
  if (p.kind === 'lab') return `/labs/${p.contentId}?contest=${compId}`;
  const [slug, u, t] = p.contentId.split(':');
  return `/courses/${slug}/units/${u}/topics/${t}/check?contest=${compId}`;
}

function useCountdown(to: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return to ? Math.max(0, (Date.parse(to) - now) / 1000) : 0;
}

function CompetitionDetail({ id }: { id: string }) {
  const load = useLoad(() => competitions.get(id), [id]);
  const view = load.data;
  const status = view?.competition.status;
  const live = status === 'live';
  // The live board polls every 15 seconds while the contest runs, otherwise once.
  const board = useLoad(() => competitions.board(id), [id, status]);
  const reloadBoard = board.reload;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reloadBoard(), 15_000);
    return () => clearInterval(t);
  }, [live, reloadBoard]);
  // When the clock runs out, re-read the contest so the final board and awards appear.
  const remaining = useCountdown(live ? view?.competition.endsAt : status === 'scheduled' ? view?.competition.startsAt : undefined);
  const reloadView = load.reload;
  useEffect(() => {
    if ((live || status === 'scheduled') && remaining === 0) {
      const t = setTimeout(() => void reloadView(), 1500);
      return () => clearTimeout(t);
    }
  }, [remaining, live, status, reloadView]);

  const me = useAuth((s) => s.user?.id);
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const navigate = useNavigate();

  const register = async (body: { teamId?: string; teamName?: string } = {}) => {
    if (!view) return;
    try {
      const r = await competitions.register(id, body);
      track('registered', { type: 'competition', id, course: view.competition.courseSlug ?? undefined }, { team: !!r.registration.teamId }, { kind: view.competition.kind });
      await load.reload();
      await board.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const setStatus = async (s: 'scheduled' | 'cancelled') => {
    if (s === 'cancelled' && !window.confirm('Cancel this contest for everyone?')) return;
    try {
      await competitions.update(id, { status: s });
      await load.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const group = useLoad(() => (view?.competition.groupId ? groups.get(view.competition.groupId).then((r) => r.group) : Promise.resolve(null)), [view?.competition.groupId]);

  // One "scored"/"awarded" event per visit when the final board shows me.
  const awardedOnce = useMemo(() => new Set<string>(), []);
  useEffect(() => {
    if (!board.data || !me || board.data.status !== 'finished' || awardedOnce.has(id)) return;
    const mine = board.data.mine;
    if (mine) {
      awardedOnce.add(id);
      track('scored', { type: 'competition', id }, { points: mine.points, solved: mine.solved, rank: mine.rank, finishS: mine.finishS });
      const myAwards = board.data.awards.filter((a) => a.userId === me);
      if (myAwards.length) track('awarded', { type: 'competition', id }, { awards: myAwards.length, kinds: myAwards.map((a) => a.kind) });
    }
  }, [board.data, me, id, awardedOnce]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <LoadState loading={load.loading} error={load.error}>
        {view && (
          <>
            <Breadcrumb
              items={[
                { to: '/community', label: 'Community' },
                ...(group.data ? [{ to: `/groups/${group.data.id}?tab=contests`, label: group.data.name }] : [{ to: '/competitions', label: 'Contests' }]),
                { label: view.competition.title },
              ]}
            />
            <Header view={view} remaining={remaining} onPublish={() => setStatus('scheduled')} onCancel={() => setStatus('cancelled')} />
            {error && (
              <div className="mt-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="min-w-0 space-y-6">
                <Problems view={view} />
                <BoardView view={view} board={board.data} loading={board.loading} error={board.error} me={me} />
              </section>
              <aside className="space-y-4">
                <Registration view={view} teamName={teamName} setTeamName={setTeamName} onRegister={register} />
                <Rules view={view} />
                {view.canManage && view.competition.status === 'draft' && (
                  <div className={CARD}>
                    <h2 className="font-medium">This is a draft</h2>
                    <p className="mt-1 text-sm text-ink-soft">Only you can see it. Publish it so people can register; the problems stay hidden until it starts.</p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => setStatus('scheduled')} className={BTN}>
                        Publish
                      </button>
                      <button type="button" onClick={() => navigate(-1)} className={BTN_SOFT}>
                        Back
                      </button>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </LoadState>
    </div>
  );
}

function Header({ view, remaining, onPublish, onCancel }: { view: CompetitionView; remaining: number; onPublish: () => void; onCancel: () => void }) {
  const c = view.competition;
  const course = c.courseSlug ? courseBySlug(c.courseSlug) : undefined;
  return (
    <header className="mt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
            <StatusPill status={c.status} />
          </div>
          <p className="mt-1 text-sm text-ink-soft flex flex-wrap gap-x-3 gap-y-1">
            <span>{KIND_LABEL[c.kind]}</span>
            <span>Run by {view.creator?.displayName ?? 'a facilitator'}</span>
            {course && (
              <Link to={`/courses/${course.slug}`} className="underline underline-offset-2 hover:text-ink">
                {course.title}
              </Link>
            )}
            <span>
              {formatWhen(c.startsAt)} to {formatWhen(c.endsAt)}
            </span>
          </p>
          {c.description && <p className="mt-2 max-w-[70ch] leading-relaxed">{c.description}</p>}
        </div>
        <div className="text-right">
          {c.status === 'live' && (
            <div className="rounded-lg border border-high bg-high-soft px-4 py-2">
              <div className="text-xs text-high font-medium">Time left</div>
              <div className="font-mono text-2xl text-high">{formatDuration(remaining)}</div>
            </div>
          )}
          {c.status === 'scheduled' && (
            <div className="rounded-lg border border-gold/40 bg-gold-soft px-4 py-2">
              <div className="text-xs text-gold-deep font-medium">Starts in</div>
              <div className="font-mono text-2xl text-gold-deep">{formatDuration(remaining)}</div>
            </div>
          )}
          {view.canManage && (c.status === 'scheduled' || c.status === 'live') && (
            <button type="button" onClick={onCancel} className={`mt-2 ${BTN_SMALL} text-fault`}>
              Cancel contest
            </button>
          )}
          {view.canManage && c.status === 'draft' && (
            <button type="button" onClick={onPublish} className={BTN}>
              Publish
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function Problems({ view }: { view: CompetitionView }) {
  const c = view.competition;
  if (!view.problems) {
    return (
      <div className={CARD}>
        <h2 className="font-medium">Problems</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {c.problemCount} problem{c.problemCount === 1 ? '' : 's'} drawn from the labs and checks. They are revealed when the contest starts.
        </p>
      </div>
    );
  }
  const total = view.problems.reduce((n, p) => n + p.points, 0);
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">Problems</h2>
        <span className="text-xs text-ink-faint font-mono">{total} points in all</span>
      </div>
      <ol className="mt-3 space-y-2">
        {view.problems.map((p) => {
          const lab = p.kind === 'lab' ? labById(p.contentId) : undefined;
          const canOpen = c.status === 'live' && view.registration;
          return (
            <li key={p.ordinal} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
              <span className="font-mono text-sm text-ink-faint w-5">{p.ordinal}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{problemTitle(p)}</span>
                <span className="block text-xs text-ink-faint">{p.kind === 'lab' ? `${LEVEL_LABEL[(lab?.level ?? p.level ?? 'beginner') as 'beginner']} lab` : 'Topic check'}</span>
              </span>
              <span className="font-mono text-sm">{p.points} pts</span>
              {canOpen ? (
                <Link to={problemLink(p, c.id)} className={BTN_SMALL}>
                  Solve
                </Link>
              ) : (
                c.status === 'finished' && (
                  <Link to={problemLink(p, c.id).split('?')[0]} className={BTN_SMALL}>
                    Open
                  </Link>
                )
              )}
            </li>
          );
        })}
      </ol>
      {c.status === 'live' && !view.registration && <p className="mt-3 text-sm text-ink-soft">Register to submit solutions.</p>}
    </div>
  );
}

function Registration({ view, teamName, setTeamName, onRegister }: { view: CompetitionView; teamName: string; setTeamName: (s: string) => void; onRegister: (b?: { teamId?: string; teamName?: string }) => void }) {
  const c = view.competition;
  const open = (c.status === 'scheduled' || c.status === 'live') && Date.now() < Date.parse(c.endsAt);
  if (view.registration) {
    const team = view.teams.find((t) => t.id === view.registration?.teamId);
    return (
      <div className="rounded-lg border border-high bg-high-soft p-4">
        <h2 className="font-medium text-high">You are registered</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {team ? (
            <>
              Team <span className="font-medium text-ink">{team.name}</span> ({team.members} of {c.teamMax}).
            </>
          ) : c.status === 'live' ? (
            'Open a problem and solve it on its page; every check you run counts as a submission.'
          ) : (
            'The problems appear here when the contest starts.'
          )}
        </p>
      </div>
    );
  }
  if (!open) return null;
  if (c.kind !== 'group') {
    return (
      <div className={CARD}>
        <h2 className="font-medium">Take part</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {c.kind === 'quest' ? 'Everyone in the group works towards one goal. Every solve counts.' : 'Individual contest. Your score, solve times and contributions are shown on the board.'}
        </p>
        <button type="button" onClick={() => onRegister()} className={`mt-3 ${BTN}`}>
          Register
        </button>
      </div>
    );
  }
  return (
    <div className={CARD}>
      <h2 className="font-medium">Join a team</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Teams of {c.teamMin} to {c.teamMax}. The top {Math.min(3, c.teamMax)} scores count, plus a bonus when everyone scores.
      </p>
      {view.teams.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {view.teams.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {t.name} <span className="text-ink-faint font-mono text-xs">{t.members}/{c.teamMax}</span>
              </span>
              <button type="button" onClick={() => onRegister({ teamId: t.id })} disabled={t.members >= c.teamMax} className={BTN_SMALL}>
                {t.members >= c.teamMax ? 'Full' : 'Join'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (teamName.trim().length >= 2) onRegister({ teamName: teamName.trim() });
        }}
        className="mt-3 flex gap-2"
      >
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" minLength={2} maxLength={60} className="input" aria-label="New team name" />
        <button type="submit" className={BTN_SOFT}>
          Create
        </button>
      </form>
    </div>
  );
}

function Rules({ view }: { view: CompetitionView }) {
  const c = view.competition;
  return (
    <div className={CARD}>
      <h2 className="font-medium">How scoring works</h2>
      <ul className="mt-2 text-sm text-ink-soft space-y-1 list-disc pl-4">
        <li>Each problem scores once, on your first passing run.</li>
        <li>Each hint you use on a problem takes {Math.round(c.hintPenalty * 100)}% off its points.</li>
        <li>Ties are broken by finishing time; each failed run before a pass adds {Math.round(c.wrongRunPenaltyS / 60)} minutes.</li>
        {c.kind === 'group' && <li>Team score is the top 3 members' points, plus 10% when every member scores.</li>}
        {c.kind === 'quest' && <li>The group aims for {String(c.rules.goal ?? '?')} solves together; everyone who solved something earns the award.</li>}
        <li>Solutions are not shown until the contest ends.</li>
      </ul>
    </div>
  );
}

function BoardView({ view, board, loading, error, me }: { view: CompetitionView; board: Board | null; loading: boolean; error: string | null; me?: string }) {
  const c = view.competition;
  const teamName = (id: string | null) => view.teams.find((t) => t.id === id)?.name ?? board?.teams.find((t) => t.id === id)?.name ?? '';
  const awardsFor = (userId: string) => board?.awards.filter((a) => a.userId === userId) ?? [];
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{c.status === 'finished' ? 'Final board' : c.status === 'live' ? 'Live board' : 'Board'}</h2>
        {c.status === 'live' && <span className="text-xs text-ink-faint">Updates every 15 seconds</span>}
      </div>
      <LoadState loading={loading && !board} error={error}>
        {board && (
          <>
            {board.quest && (
              <div className="mt-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span>
                    Group progress: <span className="font-mono font-semibold">{board.quest.solved}</span> of {board.quest.goal} solves
                  </span>
                  {board.quest.solved >= board.quest.goal && <span className="text-high font-medium">Goal reached</span>}
                </div>
                <div className="mt-1 h-2 rounded bg-bench-deep overflow-hidden">
                  <span className="block h-full bg-high-bright" style={{ width: `${Math.min(100, (board.quest.solved / Math.max(1, board.quest.goal)) * 100)}%` }} />
                </div>
              </div>
            )}
            {c.kind === 'group' && board.teams.length > 0 && (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-ink-faint">
                  <tr>
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Team</th>
                    <th className="py-1 font-medium text-right">Top 3</th>
                    <th className="py-1 font-medium text-right">Bonus</th>
                    <th className="py-1 font-medium text-right">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {board.teams.map((t) => (
                    <tr key={t.id} className="border-t border-line">
                      <td className="py-1.5 font-mono">{t.rank}</td>
                      <td className="py-1.5 font-medium">
                        {t.name} <span className="text-xs text-ink-faint">{t.scorers}/{t.members} scored</span>
                      </td>
                      <td className="py-1.5 text-right font-mono">{t.basePoints}</td>
                      <td className="py-1.5 text-right font-mono text-ink-soft">{t.points - t.basePoints > 0 ? `+${t.points - t.basePoints}` : '–'}</td>
                      <td className="py-1.5 text-right font-mono font-semibold">{t.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {board.standings.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">Nobody has registered yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead className="text-left text-xs text-ink-faint">
                    <tr>
                      <th className="py-1 font-medium">#</th>
                      <th className="py-1 font-medium">{c.kind === 'group' ? 'Member' : 'Participant'}</th>
                      {c.kind === 'group' && <th className="py-1 font-medium">Team</th>}
                      <th className="py-1 font-medium">Solved</th>
                      <th className="py-1 font-medium">Contributions</th>
                      <th className="py-1 font-medium text-right">Time</th>
                      <th className="py-1 font-medium text-right">Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.standings.map((s) => (
                      <StandingRow key={s.person?.id ?? s.rank} s={s} view={view} me={me} teamName={teamName(s.teamId)} awards={s.person ? awardsFor(s.person.id) : []} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </LoadState>
    </div>
  );
}

function StandingRow({ s, view, me, teamName, awards }: { s: Standing; view: CompetitionView; me?: string; teamName: string; awards: Board['awards'] }) {
  const mine = s.person?.id === me;
  const contrib = s.contributions;
  const parts = [
    contrib.beginner ? `${contrib.beginner} beginner` : null,
    contrib.intermediate ? `${contrib.intermediate} intermediate` : null,
    contrib.advanced ? `${contrib.advanced} advanced` : null,
    contrib.checks ? `${contrib.checks} check${contrib.checks === 1 ? '' : 's'}` : null,
    contrib.answers ? `${contrib.answers} answer${contrib.answers === 1 ? '' : 's'} accepted` : null,
    contrib.resources ? `${contrib.resources} shared` : null,
  ].filter(Boolean);
  return (
    <tr className={`border-t border-line ${mine ? 'bg-high-soft' : ''}`}>
      <td className="py-1.5 font-mono">{s.rank}</td>
      <td className="py-1.5">
        <span className="flex items-center gap-1.5 flex-wrap">
          <PersonChip person={s.person} size={20} />
          {awards.map((a, i) => (
            <span key={i} title={a.label} aria-label={a.label} className="text-sm">
              {AWARD_GLYPH[a.kind] ?? '🏅'}
            </span>
          ))}
          {mine && <span className="text-xs text-high">(you)</span>}
        </span>
      </td>
      {view.competition.kind === 'group' && <td className="py-1.5 text-ink-soft">{teamName}</td>}
      <td className="py-1.5">
        <span className="flex gap-0.5">
          {Array.from({ length: view.competition.problemCount }, (_, i) => (
            <span key={i} className={`inline-block size-3 rounded-sm ${s.solvedOrdinals.includes(i + 1) ? 'bg-high-bright' : 'bg-bench-deep'}`} title={`Problem ${i + 1}`} />
          ))}
        </span>
      </td>
      <td className="py-1.5 text-xs text-ink-soft">{parts.length ? parts.join(', ') : '–'}</td>
      <td className="py-1.5 text-right font-mono text-ink-soft">{s.solved ? formatDuration(s.finishS) : '–'}</td>
      <td className="py-1.5 text-right font-mono font-semibold">{s.points}</td>
    </tr>
  );
}

/* ----------------------------------------------------------------------------- new */

export function NewCompetitionPage() {
  return (
    <SignedInOnly what="contests">
      <NewCompetition />
    </SignedInOnly>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function NewCompetition() {
  const [params] = useSearchParams();
  const groupId = params.get('groupId') ?? undefined;
  const group = useLoad(() => (groupId ? groups.get(groupId).then((r) => r.group) : Promise.resolve(null)), [groupId]);
  const [kind, setKind] = useState<'general' | 'group' | 'quest'>(groupId ? 'group' : 'general');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [courseSlug, setCourseSlug] = useState('digital-logic-design');
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date(Date.now() + 10 * 60_000)));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 70 * 60_000)));
  const [teamMin, setTeamMin] = useState(2);
  const [teamMax, setTeamMax] = useState(5);
  const [goal, setGoal] = useState(10);
  const [hintPenalty, setHintPenalty] = useState(20);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [points, setPoints] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (group.data?.courseSlug) setCourseSlug(group.data.courseSlug);
  }, [group.data]);

  const defaultPoints = (it: TaskItem) => {
    if (it.kind === 'check') return 100;
    const level = labById(it.id)?.level;
    return level === 'advanced' ? 300 : level === 'intermediate' ? 200 : 100;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await competitions.create({
        kind,
        title: title.trim(),
        description: description.trim() || undefined,
        courseSlug: courseSlug || undefined,
        groupId: kind === 'general' ? undefined : groupId,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        teamMin: kind === 'group' ? teamMin : undefined,
        teamMax: kind === 'group' ? teamMax : undefined,
        hintPenalty: hintPenalty / 100,
        rules: kind === 'quest' ? { goal } : {},
        problems: items.map((it) => ({ kind: it.kind, contentId: it.id, level: it.kind === 'lab' ? labById(it.id)?.level : undefined, points: points[`${it.kind}:${it.id}`] ?? defaultPoints(it) })),
      });
      navigate(`/competitions/${res.competition.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, ...(group.data ? [{ to: `/groups/${group.data.id}?tab=contests`, label: group.data.name }] : [{ to: '/competitions', label: 'Contests' }]), { label: 'New' }]} />
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{groupId ? 'Run a contest or quest in the group' : 'Run an open contest'}</h1>
      <p className="mt-1 text-sm text-ink-soft">It starts as a draft only you can see. Publish it to let people register; problems stay hidden until it goes live.</p>
      <form onSubmit={submit} className={`mt-5 ${CARD} space-y-4`}>
        {groupId && (
          <Field label="Format">
            <div className="grid gap-2 sm:grid-cols-2">
              {(['group', 'quest'] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)} className={`rounded-md border p-3 text-left ${kind === k ? 'border-high bg-high-soft' : 'border-line hover:bg-bench'}`}>
                  <span className="block font-medium">{KIND_LABEL[k]}</span>
                  <span className="block text-xs text-ink-soft mt-0.5">
                    {k === 'group' ? 'Teams compete; top 3 scores count with a bonus when everyone scores.' : 'The whole group works towards one goal; everyone who helps earns the award.'}
                  </span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} className="input" placeholder="e.g. Friday logic sprint" />
        </Field>
        <Field label="Description" hint="Optional.">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={4000} className="input" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts">
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className="input" />
          </Field>
          <Field label="Ends">
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className="input" />
          </Field>
        </div>
        {kind === 'group' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Smallest team">
              <input type="number" min={1} max={10} value={teamMin} onChange={(e) => setTeamMin(Number(e.target.value))} className="input" />
            </Field>
            <Field label="Largest team">
              <input type="number" min={teamMin} max={10} value={teamMax} onChange={(e) => setTeamMax(Number(e.target.value))} className="input" />
            </Field>
          </div>
        )}
        {kind === 'quest' && (
          <Field label="Goal: solves the group needs together">
            <input type="number" min={1} max={500} value={goal} onChange={(e) => setGoal(Number(e.target.value))} className="input" />
          </Field>
        )}
        <Field label="Hint penalty" hint="Points taken off a problem for each hint used.">
          <select value={hintPenalty} onChange={(e) => setHintPenalty(Number(e.target.value))} className="input">
            {[0, 10, 20, 30, 50].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </Field>
        <Field label="Problems from a course">
          <select value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} className="input">
            <option value="">All courses</option>
            {COURSES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <ContentPicker courseSlug={courseSlug} selected={items} onChange={setItems} />
        {items.length > 0 && (
          <div>
            <p className="text-sm font-medium">Points per problem</p>
            <ul className="mt-1.5 space-y-1.5">
              {items.map((it, i) => {
                const key = `${it.kind}:${it.id}`;
                return (
                  <li key={key} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-ink-faint w-5">{i + 1}</span>
                    <span className="flex-1 truncate">{it.kind === 'lab' ? labById(it.id)?.title : `Check ${it.id}`}</span>
                    <input type="number" min={1} max={1000} value={points[key] ?? defaultPoints(it)} onChange={(e) => setPoints({ ...points, [key]: Number(e.target.value) })} className="input w-24" aria-label="Points" />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy || items.length === 0} className={BTN}>
            Create draft
          </button>
          <button type="button" onClick={() => navigate(-1)} className={BTN_SOFT}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
