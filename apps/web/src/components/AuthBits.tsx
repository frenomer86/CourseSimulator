import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useProgress } from '../store/progress';

export function AuthCard({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {lead && <p className="mt-1.5 text-ink-soft">{lead}</p>}
      <div className="mt-6 rounded-lg border border-line bg-surface p-5">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="block text-xs text-ink-soft mt-0.5">{hint}</span>}
      <span className="block mt-1.5">{children}</span>
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-fault/40 bg-fault-soft px-3 py-2 text-sm">
      {message}
    </p>
  );
}

/** Shown on every account page when the deployment has no Supabase configuration. */
export function AccountsDisabled() {
  const passed = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);
  const topics = useProgress((s) => Object.values(s.topics).filter((t) => t.mastery !== 'not_started').length);
  return (
    <AuthCard title="Working as a guest" lead="This copy of the app has no account server, so everything stays on this device.">
      <p className="text-[15px] leading-relaxed">
        Labs, topic checks and your progress all work without an account. Your progress is kept in this browser: clearing the
        browser's site data would remove it.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md bg-bench p-3">
          <dt className="text-ink-soft">Labs completed here</dt>
          <dd className="text-xl font-semibold font-mono">{passed}</dd>
        </div>
        <div className="rounded-md bg-bench p-3">
          <dt className="text-ink-soft">Topics started here</dt>
          <dd className="text-xl font-semibold font-mono">{topics}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-ink-soft">
        If you run this app yourself, the README explains how to connect a Supabase project so learners can sign in and keep
        progress across devices.
      </p>
      <Link to="/" className="mt-5 inline-block rounded-md bg-high px-4 py-2 text-white font-medium">
        Back to the courses
      </Link>
    </AuthCard>
  );
}
