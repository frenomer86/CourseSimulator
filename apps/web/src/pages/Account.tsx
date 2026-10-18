import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useProgress } from '../store/progress';
import { signOutAndClear, useSyncStatus } from '../lib/sync';
import { COUNTRIES } from '../lib/countries';
import type { AgeBand } from '../lib/database.types';
import { AccountsDisabled, Field, FormError } from '../components/AuthBits';
import { Avatar } from '../components/Avatar';

const AGE_BANDS: Array<{ value: AgeBand; label: string }> = [
  { value: 'undisclosed', label: 'Prefer not to say' },
  { value: 'under_18', label: 'Under 18' },
  { value: '18_plus', label: '18 or over' },
];

export function AccountPage() {
  const status = useAuth((s) => s.status);
  if (status === 'disabled') return <AccountsDisabled />;
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-ink-soft" aria-busy>
        Checking who you are…
      </div>
    );
  }
  if (status === 'guest') return <Navigate to="/account/sign-in" replace state={{ from: '/account' }} />;
  return <Profile />;
}

function Profile() {
  const user = useAuth((s) => s.user);
  const profile = useAuth((s) => s.profile);
  const profileError = useAuth((s) => s.profileError);
  const refreshProfile = useAuth((s) => s.refreshProfile);
  const updateProfile = useAuth((s) => s.updateProfile);
  const sync = useSyncStatus();
  const labsPassed = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);
  const proficient = useProgress((s) => Object.values(s.topics).filter((t) => t.mastery === 'proficient' || t.mastery === 'mastered').length);
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [country, setCountry] = useState('');
  const [ageBand, setAgeBand] = useState<AgeBand>('undisclosed');
  const [showOnBoards, setShowOnBoards] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name);
    setUsername(profile.username);
    setAvatarUrl(profile.avatar_url ?? '');
    setCountry(profile.country ?? '');
    setAgeBand(profile.age_band);
    setShowOnBoards(profile.show_on_boards);
  }, [profile]);

  useEffect(() => {
    if (!profile && !profileError) void refreshProfile();
  }, [profile, profileError, refreshProfile]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const uname = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(uname)) {
      setBusy(false);
      setError('Usernames are 3 to 24 characters: lowercase letters, digits and underscores.');
      return;
    }
    const res = await updateProfile({
      display_name: displayName.trim() || uname,
      username: uname,
      avatar_url: avatarUrl.trim() || null,
      country: country || null,
      age_band: ageBand,
      show_on_boards: showOnBoards,
    });
    setBusy(false);
    if (res.error) setError(res.error);
    else setSaved(true);
  };

  const signOut = async () => {
    setSigningOut(true);
    const res = await signOutAndClear((pending) =>
      window.confirm(
        `${pending} change${pending === 1 ? '' : 's'} could not be saved to your account yet (you may be offline). Sign out anyway and lose ${pending === 1 ? 'it' : 'them'}?`,
      ),
    );
    setSigningOut(false);
    if (res.error) setError(res.error);
    else if (useAuth.getState().status !== 'signed-in') navigate('/', { replace: true });
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={displayName || profile?.display_name || user?.email || '?'} url={avatarUrl || null} size={64} />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight truncate">{profile?.display_name ?? 'Your account'}</h1>
          <p className="text-sm text-ink-soft truncate">
            {profile && <span className="font-mono">@{profile.username}</span>}
            {profile && user?.email && ' · '}
            {user?.email}
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Level" value={profile?.level ?? 1} />
        <Stat label="XP" value={profile?.xp ?? 0} />
        <Stat label="Labs passed" value={labsPassed} />
        <Stat label="Topics proficient" value={proficient} />
      </dl>

      <section className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">
        <h2 className="font-medium">Saving your progress</h2>
        <p className="mt-1 text-ink-soft">
          {sync.phase === 'syncing' && 'Saving to your account…'}
          {sync.phase === 'idle' && sync.pending === 0 && 'Everything is saved to your account. Signing in on another device brings it all back.'}
          {sync.phase === 'idle' && sync.pending > 0 && `${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting to save.`}
          {sync.phase === 'waiting' && `You are offline. ${sync.pending} change${sync.pending === 1 ? '' : 's'} will save when you reconnect.`}
          {sync.phase === 'error' && `Could not save just now (${sync.lastError}). We keep retrying.`}
        </p>
      </section>

      <form onSubmit={save} className="mt-6 rounded-lg border border-line bg-surface p-5 space-y-4">
        <h2 className="font-medium text-lg">Your profile</h2>
        {profileError && <FormError message={profileError} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" hint="Shown on boards and in groups.">
            <input type="text" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
          </Field>
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
        </div>
        <Field label="Avatar picture link" hint="Optional. A link to an image; leave empty to use your initials.">
          <input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
            className="input"
            inputMode="url"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" hint="Optional.">
            <select value={country} onChange={(e) => setCountry(e.target.value)} className="input">
              <option value="">Prefer not to say</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Age" hint="Under-18 accounts get extra protection in groups and messages.">
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
          <input
            type="checkbox"
            checked={showOnBoards}
            onChange={(e) => setShowOnBoards(e.target.checked)}
            className="mt-0.5 accent-[var(--color-high)]"
          />
          <span>
            <span className="font-medium">Show me on public leaderboards.</span>{' '}
            <span className="text-ink-soft">Only your display name, avatar and XP appear. Untick to stay off every board.</span>
          </span>
        </label>
        <FormError message={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy || !profile} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          {saved && <span className="text-sm text-high">Saved.</span>}
        </div>
      </form>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-lg">Sign out</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Signing out clears progress from this device, which keeps it private on a shared computer. It stays safe in your account.
        </p>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="mt-3 rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench disabled:opacity-60"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface border border-line p-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-xl font-semibold font-mono">{value}</dd>
    </div>
  );
}
