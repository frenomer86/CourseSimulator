/**
 * On a passed lab: share your circuit to the course library, and see what others who also
 * passed it built. The API only serves solution shares to learners who passed the same lab.
 */

import { useState } from 'react';
import type { LabSpec } from '@cslab/lab-runtime';
import { resources, timeAgo, type Resource } from '../lib/community';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';
import { BTN_SMALL, errorText, LoadState, PersonChip, useLoad } from './Community';
import { Notice } from './Form';

export function SolutionShare({ lab, passed, artefact, onOpen }: { lab: LabSpec<unknown>; passed: boolean; artefact: unknown; onOpen?: (payload: unknown) => void }) {
  const signedIn = useAuth((s) => s.status === 'signed-in');
  const me = useAuth((s) => s.user?.id);
  const load = useLoad(() => (signedIn && passed ? resources.solutionsForLab(lab.id) : Promise.resolve([] as Resource[])), [signedIn, passed, lab.id]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!signedIn) return null;
  const mine = load.data?.some((r) => r.owner?.id === me);

  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await resources.share({ kind: 'solution', courseSlug: lab.course, labId: lab.id, title: `${lab.title}: my solution`, body: note.trim() || undefined, payload: artefact });
      track('shared', { type: 'resource', id: r.id, course: lab.course, labId: lab.id, labLevel: lab.level }, undefined, { kind: 'solution', to: 'course' });
      setNote('');
      await load.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="font-medium">Solutions from others</h2>
      {!passed ? (
        <p className="mt-1 text-sm text-ink-soft">Pass this lab and you can see how others who passed it built theirs, and share your own.</p>
      ) : (
        <>
          <LoadState loading={load.loading} error={load.error}>
            {load.data && load.data.length === 0 ? (
              <p className="mt-1 text-sm text-ink-soft">Nobody has shared a solution yet. Yours could be the first.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {load.data?.map((r) => (
                  <li key={r.id} className="rounded-md border border-line p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <PersonChip person={r.owner} size={18} />
                      <span className="text-xs text-ink-faint">{timeAgo(r.createdAt)}</span>
                    </div>
                    {r.body && <p className="mt-1 text-ink-soft">{r.body}</p>}
                    <div className="mt-1.5 flex gap-2">
                      {onOpen && r.payload != null && (
                        <button type="button" onClick={() => window.confirm('Replace your bench with this solution? Your current circuit is kept as a saved copy.') && onOpen(r.payload)} className={BTN_SMALL}>
                          Load on my bench
                        </button>
                      )}
                      {r.owner?.id === me && (
                        <button type="button" onClick={() => void resources.remove(r.id).then(() => load.reload())} className={`${BTN_SMALL} text-fault`}>
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </LoadState>
          {!mine && (
            <div className="mt-3 border-t border-line pt-3">
              <label className="block text-sm">
                <span className="font-medium">Share your solution</span>
                <span className="block text-xs text-ink-soft">Only learners who have passed this lab can see it.</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="A sentence about your approach (optional)" className="input mt-1.5" />
              </label>
              {error && (
                <div className="mt-2">
                  <Notice tone="error">{error}</Notice>
                </div>
              )}
              <button type="button" onClick={share} disabled={busy} className={`mt-2 ${BTN_SMALL}`}>
                Share my circuit
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
