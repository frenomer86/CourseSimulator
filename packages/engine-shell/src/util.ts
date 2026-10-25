/** Shared helpers for simulated commands: option parsing, input reading and formatting. */

import { FsError, lookup, readFile, resolvePath, type FsNode } from './fs.js';
import { homeOf } from './system.js';
import type { Ctx } from './shell.js';
import { actor, currentUser } from './shell.js';

export interface IO {
  stdin: string;
  out(s: string): void;
  err(s: string): void;
  /** True for the terminal's own stdin (nothing piped or redirected), so `read` can explain itself. */
  interactive?: boolean;
  /** Standard output is the terminal (not a pipe, file or command substitution). */
  tty?: boolean;
}

export interface Opts {
  flags: Set<string>;
  values: Record<string, string>;
  rest: string[];
}

/** Parses short and long options. `withArg` lists flags that take a value, e.g. ['n', 'd', 'name']. */
export function parseOpts(args: string[], withArg: string[] = [], longAliases: Record<string, string> = {}, stopAtFirstPositional = false): Opts {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  let i = 0;
  let noMore = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (noMore || a === '-' || !a.startsWith('-')) {
      rest.push(a);
      if (stopAtFirstPositional) noMore = true;
      continue;
    }
    if (a === '--') {
      noMore = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      name = longAliases[name] ?? name;
      if (withArg.includes(name)) values[name] = eq === -1 ? args[++i] ?? '' : a.slice(eq + 1);
      else flags.add(name);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const f = a[k];
      if (withArg.includes(f)) {
        values[f] = k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? '';
        break;
      }
      // Numeric shorthand like head -5 or tail -20.
      if (/\d/.test(f) && k === 1 && /^-\d+$/.test(a)) {
        values.N = a.slice(1);
        break;
      }
      flags.add(f);
    }
  }
  return { flags, values, rest };
}

export function abs(ctx: Ctx, path: string): string {
  return resolvePath(ctx.sys.cwd, path, homeOf(ctx.sys, currentUser(ctx)));
}

/** Reads each named file (or stdin when none / "-"); reports errors and returns the readable ones. */
export function readInputs(ctx: Ctx, io: IO, files: string[], cmd: string): Array<{ name: string; content: string }> {
  if (!files.length) return [{ name: '-', content: io.stdin }];
  const out: Array<{ name: string; content: string }> = [];
  for (const f of files) {
    if (f === '-') {
      out.push({ name: '-', content: io.stdin });
      continue;
    }
    try {
      out.push({ name: f, content: readFile(ctx.sys.fs, abs(ctx, f), actor(ctx)) });
    } catch (e) {
      io.err(`${cmd}: ${errText(e, f)}\n`);
      ctx.status = 1;
    }
  }
  return out;
}

export function errText(e: unknown, path: string): string {
  if (e instanceof FsError) {
    const msg = e.message.includes(': ') ? e.message.slice(e.message.indexOf(': ') + 2) : e.message;
    return `${path}: ${msg}`;
  }
  return `${path}: ${(e as Error).message}`;
}

export function statNode(ctx: Ctx, path: string): FsNode | null {
  const l = lookup(ctx.sys.fs, abs(ctx, path), actor(ctx));
  return l?.node ?? null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function lsDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A subset of strftime, as used by date +FORMAT. */
export function strftime(ms: number, fmt: string): string {
  const d = new Date(ms);
  return fmt.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case 'Y': return String(d.getUTCFullYear());
      case 'y': return pad(d.getUTCFullYear() % 100);
      case 'm': return pad(d.getUTCMonth() + 1);
      case 'd': return pad(d.getUTCDate());
      case 'e': return String(d.getUTCDate()).padStart(2, ' ');
      case 'H': return pad(d.getUTCHours());
      case 'M': return pad(d.getUTCMinutes());
      case 'S': return pad(d.getUTCSeconds());
      case 'F': return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      case 'T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      case 'D': return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear() % 100)}`;
      case 'R': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      case 'a': return DAYS[d.getUTCDay()];
      case 'A': return DAYS_LONG[d.getUTCDay()];
      case 'b': case 'h': return MONTHS[d.getUTCMonth()];
      case 'B': return MONTHS_LONG[d.getUTCMonth()];
      case 'j': return pad(Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1, 3);
      case 'u': return String(d.getUTCDay() || 7);
      case 'w': return String(d.getUTCDay());
      case 's': return String(Math.floor(ms / 1000));
      case 'Z': return 'GMT';
      case 'z': return '+0000';
      case 'n': return '\n';
      case 't': return '\t';
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case '%': return '%';
      default: return '%' + c;
    }
  });
}

export function fullDate(ms: number): string {
  return strftime(ms, '%a %b %e %T %Z %Y');
}

export function humanSize(n: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + units[u];
}

export function sizeOf(node: FsNode): number {
  if (node.type === 'file') return node.content.length;
  if (node.type === 'link') return node.target.length;
  return 4096;
}

export function totalSize(node: FsNode): number {
  if (node.type !== 'dir') return sizeOf(node);
  return 4096 + Object.values(node.children).reduce((a, c) => a + totalSize(c), 0);
}

/** Converts a grep-style pattern (BRE by default, ERE with -E, literal with -F) to a JS RegExp. */
export function grepRegex(pattern: string, mode: 'basic' | 'extended' | 'fixed', flags: string): RegExp {
  let src = pattern;
  if (mode === 'fixed') src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else if (mode === 'basic') {
    // In BRE, +, ?, |, (, ), {, } are literal unless escaped; \+ \? \| \( \) \{ \} are operators.
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        const n = src[i + 1];
        if ('+?|(){}'.includes(n)) out += n;
        else out += '\\' + n;
        i++;
      } else if ('+?|(){}'.includes(c)) out += '\\' + c;
      else out += c;
    }
    src = out;
  }
  if (mode !== 'fixed') {
    // POSIX bracket classes ([[:alnum:]]) and GNU word boundaries (\< \>), which JavaScript lacks.
    const CLASSES: Record<string, string> = { alnum: 'A-Za-z0-9', alpha: 'A-Za-z', digit: '0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', xdigit: '0-9A-Fa-f', punct: '!-\\/:-@\\[-`{-~' };
    src = src.replace(/\[:(alnum|alpha|digit|upper|lower|space|blank|xdigit|punct):\]/g, (_m, n: string) => CLASSES[n]).replace(/\\[<>]/g, '\\b');
  }
  try {
    return new RegExp(src, flags);
  } catch {
    throw new Error(`invalid regular expression: ${pattern}`);
  }
}

export function lines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}
