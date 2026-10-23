/** The command table, plus test/[ which needs the file system. */

import { can, lookup } from './fs.js';
import { actor, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { FILE_COMMANDS } from './commands-files.js';
import { TEXT_COMMANDS } from './commands-text.js';
import { ADMIN_COMMANDS } from './commands-admin.js';
import { SYSADMIN_COMMANDS } from './commands-sysadmin.js';
import { GIT_COMMANDS } from './commands-git.js';
import { DOCKER_COMMANDS } from './commands-docker.js';

export type { IO } from './util.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/** Evaluates a test expression (the words between [ and ]). */
export function evalTest(ctx: Ctx, args: string[], io: IO): number {
  let i = 0;
  const peek = () => args[i];
  const next = () => args[i++];
  const fileOf = (p: string) => {
    try {
      return lookup(ctx.sys.fs, abs(ctx, p), actor(ctx));
    } catch {
      return null;
    }
  };
  const num = (s: string) => {
    if (!/^-?\d+$/.test(s)) throw new Error(`integer expression expected: ${s}`);
    return Number(s);
  };
  function orExpr(): boolean {
    let v = andExpr();
    while (peek() === '-o' || peek() === '||') {
      next();
      const r = andExpr();
      v = v || r;
    }
    return v;
  }
  function andExpr(): boolean {
    let v = notExpr();
    while (peek() === '-a' || peek() === '&&') {
      next();
      const r = notExpr();
      v = v && r;
    }
    return v;
  }
  function notExpr(): boolean {
    if (peek() === '!') {
      next();
      return !notExpr();
    }
    return primary();
  }
  function primary(): boolean {
    const t = next();
    if (t === undefined) return false;
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error("missing ')'");
      return v;
    }
    const unary = ['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-L', '-h', '-O', '-G', '-u', '-g', '-k', '-p', '-S', '-b', '-c', '-t'];
    if (unary.includes(t) && (i < args.length || t === '-z' || t === '-n')) {
      const a = next() ?? '';
      if (t === '-z') return a === '';
      if (t === '-n') return a !== '';
      const f = fileOf(a);
      if (!f) return false;
      const n = f.node;
      switch (t) {
        case '-e': return true;
        case '-f': return n.type === 'file';
        case '-d': return n.type === 'dir';
        case '-L': case '-h': return n.type === 'link';
        case '-r': return can(n, actor(ctx), 'r');
        case '-w': return can(n, actor(ctx), 'w');
        case '-x': return can(n, actor(ctx), 'x');
        case '-s': return n.type === 'file' && n.content.length > 0;
        case '-O': return n.owner === actor(ctx).user;
        case '-G': return n.group === actor(ctx).groups[0];
        case '-u': return (n.mode & 0o4000) !== 0;
        case '-g': return (n.mode & 0o2000) !== 0;
        case '-k': return (n.mode & 0o1000) !== 0;
        default: return false;
      }
    }
    // Binary operator?
    const op = peek();
    if (op !== undefined && ['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '<', '>', '-nt', '-ot', '-ef', '=~'].includes(op)) {
      next();
      const b = next() ?? '';
      switch (op) {
        case '=': case '==': return t === b;
        case '!=': return t !== b;
        case '<': return t < b;
        case '>': return t > b;
        case '-eq': return num(t) === num(b);
        case '-ne': return num(t) !== num(b);
        case '-lt': return num(t) < num(b);
        case '-le': return num(t) <= num(b);
        case '-gt': return num(t) > num(b);
        case '-ge': return num(t) >= num(b);
        case '-nt': { const fa = fileOf(t); const fb = fileOf(b); return !!fa && (!fb || fa.node.mtime > fb.node.mtime); }
        case '-ot': { const fa = fileOf(t); const fb = fileOf(b); return !!fb && (!fa || fa.node.mtime < fb.node.mtime); }
        case '-ef': { const fa = fileOf(t); const fb = fileOf(b); return !!fa && !!fb && fa.node === fb.node; }
        case '=~': {
          const m = new RegExp(b).exec(t);
          if (m) m.forEach((g, k) => (ctx.vars[`BASH_REMATCH_${k}`] = g ?? ''));
          return !!m;
        }
      }
    }
    return t !== '';
  }
  try {
    const v = orExpr();
    if (i < args.length) {
      io.err(`bash: test: ${args[i]}: binary operator expected\n`);
      return 2;
    }
    return v ? 0 : 1;
  } catch (e) {
    io.err(`bash: test: ${(e as Error).message}\n`);
    return 2;
  }
}

const TEST_COMMANDS: Record<string, Cmd> = {
  test: (args, io, ctx) => evalTest(ctx, args, io),
  '[': (args, io, ctx) => {
    if (args[args.length - 1] !== ']') {
      io.err("bash: [: missing `]'\n");
      return 2;
    }
    return evalTest(ctx, args.slice(0, -1), io);
  },
  '[[': (args, io, ctx) => {
    if (args[args.length - 1] !== ']]') {
      io.err("bash: [[: missing `]]'\n");
      return 2;
    }
    return evalTest(ctx, args.slice(0, -1), io);
  },
};

export const COMMANDS: Record<string, Cmd> = { ...FILE_COMMANDS, ...TEXT_COMMANDS, ...ADMIN_COMMANDS, ...SYSADMIN_COMMANDS, ...GIT_COMMANDS, ...DOCKER_COMMANDS, ...TEST_COMMANDS };
