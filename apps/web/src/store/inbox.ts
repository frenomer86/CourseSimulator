/** The notification inbox: loaded on sign-in, bumped live over the WebSocket. */

import { create } from 'zustand';
import { inbox, type Notification } from '../lib/community';
import { onFrame } from '../lib/realtime';
import { useAuth } from './auth';

interface InboxState {
  notifications: Notification[];
  unread: number;
  loaded: boolean;
  refresh: () => Promise<void>;
  markRead: (ids?: number[]) => Promise<void>;
}

export const useInbox = create<InboxState>()((set, get) => ({
  notifications: [],
  unread: 0,
  loaded: false,
  refresh: async () => {
    if (useAuth.getState().status !== 'signed-in') return;
    try {
      const r = await inbox.list();
      set({ notifications: r.notifications, unread: r.unread, loaded: true });
    } catch {
      /* offline: keep what we have */
    }
  },
  markRead: async (ids) => {
    const now = new Date().toISOString();
    set((s) => {
      const list = s.notifications.map((n) => (!n.readAt && (!ids || ids.includes(n.id)) ? { ...n, readAt: now } : n));
      return { notifications: list, unread: list.filter((n) => !n.readAt).length };
    });
    try {
      await inbox.markRead(ids);
    } catch {
      void get().refresh();
    }
  },
}));

let started = false;

export function startInbox(): void {
  if (started) return;
  started = true;
  const load = () => void useInbox.getState().refresh();
  if (useAuth.getState().status === 'signed-in') load();
  useAuth.subscribe((s, prev) => {
    if (s.status === 'signed-in' && prev.status !== 'signed-in') load();
    if (s.status !== 'signed-in' && prev.status === 'signed-in') useInbox.setState({ notifications: [], unread: 0, loaded: false });
  });
  onFrame((f) => {
    if (f.type === 'notification') {
      useInbox.setState((s) => ({ notifications: [f.notification, ...s.notifications].slice(0, 100), unread: s.unread + 1 }));
    }
  });
}
