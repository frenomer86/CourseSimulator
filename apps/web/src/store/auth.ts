/**
 * Account state. In offline guest mode (no Supabase env) status stays 'disabled' and every
 * action resolves with a friendly message instead of touching the network.
 */

import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { accountsEnabled, authRedirectUrl, describeError, supabase } from '../lib/supabase';
import type { ProfileRow, ProfileUpdate } from '../lib/database.types';

export type AuthStatus = 'disabled' | 'loading' | 'guest' | 'signed-in';

export interface AuthUser {
  id: string;
  email: string | null;
}

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  profile: ProfileRow | null;
  profileError: string | null;

  signUp: (email: string, password: string, displayName: string) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  signInWithPassword: (email: string, password: string) => Promise<{ error?: string }>;
  signInWithMagicLink: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<{ error?: string }>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: ProfileUpdate) => Promise<{ error?: string }>;
}

const DISABLED_MESSAGE = 'Accounts are not set up on this copy of the app. Your progress is saved on this device.';

function toUser(session: Session | null): AuthUser | null {
  return session?.user ? { id: session.user.id, email: session.user.email ?? null } : null;
}

export const useAuth = create<AuthState>()((set, get) => ({
  status: accountsEnabled ? 'loading' : 'disabled',
  user: null,
  profile: null,
  profileError: null,

  signUp: async (email, password, displayName) => {
    if (!supabase) return { error: DISABLED_MESSAGE };
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { display_name: displayName.trim() }, emailRedirectTo: authRedirectUrl() },
    });
    if (error) return { error: describeError(error) };
    // With email confirmation on, Supabase returns a user but no session.
    return { needsConfirmation: !data.session };
  },

  signInWithPassword: async (email, password) => {
    if (!supabase) return { error: DISABLED_MESSAGE };
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return error ? { error: describeError(error) } : {};
  },

  signInWithMagicLink: async (email) => {
    if (!supabase) return { error: DISABLED_MESSAGE };
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true },
    });
    return error ? { error: describeError(error) } : {};
  },

  signOut: async () => {
    if (!supabase) return { error: DISABLED_MESSAGE };
    const { error } = await supabase.auth.signOut();
    if (error && !/session/i.test(error.message)) return { error: describeError(error) };
    set({ status: 'guest', user: null, profile: null, profileError: null });
    return {};
  },

  refreshProfile: async () => {
    const user = get().user;
    if (!supabase || !user) return;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) {
      set({ profileError: describeError(error) });
      return;
    }
    set({ profile: data ?? null, profileError: data ? null : 'Your profile has not been created yet. Try again in a moment.' });
  },

  updateProfile: async (patch) => {
    const user = get().user;
    if (!supabase || !user) return { error: DISABLED_MESSAGE };
    const { data, error } = await supabase.from('profiles').update(patch).eq('id', user.id).select('*').single();
    if (error) return { error: describeError(error) };
    set({ profile: data });
    return {};
  },
}));

/**
 * Starts listening to Supabase auth. Returns an unsubscribe. Calls `onChange` with the user id
 * whenever the signed-in account changes (including the initial session), so the sync layer
 * can merge and flush.
 */
export function initAuth(onChange: (user: AuthUser | null) => void): () => void {
  if (!supabase) {
    onChange(null);
    return () => {};
  }
  let lastUserId: string | null | undefined;
  const apply = (session: Session | null) => {
    const user = toUser(session);
    useAuth.setState({ status: user ? 'signed-in' : 'guest', user, profile: user ? useAuth.getState().profile : null });
    if (user?.id !== lastUserId) {
      lastUserId = user?.id ?? null;
      if (user) void useAuth.getState().refreshProfile();
      onChange(user);
    }
  };
  supabase.auth
    .getSession()
    .then(({ data }) => apply(data.session))
    .catch(() => apply(null));
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return; // handled by getSession above
    if (event === 'USER_UPDATED') {
      void useAuth.getState().refreshProfile();
      return;
    }
    apply(session);
  });
  return () => data.subscription.unsubscribe();
}
