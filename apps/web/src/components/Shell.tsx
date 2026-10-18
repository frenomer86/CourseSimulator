import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOnline } from '../lib/useOnline';
import { useSyncStatus } from '../lib/sync';
import { useAuth } from '../store/auth';
import { useProfile } from '../store/profile';
import { Avatar } from './Avatar';

export function Shell({ children }: { children: ReactNode }) {
  const displayName = useProfile((s) => s.displayName);
  const avatarUrl = useProfile((s) => s.avatarUrl);
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
            <ConnectionBadge />
            <Link to="/profile" className="flex items-center gap-2 text-ink hover:text-high" title="Your profile and progress">
              <Avatar name={displayName || 'Learner'} url={avatarUrl || null} size={28} />
              <span className="hidden sm:inline max-w-[14ch] truncate">{displayName || 'Your progress'}</span>
            </Link>
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

function ConnectionBadge() {
  const online = useOnline();
  const sync = useSyncStatus();
  const signedIn = useAuth((s) => s.status === 'signed-in');
  let text = online ? 'Online' : 'Offline';
  let title = online ? 'Connected. Labs also work offline once loaded.' : 'Offline. Loaded labs still work.';
  let colour = online ? 'bg-high-bright' : 'bg-gold';
  if (signedIn && sync.phase === 'syncing') {
    text = 'Saving…';
    title = 'Saving your progress to your account.';
  } else if (signedIn && sync.pending > 0) {
    text = online ? `${sync.pending} to save` : `Offline, ${sync.pending} to save`;
    title = online
      ? sync.phase === 'error'
        ? `Could not save yet: ${sync.lastError}`
        : 'Changes waiting to be saved to your account.'
      : 'Your changes are kept here and will save when you reconnect.';
    colour = 'bg-gold';
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={`inline-block size-2 rounded-full ${colour}`} aria-hidden />
      {text}
    </span>
  );
}
