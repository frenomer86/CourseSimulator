/**
 * Typed calls to the community and competition routes of the app's API (apps/api/src/community.ts,
 * forum.ts, messages.ts, competitions.ts). Shapes mirror the API's responses.
 */

import { api } from './api';

export type PlatformRole = 'learner' | 'facilitator' | 'moderator' | 'admin';
export type GroupRole = 'owner' | 'admin' | 'member';

export interface Person {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  platformRole: PlatformRole;
}

export interface Group {
  id: string;
  kind: 'study' | 'class' | 'team';
  name: string;
  description: string | null;
  visibility: 'public' | 'invite';
  courseSlug: string | null;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  myRole: GroupRole | null;
  joinCode: string | null;
}

export interface Member extends Person {
  role: GroupRole;
  joinedAt: string;
}

export interface Online {
  displayName: string;
  avatarUrl: string | null;
}

export interface GroupMessage {
  id: number;
  groupId: string;
  author: Person | null;
  body: string;
  replyTo: number | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface Resource {
  id: string;
  kind: 'link' | 'note' | 'file' | 'solution';
  owner: Person | null;
  groupId: string | null;
  courseSlug: string | null;
  labId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  payload: unknown;
  createdAt: string;
}

export interface TaskItem {
  kind: 'lab' | 'check';
  id: string;
  title?: string;
}

export interface GroupTask {
  id: string;
  groupId: string;
  createdBy: Person | null;
  title: string;
  description: string | null;
  items: TaskItem[];
  dueAt: string | null;
  createdAt: string;
  mine: { done: number; total: number; completedIds: string[] };
}

export interface TaskMember extends Person {
  role: GroupRole;
  done: number;
  total: number;
  completedIds: string[];
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  lecturersOnly: boolean;
  threads: number;
}

export interface ThreadSummary {
  id: string;
  categoryId: string;
  author: Person | null;
  title: string;
  tags: string[];
  courseSlug: string | null;
  unitIndex: number | null;
  topicIndex: number | null;
  labId: string | null;
  solved: boolean;
  locked: boolean;
  pinned: boolean;
  views: number;
  replies: number;
  votes: number;
  createdAt: string;
  updatedAt: string;
}

export interface Thread extends ThreadSummary {
  body: string;
  acceptedPostId: string | null;
}

export interface Post {
  id: string;
  threadId: string;
  author: Person | null;
  body: string;
  parentId: string | null;
  endorsed: boolean;
  accepted: boolean;
  votes: number;
  myVote: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface ThreadView {
  thread: Thread;
  posts: Post[];
  can: { reply: boolean; edit: boolean; accept: boolean; endorse: boolean; moderate: boolean };
}

export interface DirectMessage {
  id: number;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  other: Person | null;
  lastMessage: DirectMessage | null;
  unread: number;
  createdAt: string;
}

export type CompetitionKind = 'general' | 'group' | 'league' | 'quest';
export type CompetitionStatus = 'draft' | 'scheduled' | 'live' | 'scoring' | 'finished' | 'cancelled';

export interface Competition {
  id: string;
  kind: CompetitionKind;
  status: CompetitionStatus;
  title: string;
  description: string | null;
  courseSlug: string | null;
  groupId: string | null;
  createdBy: string;
  startsAt: string;
  endsAt: string;
  teamMin: number;
  teamMax: number;
  hintPenalty: number;
  wrongRunPenaltyS: number;
  rules: Record<string, unknown>;
  participants: number;
  problemCount: number;
  createdAt: string;
}

export interface Problem {
  ordinal: number;
  kind: 'lab' | 'check';
  contentId: string;
  level: string | null;
  points: number;
}

export interface Team {
  id: string;
  name: string;
  groupId: string | null;
  members: number;
}

export interface CompetitionView {
  competition: Competition;
  creator: Person | null;
  problems: Problem[] | null;
  registration: { teamId: string | null; joinedAt: string } | null;
  teams: Team[];
  canManage: boolean;
}

export interface Standing {
  rank: number;
  person: Person | null;
  teamId: string | null;
  points: number;
  solved: number;
  finishS: number;
  penaltyS: number;
  contributions: Record<string, number>;
  solvedOrdinals: number[];
}

export interface TeamStanding {
  id: string;
  name: string;
  rank: number;
  points: number;
  basePoints: number;
  members: number;
  scorers: number;
  finishS: number;
}

export interface AwardRow {
  userId: string;
  kind: string;
  label: string;
  teamId: string | null;
}

export interface Board {
  status: CompetitionStatus;
  endsAt: string;
  standings: Standing[];
  teams: TeamStanding[];
  mine: Standing | null;
  quest: { goal: number; solved: number } | null;
  awards: AwardRow[];
}

export interface Award {
  id: number;
  kind: string;
  label: string;
  competitionId: string | null;
  competitionTitle: string | null;
  awardedAt: string;
}

export type NotificationKind = 'reply' | 'mention' | 'accepted' | 'invite' | 'deadline' | 'contest' | 'message' | 'task';

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface PublicProfile {
  person: Person;
  xp: number | null;
  level: number | null;
  bio: string | null;
  memberSince: string;
  contributions: number;
  canMessage: boolean;
  awards: Award[];
}

/* ----------------------------------------------------------------------------- groups */

export const groups = {
  mine: () => api<{ groups: Group[] }>('/groups?scope=mine').then((r) => r.groups),
  discover: (q?: string) => api<{ groups: Group[] }>(`/groups?scope=public${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => r.groups),
  create: (body: { name: string; description?: string; visibility: 'public' | 'invite'; kind?: 'study' | 'class' | 'team'; courseSlug?: string }) =>
    api<{ group: Group }>('/groups', { method: 'POST', body }).then((r) => r.group),
  get: (id: string) => api<{ group: Group; online: Online[] }>(`/groups/${id}`),
  byCode: (code: string) => api<{ group: Group }>(`/groups/by-code/${encodeURIComponent(code)}`).then((r) => r.group),
  joinByCode: (code: string) => api<{ group: Group }>('/groups/join', { method: 'POST', body: { code } }).then((r) => r.group),
  join: (id: string) => api<{ group: Group }>(`/groups/${id}/join`, { method: 'POST' }).then((r) => r.group),
  leave: (id: string) => api<void>(`/groups/${id}/leave`, { method: 'POST' }),
  update: (id: string, body: Partial<{ name: string; description: string; visibility: 'public' | 'invite'; courseSlug: string }>) =>
    api<{ group: Group }>(`/groups/${id}`, { method: 'PATCH', body }).then((r) => r.group),
  newCode: (id: string) => api<{ group: Group }>(`/groups/${id}/code`, { method: 'POST' }).then((r) => r.group),
  remove: (id: string) => api<void>(`/groups/${id}`, { method: 'DELETE' }),
  members: (id: string) => api<{ members: Member[]; online: Online[] }>(`/groups/${id}/members`),
  setRole: (id: string, userId: string, role: 'admin' | 'member') => api<void>(`/groups/${id}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (id: string, userId: string) => api<void>(`/groups/${id}/members/${userId}`, { method: 'DELETE' }),
  messages: (id: string, before?: string) =>
    api<{ messages: GroupMessage[]; online: Online[] }>(`/groups/${id}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  send: (id: string, body: string, replyTo?: number | null) => api<{ message: GroupMessage }>(`/groups/${id}/messages`, { method: 'POST', body: { body, replyTo: replyTo ?? null } }).then((r) => r.message),
  deleteMessage: (id: string, mid: number) => api<void>(`/groups/${id}/messages/${mid}`, { method: 'DELETE' }),
  tasks: (id: string) => api<{ tasks: GroupTask[] }>(`/groups/${id}/tasks`).then((r) => r.tasks),
  createTask: (id: string, body: { title: string; description?: string; items: TaskItem[]; dueAt?: string }) =>
    api<{ task: GroupTask }>(`/groups/${id}/tasks`, { method: 'POST', body }).then((r) => r.task),
  task: (id: string, taskId: string) => api<{ task: GroupTask; members: TaskMember[] | null }>(`/groups/${id}/tasks/${taskId}`),
  deleteTask: (id: string, taskId: string) => api<void>(`/groups/${id}/tasks/${taskId}`, { method: 'DELETE' }),
};

export const resources = {
  forGroup: (groupId: string) => api<{ resources: Resource[] }>(`/resources?groupId=${groupId}`).then((r) => r.resources),
  forCourse: (slug: string) => api<{ resources: Resource[] }>(`/resources?courseSlug=${encodeURIComponent(slug)}`).then((r) => r.resources),
  solutionsForLab: (labId: string) => api<{ resources: Resource[] }>(`/resources?labId=${encodeURIComponent(labId)}`).then((r) => r.resources),
  share: (body: { kind: 'link' | 'note' | 'solution'; groupId?: string; courseSlug?: string; labId?: string; title: string; body?: string; url?: string; payload?: unknown }) =>
    api<{ resource: Resource }>('/resources', { method: 'POST', body }).then((r) => r.resource),
  remove: (id: string) => api<void>(`/resources/${id}`, { method: 'DELETE' }),
};

/* ----------------------------------------------------------------------------- forum */

export interface ThreadFilter {
  category?: string;
  labId?: string;
  course?: string;
  unit?: number;
  topic?: number;
  q?: string;
  unsolved?: boolean;
  limit?: number;
}

export const forum = {
  categories: () => api<{ categories: Category[] }>('/forum/categories').then((r) => r.categories),
  threads: (f: ThreadFilter = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v === true ? '1' : v));
    return api<{ threads: ThreadSummary[] }>(`/forum/threads?${p}`).then((r) => r.threads);
  },
  ask: (body: { categoryId: string; title: string; body: string; tags?: string[]; courseSlug?: string; unitIndex?: number; topicIndex?: number; labId?: string }) =>
    api<{ thread: Thread }>('/forum/threads', { method: 'POST', body }).then((r) => r.thread),
  thread: (id: string) => api<ThreadView>(`/forum/threads/${id}`),
  editThread: (id: string, body: Partial<{ title: string; body: string; tags: string[]; locked: boolean; pinned: boolean }>) => api<void>(`/forum/threads/${id}`, { method: 'PATCH', body }),
  reply: (id: string, body: string, parentId?: string | null) => api<{ post: Post }>(`/forum/threads/${id}/posts`, { method: 'POST', body: { body, parentId: parentId ?? null } }).then((r) => r.post),
  editPost: (id: string, body: string) => api<void>(`/forum/posts/${id}`, { method: 'PATCH', body: { body } }),
  deletePost: (id: string) => api<void>(`/forum/posts/${id}`, { method: 'DELETE' }),
  vote: (postId: string, value: 1 | -1 | 0) => api<{ votes: number; myVote: number }>(`/forum/posts/${postId}/vote`, { method: 'PUT', body: { value } }),
  accept: (threadId: string, postId: string | null) => api<{ acceptedPostId: string | null }>(`/forum/threads/${threadId}/accept`, { method: 'POST', body: { postId } }),
  endorse: (postId: string, endorsed: boolean) => api<{ endorsed: boolean }>(`/forum/posts/${postId}/endorse`, { method: 'POST', body: { endorsed } }),
};

/* ----------------------------------------------------------------------------- messages */

export const messages = {
  conversations: () => api<{ conversations: Conversation[] }>('/conversations').then((r) => r.conversations),
  open: (userId: string) => api<{ conversationId: string; other: Person }>('/conversations', { method: 'POST', body: { userId } }),
  list: (id: string, before?: string) =>
    api<{ messages: DirectMessage[]; other: Person | null; blocked: boolean }>(`/conversations/${id}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  send: (id: string, body: string) => api<{ message: DirectMessage }>(`/conversations/${id}/messages`, { method: 'POST', body: { body } }).then((r) => r.message),
  blocks: () => api<{ blocked: Person[] }>('/me/blocks').then((r) => r.blocked),
  block: (userId: string) => api<void>(`/me/blocks/${userId}`, { method: 'PUT' }),
  unblock: (userId: string) => api<void>(`/me/blocks/${userId}`, { method: 'DELETE' }),
};

/* ----------------------------------------------------------------------------- competitions */

export interface NewCompetition {
  kind: 'general' | 'group' | 'quest';
  title: string;
  description?: string;
  courseSlug?: string;
  groupId?: string;
  startsAt: string;
  endsAt: string;
  teamMin?: number;
  teamMax?: number;
  hintPenalty?: number;
  wrongRunPenaltyS?: number;
  rules?: Record<string, unknown>;
  problems: Array<{ kind: 'lab' | 'check'; contentId: string; level?: 'beginner' | 'intermediate' | 'advanced'; points: number }>;
}

export const competitions = {
  open: () => api<{ competitions: Competition[] }>('/competitions?scope=open').then((r) => r.competitions),
  mine: () => api<{ competitions: Competition[] }>('/competitions?scope=mine').then((r) => r.competitions),
  forGroup: (groupId: string) => api<{ competitions: Competition[] }>(`/competitions?scope=group&groupId=${groupId}`).then((r) => r.competitions),
  create: (body: NewCompetition) => api<{ competition: Competition; problems: Problem[] }>('/competitions', { method: 'POST', body }),
  get: (id: string) => api<CompetitionView>(`/competitions/${id}`),
  update: (id: string, body: Partial<{ status: 'scheduled' | 'cancelled'; title: string; description: string; startsAt: string; endsAt: string }>) =>
    api<{ competition: Competition }>(`/competitions/${id}`, { method: 'PATCH', body }).then((r) => r.competition),
  register: (id: string, body: { teamId?: string; teamName?: string } = {}) => api<{ registration: { teamId: string | null; joinedAt: string } }>(`/competitions/${id}/register`, { method: 'POST', body }),
  active: (q: { labId?: string; checkId?: string }) =>
    api<{ active: Array<{ competitionId: string; title: string; ordinal: number; endsAt: string }> }>(`/competitions/active?${new URLSearchParams(q as Record<string, string>)}`).then((r) => r.active),
  submit: (id: string, body: { ordinal: number; passed: boolean; hintsUsed: number }) =>
    api<{ score: { points: number; solved: number; finishS: number } }>(`/competitions/${id}/submissions`, { method: 'POST', body }).then((r) => r.score),
  board: (id: string) => api<Board>(`/competitions/${id}/board`),
  myAwards: () => api<{ awards: Award[] }>('/me/awards').then((r) => r.awards),
};

/* ----------------------------------------------------------------------------- inbox, people */

export const inbox = {
  list: () => api<{ notifications: Notification[]; unread: number }>('/me/notifications'),
  markRead: (ids?: number[]) => api<void>('/me/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),
};

export const people = {
  get: (username: string) => api<PublicProfile>(`/people/${encodeURIComponent(username)}`),
  report: (body: { targetKind: 'thread' | 'post' | 'group_message' | 'dm' | 'resource' | 'profile'; targetId: string; reason: string }) => api<void>('/reports', { method: 'POST', body }),
};

export const AWARD_LABEL: Record<string, string> = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
  first_solve: 'First solve',
  most_helpful: 'Most helpful',
  top_contributor: 'Top contributor',
  tier: 'Tier',
  quest: 'Quest complete',
};

export const AWARD_GLYPH: Record<string, string> = {
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
  first_solve: '⚡',
  most_helpful: '🤝',
  top_contributor: '⭐',
  tier: '🏅',
  quest: '🧭',
};

/** "3 minutes ago", "yesterday", or a short date. */
export function timeAgo(isoDate: string): string {
  const diff = Date.now() - Date.parse(isoDate);
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(isoDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatWhen(isoDate: string): string {
  return new Date(isoDate).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "1h 02m 15s" style countdown. */
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}
