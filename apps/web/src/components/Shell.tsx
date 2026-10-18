import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOnline } from '../lib/useOnline';

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
            <span
              className="inline-flex items-center gap-1.5"
              title={online ? 'Connected. Labs also work offline once loaded.' : 'Offline. Loaded labs still work.'}
            >
              <span
                className={`inline-block size-2 rounded-full ${online ? 'bg-high-bright' : 'bg-gold'}`}
                aria-hidden
              />
              {online ? 'Online' : 'Offline'}
            </span>
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
