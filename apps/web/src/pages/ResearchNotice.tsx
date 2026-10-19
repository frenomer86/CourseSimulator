import { Link } from 'react-router-dom';
import { Markdown } from '../components/Markdown';
import { NOTICE_MARKDOWN, NOTICE_VERSION } from '../lib/consent';

export function ResearchNoticePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav className="text-sm text-ink-soft">
        <Link to="/profile" className="hover:text-ink">
          Your profile
        </Link>
        <span className="mx-2">/</span>
        <span>Your data</span>
      </nav>
      <div className="mt-4 rounded-lg border border-line bg-surface p-5">
        <Markdown source={NOTICE_MARKDOWN} className="text-[15px]" />
      </div>
      <p className="mt-4 text-xs text-ink-faint">Notice version {NOTICE_VERSION}. The research design behind it is published with the source code.</p>
    </div>
  );
}
