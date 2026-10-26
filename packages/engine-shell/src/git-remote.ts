/**
 * The network side of the simulated git: clone, fetch, pull, push, remote, ls-remote and bundle.
 * A remote is another repository in the same simulated file system (a path, file:// URL or a
 * bundle file), or a repository on the lab forge (ssh or https URLs on the forge host), which
 * checks SSH keys, tokens and branch protection and runs CI after a push (see forge.ts).
 */

import { can, lookup, mkdir, readFile, writeFile } from './fs.js';
import { actor, runCommand, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import type { GitCommit, GitState } from './git-state.js';
import {
  GitExit,
  PROMISED,
  ROOT,
  ancestors,
  checkoutTree,
  configGet,
  die,
  findRepo,
  headCommit,
  initRepo,
  isBareAt,
  loadGit,
  logRef,
  openRepo,
  plural,
  runHook,
  saveRepo,
  short,
  truthy,
  type Repo,
} from './git-core.js';
import { blobId } from './git-state.js';
import { forgeAfterPush, forgeBeforePush, forgeResolve, type RefUpdate } from './forge.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
const ZERO = '0'.repeat(40);

/* ----------------------------------------------------------------------------- connecting */

export interface Remote {
  /** The URL as git prints it ("From <url>", "To <url>"). */
  url: string;
  /** Repository path in the simulated file system ('' for a bundle). */
  path: string;
  bare: boolean;
  /** Who the forge authenticated (null for local paths). */
  user: string | null;
  /** Token scopes when the forge authenticated a token (null for SSH keys). */
  scopes?: string[] | null;
  forge: boolean;
  bundle?: { refs: Record<string, string>; commits: Record<string, GitCommit>; tags: Record<string, string>; annotated?: GitState['annotated']; prereqs: string[] };
}

const BUNDLE_HEADER = '# v2 git bundle';

function readBundle(text: string): Remote['bundle'] {
  const [head, json] = text.split('\n\n');
  const lines = head.split('\n').slice(1);
  const refs: Record<string, string> = {};
  const prereqs: string[] = [];
  for (const l of lines) {
    if (l.startsWith('-')) prereqs.push(l.slice(1).split(' ')[0]);
    else if (l) {
      const [id, ref] = l.split(' ');
      refs[ref] = id;
    }
  }
  const body = JSON.parse(json || '{}') as { commits?: Record<string, GitCommit>; tags?: Record<string, string>; annotated?: GitState['annotated'] };
  return { refs, commits: body.commits ?? {}, tags: body.tags ?? {}, annotated: body.annotated, prereqs };
}

/** Resolves a URL or path to a repository we can read (and, for push, write). Dies with git's messages. */
export function connect(ctx: Ctx, url: string, intent: 'fetch' | 'push', base = ctx.sys.cwd): Remote {
  const forge = forgeResolve(ctx, url, intent);
  if (forge) {
    if ('error' in forge) die(forge.error);
    const f = forge as { path: string; user: string | null; scopes?: string[] | null };
    return { url, path: f.path, bare: true, user: f.user, scopes: f.scopes, forge: true };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('file://')) {
    const host = /^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1] ?? url;
    if (url.startsWith('ssh://')) die(`ssh: Could not resolve hostname ${host}: Name or service not known\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
    die(`fatal: unable to access '${url}': Could not resolve host: ${host}`);
  }
  if (/^[\w.-]+@[\w.-]+:/.test(url)) {
    const host = /@([^:]+):/.exec(url)![1];
    die(`ssh: Could not resolve hostname ${host}: Name or service not known\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  }
  const raw = url.replace(/^file:\/\//, '');
  const path = raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : abs({ ...ctx, sys: { ...ctx.sys, cwd: base } } as Ctx, raw);
  const l = lookup(ctx.sys.fs, path, ROOT);
  const notRepo = () => die(`fatal: '${url}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  if (!l) return notRepo();
  if (l.node.type === 'file') {
    if (!l.node.content.startsWith(BUNDLE_HEADER)) return notRepo();
    if (intent === 'push') die(`fatal: '${url}' is a bundle file; bundles can be read from but not pushed to`);
    return { url, path: '', bare: true, user: null, forge: false, bundle: readBundle(l.node.content) };
  }
  const bare = isBareAt(ctx, path);
  if (!bare && !lookup(ctx.sys.fs, `${path === '/' ? '' : path}/.git/state.json`, ROOT)) return notRepo();
  const stateNode = lookup(ctx.sys.fs, `${path === '/' ? '' : path}/${bare ? 'objects/state.json' : '.git/state.json'}`, ROOT)!.node;
  const me = actor(ctx);
  if (!can(stateNode, me, 'r') || !can(l.node, me, 'x')) die(`fatal: '${url}': Permission denied\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  if (intent === 'push') {
    const objects = lookup(ctx.sys.fs, `${path === '/' ? '' : path}/${bare ? 'objects' : '.git/objects'}`, ROOT);
    if (!objects || !can(objects.node, me, 'w') || !can(stateNode, me, 'w'))
      die(`remote: error: insufficient permission for adding an object to repository database ./objects\nremote: fatal: failed to write object\nerror: remote unpack failed: unable to create temporary object directory\nTo ${url}\n ! [remote rejected] (unpacker error)\nerror: failed to push some refs to '${url}'`, 1);
  }
  return { url, path, bare, user: null, forge: false };
}

function remoteState(ctx: Ctx, rm: Remote): GitState {
  if (rm.bundle) {
    const branches: Record<string, string> = {};
    const tags: Record<string, string> = {};
    for (const [ref, id] of Object.entries(rm.bundle.refs)) {
      if (ref.startsWith('refs/heads/')) branches[ref.slice(11)] = id;
      else if (ref.startsWith('refs/tags/')) tags[ref.slice(10)] = id;
    }
    const head = branches.main !== undefined ? 'main' : branches.master !== undefined ? 'master' : Object.keys(branches)[0];
    return { head: { branch: head }, branches, commits: rm.bundle.commits, index: {}, config: {}, tags: { ...tags, ...rm.bundle.tags }, annotated: rm.bundle.annotated, bare: true };
  }
  return loadGit(ctx, rm.path);
}

/** The remote's local branches, as refs a client sees ("main" -> id). */
function remoteBranches(st: GitState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [b, id] of Object.entries(st.branches)) if (id) out[b] = id;
  return out;
}

/* ----------------------------------------------------------------------------- copying objects */

/** Commits reachable from `tips`, limited to `depth` generations when given. Returns the set and the shallow boundary. */
function reachable(st: GitState, tips: string[], depth?: number): { ids: Set<string>; boundary: Set<string> } {
  const ids = new Set<string>();
  const boundary = new Set<string>();
  if (!depth) {
    for (const t of tips) for (const c of ancestors(st, t)) ids.add(c);
    return { ids, boundary };
  }
  let frontier = tips.filter((t) => st.commits[t]);
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const c of frontier) {
      if (ids.has(c)) continue;
      ids.add(c);
      if (d === depth) {
        if (st.commits[c].parents.length) boundary.add(c);
      } else next.push(...st.commits[c].parents.filter((p) => st.commits[p]));
    }
    frontier = next;
  }
  return { ids, boundary };
}

/** Copies commits from one state into another. Returns how many were new. */
function copyCommits(from: GitState, to: GitState, ids: Iterable<string>, opts: { partialKeep?: Set<string> } = {}): number {
  let n = 0;
  let seq = Object.values(to.commits).reduce((m, c) => Math.max(m, c.seq), 0);
  const list = [...ids].filter((id) => !to.commits[id]).sort((a, b) => from.commits[a].seq - from.commits[b].seq);
  for (const id of list) {
    const c = from.commits[id];
    let tree = c.tree;
    if (opts.partialKeep && !opts.partialKeep.has(id)) {
      // A partial clone keeps only the newest files; older contents stay on the remote until needed.
      const keep = new Set<string>();
      for (const k of opts.partialKeep) for (const content of Object.values(from.commits[k]?.tree ?? {})) keep.add(content);
      tree = Object.fromEntries(Object.entries(c.tree).map(([p, content]) => [p, keep.has(content) ? content : PROMISED + blobId(content)]));
    }
    to.commits[id] = { ...c, tree, seq: ++seq };
    n++;
  }
  return n;
}

function objectCount(st: GitState, ids: string[]): number {
  const blobs = new Set<string>();
  for (const id of ids) for (const content of Object.values(st.commits[id]?.tree ?? {})) blobs.add(content);
  return ids.length * 2 + Math.min(blobs.size, ids.length * 3);
}

function progressLines(n: number, remote: boolean): string {
  if (!n) return '';
  const bytes = n * 96;
  const size = bytes > 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} bytes`;
  return remote
    ? `remote: Enumerating objects: ${n}, done.\nremote: Counting objects: 100% (${n}/${n}), done.\nremote: Compressing objects: 100% (${Math.ceil(n / 2)}/${Math.ceil(n / 2)}), done.\nremote: Total ${n} (delta 0), reused 0 (delta 0), pack-reused 0\nUnpacking objects: 100% (${n}/${n}), ${size} | ${size}/s, done.\n`
    : `Enumerating objects: ${n}, done.\nCounting objects: 100% (${n}/${n}), done.\nDelta compression using up to 4 threads\nCompressing objects: 100% (${Math.ceil(n / 2)}/${Math.ceil(n / 2)}), done.\nWriting objects: 100% (${n}/${n}), ${size} | ${size}/s, done.\nTotal ${n} (delta 0), reused 0 (delta 0), pack-reused 0\n`;
}

/* ----------------------------------------------------------------------------- partial clones */

/** Fills in file contents a partial clone left on the promisor remote (called by git-core when needed). */
export function materializePartial(r: Repo, tree: Record<string, string>): Record<string, string> {
  if (!Object.values(tree).some((c) => c.startsWith(PROMISED))) return tree;
  const p = r.st.partial!;
  const url = r.st.remotes?.[p.remote]?.url;
  let src: GitState | null = null;
  try {
    src = url ? remoteState(r.ctx, connect(r.ctx, url, 'fetch', r.root)) : null;
  } catch (e) {
    if (e instanceof GitExit) throw new GitExit(`fatal: could not fetch missing objects from promisor remote '${p.remote}'\n${e.text}`);
    throw e;
  }
  const byId = new Map<string, string>();
  for (const c of Object.values(src?.commits ?? {})) for (const content of Object.values(c.tree)) byId.set(blobId(content), content);
  for (const [path, content] of Object.entries(tree)) {
    if (!content.startsWith(PROMISED)) continue;
    const real = byId.get(content.slice(PROMISED.length));
    if (real === undefined) die(`fatal: could not fetch ${content.slice(PROMISED.length)} from promisor remote`);
    tree[path] = real!;
  }
  return tree;
}

/* ----------------------------------------------------------------------------- fetch */

interface FetchResult {
  lines: string[];
  updated: Record<string, string>;
  objects: number;
}

function fetchInto(r: Repo, remoteName: string, rm: Remote, o: { branches?: string[]; prune?: boolean; tags?: boolean; depth?: number; deepen?: number; unshallow?: boolean; dryRun?: boolean }): FetchResult {
  const st = r.st;
  const src = remoteState(r.ctx, rm);
  const heads = remoteBranches(src);
  const wanted: Record<string, string> = o.branches?.length ? Object.fromEntries(o.branches.map((b) => [b, heads[b]] as [string, string]).filter(([, id]) => id)) : heads;
  for (const b of o.branches ?? []) if (!heads[b]) die(`fatal: couldn't find remote ref ${b}`);
  if (rm.bundle) {
    const missing = rm.bundle.prereqs.filter((p) => !st.commits[p]);
    if (missing.length) die(`error: Repository lacks these prerequisite commits:\n${missing.map((m) => `error: ${m}`).join('\n')}`);
  }
  const lines: string[] = [];
  const updated: Record<string, string> = {};
  const tips = Object.values(wanted);
  const depth = o.unshallow ? undefined : o.depth ?? (st.shallow?.length ? undefined : undefined);
  const { ids, boundary } = reachable(src, tips, depth);
  if (o.deepen) {
    if (!st.shallow?.length) die('fatal: --deepen on a complete repository does not make sense');
    // Extend the history below each shallow boundary by that many more commits.
    for (const c of [...ids]) if (st.commits[c]) for (const a of ancestors(src, c)) ids.delete(a);
    const more = reachable(src, (st.shallow ?? []).flatMap((c) => src.commits[c]?.parents ?? []), o.deepen);
    for (const c of more.ids) ids.add(c);
    for (const c of more.boundary) boundary.add(c);
  }
  if (o.unshallow) {
    if (!st.shallow?.length) die('fatal: --unshallow on a complete repository does not make sense');
    delete st.shallow;
  } else if (st.shallow?.length && !o.depth && !o.deepen) {
    // A shallow clone keeps its boundary: only fetch what is new above what we have.
    for (const c of [...ids]) if (st.commits[c]) for (const a of ancestors(src, c)) ids.delete(a);
  }
  const before = new Set(Object.keys(st.commits));
  const n = o.dryRun ? [...ids].filter((c) => !st.commits[c]).length : copyCommits(src, st, ids, st.partial ? { partialKeep: new Set(tips) } : {});
  if ((depth || o.deepen) && !o.dryRun) {
    const sh = new Set(st.shallow ?? []);
    for (const b of boundary) if (!before.has(b)) sh.add(b);
    // A boundary whose parents have now arrived is no longer a boundary.
    for (const c of [...sh]) if (st.commits[c]?.parents.every((p) => st.commits[p])) sh.delete(c);
    if (sh.size) st.shallow = [...sh];
    else delete st.shallow;
  }
  st.remoteRefs ??= {};
  for (const [b, id] of Object.entries(wanted).sort()) {
    const key = `${remoteName}/${b}`;
    const old = st.remoteRefs[key];
    if (old === id) continue;
    const name = b.padEnd(10);
    if (!old) lines.push(` * [new branch]      ${name} -> ${key}`);
    else if (ancestors(st, id).has(old)) lines.push(`   ${short(old)}..${short(id)}  ${name} -> ${key}`);
    else lines.push(` + ${short(old)}...${short(id)} ${name} -> ${key}  (forced update)`);
    if (!o.dryRun) st.remoteRefs[key] = id;
    updated[key] = id;
  }
  // remoteName/HEAD follows the remote's default branch.
  if (src.head.branch && wanted[src.head.branch] && !o.dryRun && (!o.branches?.length || st.remoteRefs[`${remoteName}/HEAD`])) st.remoteRefs[`${remoteName}/HEAD`] = wanted[src.head.branch];
  if (o.prune || truthy(configGet(r.ctx, st, 'fetch.prune'))) {
    for (const key of Object.keys(st.remoteRefs)) {
      if (!key.startsWith(remoteName + '/') || key.endsWith('/HEAD')) continue;
      const b = key.slice(remoteName.length + 1);
      if (heads[b] === undefined && (!o.branches?.length || o.branches.includes(b))) {
        lines.push(` - [deleted]         (none)     -> ${key}`);
        if (!o.dryRun) delete st.remoteRefs[key];
      }
    }
  }
  // Tags that point into what we fetched come along (or all of them with --tags).
  for (const [t, id] of Object.entries(src.tags).sort()) {
    if (st.tags[t] === id) continue;
    if (!o.tags && !st.commits[id]) continue;
    if (st.tags[t] && st.tags[t] !== id) {
      lines.push(` ! [rejected]        ${t.padEnd(10)} -> ${t}  (would clobber existing tag)`);
      continue;
    }
    if (o.tags && !st.commits[id] && !o.dryRun) copyCommits(src, st, ancestors(src, id));
    lines.push(` * [new tag]         ${t.padEnd(10)} -> ${t}`);
    if (!o.dryRun) {
      st.tags[t] = id;
      if (src.annotated?.[t]) (st.annotated ??= {})[t] = src.annotated[t];
    }
  }
  const first = Object.values(updated)[0];
  if (first && !o.dryRun) st.fetchHead = o.branches?.length ? wanted[o.branches[0]] : heads[src.head.branch ?? ''] ?? first;
  return { lines, updated, objects: n ? objectCount(st, [...ids].filter((c) => !before.has(c))) : 0 };
}

function remoteNameFor(r: Repo, name: string | undefined): string {
  if (name) return name;
  const b = r.st.head.branch;
  return (b && r.st.upstream?.[b]?.remote) ?? 'origin';
}

function urlFor(r: Repo, nameOrUrl: string): { name: string | null; url: string } {
  if (r.st.remotes?.[nameOrUrl]) return { name: nameOrUrl, url: r.st.remotes[nameOrUrl].url };
  if (nameOrUrl === 'origin' && !r.st.remotes?.origin)
    die(`fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  return { name: null, url: nameOrUrl };
}

function needRepo(ctx: Ctx, io: IO): Repo {
  const path = findRepo(ctx);
  if (!path) die('fatal: not a git repository (or any of the parent directories): .git');
  return openRepo(ctx, io, path!);
}

const opt = (args: string[], name: string) => {
  const k = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (k === -1) return undefined;
  return args[k].includes('=') ? args[k].slice(args[k].indexOf('=') + 1) : args[k + 1];
};
const withoutOpts = (args: string[], valued: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
};

function cmdFetch(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const pos = withoutOpts(args, ['--depth', '--deepen']);
  const quiet = args.includes('-q') || args.includes('--quiet');
  const names = args.includes('--all') ? Object.keys(r.st.remotes ?? {}) : [remoteNameFor(r, pos[0])];
  if (!names.length) return 0;
  let code = 0;
  for (const name of names) {
    const { name: rname, url } = urlFor(r, name);
    const rm = connect(ctx, url, 'fetch', r.root);
    if (args.includes('--all')) io.out(`Fetching ${name}\n`);
    const depth = opt(args, '--depth');
    const deepen = opt(args, '--deepen');
    const res = fetchInto(r, rname ?? 'FETCH_HEAD', rm, { branches: pos.slice(1).map((b) => b.replace(/^refs\/heads\//, '').replace(/:.*$/, '')), prune: args.includes('--prune') || args.includes('-p'), tags: args.includes('--tags') || args.includes('-t'), depth: depth ? Number(depth) : undefined, deepen: deepen ? Number(deepen) : undefined, unshallow: args.includes('--unshallow'), dryRun: args.includes('--dry-run') });
    if (!quiet) {
      io.err(progressLines(res.objects, true));
      if (res.lines.length) io.err(`From ${url}\n${res.lines.join('\n')}\n`);
    }
    if (!rname && pos[1]) io.err(` * branch            ${pos[1]}       -> FETCH_HEAD\n`);
    if (res.lines.some((l) => l.includes('[rejected]'))) code = 1;
  }
  if (!args.includes('--dry-run')) saveRepo(r);
  return code;
}

/* ----------------------------------------------------------------------------- pull */

function cmdPull(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  if (r.bare) die('fatal: this operation must be run in a work tree');
  const st = r.st;
  const pos = withoutOpts(args, ['--depth']);
  const b = st.head.branch;
  const up = b ? st.upstream?.[b] : undefined;
  if (!pos.length && !up) {
    if (!st.remotes || !Object.keys(st.remotes).length) die('fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.');
    die(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=${remoteNameFor(r, undefined)}/<branch> ${b ?? 'main'}\n`, 1);
  }
  const remoteName = pos[0] ?? up!.remote;
  const branch = pos[1] ?? (pos[0] && !up ? b : up?.merge) ?? b;
  const fetchCode = cmdFetch([remoteName, ...(branch ? [branch] : []), ...(args.includes('-q') ? ['-q'] : [])], io, ctx);
  if (fetchCode !== 0) return fetchCode;
  const r2 = openRepo(ctx, io, r.root);
  const isNamed = !!r2.st.remotes?.[remoteName];
  const source = isNamed ? `${remoteName}/${branch}` : r2.st.fetchHead!;
  const target = isNamed ? r2.st.remoteRefs?.[source] : r2.st.fetchHead;
  if (!target) die(`fatal: couldn't find remote ref ${branch}`);
  const head = headCommit(r2.st);
  const url = isNamed ? r2.st.remotes![remoteName].url : remoteName;
  const git = (a: string[]) => runCommand(ctx, ['git', ...a], io);
  if (!head) return git(['merge', '--ff-only', source]);
  if (ancestors(r2.st, head).has(target!)) {
    io.out('Already up to date.\n');
    return 0;
  }
  const ff = ancestors(r2.st, target).has(head);
  const pullRebase = configGet(ctx, r2.st, 'pull.rebase');
  const pullFf = configGet(ctx, r2.st, 'pull.ff');
  const wantRebase = args.includes('--rebase') || args.includes('-r') || (!args.includes('--no-rebase') && truthy(pullRebase));
  if (ff && !args.includes('--no-ff') && !wantRebase) return git(['merge', '--ff-only', source]);
  if (args.includes('--ff-only') || (pullFf === 'only' && !args.includes('--rebase') && !args.includes('--no-ff'))) {
    if (ff) return git(['merge', '--ff-only', source]);
    die('hint: Diverging branches can\'t be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with "git config advice.diverging false"\nfatal: Not possible to fast-forward, aborting.');
  }
  if (wantRebase) return git(['rebase', source]);
  const decided = args.includes('--no-rebase') || args.includes('--no-ff') || args.includes('--ff') || pullRebase !== undefined || pullFf !== undefined;
  if (!decided && !ff)
    die('hint: You have divergent branches and need to specify how to reconcile them.\nhint: You can do so by running one of the following commands sometime before\nhint: your next pull:\nhint:\nhint:   git config pull.rebase false  # merge\nhint:   git config pull.rebase true   # rebase\nhint:   git config pull.ff only       # fast-forward only\nhint:\nhint: You can replace "git config" with "git config --global" to set a default\nhint: preference for all repositories. You can also pass --rebase, --no-rebase,\nhint: or --ff-only on the command line to override the configured default per\nhint: invocation.\nfatal: Need to specify how to reconcile divergent branches.');
  return git(['merge', ...(args.includes('--no-ff') ? ['--no-ff'] : []), '-m', `Merge branch '${branch}' of ${url}${b && !['main', 'master'].includes(b) ? ` into ${b}` : ''}`, source]);
}

/* ----------------------------------------------------------------------------- push */

interface PushSpec {
  src: string | null;
  dst: string;
  force: boolean;
  tag: boolean;
}

function cmdPush(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const st = r.st;
  const pos = withoutOpts(args, ['--repo', '--push-option', '-o']);
  const flag = (...ns: string[]) => ns.some((n) => args.includes(n));
  const force = flag('-f', '--force');
  const leaseArg = args.find((a) => a.startsWith('--force-with-lease'));
  const setUp = flag('-u', '--set-upstream');
  const del = flag('-d', '--delete');
  const dry = flag('-n', '--dry-run');
  const quiet = flag('-q', '--quiet');
  const b = st.head.branch;
  const up = b ? st.upstream?.[b] : undefined;
  let remoteName = pos[0] ?? up?.remote ?? (Object.keys(st.remotes ?? {}).length === 1 ? Object.keys(st.remotes!)[0] : 'origin');
  if (!pos[0] && !st.remotes?.[remoteName])
    die('fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n');
  const { name: rname, url } = urlFor(r, remoteName);
  remoteName = rname ?? remoteName;
  // Work out what goes where.
  const specs: PushSpec[] = [];
  let refspecs = pos.slice(1);
  let autoUpstream = false;
  if (flag('--all')) refspecs = Object.keys(st.branches).filter((x) => st.branches[x]);
  if (flag('--tags')) for (const t of Object.keys(st.tags)) specs.push({ src: t, dst: `refs/tags/${t}`, force, tag: true });
  if (!refspecs.length && !flag('--tags')) {
    if (!b) die('fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push origin HEAD:<name-of-remote-branch>\n');
    if (!up && !pos[0]) {
      if (truthy(configGet(ctx, st, 'push.autosetupremote'))) autoUpstream = true;
      else die(`fatal: The current branch ${b} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remoteName} ${b}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n`);
    }
    refspecs = [up && up.remote === remoteName ? `${b}:${up.merge}` : b!];
  }
  for (let spec of refspecs) {
    let f = force;
    if (spec.startsWith('+')) {
      f = true;
      spec = spec.slice(1);
    }
    if (del) {
      specs.push({ src: null, dst: spec.replace(/^refs\/heads\//, ''), force: true, tag: false });
      continue;
    }
    const [s, d] = spec.includes(':') ? spec.split(':') : [spec, spec === 'HEAD' ? b ?? 'HEAD' : spec];
    if (s === '') {
      specs.push({ src: null, dst: d.replace(/^refs\/heads\//, ''), force: true, tag: false });
      continue;
    }
    const isTag = !!st.tags[s.replace(/^refs\/tags\//, '')] && st.branches[s] === undefined;
    if (!isTag && s !== 'HEAD' && st.branches[s.replace(/^refs\/heads\//, '')] === undefined && !/^[0-9a-f]{7,40}$/.test(s)) die(`error: src refspec ${s} does not match any\nerror: failed to push some refs to '${url}'`, 1);
    specs.push({ src: s, dst: isTag ? `refs/tags/${d.replace(/^refs\/tags\//, '')}` : d.replace(/^refs\/heads\//, ''), force: f, tag: isTag });
  }
  if (flag('--follow-tags')) for (const [t, id] of Object.entries(st.tags)) if (st.annotated?.[t] && specs.some((s) => s.src && ancestors(st, resolveLocal(st, s.src)).has(id))) specs.push({ src: t, dst: `refs/tags/${t}`, force: false, tag: true });
  const rm = connect(ctx, url, 'push', r.root);
  const dest = remoteState(ctx, rm);
  const updates: Array<RefUpdate & { label: string; status?: string; reason?: string }> = [];
  for (const s of specs) {
    const ref = s.tag ? s.dst : `refs/heads/${s.dst}`;
    const shortDst = s.tag ? s.dst.replace(/^refs\/tags\//, '') : s.dst;
    const oldId = s.tag ? dest.tags[shortDst] ?? null : dest.branches[s.dst] ?? null;
    const newId = s.src === null ? null : resolveLocal(st, s.src);
    const label = s.src === null ? shortDst : `${s.src.replace(/^refs\/(heads|tags)\//, '')} -> ${shortDst}`;
    const u = { ref, old: oldId, new: newId, force: s.force, label };
    if (newId === oldId) {
      updates.push({ ...u, status: 'uptodate' });
      continue;
    }
    if (newId === null && oldId === null) {
      updates.push({ ...u, status: 'error', reason: `unable to delete '${shortDst}': remote ref does not exist` });
      continue;
    }
    if (s.tag && oldId && !s.force) {
      updates.push({ ...u, status: 'rejected', reason: 'already exists' });
      continue;
    }
    if (leaseArg && newId) {
      const m = /^--force-with-lease(?:=([^:]+)(?::(.+))?)?$/.exec(leaseArg)!;
      const expect = m[2] ? resolveLocal(st, m[2]) : st.remoteRefs?.[`${remoteName}/${m[1] ?? s.dst}`] ?? null;
      if ((m[1] ?? s.dst) === s.dst && expect !== oldId) {
        updates.push({ ...u, status: 'rejected', reason: 'stale info' });
        continue;
      }
      u.force = true;
    }
    if (newId && oldId && !u.force && !ancestors(st, newId).has(oldId)) {
      updates.push({ ...u, status: 'rejected', reason: st.commits[oldId] ? 'non-fast-forward' : 'fetch first' });
      continue;
    }
    if (!rm.bare && !s.tag && dest.head.branch === s.dst && newId) {
      updates.push({ ...u, status: 'remote-rejected', reason: 'branch is currently checked out' });
      continue;
    }
    updates.push(u);
  }
  const todo = updates.filter((u) => !u.status);
  const fail = (code = 1) => {
    io.err(`To ${url}\n`);
    for (const u of updates) {
      if (u.status === 'uptodate') continue;
      if (u.status === 'rejected') io.err(` ! [rejected]        ${u.label} (${u.reason})\n`);
      else if (u.status === 'remote-rejected') io.err(` ! [remote rejected] ${u.label} (${u.reason})\n`);
      else if (u.status === 'error') io.err(`error: ${u.reason}\n`);
      else if (u.status === 'ok') io.err(line(u) + '\n');
    }
    io.err(`error: failed to push some refs to '${url}'\n`);
    const why = updates.find((u) => u.status === 'rejected')?.reason;
    if (why === 'fetch first') io.err("hint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n");
    if (why === 'non-fast-forward') io.err("hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n");
    if (why === 'already exists') io.err('hint: Updates were rejected because the tag already exists in the remote.\n');
    return code;
  };
  const line = (u: (typeof updates)[number]) => {
    if (u.new === null) return ` - [deleted]         ${u.label}`;
    if (!u.old) return ` * [new ${u.ref.startsWith('refs/tags/') ? 'tag' : 'branch'}]${u.ref.startsWith('refs/tags/') ? '         ' : '      '}${u.label}`;
    if (st.commits[u.new] && ancestors(st, u.new).has(u.old)) return `   ${short(u.old)}..${short(u.new)}  ${u.label}`;
    return ` + ${short(u.old)}...${short(u.new)} ${u.label} (forced update)`;
  };
  if (updates.some((u) => u.status && u.status !== 'uptodate')) {
    if (!todo.length) return fail();
  }
  if (!todo.length) {
    io.err('Everything up-to-date\n');
    return 0;
  }
  // pre-push hook on our side.
  if (!flag('--no-verify')) {
    const stdin = todo.map((u) => `${u.new ? (u.ref.startsWith('refs/tags/') ? u.ref : `refs/heads/${u.label.split(' -> ')[0]}`) : '(delete)'} ${u.new ?? ZERO} ${u.ref} ${u.old ?? ZERO}\n`).join('');
    saveRepo(r);
    const code = runHook(r, 'pre-push', [remoteName, url], stdin);
    if (code !== null && code !== 0) {
      io.err(`error: failed to push some refs to '${url}'\n`);
      return 1;
    }
  }
  const newIds = todo.map((u) => u.new).filter((x): x is string => !!x);
  const have = new Set<string>();
  for (const id of Object.values(dest.branches)) if (id && st.commits[id]) for (const c of ancestors(st, id)) have.add(c);
  const sending = [...reachable(st, newIds).ids].filter((c) => !have.has(c) && !dest.commits[c]);
  if (dry) {
    io.err(`To ${url}\n${todo.map((u) => line(u)).join('\n')}\n`);
    return 0;
  }
  if (!quiet) io.err(progressLines(objectCount(st, sending), false));
  // Server side: forge rules and hooks.
  const remoteRepo: Repo | null = rm.bundle ? null : { ctx, io, root: rm.path, gitDir: rm.bare ? rm.path : `${rm.path}/.git`, bare: rm.bare, st: dest };
  const prefix = (s: string) => s.replace(/^(?=.)/gm, 'remote: ');
  const rejections = rm.forge ? forgeBeforePush(ctx, rm.path, rm.user, todo, st, rm.scopes) : {};
  for (const [ref, reason] of Object.entries(rejections)) {
    const u = todo.find((x) => x.ref === ref)!;
    u.status = 'remote-rejected';
    u.reason = reason.split('\n')[0];
    io.err(prefix(reason.split('\n').slice(1).join('\n')) + (reason.includes('\n') ? '\n' : ''));
  }
  const live = todo.filter((u) => !u.status);
  if (live.length && remoteRepo) {
    // pre-receive sees every ref; a failure declines them all.
    const stdin = live.map((u) => `${u.old ?? ZERO} ${u.new ?? ZERO} ${u.ref}\n`).join('');
    // The objects are in the remote's quarantine area while its hooks run.
    copyCommits(st, dest, sending);
    saveRepo(remoteRepo, ROOT);
    const code = runHook(remoteRepo, 'pre-receive', [], stdin, prefix);
    if (code !== null && code !== 0) for (const u of live) Object.assign(u, { status: 'remote-rejected', reason: 'pre-receive hook declined' });
    else
      for (const u of live) {
        const c2 = runHook(remoteRepo, 'update', [u.ref, u.old ?? ZERO, u.new ?? ZERO], '', prefix);
        if (c2 !== null && c2 !== 0) Object.assign(u, { status: 'remote-rejected', reason: 'hook declined' });
      }
  }
  const accepted = todo.filter((u) => !u.status);
  if (remoteRepo) {
    const fresh = loadGit(ctx, rm.path);
    copyCommits(st, fresh, sending);
    for (const u of accepted) {
      const shortRef = u.ref.replace(/^refs\/(heads|tags)\//, '');
      if (u.ref.startsWith('refs/tags/')) {
        if (u.new) {
          fresh.tags[shortRef] = u.new;
          if (st.annotated?.[shortRef]) (fresh.annotated ??= {})[shortRef] = st.annotated[shortRef];
        } else delete fresh.tags[shortRef];
      } else if (u.new) fresh.branches[shortRef] = u.new;
      else delete fresh.branches[shortRef];
      u.status = 'ok';
    }
    const target: Repo = { ...remoteRepo, st: fresh };
    // A push into an empty bare repository makes the first branch its HEAD.
    if (fresh.bare && (fresh.branches[fresh.head.branch!] === null || fresh.branches[fresh.head.branch!] === undefined)) {
      const firstBranch = accepted.find((u) => u.new && !u.ref.startsWith('refs/tags/'));
      if (firstBranch && fresh.branches[fresh.head.branch!] === null) delete fresh.branches[fresh.head.branch!];
      if (firstBranch && !fresh.branches[fresh.head.branch!]) fresh.head = { branch: firstBranch.ref.slice(11) };
    }
    saveRepo(target, ROOT);
    if (accepted.length) runHook(target, 'post-receive', [], accepted.map((u) => `${u.old ?? ZERO} ${u.new ?? ZERO} ${u.ref}\n`).join(''), prefix);
  }
  // Remote-tracking refs follow what was accepted.
  if (rname) {
    st.remoteRefs ??= {};
    for (const u of accepted) {
      if (u.ref.startsWith('refs/tags/')) continue;
      const key = `${rname}/${u.ref.slice(11)}`;
      if (u.new) st.remoteRefs[key] = u.new;
      else delete st.remoteRefs[key];
      if (u.new && dest.head.branch === u.ref.slice(11) && st.remoteRefs[`${rname}/HEAD`]) st.remoteRefs[`${rname}/HEAD`] = u.new;
    }
  }
  if (rm.forge && accepted.length) {
    const after = forgeAfterPush(ctx, rm.path, rm.user, accepted, st);
    if (after) io.err(prefix(after) + '\n');
  }
  const rejected = updates.filter((u) => u.status && !['ok', 'uptodate'].includes(u.status));
  if (rejected.length) return fail();
  io.err(`To ${url}\n${accepted.map((u) => line(u)).join('\n')}\n`);
  if ((setUp || autoUpstream) && rname) {
    st.upstream ??= {};
    for (const u of accepted) {
      if (!u.new || u.ref.startsWith('refs/tags/')) continue;
      const local = u.label.split(' -> ')[0];
      if (st.branches[local] === undefined) continue;
      st.upstream[local] = { remote: rname, merge: u.ref.slice(11) };
      io.out(`branch '${local}' set up to track '${rname}/${u.ref.slice(11)}'.\n`);
    }
  }
  saveRepo(r);
  return 0;
}

function resolveLocal(st: GitState, ref: string): string {
  if (ref === 'HEAD') return headCommit(st)!;
  const b = ref.replace(/^refs\/heads\//, '');
  if (st.branches[b]) return st.branches[b]!;
  const t = ref.replace(/^refs\/tags\//, '');
  if (st.tags[t]) return st.tags[t];
  const hit = Object.keys(st.commits).find((id) => id.startsWith(ref));
  if (hit) return hit;
  return die(`error: src refspec ${ref} does not match any`, 1);
}

/* ----------------------------------------------------------------------------- clone */

function cmdClone(args: string[], io: IO, ctx: Ctx): number {
  const pos = withoutOpts(args, ['--depth', '--branch', '-b', '--filter', '--origin', '-o', '--config', '-c', '--shallow-since', '--reference', '--template', '--separate-git-dir', '-j', '--jobs']);
  const url = pos[0];
  if (!url) die('fatal: You must specify a repository to clone.\n\nusage: git clone [<options>] [--] <repo> [<dir>]');
  const bare = args.includes('--bare') || args.includes('--mirror');
  const quiet = args.includes('-q') || args.includes('--quiet');
  const isLocalPath = !/^[a-z]+:\/\//i.test(url) && !/^[\w.-]+@[\w.-]+:/.test(url);
  const name = url.replace(/\/+$/, '').replace(/\.bundle$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '') + (bare ? '.git' : '');
  const target = abs(ctx, pos[1] ?? name);
  const existing = lookup(ctx.sys.fs, target, ROOT);
  if (existing && (existing.node.type !== 'dir' || Object.keys(existing.node.children).length)) die(`fatal: destination path '${pos[1] ?? name}' already exists and is not an empty directory.`);
  let depthArg = opt(args, '--depth');
  if (depthArg && isLocalPath && !url.startsWith('file://')) {
    io.err('warning: --depth is ignored in local clones; use file:// instead.\n');
    depthArg = undefined;
  }
  const filter = opt(args, '--filter');
  if (filter && isLocalPath && !url.startsWith('file://')) io.err('warning: filtering not recognized by server, ignoring\n');
  const rm = connect(ctx, url, 'fetch');
  const src = remoteState(ctx, rm);
  // A local source is recorded as an absolute path, so the clone works from anywhere.
  const storedUrl = isLocalPath && !url.startsWith('file://') ? abs(ctx, url) : url;
  if (!quiet) io.err(`Cloning into ${bare ? 'bare repository ' : ''}'${pos[1] ?? name}'...\n`);
  mkdir(ctx.sys.fs, target, actor(ctx), ctx.sys.now, true);
  const originName = opt(args, '--origin') ?? opt(args, '-o') ?? 'origin';
  const heads = remoteBranches(src);
  const wantBranch = opt(args, '--branch') ?? opt(args, '-b');
  const headBranch = wantBranch ?? (src.head.branch && heads[src.head.branch] ? src.head.branch : Object.keys(heads)[0]);
  if (wantBranch && !heads[wantBranch] && !src.tags[wantBranch]) {
    die(`warning: Could not find remote branch ${wantBranch} to clone.\nfatal: Remote branch ${wantBranch} not found in upstream ${originName}`);
  }
  initRepo(ctx, target, { bare, branch: headBranch ?? src.head.branch ?? 'main' });
  const r = openRepo(ctx, io, target);
  const st = r.st;
  const single = args.includes('--single-branch') || !!depthArg;
  const branchSet = single && headBranch ? { [headBranch]: heads[headBranch] } : heads;
  const tips = Object.values(branchSet).filter(Boolean);
  const depth = depthArg ? Number(depthArg) : undefined;
  const { ids, boundary } = reachable(src, tips, depth);
  const partial = filter && !(isLocalPath && !url.startsWith('file://')) ? { remote: originName, filter } : undefined;
  copyCommits(src, st, ids, partial ? { partialKeep: new Set(tips) } : {});
  if (boundary.size) st.shallow = [...boundary];
  if (partial) st.partial = partial;
  for (const [t, id] of Object.entries(src.tags)) {
    if (!st.commits[id]) continue;
    st.tags[t] = id;
    if (src.annotated?.[t]) (st.annotated ??= {})[t] = src.annotated[t];
  }
  if (!quiet) {
    if (isLocalPath && !url.startsWith('file://') && !rm.bundle) io.err('done.\n');
    else if (ids.size) io.err(progressLines(objectCount(src, [...ids]), true).replace('Unpacking objects', 'Receiving objects') + `Resolving deltas: 100% (0/0), done.\n`);
  }
  if (!headBranch || !tips.length) {
    if (!bare) st.remotes = { [originName]: { url: storedUrl } };
    saveRepo(r);
    io.err('warning: You appear to have cloned an empty repository.\n');
    return 0;
  }
  if (bare) {
    st.branches = { ...heads };
    st.head = { branch: headBranch };
    if (args.includes('--mirror')) st.remotes = { origin: { url: storedUrl } };
    saveRepo(r);
    return 0;
  }
  st.remotes = { [originName]: { url: storedUrl } };
  st.remoteRefs = {};
  for (const [b, id] of Object.entries(branchSet)) st.remoteRefs[`${originName}/${b}`] = id;
  if (!single) st.remoteRefs[`${originName}/HEAD`] = heads[src.head.branch ?? headBranch] ?? branchSet[headBranch];
  const headId = branchSet[headBranch] ?? src.tags[wantBranch ?? ''];
  st.branches = { [headBranch]: headId };
  st.upstream = { [headBranch]: { remote: originName, merge: headBranch } };
  st.head = { branch: headBranch };
  if (args.includes('--sparse')) st.sparse = [];
  if (!args.includes('--no-checkout') && !args.includes('-n')) {
    const tree = r.st.partial ? { ...st.commits[headId].tree } : st.commits[headId].tree;
    checkoutTree(r, {}, tree, st.commits[headId].x ?? [], []);
    st.index = { ...tree };
    st.x = [...(st.commits[headId].x ?? [])];
  }
  st.reflogs = {};
  logRef(r, `refs/heads/${headBranch}`, null, headId, `clone: from ${storedUrl}`);
  logRef(r, 'HEAD', null, headId, `clone: from ${storedUrl}`);
  saveRepo(r);
  return 0;
}

/* ----------------------------------------------------------------------------- remote, ls-remote */

function cmdRemote(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const st = r.st;
  const verbose = args.includes('-v') || args.includes('--verbose');
  const rest = args.filter((a) => a !== '-v' && a !== '--verbose');
  const [sub, ...pos] = rest;
  st.remotes ??= {};
  if (!sub) {
    for (const [n, rm] of Object.entries(st.remotes)) io.out(verbose ? `${n}\t${rm.url} (fetch)\n${n}\t${rm.url} (push)\n` : `${n}\n`);
    return 0;
  }
  switch (sub) {
    case 'add': {
      const p = pos.filter((a) => !a.startsWith('-'));
      const [n, url] = p;
      if (!n || !url) die('usage: git remote add [<options>] <name> <url>', 129);
      if (st.remotes[n]) die(`error: remote ${n} already exists.`, 3);
      st.remotes[n] = { url };
      saveRepo(r);
      if (pos.includes('-f') || pos.includes('--fetch')) return cmdFetch([n], io, ctx);
      return 0;
    }
    case 'remove':
    case 'rm': {
      const n = pos[0];
      if (!st.remotes[n]) die(`error: No such remote: '${n}'`, 2);
      delete st.remotes[n];
      for (const k of Object.keys(st.remoteRefs ?? {})) if (k.startsWith(n + '/')) delete st.remoteRefs![k];
      for (const [b, u] of Object.entries(st.upstream ?? {})) if (u.remote === n) delete st.upstream![b];
      saveRepo(r);
      return 0;
    }
    case 'rename': {
      const [a, b] = pos;
      if (!st.remotes[a]) die(`error: No such remote: '${a}'`, 2);
      if (st.remotes[b]) die(`error: remote ${b} already exists.`, 3);
      st.remotes[b] = st.remotes[a];
      delete st.remotes[a];
      for (const k of Object.keys(st.remoteRefs ?? {})) {
        if (!k.startsWith(a + '/')) continue;
        st.remoteRefs![b + k.slice(a.length)] = st.remoteRefs![k];
        delete st.remoteRefs![k];
      }
      for (const u of Object.values(st.upstream ?? {})) if (u.remote === a) u.remote = b;
      saveRepo(r);
      return 0;
    }
    case 'get-url': {
      const n = pos.find((a) => !a.startsWith('-'))!;
      if (!st.remotes[n]) die(`error: No such remote '${n}'`, 2);
      io.out(st.remotes[n].url + '\n');
      return 0;
    }
    case 'set-url': {
      const p = pos.filter((a) => !a.startsWith('-'));
      const [n, url] = p;
      if (!st.remotes[n]) die(`error: No such remote '${n}'`, 2);
      st.remotes[n] = { url };
      saveRepo(r);
      return 0;
    }
    case 'show': {
      const n = pos[0];
      if (!n) {
        for (const k of Object.keys(st.remotes)) io.out(k + '\n');
        return 0;
      }
      if (!st.remotes[n]) die(`fatal: '${n}' does not appear to be a git repository\nfatal: Could not read from remote repository.`);
      const url = st.remotes[n].url;
      const src = remoteState(ctx, connect(ctx, url, 'fetch', r.root));
      const heads = remoteBranches(src);
      const w = Math.max(...Object.keys(heads).map((b) => b.length), 4);
      let s = `* remote ${n}\n  Fetch URL: ${url}\n  Push  URL: ${url}\n  HEAD branch: ${src.head.branch ?? '(unknown)'}\n  Remote branch${Object.keys(heads).length === 1 ? '' : 'es'}:\n`;
      for (const b of Object.keys(heads).sort()) s += `    ${b.padEnd(w)} ${st.remoteRefs?.[`${n}/${b}`] ? 'tracked' : 'new (next fetch will store in remotes/' + n + ')'}\n`;
      for (const k of Object.keys(st.remoteRefs ?? {})) if (k.startsWith(n + '/') && !k.endsWith('/HEAD') && !heads[k.slice(n.length + 1)]) s += `    refs/remotes/${k} stale (use 'git remote prune' to remove)\n`;
      const pulls = Object.entries(st.upstream ?? {}).filter(([, u]) => u.remote === n);
      if (pulls.length) s += `  Local branch${pulls.length === 1 ? '' : 'es'} configured for 'git pull':\n${pulls.map(([b, u]) => `    ${b} merges with remote ${u.merge}\n`).join('')}`;
      if (pulls.length) {
        s += `  Local ref${pulls.length === 1 ? '' : 's'} configured for 'git push':\n`;
        for (const [b, u] of pulls) {
          const local = st.branches[b];
          const remote = heads[u.merge];
          const state = local === remote ? 'up to date' : remote && local && ancestors(st, local).has(remote) ? 'fast-forwardable' : remote && local && st.commits[remote] && ancestors(st, remote).has(local) ? 'local out of date' : 'local out of date';
          s += `    ${b} pushes to ${u.merge} (${state})\n`;
        }
      }
      io.out(s);
      return 0;
    }
    case 'prune': {
      const n = pos.filter((a) => !a.startsWith('-'))[0];
      if (!st.remotes[n]) die(`fatal: '${n}' does not appear to be a git repository`);
      const heads = remoteBranches(remoteState(ctx, connect(ctx, st.remotes[n].url, 'fetch', r.root)));
      const gone = Object.keys(st.remoteRefs ?? {}).filter((k) => k.startsWith(n + '/') && !k.endsWith('/HEAD') && !heads[k.slice(n.length + 1)]);
      if (gone.length) io.out(`Pruning ${n}\nURL: ${st.remotes[n].url}\n${gone.map((k) => ` * [${pos.includes('--dry-run') || pos.includes('-n') ? 'would prune' : 'pruned'}] ${k}\n`).join('')}`);
      if (!pos.includes('--dry-run') && !pos.includes('-n')) for (const k of gone) delete st.remoteRefs![k];
      saveRepo(r);
      return 0;
    }
    case 'update':
      return cmdFetch(['--all', ...(pos.includes('-p') || pos.includes('--prune') ? ['--prune'] : [])], io, ctx);
  }
  die(`error: unknown subcommand: \`${sub}'\nusage: git remote [-v | --verbose]\n   or: git remote add [-t <branch>] [-m <master>] [-f] [--tags | --no-tags] [--mirror=<fetch|push>] <name> <url>\n   or: git remote rename [--[no-]progress] <old> <new>\n   or: git remote remove <name>\n   or: git remote set-url [--push] <name> <newurl> [<oldurl>]\n   or: git remote [-v | --verbose] show [-n] <name>\n   or: git remote prune [-n | --dry-run] <name>`, 129);
  return 129;
}

function cmdLsRemote(args: string[], io: IO, ctx: Ctx): number {
  const pos = args.filter((a) => !a.startsWith('-'));
  const repoDir = findRepo(ctx);
  const r = repoDir ? openRepo(ctx, io, repoDir) : null;
  const target = pos[0] ?? (r ? r.st.remotes?.origin?.url : undefined);
  if (!target) die('fatal: No remote configured to list refs from.');
  const url = r?.st.remotes?.[target!]?.url ?? target!;
  const src = remoteState(ctx, connect(ctx, url, 'fetch', r?.root ?? ctx.sys.cwd));
  const heads = args.includes('--heads') || args.includes('-h') || args.includes('--branches');
  const tags = args.includes('--tags') || args.includes('-t');
  const patterns = pos.slice(1);
  const rows: Array<[string, string]> = [];
  if (!heads && !tags && src.head.branch && src.branches[src.head.branch]) rows.push([src.branches[src.head.branch]!, 'HEAD']);
  if (!tags) for (const b of Object.keys(src.branches).sort()) if (src.branches[b]) rows.push([src.branches[b]!, `refs/heads/${b}`]);
  if (!heads) for (const t of Object.keys(src.tags).sort()) rows.push([src.tags[t], `refs/tags/${t}`]);
  for (const [id, ref] of rows) if (!patterns.length || patterns.some((p) => ref.endsWith(p))) io.out(`${id}\t${ref}\n`);
  return 0;
}

/* ----------------------------------------------------------------------------- bundle */

function cmdBundle(args: string[], io: IO, ctx: Ctx): number {
  const [sub, file, ...rest] = args;
  if (sub === 'create') {
    const r = needRepo(ctx, io);
    const st = r.st;
    if (!file) die('usage: git bundle create [<options>] <file> <git-rev-list args>', 129);
    const refs: Record<string, string> = {};
    const tips: string[] = [];
    const excluded = new Set<string>();
    const revs = rest.filter((a) => a !== '-q' && a !== '--quiet');
    for (const a of revs) {
      if (a === '--all') {
        for (const [b, id] of Object.entries(st.branches)) if (id) refs[`refs/heads/${b}`] = id;
        for (const [t, id] of Object.entries(st.tags)) refs[`refs/tags/${t}`] = id;
        continue;
      }
      if (a === '--branches') {
        for (const [b, id] of Object.entries(st.branches)) if (id) refs[`refs/heads/${b}`] = id;
        continue;
      }
      if (a === '--tags') {
        for (const [t, id] of Object.entries(st.tags)) refs[`refs/tags/${t}`] = id;
        continue;
      }
      const range = /^(.*)\.\.(.*)$/.exec(a);
      const name = range ? range[2] || 'HEAD' : a.replace(/^\^/, '');
      const ex = range ? range[1] : a.startsWith('^') ? a.slice(1) : null;
      if (ex) for (const c of ancestors(st, resolveLocal(st, ex))) excluded.add(c);
      if (a.startsWith('^')) continue;
      const id = resolveLocal(st, name);
      const ref = st.branches[name] !== undefined ? `refs/heads/${name}` : st.tags[name] ? `refs/tags/${name}` : name === 'HEAD' ? (st.head.branch ? `refs/heads/${st.head.branch}` : 'HEAD') : name;
      refs[ref] = id;
    }
    for (const id of Object.values(refs)) tips.push(id);
    if (!tips.length) die('fatal: Refusing to create empty bundle.');
    const ids = [...reachable(st, tips).ids].filter((c) => !excluded.has(c));
    const prereqs = [...new Set(ids.flatMap((c) => st.commits[c].parents).filter((p) => !ids.includes(p) && st.commits[p]))];
    const commits: Record<string, GitCommit> = {};
    for (const c of ids) commits[c] = st.commits[c];
    const annotated: GitState['annotated'] = {};
    for (const ref of Object.keys(refs)) if (ref.startsWith('refs/tags/') && st.annotated?.[ref.slice(10)]) annotated[ref.slice(10)] = st.annotated[ref.slice(10)];
    const text = `${BUNDLE_HEADER}\n${prereqs.map((p) => `-${p} ${st.commits[p].message.split('\n')[0]}\n`).join('')}${Object.entries(refs).map(([ref, id]) => `${id} ${ref}\n`).join('')}\n${JSON.stringify({ commits, annotated })}`;
    writeFile(ctx.sys.fs, abs(ctx, file), text, actor(ctx), ctx.sys.now);
    io.err(progressLines(objectCount(st, ids), false));
    return 0;
  }
  if (sub === 'verify' || sub === 'list-heads') {
    if (!file) die(`usage: git bundle ${sub} <file>`, 129);
    let text: string;
    try {
      text = readFile(ctx.sys.fs, abs(ctx, file), actor(ctx));
    } catch {
      return die(`error: could not open '${file}'`);
    }
    if (!text.startsWith(BUNDLE_HEADER)) die(`error: '${file}' does not look like a v2 or v3 bundle file`);
    const b = readBundle(text)!;
    if (sub === 'list-heads') {
      for (const [ref, id] of Object.entries(b.refs)) io.out(`${id} ${ref}\n`);
      return 0;
    }
    const repoDir = findRepo(ctx);
    const st = repoDir ? loadGit(ctx, repoDir) : null;
    const missing = b.prereqs.filter((p) => !st?.commits[p]);
    if (missing.length) die(`error: Repository lacks these prerequisite commits:\n${missing.map((m) => `error: ${m}`).join('\n')}`, 1);
    io.out(`The bundle contains ${Object.keys(b.refs).length === 1 ? 'this ref' : `these ${Object.keys(b.refs).length} refs`}:\n${Object.entries(b.refs).map(([ref, id]) => `${id} ${ref}\n`).join('')}${b.prereqs.length ? `The bundle requires ${b.prereqs.length === 1 ? 'this ref' : `these ${b.prereqs.length} refs`}:\n${b.prereqs.map((p) => p + '\n').join('')}` : 'The bundle records a complete history.\n'}`);
    io.err(`${file} is okay\n`);
    return 0;
  }
  die('usage: git bundle create [<options>] <file> <git-rev-list args>\n   or: git bundle verify [<options>] <file>\n   or: git bundle list-heads <file> [<refname>...]', 129);
  return 129;
}

export const REMOTE_COMMANDS: Record<string, Cmd> = {
  clone: cmdClone,
  fetch: cmdFetch,
  pull: cmdPull,
  push: cmdPush,
  remote: cmdRemote,
  'ls-remote': cmdLsRemote,
  bundle: cmdBundle,
};

/** For callers outside git: runs a remote subcommand by name. */
export function gitRemoteCommand(name: string, args: string[], io: IO, ctx: Ctx): number {
  return REMOTE_COMMANDS[name](args, io, ctx);
}

void plural;
