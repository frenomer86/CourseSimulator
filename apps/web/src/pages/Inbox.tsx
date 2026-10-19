import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { timeAgo, type Notification } from '../lib/community';
import { useInbox } from '../store/inbox';
import { BTN_SOFT, Breadcrumb, Empty, SignedInOnly } from '../components/Community';

const KIND_WORD: Record<Notification['kind'], string> = {
  reply: 'Reply',
  mention: 'Mention',
  accepted: 'Answer accepted',
  invite: 'Invite',
  deadline: 'Deadline',
  contest: 'Contest',
  message: 'Message',
  task: 'Task',
};

export function InboxPage() {
  return (
    <SignedInOnly what="your inbox">
      <Inbox />
    </SignedInOnly>
  );
}

function Inbox() {
  const { notifications, unread, loaded, refresh, markRead } = useInbox();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { label: 'Inbox' }]} />
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-ink-soft">Replies, mentions, accepted answers, tasks and deadlines, and contest news. Nothing is emailed.</p>
        </div>
        {unread > 0 && (
          <button type="button" onClick={() => void markRead()} className={BTN_SOFT}>
            Mark all read
          </button>
        )}
      </div>
      <div className="mt-5">
        {!loaded ? (
          <p className="text-sm text-ink-soft">Loading…</p>
        ) : notifications.length === 0 ? (
          <Empty>Nothing yet. When someone replies to you or your group gets a task, it shows up here.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {notifications.map((n) => (
              <li key={n.id} className={`px-4 py-3 ${n.readAt ? '' : 'bg-high-soft/40'}`}>
                <Link to={n.link ?? '#'} onClick={() => !n.readAt && void markRead([n.id])} className="block">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-ink-faint font-medium">{KIND_WORD[n.kind] ?? n.kind}</span>
                    <span className="text-xs text-ink-faint">{timeAgo(n.createdAt)}</span>
                  </div>
                  <p className={`mt-0.5 leading-snug ${n.readAt ? '' : 'font-medium'}`}>{n.title}</p>
                  {n.body && <p className="mt-0.5 text-sm text-ink-soft line-clamp-2">{n.body}</p>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
