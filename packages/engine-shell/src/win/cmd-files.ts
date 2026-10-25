/**
 * File and print services: SMB shares and share permissions, NTFS permissions (icacls, Get-Acl),
 * effective access, FSRM quotas and file screens, DFS namespaces and replication, shadow copies
 * and previous versions, and print servers (drivers, ports, printers, queues, client connections).
 */

import { listDir, lookup, mkdir, readFile, remove, writeFile } from '../fs.js';
import { asList, bool, machine, machineByName, normWin, register, registerNative, str, toVfs, toVfsOn, toWin, UNC_RESOLVERS, type Cx, type Env, type Obj, type Value } from './core.js';
import { findGroup, findUser, groupsOf } from './cmd-ad.js';
import { readWinFile, requireFeature } from './cmd-basic.js';
import { driveRoot, type Ace, type Machine, type Printer, type SmbShareRec } from './model.js';

const ROOT = { user: 'root', groups: ['root'] };

/* ----------------------------------------------------------------------------- rights */

export const RIGHT_ORDER = ['ListDirectory', 'Read', 'ReadAndExecute', 'Write', 'Modify', 'FullControl'] as const;
export type Right = Ace['rights'];
const LETTER: Record<string, Right> = { F: 'FullControl', M: 'Modify', RX: 'ReadAndExecute', R: 'Read', W: 'Write', L: 'ListDirectory' };
const SHORT: Record<Right, string> = { FullControl: 'F', Modify: 'M', ReadAndExecute: 'RX', Read: 'R', Write: 'W', ListDirectory: 'L' };

/** Rights a level includes. */
function includes(r: Right): Right[] {
  switch (r) {
    case 'FullControl':
      return ['FullControl', 'Modify', 'Write', 'ReadAndExecute', 'Read', 'ListDirectory'];
    case 'Modify':
      return ['Modify', 'Write', 'ReadAndExecute', 'Read', 'ListDirectory'];
    case 'ReadAndExecute':
      return ['ReadAndExecute', 'Read', 'ListDirectory'];
    case 'Read':
      return ['Read', 'ListDirectory'];
    case 'Write':
      return ['Write'];
    case 'ListDirectory':
      return ['ListDirectory'];
  }
}
/** The highest single level contained in a set of rights. */
function levelOf(set: Set<Right>): Right | 'None' {
  for (const r of ['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write', 'ListDirectory'] as Right[]) if (includes(r).every((x) => set.has(x))) return r;
  return 'None';
}

/** Accounts a user acts as: themself, their groups (nested) and the well-known identities. */
export function identitiesOf(env: Env, sam: string): string[] {
  const st = env.st;
  const u = findUser(st, sam);
  const names = new Set(['everyone', 'authenticated users', 'users']);
  if (u) {
    names.add(u.sam.toLowerCase());
    for (const g of groupsOf(st, u.dn)) names.add(g.name.toLowerCase());
    if (names.has('domain admins')) names.add('administrators');
  } else names.add(sam.toLowerCase());
  return [...names];
}

const acctName = (a: string) => a.replace(/^[^\\]+\\/, '').replace(/^BUILTIN\\/i, '').toLowerCase();

/** The ACL of a folder or file, following inheritance up to the drive root. */
export function aclOf(m: Machine, winPath: string): Ace[] {
  const path = normWin(winPath);
  const own = m.ntfs[path];
  const parent = path.includes('\\') && !/^[A-Z]:$/i.test(path) ? path.slice(0, path.lastIndexOf('\\')) : null;
  const inherited = !own || own.inherit ? (parent && parent.length >= 2 ? aclOf(m, /^[A-Z]:$/i.test(parent) ? parent : parent) : rootAcl(path)) : [];
  return [...(own?.aces ?? []), ...inherited.map((a) => ({ ...a, inherited: true }))];
}

function rootAcl(path: string): Ace[] {
  const drive = path.slice(0, 2).toUpperCase();
  return [
    { account: 'BUILTIN\\Administrators', rights: 'FullControl', type: 'Allow' },
    { account: 'NT AUTHORITY\\SYSTEM', rights: 'FullControl', type: 'Allow' },
    { account: 'CREATOR OWNER', rights: 'FullControl', type: 'Allow' },
    { account: 'BUILTIN\\Users', rights: drive === 'C:' ? 'ReadAndExecute' : 'ReadAndExecute', type: 'Allow' },
  ];
}

export function ntfsAccess(env: Env, m: Machine, winPath: string, sam: string): Right | 'None' {
  const ids = new Set(identitiesOf(env, sam));
  const allowed = new Set<Right>();
  const denied = new Set<Right>();
  for (const ace of aclOf(m, winPath)) {
    if (!ids.has(acctName(ace.account))) continue;
    for (const r of includes(ace.rights)) (ace.type === 'Allow' ? allowed : denied).add(r);
  }
  for (const r of denied) allowed.delete(r);
  return levelOf(allowed);
}

export function shareAccess(env: Env, share: SmbShareRec, sam: string): Right | 'None' {
  const ids = new Set(identitiesOf(env, sam));
  const rights = new Set<Right>();
  for (const a of share.access) if (ids.has(acctName(a.account))) for (const r of includes(a.right === 'Full' ? 'FullControl' : a.right === 'Change' ? 'Modify' : 'ReadAndExecute')) rights.add(r);
  return levelOf(rights);
}

/** Effective access over the network: the more restrictive of the share and NTFS permissions. */
export function effectiveAccess(env: Env, uncOrPath: string, sam: string): Right | 'None' {
  const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/.exec(uncOrPath);
  if (!unc) return ntfsAccess(env, machine(env), uncOrPath, sam);
  const m = machineByName(env, unc[1]);
  const share = m?.shares.find((s) => s.name.toLowerCase() === unc[2].toLowerCase());
  if (!m || !share) return 'None';
  const s = shareAccess(env, share, sam);
  const n = ntfsAccess(env, m, share.path + (unc[3] ?? ''), sam);
  if (s === 'None' || n === 'None') return 'None';
  const common = new Set(includes(s as Right).filter((r) => includes(n as Right).includes(r)));
  return levelOf(common);
}

/* ----------------------------------------------------------------------------- FSRM */

export const FILE_GROUPS: Record<string, string[]> = {
  'Audio and Video Files': ['*.mp3', '*.mp4', '*.avi', '*.wav', '*.wma', '*.wmv', '*.mkv', '*.mov', '*.flac'],
  'Executable Files': ['*.exe', '*.bat', '*.cmd', '*.ps1', '*.msi', '*.com', '*.vbs', '*.scr'],
  'Image Files': ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp', '*.tif'],
  'Compressed Files': ['*.zip', '*.rar', '*.7z', '*.cab', '*.gz'],
  'Office Files': ['*.docx', '*.xlsx', '*.pptx', '*.doc', '*.xls', '*.ppt'],
};

const sizes = (m: Machine) => ((m as Machine & { sizes?: Record<string, number> }).sizes ??= {});

function sizeMb(m: Machine, winPath: string, content: string): number {
  return sizes(m)[normWin(winPath)] ?? Math.max(0.001, content.length / 1e6);
}

function folderUsage(env: Env, m: Machine, winFolder: string): number {
  const vfs = toVfsOn(env, m.name, winFolder);
  let total = 0;
  const walk = (p: string, w: string) => {
    let entries;
    try {
      entries = listDir(env.sys.fs, p, ROOT);
    } catch {
      return;
    }
    for (const { name, node } of entries) {
      if (node.type === 'dir') walk(`${p}/${name}`, `${w}\\${name}`);
      else if (node.type === 'file') total += sizeMb(m, `${w}\\${name}`, node.content);
    }
  };
  walk(vfs, normWin(winFolder));
  return total;
}

/** Throws when FSRM blocks writing a file of this size to this folder. */
export function fsrmCheck(cx: Cx, m: Machine, destWin: string, mb: number): void {
  const dest = normWin(destWin);
  const file = dest.split('\\').pop() ?? '';
  for (const sc of m.fsrm.screens) {
    if (!sc.active || !dest.toLowerCase().startsWith(normWin(sc.path).toLowerCase() + '\\')) continue;
    for (const g of sc.groups) if ((FILE_GROUPS[g] ?? []).some((pat) => new RegExp('^' + pat.replace('.', '\\.').replace('*', '.*') + '$', 'i').test(file))) cx.fail(`Access to the path '${dest}' is denied. (File Server Resource Manager blocked ${file}: it is in the file group "${g}" screened on ${normWin(sc.path)}.)`);
  }
  for (const q of m.fsrm.quotas) {
    const qp = normWin(q.path).toLowerCase();
    if (!dest.toLowerCase().startsWith(qp + '\\') || q.soft) continue;
    const used = folderUsage(cx.env, m, q.path);
    if (used + mb > q.sizeMb + 1e-9) cx.fail(`There is not enough space on the disk. (The ${q.sizeMb} MB hard quota on ${normWin(q.path)} is ${Math.round(used)} MB used; this file needs ${Math.round(mb)} MB.)`);
  }
}

/* ----------------------------------------------------------------------------- UNC resolution */

UNC_RESOLVERS.push((env, server, share, rest) => {
  const st = env.st;
  const isDomain = server.toLowerCase() === st.domain.toLowerCase() || server.toLowerCase() === st.netbios.toLowerCase();
  if (!isDomain) return null;
  const dc = env.est.machines.find((m) => m.dc) ?? env.est.machines[0];
  if (/^sysvol$/i.test(share)) return toVfsOn(env, dc.name, `C:\\Windows\\SYSVOL\\sysvol${rest}`);
  if (/^netlogon$/i.test(share)) return toVfsOn(env, dc.name, `C:\\Windows\\SYSVOL\\sysvol\\${st.domain}\\scripts${rest}`);
  for (const m of env.est.machines) {
    for (const root of m.dfs.roots) {
      const rootPath = `\\\\${server}\\${share}`.toLowerCase();
      if (root.path.toLowerCase() !== rootPath && root.path.toLowerCase() !== `\\\\${st.domain}\\${share}`.toLowerCase()) continue;
      const full = `${root.path}${rest}`.toLowerCase();
      const folder = root.folders.find((f) => full === f.path.toLowerCase() || full.startsWith(f.path.toLowerCase() + '\\'));
      if (!folder) return null;
      const target = folder.targets[0];
      const tail = full.slice(folder.path.length);
      return toVfs(env, target + tail);
    }
  }
  return null;
});

/* ----------------------------------------------------------------------------- helpers */

function shareOf(cx: Cx, name: string, m = machine(cx.env)): SmbShareRec {
  const s = m.shares.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) return cx.fail(`No MSFT_SMBShare objects found with property 'Name' equal to '${name}'.`);
  return s;
}

function accountExists(env: Env, acct: string): boolean {
  const short = acct.replace(/^[^\\]+\\/, '');
  return /^(everyone|authenticated users|administrators|users|system|creator owner)$/i.test(short) || !!findUser(env.st, short) || !!findGroup(env.st, short);
}

function fullAccount(env: Env, acct: string): string {
  if (/^(everyone|creator owner)$/i.test(acct)) return acct === acct.toLowerCase() ? acct.replace(/\b\w/g, (c) => c.toUpperCase()) : acct;
  if (/^(administrators|users)$/i.test(acct)) return `BUILTIN\\${acct[0].toUpperCase()}${acct.slice(1).toLowerCase()}`;
  if (/^authenticated users$/i.test(acct)) return 'NT AUTHORITY\\Authenticated Users';
  return acct.includes('\\') ? acct : `${env.st.netbios}\\${acct}`;
}

const printers = (m: Machine) => m.printers;
const connections = (m: Machine) => ((m as Machine & { connections?: string[] }).connections ??= []);

function spoolDir(env: Env, m: Machine): string {
  return driveRoot(env.est, m.name) + '/Windows/System32/spool/PRINTERS';
}

/** Jobs whose spool file was deleted while the spooler was stopped are gone. */
function reconcileJobs(env: Env, m: Machine): void {
  if (m.services.Spooler?.status !== 'Running') return;
  const dir = spoolDir(env, m);
  for (const p of m.printers) p.jobs = p.jobs.filter((j) => j.status !== 'Error' || !!lookup(env.sys.fs, `${dir}/${String(j.id).padStart(5, '0')}.SPL`, ROOT));
}

function printerView(p: Printer, m: Machine): Obj {
  return { __type: 'printer', Name: p.name, ComputerName: m.name, Type: 'Local', DriverName: p.driver, PortName: p.port, Shared: p.shared, ShareName: p.shareName ?? '', Published: p.published };
}

/* ----------------------------------------------------------------------------- cmdlets */

register({
  /* ------------------------------------------------------------ SMB */
  'new-smbshare': (cx) => {
    const env = cx.env;
    const m = cx.P.cimsession ? machineByName(env, str(cx.P.cimsession)) ?? machine(env) : machine(env);
    const n = str(cx.P.name ?? cx.pos[0]);
    const folderWin = normWin(str(cx.P.path ?? cx.pos[1]));
    const l = lookup(env.sys.fs, toVfsOn(env, m.name, folderWin), ROOT);
    if (!l || l.node.type !== 'dir') cx.fail(`The system cannot find the file specified: ${folderWin}. Create the folder first with New-Item -ItemType Directory.`);
    if (m.shares.some((s) => s.name.toLowerCase() === n.toLowerCase())) cx.fail('The name has already been shared.');
    const access: SmbShareRec['access'] = [];
    const add = (v: Value, right: 'Full' | 'Change' | 'Read') => {
      for (const a of asList(v)) {
        const acct = str(a);
        if (!accountExists(env, acct)) cx.fail(`No mapping between account names and security IDs was done: ${acct}`);
        access.push({ account: fullAccount(env, acct), right });
      }
    };
    if (cx.P.fullaccess !== undefined) add(cx.P.fullaccess, 'Full');
    if (cx.P.changeaccess !== undefined) add(cx.P.changeaccess, 'Change');
    if (cx.P.readaccess !== undefined) add(cx.P.readaccess, 'Read');
    if (!access.length) access.push({ account: 'Everyone', right: 'Read' });
    const share: SmbShareRec = { name: n, path: folderWin, server: m.name, access, abe: str(cx.P.folderenumerationmode).toLowerCase() === 'accessbased', caching: cx.P.cachingmode !== undefined ? str(cx.P.cachingmode) : 'Manual', description: cx.P.description !== undefined ? str(cx.P.description) : undefined };
    m.shares.push(share);
    // The first Windows lab reads shares from the directory as well.
    if (m === env.est.machines[0]) {
      env.st.shares.push(share);
      env.dirtyAd = true;
    }
    env.dirtyEst = true;
    return [{ __type: 'share', Name: n, ScopeName: '*', Path: folderWin, Description: share.description ?? '' }];
  },
  'get-smbshare': (cx) => {
    const m = machine(cx.env);
    const all = [
      { __type: 'share', Name: 'ADMIN$', ScopeName: '*', Path: 'C:\\Windows', Description: 'Remote Admin' },
      { __type: 'share', Name: 'C$', ScopeName: '*', Path: 'C:\\', Description: 'Default share' },
      ...(m.dc ? [{ __type: 'share', Name: 'NETLOGON', ScopeName: '*', Path: `C:\\Windows\\SYSVOL\\sysvol\\${cx.env.st.domain}\\SCRIPTS`, Description: 'Logon server share' }, { __type: 'share', Name: 'SYSVOL', ScopeName: '*', Path: 'C:\\Windows\\SYSVOL\\sysvol', Description: 'Logon server share' }] : []),
      ...m.shares.map((s) => ({ __type: 'share', Name: s.name, ScopeName: '*', Path: s.path, Description: s.description ?? '', ...(cx.P.name ? { FolderEnumerationMode: s.abe ? 'AccessBased' : 'Unrestricted', CachingMode: s.caching ?? 'Manual' } : {}) })),
    ];
    const want = cx.P.name ?? cx.pos[0];
    return all.filter((s) => !want || s.Name.toLowerCase() === str(want).toLowerCase());
  },
  'set-smbshare': (cx) => {
    const s = shareOf(cx, str(cx.P.name ?? cx.pos[0]));
    if (cx.P.folderenumerationmode !== undefined) s.abe = str(cx.P.folderenumerationmode).toLowerCase() === 'accessbased';
    if (cx.P.cachingmode !== undefined) s.caching = str(cx.P.cachingmode);
    if (cx.P.description !== undefined) s.description = str(cx.P.description);
    cx.env.dirtyEst = true;
    return [];
  },
  'remove-smbshare': (cx) => {
    const env = cx.env;
    const m = machine(env);
    const n = str(cx.P.name ?? cx.pos[0]);
    shareOf(cx, n);
    m.shares = m.shares.filter((s) => s.name.toLowerCase() !== n.toLowerCase());
    env.st.shares = env.st.shares.filter((s) => s.name.toLowerCase() !== n.toLowerCase());
    env.dirtyAd = true;
    env.dirtyEst = true;
    return [];
  },
  'get-smbshareaccess': (cx) => {
    const s = shareOf(cx, str(cx.P.name ?? cx.pos[0]));
    return s.access.map((a) => ({ __type: 'access', Name: s.name, ScopeName: '*', AccountName: a.account, AccessControlType: 'Allow', AccessRight: a.right }));
  },
  'grant-smbshareaccess': (cx) => {
    const env = cx.env;
    const s = shareOf(cx, str(cx.P.name ?? cx.pos[0]));
    const right = str(cx.P.accessright) as 'Full' | 'Change' | 'Read';
    if (!['Full', 'Change', 'Read'].includes(right)) cx.fail('Use -AccessRight Full, Change or Read.');
    for (const a of asList(cx.P.accountname)) {
      const acct = str(a);
      if (!accountExists(env, acct)) cx.fail(`No mapping between account names and security IDs was done: ${acct}`);
      const full = fullAccount(env, acct);
      s.access = s.access.filter((x) => x.account.toLowerCase() !== full.toLowerCase());
      s.access.push({ account: full, right });
    }
    syncLegacy(env, s);
    env.dirtyEst = true;
    return [];
  },
  'revoke-smbshareaccess': (cx) => {
    const env = cx.env;
    const s = shareOf(cx, str(cx.P.name ?? cx.pos[0]));
    for (const a of asList(cx.P.accountname)) {
      const target = acctName(str(a));
      s.access = s.access.filter((x) => acctName(x.account) !== target);
    }
    syncLegacy(env, s);
    env.dirtyEst = true;
    return [];
  },

  /* ------------------------------------------------------------ NTFS */
  'get-acl': (cx) => {
    const p = normWin(str(cx.P.path ?? cx.pos[0] ?? '.'));
    const vfs = toVfs(cx.env, p);
    // The ACL lives on the machine the path is on (\\FS01\D$\... is FS01).
    const m = machineFromVfs(cx.env, vfs);
    if (!lookup(cx.env.sys.fs, vfs, ROOT)) cx.fail(`Cannot find path '${p}' because it does not exist.`);
    const win = toWin(vfs);
    const acl = aclOf(m, win);
    // Access holds FileSystemAccessRule-like objects; AccessToString is the text the default view shows.
    const rules = acl.map((a) => ({ __type: 'select', __display: `${a.account} ${a.type}  ${a.rights}${a.inherited ? ' (inherited)' : ''}`, FileSystemRights: a.rights, AccessControlType: a.type, IdentityReference: a.account, IsInherited: !!a.inherited, InheritanceFlags: 'ContainerInherit, ObjectInherit', PropagationFlags: 'None' }));
    return [{ __type: 'acl', Path: win, Owner: m.ntfs[normWin(win)]?.owner ?? 'BUILTIN\\Administrators', Access: rules, __extra: { AccessToString: acl.map((a) => `${a.account} ${a.type}  ${a.rights}`).join('\n') } }];
  },
  'copy-item': (cx) => copyOrMove(cx, false),
  'move-item': (cx) => copyOrMove(cx, true),
  'rename-item': (cx) => {
    const src = toVfs(cx.env, str(cx.P.path ?? cx.pos[0]));
    const newName = str(cx.P.newname ?? cx.pos[1]);
    const dest = src.slice(0, src.lastIndexOf('/')) + '/' + newName;
    const text = readFile(cx.env.sys.fs, src, ROOT);
    writeFile(cx.env.sys.fs, dest, text, ROOT, cx.env.sys.now);
    remove(cx.env.sys.fs, src, ROOT, false);
    return [];
  },

  /* ------------------------------------------------------------ FSRM */
  'new-fsrmquota': (cx) => {
    const m = machine(cx.env);
    requireFeature(cx, m, 'FS-Resource-Manager', 'FSRM quotas');
    const p = normWin(str(cx.P.path ?? cx.pos[0]));
    if (!lookup(cx.env.sys.fs, toVfs(cx.env, p), ROOT)) cx.fail(`The system cannot find the path specified: ${p}.`);
    const tmpl = cx.P.template !== undefined ? str(cx.P.template) : undefined;
    const tmplSize: Record<string, number> = { '100 MB Limit': 100, '200 MB Limit Reports to User': 200, '2 GB Limit': 2048, '5 GB Limit': 5120, '10 GB Limit': 10240, '250 MB Extended Limit': 250, 'Monitor 200 GB Volume Usage': 204800 };
    if (tmpl && tmplSize[tmpl] === undefined) cx.fail(`The quota template "${tmpl}" does not exist. Get-FsrmQuotaTemplate lists them.`);
    const sizeMb = tmpl ? tmplSize[tmpl] : sizeToMb(cx, cx.P.size);
    m.fsrm.quotas = m.fsrm.quotas.filter((q) => normWin(q.path).toLowerCase() !== p.toLowerCase());
    m.fsrm.quotas.push({ path: p, sizeMb, soft: !!cx.P.softlimit || /monitor/i.test(tmpl ?? ''), template: tmpl });
    cx.env.dirtyEst = true;
    return [];
  },
  'get-fsrmquota': (cx) => machine(cx.env).fsrm.quotas.map((q) => ({ __type: 'quota', Path: q.path, Size: `${q.sizeMb} MB`, SoftLimit: q.soft, Usage: `${Math.round(folderUsage(cx.env, machine(cx.env), q.path))} MB`, Template: q.template ?? '' })),
  'get-fsrmquotatemplate': () => ['100 MB Limit', '200 MB Limit Reports to User', '2 GB Limit', '5 GB Limit', '10 GB Limit', '250 MB Extended Limit', 'Monitor 200 GB Volume Usage'].map((n) => ({ __type: 'select', Name: n })),
  'remove-fsrmquota': (cx) => {
    const m = machine(cx.env);
    const p = normWin(str(cx.P.path ?? cx.pos[0])).toLowerCase();
    m.fsrm.quotas = m.fsrm.quotas.filter((q) => normWin(q.path).toLowerCase() !== p);
    cx.env.dirtyEst = true;
    return [];
  },
  'new-fsrmfilescreen': (cx) => {
    const m = machine(cx.env);
    requireFeature(cx, m, 'FS-Resource-Manager', 'FSRM file screens');
    const p = normWin(str(cx.P.path ?? cx.pos[0]));
    if (!lookup(cx.env.sys.fs, toVfs(cx.env, p), ROOT)) cx.fail(`The system cannot find the path specified: ${p}.`);
    const groups = asList(cx.P.includegroup).map(str);
    if (!groups.length && cx.P.template === undefined) cx.fail('New-FsrmFileScreen needs -IncludeGroup "<file group>" (Get-FsrmFileGroup lists them).');
    const tmplGroups: Record<string, string[]> = { 'Block Audio and Video Files': ['Audio and Video Files'], 'Block Executable Files': ['Executable Files'], 'Block Image Files': ['Image Files'] };
    const all = [...groups, ...(cx.P.template !== undefined ? tmplGroups[str(cx.P.template)] ?? cx.fail(`The file screen template "${str(cx.P.template)}" does not exist.`) : [])];
    for (const g of all) if (!FILE_GROUPS[g]) cx.fail(`The file group "${g}" does not exist. Get-FsrmFileGroup lists them.`);
    m.fsrm.screens = m.fsrm.screens.filter((s) => normWin(s.path).toLowerCase() !== p.toLowerCase());
    m.fsrm.screens.push({ path: p, groups: all, active: cx.P.active === undefined ? true : bool(cx.P.active) });
    cx.env.dirtyEst = true;
    return [];
  },
  'get-fsrmfilescreen': (cx) => machine(cx.env).fsrm.screens.map((s) => ({ __type: 'screen', Path: s.path, IncludeGroup: s.groups, Active: s.active })),
  'get-fsrmfilegroup': () => Object.entries(FILE_GROUPS).map(([n, p]) => ({ __type: 'select', Name: n, IncludePattern: p })),

  /* ------------------------------------------------------------ DFS */
  'new-dfsnroot': (cx) => {
    const env = cx.env;
    const target = str(cx.P.targetpath);
    const unc = /^\\\\([^\\]+)\\([^\\]+)$/.exec(target);
    if (!unc) cx.fail('Use -TargetPath \\\\SERVER\\Share for the namespace root target.');
    const m = machineByName(env, unc![1]) ?? cx.fail(`The namespace server ${unc![1]} cannot be contacted.`);
    if (!m.features.includes('FS-DFS-Namespace')) cx.fail(`The DFS Namespace role service is not installed on ${m.name}. Install-WindowsFeature FS-DFS-Namespace -IncludeManagementTools -ComputerName ${m.name}`);
    if (!m.shares.some((s) => s.name.toLowerCase() === unc![2].toLowerCase())) cx.fail(`The share ${target} does not exist: create the root folder share first.`);
    const type = str(cx.P.type ?? 'DomainV2');
    const path = str(cx.P.path);
    if (!/^\\\\[^\\]+\\[^\\]+$/.test(path)) cx.fail('Use -Path \\\\campus.local\\Name for a domain-based namespace.');
    if (/^domainv[12]$/i.test(type) && path.split('\\')[2].toLowerCase() !== env.st.domain.toLowerCase()) cx.fail(`A domain-based namespace path starts with the domain name: \\\\${env.st.domain}\\...`);
    m.dfs.roots.push({ path, type, folders: [] });
    env.dirtyEst = true;
    return [{ __type: 'select', Path: path, Type: type, State: 'Online' }];
  },
  'new-dfsnfolder': (cx) => {
    const env = cx.env;
    const path = str(cx.P.path);
    const target = str(cx.P.targetpath);
    const root = env.est.machines.flatMap((m) => m.dfs.roots).find((r) => path.toLowerCase().startsWith(r.path.toLowerCase() + '\\'));
    if (!root) cx.fail(`No namespace root contains ${path}. Create the root with New-DfsnRoot first.`);
    const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(target);
    const tm = unc && machineByName(env, unc[1]);
    if (!tm || !tm.shares.some((s) => s.name.toLowerCase() === unc![2].toLowerCase())) cx.fail(`The folder target ${target} does not exist. Share the folder on its server first.`);
    if (root!.folders.some((f) => f.path.toLowerCase() === path.toLowerCase())) cx.fail(`The DFS folder ${path} already exists; add another target with New-DfsnFolderTarget.`);
    root!.folders.push({ path, targets: [target] });
    env.dirtyEst = true;
    return [{ __type: 'select', Path: path, State: 'Online', TargetPath: target }];
  },
  'new-dfsnfoldertarget': (cx) => {
    const env = cx.env;
    const path = str(cx.P.path);
    const folder = env.est.machines.flatMap((m) => m.dfs.roots).flatMap((r) => r.folders).find((f) => f.path.toLowerCase() === path.toLowerCase());
    if (!folder) cx.fail(`The DFS folder ${path} does not exist.`);
    folder!.targets.push(str(cx.P.targetpath));
    env.dirtyEst = true;
    return [];
  },
  'get-dfsnroot': (cx) => cx.env.est.machines.flatMap((m) => m.dfs.roots).map((r) => ({ __type: 'select', Path: r.path, Type: r.type, State: 'Online' })),
  'get-dfsnfolder': (cx) => cx.env.est.machines.flatMap((m) => m.dfs.roots).flatMap((r) => r.folders).filter((f) => !cx.P.path || new RegExp('^' + str(cx.P.path).replace(/\\/g, '\\\\').replace(/\*/g, '.*') + '$', 'i').test(f.path)).map((f) => ({ __type: 'select', Path: f.path, State: 'Online' })),
  'get-dfsnfoldertarget': (cx) => cx.env.est.machines.flatMap((m) => m.dfs.roots).flatMap((r) => r.folders).filter((f) => f.path.toLowerCase() === str(cx.P.path ?? cx.pos[0]).toLowerCase()).flatMap((f) => f.targets.map((t) => ({ __type: 'select', Path: f.path, TargetPath: t, State: 'Online' }))),
  'new-dfsreplicationgroup': (cx) => {
    const m = cx.env.est.machines[0];
    const g = str(cx.P.groupname ?? cx.pos[0]);
    if (m.dfs.replication.some((r) => r.group.toLowerCase() === g.toLowerCase())) cx.fail(`The replication group ${g} already exists.`);
    m.dfs.replication.push({ group: g, folder: '', members: [] });
    cx.env.dirtyEst = true;
    return [];
  },
  'new-dfsreplicatedfolder': (cx) => {
    const rg = replGroup(cx);
    rg.folder = str(cx.P.foldername);
    cx.env.dirtyEst = true;
    return [];
  },
  'add-dfsrmember': (cx) => {
    const rg = replGroup(cx);
    for (const c of asList(cx.P.computername).map(str)) {
      const m = machineByName(cx.env, c) ?? cx.fail(`The computer ${c} cannot be contacted.`);
      if (!m.features.includes('FS-DFS-Replication')) cx.fail(`DFS Replication is not installed on ${m.name}. Install-WindowsFeature FS-DFS-Replication -ComputerName ${m.name}`);
      if (!rg.members.includes(m.name)) rg.members.push(m.name);
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'add-dfsrconnection': (cx) => {
    const rg = replGroup(cx);
    const a = str(cx.P.sourcecomputername);
    const b = str(cx.P.destinationcomputername);
    if (![a, b].every((x) => rg.members.some((mm) => mm.toLowerCase() === x.toLowerCase()))) cx.fail('Both computers must be members of the replication group (Add-DfsrMember).');
    (rg as typeof rg & { connections?: string[] }).connections = [...((rg as typeof rg & { connections?: string[] }).connections ?? []), `${a}->${b}`];
    cx.env.dirtyEst = true;
    return [];
  },
  'set-dfsrmembership': (cx) => {
    const env = cx.env;
    const rg = replGroup(cx);
    const comp = str(cx.P.computername);
    const m = machineByName(env, comp) ?? cx.fail(`The computer ${comp} cannot be contacted.`);
    if (!rg.members.includes(m.name)) cx.fail(`${m.name} is not a member of ${rg.group}. Add-DfsrMember first.`);
    const contentPath = normWin(str(cx.P.contentpath));
    const ext = rg as typeof rg & { paths?: Record<string, string>; primary?: string };
    ext.paths = { ...(ext.paths ?? {}), [m.name]: contentPath };
    if (cx.P.primarymember !== undefined && bool(cx.P.primarymember)) ext.primary = m.name;
    mkdir(env.sys.fs, toVfsOn(env, m.name, contentPath), ROOT, env.sys.now, true);
    replicate(env, ext);
    env.dirtyEst = true;
    return [];
  },
  'get-dfsreplicationgroup': (cx) => cx.env.est.machines[0].dfs.replication.map((r) => ({ __type: 'select', GroupName: r.group, Folder: r.folder, Members: r.members })),

  /* ------------------------------------------------------------ printers */
  'add-printerdriver': (cx) => {
    const m = machine(cx.env);
    const n = str(cx.P.name ?? cx.pos[0]);
    const known = ['HP Universal Printing PCL 6', 'Canon Generic Plus PCL6', 'Kyocera Classic Universaldriver PCL6', 'Xerox Global Print Driver PCL6', 'Microsoft PCL6 Class Driver', 'Brother Laser Type1 Class Driver'];
    if (!known.some((k) => k.toLowerCase() === n.toLowerCase())) cx.fail(`The specified driver does not exist in the driver store: ${n}. Available here: ${known.join('; ')}.`);
    if (!m.drivers.includes(n)) m.drivers.push(known.find((k) => k.toLowerCase() === n.toLowerCase())!);
    cx.env.dirtyEst = true;
    return [];
  },
  'get-printerdriver': (cx) => machine(cx.env).drivers.map((d) => ({ __type: 'select', Name: d, PrinterEnvironment: 'Windows x64', MajorVersion: 4 })),
  'add-printerport': (cx) => {
    const m = machine(cx.env);
    const n = str(cx.P.name ?? cx.pos[0]);
    const host = str(cx.P.printerhostaddress);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) cx.fail('Use -PrinterHostAddress with the printer\'s IP address.');
    if (m.ports.some((p) => p.name.toLowerCase() === n.toLowerCase())) cx.fail(`The port ${n} already exists.`);
    m.ports.push({ name: n, host });
    cx.env.dirtyEst = true;
    return [];
  },
  'get-printerport': (cx) => machine(cx.env).ports.map((p) => ({ __type: 'select', Name: p.name, PrinterHostAddress: p.host, Description: 'Standard TCP/IP Port' })),
  'add-printer': (cx) => {
    const env = cx.env;
    const m = machine(env);
    if (cx.P.connectionname !== undefined) {
      const conn = str(cx.P.connectionname);
      const unc = /^\\\\([^\\]+)\\(.+)$/.exec(conn);
      const srv = unc && machineByName(env, unc[1]);
      if (!srv) cx.fail(`The printer name is invalid or the server ${unc?.[1] ?? conn} cannot be contacted.`);
      if (srv!.services.Spooler?.status !== 'Running') cx.fail(`The print spooler on ${srv!.name} is not running.`);
      const smb = srv!.firewall.rules.find((r) => /File and Printer Sharing \(SMB-In\)/.test(r.name));
      if (Object.values(srv!.firewall.enabled).some(Boolean) && smb && !smb.enabled) cx.fail(`The RPC server is unavailable: ${srv!.name}'s firewall blocks File and Printer Sharing.`);
      if (!srv!.printers.some((p) => p.shared && p.shareName?.toLowerCase() === unc![2].toLowerCase())) cx.fail(`The printer name is invalid: ${srv!.name} does not share a printer called ${unc![2]}.`);
      if (!connections(m).some((c) => c.toLowerCase() === conn.toLowerCase())) connections(m).push(conn);
      env.dirtyEst = true;
      return [];
    }
    const n = str(cx.P.name ?? cx.pos[0]);
    const driver = str(cx.P.drivername);
    const port = str(cx.P.portname);
    if (!m.drivers.some((d) => d.toLowerCase() === driver.toLowerCase())) cx.fail(`The specified driver does not exist on ${m.name}: ${driver}. Add-PrinterDriver first.`);
    if (!m.ports.some((p) => p.name.toLowerCase() === port.toLowerCase()) && !/^(PORTPROMPT:|FILE:|LPT1:)$/i.test(port)) cx.fail(`The specified port does not exist: ${port}. Add-PrinterPort first.`);
    if (m.printers.some((p) => p.name.toLowerCase() === n.toLowerCase())) cx.fail(`The printer ${n} already exists.`);
    const shared = !!cx.P.shared;
    const shareName = cx.P.sharename !== undefined ? str(cx.P.sharename) : shared ? n : undefined;
    if (shareName && m.printers.some((p) => p.shareName?.toLowerCase() === shareName.toLowerCase())) cx.fail(`The share name ${shareName} is already used by another printer.`);
    m.printers.push({ name: n, driver: m.drivers.find((d) => d.toLowerCase() === driver.toLowerCase())!, port, shared, shareName, published: !!cx.P.published, location: cx.P.location !== undefined ? str(cx.P.location) : undefined, jobs: [] });
    env.dirtyEst = true;
    return [];
  },
  'set-printer': (cx) => {
    const m = machine(cx.env);
    const p = m.printers.find((x) => x.name.toLowerCase() === str(cx.P.name ?? cx.pos[0]).toLowerCase()) ?? cx.fail(`The printer ${str(cx.P.name ?? cx.pos[0])} was not found.`);
    if (cx.P.shared !== undefined) p.shared = bool(cx.P.shared);
    if (cx.P.sharename !== undefined) p.shareName = str(cx.P.sharename);
    if (p.shared && !p.shareName) p.shareName = p.name;
    if (cx.P.published !== undefined) p.published = bool(cx.P.published);
    if (cx.P.location !== undefined) p.location = str(cx.P.location);
    if (cx.P.drivername !== undefined) {
      if (!m.drivers.some((d) => d.toLowerCase() === str(cx.P.drivername).toLowerCase())) cx.fail(`The driver ${str(cx.P.drivername)} is not installed. Add-PrinterDriver first.`);
      p.driver = str(cx.P.drivername);
    }
    if (cx.P.portname !== undefined) p.port = str(cx.P.portname);
    cx.env.dirtyEst = true;
    return [];
  },
  'get-printer': (cx) => {
    const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) ?? cx.fail(`The computer ${str(cx.P.computername)} cannot be contacted.`) : machine(cx.env);
    const local = printers(m).map((p) => printerView(p, m));
    const conns = connections(m).map((c) => ({ __type: 'printer', Name: c, ComputerName: c.split('\\')[2], Type: 'Connection', DriverName: '', PortName: '', Shared: false, ShareName: '', Published: false }));
    const want = cx.P.name ?? cx.pos[0];
    return [...local, ...conns].filter((p) => !want || String(p.Name).toLowerCase() === str(want).toLowerCase());
  },
  'remove-printer': (cx) => {
    const m = machine(cx.env);
    const n = str(cx.P.name ?? cx.pos[0]);
    m.printers = m.printers.filter((p) => p.name.toLowerCase() !== n.toLowerCase());
    (m as Machine & { connections?: string[] }).connections = connections(m).filter((c) => c.toLowerCase() !== n.toLowerCase());
    cx.env.dirtyEst = true;
    return [];
  },
  'get-printjob': (cx) => {
    const m = machine(cx.env);
    reconcileJobs(cx.env, m);
    cx.env.dirtyEst = true;
    const p = m.printers.find((x) => x.name.toLowerCase() === str(cx.P.printername ?? cx.pos[0]).toLowerCase()) ?? cx.fail(`The printer ${str(cx.P.printername ?? cx.pos[0])} was not found.`);
    if (m.services.Spooler?.status !== 'Running') cx.fail('The spooler service is not reachable. Start-Service Spooler.');
    return p.jobs.map((j) => ({ __type: 'job', Id: j.id, PrinterName: p.name, DocumentName: j.document, SubmittedBy: j.owner, JobStatus: j.status }));
  },
  'remove-printjob': (cx) => {
    const m = machine(cx.env);
    const p = m.printers.find((x) => x.name.toLowerCase() === str(cx.P.printername ?? cx.pos[0]).toLowerCase()) ?? cx.fail(`The printer ${str(cx.P.printername ?? cx.pos[0])} was not found.`);
    const id = Number(str(cx.P.id ?? cx.pos[1]));
    const job = p.jobs.find((j) => j.id === id) ?? cx.fail(`The print job ${id} was not found.`);
    if (job.status === 'Error') cx.fail(`The print job ${id} is stuck in the Error state and cannot be removed while the spooler holds it. Stop-Service Spooler, delete C:\\Windows\\System32\\spool\\PRINTERS\\*, then Start-Service Spooler.`);
    p.jobs = p.jobs.filter((j) => j !== job);
    cx.env.dirtyEst = true;
    return [];
  },
});

function syncLegacy(env: Env, s: SmbShareRec): void {
  const legacy = env.st.shares.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
  if (legacy) {
    legacy.access = s.access;
    env.dirtyAd = true;
  }
}

function sizeToMb(cx: Cx, v: Value): number {
  const s = str(v).toUpperCase().replace(/\s+/g, '');
  const m = /^(\d+(?:\.\d+)?)(KB|MB|GB|TB)?$/.exec(s);
  if (!m) return cx.fail(`Cannot read the size "${str(v)}". Use for example 500MB or 2GB.`);
  const n = Number(m[1]);
  return m[2] === 'GB' ? n * 1024 : m[2] === 'TB' ? n * 1024 * 1024 : m[2] === 'KB' ? n / 1024 : m[2] === 'MB' ? n : n / (1024 * 1024);
}

function replGroup(cx: Cx) {
  const g = str(cx.P.groupname ?? cx.pos[0]);
  const rg = cx.env.est.machines[0].dfs.replication.find((r) => r.group.toLowerCase() === g.toLowerCase());
  if (!rg) return cx.fail(`The replication group ${g} does not exist. New-DfsReplicationGroup first.`);
  return rg;
}

/** Copies the primary member's content to every other member that has a content path. */
function replicate(env: Env, rg: { members: string[]; paths?: Record<string, string>; primary?: string }): void {
  if (!rg.primary || !rg.paths?.[rg.primary]) return;
  const src = toVfsOn(env, rg.primary, rg.paths[rg.primary]);
  const files: Array<[string, string]> = [];
  const walk = (p: string, rel: string) => {
    let entries;
    try {
      entries = listDir(env.sys.fs, p, ROOT);
    } catch {
      return;
    }
    for (const { name, node } of entries) {
      if (node.type === 'dir') walk(`${p}/${name}`, `${rel}/${name}`);
      else if (node.type === 'file') files.push([`${rel}/${name}`, node.content]);
    }
  };
  walk(src, '');
  for (const mname of rg.members) {
    if (mname === rg.primary || !rg.paths[mname]) continue;
    const dst = toVfsOn(env, mname, rg.paths[mname]);
    for (const [rel, content] of files) {
      const target = dst + rel;
      mkdir(env.sys.fs, target.slice(0, target.lastIndexOf('/')), ROOT, env.sys.now, true);
      writeFile(env.sys.fs, target, content, ROOT, env.sys.now);
    }
  }
}

function copyOrMove(cx: Cx, move: boolean): Value[] {
  const env = cx.env;
  const srcArg = str(cx.P.path ?? cx.pos[0]);
  const dstArg = str(cx.P.destination ?? cx.pos[1]);
  const dstVfs = toVfs(env, dstArg);
  const dstMachine = machineFromVfs(env, dstVfs);
  const files: Array<{ rel: string; content: string; mb: number }> = [];
  if (/@GMT-/i.test(srcArg)) {
    files.push({ rel: srcArg.split('\\').pop()!, content: readWinFile(cx, srcArg), mb: 0.001 });
  } else {
    const srcVfs = toVfs(env, srcArg);
    const srcMachine = machineFromVfs(env, srcVfs);
    const leaf = srcVfs.slice(srcVfs.lastIndexOf('/') + 1);
    // C:\Data\* or C:\Data\*.csv: every match in the folder.
    if (/[*?]/.test(leaf)) {
      const dir = srcVfs.slice(0, srcVfs.lastIndexOf('/')) || '/';
      const re = new RegExp('^' + leaf.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      let entries: ReturnType<typeof listDir> = [];
      try {
        entries = listDir(env.sys.fs, dir, ROOT);
      } catch {
        cx.fail(`Cannot find path '${toWin(dir)}' because it does not exist.`);
      }
      const walk = (p: string, rel: string) => {
        for (const { name, node } of listDir(env.sys.fs, p, ROOT)) {
          if (node.type === 'dir') walk(`${p}/${name}`, `${rel}/${name}`);
          else if (node.type === 'file') files.push({ rel: `${rel}/${name}`, content: node.content, mb: sizeMb(srcMachine, toWin(`${p}/${name}`), node.content) });
        }
      };
      for (const { name, node } of entries.filter((e) => re.test(e.name))) {
        if (node.type === 'file') files.push({ rel: name, content: node.content, mb: sizeMb(srcMachine, toWin(`${dir}/${name}`), node.content) });
        else if (node.type === 'dir' && cx.P.recurse) walk(`${dir}/${name}`, name);
      }
      if (move) for (const { name } of entries.filter((e) => re.test(e.name))) remove(env.sys.fs, `${dir}/${name}`, ROOT, true);
      mkdir(env.sys.fs, dstVfs, ROOT, env.sys.now, true);
    }
    const l = /[*?]/.test(leaf) ? null : lookup(env.sys.fs, srcVfs, ROOT);
    if (!l && !/[*?]/.test(leaf)) cx.fail(`Cannot find path '${srcArg}' because it does not exist.`);
    if (l && l.node.type === 'dir') {
      if (!cx.P.recurse && !move) cx.fail(`'${srcArg}' is a folder: add -Recurse to copy what is inside it.`);
      const walk = (p: string, rel: string) => {
        for (const { name, node } of listDir(env.sys.fs, p, ROOT)) {
          if (node.type === 'dir') walk(`${p}/${name}`, `${rel}/${name}`);
          else if (node.type === 'file') files.push({ rel: `${rel}/${name}`.replace(/^\//, ''), content: node.content, mb: sizeMb(srcMachine, toWin(`${p}/${name}`), node.content) });
        }
      };
      const base = srcVfs.split('/').pop()!;
      walk(srcVfs, base);
    } else if (l && l.node.type === 'file') files.push({ rel: srcVfs.split('/').pop()!, content: l.node.content, mb: sizeMb(srcMachine, toWin(srcVfs), l.node.content) });
  }
  const dstIsDir = (() => {
    const d = lookup(env.sys.fs, dstVfs, ROOT);
    return !!d && d.node.type === 'dir';
  })();
  for (const f of files) {
    const target = dstIsDir || files.length > 1 ? `${dstVfs}/${f.rel}` : dstVfs;
    fsrmCheck(cx, dstMachine, toWin(target), f.mb);
    mkdir(env.sys.fs, target.slice(0, target.lastIndexOf('/')), ROOT, env.sys.now, true);
    writeFile(env.sys.fs, target, f.content, ROOT, env.sys.now);
    if (f.mb > 0.01) sizes(dstMachine)[normWin(toWin(target))] = f.mb;
  }
  if (move && !/@GMT-/i.test(srcArg) && !/[*?]/.test(srcArg.split('\\').pop() ?? '')) remove(env.sys.fs, toVfs(env, srcArg), ROOT, true);
  if (files.length) env.dirtyEst = true;
  // Copying ADMX templates into SYSVOL creates the central store.
  if (/\\\\[^\\]+\\sysvol\\[^\\]+\\policies\\policydefinitions/i.test(dstArg + '\\' + (files[0]?.rel.split('/')[0] ?? ''))) {
    env.st.centralStore = true;
    env.dirtyAd = true;
  }
  return [];
}

export function machineFromVfs(env: Env, vfs: string): Machine {
  const m = /^\/m\/([^/]+)\//.exec(vfs);
  return (m && env.est.machines.find((x) => x.name.toLowerCase() === m[1])) || env.est.machines[0];
}

/* ----------------------------------------------------------------------------- natives */

registerNative({
  icacls: (args, cx) => {
    const env = cx.env;
    const target = args[0];
    if (!target) return ['Usage: icacls <path> [/grant[:r] "DOMAIN\\name:(OI)(CI)M"] [/remove "name"] [/deny ...] [/inheritance:e|d|r]'];
    const vfs = toVfs(env, target);
    if (!lookup(env.sys.fs, vfs, ROOT)) cx.fail(`${target}: The system cannot find the file specified.`);
    const win = normWin(toWin(vfs));
    const tm = machineFromVfs(env, vfs);
    const entry = (tm.ntfs[win] ??= { aces: [], inherit: true });
    let changed = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '/grant' || a === '/grant:r' || a === '/deny') {
        const spec = args[++i] ?? '';
        const mm = /^(.+?):((?:\([A-Z]{1,2}\))*)\(?([A-Z]{1,2})\)?$/i.exec(spec);
        if (!mm) cx.fail(`Invalid parameter "${spec}". Use "DOMAIN\\name:(OI)(CI)M" (F full, M modify, RX read and execute, R read, W write).`);
        const acct = mm![1];
        const right = LETTER[mm![3].toUpperCase()];
        if (!right) cx.fail(`Invalid permission ${mm![3]}: use F, M, RX, R or W.`);
        if (!accountExists(env, acct)) cx.fail(`${acct}: No mapping between account names and security IDs was done.`);
        const full = fullAccount(env, acct);
        if (a === '/grant:r') entry.aces = entry.aces.filter((x) => !(acctName(x.account) === acctName(full) && x.type === 'Allow'));
        entry.aces.push({ account: full, rights: right, type: a === '/deny' ? 'Deny' : 'Allow' });
        changed = true;
      } else if (a === '/remove' || a === '/remove:g' || a === '/remove:d') {
        const acct = acctName(args[++i] ?? '');
        entry.aces = entry.aces.filter((x) => acctName(x.account) !== acct || (a === '/remove:g' && x.type === 'Deny') || (a === '/remove:d' && x.type === 'Allow'));
        changed = true;
      } else if (a.startsWith('/inheritance:')) {
        const mode = a.slice(13);
        if (mode === 'd') {
          entry.aces = [...entry.aces, ...aclOf(tm, win).filter((x) => x.inherited).map((x) => ({ account: x.account, rights: x.rights, type: x.type }))];
          entry.inherit = false;
        } else if (mode === 'r') entry.inherit = false;
        else if (mode === 'e') entry.inherit = true;
        else cx.fail('Use /inheritance:e (enable), :d (disable and copy) or :r (remove inherited).');
        changed = true;
      } else if (a === '/t' || a === '/c' || a === '/q') continue;
      else cx.fail(`Invalid parameter "${args[i]}".`);
    }
    if (changed) {
      env.dirtyEst = true;
      return ['processed file: ' + win, 'Successfully processed 1 files; Failed processing 0 files'];
    }
    return [aclOf(tm, win).map((x, k) => `${k === 0 ? win + ' ' : ' '.repeat(win.length + 1)}${x.account}:${x.inherited ? '(I)' : ''}(OI)(CI)${x.type === 'Deny' ? '(DENY)' : ''}(${SHORT[x.rights]})`).join('\n'), '', 'Successfully processed 1 files; Failed processing 0 files'];
  },
  vssadmin: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    const verb = args.slice(0, 2).join(' ').toLowerCase();
    if (verb === 'create shadow') {
      const vol = (args.find((a) => /^\/for=/i.test(a))?.slice(5) ?? '').toUpperCase().replace(/\\$/, '');
      if (!/^[A-Z]:$/.test(vol)) cx.fail('Use vssadmin create shadow /for=D:');
      if (!m.disks.some((d) => d.partitions.some((p) => `${p.letter}:` === vol && p.fs))) cx.fail(`Error: The volume ${vol} does not exist.`);
      const root = driveRoot(env.est, m.name, vol[0]);
      const files: Record<string, string> = {};
      const walk = (p: string) => {
        let entries;
        try {
          entries = listDir(env.sys.fs, p, ROOT);
        } catch {
          return;
        }
        for (const { name, node } of entries) {
          if (node.type === 'dir') walk(`${p}/${name}`);
          else if (node.type === 'file') files[normWin(toWin(`${p}/${name}`))] = node.content;
        }
      };
      walk(root);
      const n = m.shadows.length;
      const time = `2026.10.22-${String(9 + n).padStart(2, '0')}.30.00`;
      const id = `{b5946137-7b9f-4925-af80-51abd60b20d${n}}`;
      m.shadows.push({ id, volume: vol, time, files });
      env.dirtyEst = true;
      return ['vssadmin 1.1 - Volume Shadow Copy Service administrative command-line tool', `Successfully created shadow copy for '${vol}\\'`, `    Shadow Copy ID: ${id}`, `    Shadow Copy Volume Name: \\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy${n + 1}`, `    (Previous versions: \\\\${m.name}\\${vol[0]}$\\@GMT-${time}\\...)`];
    }
    if (verb === 'list shadows') return m.shadows.length ? m.shadows.flatMap((s) => [`Contents of shadow copy set ID: ${s.id}`, `   Original Volume: (${s.volume})`, `   Creation Time: @GMT-${s.time}`, '']) : ['No items found that satisfy the query.'];
    if (verb === 'add shadowstorage' || verb === 'resize shadowstorage') {
      (m as Machine & { shadowStorage?: string }).shadowStorage = args.slice(2).join(' ');
      env.dirtyEst = true;
      return ['Successfully added the shadow copy storage association'];
    }
    return ['Usage: vssadmin create shadow /for=D: | list shadows | add shadowstorage /for=D: /on=D: /maxsize=10%'];
  },
  dfsrdiag: (args, cx) => {
    if (!/^syncnow$/i.test(args[0] ?? '')) return ['Usage: dfsrdiag syncnow /partner:<server> /RGName:<group> /Time:1'];
    for (const rg of cx.env.est.machines[0].dfs.replication) replicate(cx.env, rg as typeof rg & { paths?: Record<string, string>; primary?: string });
    cx.env.dirtyEst = true;
    return ['Operation Succeeded'];
  },
});

export { readFile };
