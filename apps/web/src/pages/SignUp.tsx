import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useProgress } from '../store/progress';
import { AccountsDisabled, AuthCard, Field, FormError } from '../components/AuthBits';

export function SignUpPage() {
  const status = useAuth((s) => s.status);
  const signUp = useAuth((s) => s.signUp);
  const navigate = useNavigate();
  const localLabs = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  if (status === 'disabled') return <AccountsDisabled />;
  if (status === 'signed-in') return <Navigate to="/account" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agree) {
      setError('Please tick the box to agree before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await signUp(email, password, displayName || email.split('@')[0]);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.needsConfirmation) setConfirm(true);
    else navigate('/account', { replace: true });
  };

  return (
    <AuthCard title="Create an account" lead="Free. Keeps your progress safe and lets you pick up on another device.">
      {confirm ? (
        <div className="rounded-md border border-high bg-high-soft p-4">
          <p className="font-medium">One more step: confirm your email.</p>
          <p className="mt-1 text-sm text-ink-soft">
            We sent a confirmation link to <span className="font-mono">{email}</span>. Open it and you are in.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {localLabs > 0 && (
            <p className="rounded-md bg-gold-soft border border-gold/40 px-3 py-2 text-sm">
              You have already completed {localLabs} lab{localLabs === 1 ? '' : 's'} on this device. They will be saved to your new account.
            </p>
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
            <input
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
            />
          </Field>
          <label className="flex items-start gap-2.5 text-sm leading-snug">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-[var(--color-high)]" />
            <span>
              I agree that CS Virtual Lab stores my email, display name and learning progress so I can use my account. Nothing is sold or
              shared. I can export or delete my data from my account page.
            </span>
          </label>
          <FormError message={error} />
          <button type="submit" disabled={busy} className="w-full rounded-md bg-high px-4 py-2.5 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            {busy ? 'Creating your account…' : 'Create my account'}
          </button>
        </form>
      )}
      <p className="mt-5 text-sm text-ink-soft">
        Already have one?{' '}
        <Link to="/account/sign-in" className="text-high font-medium underline underline-offset-2">
          Sign in
        </Link>
        .
      </p>
    </AuthCard>
  );
}
