import { useState } from 'react';

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

/** A picture when a link is given and loads, otherwise initials on the bench colour. */
export function Avatar({ name, url, size = 32 }: { name: string; url: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const common = 'rounded-full shrink-0 object-cover border border-line';
  if (url && !broken) {
    return <img src={url} alt="" width={size} height={size} className={common} onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
  }
  return (
    <span
      className={`${common} grid place-items-center bg-high-soft text-high font-semibold`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
