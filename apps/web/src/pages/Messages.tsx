import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatWhen, messages, timeAgo, type Conversation, type DirectMessage } from '../lib/community';
import { onFrame } from '../lib/realtime';
import { useAuth } from '../store/auth';
import { Avatar } from '../components/Avatar';
import { BTN_SMALL, Breadcrumb, Composer, Empty, errorText, LoadState, PersonChip, SignedInOnly, useLoad } from '../components/Community';
import { Notice } from '../components/Form';

export function MessagesPage() {
  const { id } = useParams();
  return (
    <SignedInOnly what="messages">
      <Messages activeId={id} />
    </SignedInOnly>
  );
}

function Messages({ activeId }: { activeId?: string }) {
  const list = useLoad(() => messages.conversations(), [activeId]);
  const reloadList = list.reload;
  useEffect(
    () =>
      onFrame((f) => {
        if (f.type === 'dm') void reloadList();
      }),
    [reloadList],
  );
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { label: 'Messages' }]} />
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Messages</h1>
      <p className="mt-1 text-sm text-ink-soft">One-to-one with people you share a group with. Open someone's profile or a group's member list to start one.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-line bg-surface overflow-hidden h-fit">
          <LoadState loading={list.loading} error={list.error}>
            {list.data && list.data.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No conversations yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {list.data?.map((c) => (
                  <ConversationRow key={c.id} c={c} active={c.id === activeId} />
                ))}
              </ul>
            )}
          </LoadState>
        </aside>
        <section className="min-w-0">
          {activeId ? <Thread key={activeId} id={activeId} onChange={() => void list.reload()} /> : <Empty>Pick a conversation, or message someone from a group's member list.</Empty>}
        </section>
      </div>
    </div>
  );
}

function ConversationRow({ c, active }: { c: Conversation; active: boolean }) {
  return (
    <li>
      <Link to={`/messages/${c.id}`} className={`flex items-center gap-3 px-3 py-2.5 hover:bg-bench ${active ? 'bg-bench' : ''}`}>
        <Avatar name={c.other?.displayName ?? '?'} url={c.other?.avatarUrl ?? null} size={36} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${c.unread ? 'font-semibold' : 'font-medium'}`}>{c.other?.displayName ?? 'Someone who left'}</span>
            {c.lastMessage && <span className="text-[11px] text-ink-faint shrink-0">{timeAgo(c.lastMessage.createdAt)}</span>}
          </span>
          <span className={`block truncate text-xs ${c.unread ? 'text-ink' : 'text-ink-soft'}`}>{c.lastMessage?.body ?? 'No messages yet'}</span>
        </span>
        {c.unread > 0 && <span className="rounded-full bg-high px-1.5 text-xs text-white font-mono">{c.unread}</span>}
      </Link>
    </li>
  );
}

function Thread({ id, onChange }: { id: string; onChange: () => void }) {
  const load = useLoad(() => messages.list(id), [id]);
  const me = useAuth((s) => s.user?.id);
  const [draft, setDraft] = useState('');
  const [extra, setExtra] = useState<DirectMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onFrame((f) => {
        if (f.type === 'dm' && f.conversationId === id) setExtra((x) => (x.some((m) => m.id === f.message.id) ? x : [...x, f.message]));
      }),
    [id],
  );

  const all = useMemo(() => {
    const map = new Map<number, DirectMessage>();
    for (const m of [...(load.data?.messages ?? []), ...extra]) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [load.data, extra]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [all.length]);

  const isBlocked = blocked ?? load.data?.blocked ?? false;
  const other = load.data?.other ?? null;

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    setError(null);
    try {
      const m = await messages.send(id, body);
      setExtra((x) => [...x, m]);
      onChange();
    } catch (err) {
      setError(errorText(err));
      setDraft(body);
    }
  };

  const toggleBlock = async () => {
    if (!other) return;
    try {
      if (isBlocked) await messages.unblock(other.id);
      else {
        if (!window.confirm(`Block ${other.displayName}? They will not be able to message you, and you will not see their group messages.`)) return;
        await messages.block(other.id);
      }
      setBlocked(!isBlocked);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface flex flex-col" style={{ minHeight: 480 }}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <PersonChip person={other} size={28} />
        {other && (
          <button type="button" onClick={toggleBlock} className={`ml-auto ${BTN_SMALL}`}>
            {isBlocked ? 'Unblock' : 'Block'}
          </button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 max-h-[55vh]">
        <LoadState loading={load.loading} error={load.error}>
          {all.length === 0 && <p className="text-sm text-ink-soft">No messages yet. Say hello.</p>}
          {all.map((m) => {
            const mine = m.senderId === me;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-lg px-3 py-2 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${mine ? 'bg-high text-white' : 'bg-bench'}`} title={formatWhen(m.createdAt)}>
                  {m.body}
                  <span className={`block text-[10px] mt-0.5 ${mine ? 'text-white/70' : 'text-ink-faint'}`}>{timeAgo(m.createdAt)}</span>
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
        {isBlocked ? (
          <p className="text-sm text-ink-soft">You have blocked this person. Unblock to message them.</p>
        ) : (
          <Composer value={draft} onChange={setDraft} onSubmit={send} placeholder={`Message ${other?.displayName ?? ''}`.trim()} />
        )}
      </div>
    </div>
  );
}
