/**
 * The simulated git's saved state, real git object ids, and a helper that builds a repository for
 * a lab's starting files. A leaf module (it imports only the hash functions), so lab templates can
 * import it without loading the shell.
 *
 * Object ids are real: a blob's id is SHA-1 of "blob <size>\0<content>", trees and commits are
 * hashed from git's own object formats, so `git hash-object` and `git cat-file` agree with real git.
 */

import { sha1Bytes } from './hash.js';

export interface GitCommit {
  id: string;
  seq: number;
  parents: string[];
  message: string;
  author: string;
  email: string;
  /** Author date, ms since epoch. */
  time: number;
  tree: Record<string, string>;
  /** Committer, when different from the author (rebase, cherry-pick, amend). */
  committer?: string;
  cemail?: string;
  ctime?: number;
  /** Paths stored with mode 100755. */
  x?: string[];
}

export interface ReflogEntry {
  from: string | null;
  to: string;
  msg: string;
  time: number;
  who?: string;
}

export interface StashEntry {
  message: string;
  branch: string;
  base: string;
  index: Record<string, string>;
  work: Record<string, string>;
  untracked?: Record<string, string>;
  time: number;
}

export interface TodoItem {
  action: string;
  id?: string;
  msg?: string;
  cmd?: string;
}

/** A rebase, cherry-pick or revert that stopped part-way (conflict, edit, reword). */
export interface Sequencer {
  kind: 'rebase' | 'cherry-pick' | 'revert';
  todo: TodoItem[];
  done: TodoItem[];
  /** The commit being applied when it stopped. */
  current?: TodoItem;
  /** Rebase: the branch being rebased, where it started and what it is being replayed onto. */
  branch?: string;
  origHead: string;
  onto?: string;
  ontoName?: string;
  /** Message collected for a squash/fixup chain. */
  squashMsg?: string;
  /** The stop needs a new commit message (reword) or a manual amend (edit). */
  stop?: 'conflict' | 'edit' | 'reword';
  /** cherry-pick -x / revert -m and similar options. */
  opts?: { x?: boolean; mainline?: number; noCommit?: boolean };
  interactive?: boolean;
  /** --force-rebase / --no-ff: replay every commit even when it could be kept. */
  force?: boolean;
}

export interface Bisect {
  bad?: string;
  good: string[];
  skip: string[];
  orig: string;
  origBranch?: string;
  log: string[];
  terms?: { bad: string; good: string };
}

export interface GitState {
  head: { branch?: string; detached?: string };
  branches: Record<string, string | null>;
  commits: Record<string, GitCommit>;
  index: Record<string, string>;
  /** user.name and user.email as name/email; every other key as "section.key" (lower case). */
  config: { name?: string; email?: string; [key: string]: string | undefined };
  tags: Record<string, string>;
  merging?: { other: string; otherName: string; message?: string; squash?: boolean };
  /** Paths with an unresolved conflict, and what kind. */
  unmerged?: Record<string, string>;
  /** Objects written with hash-object -w: id -> content. */
  objects?: Record<string, string>;
  bare?: boolean;
  /** Executable paths in the index. */
  x?: string[];
  annotated?: Record<string, { message: string; tagger: string; email: string; time: number }>;
  reflogs?: Record<string, ReflogEntry[]>;
  stash?: StashEntry[];
  remotes?: Record<string, { url: string }>;
  /** Remote-tracking branches: "origin/main" -> commit. */
  remoteRefs?: Record<string, string>;
  upstream?: Record<string, { remote: string; merge: string }>;
  seq?: Sequencer;
  /** Commits whose parents were cut off by a shallow clone. */
  shallow?: string[];
  /** A partial clone: historical file contents stay on the remote until needed. */
  partial?: { remote: string; filter: string };
  bisect?: Bisect;
  /** rerere: conflict preimage -> recorded resolution. */
  rerere?: Record<string, string>;
  /** rerere: path -> preimage of a conflict still being resolved. */
  rerereOpen?: Record<string, string>;
  sparse?: string[];
  origHead?: string;
  fetchHead?: string;
}

export const STATE = '.git/state.json';
/** A bare repository keeps its state here instead of in .git. */
export const BARE_STATE = 'objects/state.json';

/* ----------------------------------------------------------------------------- object ids */

const enc = new TextEncoder();
const blobCache = new Map<string, string>();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function objectId(type: string, body: Uint8Array): string {
  return sha1Bytes(concat([enc.encode(`${type} ${body.length}\0`), body]));
}

export function blobId(content: string): string {
  let id = blobCache.get(content);
  if (!id) {
    id = objectId('blob', enc.encode(content));
    if (blobCache.size > 4000) blobCache.clear();
    blobCache.set(content, id);
  }
  return id;
}

function hexBytes(hex: string): Uint8Array {
  const b = new Uint8Array(20);
  for (let i = 0; i < 20; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree';
  id: string;
  name: string;
}

/** The entries of the tree at `dir` ('' for the root) of a flat path -> content map. */
export function treeEntries(tree: Record<string, string>, x: string[] | undefined, dir = ''): TreeEntry[] {
  const prefix = dir ? dir + '/' : '';
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.set(rest, p);
    else dirs.add(rest.slice(0, slash));
  }
  const out: TreeEntry[] = [];
  for (const [name, p] of files) out.push({ mode: x?.includes(p) ? '100755' : '100644', type: 'blob', id: blobId(tree[p]), name });
  for (const d of dirs) out.push({ mode: '040000', type: 'tree', id: treeId(tree, x, prefix + d), name: d });
  // git orders entries byte-wise, with directory names compared as if they ended in "/".
  return out.sort((a, b) => {
    const ka = a.type === 'tree' ? a.name + '/' : a.name;
    const kb = b.type === 'tree' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function treeId(tree: Record<string, string>, x: string[] | undefined, dir = ''): string {
  const parts: Uint8Array[] = [];
  for (const e of treeEntries(tree, x, dir)) parts.push(enc.encode(`${e.mode === '040000' ? '40000' : e.mode} ${e.name}\0`), hexBytes(e.id));
  return objectId('tree', concat(parts));
}

const stamp = (ms: number) => `${Math.floor(ms / 1000)} +0000`;

/** The text of a commit object, as `git cat-file -p` shows it. */
export function commitText(c: Omit<GitCommit, 'id' | 'seq'>): string {
  return `tree ${treeId(c.tree, c.x)}\n${c.parents.map((p) => `parent ${p}\n`).join('')}author ${c.author} <${c.email}> ${stamp(c.time)}\ncommitter ${c.committer ?? c.author} <${c.cemail ?? c.email}> ${stamp(c.ctime ?? c.time)}\n\n${c.message}\n`;
}

export function commitId(c: Omit<GitCommit, 'id' | 'seq'>): string {
  return objectId('commit', enc.encode(commitText(c)));
}

export function tagText(name: string, target: string, t: { message: string; tagger: string; email: string; time: number }): string {
  return `object ${target}\ntype commit\ntag ${name}\ntagger ${t.tagger} <${t.email}> ${stamp(t.time)}\n\n${t.message}\n`;
}

export function tagId(name: string, target: string, t: { message: string; tagger: string; email: string; time: number }): string {
  return objectId('tag', enc.encode(tagText(name, target, t)));
}

/** Kept for older callers: a 40-hex digest of any text. */
export function hashHex(text: string): string {
  return sha1Bytes(enc.encode(text));
}

/* ----------------------------------------------------------------------------- lab seeding */

export interface SeedCommit {
  message: string;
  author: string;
  email: string;
  /** Files this commit adds or changes; null deletes. */
  files: Record<string, string | null>;
  /** Days after 10 Oct 2026 (default: the commit's position). */
  day?: number;
  /** Hour of the day, UTC (default 10). */
  hour?: number;
}

export interface SeedOptions {
  /** Extra branches: name -> the index of the main-line commit they start from, and their own commits. */
  branches?: Record<string, { from: number; commits: SeedCommit[] }>;
  /** Branch checked out (default main). */
  checkout?: string;
  /** Paths stored as executable. */
  executable?: string[];
  /** A bare repository (a server-side copy), with no working tree. */
  bare?: boolean;
  /** Remote "origin" with this URL, and remote-tracking refs equal to the local branches. */
  origin?: string;
  /** Annotated tag messages (tag name -> message). */
  annotate?: Record<string, string>;
  /** Mode of the files written in the working tree for executable paths. */
  defaultBranch?: string;
}

/**
 * Files for a lab's starting state: a repository at `repo` whose history is `commits` (each one
 * changes the files it lists), checked out on main, with the working tree at the last commit.
 * Tags map a tag name to the index of the main-line commit it points at.
 */
export function seedRepo(repo: string, commits: SeedCommit[], tags: Record<string, number> = {}, opts: SeedOptions = {}): Record<string, string | { content: string; mode: string }> {
  const main = opts.defaultBranch ?? 'main';
  const st: GitState = { head: { branch: opts.checkout ?? main }, branches: {}, commits: {}, index: {}, config: {}, tags: {}, x: opts.executable ? [...opts.executable] : undefined };
  if (opts.bare) st.bare = true;
  let seq = 0;
  const build = (list: SeedCommit[], start: string | null, startTree: Record<string, string>, dayOffset: number): { ids: string[]; tree: Record<string, string> } => {
    let tree = { ...startTree };
    let parent = start;
    const ids: string[] = [];
    list.forEach((c, i) => {
      tree = { ...tree };
      for (const [p, v] of Object.entries(c.files)) {
        if (v === null) delete tree[p];
        else tree[p] = v;
      }
      seq++;
      const time = Date.UTC(2026, 9, 10 + (c.day ?? dayOffset + i), c.hour ?? 10, seq % 60);
      const x = opts.executable?.filter((p) => tree[p] !== undefined);
      const body = { parents: parent ? [parent] : [], message: c.message, author: c.author, email: c.email, time, tree: { ...tree }, ...(x?.length ? { x } : {}) };
      const id = commitId(body);
      st.commits[id] = { id, seq, ...body };
      parent = id;
      ids.push(id);
    });
    return { ids, tree };
  };
  const trunk = build(commits, null, {}, 0);
  st.branches[main] = trunk.ids[trunk.ids.length - 1] ?? null;
  const treeAt = (n: number) => st.commits[trunk.ids[n]].tree;
  for (const [name, b] of Object.entries(opts.branches ?? {})) {
    const r = build(b.commits, trunk.ids[b.from], treeAt(b.from), b.from + 1);
    st.branches[name] = r.ids[r.ids.length - 1] ?? trunk.ids[b.from];
  }
  for (const [t, n] of Object.entries(tags)) st.tags[t] = trunk.ids[n];
  if (opts.annotate) {
    st.annotated = {};
    for (const [t, message] of Object.entries(opts.annotate)) {
      const c = st.commits[st.tags[t]];
      st.annotated[t] = { message, tagger: c.author, email: c.email, time: c.time + 3600000 };
    }
  }
  const headId = st.branches[st.head.branch!]!;
  const headTree = headId ? st.commits[headId].tree : {};
  st.reflogs = { HEAD: [{ from: null, to: headId, msg: opts.origin ? `clone: from ${opts.origin}` : 'commit (initial): seeded history', time: st.commits[headId]?.time ?? 0 }] };
  if (opts.origin) {
    st.remotes = { origin: { url: opts.origin } };
    st.remoteRefs = {};
    st.upstream = {};
    for (const [b, id] of Object.entries(st.branches)) {
      if (id) st.remoteRefs[`origin/${b}`] = id;
      st.upstream[b] = { remote: 'origin', merge: b };
    }
    st.remoteRefs['origin/HEAD'] = st.branches[main]!;
  }
  const base = repo === '/' ? '' : repo;
  if (opts.bare) {
    return { [`${base}/${BARE_STATE}`]: JSON.stringify(st), [`${base}/HEAD`]: `ref: refs/heads/${main}\n`, [`${base}/config`]: '[core]\n\tbare = true\n', [`${base}/hooks/.keep`]: '', [`${base}/refs/heads/.keep`]: '' };
  }
  st.index = { ...headTree };
  if (opts.executable) st.x = opts.executable.filter((p) => headTree[p] !== undefined);
  const files: Record<string, string | { content: string; mode: string }> = { [`${base}/${STATE}`]: JSON.stringify(st), [`${base}/.git/HEAD`]: `ref: refs/heads/${st.head.branch}\n` };
  for (const [p, content] of Object.entries(headTree)) files[`${base}/${p}`] = opts.executable?.includes(p) ? { content, mode: '755' } : content;
  return files;
}
