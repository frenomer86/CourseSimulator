/**
 * The simulated machine: file system, users and groups, services, packages, processes,
 * crontabs and the shell session (who is logged in, where, and what they have typed).
 */

import { getUmask, mkdirNode, mkfileNode, lookup, type AclEntry, type Actor, type DirNode, type FsNode } from './fs.js';

export interface UserRec {
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups: string[];
  comment?: string;
  /** 'set' means a password exists; 'locked' means the account is locked; 'none' means no password yet. */
  password: 'set' | 'locked' | 'none';
  lastChanged?: number;
  maxDays?: number;
  minDays?: number;
  warnDays?: number;
  /** Days after the password expires before the account is disabled. */
  inactiveDays?: number;
  /** When the account expires (ms since epoch); undefined means never. */
  expireDate?: number;
}
export interface GroupRec {
  gid: number;
  members: string[];
}
export interface ServiceFault {
  /** The fault is present while this file (optional) matches the pattern, or while `missing` does not exist. */
  file?: string;
  pattern?: string;
  missing?: string;
  message: string;
}
export interface ServiceRec {
  description: string;
  active: boolean;
  enabled: boolean;
  faults?: ServiceFault[];
  logs: string[];
  /** Package that must be installed for the unit to exist. */
  package?: string;
  port?: number;
}
export interface PackageRec {
  version: string;
  description: string;
  installed: boolean;
  /** Commands this package provides. */
  provides?: string[];
  /** Service unit it installs. */
  service?: string;
  /** A newer version the repositories offer (upgrade installs it unless the package is held). */
  available?: string;
}
export interface ProcRec {
  pid: number;
  user: string;
  cmd: string;
  cpu: number;
  mem: number;
}

export interface ShellSystem {
  hostname: string;
  fs: DirNode;
  users: Record<string, UserRec>;
  groups: Record<string, GroupRec>;
  services: Record<string, ServiceRec>;
  packages: Record<string, PackageRec>;
  processes: ProcRec[];
  crontabs: Record<string, string>;
  sudoers: string[];
  env: Record<string, string>;
  cwd: string;
  user: string;
  /** Users we have switched from with su/sudo -i, so exit can return. */
  userStack: Array<{ user: string; cwd: string }>;
  history: string[];
  nextPid: number;
  /** Simulated clock, ms since epoch. */
  now: number;
  umask: number;
  /** Lab-defined network view for ip/ping/ssh. */
  network?: { address: string; gateway?: string; hosts?: Record<string, string> };
  /** 'windows' routes typed lines to the PowerShell subset (powershell.ts). */
  os?: 'linux' | 'windows';
}

/** acl entries look like "u:name:r-x", "g:name:rwx" or "d:g:name:rwx" (a default entry on a directory); ageDays backdates the modification time. */
export type FileSpec = string | null | { content?: string; mode?: number | string; owner?: string; group?: string; link?: string; acl?: string[]; ageDays?: number };

function parseAclSpec(entries: string[] | undefined): AclEntry[] | undefined {
  if (!entries?.length) return undefined;
  return entries.map((e) => {
    const def = /^(d|default):/.test(e);
    const [k, name, perms] = e.replace(/^(d|default):/, '').split(':');
    return { kind: k.startsWith('u') ? 'user' : 'group', name, perms, ...(def ? { def: true } : {}) } as AclEntry;
  });
}

/** What a lab's initialState.system may contain. Everything is optional except user. */
export interface SystemSpec {
  hostname?: string;
  user: string;
  cwd?: string;
  files?: Record<string, FileSpec>;
  users?: Record<string, Partial<UserRec> & { sudo?: boolean }>;
  groups?: Record<string, string[]>;
  services?: Record<string, Partial<ServiceRec>>;
  packages?: Record<string, Partial<PackageRec>>;
  processes?: Array<Partial<ProcRec> & { cmd: string }>;
  crontabs?: Record<string, string>;
  now?: string;
  network?: ShellSystem['network'];
  os?: ShellSystem['os'];
}

export const BASE_TIME = Date.UTC(2026, 9, 22, 9, 30, 0);

const CATALOGUE: Record<string, PackageRec> = {
  bash: { version: '5.2', description: 'GNU Bourne-Again Shell', installed: true },
  coreutils: { version: '9.5', description: 'GNU core utilities', installed: true },
  nano: { version: '7.2', description: 'Small, friendly text editor', installed: true, provides: ['nano'] },
  vim: { version: '9.1', description: 'Vi IMproved text editor', installed: true, provides: ['vim', 'vi'] },
  tree: { version: '2.1', description: 'Displays directories as trees', installed: false, provides: ['tree'] },
  htop: { version: '3.3', description: 'Interactive process viewer', installed: false, provides: ['htop'] },
  rsync: { version: '3.3', description: 'Fast, versatile file copying tool', installed: false, provides: ['rsync'] },
  git: { version: '2.45', description: 'Distributed version control', installed: false, provides: ['git'] },
  docker: { version: '27.3', description: 'Container engine and command-line client', installed: false, service: 'docker', provides: ['docker'] },
  curl: { version: '8.8', description: 'Command line tool for transferring data', installed: true, provides: ['curl'] },
  apache2: { version: '2.4.59', description: 'Apache HTTP Server', installed: false, provides: ['apachectl'], service: 'apache2' },
  nginx: { version: '1.26', description: 'High performance web server', installed: false, service: 'nginx' },
  bind: { version: '9.18', description: 'BIND DNS server', installed: false, provides: ['named-checkzone', 'named-checkconf'], service: 'named' },
  fail2ban: { version: '1.1', description: 'Bans hosts that cause repeated authentication errors', installed: false, service: 'fail2ban', provides: ['fail2ban-client'] },
  firewalld: { version: '2.1', description: 'Dynamically managed firewall', installed: true, service: 'firewalld', provides: ['firewall-cmd'] },
  openssh: { version: '9.8', description: 'Secure shell client and server', installed: true, service: 'sshd', provides: ['ssh', 'ssh-keygen', 'scp'] },
  cronie: { version: '1.7', description: 'Cron daemon', installed: true, service: 'cron', provides: ['crontab'] },
  restic: { version: '0.17', description: 'Fast, secure backup program', installed: false, provides: ['restic'] },
  shellcheck: { version: '0.10', description: 'Shell script analysis tool', installed: false, provides: ['shellcheck'] },
  zip: { version: '3.0', description: 'Archiver for .zip files', installed: false, provides: ['zip', 'unzip'] },
  jq: { version: '1.7.1', description: 'Command-line JSON processor', installed: false, provides: ['jq'] },
  bats: { version: '1.11', description: 'Bash Automated Testing System', installed: false, provides: ['bats'] },
  mailx: { version: '12.5', description: 'Mail user agent (mail, mailx)', installed: false, provides: ['mail', 'mailx'] },
  quota: { version: '4.09', description: 'Disk quota tools', installed: false, provides: ['setquota', 'quota', 'repquota', 'edquota'] },
  pwgen: { version: '2.08', description: 'Password generator', installed: false, provides: ['pwgen'] },
  dos2unix: { version: '7.5', description: 'Line ending converters', installed: false, provides: ['dos2unix', 'unix2dos'] },
  logrotate: { version: '3.21', description: 'Rotates, compresses and mails system logs', installed: true, provides: ['logrotate'] },
  openssl: { version: '3.1', description: 'Secure Sockets Layer toolkit', installed: true, provides: ['openssl'] },
  python3: { version: '3.12', description: 'Python interpreter', installed: true, provides: ['python3'] },
  php8: { version: '8.3', description: 'PHP scripting language', installed: false },
  mariadb: { version: '11.4', description: 'MariaDB database server', installed: false, service: 'mariadb', provides: ['mysql'] },
  sudo: { version: '1.9', description: 'Execute commands as another user', installed: true, provides: ['sudo'] },
};

export const DEFAULT_PORTS: Record<string, number> = { apache2: 80, nginx: 80, named: 53, mariadb: 3306, sshd: 22, postgresql: 5432, vsftpd: 21, smb: 445, nfs: 2049 };

function toMode(m: number | string | undefined, dflt: number): number {
  if (m === undefined) return dflt;
  return typeof m === 'number' ? m : parseInt(m, 8);
}

export function parseFileMode(mode: number | string | undefined, dflt: number): number {
  return toMode(mode, dflt);
}

export function buildSystem(spec: SystemSpec): ShellSystem {
  const now = spec.now ? Date.parse(spec.now) : BASE_TIME;
  const root = mkdirNode('root', 'root', 0o755, now);
  const sys: ShellSystem = {
    ...(spec.os ? { os: spec.os } : {}),
    hostname: spec.hostname ?? 'lab',
    fs: root,
    users: {},
    groups: {},
    services: {},
    packages: {},
    processes: [],
    crontabs: { ...(spec.crontabs ?? {}) },
    sudoers: ['root'],
    env: {},
    cwd: '/',
    user: spec.user,
    userStack: [],
    history: [],
    nextPid: 1200,
    now,
    umask: 0o022,
    network: spec.network,
  };
  const rootActor: Actor = { user: 'root', groups: ['root'] };
  const base = ['/bin', '/boot', '/dev', '/etc', '/etc/cron.d', '/etc/cron.daily', '/etc/default', '/etc/logrotate.d', '/etc/profile.d', '/etc/security', '/etc/sysctl.d', '/etc/skel', '/etc/sudoers.d', '/home', '/lib', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/usr/bin', '/usr/local', '/usr/local/bin', '/usr/local/sbin', '/usr/sbin', '/usr/lib', '/usr/lib/systemd/system', '/etc/systemd/system', '/var/lib', '/usr/share', '/usr/share/man', '/var', '/var/log', '/var/spool', '/var/spool/cron', '/var/tmp', '/var/www', '/var/backups'];
  for (const d of base) ensureDir(sys, d, rootActor);
  dirAt(sys, '/root').mode = 0o700;
  dirAt(sys, '/tmp').mode = 0o1777;
  dirAt(sys, '/var/tmp').mode = 0o1777;

  // Groups and users.
  sys.groups.root = { gid: 0, members: [] };
  sys.groups.wheel = { gid: 10, members: [] };
  sys.groups.sudo = { gid: 27, members: [] };
  sys.groups.users = { gid: 100, members: [] };
  sys.groups.adm = { gid: 4, members: [] };
  for (const [g, members] of Object.entries(spec.groups ?? {})) sys.groups[g] = { gid: sys.groups[g]?.gid ?? nextGid(sys), members: [...members] };
  sys.users.root = { uid: 0, gid: 0, home: '/root', shell: '/bin/bash', groups: ['root'], password: 'set', comment: 'root', lastChanged: now };
  const specUsers = { ...(spec.users ?? {}) };
  if (!specUsers[spec.user] && spec.user !== 'root') specUsers[spec.user] = {};
  let uid = 1000;
  for (const [name, u] of Object.entries(specUsers)) {
    if (name === 'root') continue;
    const myUid = u.uid ?? uid++;
    if (!sys.groups[name]) sys.groups[name] = { gid: myUid, members: [] };
    const home = u.home ?? `/home/${name}`;
    sys.users[name] = {
      uid: myUid,
      gid: u.gid ?? sys.groups[name].gid,
      home,
      shell: u.shell ?? '/bin/bash',
      groups: [name, ...(u.groups ?? [])],
      comment: u.comment ?? name,
      password: u.password ?? 'set',
      lastChanged: now - 30 * 86400000,
      maxDays: u.maxDays,
    };
    for (const g of u.groups ?? []) {
      if (!sys.groups[g]) sys.groups[g] = { gid: nextGid(sys), members: [] };
      if (!sys.groups[g].members.includes(name)) sys.groups[g].members.push(name);
    }
    if (u.sudo) {
      sys.groups.wheel.members.push(name);
      if (!sys.users[name].groups.includes('wheel')) sys.users[name].groups.push('wheel');
    }
    ensureDir(sys, home, rootActor);
    const h = dirAt(sys, home);
    h.owner = name;
    h.group = groupName(sys, sys.users[name].gid);
    h.mode = 0o755;
  }
  for (const [g, rec] of Object.entries(sys.groups)) for (const m of rec.members) if (sys.users[m] && !sys.users[m].groups.includes(g)) sys.users[m].groups.push(g);

  // Packages and services.
  for (const [name, p] of Object.entries(CATALOGUE)) sys.packages[name] = { ...p, provides: p.provides ? [...p.provides] : undefined };
  for (const [name, p] of Object.entries(spec.packages ?? {})) sys.packages[name] = { ...(sys.packages[name] ?? { version: '1.0', description: name, installed: false }), ...p };
  const baseServices: Record<string, ServiceRec> = {
    sshd: { description: 'OpenSSH Daemon', active: true, enabled: true, logs: ['Server listening on 0.0.0.0 port 22.'], port: 22 },
    cron: { description: 'Command Scheduler', active: true, enabled: true, logs: ['(CRON) STARTUP (1.7.0)'] },
    firewalld: { description: 'firewalld - dynamic firewall daemon', active: true, enabled: true, logs: [] },
    systemd_journald: { description: 'Journal Service', active: true, enabled: true, logs: [] },
  };
  for (const [n, s] of Object.entries(baseServices)) sys.services[n] = s;
  for (const [name, s] of Object.entries(spec.services ?? {})) {
    const base: ServiceRec = sys.services[name] ?? { description: name, active: false, enabled: false, logs: [], port: DEFAULT_PORTS[name] };
    sys.services[name] = { ...base, ...s, logs: [...(s.logs ?? base.logs)] };
  }

  // Processes.
  sys.processes = [
    { pid: 1, user: 'root', cmd: '/usr/lib/systemd/systemd', cpu: 0, mem: 0.2 },
    { pid: 412, user: 'root', cmd: '/usr/sbin/sshd -D', cpu: 0, mem: 0.1 },
    { pid: 420, user: 'root', cmd: '/usr/sbin/cron -n', cpu: 0, mem: 0.1 },
    { pid: 1101, user: spec.user, cmd: '-bash', cpu: 0, mem: 0.1 },
  ];
  for (const p of spec.processes ?? []) sys.processes.push({ pid: p.pid ?? sys.nextPid++, user: p.user ?? 'root', cmd: p.cmd, cpu: p.cpu ?? 0, mem: p.mem ?? 0.1 });

  // Files from the spec, then the generated /etc files.
  writeSpecFiles(sys, spec.files ?? {}, rootActor);
  if (!lookup(root, '/etc/os-release', rootActor)) putFile(sys, '/etc/os-release', 'NAME="openSUSE Leap"\nVERSION="15.6"\nID=opensuse-leap\nPRETTY_NAME="openSUSE Leap 15.6"\n', rootActor);
  if (!lookup(root, '/etc/hostname', rootActor)) putFile(sys, '/etc/hostname', sys.hostname + '\n', rootActor);
  if (!lookup(root, '/etc/logrotate.conf', rootActor)) putFile(sys, '/etc/logrotate.conf', '# see "man logrotate" for details\n# rotate log files weekly\nweekly\n\n# keep 4 weeks worth of backlogs\nrotate 4\n\n# create new (empty) log files after rotating old ones\ncreate\n\n# use date as a suffix of the rotated file\ndateext\n\n# packages drop log rotation information into this directory\ninclude /etc/logrotate.d\n', rootActor, 0o644);
  if (!lookup(root, '/etc/ssh/sshd_config', rootActor)) putFile(sys, '/etc/ssh/sshd_config', '# OpenSSH server configuration. Commented options show the defaults.\n#Port 22\n#PermitRootLogin prohibit-password\n#PasswordAuthentication yes\n#PubkeyAuthentication yes\n#MaxAuthTries 6\nUsePAM yes\nX11Forwarding no\nSubsystem sftp /usr/lib/ssh/sftp-server\n', rootActor, 0o600);
  if (!lookup(root, '/etc/sudoers', rootActor)) putFile(sys, '/etc/sudoers', '## sudoers file.\nroot ALL=(ALL:ALL) ALL\n%wheel ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n', rootActor, 0o440);
  for (const name of ['messages', 'auth.log', 'syslog']) if (!lookup(root, `/var/log/${name}`, rootActor)) putFile(sys, `/var/log/${name}`, '', rootActor, 0o640, 'root', 'adm');
  syncEtc(sys);
  sys.cwd = spec.cwd ?? sys.users[spec.user]?.home ?? '/';
  sys.env = { HOME: sys.users[spec.user]?.home ?? '/', USER: spec.user, LOGNAME: spec.user, SHELL: '/bin/bash', PATH: spec.user === 'root' ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : '/usr/local/bin:/usr/bin:/bin', PWD: sys.cwd, HOSTNAME: sys.hostname, LANG: 'en_GB.UTF-8', TERM: 'xterm-256color' };
  return sys;
}

function nextGid(sys: ShellSystem): number {
  const used = new Set(Object.values(sys.groups).map((g) => g.gid));
  let g = 1000;
  while (used.has(g)) g++;
  return g;
}

export function nextUid(sys: ShellSystem): number {
  const used = new Set(Object.values(sys.users).map((u) => u.uid));
  let u = 1000;
  while (used.has(u)) u++;
  return u;
}

export function allocGid(sys: ShellSystem): number {
  return nextGid(sys);
}

export function groupName(sys: ShellSystem, gid: number): string {
  return Object.entries(sys.groups).find(([, g]) => g.gid === gid)?.[0] ?? String(gid);
}

function ensureDir(sys: ShellSystem, path: string, actor: Actor): void {
  const parts = path.slice(1).split('/');
  let cur = sys.fs;
  for (const p of parts) {
    if (!cur.children[p]) cur.children[p] = mkdirNode(actor.user, actor.groups[0], 0o755, sys.now);
    const n = cur.children[p];
    if (n.type !== 'dir') throw new Error(`${path}: not a directory`);
    cur = n;
  }
}

function dirAt(sys: ShellSystem, path: string): DirNode {
  const l = lookup(sys.fs, path, { user: 'root', groups: ['root'] });
  if (!l || l.node.type !== 'dir') throw new Error(`${path}: not a directory`);
  return l.node;
}

function putFile(sys: ShellSystem, path: string, content: string, actor: Actor, mode = 0o644, owner = actor.user, group = actor.groups[0]): void {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  ensureDir(sys, dir, actor);
  dirAt(sys, dir).children[path.slice(path.lastIndexOf('/') + 1)] = mkfileNode(content, owner, group, mode, sys.now);
}

function writeSpecFiles(sys: ShellSystem, files: Record<string, FileSpec>, actor: Actor): void {
  for (const [rawPath, spec] of Object.entries(files)) {
    const isDir = rawPath.endsWith('/') || spec === null;
    const path = rawPath.replace(/\/+$/, '') || '/';
    // Default ownership: the user whose home the file is under, else root.
    const homeOwner = Object.entries(sys.users).find(([, u]) => path === u.home || path.startsWith(u.home + '/'))?.[0];
    const owner = typeof spec === 'object' && spec?.owner ? spec.owner : homeOwner ?? 'root';
    const group = typeof spec === 'object' && spec?.group ? spec.group : sys.users[owner] ? groupName(sys, sys.users[owner].gid) : 'root';
    if (isDir) {
      ensureDir(sys, path, actor);
      const d = dirAt(sys, path);
      d.owner = owner;
      d.group = group;
      d.mode = toMode(typeof spec === 'object' && spec ? spec.mode : undefined, 0o755);
      const dAcl = parseAclSpec(typeof spec === 'object' && spec ? spec.acl : undefined);
      if (dAcl) d.acl = dAcl;
      continue;
    }
    if (typeof spec === 'object' && spec?.link) {
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      ensureDir(sys, dir, actor);
      dirAt(sys, dir).children[path.slice(path.lastIndexOf('/') + 1)] = { type: 'link', target: spec.link, mode: 0o777, owner, group, mtime: sys.now };
      continue;
    }
    const content = typeof spec === 'string' ? spec : spec?.content ?? '';
    putFile(sys, path, content, actor, toMode(typeof spec === 'object' && spec ? spec.mode : undefined, 0o644), owner, group);
    const fAcl = parseAclSpec(typeof spec === 'object' && spec ? spec.acl : undefined);
    if (fAcl) lookup(sys.fs, path, actor)!.node.acl = fAcl;
    if (typeof spec === 'object' && spec?.ageDays) lookup(sys.fs, path, actor)!.node.mtime = sys.now - spec.ageDays * 86400000;
    // Parent dirs created on the way get sensible owners when inside a home.
    if (homeOwner) {
      let p = path;
      while (p.includes('/') && p !== sys.users[homeOwner].home) {
        p = p.slice(0, p.lastIndexOf('/')) || '/';
        if (p === sys.users[homeOwner].home) break;
        const d = dirAt(sys, p);
        if (d.owner === 'root' && p.startsWith(sys.users[homeOwner].home)) {
          d.owner = homeOwner;
          d.group = groupName(sys, sys.users[homeOwner].gid);
        }
      }
    }
  }
}

/** Regenerates /etc/passwd, /etc/group and /etc/shadow from the user and group tables. */
export function syncEtc(sys: ShellSystem): void {
  const rootActor: Actor = { user: 'root', groups: ['root'] };
  const passwd = Object.entries(sys.users)
    .sort((a, b) => a[1].uid - b[1].uid)
    .map(([n, u]) => `${n}:x:${u.uid}:${u.gid}:${u.comment ?? n}:${u.home}:${u.shell}`)
    .join('\n');
  const group = Object.entries(sys.groups)
    .sort((a, b) => a[1].gid - b[1].gid)
    .map(([n, g]) => `${n}:x:${g.gid}:${g.members.join(',')}`)
    .join('\n');
  const shadow = Object.entries(sys.users)
    .sort((a, b) => a[1].uid - b[1].uid)
    .map(([n, u]) => `${n}:${u.password === 'none' ? '' : u.password === 'locked' ? '!$6$locked' : '$6$rounds=5000$salt$hash'}:${Math.floor((u.lastChanged ?? sys.now) / 86400000)}:${u.minDays ?? 0}:${u.maxDays ?? 99999}:${u.warnDays ?? 7}:${u.inactiveDays ?? ''}:${u.expireDate !== undefined ? Math.floor(u.expireDate / 86400000) : ''}:`)
    .join('\n');
  putFile(sys, '/etc/passwd', passwd + '\n', rootActor, 0o644);
  putFile(sys, '/etc/group', group + '\n', rootActor, 0o644);
  putFile(sys, '/etc/shadow', shadow + '\n', rootActor, 0o640, 'root', 'shadow');
  if (!sys.groups.shadow) sys.groups.shadow = { gid: 15, members: [] };
}

export function actorFor(sys: ShellSystem, user = sys.user): Actor {
  const u = sys.users[user];
  return { user, groups: u ? [groupName(sys, u.gid), ...u.groups.filter((g) => g !== groupName(sys, u.gid))] : [user] };
}

export function homeOf(sys: ShellSystem, user = sys.user): string {
  return sys.users[user]?.home ?? '/';
}

export function isSudoer(sys: ShellSystem, user: string): boolean {
  if (user === 'root') return true;
  const u = sys.users[user];
  if (!u) return false;
  if (sys.sudoers.includes(user)) return true;
  return u.groups.includes('wheel') || u.groups.includes('sudo') || (sys.groups.wheel?.members.includes(user) ?? false) || (sys.groups.sudo?.members.includes(user) ?? false);
}

export function commandAvailable(sys: ShellSystem, name: string): { ok: true } | { ok: false; package?: string } {
  for (const [pkg, p] of Object.entries(sys.packages)) {
    if (p.provides?.includes(name)) return p.installed ? { ok: true } : { ok: false, package: pkg };
  }
  return { ok: true };
}

export function serviceFaults(sys: ShellSystem, name: string): string[] {
  const s = sys.services[name];
  if (!s?.faults) return [];
  const rootActor: Actor = { user: 'root', groups: ['root'] };
  const out: string[] = [];
  for (const f of s.faults) {
    if (f.missing) {
      if (!lookup(sys.fs, f.missing, rootActor)) out.push(f.message);
      continue;
    }
    if (f.file && f.pattern) {
      const l = lookup(sys.fs, f.file, rootActor);
      if (!l) {
        out.push(f.message);
        continue;
      }
      if (l.node.type === 'file' && new RegExp(f.pattern, 'm').test(l.node.content)) out.push(f.message);
    }
  }
  return out;
}

export function fileAt(sys: ShellSystem, path: string): FsNode | null {
  try {
    return lookup(sys.fs, path, { user: 'root', groups: ['root'] })?.node ?? null;
  } catch {
    return null;
  }
}

export { getUmask };
