import { MASTERY_LABEL, type Mastery } from '@cslab/lab-runtime';

/**
 * The mastery marker: an empty ring for not started, a half-filled one for attempted,
 * a filled green dot for proficient, and a filled dot with a ring for mastered.
 */
export function MasteryDot({ mastery, size = 'md' }: { mastery: Mastery; size?: 'sm' | 'md' }) {
  const px = size === 'sm' ? 12 : 18;
  const r = px / 2;
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      role="img"
      aria-label={MASTERY_LABEL[mastery]}
      className="shrink-0"
    >
      {mastery === 'not_started' && <circle cx={r} cy={r} r={r - 1.5} fill="none" stroke="var(--color-line)" strokeWidth={2} />}
      {mastery === 'attempted' && (
        <>
          <circle cx={r} cy={r} r={r - 1.5} fill="none" stroke="var(--color-gold)" strokeWidth={2} />
          <path d={`M ${r} ${1.5} A ${r - 1.5} ${r - 1.5} 0 0 1 ${r} ${px - 1.5} Z`} fill="var(--color-gold)" />
        </>
      )}
      {mastery === 'proficient' && <circle cx={r} cy={r} r={r - 1} fill="var(--color-high-bright)" />}
      {mastery === 'mastered' && (
        <>
          <circle cx={r} cy={r} r={r - 0.75} fill="none" stroke="var(--color-high)" strokeWidth={1.5} />
          <circle cx={r} cy={r} r={r - 4} fill="var(--color-high)" />
        </>
      )}
    </svg>
  );
}

export function MasteryLegend() {
  const states: Mastery[] = ['not_started', 'attempted', 'proficient', 'mastered'];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
      {states.map((m) => (
        <li key={m} className="inline-flex items-center gap-1.5">
          <MasteryDot mastery={m} size="sm" />
          {MASTERY_LABEL[m]}
        </li>
      ))}
    </ul>
  );
}
