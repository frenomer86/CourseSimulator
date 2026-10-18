import type { ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="block text-xs text-ink-soft mt-0.5">{hint}</span>}
      <span className="block mt-1.5">{children}</span>
    </label>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'ok' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'error' ? 'border-fault/40 bg-fault-soft' : tone === 'ok' ? 'border-high bg-high-soft' : 'border-gold/40 bg-gold-soft';
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}
