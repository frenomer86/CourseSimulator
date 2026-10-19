import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { courseBySlug, labById, unitOf } from '../lib/catalogue';
import { forum, formatWhen, timeAgo, type Category, type Post, type ThreadSummary, type ThreadView } from '../lib/community';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';
import { BTN, BTN_SMALL, BTN_SOFT, Breadcrumb, CARD, Composer, Empty, errorText, LoadState, PersonChip, SignedInOnly, useLoad } from '../components/Community';
import { Field, Notice } from '../components/Form';

/* ----------------------------------------------------------------------------- list */

export function ForumPage() {
  return (
    <SignedInOnly what="the forum">
      <ForumHome />
    </SignedInOnly>
  );
}

function ForumHome() {
  const { category } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const unsolved = params.get('unsolved') === '1';
  const cats = useLoad(() => forum.categories(), []);
  const threads = useLoad(() => forum.threads({ category: category || undefined, q: q || undefined, unsolved, limit: 50 }), [category, q, unsolved]);
  const current = cats.data?.find((c) => c.id === category);
  const courseCats = cats.data?.filter((c) => !['general', 'help', 'careers', 'lecturers'].includes(c.id)) ?? [];
  const fixedCats = cats.data?.filter((c) => ['general', 'help', 'careers', 'lecturers'].includes(c.id)) ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Breadcrumb items={[{ to: '/community', label: 'Community' }, { to: '/forum', label: 'Forum' }, ...(current ? [{ label: current.name }] : [])]} />
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{current ? current.name : 'Forum'}</h1>
          <p className="mt-1 text-ink-soft max-w-[60ch]">{current?.description ?? 'Ask about a lab, a topic or anything in the degree. Answers can be accepted by the asker and endorsed by facilitators.'}</p>
        </div>
        <Link to={`/forum/new${category ? `?category=${category}` : ''}`} className={BTN}>
          Ask a question
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside>
          <LoadState loading={cats.loading} error={cats.error}>
            <CategoryList title="Categories" items={fixedCats} active={category} />
            <details className="mt-4" open={!!current && courseCats.some((c) => c.id === current.id)}>
              <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">By course ({courseCats.length})</summary>
              <CategoryList items={courseCats} active={category} />
            </details>
          </LoadState>
        </aside>
        <section className="min-w-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = (new FormData(e.currentTarget).get('q') as string).trim();
              setParams(Object.fromEntries([...(v ? [['q', v]] : []), ...(unsolved ? [['unsolved', '1']] : [])]));
            }}
            className="flex flex-wrap gap-2 items-center"
          >
            <input name="q" type="search" defaultValue={q} placeholder="Search questions" className="input max-w-sm" aria-label="Search questions" />
            <button type="submit" className={BTN_SOFT}>
              Search
            </button>
            <label className="text-sm inline-flex items-center gap-1.5 ml-auto">
              <input type="checkbox" checked={unsolved} onChange={(e) => setParams(Object.fromEntries([...(q ? [['q', q]] : []), ...(e.target.checked ? [['unsolved', '1']] : [])]))} className="accent-[var(--color-high)]" />
              Unanswered only
            </label>
          </form>
          <div className="mt-4">
            <LoadState loading={threads.loading} error={threads.error}>
              <ThreadList threads={threads.data ?? []} showCategory={!category} categories={cats.data ?? []} />
            </LoadState>
          </div>
        </section>
      </div>
    </div>
  );
}

function CategoryList({ title, items, active }: { title?: string; items: Category[]; active?: string }) {
  return (
    <div>
      {title && <h2 className="text-sm font-medium text-ink-soft">{title}</h2>}
      <ul className="mt-1.5 space-y-0.5">
        <li>
          {!title ? null : (
            <Link to="/forum" className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-bench ${!active ? 'bg-bench font-medium' : ''}`}>
              All questions
            </Link>
          )}
        </li>
        {items.map((c) => (
          <li key={c.id}>
            <Link to={`/forum/c/${c.id}`} className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-bench ${active === c.id ? 'bg-bench font-medium' : ''}`}>
              <span className="truncate">{c.name}</span>
              <span className="font-mono text-xs text-ink-faint">{c.threads}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ThreadList({ threads, showCategory, categories = [], compact }: { threads: ThreadSummary[]; showCategory?: boolean; categories?: Category[]; compact?: boolean }) {
  if (threads.length === 0) return <Empty>No questions here yet. Be the first to ask.</Empty>;
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  return (
    <ul className={`divide-y divide-line rounded-lg border border-line bg-surface ${compact ? 'text-sm' : ''}`}>
      {threads.map((t) => (
        <li key={t.id} className={`flex gap-3 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
          <div className={`shrink-0 text-center ${compact ? 'w-8' : 'w-12'}`}>
            <div className={`font-mono ${t.solved ? 'text-high' : 'text-ink-soft'} ${compact ? 'text-sm' : 'text-lg'}`}>{t.replies}</div>
            <div className="text-[10px] text-ink-faint">{t.solved ? 'solved' : t.replies === 1 ? 'reply' : 'replies'}</div>
          </div>
          <div className="min-w-0 flex-1">
            <Link to={`/forum/threads/${t.id}`} className="font-medium leading-snug hover:text-high block">
              {t.pinned && <span className="text-gold-deep mr-1">Pinned ·</span>}
              {t.title}
            </Link>
            <p className={`mt-0.5 text-ink-faint flex flex-wrap gap-x-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
              {showCategory && <Link to={`/forum/c/${t.categoryId}`} className="hover:text-ink">{catName(t.categoryId)}</Link>}
              <Anchor t={t} />
              {t.tags.map((tag) => (
                <span key={tag} className="rounded bg-bench px-1">
                  {tag}
                </span>
              ))}
              <span>
                {t.author?.displayName ?? 'Someone'} · {timeAgo(t.updatedAt)}
              </span>
              {t.locked && <span>locked</span>}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Anchor({ t }: { t: ThreadSummary }) {
  if (t.labId) {
    const lab = labById(t.labId);
    return lab ? (
      <Link to={`/labs/${lab.id}`} className="hover:text-ink">
        Lab: {lab.title}
      </Link>
    ) : null;
  }
  if (t.courseSlug && t.unitIndex && t.topicIndex) {
    const course = courseBySlug(t.courseSlug);
    const unit = course ? unitOf(course, t.unitIndex) : undefined;
    return unit ? (
      <Link to={`/courses/${t.courseSlug}/units/${t.unitIndex}`} className="hover:text-ink">
        {unit.topics[t.topicIndex - 1] ?? `Unit ${t.unitIndex}`}
      </Link>
    ) : null;
  }
  if (t.courseSlug && t.unitIndex) {
    return (
      <Link to={`/courses/${t.courseSlug}/units/${t.unitIndex}`} className="hover:text-ink">
        Unit {t.unitIndex}
      </Link>
    );
  }
  return null;
}

const FIXED_CATEGORIES: Record<string, string> = { general: 'General', help: 'Help', careers: 'Careers', lecturers: 'Lecturers' };

function categoryLabel(id: string): string {
  return FIXED_CATEGORIES[id] ?? courseBySlug(id)?.title ?? id;
}

/* ----------------------------------------------------------------------------- new thread */

export function NewThreadPage() {
  return (
    <SignedInOnly what="the forum">
      <NewThread />
    </SignedInOnly>
  );
}

function NewThread() {
  const [params] = useSearchParams();
  const labId = params.get('labId') ?? undefined;
  const lab = labId ? labById(labId) : undefined;
  const courseSlug = params.get('course') ?? lab?.course ?? undefined;
  const unitIndex = params.get('unit') ? Number(params.get('unit')) : lab?.unit;
  const topicIndex = params.get('topic') ? Number(params.get('topic')) : lab?.topicIndex;
  const course = courseSlug ? courseBySlug(courseSlug) : undefined;
  const unit = course && unitIndex ? unitOf(course, unitIndex) : undefined;
  const cats = useLoad(() => forum.categories(), []);
  const [categoryId, setCategoryId] = useState(params.get('category') ?? courseSlug ?? 'help');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState<ThreadSummary[]>([]);
  const navigate = useNavigate();

  // "Similar threads" prompt before posting.
  useEffect(() => {
    const words = title.trim();
    if (words.length < 8) {
      setSimilar([]);
      return;
    }
    const t = setTimeout(() => void forum.threads({ q: words.split(/\s+/).slice(0, 4).join(' '), limit: 5 }).then(setSimilar).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [title]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await forum.ask({
        categoryId,
        title: title.trim(),
        body: body.trim(),
        tags: tags.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 5),
        courseSlug,
        unitIndex: unitIndex || undefined,
        topicIndex: topicIndex || undefined,
        labId,
      });
      track('asked', { type: 'forum-thread', id: t.id, course: courseSlug, unit: unitIndex || undefined, topic: topicIndex || undefined, labId }, { length: body.length, tags: t.tags.length }, { category: categoryId });
      navigate(`/forum/threads/${t.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Breadcrumb items={[{ to: '/forum', label: 'Forum' }, { label: 'Ask a question' }]} />
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Ask a question</h1>
      {(lab || unit) && (
        <p className="mt-1 text-sm text-ink-soft">
          Attached to {lab ? <>the lab <span className="font-medium text-ink">{lab.title}</span></> : <>{unit?.topics[(topicIndex ?? 1) - 1] ?? unit?.title}</>}
          {course && <> in {course.title}</>}, so it will show up beside it.
        </p>
      )}
      <form onSubmit={submit} className={`mt-5 ${CARD} space-y-4`}>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Your question in one line" hint="Be specific: what you tried, what happened.">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={5} maxLength={200} className="input" placeholder="e.g. Why does my half adder carry light stay off?" />
        </Field>
        {similar.length > 0 && (
          <div className="rounded-md border border-gold/40 bg-gold-soft p-3 text-sm">
            <p className="font-medium">These look similar. Has one of them answered it already?</p>
            <ul className="mt-1.5 space-y-1">
              {similar.map((s) => (
                <li key={s.id}>
                  <Link to={`/forum/threads/${s.id}`} className="underline underline-offset-2 hover:text-high">
                    {s.title}
                  </Link>{' '}
                  <span className="text-ink-faint">{s.solved ? '· solved' : `· ${s.replies} replies`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Details" hint="Mention someone with @username to bring them in.">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={20000} className="input" />
        </Field>
        <Field label="Tags" hint="Optional, comma separated, up to five.">
          <input value={tags} onChange={(e) => setTags(e.target.value)} className="input" placeholder="gates, truth-table" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={BTN}>
            Post question
          </button>
          <Link to="/forum" className={BTN_SOFT}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------------------- thread */

export function ThreadPage() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly what="the forum">
      <ThreadDetail key={id} id={id} />
    </SignedInOnly>
  );
}

function ThreadDetail({ id }: { id: string }) {
  const load = useLoad(() => forum.thread(id), [id]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = useAuth((s) => s.user?.id);
  const view = load.data;

  useEffect(() => {
    if (view) track('viewed', { type: 'forum-thread', id, course: view.thread.courseSlug ?? undefined, labId: view.thread.labId ?? undefined }, { replies: view.thread.replies, solved: view.thread.solved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.thread.id]);

  useEffect(() => {
    if (view && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [view]);

  const patch = (fn: (v: ThreadView) => ThreadView) => load.setData((v) => (v ? fn(v) : v));
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !view) return;
    setDraft('');
    await act(async () => {
      const p = await forum.reply(id, body, replyTo?.id ?? null);
      track('replied', { type: 'forum-thread', id, course: view.thread.courseSlug ?? undefined, labId: view.thread.labId ?? undefined }, { length: body.length, nested: !!replyTo });
      patch((v) => ({ ...v, posts: [...v.posts, p], thread: { ...v.thread, replies: v.thread.replies + 1 } }));
      setReplyTo(null);
    });
  };

  const vote = (p: Post, value: 1 | -1) =>
    act(async () => {
      const next = p.myVote === value ? 0 : value;
      const r = await forum.vote(p.id, next);
      track('voted', { type: 'forum-thread', id }, { value: next });
      patch((v) => ({ ...v, posts: v.posts.map((x) => (x.id === p.id ? { ...x, votes: r.votes, myVote: r.myVote } : x)) }));
    });

  const accept = (p: Post) =>
    act(async () => {
      const next = p.accepted ? null : p.id;
      await forum.accept(id, next);
      patch((v) => ({ ...v, thread: { ...v.thread, acceptedPostId: next, solved: !!next }, posts: v.posts.map((x) => ({ ...x, accepted: x.id === next })) }));
    });

  const endorse = (p: Post) =>
    act(async () => {
      const r = await forum.endorse(p.id, !p.endorsed);
      patch((v) => ({ ...v, posts: v.posts.map((x) => (x.id === p.id ? { ...x, endorsed: r.endorsed } : x)) }));
    });

  const removePost = (p: Post) =>
    act(async () => {
      if (!window.confirm('Remove this reply?')) return;
      await forum.deletePost(p.id);
      patch((v) => ({ ...v, posts: v.posts.map((x) => (x.id === p.id ? { ...x, body: '', deletedAt: new Date().toISOString(), accepted: false } : x)) }));
    });

  const toggleLock = () =>
    act(async () => {
      if (!view) return;
      await forum.editThread(id, { locked: !view.thread.locked });
      patch((v) => ({ ...v, thread: { ...v.thread, locked: !v.thread.locked }, can: { ...v.can, reply: v.thread.locked } }));
    });

  const lab = view?.thread.labId ? labById(view.thread.labId) : undefined;
  const accepted = view?.posts.find((p) => p.accepted);
  const others = view?.posts.filter((p) => !p.accepted) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <LoadState loading={load.loading} error={load.error}>
        {view && (
          <>
            <Breadcrumb items={[{ to: '/forum', label: 'Forum' }, { to: `/forum/c/${view.thread.categoryId}`, label: categoryLabel(view.thread.categoryId) }, { label: 'Question' }]} />
            <article className={`mt-2 ${CARD}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h1 className="text-2xl font-semibold tracking-tight leading-tight">{view.thread.title}</h1>
                <div className="flex gap-2 text-xs">
                  {view.thread.solved && <span className="rounded-full bg-high-soft text-high border border-high/30 px-2 py-0.5 font-medium">Solved</span>}
                  {view.thread.locked && <span className="rounded-full bg-bench text-ink-soft border border-line px-2 py-0.5 font-medium">Locked</span>}
                </div>
              </div>
              <p className="mt-2 text-sm text-ink-soft flex flex-wrap items-center gap-x-3 gap-y-1">
                <PersonChip person={view.thread.author} size={20} />
                <span title={formatWhen(view.thread.createdAt)}>asked {timeAgo(view.thread.createdAt)}</span>
                <span>{view.thread.views} views</span>
                <Anchor t={view.thread} />
                {view.thread.tags.map((tag) => (
                  <span key={tag} className="rounded bg-bench px-1.5 text-xs">
                    {tag}
                  </span>
                ))}
              </p>
              {view.thread.body && <p className="mt-4 leading-relaxed whitespace-pre-wrap break-words">{view.thread.body}</p>}
              {lab && (
                <p className="mt-4 text-sm">
                  <Link to={`/labs/${lab.id}`} className="rounded-md border border-line bg-bench px-3 py-1.5 hover:border-ink-faint inline-block">
                    Open the lab: {lab.title}
                  </Link>
                </p>
              )}
              {view.can.moderate && (
                <div className="mt-3">
                  <button type="button" onClick={toggleLock} className={BTN_SMALL}>
                    {view.thread.locked ? 'Unlock thread' : 'Lock thread'}
                  </button>
                </div>
              )}
            </article>

            {error && (
              <div className="mt-4">
                <Notice tone="error">{error}</Notice>
              </div>
            )}

            <section className="mt-6">
              <h2 className="text-lg font-semibold">
                {view.thread.replies} {view.thread.replies === 1 ? 'reply' : 'replies'}
              </h2>
              <ul className="mt-3 space-y-3">
                {accepted && <PostCard key={accepted.id} post={accepted} view={view} me={me} onVote={vote} onAccept={accept} onEndorse={endorse} onRemove={removePost} onReply={setReplyTo} />}
                {others.map((p) => (
                  <PostCard key={p.id} post={p} view={view} me={me} onVote={vote} onAccept={accept} onEndorse={endorse} onRemove={removePost} onReply={setReplyTo} />
                ))}
              </ul>
            </section>

            <section className="mt-6">
              {view.can.reply ? (
                <div className={CARD}>
                  <h2 className="font-medium">
                    {replyTo ? (
                      <>
                        Replying to {replyTo.author?.displayName ?? 'a reply'}{' '}
                        <button type="button" onClick={() => setReplyTo(null)} className="text-sm text-ink-soft underline underline-offset-2 ml-2">
                          Reply to the question instead
                        </button>
                      </>
                    ) : (
                      'Your answer'
                    )}
                  </h2>
                  <div className="mt-3">
                    <Composer value={draft} onChange={setDraft} onSubmit={send} placeholder="Write a clear answer. Mention @username to notify someone." rows={4} maxLength={20000} label="Post reply" />
                  </div>
                </div>
              ) : (
                <Empty>This thread is locked, so no more replies can be added.</Empty>
              )}
            </section>
          </>
        )}
      </LoadState>
    </div>
  );
}

function PostCard({
  post,
  view,
  me,
  onVote,
  onAccept,
  onEndorse,
  onRemove,
  onReply,
}: {
  post: Post;
  view: ThreadView;
  me: string | undefined;
  onVote: (p: Post, v: 1 | -1) => void;
  onAccept: (p: Post) => void;
  onEndorse: (p: Post) => void;
  onRemove: (p: Post) => void;
  onReply: (p: Post) => void;
}) {
  const parent = post.parentId ? view.posts.find((x) => x.id === post.parentId) : undefined;
  const mine = post.author?.id === me;
  return (
    <li id={`post-${post.id}`} className={`rounded-lg border p-4 flex gap-3 ${post.accepted ? 'border-high bg-high-soft' : post.endorsed ? 'border-gold/50 bg-gold-soft' : 'border-line bg-surface'}`}>
      <div className="flex flex-col items-center gap-0.5 shrink-0 w-10">
        <button type="button" onClick={() => onVote(post, 1)} disabled={!!post.deletedAt} className={`text-lg leading-none ${post.myVote === 1 ? 'text-high' : 'text-ink-faint hover:text-ink'}`} aria-label="Helpful">
          ▲
        </button>
        <span className="font-mono text-sm">{post.votes}</span>
        <button type="button" onClick={() => onVote(post, -1)} disabled={!!post.deletedAt} className={`text-lg leading-none ${post.myVote === -1 ? 'text-fault' : 'text-ink-faint hover:text-ink'}`} aria-label="Not helpful">
          ▼
        </button>
        {post.accepted && <span className="mt-1 text-high text-lg" title="Accepted answer">✓</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <PersonChip person={post.author} size={22} />
          <span className="text-ink-faint" title={formatWhen(post.createdAt)}>
            {timeAgo(post.createdAt)}
            {post.editedAt && ' · edited'}
          </span>
          {post.accepted && <span className="text-high font-medium text-xs">Accepted answer</span>}
          {post.endorsed && <span className="text-gold-deep font-medium text-xs">Endorsed by a facilitator</span>}
        </div>
        {parent && <p className="mt-1 text-xs text-ink-faint">Replying to {parent.author?.displayName ?? 'a reply'}</p>}
        <p className={`mt-2 leading-relaxed whitespace-pre-wrap break-words ${post.deletedAt ? 'italic text-ink-faint' : ''}`}>{post.deletedAt ? 'Reply removed' : post.body}</p>
        {!post.deletedAt && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {view.can.reply && (
              <button type="button" onClick={() => onReply(post)} className={BTN_SMALL}>
                Reply
              </button>
            )}
            {view.can.accept && (
              <button type="button" onClick={() => onAccept(post)} className={BTN_SMALL}>
                {post.accepted ? 'Unmark as answer' : 'Mark as the answer'}
              </button>
            )}
            {view.can.endorse && (
              <button type="button" onClick={() => onEndorse(post)} className={BTN_SMALL}>
                {post.endorsed ? 'Remove endorsement' : 'Endorse'}
              </button>
            )}
            {(mine || view.can.moderate) && (
              <button type="button" onClick={() => onRemove(post)} className={`${BTN_SMALL} text-fault`}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Beside a lab or topic: the questions attached to it, and a way to ask. */
export function QuestionsAbout({ labId, course, unit, topic, title }: { labId?: string; course?: string; unit?: number; topic?: number; title: string }) {
  const status = useAuth((s) => s.status);
  const load = useLoad(() => (status === 'signed-in' ? forum.threads(labId ? { labId, limit: 5 } : { course, unit, topic, limit: 5 }) : Promise.resolve([] as ThreadSummary[])), [status, labId, course, unit, topic]);
  const askLink = labId ? `/forum/new?labId=${encodeURIComponent(labId)}` : `/forum/new?course=${course}&unit=${unit}&topic=${topic}`;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {status === 'signed-in' && (
          <Link to={askLink} className="text-sm text-high hover:underline underline-offset-2">
            Ask
          </Link>
        )}
      </div>
      {status !== 'signed-in' ? (
        <p className="mt-1 text-sm text-ink-soft">
          <Link to="/sign-in" className="underline underline-offset-2 hover:text-ink">
            Sign in
          </Link>{' '}
          to see questions other learners asked here, or ask your own.
        </p>
      ) : (
        <div className="mt-2">
          <LoadState loading={load.loading} error={load.error}>
            {load.data && load.data.length === 0 ? (
              <p className="text-sm text-ink-soft">Nobody has asked about this yet. Stuck? Ask and others who did this lab will see it.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {load.data?.map((t) => (
                  <li key={t.id} className="flex gap-2">
                    <span className={`font-mono text-xs mt-0.5 ${t.solved ? 'text-high' : 'text-ink-faint'}`}>{t.solved ? '✓' : t.replies}</span>
                    <Link to={`/forum/threads/${t.id}`} className="hover:text-high leading-snug">
                      {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </LoadState>
        </div>
      )}
    </div>
  );
}

