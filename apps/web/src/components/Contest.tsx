/**
 * Contest entry on a lab or topic-check page: which live contests the learner is registered in
 * that include this content, a banner saying so, and a submit() that records each run.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { competitions, formatDuration } from '../lib/community';
import { track } from '../lib/telemetry';
import { useAuth } from '../store/auth';

interface Active {
  competitionId: string;
  title: string;
  ordinal: number;
  endsAt: string;
}

export function useContestEntry(kind: 'lab' | 'check', contentId: string, course?: string) {
  const signedIn = useAuth((s) => s.status === 'signed-in');
  const [active, setActive] = useState<Active[]>([]);
  const [lastScore, setLastScore] = useState<{ title: string; points: number; solved: number } | null>(null);
  const [params] = useSearchParams();
  const fromContest = params.get('contest');

  useEffect(() => {
    if (!signedIn) {
      setActive([]);
      return;
    }
    let alive = true;
    void competitions
      .active(kind === 'lab' ? { labId: contentId } : { checkId: contentId })
      .then((a) => alive && setActive(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn, kind, contentId]);

  /** Records a run in every live contest this content belongs to. Never throws into the page. */
  const submit = useCallback(
    async (passed: boolean, hintsUsed: number) => {
      for (const a of active) {
        if (Date.parse(a.endsAt) < Date.now()) continue;
        const obj = { type: 'problem' as const, id: `${a.competitionId}:${a.ordinal}`, course, labId: kind === 'lab' ? contentId : undefined };
        try {
          const score = await competitions.submit(a.competitionId, { ordinal: a.ordinal, passed, hintsUsed });
          track('submitted', obj, { passed, hintsUsed });
          track(passed ? 'passed' : 'failed', obj, { points: score.points, solved: score.solved });
          setLastScore({ title: a.title, points: score.points, solved: score.solved });
        } catch {
          /* the contest may have just closed; the board is the source of truth */
        }
      }
    },
    [active, kind, contentId, course],
  );

  return { active, submit, lastScore, fromContest };
}

export function ContestBanner({ entry }: { entry: ReturnType<typeof useContestEntry> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (entry.active.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [entry.active.length]);
  if (entry.active.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-gold/50 bg-gold-soft px-4 py-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1" role="status">
      {entry.active.map((a) => (
        <span key={a.competitionId} className="inline-flex items-center gap-2">
          <span className="font-medium">Contest: {a.title}</span>
          <span className="text-ink-soft">
            problem {a.ordinal} · <span className="font-mono">{formatDuration(Math.max(0, (Date.parse(a.endsAt) - now) / 1000))}</span> left
          </span>
          <Link to={`/competitions/${a.competitionId}`} className="underline underline-offset-2 hover:text-ink">
            board
          </Link>
        </span>
      ))}
      {entry.lastScore && (
        <span className="ml-auto text-high font-medium">
          {entry.lastScore.points} points, {entry.lastScore.solved} solved
        </span>
      )}
      <span className="basis-full text-xs text-ink-soft">Every check counts as a run: a failed run adds time, hints cost points. Solutions stay hidden until the contest ends.</span>
    </div>
  );
}
