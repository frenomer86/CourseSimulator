/**
 * A simulated git for the terminal engine. The repository lives in <repo>/.git/state.json inside
 * the simulated file system, so it is saved, reset and inspected like any other file.
 *
 * Supported: init, config, status, add, rm, commit, log, diff, show, branch, switch, checkout,
 * merge (fast-forward and three-way, with line-level conflict markers), restore, tag and
 * rev-parse. Remotes are explained but not simulated.
 */

import { FsError, lookup, mkdir, readFile, remove, writeFile, type DirNode, type FsNode } from './fs.js';
import { homeOf } from './system.js';
import { actor, currentUser, type Ctx } from './shell.js';
import { abs, parseOpts, type IO } from './util.js';
import { STATE, hashHex, type GitState } from './git-state.js';

export { seedRepo, type GitCommit, type GitState } from './git-state.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/* ----------------------------------------------------------------------------- helpers */

/** Finds the repository root at or above the current directory. */
export function findRepo(ctx: Ctx, from = ctx.sys.cwd): string | null {
  let dir = from;
  for (;;) {
    const l = lookup(ctx.sys.fs, (dir === '/' ? '' : dir) + '/' + STATE, { user: 'root', groups: ['root'] });
    if (l) return dir;
    if (dir === '/') return null;
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
  }
}

export function loadGit(ctx: Ctx, repo: string): GitState {
  return JSON.parse(readFile(ctx.sys.fs, `${repo === '/' ? '' : repo}/${STATE}`, { user: 'root', groups: ['root'] })) as GitState;
}

function saveGit(ctx: Ctx, repo: string, st: GitState): void {
  const base = repo === '/' ? '' : repo;
  writeFile(ctx.sys.fs, `${base}/${STATE}`, JSON.stringify(st), actor(ctx), ctx.sys.now);
  writeFile(ctx.sys.fs, `${base}/.git/HEAD`, st.head.branch ? `ref: refs/heads/${st.head.branch}\n` : `${st.head.detached}\n`, actor(ctx), ctx.sys.now);
}

export function headCommit(st: GitState): string | null {
  return st.head.branch !== undefined ? st.branches[st.head.branch] ?? null : st.head.detached ?? null;
}

function headTree(st: GitState): Record<string, string> {
  const h = headCommit(st);
  return h ? st.commits[h].tree : {};
}

/** Every file under the repository except .git, as path relative to the repo → content. */
function workingTree(ctx: Ctx, repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const a = actor(ctx);
  const start = lookup(ctx.sys.fs, repo, a);
  if (!start || start.node.type !== 'dir') return out;
  const visit = (node: DirNode, rel: string) => {
    for (const [name, child] of Object.entries(node.children)) {
      if (!rel && name === '.git') continue;
      const p = rel ? `${rel}/${name}` : name;
      if (child.type === 'dir') visit(child, p);
      else if (child.type === 'file') out[p] = (child as FsNode & { content: string }).content;
    }
  };
  visit(start.node as DirNode, '');
  // .gitignore: glob patterns (*.log, build/, /secret.txt); ignored files are invisible to add and status.
  const ignore = (out['.gitignore'] ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (ignore.length) {
    const res = ignore.map((pat) => {
      const dir = pat.endsWith('/');
      const anchored = pat.startsWith('/');
      const body = pat.replace(/^\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
      return new RegExp(`${anchored || body.includes('/') ? '^' : '(^|/)'}${body}${dir ? '/' : '(/|$)'}`);
    });
    for (const p of Object.keys(out)) if (p !== '.gitignore' && res.some((re) => re.test(p))) delete out[p];
  }
  return out;
}

export function ancestors(st: GitState, id: string | null): Set<string> {
  const seen = new Set<string>();
  const stack = id ? [id] : [];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(st.commits[c]?.parents ?? []));
  }
  return seen;
}

function resolveRef(st: GitState, ref: string): string | null {
  if (ref === 'HEAD') return headCommit(st);
  if (/^HEAD~\d+$/.test(ref)) {
    let c = headCommit(st);
    for (let i = 0; i < Number(ref.slice(5)) && c; i++) c = st.commits[c].parents[0] ?? null;
    return c;
  }
  if (st.branches[ref] !== undefined) return st.branches[ref];
  if (st.tags[ref]) return st.tags[ref];
  const hits = Object.keys(st.commits).filter((id) => id.startsWith(ref));
  return ref.length >= 4 && hits.length === 1 ? hits[0] : null;
}

function identity(ctx: Ctx, st: GitState): { name?: string; email?: string } {
  const global: { name?: string; email?: string } = {};
  try {
    const text = readFile(ctx.sys.fs, `${homeOf(ctx.sys, currentUser(ctx))}/.gitconfig`, actor(ctx));
    const name = /^\s*name\s*=\s*(.+)$/m.exec(text);
    const email = /^\s*email\s*=\s*(.+)$/m.exec(text);
    if (name) global.name = name[1].trim();
    if (email) global.email = email[1].trim();
  } catch {
    /* no global config */
  }
  return { name: st.config.name ?? global.name, email: st.config.email ?? global.email };
}

function writeWorking(ctx: Ctx, repo: string, files: Record<string, string>, removeTracked: string[]): void {
  const a = actor(ctx);
  const base = repo === '/' ? '' : repo;
  for (const p of removeTracked) {
    try {
      remove(ctx.sys.fs, `${base}/${p}`, a, false);
    } catch {
      /* already gone */
    }
  }
  for (const [p, content] of Object.entries(files)) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir) mkdir(ctx.sys.fs, `${base}/${dir}`, a, ctx.sys.now, true);
    writeFile(ctx.sys.fs, `${base}/${p}`, content, a, ctx.sys.now);
  }
}

function lineDiff(a: string, b: string): string[] {
  const x = a === '' ? [] : a.replace(/\n$/, '').split('\n');
  const y = b === '' ? [] : b.replace(/\n$/, '').split('\n');
  const n = x.length;
  const m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [`@@ -1,${n} +1,${m} @@`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(' ' + x[i]);
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push('+' + y[j++]);
    else out.push('-' + x[i++]);
  }
  return out;
}

function printDiff(io: IO, from: Record<string, string>, to: Record<string, string>, paths?: string[]): void {
  const all = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().filter((p) => !paths?.length || paths.some((q) => p === q || p.startsWith(q.replace(/\/$/, '') + '/')));
  for (const p of all) {
    if (from[p] === to[p]) continue;
    io.out(`diff --git a/${p} b/${p}\n`);
    if (from[p] === undefined) io.out('new file mode 100644\n--- /dev/null\n');
    else io.out(`--- a/${p}\n`);
    io.out(to[p] === undefined ? '+++ /dev/null\n' : `+++ b/${p}\n`);
    io.out(lineDiff(from[p] ?? '', to[p] ?? '').join('\n') + '\n');
  }
}

/** Line-level three-way merge when all three versions have the same number of lines; else whole-file. */
function mergeFile(base: string | undefined, ours: string | undefined, theirs: string | undefined, otherName: string): { content?: string; conflict: boolean } {
  if (ours === theirs) return { content: ours, conflict: false };
  if (ours === base) return { content: theirs, conflict: false };
  if (theirs === base) return { content: ours, conflict: false };
  const split = (s: string | undefined) => (s ?? '').replace(/\n$/, '').split('\n');
  const [b, o, t] = [split(base), split(ours), split(theirs)];
  if (base !== undefined && ours !== undefined && theirs !== undefined && b.length === o.length && o.length === t.length) {
    const out: string[] = [];
    let conflict = false;
    let i = 0;
    while (i < b.length) {
      if (o[i] === t[i] || o[i] === b[i] || t[i] === b[i]) {
        out.push(o[i] === b[i] ? t[i] : o[i]);
        i++;
        continue;
      }
      conflict = true;
      const start = i;
      while (i < b.length && o[i] !== t[i] && o[i] !== b[i] && t[i] !== b[i]) i++;
      out.push('<<<<<<< HEAD', ...o.slice(start, i), '=======', ...t.slice(start, i), `>>>>>>> ${otherName}`);
    }
    return { content: out.join('\n') + '\n', conflict };
  }
  return { content: `<<<<<<< HEAD\n${ours ?? ''}${ours && !ours.endsWith('\n') ? '\n' : ''}=======\n${theirs ?? ''}${theirs && !theirs.endsWith('\n') ? '\n' : ''}>>>>>>> ${otherName}\n`, conflict: true };
}

const short = (id: string) => id.slice(0, 7);
const hasMarkers = (s: string) => /^(<<<<<<< |=======$|>>>>>>> )/m.test(s);

function decorations(st: GitState, id: string): string {
  const names: string[] = [];
  if (st.head.branch && st.branches[st.head.branch] === id) names.push(`HEAD -> ${st.head.branch}`);
  else if (!st.head.branch && st.head.detached === id) names.push('HEAD');
  for (const [b, c] of Object.entries(st.branches)) if (c === id && b !== st.head.branch) names.push(b);
  for (const [t, c] of Object.entries(st.tags)) if (c === id) names.push(`tag: ${t}`);
  return names.length ? ` (${names.join(', ')})` : '';
}

/* ----------------------------------------------------------------------------- git */

const git: Cmd = (args, io, ctx) => {
  const [sub, ...rest] = args;
  const a = actor(ctx);
  const fail = (msg: string, code = 128) => {
    io.err(msg.endsWith('\n') ? msg : msg + '\n');
    return code;
  };
  if (!sub || sub === 'help' || sub === '--help') {
    io.out('usage: git <command> [<args>]\n\nstart a working area:   init\nwork on changes:        add, rm, restore, commit\nexamine history:        status, log, diff, show\nbranches:               branch, switch, checkout, merge, tag\nsettings:               config\n');
    return sub ? 0 : 1;
  }
  if (sub === '--version' || sub === 'version') {
    io.out('git version 2.45.2\n');
    return 0;
  }

  if (sub === 'config') {
    const o = parseOpts(rest, []);
    const [key, ...vals] = o.rest;
    const value = vals.join(' ');
    if (o.flags.has('list') || o.flags.has('l')) {
      const repo = findRepo(ctx);
      const id = identity(ctx, repo ? loadGit(ctx, repo) : ({ config: {} } as GitState));
      if (id.name) io.out(`user.name=${id.name}\n`);
      if (id.email) io.out(`user.email=${id.email}\n`);
      io.out('init.defaultbranch=main\n');
      return 0;
    }
    if (key !== 'user.name' && key !== 'user.email') return fail(`error: this simulator supports user.name and user.email only (you asked for ${key ?? 'nothing'})`, 1);
    const field = key === 'user.name' ? 'name' : 'email';
    if (o.flags.has('global')) {
      const file = `${homeOf(ctx.sys, currentUser(ctx))}/.gitconfig`;
      let text = '';
      try {
        text = readFile(ctx.sys.fs, file, a);
      } catch {
        /* new file */
      }
      if (!value) {
        const m = new RegExp(`^\\s*${field}\\s*=\\s*(.+)$`, 'm').exec(text);
        if (m) io.out(m[1].trim() + '\n');
        return m ? 0 : 1;
      }
      const lines = text.split('\n').filter((l) => l.trim() && !new RegExp(`^\\s*${field}\\s*=`).test(l) && l.trim() !== '[user]');
      const id = { name: /^\s*name\s*=\s*(.+)$/m.exec(text)?.[1], email: /^\s*email\s*=\s*(.+)$/m.exec(text)?.[1], [field]: value };
      writeFile(ctx.sys.fs, file, `[user]\n${id.name ? `\tname = ${id.name}\n` : ''}${id.email ? `\temail = ${id.email}\n` : ''}${lines.length ? lines.join('\n') + '\n' : ''}`, a, ctx.sys.now);
      return 0;
    }
    const repo = findRepo(ctx);
    if (!repo) return fail('fatal: not in a git directory (use --global outside a repository)');
    const st = loadGit(ctx, repo);
    if (!value) {
      const v = identity(ctx, st)[field];
      if (v) io.out(v + '\n');
      return v ? 0 : 1;
    }
    st.config[field] = value;
    saveGit(ctx, repo, st);
    return 0;
  }

  if (sub === 'init') {
    const dir = rest.find((x) => !x.startsWith('-'));
    const target = dir ? abs(ctx, dir) : ctx.sys.cwd;
    try {
      if (dir) mkdir(ctx.sys.fs, target, a, ctx.sys.now, true);
      if (lookup(ctx.sys.fs, `${target === '/' ? '' : target}/${STATE}`, a)) {
        io.out(`Reinitialized existing Git repository in ${target}/.git/\n`);
        return 0;
      }
      mkdir(ctx.sys.fs, `${target === '/' ? '' : target}/.git`, a, ctx.sys.now, true);
    } catch (e) {
      return fail(`fatal: cannot create ${target}/.git: ${e instanceof FsError ? e.message : String(e)}`);
    }
    saveGit(ctx, target, { head: { branch: 'main' }, branches: { main: null }, commits: {}, index: {}, config: {}, tags: {} });
    io.out(`Initialized empty Git repository in ${target}/.git/\n`);
    return 0;
  }

  if (['clone', 'push', 'pull', 'fetch', 'remote'].includes(sub)) {
    if (sub === 'remote' && rest.length === 0) return 0;
    return fail(`git ${sub}: remotes are not simulated in this lab; everything here happens in your local repository.`, 1);
  }

  const repo = findRepo(ctx);
  if (!repo) return fail('fatal: not a git repository (or any of the parent directories): .git');
  const st = loadGit(ctx, repo);
  const base = repo === '/' ? '' : repo;
  const rel = (p: string) => {
    const full = abs(ctx, p);
    return full === repo ? '' : full.startsWith(base + '/') ? full.slice(base.length + 1) : null;
  };
  const head = headCommit(st);
  const ht = headTree(st);

  switch (sub) {
    case 'ls-files': {
      // Tracked files (the index), sorted, relative to the repository.
      for (const p of Object.keys(st.index).sort()) io.out(p + '\n');
      return 0;
    }

    case 'status': {
      const wt = workingTree(ctx, repo);
      const staged = [...new Set([...Object.keys(ht), ...Object.keys(st.index)])].sort().filter((p) => ht[p] !== st.index[p]);
      const unstaged = Object.keys(st.index).sort().filter((p) => wt[p] !== st.index[p]);
      const untracked = Object.keys(wt).sort().filter((p) => st.index[p] === undefined);
      const shortForm = rest.includes('-s') || rest.includes('--short');
      if (shortForm) {
        const all = [...new Set([...staged, ...unstaged])].sort();
        for (const p of all) {
          const x = staged.includes(p) ? (ht[p] === undefined ? 'A' : st.index[p] === undefined ? 'D' : 'M') : ' ';
          const y = unstaged.includes(p) ? (wt[p] === undefined ? 'D' : 'M') : ' ';
          io.out(`${st.merging && hasMarkers(wt[p] ?? '') ? 'UU' : x + y} ${p}\n`);
        }
        for (const p of untracked) io.out(`?? ${p}\n`);
        return 0;
      }
      io.out(st.head.branch ? `On branch ${st.head.branch}\n` : `HEAD detached at ${short(st.head.detached!)}\n`);
      if (!head) io.out('\nNo commits yet\n');
      if (st.merging) {
        const unmerged = Object.keys(wt).filter((p) => hasMarkers(wt[p]) || hasMarkers(st.index[p] ?? ''));
        io.out(unmerged.length ? `You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\nUnmerged paths:\n  (use "git add <file>..." to mark resolution)\n${unmerged.map((p) => `\tboth modified:   ${p}\n`).join('')}` : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n');
      }
      if (staged.length) io.out(`\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)\n${staged.map((p) => `\t${ht[p] === undefined ? 'new file' : st.index[p] === undefined ? 'deleted' : 'modified'}:   ${p}\n`).join('')}`);
      if (unstaged.length) io.out(`\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n${unstaged.map((p) => `\t${wt[p] === undefined ? 'deleted' : 'modified'}:   ${p}\n`).join('')}`);
      if (untracked.length) io.out(`\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)\n${untracked.map((p) => `\t${p}\n`).join('')}`);
      if (!staged.length && !unstaged.length && !untracked.length) io.out(head ? '\nnothing to commit, working tree clean\n' : '\nnothing to commit (create/copy files and use "git add" to track)\n');
      else if (!staged.length) io.out('\nno changes added to commit (use "git add" and/or "git commit -a")\n');
      return 0;
    }

    case 'add': {
      const o = parseOpts(rest, []);
      const wt = workingTree(ctx, repo);
      const targets = o.flags.has('A') || o.flags.has('all') ? ['.'] : o.rest;
      if (!targets.length) return fail('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?', 0);
      for (const t of targets) {
        const r = rel(t);
        if (r === null) return fail(`fatal: ${t}: '${t}' is outside repository at '${repo}'`);
        const inside = (p: string) => r === '' || p === r || p.startsWith(r + '/');
        const matches = [...new Set([...Object.keys(wt), ...Object.keys(st.index)])].filter(inside);
        if (!matches.length) return fail(`fatal: pathspec '${t}' did not match any files`);
        for (const p of matches) {
          if (wt[p] === undefined) delete st.index[p];
          else st.index[p] = wt[p];
        }
      }
      saveGit(ctx, repo, st);
      return 0;
    }

    case 'rm': {
      const o = parseOpts(rest, []);
      for (const t of o.rest) {
        const r = rel(t);
        if (r === null || st.index[r] === undefined) return fail(`fatal: pathspec '${t}' did not match any files`);
        delete st.index[r];
        if (!o.flags.has('cached')) {
          try {
            remove(ctx.sys.fs, `${base}/${r}`, a, false);
          } catch {
            /* already gone */
          }
        }
        io.out(`rm '${r}'\n`);
      }
      saveGit(ctx, repo, st);
      return 0;
    }

    case 'commit': {
      const o = parseOpts(rest, ['m', 'message']);
      if (o.flags.has('a') || o.flags.has('all')) {
        const wt = workingTree(ctx, repo);
        for (const p of Object.keys(st.index)) {
          if (wt[p] === undefined) delete st.index[p];
          else st.index[p] = wt[p];
        }
      }
      const message = o.values.m ?? o.values.message ?? (st.merging ? `Merge branch '${st.merging.otherName}'` : undefined);
      if (!message) return fail('error: this simulator has no editor for commit messages. Use git commit -m "your message".', 1);
      const id = identity(ctx, st);
      if (!id.name || !id.email)
        return fail(`Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nfatal: unable to auto-detect email address`);
      if (st.merging && Object.values(st.index).some(hasMarkers)) return fail('error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add <file>\'\nfatal: Exiting because of an unresolved conflict.', 1);
      const changed = [...new Set([...Object.keys(ht), ...Object.keys(st.index)])].filter((p) => ht[p] !== st.index[p]);
      if (!changed.length && !st.merging) {
        io.out(`On branch ${st.head.branch ?? 'HEAD'}\nnothing to commit, working tree clean\n`);
        return 1;
      }
      const seq = Object.keys(st.commits).length + 1;
      const parents = [head, st.merging?.other].filter((x): x is string => !!x);
      const cid = hashHex(JSON.stringify([seq, parents, message, id, st.index]));
      st.commits[cid] = { id: cid, seq, parents, message, author: id.name, email: id.email, time: ctx.sys.now + seq * 60000, tree: { ...st.index } };
      if (st.head.branch !== undefined) st.branches[st.head.branch] = cid;
      else st.head.detached = cid;
      const wasMerge = !!st.merging;
      delete st.merging;
      saveGit(ctx, repo, st);
      const added = changed.filter((p) => ht[p] === undefined).length;
      io.out(`[${st.head.branch ?? 'detached HEAD'}${head ? '' : ' (root-commit)'} ${short(cid)}] ${message}\n ${changed.length} file${changed.length === 1 ? '' : 's'} changed${added ? `, ${added} new` : ''}${wasMerge ? ' (merge)' : ''}\n`);
      return 0;
    }

    case 'log': {
      const o = parseOpts(rest, ['n']);
      if (!head) return fail(`fatal: your current branch '${st.head.branch}' does not have any commits yet`);
      const oneline = o.flags.has('oneline');
      const max = Number(o.values.n ?? o.values.N ?? Infinity);
      const startIds = o.flags.has('all') ? [...Object.values(st.branches).filter((x): x is string => !!x)] : [o.rest[0] ? resolveRef(st, o.rest[0]) : head].filter((x): x is string => !!x);
      const set = new Set<string>();
      for (const s of startIds) for (const c of ancestors(st, s)) set.add(c);
      const list = [...set].map((cid) => st.commits[cid]).sort((x, y) => y.seq - x.seq).slice(0, max);
      for (const c of list) {
        if (oneline) io.out(`${short(c.id)}${decorations(st, c.id)} ${c.message.split('\n')[0]}\n`);
        else io.out(`commit ${c.id}${decorations(st, c.id)}\n${c.parents.length > 1 ? `Merge: ${c.parents.map(short).join(' ')}\n` : ''}Author: ${c.author} <${c.email}>\nDate:   ${new Date(c.time).toUTCString()}\n\n${c.message.split('\n').map((l) => (l ? '    ' + l : '')).join('\n')}\n\n`);
      }
      return 0;
    }

    case 'diff': {
      const o = parseOpts(rest, []);
      const paths = o.rest.map((p) => rel(p) ?? p);
      if (o.flags.has('staged') || o.flags.has('cached')) printDiff(io, ht, st.index, paths);
      else if (o.rest.length && resolveRef(st, o.rest[0])) {
        const from = resolveRef(st, o.rest[0])!;
        const to = o.rest[1] ? resolveRef(st, o.rest[1]) : null;
        printDiff(io, st.commits[from].tree, to ? st.commits[to].tree : workingTree(ctx, repo));
      } else {
        const wt = workingTree(ctx, repo);
        const tracked = Object.fromEntries(Object.keys(st.index).map((p) => [p, wt[p]]).filter(([, v]) => v !== undefined || true)) as Record<string, string>;
        for (const p of Object.keys(tracked)) if (tracked[p] === undefined) delete tracked[p];
        printDiff(io, st.index, tracked, paths);
      }
      return 0;
    }

    case 'show': {
      const id = resolveRef(st, rest[0] ?? 'HEAD');
      if (!id) return fail(`fatal: ambiguous argument '${rest[0] ?? 'HEAD'}': unknown revision`);
      const c = st.commits[id];
      io.out(`commit ${c.id}${decorations(st, c.id)}\nAuthor: ${c.author} <${c.email}>\n\n    ${c.message}\n\n`);
      printDiff(io, c.parents[0] ? st.commits[c.parents[0]].tree : {}, c.tree);
      return 0;
    }

    case 'branch': {
      const o = parseOpts(rest, []);
      const del = o.flags.has('d') || o.flags.has('D') || o.flags.has('delete');
      if (!o.rest.length) {
        for (const b of Object.keys(st.branches).sort()) if (st.branches[b] || b === st.head.branch) io.out(`${b === st.head.branch ? '*' : ' '} ${b}${o.flags.has('v') && st.branches[b] ? ` ${short(st.branches[b]!)} ${st.commits[st.branches[b]!].message}` : ''}\n`);
        return 0;
      }
      const name = o.rest[0];
      if (del) {
        if (st.branches[name] === undefined) return fail(`error: branch '${name}' not found.`, 1);
        if (name === st.head.branch) return fail(`error: Cannot delete branch '${name}' checked out at '${repo}'`, 1);
        if (!o.flags.has('D') && st.branches[name] && !ancestors(st, head).has(st.branches[name]!)) return fail(`error: The branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'.`, 1);
        io.out(`Deleted branch ${name} (was ${short(st.branches[name] ?? '0000000')}).\n`);
        delete st.branches[name];
        saveGit(ctx, repo, st);
        return 0;
      }
      if (!head) return fail(`fatal: not a valid object name: '${st.head.branch}'`);
      if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-')) return fail(`fatal: '${name}' is not a valid branch name`);
      if (st.branches[name] !== undefined) return fail(`fatal: a branch named '${name}' already exists`);
      st.branches[name] = o.rest[1] ? resolveRef(st, o.rest[1]) : head;
      saveGit(ctx, repo, st);
      return 0;
    }

    case 'switch':
    case 'checkout': {
      const o = parseOpts(rest, ['c', 'b']);
      const create = o.values.c ?? o.values.b;
      const name = create ?? o.rest[0];
      if (!name) return fail(`fatal: missing branch name; try git ${sub} <branch>`);
      if (sub === 'checkout' && !create && st.index[rel(name) ?? ''] !== undefined && st.branches[name] === undefined) {
        const r = rel(name)!;
        writeWorking(ctx, repo, { [r]: st.index[r] }, []);
        io.out(`Updated 1 path from the index\n`);
        return 0;
      }
      if (create) {
        if (st.branches[create] !== undefined) return fail(`fatal: a branch named '${create}' already exists`);
        if (!head) {
          st.branches[create] = null;
          delete st.branches[st.head.branch!];
          st.head = { branch: create };
          saveGit(ctx, repo, st);
          io.out(`Switched to a new branch '${create}'\n`);
          return 0;
        }
        st.branches[create] = head;
        st.head = { branch: create };
        saveGit(ctx, repo, st);
        io.out(`Switched to a new branch '${create}'\n`);
        return 0;
      }
      if (st.merging) return fail('error: you need to resolve your current index first (finish or abort the merge)', 1);
      const target = st.branches[name] !== undefined ? st.branches[name] : null;
      if (st.branches[name] === undefined) return fail(`fatal: invalid reference: ${name}`);
      if (name === st.head.branch) {
        io.out(`Already on '${name}'\n`);
        return 0;
      }
      const tt = target ? st.commits[target].tree : {};
      const wt = workingTree(ctx, repo);
      const dirty = [...new Set([...Object.keys(ht), ...Object.keys(st.index)])].filter((p) => ht[p] !== st.index[p] || (st.index[p] !== undefined && wt[p] !== st.index[p]));
      const blocked = dirty.filter((p) => tt[p] !== ht[p]);
      if (blocked.length) return fail(`error: Your local changes to the following files would be overwritten by checkout:\n${blocked.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you switch branches.\nAborting`, 1);
      const removeTracked = Object.keys(ht).filter((p) => tt[p] === undefined && !dirty.includes(p));
      const write: Record<string, string> = {};
      for (const [p, c] of Object.entries(tt)) if (!dirty.includes(p)) write[p] = c;
      writeWorking(ctx, repo, write, removeTracked);
      const newIndex: Record<string, string> = { ...tt };
      for (const p of dirty) {
        if (st.index[p] === undefined) delete newIndex[p];
        else newIndex[p] = st.index[p];
      }
      st.index = newIndex;
      st.head = { branch: name };
      saveGit(ctx, repo, st);
      io.out(`Switched to branch '${name}'\n`);
      return 0;
    }

    case 'merge': {
      const o = parseOpts(rest, ['m']);
      if (o.flags.has('abort')) {
        if (!st.merging) return fail('fatal: There is no merge to abort (MERGE_HEAD missing).');
        const wt = workingTree(ctx, repo);
        writeWorking(ctx, repo, ht, Object.keys(wt).filter((p) => ht[p] === undefined && st.index[p] !== undefined));
        st.index = { ...ht };
        delete st.merging;
        saveGit(ctx, repo, st);
        return 0;
      }
      const name = o.rest[0];
      if (!name) return fail('fatal: No remote for the current branch.');
      if (st.merging) return fail('error: Merging is not possible because you have unmerged files.', 1);
      const other = resolveRef(st, name);
      if (!other) return fail(`merge: ${name} - not something we can merge`, 1);
      if (!head) return fail('fatal: cannot merge into an empty branch; commit something first');
      const wt = workingTree(ctx, repo);
      const dirty = Object.keys({ ...ht, ...st.index }).filter((p) => ht[p] !== st.index[p] || (st.index[p] !== undefined && wt[p] !== st.index[p]));
      if (dirty.length) return fail(`error: Your local changes to the following files would be overwritten by merge:\n${dirty.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting`, 1);
      const ours = ancestors(st, head);
      if (ours.has(other)) {
        io.out('Already up to date.\n');
        return 0;
      }
      const theirs = ancestors(st, other);
      const ot = st.commits[other].tree;
      if (theirs.has(head) && !o.flags.has('no-ff')) {
        writeWorking(ctx, repo, ot, Object.keys(ht).filter((p) => ot[p] === undefined));
        st.index = { ...ot };
        st.branches[st.head.branch!] = other;
        saveGit(ctx, repo, st);
        io.out(`Updating ${short(head)}..${short(other)}\nFast-forward\n${Object.keys({ ...ht, ...ot }).filter((p) => ht[p] !== ot[p]).map((p) => ` ${p}\n`).join('')}`);
        return 0;
      }
      const common = [...ours].filter((c) => theirs.has(c)).sort((x, y) => st.commits[y].seq - st.commits[x].seq)[0];
      const bt = common ? st.commits[common].tree : {};
      const merged: Record<string, string> = {};
      const conflicts: string[] = [];
      for (const p of [...new Set([...Object.keys(bt), ...Object.keys(ht), ...Object.keys(ot)])].sort()) {
        const r = mergeFile(bt[p], ht[p], ot[p], name);
        if (r.conflict) conflicts.push(p);
        if (r.content !== undefined) merged[p] = r.content;
      }
      writeWorking(ctx, repo, merged, Object.keys(ht).filter((p) => merged[p] === undefined));
      st.merging = { other, otherName: name };
      if (conflicts.length) {
        st.index = { ...merged };
        for (const p of conflicts) st.index[p] = merged[p];
        saveGit(ctx, repo, st);
        io.out(`${conflicts.map((p) => `Auto-merging ${p}\nCONFLICT (content): Merge conflict in ${p}\n`).join('')}Automatic merge failed; fix conflicts and then commit the result.\n`);
        return 1;
      }
      st.index = { ...merged };
      saveGit(ctx, repo, st);
      return git(['commit', '-m', o.values.m ?? `Merge branch '${name}'`], io, ctx);
    }

    case 'restore': {
      const o = parseOpts(rest, ['source']);
      for (const t of o.rest) {
        const r = rel(t);
        if (r === null) return fail(`error: pathspec '${t}' did not match any file(s) known to git`, 1);
        if (o.flags.has('staged')) {
          if (ht[r] === undefined) delete st.index[r];
          else st.index[r] = ht[r];
        } else {
          if (st.index[r] === undefined) return fail(`error: pathspec '${t}' did not match any file(s) known to git`, 1);
          writeWorking(ctx, repo, { [r]: st.index[r] }, []);
        }
      }
      saveGit(ctx, repo, st);
      return 0;
    }

    case 'revert': {
      // git revert [--no-edit] COMMIT: a new commit that undoes COMMIT's changes.
      const ref = rest.find((x) => !x.startsWith('-')) ?? 'HEAD';
      const cid = resolveRef(st, ref);
      if (!cid) return fail(`fatal: bad revision '${ref}'`);
      if (!rest.includes('--no-edit') && !rest.includes('-m')) return fail('error: this simulator has no editor for commit messages. Use git revert --no-edit COMMIT.', 1);
      const c = st.commits[cid];
      const before = c.parents[0] ? st.commits[c.parents[0]].tree : {};
      const touched = [...new Set([...Object.keys(before), ...Object.keys(c.tree)])].filter((p) => before[p] !== c.tree[p]);
      const clash = touched.filter((p) => ht[p] !== c.tree[p]);
      if (clash.length) return fail(`error: could not revert ${short(cid)}... ${c.message}\nhint: after resolving the conflicts, mark the corrected paths\nCONFLICT (content): ${clash[0]} was changed again after ${short(cid)}`, 1);
      if (Object.keys(st.index).some((p) => st.index[p] !== ht[p])) return fail('error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.', 1);
      const restore: Record<string, string> = {};
      const gone: string[] = [];
      for (const p of touched) {
        if (before[p] === undefined) {
          delete st.index[p];
          gone.push(p);
        } else {
          st.index[p] = before[p];
          restore[p] = before[p];
        }
      }
      writeWorking(ctx, repo, restore, gone);
      const id = identity(ctx, st);
      const message = `Revert "${c.message}"\n\nThis reverts commit ${cid}.`;
      const seq = Object.keys(st.commits).length + 1;
      const newId = hashHex(JSON.stringify([seq, [head], message, id, st.index]));
      st.commits[newId] = { id: newId, seq, parents: head ? [head] : [], message, author: id.name ?? 'Unknown', email: id.email ?? '', time: ctx.sys.now + seq * 60000, tree: { ...st.index } };
      if (st.head.branch !== undefined) st.branches[st.head.branch] = newId;
      else st.head.detached = newId;
      saveGit(ctx, repo, st);
      io.out(`[${st.head.branch ?? 'detached HEAD'} ${short(newId)}] Revert "${c.message}"\n ${touched.length} file${touched.length === 1 ? '' : 's'} changed\n`);
      return 0;
    }

    case 'tag': {
      if (!rest.length) {
        for (const t of Object.keys(st.tags).sort()) io.out(t + '\n');
        return 0;
      }
      const name = rest.find((x) => !x.startsWith('-'))!;
      if (!head) return fail('fatal: Failed to resolve \'HEAD\' as a valid ref.');
      if (st.tags[name]) return fail(`fatal: tag '${name}' already exists`);
      st.tags[name] = head;
      saveGit(ctx, repo, st);
      return 0;
    }

    case 'rev-parse': {
      if (rest.includes('--show-toplevel')) {
        io.out(repo + '\n');
        return 0;
      }
      const ref = rest.filter((x) => !x.startsWith('-'))[0] ?? 'HEAD';
      if (rest.includes('--abbrev-ref') && ref === 'HEAD') {
        io.out((st.head.branch ?? 'HEAD') + '\n');
        return 0;
      }
      const id = resolveRef(st, ref);
      if (!id) return fail(`fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
      io.out((rest.includes('--short') ? short(id) : id) + '\n');
      return 0;
    }
  }
  return fail(`git: '${sub}' is not a git command in this simulator. See 'git help'.`, 1);
};

export const GIT_COMMANDS: Record<string, Cmd> = { git };
