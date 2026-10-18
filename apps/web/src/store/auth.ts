/**
 * Account state against the app's own API.
 *
 *   checking     looking for a saved session or an account server
 *   unavailable  no API on this deployment (a static host): everything stays on the device
 *   guest        the API is there but nobody is signed in
 *   signed-in    a session token is saved; the user and profile are cached for offline use
 */

import { create } from 'zustand';
import { api, ApiError, getToken, setToken, type Profile, type ProfilePatch, type User } from '../lib/api';
import { useProfile } from './profile';

export type AuthStatus = 'checking' | 'unavailable' | 'guest' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  profile: Profile | null;
  signUp: (email: string, password: string, displayName: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<{ error?: string }>;
  deleteAccount: (password: string) => Promise<{ error?: string }>;
  /** Called by the sync layer when the server returns a fresher profile. */
  applyProfile: (profile: Profile) => void;
}

const CACHE_KEY = 'cslab-account-v1';

function readCache(): { user: User; profile: Profile } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { user: User; profile: Profile }) : null;
  } catch {
    return null;
  }
}

function writeCache(value: { user: User; profile: Profile } | null) {
  try {
    if (value) localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function mirrorProfile(profile: Profile) {
  useProfile.getState().setProfile({ displayName: profile.displayName, avatarUrl: profile.avatarUrl ?? '' });
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

export const useAuth = create<AuthState>()((set, get) => ({
  status: 'checking',
  user: null,
  profile: null,

  signUp: async (email, password, displayName) => {
    try {
      const res = await api<{ token: string; user: User; profile: Profile }>('/auth/sign-up', {
        method: 'POST',
        body: { email, password, displayName: displayName || undefined },
        auth: false,
      });
      setToken(res.token);
      writeCache({ user: res.user, profile: res.profile });
      mirrorProfile(res.profile);
      set({ status: 'signed-in', user: res.user, profile: res.profile });
      return {};
    } catch (err) {
      return { error: message(err) };
    }
  },

  signIn: async (email, password) => {
    try {
      const res = await api<{ token: string; user: User; profile: Profile }>('/auth/sign-in', { method: 'POST', body: { email, password }, auth: false });
      setToken(res.token);
      writeCache({ user: res.user, profile: res.profile });
      mirrorProfile(res.profile);
      set({ status: 'signed-in', user: res.user, profile: res.profile });
      return {};
    } catch (err) {
      return { error: message(err) };
    }
  },

  signOut: async () => {
    try {
      await api('/auth/sign-out', { method: 'POST', timeoutMs: 5000 });
    } catch {
      /* the token is dropped locally either way; the server session expires on its own */
    }
    setToken(null);
    writeCache(null);
    set({ status: 'guest', user: null, profile: null });
  },

  updateProfile: async (patch) => {
    try {
      const res = await api<{ profile: Profile }>('/me/profile', { method: 'PATCH', body: patch });
      get().applyProfile(res.profile);
      return {};
    } catch (err) {
      return { error: message(err) };
    }
  },

  deleteAccount: async (password) => {
    try {
      await api('/me', { method: 'DELETE', body: { password } });
      setToken(null);
      writeCache(null);
      set({ status: 'guest', user: null, profile: null });
      return {};
    } catch (err) {
      return { error: message(err) };
    }
  },

  applyProfile: (profile) => {
    const user = get().user;
    if (user) writeCache({ user, profile });
    mirrorProfile(profile);
    set({ profile });
  },
}));

/** Works out who is signed in. Runs once at startup. */
export async function initAuth(): Promise<void> {
  const token = getToken();
  if (token) {
    const cached = readCache();
    if (cached) useAuth.setState({ status: 'signed-in', user: cached.user, profile: cached.profile });
    try {
      const me = await api<{ user: User; profile: Profile }>('/me', { timeoutMs: 8000 });
      writeCache(me);
      mirrorProfile(me.profile);
      useAuth.setState({ status: 'signed-in', user: me.user, profile: me.profile });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        writeCache(null);
        useAuth.setState({ status: 'guest', user: null, profile: null });
      } else if (!cached) {
        // Offline with no cache: keep the token and treat the session as signed in but unknown.
        useAuth.setState({ status: 'signed-in' });
      }
    }
    return;
  }
  try {
    await api('/health', { auth: false, timeoutMs: 5000 });
    useAuth.setState({ status: 'guest' });
  } catch (err) {
    // A 404 means a static host with no API behind it; a network error means offline or no API.
    useAuth.setState({ status: err instanceof ApiError && err.status > 0 && err.status !== 404 ? 'guest' : 'unavailable' });
  }
}
