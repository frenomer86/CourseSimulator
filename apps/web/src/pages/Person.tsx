import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { messages, people } from '../lib/community';
import { useAuth } from '../store/auth';
import { Avatar } from '../components/Avatar';
import { BTN, BTN_SOFT, Breadcrumb, errorText, LoadState, RoleBadge, SignedInOnly, useLoad } from '../components/Community';
import { Notice } from '../components/Form';
import { TrophyCase } from './Competitions';

export function PersonPage() {
  const { username = '' } = useParams();
  return (
    <SignedInOnly what="profiles">
      <Person key={username} username={username} />
    </SignedInOnly>
  );
}

function Person({ username }: { username: string }) {
  const load = useLoad(() => people.get(username), [username]);
  const me = useAuth((s) => s.profile?.username);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const p = load.data;

  const message = async () => {
    if (!p) return;
    try {
      const c = await messages.open(p.person.id);
      navigate(`/messages/${c.conversationId}`);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const block = async () => {
    if (!p || !window.confirm(`Block ${p.person.displayName}? They cannot message you and you will not see their group messages.`)) return;
    try {
      await messages.block(p.person.id);
      setError(null);
      setReported(false);
      window.alert(`${p.person.displayName} is blocked. You can undo this from any conversation with them.`);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const report = async () => {
    if (!p) return;
    const reason = window.prompt('What is wrong? A moderator will look at it.');
    if (!reason?.trim()) return;
    try {
      await people.report({ targetKind: 'profile', targetId: p.person.id, reason: reason.trim() });
      setReported(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { label: p?.person.displayName ?? 'Profile' }]} />
      <LoadState loading={load.loading} error={load.error}>
        {p && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <Avatar name={p.person.displayName} url={p.person.avatarUrl} size={72} />
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
                  {p.person.displayName}
                  {p.person.platformRole !== 'learner' && <RoleBadge role={p.person.platformRole} />}
                </h1>
                <p className="text-sm text-ink-soft">
                  <span className="font-mono">@{p.person.username}</span> · joined {new Date(p.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                </p>
                {p.bio && <p className="mt-2 leading-relaxed">{p.bio}</p>}
              </div>
              {me !== p.person.username && (
                <div className="flex flex-wrap gap-2">
                  {p.canMessage && (
                    <button type="button" onClick={message} className={BTN}>
                      Message
                    </button>
                  )}
                  <button type="button" onClick={block} className={BTN_SOFT}>
                    Block
                  </button>
                  <button type="button" onClick={report} className={BTN_SOFT} disabled={reported}>
                    {reported ? 'Reported' : 'Report'}
                  </button>
                </div>
              )}
            </div>
            {error && (
              <div className="mt-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <dl className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <div className="rounded-md bg-surface border border-line p-3">
                <dt className="text-ink-soft">Level</dt>
                <dd className="text-xl font-semibold font-mono">{p.level ?? '–'}</dd>
              </div>
              <div className="rounded-md bg-surface border border-line p-3">
                <dt className="text-ink-soft">XP</dt>
                <dd className="text-xl font-semibold font-mono">{p.xp ?? '–'}</dd>
              </div>
              <div className="rounded-md bg-surface border border-line p-3">
                <dt className="text-ink-soft">Contributions</dt>
                <dd className="text-xl font-semibold font-mono">{p.contributions}</dd>
              </div>
            </dl>
            {p.xp === null && <p className="mt-2 text-xs text-ink-faint">This person keeps their XP off public boards.</p>}
            <section className="mt-8">
              <h2 className="text-xl font-semibold">Trophy case</h2>
              <TrophyCase awards={p.awards} />
            </section>
            {!p.canMessage && me !== p.person.username && <p className="mt-6 text-sm text-ink-soft">You can message people you share a group with.</p>}
          </>
        )}
      </LoadState>
    </div>
  );
}
