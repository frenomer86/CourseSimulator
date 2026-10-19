import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LEVEL_LABEL } from '@cslab/lab-runtime';
import { CHECKS, COURSES, courseBySlug, labById, LABS, unitOf } from '../lib/catalogue';
import {
  competitions,
  formatWhen,
  groups,
  messages as dm,
  resources as resourcesApi,
  timeAgo,
  type Competition,
  type Group,
  type GroupMessage,
  type GroupTask,
  type Member,
  type Online,
  type Resource,
  type TaskItem,
  type TaskMember,
} from '../lib/community';
import { sendGroupMessage, useRoom } from '../lib/realtime';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';
import { Avatar } from '../components/Avatar';
import { BTN, BTN_DANGER, BTN_SMALL, BTN_SOFT, Breadcrumb, CARD, Composer, Empty, errorText, LoadState, PersonChip, RoleBadge, SignedInOnly, Tabs, useLoad } from '../components/Community';
import { CompetitionCard } from './Competitions';
import { Field, Notice } from '../components/Form';

type Tab = 'chat' | 'members' | 'resources' | 'tasks' | 'contests';
const TAB_IDS: Tab[] = ['chat', 'members', 'resources', 'tasks', 'contests'];

export function GroupPage() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly what="groups">
      <GroupView key={id} id={id} />
    </SignedInOnly>
  );
}

function GroupView({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TAB_IDS.includes(tabParam) ? tabParam : 'chat';
  const setTab = (t: Tab) => setParams(t === 'chat' ? {} : { tab: t }, { replace: true });
  const load = useLoad(() => groups.get(id), [id]);
  const group = load.data?.group ?? null;
  const room = useRoom(group?.myRole ? id : undefined);
  const online = room.online.length ? room.online : (load.data?.online ?? []);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    try {
      const g = await groups.join(id);
      track('joined', { type: 'group', id }, { members: g.memberCount }, { via: 'public' });
      load.setData({ group: g, online: [] });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const leave = async () => {
    if (!window.confirm(group?.myRole === 'owner' ? 'Leave this group? Ownership passes to the next member, or the group closes if you are the last one.' : 'Leave this group?')) return;
    try {
      await groups.leave(id);
      track('left', { type: 'group', id });
      navigate('/community');
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { label: group?.name ?? 'Group' }]} />
      <LoadState loading={load.loading} error={load.error}>
        {group && (
          <>
            <GroupHeader group={group} onChange={(g) => load.setData({ group: g, online })} onJoin={join} onLeave={leave} />
            {error && (
              <div className="mt-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            {group.myRole ? (
              <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="min-w-0">
                  <Tabs tabs={TAB_IDS.map((t) => ({ id: t, label: TAB_LABEL[t] }))} value={tab} onChange={setTab} />
                  <div className="mt-4">
                    {tab === 'chat' && <ChatPanel group={group} incoming={room.incoming} deleted={room.deleted} connected={room.connected} />}
                    {tab === 'members' && <MembersPanel group={group} online={online} />}
                    {tab === 'resources' && <ResourcesPanel group={group} />}
                    {tab === 'tasks' && <TasksPanel group={group} />}
                    {tab === 'contests' && <ContestsPanel group={group} />}
                  </div>
                </div>
                <OnlineRail online={online} connected={room.connected} total={group.memberCount} />
              </div>
            ) : (
              <div className="mt-6">
                <Empty>Join the group to see its chat, members, resources and tasks.</Empty>
              </div>
            )}
          </>
        )}
      </LoadState>
    </div>
  );
}

const TAB_LABEL: Record<Tab, string> = { chat: 'Chat', members: 'Members', resources: 'Resources', tasks: 'Tasks', contests: 'Contests' };

function GroupHeader({ group, onChange, onJoin, onLeave }: { group: Group; onChange: (g: Group) => void; onJoin: () => void; onLeave: () => void }) {
  const course = group.courseSlug ? courseBySlug(group.courseSlug) : undefined;
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  const link = `${window.location.origin}/groups/join/${group.joinCode ?? ''}`;

  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? (group.joinCode ?? '') : link);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt('Copy this', what === 'code' ? (group.joinCode ?? '') : link);
    }
  };
  const newCode = async () => {
    if (!window.confirm('Make a new code? The old code and link stop working.')) return;
    onChange(await groups.newCode(group.id));
  };
  const remove = async () => {
    if (!window.confirm('Delete this group for everyone, with its chat, resources and tasks? This cannot be undone.')) return;
    await groups.remove(group.id);
    navigate('/community');
  };

  return (
    <header className="mt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
          <p className="mt-1 text-sm text-ink-soft flex flex-wrap gap-x-3 gap-y-1">
            <span>{group.kind === 'class' ? 'Class' : group.kind === 'team' ? 'Team' : 'Study group'}</span>
            <span>
              {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
            </span>
            <span>{group.visibility === 'public' ? 'Anyone can join' : 'Join by code'}</span>
            {course && (
              <Link to={`/courses/${course.slug}`} className="hover:text-ink underline underline-offset-2">
                {course.title}
              </Link>
            )}
          </p>
          {group.description && <p className="mt-2 max-w-[70ch] leading-relaxed">{group.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!group.myRole && group.visibility === 'public' && (
            <button type="button" onClick={onJoin} className={BTN}>
              Join group
            </button>
          )}
          {isAdmin && (
            <button type="button" onClick={() => setEditing((v) => !v)} className={BTN_SOFT}>
              {editing ? 'Close settings' : 'Settings'}
            </button>
          )}
          {group.myRole && (
            <button type="button" onClick={onLeave} className={BTN_SOFT}>
              Leave
            </button>
          )}
        </div>
      </div>

      {group.myRole && group.joinCode && (
        <div className="mt-4 rounded-lg border border-line bg-surface px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-soft">Invite others with the code</span>
          <span className="font-mono text-base tracking-widest font-semibold">{group.joinCode}</span>
          <button type="button" onClick={() => copy('code')} className={BTN_SMALL}>
            {copied === 'code' ? 'Copied' : 'Copy code'}
          </button>
          <button type="button" onClick={() => copy('link')} className={BTN_SMALL}>
            {copied === 'link' ? 'Copied' : 'Copy join link'}
          </button>
          {isAdmin && (
            <button type="button" onClick={newCode} className="text-ink-soft underline underline-offset-2 hover:text-ink">
              New code
            </button>
          )}
        </div>
      )}

      {editing && isAdmin && <GroupSettings group={group} onChange={onChange} onDelete={group.myRole === 'owner' ? remove : undefined} />}
    </header>
  );
}

function GroupSettings({ group, onChange, onDelete }: { group: Group; onChange: (g: Group) => void; onDelete?: () => void }) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [visibility, setVisibility] = useState(group.visibility);
  const [courseSlug, setCourseSlug] = useState(group.courseSlug ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await groups.update(group.id, { name: name.trim(), description: description.trim(), visibility, courseSlug }));
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form onSubmit={save} className={`mt-4 ${CARD} space-y-3`}>
      <h2 className="font-medium">Group settings</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} minLength={3} maxLength={80} required className="input" />
        </Field>
        <Field label="Who can join">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'invite')} className="input">
            <option value="invite">Only with the code</option>
            <option value="public">Anyone who finds it</option>
          </select>
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} className="input" />
        </Field>
        <Field label="Course">
          <select value={courseSlug} onChange={(e) => setCourseSlug(e.target.value)} className="input">
            <option value="">Any course</option>
            {COURSES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={BTN}>
          Save
        </button>
        {saved && <span className="text-sm text-high">Saved.</span>}
        {onDelete && (
          <button type="button" onClick={onDelete} className={`ml-auto ${BTN_DANGER}`}>
            Delete group
          </button>
        )}
      </div>
    </form>
  );
}

function OnlineRail({ online, connected, total }: { online: Online[]; connected: boolean; total: number }) {
  return (
    <aside className="rounded-lg border border-line bg-surface p-4 h-fit">
      <h2 className="font-medium flex items-center gap-2">
        <span className={`inline-block size-2 rounded-full ${connected ? 'bg-high-bright' : 'bg-low'}`} aria-hidden />
        Online now
        <span className="ml-auto font-mono text-xs text-ink-faint">
          {online.length}/{total}
        </span>
      </h2>
      {online.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">{connected ? 'Nobody else is here right now.' : 'Connecting…'}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {online.map((p, i) => (
            <li key={`${p.displayName}-${i}`} className="flex items-center gap-2 text-sm">
              <Avatar name={p.displayName} url={p.avatarUrl} size={24} />
              <span className="truncate">{p.displayName}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-ink-faint">Only names and pictures are shared here.</p>
    </aside>
  );
}

/* ----------------------------------------------------------------------------- chat */

function ChatPanel({ group, incoming, deleted, connected }: { group: Group; incoming: GroupMessage[]; deleted: number[]; connected: boolean }) {
  const history = useLoad(() => groups.messages(group.id), [group.id]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<GroupMessage[]>([]);
  const me = useAuth((s) => s.user?.id);
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  const bottom = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const map = new Map<number, GroupMessage>();
    for (const m of [...(history.data?.messages ?? []), ...sent, ...incoming]) map.set(m.id, m);
    for (const id of deleted) {
      const m = map.get(id);
      if (m) map.set(id, { ...m, body: '', deletedAt: m.deletedAt ?? new Date().toISOString() });
    }
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [history.data, sent, incoming, deleted]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [all.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    setError(null);
    try {
      // The live socket echoes the message back to every open tab; fall back to REST when it is down.
      if (!sendGroupMessage(group.id, body)) {
        const m = await groups.send(group.id, body);
        setSent((s) => [...s, m]);
      }
      track('posted', { type: 'group-message', id: group.id }, { length: body.length });
    } catch (err) {
      setError(errorText(err));
      setDraft(body);
    }
  };

  const remove = async (m: GroupMessage) => {
    try {
      await groups.deleteMessage(group.id, m.id);
      setSent((s) => s.map((x) => (x.id === m.id ? { ...x, body: '', deletedAt: new Date().toISOString() } : x)));
      history.setData((d) => (d ? { ...d, messages: d.messages.map((x) => (x.id === m.id ? { ...x, body: '', deletedAt: new Date().toISOString() } : x)) } : d));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface flex flex-col" style={{ minHeight: 420 }}>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 max-h-[60vh]">
        <LoadState loading={history.loading} error={history.error}>
          {all.length === 0 && <p className="text-sm text-ink-soft">No messages yet. Say hello.</p>}
          {all.map((m, i) => {
            const prev = all[i - 1];
            const sameAuthor = prev && prev.author?.id === m.author?.id && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
            const mine = m.author?.id === me;
            return (
              <div key={m.id} className={`group/msg ${sameAuthor ? 'pl-9' : 'flex gap-2.5'}`}>
                {!sameAuthor && <Avatar name={m.author?.displayName ?? '?'} url={m.author?.avatarUrl ?? null} size={28} />}
                <div className="min-w-0 flex-1">
                  {!sameAuthor && (
                    <div className="flex items-baseline gap-2 text-sm">
                      <PersonChip person={m.author} avatar={false} />
                      <span className="text-xs text-ink-faint" title={formatWhen(m.createdAt)}>
                        {timeAgo(m.createdAt)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <p className={`text-[15px] leading-relaxed whitespace-pre-wrap break-words ${m.deletedAt ? 'italic text-ink-faint' : ''}`}>{m.deletedAt ? 'Message removed' : m.body}</p>
                    {!m.deletedAt && (mine || isAdmin) && (
                      <button type="button" onClick={() => remove(m)} className="opacity-0 group-hover/msg:opacity-100 focus:opacity-100 text-xs text-ink-faint hover:text-fault shrink-0" aria-label="Remove message">
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </LoadState>
        <div ref={bottom} />
      </div>
      <div className="border-t border-line p-3">
        {error && (
          <div className="mb-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <Composer value={draft} onChange={setDraft} onSubmit={send} placeholder={connected ? 'Message the group' : 'Message the group (reconnecting…)'} />
        <p className="mt-1.5 text-xs text-ink-faint">Up to 4000 characters. Ctrl+Enter sends. People you block are hidden from you.</p>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------------------- members */

function MembersPanel({ group, online }: { group: Group; online: Online[] }) {
  const load = useLoad(() => groups.members(group.id), [group.id]);
  const me = useAuth((s) => s.user?.id);
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const onlineNames = new Set(online.map((o) => o.displayName));

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const message = async (m: Member) => {
    try {
      const c = await dm.open(m.id);
      navigate(`/messages/${c.conversationId}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section>
      {error && (
        <div className="mb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <LoadState loading={load.loading} error={load.error}>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {load.data?.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="relative">
                <Avatar name={m.displayName} url={m.avatarUrl} size={32} />
                {onlineNames.has(m.displayName) && <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-high-bright border-2 border-surface" aria-label="Online" />}
              </span>
              <div className="min-w-0 flex-1">
                <PersonChip person={m} avatar={false} suffix={<RoleBadge role={m.role} />} />
                <p className="text-xs text-ink-faint">
                  @{m.username} · joined {timeAgo(m.joinedAt)}
                </p>
              </div>
              {m.id !== me && (
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => message(m)} className={BTN_SMALL}>
                    Message
                  </button>
                  {isAdmin && m.role !== 'owner' && (
                    <>
                      <button type="button" onClick={() => act(() => groups.setRole(group.id, m.id, m.role === 'admin' ? 'member' : 'admin'))} className={BTN_SMALL}>
                        {m.role === 'admin' ? 'Make member' : 'Make admin'}
                      </button>
                      <button
                        type="button"
                        onClick={() => window.confirm(`Remove ${m.displayName} from the group?`) && act(() => groups.removeMember(group.id, m.id))}
                        className={`${BTN_SMALL} text-fault`}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </LoadState>
    </section>
  );
}

/* ----------------------------------------------------------------------------- resources */

export function ResourceList({ items, onRemove, canRemove }: { items: Resource[]; onRemove: (r: Resource) => void; canRemove: (r: Resource) => boolean }) {
  if (items.length === 0) return <Empty>Nothing shared yet. Links and notes you add appear here for everyone in the group.</Empty>;
  return (
    <ul className="space-y-2">
      {items.map((r) => {
        const lab = r.labId ? labById(r.labId) : undefined;
        return (
          <li key={r.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[11px] uppercase tracking-wide text-ink-faint font-medium">{r.kind === 'link' ? 'Link' : r.kind === 'note' ? 'Note' : r.kind === 'solution' ? 'Solution share' : 'File'}</span>
                <h3 className="font-medium leading-snug">
                  {r.kind === 'link' && r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-high break-words">
                      {r.title}
                    </a>
                  ) : r.kind === 'solution' && lab ? (
                    <Link to={`/labs/${lab.id}`} className="hover:text-high">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </h3>
                {r.kind === 'link' && r.url && <p className="text-xs text-ink-faint truncate">{r.url}</p>}
              </div>
              {canRemove(r) && (
                <button type="button" onClick={() => onRemove(r)} className="text-xs text-ink-faint hover:text-fault">
                  Remove
                </button>
              )}
            </div>
            {r.body && <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{r.body}</p>}
            <p className="mt-2 text-xs text-ink-faint flex items-center gap-1.5">
              <PersonChip person={r.owner} size={16} /> · {timeAgo(r.createdAt)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function ShareForm({ onShare, kinds = ['link', 'note'] }: { onShare: (body: { kind: 'link' | 'note'; title: string; url?: string; body?: string }) => Promise<void>; kinds?: Array<'link' | 'note'> }) {
  const [kind, setKind] = useState<'link' | 'note'>(kinds[0]);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onShare({ kind, title: title.trim(), url: kind === 'link' ? url.trim() : undefined, body: body.trim() || undefined });
      setTitle('');
      setUrl('');
      setBody('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Share something</h3>
        <div className="flex gap-1 text-sm" role="radiogroup">
          {kinds.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-md px-2.5 py-1 border ${kind === k ? 'border-high bg-high-soft text-high' : 'border-line hover:bg-bench'}`}>
              {k === 'link' ? 'A link' : 'A note'}
            </button>
          ))}
        </div>
      </div>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={160} className="input" placeholder={kind === 'link' ? 'What is it?' : 'A short heading'} />
      </Field>
      {kind === 'link' && (
        <Field label="Web address">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required className="input" placeholder="https://…" inputMode="url" />
        </Field>
      )}
      <Field label={kind === 'link' ? 'Why is it useful?' : 'The note'} hint={kind === 'link' ? 'Optional.' : undefined}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} required={kind === 'note'} rows={kind === 'note' ? 4 : 2} maxLength={20000} className="input" />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={BTN}>
        Share
      </button>
    </form>
  );
}

function ResourcesPanel({ group }: { group: Group }) {
  const load = useLoad(() => resourcesApi.forGroup(group.id), [group.id]);
  const me = useAuth((s) => s.user?.id);
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <LoadState loading={load.loading} error={load.error}>
        <ResourceList
          items={load.data ?? []}
          canRemove={(r) => isAdmin || r.owner?.id === me}
          onRemove={async (r) => {
            if (!window.confirm('Remove this from the group?')) return;
            await resourcesApi.remove(r.id);
            void load.reload();
          }}
        />
      </LoadState>
      <ShareForm
        onShare={async (b) => {
          const r = await resourcesApi.share({ ...b, groupId: group.id, courseSlug: group.courseSlug ?? undefined });
          track('shared', { type: 'resource', id: r.id, course: group.courseSlug ?? undefined }, undefined, { kind: r.kind, to: 'group' });
          void load.reload();
        }}
      />
    </section>
  );
}

/* ----------------------------------------------------------------------------- tasks */

function TasksPanel({ group }: { group: Group }) {
  const load = useLoad(() => groups.tasks(group.id), [group.id]);
  const profile = useAuth((s) => s.profile);
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  const canSet = isAdmin && (profile?.platformRole === 'facilitator' || profile?.platformRole === 'moderator' || profile?.platformRole === 'admin');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft max-w-[60ch]">
          Simulation tasks set for this group: labs to pass and topic checks to clear, each with an optional deadline. Completing them anywhere in the app counts.
        </p>
        {canSet && (
          <button type="button" onClick={() => setCreating((v) => !v)} className={BTN}>
            {creating ? 'Close' : 'Set a task'}
          </button>
        )}
        {isAdmin && !canSet && (
          <p className="text-sm text-ink-soft">
            Setting tasks is for facilitators.{' '}
            <Link to="/profile" className="underline underline-offset-2 hover:text-ink">
              Declare yourself one on your profile.
            </Link>
          </p>
        )}
      </div>
      {creating && (
        <div className="mt-4">
          <NewTaskForm
            group={group}
            onCreated={() => {
              setCreating(false);
              void load.reload();
            }}
          />
        </div>
      )}
      <div className="mt-4">
        <LoadState loading={load.loading} error={load.error}>
          {load.data && load.data.length === 0 ? (
            <Empty>No tasks yet.{canSet ? ' Set one from the labs and checks in the catalogue, and everyone in the group sees it.' : ''}</Empty>
          ) : (
            <ul className="space-y-3">
              {load.data?.map((t) => (
                <TaskCard
                  key={t.id}
                  group={group}
                  task={t}
                  open={open === t.id}
                  onToggle={() => setOpen(open === t.id ? null : t.id)}
                  canManage={canSet}
                  onDeleted={() => void load.reload()}
                />
              ))}
            </ul>
          )}
        </LoadState>
      </div>
    </section>
  );
}

function itemTitle(it: TaskItem): string {
  if (it.kind === 'lab') return labById(it.id)?.title ?? it.title ?? it.id;
  const [slug, u, t] = it.id.split(':');
  const course = courseBySlug(slug);
  const unit = course ? unitOf(course, Number(u)) : undefined;
  return unit?.topics[Number(t) - 1] ? `Check: ${unit.topics[Number(t) - 1]}` : (it.title ?? `Check ${it.id}`);
}

function itemLink(it: TaskItem): string {
  if (it.kind === 'lab') return `/labs/${it.id}`;
  const [slug, u, t] = it.id.split(':');
  return `/courses/${slug}/units/${u}/topics/${t}/check`;
}

function TaskCard({ group, task, open, onToggle, canManage, onDeleted }: { group: Group; task: GroupTask; open: boolean; onToggle: () => void; canManage: boolean; onDeleted: () => void }) {
  const due = task.dueAt ? Date.parse(task.dueAt) : null;
  const overdue = due !== null && due < Date.now() && task.mine.done < task.mine.total;
  const complete = task.mine.done === task.mine.total;
  const completedRef = useRef(complete);
  useEffect(() => {
    if (complete && !completedRef.current) track('completed', { type: 'assignment', id: task.id }, { items: task.mine.total });
    completedRef.current = complete;
  }, [complete, task.id, task.mine.total]);

  return (
    <li className="rounded-lg border border-line bg-surface">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-medium leading-snug">{task.title}</h3>
            <p className="text-xs text-ink-faint mt-0.5">
              Set by {task.createdBy?.displayName ?? 'a facilitator'} {timeAgo(task.createdAt)}
              {task.dueAt && (
                <>
                  {' · '}
                  <span className={overdue ? 'text-fault font-medium' : ''}>
                    {overdue ? 'Was due' : 'Due'} {formatWhen(task.dueAt)}
                  </span>
                </>
              )}
            </p>
          </div>
          <span className={`font-mono text-sm ${complete ? 'text-high' : 'text-ink-soft'}`}>
            {task.mine.done}/{task.mine.total} done
          </span>
        </div>
        {task.description && <p className="mt-2 text-sm leading-relaxed">{task.description}</p>}
        <ul className="mt-3 space-y-1.5">
          {task.items.map((it) => {
            const done = task.mine.completedIds.includes(it.id);
            return (
              <li key={`${it.kind}:${it.id}`} className="flex items-center gap-2 text-sm">
                <span className={`size-5 shrink-0 rounded-full border-2 grid place-items-center text-[10px] font-mono ${done ? 'border-high bg-high text-white' : 'border-line text-ink-faint'}`} aria-label={done ? 'Done' : 'Not done'}>
                  {done ? '✓' : ''}
                </span>
                <Link to={itemLink(it)} className="hover:text-high underline-offset-2 hover:underline">
                  {itemTitle(it)}
                </Link>
                <span className="text-xs text-ink-faint">{it.kind === 'lab' ? LEVEL_LABEL[labById(it.id)?.level ?? 'beginner'] + ' lab' : 'Topic check'}</span>
              </li>
            );
          })}
        </ul>
        {(group.myRole === 'owner' || group.myRole === 'admin') && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onToggle} className={BTN_SMALL}>
              {open ? 'Hide who has finished' : 'Who has finished?'}
            </button>
            {canManage && (
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm('Remove this task?')) return;
                  await groups.deleteTask(group.id, task.id);
                  onDeleted();
                }}
                className={`${BTN_SMALL} text-fault`}
              >
                Remove task
              </button>
            )}
          </div>
        )}
      </div>
      {open && <TaskCompletion group={group} task={task} />}
    </li>
  );
}

function TaskCompletion({ group, task }: { group: Group; task: GroupTask }) {
  const load = useLoad(() => groups.task(group.id, task.id), [group.id, task.id]);
  const members: TaskMember[] = load.data?.members ?? [];
  const finished = members.filter((m) => m.done === m.total).length;
  return (
    <div className="border-t border-line px-4 py-3">
      <LoadState loading={load.loading} error={load.error}>
        <p className="text-sm text-ink-soft mb-2">
          {finished} of {members.length} member{members.length === 1 ? '' : 's'} finished everything.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-faint">
            <tr>
              <th className="py-1 font-medium">Member</th>
              {task.items.map((it, i) => (
                <th key={i} className="py-1 font-medium text-center" title={itemTitle(it)}>
                  {i + 1}
                </th>
              ))}
              <th className="py-1 font-medium text-right">Done</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t border-line">
                <td className="py-1.5">
                  <PersonChip person={m} size={20} />
                </td>
                {task.items.map((it, i) => (
                  <td key={i} className={`py-1.5 text-center font-mono ${m.completedIds.includes(it.id) ? 'text-high' : 'text-ink-faint'}`}>
                    {m.completedIds.includes(it.id) ? '✓' : '·'}
                  </td>
                ))}
                <td className={`py-1.5 text-right font-mono ${m.done === m.total ? 'text-high' : ''}`}>
                  {m.done}/{m.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </LoadState>
    </div>
  );
}

export function ContentPicker({ courseSlug, selected, onChange }: { courseSlug: string; selected: TaskItem[]; onChange: (items: TaskItem[]) => void }) {
  const labs = useMemo(() => LABS.filter((l) => !courseSlug || l.course === courseSlug), [courseSlug]);
  const checks = useMemo(() => CHECKS.filter((c) => !courseSlug || c.course === courseSlug), [courseSlug]);
  const has = (kind: TaskItem['kind'], id: string) => selected.some((s) => s.kind === kind && s.id === id);
  const toggle = (kind: TaskItem['kind'], id: string) => onChange(has(kind, id) ? selected.filter((s) => !(s.kind === kind && s.id === id)) : [...selected, { kind, id }]);
  return (
    <div className="grid gap-3 sm:grid-cols-2 max-h-72 overflow-y-auto rounded-md border border-line p-3">
      <div>
        <p className="text-xs font-medium text-ink-soft mb-1">Labs</p>
        {labs.length === 0 && <p className="text-xs text-ink-faint">No labs published for this course yet.</p>}
        {labs.map((l) => (
          <label key={l.id} className="flex items-start gap-2 text-sm py-0.5">
            <input type="checkbox" checked={has('lab', l.id)} onChange={() => toggle('lab', l.id)} className="mt-1 accent-[var(--color-high)]" />
            <span>
              {l.title} <span className="text-xs text-ink-faint">{LEVEL_LABEL[l.level]}</span>
            </span>
          </label>
        ))}
      </div>
      <div>
        <p className="text-xs font-medium text-ink-soft mb-1">Topic checks</p>
        {checks.length === 0 && <p className="text-xs text-ink-faint">No checks for this course yet.</p>}
        {checks.map((c) => {
          const id = `${c.course}:${c.unit}:${c.topic}`;
          const course = courseBySlug(c.course);
          const unit = course ? unitOf(course, c.unit) : undefined;
          return (
            <label key={id} className="flex items-start gap-2 text-sm py-0.5">
              <input type="checkbox" checked={has('check', id)} onChange={() => toggle('check', id)} className="mt-1 accent-[var(--color-high)]" />
              <span>
                {unit?.topics[c.topic - 1] ?? id} <span className="text-xs text-ink-faint">Unit {c.unit}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function NewTaskForm({ group, onCreated }: { group: Group; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [courseSlug, setCourseSlug] = useState(group.courseSlug ?? 'digital-logic-design');
  const [items, setItems] = useState<TaskItem[]>([]);
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await groups.createTask(group.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        items: items.map((it) => ({ ...it, title: itemTitle(it) })),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      });
      track('assigned', { type: 'assignment', id: t.id, course: courseSlug || undefined }, { items: items.length, labs: items.filter((i) => i.kind === 'lab').length, checks: items.filter((i) => i.kind === 'check').length }, { group: group.id, hasDeadline: !!dueAt });
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={`${CARD} space-y-3`}>
      <h3 className="font-medium">New simulation task</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} className="input" placeholder="e.g. Week 3: build the half adder" />
        </Field>
        <Field label="Deadline" hint="Optional. Members are reminded in their inbox.">
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="input" />
        </Field>
      </div>
      <Field label="Instructions" hint="Optional.">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className="input" />
      </Field>
      <Field label="Pick from a course">
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
      <p className="text-xs text-ink-soft">
        {items.length} item{items.length === 1 ? '' : 's'} selected.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy || items.length === 0} className={BTN}>
        Set task for the group
      </button>
    </form>
  );
}

/* ----------------------------------------------------------------------------- contests */

function ContestsPanel({ group }: { group: Group }) {
  const load = useLoad(() => competitions.forGroup(group.id), [group.id]);
  const profile = useAuth((s) => s.profile);
  const isAdmin = group.myRole === 'owner' || group.myRole === 'admin';
  const canRun = isAdmin || profile?.platformRole === 'facilitator';
  const list: Competition[] = load.data ?? [];
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft max-w-[60ch]">Team contests and co-op quests for this group. Everyone in the group can take part.</p>
        {canRun && (
          <Link to={`/competitions/new?groupId=${group.id}`} className={BTN}>
            Run a contest or quest
          </Link>
        )}
      </div>
      <div className="mt-4">
        <LoadState loading={load.loading} error={load.error}>
          {list.length === 0 ? <Empty>No contests in this group yet.</Empty> : <ul className="grid gap-3 sm:grid-cols-2">{list.map((c) => <CompetitionCard key={c.id} competition={c} />)}</ul>}
        </LoadState>
      </div>
    </section>
  );
}
