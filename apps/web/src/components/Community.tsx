/** Small building blocks shared by the community pages. */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import type { Person } from '../lib/community';
import { useAuth } from '../store/auth';
import { Avatar } from './Avatar';
import { Notice } from './Form';

export const BTN = 'rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60';
export const BTN_SOFT = 'rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench disabled:opacity-60';
export const BTN_SMALL = 'rounded-md border border-line bg-surface px-2.5 py-1 text-sm hover:bg-bench disabled:opacity-60';
export const BTN_DANGER = 'rounded-md border border-fault/50 text-fault px-4 py-2 font-medium hover:bg-fault-soft disabled:opacity-60';
export const CARD = 'rounded-lg border border-line bg-surface p-5';

export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

/** Loads something once (and again when `deps` change); exposes reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

/** Pages for signed-in learners. Guests see why and where to sign in. */
export function SignedInOnly({ children, what }: { children: ReactNode; what: string }) {
  const status = useAuth((s) => s.status);
  if (status === 'checking') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-ink-soft" aria-busy>
        Checking your account…
      </div>
    );
  }
  if (status === 'unavailable') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-2xl font-semibold">Not available on this copy</h1>
        <p className="mt-2 text-ink-soft">This copy of the app runs without a server, so {what} is switched off. Labs and checks still work.</p>
      </div>
    );
  }
  if (status === 'guest') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-2xl font-semibold">Sign in to use {what}</h1>
        <p className="mt-2 text-ink-soft leading-relaxed">
          Groups, chat, the forum and contests belong to accounts, so other learners know who they are talking to. Creating one is free.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link to="/sign-in" className={BTN}>
            Sign in
          </Link>
          <Link to="/sign-up" className={BTN_SOFT}>
            Create an account
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function PersonChip({ person, size = 24, link = true, suffix, avatar = true }: { person: Person | null; size?: number; link?: boolean; suffix?: ReactNode; avatar?: boolean }) {
  if (!person) return <span className="text-ink-faint">Someone who left</span>;
  const inner = (
    <>
      {avatar && <Avatar name={person.displayName} url={person.avatarUrl} size={size} />}
      <span className="truncate font-medium">{person.displayName}</span>
      {person.platformRole === 'facilitator' || person.platformRole === 'moderator' || person.platformRole === 'admin' ? <RoleBadge role={person.platformRole} /> : null}
      {suffix}
    </>
  );
  return link ? (
    <Link to={`/people/${person.username}`} className="inline-flex items-center gap-1.5 min-w-0 hover:text-high">
      {inner}
    </Link>
  ) : (
    <span className="inline-flex items-center gap-1.5 min-w-0">{inner}</span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const label = role === 'facilitator' ? 'Facilitator' : role === 'moderator' ? 'Moderator' : role === 'admin' ? 'Admin' : role === 'owner' ? 'Owner' : role === 'member' ? 'Member' : role;
  const tone = role === 'owner' || role === 'admin' ? 'bg-gold-soft text-gold-deep border-gold/40' : role === 'facilitator' || role === 'moderator' ? 'bg-high-soft text-high border-high/30' : 'bg-bench text-ink-soft border-line';
  return <span className={`rounded-full border px-1.5 py-px text-[11px] font-medium leading-4 ${tone}`}>{label}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 ${t.id === value ? 'border-high text-high' : 'border-transparent text-ink-soft hover:text-ink'}`}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 font-mono text-xs text-ink-faint">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line bg-surface p-5 text-sm text-ink-soft">{children}</div>;
}

export function LoadState({ loading, error, children }: { loading: boolean; error: string | null; children: ReactNode }) {
  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading) return <p className="text-sm text-ink-soft py-4">Loading…</p>;
  return <>{children}</>;
}

/** Textarea that grows and submits on Ctrl/Cmd+Enter. */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  maxLength = 4000,
  rows = 2,
  label = 'Send',
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  maxLength?: number;
  rows?: number;
  label?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit();
      }}
      className="flex items-end gap-2"
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && value.trim()) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        className="input resize-none"
        aria-label={placeholder}
      />
      <button type="submit" disabled={disabled || !value.trim()} className={BTN}>
        {label}
      </button>
    </form>
  );
}

export function Breadcrumb({ items }: { items: Array<{ to?: string; label: string }> }) {
  return (
    <nav className="text-sm text-ink-soft flex flex-wrap items-center gap-x-2">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-x-2">
          {i > 0 && <span>/</span>}
          {it.to ? (
            <Link to={it.to} className="hover:text-ink">
              {it.label}
            </Link>
          ) : (
            <span>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
