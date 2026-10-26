/**
 * Security scanners for the DevSecOps labs: gitleaks (secrets in git history, staged changes or a
 * directory), pip-audit and osv-scanner (vulnerable dependencies in requirements.txt and
 * package-lock.json), and trivy (vulnerable OS and language packages and secrets in images and
 * folders, and misconfigurations in Dockerfiles). The advisories are a small set of real ones.
 */

import { lookup, readFile, writeFile, type DirNode } from './fs.js';
import { actor, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { findRepo, openRepo, type Repo } from './git-core.js';
import { ancestors, headCommit } from './git-core.js';
import { containerFile, dockerState, findImage, type DockerImage } from './docker-engine.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/* ----------------------------------------------------------------------------- secret rules */

interface Rule {
  id: string;
  description: string;
  re: RegExp;
  entropy?: number;
}

const RULES: Rule[] = [
  { id: 'aws-access-token', description: 'Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/ },
  { id: 'github-pat', description: 'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.', re: /\b(ghp_[0-9a-zA-Z]{36})\b/ },
  { id: 'slack-bot-token', description: 'Identified a Slack Bot token, which may compromise bot integrations and communication channel security.', re: /\b(xox[baprs]-[0-9a-zA-Z-]{10,})\b/ },
  { id: 'stripe-access-token', description: 'Found a Stripe Access Token, posing a risk to payment processing services and sensitive financial data.', re: /\b((?:sk|rk)_(?:test|live|prod)_[0-9a-zA-Z]{10,99})\b/ },
  { id: 'private-key', description: 'Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.', re: /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY-----)/ },
  { id: 'jwt', description: 'Uncovered a JSON Web Token, which may lead to unauthorized access to web applications and sensitive user data.', re: /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.[a-zA-Z0-9/\\_-]{10,}={0,2})/ },
  { id: 'generic-api-key', description: 'Detected a Generic API Key, potentially exposing access to various services and sensitive operations.', re: /(?:api[_-]?key|secret|token|passwd|password|pwd)[\w.-]{0,20}\s*[:=]\s*['"]?([A-Za-z0-9+/_@!#$%^&*.-]{10,150})['"]?/i, entropy: 3.5 },
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let e = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

export interface Leak {
  rule: Rule;
  secret: string;
  match: string;
  file: string;
  line: number;
  commit?: string;
  author?: string;
  email?: string;
  date?: string;
}

/** Secrets in some lines of a file (lineNos: the 1-based numbers of the lines to look at). */
export function scanText(text: string, file: string, onlyLines?: Set<number>): Leak[] {
  const out: Leak[] = [];
  text.split('\n').forEach((line, i) => {
    if (onlyLines && !onlyLines.has(i + 1)) return;
    if (/gitleaks:allow/.test(line)) return;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const secret = m[1] ?? m[0];
      if (rule.entropy && (entropy(secret) < rule.entropy || /^(\$\{|\$[A-Z_]|<|changeme|example|xxxx)/i.test(secret))) continue;
      out.push({ rule, secret, match: m[0], file, line: i + 1 });
      break;
    }
  });
  return out;
}

const addedLines = (before: string | undefined, after: string): Set<number> => {
  const old = new Set((before ?? '').split('\n'));
  const s = new Set<number>();
  after.split('\n').forEach((l, i) => {
    if (!old.has(l)) s.add(i + 1);
  });
  return s;
};

function ignoreList(ctx: Ctx, dir: string): Set<string> {
  try {
    return new Set(readFile(ctx.sys.fs, `${dir}/.gitleaksignore`, actor(ctx)).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  } catch {
    return new Set();
  }
}

const fingerprint = (l: Leak) => `${l.commit ? l.commit + ':' : ''}${l.file}:${l.rule.id}:${l.line}`;

function printLeaks(io: IO, leaks: Leak[], verbose: boolean, redact: boolean, scanned: string): number {
  io.err('\n    ○\n    │╲\n    │ ○\n    ○ ░\n    ░    gitleaks\n\n');
  if (verbose) {
    for (const l of leaks) {
      const shown = redact ? l.match.replace(l.secret, 'REDACTED') : l.match;
      io.out(`Finding:     ${shown}\nSecret:      ${redact ? 'REDACTED' : l.secret}\nRuleID:      ${l.rule.id}\nEntropy:     ${entropy(l.secret).toFixed(6)}\nFile:        ${l.file}\nLine:        ${l.line}\n${l.commit ? `Commit:      ${l.commit}\nAuthor:      ${l.author}\nEmail:       ${l.email}\nDate:        ${l.date}\n` : ''}Fingerprint: ${fingerprint(l)}\n\n`);
    }
  }
  io.err(`10:02AM INF ${scanned}\n10:02AM INF scan completed in 14.2ms\n`);
  io.err(leaks.length ? `10:02AM WRN leaks found: ${leaks.length}\n` : '10:02AM INF no leaks found\n');
  return leaks.length ? 1 : 0;
}

function walkFiles(ctx: Ctx, dir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const l = lookup(ctx.sys.fs, dir, actor(ctx));
  if (!l) return out;
  if (l.node.type === 'file') return [{ path: dir.split('/').pop()!, content: l.node.content }];
  const rec = (n: DirNode, rel: string) => {
    for (const [name, c] of Object.entries(n.children)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = rel ? `${rel}/${name}` : name;
      if (c.type === 'dir') rec(c, p);
      else if (c.type === 'file') out.push({ path: p, content: c.content });
    }
  };
  if (l.node.type === 'dir') rec(l.node, '');
  return out;
}

const gitleaks: Cmd = (args, io, ctx) => {
  const [sub, ...rest] = args;
  if (sub === 'version' || sub === '--version') {
    io.out('8.21.2\n');
    return 0;
  }
  const verbose = rest.includes('-v') || rest.includes('--verbose');
  const redact = rest.some((a) => a === '--redact' || a.startsWith('--redact='));
  const val = (name: string) => {
    const i = rest.findIndex((a) => a === name || a.startsWith(name + '='));
    return i < 0 ? undefined : rest[i].includes('=') ? rest[i].slice(rest[i].indexOf('=') + 1) : rest[i + 1];
  };
  const source = abs(ctx, val('--source') ?? val('-s') ?? (sub === 'dir' || sub === 'directory' ? rest.find((a) => !a.startsWith('-')) ?? '.' : '.'));
  const exitCode = Number(val('--exit-code') ?? 1);
  const noGit = rest.includes('--no-git') || sub === 'dir' || sub === 'directory';
  const ignore = ignoreList(ctx, source);
  if (sub !== 'detect' && sub !== 'protect' && sub !== 'git' && !noGit) {
    io.err('Usage:\n  gitleaks [command]\n\nAvailable Commands:\n  dir         scan directories or files for secrets\n  git         scan git repositories for secrets\n  detect      detect secrets in code (deprecated: use git or dir)\n  protect     protect secrets in code (deprecated: use git --staged)\n  version     display gitleaks version\n');
    return 1;
  }
  let leaks: Leak[] = [];
  let scanned = '';
  if (noGit) {
    const files = walkFiles(ctx, source);
    for (const f of files) leaks.push(...scanText(f.content, f.path));
    scanned = `scanned ~${files.reduce((a, f) => a + f.content.length, 0)} bytes (${files.length} files)`;
  } else {
    const repoDir = findRepo(ctx, source);
    if (!repoDir) {
      io.err(`10:02AM ERR failed to scan Git repository error="${source} is not a git repository"\n`);
      return 1;
    }
    const r: Repo = openRepo(ctx, io, repoDir);
    const st = r.st;
    if (sub === 'protect' || rest.includes('--staged')) {
      const head = headCommit(st);
      const ht = head ? st.commits[head].tree : {};
      for (const [p, c] of Object.entries(st.index)) if (ht[p] !== c) leaks.push(...scanText(c, p, addedLines(ht[p], c)));
      scanned = `${Object.keys(st.index).length} staged files scanned`;
    } else {
      // Like git log --all: commits reachable from a branch, tag, remote-tracking ref or HEAD (rewritten-away commits are not scanned).
      const live = new Set<string>();
      for (const tip of [headCommit(st), ...Object.values(st.branches), ...Object.values(st.tags), ...Object.values(st.remoteRefs ?? {})]) for (const id of ancestors(st, tip)) live.add(id);
      const ids = Object.values(st.commits).filter((c) => live.has(c.id)).sort((a, b) => a.seq - b.seq);
      for (const c of ids) {
        const parent = c.parents[0] ? st.commits[c.parents[0]] : undefined;
        for (const [p, content] of Object.entries(c.tree)) {
          const before = parent?.tree[p];
          if (before === content) continue;
          for (const l of scanText(content, p, addedLines(before, content))) leaks.push({ ...l, commit: c.id, author: c.author, email: c.email, date: new Date(c.time).toISOString().replace(/\.\d+Z$/, 'Z') });
        }
      }
      scanned = `${ids.length} commits scanned.`;
    }
  }
  leaks = leaks.filter((l) => !ignore.has(fingerprint(l)));
  const reportPath = val('--report-path') ?? val('-r');
  if (reportPath) {
    const json = JSON.stringify(leaks.map((l) => ({ RuleID: l.rule.id, Description: l.rule.description, StartLine: l.line, File: l.file, Secret: redact ? 'REDACTED' : l.secret, Match: redact ? l.match.replace(l.secret, 'REDACTED') : l.match, Commit: l.commit ?? '', Author: l.author ?? '', Email: l.email ?? '', Date: l.date ?? '', Fingerprint: fingerprint(l) })), null, 1);
    try {
      writeFile(ctx.sys.fs, abs(ctx, reportPath), json + '\n', actor(ctx), ctx.sys.now);
    } catch (e) {
      io.err(`10:02AM ERR could not write report error="${(e as Error).message}"\n`);
    }
  }
  const code = printLeaks(io, leaks, verbose, redact, scanned);
  return code ? exitCode : 0;
};

/* ----------------------------------------------------------------------------- advisories */

type Sev = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface Advisory {
  id: string;
  cve: string;
  pkg: string;
  ecosystem: 'PyPI' | 'npm' | 'debian' | 'alpine';
  /** Vulnerable when the version is below this (or in a listed set for OS packages). */
  below: string;
  fixed: string;
  severity: Sev;
  cvss: number;
  title: string;
}

const ADVISORIES: Advisory[] = [
  { id: 'GHSA-m2qf-hxjv-5gpq', cve: 'CVE-2023-30861', pkg: 'flask', ecosystem: 'PyPI', below: '2.2.5', fixed: '2.2.5,2.3.2', severity: 'HIGH', cvss: 7.5, title: 'Flask vulnerable to possible disclosure of permanent session cookie due to missing Vary: Cookie header' },
  { id: 'GHSA-9wx4-h78v-vm56', cve: 'CVE-2024-35195', pkg: 'requests', ecosystem: 'PyPI', below: '2.32.0', fixed: '2.32.0', severity: 'MEDIUM', cvss: 5.6, title: 'Requests Session object does not verify requests after making first request with verify=False' },
  { id: 'GHSA-h75v-3vvj-5mfj', cve: 'CVE-2024-34064', pkg: 'jinja2', ecosystem: 'PyPI', below: '3.1.4', fixed: '3.1.4', severity: 'MEDIUM', cvss: 5.4, title: 'Jinja vulnerable to HTML attribute injection when passing user input as keys to xmlattr filter' },
  { id: 'GHSA-2g68-c3qc-8985', cve: 'CVE-2024-34069', pkg: 'werkzeug', ecosystem: 'PyPI', below: '3.0.3', fixed: '3.0.3', severity: 'HIGH', cvss: 7.5, title: 'Werkzeug debugger vulnerable to remote execution when interacting with attacker controlled domain' },
  { id: 'GHSA-34jh-p97f-mpxf', cve: 'CVE-2024-37891', pkg: 'urllib3', ecosystem: 'PyPI', below: '1.26.19', fixed: '1.26.19,2.2.2', severity: 'MEDIUM', cvss: 4.4, title: "urllib3's Proxy-Authorization request header isn't stripped during cross-origin redirects" },
  { id: 'GHSA-8q59-q68h-6hv4', cve: 'CVE-2020-14343', pkg: 'pyyaml', ecosystem: 'PyPI', below: '5.4', fixed: '5.4', severity: 'CRITICAL', cvss: 9.8, title: 'Improper Input Validation in PyYAML (arbitrary code execution through full_load)' },
  { id: 'GHSA-3ww4-gg4f-jr7f', cve: 'CVE-2024-26130', pkg: 'cryptography', ecosystem: 'PyPI', below: '42.0.4', fixed: '42.0.4', severity: 'HIGH', cvss: 7.5, title: 'Null pointer dereference in PKCS12 serialization' },
  { id: 'GHSA-35jh-r3h4-6jhm', cve: 'CVE-2021-23337', pkg: 'lodash', ecosystem: 'npm', below: '4.17.21', fixed: '4.17.21', severity: 'HIGH', cvss: 7.2, title: 'Command Injection in lodash' },
  { id: 'GHSA-rv95-896h-c2vc', cve: 'CVE-2024-29041', pkg: 'express', ecosystem: 'npm', below: '4.19.2', fixed: '4.19.2', severity: 'MEDIUM', cvss: 6.1, title: 'Express.js Open Redirect in malformed URLs' },
  { id: 'GHSA-wf5p-g6vw-rhxx', cve: 'CVE-2023-45857', pkg: 'axios', ecosystem: 'npm', below: '1.6.0', fixed: '1.6.0', severity: 'MEDIUM', cvss: 6.5, title: 'Axios Cross-Site Request Forgery Vulnerability' },
  { id: 'GHSA-xvch-5gv4-984h', cve: 'CVE-2021-44906', pkg: 'minimist', ecosystem: 'npm', below: '1.2.6', fixed: '1.2.6', severity: 'CRITICAL', cvss: 9.8, title: 'Prototype Pollution in minimist' },
  { id: 'GHSA-27h2-hvpr-p74q', cve: 'CVE-2022-23529', pkg: 'jsonwebtoken', ecosystem: 'npm', below: '9.0.0', fixed: '9.0.0', severity: 'HIGH', cvss: 7.6, title: 'jsonwebtoken unrestricted key type could lead to legacy keys usage' },
];

/** OS packages with known problems in the older base images. */
const OS_VULNS: Record<string, { os: string; vulns: Array<{ pkg: string; cve: string; sev: Sev; installed: string; fixed: string; title: string }> }> = {
  'python:3.9': { os: 'debian 11.9', vulns: [{ pkg: 'libssl1.1', cve: 'CVE-2023-0286', sev: 'HIGH', installed: '1.1.1n-0+deb11u3', fixed: '1.1.1n-0+deb11u4', title: 'openssl: X.400 address type confusion in X.509 GeneralName' }, { pkg: 'zlib1g', cve: 'CVE-2022-37434', sev: 'CRITICAL', installed: '1:1.2.11.dfsg-2+deb11u1', fixed: '1:1.2.11.dfsg-2+deb11u2', title: 'zlib: heap-based buffer over-read and overflow in inflate()' }, { pkg: 'libc6', cve: 'CVE-2023-4911', sev: 'HIGH', installed: '2.31-13+deb11u5', fixed: '2.31-13+deb11u7', title: 'glibc: buffer overflow in ld.so leading to privilege escalation' }, { pkg: 'curl', cve: 'CVE-2023-38545', sev: 'HIGH', installed: '7.74.0-1.3+deb11u7', fixed: '7.74.0-1.3+deb11u10', title: 'curl: heap based buffer overflow in the SOCKS5 proxy handshake' }, { pkg: 'libtiff5', cve: 'CVE-2023-52356', sev: 'MEDIUM', installed: '4.2.0-1+deb11u4', fixed: '', title: 'libtiff: Segment fault in libtiff in TIFFReadRGBATileExt()' }] },
  'node:16': { os: 'debian 11.7', vulns: [{ pkg: 'libssl1.1', cve: 'CVE-2023-0286', sev: 'HIGH', installed: '1.1.1n-0+deb11u3', fixed: '1.1.1n-0+deb11u4', title: 'openssl: X.400 address type confusion in X.509 GeneralName' }, { pkg: 'libc6', cve: 'CVE-2023-4911', sev: 'HIGH', installed: '2.31-13+deb11u5', fixed: '2.31-13+deb11u7', title: 'glibc: buffer overflow in ld.so leading to privilege escalation' }] },
  'alpine:3.14': { os: 'alpine 3.14.10', vulns: [{ pkg: 'libcrypto1.1', cve: 'CVE-2023-0286', sev: 'HIGH', installed: '1.1.1t-r0', fixed: '1.1.1t-r1', title: 'openssl: X.400 address type confusion in X.509 GeneralName' }, { pkg: 'busybox', cve: 'CVE-2022-48174', sev: 'CRITICAL', installed: '1.33.1-r7', fixed: '1.33.1-r8', title: 'busybox: stack overflow vulnerability in ash.c' }] },
  'python:3.12': { os: 'debian 12.7', vulns: [{ pkg: 'libtiff6', cve: 'CVE-2023-52355', sev: 'MEDIUM', installed: '4.5.0-6+deb12u1', fixed: '', title: 'libtiff: TIFFRasterScanlineSize64 produce too-big size and could cause OOM' }] },
  'python:3.12-slim': { os: 'debian 12.7', vulns: [{ pkg: 'perl-base', cve: 'CVE-2023-31484', sev: 'MEDIUM', installed: '5.36.0-7+deb12u1', fixed: '', title: 'perl: CPAN.pm does not verify TLS certificates when downloading distributions over HTTPS' }] },
  'node:20': { os: 'debian 12.7', vulns: [{ pkg: 'libtiff6', cve: 'CVE-2023-52355', sev: 'MEDIUM', installed: '4.5.0-6+deb12u1', fixed: '', title: 'libtiff: TIFFRasterScanlineSize64 produce too-big size and could cause OOM' }] },
  'debian:12-slim': { os: 'debian 12.7', vulns: [] },
  'alpine:3.20': { os: 'alpine 3.20.3', vulns: [] },
  'nginx:1.27-alpine': { os: 'alpine 3.20.3', vulns: [] },
  'nginx:1.27': { os: 'debian 12.7', vulns: [{ pkg: 'libgnutls30', cve: 'CVE-2024-12243', sev: 'MEDIUM', installed: '3.7.9-2+deb12u3', fixed: '3.7.9-2+deb12u4', title: 'gnutls: GnuTLS Impacted by Inefficient DER Decoding in libtasn1' }] },
};

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

interface Dep {
  name: string;
  version: string;
  ecosystem: 'PyPI' | 'npm';
  source: string;
}

/** Affected unless the version reaches the fix in its own release line (2.2.5 fixes 2.2.x) or the newest fix. */
function advisoriesFor(d: Dep): Advisory[] {
  const line = (v: string) => v.split('.').slice(0, 2).join('.');
  return ADVISORIES.filter((a) => {
    if (a.ecosystem !== d.ecosystem || a.pkg !== d.name.toLowerCase()) return false;
    const fixes = a.fixed.split(',');
    const newest = fixes.reduce((m, f) => (cmpVersion(f, m) > 0 ? f : m), fixes[0]);
    if (cmpVersion(d.version, newest) >= 0) return false;
    const sameLine = fixes.find((f) => line(f) === line(d.version));
    return !(sameLine && cmpVersion(d.version, sameLine) >= 0);
  });
}

function parseRequirements(text: string, source: string): { deps: Dep[]; unpinned: string[] } {
  const deps: Dep[] = [];
  const unpinned: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.replace(/#.*/, '').trim();
    if (!l || l.startsWith('-')) continue;
    const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([\w.]+)/.exec(l);
    if (m) deps.push({ name: m[1].toLowerCase(), version: m[2], ecosystem: 'PyPI', source });
    else unpinned.push(l.split(/[<>=!~\s]/)[0]);
  }
  return { deps, unpinned };
}

function parseLock(text: string, source: string): Dep[] {
  try {
    const j = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    const out: Dep[] = [];
    for (const [k, v] of Object.entries(j.packages ?? {})) if (k.startsWith('node_modules/') && v.version) out.push({ name: k.slice(13), version: v.version, ecosystem: 'npm', source });
    for (const [k, v] of Object.entries(j.dependencies ?? {})) if (v.version && !out.some((d) => d.name === k)) out.push({ name: k, version: v.version, ecosystem: 'npm', source });
    return out;
  } catch {
    return [];
  }
}

function read(ctx: Ctx, p: string): string | null {
  try {
    return readFile(ctx.sys.fs, abs(ctx, p), actor(ctx));
  } catch {
    return null;
  }
}

function boxTable(rows: string[][], head: string[]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (l: string, m: string, r: string) => l + w.map((x) => '─'.repeat(x + 2)).join(m) + r + '\n';
  const row = (r: string[]) => '│' + r.map((c, i) => ` ${(c ?? '').padEnd(w[i])} `).join('│') + '│\n';
  return line('╭', '┬', '╮') + row(head) + line('├', '┼', '┤') + rows.map(row).join(line('├', '┼', '┤')) + line('╰', '┴', '╯');
}

const pipAudit: Cmd = (args, io, ctx) => {
  if (args.includes('--version')) {
    io.out('pip-audit 2.7.3\n');
    return 0;
  }
  const ri = args.findIndex((a) => a === '-r' || a === '--requirement');
  if (ri < 0) {
    io.err('No known vulnerabilities found\n(Without -r, pip-audit audits the current Python environment, which has no third-party packages here.)\n');
    return 0;
  }
  const file = args[ri + 1] ?? '';
  const text = read(ctx, file);
  if (text === null) {
    io.err(`ERROR:pip_audit._cli:${file}: No such file or directory\n`);
    return 1;
  }
  const { deps, unpinned } = parseRequirements(text, file);
  if (unpinned.length && !args.includes('--no-deps')) io.err(`WARNING:pip_audit._dependency_source.requirement:Resolving unpinned requirements (${unpinned.join(', ')}) to their latest versions\n`);
  const found = deps.flatMap((d) => advisoriesFor(d).map((a) => ({ d, a })));
  if (args.includes('-f') && args[args.indexOf('-f') + 1] === 'json') {
    io.out(JSON.stringify({ dependencies: deps.map((d) => ({ name: d.name, version: d.version, vulns: advisoriesFor(d).map((a) => ({ id: a.id, fix_versions: a.fixed.split(','), aliases: [a.cve], description: a.title })) })) }) + '\n');
    return found.length ? 1 : 0;
  }
  if (!found.length) {
    io.err('No known vulnerabilities found\n');
    return 0;
  }
  io.err(`Found ${found.length} known vulnerabilit${found.length === 1 ? 'y' : 'ies'} in ${new Set(found.map((f) => f.d.name)).size} package${new Set(found.map((f) => f.d.name)).size === 1 ? '' : 's'}\n`);
  const rows = found.map(({ d, a }) => [d.name, d.version, a.id, a.fixed]);
  const head = ['Name', 'Version', 'ID', 'Fix Versions', ...(args.includes('--desc') ? ['Description'] : [])];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  io.out(head.map((h, i) => h.padEnd(w[i])).join(' ').trimEnd() + '\n' + w.map((x) => '-'.repeat(x)).join(' ') + '\n' + rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join(' ').trimEnd() + '\n').join(''));
  return 1;
};

const osvScanner: Cmd = (args, io, ctx) => {
  if (args.includes('--version')) {
    io.out('osv-scanner version: 1.9.1\n');
    return 0;
  }
  const lockfiles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-L' || a === '--lockfile') lockfiles.push(args[++i] ?? '');
    else if (a.startsWith('--lockfile=')) lockfiles.push(a.slice(11));
  }
  const dirs = args.filter((a, i) => !a.startsWith('-') && !['-L', '--lockfile'].includes(args[i - 1] ?? '') && !['scan', 'source'].includes(a));
  if (!lockfiles.length) {
    for (const d of dirs.length ? dirs : ['.']) {
      io.err(`Scanning dir ${d}\n`);
      for (const f of walkFiles(ctx, abs(ctx, d))) if (/(^|\/)(requirements[^/]*\.txt|package-lock\.json)$/.test(f.path)) lockfiles.push(`${d.replace(/\/$/, '')}/${f.path}`);
    }
  }
  if (!lockfiles.length) {
    io.err('No package sources found, --help for usage information.\n');
    return 128;
  }
  const deps: Dep[] = [];
  for (const f of lockfiles) {
    const text = read(ctx, f);
    if (text === null) {
      io.err(`could not determine extractor for ${f}\n`);
      return 127;
    }
    const found = /package-lock\.json$/.test(f) ? parseLock(text, f) : parseRequirements(text, f).deps;
    io.err(`Scanned ${abs(ctx, f)} file and found ${found.length} package${found.length === 1 ? '' : 's'}\n`);
    deps.push(...found);
  }
  const rows = deps.flatMap((d) => advisoriesFor(d).map((a) => [`https://osv.dev/${a.id}`, a.cvss.toFixed(1), d.ecosystem, d.name, d.version, d.source.replace(/^\.\//, '')]));
  if (!rows.length) {
    io.out('No issues found\n');
    return 0;
  }
  io.out(boxTable(rows, ['OSV URL', 'CVSS', 'ECOSYSTEM', 'PACKAGE', 'VERSION', 'SOURCE']));
  return 1;
};

/* ----------------------------------------------------------------------------- trivy */

const SEV_ORDER: Sev[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

interface TFinding {
  pkg: string;
  id: string;
  sev: Sev;
  status: string;
  installed: string;
  fixed: string;
  title: string;
}

function imageLangDeps(img: DockerImage): Dep[] {
  const out: Dep[] = [];
  for (const [p, c] of Object.entries(img.files)) {
    let m = /\/site-packages\/([^/]+)\/VERSION$/.exec(p);
    if (m) out.push({ name: m[1], version: c.trim(), ecosystem: 'PyPI', source: 'Python' });
    m = /\/node_modules\/([^/]+)\/package\.json$/.exec(p);
    if (m) {
      try {
        out.push({ name: m[1], version: String(JSON.parse(c).version), ecosystem: 'npm', source: 'Node.js' });
      } catch {
        /* not a package manifest */
      }
    }
  }
  return out;
}

function trivyTable(io: IO, title: string, findings: TFinding[], kind: string): void {
  const counts = SEV_ORDER.filter((s) => findings.some((f) => f.sev === s)).reverse();
  io.out(`\n${title}\n${'='.repeat(title.length)}\nTotal: ${findings.length}${findings.length ? ` (${counts.map((s) => `${s}: ${findings.filter((f) => f.sev === s).length}`).join(', ')})` : ''}\n\n`);
  if (!findings.length) return;
  io.out(boxTable(findings.map((f) => [f.pkg, f.id, f.sev, f.status, f.installed, f.fixed, f.title.length > 40 ? f.title.slice(0, 39) + '…' : f.title]), [kind, 'Vulnerability', 'Severity', 'Status', 'Installed Version', 'Fixed Version', 'Title']).replace(/╭/g, '┌').replace(/╮/g, '┐').replace(/╰/g, '└').replace(/╯/g, '┘'));
}

const DOCKERFILE_CHECKS: Array<{ id: string; sev: Sev; title: string; test: (text: string, lines: string[]) => string | null }> = [
  { id: 'DS001', sev: 'MEDIUM', title: ":latest tag used", test: (_t, ls) => (ls.find((l) => /^FROM\s+[^\s:@]+(:latest)?(\s|$)/i.test(l) && !/^FROM\s+scratch/i.test(l)) ? 'Specify a tag in the \'FROM\' statement for image' : null) },
  { id: 'DS002', sev: 'HIGH', title: 'Image user should not be \'root\'', test: (_t, ls) => { const users = ls.filter((l) => /^USER\s+/i.test(l)); return !users.length || /^USER\s+(root|0)\s*$/i.test(users[users.length - 1]) ? 'Specify at least 1 USER command in Dockerfile with non-root user as argument' : null; } },
  { id: 'DS026', sev: 'LOW', title: 'No HEALTHCHECK defined', test: (t) => (/^HEALTHCHECK\s/im.test(t) ? null : 'Add HEALTHCHECK instruction in your Dockerfile') },
  { id: 'DS029', sev: 'HIGH', title: "'apt-get' missing '--no-install-recommends'", test: (_t, ls) => (ls.some((l) => /apt-get\s+(-\S+\s+)*install/.test(l) && !/--no-install-recommends/.test(l)) ? "'--no-install-recommends' flag is missed" : null) },
  { id: 'DS017', sev: 'HIGH', title: "'RUN <package-manager> update' instruction alone", test: (_t, ls) => (ls.some((l) => /^RUN\s+(apt-get|apk)\s+update\s*$/i.test(l)) ? "The instruction 'RUN <package-manager> update' should always be followed by '<package-manager> install' in the same RUN statement." : null) },
  { id: 'DS025', sev: 'HIGH', title: "'apk add' is missing '--no-cache'", test: (_t, ls) => (ls.some((l) => /apk\s+add/.test(l) && !/--no-cache/.test(l)) ? "'--no-cache' is missed" : null) },
];

const trivy: Cmd = (args, io, ctx) => {
  const [sub, ...rest] = args;
  if (sub === '--version' || sub === 'version') {
    io.out('Version: 0.56.2\n');
    return 0;
  }
  const val = (name: string) => {
    const i = rest.findIndex((a) => a === name || a.startsWith(name + '='));
    return i < 0 ? undefined : rest[i].includes('=') ? rest[i].slice(rest[i].indexOf('=') + 1) : rest[i + 1];
  };
  const severities = (val('--severity') ?? val('-s') ?? 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL').split(',').map((s) => s.trim().toUpperCase());
  const exitCode = Number(val('--exit-code') ?? 0);
  const unfixedOff = rest.includes('--ignore-unfixed');
  const scanners = (val('--scanners') ?? (sub === 'config' ? 'misconfig' : 'vuln,secret')).split(',');
  const target = rest.filter((a, i) => !a.startsWith('-') && !['--severity', '-s', '--exit-code', '--scanners', '--format', '-f', '--output', '-o'].includes(rest[i - 1] ?? ''))[0];
  if (!target) {
    io.err(`${sub ?? 'trivy'}: requires at least 1 arg(s), only received 0\n`);
    return 1;
  }
  if (!rest.includes('-q') && !rest.includes('--quiet')) io.err(`2026-10-20T10:02:11Z\tINFO\t[vuln] Vulnerability scanning is enabled\n2026-10-20T10:02:11Z\tINFO\t[secret] Secret scanning is enabled\n`);
  let total = 0;
  const keep = (f: TFinding) => severities.includes(f.sev) && !(unfixedOff && !f.fixed);
  if (sub === 'image') {
    const st = dockerState(ctx);
    const img = findImage(st, target);
    if (!img) {
      io.err(`2026-10-20T10:02:11Z\tFATAL\tFatal error\timage scan error: scan error: unable to initialize a scan service: unable to initialize an image scan service: unable to find the specified image "${target}" in ["docker" "containerd" "podman" "remote"]\n`);
      return 1;
    }
    const os = OS_VULNS[img.base] ?? { os: 'unknown', vulns: [] };
    if (scanners.includes('vuln')) {
      const osF = os.vulns.map((v) => ({ pkg: v.pkg, id: v.cve, sev: v.sev, status: v.fixed ? 'fixed' : 'affected', installed: v.installed, fixed: v.fixed, title: v.title })).filter(keep);
      trivyTable(io, `${target} (${os.os})`, osF, 'Library');
      total += osF.length;
      const lang = imageLangDeps(img).flatMap((d) => advisoriesFor(d).map((a) => ({ pkg: d.name, id: a.cve, sev: a.severity, status: 'fixed', installed: d.version, fixed: a.fixed, title: a.title, src: d.source }))).filter(keep);
      for (const src of [...new Set(lang.map((l) => l.src))]) {
        const fs = lang.filter((l) => l.src === src);
        trivyTable(io, `${src} (${src === 'Python' ? 'python-pkg' : 'node-pkg'})`, fs, 'Library');
        total += fs.length;
      }
    }
    if (scanners.includes('secret')) {
      const leaks = Object.entries(img.files).flatMap(([p, c]) => scanText(c, p));
      const shown = leaks.filter((l) => severities.includes(l.rule.id === 'generic-api-key' ? 'MEDIUM' : l.rule.id === 'private-key' ? 'HIGH' : 'CRITICAL'));
      if (shown.length) {
        io.out(`\n${target} (secrets)\n${'='.repeat(target.length + 10)}\nTotal: ${shown.length}\n\n`);
        for (const l of shown) io.out(`${l.rule.id === 'generic-api-key' ? 'MEDIUM' : 'CRITICAL'}: ${l.rule.id === 'aws-access-token' ? 'AWS' : l.rule.id} (${l.rule.id})\n${'═'.repeat(60)}\n${l.rule.description}\n${'─'.repeat(60)}\n ${l.file}:${l.line}\n${'─'.repeat(60)}\n${l.line} [ ${l.match.replace(l.secret, '*'.repeat(Math.min(20, l.secret.length)))}\n${'─'.repeat(60)}\n\n`);
        total += shown.length;
      }
    }
    void containerFile;
  } else if (sub === 'fs' || sub === 'repo' || sub === 'rootfs') {
    const dir = abs(ctx, target);
    const files = walkFiles(ctx, dir);
    if (scanners.includes('vuln')) {
      for (const f of files) {
        const deps = /requirements[^/]*\.txt$/.test(f.path) ? parseRequirements(f.content, f.path).deps : /package-lock\.json$/.test(f.path) ? parseLock(f.content, f.path) : [];
        if (!deps.length) continue;
        const fs = deps.flatMap((d) => advisoriesFor(d).map((a) => ({ pkg: d.name, id: a.cve, sev: a.severity, status: 'fixed', installed: d.version, fixed: a.fixed, title: a.title }))).filter(keep);
        trivyTable(io, `${f.path} (${/package-lock/.test(f.path) ? 'npm' : 'pip'})`, fs, 'Library');
        total += fs.length;
      }
    }
    if (scanners.includes('secret')) {
      for (const f of files) {
        const leaks = scanText(f.content, f.path);
        if (!leaks.length) continue;
        io.out(`\n${f.path} (secrets)\n${'='.repeat(f.path.length + 10)}\nTotal: ${leaks.length}\n\n${leaks.map((l) => `CRITICAL: ${l.rule.id}\n ${f.path}:${l.line}\n`).join('')}`);
        total += leaks.length;
      }
    }
    if (scanners.includes('misconfig')) total += misconfig(io, files, severities);
  } else if (sub === 'config') {
    total += misconfig(io, walkFiles(ctx, abs(ctx, target)), severities);
  } else {
    io.err(`Error: unknown command "${sub ?? ''}" for "trivy"\nRun 'trivy --help' for usage.\n`);
    return 1;
  }
  return total && exitCode ? exitCode : 0;
};

function misconfig(io: IO, files: Array<{ path: string; content: string }>, severities: string[]): number {
  let total = 0;
  for (const f of files.filter((x) => /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/.test(x.path))) {
    const lines = f.content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const fails = DOCKERFILE_CHECKS.map((c) => ({ c, msg: c.test(f.content, lines) })).filter((x) => x.msg && severities.includes(x.c.sev));
    io.out(`\n${f.path} (dockerfile)\n${'='.repeat(f.path.length + 13)}\nTests: ${DOCKERFILE_CHECKS.length} (SUCCESSES: ${DOCKERFILE_CHECKS.length - fails.length}, FAILURES: ${fails.length})\nFailures: ${fails.length}${fails.length ? ` (${SEV_ORDER.slice().reverse().filter((s) => fails.some((x) => x.c.sev === s)).map((s) => `${s}: ${fails.filter((x) => x.c.sev === s).length}`).join(', ')})` : ''}\n\n`);
    for (const { c, msg } of fails) io.out(`${c.sev}: ${msg}\n${'═'.repeat(60)}\n${c.id}: ${c.title}\n${'─'.repeat(60)}\n\n`);
    total += fails.length;
  }
  return total;
}

export const SECURITY_COMMANDS: Record<string, Cmd> = { gitleaks, 'pip-audit': pipAudit, 'osv-scanner': osvScanner, trivy };
