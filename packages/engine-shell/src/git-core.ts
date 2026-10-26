/**
 * The machinery under the simulated git: finding and saving repositories, configuration, identity,
 * revision syntax, the working tree and .gitignore, unified diffs, three-way merges, commits,
 * reflogs, hooks and the editor. commands-git.ts builds the porcelain on top of this.
 */

import { FsError, lookup, mkdir, readFile, remove, writeFile, type Actor, type DirNode } from './fs.js';
import { homeOf } from './system.js';
import { actor, currentUser, runCommand, type Ctx } from './shell.js';
import { abs, strftime, type IO } from './util.js';
import { materializePartial } from './git-remote.js';
import { BARE_STATE, STATE, blobId, commitId, treeId, type GitCommit, type GitState, type ReflogEntry } from './git-state.js';

export const ROOT: Actor = { user: 'root', groups: ['root'] };
export const short = (id: string) => id.slice(0, 7);
export const subject = (msg: string) => msg.split('\n')[0];
export const plural = (n: number, w: string, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;

export interface Repo {
  ctx: Ctx;
  io: IO;
  /** The working tree root, or the repository directory itself when bare. */
  root: string;
  gitDir: string;
  bare: boolean;
  st: GitState;
  /** A work tree outside the repository (--work-tree / GIT_WORK_TREE with a bare --git-dir). */
  separate?: boolean;
}

/** GIT_DIR and GIT_WORK_TREE as the environment (or --git-dir / --work-tree) set them. */
export function gitEnv(ctx: Ctx): { gitDir?: string; workTree?: string } {
  const v = (k: string) => (ctx.exported.has(k) ? ctx.vars[k] : undefined) || undefined;
  const gd = v('GIT_DIR');
  const wt = v('GIT_WORK_TREE');
  return { ...(gd ? { gitDir: abs(ctx, gd) } : {}), ...(wt ? { workTree: abs(ctx, wt) } : {}) };
}

/** Thrown to stop a git command with a message and exit status. */
export class GitExit extends Error {
  constructor(
    public text: string,
    public code = 128,
  ) {
    super(text);
  }
}
export const die = (text: string, code = 128): never => {
  throw new GitExit(text, code);
};

/* ----------------------------------------------------------------------------- locating repositories */

const join = (dir: string, p: string) => (dir === '/' ? '' : dir) + '/' + p;

export function isBareAt(ctx: Ctx, dir: string): boolean {
  return !!lookup(ctx.sys.fs, join(dir, BARE_STATE), ROOT) && !!lookup(ctx.sys.fs, join(dir, 'HEAD'), ROOT);
}

/** Finds the repository at or above `from`: a working tree with .git, or a bare repository directory. */
export function findRepo(ctx: Ctx, from = ctx.sys.cwd): string | null {
  const env = gitEnv(ctx);
  if (env.gitDir && from === ctx.sys.cwd) {
    const gd = env.gitDir.replace(/\/\.git$/, '');
    return lookup(ctx.sys.fs, join(gd, STATE), ROOT) || isBareAt(ctx, gd) ? gd : null;
  }
  let dir = from;
  for (;;) {
    if (lookup(ctx.sys.fs, join(dir, STATE), ROOT) || isBareAt(ctx, dir)) return dir;
    if (dir === '/') return null;
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
  }
}

export function loadGit(ctx: Ctx, repo: string): GitState {
  const bare = !lookup(ctx.sys.fs, join(repo, STATE), ROOT);
  const st = JSON.parse(readFile(ctx.sys.fs, join(repo, bare ? BARE_STATE : STATE), ROOT)) as GitState;
  if (bare) st.bare = true;
  return st;
}

export function openRepo(ctx: Ctx, io: IO, path: string): Repo {
  const bare = !lookup(ctx.sys.fs, join(path, STATE), ROOT);
  const env = gitEnv(ctx);
  // A bare repository checked out into a separate work tree (the classic deploy hook).
  if (bare && env.workTree && env.gitDir && env.gitDir.replace(/\/\.git$/, '') === path) {
    const st = loadGit(ctx, path);
    delete st.bare;
    return { ctx, io, root: env.workTree, gitDir: path, bare: false, st, separate: true };
  }
  return { ctx, io, root: path, gitDir: bare ? path : join(path, '.git'), bare, st: loadGit(ctx, path) };
}

export function headCommit(st: GitState): string | null {
  return st.head.branch !== undefined ? st.branches[st.head.branch] ?? null : st.head.detached ?? null;
}

export function ancestors(st: GitState, id: string | null | undefined, firstParent = false): Set<string> {
  const seen = new Set<string>();
  const stack = id ? [id] : [];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c) || !st.commits[c]) continue;
    seen.add(c);
    const ps = st.commits[c].parents.filter((p) => st.commits[p]);
    stack.push(...(firstParent ? ps.slice(0, 1) : ps));
  }
  return seen;
}

/* ----------------------------------------------------------------------------- saving */

function writeAs(ctx: Ctx, path: string, content: string, who: Actor): void {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  if (!lookup(ctx.sys.fs, dir, ROOT)) mkdir(ctx.sys.fs, dir, who, ctx.sys.now, true);
  writeFile(ctx.sys.fs, path, content, who, ctx.sys.now);
}

/** The text a real git keeps in .git/config, rebuilt from the state. */
function localConfigText(st: GitState): string {
  const sections = new Map<string, string[]>();
  const add = (sec: string, line: string) => {
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec)!.push(line);
  };
  add('[core]', '\trepositoryformatversion = 0');
  add('[core]', '\tfilemode = true');
  add('[core]', `\tbare = ${st.bare ? 'true' : 'false'}`);
  if (st.config.name) add('[user]', `\tname = ${st.config.name}`);
  if (st.config.email) add('[user]', `\temail = ${st.config.email}`);
  for (const [k, v] of Object.entries(st.config)) {
    if (k === 'name' || k === 'email' || v === undefined) continue;
    const parts = k.split('.');
    const key = parts.pop()!;
    const sec = parts.length > 1 ? `[${parts[0]} "${parts.slice(1).join('.')}"]` : `[${parts[0]}]`;
    add(sec, `\t${key} = ${v}`);
  }
  for (const [name, r] of Object.entries(st.remotes ?? {})) {
    add(`[remote "${name}"]`, `\turl = ${r.url}`);
    add(`[remote "${name}"]`, `\tfetch = +refs/heads/*:refs/remotes/${name}/*`);
  }
  for (const [b, u] of Object.entries(st.upstream ?? {})) {
    add(`[branch "${b}"]`, `\tremote = ${u.remote}`);
    add(`[branch "${b}"]`, `\tmerge = refs/heads/${u.merge}`);
  }
  return [...sections].map(([s, ls]) => `${s}\n${ls.join('\n')}\n`).join('');
}

export function reflogText(entries: ReflogEntry[] | undefined): string {
  return (entries ?? []).map((e) => `${e.from ?? '0'.repeat(40)} ${e.to} ${e.who ?? 'git'} ${Math.floor(e.time / 1000)} +0000\t${e.msg}\n`).join('');
}

/** Writes the state and the files a learner can inspect: HEAD, refs/, config, logs/HEAD. */
export function saveRepo(r: Repo, who: Actor = actor(r.ctx)): void {
  const { ctx, st, gitDir } = r;
  writeAs(ctx, r.separate ? join(gitDir, BARE_STATE) : join(r.root, r.bare ? BARE_STATE : STATE), JSON.stringify(r.separate ? { ...st, bare: true } : st), who);
  writeAs(ctx, join(gitDir, 'HEAD'), st.head.branch !== undefined ? `ref: refs/heads/${st.head.branch}\n` : `${st.head.detached}\n`, who);
  writeAs(ctx, join(gitDir, 'config'), localConfigText(st), who);
  try {
    remove(ctx.sys.fs, join(gitDir, 'refs'), ROOT, true);
  } catch {
    /* first save */
  }
  mkdir(ctx.sys.fs, join(gitDir, 'refs/heads'), who, ctx.sys.now, true);
  mkdir(ctx.sys.fs, join(gitDir, 'refs/tags'), who, ctx.sys.now, true);
  for (const [b, id] of Object.entries(st.branches)) if (id) writeAs(ctx, join(gitDir, `refs/heads/${b}`), id + '\n', who);
  for (const [t, id] of Object.entries(st.tags)) writeAs(ctx, join(gitDir, `refs/tags/${t}`), id + '\n', who);
  for (const [rb, id] of Object.entries(st.remoteRefs ?? {})) writeAs(ctx, join(gitDir, `refs/remotes/${rb}`), rb.endsWith('/HEAD') ? `ref: refs/remotes/${rb.replace(/HEAD$/, '')}${Object.entries(st.remoteRefs ?? {}).find(([k, v]) => v === id && !k.endsWith('/HEAD') && k.startsWith(rb.replace(/HEAD$/, '')))?.[0].split('/').slice(1).join('/') ?? 'main'}\n` : id + '\n', who);
  if (st.stash?.length) writeAs(ctx, join(gitDir, 'refs/stash'), stashId(st, 0) + '\n', who);
  // rerere keeps what it learned in rr-cache, one folder per conflict.
  for (const [key, resolution] of Object.entries(st.rerere ?? {})) writeAs(ctx, join(gitDir, `rr-cache/${key}/postimage`), resolution, who);
  for (const [path, key] of Object.entries(st.rerereOpen ?? {})) writeAs(ctx, join(gitDir, `rr-cache/${key}/preimage`), path + '\n', who);
  if (!r.bare) {
    writeAs(ctx, join(gitDir, 'logs/HEAD'), reflogText(st.reflogs?.HEAD), who);
    for (const name of ['ORIG_HEAD', 'MERGE_HEAD', 'FETCH_HEAD', 'CHERRY_PICK_HEAD']) {
      const v = name === 'ORIG_HEAD' ? st.origHead : name === 'MERGE_HEAD' ? st.merging?.other : name === 'FETCH_HEAD' ? st.fetchHead : st.seq?.kind === 'cherry-pick' ? st.seq.current?.id : undefined;
      const p = join(gitDir, name);
      if (v) writeAs(ctx, p, v + '\n', who);
      else if (lookup(ctx.sys.fs, p, ROOT)) remove(ctx.sys.fs, p, ROOT, false);
    }
  }
}

export function stashId(st: GitState, n: number): string {
  const s = st.stash![n];
  return commitId({ parents: [s.base], message: s.message, author: 'stash', email: '', time: s.time, tree: s.work });
}

/* ----------------------------------------------------------------------------- configuration */

/** Parses git's INI format into "section.key" (or "section.sub.key") -> value. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let sec = '';
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s[#;].*$/, '').trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const s = /^\[\s*([\w.-]+)(?:\s+"([^"]*)")?\s*\]$/.exec(l);
    if (s) {
      sec = s[1].toLowerCase() + (s[2] !== undefined ? '.' + s[2] : '');
      continue;
    }
    const kv = /^([\w-]+)\s*(?:=\s*(.*))?$/.exec(l);
    if (kv && sec) out[`${sec}.${kv[1].toLowerCase()}`] = (kv[2] ?? 'true').replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function iniText(map: Record<string, string>): string {
  const sections = new Map<string, string[]>();
  for (const [k, v] of Object.entries(map)) {
    const parts = k.split('.');
    const key = parts.pop()!;
    const sec = parts.length > 1 ? `[${parts[0]} "${parts.slice(1).join('.')}"]` : `[${parts[0]}]`;
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec)!.push(`\t${key} = ${v}`);
  }
  return [...sections].map(([s, ls]) => `${s}\n${ls.join('\n')}\n`).join('');
}

/** Normalises a config key: section and key lower case, a subsection kept as written. */
export function normKey(key: string): string {
  const parts = key.split('.');
  if (parts.length < 2) return key.toLowerCase();
  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();
  return [first, ...parts.slice(1, -1), last].join('.');
}

export function globalConfigPath(ctx: Ctx): string {
  return `${homeOf(ctx.sys, currentUser(ctx))}/.gitconfig`;
}

export function readConfigFile(ctx: Ctx, path: string): Record<string, string> {
  try {
    return parseIni(readFile(ctx.sys.fs, path, actor(ctx)));
  } catch {
    return {};
  }
}

/** A config value: repository, then ~/.gitconfig, then /etc/gitconfig. */
export function configGet(ctx: Ctx, st: GitState | null, key: string): string | undefined {
  const k = normKey(key);
  const env = (n: string) => (ctx.exported.has(n) ? ctx.vars[n] : undefined);
  // GIT_CONFIG_PARAMETERS is how `git -c key=value` reaches subcommands.
  const params = env('GIT_CONFIG_PARAMETERS');
  if (params) {
    for (const p of params.split('\u0001')) {
      const eq = p.indexOf('=');
      if (eq > 0 && normKey(p.slice(0, eq)) === k) return p.slice(eq + 1);
    }
  }
  if (st) {
    if (k === 'user.name' && st.config.name) return st.config.name;
    if (k === 'user.email' && st.config.email) return st.config.email;
    const rm = /^remote\.(.+)\.url$/.exec(k);
    if (rm && st.remotes?.[rm[1]]) return st.remotes[rm[1]].url;
    const bm = /^branch\.(.+)\.(remote|merge)$/.exec(k);
    if (bm && st.upstream?.[bm[1]]) return bm[2] === 'remote' ? st.upstream[bm[1]].remote : `refs/heads/${st.upstream[bm[1]].merge}`;
    if (st.config[k] !== undefined) return st.config[k];
  }
  const g = readConfigFile(ctx, globalConfigPath(ctx))[k];
  if (g !== undefined) return g;
  return readConfigFile(ctx, '/etc/gitconfig')[k];
}

export const truthy = (v: string | undefined) => v !== undefined && /^(true|yes|on|1)$/i.test(v);

export function envOf(ctx: Ctx, name: string): string | undefined {
  return ctx.exported.has(name) ? ctx.vars[name] : ctx.sys.env[name];
}

/* ----------------------------------------------------------------------------- identity and time */

export interface Person {
  name: string;
  email: string;
  time: number;
}

export function latestTime(st: GitState): number {
  let t = 0;
  for (const c of Object.values(st.commits)) t = Math.max(t, c.ctime ?? c.time, c.time);
  for (const e of st.reflogs?.HEAD ?? []) t = Math.max(t, e.time);
  return t;
}

/** The next timestamp: the simulated clock, but always after everything already in the repository. */
export function nextTime(r: Repo): number {
  return Math.max(r.ctx.sys.now, latestTime(r.st) + 60000);
}

export function parseGitDate(s: string | undefined, now: number): number | null {
  if (!s) return null;
  const t = s.trim();
  const unix = /^@?(\d{9,11})(?:\s+[+-]\d{4})?$/.exec(t);
  if (unix) return Number(unix[1]) * 1000;
  const rel = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(t);
  if (rel) {
    const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[rel[2].toLowerCase()]!;
    return now - Number(rel[1]) * unit * 1000;
  }
  if (/^yesterday$/i.test(t)) return now - 86400000;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (iso) {
    const ms = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0));
    const tz = iso[7] && iso[7] !== 'Z' ? /([+-])(\d{2}):?(\d{2})/.exec(iso[7]) : null;
    return tz ? ms - (tz[1] === '+' ? 1 : -1) * (Number(tz[2]) * 60 + Number(tz[3])) * 60000 : ms;
  }
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : d;
}

/** Author or committer identity, from the environment or configuration; dies like git when unset. */
export function ident(r: Repo, role: 'author' | 'committer'): Person {
  const E = role === 'author' ? 'AUTHOR' : 'COMMITTER';
  const name = envOf(r.ctx, `GIT_${E}_NAME`) ?? configGet(r.ctx, r.st, 'user.name');
  const email = envOf(r.ctx, `GIT_${E}_EMAIL`) ?? configGet(r.ctx, r.st, 'user.email');
  if (!name || !email)
    die(`Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address (got '${currentUser(r.ctx)}@${r.ctx.sys.hostname}.(none)')`);
  const time = parseGitDate(envOf(r.ctx, `GIT_${E}_DATE`), r.ctx.sys.now) ?? nextTime(r);
  return { name: name!, email: email!, time };
}

/* ----------------------------------------------------------------------------- revisions */

export function branchOfRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/** Resolves a name without suffixes: HEAD, branches, tags, remote-tracking refs, abbreviated ids. */
function resolveName(r: Repo, name: string): string | null {
  const st = r.st;
  if (name === 'HEAD' || name === '@') return headCommit(st);
  if (name === 'ORIG_HEAD') return st.origHead ?? null;
  if (name === 'MERGE_HEAD') return st.merging?.other ?? null;
  if (name === 'FETCH_HEAD') return st.fetchHead ?? null;
  if (name === 'CHERRY_PICK_HEAD' || name === 'REBASE_HEAD' || name === 'REVERT_HEAD') return st.seq?.current?.id ?? null;
  const n = name.replace(/^refs\/heads\//, '');
  if (st.branches[n] !== undefined && !name.startsWith('refs/tags/') && !name.startsWith('refs/remotes/')) return st.branches[n];
  const t = name.replace(/^refs\/tags\//, '');
  if (st.tags[t]) return st.tags[t];
  const rr = name.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  if (st.remoteRefs?.[rr]) return st.remoteRefs[rr];
  if (st.remotes?.[rr] && st.remoteRefs?.[`${rr}/HEAD`]) return st.remoteRefs[`${rr}/HEAD`];
  if (/^[0-9a-f]{4,40}$/.test(name)) {
    const hits = Object.keys(st.commits).filter((id) => id.startsWith(name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) die(`error: short object ID ${name} is ambiguous\nfatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`);
  }
  return null;
}

/** The previous branch: `@{-1}` from the checkout entries of the reflog. */
function previousBranch(st: GitState, n: number): string | null {
  const moves = (st.reflogs?.HEAD ?? []).map((e) => /^checkout: moving from (\S+) to (\S+)$/.exec(e.msg)).filter((m): m is RegExpExecArray => !!m);
  const m = moves[moves.length - n];
  return m ? m[1] : null;
}

/** git's revision syntax: names, ~n, ^n, @{n}, @{u}, @{-n}, :/text and X^{}. */
export function rev(r: Repo, spec: string): string | null {
  const st = r.st;
  let s = spec;
  if (s.startsWith(':/')) {
    const re = new RegExp(s.slice(2));
    const list = [...ancestors(st, headCommit(st))].map((id) => st.commits[id]).sort((a, b) => (b.ctime ?? b.time) - (a.ctime ?? a.time) || b.seq - a.seq);
    return list.find((c) => re.test(c.message))?.id ?? null;
  }
  s = s.replace(/\^\{(commit)?\}$/, '');
  const m = /^(.*?)((?:@\{[^}]*\}|[~^]\d*)*)$/.exec(s)!;
  let base = m[1];
  let ops = m[2];
  let id: string | null;
  const at = /^@\{([^}]*)\}/.exec(ops);
  if (at && (base === '' || base === 'HEAD' || base === '@' || st.branches[base] !== undefined)) {
    ops = ops.slice(at[0].length);
    const what = at[1];
    const b = base === '' || base === '@' ? (what.startsWith('-') ? '' : st.head.branch ?? 'HEAD') : base;
    if (/^-\d+$/.test(what)) {
      const pb = previousBranch(st, Number(what.slice(1)));
      if (!pb) return null;
      id = resolveName(r, pb);
    } else if (/^(u|upstream|push)$/i.test(what)) {
      const u = st.upstream?.[b];
      if (!u) die(`fatal: no upstream configured for branch '${b}'`);
      id = st.remoteRefs?.[`${u!.remote}/${u!.merge}`] ?? null;
    } else if (/^\d+$/.test(what)) {
      const log = (base === '' || base === 'HEAD' || base === '@' ? st.reflogs?.HEAD : st.reflogs?.[`refs/heads/${b}`]) ?? [];
      const e = log[log.length - 1 - Number(what)];
      if (!e) die(`fatal: log for '${base || 'HEAD'}' only has ${log.length} entries`);
      id = e!.to;
    } else {
      const when = parseGitDate(what, r.ctx.sys.now);
      const log = st.reflogs?.HEAD ?? [];
      id = [...log].reverse().find((e) => when !== null && e.time <= when)?.to ?? null;
    }
  } else {
    if (base === '') base = 'HEAD';
    id = resolveName(r, base);
  }
  const opRe = /([~^])(\d*)/g;
  let o: RegExpExecArray | null;
  while (id && (o = opRe.exec(ops))) {
    const n = o[2] === '' ? 1 : Number(o[2]);
    const c: GitCommit | undefined = st.commits[id];
    if (!c) return null;
    if (o[1] === '~') {
      for (let k = 0; k < n && id; k++) id = st.commits[id]?.parents.find((p) => st.commits[p]) ?? null;
    } else if (n === 0) continue;
    else id = c.parents[n - 1] && st.commits[c.parents[n - 1]] ? c.parents[n - 1] : null;
  }
  return id;
}

export function mustRev(r: Repo, spec: string, what = 'revision'): string {
  const id = rev(r, spec);
  if (!id) die(what === 'revision' ? `fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'` : `fatal: ${what}`);
  return id!;
}

export function isRev(r: Repo, spec: string): boolean {
  try {
    return rev(r, spec) !== null;
  } catch {
    return false;
  }
}

/** The commits a range selects: "A..B", "A...B", "^A B", "B" (with --not handled by the caller). */
export function selectCommits(r: Repo, specs: string[], all = false): string[] {
  const st = r.st;
  const include = new Set<string>();
  const exclude = new Set<string>();
  const tips: string[] = [];
  const nots: string[] = [];
  for (const s of specs) {
    const sym = /^(.*)\.\.\.(.*)$/.exec(s);
    const dot = /^(.*)\.\.(.*)$/.exec(s);
    if (sym) {
      const a = mustRev(r, sym[1] || 'HEAD');
      const b = mustRev(r, sym[2] || 'HEAD');
      const aa = ancestors(st, a);
      const bb = ancestors(st, b);
      for (const c of aa) if (!bb.has(c)) include.add(c);
      for (const c of bb) if (!aa.has(c)) include.add(c);
    } else if (dot) {
      nots.push(mustRev(r, dot[1] || 'HEAD'));
      tips.push(mustRev(r, dot[2] || 'HEAD'));
    } else if (s.startsWith('^')) nots.push(mustRev(r, s.slice(1)));
    else tips.push(mustRev(r, s));
  }
  if (all) {
    for (const id of Object.values(st.branches)) if (id) tips.push(id);
    for (const id of Object.values(st.tags)) tips.push(id);
    for (const [k, id] of Object.entries(st.remoteRefs ?? {})) if (!k.endsWith('/HEAD')) tips.push(id);
    const h = headCommit(st);
    if (h) tips.push(h);
  }
  if (!specs.length && !all) {
    const h = headCommit(st);
    if (h) tips.push(h);
  }
  for (const n of nots) for (const c of ancestors(st, n)) exclude.add(c);
  for (const t of tips) for (const c of ancestors(st, t)) include.add(c);
  return [...include].filter((c) => !exclude.has(c));
}

/** Newest first by commit date, but never a parent before its child (git's default walk). */
export function orderCommits(st: GitState, ids: string[], topo = false): string[] {
  const set = new Set(ids);
  const t = (id: string) => st.commits[id].ctime ?? st.commits[id].time;
  const byDate = [...ids].sort((a, b) => t(b) - t(a) || st.commits[b].seq - st.commits[a].seq);
  if (!topo) return byDate;
  const children = new Map<string, number>();
  for (const id of ids) for (const p of st.commits[id].parents) if (set.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const ready = byDate.filter((id) => !children.get(id));
  const out: string[] = [];
  while (ready.length) {
    // Keep a line of history together: prefer the first parent of what was just shown.
    const last = out[out.length - 1];
    let k = last ? ready.indexOf(st.commits[last].parents[0]) : -1;
    if (k === -1) k = 0;
    const id = ready.splice(k, 1)[0];
    out.push(id);
    for (const p of st.commits[id].parents) {
      if (!set.has(p)) continue;
      const n = (children.get(p) ?? 1) - 1;
      children.set(p, n);
      if (n === 0) {
        ready.push(p);
        ready.sort((a, b) => t(b) - t(a) || st.commits[b].seq - st.commits[a].seq);
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------- trees */

/** Marks a file content a partial clone has not fetched yet (see git-remote materializePartial). */
export const PROMISED = '\u0000promised:';

export function treeOf(r: Repo, id: string | null | undefined): Record<string, string> {
  if (!id || !r.st.commits[id]) return {};
  const c = r.st.commits[id];
  return r.st.partial ? materializePartial(r, c.tree) : c.tree;
}
export function execOf(r: Repo, id: string | null | undefined): string[] {
  return (id && r.st.commits[id]?.x) || [];
}
export function headTree(r: Repo): Record<string, string> {
  return treeOf(r, headCommit(r.st));
}

/* ----------------------------------------------------------------------------- working tree and .gitignore */

export interface Work {
  files: Record<string, string>;
  exec: Set<string>;
}

export function workTree(r: Repo): Work {
  const files: Record<string, string> = {};
  const exec = new Set<string>();
  if (r.bare) return { files, exec };
  const start = lookup(r.ctx.sys.fs, r.root, ROOT);
  if (!start || start.node.type !== 'dir') return { files, exec };
  const visit = (node: DirNode, rel: string) => {
    for (const [name, child] of Object.entries(node.children)) {
      if (!rel && name === '.git') continue;
      const p = rel ? `${rel}/${name}` : name;
      if (child.type === 'dir') visit(child, p);
      else if (child.type === 'file') {
        files[p] = child.content;
        if (child.mode & 0o100) exec.add(p);
      } else if (child.type === 'link') files[p] = child.target;
    }
  };
  visit(start.node as DirNode, '');
  // Files outside a sparse checkout are not in the working tree but are not deleted either.
  if (r.st.sparse) for (const p of Object.keys(r.st.index)) if (!inSparse(r.st, p) && files[p] === undefined) files[p] = r.st.index[p];
  return { files, exec };
}

export function inSparse(st: GitState, p: string): boolean {
  if (!st.sparse) return true;
  if (!p.includes('/')) return true;
  return st.sparse.some((d) => p === d || p.startsWith(d.replace(/\/$/, '') + '/'));
}

interface IgnoreRule {
  base: string;
  re: RegExp;
  neg: boolean;
  dirOnly: boolean;
  src: string;
  line: number;
  text: string;
}

function ruleRegex(pat: string): { re: RegExp; dirOnly: boolean } {
  let p = pat;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\//, '');
  let rx = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        rx += '(?:.*/)?';
        i += 2;
      } else {
        rx += '.*';
        i++;
      }
    } else if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i);
      if (end === -1) rx += '\\[';
      else {
        rx += '[' + p.slice(i + 1, end).replace(/^!/, '^') + ']';
        i = end;
      }
    } else if (c === '\\' && i + 1 < p.length) rx += '\\' + p[++i];
    else rx += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return { re: new RegExp(anchored ? `^${rx}$` : `(?:^|/)${rx}$`), dirOnly };
}

function ignoreRules(r: Repo, files: Record<string, string>): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const addFrom = (text: string, base: string, src: string) => {
    text.split('\n').forEach((raw, k) => {
      const l = raw.replace(/\s+$/, '');
      if (!l || l.startsWith('#')) return;
      const neg = l.startsWith('!');
      const body = neg ? l.slice(1) : l;
      const { re, dirOnly } = ruleRegex(body);
      rules.push({ base, re, neg, dirOnly, src, line: k + 1, text: l });
    });
  };
  const excludesFile = configGet(r.ctx, r.st, 'core.excludesfile') ?? `${homeOf(r.ctx.sys, currentUser(r.ctx))}/.config/git/ignore`;
  try {
    addFrom(readFile(r.ctx.sys.fs, excludesFile.replace(/^~/, homeOf(r.ctx.sys, currentUser(r.ctx))), ROOT), '', excludesFile);
  } catch {
    /* none */
  }
  try {
    addFrom(readFile(r.ctx.sys.fs, join(r.gitDir, 'info/exclude'), ROOT), '', '.git/info/exclude');
  } catch {
    /* none */
  }
  const gi = Object.keys(files).filter((p) => p === '.gitignore' || p.endsWith('/.gitignore')).sort((a, b) => a.split('/').length - b.split('/').length);
  for (const p of gi) addFrom(files[p], p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', p);
  return rules;
}

/** Which of `paths` .gitignore excludes, and the rule that decided each (for check-ignore -v). */
export function ignoreCheck(r: Repo, files: Record<string, string>, paths: string[]): Map<string, IgnoreRule | null> {
  const rules = ignoreRules(r, files);
  const out = new Map<string, IgnoreRule | null>();
  const decide = (p: string, isDir: boolean): IgnoreRule | null => {
    let hit: IgnoreRule | null = null;
    for (const rule of rules) {
      if (rule.base && !(p === rule.base || p.startsWith(rule.base + '/'))) continue;
      const relp = rule.base ? p.slice(rule.base.length + 1) : p;
      if (!relp) continue;
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(relp)) hit = rule;
    }
    return hit && !hit.neg ? hit : null;
  };
  for (const p of paths) {
    const parts = p.split('/');
    let found: IgnoreRule | null = null;
    for (let k = 1; k < parts.length && !found; k++) found = decide(parts.slice(0, k).join('/'), true);
    if (!found) found = decide(p, false);
    out.set(p, found);
  }
  return out;
}

export function untrackedFiles(r: Repo, w: Work, includeIgnored = false): { untracked: string[]; ignored: string[] } {
  const cand = Object.keys(w.files).filter((p) => r.st.index[p] === undefined).sort();
  const ig = ignoreCheck(r, w.files, cand);
  return { untracked: cand.filter((p) => includeIgnored || !ig.get(p)), ignored: cand.filter((p) => ig.get(p)) };
}

/** Writes files into the working tree (with executable modes) and removes others. */
export function writeWorking(r: Repo, files: Record<string, string>, removePaths: string[], exec: string[] = []): void {
  const a = actor(r.ctx);
  const base = r.root === '/' ? '' : r.root;
  for (const p of removePaths) {
    try {
      remove(r.ctx.sys.fs, `${base}/${p}`, a, false);
      // Remove directories that became empty, as git does.
      let dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      while (dir) {
        const l = lookup(r.ctx.sys.fs, `${base}/${dir}`, ROOT);
        if (!l || l.node.type !== 'dir' || Object.keys(l.node.children).length) break;
        remove(r.ctx.sys.fs, `${base}/${dir}`, a, true);
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      }
    } catch {
      /* already gone */
    }
  }
  for (const [p, content] of Object.entries(files)) {
    if (!inSparse(r.st, p)) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir) mkdir(r.ctx.sys.fs, `${base}/${dir}`, a, r.ctx.sys.now, true);
    writeFile(r.ctx.sys.fs, `${base}/${p}`, content, a, r.ctx.sys.now);
    const l = lookup(r.ctx.sys.fs, `${base}/${p}`, ROOT);
    if (l && l.node.type === 'file') l.node.mode = exec.includes(p) ? l.node.mode | 0o111 : l.node.mode & ~0o111;
  }
}

/** Replaces the working tree's tracked files with `tree` (files tracked now but absent there are removed). */
export function checkoutTree(r: Repo, from: Record<string, string>, to: Record<string, string>, toX: string[], keep: string[] = []): void {
  const write: Record<string, string> = {};
  for (const [p, c] of Object.entries(to)) if (!keep.includes(p)) write[p] = c;
  writeWorking(
    r,
    write,
    Object.keys(from).filter((p) => to[p] === undefined && !keep.includes(p)),
    toX,
  );
}

/* ----------------------------------------------------------------------------- diff */

function splitLines(s: string): string[] {
  if (s === '') return [];
  const out = s.split('\n').map((l) => l + '\n');
  if (s.endsWith('\n')) out.pop();
  else out[out.length - 1] = out[out.length - 1].slice(0, -1);
  return out;
}

export interface Edit {
  op: ' ' | '-' | '+';
  line: string;
}

/** Line edits from a to b (longest common subsequence). */
export function lineEdits(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  // Trim the common head and tail first: most edits touch a few lines of a longer file.
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const x = a.slice(pre, n - suf);
  const y = b.slice(pre, m - suf);
  const out: Edit[] = a.slice(0, pre).map((line) => ({ op: ' ' as const, line }));
  if (x.length * y.length > 4_000_000) {
    out.push(...x.map((line) => ({ op: '-' as const, line })), ...y.map((line) => ({ op: '+' as const, line })));
  } else {
    const L: Uint32Array[] = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        out.push({ op: ' ', line: x[i++] });
        j++;
      } else if (i < x.length && (j >= y.length || L[i + 1][j] >= L[i][j + 1])) out.push({ op: '-', line: x[i++] });
      else out.push({ op: '+', line: y[j++] });
    }
  }
  out.push(...a.slice(n - suf).map((line) => ({ op: ' ' as const, line })));
  return out;
}

/** Unified diff hunks (without the file header). */
export function hunks(a: string, b: string, context = 3): string[] {
  const edits = lineEdits(splitLines(a), splitLines(b));
  const out: string[] = [];
  const changed = edits.map((e) => e.op !== ' ');
  let k = 0;
  while (k < edits.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // Extend while the next change is within 2*context lines.
    for (;;) {
      while (end < edits.length && changed[end]) end++;
      let next = end;
      while (next < edits.length && !changed[next]) next++;
      if (next < edits.length && next - end <= context * 2) end = next;
      else break;
    }
    const stop = Math.min(edits.length, end + context);
    let aStart = 0;
    let bStart = 0;
    for (let q = 0; q < start; q++) {
      if (edits[q].op !== '+') aStart++;
      if (edits[q].op !== '-') bStart++;
    }
    const slice = edits.slice(start, stop);
    const aLen = slice.filter((e) => e.op !== '+').length;
    const bLen = slice.filter((e) => e.op !== '-').length;
    const range = (s: number, len: number) => (len === 1 ? `${s + 1}` : `${len === 0 ? s : s + 1},${len}`);
    out.push(`@@ -${range(aStart, aLen)} +${range(bStart, bLen)} @@`);
    for (const e of slice) {
      out.push(e.op + e.line.replace(/\n$/, ''));
      if (!e.line.endsWith('\n')) out.push('\\ No newline at end of file');
    }
    k = stop;
    start = stop;
  }
  return out;
}

export function countChanges(a: string, b: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const e of lineEdits(splitLines(a), splitLines(b))) {
    if (e.op === '+') add++;
    else if (e.op === '-') del++;
  }
  return { add, del };
}

export interface DiffOpts {
  paths?: string[];
  stat?: boolean;
  numstat?: boolean;
  shortstat?: boolean;
  nameOnly?: boolean;
  nameStatus?: boolean;
  patch?: boolean;
  context?: number;
  quiet?: boolean;
  /** --diff-filter letters: A added, M modified, D deleted (lower case excludes). */
  filter?: string;
}

export const pathMatch = (p: string, specs: string[] | undefined) => {
  if (!specs?.length) return true;
  return specs.some((q) => {
    if (q === '' || q === '.') return true;
    if (/[*?[]/.test(q)) {
      const rx = new RegExp('^' + q.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0000/g, '.*') + '$');
      return rx.test(p) || rx.test(p.split('/').pop()!);
    }
    return p === q || p.startsWith(q.replace(/\/$/, '') + '/');
  });
};

/** Prints a diff between two trees in the format the options ask for. Returns the number of files that differ. */
export function printTreeDiff(io: IO, from: Record<string, string>, fromX: string[], to: Record<string, string>, toX: string[], o: DiffOpts = {}): number {
  const status = (p: string) => (from[p] === undefined ? 'A' : to[p] === undefined ? 'D' : 'M');
  const keep = (p: string) => !o.filter || (/[A-Z]/.test(o.filter) ? o.filter.includes(status(p)) : !o.filter.includes(status(p).toLowerCase()));
  const all = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().filter((p) => pathMatch(p, o.paths) && (from[p] !== to[p] || fromX.includes(p) !== toX.includes(p)) && keep(p));
  if (o.quiet) return all.length;
  if (o.nameOnly) {
    for (const p of all) io.out(p + '\n');
    return all.length;
  }
  if (o.nameStatus) {
    for (const p of all) io.out(`${from[p] === undefined ? 'A' : to[p] === undefined ? 'D' : 'M'}\t${p}\n`);
    return all.length;
  }
  const counts = all.map((p) => ({ p, ...countChanges(from[p] ?? '', to[p] ?? '') }));
  if (o.numstat) {
    for (const c of counts) io.out(`${c.add}\t${c.del}\t${c.p}\n`);
    return all.length;
  }
  if (o.stat || o.shortstat) {
    if (o.stat) {
      const w = Math.max(...counts.map((c) => c.p.length), 0);
      const maxN = Math.max(...counts.map((c) => c.add + c.del), 0);
      const scale = maxN > 50 ? 50 / maxN : 1;
      for (const c of counts) {
        const n = c.add + c.del;
        io.out(` ${c.p.padEnd(w)} | ${String(n).padStart(String(maxN).length)} ${'+'.repeat(Math.round(c.add * scale))}${'-'.repeat(Math.round(c.del * scale))}\n`);
      }
    }
    if (all.length) {
      const ins = counts.reduce((s, c) => s + c.add, 0);
      const del = counts.reduce((s, c) => s + c.del, 0);
      io.out(` ${plural(all.length, 'file')} changed${ins ? `, ${ins} insertion${ins === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}\n`);
    }
    if (!o.patch) return all.length;
    io.out('\n');
  }
  for (const p of all) {
    const a = from[p];
    const b = to[p];
    const am = fromX.includes(p) ? '100755' : '100644';
    const bm = toX.includes(p) ? '100755' : '100644';
    io.out(`diff --git a/${p} b/${p}\n`);
    if (a === undefined) io.out(`new file mode ${bm}\nindex 0000000..${short(blobId(b!))}\n`);
    else if (b === undefined) io.out(`deleted file mode ${am}\nindex ${short(blobId(a))}..0000000\n`);
    else {
      if (am !== bm) io.out(`old mode ${am}\nnew mode ${bm}\n`);
      if (a !== b) io.out(`index ${short(blobId(a))}..${short(blobId(b))}${am === bm ? ' ' + am : ''}\n`);
    }
    if (a === b) continue;
    io.out(a === undefined ? '--- /dev/null\n' : `--- a/${p}\n`);
    io.out(b === undefined ? '+++ /dev/null\n' : `+++ b/${p}\n`);
    for (const l of hunks(a ?? '', b ?? '', o.context ?? 3)) io.out(l + '\n');
  }
  return all.length;
}

/* ----------------------------------------------------------------------------- three-way merge */

export interface MergeLabels {
  ours: string;
  theirs: string;
  base?: string;
}

/** Matches base lines to other lines (LCS): base index -> other index. */
function matchMap(base: string[], other: string[]): Map<number, number> {
  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  for (const e of lineEdits(base, other)) {
    if (e.op === ' ') map.set(i++, j++);
    else if (e.op === '-') i++;
    else j++;
  }
  return map;
}

/** diff3: merges two edits of `base` line by line; conflicting regions get conflict markers. */
export function merge3(base: string, ours: string, theirs: string, labels: MergeLabels, style: 'merge' | 'diff3' = 'merge'): { text: string; conflicts: number } {
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (ours === base) return { text: theirs, conflicts: 0 };
  if (theirs === base) return { text: ours, conflicts: 0 };
  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);
  const mo = matchMap(B, O);
  const mt = matchMap(B, T);
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  let a = 0;
  let b = 0;
  const nl = (ls: string[]) => (ls.length && !ls[ls.length - 1].endsWith('\n') ? [...ls.slice(0, -1), ls[ls.length - 1] + '\n'] : ls);
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((l, k) => l === y[k]);
  const emit = (j: number, aj: number, bj: number) => {
    const bc = B.slice(i, j);
    const oc = O.slice(a, aj);
    const tc = T.slice(b, bj);
    if (eq(oc, bc)) out.push(...tc);
    else if (eq(tc, bc) || eq(oc, tc)) out.push(...oc);
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.ours}\n`, ...nl(oc));
      if (style === 'diff3') out.push(`||||||| ${labels.base ?? 'base'}\n`, ...nl(bc));
      out.push('=======\n', ...nl(tc), `>>>>>>> ${labels.theirs}\n`);
    }
  };
  for (let j = 0; j < B.length; j++) {
    const aj = mo.get(j);
    const bj = mt.get(j);
    if (aj === undefined || bj === undefined || aj < a || bj < b) continue;
    if (j > i || aj > a || bj > b) emit(j, aj, bj);
    out.push(B[j]);
    i = j + 1;
    a = aj + 1;
    b = bj + 1;
  }
  if (i < B.length || a < O.length || b < T.length) emit(B.length, O.length, T.length);
  return { text: out.join(''), conflicts };
}

export type Unmerged = 'both modified' | 'both added' | 'deleted by us' | 'deleted by them';

export interface TreeMerge {
  tree: Record<string, string>;
  x: string[];
  conflicts: Record<string, Unmerged>;
  /** Paths auto-merged from two sides (git prints "Auto-merging"). */
  merged: string[];
}

export function mergeTrees(r: Repo, base: Record<string, string>, ours: Record<string, string>, theirs: Record<string, string>, x: { base: string[]; ours: string[]; theirs: string[] }, labels: MergeLabels): TreeMerge {
  const tree: Record<string, string> = {};
  const conflicts: Record<string, Unmerged> = {};
  const merged: string[] = [];
  const execOut = new Set<string>();
  const style = configGet(r.ctx, r.st, 'merge.conflictstyle') === 'diff3' || configGet(r.ctx, r.st, 'merge.conflictstyle') === 'zdiff3' ? 'diff3' : 'merge';
  for (const p of [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
    const [b, o, t] = [base[p], ours[p], theirs[p]];
    const xb = x.base.includes(p);
    const xo = x.ours.includes(p);
    const xt = x.theirs.includes(p);
    if (xo === xt ? xo : xo === xb ? xt : xo) execOut.add(p);
    if (o === t) {
      if (o !== undefined) tree[p] = o;
      continue;
    }
    if (o === b) {
      if (t !== undefined) tree[p] = t;
      continue;
    }
    if (t === b) {
      if (o !== undefined) tree[p] = o;
      continue;
    }
    if (o === undefined || t === undefined) {
      conflicts[p] = o === undefined ? 'deleted by us' : 'deleted by them';
      tree[p] = (o ?? t)!;
      continue;
    }
    merged.push(p);
    const m = merge3(b ?? '', o, t, labels, style);
    tree[p] = m.text;
    if (m.conflicts) conflicts[p] = b === undefined ? 'both added' : 'both modified';
  }
  return { tree, x: [...execOut].filter((p) => tree[p] !== undefined), conflicts, merged };
}

/** rerere: replays a recorded resolution, or records the preimage of a new conflict. */
export function rerereOnConflict(r: Repo, conflicts: Record<string, Unmerged>, tree: Record<string, string>): void {
  if (!truthy(configGet(r.ctx, r.st, 'rerere.enabled'))) return;
  r.st.rerere ??= {};
  r.st.rerereOpen ??= {};
  for (const p of Object.keys(conflicts)) {
    const key = blobId(tree[p].replace(/^(<<<<<<<|>>>>>>>) .*$/gm, '$1'));
    const known = r.st.rerere[key];
    if (known !== undefined) {
      tree[p] = known;
      r.io.out(`Resolved '${p}' using previous resolution.\n`);
    } else r.io.out(`Recorded preimage for '${p}'\n`);
    r.st.rerereOpen[p] = key;
  }
}

/** rerere: when a conflicted file is committed without markers, remember how it was resolved. */
export function rerereRecord(r: Repo, files: Record<string, string>): void {
  if (!r.st.rerereOpen) return;
  for (const [p, key] of Object.entries(r.st.rerereOpen)) {
    const c = files[p];
    if (c !== undefined && !hasMarkers(c)) {
      if (r.st.rerere?.[key] === undefined) r.io.out(`Recorded resolution for '${p}'.\n`);
      (r.st.rerere ??= {})[key] = c;
      delete r.st.rerereOpen[p];
    }
  }
  if (!Object.keys(r.st.rerereOpen).length) delete r.st.rerereOpen;
}

export const hasMarkers = (s: string) => /^(<<<<<<< |=======$|>>>>>>> )/m.test(s);

/* ----------------------------------------------------------------------------- commits and refs */

export function logRef(r: Repo, ref: string, from: string | null, to: string, msg: string): void {
  const st = r.st;
  st.reflogs ??= {};
  const who = (() => {
    const n = configGet(r.ctx, st, 'user.name');
    const e = configGet(r.ctx, st, 'user.email');
    return n && e ? `${n} <${e}>` : `${currentUser(r.ctx)} <${currentUser(r.ctx)}@${r.ctx.sys.hostname}>`;
  })();
  const list = (st.reflogs[ref] ??= []);
  list.push({ from, to, msg, time: nextTime(r), who });
  if (list.length > 300) list.splice(0, list.length - 300);
}

/** Points HEAD (and its branch, when attached) at `id`, logging both. */
export function moveHead(r: Repo, id: string, msg: string): void {
  const st = r.st;
  const from = headCommit(st);
  if (st.head.branch !== undefined) {
    st.branches[st.head.branch] = id;
    logRef(r, `refs/heads/${st.head.branch}`, from, id, msg);
  } else st.head.detached = id;
  logRef(r, 'HEAD', from, id, msg);
}

export function setBranch(r: Repo, name: string, id: string, msg: string): void {
  const from = r.st.branches[name] ?? null;
  r.st.branches[name] = id;
  logRef(r, `refs/heads/${name}`, from, id, msg);
  if (r.st.head.branch === name) logRef(r, 'HEAD', from, id, msg);
}

export function newCommit(r: Repo, o: { message: string; parents: string[]; tree: Record<string, string>; x: string[]; author?: Person; committer?: Person }): string {
  const author = o.author ?? ident(r, 'author');
  const committer = o.committer ?? ident(r, 'committer');
  const ctime = Math.max(committer.time, author.time);
  const body = {
    parents: o.parents,
    message: o.message,
    author: author.name,
    email: author.email,
    time: author.time,
    tree: { ...o.tree },
    ...(committer.name !== author.name || committer.email !== author.email || ctime !== author.time ? { committer: committer.name, cemail: committer.email, ctime } : {}),
    ...(o.x.length ? { x: [...o.x].sort() } : {}),
  };
  const id = commitId(body);
  const seq = Object.values(r.st.commits).reduce((m, c) => Math.max(m, c.seq), 0) + 1;
  r.st.commits[id] = { id, seq, ...body };
  return id;
}

export function cleanMessage(text: string, mode: 'strip' | 'whitespace' | 'verbatim' = 'strip'): string {
  let ls = text.split('\n');
  if (mode === 'strip') ls = ls.filter((l) => !l.startsWith('#'));
  if (mode !== 'verbatim') ls = ls.map((l) => l.replace(/\s+$/, ''));
  let s = ls.join('\n');
  if (mode !== 'verbatim') s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return s;
}

/* ----------------------------------------------------------------------------- hooks */

export function hookPath(r: Repo, name: string): string {
  const custom = configGet(r.ctx, r.st, 'core.hookspath');
  if (custom) return `${custom.startsWith('/') ? custom : join(r.root, custom)}/${name}`.replace(/\/+/g, '/');
  return join(r.gitDir, `hooks/${name}`);
}

/** Runs a hook if it exists. null: no hook. Output goes through `wrap` (remote hooks prefix "remote: "). */
export function runHook(r: Repo, name: string, args: string[] = [], stdin = '', wrap?: (s: string) => string): number | null {
  const path = hookPath(r, name);
  const l = lookup(r.ctx.sys.fs, path, ROOT);
  if (!l || l.node.type !== 'file') return null;
  if (!(l.node.mode & 0o111)) {
    r.io.err(`hint: The '${path.replace(r.root + '/', '')}' hook was ignored because it's not set as executable.\nhint: You can disable this warning with \`git config advice.ignoredHook false\`.\n`);
    return null;
  }
  const cwd = r.ctx.sys.cwd;
  r.ctx.sys.cwd = r.root;
  const out = wrap ? (s: string) => r.io.err(wrap(s)) : r.io.out;
  const err = wrap ? (s: string) => r.io.err(wrap(s)) : r.io.err;
  try {
    return runCommand(r.ctx, [path, ...args], { stdin, out, err });
  } finally {
    r.ctx.sys.cwd = cwd;
  }
}

/* ----------------------------------------------------------------------------- the editor */

const INTERACTIVE_EDITORS = /^(vi|vim|nvim|nano|emacs|pico|editor|sensible-editor|code\s+--wait|code)$/;

/**
 * Lets the learner edit `file` (relative to the git directory). Non-interactive editors (sed, true,
 * a script) run now; vi or nano open the terminal's editor and git continues with `resume` once
 * the file is saved. Returns the edited text, or null when git must stop and wait.
 */
export function editFile(r: Repo, file: string, initial: string, resume: string[], kind: 'msg' | 'sequence' = 'msg'): string | null {
  const path = join(r.gitDir, file);
  writeAs(r.ctx, path, initial, actor(r.ctx));
  const pick = kind === 'sequence' ? envOf(r.ctx, 'GIT_SEQUENCE_EDITOR') ?? configGet(r.ctx, r.st, 'sequence.editor') : undefined;
  const editor = (pick ?? envOf(r.ctx, 'GIT_EDITOR') ?? configGet(r.ctx, r.st, 'core.editor') ?? envOf(r.ctx, 'VISUAL') ?? envOf(r.ctx, 'EDITOR') ?? 'vi').trim();
  if (editor === ':' || editor === 'true') return initial;
  if (INTERACTIVE_EDITORS.test(editor.replace(/^.*\//, ''))) {
    if (!r.io.interactive) die(`error: there was a problem with the editor '${editor}'\nhint: in a script, give the text another way (git commit -m, -F FILE) or set GIT_EDITOR to a command such as "sed -i ..."`, 1);
    r.ctx.requests.push({ kind: 'editor', path, content: initial, then: `git -C ${shellQuote(r.root)} ${resume.map(shellQuote).join(' ')}` });
    r.io.out(`hint: Waiting for your editor to close the file... (save it to continue)\n`);
    return null;
  }
  const cwd = r.ctx.sys.cwd;
  r.ctx.sys.cwd = r.root;
  let code: number;
  try {
    code = runCommand(r.ctx, ['bash', '-c', `${editor} "$1"`, 'editor', path], { stdin: '', out: r.io.out, err: r.io.err });
  } finally {
    r.ctx.sys.cwd = cwd;
  }
  if (code !== 0) die(`error: There was a problem with the editor '${editor}'.`, 1);
  return readFile(r.ctx.sys.fs, path, ROOT);
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ----------------------------------------------------------------------------- formatting */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

export function relative(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} days ago`;
  if (d < 70) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

export function gitDate(ms: number, mode: string | undefined, now: number): string {
  const d = new Date(ms);
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  const ymd = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  switch (mode) {
    case 'iso':
    case 'iso8601':
      return `${ymd} ${time} +0000`;
    case 'iso-strict':
    case 'iso8601-strict':
      return `${ymd}T${time}+00:00`;
    case 'short':
      return ymd;
    case 'unix':
    case 'raw':
      return mode === 'raw' ? `${Math.floor(ms / 1000)} +0000` : String(Math.floor(ms / 1000));
    case 'relative':
      return relative(ms, now);
    case 'rfc':
    case 'rfc2822':
      return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${time} +0000`;
    default:
      if (mode?.startsWith('format:')) return strftime(ms, mode.slice(7));
      return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${time} ${d.getUTCFullYear()} +0000`;
  }
}

export function decorations(r: Repo, id: string, bare = false): string {
  const st = r.st;
  const names: string[] = [];
  if (st.head.branch !== undefined && st.branches[st.head.branch] === id) names.push(`HEAD -> ${st.head.branch}`);
  else if (st.head.branch === undefined && st.head.detached === id) names.push('HEAD');
  for (const [t, c] of Object.entries(st.tags)) if (c === id) names.push(`tag: ${t}`);
  for (const [rb, c] of Object.entries(st.remoteRefs ?? {}).sort(([a], [b]) => Number(a.endsWith('/HEAD')) - Number(b.endsWith('/HEAD')) || (a < b ? -1 : 1))) if (c === id) names.push(rb);
  for (const [b, c] of Object.entries(st.branches)) if (c === id && b !== st.head.branch) names.push(b);
  if (!names.length) return '';
  return bare ? names.join(', ') : ` (${names.join(', ')})`;
}

/** A --format/--pretty=format: string for one commit. */
export function formatCommit(r: Repo, c: GitCommit, fmt: string, dateMode: string | undefined): string {
  const now = r.ctx.sys.now;
  const ct = c.ctime ?? c.time;
  const body = c.message.includes('\n') ? c.message.slice(c.message.indexOf('\n') + 1).replace(/^\n/, '') : '';
  return fmt.replace(/%(?:C\([^)]*\)|C(?:red|green|blue|reset)|x([0-9a-fA-F]{2})|([aAcC][nNeElLdDrtiIs])|([HhTtPpsbBdDnmG%]))/g, (all, hex: string | undefined, person: string | undefined, one: string | undefined) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (person) {
      const isA = person[0] === 'a' || person[0] === 'A';
      const name = isA ? c.author : c.committer ?? c.author;
      const email = isA ? c.email : c.cemail ?? c.email;
      const t = isA ? c.time : ct;
      switch (person[1]) {
        case 'n':
        case 'N':
          return name;
        case 'e':
        case 'E':
          return email;
        case 'l':
        case 'L':
          return email.split('@')[0];
        case 'd':
          return gitDate(t, dateMode, now);
        case 'D':
          return gitDate(t, 'rfc', now);
        case 'r':
          return relative(t, now);
        case 't':
          return String(Math.floor(t / 1000));
        case 'i':
          return gitDate(t, 'iso', now);
        case 'I':
          return gitDate(t, 'iso-strict', now);
        case 's':
          return gitDate(t, 'short', now);
      }
      return all;
    }
    switch (one) {
      case 'H':
        return c.id;
      case 'h':
        return short(c.id);
      case 'T':
        return treeId(c.tree, c.x);
      case 't':
        return short(treeId(c.tree, c.x));
      case 'P':
        return c.parents.join(' ');
      case 'p':
        return c.parents.map(short).join(' ');
      case 's':
        return subject(c.message);
      case 'b':
        return body ? body + '\n' : '';
      case 'B':
        return c.message + '\n';
      case 'd':
        return decorations(r, c.id);
      case 'D':
        return decorations(r, c.id, true);
      case 'n':
        return '\n';
      case 'm':
        return '>';
      case '%':
        return '%';
    }
    return '';
  });
}

/** Draws `git log --graph` lanes for commits in topological order. */
export function graphLines(st: GitState, ordered: string[], text: (id: string) => string[]): string[] {
  const out: string[] = [];
  let cols: string[] = [];
  const row = (chars: string[]) => chars.join(' ').replace(/\s+$/, '');
  for (const id of ordered) {
    let col = cols.indexOf(id);
    if (col === -1) {
      cols.push(id);
      col = cols.length - 1;
    }
    const lines = text(id);
    const parents = st.commits[id].parents.filter((p) => st.commits[p]);
    const marks = cols.map((_, k) => (k === col ? '*' : '|'));
    out.push(`${row(marks)}${parents.length > 1 ? '   ' : ' '}${lines[0] ?? ''}`.replace(/\s+$/, ''));
    const next = [...cols];
    if (!parents.length) next.splice(col, 1);
    else next[col] = parents[0];
    const extra = parents.slice(1).filter((p) => !next.includes(p));
    if (extra.length) {
      next.splice(col + 1, 0, ...extra);
      // A merge opens a lane to the right: '|\' at the merge column, later lanes shift out with ' \'.
      const merge = '| '.repeat(col) + '|\\' + ' \\'.repeat(cols.length - col - 1);
      for (const l of lines.slice(1)) out.push(`${row(cols.map(() => '|')).padEnd(cols.length * 2)} ${l}`.replace(/\s+$/, ''));
      out.push(merge);
    } else for (const l of lines.slice(1)) out.push(`${row(next.map(() => '|')).padEnd(next.length * 2)} ${l}`.replace(/\s+$/, ''));
    // Lanes that now wait for the same commit join up.
    for (let k = 0; k < next.length; k++) {
      const first = next.indexOf(next[k]);
      if (first < k) {
        // A lane that ends in the same commit as the lane to its left joins it: '|/', later lanes ' /'.
        out.push('| '.repeat(k - 1) + '|/' + ' /'.repeat(next.length - k - 1));
        next.splice(k, 1);
        k--;
      }
    }
    cols = next;
  }
  return out;
}

export function fsErrorText(e: unknown): string {
  if (e instanceof FsError) return e.message;
  return (e as Error).message;
}

/** Resolves a path argument relative to the working tree root; null when outside it. */
export function repoPath(r: Repo, p: string): string | null {
  const full = abs(r.ctx, p);
  const base = r.root === '/' ? '' : r.root;
  if (full === r.root) return '';
  return full.startsWith(base + '/') ? full.slice(base.length + 1) : null;
}

/* ----------------------------------------------------------------------------- creating repositories */

export const SAMPLE_HOOKS: Record<string, string> = {
  'pre-commit.sample': '#!/bin/sh\n#\n# An example hook script to verify what is about to be committed.\n# Called by "git commit" with no arguments.  The hook should\n# exit with non-zero status after issuing an appropriate message if\n# it wants to stop the commit.\n#\n# To enable this hook, rename this file to "pre-commit".\n\nexec git diff-index --check --cached HEAD --\n',
  'commit-msg.sample': '#!/bin/sh\n#\n# An example hook script to check the commit log message.\n# Called by "git commit" with one argument, the name of the file\n# that has the commit message.  The hook should exit with non-zero\n# status after issuing an appropriate message if it wants to stop the\n# commit.  The hook is allowed to edit the commit message file.\n#\n# To enable this hook, rename this file to "commit-msg".\n',
  'pre-push.sample': '#!/bin/sh\n\n# An example hook script to verify what is about to be pushed.  Called by "git\n# push" after it has checked the remote status, but before anything has been\n# pushed.  If this script exits with a non-zero status nothing will be pushed.\n#\n# This hook is called with the following parameters:\n#\n# $1 -- Name of the remote to which the push is being done\n# $2 -- URL to which the push is being done\n#\n# Information about the commits which are being pushed is supplied as lines to\n# the standard input in the form:\n#\n#   <local ref> <local oid> <remote ref> <remote oid>\n',
  'pre-receive.sample': '#!/bin/sh\n#\n# An example hook script to make use of push options.\n# The hook receives "<old-value> SP <new-value> SP <ref-name> LF" lines on\n# standard input, one per updated ref.\n#\n# To enable this hook, rename this file to "pre-receive".\n',
};

export function initRepo(ctx: Ctx, target: string, o: { bare?: boolean; branch?: string; shared?: string }): void {
  const a = actor(ctx);
  const gitDir = o.bare ? target : `${target === '/' ? '' : target}/.git`;
  mkdir(ctx.sys.fs, gitDir, a, ctx.sys.now, true);
  for (const d of ['hooks', 'info', 'objects', 'refs/heads', 'refs/tags']) mkdir(ctx.sys.fs, `${gitDir}/${d}`, a, ctx.sys.now, true);
  for (const [n, c] of Object.entries(SAMPLE_HOOKS)) {
    writeFile(ctx.sys.fs, `${gitDir}/hooks/${n}`, c, a, ctx.sys.now);
    const l = lookup(ctx.sys.fs, `${gitDir}/hooks/${n}`, ROOT);
    if (l) l.node.mode = 0o755;
  }
  writeFile(ctx.sys.fs, `${gitDir}/info/exclude`, "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n", a, ctx.sys.now);
  writeFile(ctx.sys.fs, `${gitDir}/description`, "Unnamed repository; edit this file 'description' to name the repository.\n", a, ctx.sys.now);
  const branch = o.branch ?? configGet(ctx, null, 'init.defaultbranch') ?? 'main';
  const st: GitState = { head: { branch }, branches: { [branch]: null }, commits: {}, index: {}, config: {}, tags: {} };
  if (o.bare) st.bare = true;
  if (o.shared) st.config['core.sharedrepository'] = o.shared === 'true' ? 'group' : o.shared;
  const r: Repo = { ctx, io: { stdin: '', out: () => {}, err: () => {} }, root: target, gitDir, bare: !!o.bare, st };
  saveRepo(r);
  if (o.shared) {
    // A shared repository: group-writable files and set-group-ID directories, so every member can push.
    const fix = (path: string) => {
      const l = lookup(ctx.sys.fs, path, ROOT);
      if (!l) return;
      if (l.node.type === 'dir') {
        l.node.mode = (l.node.mode | 0o2070) & ~0o002;
        for (const name of Object.keys(l.node.children)) fix(`${path}/${name}`);
      } else l.node.mode |= 0o060;
    };
    fix(gitDir);
  }
}
