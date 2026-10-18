import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { AccountsDisabled, AuthCard, Field, FormError } from '../components/AuthBits';

export function SignInPage() {
  const status = useAuth((s) => s.status);
  const signInWithPassword = useAuth((s) => s.signInWithPassword);
  const signInWithMagicLink = useAuth((s) => s.signInWithMagicLink);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/account';

  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);

  if (status === 'disabled') return <AccountsDisabled />;
  if (status === 'signed-in') return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === 'password') {
      const res = await signInWithPassword(email, password);
      setBusy(false);
      if (res.error) setError(res.error);
      else navigate(from, { replace: true });
    } else {
      const res = await signInWithMagicLink(email);
      setBusy(false);
      if (res.error) setError(res.error);
      else setLinkSent(true);
    }
  };

  return (
    <AuthCard title="Sign in" lead="Your progress follows you to any device once you sign in.">
      {linkSent ? (
        <div className="rounded-md border border-high bg-high-soft p-4">
          <p className="font-medium">Check your email.</p>
          <p className="mt-1 text-sm text-ink-soft">
            We sent a sign-in link to <span className="font-mono">{email}</span>. Open it on this device and you will be signed in.
            It can take a minute to arrive.
          </p>
          <button type="button" onClick={() => setLinkSent(false)} className="mt-3 text-sm underline underline-offset-2 text-ink-soft hover:text-ink">
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="flex gap-1 rounded-md bg-bench p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode('password')}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === 'password' ? 'bg-surface shadow-sm' : 'text-ink-soft'}`}
            >
              Email and password
            </button>
            <button
              type="button"
              onClick={() => setMode('link')}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === 'link' ? 'bg-surface shadow-sm' : 'text-ink-soft'}`}
            >
              Email me a link
            </button>
          </div>
          <Field label="Email">
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </Field>
          {mode === 'password' && (
            <Field label="Password">
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
              />
            </Field>
          )}
          {mode === 'link' && (
            <p className="text-sm text-ink-soft">No password needed. We email you a link that signs you in; it also creates an account if you do not have one.</p>
          )}
          <FormError message={error} />
          <button type="submit" disabled={busy} className="w-full rounded-md bg-high px-4 py-2.5 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            {busy ? 'One moment…' : mode === 'password' ? 'Sign in' : 'Send me the link'}
          </button>
        </form>
      )}
      <p className="mt-5 text-sm text-ink-soft">
        New here?{' '}
        <Link to="/account/sign-up" className="text-high font-medium underline underline-offset-2">
          Create an account
        </Link>
        . Or keep going as a guest: labs work without one, and your progress stays on this device.
      </p>
    </AuthCard>
  );
}
