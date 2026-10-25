/**
 * A simulated git for the terminal engine. Each repository's state lives in .git/state.json (or
 * objects/state.json for a bare repository) inside the simulated file system, so it is saved,
 * reset and inspected like any other file; HEAD, refs/, config and logs/HEAD are written beside it.
 *
 * Supported: init, clone, config, status, add, rm, mv, commit (with hooks and the editor), log,
 * shortlog, show, diff, blame, grep, branch, switch, checkout, restore, reset, merge, rebase
 * (including -i, --onto, --autosquash), cherry-pick, revert, stash, tag, describe, reflog, bisect,
 * rerere, clean, remote, fetch, pull, push, ls-remote, bundle, sparse-checkout, archive, and the
 * plumbing used to teach the object model (cat-file, ls-tree, hash-object, rev-parse, rev-list,
 * merge-base, ls-files, check-ignore, count-objects, show-ref, for-each-ref, symbolic-ref, fsck, gc).
 */

import { FsError, lookup, mkdir, readFile, remove, writeFile } from './fs.js';
import { actor, runCommand, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { blobId, commitText, tagId, tagText, treeEntries, treeId, type GitCommit, type GitState, type Sequencer, type TodoItem } from './git-state.js';
import {
  GitExit,
  initRepo,
  ROOT,
  ancestors,
  checkoutTree,
  cleanMessage,
  configGet,
  countChanges,
  decorations,
  die,
  editFile,
  envOf,
  execOf,
  findRepo,
  formatCommit,
  gitDate,
  globalConfigPath,
  graphLines,
  headCommit,
  headTree,
  hunks,
  ident,
  ignoreCheck,
  iniText,
  isRev,
  logRef,
  mergeTrees,
  moveHead,
  mustRev,
  newCommit,
  nextTime,
  normKey,
  openRepo,
  orderCommits,
  parseGitDate,
  pathMatch,
  plural,
  printTreeDiff,
  readConfigFile,
  reflogText,
  relative,
  repoPath,
  rerereOnConflict,
  rerereRecord,
  rev,
  runHook,
  saveRepo,
  selectCommits,
  setBranch,
  short,
  stashId,
  subject,
  treeOf,
  truthy,
  untrackedFiles,
  workTree,
  writeWorking,
  type Person,
  type Repo,
  type Unmerged,
  type Work,
} from './git-core.js';
import { gitRemoteCommand, REMOTE_COMMANDS } from './git-remote.js';

export { seedRepo, type GitCommit, type GitState } from './git-state.js';
export { ancestors, findRepo, headCommit, loadGit } from './git-core.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/* ----------------------------------------------------------------------------- option parsing */

export interface Parsed {
  flags: Set<string>;
  vals: Record<string, string[]>;
  pos: string[];
  /** Arguments after "--" (null when there was no "--"). */
  paths: string[] | null;
}

/**
 * Parses git-style options. `withVal` lists long names that take a value (also as --name value);
 * `shorts` maps one-letter options to long names (a trailing ":" means it takes a value).
 */
export function gitOpts(args: string[], withVal: string[] = [], shorts: Record<string, string> = {}): Parsed {
  const flags = new Set<string>();
  const vals: Record<string, string[]> = {};
  const pos: string[] = [];
  let paths: string[] | null = null;
  const put = (k: string, v: string) => (vals[k] ??= []).push(v);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (paths) {
      paths.push(a);
      continue;
    }
    if (a === '--') {
      paths = [];
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) put(name, a.slice(eq + 1));
      else if (withVal.includes(name)) put(name, args[++i] ?? '');
      else flags.add(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const def = shorts[a[k]];
        const long = def?.replace(/:$/, '') ?? a[k];
        if (def?.endsWith(':')) {
          put(long, k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? '');
          break;
        }
        flags.add(long);
      }
      continue;
    }
    if (/^-\d+$/.test(a)) {
      put('max-count', a.slice(1));
      continue;
    }
    pos.push(a);
  }
  return { flags, vals, pos, paths };
}
const val = (o: Parsed, k: string) => o.vals[k]?.[o.vals[k].length - 1];
const has = (o: Parsed, ...ks: string[]) => ks.some((k) => o.flags.has(k) || o.vals[k] !== undefined);

/* ----------------------------------------------------------------------------- shared helpers */

function needRepo(ctx: Ctx, io: IO): Repo {
  const path = findRepo(ctx);
  if (!path) die('fatal: not a git repository (or any of the parent directories): .git');
  return openRepo(ctx, io, path!);
}
function needWorkTree(r: Repo, what = 'this operation'): void {
  if (r.bare) die(`fatal: ${what} must be run in a work tree`);
}

/** The state of the index against HEAD and the working tree. */
interface Changes {
  ht: Record<string, string>;
  hx: string[];
  w: Work;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  ignored: string[];
}

function changes(r: Repo, withIgnored = false): Changes {
  const st = r.st;
  const head = headCommit(st);
  const ht = treeOf(r, head);
  const hx = execOf(r, head);
  const w = workTree(r);
  const ix = st.x ?? [];
  const staged = [...new Set([...Object.keys(ht), ...Object.keys(st.index)])].sort().filter((p) => !st.unmerged?.[p] && (ht[p] !== st.index[p] || (st.index[p] !== undefined && hx.includes(p) !== ix.includes(p))));
  const unstaged = Object.keys(st.index)
    .sort()
    .filter((p) => !st.unmerged?.[p] && (w.files[p] !== st.index[p] || (w.files[p] !== undefined && w.exec.has(p) !== ix.includes(p))));
  const u = untrackedFiles(r, w, withIgnored);
  return { ht, hx, w, staged, unstaged, untracked: u.untracked, ignored: u.ignored };
}

function isDirty(c: Changes, st: GitState): boolean {
  return c.staged.length > 0 || c.unstaged.length > 0 || Object.keys(st.unmerged ?? {}).length > 0;
}

function setIndexFromTree(r: Repo, tree: Record<string, string>, x: string[]): void {
  r.st.index = { ...tree };
  r.st.x = [...x];
}

function stageFile(r: Repo, p: string, w: Work): void {
  if (w.files[p] === undefined) {
    delete r.st.index[p];
    r.st.x = (r.st.x ?? []).filter((q) => q !== p);
  } else {
    r.st.index[p] = w.files[p];
    const xs = new Set(r.st.x ?? []);
    if (w.exec.has(p)) xs.add(p);
    else xs.delete(p);
    r.st.x = [...xs];
  }
  if (r.st.unmerged?.[p]) {
    delete r.st.unmerged[p];
    if (!Object.keys(r.st.unmerged).length) delete r.st.unmerged;
  }
}

/** Paths a pathspec selects among `candidates`. */
function matchSpec(r: Repo, spec: string, candidates: string[]): string[] {
  const rel = repoPath(r, spec);
  if (/[*?[]/.test(spec)) {
    const prefix = repoPath(r, '.') ?? '';
    const pat = (prefix ? prefix + '/' : '') + spec.replace(/^\.\//, '');
    return candidates.filter((p) => pathMatch(p, [pat]));
  }
  if (rel === null) die(`fatal: ${spec}: '${spec}' is outside repository at '${r.root}'`);
  return candidates.filter((p) => rel === '' || p === rel || p.startsWith(rel + '/'));
}

function commitLine(r: Repo, id: string): string {
  return `${short(id)} ${subject(r.st.commits[id].message)}`;
}

function relDisplay(r: Repo, p: string): string {
  const prefix = repoPath(r, '.') ?? '';
  if (!prefix) return p;
  if (p.startsWith(prefix + '/')) return p.slice(prefix.length + 1);
  const up = prefix.split('/').length;
  return '../'.repeat(up) + p;
}

/** Collapses untracked files to their top untracked directory, as git status does. */
function collapseUntracked(r: Repo, files: string[], all: string[]): string[] {
  const tracked = Object.keys(r.st.index);
  const out = new Set<string>();
  for (const p of files) {
    const parts = p.split('/');
    let shown = p;
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join('/');
      if (!tracked.some((t) => t.startsWith(dir + '/')) && all.filter((q) => q.startsWith(dir + '/')).every((q) => files.includes(q))) {
        shown = dir + '/';
        break;
      }
    }
    out.add(shown);
  }
  return [...out].sort();
}

function aheadBehind(r: Repo, a: string | null, b: string | null): { ahead: number; behind: number } {
  const A = ancestors(r.st, a);
  const B = ancestors(r.st, b);
  return { ahead: [...A].filter((c) => !B.has(c)).length, behind: [...B].filter((c) => !A.has(c)).length };
}

function trackingLine(r: Repo): string {
  const st = r.st;
  const b = st.head.branch;
  if (!b) return '';
  const u = st.upstream?.[b];
  if (!u) return '';
  const name = `${u.remote}/${u.merge}`;
  const rid = st.remoteRefs?.[name];
  if (!rid) return `Your branch is based on '${name}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`;
  const { ahead, behind } = aheadBehind(r, headCommit(st), rid);
  if (!ahead && !behind) return `Your branch is up to date with '${name}'.\n`;
  if (ahead && !behind) return `Your branch is ahead of '${name}' by ${plural(ahead, 'commit')}.\n  (use "git push" to publish your local commits)\n`;
  if (!ahead && behind) return `Your branch is behind '${name}' by ${plural(behind, 'commit')}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`;
  return `Your branch and '${name}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}

/* ----------------------------------------------------------------------------- init */

function cmdInit(args: string[], io: IO, ctx: Ctx): number {
  const o = gitOpts(args, ['initial-branch', 'template', 'shared'], { b: 'initial-branch:', q: 'quiet' });
  const dir = o.pos[0];
  const target = dir ? abs(ctx, dir) : ctx.sys.cwd;
  const bare = o.flags.has('bare');
  const existing = lookup(ctx.sys.fs, `${target === '/' ? '' : target}/${bare ? 'objects/state.json' : '.git/state.json'}`, ROOT);
  if (existing) {
    io.out(`Reinitialized existing Git repository in ${bare ? target : target + '/.git'}/\n`);
    return 0;
  }
  try {
    if (dir) mkdir(ctx.sys.fs, target, actor(ctx), ctx.sys.now, true);
    initRepo(ctx, target, { bare, branch: val(o, 'initial-branch'), shared: o.flags.has('shared') ? 'group' : val(o, 'shared') });
  } catch (e) {
    return die(`fatal: cannot mkdir ${target}: ${e instanceof FsError ? e.message.replace(/^.*?: /, '') : String(e)}`);
  }
  if (!o.flags.has('quiet')) io.out(`Initialized empty ${o.vals.shared || o.flags.has('shared') ? 'shared ' : ''}Git repository in ${bare ? target : (target === '/' ? '' : target) + '/.git'}/\n`);
  return 0;
}

/* ----------------------------------------------------------------------------- config */

function cmdConfig(args: string[], io: IO, ctx: Ctx): number {
  const o = gitOpts(args, ['file', 'type', 'default'], { l: 'list', e: 'edit', f: 'file:' });
  const scope = o.flags.has('global') ? 'global' : o.flags.has('system') ? 'system' : o.flags.has('local') ? 'local' : val(o, 'file') ? 'file' : 'auto';
  const repoPathFound = findRepo(ctx);
  const r = repoPathFound ? openRepo(ctx, io, repoPathFound) : null;
  const fileFor = (s: string) => (s === 'global' ? globalConfigPath(ctx) : s === 'system' ? '/etc/gitconfig' : abs(ctx, val(o, 'file')!));
  if (o.flags.has('list')) {
    const show = (origin: string, map: Record<string, string>) => {
      for (const [k, v] of Object.entries(map)) io.out(`${o.flags.has('show-origin') ? `file:${origin}\t` : ''}${o.flags.has('name-only') ? k : `${k}=${v}`}\n`);
    };
    if (scope === 'auto' || scope === 'system') show('/etc/gitconfig', readConfigFile(ctx, '/etc/gitconfig'));
    if (scope === 'auto' || scope === 'global') show(globalConfigPath(ctx), readConfigFile(ctx, globalConfigPath(ctx)));
    if (scope === 'file') show(fileFor('file'), readConfigFile(ctx, fileFor('file')));
    if ((scope === 'auto' || scope === 'local') && r) {
      const local: Record<string, string> = { 'core.repositoryformatversion': '0', 'core.filemode': 'true', 'core.bare': r.bare ? 'true' : 'false' };
      if (r.st.config.name) local['user.name'] = r.st.config.name;
      if (r.st.config.email) local['user.email'] = r.st.config.email;
      for (const [k, v] of Object.entries(r.st.config)) if (k !== 'name' && k !== 'email' && v !== undefined) local[k] = v;
      for (const [n, rm] of Object.entries(r.st.remotes ?? {})) {
        local[`remote.${n}.url`] = rm.url;
        local[`remote.${n}.fetch`] = `+refs/heads/*:refs/remotes/${n}/*`;
      }
      for (const [b, u] of Object.entries(r.st.upstream ?? {})) {
        local[`branch.${b}.remote`] = u.remote;
        local[`branch.${b}.merge`] = `refs/heads/${u.merge}`;
      }
      show('.git/config', local);
    } else if (scope === 'local' && !r) die('fatal: --local can only be used inside a git repository');
    return 0;
  }
  if (o.flags.has('edit')) {
    const path = scope === 'auto' || scope === 'local' ? (r ? `${r.gitDir}/config` : die('fatal: not in a git directory')) : fileFor(scope);
    let content = '';
    try {
      content = readFile(ctx.sys.fs, path as string, actor(ctx));
    } catch {
      /* new */
    }
    ctx.requests.push({ kind: 'editor', path: path as string, content, then: scope === 'auto' || scope === 'local' ? `git -C ${r!.root} config --lab-reload` : undefined });
    return 0;
  }
  if (o.flags.has('lab-reload') && r) {
    // The learner edited .git/config by hand: read it back into the repository state.
    const map = readConfigFile(ctx, `${r.gitDir}/config`);
    const st = r.st;
    st.config = {};
    st.remotes = {};
    st.upstream = {};
    for (const [k, v] of Object.entries(map)) {
      const rm = /^remote\.(.+)\.(url|fetch)$/.exec(k);
      const bm = /^branch\.(.+)\.(remote|merge)$/.exec(k);
      if (k === 'user.name') st.config.name = v;
      else if (k === 'user.email') st.config.email = v;
      else if (rm) {
        if (rm[2] === 'url') st.remotes[rm[1]] = { url: v };
      } else if (bm) {
        const u = (st.upstream[bm[1]] ??= { remote: 'origin', merge: bm[1] });
        if (bm[2] === 'remote') u.remote = v;
        else u.merge = v.replace(/^refs\/heads\//, '');
      } else if (!k.startsWith('core.')) st.config[k] = v;
    }
    saveRepo(r);
    return 0;
  }
  const unset = o.flags.has('unset') || o.flags.has('unset-all');
  const key = o.pos[0];
  if (!key) die('usage: git config [<options>]\n\n    --global              use global config file\n    --local               use repository config file\n    -l, --list            list all\n    --get                 get value: name\n    --unset               remove a variable: name');
  if (!key.includes('.')) die(`error: key does not contain a section: ${key}`, 2);
  const k = normKey(key);
  const value = o.flags.has('get') || o.flags.has('get-all') ? undefined : o.pos.slice(1).join(' ') || undefined;
  if (value === undefined && !unset) {
    const v = scope === 'global' || scope === 'system' || scope === 'file' ? readConfigFile(ctx, fileFor(scope))[k] : scope === 'local' ? (r ? configGetLocal(r.st, k) : undefined) : configGet(ctx, r?.st ?? null, k);
    if (v === undefined) {
      if (val(o, 'default') !== undefined) io.out(val(o, 'default') + '\n');
      return val(o, 'default') !== undefined ? 0 : 1;
    }
    io.out((o.vals.type?.includes('bool') ? (truthy(v) ? 'true' : 'false') : v) + '\n');
    return 0;
  }
  if (scope === 'global' || scope === 'system' || scope === 'file') {
    const path = fileFor(scope);
    const map = readConfigFile(ctx, path);
    if (unset) {
      if (map[k] === undefined) return 5;
      delete map[k];
    } else map[k] = value!;
    try {
      writeFile(ctx.sys.fs, path, iniText(map), actor(ctx), ctx.sys.now);
    } catch (e) {
      die(`error: could not lock config file ${path}: ${e instanceof FsError ? 'Permission denied' : String(e)}`, 255);
    }
    return 0;
  }
  if (!r) die('fatal: not in a git directory');
  const st = r!.st;
  const rm = /^remote\.(.+)\.url$/.exec(k);
  const bm = /^branch\.(.+)\.(remote|merge)$/.exec(k);
  if (k === 'user.name' || k === 'user.email') {
    const f = k === 'user.name' ? 'name' : 'email';
    if (unset) delete st.config[f];
    else st.config[f] = value;
  } else if (rm) {
    st.remotes ??= {};
    if (unset) delete st.remotes[rm[1]];
    else st.remotes[rm[1]] = { url: value! };
  } else if (bm) {
    st.upstream ??= {};
    if (unset) delete st.upstream[bm[1]];
    else {
      const u = (st.upstream[bm[1]] ??= { remote: 'origin', merge: bm[1] });
      if (bm[2] === 'remote') u.remote = value!;
      else u.merge = value!.replace(/^refs\/heads\//, '');
    }
  } else if (unset) {
    if (st.config[k] === undefined) return 5;
    delete st.config[k];
  } else st.config[k] = value;
  saveRepo(r!);
  return 0;
}

function configGetLocal(st: GitState, k: string): string | undefined {
  if (k === 'user.name') return st.config.name;
  if (k === 'user.email') return st.config.email;
  return st.config[k];
}

/* ----------------------------------------------------------------------------- status */

function statusShortCode(r: Repo, c: Changes, p: string): string {
  const st = r.st;
  const um = st.unmerged?.[p];
  if (um) return um === 'both added' ? 'AA' : um === 'deleted by us' ? 'DU' : um === 'deleted by them' ? 'UD' : 'UU';
  const x = c.staged.includes(p) ? (c.ht[p] === undefined ? 'A' : st.index[p] === undefined ? 'D' : 'M') : ' ';
  const y = c.unstaged.includes(p) ? (c.w.files[p] === undefined ? 'D' : 'M') : ' ';
  return x + y;
}

function inProgressText(r: Repo): string {
  const st = r.st;
  let s = '';
  if (st.seq?.kind === 'rebase') {
    const q = st.seq;
    s += `${q.interactive ? 'interactive rebase' : 'rebase'} in progress; onto ${short(q.onto!)}\n`;
    if (q.interactive) {
      const done = [...q.done, ...(q.current ? [q.current] : [])];
      if (done.length) s += `Last command${done.length > 1 ? 's' : ''} done (${plural(done.length, 'command')} done):\n${done.slice(-2).map((t) => `   ${todoLine(r, t)}\n`).join('')}`;
      if (q.todo.length) s += `Next command${q.todo.length > 1 ? 's' : ''} to do (${plural(q.todo.length, 'remaining command')}):\n${q.todo.slice(0, 2).map((t) => `   ${todoLine(r, t)}\n`).join('')}  (use "git rebase --edit-todo" to view and edit)\n`;
      else s += 'No commands remaining.\n';
    }
    s += `You are currently ${q.stop === 'edit' ? 'editing a commit while rebasing' : 'rebasing'} branch '${q.branch ?? 'HEAD'}' on '${short(q.onto!)}'.\n`;
    if (q.stop === 'edit') s += '  (use "git commit --amend" to amend the current commit)\n  (use "git rebase --continue" once you are satisfied with your changes)\n';
    else s += '  (fix conflicts and then run "git rebase --continue")\n  (use "git rebase --skip" to skip this patch)\n  (use "git rebase --abort" to check out the original branch)\n';
    s += '\n';
  } else if (st.seq) {
    const verb = st.seq.kind === 'cherry-pick' ? 'cherry-picking' : 'reverting';
    s += `You are currently ${verb} commit ${short(st.seq.current?.id ?? '')}.\n  (fix conflicts and run "git ${st.seq.kind} --continue")\n  (use "git ${st.seq.kind} --skip" to skip this patch)\n  (use "git ${st.seq.kind} --abort" to cancel the ${st.seq.kind} operation)\n\n`;
  }
  if (st.bisect) s += `You are currently bisecting, started from branch '${st.bisect.origBranch ?? short(st.bisect.orig)}'.\n  (use "git bisect reset" to get back to the original branch)\n\n`;
  return s;
}

function cmdStatus(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['untracked-files', 'ignored'], { s: 'short', b: 'branch', u: 'untracked-files:', z: 'z' });
  const st = r.st;
  const c = changes(r, has(o, 'ignored'));
  const uMode = val(o, 'untracked-files') ?? 'normal';
  const untracked = uMode === 'no' ? [] : c.untracked;
  const shortForm = o.flags.has('short') || o.flags.has('porcelain') || o.vals.porcelain !== undefined;
  const head = headCommit(st);
  const unmerged = Object.keys(st.unmerged ?? {}).sort();
  if (shortForm) {
    if (o.flags.has('branch')) {
      if (st.head.branch === undefined) io.out('## HEAD (no branch)\n');
      else if (!head) io.out(`## No commits yet on ${st.head.branch}\n`);
      else {
        const u = st.upstream?.[st.head.branch];
        const rid = u ? st.remoteRefs?.[`${u.remote}/${u.merge}`] : undefined;
        let track = '';
        if (u && rid) {
          const ab = aheadBehind(r, head, rid);
          track = `...${u.remote}/${u.merge}${ab.ahead || ab.behind ? ` [${[ab.ahead ? `ahead ${ab.ahead}` : '', ab.behind ? `behind ${ab.behind}` : ''].filter(Boolean).join(', ')}]` : ''}`;
        } else if (u) track = `...${u.remote}/${u.merge} [gone]`;
        io.out(`## ${st.head.branch}${track}\n`);
      }
    }
    const all = [...new Set([...c.staged, ...c.unstaged, ...unmerged])].sort();
    for (const p of all) io.out(`${statusShortCode(r, c, p)} ${relDisplay(r, p)}\n`);
    for (const p of uMode === 'all' ? untracked : collapseUntracked(r, untracked, [...untracked, ...c.ignored])) io.out(`?? ${relDisplay(r, p)}\n`);
    if (has(o, 'ignored')) for (const p of collapseUntracked(r, c.ignored, c.ignored)) io.out(`!! ${relDisplay(r, p)}\n`);
    return 0;
  }
  let s = '';
  if (st.seq?.kind === 'rebase') s += inProgressText(r);
  else {
    if (st.head.branch !== undefined) s += `On branch ${st.head.branch}\n`;
    else {
      const fromTag = Object.entries(st.tags).find(([, id]) => id === st.head.detached)?.[0];
      s += `HEAD detached at ${fromTag ?? short(st.head.detached!)}\n`;
    }
    const track = trackingLine(r);
    if (track) s += track + '\n';
    if (!head) s += '\nNo commits yet\n\n';
    if (st.merging && !st.merging.squash) s += unmerged.length ? 'You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n' : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n';
    s += inProgressText(r);
  }
  const kind = (p: string) => (c.ht[p] === undefined ? 'new file' : st.index[p] === undefined ? 'deleted' : 'modified');
  const shownUntracked = uMode === 'all' ? untracked : collapseUntracked(r, untracked, [...untracked, ...c.ignored]);
  if (c.staged.length) s += `Changes to be committed:\n  (use "git ${head ? 'restore --staged' : 'rm --cached'} <file>..." to unstage)\n${c.staged.map((p) => `\t${(kind(p) + ':').padEnd(12)}${relDisplay(r, p)}\n`).join('')}\n`;
  if (unmerged.length) s += `Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n${unmerged.map((p) => `\t${(st.unmerged![p] + ':').padEnd(17)}${relDisplay(r, p)}\n`).join('')}\n`;
  if (c.unstaged.length) s += `Changes not staged for commit:\n  (use "git add${c.unstaged.some((p) => c.w.files[p] === undefined) ? '/rm' : ''} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n${c.unstaged.map((p) => `\t${(c.w.files[p] === undefined ? 'deleted:' : 'modified:').padEnd(12)}${relDisplay(r, p)}\n`).join('')}\n`;
  if (shownUntracked.length) s += `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n${shownUntracked.map((p) => `\t${relDisplay(r, p)}\n`).join('')}\n`;
  if (has(o, 'ignored') && c.ignored.length) s += `Ignored files:\n  (use "git add -f <file>..." to include in what will be committed)\n${collapseUntracked(r, c.ignored, c.ignored).map((p) => `\t${relDisplay(r, p)}\n`).join('')}\n`;
  if (!c.staged.length && !c.unstaged.length && !untracked.length && !unmerged.length) s += head ? 'nothing to commit, working tree clean\n' : 'nothing to commit (create/copy files and use "git add" to track)\n';
  else if (!c.staged.length && (c.unstaged.length || unmerged.length)) s += 'no changes added to commit (use "git add" and/or "git commit -a")\n';
  else if (!c.staged.length) s += 'nothing added to commit but untracked files present (use "git add" to track)\n';
  io.out(s);
  return 0;
}

/* ----------------------------------------------------------------------------- add, rm, mv */

function cmdAdd(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['chmod'], { A: 'all', u: 'update', f: 'force', n: 'dry-run', v: 'verbose', p: 'patch', N: 'intent-to-add' });
  if (o.flags.has('patch')) die('error: git add -p (interactive staging) is not available in this simulator; stage whole files, or split the change and commit in steps.', 1);
  const w = workTree(r);
  let specs = [...o.pos, ...(o.paths ?? [])];
  if ((o.flags.has('all') || o.flags.has('update')) && !specs.length) specs = [r.root];
  if (!specs.length) {
    io.err("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\nhint: Disable this message with \"git config advice.addEmptyPathspec false\"\n");
    return 0;
  }
  const tracked = Object.keys(r.st.index);
  const all = [...new Set([...Object.keys(w.files), ...tracked])];
  const ig = ignoreCheck(r, w.files, Object.keys(w.files).filter((p) => r.st.index[p] === undefined));
  const ignoredNamed: string[] = [];
  const chosen = new Set<string>();
  for (const spec of specs) {
    const hits = matchSpec(r, spec, all);
    const rel = repoPath(r, spec);
    if (!hits.length) {
      if (rel !== null && ig.size && [...ig].some(([p, rule]) => rule && (p === rel || p.startsWith(rel + '/')))) {
        ignoredNamed.push(spec);
        continue;
      }
      die(`fatal: pathspec '${spec}' did not match any files`);
    }
    for (const p of hits) {
      if (o.flags.has('update') && r.st.index[p] === undefined) continue;
      if (r.st.index[p] === undefined && ig.get(p) && !o.flags.has('force')) {
        if (p === rel) ignoredNamed.push(spec);
        continue;
      }
      chosen.add(p);
    }
  }
  if (val(o, 'chmod')) {
    const plus = val(o, 'chmod') === '+x';
    for (const p of chosen) {
      if (r.st.index[p] === undefined) continue;
      const xs = new Set(r.st.x ?? []);
      if (plus) xs.add(p);
      else xs.delete(p);
      r.st.x = [...xs];
    }
    saveRepo(r);
    return 0;
  }
  for (const p of [...chosen].sort()) {
    const changed = r.st.index[p] !== w.files[p] || (w.files[p] !== undefined && (r.st.x ?? []).includes(p) !== w.exec.has(p)) || !!r.st.unmerged?.[p];
    if (!changed) continue;
    if (o.flags.has('verbose') || o.flags.has('dry-run')) io.out(w.files[p] === undefined ? `remove '${p}'\n` : `add '${p}'\n`);
    if (!o.flags.has('dry-run')) stageFile(r, p, w);
  }
  if (!o.flags.has('dry-run')) saveRepo(r);
  if (ignoredNamed.length) {
    io.err(`The following paths are ignored by one of your .gitignore files:\n${ignoredNamed.join('\n')}\nhint: Use -f if you really want to add them.\nhint: Disable this message with "git config advice.addIgnoredFile false"\n`);
    return 1;
  }
  return 0;
}

function cmdRm(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { r: 'recursive', f: 'force', q: 'quiet', n: 'dry-run' });
  const specs = [...o.pos, ...(o.paths ?? [])];
  if (!specs.length) die('usage: git rm [<options>] [--] <file>...');
  const cached = o.flags.has('cached');
  const w = workTree(r);
  const tracked = Object.keys(r.st.index);
  const targets: string[] = [];
  for (const spec of specs) {
    const hits = matchSpec(r, spec, tracked);
    if (!hits.length) die(`fatal: pathspec '${spec}' did not match any files`);
    const rel = repoPath(r, spec);
    if (!o.flags.has('recursive') && hits.some((p) => p !== rel) && !/[*?[]/.test(spec)) die(`fatal: not removing '${spec}' recursively without -r`);
    targets.push(...hits);
  }
  const ht = headTree(r);
  if (!o.flags.has('force')) {
    const local = targets.filter((p) => !cached && w.files[p] !== undefined && w.files[p] !== r.st.index[p]);
    const stagedBoth = targets.filter((p) => r.st.index[p] !== ht[p] && w.files[p] !== r.st.index[p] && w.files[p] !== undefined);
    if (stagedBoth.length) die(`error: the following file has staged content different from both the\nfile and the HEAD:\n${stagedBoth.map((p) => `    ${p}\n`).join('')}(use -f to force removal)`, 1);
    if (local.length) die(`error: the following file${local.length > 1 ? 's have' : ' has'} local modifications:\n${local.map((p) => `    ${p}\n`).join('')}(use --cached to keep the file, or -f to force removal)`, 1);
  }
  for (const p of [...new Set(targets)].sort()) {
    if (!o.flags.has('quiet')) io.out(`rm '${p}'\n`);
    if (o.flags.has('dry-run')) continue;
    delete r.st.index[p];
    r.st.x = (r.st.x ?? []).filter((q) => q !== p);
    if (r.st.unmerged?.[p]) delete r.st.unmerged[p];
    if (!cached) writeWorking(r, {}, [p]);
  }
  saveRepo(r);
  return 0;
}

function cmdMv(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { f: 'force', n: 'dry-run', v: 'verbose', k: 'skip' });
  if (o.pos.length < 2) die('usage: git mv [<options>] <source>... <destination>');
  const dest = o.pos[o.pos.length - 1];
  const sources = o.pos.slice(0, -1);
  const destRel = repoPath(r, dest);
  if (destRel === null) die(`fatal: '${dest}' is outside repository`);
  const destIsDir = lookup(ctx.sys.fs, abs(ctx, dest), ROOT)?.node.type === 'dir';
  const w = workTree(r);
  for (const src of sources) {
    const srcRel = repoPath(r, src);
    const moved = Object.keys(r.st.index).filter((p) => p === srcRel || p.startsWith(srcRel + '/'));
    if (!moved.length) die(`fatal: not under version control, source=${src}, destination=${dest}`);
    const target = destIsDir ? `${destRel ? destRel + '/' : ''}${srcRel!.split('/').pop()}` : destRel!;
    if (!destIsDir && r.st.index[target] !== undefined && !o.flags.has('force')) die(`fatal: destination exists, source=${src}, destination=${dest}`);
    for (const p of moved) {
      const np = target + p.slice(srcRel!.length);
      if (o.flags.has('verbose') || o.flags.has('dry-run')) io.out(`Renaming ${p} to ${np}\n`);
      if (o.flags.has('dry-run')) continue;
      const exec = w.exec.has(p);
      writeWorking(r, { [np]: w.files[p] ?? r.st.index[p] }, [p], exec ? [np] : []);
      r.st.index[np] = r.st.index[p];
      delete r.st.index[p];
      const xs = new Set(r.st.x ?? []);
      if (xs.delete(p)) xs.add(np);
      r.st.x = [...xs];
    }
  }
  saveRepo(r);
  return 0;
}

/* ----------------------------------------------------------------------------- commit */

function commitSummary(r: Repo, id: string, from: Record<string, string>, fromX: string[], amend: boolean): string {
  const c = r.st.commits[id];
  const to = c.tree;
  const paths = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().filter((p) => from[p] !== to[p] || fromX.includes(p) !== (c.x ?? []).includes(p));
  let ins = 0;
  let del = 0;
  for (const p of paths) {
    const n = countChanges(from[p] ?? '', to[p] ?? '');
    ins += n.add;
    del += n.del;
  }
  const where = r.st.head.branch !== undefined ? r.st.head.branch : 'detached HEAD';
  let s = `[${where}${c.parents.length ? '' : ' (root-commit)'} ${short(id)}] ${subject(c.message)}\n`;
  if (amend) s += ` Date: ${gitDate(c.time, undefined, r.ctx.sys.now)}\n`;
  s += ` ${plural(paths.length, 'file')} changed${ins ? `, ${ins} insertion${ins === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}\n`;
  for (const p of paths) {
    if (from[p] === undefined) s += ` create mode ${(c.x ?? []).includes(p) ? '100755' : '100644'} ${p}\n`;
    else if (to[p] === undefined) s += ` delete mode ${fromX.includes(p) ? '100755' : '100644'} ${p}\n`;
    else if (fromX.includes(p) !== (c.x ?? []).includes(p)) s += ` mode change ${fromX.includes(p) ? '100755 => 100644' : '100644 => 100755'} ${p}\n`;
  }
  return s;
}

function statusComment(r: Repo): string {
  const c = changes(r);
  let s = `#\n# On branch ${r.st.head.branch ?? 'HEAD'}\n`;
  if (c.staged.length) s += `# Changes to be committed:\n${c.staged.map((p) => `#\t${(c.ht[p] === undefined ? 'new file:' : r.st.index[p] === undefined ? 'deleted:' : 'modified:').padEnd(12)}${p}\n`).join('')}#\n`;
  if (c.unstaged.length) s += `# Changes not staged for commit:\n${c.unstaged.map((p) => `#\tmodified:   ${p}\n`).join('')}#\n`;
  if (c.untracked.length) s += `# Untracked files:\n${c.untracked.map((p) => `#\t${p}\n`).join('')}#\n`;
  return s;
}

function parseAuthor(r: Repo, spec: string, time: number): Person {
  const m = /^(.*?)\s*<([^>]*)>$/.exec(spec.trim());
  if (m) return { name: m[1], email: m[2], time };
  const re = new RegExp(spec, 'i');
  const hit = Object.values(r.st.commits).find((c) => re.test(`${c.author} <${c.email}>`));
  if (!hit) die(`fatal: --author '${spec}' is not 'Name <email>' and matches no existing author`);
  return { name: hit!.author, email: hit!.email, time };
}

function cmdCommit(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['message', 'file', 'author', 'date', 'fixup', 'squash', 'cleanup', 'reuse-message', 'reedit-message', 'template'], {
    m: 'message:',
    F: 'file:',
    a: 'all',
    n: 'no-verify',
    s: 'signoff',
    q: 'quiet',
    v: 'verbose',
    e: 'edit',
    C: 'reuse-message:',
    c: 'reedit-message:',
    t: 'template:',
  });
  const st = r.st;
  const resume = o.flags.has('lab-resume');
  const amend = o.flags.has('amend');
  const head = headCommit(st);
  if (amend && !head) die('fatal: You have nothing to amend.');
  if (amend && st.merging) die('fatal: You are in the middle of a merge -- cannot amend.');
  // Stage what -a or the listed paths ask for.
  const w = workTree(r);
  if (o.flags.has('all')) for (const p of Object.keys(st.index)) if (w.files[p] !== st.index[p] || w.exec.has(p) !== (st.x ?? []).includes(p) || st.unmerged?.[p]) stageFile(r, p, w);
  const only = [...o.pos, ...(o.paths ?? [])];
  if (only.length) {
    if (st.merging) die('fatal: cannot do a partial commit during a merge.');
    for (const spec of only) {
      const hits = matchSpec(r, spec, [...new Set([...Object.keys(st.index), ...Object.keys(w.files)])]).filter((p) => st.index[p] !== undefined);
      if (!hits.length) die(`error: pathspec '${spec}' did not match any file(s) known to git`, 1);
      for (const p of hits) stageFile(r, p, w);
    }
  }
  if (st.unmerged && Object.keys(st.unmerged).length)
    die("error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.");
  const parents = amend ? st.commits[head!].parents : [head, st.merging && !st.merging.squash ? st.merging.other : null].filter((x): x is string => !!x);
  const base = amend ? treeOf(r, parents[0]) : treeOf(r, head);
  const baseX = amend ? execOf(r, parents[0]) : execOf(r, head);
  const ix = st.x ?? [];
  const same = Object.keys({ ...base, ...st.index }).every((p) => base[p] === st.index[p] && baseX.includes(p) === ix.includes(p));
  if (same && !st.merging && !o.flags.has('allow-empty') && !amend) {
    saveRepo(r);
    const c = changes(r);
    let s = st.head.branch !== undefined ? `On branch ${st.head.branch}\n` : `HEAD detached at ${short(head ?? '')}\n`;
    s += trackingLine(r);
    if (c.unstaged.length) s += `Changes not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n${c.unstaged.map((p) => `\t${(c.w.files[p] === undefined ? 'deleted:' : 'modified:').padEnd(12)}${p}\n`).join('')}\n`;
    if (c.untracked.length) s += `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n${collapseUntracked(r, c.untracked, c.untracked).map((p) => `\t${p}\n`).join('')}\n`;
    s += c.unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")\n' : c.untracked.length ? 'nothing added to commit but untracked files present (use "git add" to track)\n' : head ? 'nothing to commit, working tree clean\n' : 'nothing to commit (create/copy files and use "git add" to track)\n';
    io.out(s);
    return 1;
  }
  // pre-commit runs before the message is written (and only once, not again after the editor).
  if (!o.flags.has('no-verify') && !resume) {
    saveRepo(r);
    const code = runHook(r, 'pre-commit');
    if (code !== null) {
      Object.assign(r, openRepo(ctx, io, r.root));
      if (code !== 0) return 1;
    }
  }
  const st2 = r.st;
  // The message.
  let message: string | null;
  const cleanup = (val(o, 'cleanup') ?? 'default') as string;
  if (resume) message = cleanMessage(readFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, ROOT), cleanup === 'verbatim' ? 'verbatim' : 'strip');
  else if (o.vals.message) message = cleanMessage(o.vals.message.join('\n\n'), cleanup === 'verbatim' ? 'verbatim' : 'whitespace');
  else if (val(o, 'file') !== undefined) {
    const f = val(o, 'file')!;
    let text: string;
    if (f === '-') text = io.stdin;
    else {
      try {
        text = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
      } catch {
        return die(`fatal: could not read log file '${f}': No such file or directory`);
      }
    }
    message = cleanMessage(text, cleanup === 'verbatim' ? 'verbatim' : cleanup === 'strip' ? 'strip' : 'whitespace');
  } else if (val(o, 'reuse-message')) message = st2.commits[mustRev(r, val(o, 'reuse-message')!)].message;
  else if (val(o, 'fixup')) message = `fixup! ${subject(st2.commits[mustRev(r, val(o, 'fixup')!)].message)}`;
  else if (val(o, 'squash')) message = `squash! ${subject(st2.commits[mustRev(r, val(o, 'squash')!)].message)}`;
  else if (amend && o.flags.has('no-edit')) message = st2.commits[head!].message;
  else if (st2.merging && (o.flags.has('no-edit') || !io.interactive)) message = st2.merging.message ?? `Merge branch '${st2.merging.otherName}'`;
  else {
    const initial = amend ? st2.commits[head!].message : st2.merging ? st2.merging.message ?? `Merge branch '${st2.merging.otherName}'` : val(o, 'reedit-message') ? st2.commits[mustRev(r, val(o, 'reedit-message')!)].message : '';
    const tmpl = `${initial}\n\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n${statusComment(r)}`;
    saveRepo(r);
    const edited = editFile(r, 'COMMIT_EDITMSG', tmpl, ['commit', '--lab-resume', ...(amend ? ['--amend'] : []), ...(o.flags.has('no-verify') ? ['--no-verify'] : []), ...(o.flags.has('signoff') ? ['--signoff'] : []), ...(o.flags.has('allow-empty') ? ['--allow-empty'] : [])]);
    if (edited === null) return 0;
    message = cleanMessage(edited, 'strip');
  }
  if (!message && !o.flags.has('allow-empty-message')) {
    io.err('Aborting commit due to empty commit message.\n');
    saveRepo(r);
    return 1;
  }
  if (o.flags.has('signoff')) {
    const me = ident(r, 'committer');
    const line = `Signed-off-by: ${me.name} <${me.email}>`;
    if (!message!.includes(line)) message = `${message}\n\n${line}`;
  }
  // commit-msg may check or rewrite the message.
  if (!o.flags.has('no-verify')) {
    writeFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, message + '\n', actor(ctx), ctx.sys.now);
    saveRepo(r);
    const code = runHook(r, 'commit-msg', ['.git/COMMIT_EDITMSG']);
    if (code !== null) {
      Object.assign(r, openRepo(ctx, io, r.root));
      if (code !== 0) return 1;
      message = cleanMessage(readFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, ROOT), 'strip');
    }
  } else writeFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, message + '\n', actor(ctx), ctx.sys.now);
  const st3 = r.st;
  const old = amend ? st3.commits[head!] : null;
  const date = parseGitDate(val(o, 'date'), ctx.sys.now);
  let author: Person | undefined;
  if (val(o, 'author')) author = parseAuthor(r, val(o, 'author')!, date ?? nextTime(r));
  else if (old && !o.flags.has('reset-author')) author = { name: old.author, email: old.email, time: date ?? old.time };
  else if (date !== null) author = { ...ident(r, 'author'), time: date };
  const id = newCommit(r, { message: message!, parents, tree: st3.index, x: st3.x ?? [], author });
  const kind = amend ? 'commit (amend)' : st3.merging ? 'commit (merge)' : !head ? 'commit (initial)' : 'commit';
  moveHead(r, id, `${kind}: ${subject(message!)}`);
  if (amend) st3.origHead = head!;
  rerereRecord(r, st3.index);
  delete st3.merging;
  delete st3.unmerged;
  saveRepo(r);
  if (!o.flags.has('quiet')) io.out(commitSummary(r, id, base, baseX, amend));
  runHook(r, 'post-commit');
  return 0;
}

/* ----------------------------------------------------------------------------- log, show, reflog, shortlog */

interface LogOpts {
  fmt: string | null;
  sep: 'term' | 'sep';
  date?: string;
  patch: boolean;
  stat: boolean;
  shortstat: boolean;
  numstat: boolean;
  nameOnly: boolean;
  nameStatus: boolean;
  graph: boolean;
  decorate: boolean;
  paths?: string[];
}

function logOptsFrom(o: Parsed): LogOpts {
  let fmt: string | null = null;
  let sep: 'term' | 'sep' = 'term';
  const pretty = val(o, 'pretty') ?? val(o, 'format');
  if (o.flags.has('oneline')) fmt = 'oneline';
  else if (pretty !== undefined) {
    if (pretty.startsWith('format:')) {
      fmt = pretty.slice(7);
      sep = 'sep';
    } else if (pretty.startsWith('tformat:')) fmt = pretty.slice(8);
    else if (['oneline', 'short', 'medium', 'full', 'fuller', 'raw', 'reference'].includes(pretty)) fmt = pretty;
    else fmt = pretty;
  }
  if (o.flags.has('pretty')) fmt = 'medium';
  return {
    fmt,
    sep,
    date: o.flags.has('relative-date') ? 'relative' : val(o, 'date'),
    patch: has(o, 'patch', 'p', 'u', 'patch-with-stat'),
    stat: has(o, 'stat', 'patch-with-stat'),
    shortstat: has(o, 'shortstat'),
    numstat: has(o, 'numstat'),
    nameOnly: has(o, 'name-only'),
    nameStatus: has(o, 'name-status'),
    graph: o.flags.has('graph'),
    decorate: !o.flags.has('no-decorate'),
  };
}

const LOG_VALS = ['max-count', 'skip', 'since', 'after', 'until', 'before', 'author', 'committer', 'grep', 'format', 'pretty', 'date', 'S', 'G', 'min-parents', 'max-parents'];
const LOG_SHORTS = { n: 'max-count:', p: 'patch', u: 'patch', i: 'regexp-ignore-case', S: 'S:', G: 'G:', g: 'walk-reflogs', s: 'no-patch', q: 'quiet' };

function commitText1(r: Repo, c: GitCommit, lo: LogOpts): string[] {
  const dec = lo.decorate ? decorations(r, c.id) : '';
  const fmt = lo.fmt ?? 'medium';
  if (fmt === 'oneline') return [`${lo.graph || lo.fmt === 'oneline' ? short(c.id) : c.id}${dec} ${subject(c.message)}`];
  if (fmt === 'reference') return [`${short(c.id)} (${subject(c.message)}, ${gitDate(c.time, 'short', r.ctx.sys.now)})`];
  if (fmt === '') return [];
  if (!['short', 'medium', 'full', 'fuller', 'raw'].includes(fmt)) return formatCommit(r, c, fmt, lo.date).split('\n');
  const lines = [`commit ${c.id}${dec}`];
  if (c.parents.length > 1) lines.push(`Merge: ${c.parents.map(short).join(' ')}`);
  if (fmt === 'fuller') {
    lines.push(`Author:     ${c.author} <${c.email}>`, `AuthorDate: ${gitDate(c.time, lo.date, r.ctx.sys.now)}`, `Commit:     ${c.committer ?? c.author} <${c.cemail ?? c.email}>`, `CommitDate: ${gitDate(c.ctime ?? c.time, lo.date, r.ctx.sys.now)}`);
  } else {
    lines.push(`Author: ${c.author} <${c.email}>`);
    if (fmt === 'full') lines.push(`Commit: ${c.committer ?? c.author} <${c.cemail ?? c.email}>`);
    if (fmt === 'medium' || fmt === 'raw') lines.push(`Date:   ${gitDate(c.time, lo.date, r.ctx.sys.now)}`);
  }
  lines.push('');
  const msg = fmt === 'short' ? [subject(c.message)] : c.message.split('\n');
  lines.push(...msg.map((l) => (l ? '    ' + l : '')));
  return lines;
}

function commitDiffText(r: Repo, c: GitCommit, lo: LogOpts): string {
  if (!(lo.patch || lo.stat || lo.shortstat || lo.numstat || lo.nameOnly || lo.nameStatus)) return '';
  if (c.parents.length > 1 && !lo.stat) return '';
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: () => {} };
  const parent = c.parents[0];
  printTreeDiff(io, treeOf(r, parent), execOf(r, parent), treeOf(r, c.id), c.x ?? [], { paths: lo.paths, patch: lo.patch, stat: lo.stat, shortstat: lo.shortstat, numstat: lo.numstat, nameOnly: lo.nameOnly, nameStatus: lo.nameStatus });
  return buf.join('');
}

function cmdLog(args: string[], io: IO, ctx: Ctx, defaults: string[] = []): number {
  const r = needRepo(ctx, io);
  const o = gitOpts([...defaults, ...args], LOG_VALS, LOG_SHORTS);
  const st = r.st;
  const lo = logOptsFrom(o);
  if (o.flags.has('walk-reflogs')) return cmdReflog(['show', ...o.pos, ...(lo.fmt === 'oneline' ? [] : ['--lab-long'])], io, ctx);
  // Positional arguments are revisions until one is not; the rest are paths.
  const revs: string[] = [];
  const paths = [...(o.paths ?? [])];
  let inPaths = false;
  for (const p of o.pos) {
    if (!inPaths && (isRev(r, p) || /\.\./.test(p) || p.startsWith('^'))) revs.push(p);
    else if (o.paths) revs.push(p);
    else if (lookup(ctx.sys.fs, abs(ctx, p), ROOT) || Object.keys(st.index).some((q) => q === repoPath(r, p) || q.startsWith((repoPath(r, p) ?? '') + '/'))) {
      inPaths = true;
      paths.push(p);
    }
    else die(`fatal: ambiguous argument '${p}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
  }
  const relPaths = paths.map((p) => repoPath(r, p) ?? p);
  lo.paths = relPaths.length ? relPaths : undefined;
  if (!headCommit(st) && !revs.length && !has(o, 'all', 'branches', 'tags', 'remotes')) die(`fatal: your current branch '${st.head.branch}' does not have any commits yet`);
  let ids = selectCommits(r, revs, has(o, 'all'));
  if (has(o, 'branches')) for (const id of Object.values(st.branches)) if (id) for (const c of ancestors(st, id)) ids.push(c);
  if (has(o, 'tags')) for (const id of Object.values(st.tags)) for (const c of ancestors(st, id)) ids.push(c);
  if (has(o, 'remotes')) for (const id of Object.values(st.remoteRefs ?? {})) for (const c of ancestors(st, id)) ids.push(c);
  ids = [...new Set(ids)];
  if (o.flags.has('first-parent')) {
    const tips = revs.length ? revs.map((x) => mustRev(r, x.replace(/^.*\.\./, '') || 'HEAD')) : [headCommit(st)!];
    const fp = new Set<string>();
    for (const t of tips) for (const c of ancestors(st, t, true)) fp.add(c);
    ids = ids.filter((c) => fp.has(c));
  }
  const ci = o.flags.has('regexp-ignore-case') ? 'i' : '';
  const since = parseGitDate(val(o, 'since') ?? val(o, 'after'), ctx.sys.now);
  const until = parseGitDate(val(o, 'until') ?? val(o, 'before'), ctx.sys.now);
  const authors = (o.vals.author ?? []).map((a) => new RegExp(a, ci));
  const committers = (o.vals.committer ?? []).map((a) => new RegExp(a, ci));
  const greps = (o.vals.grep ?? []).map((g) => new RegExp(g, ci));
  const pick = val(o, 'S');
  const pickRe = val(o, 'G') ? new RegExp(val(o, 'G')!) : null;
  ids = ids.filter((id) => {
    const c = st.commits[id];
    const ct = c.ctime ?? c.time;
    if (since !== null && ct < since) return false;
    if (until !== null && ct > until) return false;
    if (authors.length && !authors.some((re) => re.test(`${c.author} <${c.email}>`))) return false;
    if (committers.length && !committers.some((re) => re.test(`${c.committer ?? c.author} <${c.cemail ?? c.email}>`))) return false;
    if (greps.length) {
      const hit = o.flags.has('all-match') ? greps.every((re) => re.test(c.message)) : greps.some((re) => re.test(c.message));
      if (hit === o.flags.has('invert-grep')) return false;
    }
    if (o.flags.has('merges') && c.parents.length < 2) return false;
    if (o.flags.has('no-merges') && c.parents.length > 1) return false;
    if (val(o, 'min-parents') && c.parents.length < Number(val(o, 'min-parents'))) return false;
    if (val(o, 'max-parents') && c.parents.length > Number(val(o, 'max-parents'))) return false;
    const tree = treeOf(r, id);
    if (lo.paths) {
      const differs = (pid: string | undefined) => {
        const pt = treeOf(r, pid);
        return [...new Set([...Object.keys(pt), ...Object.keys(tree)])].some((p) => pathMatch(p, lo.paths) && pt[p] !== tree[p]);
      };
      if (c.parents.length > 1 ? c.parents.some((p) => !differs(p)) : !differs(c.parents[0])) return false;
    }
    if (pick !== undefined || pickRe) {
      const pt = treeOf(r, c.parents[0]);
      const keys = [...new Set([...Object.keys(pt), ...Object.keys(tree)])].filter((p) => pathMatch(p, lo.paths));
      if (pick !== undefined) {
        const count = (t: Record<string, string>) => keys.reduce((n, p) => n + ((t[p] ?? '').split(pick).length - 1), 0);
        if (count(pt) === count(tree)) return false;
      } else if (!keys.some((p) => hunks(pt[p] ?? '', tree[p] ?? '').some((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l) && pickRe!.test(l.slice(1))))) return false;
    }
    return true;
  });
  let ordered = orderCommits(st, ids, lo.graph || o.flags.has('topo-order'));
  const skip = Number(val(o, 'skip') ?? 0);
  const max = val(o, 'max-count') !== undefined ? Number(val(o, 'max-count')) : Infinity;
  ordered = ordered.slice(skip, skip + max);
  if (o.flags.has('reverse')) ordered.reverse();
  const entries = ordered.map((id) => {
    const c = st.commits[id];
    const lines = commitText1(r, c, lo);
    const diff = commitDiffText(r, c, lo).replace(/\n$/, '');
    const isOne = lo.fmt === 'oneline' || (lo.fmt !== null && !['short', 'medium', 'full', 'fuller', 'raw', 'reference'].includes(lo.fmt));
    if (diff) lines.push(...(isOne && !lo.patch ? [] : ['']), ...diff.split('\n'));
    return { id, lines, isOne };
  });
  if (lo.graph) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const g = graphLines(st, ordered, (id) => {
      const e = byId.get(id)!;
      return e.isOne ? e.lines : [...e.lines, ''];
    });
    io.out(g.join('\n') + '\n');
    return 0;
  }
  const blocks = entries.map((e) => e.lines.join('\n'));
  const oneish = entries[0]?.isOne;
  if (lo.sep === 'sep' && lo.fmt !== null) io.out(blocks.join('\n') + (blocks.length ? '\n' : ''));
  else if (oneish) io.out(blocks.map((b) => b + '\n').join(''));
  else io.out(blocks.join('\n\n') + (blocks.length ? '\n' : ''));
  return 0;
}

function cmdShow(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, LOG_VALS, LOG_SHORTS);
  const st = r.st;
  const lo = logOptsFrom(o);
  if (!(lo.stat || lo.shortstat || lo.numstat || lo.nameOnly || lo.nameStatus || o.flags.has('no-patch'))) lo.patch = true;
  if (o.flags.has('no-patch')) lo.patch = false;
  lo.paths = o.paths?.map((p) => repoPath(r, p) ?? p);
  const targets = o.pos.length ? o.pos : ['HEAD'];
  const out: string[] = [];
  for (const t of targets) {
    const colon = /^([^:]*):(.+)$/.exec(t);
    if (colon && !/^[a-z]+:\/\//.test(t)) {
      const id = colon[1] === '' ? null : mustRev(r, colon[1]);
      const tree = id ? treeOf(r, id) : st.index;
      const p = colon[2].replace(/^\.\//, (repoPath(r, '.') ? repoPath(r, '.') + '/' : ''));
      if (tree[p] !== undefined) {
        out.push(tree[p].replace(/\n$/, ''));
        continue;
      }
      const dir = Object.keys(tree).filter((q) => q.startsWith(p.replace(/\/$/, '') + '/'));
      if (dir.length) {
        out.push(`tree ${t}\n\n${[...new Set(dir.map((q) => q.slice(p.replace(/\/$/, '').length + 1).split('/')[0] + (q.slice(p.replace(/\/$/, '').length + 1).includes('/') ? '/' : '')))].join('\n')}`);
        continue;
      }
      die(`fatal: path '${p}' does not exist in '${colon[1] || 'the index'}'`);
    }
    const tagName = st.annotated?.[t] ? t : st.annotated?.[t.replace(/^refs\/tags\//, '')] ? t.replace(/^refs\/tags\//, '') : null;
    const id = mustRev(r, t);
    let s = '';
    if (tagName) {
      const a = st.annotated![tagName];
      s += `tag ${tagName}\nTagger: ${a.tagger} <${a.email}>\nDate:   ${gitDate(a.time, lo.date, ctx.sys.now)}\n\n${a.message}\n\n`;
    }
    const c = st.commits[id];
    const lines = commitText1(r, c, lo);
    let diff = commitDiffText(r, c, lo);
    if (c.parents.length > 1 && lo.patch) diff = '';
    const head = lines.join('\n');
    s += head && diff ? head + (lo.fmt === 'oneline' ? '\n' : '\n\n') + diff.replace(/\n$/, '') : head || diff.replace(/\n$/, '');
    out.push(s);
  }
  io.out(out.join('\n\n') + '\n');
  return 0;
}

function cmdReflog(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const st = r.st;
  const sub = ['show', 'expire', 'delete', 'exists', 'list'].includes(args[0]) ? args[0] : 'show';
  const rest = sub === args[0] ? args.slice(1) : args;
  const o = gitOpts(rest, ['expire', 'date', 'format', 'pretty', 'max-count'], { n: 'max-count:' });
  if (sub === 'list') {
    for (const k of Object.keys(st.reflogs ?? {}).sort()) io.out(k + '\n');
    return 0;
  }
  if (sub === 'expire') {
    const when = val(o, 'expire') === 'now' || val(o, 'expire') === 'all' ? Infinity : parseGitDate(val(o, 'expire') ?? '90 days ago', ctx.sys.now) ?? 0;
    for (const k of Object.keys(st.reflogs ?? {})) st.reflogs![k] = st.reflogs![k].filter((e) => e.time >= when);
    saveRepo(r);
    return 0;
  }
  if (sub === 'delete') {
    for (const spec of o.pos) {
      const m = /^(.*)@\{(\d+)\}$/.exec(spec);
      if (!m) die(`error: not a reflog: ${spec}`);
      const ref = m![1] === 'HEAD' || m![1] === '' ? 'HEAD' : `refs/heads/${m![1]}`;
      const list = st.reflogs?.[ref] ?? [];
      list.splice(list.length - 1 - Number(m![2]), 1);
    }
    saveRepo(r);
    return 0;
  }
  const refArg = o.pos[0] ?? 'HEAD';
  const ref = refArg === 'HEAD' ? 'HEAD' : st.branches[refArg] !== undefined ? `refs/heads/${refArg}` : refArg;
  if (sub === 'exists') return st.reflogs?.[ref] ? 0 : 1;
  const list = [...(st.reflogs?.[ref] ?? [])].reverse();
  const max = val(o, 'max-count') ? Number(val(o, 'max-count')) : list.length;
  const dateMode = val(o, 'date');
  const long = o.flags.has('lab-long');
  list.slice(0, max).forEach((e, n) => {
    const sel = dateMode ? `${refArg}@{${gitDate(e.time, dateMode, ctx.sys.now)}}` : `${refArg}@{${n}}`;
    const c = st.commits[e.to];
    if (long && c) io.out(`commit ${e.to}${decorations(r, e.to)}\nReflog: ${sel} (${e.who ?? ''})\nReflog message: ${e.msg}\nAuthor: ${c.author} <${c.email}>\nDate:   ${gitDate(c.time, undefined, ctx.sys.now)}\n\n${c.message.split('\n').map((l) => '    ' + l).join('\n')}\n\n`);
    else io.out(`${short(e.to)}${decorations(r, e.to)} ${sel}: ${e.msg}\n`);
  });
  return 0;
}

function cmdShortlog(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['since', 'until', 'group'], { s: 'summary', n: 'numbered', e: 'email', c: 'committer' });
  const ids = selectCommits(r, o.pos, o.flags.has('all'));
  const since = parseGitDate(val(o, 'since'), ctx.sys.now);
  const until = parseGitDate(val(o, 'until'), ctx.sys.now);
  const groups = new Map<string, string[]>();
  for (const id of orderCommits(r.st, ids).reverse()) {
    const c = r.st.commits[id];
    const t = c.ctime ?? c.time;
    if ((since !== null && t < since) || (until !== null && t > until)) continue;
    if (o.flags.has('no-merges') && c.parents.length > 1) continue;
    const key = o.flags.has('committer') ? `${c.committer ?? c.author}${o.flags.has('email') ? ` <${c.cemail ?? c.email}>` : ''}` : `${c.author}${o.flags.has('email') ? ` <${c.email}>` : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(subject(c.message));
  }
  let list = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  if (o.flags.has('numbered')) list = list.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [who, subs] of list) {
    if (o.flags.has('summary')) io.out(`${String(subs.length).padStart(6)}\t${who}\n`);
    else io.out(`${who} (${subs.length}):\n${subs.map((s) => `      ${s}\n`).join('')}\n`);
  }
  return 0;
}

/* ----------------------------------------------------------------------------- diff */

function cmdDiff(args: string[], io: IO, ctx: Ctx): number {
  const o = gitOpts(args, ['unified'], { U: 'unified:', w: 'ignore-all-space', b: 'ignore-space-change', q: 'quiet', R: 'reverse' });
  if (o.flags.has('no-index')) {
    const [a, b] = [...o.pos, ...(o.paths ?? [])];
    const read = (p: string) => {
      try {
        return readFile(ctx.sys.fs, abs(ctx, p), actor(ctx));
      } catch {
        return die(`error: Could not access '${p}'`, 1);
      }
    };
    const x = read(a);
    const y = read(b);
    if (x === y) return 0;
    io.out(`diff --git a/${a} b/${b}\nindex ${short(blobId(x))}..${short(blobId(y))} 100644\n--- a/${a}\n+++ b/${b}\n${hunks(x, y).join('\n')}\n`);
    return 1;
  }
  const r = needRepo(ctx, io);
  const st = r.st;
  const revs: string[] = [];
  const paths = [...(o.paths ?? [])];
  // Before a '--', arguments are revisions until one is not; after it, they are paths.
  let inPaths = false;
  for (const p of o.pos) {
    if (o.paths || (!inPaths && (isRev(r, p) || /\.\./.test(p)))) revs.push(p);
    else {
      inPaths = true;
      paths.push(p);
    }
  }
  const rel = paths.map((p) => repoPath(r, p) ?? p);
  const opts = {
    paths: rel.length ? rel : undefined,
    stat: has(o, 'stat'),
    numstat: o.flags.has('numstat'),
    shortstat: o.flags.has('shortstat'),
    nameOnly: o.flags.has('name-only'),
    nameStatus: o.flags.has('name-status'),
    context: val(o, 'unified') !== undefined ? Number(val(o, 'unified')) : undefined,
    patch: o.flags.has('patch') || o.flags.has('p'),
    quiet: o.flags.has('quiet'),
  };
  let from: Record<string, string>;
  let fromX: string[];
  let to: Record<string, string>;
  let toX: string[];
  const cached = o.flags.has('cached') || o.flags.has('staged');
  const work = () => {
    const w = workTree(r);
    const t: Record<string, string> = {};
    for (const p of Object.keys(st.index)) if (w.files[p] !== undefined) t[p] = w.files[p];
    return { t, x: [...w.exec].filter((p) => t[p] !== undefined) };
  };
  if (revs.length === 1 && /\.\.\./.test(revs[0])) {
    const [a, b] = revs[0].split('...');
    const A = mustRev(r, a || 'HEAD');
    const B = mustRev(r, b || 'HEAD');
    const base = mergeBases(st, A, B)[0];
    [from, fromX, to, toX] = [treeOf(r, base), execOf(r, base), treeOf(r, B), execOf(r, B)];
  } else if (revs.length === 1 && /\.\./.test(revs[0])) {
    const [a, b] = revs[0].split('..');
    const A = mustRev(r, a || 'HEAD');
    const B = mustRev(r, b || 'HEAD');
    [from, fromX, to, toX] = [treeOf(r, A), execOf(r, A), treeOf(r, B), execOf(r, B)];
  } else if (revs.length === 2) {
    const A = mustRev(r, revs[0]);
    const B = mustRev(r, revs[1]);
    [from, fromX, to, toX] = [treeOf(r, A), execOf(r, A), treeOf(r, B), execOf(r, B)];
  } else if (cached) {
    const base = revs[0] ? mustRev(r, revs[0]) : headCommit(st);
    [from, fromX, to, toX] = [treeOf(r, base), execOf(r, base), st.index, st.x ?? []];
  } else if (revs.length === 1) {
    const A = mustRev(r, revs[0]);
    const w = work();
    [from, fromX, to, toX] = [treeOf(r, A), execOf(r, A), w.t, w.x];
  } else {
    needWorkTree(r);
    const w = work();
    [from, fromX, to, toX] = [st.index, st.x ?? [], w.t, w.x];
  }
  if (o.flags.has('reverse')) [from, fromX, to, toX] = [to, toX, from, fromX];
  if (o.flags.has('ignore-all-space') || o.flags.has('ignore-space-change')) {
    const norm = (s: string) => (o.flags.has('ignore-all-space') ? s.replace(/[ \t]+/g, '') : s.replace(/[ \t]+/g, ' ').replace(/ +$/gm, ''));
    const f2 = { ...from };
    for (const p of Object.keys(to)) if (f2[p] !== undefined && norm(f2[p]) === norm(to[p])) f2[p] = to[p];
    from = f2;
  }
  if (o.flags.has('check')) {
    let bad = false;
    for (const p of Object.keys({ ...from, ...to }).sort()) {
      if (from[p] === to[p] || to[p] === undefined || !pathMatch(p, opts.paths)) continue;
      let line = 0;
      for (const l of hunks(from[p] ?? '', to[p])) {
        const hm = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
        if (hm) {
          line = Number(hm[1]) - 1;
          continue;
        }
        if (l.startsWith('-') || l.startsWith('\\')) continue;
        line++;
        if (!l.startsWith('+')) continue;
        const text = l.slice(1);
        if (/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(text)) {
          io.out(`${p}:${line}: leftover conflict marker\n`);
          bad = true;
        } else if (/[ \t]+$/.test(text)) {
          io.out(`${p}:${line}: trailing whitespace.\n+${text}\n`);
          bad = true;
        }
      }
    }
    return bad ? 2 : 0;
  }
  const n = printTreeDiff(io, from, fromX, to, toX, opts);
  return (o.flags.has('exit-code') || o.flags.has('quiet')) && n ? 1 : 0;
}

export function mergeBases(st: GitState, a: string, b: string): string[] {
  const A = ancestors(st, a);
  const common = [...ancestors(st, b)].filter((c) => A.has(c));
  // Best common ancestors: those not reachable from another common ancestor.
  return common.filter((c) => !common.some((d) => d !== c && ancestors(st, d).has(c))).sort((x, y) => (st.commits[y].ctime ?? st.commits[y].time) - (st.commits[x].ctime ?? st.commits[x].time));
}

/* ----------------------------------------------------------------------------- blame, grep */

function cmdBlame(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['L', 'date'], { L: 'L:', e: 'show-email', s: 'no-author', l: 'long', w: 'w', n: 'show-number', f: 'show-name' });
  const st = r.st;
  const specs = [...o.pos, ...(o.paths ?? [])];
  const file = o.paths?.[0] ?? specs.find((s) => !isRev(r, s)) ?? specs[specs.length - 1];
  const revArg = specs.find((s) => s !== file && isRev(r, s));
  if (!file) die('usage: git blame [<options>] [<rev-opts>] [<rev>] [--] <file>');
  const p = repoPath(r, file)!;
  const start = revArg ? mustRev(r, revArg) : headCommit(st);
  const startTree = treeOf(r, start);
  let content: string | undefined;
  let uncommitted = false;
  if (revArg) content = startTree[p];
  else {
    const w = workTree(r);
    content = w.files[p];
    uncommitted = content !== startTree[p];
  }
  if (content === undefined) die(revArg ? `fatal: no such path ${p} in ${revArg}` : `fatal: no such path '${p}' in HEAD`);
  const lines = content!.replace(/\n$/, '').split('\n');
  const owner: Array<string | null> = lines.map(() => null);
  // Lines not in the starting commit belong to the working tree ("Not Committed Yet").
  type Pending = { id: string; map: number[] };
  const queue: Pending[] = [];
  const mapTo = (from: string, to: string): Array<number | undefined> => {
    // For each line of `to`, the index of the same line in `from` (LCS match), if any.
    const a = from.replace(/\n$/, '').split('\n');
    const b = to.replace(/\n$/, '').split('\n');
    const res: Array<number | undefined> = b.map(() => undefined);
    const L: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) res[j++] = i++;
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
    return res;
  };
  if (start) {
    if (uncommitted) {
      const m = mapTo(startTree[p] ?? '', content!);
      const map: number[] = [];
      m.forEach((k, line) => {
        if (k === undefined) owner[line] = 'WORKTREE';
        else map[k] = line;
      });
      queue.push({ id: start, map });
    } else queue.push({ id: start, map: lines.map((_, k) => k) });
  } else lines.forEach((_, k) => (owner[k] = 'WORKTREE'));
  while (queue.length) {
    const { id, map } = queue.shift()!;
    const c = st.commits[id];
    const mine = treeOf(r, id)[p] ?? '';
    let remaining = map.map((line, k) => ({ k, line })).filter((x) => x.line !== undefined);
    for (const parent of c.parents.filter((q) => st.commits[q])) {
      const pc = treeOf(r, parent)[p];
      if (pc === undefined || !remaining.length) continue;
      const m = mapTo(pc, mine);
      const pmap: number[] = [];
      const left: typeof remaining = [];
      for (const x of remaining) {
        const k = m[x.k];
        if (k === undefined) left.push(x);
        else pmap[k] = x.line;
      }
      if (pmap.some((x) => x !== undefined)) queue.push({ id: parent, map: pmap });
      remaining = left;
    }
    for (const x of remaining) owner[x.line] = id;
  }
  const range = val(o, 'L');
  let from = 1;
  let to = lines.length;
  if (range) {
    const m = /^(\d+)(?:,(\+?)(\d+))?$/.exec(range);
    if (!m) die(`fatal: invalid -L argument '${range}'`);
    from = Number(m![1]);
    to = m![3] ? (m![2] ? from + Number(m![3]) - 1 : Number(m![3])) : lines.length;
    if (from > lines.length) die(`fatal: file ${p} has only ${plural(lines.length, 'line')}`);
  }
  const nameW = Math.max(...owner.map((id) => (id === 'WORKTREE' ? 'Not Committed Yet'.length : id ? (o.flags.has('show-email') ? `<${st.commits[id].email}>` : st.commits[id].author).length : 0)));
  const numW = String(lines.length).length;
  for (let k = from - 1; k < Math.min(to, lines.length); k++) {
    const id = owner[k];
    const root = id && id !== 'WORKTREE' && !st.commits[id].parents.length;
    const hash = id === 'WORKTREE' || !id ? '00000000' : o.flags.has('long') ? id : (root ? '^' + id.slice(0, 7) : id.slice(0, 8));
    if (o.flags.has('no-author')) {
      io.out(`${hash} ${String(k + 1).padStart(numW)}) ${lines[k]}\n`);
      continue;
    }
    const who = id === 'WORKTREE' || !id ? 'Not Committed Yet' : o.flags.has('show-email') ? `<${st.commits[id].email}>` : st.commits[id].author;
    const when = id === 'WORKTREE' || !id ? gitDate(ctx.sys.now, 'iso', ctx.sys.now) : gitDate(st.commits[id].time, val(o, 'date') ?? 'iso', ctx.sys.now);
    io.out(`${hash}${o.flags.has('show-name') ? ' ' + p : ''} (${who.padEnd(nameW)} ${when} ${String(k + 1).padStart(numW)}) ${lines[k]}\n`);
  }
  return 0;
}

function cmdGrep(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['e'], { n: 'line-number', i: 'ignore-case', l: 'files-with-matches', L: 'files-without-match', c: 'count', w: 'word-regexp', v: 'invert-match', E: 'extended-regexp', F: 'fixed-strings', e: 'e:', h: 'h', q: 'quiet' });
  const pats = [...(o.vals.e ?? [])];
  const pos = [...o.pos];
  if (!pats.length) {
    if (!pos.length) die('usage: git grep [<options>] [-e] <pattern> [<rev>...] [[--] <path>...]');
    pats.push(pos.shift()!);
  }
  const revs = pos.filter((p) => isRev(r, p));
  const paths = [...pos.filter((p) => !isRev(r, p)), ...(o.paths ?? [])].map((p) => repoPath(r, p) ?? p);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const src = pats.map((p) => (o.flags.has('fixed-strings') ? esc(p) : o.flags.has('extended-regexp') ? p : p.replace(/\\\|/g, '|').replace(/\\([(){}+?])/g, '$1'))).map((p) => (o.flags.has('word-regexp') ? `\\b(?:${p})\\b` : p));
  const re = new RegExp(src.join('|'), o.flags.has('ignore-case') ? 'i' : '');
  let found = false;
  const search = (prefix: string, tree: Record<string, string>) => {
    for (const p of Object.keys(tree).sort()) {
      if (!pathMatch(p, paths.length ? paths : undefined)) continue;
      const ls = tree[p].replace(/\n$/, '').split('\n');
      const hits = ls.map((l, k) => ({ l, k })).filter((x) => re.test(x.l) !== o.flags.has('invert-match'));
      const shown = prefix + relDisplay(r, p);
      if (o.flags.has('files-without-match')) {
        if (!hits.length) io.out(shown + '\n');
        continue;
      }
      if (!hits.length) continue;
      found = true;
      if (o.flags.has('quiet')) continue;
      if (o.flags.has('files-with-matches')) io.out(shown + '\n');
      else if (o.flags.has('count')) io.out(`${shown}:${hits.length}\n`);
      else for (const h of hits) io.out(`${o.flags.has('h') ? '' : shown + ':'}${o.flags.has('line-number') ? h.k + 1 + ':' : ''}${h.l}\n`);
    }
  };
  if (revs.length) for (const rv of revs) search(rv + ':', treeOf(r, mustRev(r, rv)));
  else {
    const w = workTree(r);
    const t: Record<string, string> = {};
    for (const p of Object.keys(r.st.index)) if (w.files[p] !== undefined) t[p] = w.files[p];
    if (o.flags.has('untracked')) for (const p of untrackedFiles(r, w).untracked) t[p] = w.files[p];
    search('', t);
  }
  return found ? 0 : 1;
}

/* ----------------------------------------------------------------------------- branch, tag, describe */

function upstreamTrack(r: Repo, b: string, verbose: number): string {
  const u = r.st.upstream?.[b];
  if (!u || verbose < 2) return '';
  const name = `${u.remote}/${u.merge}`;
  const rid = r.st.remoteRefs?.[name];
  if (!rid) return `[${name}: gone] `;
  const ab = aheadBehind(r, r.st.branches[b], rid);
  const parts = [ab.ahead ? `ahead ${ab.ahead}` : '', ab.behind ? `behind ${ab.behind}` : ''].filter(Boolean);
  return `[${name}${parts.length ? ': ' + parts.join(', ') : ''}] `;
}

function cmdBranch(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['set-upstream-to', 'merged', 'no-merged', 'contains', 'no-contains', 'sort', 'format', 'points-at'], { d: 'delete', D: 'force-delete', m: 'move', M: 'force-move', c: 'copy', a: 'all', r: 'remotes', v: 'verbose', f: 'force', u: 'set-upstream-to:', l: 'list', t: 'track', q: 'quiet' });
  const st = r.st;
  const head = headCommit(st);
  const verbose = [...args].filter((a) => a === '-v' || a === '--verbose').length + (args.includes('-vv') ? 2 : 0);
  if (o.flags.has('show-current')) {
    if (st.head.branch !== undefined) io.out(st.head.branch + '\n');
    return 0;
  }
  if (o.flags.has('delete') || o.flags.has('force-delete')) {
    if (!o.pos.length) die('fatal: branch name required');
    let code = 0;
    for (const name of o.pos) {
      if (o.flags.has('remotes')) {
        if (!st.remoteRefs?.[name]) {
          io.err(`error: remote-tracking branch '${name}' not found\n`);
          code = 1;
          continue;
        }
        io.out(`Deleted remote-tracking branch ${name} (was ${short(st.remoteRefs[name])}).\n`);
        delete st.remoteRefs[name];
        continue;
      }
      if (st.branches[name] === undefined) {
        io.err(`error: branch '${name}' not found\n`);
        code = 1;
        continue;
      }
      if (name === st.head.branch) {
        io.err(`error: cannot delete branch '${name}' used by worktree at '${r.root}'\n`);
        code = 1;
        continue;
      }
      const tip = st.branches[name];
      const u = st.upstream?.[name];
      const mergedInto = u && st.remoteRefs?.[`${u.remote}/${u.merge}`] ? st.remoteRefs[`${u.remote}/${u.merge}`] : head;
      if (!o.flags.has('force-delete') && !o.flags.has('force') && tip && !ancestors(st, mergedInto).has(tip)) {
        io.err(`error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'\nhint: Disable this message with "git config advice.forceDeleteBranch false"\n`);
        code = 1;
        continue;
      }
      io.out(`Deleted branch ${name} (was ${short(tip ?? '0000000')}).\n`);
      delete st.branches[name];
      delete st.upstream?.[name];
      delete st.reflogs?.[`refs/heads/${name}`];
    }
    saveRepo(r);
    return code;
  }
  if (o.flags.has('move') || o.flags.has('force-move') || o.flags.has('copy')) {
    const [a, b] = o.pos.length === 1 ? [st.head.branch!, o.pos[0]] : o.pos;
    if (st.branches[a] === undefined) die(`error: refname refs/heads/${a} not found\nfatal: branch rename failed`, 1);
    if (st.branches[b] !== undefined && !o.flags.has('force-move')) die(`fatal: a branch named '${b}' already exists`);
    st.branches[b] = st.branches[a];
    if (!o.flags.has('copy')) {
      delete st.branches[a];
      if (st.head.branch === a) st.head.branch = b;
      if (st.upstream?.[a]) {
        st.upstream[b] = st.upstream[a];
        delete st.upstream[a];
      }
    }
    logRef(r, `refs/heads/${b}`, null, st.branches[b] ?? '', `Branch: renamed refs/heads/${a} to refs/heads/${b}`);
    saveRepo(r);
    return 0;
  }
  if (val(o, 'set-upstream-to') !== undefined || o.flags.has('unset-upstream')) {
    const b = o.pos[0] ?? st.head.branch!;
    if (o.flags.has('unset-upstream')) {
      if (!st.upstream?.[b]) die(`fatal: branch '${b}' has no upstream information`);
      delete st.upstream![b];
      saveRepo(r);
      return 0;
    }
    const up = val(o, 'set-upstream-to')!;
    if (!st.remoteRefs?.[up]) {
      if (st.branches[up] !== undefined) die(`fatal: the requested upstream branch '${up}' is a local branch; this simulator tracks remote branches (origin/${up})`);
      die(`fatal: the requested upstream branch '${up}' does not exist\nhint: \nhint: If you are planning on basing your work on an upstream\nhint: branch that already exists at the remote, you may need to\nhint: run "git fetch" to retrieve it.`);
    }
    const [remote, ...rest] = up.split('/');
    (st.upstream ??= {})[b] = { remote, merge: rest.join('/') };
    saveRepo(r);
    io.out(`branch '${b}' set up to track '${up}'.\n`);
    return 0;
  }
  const listing = !o.pos.length || o.flags.has('list') || o.flags.has('all') || o.flags.has('remotes') || o.vals.merged || o.vals['no-merged'] || o.vals.contains || o.flags.has('merged') || o.flags.has('no-merged');
  if (listing) {
    let rows: Array<{ name: string; id: string | null; local: boolean }> = [];
    if (!o.flags.has('remotes')) for (const b of Object.keys(st.branches).sort()) if (st.branches[b] || b === st.head.branch) rows.push({ name: b, id: st.branches[b], local: true });
    if (o.flags.has('all') || o.flags.has('remotes')) for (const rb of Object.keys(st.remoteRefs ?? {}).sort()) rows.push({ name: rb, id: st.remoteRefs![rb], local: false });
    if (o.flags.has('list') && o.pos.length) rows = rows.filter((x) => o.pos.some((pat) => pathMatch(x.name, [pat])));
    const mergedRef = o.vals.merged ? mustRev(r, val(o, 'merged')!) : o.flags.has('merged') ? head : null;
    const noMergedRef = o.vals['no-merged'] ? mustRev(r, val(o, 'no-merged')!) : o.flags.has('no-merged') ? head : null;
    if (mergedRef) rows = rows.filter((x) => x.id && ancestors(st, mergedRef).has(x.id));
    if (noMergedRef) rows = rows.filter((x) => x.id && !ancestors(st, noMergedRef).has(x.id));
    if (val(o, 'contains')) {
      const c = mustRev(r, val(o, 'contains')!);
      rows = rows.filter((x) => x.id && ancestors(st, x.id).has(c));
    }
    if (st.head.branch === undefined && !o.flags.has('remotes') && head) rows.unshift({ name: `(HEAD detached at ${short(head)})`, id: head, local: true });
    if (st.seq?.kind === 'rebase' && st.head.branch === undefined) rows[0] = { name: `(no branch, rebasing ${st.seq.branch})`, id: head, local: true };
    const w = Math.max(...rows.map((x) => (x.local ? x.name : 'remotes/' + x.name).length), 0);
    for (const x of rows) {
      const cur = x.local && (x.name === st.head.branch || x.name.startsWith('('));
      const display = x.local || o.flags.has('remotes') ? x.name : `remotes/${x.name}`;
      const sym = !x.local && x.name.endsWith('/HEAD') ? Object.entries(st.remoteRefs ?? {}).find(([k, v]) => v === x.id && !k.endsWith('/HEAD'))?.[0] : undefined;
      if (sym) {
        io.out(`  ${display} -> ${sym}\n`);
        continue;
      }
      const tail = verbose && x.id ? ` ${short(x.id)} ${x.local ? upstreamTrack(r, x.name, verbose) : ''}${subject(st.commits[x.id]?.message ?? '')}` : '';
      io.out(`${cur ? '*' : ' '} ${verbose ? display.padEnd(w) : display}${tail}\n`);
    }
    return 0;
  }
  const name = o.pos[0];
  if (!head && !o.pos[1]) die(`fatal: not a valid object name: '${st.head.branch}'`);
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-') || name.endsWith('.lock') || name.includes('..') || name.endsWith('/')) die(`fatal: '${name}' is not a valid branch name`);
  if (st.branches[name] !== undefined && !o.flags.has('force')) die(`fatal: a branch named '${name}' already exists`);
  const startName = o.pos[1] ?? 'HEAD';
  const start = mustRev(r, startName, `not a valid object name: '${startName}'`);
  st.branches[name] = start;
  logRef(r, `refs/heads/${name}`, null, start, `branch: Created from ${startName}`);
  if (st.remoteRefs?.[startName] && !o.flags.has('no-track')) {
    const [remote, ...rest] = startName.split('/');
    (st.upstream ??= {})[name] = { remote, merge: rest.join('/') };
    io.out(`branch '${name}' set up to track '${startName}'.\n`);
  }
  saveRepo(r);
  return 0;
}

function versionKey(name: string): Array<number | string> {
  return name.split(/(\d+)/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}
export function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '';
    const q = y[i] ?? '';
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

function cmdTag(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['message', 'file', 'sort', 'contains', 'points-at', 'format', 'n'], { a: 'annotate', m: 'message:', F: 'file:', d: 'delete', f: 'force', l: 'list', s: 'sign', v: 'verify' });
  const st = r.st;
  if (o.flags.has('sign') || o.flags.has('verify')) die('error: signing tags needs a GPG key, which this simulator does not have; use an annotated tag (-a -m).', 1);
  if (o.flags.has('delete')) {
    let code = 0;
    for (const t of o.pos) {
      if (!st.tags[t]) {
        io.err(`error: tag '${t}' not found.\n`);
        code = 1;
        continue;
      }
      io.out(`Deleted tag '${t}' (was ${short(st.annotated?.[t] ? tagId(t, st.tags[t], st.annotated[t]) : st.tags[t])})\n`);
      delete st.tags[t];
      delete st.annotated?.[t];
    }
    saveRepo(r);
    return code;
  }
  const nLines = args.some((a) => /^-n\d*$/.test(a)) ? Number(args.find((a) => /^-n\d*$/.test(a))!.slice(2) || 1) : 0;
  const listMode = !o.pos.length || o.flags.has('list') || nLines || o.vals.contains || o.vals['points-at'];
  if (listMode && !o.vals.message && !o.vals.file) {
    let names = Object.keys(st.tags);
    if (o.pos.length) names = names.filter((t) => o.pos.some((pat) => pathMatch(t, [pat])));
    if (val(o, 'contains')) {
      const c = mustRev(r, val(o, 'contains')!);
      names = names.filter((t) => ancestors(st, st.tags[t]).has(c));
    }
    if (val(o, 'points-at')) {
      const c = mustRev(r, val(o, 'points-at')!);
      names = names.filter((t) => st.tags[t] === c);
    }
    const sort = val(o, 'sort') ?? configGet(ctx, st, 'tag.sort') ?? 'refname';
    const desc = sort.startsWith('-');
    const key = sort.replace(/^-/, '');
    names.sort((a, b) => (key.startsWith('v:') || key.startsWith('version:') ? compareVersions(a, b) : key === 'creatordate' || key === 'taggerdate' ? (st.annotated?.[a]?.time ?? st.commits[st.tags[a]].time) - (st.annotated?.[b]?.time ?? st.commits[st.tags[b]].time) : a < b ? -1 : a > b ? 1 : 0));
    if (desc) names.reverse();
    const w = Math.max(15, ...names.map((t) => t.length));
    for (const t of names) {
      if (nLines) {
        const msg = st.annotated?.[t]?.message ?? subject(st.commits[st.tags[t]].message);
        io.out(`${t.padEnd(w)} ${msg.split('\n').slice(0, nLines).join('\n    ')}\n`);
      } else io.out(t + '\n');
    }
    return 0;
  }
  const name = o.pos[0];
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-')) die(`fatal: '${name}' is not a valid tag name.`);
  if (st.tags[name] && !o.flags.has('force')) die(`fatal: tag '${name}' already exists`);
  const target = mustRev(r, o.pos[1] ?? 'HEAD', `Failed to resolve '${o.pos[1] ?? 'HEAD'}' as a valid ref.`);
  const annotated = o.flags.has('annotate') || o.vals.message || o.vals.file;
  if (annotated) {
    let message = o.vals.message?.join('\n\n') ?? (val(o, 'file') ? readFile(ctx.sys.fs, abs(ctx, val(o, 'file')!), actor(ctx)) : null);
    if (message === null) {
      const edited = editFile(r, 'TAG_EDITMSG', `\n#\n# Write a message for tag:\n#   ${name}\n# Lines starting with '#' will be ignored.\n`, ['tag', '-F', `${r.gitDir}/TAG_EDITMSG`, '--lab-strip', ...(o.flags.has('force') ? ['-f'] : []), name, target]);
      if (edited === null) return 0;
      message = edited;
    }
    message = cleanMessage(message, o.flags.has('lab-strip') || !o.vals.message ? 'strip' : 'whitespace');
    if (!message) die('fatal: no tag message?');
    const me = ident(r, 'committer');
    (st.annotated ??= {})[name] = { message, tagger: me.name, email: me.email, time: me.time };
  } else delete st.annotated?.[name];
  const old = st.tags[name];
  st.tags[name] = target;
  saveRepo(r);
  if (old && old !== target) io.out(`Updated tag '${name}' (was ${short(old)})\n`);
  return 0;
}

function describe(r: Repo, id: string, o: Parsed): string | null {
  const st = r.st;
  const tagsOnly = o.flags.has('tags');
  const match = o.vals.match ?? [];
  const exclude = o.vals.exclude ?? [];
  const cands = Object.keys(st.tags).filter((t) => (tagsOnly || st.annotated?.[t]) && (!match.length || match.some((m) => pathMatch(t, [m]))) && !exclude.some((m) => pathMatch(t, [m])));
  const mine = ancestors(st, id);
  let best: { tag: string; depth: number; time: number } | null = null;
  for (const t of cands) {
    const tid = st.tags[t];
    if (!mine.has(tid)) continue;
    const reach = ancestors(st, tid);
    const depth = [...mine].filter((c) => !reach.has(c)).length;
    const time = st.annotated?.[t]?.time ?? st.commits[tid].time;
    if (!best || depth < best.depth || (depth === best.depth && time > best.time)) best = { tag: t, depth, time };
  }
  if (!best) return null;
  const abbrev = val(o, 'abbrev') !== undefined ? Number(val(o, 'abbrev')) : 7;
  if ((best.depth === 0 && !o.flags.has('long')) || abbrev === 0) return best.tag;
  return `${best.tag}-${best.depth}-g${id.slice(0, abbrev)}`;
}

function cmdDescribe(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['abbrev', 'match', 'exclude', 'dirty', 'candidates'], {});
  const target = o.pos[0] ?? 'HEAD';
  const id = mustRev(r, target);
  if (o.flags.has('exact-match')) {
    const t = Object.keys(r.st.tags).find((x) => r.st.tags[x] === id && (o.flags.has('tags') || r.st.annotated?.[x]));
    if (!t) die(`fatal: no tag exactly matches '${id}'`);
    io.out(t + '\n');
    return 0;
  }
  let d = describe(r, id, o);
  if (!d) {
    if (o.flags.has('always')) d = short(id);
    else die(Object.keys(r.st.tags).length && !o.flags.has('tags') ? `fatal: No annotated tags can describe '${id}'.\nHowever, there were unannotated tags: try --tags.` : Object.keys(r.st.tags).length ? `fatal: No tags can describe '${id}'.\nTry --always, or create some tags.` : 'fatal: No names found, cannot describe anything.');
  }
  if ((o.flags.has('dirty') || o.vals.dirty) && !o.pos.length && isDirty(changes(r), r.st)) d += val(o, 'dirty') ?? '-dirty';
  io.out(d + '\n');
  return 0;
}

/* ----------------------------------------------------------------------------- switch, checkout, restore, reset */

/** Moves to another commit, carrying local changes that do not clash; dies like git when they do. */
function switchTo(r: Repo, target: string | null, _verb: string): void {
  const st = r.st;
  const c = changes(r);
  const tt = treeOf(r, target);
  const tx = execOf(r, target);
  const dirty = [...new Set([...c.staged, ...c.unstaged])];
  const blocked = dirty.filter((p) => tt[p] !== c.ht[p]);
  if (blocked.length) die(`error: Your local changes to the following files would be overwritten by checkout:\n${blocked.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you switch branches.\nAborting`, 1);
  const clobber = c.untracked.filter((p) => tt[p] !== undefined && tt[p] !== c.w.files[p]);
  if (clobber.length) die(`error: The following untracked working tree files would be overwritten by checkout:\n${clobber.map((p) => `\t${p}\n`).join('')}Please move or remove them before you switch branches.\nAborting`, 1);
  checkoutTree(r, c.ht, tt, tx, dirty);
  const idx: Record<string, string> = { ...tt };
  const xs = new Set(tx);
  for (const p of dirty) {
    if (st.index[p] === undefined) delete idx[p];
    else idx[p] = st.index[p];
    if ((st.x ?? []).includes(p)) xs.add(p);
    else xs.delete(p);
  }
  st.index = idx;
  st.x = [...xs].filter((p) => idx[p] !== undefined);
}

function localChangeLines(r: Repo): string {
  const c = changes(r);
  return [...new Set([...c.staged, ...c.unstaged])].sort().map((p) => `${c.w.files[p] === undefined ? 'D' : c.ht[p] === undefined ? 'A' : 'M'}\t${p}\n`).join('');
}

function detachAdvice(to: string): string {
  return `Note: switching to '${to}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\nIf you want to create a new branch to retain commits you create, you may\ndo so (now or later) by using -c with the switch command. Example:\n\n  git switch -c <new-branch-name>\n\nOr undo this operation with:\n\n  git switch -\n\nTurn off this advice by setting config variable advice.detachedHead to false\n\n`;
}

function doSwitch(r: Repo, io: IO, name: string, o: { create?: string; force?: boolean; detach?: boolean; start?: string; orphan?: boolean; track?: boolean }, verb: 'switch' | 'checkout'): number {
  const st = r.st;
  const fromName = st.head.branch ?? short(headCommit(st) ?? '');
  const head = headCommit(st);
  if (st.seq?.kind === 'rebase' && !o.detach) die(`fatal: cannot switch branch while rebasing\nConsider "git rebase --quit" or "git worktree add".`);
  if (st.merging) die(`fatal: cannot switch branch while merging\nConsider "git merge --quit" or "git worktree add".`);
  if (o.orphan) {
    const c = changes(r);
    checkoutTree(r, c.ht, {}, [], []);
    st.index = {};
    st.x = [];
    st.head = { branch: name };
    st.branches[name] = null;
    saveRepo(r);
    io.err(`Switched to a new branch '${name}'\n`);
    return 0;
  }
  if (o.create) {
    if (st.branches[o.create] !== undefined && !o.force) die(`fatal: a branch named '${o.create}' already exists`);
    const startName = o.start ?? 'HEAD';
    const start = o.start ? mustRev(r, o.start, `invalid reference: ${o.start}`) : head;
    if (start !== head) switchTo(r, start, verb);
    if (!head && !o.start) {
      delete st.branches[st.head.branch!];
      st.branches[o.create] = null;
    } else st.branches[o.create] = start;
    st.head = { branch: o.create };
    if (start) {
      logRef(r, `refs/heads/${o.create}`, null, start, `branch: Created from ${startName}`);
      logRef(r, 'HEAD', head, start, `checkout: moving from ${fromName} to ${o.create}`);
    }
    if (o.start && st.remoteRefs?.[o.start] && o.track !== false) {
      const [remote, ...rest] = o.start.split('/');
      (st.upstream ??= {})[o.create] = { remote, merge: rest.join('/') };
      io.out(`branch '${o.create}' set up to track '${o.start}'.\n`);
    }
    saveRepo(r);
    io.err(`Switched to a new branch '${o.create}'\n`);
    return 0;
  }
  let target = name;
  if (name === '-') {
    const moves = (st.reflogs?.HEAD ?? []).map((e) => /^checkout: moving from (\S+) to (\S+)$/.exec(e.msg)).filter((m): m is RegExpExecArray => !!m);
    if (!moves.length) die('fatal: invalid reference: @{-1}');
    target = moves[moves.length - 1][1];
  }
  if (st.branches[target] !== undefined && !o.detach) {
    if (target === st.head.branch) {
      io.err(`Already on '${target}'\n`);
      io.out(trackingLine(r));
      return 0;
    }
    const id = st.branches[target];
    if (o.force) {
      const c = changes(r);
      checkoutTree(r, { ...c.ht, ...st.index }, treeOf(r, id), execOf(r, id), []);
      setIndexFromTree(r, treeOf(r, id), execOf(r, id));
    } else switchTo(r, id, verb);
    st.head = { branch: target };
    if (id) logRef(r, 'HEAD', head, id, `checkout: moving from ${fromName} to ${target}`);
    saveRepo(r);
    const lc = localChangeLines(r);
    if (lc) io.out(lc);
    io.err(`Switched to branch '${target}'\n`);
    io.out(trackingLine(r));
    return 0;
  }
  // A remote branch of the same name: create a local tracking branch (git's "DWIM").
  const remoteMatches = Object.keys(st.remoteRefs ?? {}).filter((k) => k.split('/').slice(1).join('/') === target && !k.endsWith('/HEAD'));
  if (!o.detach && remoteMatches.length === 1 && st.branches[target] === undefined) {
    return doSwitch(r, io, target, { create: target, start: remoteMatches[0] }, verb);
  }
  const id = rev(r, target);
  if (!id) {
    if (verb === 'switch') die(`fatal: invalid reference: ${target}`);
    die(`error: pathspec '${target}' did not match any file(s) known to git`, 1);
  }
  if (verb === 'switch' && !o.detach) die(`fatal: a branch is expected, got '${target}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
  switchTo(r, id, verb);
  st.head = { detached: id! };
  logRef(r, 'HEAD', head, id!, `checkout: moving from ${fromName} to ${target}`);
  saveRepo(r);
  if (configGet(r.ctx, st, 'advice.detachedhead') !== 'false') io.err(detachAdvice(target));
  io.err(`HEAD is now at ${commitLine(r, id!)}\n`);
  return 0;
}

function cmdSwitch(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['create', 'force-create', 'orphan'], { c: 'create:', C: 'force-create:', d: 'detach', f: 'force', t: 'track', q: 'quiet' });
  const create = val(o, 'create') ?? val(o, 'force-create');
  if (val(o, 'orphan')) return doSwitch(r, io, val(o, 'orphan')!, { orphan: true }, 'switch');
  const name = create ?? o.pos[0];
  if (!name) die('fatal: missing branch or commit argument');
  return doSwitch(r, io, name, { create, force: !!val(o, 'force-create') || o.flags.has('force') || o.flags.has('discard-changes'), detach: o.flags.has('detach'), start: create ? o.pos[0] : undefined, track: o.flags.has('no-track') ? false : undefined }, 'switch');
}

function cmdCheckout(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['orphan'], { b: 'b:', B: 'B:', f: 'force', t: 'track', q: 'quiet', p: 'patch' });
  const st = r.st;
  if (o.flags.has('patch')) die('error: git checkout -p is not available in this simulator; restore whole files.', 1);
  const create = val(o, 'b') ?? val(o, 'B');
  if (val(o, 'orphan')) return doSwitch(r, io, val(o, 'orphan')!, { orphan: true }, 'checkout');
  if (o.flags.has('track') && !create && o.pos[0]) {
    const rb = o.pos[0];
    return doSwitch(r, io, rb, { create: rb.split('/').slice(1).join('/'), start: rb }, 'checkout');
  }
  // checkout [<tree-ish>] -- <paths>, or checkout <path> when the name is not a branch.
  const restoreFrom = (source: string | null, specs: string[]) => {
    const tree = source ? treeOf(r, mustRev(r, source)) : st.index;
    const tx = source ? execOf(r, mustRev(r, source)) : st.x ?? [];
    let n = 0;
    for (const spec of specs) {
      const hits = matchSpec(r, spec, Object.keys(tree));
      if (!hits.length) die(`error: pathspec '${spec}' did not match any file(s) known to git`, 1);
      const files: Record<string, string> = {};
      for (const p of hits) {
        files[p] = tree[p];
        if (source) st.index[p] = tree[p];
        if (st.unmerged?.[p]) delete st.unmerged[p];
      }
      if (source) st.x = [...new Set([...(st.x ?? []).filter((p) => !hits.includes(p)), ...tx.filter((p) => hits.includes(p))])];
      writeWorking(r, files, [], tx);
      n += hits.length;
    }
    saveRepo(r);
    io.err(`Updated ${plural(n, 'path')} from ${source ? 'the tree' : 'the index'}\n`);
    return 0;
  };
  if (o.paths) return restoreFrom(o.pos[0] ?? null, o.paths);
  if (!create && o.pos.length === 1 && st.branches[o.pos[0]] === undefined && !isRev(r, o.pos[0]) && !Object.keys(st.remoteRefs ?? {}).some((k) => k.endsWith('/' + o.pos[0]))) return restoreFrom(null, o.pos);
  if (!create && o.pos.length > 1) return restoreFrom(isRev(r, o.pos[0]) ? o.pos[0] : null, isRev(r, o.pos[0]) ? o.pos.slice(1) : o.pos);
  const name = create ?? o.pos[0];
  if (!name) die("fatal: you must specify path(s) to restore");
  const isBranch = st.branches[name] !== undefined && !create;
  return doSwitch(r, io, name, { create, force: !!val(o, 'B') || o.flags.has('force'), detach: !create && !isBranch && !Object.keys(st.remoteRefs ?? {}).some((k) => k.split('/').slice(1).join('/') === name), start: create ? o.pos[0] : undefined, track: o.flags.has('no-track') ? false : undefined }, 'checkout');
}

function cmdRestore(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['source'], { s: 'source:', S: 'staged', W: 'worktree', p: 'patch' });
  const st = r.st;
  const specs = [...o.pos, ...(o.paths ?? [])];
  if (!specs.length) die('fatal: you must specify path(s) to restore');
  const staged = o.flags.has('staged');
  const worktree = o.flags.has('worktree') || !staged;
  const source = val(o, 'source');
  const srcId = source ? mustRev(r, source, `could not resolve ${source}`) : null;
  const head = headCommit(st);
  for (const spec of specs) {
    const fromTree = srcId ? treeOf(r, srcId) : staged ? treeOf(r, head) : st.index;
    const fromX = srcId ? execOf(r, srcId) : staged ? execOf(r, head) : st.x ?? [];
    const w = workTree(r);
    const cand = [...new Set([...Object.keys(fromTree), ...Object.keys(st.index), ...(staged ? [] : Object.keys(w.files).filter((p) => st.index[p] !== undefined))])];
    const hits = matchSpec(r, spec, cand);
    if (!hits.length) die(`error: pathspec '${spec}' did not match any file(s) known to git`, 1);
    for (const p of hits) {
      if (staged) {
        if (fromTree[p] === undefined) delete st.index[p];
        else st.index[p] = fromTree[p];
        const xs = new Set(st.x ?? []);
        if (fromX.includes(p)) xs.add(p);
        else xs.delete(p);
        st.x = [...xs];
      }
      if (worktree) {
        if (st.unmerged?.[p] && !srcId) die(`error: path '${p}' is unmerged`, 1);
        const content = staged || srcId ? fromTree[p] : st.index[p];
        if (content === undefined) writeWorking(r, {}, [p]);
        else writeWorking(r, { [p]: content }, [], (staged || srcId ? fromX : st.x ?? []).filter((q) => q === p));
      }
    }
  }
  saveRepo(r);
  return 0;
}

function cmdReset(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { q: 'quiet', p: 'patch' });
  const st = r.st;
  const mode = o.flags.has('hard') ? 'hard' : o.flags.has('soft') ? 'soft' : o.flags.has('keep') ? 'keep' : o.flags.has('merge') ? 'merge' : 'mixed';
  const head = headCommit(st);
  let paths = o.paths ?? [];
  let target = 'HEAD';
  if (o.pos.length) {
    if (isRev(r, o.pos[0]) && !(o.pos.length === 1 && lookup(ctx.sys.fs, abs(ctx, o.pos[0]), ROOT) && st.index[repoPath(r, o.pos[0]) ?? ''] !== undefined && !st.branches[o.pos[0]])) {
      target = o.pos[0];
      paths = [...o.pos.slice(1), ...paths];
    } else paths = [...o.pos, ...paths];
  }
  if (paths.length) {
    if (mode === 'hard' || mode === 'soft') die(`fatal: Cannot do ${mode} reset with paths.`);
    const id = head ? mustRev(r, target) : null;
    const tree = treeOf(r, id);
    const tx = execOf(r, id);
    for (const spec of paths) {
      const hits = matchSpec(r, spec, [...new Set([...Object.keys(tree), ...Object.keys(st.index)])]);
      for (const p of hits) {
        if (tree[p] === undefined) delete st.index[p];
        else st.index[p] = tree[p];
        const xs = new Set(st.x ?? []);
        if (tx.includes(p)) xs.add(p);
        else xs.delete(p);
        st.x = [...xs];
        if (st.unmerged?.[p]) delete st.unmerged[p];
      }
    }
    saveRepo(r);
    const lines = localChangeLines(r);
    if (lines && !o.flags.has('quiet')) io.out(`Unstaged changes after reset:\n${changes(r).unstaged.map((p) => `M\t${p}\n`).join('')}`);
    return 0;
  }
  if (!head) die("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
  const id = mustRev(r, target);
  const c = changes(r);
  const tt = treeOf(r, id);
  const tx = execOf(r, id);
  if (mode === 'keep') {
    const dirty = [...new Set([...c.staged, ...c.unstaged])].filter((p) => tt[p] !== c.ht[p]);
    if (dirty.length) die(`error: Entry '${dirty[0]}' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision '${target}'.`);
  }
  st.origHead = head!;
  moveHead(r, id, `reset: moving to ${target}`);
  if (mode !== 'soft') {
    if (mode === 'hard' || mode === 'merge' || mode === 'keep') {
      const local = mode === 'keep' ? [...new Set([...c.staged, ...c.unstaged])] : [];
      checkoutTree(r, { ...c.ht, ...st.index }, tt, tx, local);
      if (mode === 'hard') {
        // Remove files that were only staged (new files), as git does.
        writeWorking(r, {}, Object.keys(st.index).filter((p) => tt[p] === undefined && c.ht[p] === undefined));
      }
    }
    setIndexFromTree(r, tt, tx);
    delete st.merging;
    delete st.unmerged;
  }
  saveRepo(r);
  if (o.flags.has('quiet')) return 0;
  if (mode === 'hard') io.out(`HEAD is now at ${commitLine(r, id)}\n`);
  else if (mode === 'mixed') {
    const after = changes(r);
    if (after.unstaged.length) io.out(`Unstaged changes after reset:\n${after.unstaged.map((p) => `${after.w.files[p] === undefined ? 'D' : 'M'}\t${p}\n`).join('')}`);
  }
  return 0;
}

/* ----------------------------------------------------------------------------- merge */

function mergeMessage(r: Repo, name: string): string {
  const st = r.st;
  const into = st.head.branch && !['main', 'master'].includes(st.head.branch) ? ` into ${st.head.branch}` : '';
  if (st.remoteRefs?.[name]) return `Merge remote-tracking branch '${name}'${into}`;
  if (st.tags[name]) return `Merge tag '${name}'${into}`;
  if (st.branches[name] !== undefined) return `Merge branch '${name}'${into}`;
  return `Merge commit '${name}'${into}`;
}

function conflictReport(io: IO, m: { conflicts: Record<string, Unmerged>; merged: string[] }, oursLabel: string, theirsLabel: string): void {
  for (const p of m.merged) io.out(`Auto-merging ${p}\n`);
  for (const [p, kind] of Object.entries(m.conflicts)) {
    if (kind === 'both modified') io.out(`CONFLICT (content): Merge conflict in ${p}\n`);
    else if (kind === 'both added') io.out(`CONFLICT (add/add): Merge conflict in ${p}\n`);
    else if (kind === 'deleted by us') io.out(`CONFLICT (modify/delete): ${p} deleted in ${oursLabel} and modified in ${theirsLabel}.  Version ${theirsLabel} of ${p} left in tree.\n`);
    else io.out(`CONFLICT (modify/delete): ${p} deleted in ${theirsLabel} and modified in ${oursLabel}.  Version ${oursLabel} of ${p} left in tree.\n`);
  }
}

/** Applies a three-way merge result to the index and working tree. Unmerged paths keep "ours" in the index. */
function applyMergeResult(r: Repo, before: Record<string, string>, m: ReturnType<typeof mergeTrees>, ours: Record<string, string>): void {
  const st = r.st;
  rerereOnConflict(r, m.conflicts, m.tree);
  checkoutTree(r, before, m.tree, m.x, []);
  st.index = { ...m.tree };
  st.x = [...m.x];
  if (Object.keys(m.conflicts).length) {
    st.unmerged = { ...m.conflicts };
    for (const p of Object.keys(m.conflicts)) {
      if (ours[p] === undefined) delete st.index[p];
      else st.index[p] = ours[p];
    }
  }
}

export function doMerge(r: Repo, io: IO, name: string, o: { noFf?: boolean; ffOnly?: boolean; squash?: boolean; noCommit?: boolean; message?: string; strategyOption?: string; strategy?: string; verb?: string; label?: string }): number {
  const st = r.st;
  if (st.merging) die('error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.');
  const other = rev(r, name);
  if (!other) die(`merge: ${name} - not something we can merge`, 1);
  const head = headCommit(st);
  const c = changes(r);
  const ot = treeOf(r, other);
  const theirsLabel = o.label ?? name;
  if (!head) {
    // Merging into an unborn branch: just take the other history.
    checkoutTree(r, {}, ot, execOf(r, other!), []);
    setIndexFromTree(r, ot, execOf(r, other!));
    moveHead(r, other!, `${o.verb ?? 'merge'} ${name}: Fast-forward`);
    saveRepo(r);
    return 0;
  }
  const dirtyClash = [...new Set([...c.staged, ...c.unstaged])].filter((p) => ot[p] !== c.ht[p]);
  if (dirtyClash.length) die(`error: Your local changes to the following files would be overwritten by merge:\n${dirtyClash.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting`, 1);
  const clobber = c.untracked.filter((p) => ot[p] !== undefined && ot[p] !== c.w.files[p] && c.ht[p] === undefined);
  if (clobber.length) die(`error: The following untracked working tree files would be overwritten by merge:\n${clobber.map((p) => `\t${p}\n`).join('')}Please move or remove them before you merge.\nAborting`, 1);
  const ours = ancestors(st, head);
  if (ours.has(other!)) {
    io.out('Already up to date.\n');
    return 0;
  }
  const theirs = ancestors(st, other);
  const canFf = theirs.has(head);
  if (canFf && !o.noFf && !o.squash) {
    io.out(`Updating ${short(head)}..${short(other!)}\nFast-forward\n`);
    printTreeDiff(io, c.ht, c.hx, ot, execOf(r, other!), { stat: true });
    const created = Object.keys(ot).filter((p) => c.ht[p] === undefined).sort();
    for (const p of created) io.out(` create mode ${execOf(r, other!).includes(p) ? '100755' : '100644'} ${p}\n`);
    for (const p of Object.keys(c.ht).filter((q) => ot[q] === undefined).sort()) io.out(` delete mode 100644 ${p}\n`);
    checkoutTree(r, c.ht, ot, execOf(r, other!), []);
    setIndexFromTree(r, ot, execOf(r, other!));
    st.origHead = head;
    moveHead(r, other!, `${o.verb ?? 'merge'} ${name}: Fast-forward`);
    saveRepo(r);
    return 0;
  }
  if (o.ffOnly) die('fatal: Not possible to fast-forward, aborting.');
  const base = mergeBases(st, head, other!)[0];
  let m: ReturnType<typeof mergeTrees>;
  if (o.strategy === 'ours') m = { tree: { ...c.ht }, x: [...c.hx], conflicts: {}, merged: [] };
  else {
    m = mergeTrees(r, treeOf(r, base), c.ht, ot, { base: execOf(r, base), ours: c.hx, theirs: execOf(r, other!) }, { ours: 'HEAD', theirs: theirsLabel, base: base ? short(base) : 'empty tree' });
    if (o.strategyOption === 'ours' || o.strategyOption === 'theirs') {
      for (const p of Object.keys(m.conflicts)) {
        const pick = o.strategyOption === 'ours' ? c.ht[p] : ot[p];
        if (pick === undefined) delete m.tree[p];
        else m.tree[p] = pick;
      }
      m.conflicts = {};
    }
  }
  st.origHead = head;
  const before = { ...c.ht };
  applyMergeResult(r, before, m, c.ht);
  const message = o.message ?? mergeMessage(r, name);
  if (Object.keys(m.conflicts).length) {
    st.merging = { other: other!, otherName: name, message: `${message}\n\n# Conflicts:\n${Object.keys(m.conflicts).map((p) => `#\t${p}`).join('\n')}`, squash: o.squash };
    saveRepo(r);
    conflictReport(io, m, 'HEAD', theirsLabel);
    io.out(o.squash ? 'Squash commit -- not updating HEAD\nAutomatic merge failed; fix conflicts and then commit the result.\n' : 'Automatic merge failed; fix conflicts and then commit the result.\n');
    return 1;
  }
  for (const p of m.merged) io.out(`Auto-merging ${p}\n`);
  if (o.squash) {
    st.merging = { other: other!, otherName: name, message: `Squashed commit of the following:\n\n${orderCommits(st, [...theirs].filter((x) => !ours.has(x))).map((id) => `commit ${id}\nAuthor: ${st.commits[id].author} <${st.commits[id].email}>\n\n    ${subject(st.commits[id].message)}`).join('\n\n')}`, squash: true };
    // A squash merge is staged but is not a merge: the commit gets one parent.
    saveRepo(r);
    io.out('Squash commit -- not updating HEAD\nAutomatic merge went well; stopped before committing as requested\n');
    return 0;
  }
  if (o.noCommit) {
    st.merging = { other: other!, otherName: name, message };
    saveRepo(r);
    io.out('Automatic merge went well; stopped before committing as requested\n');
    return 0;
  }
  const id = newCommit(r, { message, parents: [head, other!], tree: st.index, x: st.x ?? [] });
  moveHead(r, id, `${o.verb ?? 'merge'} ${name}: Merge made by the 'ort' strategy.`);
  saveRepo(r);
  io.out(`Merge made by the 'ort' strategy.\n`);
  printTreeDiff(io, c.ht, c.hx, st.index, st.x ?? [], { stat: true });
  for (const p of Object.keys(st.index).filter((q) => c.ht[q] === undefined).sort()) io.out(` create mode ${(st.x ?? []).includes(p) ? '100755' : '100644'} ${p}\n`);
  return 0;
}

function cmdMerge(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['message', 'strategy', 'strategy-option', 'file'], { m: 'message:', s: 'strategy:', X: 'strategy-option:', F: 'file:', e: 'edit', n: 'no-stat', q: 'quiet', v: 'verbose' });
  const st = r.st;
  if (o.flags.has('abort') || o.flags.has('quit')) {
    if (!st.merging) die('fatal: There is no merge to abort (MERGE_HEAD missing).');
    if (o.flags.has('abort')) {
      const c = changes(r);
      const ht = c.ht;
      checkoutTree(r, { ...c.w.files, ...st.index }, ht, c.hx, []);
      writeWorking(r, {}, Object.keys(st.index).filter((p) => ht[p] === undefined));
      setIndexFromTree(r, ht, c.hx);
    }
    delete st.merging;
    delete st.unmerged;
    delete st.rerereOpen;
    saveRepo(r);
    return 0;
  }
  if (o.flags.has('continue')) {
    if (!st.merging) die('fatal: There is no merge in progress (MERGE_HEAD missing).');
    return cmdCommit(['--no-edit'], io, ctx);
  }
  let name = o.pos[0];
  if (!name) {
    const u = st.head.branch ? st.upstream?.[st.head.branch] : undefined;
    if (!u) die('fatal: No remote for the current branch.');
    name = `${u!.remote}/${u!.merge}`;
  }
  if (o.pos.length > 1) die('error: this simulator merges one branch at a time (no octopus merges).', 1);
  const strategyOption = val(o, 'strategy-option');
  return doMerge(r, io, name, { noFf: o.flags.has('no-ff') || configGet(ctx, st, 'merge.ff') === 'false', ffOnly: o.flags.has('ff-only') || configGet(ctx, st, 'merge.ff') === 'only', squash: o.flags.has('squash'), noCommit: o.flags.has('no-commit'), message: o.vals.message?.join('\n\n') ?? (val(o, 'file') ? readFile(ctx.sys.fs, abs(ctx, val(o, 'file')!), actor(ctx)).trim() : undefined), strategyOption, strategy: val(o, 'strategy') });
}

/* ----------------------------------------------------------------------------- the sequencer: cherry-pick, revert, rebase */

function todoLine(r: Repo, t: TodoItem): string {
  if (t.action === 'exec') return `exec ${t.cmd}`;
  if (t.action === 'break') return 'break';
  return `${t.action} ${short(t.id ?? '')} ${t.msg ?? (t.id ? subject(r.st.commits[t.id]?.message ?? '') : '')}`;
}

const TODO_HELP = `
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup <commit> = like "squash" but keep only the previous
#                    commit's log message
# x, exec <command> = run command (the rest of the line) using shell
# b, break = stop here (continue rebase later with 'git rebase --continue')
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
#
# If you remove a line here THAT COMMIT WILL BE LOST.
#
# However, if you remove everything, the rebase will be aborted.
#
`;

function parseTodo(r: Repo, text: string): TodoItem[] {
  const out: TodoItem[] = [];
  const names: Record<string, string> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', x: 'exec', b: 'break', d: 'drop' };
  text.split('\n').forEach((raw, n) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const m = /^(\S+)\s*(.*)$/.exec(l)!;
    const action = names[m[1]] ?? m[1];
    if (action === 'exec') return void out.push({ action, cmd: m[2] });
    if (action === 'break') return void out.push({ action });
    if (!['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'].includes(action)) die(`error: invalid command '${m[1]}' on line ${n + 1}\nYou can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'.\nOr you can abort the rebase with 'git rebase --abort'.`, 1);
    const ref = m[2].split(/\s+/)[0];
    const id = rev(r, ref);
    if (!id) die(`error: invalid line ${n + 1}: ${l}`, 1);
    out.push({ action, id: id!, msg: m[2].split(/\s+/).slice(1).join(' ') || subject(r.st.commits[id!].message) });
  });
  return out;
}

/** Applies one commit onto HEAD (cherry-pick, or revert when reverse). Returns 'ok', 'empty' or 'conflict'. */
function applyCommit(r: Repo, io: IO, id: string, reverse: boolean, mainline: number | undefined): { result: 'ok' | 'empty' | 'conflict'; tree: Record<string, string>; x: string[] } {
  const st = r.st;
  const c = st.commits[id];
  if (c.parents.length > 1 && !mainline) die(`error: commit ${id} is a merge but no -m option was given.\nfatal: ${reverse ? 'revert' : 'cherry-pick'} failed`);
  const parent = c.parents[(mainline ?? 1) - 1];
  const head = headCommit(st);
  const ht = treeOf(r, head);
  const hx = execOf(r, head);
  const [baseT, baseX, theirT, theirX] = reverse ? [treeOf(r, id), execOf(r, id), treeOf(r, parent), execOf(r, parent)] : [treeOf(r, parent), execOf(r, parent), treeOf(r, id), execOf(r, id)];
  const label = `${short(id)} (${subject(c.message)})`;
  const m = mergeTrees(r, baseT, ht, theirT, { base: baseX, ours: hx, theirs: theirX }, { ours: 'HEAD', theirs: reverse ? `parent of ${label}` : label, base: reverse ? label : `parent of ${label}` });
  if (!Object.keys(m.conflicts).length && Object.keys({ ...ht, ...m.tree }).every((p) => ht[p] === m.tree[p]) && m.x.length === hx.length) return { result: 'empty', tree: m.tree, x: m.x };
  applyMergeResult(r, ht, m, ht);
  if (Object.keys(m.conflicts).length) {
    conflictReport(io, m, 'HEAD', label);
    return { result: 'conflict', tree: m.tree, x: m.x };
  }
  return { result: 'ok', tree: m.tree, x: m.x };
}

function pickedMessage(r: Repo, q: Sequencer, id: string): string {
  const c = r.st.commits[id];
  if (q.kind === 'revert') return `Revert "${subject(c.message)}"\n\nThis reverts commit ${id}.`;
  return q.opts?.x ? `${c.message}\n\n(cherry picked from commit ${id})` : c.message;
}

function authorOf(r: Repo, id: string): Person {
  const c = r.st.commits[id];
  return { name: c.author, email: c.email, time: c.time };
}

/** Runs the sequencer until it finishes or stops. */
function runSequencer(r: Repo, io: IO): number {
  const st = r.st;
  const q = st.seq!;
  for (;;) {
    const item = q.todo.shift();
    if (!item) break;
    q.current = item;
    if (item.action === 'drop') {
      q.done.push(item);
      continue;
    }
    if (item.action === 'break') {
      q.done.push(item);
      delete q.current;
      saveRepo(r);
      io.err('Stopped at HEAD\n');
      return 0;
    }
    if (item.action === 'exec') {
      io.out(`Executing: ${item.cmd}\n`);
      saveRepo(r);
      const cwd = r.ctx.sys.cwd;
      r.ctx.sys.cwd = r.root;
      let code: number;
      try {
        code = runCommand(r.ctx, ['bash', '-c', item.cmd!], { stdin: '', out: io.out, err: io.err });
      } finally {
        r.ctx.sys.cwd = cwd;
      }
      Object.assign(r, openRepo(r.ctx, io, r.root));
      if (code !== 0) {
        io.err(`warning: execution failed: ${item.cmd}\nYou can fix the problem, and then run\n\n  git rebase --continue\n\n`);
        r.st.seq!.done.push(item);
        delete r.st.seq!.current;
        saveRepo(r);
        return 1;
      }
      r.st.seq!.done.push(item);
      return runSequencer(r, io);
    }
    const id = item.id!;
    const isSquash = item.action === 'squash' || item.action === 'fixup';
    const res = applyCommit(r, io, id, q.kind === 'revert', q.opts?.mainline);
    if (res.result === 'conflict') {
      q.stop = 'conflict';
      saveRepo(r);
      const verb = q.kind === 'revert' ? 'revert' : q.kind === 'cherry-pick' ? 'cherry-pick' : 'rebase';
      if (q.kind === 'rebase')
        io.err(`error: could not apply ${short(id)}... ${subject(st.commits[id].message)}\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: "git add/rm <conflicted_files>", then run "git rebase --continue".\nhint: You can instead skip this commit: run "git rebase --skip".\nhint: To abort and get back to the state before "git rebase", run "git rebase --abort".\nCould not apply ${short(id)}... ${subject(st.commits[id].message)}\n`);
      else io.err(`error: could not ${verb} ${short(id)}... ${subject(st.commits[id].message)}\nhint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git ${verb} --continue".\nhint: You can instead skip this commit with "git ${verb} --skip".\nhint: To abort and get back to the state before "git ${verb}",\nhint: run "git ${verb} --abort".\n`);
      return 1;
    }
    if (res.result === 'empty' && !isSquash) {
      if (q.kind === 'rebase') {
        q.done.push(item);
        continue;
      }
      q.stop = 'conflict';
      saveRepo(r);
      io.err(`On branch ${st.head.branch ?? 'HEAD'}\nYou are currently ${q.kind === 'revert' ? 'reverting' : 'cherry-picking'} commit ${short(id)}.\n  (all conflicts fixed: run "git ${q.kind} --continue")\n  (use "git ${q.kind} --skip" to skip this patch)\n  (use "git ${q.kind} --abort" to cancel the ${q.kind} operation)\n\nnothing to commit, working tree clean\nThe previous ${q.kind} is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git ${q.kind} --skip'\n`);
      return 1;
    }
    const r2 = finishItem(r, io, item);
    if (r2 !== null) return r2;
  }
  return finishSequencer(r, io);
}

/** Commits the applied item (or squashes it into HEAD). null to keep going; a number to stop. */
function finishItem(r: Repo, io: IO, item: TodoItem): number | null {
  const st = r.st;
  const q = st.seq!;
  const id = item.id!;
  const head = headCommit(st)!;
  if (q.opts?.noCommit) {
    q.done.push(item);
    delete q.current;
    return null;
  }
  if (item.action === 'squash' || item.action === 'fixup') {
    const prev = st.commits[head];
    const msg = item.action === 'fixup' ? q.squashMsg ?? prev.message : `${q.squashMsg ?? prev.message}\n\n${st.commits[id].message}`;
    const needsEdit = item.action === 'squash' && !q.todo.some((t) => t.action === 'squash' || t.action === 'fixup');
    q.squashMsg = msg;
    let message = msg.replace(/^(fixup|squash)! .*\n*/gm, '');
    if (needsEdit) {
      const tmpl = `# This is a combination of commits.\n${message}\n\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n`;
      q.done.push(item);
      delete q.current;
      q.stop = 'reword';
      saveRepo(r);
      const edited = editFile(r, 'COMMIT_EDITMSG', tmpl, ['rebase', '--lab-amend-msg']);
      if (edited === null) return 0;
      message = cleanMessage(edited, 'strip');
      delete q.stop;
    } else {
      q.done.push(item);
      delete q.current;
    }
    const nid = newCommit(r, { message: message || prev.message, parents: prev.parents, tree: st.index, x: st.x ?? [], author: authorOf(r, prev.id) });
    moveHead(r, nid, `rebase (${item.action}): ${subject(message || prev.message)}`);
    if (!q.todo.some((t) => t.action === 'squash' || t.action === 'fixup')) delete q.squashMsg;
    return null;
  }
  delete q.squashMsg;
  if (q.kind === 'rebase' && !q.opts?.x && st.commits[id].parents[0] === head && (item.action === 'pick' || item.action === 'edit') && !q.force) {
    moveHead(r, id, `rebase (${item.action}): ${subject(st.commits[id].message)}`);
    q.done.push(item);
    delete q.current;
    if (item.action === 'edit') {
      q.stop = 'edit';
      saveRepo(r);
      io.err(`Stopped at ${short(id)}...  ${subject(st.commits[id].message)}
You can amend the commit now, with

  git commit --amend 

Once you are satisfied with your changes, run

  git rebase --continue
`);
      return 0;
    }
    return null;
  }
  let message = pickedMessage(r, q, id);
  if (q.kind === 'revert' && !q.opts?.x && q.interactive) {
    const edited = editFile(r, 'COMMIT_EDITMSG', `${message}\n`, ['revert', '--lab-msg']);
    if (edited === null) {
      saveRepo(r);
      return 0;
    }
    message = cleanMessage(edited, 'strip');
  }
  const nid = newCommit(r, { message, parents: [head], tree: st.index, x: st.x ?? [], author: q.kind === 'revert' ? undefined : authorOf(r, id) });
  const verb = q.kind === 'rebase' ? `rebase (${item.action === 'pick' ? 'pick' : item.action})` : q.kind;
  moveHead(r, nid, `${verb}: ${subject(message)}`);
  if (q.kind !== 'rebase') io.out(commitSummary(r, nid, treeOf(r, head), execOf(r, head), false));
  q.done.push(item);
  delete q.current;
  if (item.action === 'reword') {
    q.stop = 'reword';
    saveRepo(r);
    const edited = editFile(r, 'COMMIT_EDITMSG', `${message}\n\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n`, ['rebase', '--lab-amend-msg']);
    if (edited === null) return 0;
    amendMessage(r, cleanMessage(edited, 'strip'));
    delete q.stop;
  }
  if (item.action === 'edit') {
    q.stop = 'edit';
    saveRepo(r);
    io.err(`Stopped at ${short(id)}...  ${subject(message)}\nYou can amend the commit now, with\n\n  git commit --amend \n\nOnce you are satisfied with your changes, run\n\n  git rebase --continue\n`);
    return 0;
  }
  return null;
}

function amendMessage(r: Repo, message: string): void {
  const st = r.st;
  const head = headCommit(st)!;
  const c = st.commits[head];
  const nid = newCommit(r, { message, parents: c.parents, tree: c.tree, x: c.x ?? [], author: authorOf(r, head) });
  moveHead(r, nid, `rebase (reword): ${subject(message)}`);
}

function finishSequencer(r: Repo, io: IO): number {
  const st = r.st;
  const q = st.seq!;
  delete st.seq;
  if (q.kind === 'rebase') {
    const head = headCommit(st)!;
    if (q.branch) {
      setBranch(r, q.branch, head, `rebase (finish): refs/heads/${q.branch} onto ${q.onto}`);
      st.head = { branch: q.branch };
      logRef(r, 'HEAD', head, head, `rebase (finish): returning to refs/heads/${q.branch}`);
    }
    saveRepo(r);
    io.err(`Successfully rebased and updated ${q.branch ? `refs/heads/${q.branch}` : 'detached HEAD'}.\n`);
    return 0;
  }
  saveRepo(r);
  return 0;
}

function continueSequencer(r: Repo, io: IO, kind: Sequencer['kind']): number {
  const st = r.st;
  const q = st.seq;
  if (!q || q.kind !== kind) die(kind === 'rebase' ? 'fatal: No rebase in progress?' : `error: no ${kind} in progress\nfatal: ${kind} failed`);
  if (st.unmerged && Object.keys(st.unmerged).length) {
    io.err(`${Object.keys(st.unmerged).map((p) => `${p}: needs merge\n`).join('')}You must edit all merge conflicts and then\nmark them as resolved using git add\n`);
    return 1;
  }
  const item = q!.current;
  if (q!.stop === 'edit') {
    const c = changes(r);
    if (c.staged.length) die(`error: you have staged changes in your working tree\nIf these changes are meant to be squashed into the previous commit, run:\n\n  git commit --amend \n\nIf they are meant to go into a new commit, run:\n\n  git commit \n\nIn both cases, once you're done, continue with:\n\n  git rebase --continue\n`, 1);
    delete q!.stop;
    return runSequencer(r, io);
  }
  delete q!.stop;
  if (item) {
    const head = headCommit(st)!;
    const same = Object.keys({ ...treeOf(r, head), ...st.index }).every((p) => treeOf(r, head)[p] === st.index[p]);
    if (same && item.action !== 'squash' && item.action !== 'fixup') {
      if (q!.kind !== 'rebase') die(`The previous ${q!.kind} is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git ${q!.kind} --skip'`, 1);
      q!.done.push(item);
      delete q!.current;
    } else {
      rerereRecord(r, st.index);
      const r2 = finishItem(r, io, item);
      if (r2 !== null) return r2;
    }
  }
  return runSequencer(r, io);
}

function abortSequencer(r: Repo, _io: IO, kind: Sequencer['kind'], quit = false): number {
  const st = r.st;
  const q = st.seq;
  if (!q || q.kind !== kind) die(kind === 'rebase' ? 'fatal: No rebase in progress?' : `error: no ${kind} in progress\nfatal: ${kind} failed`);
  if (!quit) {
    const c = changes(r);
    const orig = q!.origHead;
    const ot = treeOf(r, orig);
    checkoutTree(r, { ...c.w.files, ...st.index }, ot, execOf(r, orig), []);
    writeWorking(r, {}, Object.keys(st.index).filter((p) => ot[p] === undefined));
    setIndexFromTree(r, ot, execOf(r, orig));
    const head = headCommit(st);
    if (q!.kind === 'rebase' && q!.branch) {
      st.branches[q!.branch] = orig;
      st.head = { branch: q!.branch };
      logRef(r, 'HEAD', head, orig, `rebase (abort): returning to refs/heads/${q!.branch}`);
    } else if (q!.kind === 'rebase') st.head = { detached: orig };
    else moveHead(r, orig, `${kind}: abort`);
  }
  delete st.seq;
  delete st.unmerged;
  delete st.rerereOpen;
  saveRepo(r);
  return 0;
}

function skipSequencer(r: Repo, io: IO, kind: Sequencer['kind']): number {
  const st = r.st;
  const q = st.seq;
  if (!q || q.kind !== kind) die(kind === 'rebase' ? 'fatal: No rebase in progress?' : `error: no ${kind} in progress`);
  const c = changes(r);
  checkoutTree(r, { ...c.w.files, ...st.index }, c.ht, c.hx, []);
  setIndexFromTree(r, c.ht, c.hx);
  delete st.unmerged;
  if (q!.current) q!.done.push(q!.current);
  delete q!.current;
  delete q!.stop;
  return runSequencer(r, io);
}

function startPicks(r: Repo, io: IO, kind: 'cherry-pick' | 'revert', specs: string[], o: Parsed): number {
  const st = r.st;
  if (st.seq) die(`error: ${st.seq.kind === 'rebase' ? 'a rebase' : `a ${st.seq.kind}`} is already in progress\nhint: try "git ${st.seq.kind} (--continue | --abort | --quit)"`);
  if (!specs.length) die(`usage: git ${kind} [<options>] <commit-ish>...`);
  const c = changes(r);
  if ((c.staged.length || c.unstaged.length) && !o.flags.has('no-commit')) die(`error: your local changes would be overwritten by ${kind}.\nhint: commit your changes or stash them to proceed.\nfatal: ${kind} failed`);
  let ids: string[] = [];
  for (const s of specs) {
    if (/\.\./.test(s)) ids.push(...orderCommits(st, selectCommits(r, [s])).reverse());
    else ids.push(mustRev(r, s, `bad revision '${s}'`));
  }
  if (kind === 'revert' && specs.every((s) => !/\.\./.test(s))) ids = ids.filter(Boolean);
  const mainline = val(o, 'mainline') ? Number(val(o, 'mainline')) : undefined;
  st.seq = { kind, todo: ids.map((id) => ({ action: 'pick', id, msg: subject(st.commits[id].message) })), done: [], origHead: headCommit(st)!, opts: { x: o.flags.has('x'), mainline, noCommit: o.flags.has('no-commit') }, interactive: kind === 'revert' && !o.flags.has('no-edit') && !o.flags.has('no-commit') };
  const code = runSequencer(r, io);
  if (o.flags.has('no-commit') && r.st.seq && !r.st.seq.todo.length && !r.st.unmerged) {
    delete r.st.seq;
    saveRepo(r);
  }
  return code;
}

function cmdPicks(kind: 'cherry-pick' | 'revert'): Cmd {
  return (args, io, ctx) => {
    const r = needRepo(ctx, io);
    needWorkTree(r);
    const o = gitOpts(args, ['mainline', 'strategy-option'], { m: 'mainline:', n: 'no-commit', e: 'edit', x: 'x', X: 'strategy-option:' });
    if (o.flags.has('continue')) return continueSequencer(r, io, kind);
    if (o.flags.has('abort')) return abortSequencer(r, io, kind);
    if (o.flags.has('quit')) return abortSequencer(r, io, kind, true);
    if (o.flags.has('skip')) return skipSequencer(r, io, kind);
    if (o.flags.has('lab-msg')) {
      // The revert message came back from the editor.
      const q = r.st.seq;
      if (!q) return 0;
      const head = headCommit(r.st)!;
      const message = cleanMessage(readFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, ROOT), 'strip');
      if (!message) {
        io.err('Aborting commit due to empty commit message.\n');
        return 1;
      }
      const item = q.current!;
      const nid = newCommit(r, { message, parents: [head], tree: r.st.index, x: r.st.x ?? [] });
      moveHead(r, nid, `${kind}: ${subject(message)}`);
      io.out(commitSummary(r, nid, treeOf(r, head), execOf(r, head), false));
      q.done.push(item);
      delete q.current;
      return runSequencer(r, io);
    }
    return startPicks(r, io, kind, o.pos, o);
  };
}

function cmdRebase(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['onto', 'exec', 'strategy-option'], { i: 'interactive', x: 'exec:', q: 'quiet', v: 'verbose', f: 'force-rebase', X: 'strategy-option:' });
  const st = r.st;
  if (o.flags.has('continue')) return continueSequencer(r, io, 'rebase');
  if (o.flags.has('abort')) return abortSequencer(r, io, 'rebase');
  if (o.flags.has('quit')) return abortSequencer(r, io, 'rebase', true);
  if (o.flags.has('skip')) return skipSequencer(r, io, 'rebase');
  if (o.flags.has('edit-todo')) {
    if (!st.seq) die('fatal: No rebase in progress?');
    const edited = editFile(r, 'rebase-merge/git-rebase-todo', st.seq!.todo.map((t) => todoLine(r, t)).join('\n') + '\n' + TODO_HELP, ['rebase', '--lab-todo-edited'], 'sequence');
    if (edited === null) {
      saveRepo(r);
      return 0;
    }
    st.seq!.todo = parseTodo(r, edited);
    saveRepo(r);
    return 0;
  }
  if (o.flags.has('lab-todo-edited')) {
    if (!st.seq) return 0;
    st.seq.todo = parseTodo(r, readFile(ctx.sys.fs, `${r.gitDir}/rebase-merge/git-rebase-todo`, ROOT));
    saveRepo(r);
    return 0;
  }
  if (o.flags.has('lab-todo-ready')) {
    if (!st.seq) return 0;
    const todo = parseTodo(r, readFile(ctx.sys.fs, `${r.gitDir}/rebase-merge/git-rebase-todo`, ROOT));
    if (!todo.length) {
      delete st.seq;
      saveRepo(r);
      io.out('Nothing to do\n');
      return 0;
    }
    return startRebase(r, io, todo);
  }
  if (o.flags.has('lab-amend-msg')) {
    const q = st.seq;
    if (!q) return 0;
    const message = cleanMessage(readFile(ctx.sys.fs, `${r.gitDir}/COMMIT_EDITMSG`, ROOT), 'strip');
    if (!message) die('Aborting commit due to empty commit message.', 1);
    const head = headCommit(st)!;
    const c = st.commits[head];
    const isSquash = !!q.squashMsg && q.stop === 'reword' && q.done[q.done.length - 1]?.action === 'squash';
    const nid = newCommit(r, { message, parents: c.parents, tree: isSquash ? st.index : c.tree, x: isSquash ? st.x ?? [] : c.x ?? [], author: authorOf(r, head) });
    moveHead(r, nid, `rebase (${isSquash ? 'squash' : 'reword'}): ${subject(message)}`);
    delete q.stop;
    delete q.squashMsg;
    return runSequencer(r, io);
  }
  if (st.seq) die(`fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)\nIf that is not the case, please\n\trm -fr ".git/rebase-merge"\nand run me again.  I am stopping in case you still have something\nvaluable there.`);
  const c = changes(r);
  if (c.staged.length || c.unstaged.length || st.unmerged) {
    if (o.flags.has('autostash') || truthy(configGet(ctx, st, 'rebase.autostash'))) die('error: --autostash is not simulated; run git stash first, then rebase, then git stash pop.', 1);
    die(`error: cannot rebase: You have ${c.staged.length ? 'unstaged and staged' : 'unstaged'} changes.\nerror: Please commit or stash them.`, 1);
  }
  const head = headCommit(st);
  if (!head) die('fatal: invalid upstream (nothing to rebase)');
  const root = o.flags.has('root');
  let upstreamName = o.pos[0];
  if (o.pos[1]) {
    // git rebase <upstream> <branch>: switch to <branch> first.
    doSwitch(r, io, o.pos[1], {}, 'checkout');
    Object.assign(r, openRepo(ctx, io, r.root));
  }
  const st2 = r.st;
  const head2 = headCommit(st2)!;
  if (!upstreamName && !root) {
    const u = st2.head.branch ? st2.upstream?.[st2.head.branch] : undefined;
    if (!u) die(`There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\nSee git-rebase(1) for details.\n\n    git rebase '<branch>'\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ${st2.head.branch ?? 'main'}\n`, 1);
    upstreamName = `${u!.remote}/${u!.merge}`;
  }
  const upstream = root ? null : mustRev(r, upstreamName, `invalid upstream '${upstreamName}'`);
  const onto = val(o, 'onto') ? mustRev(r, val(o, 'onto')!, `invalid onto '${val(o, 'onto')}'`) : upstream;
  const ontoName = val(o, 'onto') ?? upstreamName;
  const excluded = upstream ? ancestors(st2, upstream) : new Set<string>();
  let commits = orderCommits(st2, [...ancestors(st2, head2)].filter((id) => !excluded.has(id) && st2.commits[id].parents.length < 2), true).reverse();
  if (root) commits = orderCommits(st2, [...ancestors(st2, head2)].filter((id) => st2.commits[id].parents.length < 2), true).reverse();
  const interactive = o.flags.has('interactive');
  // Already based on onto and nothing to edit: nothing to do.
  if (!interactive && onto && ancestors(st2, head2).has(onto) && !o.flags.has('force-rebase') && !val(o, 'onto') && commits.every((id) => ancestors(st2, id).has(onto) || id === onto)) {
    io.out(`Current branch ${st2.head.branch ?? 'HEAD'} is up to date.\n`);
    return 0;
  }
  let todo: TodoItem[] = commits.map((id) => ({ action: 'pick', id, msg: subject(st2.commits[id].message) }));
  if (o.flags.has('autosquash') || (interactive && truthy(configGet(ctx, st2, 'rebase.autosquash')))) todo = autosquash(todo);
  const execs = o.vals.exec ?? [];
  if (execs.length) todo = todo.flatMap((t) => [t, ...execs.map((cmd) => ({ action: 'exec', cmd }))]);
  st2.seq = { kind: 'rebase', todo: [], done: [], branch: st2.head.branch, origHead: head2, onto: onto ?? undefined, ontoName, interactive, force: o.flags.has('force-rebase') || o.flags.has('no-ff') };
  st2.origHead = head2;
  if (interactive) {
    const text = `${todo.map((t) => todoLine(r, t)).join('\n')}\n\n# Rebase ${short(upstream ?? commits[0])}..${short(head2)} onto ${short(onto ?? commits[0])} (${plural(todo.length, 'command')})${TODO_HELP}`;
    saveRepo(r);
    const edited = editFile(r, 'rebase-merge/git-rebase-todo', text, ['rebase', '--lab-todo-ready'], 'sequence');
    if (edited === null) return 0;
    todo = parseTodo(r, edited);
    if (!todo.length) {
      delete st2.seq;
      saveRepo(r);
      io.out('Nothing to do\n');
      return 0;
    }
  }
  return startRebase(r, io, todo);
}

function autosquash(todo: TodoItem[]): TodoItem[] {
  const out = [...todo];
  for (const t of todo) {
    const m = /^(fixup|squash)! (.*)$/.exec(t.msg ?? '');
    if (!m) continue;
    const target = out.findIndex((x) => x !== t && (x.msg === m[2] || x.id?.startsWith(m[2])));
    if (target === -1) continue;
    out.splice(out.indexOf(t), 1);
    let at = target + 1;
    while (at < out.length && /^(fixup|squash)$/.test(out[at].action)) at++;
    out.splice(at, 0, { ...t, action: m[1] });
  }
  return out;
}

function startRebase(r: Repo, io: IO, todo: TodoItem[]): number {
  const st = r.st;
  const q = st.seq!;
  q.todo = todo;
  const head = headCommit(st)!;
  const onto = q.onto ?? null;
  // Detach at onto and replay.
  const target = onto ?? head;
  if (onto && onto !== head) {
    const c = changes(r);
    const tt = treeOf(r, onto);
    checkoutTree(r, c.ht, tt, execOf(r, onto), []);
    setIndexFromTree(r, tt, execOf(r, onto));
  }
  st.head = { detached: target };
  logRef(r, 'HEAD', head, target, `rebase (start): checkout ${q.ontoName ?? short(target)}`);
  if (!onto) {
    // --root: start from nothing.
    const first = todo.shift()!;
    const c = st.commits[first.id!];
    checkoutTree(r, treeOf(r, head), c.tree, c.x ?? [], []);
    setIndexFromTree(r, c.tree, c.x ?? []);
    const nid = newCommit(r, { message: c.message, parents: [], tree: c.tree, x: c.x ?? [], author: authorOf(r, c.id) });
    st.head = { detached: nid };
    logRef(r, 'HEAD', target, nid, `rebase (pick): ${subject(c.message)}`);
    q.done.push(first);
    q.onto = nid;
  }
  return runSequencer(r, io);
}

/* ----------------------------------------------------------------------------- stash */

function cmdStash(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const st = r.st;
  const sub = ['push', 'save', 'list', 'show', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store'].includes(args[0]) ? args[0] : args.length && !args[0].startsWith('-') ? args[0] : 'push';
  const rest = sub === args[0] ? args.slice(1) : args;
  st.stash ??= [];
  const which = (spec: string | undefined): number => {
    if (!spec) return 0;
    const m = /^(?:stash@\{)?(\d+)\}?$/.exec(spec);
    if (!m || Number(m[1]) >= st.stash!.length) die(`error: ${spec} is not a valid reference`, 1);
    return Number(m![1]);
  };
  const label = (n: number) => `stash@{${n}}`;
  switch (sub) {
    case 'push':
    case 'save': {
      const o = gitOpts(rest, ['message'], { m: 'message:', u: 'include-untracked', k: 'keep-index', a: 'all', q: 'quiet', p: 'patch', S: 'staged' });
      if (o.flags.has('patch')) die('error: git stash -p is not available in this simulator.', 1);
      const head = headCommit(st);
      if (!head) die('You do not have the initial commit yet', 1);
      const c = changes(r, o.flags.has('all'));
      const untrackedList = o.flags.has('include-untracked') ? c.untracked : o.flags.has('all') ? [...c.untracked, ...c.ignored] : [];
      const specs = o.paths ?? (sub === 'push' ? o.pos : []);
      const inSpec = (p: string) => !specs.length || specs.some((s) => matchSpec(r, s, [p]).length > 0);
      const touched = [...new Set([...c.staged, ...c.unstaged])].filter(inSpec);
      if (!touched.length && !untrackedList.filter(inSpec).length) {
        io.out('No local changes to save\n');
        return 0;
      }
      const message = (sub === 'save' ? o.pos.join(' ') : val(o, 'message')) || '';
      const branch = st.head.branch ?? '(no branch)';
      const work: Record<string, string> = { ...st.index };
      for (const p of touched) {
        if (c.w.files[p] === undefined) delete work[p];
        else work[p] = c.w.files[p];
      }
      const untracked: Record<string, string> = {};
      for (const p of untrackedList.filter(inSpec)) untracked[p] = c.w.files[p];
      const entry = { message: message ? `On ${branch}: ${message}` : `WIP on ${branch}: ${commitLine(r, head!)}`, branch, base: head!, index: { ...st.index }, work, untracked: Object.keys(untracked).length ? untracked : undefined, time: nextTime(r) };
      st.stash!.unshift(entry);
      // Put the stashed paths back to HEAD (the index too, unless --keep-index).
      const restore: Record<string, string> = {};
      const gone: string[] = [];
      for (const p of touched) {
        const target = o.flags.has('keep-index') ? st.index[p] : c.ht[p];
        if (target === undefined) gone.push(p);
        else restore[p] = target;
        if (!o.flags.has('keep-index')) {
          if (c.ht[p] === undefined) delete st.index[p];
          else st.index[p] = c.ht[p];
        }
      }
      writeWorking(r, restore, [...gone, ...Object.keys(untracked)], c.hx);
      logRef(r, 'refs/stash', null, stashId(st, 0), entry.message);
      saveRepo(r);
      if (!o.flags.has('quiet')) io.out(`Saved working directory and index state ${entry.message}\n`);
      return 0;
    }
    case 'list':
      st.stash.forEach((s, n) => io.out(`${label(n)}: ${s.message}\n`));
      return 0;
    case 'show': {
      const o = gitOpts(rest, [], { p: 'patch', u: 'include-untracked' });
      if (!st.stash.length) die('error: No stash entries found.', 1);
      const s = st.stash[which(o.pos[0])];
      const base = treeOf(r, s.base);
      printTreeDiff(io, base, execOf(r, s.base), { ...s.work, ...(o.flags.has('include-untracked') ? s.untracked ?? {} : {}) }, execOf(r, s.base), { stat: !o.flags.has('patch'), patch: o.flags.has('patch') });
      return 0;
    }
    case 'pop':
    case 'apply': {
      const o = gitOpts(rest, [], { q: 'quiet' });
      if (!st.stash.length) die('error: No stash entries found.', 1);
      const n = which(o.pos[0]);
      const s = st.stash[n];
      const c = changes(r);
      const baseT = treeOf(r, s.base);
      const dirty = [...new Set([...c.staged, ...c.unstaged])].filter((p) => s.work[p] !== baseT[p]);
      if (dirty.length) die(`error: Your local changes to the following files would be overwritten by merge:\n${dirty.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting\nThe stash entry is kept in case you need it again.`, 1);
      const clobber = Object.keys(s.untracked ?? {}).filter((p) => c.w.files[p] !== undefined);
      if (clobber.length) die(`${clobber.map((p) => `${p} already exists, no checkout\n`).join('')}error: could not restore untracked files from stash\nThe stash entry is kept in case you need it again.`, 1);
      const current: Record<string, string> = { ...st.index };
      const m = mergeTrees(r, baseT, current, s.work, { base: execOf(r, s.base), ours: st.x ?? [], theirs: execOf(r, s.base) }, { ours: 'Updated upstream', theirs: 'Stashed changes' });
      rerereOnConflict(r, m.conflicts, m.tree);
      const changed = Object.keys({ ...current, ...m.tree }).filter((p) => current[p] !== m.tree[p]);
      writeWorking(r, Object.fromEntries(changed.filter((p) => m.tree[p] !== undefined).map((p) => [p, m.tree[p]])), changed.filter((p) => m.tree[p] === undefined), st.x ?? []);
      if (s.untracked) writeWorking(r, s.untracked, []);
      // New files that were staged when stashed come back staged; other changes come back unstaged.
      for (const p of changed) {
        if (baseT[p] === undefined && s.index[p] !== undefined && m.tree[p] !== undefined) st.index[p] = m.tree[p];
        if (m.tree[p] === undefined && baseT[p] !== undefined && s.index[p] === undefined) delete st.index[p];
      }
      if (Object.keys(m.conflicts).length) {
        st.unmerged = { ...(st.unmerged ?? {}), ...m.conflicts };
        saveRepo(r);
        conflictReport(io, m, 'Updated upstream', 'Stashed changes');
        io.out('On branch ' + (st.head.branch ?? 'HEAD') + '\n');
        io.err('The stash entry is kept in case you need it again.\n');
        return 1;
      }
      if (sub === 'pop') st.stash.splice(n, 1);
      saveRepo(r);
      if (!o.flags.has('quiet')) {
        cmdStatus([], io, ctx);
        if (sub === 'pop') io.out(`Dropped refs/${label(n)} (${stashId({ ...st, stash: [s] } as GitState, 0)})\n`);
      }
      return 0;
    }
    case 'drop': {
      if (!st.stash.length) die('error: No stash entries found.', 1);
      const n = which(rest[0]);
      const id = stashId(st, n);
      st.stash.splice(n, 1);
      saveRepo(r);
      io.out(`Dropped ${label(n)} (${id})\n`);
      return 0;
    }
    case 'clear':
      st.stash = [];
      saveRepo(r);
      return 0;
    case 'branch': {
      const name = rest[0];
      if (!name) die('fatal: No branch name specified');
      if (!st.stash.length) die('error: No stash entries found.', 1);
      const n = which(rest[1]);
      const s = st.stash[n];
      doSwitch(r, io, name, { create: name, start: s.base }, 'checkout');
      Object.assign(r, openRepo(ctx, io, r.root));
      return cmdStash(['pop', label(n)], io, ctx);
    }
  }
  die(`error: unknown subcommand: \`${sub}'\nusage: git stash list\n   or: git stash show [<stash>]\n   or: git stash drop [<stash>]\n   or: git stash ( pop | apply ) [<stash>]\n   or: git stash branch <branchname> [<stash>]\n   or: git stash [push [-u] [-m <message>] [-- <pathspec>...]]\n   or: git stash clear`, 129);
  return 129;
}

/* ----------------------------------------------------------------------------- bisect */

function bisectNext(r: Repo, io: IO): number {
  const st = r.st;
  const b = st.bisect!;
  if (!b.bad || !b.good.length) {
    if (!b.bad && !b.good.length) io.out('status: waiting for both good and bad commits\n');
    else if (!b.bad) io.out(`status: waiting for bad commit, ${b.good.length} good commit known\n`);
    else io.out('status: waiting for good commit(s), bad commit known\n');
    saveRepo(r);
    return 0;
  }
  const goodAnc = new Set<string>();
  for (const g of b.good) for (const c of ancestors(st, g)) goodAnc.add(c);
  const cands = [...ancestors(st, b.bad)].filter((c) => !goodAnc.has(c));
  const testable = cands.filter((c) => !b.skip.includes(c));
  if (testable.length <= 1 || (cands.length === 1)) {
    const first = cands.length === 1 ? cands[0] : testable.find((c) => c === b.bad) ?? b.bad;
    if (cands.filter((c) => c !== first).every((c) => b.skip.includes(c)) || cands.length === 1) {
      const c = st.commits[first];
      io.out(`${first} is the first ${b.terms?.bad ?? 'bad'} commit\ncommit ${first}\nAuthor: ${c.author} <${c.email}>\nDate:   ${gitDate(c.time, undefined, r.ctx.sys.now)}\n\n${c.message.split('\n').map((l) => (l ? '    ' + l : '')).join('\n')}\n\n`);
      printTreeDiff(io, treeOf(r, c.parents[0]), execOf(r, c.parents[0]), c.tree, c.x ?? [], { stat: true });
      b.log.push(`# first bad commit: [${first}] ${subject(c.message)}`);
      saveRepo(r);
      return 0;
    }
  }
  // Pick the commit that splits the candidates most evenly.
  let best = testable[0];
  let bestScore = Infinity;
  for (const c of testable) {
    if (c === b.bad) continue;
    const below = [...ancestors(st, c)].filter((x) => cands.includes(x)).length;
    const score = Math.abs(cands.length - 2 * below);
    if (score < bestScore || (score === bestScore && st.commits[c].seq > st.commits[best].seq)) {
      best = c;
      bestScore = score;
    }
  }
  if (!best || best === b.bad) {
    io.out(`There are only 'skip'ped commits left to test.\nThe first bad commit could be any of:\n${cands.map((c) => c + '\n').join('')}We cannot bisect more!\n`);
    saveRepo(r);
    return 2;
  }
  const left = cands.length - 1;
  const steps = Math.max(0, Math.round(Math.log2(Math.max(1, left))));
  const c = changes(r);
  checkoutTree(r, c.ht, treeOf(r, best), execOf(r, best), []);
  setIndexFromTree(r, treeOf(r, best), execOf(r, best));
  const from = headCommit(st);
  st.head = { detached: best };
  logRef(r, 'HEAD', from, best, `checkout: moving from ${short(from ?? '')} to ${best}`);
  saveRepo(r);
  io.out(`Bisecting: ${Math.floor(left / 2)} revision${Math.floor(left / 2) === 1 ? '' : 's'} left to test after this (roughly ${steps} step${steps === 1 ? '' : 's'})\n[${best}] ${subject(st.commits[best].message)}\n`);
  return 0;
}

function cmdBisect(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const st = r.st;
  const [sub = 'help', ...rest] = args;
  const terms = st.bisect?.terms ?? { bad: 'bad', good: 'good' };
  const isBad = sub === 'bad' || sub === 'new' || sub === terms.bad;
  const isGood = sub === 'good' || sub === 'old' || sub === terms.good;
  if (sub === 'start') {
    const o = gitOpts(rest, ['term-new', 'term-bad', 'term-old', 'term-good'], {});
    if (isDirty(changes(r), st)) die('error: Your local changes to the following files would be overwritten by checkout.\nPlease commit your changes or stash them before you bisect.', 1);
    st.bisect = { good: [], skip: [], orig: headCommit(st)!, origBranch: st.head.branch, log: ['git bisect start'] };
    const tb = val(o, 'term-new') ?? val(o, 'term-bad');
    const tg = val(o, 'term-old') ?? val(o, 'term-good');
    if (tb || tg) st.bisect.terms = { bad: tb ?? 'bad', good: tg ?? 'good' };
    const [bad, ...goods] = o.pos;
    if (bad) {
      st.bisect.bad = mustRev(r, bad);
      st.bisect.log.push(`# bad: [${st.bisect.bad}] ${subject(st.commits[st.bisect.bad].message)}`, `git bisect bad ${st.bisect.bad}`);
    }
    for (const g of goods) {
      const id = mustRev(r, g);
      st.bisect.good.push(id);
      st.bisect.log.push(`# good: [${id}] ${subject(st.commits[id].message)}`, `git bisect good ${id}`);
    }
    return bisectNext(r, io);
  }
  if (!st.bisect && sub !== 'help') die(`You need to start by "git bisect start"\n`, 1);
  const b = st.bisect!;
  if (isBad || isGood || sub === 'skip') {
    const ids = rest.length ? rest.map((x) => mustRev(r, x)) : [headCommit(st)!];
    for (const id of ids) {
      if (isBad) b.bad = id;
      else if (isGood) b.good.push(id);
      else b.skip.push(id);
      const word = isBad ? terms.bad : isGood ? terms.good : 'skip';
      b.log.push(`# ${word}: [${id}] ${subject(st.commits[id].message)}`, `git bisect ${word} ${id}`);
    }
    return bisectNext(r, io);
  }
  switch (sub) {
    case 'reset': {
      const back = rest[0] ? mustRev(r, rest[0]) : b.orig;
      const c = changes(r);
      checkoutTree(r, c.ht, treeOf(r, back), execOf(r, back), []);
      setIndexFromTree(r, treeOf(r, back), execOf(r, back));
      const from = headCommit(st);
      if (!rest[0] && b.origBranch) st.head = { branch: b.origBranch };
      else st.head = { detached: back };
      delete st.bisect;
      logRef(r, 'HEAD', from, back, `checkout: moving from ${short(from ?? '')} to ${b.origBranch ?? short(back)}`);
      saveRepo(r);
      io.err(`Previous HEAD position was ${commitLine(r, from!)}\n${st.head.branch ? `Switched to branch '${st.head.branch}'` : `HEAD is now at ${commitLine(r, back)}`}\n`);
      return 0;
    }
    case 'log':
      io.out(b.log.join('\n') + '\n');
      return 0;
    case 'visualize':
    case 'view':
      return cmdLog(['--oneline', b.bad ?? 'HEAD', ...b.good.map((g) => '^' + g)], io, ctx);
    case 'terms':
      io.out(`Your current terms are ${terms.good} for the old state\nand ${terms.bad} for the new state.\n`);
      return 0;
    case 'run': {
      if (!rest.length) die('bisect run failed: no command provided.', 1);
      for (let guard = 0; guard < 64; guard++) {
        const cur = openRepo(ctx, io, r.root);
        if (!cur.st.bisect) return 0;
        const bb = cur.st.bisect;
        if (bb.log.some((l) => l.startsWith('# first bad commit'))) {
          io.out('bisect found first bad commit\n');
          return 0;
        }
        io.out(`running '${rest.join(' ')}'\n`);
        const cwd = ctx.sys.cwd;
        ctx.sys.cwd = cur.root;
        let code: number;
        try {
          code = runCommand(ctx, rest, { stdin: '', out: io.out, err: io.err });
        } finally {
          ctx.sys.cwd = cwd;
        }
        if (code >= 128 || code < 0) {
          io.err(`bisect run failed: exit code ${code} from '${rest.join(' ')}' is < 0 or >= 128\n`);
          return code;
        }
        const verdict = code === 0 ? terms.good : code === 125 ? 'skip' : terms.bad;
        const out = cmdBisect([verdict === terms.good ? 'good' : verdict === 'skip' ? 'skip' : 'bad'], io, ctx);
        if (out !== 0) return out;
      }
      return 1;
    }
  }
  io.out('usage: git bisect [help|start|bad|good|new|old|terms|skip|next|reset|visualize|view|replay|log|run]\n');
  return sub === 'help' ? 0 : 1;
}

/* ----------------------------------------------------------------------------- clean, rerere, sparse-checkout, archive */

function cmdClean(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const o = gitOpts(args, ['exclude'], { n: 'dry-run', f: 'force', d: 'd', x: 'x', X: 'X', q: 'quiet', e: 'exclude:', i: 'interactive' });
  if (o.flags.has('interactive')) die('error: git clean -i is not available in this simulator; use -n to preview and -f to delete.', 1);
  if (!o.flags.has('dry-run') && !o.flags.has('force') && configGet(ctx, r.st, 'clean.requireforce') !== 'false') die('fatal: clean.requireForce is true and -f not given: refusing to clean');
  const c = changes(r, true);
  let list = o.flags.has('X') ? c.ignored : o.flags.has('x') ? [...c.untracked, ...c.ignored] : c.untracked;
  const specs = [...o.pos, ...(o.paths ?? [])];
  if (specs.length) list = list.filter((p) => specs.some((s) => matchSpec(r, s, [p]).length));
  const ex = o.vals.exclude ?? [];
  list = list.filter((p) => !ex.some((e) => pathMatch(p, [e])));
  // Untracked directories are removed only with -d; without it their files stay.
  const shown = collapseUntracked(r, list, list);
  const targets = shown.filter((p) => !p.endsWith('/') || o.flags.has('d'));
  for (const p of targets) {
    io.out(`${o.flags.has('dry-run') ? 'Would remove' : 'Removing'} ${relDisplay(r, p)}\n`);
    if (o.flags.has('dry-run')) continue;
    try {
      remove(ctx.sys.fs, `${r.root === '/' ? '' : r.root}/${p.replace(/\/$/, '')}`, actor(ctx), true);
    } catch (e) {
      io.err(`warning: failed to remove ${p}: ${e instanceof FsError ? 'Permission denied' : String(e)}\n`);
    }
  }
  return 0;
}

function cmdRerere(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const st = r.st;
  const sub = args[0] ?? '';
  if (sub === 'status') {
    for (const p of Object.keys(st.rerereOpen ?? {})) io.out(p + '\n');
    return 0;
  }
  if (sub === 'clear') {
    delete st.rerereOpen;
    saveRepo(r);
    return 0;
  }
  if (sub === 'forget') {
    for (const p of args.slice(1)) {
      const key = st.rerereOpen?.[repoPath(r, p) ?? p];
      if (key && st.rerere?.[key] !== undefined) {
        delete st.rerere[key];
        io.out(`Updated preimage for '${p}'\nForgot resolution for '${p}'\n`);
      }
    }
    saveRepo(r);
    return 0;
  }
  if (sub === 'remaining') {
    for (const p of Object.keys(st.unmerged ?? {})) io.out(p + '\n');
    return 0;
  }
  if (sub === 'diff') {
    const w = workTree(r);
    for (const p of Object.keys(st.rerereOpen ?? {})) io.out(`--- a/${p}\n+++ b/${p}\n${hunks(st.index[p] ?? '', w.files[p] ?? '').join('\n')}\n`);
    return 0;
  }
  if (!truthy(configGet(ctx, st, 'rerere.enabled'))) return 0;
  rerereRecord(r, workTree(r).files);
  saveRepo(r);
  return 0;
}

function cmdSparse(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  needWorkTree(r);
  const st = r.st;
  const [sub, ...rest] = args;
  const dirs = rest.filter((a) => !a.startsWith('-')).map((d) => d.replace(/^\/|\/$/g, ''));
  const apply = () => {
    const ht = headTree(r);
    const w = workTree(r);
    const remove2 = Object.keys(ht).filter((p) => !inSparseList(st.sparse, p) && w.files[p] !== undefined);
    // Write files that come into the cone; drop files that leave it.
    const bring: Record<string, string> = {};
    for (const p of Object.keys(ht)) if (inSparseList(st.sparse, p)) bring[p] = st.index[p] ?? ht[p];
    const saved = st.sparse;
    delete st.sparse;
    writeWorking(r, bring, remove2, execOf(r, headCommit(st)));
    st.sparse = saved;
    saveRepo(r);
  };
  switch (sub) {
    case 'init':
      st.sparse = [];
      apply();
      return 0;
    case 'set':
      st.sparse = dirs;
      apply();
      return 0;
    case 'add':
      st.sparse = [...new Set([...(st.sparse ?? []), ...dirs])];
      apply();
      return 0;
    case 'list':
      if (!st.sparse) die('fatal: this worktree is not sparse');
      for (const d of st.sparse!) io.out(d + '\n');
      return 0;
    case 'disable':
      delete st.sparse;
      apply();
      return 0;
    case 'reapply':
      apply();
      return 0;
  }
  die('usage: git sparse-checkout (init | list | set | add | reapply | disable) [<options>]', 129);
  return 129;
}

function inSparseList(list: string[] | undefined, p: string): boolean {
  if (!list) return true;
  if (!p.includes('/')) return true;
  return list.some((d) => p === d || p.startsWith(d + '/'));
}

function cmdArchive(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['format', 'prefix', 'output'], { o: 'output:', l: 'list' });
  if (o.flags.has('list')) {
    io.out('tar\ntgz\ntar.gz\nzip\n');
    return 0;
  }
  const out = val(o, 'output');
  const fmt = val(o, 'format') ?? (out?.endsWith('.zip') ? 'zip' : out?.endsWith('.tar.gz') || out?.endsWith('.tgz') ? 'tar.gz' : 'tar');
  const id = mustRev(r, o.pos[0] ?? 'HEAD');
  const tree = treeOf(r, id);
  const prefix = val(o, 'prefix') ?? '';
  const paths = o.pos.slice(1);
  if (!out) die('error: this simulator writes archives to a file: use -o FILE (or --output=FILE).', 1);
  // Stage the snapshot in a scratch directory and let tar or zip build the archive.
  const stage = `/tmp/.git-archive-${ctx.sys.nextPid++}`;
  const a = actor(ctx);
  mkdir(ctx.sys.fs, stage, a, ctx.sys.now, true);
  for (const [p, content] of Object.entries(tree)) {
    if (paths.length && !pathMatch(p, paths)) continue;
    const full = `${stage}/${prefix}${p}`;
    mkdir(ctx.sys.fs, full.slice(0, full.lastIndexOf('/')), a, ctx.sys.now, true);
    writeFile(ctx.sys.fs, full, content, a, ctx.sys.now);
    if (execOf(r, id).includes(p)) {
      const l = lookup(ctx.sys.fs, full, ROOT);
      if (l) l.node.mode |= 0o111;
    }
  }
  const target = abs(ctx, out!);
  const top = prefix ? [prefix.split('/')[0]] : [...new Set(Object.keys(tree).filter((p) => !paths.length || pathMatch(p, paths)).map((p) => p.split('/')[0]))];
  const cmd = fmt === 'zip' ? ['zip', '-qr', target, ...top] : ['tar', fmt === 'tar' ? '-cf' : '-czf', target, '-C', stage, ...top];
  const cwd = ctx.sys.cwd;
  ctx.sys.cwd = stage;
  let code: number;
  try {
    code = runCommand(ctx, cmd, { stdin: '', out: () => {}, err: io.err });
  } finally {
    ctx.sys.cwd = cwd;
    remove(ctx.sys.fs, stage, ROOT, true);
  }
  return code;
}

/* ----------------------------------------------------------------------------- plumbing */

interface ObjectHit {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  text: string;
  size: number;
}

function findObject(r: Repo, spec: string): ObjectHit | null {
  const st = r.st;
  const enc = new TextEncoder();
  const treeListing = (tree: Record<string, string>, x: string[] | undefined, dir: string) => treeEntries(tree, x, dir).map((e) => `${e.mode} ${e.type} ${e.id}\t${e.name}`).join('\n');
  const colon = /^([^:]*):(.*)$/.exec(spec);
  if (colon) {
    const id = colon[1] ? mustRev(r, colon[1]) : null;
    const tree = id ? treeOf(r, id) : st.index;
    const x = id ? execOf(r, id) : st.x;
    const p = colon[2].replace(/\/$/, '');
    if (p === '') return { type: 'tree', text: treeListing(tree, x, ''), size: 0 };
    if (tree[p] !== undefined) return { type: 'blob', text: tree[p], size: enc.encode(tree[p]).length };
    if (Object.keys(tree).some((q) => q.startsWith(p + '/'))) return { type: 'tree', text: treeListing(tree, x, p), size: 0 };
    die(`fatal: path '${p}' does not exist in '${colon[1] || 'the index'}'`);
  }
  const treeSuffix = /^(.*)\^\{tree\}$/.exec(spec);
  if (treeSuffix) {
    const id = mustRev(r, treeSuffix[1]);
    return { type: 'tree', text: treeListing(treeOf(r, id), execOf(r, id), ''), size: 0 };
  }
  if (st.annotated?.[spec]) {
    const t = tagText(spec, st.tags[spec], st.annotated[spec]);
    return { type: 'tag', text: t, size: enc.encode(t).length };
  }
  const id = rev(r, spec);
  if (id && st.commits[id] && (!/^[0-9a-f]{4,40}$/.test(spec) || id.startsWith(spec))) {
    const t = commitText(st.commits[id]);
    return { type: 'commit', text: t, size: enc.encode(t).length };
  }
  if (/^[0-9a-f]{4,40}$/.test(spec)) {
    for (const [name, a] of Object.entries(st.annotated ?? {})) {
      if (tagId(name, st.tags[name], a).startsWith(spec)) {
        const t = tagText(name, st.tags[name], a);
        return { type: 'tag', text: t, size: enc.encode(t).length };
      }
    }
    for (const [oid, content] of Object.entries(st.objects ?? {})) if (oid.startsWith(spec)) return { type: 'blob', text: content, size: enc.encode(content).length };
    const trees = [st.index, ...Object.values(st.commits).map((c) => c.tree)];
    for (const t of trees) for (const content of Object.values(t)) if (blobId(content).startsWith(spec)) return { type: 'blob', text: content, size: enc.encode(content).length };
    for (const c of Object.values(st.commits)) {
      const dirs = new Set<string>(['']);
      for (const p of Object.keys(c.tree)) {
        const parts = p.split('/');
        for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/'));
      }
      for (const d of dirs) if (treeId(c.tree, c.x, d).startsWith(spec)) return { type: 'tree', text: treeListing(c.tree, c.x, d), size: 0 };
    }
  }
  return null;
}

function cmdCatFile(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { t: 't', s: 's', p: 'p', e: 'e' });
  const typeArg = ['commit', 'tree', 'blob', 'tag'].includes(o.pos[0]) ? o.pos[0] : null;
  const spec = typeArg ? o.pos[1] : o.pos[0];
  if (!spec) die('usage: git cat-file (-t | -s | -e | -p | <type>) <object>', 129);
  const hit = findObject(r, spec);
  if (o.flags.has('e')) return hit ? 0 : 1;
  if (!hit) die(`fatal: Not a valid object name ${spec}`);
  if (o.flags.has('t')) io.out(hit!.type + '\n');
  else if (o.flags.has('s')) io.out((hit!.size || new TextEncoder().encode(hit!.text).length) + '\n');
  else {
    if (typeArg && typeArg !== hit!.type) die(`fatal: git cat-file ${spec}: bad file`);
    io.out(hit!.text + (hit!.text.endsWith('\n') || !hit!.text ? '' : '\n'));
  }
  return 0;
}

function cmdLsTree(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['format'], { r: 'r', t: 't', d: 'd', l: 'long' });
  const spec = o.pos[0];
  if (!spec) die('usage: git ls-tree [<options>] <tree-ish> [<path>...]', 129);
  const id = mustRev(r, spec.replace(/\^\{tree\}$/, ''), `Not a valid object name ${spec}`);
  const tree = treeOf(r, id);
  const x = execOf(r, id);
  const filters = o.pos.slice(1).map((p) => repoPath(r, p) ?? p);
  const walk = (dir: string) => {
    for (const e of treeEntries(tree, x, dir)) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      const want = !filters.length || filters.some((f) => path === f || path.startsWith(f.replace(/\/$/, '') + '/') || f.startsWith(path + '/'));
      if (!want) continue;
      const showDir = e.type === 'tree' && (!o.flags.has('r') || o.flags.has('t') || o.flags.has('d'));
      if (e.type === 'blob' && o.flags.has('d')) continue;
      if (e.type === 'blob' || showDir) {
        if (o.flags.has('name-only') || o.flags.has('name-status')) io.out(path + '\n');
        else io.out(`${e.mode} ${e.type} ${e.id}${o.flags.has('long') ? ' ' + (e.type === 'blob' ? String(new TextEncoder().encode(tree[path]).length).padStart(7) : '      -') : ''}\t${path}\n`);
      }
      if (e.type === 'tree' && (o.flags.has('r') || filters.some((f) => f.startsWith(path + '/')))) walk(path);
    }
  };
  walk('');
  return 0;
}

function cmdLsFiles(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['exclude'], { s: 'stage', m: 'modified', d: 'deleted', o: 'others', i: 'ignored', u: 'unmerged', c: 'cached', t: 't', z: 'z' });
  const st = r.st;
  const prefix = repoPath(r, '.') ?? '';
  const under = (p: string) => !prefix || p.startsWith(prefix + '/');
  const specs = [...o.pos, ...(o.paths ?? [])];
  const sel = (p: string) => under(p) && (!specs.length || specs.some((s) => matchSpec(r, s, [p]).length));
  const out: string[] = [];
  const w = workTree(r);
  if (o.flags.has('others') || o.flags.has('ignored')) {
    const u = untrackedFiles(r, w, true);
    const list = o.flags.has('ignored') ? u.ignored : o.flags.has('exclude-standard') ? u.untracked : [...u.untracked, ...u.ignored];
    for (const p of list.sort()) if (sel(p)) out.push(relDisplay(r, p));
  } else if (o.flags.has('unmerged')) {
    for (const p of Object.keys(st.unmerged ?? {}).sort()) if (sel(p)) out.push(`100644 ${blobId(st.index[p] ?? '')} 2\t${relDisplay(r, p)}`);
  } else if (o.flags.has('modified') || o.flags.has('deleted')) {
    for (const p of Object.keys(st.index).sort()) {
      if (!sel(p)) continue;
      if (o.flags.has('deleted') && w.files[p] === undefined) out.push(relDisplay(r, p));
      else if (o.flags.has('modified') && w.files[p] !== st.index[p]) out.push(relDisplay(r, p));
    }
  } else {
    for (const p of Object.keys(st.index).sort()) {
      if (!sel(p)) continue;
      out.push(o.flags.has('stage') ? `${(st.x ?? []).includes(p) ? '100755' : '100644'} ${blobId(st.index[p])} 0\t${relDisplay(r, p)}` : relDisplay(r, p));
    }
    for (const p of Object.keys(st.unmerged ?? {})) if (st.index[p] === undefined && sel(p)) out.push(relDisplay(r, p));
  }
  if (o.flags.has('error-unmatch') && specs.length && !out.length) die(`error: pathspec '${specs[0]}' did not match any file(s) known to git\nDid you forget to 'git add'?`, 1);
  io.out(out.map((l) => l + (o.flags.has('z') ? '\0' : '\n')).join(''));
  return 0;
}

function cmdHashObject(args: string[], io: IO, ctx: Ctx): number {
  const o = gitOpts(args, ['type'], { w: 'w', t: 'type:' });
  const texts: string[] = [];
  if (o.flags.has('stdin')) texts.push(io.stdin);
  for (const f of [...o.pos, ...(o.paths ?? [])]) {
    try {
      texts.push(readFile(ctx.sys.fs, abs(ctx, f), actor(ctx)));
    } catch {
      die(`fatal: could not open '${f}' for reading: No such file or directory`);
    }
  }
  const repoDir = findRepo(ctx);
  const r = repoDir ? openRepo(ctx, io, repoDir) : null;
  for (const t of texts) {
    const id = blobId(t);
    io.out(id + '\n');
    if (o.flags.has('w')) {
      if (!r) die('fatal: not a git repository (or any of the parent directories): .git');
      (r!.st.objects ??= {})[id] = t;
    }
  }
  if (o.flags.has('w') && r) saveRepo(r);
  return 0;
}

function cmdRevParse(args: string[], io: IO, ctx: Ctx): number {
  const o = gitOpts(args, ['short', 'abbrev-ref', 'git-path', 'default'], { q: 'quiet' });
  if (o.flags.has('is-inside-work-tree') || o.flags.has('is-inside-git-dir') || o.flags.has('is-bare-repository') || o.flags.has('show-toplevel') || o.flags.has('git-dir') || o.flags.has('absolute-git-dir') || o.flags.has('show-prefix') || o.flags.has('is-shallow-repository') || o.flags.has('show-cdup')) {
    const path = findRepo(ctx);
    if (!path) die('fatal: not a git repository (or any of the parent directories): .git');
    const r = openRepo(ctx, io, path!);
    if (o.flags.has('is-inside-work-tree')) io.out(r.bare ? 'false\n' : 'true\n');
    if (o.flags.has('is-inside-git-dir')) io.out(r.bare || ctx.sys.cwd.startsWith(r.gitDir) ? 'true\n' : 'false\n');
    if (o.flags.has('is-bare-repository')) io.out(r.bare ? 'true\n' : 'false\n');
    if (o.flags.has('is-shallow-repository')) io.out(r.st.shallow?.length ? 'true\n' : 'false\n');
    if (o.flags.has('show-toplevel')) {
      if (r.bare) die('fatal: this operation must be run in a work tree');
      io.out(r.root + '\n');
    }
    if (o.flags.has('git-dir')) io.out((ctx.sys.cwd === r.root && !r.bare ? '.git' : r.gitDir) + '\n');
    if (o.flags.has('absolute-git-dir')) io.out(r.gitDir + '\n');
    if (o.flags.has('show-prefix')) io.out((repoPath(r, '.') ? repoPath(r, '.') + '/' : '') + '\n');
    if (o.flags.has('show-cdup')) io.out((repoPath(r, '.') ? '../'.repeat(repoPath(r, '.')!.split('/').length) : '') + '\n');
    return 0;
  }
  const r = needRepo(ctx, io);
  const specs = [...o.pos];
  if (o.vals['abbrev-ref']) specs.push(...o.vals['abbrev-ref']);
  if (o.vals.short) specs.push(...o.vals.short.filter((s) => !/^\d+$/.test(s)));
  if (!specs.length) specs.push(o.vals.default?.[0] ?? (o.flags.has('abbrev-ref') || o.flags.has('short') || o.flags.has('verify') || o.flags.has('symbolic-full-name') ? 'HEAD' : ''));
  for (const spec of specs.filter(Boolean)) {
    if (o.flags.has('abbrev-ref') || o.vals['abbrev-ref']) {
      if (spec === 'HEAD' || spec === '@') {
        io.out((r.st.head.branch ?? 'HEAD') + '\n');
        continue;
      }
      const up = /^(.*)@\{(u|upstream|push)\}$/.exec(spec);
      if (up) {
        const b = up[1] || r.st.head.branch!;
        const u = r.st.upstream?.[b];
        if (!u) die(`fatal: no upstream configured for branch '${b}'`);
        io.out(`${u!.remote}/${u!.merge}\n`);
        continue;
      }
      if (r.st.branches[spec] !== undefined || r.st.tags[spec] || r.st.remoteRefs?.[spec]) {
        io.out(spec + '\n');
        continue;
      }
    }
    if (o.flags.has('symbolic-full-name')) {
      if (spec === 'HEAD') io.out(r.st.head.branch ? `refs/heads/${r.st.head.branch}\n` : 'HEAD\n');
      else if (r.st.branches[spec] !== undefined) io.out(`refs/heads/${spec}\n`);
      else if (r.st.tags[spec]) io.out(`refs/tags/${spec}\n`);
      else if (r.st.remoteRefs?.[spec]) io.out(`refs/remotes/${spec}\n`);
      continue;
    }
    if (/\.\.\.?/.test(spec)) {
      const [a, b] = spec.split(/\.\.\.?/);
      io.out(`${mustRev(r, b || 'HEAD')}\n^${mustRev(r, a || 'HEAD')}\n`);
      continue;
    }
    if (/:/.test(spec) || /\^\{tree\}$/.test(spec)) {
      const hit = findObject(r, spec);
      if (!hit) die(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
      const colon = /^([^:]*):(.+)$/.exec(spec);
      const id = colon ? (colon[1] ? treeOf(r, mustRev(r, colon[1])) : r.st.index)[colon[2]] : undefined;
      const oid = hit!.type === 'blob' && id !== undefined ? blobId(id) : hit!.type === 'tree' ? (() => {
        const base = colon ? (colon[1] ? mustRev(r, colon[1]) : null) : mustRev(r, spec.replace(/\^\{tree\}$/, ''));
        const tree = base ? treeOf(r, base) : r.st.index;
        return treeId(tree, base ? execOf(r, base) : r.st.x, colon ? colon[2].replace(/\/$/, '') : '');
      })() : '';
      io.out(oid + '\n');
      continue;
    }
    const id = rev(r, spec);
    if (!id) {
      if (o.flags.has('quiet') && o.flags.has('verify')) return 1;
      if (o.flags.has('verify')) die('fatal: Needed a single revision');
      die(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
    const n = o.vals.short?.find((s) => /^\d+$/.test(s));
    io.out((o.flags.has('short') || o.vals.short ? id!.slice(0, n ? Number(n) : 7) : id) + '\n');
  }
  return 0;
}

function cmdRevList(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['max-count', 'since', 'until', 'skip'], { n: 'max-count:' });
  const st = r.st;
  if (o.flags.has('left-right') && o.flags.has('count')) {
    const sym = /^(.*)\.\.\.(.*)$/.exec(o.pos[0] ?? '');
    if (!sym) die('fatal: --left-right needs A...B');
    const a = mustRev(r, sym![1] || 'HEAD');
    const b = mustRev(r, sym![2] || 'HEAD');
    const ab = aheadBehind(r, a, b);
    io.out(`${ab.ahead}\t${ab.behind}\n`);
    return 0;
  }
  let ids = selectCommits(r, o.pos, o.flags.has('all'));
  if (o.flags.has('first-parent')) {
    const tips = o.pos.length ? o.pos.filter((p) => !p.startsWith('^')).map((p) => mustRev(r, p.replace(/^.*\.\./, '') || 'HEAD')) : [headCommit(st)!];
    const fp = new Set<string>();
    for (const t of tips) for (const c of ancestors(st, t, true)) fp.add(c);
    ids = ids.filter((c) => fp.has(c));
  }
  if (o.flags.has('merges')) ids = ids.filter((c) => st.commits[c].parents.length > 1);
  if (o.flags.has('no-merges')) ids = ids.filter((c) => st.commits[c].parents.length < 2);
  const since = parseGitDate(val(o, 'since'), ctx.sys.now);
  const until = parseGitDate(val(o, 'until'), ctx.sys.now);
  ids = ids.filter((c) => (since === null || (st.commits[c].ctime ?? st.commits[c].time) >= since) && (until === null || (st.commits[c].ctime ?? st.commits[c].time) <= until));
  let ordered = orderCommits(st, ids, o.flags.has('topo-order'));
  ordered = ordered.slice(Number(val(o, 'skip') ?? 0), val(o, 'max-count') ? Number(val(o, 'skip') ?? 0) + Number(val(o, 'max-count')) : undefined);
  if (o.flags.has('reverse')) ordered.reverse();
  if (o.flags.has('count')) io.out(ordered.length + '\n');
  else for (const id of ordered) io.out(id + '\n');
  return 0;
}

function cmdMergeBase(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { a: 'all' });
  if (o.flags.has('is-ancestor')) {
    const [a, b] = o.pos.map((p) => mustRev(r, p));
    return ancestors(r.st, b).has(a) ? 0 : 1;
  }
  if (o.pos.length < 2) die('usage: git merge-base [-a | --all] <commit> <commit>...', 129);
  const [a, b] = o.pos.map((p) => mustRev(r, p));
  const bases = mergeBases(r.st, a, b);
  if (!bases.length) return 1;
  for (const id of o.flags.has('all') ? bases : bases.slice(0, 1)) io.out(id + '\n');
  return 0;
}

function cmdCheckIgnore(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { v: 'verbose', n: 'non-matching', q: 'quiet' });
  const w = workTree(r);
  const paths = [...o.pos, ...(o.paths ?? [])];
  if (o.flags.has('stdin')) paths.push(...io.stdin.split('\n').filter(Boolean));
  if (!paths.length) die('fatal: no path specified');
  const rels = paths.map((p) => repoPath(r, p) ?? p);
  const res = ignoreCheck(r, w.files, rels);
  let any = false;
  rels.forEach((p, k) => {
    const rule = r.st.index[p] !== undefined && !o.flags.has('no-index') ? null : res.get(p) ?? null;
    if (rule) any = true;
    if (o.flags.has('quiet')) return;
    if (o.flags.has('verbose')) {
      if (rule) io.out(`${rule.src}:${rule.line}:${rule.text}\t${paths[k]}\n`);
      else if (o.flags.has('non-matching')) io.out(`::\t${paths[k]}\n`);
    } else if (rule) io.out(paths[k] + '\n');
  });
  return any ? 0 : 1;
}

function reachableObjects(r: Repo, includeReflogs = true): { commits: Set<string>; blobs: Map<string, number>; trees: number } {
  const st = r.st;
  const tips: string[] = [...Object.values(st.branches).filter((x): x is string => !!x), ...Object.values(st.tags), ...Object.values(st.remoteRefs ?? {})];
  const h = headCommit(st);
  if (h) tips.push(h);
  if (includeReflogs) for (const log of Object.values(st.reflogs ?? {})) for (const e of log) if (st.commits[e.to]) tips.push(e.to);
  for (const s of st.stash ?? []) tips.push(s.base);
  const commits = new Set<string>();
  for (const t of tips) for (const c of ancestors(st, t)) commits.add(c);
  const blobs = new Map<string, number>();
  const treeIds = new Set<string>();
  const enc = new TextEncoder();
  for (const id of commits) {
    const c = st.commits[id];
    for (const content of Object.values(c.tree)) if (!content.startsWith('\u0000promised:')) blobs.set(blobId(content), enc.encode(content).length);
    treeIds.add(treeId(c.tree, c.x));
    for (const d of new Set(Object.keys(c.tree).filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))))) treeIds.add(`${id}:${d}`);
  }
  return { commits, blobs, trees: treeIds.size };
}

function cmdCountObjects(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { v: 'verbose', H: 'human-readable' });
  const obj = reachableObjects(r);
  const count = obj.commits.size + obj.blobs.size + obj.trees + Object.keys(r.st.annotated ?? {}).length;
  const bytes = [...obj.blobs.values()].reduce((s, n) => s + n, 0) + obj.commits.size * 220 + obj.trees * 90;
  const kib = Math.ceil(bytes / 1024);
  const hsize = (k: number) => (k >= 1024 ? `${(k / 1024).toFixed(2)} MiB` : `${k}.00 KiB`);
  if (o.flags.has('verbose')) io.out(`count: ${count}\nsize: ${o.flags.has('human-readable') ? hsize(kib) : kib}\nin-pack: 0\npacks: 0\nsize-pack: 0${o.flags.has('human-readable') ? ' bytes' : ''}\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0${o.flags.has('human-readable') ? ' bytes' : ''}\n`);
  else io.out(`${count} objects, ${kib} kilobytes\n`);
  return 0;
}

function cmdShowRef(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { s: 'hash', q: 'quiet' });
  const st = r.st;
  const rows: Array<[string, string]> = [];
  if (!o.flags.has('tags')) for (const b of Object.keys(st.branches).sort()) if (st.branches[b]) rows.push([st.branches[b]!, `refs/heads/${b}`]);
  if (!o.flags.has('heads') && !o.flags.has('tags')) for (const rb of Object.keys(st.remoteRefs ?? {}).sort()) if (!rb.endsWith('/HEAD')) rows.push([st.remoteRefs![rb], `refs/remotes/${rb}`]);
  if (!o.flags.has('heads')) for (const t of Object.keys(st.tags).sort()) rows.push([st.annotated?.[t] ? tagId(t, st.tags[t], st.annotated[t]) : st.tags[t], `refs/tags/${t}`]);
  let list = rows;
  if (o.pos.length) list = rows.filter(([, ref]) => o.pos.some((p) => (o.flags.has('verify') ? ref === p : ref === p || ref.endsWith('/' + p))));
  if (o.flags.has('verify') && !list.length) die(`fatal: '${o.pos[0]}' - not a valid ref`);
  if (!o.flags.has('quiet')) for (const [id, ref] of list) io.out(o.flags.has('hash') ? id + '\n' : `${id} ${ref}\n`);
  return list.length ? 0 : 1;
}

function cmdForEachRef(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['format', 'sort', 'count', 'points-at', 'contains', 'merged'], {});
  const st = r.st;
  type Row = { ref: string; id: string; kind: 'heads' | 'tags' | 'remotes' };
  let rows: Row[] = [
    ...Object.entries(st.branches).filter(([, id]) => id).map(([b, id]) => ({ ref: `refs/heads/${b}`, id: id!, kind: 'heads' as const })),
    ...Object.entries(st.remoteRefs ?? {}).map(([b, id]) => ({ ref: `refs/remotes/${b}`, id, kind: 'remotes' as const })),
    ...Object.entries(st.tags).map(([t, id]) => ({ ref: `refs/tags/${t}`, id, kind: 'tags' as const })),
  ];
  if (o.pos.length) rows = rows.filter((x) => o.pos.some((p) => x.ref === p || x.ref.startsWith(p.replace(/\/$/, '') + '/') || pathMatch(x.ref, [p])));
  if (val(o, 'points-at')) rows = rows.filter((x) => x.id === mustRev(r, val(o, 'points-at')!));
  if (val(o, 'merged')) {
    const m = ancestors(st, mustRev(r, val(o, 'merged')!));
    rows = rows.filter((x) => m.has(x.id));
  }
  if (val(o, 'contains')) {
    const c = mustRev(r, val(o, 'contains')!);
    rows = rows.filter((x) => ancestors(st, x.id).has(c));
  }
  const shortName = (x: Row) => x.ref.replace(/^refs\/(heads|tags|remotes)\//, '');
  for (const s of (o.vals.sort ?? ['refname']).reverse()) {
    const desc = s.startsWith('-');
    const key = s.replace(/^-/, '');
    rows.sort((a, b) => {
      const ca = st.commits[a.id];
      const cb = st.commits[b.id];
      const v = key === 'committerdate' || key === 'creatordate' || key === 'authordate' ? (ca.ctime ?? ca.time) - (cb.ctime ?? cb.time) : key.startsWith('version:') || key.startsWith('v:') ? compareVersions(shortName(a), shortName(b)) : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
      return desc ? -v : v;
    });
  }
  if (val(o, 'count')) rows = rows.slice(0, Number(val(o, 'count')));
  const fmt = val(o, 'format') ?? '%(objectname) %(objecttype)\t%(refname)';
  for (const x of rows) {
    const c = st.commits[x.id];
    const u = x.kind === 'heads' ? st.upstream?.[shortName(x)] : undefined;
    const line = fmt.replace(/%\(([^)]+)\)/g, (_, f: string) => {
      const [name, mod] = f.split(':');
      switch (name) {
        case 'refname':
          return mod === 'short' ? shortName(x) : mod === 'lstrip=2' ? shortName(x) : x.ref;
        case 'objectname':
          return mod === 'short' ? short(x.id) : x.id;
        case 'objecttype':
          return x.kind === 'tags' && st.annotated?.[shortName(x)] ? 'tag' : 'commit';
        case 'subject':
        case 'contents:subject':
          return subject(c.message);
        case 'authorname':
          return c.author;
        case 'authoremail':
          return `<${c.email}>`;
        case 'authordate':
        case 'committerdate':
        case 'creatordate':
          return gitDate(name === 'authordate' ? c.time : c.ctime ?? c.time, mod === 'relative' ? 'relative' : mod === 'short' ? 'short' : mod === 'iso' || mod === 'iso8601' ? 'iso' : mod === 'unix' ? 'unix' : undefined, ctx.sys.now);
        case 'HEAD':
          return x.kind === 'heads' && shortName(x) === st.head.branch ? '*' : ' ';
        case 'upstream': {
          if (!u) return '';
          if (mod === 'short') return `${u.remote}/${u.merge}`;
          if (mod === 'track' || mod === 'trackshort') {
            const rid = st.remoteRefs?.[`${u.remote}/${u.merge}`];
            if (!rid) return mod === 'track' ? '[gone]' : '';
            const ab = aheadBehind(r, x.id, rid);
            if (mod === 'trackshort') return ab.ahead && ab.behind ? '<>' : ab.ahead ? '>' : ab.behind ? '<' : '=';
            return ab.ahead || ab.behind ? `[${[ab.ahead ? `ahead ${ab.ahead}` : '', ab.behind ? `behind ${ab.behind}` : ''].filter(Boolean).join(', ')}]` : '';
          }
          return `refs/remotes/${u.remote}/${u.merge}`;
        }
      }
      return '';
    });
    io.out(line + '\n');
  }
  return 0;
}

function cmdSymbolicRef(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], { q: 'quiet' });
  if (o.pos[0] !== 'HEAD') die(`fatal: this simulator only reads the symbolic ref HEAD`);
  if (o.pos[1]) {
    const b = o.pos[1].replace(/^refs\/heads\//, '');
    r.st.head = { branch: b };
    if (r.st.branches[b] === undefined) r.st.branches[b] = null;
    saveRepo(r);
    return 0;
  }
  if (r.st.head.branch === undefined) {
    if (o.flags.has('quiet')) return 1;
    die('fatal: ref HEAD is not a symbolic ref');
  }
  io.out((o.flags.has('short') ? r.st.head.branch : `refs/heads/${r.st.head.branch}`) + '\n');
  return 0;
}

function cmdFsck(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, [], {});
  const st = r.st;
  const reach = reachableObjects(r, !o.flags.has('no-reflogs')).commits;
  const unreachable = Object.keys(st.commits).filter((c) => !reach.has(c));
  const parentsOfUnreachable = new Set(unreachable.flatMap((c) => st.commits[c].parents));
  const dangling = unreachable.filter((c) => !parentsOfUnreachable.has(c));
  io.err('Checking object directories: 100% (256/256), done.\n');
  const list = o.flags.has('unreachable') ? unreachable : dangling;
  for (const c of orderCommits(st, list)) io.out(`${o.flags.has('unreachable') ? 'unreachable' : 'dangling'} commit ${c}\n`);
  if (o.flags.has('lost-found')) {
    for (const c of dangling) {
      const p = `${r.gitDir}/lost-found/commit/${c}`;
      mkdir(ctx.sys.fs, p.slice(0, p.lastIndexOf('/')), actor(ctx), ctx.sys.now, true);
      writeFile(ctx.sys.fs, p, c + '\n', actor(ctx), ctx.sys.now);
    }
  }
  return 0;
}

function cmdGc(args: string[], io: IO, ctx: Ctx): number {
  const r = needRepo(ctx, io);
  const o = gitOpts(args, ['prune'], { q: 'quiet' });
  const st = r.st;
  const reach = reachableObjects(r).commits;
  const prune = val(o, 'prune');
  if (prune === 'now' || prune === 'all') for (const c of Object.keys(st.commits)) if (!reach.has(c)) delete st.commits[c];
  const n = reachableObjects(r).commits.size;
  saveRepo(r);
  if (!o.flags.has('quiet')) io.err(`Enumerating objects: ${n * 3}, done.\nCounting objects: 100% (${n * 3}/${n * 3}), done.\nWriting objects: 100% (${n * 3}/${n * 3}), done.\nTotal ${n * 3} (delta 0), reused 0 (delta 0), pack-reused 0\n`);
  return 0;
}

function cmdNotes(): number {
  return die('error: git notes is not simulated; put the information in the commit message or a tag annotation.', 1);
}

/* ----------------------------------------------------------------------------- help and dispatch */

const USAGE = `usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]
           <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one

work on the current change
   add       Add file contents to the index
   mv        Move or rename a file, a directory, or a symlink
   restore   Restore working tree files
   rm        Remove files from the working tree and from the index

examine the history and state
   bisect    Use binary search to find the commit that introduced a bug
   diff      Show changes between commits, commit and working tree, etc
   grep      Print lines matching a pattern
   log       Show commit logs
   show      Show various types of objects
   status    Show the working tree status

grow, mark and tweak your common history
   branch    List, create, or delete branches
   commit    Record changes to the repository
   merge     Join two or more development histories together
   rebase    Reapply commits on top of another base tip
   reset     Reset current HEAD to the specified state
   switch    Switch branches
   tag       Create, list, delete or verify a tag object signed with GPG

collaborate
   fetch     Download objects and refs from another repository
   pull      Fetch from and integrate with another repository or a local branch
   push      Update remote refs along with associated objects
`;

const SUBCOMMANDS: Record<string, Cmd> = {
  init: cmdInit,
  config: cmdConfig,
  status: cmdStatus,
  add: cmdAdd,
  rm: cmdRm,
  mv: cmdMv,
  commit: cmdCommit,
  log: (a, io, ctx) => cmdLog(a, io, ctx),
  whatchanged: (a, io, ctx) => cmdLog(a, io, ctx, ['--name-status']),
  show: cmdShow,
  reflog: cmdReflog,
  shortlog: cmdShortlog,
  diff: cmdDiff,
  blame: cmdBlame,
  annotate: cmdBlame,
  grep: cmdGrep,
  branch: cmdBranch,
  tag: cmdTag,
  describe: cmdDescribe,
  switch: cmdSwitch,
  checkout: cmdCheckout,
  restore: cmdRestore,
  reset: cmdReset,
  merge: cmdMerge,
  'cherry-pick': cmdPicks('cherry-pick'),
  revert: cmdPicks('revert'),
  rebase: cmdRebase,
  stash: cmdStash,
  bisect: cmdBisect,
  clean: cmdClean,
  rerere: cmdRerere,
  'sparse-checkout': cmdSparse,
  archive: cmdArchive,
  'cat-file': cmdCatFile,
  'ls-tree': cmdLsTree,
  'ls-files': cmdLsFiles,
  'hash-object': cmdHashObject,
  'rev-parse': cmdRevParse,
  'rev-list': cmdRevList,
  'merge-base': cmdMergeBase,
  'check-ignore': cmdCheckIgnore,
  'count-objects': cmdCountObjects,
  'show-ref': cmdShowRef,
  'for-each-ref': cmdForEachRef,
  'symbolic-ref': cmdSymbolicRef,
  fsck: cmdFsck,
  gc: cmdGc,
  prune: (a, io, ctx) => cmdGc(['--prune=now', '--quiet', ...a], io, ctx),
  notes: cmdNotes,
};

const git: Cmd = (args, io, ctx) => {
  let i = 0;
  const cwd = ctx.sys.cwd;
  const params: string[] = [];
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      const dir = abs(ctx, args[++i] ?? '.');
      const l = lookup(ctx.sys.fs, dir, actor(ctx));
      if (!l || l.node.type !== 'dir') {
        io.err(`fatal: cannot change to '${args[i]}': No such file or directory\n`);
        return 128;
      }
      ctx.sys.cwd = dir;
    } else if (a === '-c') params.push(args[++i] ?? '');
    else if (a === '--version' || a === '-v') {
      io.out('git version 2.45.2\n');
      return 0;
    } else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else if (a === '--no-pager' || a === '-P' || a === '--paginate' || a === '-p' || a === '--no-replace-objects' || a.startsWith('--exec-path') || a === '--literal-pathspecs' || a === '--no-optional-locks') {
      /* accepted, no effect here */
    } else {
      io.err(`unknown option: ${a}\n${USAGE}`);
      return 129;
    }
    i++;
  }
  const [sub, ...rest] = args.slice(i);
  const savedParams = ctx.vars.GIT_CONFIG_PARAMETERS;
  const wasExported = ctx.exported.has('GIT_CONFIG_PARAMETERS');
  if (params.length) {
    ctx.vars.GIT_CONFIG_PARAMETERS = [...(savedParams ? [savedParams] : []), ...params].join('\u0001');
    ctx.exported.add('GIT_CONFIG_PARAMETERS');
  }
  try {
    if (!sub) {
      io.out(USAGE);
      return 1;
    }
    if (sub === 'version') {
      io.out('git version 2.45.2\n');
      return 0;
    }
    if (sub === 'help' || rest.includes('--help')) {
      const what = sub === 'help' ? rest[0] : sub;
      if (!what) io.out(USAGE);
      else io.out(`GIT-${what.toUpperCase()}(1)\n\nNAME\n       git-${what}\n\nThe simulator follows real git; try "man git" for the commands and options it supports,\nor run "git ${what} -h" for a short usage line.\n`);
      return 0;
    }
    const handler = SUBCOMMANDS[sub] ?? REMOTE_COMMANDS[sub];
    if (handler) return handler(rest, io, ctx);
    // Aliases: alias.co = checkout, or alias.x = "!shell command".
    const repoDir = findRepo(ctx);
    const alias = configGet(ctx, repoDir ? openRepo(ctx, io, repoDir).st : null, `alias.${sub}`);
    if (alias) {
      if (alias.startsWith('!')) return runCommand(ctx, ['bash', '-c', `${alias.slice(1)} "$@"`, sub, ...rest], io);
      const words = alias.match(/"[^"]*"|'[^']*'|\S+/g)!.map((w) => w.replace(/^["']|["']$/g, ''));
      return git([...words, ...rest], io, ctx);
    }
    const near = Object.keys({ ...SUBCOMMANDS, ...REMOTE_COMMANDS }).filter((c) => c.startsWith(sub.slice(0, 2)));
    io.err(`git: '${sub}' is not a git command. See 'git --help'.${near.length ? `\n\nThe most similar command${near.length > 1 ? 's are' : ' is'}\n${near.slice(0, 3).map((n) => `\t${n}\n`).join('')}` : '\n'}`);
    return 1;
  } catch (e) {
    if (e instanceof GitExit) {
      if (e.text) io.err(e.text.endsWith('\n') ? e.text : e.text + '\n');
      return e.code;
    }
    if (e instanceof FsError) {
      io.err(`fatal: ${e.message.includes('Permission') ? `Unable to create '${findRepo(ctx) ?? ctx.sys.cwd}/.git/index.lock': Permission denied` : e.message}\n`);
      return 128;
    }
    throw e;
  } finally {
    ctx.sys.cwd = cwd === ctx.sys.cwd ? ctx.sys.cwd : cwd;
    if (params.length) {
      if (savedParams === undefined) delete ctx.vars.GIT_CONFIG_PARAMETERS;
      else ctx.vars.GIT_CONFIG_PARAMETERS = savedParams;
      if (!wasExported) ctx.exported.delete('GIT_CONFIG_PARAMETERS');
    }
  }
};

void gitRemoteCommand;
void envOf;
void relative;
void reflogText;

export const GIT_COMMANDS: Record<string, Cmd> = { git };
