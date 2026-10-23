/**
 * Group Policy: GPOs, links (enabled, enforced, order), blocked inheritance, security filtering,
 * registry-based settings and preferences, non-registry settings (drive maps, printers, scripts,
 * folder redirection, software) through Set-GPSetting, the Resultant Set of Policy with loopback,
 * gpupdate and gpresult, and backup, restore and reports.
 */

import { mkdir, readFile, writeFile } from '../fs.js';
import { asList, machine, machineByName, register, registerNative, str, toVfs, type Cx, type Env, type Obj, type Value } from './core.js';
import { findComputer, findGroup, findUser, groupsOf, parentOf } from './cmd-ad.js';
import { domainDn, newGpo, type Gpo, type GpoLink, type Machine } from './model.js';

const ROOT = { user: 'root', groups: ['root'] };

export function gpoOf(cx: Cx, name = str(cx.P.name ?? cx.P.guid ?? cx.pos[0])): Gpo {
  const g = cx.env.st.gpos.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id.toLowerCase() === name.toLowerCase().replace(/^\{?/, '{').replace(/\}?$/, '}'));
  if (!g) return cx.fail(`The GPO "${name}" was not found in the ${cx.env.st.domain} domain. Use Get-GPO -All to list them.`);
  return g;
}

function targetOk(env: Env, dn: string): boolean {
  const d = dn.toLowerCase();
  return d === domainDn(env.st.domain).toLowerCase() || env.st.ous.some((o) => o.dn.toLowerCase() === d);
}

function gpoView(g: Gpo): Obj {
  return { __type: 'GPO', DisplayName: g.name, DomainName: '', Id: g.id.slice(1, -1), GpoStatus: g.userEnabled && g.computerEnabled ? 'AllSettingsEnabled' : !g.userEnabled && !g.computerEnabled ? 'AllSettingsDisabled' : g.userEnabled ? 'ComputerSettingsDisabled' : 'UserSettingsDisabled', Description: g.comment ?? '', ModificationTime: '10/22/2026 9:30:00 AM' };
}

const KEY_RE = /^(HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\\/i;

/** Well-known registry policies, for gpresult and reports. */
export const POLICY_NAMES: Record<string, string> = {
  'hkcu\\software\\microsoft\\windows\\currentversion\\policies\\explorer|nocontrolpanel': 'Prohibit access to Control Panel and PC settings',
  'hkcu\\software\\microsoft\\windows\\currentversion\\policies\\system|disabletaskmgr': 'Remove Task Manager',
  'hkcu\\software\\policies\\microsoft\\windows\\control panel\\desktop|screensaveactive': 'Enable screen saver',
  'hkcu\\software\\policies\\microsoft\\windows\\control panel\\desktop|screensavetimeout': 'Screen saver timeout',
  'hkcu\\software\\policies\\microsoft\\windows\\control panel\\desktop|screensaverissecure': 'Password protect the screen saver',
  'hkcu\\software\\microsoft\\windows\\currentversion\\policies\\explorer|norun': 'Remove Run menu from Start Menu',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate\\au|noautoupdate': 'Configure Automatic Updates (NoAutoUpdate)',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate\\au|auoptions': 'Configure Automatic Updates (AUOptions)',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate\\au|scheduledinstallday': 'Scheduled install day',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate\\au|scheduledinstalltime': 'Scheduled install time',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate|wuserver': 'Specify intranet Microsoft update service location (WUServer)',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate|wustatusserver': 'Intranet statistics server (WUStatusServer)',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate\\au|usewuserver': 'Use the intranet update server',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate|targetgroup': 'Enable client-side targeting (TargetGroup)',
  'hklm\\software\\policies\\microsoft\\windows\\windowsupdate|targetgroupenabled': 'Enable client-side targeting',
  'hklm\\software\\policies\\microsoft\\windows\\system|userpolicymode': 'Configure user Group Policy loopback processing mode',
  'hklm\\software\\policies\\microsoft\\windows\\netcache|enabled': 'Allow or Disallow use of the Offline Files feature',
  'hklm\\software\\policies\\microsoft\\cryptography\\autoenrollment|aepolicy': 'Certificate Services Client - Auto-Enrollment',
  'hklm\\software\\policies\\microsoft\\windowsfirewall\\domainprofile|enablefirewall': 'Windows Defender Firewall: Protect all network connections (Domain)',
  'hklm\\software\\policies\\microsoft\\windows nt\\terminal services|fdenytsconnections': 'Allow users to connect remotely by using Remote Desktop Services',
  'hklm\\system\\currentcontrolset\\services\\usbstor|start': 'Removable storage: USB storage driver start (4 = disabled)',
  'hkcu\\software\\policies\\microsoft\\windows\\removablestoragedevices|deny_all': 'All Removable Storage classes: Deny all access',
};

const normKey = (k: string) => k.replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\').replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\');

/* ----------------------------------------------------------------------------- RSoP */

export interface Rsop {
  applied: Gpo[];
  denied: Array<{ gpo: Gpo; reason: string }>;
  settings: Record<string, { value: string | number; gpo: string }>;
  extras: Record<string, { value: string; gpo: string }>;
}

/** GPO links that reach an object at `dn`, in processing order (first = lowest precedence). */
function linksFor(env: Env, dn: string): Array<{ gpo: Gpo; link: GpoLink; scope: string }> {
  const dc = domainDn(env.st.domain).toLowerCase();
  const chain: string[] = [];
  let cur = parentOf(dn);
  while (cur && cur.toLowerCase() !== dc && cur.includes(',')) {
    if (/^OU=/i.test(cur)) chain.unshift(cur);
    cur = parentOf(cur);
  }
  const scopes = [domainDn(env.st.domain), ...chain];
  const normal: Array<{ gpo: Gpo; link: GpoLink; scope: string }> = [];
  const enforced: Array<{ gpo: Gpo; link: GpoLink; scope: string }> = [];
  scopes.forEach((scope, i) => {
    // Blocking at this scope (or deeper) removes non-enforced links from higher scopes.
    const blockedBelow = scopes.slice(i + 1).some((s) => env.st.blocked.some((b) => b.toLowerCase() === s.toLowerCase()));
    const links = env.st.gpos.flatMap((g) => g.links.filter((l) => l.target.toLowerCase() === scope.toLowerCase()).map((l) => ({ gpo: g, link: l, scope })));
    // Lower link order = higher precedence, so it is processed last.
    links.sort((a, b) => b.link.order - a.link.order);
    for (const x of links) {
      if (x.link.enforced) enforced.unshift(x);
      else if (!blockedBelow) normal.push(x);
    }
  });
  return [...normal, ...enforced];
}

function appliesTo(env: Env, g: Gpo, objDn: string): boolean {
  if (g.apply.some((a) => /authenticated users/i.test(a))) return true;
  const mine = new Set([objDn.toLowerCase(), ...groupsOf(env.st, objDn).map((x) => x.name.toLowerCase())]);
  const u = env.st.users.find((x) => x.dn === objDn);
  if (u) mine.add(u.sam.toLowerCase());
  const c = env.st.computers.find((x) => x.dn === objDn);
  if (c) {
    mine.add(c.name.toLowerCase());
    mine.add(`${c.name.toLowerCase()}$`);
    mine.add('domain computers');
  }
  return g.apply.some((a) => mine.has(a.replace(/^[^\\]+\\/, '').toLowerCase()));
}

export function rsop(env: Env, kind: 'user' | 'computer', objDn: string, computerDn?: string): Rsop {
  const out: Rsop = { applied: [], denied: [], settings: {}, extras: {} };
  let chain = linksFor(env, objDn);
  if (kind === 'user' && computerDn) {
    const comp = rsop(env, 'computer', computerDn);
    const mode = comp.settings['hklm\\software\\policies\\microsoft\\windows\\system|userpolicymode']?.value;
    const compChain = linksFor(env, computerDn);
    if (Number(mode) === 2) chain = compChain;
    else if (Number(mode) === 1) chain = [...chain, ...compChain];
  }
  for (const { gpo, link } of chain) {
    if (!link.enabled) {
      out.denied.push({ gpo, reason: 'Disabled (Link)' });
      continue;
    }
    if (kind === 'user' ? !gpo.userEnabled : !gpo.computerEnabled) {
      out.denied.push({ gpo, reason: 'Disabled (GPO)' });
      continue;
    }
    if (!appliesTo(env, gpo, objDn)) {
      out.denied.push({ gpo, reason: 'Denied (Security)' });
      continue;
    }
    const settings = kind === 'user' ? gpo.user : gpo.computer;
    const extras = Object.entries(gpo.extras).filter(([k]) => k.startsWith(kind === 'user' ? 'User:' : 'Computer:'));
    if (!Object.keys(settings).length && !extras.length && gpo.name !== 'Default Domain Policy') {
      out.denied.push({ gpo, reason: 'Empty' });
      continue;
    }
    if (!out.applied.includes(gpo)) out.applied.push(gpo);
    else out.applied = [...out.applied.filter((x) => x !== gpo), gpo];
    for (const [k, v] of Object.entries(settings)) out.settings[k.toLowerCase()] = { value: v, gpo: gpo.name };
    for (const [k, v] of extras) out.extras[k] = { value: v, gpo: gpo.name };
  }
  return out;
}

/** The value of a policy for a user signing in to a computer (or for the computer alone). */
export function effectivePolicy(env: Env, key: string, user: string | undefined, computer: string): string | number | undefined {
  const c = findComputer(env.st, computer);
  if (!c) return undefined;
  const k = normKey(key).toLowerCase();
  if (k.startsWith('hklm')) return rsop(env, 'computer', c.dn).settings[k]?.value;
  const u = user ? findUser(env.st, user) : undefined;
  return u ? rsop(env, 'user', u.dn, c.dn).settings[k]?.value : undefined;
}

export function effectiveExtra(env: Env, setting: string, user: string | undefined, computer: string): string | undefined {
  const c = findComputer(env.st, computer);
  if (!c) return undefined;
  if (setting.startsWith('Computer:')) return rsop(env, 'computer', c.dn).extras[setting]?.value;
  const u = user ? findUser(env.st, user) : undefined;
  return u ? rsop(env, 'user', u.dn, c.dn).extras[setting]?.value : undefined;
}

/* ----------------------------------------------------------------------------- cmdlets */

const EXTRA_KINDS: Record<string, string> = {
  'drive map': 'User:Drive map',
  'drive maps': 'User:Drive map',
  printer: 'User:Deployed printer',
  'deployed printer': 'User:Deployed printer',
  'computer printer': 'Computer:Deployed printer',
  'logon script': 'User:Logon script',
  'startup script': 'Computer:Startup script',
  'folder redirection: documents': 'User:Folder redirection: Documents',
  'folder redirection: desktop': 'User:Folder redirection: Desktop',
  'software installation': 'Computer:Software installation',
  'user software installation': 'User:Software installation',
  'restricted groups': 'Computer:Restricted groups',
  'wmi filter': 'Computer:WMI filter',
};

register(
  {
    'new-gpo': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (!n) cx.fail('New-GPO needs -Name.');
      if (st.gpos.some((g) => g.name.toLowerCase() === n.toLowerCase())) cx.fail(`A GPO named "${n}" already exists in the ${st.domain} domain.`);
      const g = newGpo(n);
      if (cx.P.comment !== undefined) g.comment = str(cx.P.comment);
      st.gpos.push(g);
      cx.env.dirtyAd = true;
      return [gpoView(g)];
    },
    'get-gpo': (cx) => (cx.P.all ? cx.env.st.gpos.map(gpoView) : [gpoView(gpoOf(cx))]),
    'remove-gpo': (cx) => {
      const g = gpoOf(cx);
      cx.env.st.gpos = cx.env.st.gpos.filter((x) => x !== g);
      cx.env.dirtyAd = true;
      return [];
    },
    'rename-gpo': (cx) => {
      const g = gpoOf(cx);
      g.name = str(cx.P.targetname);
      cx.env.dirtyAd = true;
      return [];
    },
    'new-gplink': (cx) => {
      const env = cx.env;
      const g = gpoOf(cx);
      const target = str(cx.P.target ?? cx.pos[1]);
      if (!targetOk(env, target)) cx.fail(`The target ${target} was not found. Link GPOs to the domain or an OU (sites are not simulated).`);
      if (g.links.some((l) => l.target.toLowerCase() === target.toLowerCase())) cx.fail(`The GPO "${g.name}" is already linked to ${target}.`);
      const existing = env.st.gpos.flatMap((x) => x.links).filter((l) => l.target.toLowerCase() === target.toLowerCase());
      const order = cx.P.order !== undefined ? Number(str(cx.P.order)) : existing.length + 1;
      for (const l of existing) if (l.order >= order) l.order++;
      g.links.push({ target, enabled: str(cx.P.linkenabled ?? 'Yes').toLowerCase() !== 'no', enforced: str(cx.P.enforced ?? 'No').toLowerCase() === 'yes' || cx.P.enforced === true, order });
      env.dirtyAd = true;
      return [{ __type: 'gpo-link', GpoId: g.id.slice(1, -1), DisplayName: g.name, Enabled: true, Enforced: g.links[g.links.length - 1].enforced, Target: target, Order: order }];
    },
    'set-gplink': (cx) => {
      const env = cx.env;
      const g = gpoOf(cx);
      const target = str(cx.P.target ?? cx.pos[1]);
      const l = g.links.find((x) => x.target.toLowerCase() === target.toLowerCase()) ?? cx.fail(`The GPO "${g.name}" is not linked to ${target}.`);
      if (cx.P.linkenabled !== undefined) l.enabled = str(cx.P.linkenabled).toLowerCase() === 'yes';
      if (cx.P.enforced !== undefined) l.enforced = str(cx.P.enforced).toLowerCase() === 'yes' || cx.P.enforced === true;
      if (cx.P.order !== undefined) {
        const others = env.st.gpos.flatMap((x) => x.links).filter((x) => x.target.toLowerCase() === target.toLowerCase() && x !== l).sort((a, b) => a.order - b.order);
        const want = Number(str(cx.P.order));
        others.splice(want - 1, 0, l);
        others.forEach((x, i) => (x.order = i + 1));
      }
      env.dirtyAd = true;
      return [];
    },
    'remove-gplink': (cx) => {
      const g = gpoOf(cx);
      const target = str(cx.P.target ?? cx.pos[1]).toLowerCase();
      g.links = g.links.filter((x) => x.target.toLowerCase() !== target);
      cx.env.dirtyAd = true;
      return [];
    },
    'set-gpinheritance': (cx) => {
      const env = cx.env;
      const target = str(cx.P.target ?? cx.pos[0]);
      if (!targetOk(env, target)) cx.fail(`The target ${target} was not found.`);
      const block = str(cx.P.isblocked).toLowerCase() === 'yes';
      env.st.blocked = env.st.blocked.filter((b) => b.toLowerCase() !== target.toLowerCase());
      if (block) env.st.blocked.push(target);
      env.dirtyAd = true;
      return [];
    },
    'get-gpinheritance': (cx) => {
      const env = cx.env;
      const target = str(cx.P.target ?? cx.pos[0]);
      const links = env.st.gpos.flatMap((g) => g.links.filter((l) => l.target.toLowerCase() === target.toLowerCase()).map((l) => ({ g, l }))).sort((a, b) => a.l.order - b.l.order);
      return [{ __type: 'inheritance', Name: target, GpoInheritanceBlocked: env.st.blocked.some((b) => b.toLowerCase() === target.toLowerCase()) ? 'Yes' : 'No', GpoLinks: links.map((x) => `${x.l.order}: ${x.g.name}${x.l.enforced ? ' (Enforced)' : ''}${x.l.enabled ? '' : ' (Disabled)'}`) }];
    },
    'set-gppermission': (cx) => {
      const env = cx.env;
      const g = gpoOf(cx);
      const target = str(cx.P.targetname);
      const level = str(cx.P.permissionlevel).toLowerCase();
      if (!/^(gpoapply|gporead|gpoedit|gpoeditdeletemodifysecurity|none)$/.test(level)) cx.fail('Use -PermissionLevel GpoApply, GpoRead, GpoEdit or None.');
      if (!/authenticated users/i.test(target) && !findGroup(env.st, target) && !findUser(env.st, target) && !findComputer(env.st, target)) cx.fail(`Trustee ${target} could not be found.`);
      const short = target.replace(/^[^\\]+\\/, '');
      if (level === 'gpoapply') {
        if (!g.apply.some((a) => a.toLowerCase() === short.toLowerCase())) g.apply.push(short);
      } else if (cx.P.replace || level === 'none' || level === 'gporead') g.apply = g.apply.filter((a) => a.toLowerCase() !== short.toLowerCase());
      env.dirtyAd = true;
      return [];
    },
    'get-gppermission': (cx) => {
      const g = gpoOf(cx);
      return [...g.apply.map((a) => ({ __type: 'access', Trustee: a, Permission: 'GpoApply' })), { __type: 'access', Trustee: 'Domain Admins', Permission: 'GpoEditDeleteModifySecurity' }, ...(g.apply.some((a) => /authenticated users/i.test(a)) ? [] : [{ __type: 'access', Trustee: 'Authenticated Users', Permission: 'GpoRead' }])];
    },
    'set-gpregistryvalue': (cx) => setValue(cx, false),
    'set-gpprefregistryvalue': (cx) => setValue(cx, true),
    'get-gpregistryvalue': (cx) => {
      const g = gpoOf(cx);
      const key = normKey(str(cx.P.key)).toLowerCase();
      const both = { ...Object.fromEntries(Object.entries(g.computer)), ...Object.fromEntries(Object.entries(g.user)) };
      const hits = Object.entries(both).filter(([k]) => k.toLowerCase().startsWith(key + '|') && (cx.P.valuename === undefined || k.toLowerCase().endsWith('|' + str(cx.P.valuename).toLowerCase())));
      if (!hits.length) cx.fail(`The following Group Policy registry setting was not found: "${str(cx.P.key)}".`);
      return hits.map(([k, v]) => ({ __type: 'select', KeyPath: k.split('|')[0], ValueName: k.split('|')[1], Value: v, PolicyState: 'Set' }));
    },
    'remove-gpregistryvalue': (cx) => {
      const g = gpoOf(cx);
      const k = `${normKey(str(cx.P.key))}|${str(cx.P.valuename)}`.toLowerCase();
      for (const part of [g.computer, g.user]) for (const key of Object.keys(part)) if (key.toLowerCase() === k) delete part[key];
      g.version++;
      cx.env.dirtyAd = true;
      return [];
    },
    // Not a Microsoft cmdlet: the simulator's stand-in for the Group Policy Management Editor.
    'set-gpsetting': (cx) => {
      const env = cx.env;
      const g = gpoOf(cx);
      const kind = str(cx.P.setting ?? cx.pos[1]);
      const key = EXTRA_KINDS[kind.toLowerCase()];
      if (!key) cx.fail(`Unknown setting "${kind}". Settings this editor knows: ${Object.keys(EXTRA_KINDS).join(', ')}.`);
      const value = str(cx.P.value ?? cx.pos[2]);
      if (/printer/i.test(key)) {
        const unc = /^\\\\([^\\]+)\\(.+)$/.exec(value);
        const srv = unc && machineByName(env, unc[1]);
        if (!srv || !srv.printers.some((p) => p.shared && p.shareName?.toLowerCase() === unc![2].toLowerCase())) cx.fail(`The printer ${value} is not shared on its server, so it cannot be deployed.`);
      }
      if (/drive map/i.test(key) && !/^[D-Z]:=\\\\[^\\]+\\.+/i.test(value)) cx.fail('A drive map value looks like H:=\\\\FS01\\Home$\\%USERNAME%');
      g.extras[key] = value;
      g.version++;
      env.dirtyAd = true;
      return [];
    },
    'get-gpsetting': (cx) => {
      const g = gpoOf(cx);
      return [...Object.entries(g.computer).map(([k, v]) => ({ __type: 'policy-row', Part: 'Computer', Setting: POLICY_NAMES[k.toLowerCase()] ?? k, Value: v })), ...Object.entries(g.user).map(([k, v]) => ({ __type: 'policy-row', Part: 'User', Setting: POLICY_NAMES[k.toLowerCase()] ?? k, Value: v })), ...Object.entries(g.extras).map(([k, v]) => ({ __type: 'policy-row', Part: k.split(':')[0], Setting: k.split(':').slice(1).join(':'), Value: v }))];
    },
    'set-gpostatus': (cx) => {
      const g = gpoOf(cx);
      const s = str(cx.P.status ?? cx.pos[1]).toLowerCase();
      g.userEnabled = !['usersettingsdisabled', 'allsettingsdisabled'].includes(s);
      g.computerEnabled = !['computersettingsdisabled', 'allsettingsdisabled'].includes(s);
      cx.env.dirtyAd = true;
      return [];
    },
    'backup-gpo': (cx) => {
      const env = cx.env;
      const dir = str(cx.P.path);
      const vfs = toVfs(env, dir);
      mkdir(env.sys.fs, vfs, ROOT, env.sys.now, true);
      const list = cx.P.all ? env.st.gpos : [gpoOf(cx)];
      for (const g of list) {
        const id = `{${(Math.abs(hash(g.name + g.version)) % 1e8).toString(16).padStart(8, '0').toUpperCase()}-BACK-UP00-0000-000000000000}`;
        mkdir(env.sys.fs, `${vfs}/${id}`, ROOT, env.sys.now, true);
        writeFile(env.sys.fs, `${vfs}/${id}/gpo.json`, JSON.stringify(g), ROOT, env.sys.now);
      }
      return list.map((g) => ({ __type: 'select', DisplayName: g.name, GpoId: g.id.slice(1, -1), Version: g.version, BackupDirectory: dir }));
    },
    'restore-gpo': (cx) => {
      const env = cx.env;
      const dir = toVfs(env, str(cx.P.path));
      const name = str(cx.P.name ?? cx.pos[0]);
      const found = findBackups(env, dir).filter((g) => g.name.toLowerCase() === name.toLowerCase()).sort((a, b) => b.version - a.version)[0];
      if (!found) cx.fail(`No backup of "${name}" was found in ${str(cx.P.path)}.`);
      const cur = env.st.gpos.find((g) => g.name.toLowerCase() === name.toLowerCase());
      if (cur) Object.assign(cur, { ...found, links: cur.links, version: cur.version + 1 });
      else env.st.gpos.push({ ...found, links: [] });
      env.dirtyAd = true;
      return [];
    },
    'import-gpo': (cx) => {
      const env = cx.env;
      const dir = toVfs(env, str(cx.P.path));
      const from = str(cx.P.backupgponame);
      const found = findBackups(env, dir).find((g) => g.name.toLowerCase() === from.toLowerCase());
      if (!found) cx.fail(`No backup of "${from}" was found in ${str(cx.P.path)}.`);
      const target = str(cx.P.targetname);
      let g = env.st.gpos.find((x) => x.name.toLowerCase() === target.toLowerCase());
      if (!g) {
        if (!cx.P.createifneeded) cx.fail(`The GPO ${target} does not exist (add -CreateIfNeeded).`);
        g = newGpo(target);
        env.st.gpos.push(g);
      }
      g.computer = { ...found!.computer };
      g.user = { ...found!.user };
      g.extras = { ...found!.extras };
      g.version++;
      env.dirtyAd = true;
      return [];
    },
    'get-gporeport': (cx) => {
      const env = cx.env;
      const list = cx.P.all ? env.st.gpos : [gpoOf(cx)];
      const type = str(cx.P.reporttype ?? 'Html');
      const body = list.map((g) => `${type.toLowerCase() === 'xml' ? `<GPO><Name>${g.name}</Name><Version>${g.version}</Version>` : `<h2>${g.name}</h2><p>Version ${g.version}</p>`}${[...Object.entries(g.computer), ...Object.entries(g.user)].map(([k, v]) => `<Setting key="${k}">${v}</Setting>`).join('')}${Object.entries(g.extras).map(([k, v]) => `<Setting name="${k}">${v}</Setting>`).join('')}${g.links.map((l) => `<Link target="${l.target}" enforced="${l.enforced}" enabled="${l.enabled}"/>`).join('')}${type.toLowerCase() === 'xml' ? '</GPO>' : ''}`).join('\n');
      if (cx.P.path !== undefined) {
        writeFile(env.sys.fs, toVfs(env, str(cx.P.path)), body + '\n', ROOT, env.sys.now);
        return [];
      }
      return [body];
    },
    'get-gpresultantsetofpolicy': (cx) => {
      const env = cx.env;
      const lines = gpresultLines(cx, str(cx.P.user ?? '') || undefined, str(cx.P.computer ?? machine(env).name), 'both');
      if (cx.P.path !== undefined) writeFile(env.sys.fs, toVfs(env, str(cx.P.path)), lines.join('\n') + '\n', ROOT, env.sys.now);
      return cx.P.path !== undefined ? [] : lines;
    },
  },
  {
    'new-gplink': 'New-GPLink -Name <GPO> -Target "OU=...,DC=campus,DC=local" [-LinkEnabled Yes|No] [-Enforced Yes|No] [-Order 1]',
    'set-gpregistryvalue': 'Set-GPRegistryValue -Name <GPO> -Key "HKCU\\Software\\..." -ValueName <name> -Type DWord|String -Value <value>',
    'set-gpsetting': 'Set-GPSetting -Name <GPO> -Setting "Drive map"|"Deployed printer"|"Logon script"|"Folder redirection: Documents"|"Software installation"|... -Value <value>   (the simulator\'s stand-in for the Group Policy Management Editor)',
    'set-gppermission': 'Set-GPPermission -Name <GPO> -TargetName <group> -TargetType Group -PermissionLevel GpoApply|GpoRead|None [-Replace]',
    'set-gpinheritance': 'Set-GPInheritance -Target "OU=...,DC=campus,DC=local" -IsBlocked Yes|No',
  },
);

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function findBackups(env: Env, dir: string): Gpo[] {
  const out: Gpo[] = [];
  try {
    const root = (env.sys.fs as unknown) as { children: Record<string, unknown> };
    void root;
  } catch {
    /* unused */
  }
  const walk = (p: string) => {
    try {
      const text = readFile(env.sys.fs, `${p}/gpo.json`, ROOT);
      out.push(JSON.parse(text) as Gpo);
    } catch {
      /* not a backup folder */
    }
  };
  // Backups are one folder per GPO under the backup directory.
  const l = (env.sys.fs as unknown) as never;
  void l;
  try {
    const { listDir } = fsHelpers;
    for (const { name, node } of listDir(env.sys.fs, dir, ROOT)) if (node.type === 'dir') walk(`${dir}/${name}`);
  } catch {
    /* no such folder */
  }
  return out;
}

import { listDir as listDirFn } from '../fs.js';
const fsHelpers = { listDir: listDirFn };

function setValue(cx: Cx, pref: boolean): Value[] {
  const env = cx.env;
  const g = gpoOf(cx);
  const key = normKey(str(cx.P.key));
  if (!KEY_RE.test(key) && !/^(HKLM|HKCU)\\/i.test(key)) cx.fail('The registry key must start with HKLM\\ or HKCU\\.');
  const name = str(cx.P.valuename);
  if (!name) cx.fail('Set-GPRegistryValue needs -ValueName.');
  const type = str(cx.P.type ?? 'String').toLowerCase();
  if (!['dword', 'string', 'expandstring', 'qword', 'multistring'].includes(type)) cx.fail('Use -Type DWord, String, ExpandString, QWord or MultiString.');
  const raw = cx.P.value;
  const value: string | number = type === 'dword' || type === 'qword' ? Number(str(raw)) : str(raw);
  if ((type === 'dword' || type === 'qword') && Number.isNaN(value as number)) cx.fail(`The value ${str(raw)} is not a number for a ${type} setting.`);
  const part = /^HKLM/i.test(key) ? g.computer : g.user;
  part[`${key}|${name}`] = value;
  if (pref) g.extras[`${/^HKLM/i.test(key) ? 'Computer' : 'User'}:Preference ${key}|${name}`] = String(value);
  g.version++;
  env.dirtyAd = true;
  return [];
}

function gpresultLines(cx: Cx, user: string | undefined, computer: string, scope: 'user' | 'computer' | 'both'): string[] {
  const env = cx.env;
  const c = findComputer(env.st, computer);
  if (!c) cx.fail(`The computer ${computer} is not a member of ${env.st.domain}: Group Policy does not apply to it.`);
  const lines = [`RSOP data for ${user ? `${env.st.netbios}\\${user}` : 'the computer'} on ${c!.name} : Logging Mode`, '-'.repeat(60), ''];
  const block = (title: string, r: Rsop) => {
    lines.push(title, '-'.repeat(title.length), '    Applied Group Policy Objects (highest precedence first)', '    ' + '-'.repeat(28));
    for (const g of [...r.applied].reverse()) lines.push(`        ${g.name}`);
    if (!r.applied.length) lines.push('        N/A');
    lines.push('', '    The following GPOs were not applied because they were filtered out', '    ' + '-'.repeat(28));
    for (const d of r.denied) lines.push(`        ${d.gpo.name}`, `            Filtering:  ${d.reason}`);
    if (!r.denied.length) lines.push('        N/A');
    const settings = Object.entries(r.settings);
    if (settings.length) {
      lines.push('', '    Winning settings');
      for (const [k, v] of settings) lines.push(`        ${POLICY_NAMES[k] ?? k} = ${v.value}   (from ${v.gpo})`);
    }
    const extras = Object.entries(r.extras);
    if (extras.length) for (const [k, v] of extras) lines.push(`        ${k.split(':').slice(1).join(':')} = ${v.value}   (from ${v.gpo})`);
    lines.push('');
  };
  if (scope !== 'user') block('COMPUTER SETTINGS', rsop(env, 'computer', c!.dn));
  if (scope !== 'computer' && user) {
    const u = findUser(env.st, user);
    if (!u) cx.fail(`The user ${user} does not have RSoP data.`);
    block('USER SETTINGS', rsop(env, 'user', u!.dn, c!.dn));
  }
  return lines;
}

/** Applies Group Policy on a machine: deployed printers and drive maps become visible there. */
export function applyPolicy(env: Env, m: Machine, user?: string): void {
  const c = findComputer(env.st, m.name);
  if (!c) return;
  const comp = rsop(env, 'computer', c.dn);
  const u = user ? findUser(env.st, user) : undefined;
  const usr = u ? rsop(env, 'user', u.dn, c.dn) : undefined;
  m.appliedGpos = [...comp.applied.map((g) => g.name), ...(usr?.applied.map((g) => g.name) ?? [])];
  const conns = ((m as Machine & { connections?: string[] }).connections ??= []);
  for (const r of [comp, usr]) {
    const p = r?.extras['User:Deployed printer']?.value ?? r?.extras['Computer:Deployed printer']?.value;
    if (p && !conns.includes(p)) conns.push(p);
  }
  const drive = usr?.extras['User:Drive map']?.value;
  if (drive) (m as Machine & { drives?: Record<string, string> }).drives = { ...((m as Machine & { drives?: Record<string, string> }).drives ?? {}), [drive.split(':=')[0].toUpperCase()]: drive.split(':=')[1].replace(/%username%/gi, user ?? '') };
}

registerNative({
  gpupdate: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    if (!m.domain || !findComputer(env.st, m.name)) return ['Updating policy...', '', 'Computer Policy update has completed successfully.', '(This computer is not in a domain, so only local policy applies.)'];
    if (Math.abs(m.timeOffsetMin) > 5) return ['Updating policy...', '', 'Computer policy could not be updated successfully. The following errors were encountered:', `The processing of Group Policy failed. Windows could not authenticate to the Active Directory service on a domain controller. (The clock is ${m.timeOffsetMin} minutes off: Kerberos needs it within 5 minutes.)`];
    const dc = env.est.machines.find((x) => x.dc);
    if (dc && !(m.nics[0]?.dns ?? []).some((ip) => dc.nics.some((n) => n.ip === ip)) && !m.dc) return ['Updating policy...', '', 'Computer policy could not be updated successfully. The following errors were encountered:', 'The processing of Group Policy failed because of lack of network connectivity to a domain controller. (Check the DNS server setting.)'];
    const user = env.vars.get('__gpuser') as string | undefined;
    applyPolicy(env, m, user ?? env.sys.user);
    env.dirtyEst = true;
    const target = args.find((a) => /^\/target:/i.test(a))?.slice(8).toLowerCase();
    return ['Updating policy...', '', ...(target !== 'user' ? ['Computer Policy update has completed successfully.'] : []), ...(target !== 'computer' ? ['User Policy update has completed successfully.'] : [])];
  },
  gpresult: (args, cx) => {
    const env = cx.env;
    const lower = args.map((a) => a.toLowerCase());
    const ui = lower.indexOf('/user');
    const si = lower.indexOf('/scope');
    const user = ui >= 0 ? args[ui + 1].replace(/^[^\\]+\\/, '') : env.sys.user;
    const scope = si >= 0 ? (lower[si + 1] as 'user' | 'computer') : 'both';
    const ci = lower.indexOf('/s');
    const computer = ci >= 0 ? args[ci + 1] : machine(env).name;
    if (!lower.includes('/r') && !lower.includes('/v') && !lower.some((a) => a.startsWith('/h'))) return ['Usage: gpresult /r [/scope user|computer] [/user DOMAIN\\name] [/s computer]'];
    const lines = gpresultLines(cx, user, computer, scope);
    const hi = lower.findIndex((a) => a === '/h');
    if (hi >= 0) {
      writeFile(env.sys.fs, toVfs(env, args[hi + 1]), `<html><body><pre>${lines.join('\n')}</pre></body></html>\n`, ROOT, env.sys.now);
      return [];
    }
    return [lines.join('\n')];
  },
});

export { asList };
