import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { groups } from '../lib/community';
import { track } from '../lib/telemetry';
import { BTN, BTN_SOFT, CARD, errorText, LoadState, SignedInOnly, useLoad } from '../components/Community';
import { Notice } from '../components/Form';

/** The join link a facilitator shares: /groups/join/CODE. */
export function GroupJoinPage() {
  const { code = '' } = useParams();
  return (
    <SignedInOnly what="groups">
      <JoinCard code={code.toUpperCase()} />
    </SignedInOnly>
  );
}

function JoinCard({ code }: { code: string }) {
  const preview = useLoad(() => groups.byCode(code), [code]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const join = async () => {
    setBusy(true);
    try {
      const g = await groups.joinByCode(code);
      track('joined', { type: 'group', id: g.id }, { members: g.memberCount }, { via: 'link' });
      navigate(`/groups/${g.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <LoadState loading={preview.loading} error={preview.error}>
        {preview.data && (
          <div className={CARD}>
            <p className="text-sm text-ink-soft">You have been invited to join</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{preview.data.name}</h1>
            {preview.data.description && <p className="mt-2 text-ink-soft">{preview.data.description}</p>}
            <p className="mt-2 text-sm text-ink-faint">
              {preview.data.memberCount} member{preview.data.memberCount === 1 ? '' : 's'} · code <span className="font-mono">{code}</span>
            </p>
            {error && (
              <div className="mt-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {preview.data.myRole ? (
                <Link to={`/groups/${preview.data.id}`} className={BTN}>
                  Open the group
                </Link>
              ) : (
                <button type="button" onClick={join} disabled={busy} className={BTN}>
                  Join this group
                </button>
              )}
              <Link to="/community" className={BTN_SOFT}>
                Not now
              </Link>
            </div>
          </div>
        )}
      </LoadState>
    </div>
  );
}
