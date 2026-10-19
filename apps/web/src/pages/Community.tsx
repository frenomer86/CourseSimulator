import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { COURSES, courseBySlug } from '../lib/catalogue';
import { groups, type Group } from '../lib/community';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';
import { useInbox } from '../store/inbox';
import { BTN, BTN_SOFT, CARD, Empty, errorText, LoadState, SignedInOnly, useLoad } from '../components/Community';
import { Field, Notice } from '../components/Form';

export function CommunityPage() {
  return (
    <SignedInOnly what="the community">
      <CommunityHome />
    </SignedInOnly>
  );
}

function CommunityHome() {
  const mine = useLoad(() => groups.mine(), []);
  const unread = useInbox((s) => s.unread);
  const profile = useAuth((s) => s.profile);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Community</h1>
          <p className="mt-1 text-ink-soft max-w-[60ch]">Study together: groups with chat, a forum beside every lab, direct messages and contests.</p>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link to="/forum" className={BTN_SOFT}>
            Forum
          </Link>
          <Link to="/messages" className={BTN_SOFT}>
            Messages
          </Link>
          <Link to="/competitions" className={BTN_SOFT}>
            Contests
          </Link>
          <Link to="/inbox" className={BTN_SOFT}>
            Inbox{unread > 0 && <span className="ml-1.5 rounded-full bg-high px-1.5 text-xs text-white font-mono">{unread}</span>}
          </Link>
        </nav>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          <h2 className="text-xl font-semibold">Your groups</h2>
          <div className="mt-3">
            <LoadState loading={mine.loading} error={mine.error}>
              {mine.data && mine.data.length === 0 ? (
                <Empty>
                  You are not in a group yet. Create one for your classmates, or join one with the code a friend or facilitator gave you.
                </Empty>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">{mine.data?.map((g) => <GroupCard key={g.id} group={g} />)}</ul>
              )}
            </LoadState>
          </div>
          {profile?.platformRole === 'facilitator' && (
            <p className="mt-4 text-sm text-ink-soft">
              As a facilitator you can set simulation tasks and run contests inside any group you own. Create a group, share its code, and the task list appears for everyone who joins.
            </p>
          )}
          <Discover />
        </section>
        <aside className="space-y-4">
          <JoinByCode />
          <CreateGroup onCreated={() => void mine.reload()} />
        </aside>
      </div>
    </div>
  );
}

export function GroupCard({ group }: { group: Group }) {
  const course = group.courseSlug ? courseBySlug(group.courseSlug) : undefined;
  return (
    <li>
      <Link to={`/groups/${group.id}`} className="block h-full rounded-lg border border-line bg-surface p-4 hover:border-ink-faint">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-snug">{group.name}</h3>
          <span className="text-xs text-ink-faint font-mono shrink-0">
            {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-soft line-clamp-2">{group.description || (course ? `A ${course.title} group.` : 'A study group.')}</p>
        <p className="mt-2 text-xs text-ink-faint">
          {group.kind === 'class' ? 'Class' : group.kind === 'team' ? 'Team' : 'Study group'} · {group.visibility === 'public' ? 'Anyone can join' : 'By code'}
          {group.myRole && ` · You are ${group.myRole === 'member' ? 'a member' : `the ${group.myRole}`}`}
        </p>
      </Link>
    </li>
  );
}

function Discover() {
  const [q, setQ] = useState('');
  const pub = useLoad(() => groups.discover(q || undefined), [q]);
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">Open groups</h2>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or course" className="input max-w-xs" aria-label="Search open groups" />
      </div>
      <div className="mt-3">
        <LoadState loading={pub.loading} error={pub.error}>
          {pub.data && pub.data.length === 0 ? (
            <Empty>No open groups {q ? 'match that' : 'yet'}. Public groups anyone creates will show here.</Empty>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">{pub.data?.map((g) => <GroupCard key={g.id} group={g} />)}</ul>
          )}
        </LoadState>
      </div>
    </section>
  );
}

function JoinByCode() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const g = await groups.joinByCode(code.trim());
      track('joined', { type: 'group', id: g.id }, { members: g.memberCount }, { via: 'code' });
      navigate(`/groups/${g.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={CARD}>
      <h2 className="font-medium text-lg">Join with a code</h2>
      <p className="mt-1 text-sm text-ink-soft">Your facilitator or a friend gives you an 8-letter code or a link.</p>
      <div className="mt-3 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7PQ2MXD"
          maxLength={12}
          className="input font-mono uppercase tracking-widest"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Join code"
        />
        <button type="submit" disabled={busy || code.trim().length < 4} className={BTN}>
          Join
        </button>
      </div>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </form>
  );
}

function CreateGroup({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'invite'>('invite');
  const [kind, setKind] = useState<'study' | 'class'>('study');
  const [courseSlug, setCourseSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const isFacilitator = useAuth((s) => s.profile?.platformRole === 'facilitator');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const g = await groups.create({ name: name.trim(), description: description.trim() || undefined, visibility, kind, courseSlug: courseSlug || undefined });
      track('created', { type: 'group', id: g.id, course: g.courseSlug ?? undefined }, undefined, { kind: g.kind, visibility: g.visibility });
      onCreated();
      navigate(`/groups/${g.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className={CARD}>
        <h2 className="font-medium text-lg">Start a group</h2>
        <p className="mt-1 text-sm text-ink-soft">For your class, a study circle or a contest team. You get a code to share.</p>
        <button type="button" onClick={() => setOpen(true)} className={`mt-3 ${BTN_SOFT}`}>
          Create a group
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`}>
      <h2 className="font-medium text-lg">New group</h2>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={80} className="input" placeholder="e.g. Logic design, Thursday circle" />
      </Field>
      <Field label="What is it for?" hint="Optional.">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} className="input" />
      </Field>
      <Field label="Course" hint="Optional. Helps others find it and links the course forum.">
        <select value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} className="input">
          <option value="">Any course</option>
          {COURSES.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who can join">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'invite')} className="input">
            <option value="invite">Only with the code</option>
            <option value="public">Anyone who finds it</option>
          </select>
        </Field>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'study' | 'class')} className="input">
            <option value="study">Study group</option>
            <option value="class">Class{isFacilitator ? '' : ' (for facilitators)'}</option>
          </select>
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BTN}>
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className={BTN_SOFT}>
          Cancel
        </button>
      </div>
    </form>
  );
}
