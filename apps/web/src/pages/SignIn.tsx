import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { Field, Notice } from '../components/Form';

export function SignInPage() {
  const status = useAuth((s) => s.status);
  const signIn = useAuth((s) => s.signIn);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/profile';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'signed-in') return <Navigate to={from} replace />;
  if (status === 'unavailable') return <Navigate to="/profile" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn(email, password);
    setBusy(false);
    if (res.error) setError(res.error);
    else navigate(from, { replace: true });
  };

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-ink-soft">Your progress follows you to any device once you sign in.</p>
      <form onSubmit={submit} className="mt-6 rounded-lg border border-line bg-surface p-5 space-y-4">
        <Field label="Email">
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
        </Field>
        <Field label="Password">
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-high px-4 py-2.5 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
          {busy ? 'One moment…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-5 text-sm text-ink-soft">
        New here?{' '}
        <Link to="/sign-up" className="text-high font-medium underline underline-offset-2">
          Create an account
        </Link>
        . Or keep going without one: labs work either way, and your progress stays on this device.
      </p>
    </div>
  );
}
