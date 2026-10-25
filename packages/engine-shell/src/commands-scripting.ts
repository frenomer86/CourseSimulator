/**
 * Commands for scripting and automation labs: mktemp, flock, timeout, date -d, checksums and
 * base64, envsubst, install, logger, mail, openssl, shellcheck, jq, bats, logrotate, quotas,
 * newusers and pwgen, and curl/wget against the lab REST API.
 */

import { listDir, lookup, mkdir, readFile, remove, walk, writeFile, type FsNode } from './fs.js';
import type { ShellSystem } from './system.js';
import { actor, currentUser, parse, runCommand, runScript, ShellSyntaxError, type Ctx } from './shell.js';
import { abs, errText, fullDate, parseOpts, readInputs, strftime, type IO } from './util.js';
import { SYSADMIN_COMMANDS } from './commands-sysadmin.js';
import { md5, sha1, sha256, toBase64, fromBase64 } from './hash.js';
import { compile, formatJ, JqError, parseJsonStream, runJq, type JqValue } from './jq.js';
import { makeCert, makeKey, opensslDate, readCert } from './cert.js';
import { apiAt, handleApi, type ApiResponse } from './labapi.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
const ROOT = { user: 'root', groups: ['root'] };

function rd(sys: ShellSystem, path: string): string | null {
  try {
    const l = lookup(sys.fs, path, ROOT);
    return l && l.node.type === 'file' ? l.node.content : null;
  } catch {
    return null;
  }
}

function wr(sys: ShellSystem, path: string, content: string): void {
  mkdir(sys.fs, path.slice(0, path.lastIndexOf('/')) || '/', ROOT, sys.now, true);
  writeFile(sys.fs, path, content, ROOT, sys.now);
}

/** A repeatable pseudo-random generator per machine, so generated names do not collide. */
function rand(sys: ShellSystem): () => number {
  const key = '/run/lab/rand';
  let seed = Number(rd(sys, key) ?? sys.now % 2147483647) || 12345;
  return () => {
    seed = (seed * 48271) % 2147483647;
    wr(sys, key, String(seed));
    return seed / 2147483647;
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/* ----------------------------------------------------------------------------- dates */

const UNIT_MS: Record<string, number> = { sec: 1000, second: 1000, min: 60000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, fortnight: 1209600000 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** GNU date -d: ISO dates and times, @epoch, today/yesterday/tomorrow, "N units [ago]", "+N days", next/last weekday. */
export function parseDate(text: string, now: number): number | null {
  let s = text.trim().toLowerCase();
  if (!s || s === 'now' || s === 'today') return now;
  const epoch = /^@(-?\d+)$/.exec(s);
  if (epoch) return Number(epoch[1]) * 1000;
  let base = now;
  let explicitDate = false;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(z|utc|gmt|[+-]\d{2}:?\d{2}))?/.exec(s);
  if (iso) {
    base = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0));
    const off = iso[7] && /^[+-]/.test(iso[7]) ? iso[7].replace(':', '') : null;
    if (off) base -= (Number(off.slice(0, 3)) * 60 + Math.sign(Number(off.slice(0, 3)) || 1) * Number(off.slice(3))) * 60000;
    s = s.slice(iso[0].length).trim();
    explicitDate = true;
  } else {
    // "22 oct 2026", "oct 22 2026", "oct 22, 2026 14:00"
    const named = /^(?:[a-z]{3,9},?\s+)?(?:(\d{1,2})\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2}),?)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (named) {
      const mon = MONTHS.indexOf((named[2] ?? named[3]).slice(0, 3));
      if (mon >= 0) {
        base = Date.UTC(Number(named[5]), mon, Number(named[1] ?? named[4]), Number(named[6] ?? 0), Number(named[7] ?? 0), Number(named[8] ?? 0));
        s = s.slice(named[0].length).trim();
        explicitDate = true;
      }
    }
    const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (!explicitDate && time) {
      const d = new Date(now);
      base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(time[1]), Number(time[2]), Number(time[3] ?? 0));
      s = s.slice(time[0].length).trim();
    }
  }
  let t = base;
  while (s) {
    let m: RegExpExecArray | null;
    if ((m = /^(yesterday|tomorrow|today|now)\b\s*/.exec(s))) {
      t += m[1] === 'yesterday' ? -86400000 : m[1] === 'tomorrow' ? 86400000 : 0;
    } else if ((m = /^(next|last|this)\s+([a-z]+)\s*/.exec(s))) {
      const sign = m[1] === 'last' ? -1 : m[1] === 'next' ? 1 : 0;
      const wd = WEEKDAYS.findIndex((w) => w.startsWith(m![2].slice(0, 3)));
      const unit = m[2].replace(/s$/, '');
      if (wd >= 0) {
        const cur = new Date(t).getUTCDay();
        let diff = wd - cur;
        if (sign > 0 && diff <= 0) diff += 7;
        if (sign < 0 && diff >= 0) diff -= 7;
        t += diff * 86400000;
      } else if (UNIT_MS[unit]) t += sign * UNIT_MS[unit];
      else if (unit === 'month' || unit === 'year') t = addMonths(t, sign * (unit === 'year' ? 12 : 1));
      else return null;
    } else if ((m = /^([+-]?\s*\d+)?\s*(sec|second|min|minute|hour|day|week|fortnight|month|year)s?\b\s*(ago)?\s*/.exec(s)) && (m[1] !== undefined || m[2])) {
      let n = m[1] !== undefined ? Number(m[1].replace(/\s+/g, '')) : 1;
      if (m[3]) n = -n;
      if (m[2] === 'month' || m[2] === 'year') t = addMonths(t, n * (m[2] === 'year' ? 12 : 1));
      else t += n * UNIT_MS[m[2]];
    } else if ((m = /^(z|utc|gmt)\b\s*/.exec(s))) {
      /* already UTC */
    } else return null;
    s = s.slice(m[0].length).trim();
  }
  return t;
}

function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
}

/* ----------------------------------------------------------------------------- shellcheck */

type Sev = 'error' | 'warning' | 'info' | 'style';
interface Finding {
  line: number;
  col: number;
  len: number;
  code: number;
  sev: Sev;
  msg: string;
}

const SEV_RANK: Record<Sev, number> = { error: 3, warning: 2, info: 1, style: 0 };

/** The commonest ShellCheck rules, found with a quote-aware scan of each line. */
export function shellcheckFindings(src: string): Finding[] {
  const out: Finding[] = [];
  const lines = src.split('\n');
  const add = (line: number, col: number, len: number, code: number, sev: Sev, msg: string) => out.push({ line, col, len, code, sev, msg });
  if (!src.startsWith('#!')) add(1, 0, 1, 2148, 'error', 'Tips depend on target shell and yours is unknown. Add a shebang or a \'shell\' directive.');
  try {
    parse(src.replace(/^#!.*/, ''));
  } catch (e) {
    if (e instanceof ShellSyntaxError) {
      const ln = Number(/line (\d+)/.exec(e.message)?.[1] ?? lines.length);
      add(ln, 0, 1, 1073, 'error', `Couldn't parse this script: ${e.message.replace(/ \(line \d+\)/, '')}. Fix any mentioned problems and try again.`);
      return out;
    }
  }
  // Names assigned and names used, for SC2034 and SC2154.
  const assigned = new Set<string>();
  const used = new Set<string>();
  const ENVLIKE = /^(HOME|PATH|USER|LOGNAME|SHELL|PWD|OLDPWD|HOSTNAME|UID|EUID|RANDOM|LINENO|IFS|OPTARG|OPTIND|REPLY|BASH_REMATCH|BASH_COMMAND|FUNCNAME|SECONDS|TMPDIR|LANG|TERM|EDITOR|PS1|MAPFILE|PIPESTATUS|BATS_\w+|output|status|lines)$/;
  let heredoc: string | null = null;
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    if (heredoc !== null) {
      if (raw.replace(/^\t+/, '') === heredoc) heredoc = null;
      return;
    }
    const hd = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(raw);
    if (hd && !/<<</.test(raw)) heredoc = hd[1];
    const line = raw.replace(/^\s*#.*$/, '');
    if (!line.trim()) return;
    for (const m of line.matchAll(/(?:^\s*|[;&|]\s*|\b(?:then|do|else)\s+|\b(?:local|declare|readonly|export|typeset)\s+(?:-\w+\s+)*)([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/g)) assigned.add(m[1]);
    for (const m of line.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)\s+in\b|\bfor\s*\(\(\s*([A-Za-z_]\w*)/g)) assigned.add(m[1] ?? m[2]);
    for (const m of line.matchAll(/\bread\b(.*)$/g)) {
      // Options -a -d -i -n -N -p -t -u take a value (-a names an array); every other word is a variable.
      // Words are split like the shell does (quotes keep spaces); ; & | < > end the command.
      const words: string[] = [];
      for (const t of m[1].match(/"[^"]*"|'[^']*'|[;&|<>]+|[^\s;&|<>"']+/g) ?? []) {
        if (/^[;&|<>]/.test(t)) break;
        words.push(t);
      }
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        if (w.startsWith('-')) {
          const takes = /[adinNptu]$/.exec(w);
          if (takes && k + 1 < words.length) {
            if (takes[0] === 'a' && /^[A-Za-z_]\w*$/.test(words[k + 1])) assigned.add(words[k + 1]);
            k++;
          }
          continue;
        }
        if (/^[A-Za-z_]\w*$/.test(w)) assigned.add(w);
        else break;
      }
    }
    for (const m of line.matchAll(/\b(?:mapfile|readarray)\s+(?:-\w+\s+(?:\d+\s+)?)*([A-Za-z_]\w*)/g)) assigned.add(m[1]);
    for (const m of line.matchAll(/\bgetopts\s+\S+\s+([A-Za-z_]\w*)/g)) assigned.add(m[1]);
    for (const m of line.matchAll(/\bprintf\s+-v\s+([A-Za-z_]\w*)/g)) assigned.add(m[1]);
    for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
    for (const m of line.matchAll(/\$\{#?!?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
    for (const m of line.matchAll(/\(\(([^)]*)\)\)/g)) for (const v of m[1].matchAll(/[A-Za-z_]\w*/g)) used.add(v[0]);
    for (const m of line.matchAll(/\b(?:export|unset)\s+([A-Za-z_]\w*)/g)) used.add(m[1]);
    for (const m of line.matchAll(/\[\[?\s*-v\s+([A-Za-z_]\w*)/g)) used.add(m[1]);
    for (const m of line.matchAll(/\$\{([A-Za-z_]\w*)[:]?[=]/g)) assigned.add(m[1]);

    // Quote-aware scan for unquoted expansions.
    let q: '' | "'" | '"' = '';
    let inCond = false;
    let arith = 0;
    const firstWord = /^\s*(\S+)/.exec(line)?.[1] ?? '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q === "'") {
        if (c === "'") q = '';
        continue;
      }
      if (c === '\\') {
        i++;
        continue;
      }
      if (q === '"') {
        if (c === '"') q = '';
        // "$(...)" opens a new quoting context: skip it whole, quotes inside included.
        else if (c === '$' && line[i + 1] === '(') i = skipParen(line, i + 1);
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        continue;
      }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (line.startsWith('[[', i)) inCond = true;
      if (line.startsWith(']]', i)) inCond = false;
      if (line.startsWith('((', i) || line.startsWith('$((', i)) arith++;
      if (line.startsWith('))', i) && arith) arith--;
      if (c === '`') {
        const end = line.indexOf('`', i + 1);
        add(n, i, end > i ? end - i + 1 : 1, 2006, 'style', 'Use $(...) notation instead of legacy backticks `...`.');
        if (end > i) i = end;
        continue;
      }
      if (c !== '$' || inCond || arith) continue;
      // Assignment right-hand side (x=$y), case word and here-string are safe.
      const before = line.slice(0, i);
      const tokenStart = before.search(/\S*$/);
      const token = before.slice(tokenStart);
      if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(token)) {
        if (line[i + 1] === '(') i = skipParen(line, i + 1);
        continue;
      }
      if (/\bcase\s+$/.test(before) || /<<<\s*$/.test(before)) continue;
      if (line[i + 1] === '(' && line[i + 2] !== '(') {
        const end = skipParen(line, i + 1);
        const inner = line.slice(i + 2, end);
        if (/\b(for|select)\s+\w+\s+in\s+$/.test(before)) {
          if (/^\s*ls\b/.test(inner)) add(n, i, end - i + 1, 2045, 'error', 'Iterating over ls output is fragile. Use globs.');
          else if (/^\s*cat\b/.test(inner)) add(n, i, end - i + 1, 2013, 'info', "To read lines rather than words, pipe/redirect to a 'while read' loop.");
        } else if (!/^\s*(local|declare|export|readonly)\b/.test(line) && firstWord !== 'echo') add(n, i, end - i + 1, 2046, 'warning', 'Quote this to prevent word splitting.');
        i = end;
        continue;
      }
      const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*])/.exec(line.slice(i));
      if (!m) continue;
      const name = m[1].replace(/^\{|\}$/g, '');
      if (/^[@*]$/.test(name) || /\[[@*]\]$/.test(name)) add(n, i, m[0].length, 2068, 'error', 'Double quote array expansions to avoid re-splitting elements.');
      else if (/^#/.test(name) || /^[?#$!-]$/.test(name)) {
        /* counts and special parameters cannot split */
      } else if (/\b(for|select)\s+\w+\s+in\s+.*$/.test(before) && !/\bdo\b/.test(before)) {
        /* for x in $list: shellcheck warns separately; keep quiet */
      } else add(n, i, m[0].length, 2086, 'info', 'Double quote to prevent globbing and word splitting.');
      i += m[0].length - 1;
    }

    if (/^\s*[A-Za-z_]\w*\s+=\s/.test(line) && !/^\s*(echo|printf|test|\[)\b/.test(line)) add(n, line.search(/\S/), 1, 1068, 'error', "Don't put spaces around the = in assignments (or quote to make it literal).");
    const cd = /^\s*cd\s+[^;&|]*$/.exec(line);
    if (cd && !/\|\||&&/.test(line)) add(n, line.indexOf('cd'), line.trim().length, 2164, 'warning', "Use 'cd ... || exit' or 'cd ... || return' in case cd fails.");
    const rd = /\bread\b(?![^|]*\s-[a-zA-Z]*r)/.exec(line);
    if (rd && /^\s*(while\s+(IFS=\S*\s+)?)?read\b|[|;&]\s*read\b|\bread\s+-p\b/.test(line) && !/\bread\s+-[a-zA-Z]*r/.test(line)) add(n, rd.index, 4, 2162, 'info', 'read without -r will mangle backslashes.');
    const cat = /\bcat\s+("[^"]+"|'[^']+'|[^\s|;&<>]+)\s*\|/.exec(line);
    if (cat && !/\bcat\s+-/.test(line)) add(n, cat.index, cat[0].length - 1, 2002, 'style', "Useless cat. Consider 'cmd < file | ..' or 'cmd file | ..' instead.");
    const status = /\[\[?\s*"?\$\?"?\s+-(eq|ne)|\(\(\s*\$\?\s*[!=]=/.exec(line);
    if (status) add(n, status.index, status[0].length, 2181, 'style', "Check exit code directly with e.g. 'if mycmd;', not indirectly with $?.");
    const masked = /\b(local|declare|export|readonly)\s+(?:-\w+\s+)*[A-Za-z_]\w*=\$\(/.exec(line);
    if (masked) add(n, masked.index, masked[0].length, 2155, 'warning', 'Declare and assign separately to avoid masking return values.');
    const rmvar = /\brm\s+(-\w+\s+)*"?\$\{?([A-Za-z_]\w*)\}?"?\//.exec(line);
    if (rmvar && /-[a-zA-Z]*r/.test(rmvar[1] ?? '') && !/\$\{\w+:\?/.test(line)) add(n, rmvar.index, rmvar[0].length, 2115, 'warning', `Use "\${var:?}" to ensure this never expands to /* .`);
    const sq = /\b(echo|printf)\s+(?:-\w+\s+)*'[^']*\$[A-Za-z_{][^']*'/.exec(line);
    if (sq) add(n, sq.index, sq[0].length, 2016, 'info', "Expressions don't expand in single quotes, use double quotes for that.");
    const fmt = /\bprintf\s+(?:-v\s+\w+\s+)?("[^"]*\$[A-Za-z_{][^"]*"|\$[A-Za-z_{]\S*)/.exec(line);
    if (fmt) add(n, fmt.index, fmt[0].length, 2059, 'info', "Don't use variables in the printf format string. Use printf '..%s..' \"$foo\".");
    const ar = /\$\(\(([^)]*\$[A-Za-z_][^)]*)\)\)/.exec(line);
    if (ar && !/\$\{?#|\$[0-9@#?]/.test(ar[1])) add(n, ar.index, ar[0].length, 2004, 'style', '$/${} is unnecessary on arithmetic variables.');
    const evl = /\beval\s+"?\$/.exec(line);
    if (evl) add(n, evl.index, 4, 2294, 'warning', 'eval negates the benefit of arrays and runs data as code: avoid it, and never eval input you did not write.');
  });
  // SC2034: assigned, never used. SC2154: used (lower case), never assigned.
  lines.forEach((raw, idx) => {
    const m = /^\s*(?:(?:local|declare|readonly|typeset)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(raw);
    if (m && !used.has(m[1]) && !/^\s*export\b/.test(raw) && !ENVLIKE.test(m[1])) add(idx + 1, raw.indexOf(m[1]), m[1].length, 2034, 'warning', `${m[1]} appears unused. Verify use (or export if used externally).`);
  });
  const reported = new Set<string>();
  lines.forEach((raw, idx) => {
    if (/^\s*#/.test(raw)) return;
    for (const m of raw.matchAll(/\$\{?([a-z_][a-z0-9_]*)/g)) {
      const v = m[1];
      if (assigned.has(v) || ENVLIKE.test(v) || reported.has(v) || /^\d/.test(v)) continue;
      // Positional or quoted-literal contexts are skipped: only flag clear references.
      if (raw.slice(0, m.index).split("'").length % 2 === 0) continue;
      reported.add(v);
      add(idx + 1, m.index!, m[0].length, 2154, 'warning', `${v} is referenced but not assigned.`);
    }
  });
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

function skipParen(line: string, open: number): number {
  let depth = 0;
  for (let j = open; j < line.length; j++) {
    if (line[j] === '(') depth++;
    else if (line[j] === ')' && --depth === 0) return j;
  }
  return line.length - 1;
}

const WIKI_SHORT: Record<number, string> = { 2086: 'Double quote to prevent globbing ...', 2034: 'foo appears unused. Verify it or e...', 2154: 'var is referenced but not assigned.', 2164: "Use 'cd ... || exit' or 'cd ... || ...", 2162: 'read without -r will mangle backs...', 2006: 'Use $(...) notation instead of le...', 2046: 'Quote this to prevent word splitt...', 2068: 'Double quote array expansions to ...', 2148: 'Tips depend on target shell and y...' };

/* ----------------------------------------------------------------------------- logrotate */

interface RotateBlock {
  paths: string[];
  opts: Record<string, string | true>;
  post?: string;
  pre?: string;
  file: string;
}

function parseRotateConfig(sys: ShellSystem, file: string, inherited: Record<string, string | true>, errors: string[], seen = new Set<string>()): RotateBlock[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = rd(sys, file);
  if (text === null) {
    errors.push(`error: cannot stat ${file}: No such file or directory`);
    return [];
  }
  const blocks: RotateBlock[] = [];
  const globals = { ...inherited };
  const lines = text.split('\n');
  const KNOWN = /^(daily|weekly|monthly|yearly|hourly|rotate|compress|nocompress|delaycompress|nodelaycompress|missingok|nomissingok|notifempty|ifempty|create|nocreate|copytruncate|nocopytruncate|size|maxsize|minsize|maxage|dateext|nodateext|dateformat|olddir|noolddir|sharedscripts|nosharedscripts|su|compresscmd|compressext|extension|tabooext|mail|nomail|start|include|postrotate|prerotate|firstaction|lastaction|endscript|copy|shred|dateyesterday)$/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*$/, '').trim();
    if (!l) continue;
    const open = /^(.+?)\s*\{$/.exec(l);
    if (open) {
      const block: RotateBlock = { paths: open[1].split(/\s+/).map((p) => p.replace(/^"|"$/g, '')), opts: { ...globals }, file };
      let closed = false;
      for (i++; i < lines.length; i++) {
        const b = lines[i].replace(/#.*$/, '').trim();
        if (!b) continue;
        if (b === '}') {
          closed = true;
          break;
        }
        if (b === 'postrotate' || b === 'prerotate') {
          const script: string[] = [];
          for (i++; i < lines.length && lines[i].trim() !== 'endscript'; i++) script.push(lines[i]);
          if (b === 'postrotate') block.post = script.join('\n');
          else block.pre = script.join('\n');
          continue;
        }
        const [k, ...v] = b.split(/\s+/);
        if (!KNOWN.test(k)) {
          errors.push(`error: ${file}:${i + 1} unknown option '${k}' -- ignoring line`);
          continue;
        }
        if (k === 'rotate' && !/^\d+$/.test(v[0] ?? '')) errors.push(`error: ${file}:${i + 1} bad rotation count '${v[0] ?? ''}'`);
        applyOpt(block.opts, k, v);
      }
      if (!closed) errors.push(`error: ${file}:${lines.length} missing '}' at end of file`);
      blocks.push(block);
      continue;
    }
    const [k, ...v] = l.split(/\s+/);
    if (k === 'include') {
      const target = v[0];
      const l2 = lookup(sys.fs, target, ROOT);
      if (l2?.node.type === 'dir') for (const e of listDir(sys.fs, target, ROOT).sort((a, b) => a.name.localeCompare(b.name))) blocks.push(...parseRotateConfig(sys, `${target}/${e.name}`, globals, errors, seen));
      else blocks.push(...parseRotateConfig(sys, target, globals, errors, seen));
      continue;
    }
    if (!KNOWN.test(k)) {
      errors.push(`error: ${file}:${i + 1} unknown option '${k}' -- ignoring line`);
      continue;
    }
    applyOpt(globals, k, v);
  }
  return blocks;
}

function applyOpt(opts: Record<string, string | true>, k: string, v: string[]): void {
  if (/^(daily|weekly|monthly|yearly|hourly)$/.test(k)) opts.period = k;
  else if (k.startsWith('no') && k !== 'notifempty' && k !== 'nocreate') delete opts[k.slice(2)];
  else if (k === 'nocreate') delete opts.create;
  else if (k === 'ifempty') delete opts.notifempty;
  else opts[k] = v.length ? v.join(' ') : true;
}

function parseSize(s: string): number {
  const m = /^(\d+)([kKmMgG]?)$/.exec(s);
  if (!m) return Infinity;
  return Number(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 } as Record<string, number>)[m[2].toLowerCase()];
}

/* ----------------------------------------------------------------------------- quotas */

interface QuotaState {
  [fs: string]: { users: Record<string, { bsoft: number; bhard: number; isoft: number; ihard: number }>; grace?: number };
}

const QUOTA_FILE = '/etc/lab/quota.json';

function quotaState(sys: ShellSystem): QuotaState {
  try {
    return JSON.parse(rd(sys, QUOTA_FILE) ?? '{}') as QuotaState;
  } catch {
    return {};
  }
}

/** Blocks (KB) and inodes a user owns under a mount point. */
function usage(sys: ShellSystem, mount: string, user: string): { blocks: number; inodes: number } {
  let blocks = 0;
  let inodes = 0;
  try {
    walk(sys.fs, mount, ROOT, (_p, node: FsNode) => {
      if (node.owner !== user) return;
      inodes++;
      blocks += node.type === 'file' ? Math.max(4, Math.ceil(node.content.length / 4096) * 4) : 4;
    });
  } catch {
    /* unreadable mount */
  }
  return { blocks, inodes };
}

function deviceOf(sys: ShellSystem, mount: string): string {
  const fstab = rd(sys, '/etc/fstab') ?? '';
  for (const l of fstab.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f[1] === mount && !l.trim().startsWith('#')) return f[0];
  }
  return mount === '/' ? '/dev/sda2' : '/dev/sda3';
}

/* ----------------------------------------------------------------------------- curl and the lab API */

interface CurlOpts {
  method?: string;
  headers: string[];
  data: string[];
  json?: boolean;
  silent: boolean;
  showErr: boolean;
  include: boolean;
  head: boolean;
  output?: string;
  writeOut?: string;
  fail: boolean;
  failWithBody: boolean;
  retry: number;
  user?: string;
  verbose: boolean;
  url?: string;
}

function parseCurl(args: string[]): CurlOpts {
  const o: CurlOpts = { headers: [], data: [], silent: false, showErr: false, include: false, head: false, fail: false, failWithBody: false, retry: 0, verbose: false };
  const takes = new Set(['X', 'H', 'd', 'o', 'w', 'u', 'm', 'A', 'e', 'b', 'T', 'F', 'x']);
  const long: Record<string, string> = { request: 'X', header: 'H', data: 'd', 'data-raw': 'd', 'data-binary': 'd', 'data-ascii': 'd', output: 'o', 'write-out': 'w', user: 'u', 'max-time': 'm', 'user-agent': 'A', silent: 's', 'show-error': 'S', include: 'i', head: 'I', fail: 'f', location: 'L', insecure: 'k', verbose: 'v' };
  const set = (f: string, v?: string) => {
    switch (f) {
      case 'X': o.method = v; break;
      case 'H': o.headers.push(v ?? ''); break;
      case 'd': o.data.push(v ?? ''); break;
      case 'o': o.output = v; break;
      case 'w': o.writeOut = v; break;
      case 'u': o.user = v; break;
      case 's': o.silent = true; break;
      case 'S': o.showErr = true; break;
      case 'i': o.include = true; break;
      case 'I': o.head = true; break;
      case 'f': o.fail = true; break;
      case 'v': o.verbose = true; break;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      if (name === 'json') {
        o.json = true;
        o.data.push(inline ?? args[++i] ?? '');
        continue;
      }
      if (name === 'retry') {
        o.retry = Number(inline ?? args[++i]) || 0;
        continue;
      }
      if (name === 'fail-with-body') {
        o.failWithBody = true;
        continue;
      }
      if (name === 'retry-delay' || name === 'connect-timeout' || name === 'retry-max-time') {
        if (inline === undefined) i++;
        continue;
      }
      const f = long[name];
      if (f && takes.has(f)) set(f, inline ?? args[++i]);
      else if (f) set(f);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const f = a[k];
        if (takes.has(f)) {
          set(f, k + 1 < a.length ? a.slice(k + 1) : args[++i]);
          break;
        }
        set(f);
      }
      continue;
    }
    o.url = a;
  }
  return o;
}

function apiCurl(o: CurlOpts, io: IO, ctx: Ctx, host: string, path: string): number {
  const sys = ctx.sys;
  if (sys.services.labapi && !sys.services.labapi.active) {
    io.err(`curl: (7) Failed to connect to ${host} port ${/:(\d+)/.exec(o.url ?? '')?.[1] ?? 80} after 0 ms: Connection refused\n`);
    return 7;
  }
  const headers: Record<string, string> = {};
  for (const h of o.headers) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  let body: string | undefined;
  if (o.data.length) {
    body = o.data
      .map((d) => {
        if (!d.startsWith('@')) return d;
        try {
          return readFile(sys.fs, abs(ctx, d.slice(1)), actor(ctx)).replace(/\n$/, '');
        } catch {
          io.err(`Warning: Couldn't read data from file "${d.slice(1)}", this makes an empty POST.\n`);
          return '';
        }
      })
      .join('&');
    if (o.json) {
      headers['Content-Type'] ??= 'application/json';
      headers.Accept ??= 'application/json';
    } else if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (o.user) headers.Authorization = `Basic ${toBase64(o.user)}`;
  const method = (o.method ?? (o.head ? 'HEAD' : body !== undefined ? 'POST' : 'GET')).toUpperCase();
  let res: ApiResponse;
  let tries = 0;
  for (;;) {
    res = handleApi(sys, { method: method === 'HEAD' ? 'GET' : method, path, headers, body });
    if (o.verbose) {
      io.err(`> ${method} ${path} HTTP/1.1\n> Host: ${host}\n${Object.entries(headers).map(([k, v]) => `> ${k}: ${v}\n`).join('')}>\n`);
      io.err(`< HTTP/1.1 ${res.status} ${res.reason}\n${Object.entries(res.headers).map(([k, v]) => `< ${k}: ${v}\n`).join('')}<\n`);
    }
    if (o.retry > tries && [408, 429, 500, 502, 503, 504].includes(res.status)) {
      tries++;
      if (!o.silent) io.err(`Warning: Problem : HTTP error. Will retry in 1 seconds. ${o.retry - tries + 1} retr${o.retry - tries + 1 === 1 ? 'y' : 'ies'} left.\n`);
      sys.now += 1000;
      continue;
    }
    break;
  }
  const failed = res.status >= 400 && (o.fail || o.failWithBody);
  const head = `HTTP/1.1 ${res.status} ${res.reason}\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}\n`).join('')}\n`;
  let text = method === 'HEAD' ? head : (o.include ? head : '') + (failed && !o.failWithBody ? '' : res.body);
  if (o.output && o.output !== '-') {
    try {
      writeFile(sys.fs, abs(ctx, o.output), res.body, actor(ctx), sys.now);
    } catch (e) {
      io.err(`curl: (23) Failure writing output to destination: ${errText(e, o.output)}\n`);
      return 23;
    }
    text = method === 'HEAD' || o.include ? head : '';
  }
  io.out(text);
  if (o.writeOut) {
    const ct = res.headers['Content-Type'] ?? '';
    io.out(o.writeOut.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%\{(\w+)\}/g, (_m, k: string) => ({ http_code: String(res.status), response_code: String(res.status), content_type: ct, size_download: String(res.body.length), url_effective: o.url ?? '', method, time_total: '0.012', num_retries: String(tries) })[k] ?? ''));
  }
  if (failed) {
    if (!o.silent || o.showErr) io.err(`curl: (22) The requested URL returned error: ${res.status}\n`);
    return 22;
  }
  return 0;
}

/* ----------------------------------------------------------------------------- the commands */

export const SCRIPTING_COMMANDS: Record<string, Cmd> = {
  mktemp: (args, io, ctx) => {
    const o = parseOpts(args, ['p', 't'], { directory: 'd', tmpdir: 'p', dry_run: 'u' });
    const tmpl = o.rest[0] ?? 'tmp.XXXXXXXXXX';
    if (!/X{3,}/.test(tmpl)) {
      io.err(`mktemp: too few X's in template ‘${tmpl}’\n`);
      return 1;
    }
    const r = rand(ctx.sys);
    const name = tmpl.replace(/X{3,}(?!.*X{3,})/, (xs) => Array.from({ length: xs.length }, () => ALNUM[Math.floor(r() * ALNUM.length)]).join(''));
    const dir = o.values.p ?? (o.rest[0] && o.rest[0].includes('/') ? '' : '/tmp');
    const path = abs(ctx, dir ? `${dir}/${name}` : name);
    try {
      if (o.flags.has('d')) mkdir(ctx.sys.fs, path, actor(ctx), ctx.sys.now);
      else writeFile(ctx.sys.fs, path, '', actor(ctx), ctx.sys.now);
      const l = lookup(ctx.sys.fs, path, ROOT);
      if (l) l.node.mode = o.flags.has('d') ? 0o700 : 0o600;
    } catch (e) {
      io.err(`mktemp: failed to create ${o.flags.has('d') ? 'directory' : 'file'} via template ‘${tmpl}’: ${errText(e, path).replace(/^.*?: /, '')}\n`);
      return 1;
    }
    io.out(path + '\n');
    return 0;
  },

  flock: (args, io, ctx) => {
    let i = 0;
    let nonblock = false;
    let wait: number | undefined;
    let conflict = 1;
    while (args[i]?.startsWith('-')) {
      const a = args[i];
      if (a === '-n' || a === '--nonblock') nonblock = true;
      else if (a === '-w' || a === '--timeout') wait = Number(args[++i]);
      else if (a === '-E' || a === '--conflict-exit-code') conflict = Number(args[++i]);
      else if (a === '-c' || a === '--command') break;
      i++;
    }
    const target = args[i++];
    if (!target) {
      io.err('flock: not enough arguments\n');
      return 64;
    }
    let command = args.slice(i);
    if (command[0] === '-c' || command[0] === '--command') command = ['bash', '-c', command.slice(1).join(' ')];
    const lockPath = /^\d+$/.test(target) ? null : abs(ctx, target);
    // Another running process holding the same lock (seeded by the lab) blocks us.
    const held = lockPath && ctx.sys.processes.some((p) => /\bflock\b/.test(p.cmd) && p.cmd.includes(lockPath));
    if (held) {
      if (nonblock || wait !== undefined) return conflict;
      io.err('(flock would wait here until the other process releases the lock; the simulator stops instead.)\n');
      return conflict;
    }
    if (lockPath && !lookup(ctx.sys.fs, lockPath, actor(ctx))) {
      try {
        writeFile(ctx.sys.fs, lockPath, '', actor(ctx), ctx.sys.now);
      } catch (e) {
        io.err(`flock: cannot open lock file ${target}: ${errText(e, target).replace(/^.*?: /, '')}\n`);
        return 1;
      }
    }
    if (!command.length) return 0;
    return runCommand(ctx, command, io);
  },

  timeout: (args, io, ctx) => {
    const o = args.filter((a, k) => !(a.startsWith('-') && k < args.indexOf(args.find((x) => !x.startsWith('-')) ?? '')));
    const [dur, ...cmd] = o;
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(dur ?? '');
    if (!m || !cmd.length) {
      io.err("timeout: invalid time interval or missing command\nTry 'timeout --help' for more information.\n");
      return 125;
    }
    const secs = Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
    if (cmd[0] === 'sleep' && Number(cmd[1]) > secs) {
      ctx.sys.now += secs * 1000;
      return 124;
    }
    return runCommand(ctx, cmd, io);
  },

  date: (args, io, ctx) => {
    let ms = ctx.sys.now;
    let fmt: string | undefined;
    let utc = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('+')) fmt = a.slice(1);
      else if (a === '-u' || a === '--utc' || a === '--universal') utc = true;
      else if (a === '-d' || a === '--date' || a.startsWith('--date=') || (a.startsWith('-d') && a.length > 2)) {
        const text = a === '-d' || a === '--date' ? args[++i] ?? '' : a.startsWith('--date=') ? a.slice(7) : a.slice(2);
        const t = parseDate(text, ctx.sys.now);
        if (t === null) {
          io.err(`date: invalid date ‘${text}’\n`);
          return 1;
        }
        ms = t;
      } else if (a === '-r' || a === '--reference') {
        const f = args[++i] ?? '';
        try {
          const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
          if (!l) throw new Error('missing');
          ms = l.node.mtime;
        } catch {
          io.err(`date: ${f}: No such file or directory\n`);
          return 1;
        }
      } else if (a === '-I' || a.startsWith('-I') || a.startsWith('--iso-8601')) {
        const kind = a.replace(/^(-I|--iso-8601=?)/, '') || 'date';
        fmt = kind.startsWith('s') ? '%Y-%m-%dT%H:%M:%S+00:00' : kind.startsWith('m') ? '%Y-%m-%dT%H:%M+00:00' : kind.startsWith('h') ? '%Y-%m-%dT%H+00:00' : '%Y-%m-%d';
      } else if (a === '-R' || a === '--rfc-email') fmt = '%a, %d %b %Y %H:%M:%S +0000';
      else if (a === '-s' || a === '--set') {
        io.err('date: cannot set date: Operation not permitted (the simulated clock is fixed)\n');
        return 1;
      }
    }
    void utc;
    io.out((fmt !== undefined ? strftime(ms, fmt) : fullDate(ms)) + '\n');
    return 0;
  },

  sha256sum: (args, io, ctx) => checksum('sha256sum', sha256, args, io, ctx),
  sha1sum: (args, io, ctx) => checksum('sha1sum', sha1, args, io, ctx),
  md5sum: (args, io, ctx) => checksum('md5sum', md5, args, io, ctx),

  base64: (args, io, ctx) => {
    const o = parseOpts(args, ['w'], { decode: 'd', wrap: 'w' });
    let text: string;
    try {
      text = o.rest.length && o.rest[0] !== '-' ? readFile(ctx.sys.fs, abs(ctx, o.rest[0]), actor(ctx)) : io.stdin;
    } catch (e) {
      io.err(`base64: ${errText(e, o.rest[0])}\n`);
      return 1;
    }
    if (o.flags.has('d')) {
      try {
        io.out(fromBase64(text));
      } catch {
        io.err('base64: invalid input\n');
        return 1;
      }
      return 0;
    }
    const wrap = o.values.w !== undefined ? Number(o.values.w) : 76;
    const enc = toBase64(text);
    io.out((wrap > 0 ? enc.replace(new RegExp(`(.{${wrap}})`, 'g'), '$1\n').replace(/\n$/, '') : enc) + '\n');
    return 0;
  },

  envsubst: (args, io, ctx) => {
    const only = args.find((a) => !a.startsWith('-'));
    const allowed = only ? new Set([...only.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].map((m) => m[1])) : null;
    const env = ctx.sys.env;
    io.out(io.stdin.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a: string, b: string) => {
      const name = a ?? b;
      if (allowed && !allowed.has(name)) return m;
      return env[name] ?? '';
    }));
    return 0;
  },

  install: (args, io, ctx) => {
    const o = parseOpts(args, ['m', 'o', 'g', 't'], { mode: 'm', owner: 'o', group: 'g', directory: 'd', 'target-directory': 't' });
    const after = (path: string) => {
      if (o.values.m) runCommand(ctx, ['chmod', o.values.m, path], io);
      if (o.values.o || o.values.g) runCommand(ctx, ['chown', `${o.values.o ?? ''}${o.values.g ? ':' + o.values.g : ''}`, path], io);
    };
    if (o.flags.has('d')) {
      for (const d of o.rest) {
        try {
          mkdir(ctx.sys.fs, abs(ctx, d), actor(ctx), ctx.sys.now, true);
        } catch (e) {
          io.err(`install: cannot create directory '${d}': ${errText(e, d).replace(/^.*?: /, '')}\n`);
          return 1;
        }
        after(d);
      }
      return 0;
    }
    const sources = o.values.t ? o.rest : o.rest.slice(0, -1);
    const dest = o.values.t ?? o.rest[o.rest.length - 1];
    if (!sources.length || !dest) {
      io.err("install: missing destination file operand\nTry 'install --help' for more information.\n");
      return 1;
    }
    for (const s of sources) {
      let content: string;
      try {
        content = readFile(ctx.sys.fs, abs(ctx, s), actor(ctx));
      } catch (e) {
        io.err(`install: cannot stat '${s}': ${errText(e, s).replace(/^.*?: /, '')}\n`);
        return 1;
      }
      const dl = lookup(ctx.sys.fs, abs(ctx, dest), actor(ctx));
      const target = dl?.node.type === 'dir' ? `${dest.replace(/\/$/, '')}/${s.split('/').pop()}` : dest;
      try {
        writeFile(ctx.sys.fs, abs(ctx, target), content, actor(ctx), ctx.sys.now);
      } catch (e) {
        io.err(`install: cannot create regular file '${target}': ${errText(e, target).replace(/^.*?: /, '')}\n`);
        return 1;
      }
      if (!o.values.m) runCommand(ctx, ['chmod', '755', target], io);
      after(target);
    }
    return 0;
  },

  logger: (args, io, ctx) => {
    const o = parseOpts(args, ['t', 'p', 'i'], { tag: 't', priority: 'p', stderr: 's' });
    const msg = o.rest.length ? o.rest.join(' ') : io.stdin.replace(/\n$/, '');
    const tag = o.values.t ?? currentUser(ctx);
    const line = `${strftime(ctx.sys.now, '%b %e %H:%M:%S')} ${ctx.sys.hostname} ${tag}[${2000 + (ctx.sys.history.length % 900)}]: ${msg}\n`;
    const prev = rd(ctx.sys, '/var/log/messages') ?? '';
    wr(ctx.sys, '/var/log/messages', prev + line);
    if (o.flags.has('s')) io.err(`<13>${line}`);
    return 0;
  },

  mail: (args, io, ctx) => mailCmd(args, io, ctx),
  mailx: (args, io, ctx) => mailCmd(args, io, ctx),

  openssl: (args, io, ctx) => {
    const [sub, ...rest] = args;
    const sys = ctx.sys;
    const val = (flag: string) => {
      const i = rest.indexOf(flag);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const has = (flag: string) => rest.includes(flag);
    if (sub === 'rand') {
      const n = Number(rest.filter((a) => /^\d+$/.test(a)).pop() ?? 16);
      const r = rand(sys);
      const bytes = Array.from({ length: n }, () => Math.floor(r() * 256));
      if (has('-hex')) io.out(bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '\n');
      else io.out(btoa(String.fromCharCode(...bytes)) + '\n');
      return 0;
    }
    if (sub === 'x509') {
      const file = val('-in');
      let pem: string;
      try {
        pem = file ? readFile(sys.fs, abs(ctx, file), actor(ctx)) : io.stdin;
      } catch (e) {
        io.err(`Could not open file or uri for loading certificate from ${file}: ${errText(e, file ?? '').replace(/^.*?: /, '')}\n`);
        return 1;
      }
      const c = readCert(pem);
      if (!c) {
        io.err('Could not read certificate from ' + (file ?? '<stdin>') + '\nUnable to load certificate\n');
        return 1;
      }
      const checkend = val('-checkend');
      if (checkend !== undefined) {
        const expires = Date.parse(c.notAfter) <= sys.now + Number(checkend) * 1000;
        io.out(expires ? 'Certificate will expire\n' : 'Certificate will not expire\n');
        return expires ? 1 : 0;
      }
      const out: string[] = [];
      if (has('-subject')) out.push(`subject=${c.subject.replace(/^\//, '').replace(/\//g, ', ').replace(/=/g, ' = ')}`);
      if (has('-issuer')) out.push(`issuer=${c.issuer.replace(/^\//, '').replace(/\//g, ', ').replace(/=/g, ' = ')}`);
      if (has('-serial')) out.push(`serial=${c.serial}`);
      if (has('-dates') || has('-startdate')) out.push(`notBefore=${opensslDate(c.notBefore)}`);
      if (has('-dates') || has('-enddate')) out.push(`notAfter=${opensslDate(c.notAfter)}`);
      if (has('-fingerprint')) out.push(`SHA1 Fingerprint=${sha1(pem).toUpperCase().match(/../g)!.join(':')}`);
      if (has('-text') || !out.length) out.push(`Certificate:\n    Data:\n        Version: 3 (0x2)\n        Serial Number: ${c.serial}\n        Issuer: ${c.issuer}\n        Validity\n            Not Before: ${opensslDate(c.notBefore)}\n            Not After : ${opensslDate(c.notAfter)}\n        Subject: ${c.subject}${c.san?.length ? `\n        X509v3 Subject Alternative Name:\n            ${c.san.map((s) => `DNS:${s}`).join(', ')}` : ''}`);
      if (!has('-noout') && !has('-text') && !out.length) out.push(pem.trimEnd());
      io.out(out.join('\n') + '\n');
      return 0;
    }
    if (sub === 'req' && has('-x509')) {
      const subj = val('-subj') ?? '/CN=localhost';
      const days = Number(val('-days') ?? 30);
      const keyout = val('-keyout');
      const out = val('-out');
      if (!out) {
        io.err('openssl req: use -out FILE (and -keyout FILE) to save the certificate\n');
        return 1;
      }
      const notBefore = new Date(sys.now).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const notAfter = new Date(sys.now + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      try {
        writeFile(sys.fs, abs(ctx, out), makeCert({ subject: subj, notBefore, notAfter }), actor(ctx), sys.now);
        if (keyout) {
          writeFile(sys.fs, abs(ctx, keyout), makeKey(subj + sys.now), actor(ctx), sys.now);
          const l = lookup(sys.fs, abs(ctx, keyout), ROOT);
          if (l) l.node.mode = 0o600;
        }
      } catch (e) {
        io.err(`openssl: ${errText(e, out)}\n`);
        return 1;
      }
      io.err('.....+++++\n.....+++++\n-----\n');
      return 0;
    }
    if (sub === 'dgst' || sub === 'sha256' || sub === 'md5' || sub === 'sha1') {
      const alg = sub === 'dgst' ? (rest.find((a) => /^-(sha256|sha1|md5)$/.test(a)) ?? '-sha256').slice(1) : sub;
      const fn = alg === 'md5' ? md5 : alg === 'sha1' ? sha1 : sha256;
      const files = rest.filter((a) => !a.startsWith('-'));
      if (!files.length) {
        io.out(`${alg.toUpperCase().replace('SHA256', 'SHA2-256')}(stdin)= ${fn(io.stdin)}\n`);
        return 0;
      }
      for (const f of files) {
        try {
          io.out(`${alg.toUpperCase().replace('SHA256', 'SHA2-256')}(${f})= ${fn(readFile(sys.fs, abs(ctx, f), actor(ctx)))}\n`);
        } catch (e) {
          io.err(`${f}: ${errText(e, f).replace(/^.*?: /, '')}\n`);
          return 1;
        }
      }
      return 0;
    }
    if (sub === 'passwd') {
      const pw = rest.filter((a) => !a.startsWith('-')).pop() ?? io.stdin.trim();
      const salt = 'Lab' + sha1(pw).slice(0, 5);
      io.out(`$6$${salt}$${toBase64(sha256(salt + pw)).replace(/[=+/]/g, '').slice(0, 86)}\n`);
      return 0;
    }
    if (sub === 's_client') {
      io.err(`connect: Connection refused\n(Only this machine is simulated: inspect certificate files with openssl x509 -in FILE -noout -dates.)\n`);
      return 1;
    }
    io.err(`Invalid command '${sub ?? ''}'; type "help" for a list.\n(Simulated subcommands: rand, x509, req -x509, dgst, passwd.)\n`);
    return 1;
  },

  shellcheck: (args, io, ctx) => {
    const o = parseOpts(args, ['f', 'S', 'e', 'i', 's'], { format: 'f', severity: 'S', exclude: 'e', include: 'i', shell: 's' });
    const minSev = (o.values.S ?? 'style') as Sev;
    const excluded = new Set((o.values.e ?? '').split(',').filter(Boolean).map((c) => Number(c.replace(/^SC/i, ''))));
    let code = 0;
    const seenCodes = new Map<number, string>();
    if (!o.rest.length) {
      io.err('No files specified.\n\nUsage: shellcheck [OPTIONS...] FILES...\n');
      return 3;
    }
    for (const f of o.rest) {
      let src: string;
      try {
        src = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
      } catch (e) {
        io.err(`${f}: ${errText(e, f).replace(/^.*?: /, '')}\n`);
        code = 2;
        continue;
      }
      const lines = src.split('\n');
      // Directives: "# shellcheck disable=SC2086" before the first command applies to the file, otherwise to the next line.
      const fileDisabled = new Set<number>();
      const lineDisabled = new Map<number, Set<number>>();
      let seenCommand = false;
      lines.forEach((l, i) => {
        const d = /#\s*shellcheck\s+disable=([\w,]+)/.exec(l);
        if (d) {
          const codes = d[1].split(',').map((c) => Number(c.replace(/^SC/i, '')));
          if (!seenCommand) codes.forEach((c) => fileDisabled.add(c));
          else lineDisabled.set(i + 2, new Set(codes));
        } else if (l.trim() && !l.trim().startsWith('#')) seenCommand = true;
      });
      const findings = shellcheckFindings(src).filter((x) => SEV_RANK[x.sev] >= SEV_RANK[minSev] && !excluded.has(x.code) && !fileDisabled.has(x.code) && !lineDisabled.get(x.line)?.has(x.code));
      if (!findings.length) continue;
      code = Math.max(code, 1);
      if (o.values.f === 'gcc') {
        for (const x of findings) io.out(`${f}:${x.line}:${x.col + 1}: ${x.sev === 'style' || x.sev === 'info' ? 'note' : x.sev}: ${x.msg} [SC${x.code}]\n`);
        continue;
      }
      const byLine = new Map<number, Finding[]>();
      for (const x of findings) byLine.set(x.line, [...(byLine.get(x.line) ?? []), x]);
      for (const [ln, list] of byLine) {
        io.out(`\nIn ${f} line ${ln}:\n${lines[ln - 1] ?? ''}\n`);
        for (const x of list.sort((a, b) => b.col - a.col)) {
          const mark = x.len >= 2 ? '^' + '-'.repeat(x.len - 2) + '^' : '^--';
          io.out(`${' '.repeat(x.col)}${mark} SC${x.code} (${x.sev}): ${x.msg}\n`);
          seenCodes.set(x.code, x.msg);
        }
      }
    }
    if (seenCodes.size && o.values.f !== 'gcc') io.out(`\nFor more information:\n${[...seenCodes].map(([c, m]) => `  https://www.shellcheck.net/wiki/SC${c} -- ${WIKI_SHORT[c] ?? m.slice(0, 33) + (m.length > 33 ? '...' : '')}\n`).join('')}`);
    return code;
  },

  jq: (args, io, ctx) => {
    if (args[0] === '--version' || args[0] === '-V') {
      io.out('jq-1.7.1\n');
      return 0;
    }
    let raw = false;
    let compact = false;
    let nullInput = false;
    let slurp = false;
    let exitStatus = false;
    let sortKeys = false;
    let tab = false;
    let join = false;
    const vars: Record<string, JqValue> = { ENV: { ...ctx.sys.env }, __now: ctx.sys.now };
    let filter: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--arg') {
        vars[args[i + 1]] = args[i + 2] ?? '';
        i += 2;
      } else if (a === '--argjson') {
        try {
          vars[args[i + 1]] = JSON.parse(args[i + 2] ?? 'null') as JqValue;
        } catch {
          io.err(`jq: Invalid JSON text passed to --argjson\n`);
          return 2;
        }
        i += 2;
      } else if (a === '--tab') tab = true;
      else if (a === '--raw-output') raw = true;
      else if (a === '--compact-output') compact = true;
      else if (a === '--sort-keys') sortKeys = true;
      else if (a === '--slurp') slurp = true;
      else if (a === '--null-input') nullInput = true;
      else if (a === '--exit-status') exitStatus = true;
      else if (/^-[rcnseSjM]+$/.test(a)) {
        raw ||= a.includes('r') || a.includes('j');
        join ||= a.includes('j');
        compact ||= a.includes('c');
        nullInput ||= a.includes('n');
        slurp ||= a.includes('s');
        exitStatus ||= a.includes('e');
        sortKeys ||= a.includes('S');
      } else if (filter === undefined) filter = a;
      else files.push(a);
    }
    if (filter === undefined) {
      io.err('Usage:\tjq [OPTIONS] FILTER [FILES...]\n');
      return 2;
    }
    let node;
    try {
      node = compile(filter);
    } catch (e) {
      io.err(`jq: error: ${(e as Error).message}\njq: 1 compile error\n`);
      return 3;
    }
    let inputs: JqValue[];
    try {
      const text = files.length ? readInputs(ctx, io, files, 'jq').map((f) => f.content).join('\n') : io.stdin;
      inputs = nullInput ? [null] : parseJsonStream(text);
      if (slurp && !nullInput) inputs = [inputs];
    } catch (e) {
      io.err(`jq: error (at <stdin>:0): ${(e as Error).message}\n`);
      return 2;
    }
    let last: JqValue | undefined;
    for (const input of inputs) {
      try {
        for (const v of runJq(node, input, vars)) {
          io.out(formatJ(v, { raw, compact, sortKeys, tab }) + (join ? '' : '\n'));
          last = v;
        }
      } catch (e) {
        if (e instanceof JqError) {
          io.err(`jq: error (at <stdin>:${inputs.indexOf(input) + 1}): ${e.message}\n`);
          return 5;
        }
        throw e;
      }
    }
    if (exitStatus) return last === undefined ? 4 : last === null || last === false ? 1 : 0;
    return 0;
  },

  bats: (args, io, ctx) => {
    const tap = args.includes('--tap') || args.includes('-t') || args.some((a) => /^--formatter=?tap$/.test(a)) || (args.includes('-F') && args[args.indexOf('-F') + 1] === 'tap');
    const targets = args.filter((a, k) => !a.startsWith('-') && args[k - 1] !== '-F');
    if (!targets.length) {
      io.err('Error: Must specify at least one <test>\nUsage: bats [OPTIONS] <tests>\n');
      return 1;
    }
    const files: string[] = [];
    for (const t of targets) {
      const p = abs(ctx, t);
      const l = lookup(ctx.sys.fs, p, actor(ctx));
      if (!l) {
        io.err(`bats: ${t} does not exist\n`);
        return 1;
      }
      if (l.node.type === 'dir') files.push(...listDir(ctx.sys.fs, p, actor(ctx)).filter((e) => e.name.endsWith('.bats')).map((e) => `${p}/${e.name}`).sort());
      else files.push(p);
    }
    const results: Array<{ name: string; ok: boolean; skip?: string; detail?: string; file: string }> = [];
    for (const file of files) {
      const src = readFile(ctx.sys.fs, file, actor(ctx));
      const names: string[] = [];
      const body = src.replace(/^(\s*)@test\s+(["'])(.*?)\2\s*\{/gm, (_m, ws: string, _q: string, name: string) => {
        names.push(name);
        return `${ws}__bats_test_${names.length}() {`;
      });
      const dir = file.slice(0, file.lastIndexOf('/')) || '/';
      const prelude = [
        `BATS_TEST_DIRNAME='${dir}'`,
        `BATS_TEST_FILENAME='${file}'`,
        `BATS_TMPDIR=/tmp`,
        `load() { source "$BATS_TEST_DIRNAME/$1.bash" 2>/dev/null || source "$BATS_TEST_DIRNAME/$1"; }`,
        `run() { status=0; output="$("$@" 2>&1)" || status=$?; lines=(); if [ -n "$output" ]; then mapfile -t lines <<< "$output"; fi; return 0; }`,
        `skip() { printf '%s' "\${1:-}" > /tmp/.bats-skip; exit 253; }`,
      ].join('\n');
      const offset = prelude.split('\n').length;
      names.forEach((name, k) => {
        if (lookup(ctx.sys.fs, '/tmp/.bats-skip', ROOT)) remove(ctx.sys.fs, '/tmp/.bats-skip', ROOT, false);
        const script = `${prelude}\n${body.replace(/^#!.*/, '')}\nset -eE\ntrap 'echo "__BATS_FAILED__ $LINENO $BASH_COMMAND"' ERR\n${/^\s*(function\s+)?teardown\s*\(\)/m.test(body) ? "trap 'teardown' EXIT\n" : ''}${/^\s*(function\s+)?setup\s*\(\)/m.test(body) ? 'setup\n' : ''}BATS_TEST_NAME='${name.replace(/'/g, '')}'\n__bats_test_${k + 1}\n`;
        const buf: string[] = [];
        const code = runScript(ctx, script, [], file, { stdin: '', out: (s) => buf.push(s), err: (s) => buf.push(s) });
        const out = buf.join('');
        if (code === 253) {
          results.push({ name, ok: true, skip: rd(ctx.sys, '/tmp/.bats-skip') ?? '', file });
          return;
        }
        if (code === 0) {
          results.push({ name, ok: true, file });
          return;
        }
        const fail = [...out.matchAll(/__BATS_FAILED__ (\d+) (.*)/g)].pop();
        const shown = out.replace(/__BATS_FAILED__.*\n?/g, '').trimEnd();
        const ln = fail ? Number(fail[1]) - offset : 0;
        const sourceLine = ln > 0 ? src.split('\n')[ln - 1]?.trim() : undefined;
        const detail = `(in test file ${file.replace(ctx.sys.cwd + '/', '')}, line ${ln > 0 ? ln : '?'})\n  \`${sourceLine || fail?.[2] || 'the test'}' failed${code !== 1 ? ` with status ${code}` : ''}${shown ? '\n' + shown.split('\n').map((l) => '  ' + l).join('\n') : ''}`;
        results.push({ name, ok: false, detail, file });
      });
    }
    const failures = results.filter((r) => !r.ok).length;
    const skipped = results.filter((r) => r.skip !== undefined).length;
    if (tap) {
      io.out(`1..${results.length}\n`);
      results.forEach((r, k) => {
        io.out(`${r.ok ? 'ok' : 'not ok'} ${k + 1} ${r.name}${r.skip !== undefined ? ` # skip${r.skip ? ' ' + r.skip : ''}` : ''}\n`);
        if (r.detail) io.out(r.detail.split('\n').map((l) => `# ${l}`).join('\n') + '\n');
      });
    } else {
      for (const r of results) {
        if (r.skip !== undefined) io.out(` - ${r.name} (skipped${r.skip ? ': ' + r.skip : ''})\n`);
        else io.out(` ${r.ok ? '✓' : '✗'} ${r.name}\n`);
        if (r.detail) io.out(r.detail.split('\n').map((l) => '   ' + l).join('\n') + '\n');
      }
      io.out(`\n${results.length} test${results.length === 1 ? '' : 's'}, ${failures} failure${failures === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''}\n`);
    }
    return failures ? 1 : 0;
  },

  logrotate: (args, io, ctx) => {
    const sys = ctx.sys;
    if (currentUser(ctx) !== 'root' && !args.includes('-d')) {
      io.err('error: error opening state file /var/lib/logrotate/status: Permission denied\n');
      return 1;
    }
    const debug = args.includes('-d') || args.includes('--debug');
    const force = args.includes('-f') || args.includes('--force');
    const verbose = args.includes('-v') || args.includes('--verbose') || debug;
    const configs = args.filter((a) => !a.startsWith('-'));
    if (!configs.length) {
      io.err('logrotate 3.21.0 - Copyright (C) 1995-2001 Red Hat, Inc.\nUsage: logrotate [-dfv] [-s|--state statefile] config_file ...\n');
      return 1;
    }
    const errors: string[] = [];
    const blocks = configs.flatMap((c) => parseRotateConfig(sys, abs(ctx, c), {}, errors));
    for (const e of errors) io.err(e + '\n');
    if (errors.some((e) => /missing '}'|bad rotation/.test(e))) return 1;
    const stateFile = '/var/lib/logrotate/status';
    const state = new Map<string, number>();
    for (const l of (rd(sys, stateFile) ?? '').split('\n')) {
      const m = /^"(.+)"\s+(\d+)-(\d+)-(\d+)/.exec(l);
      if (m) state.set(m[1], Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])));
    }
    const today = Date.UTC(new Date(sys.now).getUTCFullYear(), new Date(sys.now).getUTCMonth(), new Date(sys.now).getUTCDate());
    if (debug) io.out('WARNING: logrotate in debug mode does nothing except printing debug messages!  Consider using verbose mode (-v) instead if this is not what you want.\n\n');
    let code = 0;
    for (const b of blocks) {
      const opts = b.opts;
      const rotateN = Number(opts.rotate ?? 0);
      const period = String(opts.period ?? 'weekly');
      if (verbose) io.out(`rotating pattern: ${b.paths.join(' ')}  ${force ? 'forced from command line ' : ''}${opts.size ? `${opts.size} bytes ` : `(${period}) `}(${rotateN} rotations)\nempty log files are ${opts.notifempty ? 'not ' : ''}rotated, old logs are removed\n`);
      // Expand globs in the paths.
      const files: string[] = [];
      for (const p of b.paths) {
        if (!/[*?]/.test(p)) {
          files.push(p);
          continue;
        }
        const dir = p.slice(0, p.lastIndexOf('/')) || '/';
        const re = new RegExp('^' + p.slice(p.lastIndexOf('/') + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        try {
          for (const e of listDir(sys.fs, dir, ROOT)) if (re.test(e.name) && e.node.type === 'file' && !/\.\d+(\.gz)?$|-\d{8}(\.gz)?$/.test(e.name)) files.push(`${dir}/${e.name}`);
        } catch {
          /* missing directory */
        }
      }
      let rotatedAny = false;
      for (const f of files) {
        const content = rd(sys, f);
        if (verbose) io.out(`considering log ${f}\n`);
        if (content === null) {
          if (!opts.missingok) {
            io.err(`error: stat of ${f} failed: No such file or directory\n`);
            code = 1;
          } else if (verbose) io.out(`  log ${f} does not exist -- skipping\n`);
          continue;
        }
        if (opts.notifempty && !content.length) {
          if (verbose) io.out('  log does not need rotating (log is empty)\n');
          continue;
        }
        const last = state.get(f);
        const periodMs = { hourly: 3600000, daily: 86400000, weekly: 604800000, monthly: 2592000000, yearly: 31536000000 }[period] ?? 604800000;
        let due = force;
        if (!due && opts.size) due = content.length >= parseSize(String(opts.size));
        else if (!due) due = last !== undefined && today - last >= periodMs;
        if (!due) {
          if (verbose) io.out(last === undefined ? '  log does not need rotating (log has been rotated at ' + strftime(sys.now, '%Y-%m-%d %H:%M') + ', which is less than a ' + period.replace(/ly$/, '').replace('dai', 'day') + ' ago)\n' : `  log does not need rotating (log has been rotated at ${strftime(last, '%Y-%m-%d %H:%M')})\n`);
          if (last === undefined && !debug) state.set(f, today);
          continue;
        }
        if (verbose) io.out(`  log needs rotating\nrotating log ${f}, log->rotateCount is ${rotateN}\n`);
        if (debug) {
          io.out(`renaming ${f} to ${f}${opts.dateext ? '-' + strftime(sys.now, '%Y%m%d') : '.1'}\n`);
          if (opts.compress) io.out(`compressing log with: /bin/gzip\n`);
          continue;
        }
        rotatedAny = true;
        const dir = opts.olddir ? String(opts.olddir) : f.slice(0, f.lastIndexOf('/'));
        const base = `${dir}/${f.slice(f.lastIndexOf('/') + 1)}`;
        const gz = opts.compress ? '.gz' : '';
        if (opts.dateext) {
          writeFile(sys.fs, `${base}-${strftime(sys.now, '%Y%m%d')}${opts.compress && !opts.delaycompress ? '.gz' : ''}`, opts.compress && !opts.delaycompress ? '#CSLAB-GZ\n' + content : content, ROOT, sys.now);
          // Keep only the newest rotateN dated copies.
          const dated = listDir(sys.fs, dir, ROOT).filter((e) => e.name.startsWith(f.slice(f.lastIndexOf('/') + 1) + '-') && /-\d{8}(\.gz)?$/.test(e.name)).map((e) => e.name).sort();
          for (const old of dated.slice(0, Math.max(0, dated.length - rotateN))) remove(sys.fs, `${dir}/${old}`, ROOT, false);
        } else {
          // Shift name.N -> name.N+1, newest first; drop what falls beyond the rotate count.
          for (let n = rotateN; n >= 1; n--) {
            for (const ext of ['.gz', '']) {
              const from = `${base}.${n}${ext}`;
              const c = rd(sys, from);
              if (c === null) continue;
              remove(sys.fs, from, ROOT, false);
              if (n + 1 <= rotateN) {
                const toCompress = opts.compress && opts.delaycompress && n === 1 && ext === '';
                writeFile(sys.fs, `${base}.${n + 1}${ext || (toCompress ? '.gz' : '')}`, toCompress ? '#CSLAB-GZ\n' + c : c, ROOT, sys.now);
              }
            }
          }
          if (rotateN > 0) {
            const compressNow = opts.compress && !opts.delaycompress;
            writeFile(sys.fs, `${base}.1${compressNow ? gz : ''}`, compressNow ? '#CSLAB-GZ\n' + content : content, ROOT, sys.now);
          }
        }
        // The live log: emptied in place (copytruncate) or replaced by a new file (create).
        const node = lookup(sys.fs, f, ROOT)!.node;
        if (opts.copytruncate) writeFile(sys.fs, f, '', ROOT, sys.now);
        else {
          remove(sys.fs, f, ROOT, false);
          if (opts.create) {
            const [mode, owner, group] = String(opts.create === true ? '' : opts.create).split(/\s+/);
            writeFile(sys.fs, f, '', ROOT, sys.now);
            const n2 = lookup(sys.fs, f, ROOT)!.node;
            n2.mode = mode && /^[0-7]{3,4}$/.test(mode) ? parseInt(mode, 8) : node.mode;
            n2.owner = owner || node.owner;
            n2.group = group || node.group;
          }
        }
        state.set(f, today);
      }
      if (rotatedAny && b.post && !debug) {
        if (verbose) io.out('running postrotate script\n');
        const c = runScript(ctx, b.post, [], 'postrotate', io);
        if (c !== 0) {
          io.err(`error: error running shared postrotate script for '${b.paths.join(' ')}'\n`);
          code = 1;
        }
      }
    }
    const stamp = (t: number) => {
      const d = new Date(t);
      return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-0:0:0`;
    };
    if (!debug) wr(sys, stateFile, 'logrotate state -- version 2\n' + [...state].map(([f, t]) => `"${f}" ${stamp(t)}`).join('\n') + '\n');
    return code;
  },

  setquota: (args, io, ctx) => {
    if (currentUser(ctx) !== 'root') {
      io.err('setquota: Cannot write quota for user: Operation not permitted\n');
      return 1;
    }
    const rest = args.filter((a) => !/^-[ug]$/.test(a) && a !== '-a');
    const [user, bs, bh, is, ih, fs = '/'] = rest;
    if (!user || [bs, bh, is, ih].some((x) => !/^\d+[KMG]?$/i.test(x ?? ''))) {
      io.err('setquota: Usage: setquota [-u|-g] NAME BLOCK-SOFT BLOCK-HARD INODE-SOFT INODE-HARD FILESYSTEM\n');
      return 1;
    }
    if (!ctx.sys.users[user]) {
      io.err(`setquota: user ${user} does not exist.\n`);
      return 1;
    }
    const toKb = (v: string) => Number(v.replace(/[KMG]$/i, '')) * ({ K: 1, M: 1024, G: 1048576 } as Record<string, number>)[(/[KMG]$/i.exec(v)?.[0] ?? 'K').toUpperCase()];
    const st = quotaState(ctx.sys);
    const mount = abs(ctx, fs);
    (st[mount] ??= { users: {} }).users[user] = { bsoft: toKb(bs), bhard: toKb(bh), isoft: Number(is), ihard: Number(ih) };
    wr(ctx.sys, QUOTA_FILE, JSON.stringify(st));
    return 0;
  },

  repquota: (args, io, ctx) => {
    const st = quotaState(ctx.sys);
    const mounts = args.includes('-a') ? Object.keys(st) : args.filter((a) => !a.startsWith('-')).map((m) => abs(ctx, m));
    if (!mounts.length) {
      io.err('repquota: Not enough arguments\n');
      return 1;
    }
    for (const m of mounts) {
      const q = st[m]?.users ?? {};
      const human = args.includes('-s');
      const fmt = (kb: number) => (human ? (kb >= 1048576 ? (kb / 1048576).toFixed(0) + 'G' : kb >= 1024 ? Math.round(kb / 1024) + 'M' : kb + 'K') : String(kb));
      io.out(`*** Report for user quotas on device ${deviceOf(ctx.sys, m)}\nBlock grace time: 7days; Inode grace time: 7days\n                        Block limits                File limits\nUser            used    soft    hard  grace    used  soft  hard  grace\n----------------------------------------------------------------------\n`);
      const users = Object.keys(ctx.sys.users).filter((u) => q[u] || usage(ctx.sys, m, u).inodes > 0);
      for (const u of users) {
        const use = usage(ctx.sys, m, u);
        const lim = q[u] ?? { bsoft: 0, bhard: 0, isoft: 0, ihard: 0 };
        const overB = lim.bsoft > 0 && use.blocks > lim.bsoft;
        const overI = lim.isoft > 0 && use.inodes > lim.isoft;
        io.out(`${u.padEnd(10)}${overB ? '+' : '-'}${overI ? '+' : '-'} ${fmt(use.blocks).padStart(7)} ${fmt(lim.bsoft).padStart(7)} ${fmt(lim.bhard).padStart(7)} ${overB ? ' 7days' : '      '} ${String(use.inodes).padStart(7)} ${String(lim.isoft).padStart(5)} ${String(lim.ihard).padStart(5)}\n`);
      }
      io.out('\n');
    }
    return 0;
  },

  quota: (args, io, ctx) => {
    const ui = args.indexOf('-u');
    const user = (ui >= 0 ? args[ui + 1] : args.find((a) => !a.startsWith('-'))) ?? currentUser(ctx);
    if (user !== currentUser(ctx) && currentUser(ctx) !== 'root') {
      io.err(`quota: ${user} (uid ${ctx.sys.users[user]?.uid ?? '?'}): Permission denied\n`);
      return 1;
    }
    const st = quotaState(ctx.sys);
    const rows = Object.entries(st).filter(([, q]) => q.users[user]);
    if (!rows.length) {
      io.out(`Disk quotas for user ${user} (uid ${ctx.sys.users[user]?.uid ?? 0}): none\n`);
      return 0;
    }
    io.out(`Disk quotas for user ${user} (uid ${ctx.sys.users[user]?.uid ?? 0}): \n     Filesystem  blocks   quota   limit   grace   files   quota   limit   grace\n`);
    let over = false;
    for (const [m, q] of rows) {
      const lim = q.users[user];
      const use = usage(ctx.sys, m, user);
      const o = lim.bsoft > 0 && use.blocks > lim.bsoft;
      over ||= o;
      io.out(`${deviceOf(ctx.sys, m).padStart(15)} ${(String(use.blocks) + (o ? '*' : '')).padStart(7)} ${String(lim.bsoft).padStart(7)} ${String(lim.bhard).padStart(7)} ${o ? '  7days' : '       '} ${String(use.inodes).padStart(7)} ${String(lim.isoft).padStart(7)} ${String(lim.ihard).padStart(7)}\n`);
    }
    return over ? 1 : 0;
  },

  edquota: (_a, io) => {
    io.err('edquota opens an editor, which this terminal cannot show. Use setquota -u NAME SOFT HARD ISOFT IHARD FILESYSTEM instead.\n');
    return 1;
  },

  newusers: (args, io, ctx) => {
    if (currentUser(ctx) !== 'root') {
      io.err('newusers: Permission denied.\n');
      return 1;
    }
    let text: string;
    try {
      text = args[0] && args[0] !== '-' ? readFile(ctx.sys.fs, abs(ctx, args[0]), actor(ctx)) : io.stdin;
    } catch (e) {
      io.err(`newusers: ${errText(e, args[0])}\n`);
      return 1;
    }
    let code = 0;
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      const f = l.split(':');
      if (f.length !== 7) {
        io.err(`newusers: line ${i + 1}: invalid line\n`);
        code = 1;
        return;
      }
      const [name, pw, uid, gid, gecos, home, shell] = f;
      if (!ctx.sys.users[name]) {
        const opts = ['useradd', '-m'];
        if (uid) opts.push('-u', uid);
        if (gid && !/^\d+$/.test(gid)) {
          if (!ctx.sys.groups[gid]) runCommand(ctx, ['groupadd', gid], io);
          opts.push('-g', gid);
        }
        if (gecos) opts.push('-c', gecos);
        if (home) opts.push('-d', home);
        if (shell) opts.push('-s', shell);
        opts.push(name);
        if (runCommand(ctx, opts, io) !== 0) code = 1;
      }
      if (pw) runCommand(ctx, ['chpasswd'], { ...io, stdin: `${name}:${pw}\n` });
    });
    return code;
  },

  pwgen: (args, io, ctx) => {
    const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
    const len = nums[0] ?? 12;
    const count = nums[1] ?? 1;
    const symbols = args.some((a) => /^-[a-zA-Z]*y/.test(a));
    const chars = ALNUM + (symbols ? '!@#%^&*-_=+' : '');
    const r = rand(ctx.sys);
    for (let k = 0; k < count; k++) io.out(Array.from({ length: len }, () => chars[Math.floor(r() * chars.length)]).join('') + '\n');
    return 0;
  },

  dos2unix: (args, io, ctx) => convertEol(args, io, ctx, 'dos2unix'),
  unix2dos: (args, io, ctx) => convertEol(args, io, ctx, 'unix2dos'),

  curl: (args, io, ctx) => {
    const o = parseCurl(args);
    const m = /^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([/?][^\s#]*)?$/.exec(o.url ?? '');
    if (m) {
      const port = Number(m[3] ?? (m[1] === 'https' ? 443 : 80));
      if (apiAt(ctx.sys, m[2], port)) return apiCurl(o, io, ctx, m[2], m[4] ?? '/');
    }
    return SYSADMIN_COMMANDS.curl(args, io, ctx);
  },
  wget: (args, io, ctx) => {
    const url = args.find((a) => /^(https?:\/\/|[\w.-]+:\d+)/.test(a));
    const m = url ? /^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([/?][^\s#]*)?$/.exec(url) : null;
    if (m && apiAt(ctx.sys, m[2], Number(m[3] ?? 80))) {
      const oi = args.findIndex((a) => a === '-O' || /^-q?O/.test(a));
      const target = oi >= 0 ? (args[oi].length > 2 && args[oi] !== '-qO' ? args[oi].replace(/^-q?O/, '') : args[oi + 1]) : (m[4] ?? '/').split('/').pop() || 'index.html';
      const headers = args.flatMap((a, k) => (a === '--header' ? [args[k + 1]] : a.startsWith('--header=') ? [a.slice(9)] : []));
      const curlArgs = ['-s', ...headers.flatMap((h) => ['-H', h]), ...(target && target !== '-' ? ['-o', target] : []), url!];
      return apiCurl(parseCurl(curlArgs), io, ctx, m[2], m[4] ?? '/');
    }
    return SYSADMIN_COMMANDS.curl(args, io, ctx);
  },
};

function checksum(name: string, fn: (s: string) => string, args: string[], io: IO, ctx: Ctx): number {
  const o = parseOpts(args, [], { check: 'c', quiet: 'q', status: 's' });
  if (o.flags.has('c')) {
    let failed = 0;
    let missing = 0;
    const lists = o.rest.length ? o.rest : ['-'];
    for (const list of lists) {
      let text: string;
      try {
        text = list === '-' ? io.stdin : readFile(ctx.sys.fs, abs(ctx, list), actor(ctx));
      } catch (e) {
        io.err(`${name}: ${errText(e, list)}\n`);
        return 1;
      }
      for (const l of text.split('\n').filter((x) => x.trim())) {
        const m = /^([0-9a-fA-F]+)\s+\*?(.+)$/.exec(l);
        if (!m) continue;
        let content: string;
        try {
          content = readFile(ctx.sys.fs, abs(ctx, m[2]), actor(ctx));
        } catch {
          if (!o.flags.has('s')) io.out(`${m[2]}: FAILED open or read\n`);
          missing++;
          continue;
        }
        const ok = fn(content) === m[1].toLowerCase();
        if (!ok) failed++;
        if (!o.flags.has('s') && !(ok && o.flags.has('q'))) io.out(`${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`);
      }
    }
    if (!o.flags.has('s')) {
      if (missing) io.err(`${name}: WARNING: ${missing} listed file${missing > 1 ? 's' : ''} could not be read\n`);
      if (failed) io.err(`${name}: WARNING: ${failed} computed checksum${failed > 1 ? 's' : ''} did NOT match\n`);
    }
    return failed || missing ? 1 : 0;
  }
  if (!o.rest.length || o.rest[0] === '-') {
    io.out(`${fn(io.stdin)}  -\n`);
    return 0;
  }
  let code = 0;
  for (const f of o.rest) {
    try {
      const l = lookup(ctx.sys.fs, abs(ctx, f), actor(ctx));
      if (l?.node.type === 'dir') {
        io.err(`${name}: ${f}: Is a directory\n`);
        code = 1;
        continue;
      }
      io.out(`${fn(readFile(ctx.sys.fs, abs(ctx, f), actor(ctx)))}  ${f}\n`);
    } catch (e) {
      io.err(`${name}: ${errText(e, f)}\n`);
      code = 1;
    }
  }
  return code;
}

function mailCmd(args: string[], io: IO, ctx: Ctx): number {
  const o = parseOpts(args, ['s', 'r', 'c', 'b', 'a', 'u'], { subject: 's' });
  const sys = ctx.sys;
  const who = currentUser(ctx);
  if (!o.rest.length) {
    const box = rd(sys, `/var/spool/mail/${o.values.u ?? who}`) ?? '';
    const msgs = box.split(/^From /m).filter(Boolean);
    if (!msgs.length) {
      io.out(`No mail for ${o.values.u ?? who}\n`);
      return 1;
    }
    io.out(`Mail version 8.1.2 01/15/2001.  Type ? for help.\n"/var/spool/mail/${o.values.u ?? who}": ${msgs.length} message${msgs.length > 1 ? 's' : ''}\n`);
    msgs.forEach((m, i) => io.out(`>N  ${i + 1} ${(/^(\S+)/.exec(m)?.[1] ?? '').padEnd(20)} ${(/^Subject: (.*)$/m.exec(m)?.[1] ?? '').slice(0, 40)}\n`));
    return 0;
  }
  const body = io.stdin;
  for (const rcpt of [...o.rest, ...(o.values.c ? o.values.c.split(',') : [])]) {
    const local = rcpt.replace(/@.*/, '');
    if (!sys.users[local] && !/@/.test(rcpt)) {
      io.err(`${rcpt}... User unknown\n`);
      continue;
    }
    const box = /@/.test(rcpt) && !sys.users[local] ? '/var/spool/mail/outbound' : `/var/spool/mail/${local}`;
    const prev = rd(sys, box) ?? '';
    wr(sys, box, `${prev}From ${o.values.r ?? `${who}@${sys.hostname}`} ${strftime(sys.now, '%a %b %e %H:%M:%S %Y')}\nTo: ${rcpt}\nSubject: ${o.values.s ?? ''}\n\n${body}${body.endsWith('\n') ? '' : '\n'}\n`);
  }
  return 0;
}

function convertEol(args: string[], io: IO, ctx: Ctx, name: string): number {
  for (const f of args.filter((a) => !a.startsWith('-'))) {
    try {
      const c = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
      const out = name === 'dos2unix' ? c.replace(/\r\n/g, '\n') : c.replace(/\r?\n/g, '\r\n');
      writeFile(ctx.sys.fs, abs(ctx, f), out, actor(ctx), ctx.sys.now);
      io.err(`${name}: converting file ${f} to ${name === 'dos2unix' ? 'Unix' : 'DOS'} format...\n`);
    } catch (e) {
      io.err(`${name}: ${errText(e, f)}\n`);
      return 2;
    }
  }
  return 0;
}

