import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOnline } from '../lib/useOnline';
import { accountsEnabled } from '../lib/supabase';
import { useSyncStatus } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Avatar } from './Avatar';

export function Shell({ children }: { children: ReactNode }) {
  const online = useOnline();
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 font-semibold text-ink">
            <img src="/icon.svg" alt="" width={28} height={28} />
            <span>CS Virtual Lab</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-ink-soft">
            <Link to="/#courses" className="hover:text-ink">
              Courses
            </Link>
            <ConnectionBadge online={online} />
            {accountsEnabled && <AccountLink />}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-ink-soft flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>Built for Computer Science students who learn with little hardware. Everything runs in your browser.</span>
          <span>Open source. Labs are data, so lecturers can add their own.</span>
        </div>
      </footer>
    </div>
  );
}

function ConnectionBadge({ online }: { online: boolean }) {
  const sync = useSyncStatus();
  const signedIn = useAuth((s) => s.status === 'signed-in');
  let text = online ? 'Online' : 'Offline';
  let title = online ? 'Connected. Labs also work offline once loaded.' : 'Offline. Loaded labs still work.';
  let colour = online ? 'bg-high-bright' : 'bg-gold';
  if (signedIn && online) {
    if (sync.phase === 'syncing') {
      text = 'Saving…';
      title = 'Saving your progress to your account.';
    } else if (sync.pending > 0) {
      text = `${sync.pending} to save`;
      title = sync.phase === 'error' ? `Could not save yet: ${sync.lastError}` : 'Changes waiting to be saved to your account.';
      colour = 'bg-gold';
    }
  } else if (signedIn && !online && sync.pending > 0) {
    text = `Offline, ${sync.pending} to save`;
    title = 'Your changes are kept here and will save when you reconnect.';
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={`inline-block size-2 rounded-full ${colour}`} aria-hidden />
      {text}
    </span>
  );
}

function AccountLink() {
  const status = useAuth((s) => s.status);
  const profile = useAuth((s) => s.profile);
  const email = useAuth((s) => s.user?.email ?? null);
  if (status === 'loading') return <span className="w-16" aria-hidden />;
  if (status !== 'signed-in') {
    return (
      <Link to="/account/sign-in" className="rounded-md border border-line px-3 py-1.5 font-medium text-ink hover:bg-bench">
        Sign in
      </Link>
    );
  }
  const name = profile?.display_name ?? email ?? 'You';
  return (
    <Link to="/account" className="flex items-center gap-2 text-ink hover:text-high" title="Your account">
      <Avatar name={name} url={profile?.avatar_url ?? null} size={28} />
      <span className="hidden sm:inline max-w-[14ch] truncate">{name}</span>
    </Link>
  );
}
