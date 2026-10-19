import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { describeSnapshot, masteryRank, validateProgressSnapshot, type ProgressSnapshot } from '@cslab/lab-runtime';
import { currentRecords, useProgress } from '../store/progress';
import { useProfile } from '../store/profile';
import { useAuth } from '../store/auth';
import { signOutAndClear, useSyncStatus } from '../lib/sync';
import type { AgeBand } from '../lib/api';
import { Avatar } from '../components/Avatar';
import { Field, Notice } from '../components/Form';
import { ResearchCard } from '../components/ResearchCard';

const AGE_BANDS: Array<{ value: AgeBand; label: string }> = [
  { value: 'undisclosed', label: 'Prefer not to say' },
  { value: 'under_18', label: 'Under 18' },
  { value: '18_plus', label: '18 or over' },
];

type Message = { tone: 'error' | 'ok' | 'info'; text: string } | null;

export function ProfilePage() {
  const profile = useProfile();
  const auth = useAuth();
  const labsPassed = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);
  const topicsProficient = useProgress((s) => Object.values(s.topics).filter((t) => masteryRank(t.mastery) >= 2).length);
  const topicsMastered = useProgress((s) => Object.values(s.topics).filter((t) => t.mastery === 'mastered').length);
  const checksPassed = useProgress((s) => Object.values(s.checks).filter((c) => c.passed).length);
  const importRecords = useProgress((s) => s.importRecords);
  const reset = useProgress((s) => s.reset);

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // When the account's profile arrives (sign-in, sync), reflect it in the form.
  useEffect(() => {
    setDisplayName(profile.displayName);
    setAvatarUrl(profile.avatarUrl);
  }, [profile.displayName, profile.avatarUrl]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    const url = avatarUrl.trim();
    profile.setProfile({ displayName: name, avatarUrl: url });
    if (auth.status === 'signed-in') {
      setSaving(true);
      const res = await auth.updateProfile({ displayName: name || auth.profile?.username || 'Learner', avatarUrl: url || null });
      setSaving(false);
      if (res.error) {
        setMessage({ tone: 'error', text: `Saved on this device, but not to your account: ${res.error}` });
        return;
      }
    }
    setSaved(true);
  };

  const exportProgress = () => {
    const snapshot: ProgressSnapshot = {
      format: 'cslab-progress',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: profile.displayName ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl || undefined } : undefined,
      ...currentRecords(),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cslab-progress-${snapshot.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'ok', text: 'Your progress file is downloading. Keep it somewhere safe, or open it on another device.' });
  };

  const importProgress = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setMessage({ tone: 'error', text: 'That file is not a progress file from this app.' });
      return;
    }
    if (!validateProgressSnapshot(raw)) {
      setMessage({ tone: 'error', text: 'That file is not a progress file from this app, or it is damaged.' });
      return;
    }
    const what = describeSnapshot(raw);
    importRecords(raw);
    useProgress.getState().enqueueAllTopics();
    if (raw.profile && !profile.displayName) profile.setProfile({ displayName: raw.profile.displayName, avatarUrl: raw.profile.avatarUrl ?? '' });
    setMessage({
      tone: 'ok',
      text: `Imported. The file held ${what.labsPassed} passed lab${what.labsPassed === 1 ? '' : 's'}, ${what.checksPassed} passed check${
        what.checksPassed === 1 ? '' : 's'
      } and ${what.topicsProficient} proficient topic${what.topicsProficient === 1 ? '' : 's'}; anything better than what was here has been kept.`,
    });
  };

  const clearAll = () => {
    if (!window.confirm('Remove every lab result, check score and saved circuit from this device? Export first if you want to keep them.')) return;
    reset();
    setMessage({ tone: 'info', text: 'Progress on this device has been cleared.' });
  };

  const name = profile.displayName || 'Learner';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={name} url={profile.avatarUrl || null} size={64} />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight truncate">{name}</h1>
          <p className="text-sm text-ink-soft truncate">
            {auth.status === 'signed-in' && auth.user ? (
              <>
                Signed in as {auth.user.email}
                {auth.profile && (
                  <>
                    {' · '}
                    <span className="font-mono">@{auth.profile.username}</span>
                  </>
                )}
              </>
            ) : (
              'Your progress lives in this browser.'
            )}
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Labs passed" value={labsPassed} />
        <Stat label="Checks passed" value={checksPassed} />
        <Stat label="Topics proficient" value={topicsProficient} />
        {auth.status === 'signed-in' && auth.profile ? (
          <Stat label={`Level ${auth.profile.level}`} value={auth.profile.xp} suffix="XP" />
        ) : (
          <Stat label="Topics mastered" value={topicsMastered} />
        )}
      </dl>

      {message && (
        <div className="mt-6">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}

      <AccountCard onMessage={setMessage} />
      <ResearchCard />

      <form onSubmit={save} className="mt-6 rounded-lg border border-line bg-surface p-5 space-y-4">
        <h2 className="font-medium text-lg">About you</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown at the top of the page and on boards.">
            <input
              type="text"
              maxLength={60}
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              placeholder="Your name or a nickname"
              className="input"
              autoComplete="nickname"
            />
          </Field>
          <Field label="Picture link" hint="Optional. A link to an image; leave empty to use your initials.">
            <input
              type="url"
              value={avatarUrl}
              onChange={(e) => {
                setAvatarUrl(e.target.value);
                setSaved(false);
              }}
              placeholder="https://…"
              className="input"
              inputMode="url"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-high">Saved.</span>}
        </div>
      </form>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-lg">Move your progress by file</h2>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed">
          Export a small file with everything you have done, and import it on another phone or laptop. The best of both is kept.
          Handy when you have no account or no connection.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={exportProgress} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
            Export progress
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
            Import a progress file
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" onChange={importProgress} className="hidden" aria-label="Progress file" />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-lg">Start again on this device</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Clears every result and saved circuit from this browser.{auth.status === 'signed-in' && ' Your account keeps its copy.'}
        </p>
        <button type="button" onClick={clearAll} className="mt-3 rounded-md border border-fault/50 text-fault px-4 py-2 font-medium hover:bg-fault-soft">
          Clear progress on this device
        </button>
      </section>

      <p className="mt-6 text-sm text-ink-soft">
        <Link to="/#courses" className="hover:text-ink underline underline-offset-2">
          Back to the courses
        </Link>
      </p>
    </div>
  );
}

function AccountCard({ onMessage }: { onMessage: (m: Message) => void }) {
  const auth = useAuth();
  const sync = useSyncStatus();
  const navigate = useNavigate();
  const [username, setUsername] = useState(auth.profile?.username ?? '');
  const [ageBand, setAgeBand] = useState<AgeBand>(auth.profile?.ageBand ?? 'undisclosed');
  const [showOnBoards, setShowOnBoards] = useState(auth.profile?.showOnBoards ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  useEffect(() => {
    if (!auth.profile) return;
    setUsername(auth.profile.username);
    setAgeBand(auth.profile.ageBand);
    setShowOnBoards(auth.profile.showOnBoards);
  }, [auth.profile]);

  if (auth.status === 'checking') {
    return (
      <section className="mt-6 rounded-lg border border-line bg-surface p-5 text-sm text-ink-soft" aria-busy>
        Checking your account…
      </section>
    );
  }

  if (auth.status === 'unavailable') {
    return (
      <section className="mt-6 rounded-lg border border-dashed border-line bg-surface p-5">
        <h2 className="font-medium text-lg">No account server here</h2>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed">
          This copy of the app runs without a server, so there is nothing to sign in to. Everything is kept on this device; use the
          export below to move it.
        </p>
      </section>
    );
  }

  if (auth.status === 'guest') {
    return (
      <section className="mt-6 rounded-lg border border-high/40 bg-high-soft p-5">
        <h2 className="font-medium text-lg">Keep your progress safe</h2>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed">
          Create a free account and what you have done here is saved to it. Sign in on any phone or laptop and carry on.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/sign-up" className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
            Create an account
          </Link>
          <Link to="/sign-in" className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  const saveAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await auth.updateProfile({ username: username.trim().toLowerCase(), ageBand, showOnBoards });
    setBusy(false);
    if (res.error) setError(res.error);
    else setSaved(true);
  };

  const signOut = async () => {
    setBusy(true);
    const done = await signOutAndClear((n) =>
      window.confirm(`${n} change${n === 1 ? '' : 's'} could not be saved to your account yet (you may be offline). Sign out anyway and lose ${n === 1 ? 'it' : 'them'}?`),
    );
    setBusy(false);
    if (done) {
      onMessage({ tone: 'info', text: 'Signed out. Progress was cleared from this device; it stays in your account.' });
      navigate('/', { replace: true });
    }
  };

  const deleteAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm('Delete your account and everything saved to it? This cannot be undone.')) return;
    setBusy(true);
    const res = await auth.deleteAccount(deletePassword);
    setBusy(false);
    if (res.error) setError(res.error);
    else onMessage({ tone: 'info', text: 'Your account has been deleted. Progress on this device is still here.' });
  };

  const syncLine =
    sync.phase === 'syncing'
      ? 'Saving to your account…'
      : sync.phase === 'waiting'
        ? `You are offline. ${sync.pending} change${sync.pending === 1 ? '' : 's'} will save when you reconnect.`
        : sync.phase === 'error'
          ? `Could not save just now (${sync.lastError}). We keep retrying.`
          : sync.pending > 0
            ? `${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting to save.`
            : 'Everything is saved to your account. Signing in on another device brings it all back.';

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface p-5">
      <h2 className="font-medium text-lg">Your account</h2>
      <p className="mt-1 text-sm text-ink-soft">{syncLine}</p>
      <form onSubmit={saveAccount} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="Lowercase letters, digits and underscores.">
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input font-mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Age" hint="Under-18 accounts get extra protection in groups and messages later on.">
            <select value={ageBand} onChange={(e) => setAgeBand(e.target.value as AgeBand)} className="input">
              {AGE_BANDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-start gap-2.5 text-sm leading-snug">
          <input type="checkbox" checked={showOnBoards} onChange={(e) => setShowOnBoards(e.target.checked)} className="mt-0.5 accent-[var(--color-high)]" />
          <span>
            <span className="font-medium">Show me on public leaderboards.</span>{' '}
            <span className="text-ink-soft">Only your name, picture and XP appear. Untick to stay off every board.</span>
          </span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            Save account
          </button>
          {saved && <span className="text-sm text-high">Saved.</span>}
          <button type="button" onClick={signOut} disabled={busy} className="ml-auto rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench disabled:opacity-60">
            Sign out
          </button>
        </div>
      </form>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-ink-soft hover:text-ink">Delete my account</summary>
        <form onSubmit={deleteAccount} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Your password">
            <input type="password" required autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} className="input" />
          </Field>
          <button type="submit" disabled={busy} className="rounded-md border border-fault/50 text-fault px-4 py-2 font-medium hover:bg-fault-soft disabled:opacity-60">
            Delete account
          </button>
        </form>
      </details>
    </section>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="rounded-md bg-surface border border-line p-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-xl font-semibold font-mono">
        {value}
        {suffix && <span className="text-sm font-sans text-ink-soft ml-1">{suffix}</span>}
      </dd>
    </div>
  );
}
