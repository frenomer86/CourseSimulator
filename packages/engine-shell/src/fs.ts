/**
 * An in-memory Unix-like file system with owners, groups, mode bits and simple POSIX ACLs.
 * Everything is plain JSON so a lab's state can be saved and restored.
 */

export interface AclEntry {
  kind: 'user' | 'group';
  name: string;
  perms: string; // e.g. "rw-"
  /** A default ACL entry on a directory: inherited by new files and directories inside it. */
  def?: boolean;
}

/** ACL entries a new node inherits from its parent's default ACL (directories also keep the defaults). */
function inheritedAcl(parent: BaseNode, isDir: boolean): AclEntry[] | undefined {
  const defs = parent.acl?.filter((a) => a.def) ?? [];
  if (!defs.length) return undefined;
  return [...defs.map((a) => ({ kind: a.kind, name: a.name, perms: a.perms })), ...(isDir ? defs.map((a) => ({ ...a })) : [])];
}

interface BaseNode {
  mode: number;
  owner: string;
  group: string;
  mtime: number;
  acl?: AclEntry[];
}
export interface FileNode extends BaseNode {
  type: 'file';
  content: string;
}
export interface DirNode extends BaseNode {
  type: 'dir';
  children: Record<string, FsNode>;
}
export interface LinkNode extends BaseNode {
  type: 'link';
  target: string;
}
export type FsNode = FileNode | DirNode | LinkNode;

export class FsError extends Error {
  constructor(public code: 'ENOENT' | 'EACCES' | 'EISDIR' | 'ENOTDIR' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP', message: string) {
    super(message);
  }
}

export function normalise(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return '/' + parts.join('/');
}

export function resolvePath(cwd: string, path: string, home = '/root'): string {
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  return normalise(path.startsWith('/') ? path : `${cwd}/${path}`);
}

export function basename(path: string): string {
  const n = normalise(path);
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const n = normalise(path);
  if (n === '/') return '/';
  const i = n.lastIndexOf('/');
  return i === 0 ? '/' : n.slice(0, i);
}

export function mkdirNode(owner: string, group: string, mode = 0o755, mtime = 0): DirNode {
  return { type: 'dir', children: {}, mode, owner, group, mtime };
}
export function mkfileNode(content: string, owner: string, group: string, mode = 0o644, mtime = 0): FileNode {
  return { type: 'file', content, mode, owner, group, mtime };
}

/** Who is asking: used for permission checks. */
export interface Actor {
  user: string;
  groups: string[];
}

export function can(node: BaseNode, actor: Actor, perm: 'r' | 'w' | 'x'): boolean {
  if (actor.user === 'root') return true;
  const bit = perm === 'r' ? 4 : perm === 'w' ? 2 : 1;
  if (node.owner === actor.user) return ((node.mode >> 6) & bit) !== 0;
  // ACL entries for the user win over group bits.
  const userAcl = node.acl?.find((a) => !a.def && a.kind === 'user' && a.name === actor.user);
  if (userAcl) return userAcl.perms.includes(perm);
  const groupMatch = actor.groups.includes(node.group) ? ((node.mode >> 3) & bit) !== 0 : null;
  const groupAcls = node.acl?.filter((a) => !a.def && a.kind === 'group' && actor.groups.includes(a.name)) ?? [];
  if (groupMatch !== null || groupAcls.length) return groupMatch === true || groupAcls.some((a) => a.perms.includes(perm));
  return (node.mode & bit) !== 0;
}

export interface Lookup {
  node: FsNode;
  path: string; // resolved absolute path (after following links)
  parent: DirNode | null;
  name: string;
}

/** Finds a node, following symlinks, checking execute permission on each directory traversed. */
export function lookup(root: DirNode, path: string, actor: Actor, follow = true, depth = 0): Lookup | null {
  if (depth > 8) throw new FsError('ELOOP', 'Too many levels of symbolic links');
  const abs = normalise(path);
  if (abs === '/') return { node: root, path: '/', parent: null, name: '/' };
  const parts = abs.slice(1).split('/');
  let cur: DirNode = root;
  let curPath = '';
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    if (!can(cur, actor, 'x')) throw new FsError('EACCES', `${curPath || '/'}: Permission denied`);
    const child = cur.children[name];
    if (!child) return null;
    curPath += '/' + name;
    const last = i === parts.length - 1;
    if (child.type === 'link' && (follow || !last)) {
      const target = resolvePath(dirname(curPath), child.target);
      const rest = parts.slice(i + 1).join('/');
      return lookup(root, rest ? `${target}/${rest}` : target, actor, follow, depth + 1);
    }
    if (last) return { node: child, path: curPath, parent: cur, name };
    if (child.type !== 'dir') throw new FsError('ENOTDIR', `${curPath}: Not a directory`);
    cur = child;
  }
  return null;
}

export function readFile(root: DirNode, path: string, actor: Actor): string {
  const l = lookup(root, path, actor);
  if (!l) throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (l.node.type === 'dir') throw new FsError('EISDIR', `${path}: Is a directory`);
  if (l.node.type === 'link') throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (!can(l.node, actor, 'r')) throw new FsError('EACCES', `${path}: Permission denied`);
  return l.node.content;
}

/** Creates or overwrites a file. Needs w on the file (if it exists) or w+x on the directory. */
export function writeFile(root: DirNode, path: string, content: string, actor: Actor, now: number, append = false): void {
  const abs = normalise(path);
  const existing = lookup(root, abs, actor);
  if (existing) {
    if (existing.node.type === 'dir') throw new FsError('EISDIR', `${path}: Is a directory`);
    if (existing.node.type === 'link') throw new FsError('ENOENT', `${path}: No such file or directory`);
    if (!can(existing.node, actor, 'w')) throw new FsError('EACCES', `${path}: Permission denied`);
    existing.node.content = append ? existing.node.content + content : content;
    existing.node.mtime = now;
    return;
  }
  const parent = lookup(root, dirname(abs), actor);
  if (!parent) throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (parent.node.type !== 'dir') throw new FsError('ENOTDIR', `${dirname(abs)}: Not a directory`);
  if (!can(parent.node, actor, 'w')) throw new FsError('EACCES', `${path}: Permission denied`);
  // A setgid directory hands its group to new files.
  const group = parent.node.mode & 0o2000 ? parent.node.group : actor.groups[0] ?? actor.user;
  const created = mkfileNode(content, actor.user, group, 0o644 & ~currentUmask, now);
  const acl = inheritedAcl(parent.node, false);
  if (acl) created.acl = acl;
  parent.node.children[basename(abs)] = created;
  parent.node.mtime = now;
}

let currentUmask = 0o022;
export function setUmask(m: number): void {
  currentUmask = m;
}
export function getUmask(): number {
  return currentUmask;
}

export function mkdir(root: DirNode, path: string, actor: Actor, now: number, parents = false): void {
  const abs = normalise(path);
  if (abs === '/') throw new FsError('EEXIST', `${path}: File exists`);
  if (parents) {
    const parts = abs.slice(1).split('/');
    let p = '';
    for (const part of parts) {
      p += '/' + part;
      if (!lookup(root, p, actor)) mkdir(root, p, actor, now, false);
    }
    return;
  }
  if (lookup(root, abs, actor)) throw new FsError('EEXIST', `${path}: File exists`);
  const parent = lookup(root, dirname(abs), actor);
  if (!parent) throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (parent.node.type !== 'dir') throw new FsError('ENOTDIR', `${dirname(abs)}: Not a directory`);
  if (!can(parent.node, actor, 'w')) throw new FsError('EACCES', `${path}: Permission denied`);
  const setgid = (parent.node.mode & 0o2000) !== 0;
  const created = mkdirNode(actor.user, setgid ? parent.node.group : actor.groups[0] ?? actor.user, (0o777 & ~currentUmask) | (setgid ? 0o2000 : 0), now);
  const acl = inheritedAcl(parent.node, true);
  if (acl) created.acl = acl;
  parent.node.children[basename(abs)] = created;
  parent.node.mtime = now;
}

export function remove(root: DirNode, path: string, actor: Actor, recursive: boolean): void {
  const abs = normalise(path);
  const l = lookup(root, abs, actor, false);
  if (!l) throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (!l.parent) throw new FsError('EACCES', 'cannot remove /');
  if (l.node.type === 'dir') {
    if (!recursive) throw new FsError('EISDIR', `${path}: Is a directory`);
    if (!can(l.node, actor, 'w')) throw new FsError('EACCES', `${path}: Permission denied`);
  }
  if (!can(l.parent, actor, 'w')) throw new FsError('EACCES', `${path}: Permission denied`);
  if ((l.parent.mode & 0o1000) !== 0 && actor.user !== 'root' && l.node.owner !== actor.user && l.parent.owner !== actor.user) {
    throw new FsError('EACCES', `${path}: Operation not permitted`);
  }
  delete l.parent.children[l.name];
}

export function cloneNode(n: FsNode): FsNode {
  return JSON.parse(JSON.stringify(n)) as FsNode;
}

/** Copies a node to a new path (which must not exist); the copy belongs to the actor. */
export function copy(root: DirNode, from: string, to: string, actor: Actor, now: number, recursive: boolean): void {
  const src = lookup(root, from, actor);
  if (!src) throw new FsError('ENOENT', `${from}: No such file or directory`);
  if (src.node.type === 'dir' && !recursive) throw new FsError('EISDIR', `-r not specified; omitting directory '${from}'`);
  if (src.node.type === 'file' && !can(src.node, actor, 'r')) throw new FsError('EACCES', `${from}: Permission denied`);
  let dest = normalise(to);
  const existing = lookup(root, dest, actor);
  if (existing?.node.type === 'dir') dest = `${dest}/${basename(from)}`;
  const parent = lookup(root, dirname(dest), actor);
  if (!parent || parent.node.type !== 'dir') throw new FsError('ENOENT', `${dirname(dest)}: No such file or directory`);
  if (!can(parent.node, actor, 'w')) throw new FsError('EACCES', `${dest}: Permission denied`);
  const target = lookup(root, dest, actor);
  if (target && target.node.type !== 'dir' && !can(target.node, actor, 'w')) throw new FsError('EACCES', `${dest}: Permission denied`);
  const c = cloneNode(src.node);
  const stamp = (n: FsNode) => {
    n.owner = actor.user;
    n.group = actor.groups[0] ?? actor.user;
    n.mtime = now;
    if (n.type === 'dir') Object.values(n.children).forEach(stamp);
  };
  if (actor.user !== 'root') stamp(c);
  parent.node.children[basename(dest)] = c;
}

export function move(root: DirNode, from: string, to: string, actor: Actor, now: number): void {
  const src = lookup(root, from, actor, false);
  if (!src || !src.parent) throw new FsError('ENOENT', `${from}: No such file or directory`);
  if (!can(src.parent, actor, 'w')) throw new FsError('EACCES', `${from}: Permission denied`);
  let dest = normalise(to);
  const existing = lookup(root, dest, actor);
  if (existing?.node.type === 'dir') dest = `${dest}/${src.name}`;
  const parent = lookup(root, dirname(dest), actor);
  if (!parent || parent.node.type !== 'dir') throw new FsError('ENOENT', `${dirname(dest)}: No such file or directory`);
  if (!can(parent.node, actor, 'w')) throw new FsError('EACCES', `${dest}: Permission denied`);
  const node = src.node;
  delete src.parent.children[src.name];
  node.mtime = now;
  parent.node.children[basename(dest)] = node;
}

export function listDir(root: DirNode, path: string, actor: Actor): Array<{ name: string; node: FsNode }> {
  const l = lookup(root, path, actor);
  if (!l) throw new FsError('ENOENT', `${path}: No such file or directory`);
  if (l.node.type !== 'dir') return [{ name: basename(path), node: l.node }];
  if (!can(l.node, actor, 'r')) throw new FsError('EACCES', `${path}: Permission denied`);
  return Object.keys(l.node.children)
    .sort()
    .map((name) => ({ name, node: (l.node as DirNode).children[name] }));
}

export function modeString(node: FsNode): string {
  const t = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let s = t;
  for (let i = 8; i >= 0; i--) s += (node.mode >> i) & 1 ? bits[(8 - i) % 3] : '-';
  if (node.mode & 0o4000) s = s.slice(0, 3) + (node.mode & 0o100 ? 's' : 'S') + s.slice(4);
  if (node.mode & 0o2000) s = s.slice(0, 6) + (node.mode & 0o010 ? 's' : 'S') + s.slice(7);
  if (node.mode & 0o1000) s = s.slice(0, 9) + (node.mode & 0o001 ? 't' : 'T');
  return s + (node.acl?.length ? '+' : '');
}

/** Parses "755", "u+x", "g-w,o-rwx", "a+r", "+x", "o=r" against a current mode. */
export function parseMode(spec: string, current: number, isDir: boolean): number | null {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = current;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || 'a';
    const op = m[2];
    let bits = 0;
    const special = { s: 0, t: 0 };
    for (const ch of m[3]) {
      if (ch === 'r') bits |= 4;
      else if (ch === 'w') bits |= 2;
      else if (ch === 'x') bits |= 1;
      else if (ch === 'X') bits |= isDir || current & 0o111 ? 1 : 0;
      else if (ch === 's') special.s = 1;
      else if (ch === 't') special.t = 1;
    }
    const masks: number[] = [];
    if (who.includes('u') || who.includes('a')) masks.push(6);
    if (who.includes('g') || who.includes('a')) masks.push(3);
    if (who.includes('o') || who.includes('a')) masks.push(0);
    for (const shift of masks) {
      const m3 = bits << shift;
      if (op === '+') mode |= m3;
      else if (op === '-') mode &= ~m3;
      else mode = (mode & ~(7 << shift)) | m3;
    }
    if (special.s) {
      if (who.includes('u') || who === 'a') mode = op === '-' ? mode & ~0o4000 : mode | 0o4000;
      if (who.includes('g') || who === 'a') mode = op === '-' ? mode & ~0o2000 : mode | 0o2000;
    }
    if (special.t) mode = op === '-' ? mode & ~0o1000 : mode | 0o1000;
  }
  return mode;
}

/** Walks every node under a path (depth-first, parents first). */
export function walk(root: DirNode, path: string, actor: Actor, visit: (path: string, node: FsNode) => void): void {
  const l = lookup(root, path, actor);
  if (!l) throw new FsError('ENOENT', `${path}: No such file or directory`);
  const rec = (p: string, n: FsNode) => {
    visit(p, n);
    if (n.type === 'dir') {
      if (!can(n, actor, 'r')) return;
      for (const name of Object.keys(n.children).sort()) rec(p === '/' ? `/${name}` : `${p}/${name}`, n.children[name]);
    }
  };
  rec(normalise(path), l.node);
}

/** Expands a glob against the file system, relative to cwd. Returns null when nothing matched. */
export function glob(root: DirNode, cwd: string, pattern: string, actor: Actor, home: string): string[] | null {
  if (!/[*?[]/.test(pattern)) return null;
  const abs = pattern.startsWith('/') || pattern.startsWith('~');
  const full = resolvePath(cwd, pattern, home);
  const parts = full.slice(1).split('/');
  let candidates: string[] = ['/'];
  for (const part of parts) {
    const next: string[] = [];
    if (!/[*?[]/.test(part)) {
      for (const c of candidates) {
        const p = c === '/' ? `/${part}` : `${c}/${part}`;
        try {
          if (lookup(root, p, actor)) next.push(p);
        } catch {
          /* unreadable */
        }
      }
    } else {
      const re = new RegExp('^' + part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      for (const c of candidates) {
        let entries: Array<{ name: string }> = [];
        try {
          entries = listDir(root, c, actor);
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.name.startsWith('.') && !part.startsWith('.')) continue;
          if (re.test(e.name)) next.push(c === '/' ? `/${e.name}` : `${c}/${e.name}`);
        }
      }
    }
    candidates = next;
    if (!candidates.length) return null;
  }
  if (abs) return candidates;
  // Return paths relative to cwd, in the form the user typed (relative).
  const prefix = cwd === '/' ? '/' : cwd + '/';
  const dirPrefix = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/') + 1) : '';
  return candidates.map((c) => (c.startsWith(prefix) ? c.slice(prefix.length) : c)).map((c) => (dirPrefix && c.startsWith(dirPrefix) ? c : c));
}
