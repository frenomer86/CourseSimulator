/**
 * The app's own API (apps/api). Same origin in production (/api); in development Vite proxies
 * /api to the API dev server. VITE_API_URL overrides the base for a split deployment.
 */

import type { LabLevel, Mastery, ProgressRecords } from '@cslab/lab-runtime';

export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '/api').replace(/\/+$/, '');

const TOKEN_KEY = 'cslab-session-v1';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

export type AgeBand = 'under_18' | '18_plus' | 'undisclosed';

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Profile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  ageBand: AgeBand;
  showOnBoards: boolean;
  xp: number;
  level: number;
}

export type ProfilePatch = Partial<Pick<Profile, 'username' | 'displayName' | 'avatarUrl' | 'ageBand' | 'showOnBoards'>>;

export interface LabResultItem {
  kind: 'lab_result';
  id: string; // client attempt id (uuid)
  at: string;
  labId: string;
  course: string;
  level: LabLevel;
  passed: boolean;
  score: number;
  hintsUsed: number;
  checks?: unknown[];
}

export interface CheckAttemptItem {
  kind: 'check_attempt';
  id: string;
  at: string;
  course: string;
  unit: number;
  topic: number;
  score: number;
  passed: boolean;
}

export interface TopicProgressItem {
  kind: 'topic_progress';
  id: string; // the topic key; a newer item for the same key replaces an older queued one
  at: string;
  course: string;
  unit: number;
  topic: number;
  mastery: Mastery;
  bestCheckScore?: number;
}

export type SyncItem = LabResultItem | CheckAttemptItem | TopicProgressItem;

export interface SyncResponse {
  accepted: string[];
  records: ProgressRecords;
  profile: Profile;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const token = opts.auth === false ? null : getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    if (res.ok) return undefined as T;
  }
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? `The server answered ${res.status}.`);
  }
  return data as T;
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
