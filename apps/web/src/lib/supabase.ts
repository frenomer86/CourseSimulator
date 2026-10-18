/**
 * The Supabase client, or null in offline guest mode.
 *
 * Guest mode is the default: when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set
 * (no apps/web/.env.local), every feature keeps working from browser storage alone and the
 * account pages explain that sign-in is not available on this deployment.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const accountsEnabled: boolean = Boolean(url && anonKey);

export const supabase: SupabaseClient<Database> | null = accountsEnabled
  ? createClient<Database>(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Implicit flow: magic links then work when opened in a different browser or app.
        detectSessionInUrl: true,
        flowType: 'implicit',
        storageKey: 'cslab-auth',
      },
    })
  : null;

/** Where email links (magic link, confirmation) send the learner back to. */
export function authRedirectUrl(): string {
  return `${window.location.origin}/account`;
}

/** A UUID v4 that also works on http origins where crypto.randomUUID is unavailable. */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Turns Supabase and network errors into one plain sentence for the UI. */
export function describeError(err: unknown): string {
  if (!err) return 'Something went wrong.';
  const e = err as { message?: string; code?: string; status?: number };
  const msg = e.message ?? String(err);
  if (/fetch|network|Failed to fetch|Load failed/i.test(msg)) return 'We could not reach the server. Check your connection and try again.';
  if (/Invalid login credentials/i.test(msg)) return 'That email and password do not match.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/User already registered/i.test(msg)) return 'There is already an account with that email. Try signing in.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts for now. Please wait a minute and try again.';
  if (/Password should be/i.test(msg)) return 'Use a password of at least 6 characters.';
  if (e.code === '23505' && /username/i.test(msg)) return 'That username is taken. Try another.';
  if (e.code === '23514' && /username/i.test(msg)) return 'Usernames are 3 to 24 characters: lowercase letters, digits and underscores.';
  return msg;
}
