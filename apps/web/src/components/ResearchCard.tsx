import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { ApiError } from '../lib/api';
import { NOTICE_VERSION } from '../lib/consent';
import { getConsent, setConsent, type Consent } from '../lib/research';
import { track } from '../lib/telemetry';
import { Notice } from './Form';

const PURPOSES: Array<{ key: 'researchEvents' | 'researchSnapshots' | 'researchSocial' | 'contactFollowup'; label: string; detail: string }> = [
  {
    key: 'researchEvents',
    label: 'My learning events',
    detail: 'Which courses, labs and checks I open, how I do, how long I take, hints I use, and the kind of device and connection I had.',
  },
  {
    key: 'researchSnapshots',
    label: 'Snapshots of my lab work',
    detail: 'The circuit, program or query I had built at each check, so researchers can see how solutions develop. Scanned for names before any release.',
  },
  {
    key: 'researchSocial',
    label: 'Counts of my forum and group activity',
    detail: 'How often I post, reply or share, never the text itself. Nothing is collected until those features exist.',
  },
  {
    key: 'contactFollowup',
    label: 'Being contacted for follow-up studies',
    detail: 'An occasional email asking whether I would take part in an interview or survey. Easy to ignore.',
  },
];

/** Research participation choices on the profile page. Off by default; each purpose separate. */
export function ResearchCard() {
  const auth = useAuth();
  const [consent, setCurrent] = useState<Consent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ researchEvents: false, researchSnapshots: false, researchSocial: false, contactFollowup: false, guardianConsent: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const under18 = auth.profile?.ageBand === 'under_18';

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    let cancelled = false;
    getConsent()
      .then((r) => {
        if (cancelled) return;
        setCurrent(r.consent);
        if (r.consent && !r.consent.withdrawnAt) {
          setForm({
            researchEvents: r.consent.researchEvents,
            researchSnapshots: r.consent.researchSnapshots,
            researchSocial: r.consent.researchSocial,
            contactFollowup: r.consent.contactFollowup,
            guardianConsent: r.consent.guardianConsent,
          });
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [auth.status, auth.user?.id]);

  if (auth.status !== 'signed-in') return null;

  const anyOn = form.researchEvents || form.researchSnapshots || form.researchSocial || form.contactFollowup;
  const active = !!consent && !consent.withdrawnAt && (consent.researchEvents || consent.researchSnapshots || consent.researchSocial || consent.contactFollowup);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await setConsent({ noticeVersion: NOTICE_VERSION, ...form });
      setCurrent(r.consent);
      const nowOn = r.consent.researchEvents || r.consent.researchSnapshots || r.consent.researchSocial || r.consent.contactFollowup;
      track(nowOn ? 'consented' : 'withdrew', { type: 'consent', id: `notice-v${NOTICE_VERSION}` }, {
        researchEvents: r.consent.researchEvents,
        researchSnapshots: r.consent.researchSnapshots,
        researchSocial: r.consent.researchSocial,
        contactFollowup: r.consent.contactFollowup,
      });
      setSaved(nowOn ? 'Saved. Thank you for helping computing education research.' : 'Saved. Your activity stays out of the research stream.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your choices just now.');
    } finally {
      setBusy(false);
    }
  };

  const withdrawAll = () => setForm({ researchEvents: false, researchSnapshots: false, researchSocial: false, contactFollowup: false, guardianConsent: false });

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface p-5">
      <h2 className="font-medium text-lg">Research participation</h2>
      <p className="mt-1 text-sm text-ink-soft leading-relaxed">
        Separate from your account, and off unless you choose it. Your choices never affect what you can do here. Records are kept under a
        research code, not your name.{' '}
        <Link to="/research-data" className="text-high underline underline-offset-2">
          Read the notice
        </Link>
        {' · '}
        <Link to="/profile/data" className="text-high underline underline-offset-2">
          See what has been recorded
        </Link>
      </p>
      {!loaded ? (
        <p className="mt-3 text-sm text-ink-soft" aria-busy>
          Loading your choices…
        </p>
      ) : (
        <form onSubmit={save} className="mt-4 space-y-3">
          {active && consent && (
            <p className="text-xs text-ink-soft">
              On since {new Date(consent.consentedAt).toLocaleDateString()}, notice version {consent.noticeVersion}.
            </p>
          )}
          {PURPOSES.map((p) => (
            <label key={p.key} className="flex items-start gap-2.5 text-sm leading-snug">
              <input
                type="checkbox"
                checked={form[p.key]}
                onChange={(e) => setForm({ ...form, [p.key]: e.target.checked })}
                className="mt-0.5 accent-[var(--color-high)]"
              />
              <span>
                <span className="font-medium">{p.label}.</span> <span className="text-ink-soft">{p.detail}</span>
              </span>
            </label>
          ))}
          {under18 && anyOn && (
            <label className="flex items-start gap-2.5 text-sm leading-snug rounded-md border border-gold/40 bg-gold-soft p-3">
              <input
                type="checkbox"
                checked={form.guardianConsent}
                onChange={(e) => setForm({ ...form, guardianConsent: e.target.checked })}
                className="mt-0.5 accent-[var(--color-high)]"
              />
              <span>
                <span className="font-medium">A parent, guardian or my institution has agreed to this.</span>{' '}
                <span className="text-ink-soft">Because you are under 18, research use needs their agreement. Tick only if that is true.</span>
              </span>
            </label>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          {saved && <Notice tone="ok">{saved}</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
              Save my choices
            </button>
            {anyOn && (
              <button type="button" onClick={withdrawAll} className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">
                Untick everything
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
