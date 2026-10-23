/**
 * Shared building blocks for the Systems Administration I templates: a campus estate on a variant
 * subnet, people and OUs, and short check builders.
 */

import type { CheckSpec } from '@cslab/lab-runtime';
import { domainDn, winSystemSpec, type AdState, type Disk, type Machine, type Nic, type WinLabSpec } from '@cslab/engine-shell/src/win/model';
import type { BuiltTask, Person, Variant } from '../types';

export const COURSE = 'systems-administration-i';
export const DOMAIN = 'campus.local';
export const NB = 'CAMPUS';
export const DC = domainDn(DOMAIN);

export type MachineSpec = Partial<Machine> & { name: string };

export function nic(ip: string | undefined, net: string, opts: Partial<Nic> = {}): Nic {
  const last = ip ? Number(ip.split('.')[3]) : 99;
  return { alias: 'Ethernet', mac: `00-15-5D-${(last % 256).toString(16).toUpperCase().padStart(2, '0')}-${net.split('.')[1].padStart(2, '0').slice(-2)}-${net.split('.')[2].padStart(3, '0').slice(-2)}`, dhcp: !ip, ...(ip ? { ip, prefix: 24, gateway: `${net}.1` } : {}), dns: ip ? [`${net}.10`] : [], profile: ip ? 'DomainAuthenticated' : 'Public', up: true, ...opts };
}

const running = { status: 'Running' as const, start: 'Automatic' as const };

export function dc01(net: string, extra: Partial<Machine> = {}): MachineSpec {
  return { name: 'DC01', nics: [nic(`${net}.10`, net, { dns: [`${net}.10`] })], ...extra };
}
export function fs01(net: string, extra: Partial<Machine> = {}, name = 'FS01', last = 20): MachineSpec {
  return { name, features: ['FS-FileServer'], nics: [nic(`${net}.${last}`, net)], disks: [systemDisk(), dataDisk(1, 'D', 500)], ...extra };
}
export function print01(net: string, extra: Partial<Machine> = {}): MachineSpec {
  return { name: 'PRINT01', features: ['Print-Services', 'Print-Server'], nics: [nic(`${net}.25`, net)], ...extra };
}
export function pc(name: string, net: string, last: number, extra: Partial<Machine> = {}): MachineSpec {
  return { name, os: 'Windows 11 Pro', installType: 'Client', nics: [nic(`${net}.${last}`, net)], ...extra };
}
export function bare(name: string, extra: Partial<Machine> = {}): MachineSpec {
  return { name, domain: undefined, nics: [{ alias: 'Ethernet', mac: '00-15-5D-0B-0A-01', dhcp: true, dns: [], profile: 'Public', up: true }], ...extra };
}

export function systemDisk(): Disk {
  return { number: 0, sizeGb: 127, style: 'GPT', online: true, partitions: [{ letter: 'C', sizeGb: 126, fs: 'NTFS', label: '' }], friendlyName: 'Msft Virtual Disk' };
}
export function dataDisk(n: number, letter: string, sizeGb: number, label = 'Data'): Disk {
  return { number: n, sizeGb, style: 'GPT', online: true, partitions: [{ letter, sizeGb, fs: 'NTFS', label }], friendlyName: 'Msft Virtual Disk' };
}
export function rawDisk(n: number, sizeGb: number, online = true): Disk {
  return { number: n, sizeGb, style: 'RAW', online, partitions: [], friendlyName: 'Msft Virtual Disk' };
}

export const svc = { running, stopped: { status: 'Stopped' as const, start: 'Automatic' as const } };

/** A user in the directory. */
export function addUser(st: AdState, p: Person, ou: string, extra: Record<string, unknown> = {}): string {
  const dn = `CN=${p.name},${ou}`;
  st.users.push({ sam: p.sam, name: p.name, given: p.given, surname: p.surname, upn: `${p.sam}@${DOMAIN}`, dn, sid: `S-1-5-21-3623811015-3361044348-30300820-${st.nextRid++}`, enabled: true, hasPassword: true, passwordLength: 12, ...extra });
  st.groups.find((g) => g.name === 'Domain Users')?.members.push(dn);
  return dn;
}
export function addOu(st: AdState, name: string, parent = DC): string {
  const dn = `OU=${name},${parent}`;
  if (!st.ous.some((o) => o.dn === dn)) st.ous.push({ name, dn, protected: true });
  return dn;
}
export function addGroup(st: AdState, name: string, scope: 'Global' | 'DomainLocal' | 'Universal', parent = `CN=Users,${DC}`, members: string[] = []): string {
  const dn = `CN=${name},${parent}`;
  st.groups.push({ name, dn, sid: `S-1-5-21-3623811015-3361044348-30300820-${st.nextRid++}`, scope, category: 'Security', members });
  return dn;
}

export function system(spec: WinLabSpec): Record<string, unknown> {
  return { system: winSystemSpec({ domain: DOMAIN, netbios: NB, ...spec }) };
}

/* ----------------------------------------------------------------------------- checks */

export const ps = (label: string, script: string, expect: Partial<Record<'equals' | 'contains' | 'notContains' | 'pattern' | 'equalsIgnoreCase', unknown>> & { machine?: string; message?: string; allowError?: boolean }): CheckSpec => ({ type: 'win.ps', label, script, ...expect });
export const ran = (label: string, pattern: string, message?: string): CheckSpec => ({ type: 'sh.ran', label, pattern, ...(message ? { message } : {}) });
export const answer = (label: string, file: string, contains: string | string[], message?: string): CheckSpec => ({ type: 'win.ps', label, script: `Get-Content "${file}"`, contains, ...(message ? { message } : {}) });
export const access = (label: string, path: string, user: string, equals: string): CheckSpec => ({ type: 'win.access', label, path, user, equals });
export const policy = (label: string, key: string, computer: string, equals: string | number | null, user?: string): CheckSpec => ({ type: 'win.policy', label, key, computer, equals, ...(user ? { user } : {}) });
export const extra = (label: string, setting: string, computer: string, equals: string | null, user?: string): CheckSpec => ({ type: 'win.policy', label, setting, computer, equals, ...(user ? { user } : {}) });

/* ----------------------------------------------------------------------------- text */

export { lab, mdSafe } from '../common';

export function task(t: BuiltTask): BuiltTask {
  return t;
}

export type { Variant, Person };

type UserCheck = { sam?: string; sams?: string[]; exists?: boolean; enabled?: boolean; hasPassword?: boolean; ou?: string; department?: string; groups?: string[]; message?: string };
type GroupCheck = { exists?: boolean; scope?: 'Global' | 'DomainLocal' | 'Universal'; members?: string[]; memberOf?: string[]; message?: string };
export const ouCheck = (label: string, dn: string, exists = true): CheckSpec => ({ type: 'win.ou', label, dn, ...(exists ? {} : { exists: false }) });
export const userCheck = (label: string, o: UserCheck): CheckSpec => ({ type: 'win.user', label, ...o });
export const groupCheck = (label: string, name: string, o: GroupCheck = {}): CheckSpec => ({ type: 'win.group', label, name, ...o });

/** OU DN under the domain root, from the top down: ou('Staff', 'Engineering') → OU=Staff,OU=Engineering,DC=... */
export function ouDn(...path: string[]): string {
  return [...path.map((p) => `OU=${p}`), DC].join(',');
}

/** A Security event on the DC. */
export function secEvent(id: number, message: string, data: Record<string, string>, time = '10/22/2026 08:15:00', level: 'Audit Success' | 'Audit Failure' = id === 4625 || id === 4771 ? 'Audit Failure' : 'Audit Success') {
  return { log: 'Security' as const, id, level, source: 'Microsoft-Windows-Security-Auditing', time, message, data };
}

export const PW = 'Welcome@2026';
export const SECURE = `$pw = ConvertTo-SecureString "${PW}" -AsPlainText -Force`;

/** A second domain controller (already promoted). */
export function dcN(net: string, name = 'DC02', last = 11, site = 'Default-First-Site-Name', extra: Partial<Machine> = {}): MachineSpec {
  return { name, dc: { gc: true, site }, features: ['AD-Domain-Services', 'DNS', 'RSAT-AD-PowerShell'], dns: { forwarders: [], rootHints: true }, services: { Spooler: running, W32Time: running, WinRM: running, LanmanServer: running, Dnscache: running, EventLog: running, DNS: running, NTDS: running, Netlogon: running, Kdc: running, BITS: { status: 'Stopped', start: 'Manual' } }, nics: [nic(`${net}.${last}`, net, { dns: [`${net}.10`] })], ...extra };
}

/** One template, shortened. */
export function tmpl(unit: number, topicIndex: number, level: 'beginner' | 'intermediate' | 'advanced', slug: string, title: string, engine: string, minutes: number, summary: string, build: (v: Variant) => BuiltTask) {
  return { id: `sa1-u${unit}t${topicIndex}-${level[0]}-${slug}`, course: COURSE, unit, topicIndex, level, title, engine, estimatedMinutes: minutes, summary, build };
}

/** Moves a machine's computer account into an OU (machines start in CN=Computers). */
export function placeComputer(st: AdState, name: string, ou: string): string {
  const c = st.computers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  const dn = `CN=${name},${ou}`;
  if (c) c.dn = dn;
  else st.computers.push({ name, dn, enabled: true, os: 'Windows 11 Pro', dnsHostName: `${name.toLowerCase()}.${DOMAIN}` });
  return dn;
}

/** A Group Policy registry setting check builder: the winning value for a user on a computer, or for the computer. */
export const HK = {
  noControlPanel: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer|NoControlPanel',
  noRun: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer|NoRun',
  disableTaskMgr: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System|DisableTaskMgr',
  ssActive: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop|ScreenSaveActive',
  ssTimeout: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop|ScreenSaveTimeOut',
  ssSecure: 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop|ScreenSaverIsSecure',
  loopback: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\System|UserPolicyMode',
  usbStor: 'HKLM\\System\\CurrentControlSet\\Services\\USBSTOR|Start',
  netcache: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\NetCache|Enabled',
  wuServer: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate|WUServer',
  wuStatus: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate|WUStatusServer',
  useWu: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU|UseWUServer',
  auOptions: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU|AUOptions',
  installDay: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU|ScheduledInstallDay',
  installTime: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU|ScheduledInstallTime',
  targetGroup: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate|TargetGroup',
  targetGroupOn: 'HKLM\\Software\\Policies\\Microsoft\\Windows\\WindowsUpdate|TargetGroupEnabled',
  autoEnroll: 'HKLM\\Software\\Policies\\Microsoft\\Cryptography\\AutoEnrollment|AEPolicy',
  fwDomain: 'HKLM\\Software\\Policies\\Microsoft\\WindowsFirewall\\DomainProfile|EnableFirewall',
  rdpDeny: 'HKLM\\Software\\Policies\\Microsoft\\Windows NT\\Terminal Services|fDenyTSConnections',
};

/** Set-GPRegistryValue for a "key|value" constant. */
export function gpSet(gpo: string, kv: string, type: 'DWord' | 'String', value: string | number): string {
  const [key, name] = kv.split('|');
  return `Set-GPRegistryValue -Name "${gpo}" -Key "${key}" -ValueName ${name} -Type ${type} -Value ${type === 'String' ? `"${value}"` : value}`;
}
