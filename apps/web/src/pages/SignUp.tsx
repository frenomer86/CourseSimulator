import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useProgress } from '../store/progress';
import { useProfile } from '../store/profile';
import { Field, Notice } from '../components/Form';

export function SignUpPage() {
  const status = useAuth((s) => s.status);
  const signUp = useAuth((s) => s.signUp);
  const navigate = useNavigate();
  const localName = useProfile((s) => s.displayName);
  const localLabs = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);
  const localTopics = useProgress((s) => Object.values(s.topics).filter((t) => t.mastery !== 'not_started').length);

  const [displayName, setDisplayName] = useState(localName);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'signed-in') return <Navigate to="/profile" replace />;
  if (status === 'unavailable') return <Navigate to="/profile" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agree) {
      setError('Please tick the box to agree before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await signUp(email, password, displayName.trim());
    setBusy(false);
    if (res.error) setError(res.error);
    else navigate('/profile', { replace: true });
  };

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="mt-1.5 text-ink-soft">Free. Keeps your progress safe and lets you pick up on another device.</p>
      <form onSubmit={submit} className="mt-6 rounded-lg border border-line bg-surface p-5 space-y-4">
        {(localLabs > 0 || localTopics > 0) && (
          <Notice tone="info">
            What you have already done on this device ({localLabs} lab{localLabs === 1 ? '' : 's'} passed, {localTopics} topic
            {localTopics === 1 ? '' : 's'} started) will be saved to your new account.
          </Notice>
        )}
        <Field label="What should we call you?">
          <input
            type="text"
            autoComplete="nickname"
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name or a nickname"
            className="input"
          />
        </Field>
        <Field label="Email">
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
        </Field>
        <Field label="Password" hint="At least 6 characters.">
          <input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </Field>
        <label className="flex items-start gap-2.5 text-sm leading-snug">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-[var(--color-high)]" />
          <span>
            I agree that CS Virtual Lab stores my email, display name and learning progress on its own server so I can use my account.
            Nothing is sold or shared, and I can delete my account from my profile page.
          </span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-high px-4 py-2.5 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
          {busy ? 'Creating your account…' : 'Create my account'}
        </button>
      </form>
      <p className="mt-5 text-sm text-ink-soft">
        Already have one?{' '}
        <Link to="/sign-in" className="text-high font-medium underline underline-offset-2">
          Sign in
        </Link>
        .
      </p>
    </div>
  );
}
