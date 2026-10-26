/**
 * Linux administration beyond the basics, for Systems Administration II: name resolution through
 * /etc/hosts and a local BIND server (dig, host, nslookup, getent hosts, ping), NetworkManager
 * (nmcli) and temporary ip changes, nmap, a fuller firewall-cmd (masquerade, forwarding, rich
 * rules), systemd unit files with timers and default targets, timedatectl, localectl, sysctl,
 * Apache virtual hosts and basic authentication behind curl, htpasswd, GRUB, configuration tests
 * for sshd, sudoers, Apache and BIND, sudo rules in /etc/sudoers.d, LVM storage with file systems,
 * mounts and snapshots, and NFS and Samba configuration checks.
 *
 * State lives in ordinary files where Linux keeps it (/etc/hosts, /etc/resolv.conf, zone files,
 * unit files, /etc/fstab ...) and, where Linux keeps it in the kernel, in small JSON files under
 * /run/lab and /etc/lvm/lab-state.json.
 */

import { ADMIN_COMMANDS } from './commands-admin.js';
import { FILE_COMMANDS } from './commands-files.js';
import { listDir, lookup, mkdir, readFile, writeFile, type FsNode } from './fs.js';
import { groupName, isSudoer, serviceFaults, type ShellSystem } from './system.js';
import { actor, currentUser, runCommand, type Ctx } from './shell.js';
import { abs, lines, parseOpts, type IO } from './util.js';
import { uuidOf } from './uuid.js';

export { uuidOf };

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
const ROOT = { user: 'root', groups: ['root'] };

/* ----------------------------------------------------------------------------- file helpers */

function rd(sys: ShellSystem, path: string): string | null {
  try {
    const l = lookup(sys.fs, path, ROOT);
    return l?.node.type === 'file' ? l.node.content : null;
  } catch {
    return null;
  }
}

function wr(sys: ShellSystem, path: string, content: string): void {
  mkdir(sys.fs, path.slice(0, path.lastIndexOf('/')) || '/', ROOT, sys.now, true);
  writeFile(sys.fs, path, content, ROOT, sys.now);
}

function ls(sys: ShellSystem, dir: string): Array<{ name: string; node: FsNode }> {
  try {
    return listDir(sys.fs, dir, ROOT);
  } catch {
    return [];
  }
}

function json<T>(sys: ShellSystem, path: string, dflt: T): T {
  const t = rd(sys, path);
  if (!t) return dflt;
  try {
    return JSON.parse(t) as T;
  } catch {
    return dflt;
  }
}

const ipToInt = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function inCidr(ip: string, cidr: string): boolean {
  if (cidr === 'any' || cidr === '0.0.0.0/0') return true;
  const [net, len = '32'] = cidr.split('/');
  if (!isIp(ip) || !isIp(net)) return false;
  const mask = Number(len) === 0 ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}

function ownAddress(sys: ShellSystem): string {
  return (sys.network?.address ?? '10.0.0.10/24').split('/')[0];
}

/* ----------------------------------------------------------------------------- name resolution */

export interface DnsRecord {
  name: string;
  type: string;
  data: string;
  ttl: number;
}

interface ZoneDef {
  name: string;
  type: string;
  file?: string;
  allowTransfer?: string[];
  forwarders?: string[];
}

function hostsMap(sys: ShellSystem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(rd(sys, '/etc/hosts') ?? '')) {
    const t = l.replace(/#.*/, '').trim().split(/\s+/);
    if (t.length < 2 || !t[0]) continue;
    for (const n of t.slice(1)) if (!(n.toLowerCase() in out)) out[n.toLowerCase()] = t[0];
  }
  return out;
}

function resolvConf(sys: ShellSystem): { nameservers: string[]; search: string[] } {
  const text = rd(sys, '/etc/resolv.conf') ?? '';
  return {
    nameservers: lines(text).filter((l) => /^nameserver\s/.test(l)).map((l) => l.split(/\s+/)[1]),
    search: lines(text).filter((l) => /^(search|domain)\s/.test(l)).flatMap((l) => l.split(/\s+/).slice(1)),
  };
}

/** Zones and options from /etc/named.conf (and files it includes). */
export function namedConfig(sys: ShellSystem): { directory: string; zones: ZoneDef[]; forwarders: string[]; recursion: boolean; errors: string[] } {
  const errors: string[] = [];
  let text = rd(sys, '/etc/named.conf') ?? '';
  for (const m of [...text.matchAll(/^\s*include\s+"([^"]+)"\s*;/gm)]) text += '\n' + (rd(sys, m[1]) ?? (errors.push(`/etc/named.conf: open: ${m[1]}: file not found`), ''));
  const clean = text.replace(/\/\/.*$|#.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const ch of clean) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push("/etc/named.conf: missing '}' or unbalanced braces");
  for (const [i, l] of clean.split('\n').entries()) {
    const s = l.trim();
    if (!s || /[{};]\s*$/.test(s) || /^}/.test(s)) continue;
    errors.push(`/etc/named.conf:${i + 1}: missing ';' before end of line`);
  }
  const directory = /directory\s+"([^"]+)"/.exec(clean)?.[1] ?? '/var/lib/named';
  // The body of the { ... } block that opens at index i, matching nested braces.
  const block = (i: number): string => {
    let d = 0;
    for (let j = i; j < clean.length; j++) {
      if (clean[j] === '{') d++;
      else if (clean[j] === '}' && --d === 0) return clean.slice(i + 1, j);
    }
    return clean.slice(i + 1);
  };
  const om = /options\s*\{/.exec(clean);
  const optionsBlock = om ? block(om.index + om[0].length - 1) : '';
  const forwarders = /forwarders\s*\{([^}]*)\}/.exec(optionsBlock)?.[1].split(';').map((x) => x.trim()).filter(Boolean) ?? [];
  const recursion = !/recursion\s+no\s*;/.test(optionsBlock);
  const zones: ZoneDef[] = [];
  for (const m of clean.matchAll(/zone\s+"([^"]+)"\s*(?:in|IN)?\s*\{/g)) {
    const body = block(m.index + m[0].length - 1);
    zones.push({
      name: m[1].replace(/\.$/, '').toLowerCase(),
      type: /type\s+(\w+)/.exec(body)?.[1] ?? 'master',
      file: /file\s+"([^"]+)"/.exec(body)?.[1],
      allowTransfer: /allow-transfer\s*\{([^}]*)\}/.exec(body)?.[1].split(';').map((x) => x.trim()).filter(Boolean),
      forwarders: /forwarders\s*\{([^}]*)\}/.exec(body)?.[1].split(';').map((x) => x.trim()).filter(Boolean),
    });
  }
  return { directory, zones, forwarders, recursion, errors };
}

/** Parses a zone file. Names without a trailing dot are relative to the origin, as in BIND. */
export function parseZone(text: string, origin: string): { records: DnsRecord[]; errors: string[]; serial?: number } {
  const errors: string[] = [];
  const records: DnsRecord[] = [];
  let org = origin.replace(/\.$/, '');
  let ttl = 3600;
  let last = org;
  // Join parenthesised continuations (the SOA).
  const joined = text.replace(/;.*$/gm, '').replace(/\(([\s\S]*?)\)/g, (_m, inner: string) => inner.replace(/\s+/g, ' '));
  let serial: number | undefined;
  const abs = (n: string) => (n === '@' ? org : n.endsWith('.') ? n.slice(0, -1) : `${n}.${org}`).toLowerCase();
  for (const [i, raw] of joined.split('\n').entries()) {
    if (!raw.trim()) continue;
    const startsBlank = /^\s/.test(raw);
    const t = raw.trim().split(/\s+/);
    if (t[0] === '$ORIGIN') {
      org = t[1].replace(/\.$/, '');
      continue;
    }
    if (t[0] === '$TTL') {
      ttl = Number(t[1]) || 3600;
      continue;
    }
    let name = last;
    if (!startsBlank) name = abs(t.shift()!);
    let rttl = ttl;
    while (t.length && (/^\d+$/.test(t[0]) || /^(IN|CH)$/i.test(t[0]))) {
      const x = t.shift()!;
      if (/^\d+$/.test(x)) rttl = Number(x);
    }
    const type = (t.shift() ?? '').toUpperCase();
    if (!/^(A|AAAA|NS|CNAME|MX|PTR|TXT|SOA|SRV)$/.test(type)) {
      errors.push(`line ${i + 1}: unknown RR type '${type || '(none)'}'`);
      continue;
    }
    last = name;
    let data = t.join(' ');
    if (type === 'A' && !isIp(data)) errors.push(`line ${i + 1}: bad dotted quad '${data}'`);
    if (type === 'NS' || type === 'CNAME' || type === 'PTR') data = abs(data);
    if (type === 'MX') {
      const [pref, host] = t;
      data = `${pref} ${host ? abs(host) : ''}`;
    }
    if (type === 'SOA') {
      serial = Number(t[2]);
      if (!t[2] || Number.isNaN(serial)) errors.push(`line ${i + 1}: SOA serial is missing`);
      data = `${abs(t[0] ?? '@')} ${abs(t[1] ?? '@')} ${t.slice(2).join(' ')}`;
    }
    if (type === 'TXT') data = data.replace(/^"|"$/g, '');
    records.push({ name, type, data, ttl: rttl });
  }
  if (!records.some((r) => r.type === 'SOA')) errors.push('has no SOA record');
  if (!records.some((r) => r.type === 'NS')) errors.push('has no NS records');
  for (const r of records) if (r.type === 'CNAME' && records.some((x) => x !== r && x.name === r.name)) errors.push(`${r.name}: CNAME and other data`);
  return { records, errors, serial };
}

function localServer(sys: ShellSystem): boolean {
  return !!sys.services.named?.active && !!sys.packages.bind?.installed;
}

function zoneRecords(sys: ShellSystem, z: ZoneDef, dir: string): DnsRecord[] | null {
  if (!z.file) return null;
  const path = z.file.startsWith('/') ? z.file : `${dir}/${z.file}`;
  const text = rd(sys, path);
  return text === null ? null : parseZone(text, z.name).records;
}

/** Upstream DNS the lab knows about: network.hosts entries answer A queries. */
function upstream(sys: ShellSystem, name: string): string | undefined {
  const hosts = sys.network?.hosts ?? {};
  return hosts[name] ?? hosts[name.replace(/\.$/, '')] ?? ({ 'www.google.com': '142.250.184.4', 'download.opensuse.org': '195.135.221.134', 'deb.debian.org': '151.101.2.132' } as Record<string, string>)[name];
}

export type DnsAnswer = { status: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED' | 'TIMEOUT'; answers: DnsRecord[]; aa: boolean; server: string };

/** A DNS query as dig would send it, to `server` or the first resolv.conf nameserver. */
export function dnsQuery(sys: ShellSystem, qname: string, qtype: string, server?: string): DnsAnswer {
  const srv = server ?? resolvConf(sys).nameservers[0] ?? '';
  const name = qname.replace(/\.$/, '').toLowerCase();
  const mine = srv === '127.0.0.1' || srv === 'localhost' || srv === '::1' || srv === ownAddress(sys);
  if (!srv) return { status: 'TIMEOUT', answers: [], aa: false, server: '' };
  if (mine) {
    if (!localServer(sys)) return { status: 'TIMEOUT', answers: [], aa: false, server: srv };
    const cfg = namedConfig(sys);
    const zone = cfg.zones.filter((z) => z.type !== 'hint' && (name === z.name || name.endsWith('.' + z.name))).sort((a, b) => b.name.length - a.name.length)[0];
    if (zone && /^(forward)$/i.test(zone.type)) {
      const ip = upstream(sys, name);
      return ip ? { status: 'NOERROR', answers: [{ name, type: 'A', data: ip, ttl: 300 }], aa: false, server: srv } : { status: 'SERVFAIL', answers: [], aa: false, server: srv };
    }
    if (zone) {
      const recs = zoneRecords(sys, zone, cfg.directory);
      if (!recs) return { status: 'SERVFAIL', answers: [], aa: false, server: srv };
      if (qtype === 'AXFR') return { status: 'NOERROR', answers: recs, aa: true, server: srv };
      const hits = recs.filter((r) => r.name === name && (r.type === qtype || qtype === 'ANY'));
      if (hits.length) return { status: 'NOERROR', answers: hits, aa: true, server: srv };
      const cname = recs.find((r) => r.name === name && r.type === 'CNAME');
      if (cname && qtype !== 'CNAME') {
        const next = recs.filter((r) => r.name === cname.data && r.type === qtype);
        return { status: 'NOERROR', answers: [cname, ...next], aa: true, server: srv };
      }
      return { status: recs.some((r) => r.name === name) ? 'NOERROR' : 'NXDOMAIN', answers: [], aa: true, server: srv };
    }
    if (!cfg.recursion) return { status: 'REFUSED', answers: [], aa: false, server: srv };
    const ip = (cfg.forwarders.length || cfg.zones.some((z) => z.type === 'hint')) && qtype === 'A' ? upstream(sys, name) : undefined;
    if (ip) return { status: 'NOERROR', answers: [{ name, type: 'A', data: ip, ttl: 300 }], aa: false, server: srv };
    return { status: cfg.forwarders.length ? 'NXDOMAIN' : 'SERVFAIL', answers: [], aa: false, server: srv };
  }
  const gw = sys.network?.gateway;
  const knownServers = [gw, ...Object.values(sys.network?.hosts ?? {}), '8.8.8.8', '1.1.1.1', '9.9.9.9'].filter(Boolean);
  if (!knownServers.includes(srv)) return { status: 'TIMEOUT', answers: [], aa: false, server: srv };
  const ip = qtype === 'A' ? upstream(sys, name) : undefined;
  return ip ? { status: 'NOERROR', answers: [{ name, type: 'A', data: ip, ttl: 300 }], aa: false, server: srv } : { status: 'NXDOMAIN', answers: [], aa: false, server: srv };
}

/** A query with the resolv.conf search list applied to names without a dot (host, nslookup). */
function searchQuery(sys: ShellSystem, name: string, type: string, server?: string): DnsAnswer & { qname: string } {
  const tries = name.includes('.') ? [name] : [...resolvConf(sys).search.map((s) => `${name}.${s}`), name];
  let last: DnsAnswer & { qname: string } = { ...dnsQuery(sys, tries[0], type, server), qname: tries[0] };
  for (const t of tries) {
    const r = dnsQuery(sys, t, type, server);
    last = { ...r, qname: t };
    if (r.answers.length || r.status === 'TIMEOUT') return last;
  }
  return last;
}

/** The resolver library: /etc/hosts first, then DNS with the search list. */
export function resolveHost(sys: ShellSystem, name: string): string | undefined {
  const n = name.toLowerCase();
  if (isIp(n)) return n;
  if (n === 'localhost') return '127.0.0.1';
  if (n === sys.hostname.toLowerCase()) return ownAddress(sys);
  // Inside a container, Docker's embedded DNS answers for the containers on its networks.
  if (sys.container && sys.network?.hosts?.[n]) return sys.network.hosts[n];
  const h = hostsMap(sys);
  if (h[n]) return h[n];
  const rc = resolvConf(sys);
  const tries = n.includes('.') ? [n] : [...rc.search.map((s) => `${n}.${s}`), n];
  for (const t of tries) {
    const r = dnsQuery(sys, t, 'A');
    const a = r.answers.find((x) => x.type === 'A');
    if (a) return a.data;
  }
  return undefined;
}

function reverseName(ip: string): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

/* ----------------------------------------------------------------------------- firewall state */

const SERVICE_PORTS: Record<string, string> = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', dns: '53/tcp', 'dhcpv6-client': '546/udp', mysql: '3306/tcp', postgresql: '5432/tcp', nfs: '2049/tcp', samba: '445/tcp', smtp: '25/tcp', ftp: '21/tcp', cockpit: '9090/tcp', telnet: '23/tcp', 'rpc-bind': '111/tcp', ipp: '631/tcp', mdns: '5353/udp' };

interface FwState {
  services: string[];
  ports: string[];
  masquerade: boolean;
  forwards: string[];
  rich: string[];
}

const FW_FILE = '/etc/firewalld/zones/public.xml';

export function fwState(sys: ShellSystem): FwState {
  const text = rd(sys, FW_FILE);
  if (text === null) return { services: ['ssh', 'dhcpv6-client'], ports: [], masquerade: false, forwards: [], rich: [] };
  const st: FwState = { services: [], ports: [], masquerade: false, forwards: [], rich: [] };
  for (const l of lines(text)) {
    const [k, ...v] = l.split(':');
    const val = v.join(':');
    if (k === 'service') st.services.push(val);
    else if (k === 'port') st.ports.push(val);
    else if (k === 'masquerade') st.masquerade = val === 'yes';
    else if (k === 'forward') st.forwards.push(val);
    else if (k === 'rich') st.rich.push(val);
  }
  return st;
}

function saveFw(sys: ShellSystem, st: FwState): void {
  wr(sys, FW_FILE, [...st.services.map((s) => `service:${s}`), ...st.ports.map((p) => `port:${p}`), ...(st.masquerade ? ['masquerade:yes'] : []), ...st.forwards.map((f) => `forward:${f}`), ...st.rich.map((r) => `rich:${r}`)].map((l) => l + '\n').join(''));
}

/** Ports the firewall lets in from other hosts. */
export function openPorts(sys: ShellSystem): Set<number> {
  const listening = new Map<number, string>();
  for (const [n, s] of Object.entries(sys.services)) if (s.active && s.port) listening.set(s.port, n);
  if (!sys.services.firewalld?.active) return new Set(listening.keys());
  const st = fwState(sys);
  const allowed = new Set<number>([...st.services.map((s) => Number((SERVICE_PORTS[s] ?? '0/tcp').split('/')[0])), ...st.ports.map((p) => Number(p.split('/')[0]))]);
  return new Set([...listening.keys()].filter((p) => allowed.has(p)));
}

/* ----------------------------------------------------------------------------- systemd units */

function unitDirective(text: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(text)?.[1].trim();
}

/** Registers unit files from /etc/systemd/system as services and timers. */
export function scanUnits(sys: ShellSystem): void {
  for (const { name, node } of ls(sys, '/etc/systemd/system')) {
    if (node.type !== 'file') continue;
    const m = /^(.+)\.(service|timer)$/.exec(name);
    if (!m) continue;
    const key = m[2] === 'timer' ? name : m[1];
    if (sys.services[key]) {
      (sys.services[key] as typeof sys.services[string] & { unitFile?: string }).unitFile = `/etc/systemd/system/${name}`;
      continue;
    }
    sys.services[key] = { description: unitDirective(node.content, 'Description') ?? key, active: false, enabled: false, logs: [] };
    (sys.services[key] as typeof sys.services[string] & { unitFile?: string }).unitFile = `/etc/systemd/system/${name}`;
  }
}

function unitProblems(sys: ShellSystem, key: string): string[] {
  const s = sys.services[key] as (typeof sys.services[string] & { unitFile?: string }) | undefined;
  if (!s?.unitFile) return [];
  const text = rd(sys, s.unitFile) ?? '';
  const out: string[] = [];
  if (key.endsWith('.timer')) {
    if (!/^\s*\[Timer\]/m.test(text)) out.push(`${key}: missing [Timer] section.`);
    const cal = unitDirective(text, 'OnCalendar');
    if (!cal && !unitDirective(text, 'OnBootSec') && !unitDirective(text, 'OnUnitActiveSec')) out.push(`${key}: Timer unit lacks value setting. Refusing.`);
    if (cal && !/^(minutely|hourly|daily|weekly|monthly|yearly|annually|quarterly|semiannually|(\*|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[\w,.-]*\s+)?[\d*/:\s,.-]+$|^(minutely|hourly|daily|weekly|monthly|yearly)$/i.test(cal)) out.push(`${key}: Failed to parse calendar specification '${cal}'.`);
    const target = unitDirective(text, 'Unit') ?? key.replace(/\.timer$/, '.service');
    if (!sys.services[target.replace(/\.service$/, '')]) out.push(`${key}: Refusing to start, unit ${target} to trigger not loaded.`);
    return out;
  }
  if (!/^\s*\[Service\]/m.test(text)) out.push(`${key}.service: missing [Service] section.`);
  const exec = unitDirective(text, 'ExecStart');
  if (!exec) out.push(`${key}.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.`);
  else {
    const bin = exec.replace(/^[-@+!]+/, '').split(/\s+/)[0];
    if (!bin.startsWith('/')) out.push(`${key}.service: Executable path is not absolute: ${bin}`);
    else {
      const l = lookup(sys.fs, bin, ROOT);
      const target = bin === '/bin/bash' || bin === '/usr/bin/bash' || bin === '/bin/sh' || bin.startsWith('/usr/bin/') || bin.startsWith('/usr/sbin/');
      if (!l && !target) out.push(`${key}.service: Failed to locate executable ${bin}: No such file or directory`);
      else if (l && l.node.type === 'file' && !(l.node.mode & 0o111)) out.push(`${key}.service: Failed to execute ${bin}: Permission denied`);
    }
  }
  return out;
}

/**
 * Runs a Type=oneshot unit the way systemd does: each ExecStart= line in order, as User= (root by
 * default), in WorkingDirectory=, with only Environment=/EnvironmentFile= variables and systemd's PATH.
 * Output goes to the journal; a non-zero exit fails the unit.
 */
function runOneshot(ctx: Ctx, unit: string, text: string, io: IO): number {
  const sys = ctx.sys;
  const s = sys.services[unit];
  const user = unitDirective(text, 'User') ?? 'root';
  if (!sys.users[user]) {
    s.logs.push(`${unit}.service: Failed to determine user credentials: No such process`, `${unit}.service: Failed at step USER spawning: No such process`);
    io.err(`Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`);
    return 1;
  }
  const env: Record<string, string> = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', USER: user, LOGNAME: user, HOME: sys.users[user].home, SHELL: '/bin/sh', INVOCATION_ID: 'a1b2c3' };
  for (const m of text.matchAll(/^\s*Environment\s*=\s*(.+)$/gm)) for (const kv of m[1].match(/"[^"]*"|\S+/g) ?? []) {
    const t = kv.replace(/^"|"$/g, '');
    const eq = t.indexOf('=');
    if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  const envFile = unitDirective(text, 'EnvironmentFile');
  if (envFile) {
    const content = rd(sys, envFile.replace(/^-/, ''));
    if (content === null && !envFile.startsWith('-')) {
      s.logs.push(`${unit}.service: Failed to load environment files: No such file or directory`);
      io.err(`Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`);
      return 1;
    }
    for (const l of (content ?? '').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  const saved = { vars: ctx.vars, exported: ctx.exported, env: sys.env, euser: ctx.euser, cwd: sys.cwd };
  ctx.vars = { ...env };
  ctx.exported = new Set(Object.keys(env));
  sys.env = { ...env };
  ctx.euser = user;
  sys.cwd = unitDirective(text, 'WorkingDirectory') ?? (user === 'root' ? '/' : sys.users[user].home);
  let code = 0;
  const journal: string[] = [];
  try {
    for (const m of text.matchAll(/^\s*ExecStart\s*=\s*(.+)$/gm)) {
      const line = m[1].trim();
      const ignore = line.startsWith('-');
      const words = (line.replace(/^[-@+!]+/, '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
      const c = runCommand(ctx, words, { stdin: '', out: (t) => journal.push(t), err: (t) => journal.push(t) });
      if (c !== 0 && !ignore) {
        code = c;
        break;
      }
    }
  } finally {
    ctx.vars = saved.vars;
    ctx.exported = saved.exported;
    sys.env = saved.env;
    ctx.euser = saved.euser;
    sys.cwd = saved.cwd;
  }
  s.logs.push(...journal.join('').split('\n').filter(Boolean));
  if (code !== 0) {
    s.active = false;
    s.logs.push(`${unit}.service: Main process exited, code=exited, status=${code}/FAILURE`, `${unit}.service: Failed with result 'exit-code'.`, `Failed to start ${s.description}.`);
    io.err(`Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`);
    return 1;
  }
  s.logs.push(`${unit}.service: Deactivated successfully.`, `Finished ${s.description}.`);
  s.active = /^\s*RemainAfterExit\s*=\s*(yes|true|1)\s*$/im.test(text);
  return 0;
}

const TARGETS = ['multi-user.target', 'graphical.target', 'rescue.target', 'emergency.target', 'poweroff.target', 'reboot.target'];

/* ----------------------------------------------------------------------------- config validators */

const SSHD_KEYS = ['port', 'listenaddress', 'permitrootlogin', 'passwordauthentication', 'pubkeyauthentication', 'permitemptypasswords', 'challengeresponseauthentication', 'kbdinteractiveauthentication', 'usepam', 'x11forwarding', 'allowusers', 'allowgroups', 'denyusers', 'denygroups', 'maxauthtries', 'logingracetime', 'clientaliveinterval', 'clientalivecountmax', 'authorizedkeysfile', 'subsystem', 'protocol', 'hostkey', 'syslogfacility', 'loglevel', 'banner', 'printmotd', 'acceptenv', 'allowtcpforwarding', 'gatewayports', 'maxsessions', 'usedns', 'include', 'match', 'ciphers', 'macs', 'kexalgorithms'];

export function sshdProblems(sys: ShellSystem): string[] {
  const text = rd(sys, '/etc/ssh/sshd_config');
  if (text === null) return [];
  const out: string[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const l = raw.replace(/#.*/, '').trim();
    if (!l) continue;
    const [k, ...v] = l.split(/\s+/);
    const key = k.toLowerCase();
    const val = v.join(' ');
    if (!SSHD_KEYS.includes(key)) out.push(`/etc/ssh/sshd_config line ${i + 1}: Bad configuration option: ${k}`);
    else if (key === 'permitrootlogin' && !/^(yes|no|prohibit-password|without-password|forced-commands-only)$/i.test(val)) out.push(`/etc/ssh/sshd_config line ${i + 1}: unsupported option "${val}".`);
    else if (/^(passwordauthentication|pubkeyauthentication|permitemptypasswords|usepam|x11forwarding|kbdinteractiveauthentication|challengeresponseauthentication)$/.test(key) && !/^(yes|no)$/i.test(val)) out.push(`/etc/ssh/sshd_config line ${i + 1}: unsupported option "${val}".`);
    else if (key === 'port' && !(Number(val) > 0 && Number(val) < 65536)) out.push(`/etc/ssh/sshd_config line ${i + 1}: Badly formatted port number.`);
    else if (key === 'maxauthtries' && !/^\d+$/.test(val)) out.push(`/etc/ssh/sshd_config line ${i + 1}: Bad number.`);
  }
  return out;
}

/** The effective value of an sshd option (first occurrence wins, as in sshd). */
export function sshdOption(sys: ShellSystem, key: string, dflt: string): string {
  for (const raw of (rd(sys, '/etc/ssh/sshd_config') ?? '').split('\n')) {
    const l = raw.replace(/#.*/, '').trim();
    if (!l) continue;
    const [k, ...v] = l.split(/\s+/);
    if (k.toLowerCase() === key.toLowerCase()) return v.join(' ');
  }
  return dflt;
}

function sudoersFiles(sys: ShellSystem): Array<{ path: string; text: string }> {
  const main = rd(sys, '/etc/sudoers');
  return [...(main !== null ? [{ path: '/etc/sudoers', text: main }] : []), ...ls(sys, '/etc/sudoers.d').filter((e) => e.node.type === 'file' && !e.name.includes('.') && !e.name.endsWith('~')).map((e) => ({ path: `/etc/sudoers.d/${e.name}`, text: (e.node as { content: string }).content }))];
}

export function sudoersProblems(sys: ShellSystem, files = sudoersFiles(sys)): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const [i, raw] of f.text.split('\n').entries()) {
      const l = raw.replace(/#(?!include).*/, '').trim();
      if (!l || /^#include/.test(l) || /^@include/.test(l)) continue;
      if (/^Defaults\b/.test(l) || /^(User|Runas|Host|Cmnd)_Alias\s+[A-Z_0-9]+\s*=/.test(l)) continue;
      if (!/^%?[\w.-]+\s+[\w.,!-]+\s*=\s*(\([^)]*\)\s*)?((NO)?PASSWD:\s*)?(ALL|\/\S+.*|[A-Z_0-9]+)(\s*,\s*(\/\S+[^,]*|ALL|[A-Z_0-9]+))*$/.test(l)) out.push(`${f.path}:${i + 1}:${raw.indexOf(l.split(/\s+/)[1] ?? '') + 1}: syntax error`);
    }
  }
  return out;
}

interface SudoRule {
  who: string;
  nopasswd: boolean;
  commands: string[];
}

export function sudoRules(sys: ShellSystem): SudoRule[] {
  const rules: SudoRule[] = [];
  for (const f of sudoersFiles(sys)) {
    for (const raw of f.text.split('\n')) {
      const l = raw.replace(/#.*/, '').trim();
      const m = /^(%?[\w.-]+)\s+[\w.,!-]+\s*=\s*(?:\([^)]*\)\s*)?((?:NO)?PASSWD:\s*)?(.+)$/.exec(l);
      if (!m || /^Defaults/.test(l)) continue;
      rules.push({ who: m[1], nopasswd: /^NOPASSWD/.test(m[2] ?? ''), commands: m[3].split(',').map((c) => c.trim()) });
    }
  }
  return rules;
}

function ruleFor(sys: ShellSystem, user: string, words: string[]): SudoRule | undefined {
  const u = sys.users[user];
  if (!u) return undefined;
  const groups = new Set([groupName(sys, u.gid), ...u.groups]);
  const base = (words[0] ?? '').split('/').pop() ?? '';
  return sudoRules(sys).find((r) => {
    const mine = r.who.startsWith('%') ? groups.has(r.who.slice(1)) : r.who === user;
    if (!mine) return false;
    return r.commands.some((c) => {
      if (c === 'ALL') return true;
      const [path, ...cargs] = c.split(/\s+/);
      if ((path.split('/').pop() ?? '') !== base) return false;
      if (!cargs.length) return true;
      const want = cargs.join(' ');
      const have = words.slice(1).join(' ');
      return want.endsWith('*') ? have.startsWith(want.slice(0, -1).trim()) : have === want;
    });
  });
}

function apacheVhosts(sys: ShellSystem): Array<{ port: number; names: string[]; root: string; redirect?: string; auth?: { file: string; dir: string }; denied: string[]; file: string }> {
  const out: Array<{ port: number; names: string[]; root: string; redirect?: string; auth?: { file: string; dir: string }; denied: string[]; file: string }> = [];
  for (const { name, node } of ls(sys, '/etc/apache2/vhosts.d')) {
    if (node.type !== 'file' || !name.endsWith('.conf')) continue;
    for (const m of node.content.matchAll(/<VirtualHost\s+[^:>]*:?(\d*)\s*>([\s\S]*?)<\/VirtualHost>/gi)) {
      const body = m[2];
      const names = [/^\s*ServerName\s+(\S+)/im.exec(body)?.[1], ...(/^\s*ServerAlias\s+(.+)$/im.exec(body)?.[1].split(/\s+/) ?? [])].filter(Boolean).map((x) => x!.toLowerCase());
      const root = (/^\s*DocumentRoot\s+"?([^"\s]+)"?/im.exec(body)?.[1] ?? '/srv/www/htdocs').replace(/\/$/, '');
      const redirect = /^\s*Redirect\s+(?:permanent|301)?\s*\/\s+(\S+)/im.exec(body)?.[1];
      const dirAuth = /<Directory\s+"?([^">\s]+)"?\s*>([\s\S]*?)<\/Directory>/i.exec(body);
      const auth = dirAuth && /AuthType\s+Basic/i.test(dirAuth[2]) ? { file: /AuthUserFile\s+"?([^"\s]+)"?/i.exec(dirAuth[2])?.[1] ?? '', dir: dirAuth[1].replace(/\/$/, '') } : undefined;
      const denied = [...body.matchAll(/<Directory\s+"?([^">\s]+)"?\s*>([\s\S]*?)<\/Directory>/gi)].filter((d) => /Require\s+all\s+denied/i.test(d[2])).map((d) => d[1].replace(/\/$/, ''));
      out.push({ port: Number(m[1] || 80), names, root, ...(redirect ? { redirect } : {}), ...(auth ? { auth } : {}), denied, file: `/etc/apache2/vhosts.d/${name}` });
    }
  }
  return out;
}

export function apacheProblems(sys: ShellSystem): string[] {
  const out: string[] = [...serviceFaults(sys, 'apache2')];
  for (const { name, node } of ls(sys, '/etc/apache2/vhosts.d')) {
    if (node.type !== 'file' || !name.endsWith('.conf')) continue;
    const open = (node.content.match(/<VirtualHost\b/gi) ?? []).length;
    const close = (node.content.match(/<\/VirtualHost>/gi) ?? []).length;
    if (open !== close) out.push(`Syntax error on line ${node.content.split('\n').length} of /etc/apache2/vhosts.d/${name}: <VirtualHost> was not closed.`);
    const dOpen = (node.content.match(/<Directory\b/gi) ?? []).length;
    const dClose = (node.content.match(/<\/Directory>/gi) ?? []).length;
    if (dOpen !== dClose) out.push(`Syntax error in /etc/apache2/vhosts.d/${name}: <Directory> was not closed.`);
    for (const [i, l] of node.content.split('\n').entries()) {
      const w = l.trim().split(/\s+/)[0];
      if (w && !w.startsWith('#') && !w.startsWith('<') && !/^(ServerName|ServerAlias|DocumentRoot|ErrorLog|CustomLog|Redirect|RedirectMatch|Require|Options|AllowOverride|AuthType|AuthName|AuthUserFile|AuthBasicProvider|DirectoryIndex|SSLEngine|SSLCertificateFile|SSLCertificateKeyFile|Header|Alias|ProxyPass|ProxyPassReverse|LogLevel|Protocols|RewriteEngine|RewriteRule|RewriteCond|ServerAdmin)$/i.test(w)) out.push(`Invalid command '${w}', perhaps misspelled or defined by a module not included in the server configuration (line ${i + 1} of /etc/apache2/vhosts.d/${name})`);
    }
  }
  return out;
}

function namedProblems(sys: ShellSystem): string[] {
  const cfg = namedConfig(sys);
  const out = [...cfg.errors, ...serviceFaults(sys, 'named')];
  for (const z of cfg.zones) {
    if (z.type === 'hint' || /forward/i.test(z.type)) continue;
    if (!z.file) {
      out.push(`zone ${z.name}/IN: master zone has no file`);
      continue;
    }
    const path = z.file.startsWith('/') ? z.file : `${cfg.directory}/${z.file}`;
    const text = rd(sys, path);
    if (text === null) {
      out.push(`zone ${z.name}/IN: loading from master file ${z.file} failed: file not found`);
      continue;
    }
    for (const e of parseZone(text, z.name).errors) out.push(`zone ${z.name}/IN: ${e}`);
  }
  return out;
}

/* ----------------------------------------------------------------------------- storage */

interface Lv {
  vg: string;
  name: string;
  sizeGb: number;
  fs?: 'ext4' | 'xfs';
  snapshotOf?: string;
  files?: Record<string, string>;
}
interface Storage {
  disks: Array<{ name: string; sizeGb: number; fs?: 'ext4' | 'xfs' }>;
  pvs: Array<{ dev: string; vg?: string }>;
  vgs: Array<{ name: string; pvs: string[] }>;
  lvs: Lv[];
  mounts: Array<{ dev: string; dir: string; fs: string; opts: string }>;
}

const ST_FILE = '/etc/lvm/lab-state.json';
const stOf = (sys: ShellSystem): Storage => {
  const s = json<Partial<Storage>>(sys, ST_FILE, {});
  return { disks: s.disks ?? [], pvs: s.pvs ?? [], vgs: s.vgs ?? [], lvs: s.lvs ?? [], mounts: s.mounts ?? [] };
};
const saveSt = (sys: ShellSystem, s: Storage) => wr(sys, ST_FILE, JSON.stringify(s));
const sizeOfDisk = (s: Storage, dev: string) => s.disks.find((d) => `/dev/${d.name}` === dev)?.sizeGb ?? 0;
const vgSize = (s: Storage, vg: string) => (s.vgs.find((v) => v.name === vg)?.pvs ?? []).reduce((a, p) => a + sizeOfDisk(s, p), 0);
const vgUsed = (s: Storage, vg: string) => s.lvs.filter((l) => l.vg === vg).reduce((a, l) => a + l.sizeGb, 0);

/** Every way a block device can be named: /dev/vg/lv, /dev/mapper/vg-lv, UUID=... */
function canonDev(s: Storage, dev: string): string | null {
  const d = dev.replace(/^UUID=/, '');
  for (const l of s.lvs) {
    if (dev === `/dev/${l.vg}/${l.name}` || dev === `/dev/mapper/${l.vg}-${l.name}` || d === uuidOf(`/dev/${l.vg}/${l.name}`)) return `/dev/${l.vg}/${l.name}`;
  }
  for (const k of s.disks) if (dev === `/dev/${k.name}` || d === uuidOf(`/dev/${k.name}`)) return `/dev/${k.name}`;
  return null;
}
const fsOf = (s: Storage, dev: string) => s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === dev)?.fs ?? s.disks.find((d) => `/dev/${d.name}` === dev)?.fs;
const parseGb = (v: string) => {
  const m = /^\+?(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i.exec(v);
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  return u === 'T' ? n * 1024 : u === 'M' ? n / 1024 : u === 'K' ? n / 1048576 : n;
};

function collectFiles(sys: ShellSystem, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walkDir = (p: string, rel: string) => {
    for (const { name, node } of ls(sys, p)) {
      if (node.type === 'dir') walkDir(`${p}/${name}`, `${rel}${name}/`);
      else if (node.type === 'file') out[`${rel}${name}`] = node.content;
    }
  };
  walkDir(dir, '');
  return out;
}

function doMount(sys: ShellSystem, s: Storage, devRaw: string, dir: string, opts: string, io: IO): number {
  const dev = canonDev(s, devRaw);
  if (!dev) {
    io.err(`mount: ${dir}: special device ${devRaw} does not exist.\n`);
    return 32;
  }
  const fs = fsOf(s, dev);
  if (!fs) {
    io.err(`mount: ${dir}: wrong fs type, bad option, bad superblock on ${dev}, missing codepage or helper program, or other error.\n       (Is there a file system on it? Create one with mkfs.)\n`);
    return 32;
  }
  const l = lookup(sys.fs, dir, ROOT);
  if (!l || l.node.type !== 'dir') {
    io.err(`mount: ${dir}: mount point does not exist.\n`);
    return 32;
  }
  if (s.mounts.some((m) => m.dir === dir)) {
    io.err(`mount: ${dir}: ${dev} already mounted on ${dir}.\n`);
    return 32;
  }
  s.mounts.push({ dev, dir, fs, opts });
  const lv = s.lvs.find((x) => `/dev/${x.vg}/${x.name}` === dev);
  if (lv?.files) for (const [rel, content] of Object.entries(lv.files)) wr(sys, `${dir}/${rel}`, content);
  return 0;
}

/* ----------------------------------------------------------------------------- commands */

function digOut(q: string, type: string, r: DnsAnswer, short: boolean): string {
  if (r.status === 'TIMEOUT') return `;; communications error to ${r.server || '127.0.0.1'}#53: timed out\n;; no servers could be reached\n`;
  const fmt = (x: DnsRecord) => `${x.name}.\t${x.ttl}\tIN\t${x.type}\t${['NS', 'CNAME', 'PTR'].includes(x.type) ? x.data + '.' : x.type === 'MX' ? x.data + '.' : x.data}`;
  if (short) return r.answers.map((x) => (['NS', 'CNAME', 'PTR'].includes(x.type) ? x.data + '.' : x.type === 'MX' ? x.data + '.' : x.data) + '\n').join('');
  const head = `\n; <<>> DiG 9.18.28 <<>> ${q} ${type}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${r.status}, id: 4242\n;; flags: qr${r.aa ? ' aa' : ''} rd ra; QUERY: 1, ANSWER: ${r.answers.length}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${q.replace(/\.$/, '')}.\t\tIN\t${type}\n`;
  const ans = r.answers.length ? `\n;; ANSWER SECTION:\n${r.answers.map((x) => fmt(x) + '\n').join('')}` : '';
  return `${head}${ans}\n;; Query time: 1 msec\n;; SERVER: ${r.server}#53(${r.server}) (UDP)\n;; WHEN: Thu Oct 22 09:30:00 GMT 2026\n`;
}

const nmcliShow = (sys: ShellSystem): string => {
  const kf = rd(sys, '/etc/NetworkManager/system-connections/eth0.nmconnection') ?? '';
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(kf)?.[1];
  const addr = sys.network?.address ?? '10.0.0.10/24';
  const method = get('method') ?? 'auto';
  return `connection.id:                          eth0\nconnection.interface-name:              eth0\nconnection.autoconnect:                 yes\nipv4.method:                            ${method}\nipv4.addresses:                         ${get('address1')?.split(',')[0] ?? (method === 'manual' ? addr : '--')}\nipv4.gateway:                           ${get('address1')?.split(',')[1] ?? get('gateway') ?? (method === 'manual' ? sys.network?.gateway ?? '--' : '--')}\nipv4.dns:                               ${get('dns')?.replace(/;$/, '').replace(/;/g, ',') ?? '--'}\nIP4.ADDRESS[1]:                         ${addr}\nIP4.GATEWAY:                            ${sys.network?.gateway ?? '--'}\nIP4.DNS[1]:                             ${resolvConf(sys).nameservers[0] ?? '--'}\n`;
};

const ZONES = ['Africa/Accra', 'Africa/Abidjan', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Asia/Tokyo', 'UTC', 'Etc/UTC'];
const LOCALES = ['en_GB.UTF-8', 'en_US.UTF-8', 'fr_FR.UTF-8', 'C.UTF-8', 'POSIX'];

const SYSCTL_DEFAULTS: Record<string, string> = {
  'net.ipv4.ip_forward': '0',
  'net.ipv4.tcp_syncookies': '1',
  'net.ipv4.conf.all.accept_redirects': '1',
  'net.ipv4.conf.all.send_redirects': '1',
  'net.ipv4.conf.all.rp_filter': '0',
  'net.ipv4.icmp_echo_ignore_broadcasts': '1',
  'net.ipv4.conf.all.log_martians': '0',
  'net.core.somaxconn': '4096',
  'vm.swappiness': '60',
  'kernel.panic': '0',
  'vm.dirty_ratio': '20',
  'vm.dirty_background_ratio': '10',
  'fs.file-max': '9223372036854775807',
  'kernel.randomize_va_space': '2',
  'kernel.dmesg_restrict': '0',
  'kernel.kptr_restrict': '1',
  'net.ipv6.conf.all.disable_ipv6': '0',
};
const SYSCTL_RUN = '/run/lab/sysctl.json';
const sysctlRuntime = (sys: ShellSystem) => ({ ...SYSCTL_DEFAULTS, ...json<Record<string, string>>(sys, SYSCTL_RUN, {}) });
function sysctlLoad(sys: ShellSystem, path: string, io: IO): number {
  const text = rd(sys, path);
  if (text === null) {
    io.err(`sysctl: cannot open "${path}": No such file or directory\n`);
    return 1;
  }
  const run = json<Record<string, string>>(sys, SYSCTL_RUN, {});
  for (const l of lines(text)) {
    const s = l.replace(/[#;].*/, '').trim();
    if (!s) continue;
    const m = /^([\w.-]+)\s*=\s*(.+)$/.exec(s);
    if (!m || !(m[1] in SYSCTL_DEFAULTS)) {
      io.err(`sysctl: cannot stat /proc/sys/${(m?.[1] ?? s).replace(/\./g, '/')}: No such file or directory\n`);
      continue;
    }
    run[m[1]] = m[2].trim();
    io.out(`${m[1]} = ${m[2].trim()}\n`);
  }
  wr(sys, SYSCTL_RUN, JSON.stringify(run));
  return 0;
}

export const SYSADMIN_COMMANDS: Record<string, Cmd> = {
  /* ---------------------------------------------------------- names */
  dig: (args, io, ctx) => {
    const sys = ctx.sys;
    let server: string | undefined;
    let type = 'A';
    let name = '';
    let short = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('@')) server = a.slice(1) === 'localhost' ? '127.0.0.1' : a.slice(1);
      else if (a === '+short') short = true;
      else if (a.startsWith('+')) continue;
      else if (a === '-x') {
        name = reverseName(args[++i] ?? '');
        type = 'PTR';
      } else if (a === '-t') type = (args[++i] ?? 'A').toUpperCase();
      else if (/^(A|AAAA|NS|MX|CNAME|PTR|SOA|TXT|SRV|ANY|AXFR)$/i.test(a) && name) type = a.toUpperCase();
      else if (!name) name = a;
    }
    if (!name) name = '.';
    if (server && !isIp(server)) server = resolveHost(sys, server) ?? server;
    const r = dnsQuery(sys, name, type, server);
    if (type === 'AXFR') {
      const cfg = namedConfig(sys);
      const z = cfg.zones.find((x) => x.name === name.replace(/\.$/, '').toLowerCase());
      const allowed = z?.allowTransfer;
      if (!z || r.status !== 'NOERROR' || (allowed && !allowed.some((a) => a === 'any' || a === '127.0.0.1' || a === ownAddress(sys) || inCidr(ownAddress(sys), a)))) {
        io.out(`; <<>> DiG 9.18.28 <<>> ${name} AXFR\n; Transfer failed.\n`);
        return 0;
      }
      io.out(r.answers.map((x) => `${x.name}.\t${x.ttl}\tIN\t${x.type}\t${x.data}\n`).join(''));
      return 0;
    }
    io.out(digOut(name, type, r, short));
    return r.status === 'TIMEOUT' ? 9 : 0;
  },
  host: (args, io, ctx) => {
    const o = parseOpts(args, ['t']);
    const [name, server] = o.rest;
    if (!name) {
      io.err('Usage: host [-t type] name [server]\n');
      return 1;
    }
    const type = isIp(name) ? 'PTR' : (o.values.t ?? 'A').toUpperCase();
    const q = isIp(name) ? reverseName(name) : name;
    const r = isIp(name) ? dnsQuery(ctx.sys, q, type, server) : searchQuery(ctx.sys, q, type, server);
    if (r.status === 'TIMEOUT') {
      io.out(';; connection timed out; no servers could be reached\n');
      return 1;
    }
    if (!r.answers.length) {
      io.out(`Host ${name} not found: 3(${r.status})\n`);
      return 1;
    }
    for (const x of r.answers) io.out(x.type === 'A' ? `${x.name} has address ${x.data}\n` : x.type === 'PTR' ? `${q} domain name pointer ${x.data}.\n` : x.type === 'MX' ? `${x.name} mail is handled by ${x.data}.\n` : x.type === 'CNAME' ? `${x.name} is an alias for ${x.data}.\n` : `${x.name} ${x.type} ${x.data}\n`);
    return 0;
  },
  nslookup: (args, io, ctx) => {
    const typeArg = args.find((a) => /^-(type|q|querytype)=/i.test(a));
    const type = (typeArg?.split('=')[1] ?? 'A').toUpperCase();
    const [name, server] = args.filter((a) => !a.startsWith('-'));
    if (!name) {
      io.err('Usage: nslookup [-type=T] name [server]\n');
      return 1;
    }
    const q = isIp(name) ? reverseName(name) : name;
    const r = isIp(name) ? dnsQuery(ctx.sys, q, 'PTR', server) : searchQuery(ctx.sys, q, type, server);
    if (r.status === 'TIMEOUT') {
      io.out(';; connection timed out; no servers could be reached\n');
      return 1;
    }
    io.out(`Server:\t\t${r.server}\nAddress:\t${r.server}#53\n\n`);
    if (!r.answers.length) {
      io.out(`** server can't find ${name}: ${r.status}\n`);
      return 1;
    }
    for (const x of r.answers) io.out(x.type === 'A' ? `${r.aa ? '' : 'Non-authoritative answer:\n'}Name:\t${x.name}\nAddress: ${x.data}\n` : x.type === 'PTR' ? `${q}\tname = ${x.data}.\n` : `${x.name}\t${x.type.toLowerCase()} = ${x.data}\n`);
    return 0;
  },
  getent: (args, io, ctx) => {
    if (args[0] !== 'hosts' && args[0] !== 'ahosts') return ADMIN_COMMANDS.getent(args, io, ctx);
    const name = args[1];
    if (!name) {
      for (const l of lines(rd(ctx.sys, '/etc/hosts') ?? '')) if (l.trim() && !l.startsWith('#')) io.out(l + '\n');
      return 0;
    }
    const ip = resolveHost(ctx.sys, name);
    if (!ip) return 2;
    io.out(`${ip.padEnd(15)} ${name}\n`);
    return 0;
  },
  ping: (args, io, ctx) => {
    const o = parseOpts(args, ['c', 'W', 'i']);
    const host = o.rest[0];
    if (!host) return ADMIN_COMMANDS.ping(args, io, ctx);
    const ip = resolveHost(ctx.sys, host);
    if (!ip) {
      io.err(`ping: ${host}: Name or service not known\n`);
      return 2;
    }
    const net = ctx.sys.network ?? { address: '10.0.0.10/24', gateway: '10.0.0.1' };
    const known = ip === '127.0.0.1' || ip === ownAddress(ctx.sys) || ip === net.gateway || Object.values(net.hosts ?? {}).includes(ip) || !!upstream(ctx.sys, host);
    const reachable = known && (inCidr(ip, net.address.includes('/') ? `${net.address.split('/')[0].replace(/\.\d+$/, '.0')}/${net.address.split('/')[1]}` : `${net.address}/24`) || !!net.gateway || ip.startsWith('127.'));
    const n = Number(o.values.c ?? 4);
    io.out(`PING ${host} (${ip}) 56(84) bytes of data.\n`);
    if (!reachable) {
      io.out(`\n--- ${host} ping statistics ---\n${n} packets transmitted, 0 received, 100% packet loss, time ${n * 1000}ms\n`);
      return 1;
    }
    for (let i = 1; i <= n; i++) io.out(`64 bytes from ${ip}: icmp_seq=${i} ttl=64 time=0.${(40 + i * 7) % 100} ms\n`);
    io.out(`\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss, time ${(n - 1) * 1000}ms\n`);
    return 0;
  },
  traceroute: (args, io, ctx) => {
    const host = args.find((a) => !a.startsWith('-')) ?? '';
    const ip = resolveHost(ctx.sys, host);
    if (!ip) {
      io.err(`${host}: Name or service not known\n`);
      return 2;
    }
    const gw = ctx.sys.network?.gateway;
    io.out(`traceroute to ${host} (${ip}), 30 hops max, 60 byte packets\n`);
    if (gw && ip !== gw && !ip.startsWith('127.')) io.out(` 1  ${gw} (${gw})  0.412 ms  0.388 ms  0.371 ms\n 2  ${ip} (${ip})  1.204 ms  1.188 ms  1.170 ms\n`);
    else io.out(` 1  ${ip} (${ip})  0.320 ms  0.301 ms  0.297 ms\n`);
    return 0;
  },

  /* ---------------------------------------------------------- network configuration */
  nmcli: (args, io, ctx) => {
    const sys = ctx.sys;
    const words = args.filter((a) => a !== '-p');
    const [obj, verb, conn, ...rest] = words;
    if (!obj || /^(g|general)/.test(obj)) {
      io.out('STATE      CONNECTIVITY  WIFI-HW  WIFI     WWAN-HW  WWAN\nconnected  full          missing  enabled  missing  enabled\n');
      return 0;
    }
    if (/^d(ev(ice)?)?$/.test(obj)) {
      io.out('DEVICE  TYPE      STATE      CONNECTION\neth0    ethernet  connected  eth0\nlo      loopback  unmanaged  --\n');
      return 0;
    }
    if (!/^c(on(nection)?)?$/.test(obj)) {
      io.err(`Error: argument '${obj}' not understood. Try nmcli connection or nmcli device.\n`);
      return 2;
    }
    const kfPath = '/etc/NetworkManager/system-connections/eth0.nmconnection';
    const kf = (): Record<string, string> => Object.fromEntries(lines(rd(sys, kfPath) ?? '').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (!verb || verb === 'show' && !conn) {
      io.out('NAME  UUID                                  TYPE      DEVICE\neth0  5fb06bd0-0bb0-7ffb-45f1-d6edd65f3e03  ethernet  eth0\n');
      return 0;
    }
    if (conn && conn !== 'eth0' && !/^(id|uuid)$/.test(conn)) {
      io.err(`Error: unknown connection '${conn}'.\n`);
      return 10;
    }
    if (verb === 'show') {
      io.out(nmcliShow(sys));
      return 0;
    }
    if (currentUser(ctx) !== 'root') {
      io.err('Error: Failed to modify connection: Insufficient privileges.\n');
      return 1;
    }
    if (/^mod(ify)?$/.test(verb)) {
      const k = kf();
      for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i].replace(/^\+/, '');
        const val = rest[i + 1] ?? '';
        if (key === 'ipv4.method') k.method = val;
        else if (key === 'ipv4.addresses') {
          if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(val)) {
            io.err(`Error: failed to modify ipv4.addresses: invalid IP address: '${val}' (use address/prefix, for example 10.20.30.40/24).\n`);
            return 2;
          }
          k.address1 = [val, k.address1?.split(',')[1]].filter(Boolean).join(',');
        } else if (key === 'ipv4.gateway') k.address1 = [k.address1?.split(',')[0] ?? '', val].join(',');
        else if (key === 'ipv4.dns') k.dns = val.split(/[,\s]+/).filter(Boolean).join(';') + ';';
        else if (key === 'ipv4.dns-search') k['dns-search'] = val;
        else if (key === 'connection.autoconnect') k.autoconnect = val;
        else {
          io.err(`Error: invalid property '${key}'.\n`);
          return 2;
        }
      }
      if (k.method === 'manual' && !k.address1?.split(',')[0]) {
        io.err("Error: Failed to modify connection 'eth0': ipv4.addresses: this property cannot be empty for 'method=manual'\n");
        return 4;
      }
      wr(sys, kfPath, ['[connection]', 'id=eth0', 'type=ethernet', 'interface-name=eth0', '', '[ipv4]', ...Object.entries(k).map(([a, b]) => `${a}=${b}`)].join('\n') + '\n');
      return 0;
    }
    if (verb === 'up' || verb === 'reload') {
      const k = kf();
      if (k.method === 'manual') {
        const [addr, gw] = (k.address1 ?? '').split(',');
        sys.network = { ...(sys.network ?? { address: '10.0.0.10/24' }), address: addr, ...(gw ? { gateway: gw } : {}) };
        if (gw && !inCidr(gw, `${addr.split('/')[0]}/${addr.split('/')[1]}`)) io.err(`Warning: gateway ${gw} is not on the ${addr} network; routing will fail.\n`);
      }
      if (k.dns) wr(sys, '/etc/resolv.conf', `# Generated by NetworkManager\n${k['dns-search'] ? `search ${k['dns-search'].replace(/[;,]/g, ' ').trim()}\n` : ''}${k.dns.split(';').filter(Boolean).map((d) => `nameserver ${d}`).join('\n')}\n`);
      io.out('Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/2)\n');
      return 0;
    }
    io.err(`Error: argument '${verb}' not understood.\n`);
    return 2;
  },
  ip: (args, io, ctx) => {
    const sys = ctx.sys;
    const [obj, verb] = args;
    if ((obj?.startsWith('a') || obj?.startsWith('r')) && (verb === 'add' || verb === 'del' || verb === 'replace')) {
      if (currentUser(ctx) !== 'root') {
        io.err('RTNETLINK answers: Operation not permitted\n');
        return 2;
      }
      const net = sys.network ?? { address: '10.0.0.10/24', gateway: '10.0.0.1' };
      if (obj.startsWith('a')) {
        const addr = args[2];
        if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(addr ?? '')) {
          io.err(`Error: any valid prefix is expected rather than "${addr ?? ''}".\n`);
          return 1;
        }
        sys.network = { ...net, address: verb === 'del' ? net.address : addr };
        return 0;
      }
      const via = args[args.indexOf('via') + 1];
      if (verb === 'del') sys.network = { ...net, gateway: undefined };
      else if (via) sys.network = { ...net, gateway: via };
      return 0;
    }
    return ADMIN_COMMANDS.ip(args, io, ctx);
  },
  nmap: (args, io, ctx) => {
    const sys = ctx.sys;
    const target = args.find((a) => !a.startsWith('-')) ?? '';
    const ip = resolveHost(sys, target);
    if (!ip) {
      io.out(`Failed to resolve "${target}".\nWARNING: No targets were specified, so 0 hosts scanned.\n`);
      return 0;
    }
    const local = ip.startsWith('127.') || target === 'localhost';
    const mine = local || ip === ownAddress(sys);
    io.out(`Starting Nmap 7.95 ( https://nmap.org ) at 2026-10-22 09:30 GMT\nNmap scan report for ${target} (${ip})\n`);
    if (!mine) {
      io.out('Host is up (0.00041s latency).\nAll 1000 scanned ports on this host are in ignored states.\n(Only this machine is simulated in this lab.)\n');
      return 0;
    }
    const names: Record<number, string> = { 22: 'ssh', 25: 'smtp', 53: 'domain', 80: 'http', 443: 'https', 445: 'microsoft-ds', 2049: 'nfs', 3306: 'mysql', 5432: 'postgresql', 21: 'ftp', 8080: 'http-proxy', 9090: 'zeus-admin' };
    const listening = Object.entries(sys.services).filter(([, s]) => s.active && s.port).map(([, s]) => s.port!);
    const open = local ? new Set(listening) : openPorts(sys);
    const filtered = local ? [] : listening.filter((p) => !open.has(p));
    io.out(`Host is up (0.000050s latency).\nNot shown: ${1000 - open.size - filtered.length} closed tcp ports (reset)\nPORT     STATE    SERVICE\n`);
    for (const p of [...open, ...filtered].sort((a, b) => a - b)) io.out(`${`${p}/tcp`.padEnd(8)} ${(open.has(p) ? 'open' : 'filtered').padEnd(8)} ${names[p] ?? 'unknown'}\n`);
    io.out(`\nNmap done: 1 IP address (1 host up) scanned in 0.12 seconds\n`);
    return 0;
  },
  'firewall-cmd': (args, io, ctx) => {
    const sys = ctx.sys;
    const o = parseOpts(args, ['add-service', 'remove-service', 'add-port', 'remove-port', 'zone', 'add-forward-port', 'remove-forward-port', 'add-rich-rule', 'remove-rich-rule', 'query-service', 'query-port', 'add-source', 'set-default-zone']);
    if (o.flags.has('state')) {
      io.out(sys.services.firewalld?.active ? 'running\n' : 'not running\n');
      return sys.services.firewalld?.active ? 0 : 252;
    }
    if (!sys.services.firewalld?.active) {
      io.err('FirewallD is not running\n');
      return 252;
    }
    const st = fwState(sys);
    if (o.flags.has('get-default-zone')) {
      io.out('public\n');
      return 0;
    }
    if (o.flags.has('get-services')) {
      io.out(Object.keys(SERVICE_PORTS).join(' ') + '\n');
      return 0;
    }
    if (o.values['query-service'] !== undefined) {
      const yes = st.services.includes(o.values['query-service']);
      io.out(yes ? 'yes\n' : 'no\n');
      return yes ? 0 : 1;
    }
    if (o.values['query-port'] !== undefined) {
      const yes = st.ports.includes(o.values['query-port']);
      io.out(yes ? 'yes\n' : 'no\n');
      return yes ? 0 : 1;
    }
    if (o.flags.has('query-masquerade')) {
      io.out(st.masquerade ? 'yes\n' : 'no\n');
      return st.masquerade ? 0 : 1;
    }
    if (o.flags.has('list-all')) {
      io.out(`public (active)\n  target: default\n  interfaces: eth0\n  sources:\n  services: ${st.services.join(' ')}\n  ports: ${st.ports.join(' ')}\n  masquerade: ${st.masquerade ? 'yes' : 'no'}\n  forward-ports:${st.forwards.map((f) => `\n\t${f}`).join('')}\n  rich rules:${st.rich.map((r) => `\n\t${r}`).join('')}\n`);
      return 0;
    }
    if (o.flags.has('list-services')) {
      io.out(st.services.join(' ') + '\n');
      return 0;
    }
    if (o.flags.has('list-ports')) {
      io.out(st.ports.join(' ') + '\n');
      return 0;
    }
    if (o.flags.has('list-forward-ports')) {
      io.out(st.forwards.map((f) => f + '\n').join(''));
      return 0;
    }
    if (o.flags.has('list-rich-rules')) {
      io.out(st.rich.map((f) => f + '\n').join(''));
      return 0;
    }
    if (currentUser(ctx) !== 'root') {
      io.err('Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.\n');
      return 1;
    }
    if (o.flags.has('reload') || o.flags.has('runtime-to-permanent')) {
      io.out('success\n');
      return 0;
    }
    const svc = o.values['add-service'];
    if (svc !== undefined && !SERVICE_PORTS[svc]) {
      io.err(`Error: INVALID_SERVICE: '${svc}' not among existing services\n`);
      return 101;
    }
    const port = o.values['add-port'];
    if (port !== undefined && !/^\d+(-\d+)?\/(tcp|udp)$/.test(port)) {
      io.err(`Error: INVALID_PORT: ${port} (use port/protocol, for example 8080/tcp)\n`);
      return 102;
    }
    const fwd = o.values['add-forward-port'];
    if (fwd !== undefined && !/^port=\d+:proto=(tcp|udp)(:toport=\d+)?(:toaddr=[\d.]+)?$/.test(fwd)) {
      io.err(`Error: INVALID_FORWARD: ${fwd} (use port=80:proto=tcp:toport=8080[:toaddr=10.0.0.20])\n`);
      return 103;
    }
    if (svc && !st.services.includes(svc)) st.services.push(svc);
    if (port && !st.ports.includes(port)) st.ports.push(port);
    if (fwd && !st.forwards.includes(fwd)) st.forwards.push(fwd);
    // firewalld stores rich rules in its canonical form: double quotes, single spaces.
    const canon = (r: string) => r.replace(/'/g, '"').replace(/\s+/g, ' ').trim();
    if (o.values['add-rich-rule'] && !st.rich.includes(canon(o.values['add-rich-rule']))) st.rich.push(canon(o.values['add-rich-rule']));
    if (o.values['remove-service']) st.services = st.services.filter((s) => s !== o.values['remove-service']);
    if (o.values['remove-port']) st.ports = st.ports.filter((s) => s !== o.values['remove-port']);
    if (o.values['remove-forward-port']) st.forwards = st.forwards.filter((s) => s !== o.values['remove-forward-port']);
    if (o.values['remove-rich-rule']) st.rich = st.rich.filter((s) => s !== canon(o.values['remove-rich-rule']!));
    if (o.flags.has('add-masquerade')) st.masquerade = true;
    if (o.flags.has('remove-masquerade')) st.masquerade = false;
    const changed = [svc, port, fwd, o.values['add-rich-rule'], o.values['remove-service'], o.values['remove-port'], o.values['remove-forward-port'], o.values['remove-rich-rule']].some((x) => x !== undefined) || o.flags.has('add-masquerade') || o.flags.has('remove-masquerade');
    if (!changed) {
      io.err('firewall-cmd: unsupported option in this simulator\n');
      return 1;
    }
    saveFw(sys, st);
    io.out('success\n');
    return 0;
  },

  /* ---------------------------------------------------------- systemd */
  systemctl: (args, io, ctx) => {
    const sys = ctx.sys;
    scanUnits(sys);
    const o = parseOpts(args);
    const [action, unitRaw] = o.rest;
    const defFile = '/etc/systemd/system/default.target';
    if (action === 'get-default') {
      io.out((rd(sys, defFile)?.trim() || 'multi-user.target') + '\n');
      return 0;
    }
    if (action === 'set-default' || action === 'isolate') {
      if (!unitRaw || !TARGETS.includes(unitRaw)) {
        io.err(`Failed to ${action}: Unit ${unitRaw ?? ''} not found.\n`);
        return 1;
      }
      if (currentUser(ctx) !== 'root') {
        io.err(`Failed to ${action}: Access denied\n`);
        return 1;
      }
      if (action === 'set-default') {
        wr(sys, defFile, unitRaw + '\n');
        io.out(`Removed "/etc/systemd/system/default.target".\nCreated symlink /etc/systemd/system/default.target → /usr/lib/systemd/system/${unitRaw}.\n`);
      }
      return 0;
    }
    if (action === 'daemon-reload') return 0;
    if (action === 'list-timers') {
      io.out('NEXT                         LEFT     LAST  PASSED  UNIT                ACTIVATES\n');
      for (const [n, s] of Object.entries(sys.services)) if (n.endsWith('.timer') && s.active) {
        const text = rd(sys, (s as typeof s & { unitFile?: string }).unitFile ?? '') ?? '';
        io.out(`Fri 2026-10-23 ${(unitDirective(text, 'OnCalendar') ?? 'boot').padEnd(13)} 14h left -     -       ${n.padEnd(19)} ${unitDirective(text, 'Unit') ?? n.replace(/\.timer$/, '.service')}\n`);
      }
      return 0;
    }
    const unit = unitRaw?.replace(/\.service$/, '');
    if (unit && ['start', 'restart', 'reload', 'enable'].includes(action) && (action !== 'enable' || o.flags.has('now'))) {
      const extra = unit === 'sshd' ? sshdProblems(sys) : unit === 'apache2' ? apacheProblems(sys).filter((p) => !serviceFaults(sys, 'apache2').includes(p)) : unit === 'named' ? namedProblems(sys).filter((p) => !serviceFaults(sys, 'named').includes(p)) : unit === 'fail2ban' ? fail2banProblems(sys) : unitProblems(sys, unit);
      const s = sys.services[unit];
      if (extra.length && s && currentUser(ctx) === 'root' && (!s.package || sys.packages[s.package]?.installed)) {
        if (action === 'enable') s.enabled = true;
        s.active = false;
        s.logs.push(...extra, `${unit}: Failed with result 'exit-code'.`, `Failed to start ${s.description}.`);
        io.err(`Job for ${unit}${unit.endsWith('.timer') ? '' : '.service'} failed because the control process exited with error code.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n`);
        return 1;
      }
      // sshd listens where its configuration says once it (re)starts.
      if (unit === 'sshd' && s && currentUser(ctx) === 'root') s.port = Number(sshdOption(sys, 'port', '22')) || 22;
      if (s && (action === 'start' || action === 'restart') && !unit.endsWith('.timer') && currentUser(ctx) === 'root') {
        const text = rd(sys, (s as typeof s & { unitFile?: string }).unitFile ?? '') ?? '';
        if (/^\s*Type\s*=\s*oneshot\s*$/im.test(text)) return runOneshot(ctx, unit, text, io);
      }
    }
    return ADMIN_COMMANDS.systemctl(args, io, ctx);
  },
  service: (args, io, ctx) => SYSADMIN_COMMANDS.systemctl([args[1], args[0]], io, ctx),
  timedatectl: (args, io, ctx) => {
    const sys = ctx.sys;
    const tz = rd(sys, '/etc/timezone')?.trim() || 'UTC';
    const ntp = rd(sys, '/run/lab/ntp')?.trim() !== 'no';
    if (!args[0] || args[0] === 'status' || args[0] === 'show') {
      io.out(`               Local time: Thu 2026-10-22 09:30:00 ${tz === 'Africa/Lagos' ? 'WAT' : 'GMT'}\n           Universal time: Thu 2026-10-22 09:30:00 UTC\n                 Time zone: ${tz}\nSystem clock synchronized: ${ntp ? 'yes' : 'no'}\n              NTP service: ${ntp ? 'active' : 'inactive'}\n          RTC in local TZ: no\n`);
      return 0;
    }
    if (args[0] === 'list-timezones') {
      io.out(ZONES.join('\n') + '\n');
      return 0;
    }
    if (currentUser(ctx) !== 'root') {
      io.err('Failed to set time zone: Access denied\n');
      return 1;
    }
    if (args[0] === 'set-timezone') {
      if (!ZONES.includes(args[1] ?? '')) {
        io.err(`Failed to set time zone: Invalid or not installed time zone '${args[1] ?? ''}'\n`);
        return 1;
      }
      wr(sys, '/etc/timezone', args[1] + '\n');
      return 0;
    }
    if (args[0] === 'set-ntp') {
      wr(sys, '/run/lab/ntp', /^(true|yes|1|on)$/i.test(args[1] ?? '') ? 'yes\n' : 'no\n');
      return 0;
    }
    io.err(`Unknown command verb ${args[0]}.\n`);
    return 1;
  },
  localectl: (args, io, ctx) => {
    const sys = ctx.sys;
    const conf = rd(sys, '/etc/locale.conf') ?? 'LANG=en_GB.UTF-8\n';
    const kb = rd(sys, '/etc/vconsole.conf') ?? 'KEYMAP=gb\n';
    if (!args[0] || args[0] === 'status') {
      io.out(`System Locale: ${/LANG=(\S+)/.exec(conf)?.[1] ? `LANG=${/LANG=(\S+)/.exec(conf)![1]}` : 'n/a'}\n    VC Keymap: ${/KEYMAP=(\S+)/.exec(kb)?.[1] ?? 'n/a'}\n   X11 Layout: ${/KEYMAP=(\S+)/.exec(kb)?.[1] ?? 'n/a'}\n`);
      return 0;
    }
    if (args[0] === 'list-locales') {
      io.out(LOCALES.join('\n') + '\n');
      return 0;
    }
    if (currentUser(ctx) !== 'root') {
      io.err('Failed to issue method call: Access denied\n');
      return 1;
    }
    if (args[0] === 'set-locale') {
      const v = (args[1] ?? '').replace(/^LANG=/, '');
      if (!LOCALES.includes(v)) {
        io.err(`Failed to issue method call: Locale ${v} not installed, refusing.\n`);
        return 1;
      }
      wr(sys, '/etc/locale.conf', `LANG=${v}\n`);
      return 0;
    }
    if (args[0] === 'set-keymap') {
      wr(sys, '/etc/vconsole.conf', `KEYMAP=${args[1] ?? 'us'}\n`);
      return 0;
    }
    io.err(`Unknown command verb ${args[0]}.\n`);
    return 1;
  },
  sysctl: (args, io, ctx) => {
    const sys = ctx.sys;
    const o = parseOpts(args, ['p'], { system: 'system', write: 'w', all: 'a' });
    const run = sysctlRuntime(sys);
    if (o.flags.has('a')) {
      for (const [k, v] of Object.entries(run).sort()) io.out(`${k} = ${v}\n`);
      return 0;
    }
    if (o.flags.has('system')) {
      if (currentUser(ctx) !== 'root') {
        io.err('sysctl: permission denied on key, use sudo\n');
        return 1;
      }
      for (const f of [...ls(sys, '/etc/sysctl.d').filter((e) => e.name.endsWith('.conf')).map((e) => `/etc/sysctl.d/${e.name}`).sort(), '/etc/sysctl.conf']) {
        if (rd(sys, f) === null) continue;
        io.out(`* Applying ${f} ...\n`);
        sysctlLoad(sys, f, io);
      }
      return 0;
    }
    if (o.flags.has('p') || o.values.p !== undefined) {
      if (currentUser(ctx) !== 'root') {
        io.err('sysctl: permission denied on key, use sudo\n');
        return 1;
      }
      return sysctlLoad(sys, o.values.p || o.rest[0] || '/etc/sysctl.conf', io);
    }
    let code = 0;
    for (const a of o.rest) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a : a.slice(0, eq);
      if (!(key in SYSCTL_DEFAULTS)) {
        io.err(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory\n`);
        code = 255;
        continue;
      }
      if (eq < 0) {
        io.out(o.flags.has('n') ? `${run[key]}\n` : `${key} = ${run[key]}\n`);
        continue;
      }
      if (currentUser(ctx) !== 'root') {
        io.err(`sysctl: permission denied on key "${key}"\n`);
        code = 1;
        continue;
      }
      const cur = json<Record<string, string>>(sys, SYSCTL_RUN, {});
      cur[key] = a.slice(eq + 1);
      wr(sys, SYSCTL_RUN, JSON.stringify(cur));
      io.out(`${key} = ${a.slice(eq + 1)}\n`);
    }
    return code;
  },

  /* ---------------------------------------------------------- web */
  curl: (args, io, ctx) => {
    const sys = ctx.sys;
    const o = parseOpts(args, ['H', 'u', 'o', 'X', 'd']);
    const url = o.rest[0] ?? '';
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) return ADMIN_COMMANDS.curl(args, io, ctx);
    const host = m[2].toLowerCase();
    const port = Number(m[3] ?? (m[1] === 'https' ? 443 : 80));
    const ip = resolveHost(sys, host);
    const local = !!ip && (ip.startsWith('127.') || ip === ownAddress(sys));
    if (!local || !sys.services.apache2?.active || !sys.packages.apache2?.installed || port === 443) {
      if (ip && !local && host !== 'localhost') {
        io.err(`curl: (7) Failed to connect to ${host} port ${port}: Connection refused\n(Only this machine is simulated in this lab.)\n`);
        return 7;
      }
      if (!ip && host !== 'localhost' && !isIp(host)) {
        io.err(`curl: (6) Could not resolve host: ${host}\n`);
        return 6;
      }
      return ADMIN_COMMANDS.curl([o.flags.has('I') ? '-I' : '', `http://localhost${m[3] ? ':' + m[3] : ''}${m[4] ?? ''}`].filter(Boolean), io, ctx);
    }
    const listen = lines(rd(sys, '/etc/apache2/listen.conf') ?? 'Listen 80\n').map((l) => /^\s*Listen\s+(?:[\d.]+:)?(\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
    if (!listen.includes(port)) {
      io.err(`curl: (7) Failed to connect to ${host} port ${port}: Connection refused\n`);
      return 7;
    }
    const hdrHost = /^host:\s*(\S+)/i.exec(o.values.H ?? '')?.[1]?.toLowerCase();
    const want = hdrHost ?? host;
    const vh = apacheVhosts(sys).filter((v) => v.port === port);
    const v = vh.find((x) => x.names.includes(want)) ?? vh[0];
    const head = o.flags.has('I') || o.flags.has('head');
    const respond = (code: number, reason: string, body: string, extra = '') => {
      if (head || o.flags.has('i')) io.out(`HTTP/1.1 ${code} ${reason}\nServer: Apache/2.4.59 (Linux/SUSE)\n${extra}Content-Type: text/html\nContent-Length: ${body.length}\n\n`);
      if (!head) io.out(body);
      return 0;
    };
    if (v?.redirect) return respond(301, 'Moved Permanently', `<html><body><h1>Moved Permanently</h1><p>The document has moved <a href="${v.redirect}">here</a>.</p></body></html>\n`, `Location: ${v.redirect}\n`);
    const docroot = v?.root ?? (/^\s*DocumentRoot\s+"?([^"\s]+)/m.exec(rd(sys, '/etc/apache2/httpd.conf') ?? '')?.[1] ?? '/srv/www/htdocs').replace(/\/$/, '');
    const path = (m[4] ?? '/').replace(/\/$/, '/index.html');
    const file = docroot + path;
    if (v?.auth && file.startsWith(v.auth.dir + '/')) {
      const creds = o.values.u;
      const users = Object.fromEntries(lines(rd(sys, v.auth.file) ?? '').map((l) => [l.split(':')[0], l.split(':').slice(1).join(':')]));
      const ok = !!creds && users[creds.split(':')[0]] === htHash(creds.split(':').slice(1).join(':'));
      if (!ok) return respond(401, 'Unauthorized', '<html><body><h1>Unauthorized</h1><p>This server could not verify that you are authorized to access the document requested.</p></body></html>\n', 'WWW-Authenticate: Basic realm="Restricted"\n');
    }
    // Apache records why it refused a request in its error log.
    const errorLog = (msg: string) => {
      const log = '/var/log/apache2/error_log';
      if (lookup(sys.fs, '/var/log/apache2', ROOT)) wr(sys, log, (rd(sys, log) ?? '') + `[Thu Oct 22 09:30:00.000000 2026] [authz_core:error] [pid 2101] [client 127.0.0.1:51234] ${msg}\n`);
    };
    const forbidden = () => respond(403, 'Forbidden', `<html><body><h1>Forbidden</h1><p>You don't have permission to access ${path} on this server.</p></body></html>\n`);
    if (v?.denied.some((d) => file === d || file.startsWith(d + '/'))) {
      errorLog(`AH01630: client denied by server configuration: ${file}`);
      return forbidden();
    }
    const www = sys.users.wwwrun ? { user: 'wwwrun', groups: ['www'] } : ROOT;
    let body: string;
    try {
      body = readFile(sys.fs, file, www);
    } catch (e) {
      const exists = !!lookup(sys.fs, file, ROOT);
      if (exists) {
        errorLog(`AH00132: file permissions deny server access: ${file}`);
        return forbidden();
      }
      void e;
      return respond(404, 'Not Found', `<html><body><h1>Not Found</h1><p>The requested URL ${path} was not found on this server.</p></body></html>\n`);
    }
    return respond(200, 'OK', body);
  },
  htpasswd: (args, io, ctx) => {
    const o = parseOpts(args);
    const [file, user, pw] = o.rest;
    if (!file || !user) {
      io.err('Usage: htpasswd [-cbB] passwordfile username [password]\n');
      return 1;
    }
    const password = o.flags.has('b') ? pw ?? '' : lines(io.stdin)[0] ?? 'changeme';
    const path = abs(ctx, file);
    let cur: string[] = [];
    if (!o.flags.has('c')) {
      const t = rd(ctx.sys, path);
      if (t === null) {
        io.err(`htpasswd: cannot modify file ${file}; use '-c' to create it\n`);
        return 1;
      }
      cur = lines(t).filter((l) => l.split(':')[0] !== user);
    }
    try {
      writeFile(ctx.sys.fs, path, [...cur, `${user}:${htHash(password)}`].join('\n') + '\n', actor(ctx), ctx.sys.now);
    } catch {
      io.err(`htpasswd: cannot create file ${file}\n`);
      return 1;
    }
    io.out(`${o.flags.has('c') ? 'Adding' : 'Updating'} password for user ${user}\n`);
    return 0;
  },
  apachectl: (args, io, ctx) => {
    if (args[0] === 'configtest' || args[0] === '-t') {
      const problems = apacheProblems(ctx.sys);
      if (problems.length) {
        io.err(problems.map((p) => (p.startsWith('AH') ? p : `AH00526: ${p}`)).join('\n') + '\n');
        return 1;
      }
      io.out('Syntax OK\n');
      return 0;
    }
    if (args[0] === '-S') {
      for (const v of apacheVhosts(ctx.sys)) io.out(`*:${v.port}                 ${v.names[0] ?? 'default'} (${v.file})\n`);
      return 0;
    }
    return SYSADMIN_COMMANDS.systemctl([args[0], 'apache2'], io, ctx);
  },
  'named-checkconf': (_a, io, ctx) => {
    const p = namedConfig(ctx.sys).errors.concat(serviceFaults(ctx.sys, 'named'));
    if (p.length) {
      io.err(p.join('\n') + '\n');
      return 1;
    }
    return 0;
  },
  'named-checkzone': (args, io, ctx) => {
    const [zone, file] = args.filter((a) => !a.startsWith('-'));
    if (!zone || !file) {
      io.err('usage: named-checkzone zonename filename\n');
      return 1;
    }
    let content: string;
    try {
      content = readFile(ctx.sys.fs, abs(ctx, file), actor(ctx));
    } catch {
      io.err(`zone ${zone}/IN: loading from master file ${file} failed: file not found\nzone ${zone}/IN: not loaded due to errors.\n`);
      return 1;
    }
    const r = parseZone(content, zone);
    if (r.errors.length) {
      io.err(r.errors.map((e) => `zone ${zone}/IN: ${e}`).join('\n') + `\nzone ${zone}/IN: not loaded due to errors.\n`);
      return 1;
    }
    for (const x of r.records) if (['NS', 'CNAME', 'MX'].includes(x.type) && x.data.split(' ').pop()!.endsWith(`.${zone.replace(/\.$/, '')}.${zone.replace(/\.$/, '')}`)) io.out(`zone ${zone}/IN: ${x.name}/${x.type} '${x.data.split(' ').pop()}' (out of zone) has no addresses records (A or AAAA)\n`);
    io.out(`zone ${zone}/IN: loaded serial ${r.serial ?? 0}\nOK\n`);
    return 0;
  },
  'grub2-mkconfig': (args, io, ctx) => {
    const sys = ctx.sys;
    const o = parseOpts(args, ['o']);
    if (currentUser(ctx) !== 'root') {
      io.err('grub2-mkconfig: You must run this as root\n');
      return 1;
    }
    const d = rd(sys, '/etc/default/grub') ?? '';
    const get = (k: string, dflt: string) => new RegExp(`^${k}=["']?([^"'\\n]*)["']?`, 'm').exec(d)?.[1] ?? dflt;
    const timeout = get('GRUB_TIMEOUT', '8');
    if (!/^-?\d+$/.test(timeout)) {
      io.err(`/etc/default/grub: line ${d.split('\n').findIndex((l) => l.startsWith('GRUB_TIMEOUT')) + 1}: GRUB_TIMEOUT must be a number\n`);
      return 1;
    }
    const other = get('GRUB_DISABLE_OS_PROBER', 'true') === 'false' && rd(sys, '/etc/lab/other-os') !== null;
    io.err('Generating grub configuration file ...\nFound theme: /boot/grub2/themes/openSUSE/theme.txt\nFound linux image: /boot/vmlinuz-6.4.0-150600.23-default\nFound initrd image: /boot/initrd-6.4.0-150600.23-default\n');
    if (other) io.err(`Found ${rd(sys, '/etc/lab/other-os')!.trim()} on /dev/sda1\n`);
    io.err('done\n');
    const cfg = `# Generated by grub2-mkconfig from /etc/default/grub\nset timeout=${timeout}\nset default=${get('GRUB_DEFAULT', '0')}\nmenuentry 'openSUSE Leap 15.6' {\n  linux /boot/vmlinuz-6.4.0-150600.23-default root=/dev/sda2 ${get('GRUB_CMDLINE_LINUX_DEFAULT', 'quiet')}\n}\n${other ? `menuentry '${rd(sys, '/etc/lab/other-os')!.trim()}' {\n  chainloader /EFI/Microsoft/Boot/bootmgfw.efi\n}\n` : ''}`;
    if (o.values.o) wr(sys, abs(ctx, o.values.o), cfg);
    else io.out(cfg);
    return 0;
  },
  sshd: (args, io, ctx) => {
    if (args.includes('-t') || args.includes('-T')) {
      const p = sshdProblems(ctx.sys);
      if (p.length) {
        io.err(p.join('\n') + '\n');
        return 255;
      }
      if (args.includes('-T')) for (const k of ['port', 'permitrootlogin', 'passwordauthentication', 'pubkeyauthentication', 'maxauthtries', 'allowgroups']) io.out(`${k} ${sshdOption(ctx.sys, k, { port: '22', permitrootlogin: 'prohibit-password', passwordauthentication: 'yes', pubkeyauthentication: 'yes', maxauthtries: '6', allowgroups: '' }[k] ?? '')}\n`);
      return 0;
    }
    io.err('sshd: run it through systemctl (systemctl restart sshd); sshd -t tests the configuration.\n');
    return 1;
  },
  visudo: (args, io, ctx) => {
    // visudo -c checks everything; visudo -cf FILE (or -c -f FILE) checks one file.
    const fIdx = args.findIndex((a) => a === '-f' || a === '-cf' || a === '-fc');
    const one = fIdx >= 0 ? args[fIdx + 1] : undefined;
    if (args.some((a) => /^-[a-z]*c/.test(a)) && one) {
      const path = abs(ctx, one);
      const text = rd(ctx.sys, path);
      if (text === null) {
        io.err(`visudo: unable to open ${one}: No such file or directory\n`);
        return 1;
      }
      const bad = sudoersProblems({ ...ctx.sys, fs: ctx.sys.fs } as ShellSystem, [{ path: one, text }]);
      if (bad.length) {
        io.err(bad.map((x) => `${x}\n`).join('') + 'parse error\n');
        return 1;
      }
      io.out(`${one}: parsed OK\n`);
      return 0;
    }
    if (args.includes('-c')) {
      const p = sudoersProblems(ctx.sys);
      if (p.length) {
        io.err(p.map((x) => `${x}\n`).join('') + 'parse error\n');
        return 1;
      }
      for (const f of sudoersFiles(ctx.sys)) io.out(`${f.path}: parsed OK\n`);
      return 0;
    }
    return ADMIN_COMMANDS.visudo(args, io, ctx);
  },
  sudo: (args, io, ctx) => {
    const sys = ctx.sys;
    const me = currentUser(ctx);
    // sudo -l -U USER: root lists what another user may run.
    const uIdx = args.indexOf('-U');
    if (args.includes('-l') && uIdx >= 0) {
      const who = args[uIdx + 1] ?? '';
      if (!isSudoer(sys, me)) {
        io.err(`Sorry, user ${me} is not allowed to list another user's privileges.\n`);
        return 1;
      }
      const u = sys.users[who];
      if (!u) {
        io.err(`sudo: unknown user ${who}\n`);
        return 1;
      }
      const groups = new Set([groupName(sys, u.gid), ...u.groups]);
      if (isSudoer(sys, who)) {
        io.out(`User ${who} may run the following commands on ${sys.hostname}:\n    (ALL : ALL) ALL\n`);
        return 0;
      }
      const mine = sudoRules(sys).filter((r) => (r.who.startsWith('%') ? groups.has(r.who.slice(1)) : r.who === who));
      if (!mine.length) {
        io.out(`User ${who} is not allowed to run sudo on ${sys.hostname}.\n`);
        return 0;
      }
      io.out(`User ${who} may run the following commands on ${sys.hostname}:\n${mine.map((r) => `    (root) ${r.nopasswd ? 'NOPASSWD: ' : ''}${r.commands.join(', ')}\n`).join('')}`);
      return 0;
    }
    if (isSudoer(sys, me) && !sudoersProblems(sys).length) return ADMIN_COMMANDS.sudo(args, io, ctx);
    if (sudoersProblems(sys).length && me !== 'root') {
      io.err(`>>> /etc/sudoers.d: syntax error <<<\nsudo: parse error in ${sudoersProblems(sys)[0].split(':')[0]}\nsudo: no valid sudoers sources found, quitting\n`);
      return 1;
    }
    const o = parseOpts(args, ['u'], {}, true);
    if (o.flags.has('l')) {
      const mine = sudoRules(sys).filter((r) => (r.who.startsWith('%') ? sys.users[me]?.groups.includes(r.who.slice(1)) : r.who === me));
      if (!mine.length) {
        io.err(`Sorry, user ${me} may not run sudo on ${sys.hostname}.\n`);
        return 1;
      }
      io.out(`User ${me} may run the following commands on ${sys.hostname}:\n${mine.map((r) => `    (root) ${r.nopasswd ? 'NOPASSWD: ' : ''}${r.commands.join(', ')}\n`).join('')}`);
      return 0;
    }
    const rule = ruleFor(sys, me, o.rest);
    if (!rule) return ADMIN_COMMANDS.sudo(args, io, ctx);
    const saved = ctx.euser;
    ctx.euser = o.values.u ?? 'root';
    try {
      return runCommand(ctx, o.rest, io);
    } finally {
      ctx.euser = saved;
    }
  },

  /* ---------------------------------------------------------- storage */
  lsblk: (args, io, ctx) => {
    const s = stOf(ctx.sys);
    const f = args.includes('-f');
    const mountOf = (dev: string) => s.mounts.find((m) => m.dev === dev)?.dir ?? '';
    io.out(f ? 'NAME          FSTYPE      UUID                                 MOUNTPOINTS\n' : 'NAME          MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\n');
    io.out(f ? 'sda\n├─sda1        vfat                                             /boot/efi\n└─sda2        ext4                                             /\n' : 'sda             8:0    0   40G  0 disk\n├─sda1          8:1    0  512M  0 part /boot/efi\n└─sda2          8:2    0 39.5G  0 part /\n');
    s.disks.forEach((d, i) => {
      const dev = `/dev/${d.name}`;
      const pv = s.pvs.find((p) => p.dev === dev);
      io.out(f ? `${d.name.padEnd(13)} ${(pv ? 'LVM2_member' : d.fs ?? '').padEnd(11)} ${pv || d.fs ? uuidOf(dev) : ''.padEnd(36)} ${mountOf(dev)}\n` : `${d.name.padEnd(15)} 8:${16 * (i + 1)}   0 ${String(d.sizeGb + 'G').padStart(4)}  0 disk ${mountOf(dev)}\n`);
      if (pv?.vg) for (const lv of s.lvs.filter((l) => l.vg === pv.vg)) {
        const ldev = `/dev/${lv.vg}/${lv.name}`;
        io.out(f ? `└─${(lv.vg + '-' + lv.name).padEnd(11)} ${(lv.fs ?? '').padEnd(11)} ${lv.fs ? uuidOf(ldev) : ''.padEnd(36)} ${mountOf(ldev)}\n` : `└─${(lv.vg + '-' + lv.name).padEnd(13)} 254:${s.lvs.indexOf(lv)}  0 ${String(lv.sizeGb + 'G').padStart(4)}  0 lvm  ${mountOf(ldev)}\n`);
      }
    });
    return 0;
  },
  blkid: (args, io, ctx) => {
    const s = stOf(ctx.sys);
    const want = args.find((a) => a.startsWith('/dev/'));
    const devs = [...s.disks.filter((d) => d.fs || s.pvs.some((p) => p.dev === `/dev/${d.name}`)).map((d) => ({ dev: `/dev/${d.name}`, type: d.fs ?? 'LVM2_member' })), ...s.lvs.filter((l) => l.fs).map((l) => ({ dev: `/dev/mapper/${l.vg}-${l.name}`, type: l.fs! }))];
    for (const d of devs) if (!want || canonDev(s, want) === canonDev(s, d.dev)) io.out(`${d.dev}: UUID="${uuidOf(canonDev(s, d.dev) ?? d.dev)}" TYPE="${d.type}"\n`);
    return 0;
  },
  pvcreate: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    for (const dev of args.filter((a) => a.startsWith('/dev/'))) {
      if (!s.disks.some((d) => `/dev/${d.name}` === dev)) return fail(io, `  No device found for ${dev}.`);
      if (s.mounts.some((m) => m.dev === dev)) return fail(io, `  Can't open ${dev} exclusively.  Mounted filesystem?`);
      if (!s.pvs.some((p) => p.dev === dev)) s.pvs.push({ dev });
      io.out(`  Physical volume "${dev}" successfully created.\n`);
    }
    return 0;
  }),
  pvs: (_a, io, ctx) => {
    const s = stOf(ctx.sys);
    io.out('  PV         VG     Fmt  Attr PSize   PFree\n');
    for (const p of s.pvs) io.out(`  ${p.dev.padEnd(10)} ${(p.vg ?? '').padEnd(6)} lvm2 a--  ${(sizeOfDisk(s, p.dev) + '.00g').padStart(7)} ${((p.vg ? Math.max(0, vgSize(s, p.vg) - vgUsed(s, p.vg)) : sizeOfDisk(s, p.dev)) + '.00g').padStart(7)}\n`);
    return 0;
  },
  vgcreate: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const [name, ...devs] = args.filter((a) => !a.startsWith('-'));
    if (!name || !devs.length) return fail(io, '  Please provide a volume group name and physical volumes.');
    if (s.vgs.some((v) => v.name === name)) return fail(io, `  A volume group called ${name} already exists.`);
    for (const d of devs) {
      const pv = s.pvs.find((p) => p.dev === d);
      if (!pv) return fail(io, `  Physical volume ${d} not found (run pvcreate ${d} first).`);
      if (pv.vg) return fail(io, `  Physical volume '${d}' is already in volume group '${pv.vg}'.`);
    }
    for (const d of devs) s.pvs.find((p) => p.dev === d)!.vg = name;
    s.vgs.push({ name, pvs: devs });
    io.out(`  Volume group "${name}" successfully created\n`);
    return 0;
  }),
  vgextend: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const [name, ...devs] = args.filter((a) => !a.startsWith('-'));
    const vg = s.vgs.find((v) => v.name === name);
    if (!vg) return fail(io, `  Volume group "${name}" not found`);
    for (const d of devs) {
      const pv = s.pvs.find((p) => p.dev === d);
      if (!pv) return fail(io, `  Physical volume ${d} not found (run pvcreate ${d} first).`);
      if (pv.vg) return fail(io, `  Physical volume '${d}' is already in volume group '${pv.vg}'.`);
      pv.vg = name;
      vg.pvs.push(d);
    }
    io.out(`  Volume group "${name}" successfully extended\n`);
    return 0;
  }),
  vgs: (_a, io, ctx) => {
    const s = stOf(ctx.sys);
    io.out('  VG     #PV #LV #SN Attr   VSize   VFree\n');
    for (const v of s.vgs) io.out(`  ${v.name.padEnd(6)} ${String(v.pvs.length).padStart(3)} ${String(s.lvs.filter((l) => l.vg === v.name).length).padStart(3)} ${String(s.lvs.filter((l) => l.vg === v.name && l.snapshotOf).length).padStart(3)} wz--n- ${(vgSize(s, v.name) + '.00g').padStart(7)} ${(Math.max(0, vgSize(s, v.name) - vgUsed(s, v.name)) + '.00g').padStart(7)}\n`);
    return 0;
  },
  lvcreate: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const o = parseOpts(args, ['L', 'l', 'n'], { size: 'L', extents: 'l', name: 'n' });
    const snap = o.flags.has('s') || o.flags.has('snapshot');
    const target = o.rest[0];
    if (!o.values.n) return fail(io, '  Please specify a name with -n.');
    if (snap) {
      const origin = target ? canonDev(s, target) : null;
      const lv = origin ? s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === origin) : undefined;
      if (!lv) return fail(io, `  Logical volume ${target ?? ''} not found.`);
      const size = parseGb(o.values.L ?? '1G');
      if (vgSize(s, lv.vg) - vgUsed(s, lv.vg) < size) return fail(io, `  Volume group "${lv.vg}" has insufficient free space.`);
      const mount = s.mounts.find((m) => m.dev === origin);
      s.lvs.push({ vg: lv.vg, name: o.values.n, sizeGb: size, fs: lv.fs, snapshotOf: lv.name, files: mount ? collectFiles(ctx.sys, mount.dir) : lv.files });
      io.out(`  Logical volume "${o.values.n}" created.\n`);
      return 0;
    }
    const vg = s.vgs.find((v) => v.name === target);
    if (!vg) return fail(io, `  Volume group "${target ?? ''}" not found`);
    const free = vgSize(s, vg.name) - vgUsed(s, vg.name);
    const size = o.values.l ? (/^100%FREE$/i.test(o.values.l) ? free : /^(\d+)%FREE$/i.test(o.values.l) ? Math.floor((free * Number(/^(\d+)/.exec(o.values.l)![1])) / 100) : NaN) : parseGb(o.values.L ?? '');
    if (Number.isNaN(size) || size <= 0) return fail(io, '  Please specify a size with -L 10G or -l 100%FREE.');
    if (size > free + 1e-9) return fail(io, `  Volume group "${vg.name}" has insufficient free space (${free} GiB free, ${size} GiB requested).`);
    if (s.lvs.some((l) => l.vg === vg.name && l.name === o.values.n)) return fail(io, `  Logical Volume "${o.values.n}" already exists in volume group "${vg.name}"`);
    s.lvs.push({ vg: vg.name, name: o.values.n, sizeGb: size });
    io.out(`  Logical volume "${o.values.n}" created.\n`);
    return 0;
  }),
  lvextend: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const o = parseOpts(args, ['L', 'l'], { size: 'L', resizefs: 'r' });
    const dev = o.rest[0] ? canonDev(s, o.rest[0]) : null;
    const lv = dev ? s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === dev) : undefined;
    if (!lv) return fail(io, `  Logical volume ${o.rest[0] ?? ''} not found.`);
    const free = vgSize(s, lv.vg) - vgUsed(s, lv.vg);
    const spec = o.values.L ?? '';
    const add = o.values.l && /^\+100%FREE$/i.test(o.values.l) ? free : spec.startsWith('+') ? parseGb(spec) : parseGb(spec) - lv.sizeGb;
    if (Number.isNaN(add) || add <= 0) return fail(io, '  New size given is not larger than the current size.');
    if (add > free + 1e-9) return fail(io, `  Insufficient free space: ${add} GiB required, but only ${free} GiB available in "${lv.vg}".`);
    lv.sizeGb += add;
    io.out(`  Size of logical volume ${lv.vg}/${lv.name} changed to ${lv.sizeGb} GiB.\n  Logical volume ${lv.vg}/${lv.name} successfully resized.\n`);
    if (o.flags.has('r') && lv.fs) io.out(lv.fs === 'xfs' ? `meta-data=/dev/mapper/${lv.vg}-${lv.name} isize=512\ndata blocks changed\n` : `resize2fs 1.47.0\nThe filesystem on /dev/mapper/${lv.vg}-${lv.name} is now ${lv.sizeGb * 262144} (4k) blocks long.\n`);
    (lv as Lv & { fsSize?: number }).fsSize = o.flags.has('r') ? lv.sizeGb : (lv as Lv & { fsSize?: number }).fsSize ?? lv.sizeGb - add;
    return 0;
  }),
  resize2fs: (args, io, ctx) => growFs(args, io, ctx, 'ext4'),
  xfs_growfs: (args, io, ctx) => growFs(args, io, ctx, 'xfs'),
  lvs: (_a, io, ctx) => {
    const s = stOf(ctx.sys);
    io.out('  LV       VG     Attr       LSize   Origin\n');
    for (const l of s.lvs) io.out(`  ${l.name.padEnd(8)} ${l.vg.padEnd(6)} ${l.snapshotOf ? 'swi-a-s---' : '-wi-a-----'} ${(l.sizeGb + '.00g').padStart(7)} ${l.snapshotOf ?? ''}\n`);
    return 0;
  },
  lvremove: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const dev = args.find((a) => a.startsWith('/dev/'));
    const c = dev ? canonDev(s, dev) : null;
    const lv = c ? s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === c) : undefined;
    if (!lv) return fail(io, `  Logical volume ${dev ?? ''} not found.`);
    if (s.mounts.some((m) => m.dev === c)) return fail(io, `  Logical volume ${lv.vg}/${lv.name} contains a filesystem in use.`);
    s.lvs = s.lvs.filter((l) => l !== lv);
    io.out(`  Logical volume "${lv.name}" successfully removed.\n`);
    return 0;
  }),
  'mkfs.ext4': (args, io, ctx) => mkfs(args, io, ctx, 'ext4'),
  'mkfs.xfs': (args, io, ctx) => mkfs(args, io, ctx, 'xfs'),
  mkfs: (args, io, ctx) => {
    const o = parseOpts(args, ['t']);
    const t = o.values.t;
    if (t !== 'ext4' && t !== 'xfs') {
      io.err('mkfs: use -t ext4 or -t xfs\n');
      return 1;
    }
    return mkfs(o.rest, io, ctx, t);
  },
  mount: (args, io, ctx) => {
    const sys = ctx.sys;
    const o = parseOpts(args, ['o', 't']);
    const s = stOf(sys);
    if (!o.rest.length && !o.flags.has('a')) {
      FILE_COMMANDS.mount([], io, ctx);
      for (const m of s.mounts) io.out(`${m.dev.replace(/^\/dev\/([^/]+)\/(.+)$/, '/dev/mapper/$1-$2')} on ${m.dir} type ${m.fs} (${m.opts || 'rw,relatime'})\n`);
      return 0;
    }
    if (currentUser(ctx) !== 'root') {
      io.err('mount: only root can do that\n');
      return 1;
    }
    if (o.flags.has('a')) {
      let code = 0;
      for (const [i, raw] of lines(rd(sys, '/etc/fstab') ?? '').entries()) {
        const l = raw.replace(/#.*/, '').trim();
        if (!l) continue;
        const [dev, dir, type, opts = 'defaults'] = l.split(/\s+/);
        if (!dev || !dir || !type) {
          io.err(`mount: /etc/fstab: parse error at line ${i + 1} -- ignored\n`);
          code = 64;
          continue;
        }
        if (dir === '/' || dir === '/boot/efi' || dir === 'swap' || type === 'swap' || type === 'tmpfs' || s.mounts.some((m) => m.dir === dir)) continue;
        const r = doMount(sys, s, dev, dir, opts === 'defaults' ? 'rw,relatime' : opts, io);
        if (r && !/nofail/.test(opts)) code = r;
      }
      saveSt(sys, s);
      return code;
    }
    const [devRaw, dir] = o.rest;
    if (!dir) {
      const fromFstab = lines(rd(sys, '/etc/fstab') ?? '').map((l) => l.replace(/#.*/, '').trim().split(/\s+/)).find((p) => p[1] === abs(ctx, devRaw) || p[0] === devRaw);
      if (!fromFstab) {
        io.err(`mount: ${devRaw}: can't find in /etc/fstab.\n`);
        return 1;
      }
      const r = doMount(sys, s, fromFstab[0], fromFstab[1], fromFstab[3] ?? 'rw', io);
      saveSt(sys, s);
      return r;
    }
    const r = doMount(sys, s, devRaw, abs(ctx, dir), o.values.o ?? 'rw,relatime', io);
    saveSt(sys, s);
    return r;
  },
  umount: (args, io, ctx) => storageCmd(ctx, io, (s) => {
    const t = args.find((a) => !a.startsWith('-'));
    if (!t) return fail(io, 'umount: bad usage');
    const dir = t.startsWith('/dev/') ? s.mounts.find((m) => m.dev === canonDev(s, t))?.dir : abs(ctx, t);
    if (!dir || !s.mounts.some((m) => m.dir === dir)) return fail(io, `umount: ${t}: not mounted.`);
    if (ctx.sys.cwd === dir || ctx.sys.cwd.startsWith(dir + '/')) return fail(io, `umount: ${dir}: target is busy.`);
    s.mounts = s.mounts.filter((m) => m.dir !== dir);
    return 0;
  }),
  findmnt: (args, io, ctx) => {
    const s = stOf(ctx.sys);
    const want = args.find((a) => !a.startsWith('-'));
    const rows = [{ dir: '/', dev: '/dev/sda2', fs: 'ext4', opts: 'rw,relatime' }, ...s.mounts].filter((m) => !want || m.dir === want || m.dev === canonDev(s, want));
    if (!rows.length) return 1;
    io.out('TARGET          SOURCE                  FSTYPE OPTIONS\n');
    for (const m of rows) io.out(`${m.dir.padEnd(15)} ${m.dev.padEnd(23)} ${m.fs.padEnd(6)} ${m.opts}\n`);
    return 0;
  },
  df: (args, io, ctx) => {
    const s = stOf(ctx.sys);
    FILE_COMMANDS.df(args, io, ctx);
    for (const m of s.mounts) {
      const lv = s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === m.dev);
      const size = (lv as (Lv & { fsSize?: number }) | undefined)?.fsSize ?? lv?.sizeGb ?? sizeOfDisk(s, m.dev);
      const used = Math.max(0.1, Object.values(collectFiles(ctx.sys, m.dir)).reduce((a, c) => a + c.length, 0) / 1073741824);
      io.out(`${m.dev.replace(/^\/dev\/([^/]+)\/(.+)$/, '/dev/mapper/$1-$2').padEnd(16)}${(size + 'G').padStart(9)} ${(used.toFixed(1) + 'G').padStart(8)} ${((size - used).toFixed(1) + 'G').padStart(9)} ${String(Math.max(1, Math.round((used / size) * 100)) + '%').padStart(4)} ${m.dir}\n`);
    }
    return 0;
  },

  /* ---------------------------------------------------------- file services */
  exportfs: (args, io, ctx) => {
    const text = rd(ctx.sys, '/etc/exports') ?? '';
    const bad: string[] = [];
    const rows: string[] = [];
    for (const [i, raw] of lines(text).entries()) {
      const l = raw.replace(/#.*/, '').trim();
      if (!l) continue;
      const [dir, ...clients] = l.split(/\s+/);
      if (!lookup(ctx.sys.fs, dir, ROOT)) bad.push(`exportfs: Failed to stat ${dir}: No such file or directory`);
      for (const c of clients) {
        if (/\s/.test(c) || !/^[\w.*/-]+(\([\w,=]+\))?$|^\([\w,=]+\)$/.test(c)) bad.push(`exportfs: /etc/exports:${i + 1}: unknown keyword "${c}"`);
        const opts = /\(([^)]*)\)/.exec(c)?.[1] ?? 'ro,root_squash';
        rows.push(`${dir.padEnd(20)} ${c.replace(/\(.*/, '') || '<world>'}(${opts},sync,wdelay,hide)`);
      }
    }
    if (bad.length) {
      io.err(bad.join('\n') + '\n');
      return 1;
    }
    if (args.includes('-v') || !args.length) io.out(rows.join('\n') + (rows.length ? '\n' : ''));
    return 0;
  },
  showmount: (args, io, ctx) => {
    if (!args.includes('-e')) {
      io.err('Usage: showmount -e [host]\n');
      return 1;
    }
    if (!ctx.sys.services['nfs-server']?.active) {
      io.err('clnt_create: RPC: Program not registered\n');
      return 1;
    }
    io.out(`Export list for ${ctx.sys.hostname}:\n`);
    for (const l of lines(rd(ctx.sys, '/etc/exports') ?? '')) {
      const t = l.replace(/#.*/, '').trim().split(/\s+/);
      if (t[0]) io.out(`${t[0].padEnd(20)} ${t.slice(1).map((c) => c.replace(/\(.*/, '')).join(',')}\n`);
    }
    return 0;
  },
  testparm: (_a, io, ctx) => {
    const text = rd(ctx.sys, '/etc/samba/smb.conf');
    if (text === null) {
      io.err("Can't load /etc/samba/smb.conf - run testparm to debug it\n");
      return 1;
    }
    let section = '';
    const errs: string[] = [];
    const shares: string[] = [];
    for (const raw of lines(text)) {
      const l = raw.replace(/[#;].*/, '').trim();
      if (!l) continue;
      const sec = /^\[([^\]]+)\]$/.exec(l);
      if (sec) {
        section = sec[1];
        if (section !== 'global') shares.push(section);
        continue;
      }
      if (!/^[\w ]+=/.test(l)) errs.push(`Ignoring unknown parameter "${l}"`);
      const path = /^path\s*=\s*(\S+)/.exec(l)?.[1];
      if (path && !lookup(ctx.sys.fs, path, ROOT)) errs.push(`ERROR: [${section}] path "${path}" does not exist.`);
    }
    io.out(`Load smb config files from /etc/samba/smb.conf\n${errs.join('\n')}${errs.length ? '\n' : ''}Loaded services file OK.\n${shares.map((s) => `[${s}]`).join('\n')}\n`);
    return errs.some((e) => e.startsWith('ERROR')) ? 1 : 0;
  },
  'fail2ban-client': (args, io, ctx) => {
    const sys = ctx.sys;
    if (args[0] === '-t' || args[0] === '--test') {
      const p = fail2banProblems(sys);
      if (p.length) {
        io.err(p.map((x) => `ERROR   ${x}`).join('\n') + '\n');
        return 255;
      }
      io.out('OK: configuration test is successful\n');
      return 0;
    }
    if (!sys.services.fail2ban?.active) {
      io.err('ERROR   Failed to access socket path: /var/run/fail2ban/fail2ban.sock. Is fail2ban running?\n');
      return 255;
    }
    const jails = fail2banJails(sys);
    const [cmd, name, key, value] = args;
    if (cmd === 'ping') {
      io.out('Server replied: pong\n');
      return 0;
    }
    if (cmd === 'reload' || cmd === 'start') {
      io.out('OK\n');
      return 0;
    }
    if (cmd === 'status' && !name) {
      io.out(`Status\n|- Number of jail:\t${jails.length}\n\`- Jail list:\t${jails.map((j) => j.name).join(', ')}\n`);
      return 0;
    }
    const j = jails.find((x) => x.name === name);
    if (!j) {
      io.err(`Sorry but the jail '${name ?? ''}' does not exist\n`);
      return 255;
    }
    if (cmd === 'status') {
      const failed = Object.values(j.failures).reduce((a, b) => a + b, 0);
      io.out(`Status for the jail: ${j.name}\n|- Filter\n|  |- Currently failed:\t${Object.keys(j.failures).filter((ip) => !j.banned.includes(ip)).length}\n|  |- Total failed:\t${failed}\n|  \`- File list:\t${j.logs.join(' ')}\n\`- Actions\n   |- Currently banned:\t${j.banned.length}\n   |- Total banned:\t${j.banned.length}\n   \`- Banned IP list:\t${j.banned.join(' ')}\n`);
      return 0;
    }
    if (cmd === 'get') {
      const v = key === 'maxretry' ? String(j.maxretry) : key === 'bantime' ? j.bantime : key === 'findtime' ? j.findtime : key === 'ignoreip' ? `These IP addresses/networks are ignored:\n${j.ignoreip.map((x) => `\`- ${x}`).join('\n')}` : key === 'banned' ? JSON.stringify(j.banned) : null;
      if (v === null) {
        io.err(`Invalid command (no get action or not yet implemented)\n`);
        return 255;
      }
      io.out(v + '\n');
      return 0;
    }
    if (cmd === 'set' && (key === 'banip' || key === 'unbanip') && value) {
      const st = f2bState(sys);
      const rec = (st[j.name] ??= { banned: [], unbanned: [] });
      if (key === 'banip') {
        rec.banned = [...new Set([...rec.banned, value])];
        rec.unbanned = rec.unbanned.filter((x) => x !== value);
      } else {
        rec.unbanned = [...new Set([...rec.unbanned, value])];
        rec.banned = rec.banned.filter((x) => x !== value);
      }
      wr(sys, '/var/lib/fail2ban/lab-state.json', JSON.stringify(st));
      io.out('1\n');
      return 0;
    }
    io.err('Invalid command\n');
    return 255;
  },
};

/* ----------------------------------------------------------------------------- fail2ban */

const F2B_FILTERS: Record<string, { logs: string[]; re: RegExp }> = {
  sshd: { logs: ['/var/log/secure', '/var/log/auth.log', '/var/log/messages'], re: /Failed password for (?:invalid user )?\S+ from (\d+\.\d+\.\d+\.\d+)/ },
  'apache-auth': { logs: ['/var/log/apache2/error_log', '/var/log/apache2/error.log'], re: /\[client (\d+\.\d+\.\d+\.\d+)(?::\d+)?\].*(?:authentication failure|password mismatch|was not found)/ },
};

function f2bState(sys: ShellSystem): Record<string, { banned: string[]; unbanned: string[] }> {
  try {
    return JSON.parse(rd(sys, '/var/lib/fail2ban/lab-state.json') ?? '{}');
  } catch {
    return {};
  }
}

/** The INI sections of jail.local and jail.d/*.local (later files win), with [DEFAULT] values inherited. */
function f2bConfig(sys: ShellSystem): { sections: Map<string, Record<string, string>>; errors: string[] } {
  const files = ['/etc/fail2ban/jail.local', ...ls(sys, '/etc/fail2ban/jail.d').filter((x) => /\.(conf|local)$/.test(x.name)).map((x) => `/etc/fail2ban/jail.d/${x.name}`)];
  const sections = new Map<string, Record<string, string>>();
  const errors: string[] = [];
  for (const f of files) {
    const text = rd(sys, f);
    if (text === null) continue;
    let cur: Record<string, string> | null = null;
    let lastKey = '';
    for (const [i, raw] of text.split('\n').entries()) {
      if (/^\s*([#;]|$)/.test(raw)) continue;
      const sec = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
      if (sec) {
        cur = sections.get(sec[1]) ?? {};
        sections.set(sec[1], cur);
        continue;
      }
      const kv = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(raw.trim());
      if (/^\s/.test(raw) && cur && lastKey) cur[lastKey] += ' ' + raw.trim();
      else if (kv && cur) {
        lastKey = kv[1].toLowerCase();
        cur[lastKey] = kv[2].trim();
      } else errors.push(`Failed during configuration: Source contains parsing errors: '${f}'\n\t[line ${i + 1}]: '${raw}'`);
    }
  }
  return { sections, errors };
}

function f2bTime(v: string): string {
  const m = /^(\d+)\s*([smhdw]?)$/.exec(v.trim());
  if (!m) return v;
  return String(Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[m[2]]);
}

function fail2banProblems(sys: ShellSystem): string[] {
  const { sections, errors } = f2bConfig(sys);
  const out = [...errors];
  for (const [name, s] of sections) {
    if (name === 'DEFAULT' || !/^(true|yes|1)$/i.test(s.enabled ?? '')) continue;
    const filter = (s.filter ?? name).split(/[[\s]/)[0];
    if (!F2B_FILTERS[filter]) out.push(`Unable to read the filter '${filter}'\nErrors in jail '${name}'. Skipping...`);
    const d = sections.get('DEFAULT') ?? {};
    const mr = s.maxretry ?? d.maxretry;
    if (mr !== undefined && !/^\d+$/.test(mr)) out.push(`Jail '${name}': maxretry must be a number, not '${mr}'`);
  }
  return out;
}

function fail2banJails(sys: ShellSystem) {
  const { sections } = f2bConfig(sys);
  const d = sections.get('DEFAULT') ?? {};
  const st = f2bState(sys);
  const jails = [];
  for (const [name, s] of sections) {
    if (name === 'DEFAULT' || !/^(true|yes|1)$/i.test(s.enabled ?? d.enabled ?? '')) continue;
    const filter = F2B_FILTERS[(s.filter ?? name).split(/[[\s]/)[0]];
    if (!filter) continue;
    const maxretry = Number(s.maxretry ?? d.maxretry ?? 5);
    const ignoreip = (s.ignoreip ?? d.ignoreip ?? '127.0.0.1/8 ::1').split(/[\s,]+/).filter(Boolean);
    const logs = s.logpath ? s.logpath.split(/\s+/) : filter.logs;
    const failures: Record<string, number> = {};
    const text = [...logs.map((l) => rd(sys, l) ?? ''), ...(name === 'sshd' ? sys.services.sshd?.logs ?? [] : [])].join('\n');
    for (const l of text.split('\n')) {
      const ip = filter.re.exec(l)?.[1];
      if (ip && !ignoreip.some((c) => c === ip || inCidr(ip, c))) failures[ip] = (failures[ip] ?? 0) + 1;
    }
    const rec = st[name] ?? { banned: [], unbanned: [] };
    const banned = [...new Set([...Object.entries(failures).filter(([, n]) => n >= maxretry).map(([ip]) => ip), ...rec.banned])].filter((ip) => !rec.unbanned.includes(ip));
    jails.push({ name, maxretry, bantime: f2bTime(s.bantime ?? d.bantime ?? '600'), findtime: f2bTime(s.findtime ?? d.findtime ?? '600'), ignoreip, logs, failures, banned });
  }
  return jails;
}

function fail(io: IO, msg: string): number {
  io.err(msg + '\n');
  return 5;
}

function storageCmd(ctx: Ctx, io: IO, f: (s: Storage) => number): number {
  if (currentUser(ctx) !== 'root') {
    io.err('  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/P_global:aux: open failed: Permission denied\n');
    return 5;
  }
  const s = stOf(ctx.sys);
  const r = f(s);
  if (r === 0) saveSt(ctx.sys, s);
  return r;
}

function mkfs(args: string[], io: IO, ctx: Ctx, type: 'ext4' | 'xfs'): number {
  return storageCmd(ctx, io, (s) => {
    const dev = args.find((a) => a.startsWith('/dev/'));
    const c = dev ? canonDev(s, dev) : null;
    if (!c) return fail(io, `mkfs.${type}: The file ${dev ?? ''} does not exist and no size was specified.`);
    if (s.mounts.some((m) => m.dev === c)) return fail(io, `mkfs.${type}: ${dev} contains a mounted filesystem`);
    if (s.pvs.some((p) => p.dev === c)) return fail(io, `mkfs.${type}: ${dev} is apparently in use by the system (it is an LVM physical volume); will not make a filesystem here!`);
    const lv = s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === c);
    if (lv) {
      lv.fs = type;
      lv.files = {};
    } else s.disks.find((d) => `/dev/${d.name}` === c)!.fs = type;
    io.out(type === 'xfs' ? `meta-data=${dev}              isize=512    agcount=4\ndata     =                       bsize=4096\n` : `mke2fs 1.47.0 (5-Feb-2023)\nCreating filesystem with 4k blocks\nFilesystem UUID: ${uuidOf(c)}\nWriting superblocks and filesystem accounting information: done\n`);
    return 0;
  });
}

function growFs(args: string[], io: IO, ctx: Ctx, type: 'ext4' | 'xfs'): number {
  return storageCmd(ctx, io, (s) => {
    const t = args.find((a) => !a.startsWith('-'));
    const dev = t ? (t.startsWith('/dev/') ? canonDev(s, t) : s.mounts.find((m) => m.dir === t)?.dev ?? null) : null;
    const lv = dev ? s.lvs.find((l) => `/dev/${l.vg}/${l.name}` === dev) : undefined;
    if (!lv || lv.fs !== type) return fail(io, `${type === 'xfs' ? 'xfs_growfs' : 'resize2fs'}: ${t ?? ''} is not a mounted ${type} filesystem`);
    if (type === 'xfs' && !s.mounts.some((m) => m.dev === dev)) return fail(io, `xfs_growfs: ${t} is not a mounted XFS filesystem`);
    (lv as Lv & { fsSize?: number }).fsSize = lv.sizeGb;
    io.out(`The filesystem on ${dev} is now ${lv.sizeGb * 262144} (4k) blocks long.\n`);
    return 0;
  });
}

/** htpasswd "hash" for the simulator: not cryptographic, only distinguishes passwords. */
function htHash(pw: string): string {
  let h = 5381;
  for (const c of pw) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return `$apr1$sim$${h.toString(36)}`;
}

export { inCidr };
