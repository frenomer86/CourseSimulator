/** Text-processing commands: grep, head, tail, wc, sort, uniq, cut, tr, sed, awk, tee, xargs and friends. */

import { lookup, readFile, walk, writeFile } from './fs.js';
import { actor, runCommand, type Ctx } from './shell.js';
import { abs, errText, grepRegex, lines, parseOpts, readInputs, type IO } from './util.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

export const TEXT_COMMANDS: Record<string, Cmd> = {
  grep: (args, io, ctx) => grep(args, io, ctx, 'basic'),
  egrep: (args, io, ctx) => grep(args, io, ctx, 'extended'),
  fgrep: (args, io, ctx) => grep(args, io, ctx, 'fixed'),

  head: (args, io, ctx) => headTail(args, io, ctx, 'head'),
  tail: (args, io, ctx) => headTail(args, io, ctx, 'tail'),

  wc: (args, io, ctx) => {
    const o = parseOpts(args);
    const which = o.flags.size ? o.flags : new Set(['l', 'w', 'c']);
    const inputs = readInputs(ctx, io, o.rest, 'wc');
    const totals = { l: 0, w: 0, c: 0 };
    const pad = inputs.length > 1 ? 7 : which.size > 1 && o.rest.length ? 2 : 1;
    const row = (l: number, w: number, c: number, name: string) => {
      const cols: string[] = [];
      if (which.has('l')) cols.push(String(l).padStart(pad));
      if (which.has('w')) cols.push(String(w).padStart(pad));
      if (which.has('c') || which.has('m')) cols.push(String(c).padStart(pad));
      io.out(cols.join(' ') + (name === '-' ? '' : ' ' + name) + '\n');
    };
    for (const f of inputs) {
      const l = (f.content.match(/\n/g) ?? []).length;
      const w = f.content.split(/\s+/).filter(Boolean).length;
      const c = f.content.length;
      totals.l += l;
      totals.w += w;
      totals.c += c;
      row(l, w, c, f.name);
    }
    if (inputs.length > 1) row(totals.l, totals.w, totals.c, 'total');
    return ctx.status === 1 ? 1 : 0;
  },

  sort: (args, io, ctx) => {
    const o = parseOpts(args, ['k', 't', 'o']);
    let ls = readInputs(ctx, io, o.rest, 'sort').flatMap((f) => lines(f.content));
    const sep = o.values.t;
    const key = o.values.k ? Number(o.values.k.split(',')[0].replace(/[nr]$/g, '')) : 0;
    const numeric = o.flags.has('n') || /n/.test(o.values.k ?? '') || o.flags.has('h');
    const field = (l: string) => (key ? (sep ? l.split(sep) : l.trim().split(/\s+/))[key - 1] ?? '' : l);
    const num = (s: string) => {
      const m = /^\s*(-?[\d.]+)\s*([KMG]?)/i.exec(s);
      if (!m) return 0;
      return Number(m[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1);
    };
    ls.sort((a, b) => {
      const fa = field(a);
      const fb = field(b);
      const c = numeric ? num(fa) - num(fb) : o.flags.has('f') ? fa.toLowerCase().localeCompare(fb.toLowerCase()) : fa < fb ? -1 : fa > fb ? 1 : 0;
      return c !== 0 ? c : a < b ? -1 : a > b ? 1 : 0;
    });
    if (o.flags.has('r')) ls.reverse();
    if (o.flags.has('u')) ls = ls.filter((l, i) => i === 0 || field(l) !== field(ls[i - 1]));
    const text = ls.map((l) => l + '\n').join('');
    if (o.values.o) writeFile(ctx.sys.fs, abs(ctx, o.values.o), text, actor(ctx), ctx.sys.now);
    else io.out(text);
    return 0;
  },

  uniq: (args, io, ctx) => {
    const o = parseOpts(args);
    const ls = readInputs(ctx, io, o.rest.slice(0, 1), 'uniq').flatMap((f) => lines(f.content));
    const groups: Array<{ line: string; n: number }> = [];
    for (const l of ls) {
      const last = groups[groups.length - 1];
      const same = last && (o.flags.has('i') ? last.line.toLowerCase() === l.toLowerCase() : last.line === l);
      if (same) last.n++;
      else groups.push({ line: l, n: 1 });
    }
    let out = groups;
    if (o.flags.has('d')) out = out.filter((g) => g.n > 1);
    if (o.flags.has('u')) out = out.filter((g) => g.n === 1);
    const text = out.map((g) => (o.flags.has('c') ? `${String(g.n).padStart(7)} ${g.line}` : g.line) + '\n').join('');
    if (o.rest[1]) writeFile(ctx.sys.fs, abs(ctx, o.rest[1]), text, actor(ctx), ctx.sys.now);
    else io.out(text);
    return 0;
  },

  cut: (args, io, ctx) => {
    const o = parseOpts(args, ['d', 'f', 'c']);
    if (!o.values.f && !o.values.c) {
      io.err('cut: you must specify a list of bytes, characters, or fields\n');
      return 1;
    }
    const ranges = (spec: string, max: number): number[] => {
      const out = new Set<number>();
      for (const part of spec.split(',')) {
        const m = /^(\d*)(?:-(\d*))?$/.exec(part);
        if (!m) continue;
        const a = m[1] ? Number(m[1]) : 1;
        const b = part.includes('-') ? (m[2] ? Number(m[2]) : max) : a;
        for (let i = a; i <= Math.min(b, max); i++) out.add(i);
      }
      return [...out].sort((x, y) => x - y);
    };
    for (const f of readInputs(ctx, io, o.rest, 'cut')) {
      for (const l of lines(f.content)) {
        if (o.values.c) {
          io.out(ranges(o.values.c, l.length).map((i) => l[i - 1] ?? '').join('') + '\n');
          continue;
        }
        const d = o.values.d ?? '\t';
        if (!l.includes(d)) {
          if (!o.flags.has('s')) io.out(l + '\n');
          continue;
        }
        const fields = l.split(d);
        io.out(ranges(o.values.f, fields.length).map((i) => fields[i - 1] ?? '').join(d) + '\n');
      }
    }
    return 0;
  },

  tr: (args, io) => {
    const o = parseOpts(args);
    const expand = (s: string): string[] => {
      const out: string[] = [];
      const classes: Record<string, string> = { '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[:lower:]': 'abcdefghijklmnopqrstuvwxyz', '[:digit:]': '0123456789', '[:space:]': ' \t\n\r', '[:alpha:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', '[:alnum:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '[:punct:]': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' };
      for (let i = 0; i < s.length; i++) {
        const cls = Object.keys(classes).find((k) => s.startsWith(k, i));
        if (cls) {
          out.push(...classes[cls]);
          i += cls.length - 1;
          continue;
        }
        if (s[i] === '\\' && i + 1 < s.length) {
          out.push(s[i + 1] === 'n' ? '\n' : s[i + 1] === 't' ? '\t' : s[i + 1]);
          i++;
          continue;
        }
        if (s[i + 1] === '-' && i + 2 < s.length) {
          for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out.push(String.fromCharCode(c));
          i += 2;
          continue;
        }
        out.push(s[i]);
      }
      return out;
    };
    const set1 = expand(o.rest[0] ?? '');
    const set2 = expand(o.rest[1] ?? '');
    let text = io.stdin;
    if (o.flags.has('d')) {
      const del = new Set(set1);
      text = [...text].filter((c) => !del.has(c)).join('');
    } else if (set2.length) {
      const map = new Map<string, string>();
      set1.forEach((c, i) => map.set(c, set2[Math.min(i, set2.length - 1)]));
      text = [...text].map((c) => map.get(c) ?? c).join('');
    }
    if (o.flags.has('s')) {
      const sq = new Set(o.flags.has('d') || !set2.length ? set1 : set2);
      text = text.replace(/(.)\1+/gs, (m, c) => (sq.has(c) ? c : m));
    }
    io.out(text);
    return 0;
  },

  rev: (_a, io) => {
    io.out(lines(io.stdin).map((l) => [...l].reverse().join('') + '\n').join(''));
    return 0;
  },

  nl: (args, io, ctx) => {
    let n = 1;
    for (const f of readInputs(ctx, io, parseOpts(args).rest, 'nl')) for (const l of lines(f.content)) io.out(l.trim() === '' ? '\n' : `${String(n++).padStart(6)}\t${l}\n`);
    return 0;
  },

  tac: (args, io, ctx) => {
    for (const f of readInputs(ctx, io, parseOpts(args).rest, 'tac')) io.out(lines(f.content).reverse().map((l) => l + '\n').join(''));
    return 0;
  },

  paste: (args, io, ctx) => {
    const o = parseOpts(args, ['d']);
    const cols = readInputs(ctx, io, o.rest, 'paste').map((f) => lines(f.content));
    const n = Math.max(...cols.map((c) => c.length));
    for (let i = 0; i < n; i++) io.out(cols.map((c) => c[i] ?? '').join(o.values.d ?? '\t') + '\n');
    return 0;
  },

  column: (args, io) => {
    const o = parseOpts(args, ['s']);
    const rows = lines(io.stdin).map((l) => (o.values.s ? l.split(o.values.s) : l.trim().split(/\s+/)));
    const widths: number[] = [];
    rows.forEach((r) => r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length))));
    io.out(rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 2))).join('').trimEnd() + '\n').join(''));
    return 0;
  },

  diff: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.rest.length < 2) {
      io.err('diff: missing operand\n');
      return 2;
    }
    // diff -r / -q on two directories: compare the trees.
    const da = lookup(ctx.sys.fs, abs(ctx, o.rest[0]), actor(ctx));
    const db = lookup(ctx.sys.fs, abs(ctx, o.rest[1]), actor(ctx));
    if (da?.node.type === 'dir' && db?.node.type === 'dir') {
      if (!o.flags.has('r')) {
        io.out(`Common subdirectories: ${o.rest[0]} and ${o.rest[1]}\n`);
        return 0;
      }
      const tree = (pa: string, pb: string): number => {
        const A = lookup(ctx.sys.fs, abs(ctx, pa), actor(ctx))!.node as { children: Record<string, { type: string; content?: string }> };
        const B = lookup(ctx.sys.fs, abs(ctx, pb), actor(ctx))!.node as { children: Record<string, { type: string; content?: string }> };
        let rc = 0;
        for (const name of [...new Set([...Object.keys(A.children), ...Object.keys(B.children)])].sort()) {
          const x = A.children[name];
          const y = B.children[name];
          if (!y) {
            io.out(`Only in ${pa}: ${name}\n`);
            rc = 1;
          } else if (!x) {
            io.out(`Only in ${pb}: ${name}\n`);
            rc = 1;
          } else if (x.type === 'dir' && y.type === 'dir') rc = tree(`${pa}/${name}`, `${pb}/${name}`) || rc;
          else if (x.type === 'file' && y.type === 'file' && x.content !== y.content) {
            if (o.flags.has('q')) io.out(`Files ${pa}/${name} and ${pb}/${name} differ\n`);
            else {
              io.out(`diff -r ${pa}/${name} ${pb}/${name}\n`);
              TEXT_COMMANDS.diff([`${pa}/${name}`, `${pb}/${name}`], io, ctx);
            }
            rc = 1;
          }
        }
        return rc;
      };
      return tree(o.rest[0].replace(/\/$/, ''), o.rest[1].replace(/\/$/, ''));
    }
    const [a, b] = readInputs(ctx, io, o.rest.slice(0, 2), 'diff');
    if (!a || !b) return 2;
    const la = lines(a.content);
    const lb = lines(b.content);
    if (a.content === b.content) return 0;
    // Simple line-level diff via LCS.
    const m = la.length;
    const n = lb.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    const out: string[] = [];
    while (i < m || j < n) {
      if (i < m && j < n && la[i] === lb[j]) {
        i++;
        j++;
        continue;
      }
      const delStart = i;
      const addStart = j;
      while (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1]) && !(j < n && la[i] === lb[j])) i++;
      while (j < n && !(i < m && la[i] === lb[j])) j++;
      const dels = la.slice(delStart, i);
      const adds = lb.slice(addStart, j);
      const ra = dels.length ? (dels.length === 1 ? `${delStart + 1}` : `${delStart + 1},${i}`) : `${delStart}`;
      const rb = adds.length ? (adds.length === 1 ? `${addStart + 1}` : `${addStart + 1},${j}`) : `${addStart}`;
      out.push(`${ra}${dels.length && adds.length ? 'c' : dels.length ? 'd' : 'a'}${rb}`);
      dels.forEach((l) => out.push('< ' + l));
      if (dels.length && adds.length) out.push('---');
      adds.forEach((l) => out.push('> ' + l));
    }
    io.out(out.join('\n') + '\n');
    return 1;
  },

  tee: (args, io, ctx) => {
    const o = parseOpts(args);
    io.out(io.stdin);
    for (const f of o.rest) {
      try {
        writeFile(ctx.sys.fs, abs(ctx, f), io.stdin, actor(ctx), ctx.sys.now, o.flags.has('a'));
      } catch (e) {
        io.err(`tee: ${errText(e, f)}\n`);
        return 1;
      }
    }
    return 0;
  },

  xargs: (args, io, ctx) => {
    const o = parseOpts(args, ['n', 'I'], {}, true);
    const items = io.stdin.split(/\s+/).filter(Boolean);
    const cmd = o.rest.length ? o.rest : ['echo'];
    let code = 0;
    if (o.values.I) {
      for (const item of lines(io.stdin)) code = runCommand(ctx, cmd.map((c) => c.split(o.values.I).join(item)), { stdin: '', out: io.out, err: io.err });
      return code;
    }
    const n = o.values.n ? Number(o.values.n) : items.length || 1;
    if (!items.length) return runCommand(ctx, cmd, { stdin: '', out: io.out, err: io.err });
    for (let i = 0; i < items.length; i += n) code = runCommand(ctx, [...cmd, ...items.slice(i, i + n)], { stdin: '', out: io.out, err: io.err });
    return code;
  },

  seq: (args, io) => {
    const nums = args.filter((a) => !a.startsWith('-') || /^-\d/.test(a)).map(Number);
    let [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : [nums[0], nums[1], nums[2]];
    if (!step) step = 1;
    const out: string[] = [];
    for (let i = first; step > 0 ? i <= last : i >= last; i += step) {
      out.push(String(i));
      if (out.length > 100000) break;
    }
    io.out(out.map((s) => s + '\n').join(''));
    return 0;
  },

  expr: (args, io) => {
    const [a, op, b] = args;
    const n = (s: string) => Number(s);
    let r: string | number;
    switch (op) {
      case '+': r = n(a) + n(b); break;
      case '-': r = n(a) - n(b); break;
      case '*': r = n(a) * n(b); break;
      case '/': r = Math.trunc(n(a) / n(b)); break;
      case '%': r = n(a) % n(b); break;
      case '=': r = a === b ? 1 : 0; break;
      case '!=': r = a !== b ? 1 : 0; break;
      case '<': r = n(a) < n(b) ? 1 : 0; break;
      case '>': r = n(a) > n(b) ? 1 : 0; break;
      case 'length': r = a.length; break;
      default:
        if (op === undefined) r = a ?? '';
        else {
          io.err('expr: syntax error\n');
          return 2;
        }
    }
    io.out(String(r) + '\n');
    return r === 0 || r === '' ? 1 : 0;
  },

  bc: (_a, io) => {
    let code = 0;
    for (const l of lines(io.stdin)) {
      const expr = l.replace(/scale\s*=\s*\d+;?/g, '').trim();
      if (!expr) continue;
      if (!/^[\d\s+\-*/%().^]+$/.test(expr)) {
        io.err('(standard_in) 1: syntax error\n');
        code = 1;
        continue;
      }
      try {
        const v = Function(`"use strict"; return (${expr.replace(/\^/g, '**')});`)() as number;
        io.out(String(Number.isInteger(v) ? v : Number(v.toFixed(4))) + '\n');
      } catch {
        io.err('(standard_in) 1: syntax error\n');
        code = 1;
      }
    }
    return code;
  },

  sed: (args, io, ctx) => {
    const o = parseOpts(args, ['e', 'i']);
    const scripts: string[] = [];
    let rest = o.rest;
    // -e may appear several times; parseOpts keeps the last, so re-scan.
    for (let k = 0; k < args.length; k++) if (args[k] === '-e') scripts.push(args[++k]);
    const inPlace = o.flags.has('i') || 'i' in o.values;
    if ('i' in o.values && o.values.i && !inPlaceSuffixLooksLikeFile(o.values.i)) rest = [o.values.i, ...rest];
    if (!scripts.length) {
      if (!rest.length) {
        io.err('sed: no script given\n');
        return 1;
      }
      scripts.push(rest[0]);
      rest = rest.slice(1);
    }
    const quiet = o.flags.has('n');
    const ere = o.flags.has('E') || o.flags.has('r');
    interface Rule { addr?: { from: number | RegExp; to?: number | RegExp | '$' }; cmd: string; re?: RegExp; rep?: string; global?: boolean; text?: string }
    const rules: Rule[] = [];
    for (const script of scripts) {
      for (const partRaw of splitSedScript(script)) {
        const part = partRaw.trim();
        if (!part) continue;
        const rule: Rule = { cmd: '' };
        let s = part;
        const am = /^(\d+|\$|\/(?:\\\/|[^/])+\/)(?:,(\d+|\$|\/(?:\\\/|[^/])+\/))?/.exec(s);
        if (am) {
          const parseAddr = (a: string): number | RegExp | '$' => (a === '$' ? '$' : /^\d+$/.test(a) ? Number(a) : grepRegex(a.slice(1, -1).replace(/\\\//g, '/'), ere ? 'extended' : 'basic', ''));
          const from = parseAddr(am[1]);
          rule.addr = { from: from === '$' ? Infinity : from, to: am[2] ? parseAddr(am[2]) : undefined };
          s = s.slice(am[0].length);
        }
        if (s[0] === 's') {
          const delim = s[1];
          const m = new RegExp(`^s\\${delim}((?:\\\\.|[^\\${delim}])*)\\${delim}((?:\\\\.|[^\\${delim}])*)\\${delim}([gIi0-9]*)$`).exec(s);
          if (!m) {
            io.err(`sed: -e expression #1, char ${s.length}: unterminated \`s' command\n`);
            return 1;
          }
          rule.cmd = 's';
          try {
            rule.re = grepRegex(m[1].replace(new RegExp(`\\\\\\${delim}`, 'g'), delim), ere ? 'extended' : 'basic', (m[3].includes('g') ? 'g' : '') + (/[Ii]/.test(m[3]) ? 'i' : ''));
          } catch (e) {
            io.err(`sed: ${(e as Error).message}\n`);
            return 1;
          }
          // Translates sed's replacement syntax (\1, &, \&, \n, \t) to JavaScript's ($1, $&, $$).
          let rep = '';
          for (let i = 0; i < m[2].length; i++) {
            const c = m[2][i];
            if (c === '\\' && i + 1 < m[2].length) {
              const n = m[2][++i];
              rep += /\d/.test(n) ? '$' + n : n === 'n' ? '\n' : n === 't' ? '\t' : n === '$' ? '$$' : n;
            } else rep += c === '&' ? '$&' : c === '$' ? '$$' : c;
          }
          rule.rep = rep;
          rule.global = m[3].includes('g');
        } else if (s === 'd' || s === 'p') rule.cmd = s;
        else if (/^[aic]\\?\s*/.test(s)) {
          rule.cmd = s[0];
          rule.text = s.replace(/^[aic]\\?\s*/, '');
        } else if (s === '=' ) rule.cmd = '=';
        else {
          io.err(`sed: -e expression #1, char 1: unknown command: \`${s[0]}'\n`);
          return 1;
        }
        rules.push(rule);
      }
    }
    const matchAddr = (rule: Rule, idx: number, line: string, total: number, state: Map<Rule, boolean>): boolean => {
      if (!rule.addr) return true;
      const test = (a: number | RegExp | '$') => (a === '$' ? idx === total : typeof a === 'number' ? (a === Infinity ? idx === total : idx === a) : a.test(line));
      if (!rule.addr.to) return test(rule.addr.from);
      const active = state.get(rule) ?? false;
      if (!active) {
        if (test(rule.addr.from)) {
          state.set(rule, !test(rule.addr.to) || typeof rule.addr.to === 'number' ? !(typeof rule.addr.to === 'number' && rule.addr.to <= idx) : true);
          return true;
        }
        return false;
      }
      if (test(rule.addr.to)) state.set(rule, false);
      return true;
    };
    let code = 0;
    const process = (content: string): string => {
      const ls = lines(content);
      const out: string[] = [];
      const state = new Map<Rule, boolean>();
      ls.forEach((line, i) => {
        let cur: string | null = line;
        let printed = false;
        const before: string[] = [];
        const after: string[] = [];
        for (const r of rules) {
          if (cur === null) break;
          if (!matchAddr(r, i + 1, line, ls.length, state)) continue;
          if (r.cmd === 's') cur = cur.replace(r.re!, r.rep!);
          else if (r.cmd === 'd') cur = null;
          else if (r.cmd === 'p') {
            out.push(cur);
            printed = true;
          } else if (r.cmd === 'i') before.push(r.text ?? '');
          else if (r.cmd === 'a') after.push(r.text ?? '');
          else if (r.cmd === 'c') {
            cur = null;
            if (!r.addr?.to || !(state.get(r) ?? false) || i + 1 === ls.length) after.push(r.text ?? '');
          } else if (r.cmd === '=') out.push(String(i + 1));
        }
        out.push(...before);
        if (cur !== null && (!quiet || (printed && false))) out.push(cur);
        out.push(...after);
      });
      return out.map((l) => l + '\n').join('');
    };
    if (inPlace) {
      for (const f of rest) {
        try {
          const content = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
          if (o.values.i && inPlaceSuffixLooksLikeFile(o.values.i)) writeFile(ctx.sys.fs, abs(ctx, f) + o.values.i, content, actor(ctx), ctx.sys.now);
          writeFile(ctx.sys.fs, abs(ctx, f), process(content), actor(ctx), ctx.sys.now);
        } catch (e) {
          io.err(`sed: can't read ${f}: ${errText(e, f).replace(/^.*?: /, '')}\n`);
          code = 2;
        }
      }
      return code;
    }
    for (const f of readInputs(ctx, io, rest, 'sed')) io.out(process(f.content));
    return ctx.status === 1 ? 2 : code;
  },

  awk: (args, io, ctx) => awk(args, io, ctx),
  gawk: (args, io, ctx) => awk(args, io, ctx),
};

function inPlaceSuffixLooksLikeFile(s: string): boolean {
  return s.startsWith('.') || s.startsWith('~') || s.startsWith('-');
}

function splitSedScript(script: string): string[] {
  // Split on ';' outside of s/// delimiters and a/i/c text.
  const parts: string[] = [];
  let cur = '';
  let delim: string | null = null;
  let seen = 0;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (delim === null && c === 's' && (cur.trim() === '' || /[\d$/]$/.test(cur.trim()))) {
      delim = script[i + 1] ?? '/';
      seen = 0;
      cur += c;
      continue;
    }
    if (delim !== null) {
      if (c === '\\') {
        cur += c + (script[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === delim) seen++;
      cur += c;
      if (seen === 3) {
        delim = null;
        seen = 0;
      }
      continue;
    }
    if (c === ';' || c === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function grep(args: string[], io: IO, ctx: Ctx, defaultMode: 'basic' | 'extended' | 'fixed'): number {
  const o = parseOpts(args, ['e', 'A', 'B', 'C', 'm', 'include', 'exclude']);
  const mode = o.flags.has('E') ? 'extended' : o.flags.has('F') ? 'fixed' : o.flags.has('G') ? 'basic' : defaultMode;
  let pattern = o.values.e;
  let files = o.rest;
  if (pattern === undefined) {
    if (!files.length) {
      io.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n');
      return 2;
    }
    pattern = files[0];
    files = files.slice(1);
  }
  let re: RegExp;
  try {
    re = grepRegex(o.flags.has('w') ? `\\b(?:${mode === 'fixed' ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern})\\b` : pattern, o.flags.has('w') ? 'extended' : mode, o.flags.has('i') ? 'i' : '');
  } catch (e) {
    io.err(`grep: ${(e as Error).message}\n`);
    return 2;
  }
  if (o.flags.has('x')) re = new RegExp(`^(?:${re.source})$`, re.flags);
  const recursive = o.flags.has('r') || o.flags.has('R');
  const inputs: Array<{ name: string; content: string }> = [];
  if (recursive) {
    for (const f of files.length ? files : ['.']) {
      try {
        walk(ctx.sys.fs, abs(ctx, f), actor(ctx), (p, n) => {
          if (n.type !== 'file') return;
          const shown = f === '.' ? p.slice(ctx.sys.cwd.length + 1) : f.replace(/\/$/, '') + p.slice(abs(ctx, f).length);
          try {
            inputs.push({ name: shown || f, content: readFile(ctx.sys.fs, p, actor(ctx)) });
          } catch {
            io.err(`grep: ${shown}: Permission denied\n`);
          }
        });
      } catch (e) {
        io.err(`grep: ${errText(e, f)}\n`);
      }
    }
  } else inputs.push(...readInputs(ctx, io, files, 'grep'));
  const showNames = inputs.length > 1 || recursive || o.flags.has('H');
  const invert = o.flags.has('v');
  let any = false;
  const max = o.values.m ? Number(o.values.m) : Infinity;
  const after = Number(o.values.A ?? o.values.C ?? 0);
  const before = Number(o.values.B ?? o.values.C ?? 0);
  for (const f of inputs) {
    const ls = lines(f.content);
    const hits: number[] = [];
    ls.forEach((l, i) => {
      if ((re.test(l) !== invert) && hits.length < max) hits.push(i);
    });
    if (hits.length) any = true;
    if (o.flags.has('q')) continue;
    if (o.flags.has('c')) {
      io.out((showNames ? f.name + ':' : '') + hits.length + '\n');
      continue;
    }
    if (o.flags.has('l')) {
      if (hits.length) io.out(f.name + '\n');
      continue;
    }
    if (o.flags.has('L')) {
      if (!hits.length) io.out(f.name + '\n');
      continue;
    }
    const show = new Set<number>();
    for (const h of hits) for (let k = Math.max(0, h - before); k <= Math.min(ls.length - 1, h + after); k++) show.add(k);
    let prev = -2;
    for (const i of [...show].sort((a, b) => a - b)) {
      if ((after || before) && prev !== -2 && i !== prev + 1) io.out('--\n');
      prev = i;
      const isHit = hits.includes(i);
      const sep = isHit ? ':' : '-';
      const prefix = (showNames ? f.name + sep : '') + (o.flags.has('n') ? i + 1 + sep : '');
      if (o.flags.has('o') && isHit) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        for (const m of ls[i].matchAll(g)) if (m[0]) io.out(prefix + m[0] + '\n');
      } else io.out(prefix + ls[i] + '\n');
    }
  }
  return any ? 0 : 1;
}

function headTail(args: string[], io: IO, ctx: Ctx, which: 'head' | 'tail'): number {
  const o = parseOpts(args, ['n', 'c']);
  const n = Number(o.values.n ?? o.values.N ?? 10);
  const inputs = readInputs(ctx, io, o.rest, which);
  inputs.forEach((f, k) => {
    if (inputs.length > 1) io.out(`${k ? '\n' : ''}==> ${f.name} <==\n`);
    if (o.values.c) {
      const c = Number(o.values.c);
      io.out(which === 'head' ? f.content.slice(0, c) : f.content.slice(-c));
      return;
    }
    const ls = lines(f.content);
    const plus = typeof o.values.n === 'string' && o.values.n.startsWith('+');
    const chosen = which === 'head' ? (o.values.n?.startsWith('-') ? ls.slice(0, ls.length + n) : ls.slice(0, n)) : plus ? ls.slice(n - 1) : ls.slice(Math.max(0, ls.length - n));
    io.out(chosen.map((l) => l + '\n').join(''));
  });
  if (o.flags.has('f') && which === 'tail') io.out('(tail -f would now wait for new lines; the simulator returns immediately.)\n');
  return ctx.status === 1 ? 1 : 0;
}

/* ------------------------------------------------------------------ a small awk */

interface AwkEnv {
  vars: Record<string, string | number>;
  fields: string[];
  line: string;
  nr: number;
  fs: string;
  ofs: string;
  out: (s: string) => void;
}

type AwkValue = string | number;

class AwkParser {
  pos = 0;
  toks: string[];
  constructor(src: string) {
    const re = /\s*("(?:\\.|[^"])*"|\/(?:\\.|[^/])+\/(?=\s*(?:[{),&|]|$))|[0-9.]+|[A-Za-z_][A-Za-z0-9_]*|\$|\+\+|--|\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||!~|[-+*\/%(){}\[\],;=<>!~?:]|\n)/y;
    this.toks = [];
    let i = 0;
    while (i < src.length) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m) {
        if (/^\s*$/.test(src.slice(i))) break;
        throw new Error(`awk: syntax error near "${src.slice(i, i + 10)}"`);
      }
      if (m[1] !== '\n' || (this.toks.length && !/[{;,&|]$/.test(this.toks[this.toks.length - 1]))) this.toks.push(m[1] === '\n' ? ';' : m[1]);
      i = re.lastIndex;
    }
  }
  peek(o = 0): string | undefined {
    return this.toks[this.pos + o];
  }
  next(): string {
    return this.toks[this.pos++];
  }
  expect(t: string): void {
    if (this.next() !== t) throw new Error(`awk: syntax error: expected ${t}`);
  }
}

type Stmt =
  | { k: 'print'; args: Expr[]; file?: Expr; append?: boolean }
  | { k: 'printf'; args: Expr[] }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { k: 'while'; cond: Expr; body: Stmt[] }
  | { k: 'for'; init?: Stmt; cond?: Expr; step?: Stmt; body: Stmt[] }
  | { k: 'forin'; v: string; arr: string; body: Stmt[] }
  | { k: 'next' }
  | { k: 'exit' }
  | { k: 'delete'; arr: string; key?: Expr };
type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'regex'; v: RegExp }
  | { k: 'var'; name: string }
  | { k: 'field'; e: Expr }
  | { k: 'index'; arr: string; key: Expr[] }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'assign'; op: string; target: Expr; v: Expr }
  | { k: 'incr'; target: Expr; delta: number; prefix: boolean }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'concat'; a: Expr; b: Expr }
  | { k: 'in'; key: Expr; arr: string };

interface Rule {
  pattern?: Expr | 'BEGIN' | 'END';
  range?: [Expr, Expr];
  body: Stmt[];
}

function parseAwkProgram(src: string): Rule[] {
  const p = new AwkParser(src);
  const rules: Rule[] = [];
  const parseBlock = (): Stmt[] => {
    p.expect('{');
    const stmts: Stmt[] = [];
    while (p.peek() !== '}') {
      if (p.peek() === ';') {
        p.next();
        continue;
      }
      stmts.push(parseStmt());
    }
    p.expect('}');
    return stmts;
  };
  const parseStmtOrBlock = (): Stmt[] => (p.peek() === '{' ? parseBlock() : [parseStmt()]);
  const parseSimpleStmt = (): Stmt | undefined => {
    const t = p.peek();
    if (t === ';' || t === '}' || t === undefined) return undefined;
    if (t === 'print' || t === 'printf') {
      p.next();
      const args: Expr[] = [];
      let paren = false;
      if (p.peek() === '(') {
        paren = true;
        p.next();
      }
      while (p.peek() !== undefined && p.peek() !== ';' && p.peek() !== '}' && p.peek() !== '>' && !(paren && p.peek() === ')')) {
        args.push(parseExpr(true));
        if (p.peek() === ',') p.next();
        else break;
      }
      if (paren) p.expect(')');
      let file: Expr | undefined;
      let append = false;
      if (p.peek() === '>') {
        p.next();
        if (p.peek() === '>') {
          p.next();
          append = true;
        }
        file = parsePrimary();
      }
      return t === 'print' ? { k: 'print', args, file, append } : { k: 'printf', args };
    }
    if (t === 'next') {
      p.next();
      return { k: 'next' };
    }
    if (t === 'exit') {
      p.next();
      if (p.peek() !== ';' && p.peek() !== '}' && p.peek() !== undefined) parseExpr();
      return { k: 'exit' };
    }
    if (t === 'delete') {
      p.next();
      const arr = p.next();
      let key: Expr | undefined;
      if (p.peek() === '[') {
        p.next();
        key = parseExpr();
        p.expect(']');
      }
      return { k: 'delete', arr, key };
    }
    return { k: 'expr', e: parseExpr() };
  };
  const parseStmt = (): Stmt => {
    const t = p.peek();
    if (t === 'if') {
      p.next();
      p.expect('(');
      const cond = parseExpr();
      p.expect(')');
      while (p.peek() === ';') p.next();
      const then = parseStmtOrBlock();
      while (p.peek() === ';') p.next();
      let els: Stmt[] | undefined;
      if (p.peek() === 'else') {
        p.next();
        while (p.peek() === ';') p.next();
        els = parseStmtOrBlock();
      }
      return { k: 'if', cond, then, else: els };
    }
    if (t === 'while') {
      p.next();
      p.expect('(');
      const cond = parseExpr();
      p.expect(')');
      return { k: 'while', cond, body: parseStmtOrBlock() };
    }
    if (t === 'for') {
      p.next();
      p.expect('(');
      if (/^[A-Za-z_]/.test(p.peek() ?? '') && p.peek(1) === 'in') {
        const v = p.next();
        p.next();
        const arr = p.next();
        p.expect(')');
        return { k: 'forin', v, arr, body: parseStmtOrBlock() };
      }
      const init = parseSimpleStmt();
      p.expect(';');
      const cond = p.peek() === ';' ? undefined : parseExpr();
      p.expect(';');
      const step = p.peek() === ')' ? undefined : parseSimpleStmt();
      p.expect(')');
      return { k: 'for', init, cond, step, body: parseStmtOrBlock() };
    }
    if (t === '{') return { k: 'if', cond: { k: 'num', v: 1 }, then: parseBlock() };
    const s = parseSimpleStmt();
    if (!s) throw new Error('awk: syntax error');
    if (p.peek() === ';') p.next();
    return s;
  };
  const PREC: Record<string, number> = { '||': 1, '&&': 2, in: 3, '~': 4, '!~': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '==': 5, '!=': 5, '+': 7, '-': 7, '*': 8, '/': 8, '%': 8 };
  const parseExpr = (noGt = false): Expr => parseTernary(noGt);
  const parseTernary = (noGt: boolean): Expr => {
    const c = parseBinary(0, noGt);
    if (p.peek() === '?') {
      p.next();
      const a = parseTernary(noGt);
      p.expect(':');
      const b = parseTernary(noGt);
      return { k: 'cond', c, a, b };
    }
    if (['=', '+=', '-=', '*=', '/='].includes(p.peek() ?? '') && (c.k === 'var' || c.k === 'field' || c.k === 'index')) {
      const op = p.next();
      return { k: 'assign', op, target: c, v: parseTernary(noGt) };
    }
    return c;
  };
  const startsOperand = (t: string | undefined) => t !== undefined && (/^["0-9.$(!A-Za-z_-]/.test(t) || t.startsWith('/')) && !['in', 'print', 'printf', 'if', 'else', 'while', 'for', 'next', 'exit', 'delete'].includes(t);
  const parseBinary = (min: number, noGt: boolean): Expr => {
    let left = parseUnary(noGt);
    for (;;) {
      const op = p.peek();
      if (op === undefined) return left;
      if (noGt && op === '>') return left;
      const prec = PREC[op];
      if (prec !== undefined && prec >= min) {
        p.next();
        if (op === 'in') {
          left = { k: 'in', key: left, arr: p.next() };
          continue;
        }
        const right = parseBinary(prec + 1, noGt);
        left = { k: 'bin', op, a: left, b: right };
        continue;
      }
      // Implicit concatenation.
      if (min <= 6 && startsOperand(op) && op !== '-' && !PREC[op]) {
        const right = parseBinary(7, noGt);
        left = { k: 'concat', a: left, b: right };
        continue;
      }
      return left;
    }
  };
  const parseUnary = (noGt: boolean): Expr => {
    const t = p.peek();
    if (t === '!') {
      p.next();
      return { k: 'un', op: '!', a: parseUnary(noGt) };
    }
    if (t === '-') {
      p.next();
      return { k: 'un', op: '-', a: parseUnary(noGt) };
    }
    if (t === '++' || t === '--') {
      p.next();
      return { k: 'incr', target: parsePrimary(), delta: t === '++' ? 1 : -1, prefix: true };
    }
    const e = parsePrimary();
    if (p.peek() === '++' || p.peek() === '--') {
      const d = p.next() === '++' ? 1 : -1;
      return { k: 'incr', target: e, delta: d, prefix: false };
    }
    return e;
  };
  const parsePrimary = (): Expr => {
    const t = p.next();
    if (t === undefined) throw new Error('awk: unexpected end of program');
    if (t === '(') {
      const e = parseExpr();
      p.expect(')');
      return e;
    }
    if (t === '$') return { k: 'field', e: parsePrimaryNoConcat() };
    if (t.startsWith('"')) return { k: 'str', v: t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
    if (t.startsWith('/')) return { k: 'regex', v: grepRegex(t.slice(1, -1).replace(/\\\//g, '/'), 'extended', '') };
    if (/^[0-9.]/.test(t)) return { k: 'num', v: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (p.peek() === '(' ) {
        p.next();
        const args: Expr[] = [];
        while (p.peek() !== ')') {
          args.push(parseExpr());
          if (p.peek() === ',') p.next();
        }
        p.expect(')');
        return { k: 'call', name: t, args };
      }
      if (p.peek() === '[') {
        p.next();
        const key: Expr[] = [parseExpr()];
        while (p.peek() === ',') {
          p.next();
          key.push(parseExpr());
        }
        p.expect(']');
        return { k: 'index', arr: t, key };
      }
      return { k: 'var', name: t };
    }
    throw new Error(`awk: syntax error at "${t}"`);
  };
  const parsePrimaryNoConcat = (): Expr => {
    const t = p.peek();
    if (t === '(') return parsePrimary();
    if (t !== undefined && /^[0-9]/.test(t)) {
      p.next();
      return { k: 'num', v: Number(t) };
    }
    if (t === 'NF' || (t !== undefined && /^[A-Za-z_]/.test(t))) {
      p.next();
      return { k: 'var', name: t };
    }
    if (t === '$') return parsePrimary();
    throw new Error('awk: syntax error after $');
  };
  while (p.peek() !== undefined) {
    if (p.peek() === ';') {
      p.next();
      continue;
    }
    const rule: Rule = { body: [] };
    if (p.peek() === 'BEGIN' || p.peek() === 'END') rule.pattern = p.next() as 'BEGIN' | 'END';
    else if (p.peek() !== '{') {
      const a = parseExpr();
      if (p.peek() === ',') {
        p.next();
        rule.range = [a, parseExpr()];
      } else rule.pattern = a;
    }
    rule.body = p.peek() === '{' ? parseBlock() : [{ k: 'print', args: [] }];
    rules.push(rule);
  }
  return rules;
}

class AwkNext {}
class AwkExit {}

function awk(args: string[], io: IO, ctx: Ctx): number {
  const o = parseOpts(args, ['F', 'f', 'v']);
  let program = o.rest[0];
  let files = o.rest.slice(1);
  if (o.values.f) {
    try {
      program = readFile(ctx.sys.fs, abs(ctx, o.values.f), actor(ctx));
    } catch (e) {
      io.err(`awk: ${errText(e, o.values.f)}\n`);
      return 2;
    }
    files = o.rest;
  }
  if (program === undefined) {
    io.err("Usage: awk [-F fs] [-v var=value] 'program' [file ...]\n");
    return 2;
  }
  let rules: Rule[];
  try {
    rules = parseAwkProgram(program);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  const env: AwkEnv = { vars: { NR: 0, NF: 0, FS: o.values.F ?? ' ', OFS: ' ', ORS: '\n' }, fields: [], line: '', nr: 0, fs: o.values.F ?? ' ', ofs: ' ', out: io.out };
  const arrays: Record<string, Record<string, AwkValue>> = {};
  for (let k = 0; k < args.length; k++) if (args[k] === '-v' && args[k + 1]) {
    const [n, v] = args[k + 1].split('=');
    env.vars[n] = v ?? '';
  }
  const num = (v: AwkValue): number => (typeof v === 'number' ? v : Number(/^\s*[-+]?[\d.]+(?:e[-+]?\d+)?/i.exec(v)?.[0] ?? 0) || 0);
  const str = (v: AwkValue): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)))) : v);
  const truthy = (v: AwkValue) => (typeof v === 'number' ? v !== 0 : v !== '');
  const splitFields = (line: string): string[] => {
    const fs = str(env.vars.FS);
    if (fs === ' ') return line.trim() === '' ? [] : line.trim().split(/\s+/);
    if (fs.length === 1) return line.split(fs);
    return line.split(new RegExp(fs));
  };
  const setLine = (line: string) => {
    env.line = line;
    env.fields = splitFields(line);
    env.vars.NF = env.fields.length;
  };
  const getField = (i: number): string => (i === 0 ? env.line : env.fields[i - 1] ?? '');
  const setField = (i: number, v: string) => {
    if (i === 0) {
      setLine(v);
      return;
    }
    while (env.fields.length < i) env.fields.push('');
    env.fields[i - 1] = v;
    env.vars.NF = env.fields.length;
    env.line = env.fields.join(str(env.vars.OFS));
  };
  const keyOf = (keys: Expr[]) => keys.map((k) => str(ev(k))).join('\u001c');
  const assign = (target: Expr, v: AwkValue) => {
    if (target.k === 'var') env.vars[target.name] = v;
    else if (target.k === 'field') setField(num(ev(target.e)), str(v));
    else if (target.k === 'index') (arrays[target.arr] ??= {})[keyOf(target.key)] = v;
  };
  const read = (target: Expr): AwkValue => (target.k === 'var' ? env.vars[target.name] ?? '' : target.k === 'field' ? getField(num(ev(target.e))) : target.k === 'index' ? (arrays[target.arr] ??= {})[keyOf(target.key)] ?? '' : ev(target));
  const compare = (a: AwkValue, b: AwkValue): number => {
    const bothNum = (typeof a === 'number' || /^\s*[-+]?\d+(\.\d+)?\s*$/.test(a)) && (typeof b === 'number' || /^\s*[-+]?\d+(\.\d+)?\s*$/.test(b));
    if (bothNum) return num(a) - num(b);
    const sa = str(a);
    const sb = str(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  const formatPrintf = (fmt: string, vals: AwkValue[]): string => {
    let i = 0;
    return fmt.replace(/%(-?)(\d*)(?:\.(\d+))?([sdifxoc%])/g, (_, minus: string, width: string, prec: string, conv: string) => {
      if (conv === '%') return '%';
      const v = vals[i++] ?? '';
      let s: string;
      if (conv === 's') s = prec ? str(v).slice(0, Number(prec)) : str(v);
      else if (conv === 'c') s = str(v).slice(0, 1);
      else if (conv === 'f') s = num(v).toFixed(prec ? Number(prec) : 6);
      else if (conv === 'x') s = Math.trunc(num(v)).toString(16);
      else if (conv === 'o') s = Math.trunc(num(v)).toString(8);
      else s = String(Math.trunc(num(v)));
      const w = Number(width || 0);
      return minus ? s.padEnd(w) : s.padStart(w, width.startsWith('0') ? '0' : ' ');
    });
  };
  const call = (name: string, args: Expr[]): AwkValue => {
    const a = args.map(ev);
    switch (name) {
      case 'length': return args.length ? (args[0].k === 'var' && arrays[args[0].name] ? Object.keys(arrays[args[0].name]).length : str(a[0]).length) : env.line.length;
      case 'toupper': return str(a[0]).toUpperCase();
      case 'tolower': return str(a[0]).toLowerCase();
      case 'substr': return str(a[0]).substr(num(a[1]) - 1, a[2] === undefined ? undefined : num(a[2]));
      case 'index': return str(a[0]).indexOf(str(a[1])) + 1;
      case 'int': return Math.trunc(num(a[0]));
      case 'sqrt': return Math.sqrt(num(a[0]));
      case 'sprintf': return formatPrintf(str(a[0]), a.slice(1));
      case 'split': {
        const parts = a[2] !== undefined ? str(a[0]).split(str(a[2])) : splitFields(str(a[0]));
        const arrName = (args[1] as { k: 'var'; name: string }).name;
        arrays[arrName] = {};
        parts.forEach((pp, k) => (arrays[arrName][String(k + 1)] = pp));
        return parts.length;
      }
      case 'gsub':
      case 'sub': {
        const re = args[0].k === 'regex' ? (args[0] as { v: RegExp }).v : new RegExp(str(a[0]));
        const target = args[2] ?? { k: 'field', e: { k: 'num', v: 0 } };
        const cur = str(read(target));
        const g = new RegExp(re.source, name === 'gsub' ? 'g' : '');
        const count = (cur.match(g) ?? []).length;
        assign(target, cur.replace(g, str(a[1]).replace(/\\&/g, '\u0001').replace(/&/g, '$&').replace(/\u0001/g, '&')));
        return count;
      }
      case 'match': {
        const m = new RegExp(str(a[1])).exec(str(a[0]));
        env.vars.RSTART = m ? m.index + 1 : 0;
        env.vars.RLENGTH = m ? m[0].length : -1;
        return env.vars.RSTART;
      }
      case 'system': return runCommand(ctx, str(a[0]).split(/\s+/), { stdin: '', out: io.out, err: io.err });
      case 'exp': return Math.exp(num(a[0]));
      case 'log': return Math.log(num(a[0]));
      case 'rand': return Math.random();
      case 'srand': return 0;
      case 'strftime': return str(a[0]);
    }
    throw new Error(`awk: function ${name} never defined`);
  };
  const ev = (e: Expr): AwkValue => {
    switch (e.k) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'regex': return e.v.test(env.line) ? 1 : 0;
      case 'var': return env.vars[e.name] ?? '';
      case 'field': return getField(num(ev(e.e)));
      case 'index': return (arrays[e.arr] ??= {})[keyOf(e.key)] ?? '';
      case 'in': return (arrays[e.arr] ?? {})[str(ev(e.key))] !== undefined ? 1 : 0;
      case 'un': return e.op === '!' ? (truthy(ev(e.a)) ? 0 : 1) : -num(ev(e.a));
      case 'concat': return str(ev(e.a)) + str(ev(e.b));
      case 'cond': return truthy(ev(e.c)) ? ev(e.a) : ev(e.b);
      case 'call': return call(e.name, e.args);
      case 'incr': {
        const old = num(read(e.target));
        assign(e.target, old + e.delta);
        return e.prefix ? old + e.delta : old;
      }
      case 'assign': {
        const rhs = ev(e.v);
        let v: AwkValue = rhs;
        if (e.op !== '=') {
          const cur = num(read(e.target));
          v = e.op === '+=' ? cur + num(rhs) : e.op === '-=' ? cur - num(rhs) : e.op === '*=' ? cur * num(rhs) : cur / num(rhs);
        }
        assign(e.target, v);
        return v;
      }
      case 'bin': {
        if (e.op === '&&') return truthy(ev(e.a)) && truthy(ev(e.b)) ? 1 : 0;
        if (e.op === '||') return truthy(ev(e.a)) || truthy(ev(e.b)) ? 1 : 0;
        if (e.op === '~' || e.op === '!~') {
          const re = e.b.k === 'regex' ? e.b.v : new RegExp(str(ev(e.b)));
          const m = re.test(str(ev(e.a)));
          return (e.op === '~' ? m : !m) ? 1 : 0;
        }
        const a = ev(e.a);
        const b = ev(e.b);
        switch (e.op) {
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(b) === 0 ? (() => { throw new Error('awk: division by zero'); })() : num(a) / num(b);
          case '%': return num(a) % num(b);
          case '<': return compare(a, b) < 0 ? 1 : 0;
          case '<=': return compare(a, b) <= 0 ? 1 : 0;
          case '>': return compare(a, b) > 0 ? 1 : 0;
          case '>=': return compare(a, b) >= 0 ? 1 : 0;
          case '==': return compare(a, b) === 0 ? 1 : 0;
          case '!=': return compare(a, b) !== 0 ? 1 : 0;
        }
      }
    }
    throw new Error('awk: bad expression');
  };
  const run = (stmts: Stmt[]) => {
    for (const s of stmts) {
      switch (s.k) {
        case 'print': {
          const text = (s.args.length ? s.args.map((a) => str(ev(a))).join(str(env.vars.OFS)) : env.line) + str(env.vars.ORS);
          if (s.file) writeFile(ctx.sys.fs, abs(ctx, str(ev(s.file))), text, actor(ctx), ctx.sys.now, true);
          else io.out(text);
          break;
        }
        case 'printf': io.out(formatPrintf(str(ev(s.args[0])), s.args.slice(1).map(ev))); break;
        case 'expr': ev(s.e); break;
        case 'if': if (truthy(ev(s.cond))) run(s.then); else if (s.else) run(s.else); break;
        case 'while': { let g = 0; while (truthy(ev(s.cond))) { if (++g > 100000) throw new Error('awk: loop limit'); run(s.body); } break; }
        case 'for': {
          if (s.init) run([s.init]);
          let g = 0;
          while (!s.cond || truthy(ev(s.cond))) {
            if (++g > 100000) throw new Error('awk: loop limit');
            run(s.body);
            if (s.step) run([s.step]);
          }
          break;
        }
        case 'forin': for (const key of Object.keys(arrays[s.arr] ?? {})) { env.vars[s.v] = key; run(s.body); } break;
        case 'next': throw new AwkNext();
        case 'exit': throw new AwkExit();
        case 'delete': if (s.key) delete (arrays[s.arr] ?? {})[str(ev(s.key))]; else arrays[s.arr] = {}; break;
      }
    }
  };
  const inputs = readInputs(ctx, io, files, 'awk');
  try {
    for (const r of rules) if (r.pattern === 'BEGIN') run(r.body);
    const rangeActive = new Map<Rule, boolean>();
    let nr = 0;
    outer: for (const f of inputs) {
      env.vars.FILENAME = f.name;
      let fnr = 0;
      for (const line of lines(f.content)) {
        nr++;
        fnr++;
        env.vars.NR = nr;
        env.vars.FNR = fnr;
        setLine(line);
        try {
          for (const r of rules) {
            if (r.pattern === 'BEGIN' || r.pattern === 'END') continue;
            let matches = true;
            if (r.range) {
              const active = rangeActive.get(r) ?? false;
              if (!active) {
                matches = truthy(ev(r.range[0]));
                if (matches) rangeActive.set(r, !truthy(ev(r.range[1])));
              } else if (truthy(ev(r.range[1]))) rangeActive.set(r, false);
            } else if (r.pattern) matches = truthy(ev(r.pattern));
            if (matches) run(r.body);
          }
        } catch (e) {
          if (e instanceof AwkNext) continue;
          if (e instanceof AwkExit) break outer;
          throw e;
        }
      }
    }
    for (const r of rules) if (r.pattern === 'END') run(r.body);
  } catch (e) {
    if (e instanceof AwkExit) return 0;
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  return 0;
}
