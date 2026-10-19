/**
 * One WebSocket to the API for presence, group chat, direct messages and notifications.
 * Protocol: apps/api/src/realtime.ts. Connects while signed in, reconnects with backoff, and
 * re-joins every room the open pages care about after a reconnect.
 */

import { useEffect, useState } from 'react';
import { API_BASE, getToken } from './api';
import { useAuth } from '../store/auth';
import type { DirectMessage, GroupMessage, Notification, Online } from './community';

type Frame =
  | { type: 'ready'; userId: string }
  | { type: 'presence'; groupId: string; online: Online[] }
  | { type: 'message'; groupId: string; message: GroupMessage }
  | { type: 'message-deleted'; groupId: string; id: number }
  | { type: 'dm'; conversationId: string; message: DirectMessage }
  | { type: 'notification'; notification: Notification }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

type Listener = (f: Frame) => void;

let socket: WebSocket | null = null;
let ready = false;
let backoff = 1000;
let retry: ReturnType<typeof setTimeout> | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<Listener>();
const rooms = new Map<string, number>(); // groupId → subscriber count
let started = false;

function wsUrl(): string {
  const base = API_BASE.startsWith('http') ? new URL(API_BASE) : new URL(API_BASE, window.location.origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/ws`;
  return base.toString();
}

function send(payload: unknown) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function emit(f: Frame) {
  for (const l of listeners) l(f);
}

function connect() {
  const token = getToken();
  if (!token || useAuth.getState().status !== 'signed-in' || socket) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = (ev) => {
    let f: Frame;
    try {
      f = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (f.type === 'ready') {
      ready = true;
      backoff = 1000;
      for (const groupId of rooms.keys()) ws.send(JSON.stringify({ type: 'join', groupId }));
      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(() => send({ type: 'ping' }), 25_000);
    }
    emit(f);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    ready = false;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    if (useAuth.getState().status === 'signed-in') scheduleReconnect();
  };
  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    backoff = Math.min(backoff * 2, 30_000);
    connect();
  }, backoff);
}

function disconnect() {
  if (retry) clearTimeout(retry);
  retry = null;
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  const ws = socket;
  socket = null;
  ready = false;
  ws?.close();
}

/** Starts the connection manager once; it follows the sign-in state from then on. */
export function startRealtime(): void {
  if (started || typeof WebSocket === 'undefined') return;
  started = true;
  if (useAuth.getState().status === 'signed-in') connect();
  useAuth.subscribe((s) => {
    if (s.status === 'signed-in') connect();
    else disconnect();
  });
  window.addEventListener('online', () => connect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connect();
  });
}

export function onFrame(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function joinRoom(groupId: string): () => void {
  rooms.set(groupId, (rooms.get(groupId) ?? 0) + 1);
  if (ready) send({ type: 'join', groupId });
  else connect();
  return () => {
    const n = (rooms.get(groupId) ?? 1) - 1;
    if (n <= 0) {
      rooms.delete(groupId);
      send({ type: 'leave', groupId });
    } else rooms.set(groupId, n);
  };
}

export function sendGroupMessage(groupId: string, body: string, replyTo?: number | null): boolean {
  if (!ready) return false;
  send({ type: 'message', groupId, body, replyTo: replyTo ?? null });
  return true;
}

/** Presence and live messages for one group while the component is mounted. */
export function useRoom(groupId: string | undefined) {
  const [online, setOnline] = useState<Online[]>([]);
  const [incoming, setIncoming] = useState<GroupMessage[]>([]);
  const [deleted, setDeleted] = useState<number[]>([]);
  const [connected, setConnected] = useState(ready);
  useEffect(() => {
    if (!groupId) return;
    setConnected(ready); // the socket may already be up from an earlier page
    const leave = joinRoom(groupId);
    const off = onFrame((f) => {
      if (f.type === 'ready') setConnected(true);
      if (f.type === 'presence' && f.groupId === groupId) setOnline(f.online);
      if (f.type === 'message' && f.groupId === groupId) setIncoming((list) => (list.some((m) => m.id === f.message.id) ? list : [...list, f.message]));
      if (f.type === 'message-deleted' && f.groupId === groupId) setDeleted((d) => [...d, f.id]);
    });
    return () => {
      leave();
      off();
    };
  }, [groupId]);
  return { online, incoming, deleted, connected };
}
