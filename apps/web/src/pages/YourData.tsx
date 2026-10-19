import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { API_BASE, ApiError, getToken } from '../lib/api';
import { deleteMyData, getMyData, type MyData } from '../lib/research';
import { Notice } from '../components/Form';

const VERB_WORDS: Record<string, string> = {
  launched: 'opened',
  terminated: 'closed',
  viewed: 'viewed',
  attempted: 'started',
  answered: 'answered',
  passed: 'passed',
  failed: 'did not pass',
  'asked-for-hint': 'asked for a hint on',
  submitted: 'checked',
  saved: 'saved work on',
  interacted: 'reset',
  consented: 'gave research consent',
  withdrew: 'withdrew research consent',
};

const OBJECT_WORDS: Record<string, string> = {
  app: 'the app',
  course: 'a course',
  unit: 'a unit',
  topic: 'a topic',
  check: 'a topic check',
  'check-item': 'a check question',
  lab: 'a lab',
  'lab-artefact': 'a lab',
  consent: '',
};

export function YourDataPage() {
  const status = useAuth((s) => s.status);
  const [data, setData] = useState<MyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setData(await getMyData());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your data just now.');
    }
  };

  useEffect(() => {
    if (status === 'signed-in') void load();
  }, [status]);

  const download = async (format: 'json' | 'csv') => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/me/data/export?format=${format}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-learning-data-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download just now.');
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete every recorded learning event and saved lab snapshot from your account? Your progress and results stay. This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      const out = await deleteMyData();
      setMessage(`Deleted ${out.eventsDeleted} event${out.eventsDeleted === 1 ? '' : 's'} and ${out.snapshotsDeleted} snapshot${out.snapshotsDeleted === 1 ? '' : 's'}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete just now.');
    } finally {
      setBusy(false);
    }
  };

  if (status !== 'signed-in') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Your data</h1>
        <p className="mt-2 text-ink-soft leading-relaxed">
          Without an account, nothing about your learning is sent anywhere. Your progress lives in this browser only, and you can
          export it from your profile page.
        </p>
        <Link to="/profile" className="mt-5 inline-block rounded-md bg-high px-4 py-2 text-white font-medium">
          Go to your profile
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav className="text-sm text-ink-soft">
        <Link to="/profile" className="hover:text-ink">
          Your profile
        </Link>
        <span className="mx-2">/</span>
        <span>Your data</span>
      </nav>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">What has been recorded about your learning</h1>
      <p className="mt-2 text-ink-soft leading-relaxed max-w-[65ch]">
        Learning events are kept under a research code, not your name. They power your own history and, only if you chose it,
        research into how students learn computing. Download them, or delete them, any time.
      </p>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && (
        <div className="mt-4">
          <Notice tone="info">{message}</Notice>
        </div>
      )}

      {data && (
        <>
          <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Events recorded" value={data.events.total} />
            <Stat label="In the research stream" value={data.events.inResearchStream} />
            <Stat label="Lab snapshots" value={data.snapshots.total} />
            <Stat label="Snapshots for research" value={data.snapshots.inResearchStream} />
          </dl>

          <section className="mt-6 rounded-lg border border-line bg-surface p-5">
            <h2 className="font-medium text-lg">Research participation</h2>
            {data.consent && !data.consent.withdrawnAt ? (
              <p className="mt-1 text-sm text-ink-soft">
                You agreed to research use on {new Date(data.consent.consentedAt).toLocaleDateString()} (notice version {data.consent.noticeVersion}).
                Purposes: {describePurposes(data.consent)}.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-soft">
                Your events are not in the research stream. {data.consent?.withdrawnAt ? 'You withdrew consent.' : 'You have not opted in.'}
              </p>
            )}
            <p className="mt-2 text-sm">
              <Link to="/profile" className="text-high underline underline-offset-2">
                Change your research choices
              </Link>{' '}
              <span className="text-ink-faint">·</span>{' '}
              <Link to="/research-data" className="text-high underline underline-offset-2">
                Read the notice
              </Link>
            </p>
          </section>

          <section className="mt-6 rounded-lg border border-line bg-surface p-5">
            <h2 className="font-medium text-lg">Who can see it</h2>
            <ul className="mt-2 text-sm text-ink-soft list-disc pl-5 space-y-1 leading-relaxed">
              <li>You, on this page and in the downloads below.</li>
              <li>The project team, to run the service and fix problems.</li>
              <li>
                Approved researchers, only the de-identified events of learners who opted in, after a written request and a signed data use
                agreement. There are no lecturer class views yet; when they arrive, they show class patterns, not individual histories, and
                this page will say so.
              </li>
            </ul>
          </section>

          <section className="mt-6 rounded-lg border border-line bg-surface p-5">
            <h2 className="font-medium text-lg">Recent events</h2>
            {data.recent.length === 0 ? (
              <p className="mt-1 text-sm text-ink-soft">Nothing recorded yet. Open a course or a lab while signed in and events appear here.</p>
            ) : (
              <ol className="mt-2 divide-y divide-line text-sm">
                {data.recent.map((e) => (
                  <li key={e.id} className="py-2 flex flex-wrap items-baseline gap-x-3">
                    <span className="font-mono text-xs text-ink-faint w-[11ch] shrink-0">{new Date(e.occurredAt).toLocaleString()}</span>
                    <span>
                      You {VERB_WORDS[e.verb] ?? e.verb} {OBJECT_WORDS[e.objectType] ?? e.objectType}
                      {e.labId ? <span className="text-ink-soft"> ({e.labId})</span> : e.course ? <span className="text-ink-soft"> ({e.course}{e.unit ? `, unit ${e.unit}` : ''})</span> : null}
                    </span>
                    {e.inResearchStream && <span className="text-xs text-high">research</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="mt-6 rounded-lg border border-line bg-surface p-5">
            <h2 className="font-medium text-lg">Download or delete</h2>
            <p className="mt-1 text-sm text-ink-soft">The JSON file holds every event and snapshot; the CSV holds the events as a table.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void download('json')} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
                Download as JSON
              </button>
              <button type="button" onClick={() => void download('csv')} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
                Download as CSV
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy || data.events.total + data.snapshots.total === 0}
                className="ml-auto rounded-md border border-fault/50 text-fault px-4 py-2 font-medium hover:bg-fault-soft disabled:opacity-60"
              >
                Delete recorded events
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function describePurposes(c: NonNullable<MyData['consent']>): string {
  const parts: string[] = [];
  if (c.researchEvents) parts.push('learning events');
  if (c.researchSnapshots) parts.push('lab work snapshots');
  if (c.researchSocial) parts.push('forum and group activity counts');
  if (c.contactFollowup) parts.push('being contacted for follow-up studies');
  return parts.length ? parts.join(', ') : 'none';
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface border border-line p-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-xl font-semibold font-mono">{value}</dd>
    </div>
  );
}
