/** File and directory commands. */

import { FsError, basename, can, copy, dirname, listDir, lookup, mkdir, modeString, move, normalise, parseMode, readFile, remove, walk, writeFile, type DirNode, type FsNode } from './fs.js';
import { groupName } from './system.js';
import { actor, currentUser, globMatch, runCommand, type Ctx } from './shell.js';
import { abs, errText, humanSize, lsDate, parseOpts, readInputs, sizeOf, statNode, totalSize, type IO } from './util.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

export const FILE_COMMANDS: Record<string, Cmd> = {
  pwd: (_a, io, ctx) => {
    io.out(ctx.sys.cwd + '\n');
    return 0;
  },

  ls: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.flags.has('R')) {
      // List each directory, then every directory below it, with a "path:" header.
      const flags = args.filter((a) => a.startsWith('-')).map((a) => a.replace(/R/g, '')).filter((a) => a !== '-');
      let code = 0;
      for (const t of o.rest.length ? o.rest : ['.']) {
        const start = lookup(ctx.sys.fs, abs(ctx, t), actor(ctx));
        if (!start || start.node.type !== 'dir') {
          code = FILE_COMMANDS.ls([...flags, t], io, ctx) || code;
          continue;
        }
        const dirs: string[] = [];
        walk(ctx.sys.fs, start.path, actor(ctx), (p, n) => {
          if (n.type === 'dir' && !(p.split('/').pop() ?? '').startsWith('.')) dirs.push(p);
        });
        dirs.forEach((d, i) => {
          const shown = t.replace(/\/$/, '') + d.slice(start.path.length);
          io.out(`${i ? '\n' : ''}${shown || t}:\n`);
          FILE_COMMANDS.ls([...flags, '-1', d], io, ctx);
        });
      }
      return code;
    }
    const long = o.flags.has('l');
    const all = o.flags.has('a') || o.flags.has('A');
    const human = o.flags.has('h');
    const targets = o.rest.length ? o.rest : ['.'];
    let code = 0;
    const sys = ctx.sys;
    const onePerLine = o.values.N === '1';
    const fmtAll = (rows: Array<{ name: string; node: FsNode }>): string => {
      if (!long) return rows.map((r) => r.name).join(onePerLine ? '\n' : '  ');
      const w = { links: 1, owner: 1, group: 1, size: 1 };
      const cells = rows.map((r) => {
        const n = r.node;
        const size = human ? humanSize(sizeOf(n)) : String(sizeOf(n));
        const links = String(n.type === 'dir' ? 2 + Object.values(n.children).filter((c) => c.type === 'dir').length : 1);
        w.links = Math.max(w.links, links.length);
        w.owner = Math.max(w.owner, n.owner.length);
        w.group = Math.max(w.group, n.group.length);
        w.size = Math.max(w.size, size.length);
        return { r, size, links };
      });
      return cells.map(({ r, size, links }) => `${modeString(r.node)} ${links.padStart(w.links)} ${r.node.owner.padEnd(w.owner)} ${r.node.group.padEnd(w.group)} ${size.padStart(w.size)} ${lsDate(r.node.mtime)} ${r.name}${r.node.type === 'link' ? ` -> ${r.node.target}` : ''}`).join('\n');
    };
    const blocks: string[] = [];
    const dirsToList: string[] = [];
    const files: Array<{ name: string; node: FsNode }> = [];
    for (const t of targets) {
      try {
        let l = lookup(sys.fs, abs(ctx, t), actor(ctx), false);
        if (!l) {
          io.err(`ls: cannot access '${t}': No such file or directory\n`);
          code = 2;
          continue;
        }
        if (l.node.type === 'link' && !o.flags.has('d')) {
          const followed = lookup(sys.fs, abs(ctx, t), actor(ctx));
          if (followed?.node.type === 'dir') l = followed;
        }
        if (l.node.type === 'dir' && !o.flags.has('d')) dirsToList.push(t);
        else files.push({ name: t, node: l.node });
      } catch (e) {
        io.err(`ls: ${errText(e, t)}\n`);
        code = 2;
      }
    }
    if (files.length) blocks.push(fmtAll(files) + '\n');
    for (const d of dirsToList) {
      try {
        let entries = listDir(sys.fs, abs(ctx, d), actor(ctx));
        if (!all) entries = entries.filter((e) => !e.name.startsWith('.'));
        else if (o.flags.has('a')) {
          const self = lookup(sys.fs, abs(ctx, d), actor(ctx))!.node;
          const parent = lookup(sys.fs, dirname(abs(ctx, d)), actor(ctx))?.node ?? self;
          entries = [{ name: '.', node: self }, { name: '..', node: parent }, ...entries];
        }
        if (o.flags.has('t')) entries.sort((a, b) => b.node.mtime - a.node.mtime);
        if (o.flags.has('S')) entries.sort((a, b) => sizeOf(b.node) - sizeOf(a.node));
        if (o.flags.has('r')) entries.reverse();
        const header = dirsToList.length + files.length > 1 ? `${d}:\n` : '';
        const total = long ? `total ${entries.reduce((s, e) => s + Math.ceil(sizeOf(e.node) / 1024) * 4, 0)}\n` : '';
        const body = fmtAll(entries.map((e) => ({ name: e.name + (o.flags.has('F') && e.node.type === 'dir' ? '/' : ''), node: e.node })));
        blocks.push(header + total + (body ? body + '\n' : ''));
      } catch (e) {
        io.err(`ls: cannot open directory '${d}': ${errText(e, d).replace(/^.*?: /, '')}\n`);
        code = 2;
      }
    }
    io.out(blocks.join(dirsToList.length > 1 ? '\n' : ''));
    return code;
  },

  cat: (args, io, ctx) => {
    const o = parseOpts(args);
    let n = 1;
    for (const f of readInputs(ctx, io, o.rest, 'cat')) {
      if (o.flags.has('n')) {
        const ls = f.content.split('\n');
        if (ls[ls.length - 1] === '') ls.pop();
        io.out(ls.map((l) => `${String(n++).padStart(6)}\t${l}\n`).join(''));
      } else io.out(f.content);
    }
    return ctx.status === 1 ? 1 : 0;
  },
  less: (args, io, ctx) => FILE_COMMANDS.cat(args.filter((a) => !a.startsWith('-')), io, ctx),
  more: (args, io, ctx) => FILE_COMMANDS.cat(args.filter((a) => !a.startsWith('-')), io, ctx),

  echo: (args, io) => {
    const o = { n: false, e: false };
    let i = 0;
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      if (args[i].includes('n')) o.n = true;
      if (args[i].includes('e')) o.e = true;
      i++;
    }
    let text = args.slice(i).join(' ');
    if (o.e) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    io.out(text + (o.n ? '' : '\n'));
    return 0;
  },

  printf: (argv, io) => {
    // "--" ends options, so a format may start with "-": printf -- '- item\n'.
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    if (!args.length) {
      io.err('printf: usage: printf FORMAT [ARGUMENT]...\n');
      return 2;
    }
    const fmt = args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const values = args.slice(1);
    let vi = 0;
    const once = () =>
      fmt.replace(/%(-?)(\d*)(?:\.(\d+))?([sdifxoc%])/g, (_, minus: string, width: string, prec: string, conv: string) => {
        if (conv === '%') return '%';
        const v = values[vi++] ?? '';
        let s: string;
        if (conv === 's') s = prec ? v.slice(0, Number(prec)) : v;
        else if (conv === 'c') s = v.slice(0, 1);
        else if (conv === 'f') s = Number(v || 0).toFixed(prec ? Number(prec) : 6);
        else if (conv === 'x') s = (Number(v) || 0).toString(16);
        else if (conv === 'o') s = (Number(v) || 0).toString(8);
        else s = String(Math.trunc(Number(v) || 0));
        const w = Number(width || 0);
        return minus ? s.padEnd(w) : s.padStart(w, width.startsWith('0') && !minus ? '0' : ' ');
      });
    if (!values.length) {
      io.out(once());
      return 0;
    }
    while (vi < values.length) {
      const before = vi;
      io.out(once());
      if (vi === before) break;
    }
    return 0;
  },

  mkdir: (args, io, ctx) => {
    const o = parseOpts(args, ['m']);
    let code = 0;
    for (const d of o.rest) {
      try {
        mkdir(ctx.sys.fs, abs(ctx, d), actor(ctx), ctx.sys.now, o.flags.has('p') || o.flags.has('parents'));
        if (o.values.m) {
          const n = statNode(ctx, d);
          if (n) n.mode = parseInt(o.values.m, 8);
        }
        if (o.flags.has('v')) io.out(`mkdir: created directory '${d}'\n`);
      } catch (e) {
        if (e instanceof FsError && e.code === 'EEXIST' && o.flags.has('p')) continue;
        io.err(`mkdir: cannot create directory '${d}': ${errText(e, d).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    if (!o.rest.length) {
      io.err('mkdir: missing operand\n');
      return 1;
    }
    return code;
  },

  rmdir: (args, io, ctx) => {
    let code = 0;
    for (const d of parseOpts(args).rest) {
      const n = statNode(ctx, d);
      if (!n) {
        io.err(`rmdir: failed to remove '${d}': No such file or directory\n`);
        code = 1;
        continue;
      }
      if (n.type !== 'dir') {
        io.err(`rmdir: failed to remove '${d}': Not a directory\n`);
        code = 1;
        continue;
      }
      if (Object.keys(n.children).length) {
        io.err(`rmdir: failed to remove '${d}': Directory not empty\n`);
        code = 1;
        continue;
      }
      try {
        remove(ctx.sys.fs, abs(ctx, d), actor(ctx), true);
      } catch (e) {
        io.err(`rmdir: failed to remove '${d}': ${errText(e, d).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    return code;
  },

  touch: (args, io, ctx) => {
    const o = parseOpts(args);
    let code = 0;
    for (const f of o.rest) {
      try {
        const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
        if (l) l.node.mtime = ctx.sys.now;
        else writeFile(ctx.sys.fs, abs(ctx, f), '', actor(ctx), ctx.sys.now);
      } catch (e) {
        io.err(`touch: cannot touch '${f}': ${errText(e, f).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    if (!o.rest.length) {
      io.err('touch: missing file operand\n');
      return 1;
    }
    return code;
  },

  rm: (args, io, ctx) => {
    const o = parseOpts(args, [], { recursive: 'r', force: 'f' });
    const recursive = o.flags.has('r') || o.flags.has('R');
    const force = o.flags.has('f');
    let code = 0;
    if (!o.rest.length) {
      io.err('rm: missing operand\n');
      return 1;
    }
    for (const f of o.rest) {
      const p = abs(ctx, f);
      if (p === '/' ) {
        io.err("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
        code = 1;
        continue;
      }
      try {
        const l = lookup(ctx.sys.fs, p, actor(ctx), false);
        if (!l) {
          if (!force) {
            io.err(`rm: cannot remove '${f}': No such file or directory\n`);
            code = 1;
          }
          continue;
        }
        if (l.node.type === 'dir' && !recursive) {
          io.err(`rm: cannot remove '${f}': Is a directory\n`);
          code = 1;
          continue;
        }
        remove(ctx.sys.fs, p, actor(ctx), recursive);
        if (o.flags.has('v')) io.out(`removed '${f}'\n`);
      } catch (e) {
        io.err(`rm: cannot remove '${f}': ${errText(e, f).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    return code;
  },

  cp: (args, io, ctx) => {
    const o = parseOpts(args, [], { recursive: 'r' });
    const recursive = o.flags.has('r') || o.flags.has('R') || o.flags.has('a');
    if (o.rest.length < 2) {
      io.err(o.rest.length ? `cp: missing destination file operand after '${o.rest[0]}'\n` : 'cp: missing file operand\n');
      return 1;
    }
    const dest = o.rest[o.rest.length - 1];
    const sources = o.rest.slice(0, -1);
    const destNode = statNode(ctx, dest);
    if (sources.length > 1 && destNode?.type !== 'dir') {
      io.err(`cp: target '${dest}' is not a directory\n`);
      return 1;
    }
    let code = 0;
    for (const s of sources) {
      try {
        const src = lookup(ctx.sys.fs, abs(ctx, s), actor(ctx));
        if (!src) {
          io.err(`cp: cannot stat '${s}': No such file or directory\n`);
          code = 1;
          continue;
        }
        if (src.node.type === 'dir' && !recursive) {
          io.err(`cp: -r not specified; omitting directory '${s}'\n`);
          code = 1;
          continue;
        }
        let target = abs(ctx, dest);
        const existing = lookup(ctx.sys.fs, target, actor(ctx));
        if (existing?.node.type === 'dir') target = `${target}/${basename(s)}`;
        const prior = lookup(ctx.sys.fs, target, actor(ctx));
        if (prior && prior.node.type !== 'dir') remove(ctx.sys.fs, target, actor(ctx), false);
        copy(ctx.sys.fs, abs(ctx, s), target, actor(ctx), ctx.sys.now, recursive);
        if (o.flags.has('p') || o.flags.has('a')) {
          const copied = lookup(ctx.sys.fs, target, actor(ctx))!.node;
          copied.mode = src.node.mode;
          copied.mtime = src.node.mtime;
        }
        if (o.flags.has('v')) io.out(`'${s}' -> '${dest}'\n`);
      } catch (e) {
        io.err(`cp: ${errText(e, s)}\n`);
        code = 1;
      }
    }
    return code;
  },

  mv: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.rest.length < 2) {
      io.err(o.rest.length ? `mv: missing destination file operand after '${o.rest[0]}'\n` : 'mv: missing file operand\n');
      return 1;
    }
    const dest = o.rest[o.rest.length - 1];
    const sources = o.rest.slice(0, -1);
    const destNode = statNode(ctx, dest);
    if (sources.length > 1 && destNode?.type !== 'dir') {
      io.err(`mv: target '${dest}' is not a directory\n`);
      return 1;
    }
    let code = 0;
    for (const s of sources) {
      try {
        let target = abs(ctx, dest);
        if (destNode?.type === 'dir') target = `${target}/${basename(s)}`;
        const prior = lookup(ctx.sys.fs, target, actor(ctx), false);
        if (prior && prior.node.type !== 'dir') remove(ctx.sys.fs, target, actor(ctx), false);
        move(ctx.sys.fs, abs(ctx, s), target, actor(ctx), ctx.sys.now);
        if (o.flags.has('v')) io.out(`renamed '${s}' -> '${dest}'\n`);
      } catch (e) {
        io.err(`mv: cannot move '${s}': ${errText(e, s).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    return code;
  },

  ln: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.rest.length < 1) {
      io.err('ln: missing file operand\n');
      return 1;
    }
    const [target, linkName = basename(o.rest[0])] = o.rest;
    let dest = abs(ctx, linkName);
    // -n / -T: treat an existing symlink to a directory as a file to replace, not a directory to enter.
    const noDeref = o.flags.has('n') || o.flags.has('T') || o.flags.has('no-dereference');
    const raw = lookup(ctx.sys.fs, dest, actor(ctx), false);
    const existing = noDeref && raw?.node.type === 'link' ? null : statNode(ctx, linkName);
    if (existing?.type === 'dir') dest = `${dest}/${basename(target)}`;
    if (lookup(ctx.sys.fs, dest, actor(ctx), false)) {
      if (!o.flags.has('f')) {
        io.err(`ln: failed to create link '${linkName}': File exists\n`);
        return 1;
      }
      remove(ctx.sys.fs, dest, actor(ctx), false);
    }
    try {
      const parent = lookup(ctx.sys.fs, dirname(dest), actor(ctx));
      if (!parent || parent.node.type !== 'dir') throw new FsError('ENOENT', 'No such file or directory');
      if (!can(parent.node, actor(ctx), 'w')) throw new FsError('EACCES', 'Permission denied');
      if (o.flags.has('s')) {
        parent.node.children[basename(dest)] = { type: 'link', target, mode: 0o777, owner: currentUser(ctx), group: actor(ctx).groups[0], mtime: ctx.sys.now };
      } else {
        const src = lookup(ctx.sys.fs, abs(ctx, target), actor(ctx));
        if (!src) throw new FsError('ENOENT', `failed to access '${target}': No such file or directory`);
        if (src.node.type === 'dir') throw new FsError('EISDIR', `${target}: hard link not allowed for directory`);
        parent.node.children[basename(dest)] = src.node; // same node: a true hard link
      }
      return 0;
    } catch (e) {
      io.err(`ln: ${errText(e, linkName)}\n`);
      return 1;
    }
  },

  find: (args, io, ctx) => {
    let i = 0;
    const paths: string[] = [];
    while (i < args.length && !args[i].startsWith('-')) paths.push(args[i++]);
    if (!paths.length) paths.push('.');
    type Pred = (path: string, node: FsNode, depth: number) => boolean;
    const preds: Pred[] = [];
    let maxDepth = Infinity;
    let doDelete = false;
    let printType: 'name' | 'ls' | 'zero' = 'name';
    const execs: Array<{ cmd: string[]; batch: boolean }> = [];
    while (i < args.length) {
      const a = args[i++];
      const v = args[i];
      switch (a) {
        case '-name': i++; preds.push((p) => globMatch(v, basename(p))); break;
        case '-iname': i++; preds.push((p) => globMatch(v.toLowerCase(), basename(p).toLowerCase())); break;
        case '-path': i++; preds.push((p) => globMatch(v, p)); break;
        case '-type': i++; preds.push((_, n) => (v === 'f' ? n.type === 'file' : v === 'd' ? n.type === 'dir' : v === 'l' ? n.type === 'link' : false)); break;
        case '-user': i++; preds.push((_, n) => n.owner === v); break;
        case '-group': i++; preds.push((_, n) => n.group === v); break;
        case '-perm': {
          i++;
          const any = v.startsWith('/');
          const atLeast = v.startsWith('-');
          const m = parseInt(v.replace(/^[-/]/, ''), 8);
          preds.push((_, n) => (any ? (n.mode & m) !== 0 : atLeast ? (n.mode & m) === m : (n.mode & 0o7777) === m));
          break;
        }
        case '-empty': preds.push((_, n) => (n.type === 'file' ? n.content === '' : n.type === 'dir' ? Object.keys(n.children).length === 0 : false)); break;
        case '-size': {
          i++;
          const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(v);
          if (!m) { io.err(`find: invalid -size argument '${v}'\n`); return 1; }
          const mult = { '': 512, c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[3]] ?? 1;
          const limit = Number(m[2]) * mult;
          preds.push((_, n) => (m[1] === '+' ? sizeOf(n) > limit : m[1] === '-' ? sizeOf(n) < limit : Math.ceil(sizeOf(n) / mult) === Number(m[2])));
          break;
        }
        case '-mtime': {
          i++;
          const days = Number(v.replace(/^[+-]/, ''));
          preds.push((_, n) => {
            const age = (ctx.sys.now - n.mtime) / 86400000;
            return v.startsWith('+') ? age > days : v.startsWith('-') ? age < days : Math.floor(age) === days;
          });
          break;
        }
        case '-newer': { i++; const ref = statNode(ctx, v); preds.push((_, n) => !!ref && n.mtime > ref.mtime); break; }
        case '-maxdepth': i++; maxDepth = Number(v); break;
        case '-mindepth': i++; { const md = Number(v); preds.push((_p, _n, d) => d >= md); } break;
        case '-delete': doDelete = true; break;
        case '-print': break;
        case '-print0': printType = 'zero'; break;
        case '-mmin': {
          i++;
          const mins = Number(v.replace(/^[+-]/, ''));
          preds.push((_, n) => {
            const age = (ctx.sys.now - n.mtime) / 60000;
            return v.startsWith('+') ? age > mins : v.startsWith('-') ? age < mins : Math.floor(age) === mins;
          });
          break;
        }
        case '-ls': printType = 'ls'; break;
        case '-not': case '!': { const next = args[i]; i++; const sub = args[i]; i++; const p = makeSimplePred(next, sub); if (p) preds.push((a1, b1, c1) => !p(a1, b1, c1)); break; }
        case '-o': case '-or': case '-a': case '-and': break;
        case '-exec': {
          // -exec cmd {} \; runs once per file; -exec cmd {} + runs once with all of them.
          const cmd: string[] = [];
          i--;
          while (i < args.length && args[i] !== ';' && args[i] !== '+') cmd.push(args[i++]);
          if (i >= args.length) { io.err("find: missing argument to `-exec'\n"); return 1; }
          execs.push({ cmd, batch: args[i] === '+' });
          i++;
          break;
        }
        default:
          io.err(`find: unknown predicate '${a}'\n`);
          return 1;
      }
    }
    function makeSimplePred(name: string, v: string): Pred | null {
      if (name === '-name') return (p) => globMatch(v, basename(p));
      if (name === '-type') return (_, n) => (v === 'f' ? n.type === 'file' : v === 'd' ? n.type === 'dir' : false);
      if (name === '-user') return (_, n) => n.owner === v;
      if (name === '-path') return (p) => globMatch(v, p);
      return null;
    }
    let code = 0;
    const toDelete: string[] = [];
    const found: string[] = [];
    for (const start of paths) {
      const base = abs(ctx, start);
      const baseDepth = base === '/' ? 0 : base.split('/').length - 1;
      try {
        walk(ctx.sys.fs, base, actor(ctx), (p, n) => {
          const depth = (p === '/' ? 0 : p.split('/').length - 1) - baseDepth;
          if (depth > maxDepth) return;
          if (!preds.every((f) => f(p, n, depth))) return;
          const shown = start === '.' ? (p === base ? '.' : './' + p.slice(base.length + 1)) : base === '/' ? p : start.replace(/\/$/, '') + (p === base ? '' : p.slice(base.length));
          if (doDelete) toDelete.push(p);
          else if (execs.length) found.push(shown);
          else if (printType === 'zero') io.out(shown + '\0');
          else if (printType === 'ls') io.out(`${modeString(n)} ${n.owner} ${n.group} ${String(sizeOf(n)).padStart(6)} ${lsDate(n.mtime)} ${shown}\n`);
          else io.out(shown + '\n');
        });
      } catch (e) {
        io.err(`find: '${start}': ${errText(e, start).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    for (const e of execs) {
      if (e.batch) {
        if (found.length) code = Math.max(code, runCommand(ctx, e.cmd.flatMap((w) => (w === '{}' ? found : [w])), { stdin: '', out: io.out, err: io.err }) ? 1 : 0);
      } else for (const p of found) code = Math.max(code, runCommand(ctx, e.cmd.map((w) => w.split('{}').join(p)), { stdin: '', out: io.out, err: io.err }) ? 1 : 0);
    }
    for (const p of toDelete.sort((a, b) => b.length - a.length)) {
      try {
        remove(ctx.sys.fs, p, actor(ctx), true);
      } catch (e) {
        io.err(`find: cannot delete '${p}': ${errText(e, p).replace(/^.*?: /, '')}\n`);
        code = 1;
      }
    }
    return code;
  },

  locate: (args, io, ctx) => {
    const pat = args.find((a) => !a.startsWith('-')) ?? '';
    walk(ctx.sys.fs, '/', { user: 'root', groups: ['root'] }, (p) => {
      if (p.includes(pat)) io.out(p + '\n');
    });
    return 0;
  },

  tree: (args, io, ctx) => {
    const o = parseOpts(args, ['L']);
    const start = o.rest[0] ?? '.';
    const max = o.values.L ? Number(o.values.L) : Infinity;
    const l = lookup(ctx.sys.fs, abs(ctx, start), actor(ctx));
    if (!l) {
      io.err(`${start}  [error opening dir]\n`);
      return 1;
    }
    let dirs = 0;
    let files = 0;
    io.out(start + '\n');
    const rec = (n: FsNode, prefix: string, depth: number) => {
      if (n.type !== 'dir' || depth > max) return;
      const names = Object.keys(n.children)
        .filter((k) => o.flags.has('a') || !k.startsWith('.'))
        .sort();
      names.forEach((name, k) => {
        const last = k === names.length - 1;
        const child = n.children[name];
        io.out(`${prefix}${last ? '└── ' : '├── '}${name}${child.type === 'link' ? ' -> ' + child.target : ''}\n`);
        if (child.type === 'dir') dirs++;
        else files++;
        rec(child, prefix + (last ? '    ' : '│   '), depth + 1);
      });
    };
    rec(l.node, '', 1);
    io.out(`\n${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}\n`);
    return 0;
  },

  du: (args, io, ctx) => {
    const o = parseOpts(args);
    const targets = o.rest.length ? o.rest : ['.'];
    const fmt = (n: number) => (o.flags.has('h') ? humanSize(n) : o.flags.has('b') ? String(n) : String(Math.ceil(n / 1024)));
    for (const t of targets) {
      const l = lookup(ctx.sys.fs, abs(ctx, t), actor(ctx));
      if (!l) {
        io.err(`du: cannot access '${t}': No such file or directory\n`);
        continue;
      }
      if (o.flags.has('s') || l.node.type !== 'dir') {
        io.out(`${fmt(totalSize(l.node))}\t${t}\n`);
        continue;
      }
      walk(ctx.sys.fs, l.path, actor(ctx), (p, n) => {
        if (n.type === 'dir' || o.flags.has('a')) io.out(`${fmt(totalSize(n))}\t${p === l.path ? t : t.replace(/\/$/, '') + p.slice(l.path.length)}\n`);
      });
    }
    return 0;
  },

  df: (args, io, ctx) => {
    const h = args.includes('-h');
    const used = totalSize(ctx.sys.fs);
    const total = 40 * 1024 ** 3;
    const row = (fs: string, size: number, use: number, mount: string) =>
      `${fs.padEnd(16)}${(h ? humanSize(size) : String(Math.round(size / 1024))).padStart(9)} ${(h ? humanSize(use) : String(Math.round(use / 1024))).padStart(8)} ${(h ? humanSize(size - use) : String(Math.round((size - use) / 1024))).padStart(9)} ${String(Math.round((use / size) * 100) + '%').padStart(4)} ${mount}\n`;
    io.out(`Filesystem      ${h ? '    Size' : '1K-blocks'}     Used Available Use% Mounted on\n`);
    io.out(row('/dev/sda2', total, used + 6 * 1024 ** 3, '/'));
    io.out(row('/dev/sda1', 512 * 1024 ** 2, 50 * 1024 ** 2, '/boot/efi'));
    io.out(row('tmpfs', 2 * 1024 ** 3, 0, '/tmp'));
    return 0;
  },

  stat: (args, io, ctx) => {
    let code = 0;
    const o = parseOpts(args, ['c']);
    for (const f of o.rest) {
      const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx), false);
      if (!l) {
        io.err(`stat: cannot statx '${f}': No such file or directory\n`);
        code = 1;
        continue;
      }
      const n = l.node;
      if (o.values.c) {
        io.out(
          o.values.c
            .replace(/%a/g, (n.mode & 0o7777).toString(8))
            .replace(/%A/g, modeString(n))
            .replace(/%U/g, n.owner)
            .replace(/%G/g, n.group)
            .replace(/%s/g, String(sizeOf(n)))
            .replace(/%n/g, f)
            .replace(/%F/g, n.type === 'dir' ? 'directory' : n.type === 'link' ? 'symbolic link' : 'regular file') + '\n',
        );
        continue;
      }
      const uid = ctx.sys.users[n.owner]?.uid ?? 0;
      const gid = ctx.sys.groups[n.group]?.gid ?? 0;
      io.out(`  File: ${f}${n.type === 'link' ? ` -> ${n.target}` : ''}\n  Size: ${sizeOf(n)}\t\tBlocks: ${Math.ceil(sizeOf(n) / 512)}\tIO Block: 4096   ${n.type === 'dir' ? 'directory' : n.type === 'link' ? 'symbolic link' : 'regular file'}\nAccess: (${(n.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(n)})  Uid: (${String(uid).padStart(5)}/${n.owner.padEnd(8)})   Gid: (${String(gid).padStart(5)}/${n.group.padEnd(8)})\nModify: ${new Date(n.mtime).toISOString().replace('T', ' ').slice(0, 19)}.000000000 +0000\n`);
    }
    return code;
  },

  file: (args, io, ctx) => {
    for (const f of parseOpts(args).rest) {
      const n = statNode(ctx, f);
      if (!n) io.out(`${f}: cannot open (No such file or directory)\n`);
      else if (n.type === 'dir') io.out(`${f}: directory\n`);
      else if (n.type === 'link') io.out(`${f}: symbolic link to ${n.target}\n`);
      else if (n.content.startsWith('#CSLAB-TAR')) io.out(`${f}: POSIX tar archive${f.endsWith('.gz') || f.endsWith('.tgz') ? ' (gzip compressed data)' : ''}\n`);
      else if (n.content.startsWith('#CSLAB-GZ')) io.out(`${f}: gzip compressed data\n`);
      else if (n.content.startsWith('#!')) io.out(`${f}: ${n.content.slice(2, n.content.indexOf('\n'))} script, ASCII text executable\n`);
      else if (n.content === '') io.out(`${f}: empty\n`);
      else io.out(`${f}: ASCII text\n`);
    }
    return 0;
  },

  chmod: (args, io, ctx) => {
    const o = parseOpts(args);
    const [spec, ...files] = o.rest;
    if (!spec || !files.length) {
      io.err('chmod: missing operand\n');
      return 1;
    }
    let code = 0;
    for (const f of files) {
      const apply = (p: string, n: FsNode) => {
        if (n.type === 'link') return;
        if (currentUser(ctx) !== 'root' && n.owner !== currentUser(ctx)) throw new FsError('EACCES', `changing permissions of '${p}': Operation not permitted`);
        const m = parseMode(spec, n.mode, n.type === 'dir');
        if (m === null) throw new Error(`invalid mode: '${spec}'`);
        n.mode = m;
      };
      try {
        const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
        if (!l) throw new FsError('ENOENT', `cannot access '${f}': No such file or directory`);
        if (o.flags.has('R')) walk(ctx.sys.fs, l.path, actor(ctx), apply);
        else apply(f, l.node);
        if (o.flags.has('v')) io.out(`mode of '${f}' changed to ${(l.node.mode & 0o7777).toString(8).padStart(4, '0')} (${modeString(l.node).slice(1, 10)})\n`);
      } catch (e) {
        io.err(`chmod: ${e instanceof FsError ? e.message : (e as Error).message}\n`);
        code = 1;
      }
    }
    return code;
  },

  chown: (args, io, ctx) => chownLike(args, io, ctx, 'chown'),
  chgrp: (args, io, ctx) => chownLike(args, io, ctx, 'chgrp'),

  getfacl: (args, io, ctx) => {
    let code = 0;
    for (const f of parseOpts(args).rest) {
      const n = statNode(ctx, f);
      if (!n) {
        io.err(`getfacl: ${f}: No such file or directory\n`);
        code = 1;
        continue;
      }
      const rwx = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
      io.out(`# file: ${f.replace(/^\//, '')}\n# owner: ${n.owner}\n# group: ${n.group}\n`);
      if (n.mode & 0o4000) io.out('# flags: s--\n');
      const own = (n.acl ?? []).filter((a) => !a.def);
      const defs = (n.acl ?? []).filter((a) => a.def);
      io.out(`user::${rwx(n.mode >> 6)}\n`);
      for (const a of own) if (a.kind === 'user') io.out(`user:${a.name}:${a.perms}\n`);
      io.out(`group::${rwx(n.mode >> 3)}\n`);
      for (const a of own) if (a.kind === 'group') io.out(`group:${a.name}:${a.perms}\n`);
      if (own.length) io.out('mask::rwx\n');
      io.out(`other::${rwx(n.mode)}\n`);
      if (defs.length) {
        io.out(`default:user::${rwx(n.mode >> 6)}\n`);
        for (const a of defs) if (a.kind === 'user') io.out(`default:user:${a.name}:${a.perms}\n`);
        io.out(`default:group::${rwx(n.mode >> 3)}\n`);
        for (const a of defs) if (a.kind === 'group') io.out(`default:group:${a.name}:${a.perms}\n`);
        io.out(`default:mask::rwx\ndefault:other::${rwx(n.mode)}\n`);
      }
      io.out('\n');
    }
    return code;
  },

  setfacl: (args, io, ctx) => {
    const o = parseOpts(args, ['m', 'x']);
    const files = o.rest;
    if (!files.length) {
      io.err('setfacl: missing file operand\n');
      return 2;
    }
    let code = 0;
    for (const f of files) {
      const apply = (p: string, n: FsNode) => {
        if (n.type === 'link') return;
        if (currentUser(ctx) !== 'root' && n.owner !== currentUser(ctx)) throw new FsError('EACCES', `${p}: Operation not permitted`);
        if (o.flags.has('b')) n.acl = [];
        if (o.flags.has('k')) n.acl = (n.acl ?? []).filter((a) => !a.def);
        if (o.values.m) {
          for (const raw of o.values.m.split(',')) {
            // -d, or a d:/default: prefix, makes a default entry on a directory.
            const isDef = o.flags.has('d') || /^(d|default):/.test(raw.trim());
            const entry = raw.trim().replace(/^(d|default):/, '');
            if (isDef) {
              if (n.type !== 'dir') throw new Error(`${p}: Only directories can have default ACLs`);
              const d = /^(u|user|g|group):([^:]+):([rwx-]*)$/.exec(entry);
              if (!d) {
                if (/^(u|user|g|group|o|other|m|mask):?:[rwx-]*$/.test(entry)) continue;
                throw new Error(`Invalid argument: ${raw}`);
              }
              const dk = d[1].startsWith('u') ? 'user' : 'group';
              if (dk === 'user' && !ctx.sys.users[d[2]]) throw new Error(`Option -m: Invalid argument near character 3 (no such user: ${d[2]})`);
              if (dk === 'group' && !ctx.sys.groups[d[2]]) throw new Error(`Option -m: Invalid argument near character 3 (no such group: ${d[2]})`);
              const dp = `${d[3].includes('r') ? 'r' : '-'}${d[3].includes('w') ? 'w' : '-'}${d[3].includes('x') ? 'x' : '-'}`;
              n.acl = (n.acl ?? []).filter((a) => !(a.def && a.kind === dk && a.name === d[2]));
              n.acl.push({ kind: dk, name: d[2], perms: dp, def: true });
              continue;
            }
            const m = /^(u|user|g|group|o|other|m|mask):([^:]*):([rwx-]*)$/.exec(entry);
            if (!m) throw new Error(`Invalid argument: ${entry}`);
            const kind = m[1].startsWith('u') ? 'user' : m[1].startsWith('g') ? 'group' : null;
            const perms = `${m[3].includes('r') ? 'r' : '-'}${m[3].includes('w') ? 'w' : '-'}${m[3].includes('x') ? 'x' : '-'}`;
            if (!kind || m[2] === '') {
              // Base entries change the mode bits.
              const bits = (m[3].includes('r') ? 4 : 0) | (m[3].includes('w') ? 2 : 0) | (m[3].includes('x') ? 1 : 0);
              if (m[1].startsWith('u')) n.mode = (n.mode & ~0o700) | (bits << 6);
              else if (m[1].startsWith('g')) n.mode = (n.mode & ~0o070) | (bits << 3);
              else if (m[1].startsWith('o')) n.mode = (n.mode & ~0o007) | bits;
              continue;
            }
            if (kind === 'user' && !ctx.sys.users[m[2]]) throw new Error(`Option -m: Invalid argument near character 3 (no such user: ${m[2]})`);
            if (kind === 'group' && !ctx.sys.groups[m[2]]) throw new Error(`Option -m: Invalid argument near character 3 (no such group: ${m[2]})`);
            n.acl = (n.acl ?? []).filter((a) => !(!a.def && a.kind === kind && a.name === m[2]));
            n.acl.push({ kind, name: m[2], perms });
          }
        }
        if (o.values.x) {
          for (const raw of o.values.x.split(',')) {
            const isDef = o.flags.has('d') || /^(d|default):/.test(raw.trim());
            const entry = raw.trim().replace(/^(d|default):/, '');
            const m = /^(u|user|g|group):([^:]*)$/.exec(entry);
            if (!m) throw new Error(`Invalid argument: ${raw}`);
            const kind = m[1].startsWith('u') ? 'user' : 'group';
            n.acl = (n.acl ?? []).filter((a) => !(!!a.def === isDef && a.kind === kind && a.name === m[2]));
          }
        }
      };
      try {
        const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
        if (!l) throw new Error(`${f}: No such file or directory`);
        if (o.flags.has('R')) walk(ctx.sys.fs, l.path, actor(ctx), apply);
        else apply(f, l.node);
      } catch (e) {
        io.err(`setfacl: ${(e as Error).message}\n`);
        code = 1;
      }
    }
    return code;
  },

  basename: (args, io) => {
    const [p, suffix] = args.filter((a) => !a.startsWith('-'));
    let b = basename(p ?? '');
    if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
    io.out(b + '\n');
    return 0;
  },
  dirname: (args, io) => {
    io.out(dirname(args[0] ?? '') + '\n');
    return 0;
  },
  realpath: (args, io, ctx) => {
    io.out(abs(ctx, args[0] ?? '.') + '\n');
    return 0;
  },
  readlink: (args, io, ctx) => {
    const f = args.filter((a) => !a.startsWith('-'))[0];
    const l = f ? lookup(ctx.sys.fs, abs(ctx, f), actor(ctx), false) : null;
    if (!l || l.node.type !== 'link') return 1;
    io.out((args.includes('-f') ? abs(ctx, l.node.target) : l.node.target) + '\n');
    return 0;
  },

  tar: (args, io, ctx) => {
    // Accept "tar -czvf file.tar.gz a b", "tar czf ...", "tar -xzf file -C dir", "tar -tf file".
    let flags = args[0] ?? '';
    if (!flags.startsWith('-')) flags = '-' + flags;
    const o = parseOpts([flags, ...args.slice(1)], ['f', 'C']);
    const mode = o.flags.has('c') ? 'c' : o.flags.has('x') ? 'x' : o.flags.has('t') ? 't' : null;
    if (!mode) {
      io.err("tar: You must specify one of the '-c', '-x' or '-t' options\n");
      return 2;
    }
    const archive = o.values.f;
    if (!archive) {
      io.err('tar: Refusing to read/write archive contents from terminal (give -f FILE)\n');
      return 2;
    }
    const verbose = o.flags.has('v');
    interface Entry { path: string; type: 'file' | 'dir' | 'link'; content?: string; target?: string; mode: number; owner: string; group: string; mtime: number }
    if (mode === 'c') {
      if (!o.rest.length) {
        io.err('tar: Cowardly refusing to create an empty archive\n');
        return 2;
      }
      const entries: Entry[] = [];
      const base = o.values.C ? abs(ctx, o.values.C) : ctx.sys.cwd;
      for (const r of o.rest) {
        const start = normalise(r.startsWith('/') ? r : `${base}/${r}`);
        try {
          walk(ctx.sys.fs, start, actor(ctx), (p, n) => {
            const rel = r.startsWith('/') ? p.slice(1) : (r === '.' || r === './' ? '.' : r.replace(/\/$/, '')) + p.slice(start === '/' ? 0 : start.length);
            const name = n.type === 'dir' ? rel + '/' : rel;
            if (n.type === 'file' && !can(n, actor(ctx), 'r')) {
              io.err(`tar: ${name}: Cannot open: Permission denied\n`);
              return;
            }
            entries.push({ path: name, type: n.type, content: n.type === 'file' ? n.content : undefined, target: n.type === 'link' ? n.target : undefined, mode: n.mode, owner: n.owner, group: n.group, mtime: n.mtime });
            if (verbose) io.out(name + '\n');
          });
        } catch (e) {
          io.err(`tar: ${errText(e, r)}: Cannot stat: No such file or directory\n`);
          return 2;
        }
        if (r.startsWith('/')) io.err("tar: Removing leading `/' from member names\n");
      }
      try {
        writeFile(ctx.sys.fs, abs(ctx, archive), '#CSLAB-TAR\n' + JSON.stringify(entries), actor(ctx), ctx.sys.now);
      } catch (e) {
        io.err(`tar: ${errText(e, archive)}: Cannot open\n`);
        return 2;
      }
      return 0;
    }
    let raw: string;
    try {
      raw = readFile(ctx.sys.fs, abs(ctx, archive), actor(ctx));
    } catch (e) {
      io.err(`tar: ${errText(e, archive)}: Cannot open\n`);
      return 2;
    }
    if (!raw.startsWith('#CSLAB-TAR\n')) {
      io.err('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n');
      return 2;
    }
    const entries = JSON.parse(raw.slice('#CSLAB-TAR\n'.length)) as Entry[];
    if (mode === 't') {
      for (const e of entries) io.out(verbose ? `${modeString({ ...e, type: e.type, content: '', children: {} } as unknown as FsNode)} ${e.owner}/${e.group} ${String(e.content?.length ?? 0).padStart(7)} ${e.path}\n` : e.path + '\n');
      return 0;
    }
    const dest = o.values.C ? abs(ctx, o.values.C) : ctx.sys.cwd;
    const only = new Set(o.rest);
    for (const e of entries) {
      if (only.size && ![...only].some((s) => e.path === s || e.path.startsWith(s.replace(/\/$/, '') + '/'))) continue;
      const target = `${dest}/${e.path.replace(/\/$/, '')}`;
      try {
        if (e.type === 'dir') {
          mkdir(ctx.sys.fs, target, actor(ctx), ctx.sys.now, true);
        } else {
          mkdir(ctx.sys.fs, dirname(target), actor(ctx), ctx.sys.now, true);
          if (e.type === 'link') {
            const parent = lookup(ctx.sys.fs, dirname(target), actor(ctx))!.node as DirNode;
            parent.children[basename(target)] = { type: 'link', target: e.target ?? '', mode: 0o777, owner: currentUser(ctx), group: actor(ctx).groups[0], mtime: e.mtime };
          } else writeFile(ctx.sys.fs, target, e.content ?? '', actor(ctx), ctx.sys.now);
        }
        const n = lookup(ctx.sys.fs, target, actor(ctx), false)?.node;
        if (n) {
          n.mode = e.mode;
          n.mtime = e.mtime;
          if (currentUser(ctx) === 'root') {
            n.owner = e.owner;
            n.group = e.group;
          }
        }
        if (verbose) io.out(e.path + '\n');
      } catch (err) {
        io.err(`tar: ${e.path}: Cannot create: ${errText(err, e.path).replace(/^.*?: /, '')}\n`);
      }
    }
    return 0;
  },

  gzip: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.flags.has('d')) return FILE_COMMANDS.gunzip(o.rest, io, ctx);
    let code = 0;
    for (const f of o.rest) {
      try {
        const content = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
        if (f.endsWith('.gz')) {
          io.err(`gzip: ${f} already has .gz suffix -- unchanged\n`);
          continue;
        }
        writeFile(ctx.sys.fs, abs(ctx, f) + '.gz', content.startsWith('#CSLAB-TAR') ? content : '#CSLAB-GZ\n' + content, actor(ctx), ctx.sys.now);
        if (!o.flags.has('k')) remove(ctx.sys.fs, abs(ctx, f), actor(ctx), false);
      } catch (e) {
        io.err(`gzip: ${errText(e, f)}\n`);
        code = 1;
      }
    }
    return code;
  },
  gunzip: (args, io, ctx) => {
    let code = 0;
    for (const f of parseOpts(args).rest) {
      try {
        if (!f.endsWith('.gz')) {
          io.err(`gzip: ${f}: unknown suffix -- ignored\n`);
          code = 1;
          continue;
        }
        const content = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
        writeFile(ctx.sys.fs, abs(ctx, f.slice(0, -3)), content.startsWith('#CSLAB-GZ\n') ? content.slice('#CSLAB-GZ\n'.length) : content, actor(ctx), ctx.sys.now);
        remove(ctx.sys.fs, abs(ctx, f), actor(ctx), false);
      } catch (e) {
        io.err(`gzip: ${errText(e, f)}\n`);
        code = 1;
      }
    }
    return code;
  },
  zcat: (args, io, ctx) => {
    for (const f of args) {
      try {
        const c = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
        io.out(c.startsWith('#CSLAB-GZ\n') ? c.slice('#CSLAB-GZ\n'.length) : c);
      } catch (e) {
        io.err(`zcat: ${errText(e, f)}\n`);
        return 1;
      }
    }
    return 0;
  },

  rsync: (args, io, ctx) => {
    // --exclude may repeat, so collect it by hand; parseOpts keeps only the last value.
    const excludes: string[] = [];
    const plain: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--exclude') excludes.push(args[++i] ?? '');
      else if (a.startsWith('--exclude=')) excludes.push(a.slice(10));
      else plain.push(a);
    }
    const o = parseOpts(plain, ['e'], { 'dry-run': 'n', verbose: 'v', archive: 'a', recursive: 'r' });
    if (o.rest.length < 2) {
      io.err('rsync: usage: rsync [OPTION]... SRC DEST\n');
      return 1;
    }
    const dest = o.rest[o.rest.length - 1];
    if (dest.includes(':') || o.rest.some((r) => r.includes('@'))) {
      io.err('rsync: remote hosts are not simulated in this lab; use a local destination\n');
      return 1;
    }
    const dry = o.flags.has('n');
    const verbose = o.flags.has('v') || dry;
    const del = o.flags.has('delete');
    const keepExisting = o.flags.has('ignore-existing');
    const me = actor(ctx);
    const excluded = (rel: string, isDir: boolean) =>
      excludes.some((pat) => {
        const dirOnly = pat.endsWith('/');
        const p = pat.replace(/\/$/, '');
        if (dirOnly && !isDir) return false;
        const name = rel.split('/').pop() ?? rel;
        return p.startsWith('/') ? globMatch(p.slice(1), rel) : p.includes('/') ? globMatch(p, rel) : globMatch(p, name);
      });
    let count = 0;
    const sync = (srcPath: string, dstPath: string, rel: string) => {
      const src = lookup(ctx.sys.fs, srcPath, me)!.node as DirNode;
      if (!dry) mkdir(ctx.sys.fs, dstPath, me, ctx.sys.now, true);
      const dst = lookup(ctx.sys.fs, dstPath, me)?.node as DirNode | undefined;
      for (const [name, child] of Object.entries(src.children)) {
        const r = rel ? `${rel}/${name}` : name;
        if (excluded(r, child.type === 'dir')) continue;
        if (child.type === 'dir') {
          if (verbose) io.out(`${r}/\n`);
          sync(`${srcPath}/${name}`, `${dstPath}/${name}`, r);
          continue;
        }
        const prior = dst?.children[name];
        if (prior && keepExisting) continue;
        if (prior?.type === 'file' && child.type === 'file' && prior.content === child.content) continue;
        if (verbose) io.out(`${r}\n`);
        count++;
        if (dry) continue;
        if (prior) remove(ctx.sys.fs, `${dstPath}/${name}`, me, true);
        copy(ctx.sys.fs, `${srcPath}/${name}`, `${dstPath}/${name}`, me, ctx.sys.now, true);
      }
      if (del && dst) {
        for (const name of Object.keys(dst.children)) {
          const r = rel ? `${rel}/${name}` : name;
          if (src.children[name] || excluded(r, dst.children[name].type === 'dir')) continue;
          if (verbose) io.out(`deleting ${r}${dst.children[name].type === 'dir' ? '/' : ''}\n`);
          if (!dry) remove(ctx.sys.fs, `${dstPath}/${name}`, me, true);
        }
      }
    };
    for (const s of o.rest.slice(0, -1)) {
      const src = lookup(ctx.sys.fs, abs(ctx, s), me);
      if (!src) {
        io.err(`rsync: link_stat "${abs(ctx, s)}" failed: No such file or directory (2)\n`);
        return 23;
      }
      let target = abs(ctx, dest);
      if (src.node.type === 'dir') {
        if (!o.flags.has('a') && !o.flags.has('r')) {
          io.err(`skipping directory ${s}\n`);
          continue;
        }
        if (!s.endsWith('/')) target = `${target}/${basename(s)}`;
        sync(src.path, target, '');
      } else {
        if (!dry) mkdir(ctx.sys.fs, dirname(target) || '/', me, ctx.sys.now, true);
        const t = lookup(ctx.sys.fs, target, me)?.node.type === 'dir' || dest.endsWith('/') ? `${target}/${basename(s)}` : target;
        if (keepExisting && lookup(ctx.sys.fs, t, me)) continue;
        if (verbose) io.out(`${basename(s)}\n`);
        count++;
        if (dry) continue;
        if (dest.endsWith('/')) mkdir(ctx.sys.fs, target, me, ctx.sys.now, true);
        if (lookup(ctx.sys.fs, t, me)) remove(ctx.sys.fs, t, me, false);
        copy(ctx.sys.fs, src.path, t, me, ctx.sys.now, false);
      }
    }
    if (verbose) io.out(`\nsent ${count * 120} bytes  received ${count * 35} bytes  total size ${count * 100}${dry ? ' (DRY RUN)' : ''}\n`);
    return 0;
  },

  dd: (args, io, ctx) => {
    const kv = Object.fromEntries(args.map((a) => a.split('=') as [string, string]));
    if (!kv.if || !kv.of) {
      io.err('dd: usage: dd if=SOURCE of=TARGET\n');
      return 1;
    }
    try {
      const content = kv.if === '/dev/zero' ? '\0'.repeat(Number(kv.count ?? 1) * 512) : readFile(ctx.sys.fs, abs(ctx, kv.if), actor(ctx));
      if (kv.of.startsWith('/dev/')) {
        io.out(`${Math.ceil(content.length / 512)}+0 records in\n${Math.ceil(content.length / 512)}+0 records out\n`);
        return 0;
      }
      writeFile(ctx.sys.fs, abs(ctx, kv.of), content, actor(ctx), ctx.sys.now);
      io.out(`${Math.ceil(content.length / 512)}+0 records in\n${Math.ceil(content.length / 512)}+0 records out\n${content.length} bytes copied, 0.001 s\n`);
      return 0;
    } catch (e) {
      io.err(`dd: ${errText(e, kv.if)}\n`);
      return 1;
    }
  },

  mount: (_a, io) => {
    io.out('/dev/sda2 on / type ext4 (rw,relatime)\n/dev/sda1 on /boot/efi type vfat (rw,relatime)\ntmpfs on /tmp type tmpfs (rw,nosuid,nodev)\n');
    return 0;
  },
  lsblk: (_a, io) => {
    io.out('NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nsda      8:0    0   40G  0 disk\n├─sda1   8:1    0  512M  0 part /boot/efi\n└─sda2   8:2    0 39.5G  0 part /\n');
    return 0;
  },
};

function chownLike(args: string[], io: IO, ctx: Ctx, cmd: 'chown' | 'chgrp'): number {
  const o = parseOpts(args);
  const [spec, ...files] = o.rest;
  if (!spec || !files.length) {
    io.err(`${cmd}: missing operand\n`);
    return 1;
  }
  let owner: string | null = null;
  let group: string | null = null;
  if (cmd === 'chgrp') group = spec;
  else {
    const [u, g] = spec.split(/[:.]/);
    owner = u || null;
    group = g === undefined ? null : g === '' ? (owner ? groupName(ctx.sys, ctx.sys.users[owner]?.gid ?? 0) : null) : g;
  }
  if (owner && !ctx.sys.users[owner]) {
    io.err(`${cmd}: invalid user: '${spec}'\n`);
    return 1;
  }
  if (group && !ctx.sys.groups[group]) {
    io.err(`${cmd}: invalid group: '${spec}'\n`);
    return 1;
  }
  let code = 0;
  for (const f of files) {
    const apply = (p: string, n: FsNode) => {
      const me = currentUser(ctx);
      if (me !== 'root') {
        if (owner && owner !== n.owner) throw new FsError('EACCES', `changing ownership of '${p}': Operation not permitted`);
        if (group && (n.owner !== me || !actor(ctx).groups.includes(group))) throw new FsError('EACCES', `changing group of '${p}': Operation not permitted`);
      }
      if (owner) n.owner = owner;
      if (group) n.group = group;
    };
    try {
      const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
      if (!l) throw new FsError('ENOENT', `cannot access '${f}': No such file or directory`);
      if (o.flags.has('R')) walk(ctx.sys.fs, l.path, actor(ctx), apply);
      else apply(f, l.node);
    } catch (e) {
      io.err(`${cmd}: ${e instanceof FsError ? e.message : (e as Error).message}\n`);
      code = 1;
    }
  }
  return code;
}
