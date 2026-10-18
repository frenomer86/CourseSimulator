import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { describeSnapshot, masteryRank, validateProgressSnapshot, type ProgressSnapshot } from '@cslab/lab-runtime';
import { currentRecords, useProgress } from '../store/progress';
import { useProfile } from '../store/profile';
import { Avatar } from '../components/Avatar';
import { Field, Notice } from '../components/Form';

export function ProfilePage() {
  const profile = useProfile();
  const labsPassed = useProgress((s) => Object.values(s.labs).filter((l) => l.passed).length);
  const topicsProficient = useProgress((s) => Object.values(s.topics).filter((t) => masteryRank(t.mastery) >= 2).length);
  const topicsMastered = useProgress((s) => Object.values(s.topics).filter((t) => t.mastery === 'mastered').length);
  const checksPassed = useProgress((s) => Object.values(s.checks).filter((c) => c.passed).length);
  const importRecords = useProgress((s) => s.importRecords);
  const reset = useProgress((s) => s.reset);

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok' | 'info'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    profile.setProfile({ displayName: displayName.trim(), avatarUrl: avatarUrl.trim() });
    setSaved(true);
  };

  const exportProgress = () => {
    const snapshot: ProgressSnapshot = {
      format: 'cslab-progress',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: profile.displayName ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl || undefined } : undefined,
      ...currentRecords(),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cslab-progress-${snapshot.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'ok', text: 'Your progress file is downloading. Keep it somewhere safe, or open it on another device.' });
  };

  const importProgress = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setMessage({ tone: 'error', text: 'That file is not a progress file from this app.' });
      return;
    }
    if (!validateProgressSnapshot(raw)) {
      setMessage({ tone: 'error', text: 'That file is not a progress file from this app, or it is damaged.' });
      return;
    }
    const what = describeSnapshot(raw);
    importRecords(raw);
    if (raw.profile && !profile.displayName) {
      profile.setProfile({ displayName: raw.profile.displayName, avatarUrl: raw.profile.avatarUrl ?? '' });
      setDisplayName(raw.profile.displayName);
      setAvatarUrl(raw.profile.avatarUrl ?? '');
    }
    setMessage({
      tone: 'ok',
      text: `Imported. The file held ${what.labsPassed} passed lab${what.labsPassed === 1 ? '' : 's'}, ${what.checksPassed} passed check${
        what.checksPassed === 1 ? '' : 's'
      } and ${what.topicsProficient} proficient topic${what.topicsProficient === 1 ? '' : 's'}; anything better than what was here has been kept.`,
    });
  };

  const clearAll = () => {
    if (!window.confirm('Remove every lab result, check score and saved circuit from this device? Export first if you want to keep them.')) return;
    reset();
    setMessage({ tone: 'info', text: 'Progress on this device has been cleared.' });
  };

  const name = profile.displayName || 'Learner';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={name} url={profile.avatarUrl || null} size={64} />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight truncate">{name}</h1>
          <p className="text-sm text-ink-soft">Your progress lives in this browser. No account needed.</p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Labs passed" value={labsPassed} />
        <Stat label="Checks passed" value={checksPassed} />
        <Stat label="Topics proficient" value={topicsProficient} />
        <Stat label="Topics mastered" value={topicsMastered} />
      </dl>

      {message && (
        <div className="mt-6">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}

      <form onSubmit={save} className="mt-6 rounded-lg border border-line bg-surface p-5 space-y-4">
        <h2 className="font-medium text-lg">About you</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown at the top of the page and in exported files.">
            <input
              type="text"
              maxLength={60}
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              placeholder="Your name or a nickname"
              className="input"
              autoComplete="nickname"
            />
          </Field>
          <Field label="Picture link" hint="Optional. A link to an image; leave empty to use your initials.">
            <input
              type="url"
              value={avatarUrl}
              onChange={(e) => {
                setAvatarUrl(e.target.value);
                setSaved(false);
              }}
              placeholder="https://…"
              className="input"
              inputMode="url"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
            Save
          </button>
          {saved && <span className="text-sm text-high">Saved.</span>}
        </div>
      </form>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-lg">Move your progress</h2>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed">
          Export a small file with everything you have done. Import it on another phone or laptop, or after clearing this browser, and
          the best of both is kept. Nothing leaves your device unless you move the file yourself.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={exportProgress} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
            Export progress
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench"
          >
            Import a progress file
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" onChange={importProgress} className="hidden" aria-label="Progress file" />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-lg">Start again</h2>
        <p className="mt-1 text-sm text-ink-soft">Clears every result and saved circuit from this device. Useful on a shared computer.</p>
        <button
          type="button"
          onClick={clearAll}
          className="mt-3 rounded-md border border-fault/50 text-fault px-4 py-2 font-medium hover:bg-fault-soft"
        >
          Clear progress on this device
        </button>
      </section>

      <p className="mt-6 text-sm text-ink-soft">
        <Link to="/#courses" className="hover:text-ink underline underline-offset-2">
          Back to the courses
        </Link>
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface border border-line p-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-xl font-semibold font-mono">{value}</dd>
    </div>
  );
}
