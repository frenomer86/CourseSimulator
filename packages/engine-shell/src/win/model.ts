/**
 * The Windows estate behind the PowerShell subset: Active Directory (with Group Policy, DNS zones
 * that are AD-integrated, password policies, sites and the recycle bin) and a set of machines, each
 * with its features, network settings, firewall, services, disks, shares, printers, events and
 * server roles (DHCP, DNS, FSRM, DFS, VSS, WSUS, WDS, AD CS, Hyper-V).
 *
 * Both stores are JSON files inside the simulated file system of the lab machine:
 *   /c/Windows/NTDS/ntds.json         the directory
 *   /c/Windows/Lab/estate.json        the machines
 * The first machine is the one the learner signs in to; its C: drive is the VFS path /c.
 * Other machines' drives live under /m/<name>/c.
 */

import { mkdir, readFile, writeFile, type DirNode } from '../fs.js';

export const NTDS = '/c/Windows/NTDS/ntds.json';
export const ESTATE = '/c/Windows/Lab/estate.json';
export const ROOT = { user: 'root', groups: ['root'] };

/* ----------------------------------------------------------------------------- directory */

export interface AdUser {
  sam: string;
  name: string;
  given?: string;
  surname?: string;
  upn?: string;
  dn: string;
  sid?: string;
  department?: string;
  title?: string;
  office?: string;
  description?: string;
  manager?: string;
  homeDirectory?: string;
  homeDrive?: string;
  profilePath?: string;
  enabled: boolean;
  hasPassword: boolean;
  lockedOut?: boolean;
  passwordNeverExpires?: boolean;
  cannotChangePassword?: boolean;
  changeAtLogon?: boolean;
  /** Last password set, in characters, so policies can be checked against it. */
  passwordLength?: number;
}

export interface AdGroup {
  name: string;
  dn: string;
  sid?: string;
  scope: 'Global' | 'DomainLocal' | 'Universal';
  category: 'Security' | 'Distribution';
  description?: string;
  /** Members as DNs. */
  members: string[];
}

export interface AdOu {
  name: string;
  dn: string;
  protected: boolean;
  description?: string;
}

export interface AdComputer {
  name: string;
  dn: string;
  sid?: string;
  enabled: boolean;
  os?: string;
  dnsHostName?: string;
}

export interface ServiceAccount {
  name: string;
  dn: string;
  dnsHostName?: string;
  principals: string[];
  installedOn: string[];
}

export interface PasswordPolicy {
  minLength: number;
  complexity: boolean;
  history: number;
  maxAgeDays: number;
  minAgeDays: number;
  lockoutThreshold: number;
  lockoutDurationMin: number;
  lockoutWindowMin: number;
}

export interface Fgpp extends PasswordPolicy {
  name: string;
  precedence: number;
  /** Groups or users (DNs) the policy applies to. */
  subjects: string[];
}

export interface GpoLink {
  target: string;
  enabled: boolean;
  enforced: boolean;
  order: number;
}

export interface Gpo {
  name: string;
  id: string;
  /** Registry-based settings: "HKLM\\Key|ValueName" → value. */
  computer: Record<string, string | number>;
  user: Record<string, string | number>;
  /** Named settings that are not registry-based: drive maps, printers, scripts, software, folder redirection. */
  extras: Record<string, string>;
  links: GpoLink[];
  /** Accounts with Apply Group Policy. Default: Authenticated Users. */
  apply: string[];
  userEnabled: boolean;
  computerEnabled: boolean;
  version: number;
  comment?: string;
}

export interface Delegation {
  ou: string;
  trustee: string;
  task: string;
}

export interface DnsRecord {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'PTR' | 'SRV' | 'NS' | 'TXT';
  data: string;
  ttl?: number;
}

export interface DnsZone {
  name: string;
  kind: 'Primary' | 'Secondary' | 'Stub' | 'Forwarder';
  adIntegrated: boolean;
  reverse: boolean;
  dynamicUpdate: 'None' | 'Secure' | 'NonsecureAndSecure';
  records: DnsRecord[];
  scavenging?: boolean;
}

export interface Site {
  name: string;
  subnets: string[];
  dcs: string[];
}

export interface AdState {
  domain: string;
  netbios: string;
  forestLevel: string;
  ous: AdOu[];
  users: AdUser[];
  groups: AdGroup[];
  computers: AdComputer[];
  serviceAccounts: ServiceAccount[];
  kdsRootKey: boolean;
  /** Kept for the first Windows lab; new tasks keep shares on machines. */
  shares: SmbShareRec[];
  passwordPolicy: PasswordPolicy;
  fgpps: Fgpp[];
  gpos: Gpo[];
  /** OU or domain DNs with inheritance blocked. */
  blocked: string[];
  delegations: Delegation[];
  zones: DnsZone[];
  sites: Site[];
  fsmo: Record<'SchemaMaster' | 'DomainNamingMaster' | 'PDCEmulator' | 'RIDMaster' | 'InfrastructureMaster', string>;
  recycleBin: boolean;
  deleted: Array<{ kind: 'user' | 'group' | 'ou' | 'computer'; obj: AdUser | AdGroup | AdOu | AdComputer }>;
  centralStore: boolean;
  caTemplates: string[];
  nextRid: number;
}

/* ----------------------------------------------------------------------------- machines */

export interface Nic {
  alias: string;
  mac: string;
  dhcp: boolean;
  ip?: string;
  prefix?: number;
  gateway?: string;
  dns: string[];
  ipv6?: string[];
  profile: 'Public' | 'Private' | 'DomainAuthenticated';
  up: boolean;
}

export interface FwRule {
  name: string;
  direction: 'Inbound' | 'Outbound';
  action: 'Allow' | 'Block';
  protocol: 'TCP' | 'UDP' | 'ICMPv4' | 'Any';
  ports: string;
  profiles: string[];
  remote: string;
  enabled: boolean;
  program?: string;
}

export interface Partition {
  letter?: string;
  sizeGb: number;
  fs?: 'NTFS' | 'ReFS' | 'FAT32';
  label?: string;
}

export interface Disk {
  number: number;
  sizeGb: number;
  style: 'RAW' | 'GPT' | 'MBR';
  online: boolean;
  partitions: Partition[];
  pooled?: string;
  friendlyName?: string;
}

export interface StoragePool {
  name: string;
  disks: number[];
  virtualDisks: Array<{ name: string; resiliency: 'Simple' | 'Mirror' | 'Parity'; sizeGb: number }>;
}

export interface SmbShareRec {
  name: string;
  path: string;
  server?: string;
  access: Array<{ account: string; right: 'Full' | 'Change' | 'Read' }>;
  abe?: boolean;
  caching?: string;
  description?: string;
}

export interface Ace {
  account: string;
  rights: 'FullControl' | 'Modify' | 'ReadAndExecute' | 'Read' | 'Write' | 'ListDirectory';
  type: 'Allow' | 'Deny';
  inherited?: boolean;
}

export interface Printer {
  name: string;
  driver: string;
  port: string;
  shared: boolean;
  shareName?: string;
  published: boolean;
  location?: string;
  jobs: Array<{ id: number; document: string; owner: string; status: 'Printing' | 'Error' | 'Spooling' | 'Paused' }>;
}

export interface WinEvent {
  log: 'Security' | 'System' | 'Application' | 'Directory Service' | 'DFS Replication';
  id: number;
  level: 'Information' | 'Warning' | 'Error' | 'Audit Success' | 'Audit Failure';
  source: string;
  time: string;
  message: string;
  data?: Record<string, string>;
}

export interface DhcpScope {
  id: string;
  name: string;
  start: string;
  end: string;
  mask: string;
  active: boolean;
  exclusions: Array<[string, string]>;
  reservations: Array<{ ip: string; mac: string; name?: string }>;
  options: { router?: string; dns?: string[]; domain?: string };
  leaseDays: number;
  leases: Array<{ ip: string; mac: string; host: string }>;
  failover?: { partner: string; mode: 'LoadBalance' | 'HotStandby' };
}

export interface ScheduledTask {
  name: string;
  action: string;
  trigger: string;
  user: string;
  enabled: boolean;
}

export interface Vm {
  name: string;
  memoryMb: number;
  generation: number;
  cpus: number;
  switch?: string;
  state: 'Off' | 'Running';
  checkpoints: string[];
  vhd?: string;
}

export interface Machine {
  name: string;
  os: string;
  installType: 'Server Core' | 'Desktop Experience' | 'Client';
  domain?: string;
  /** The DC role: domain controller of the domain, global catalogue? */
  dc?: { gc: boolean; site: string };
  features: string[];
  nics: Nic[];
  firewall: { enabled: Record<'Domain' | 'Private' | 'Public', boolean>; rules: FwRule[] };
  services: Record<string, { status: 'Running' | 'Stopped'; start: 'Automatic' | 'Manual' | 'Disabled' }>;
  disks: Disk[];
  pools: StoragePool[];
  shares: SmbShareRec[];
  ntfs: Record<string, { aces: Ace[]; inherit: boolean; owner?: string }>;
  printers: Printer[];
  drivers: string[];
  ports: Array<{ name: string; host: string }>;
  events: WinEvent[];
  tasks: ScheduledTask[];
  fsrm: { quotas: Array<{ path: string; sizeMb: number; soft: boolean; template?: string }>; screens: Array<{ path: string; groups: string[]; active: boolean }> };
  dfs: { roots: Array<{ path: string; type: string; folders: Array<{ path: string; targets: string[] }> }>; replication: Array<{ group: string; folder: string; members: string[] }> };
  shadows: Array<{ id: string; volume: string; time: string; files: Record<string, string> }>;
  timeOffsetMin: number;
  remoting: boolean;
  timeZone: string;
  activated: boolean;
  updatesPending: number;
  dhcp?: { authorized: boolean; scopes: DhcpScope[] };
  dns?: { forwarders: string[]; rootHints: boolean };
  wsus?: { contentDir?: string; groups: string[]; approved: Array<{ kb: string; group: string }>; updates: Array<{ kb: string; title: string; classification: string }> };
  wds?: { remInst?: string; bootImages: string[]; installImages: string[] };
  ca?: { name: string; type: string; keyLength: number; hash: string; years: number };
  rds?: { collections: Array<{ name: string; users: string[] }> };
  hyperv?: { switches: Array<{ name: string; type: 'External' | 'Internal' | 'Private' }>; vms: Vm[] };
  audit: Record<string, { success: boolean; failure: boolean }>;
  backups: Array<{ target: string; items: string; time: string; systemState: boolean }>;
  /** Group Policy last applied (gpupdate): GPO names for computer and user. */
  appliedGpos?: string[];
}

export interface Estate {
  machines: Machine[];
  /** Machine the learner is signed in to; changed by Enter-PSSession. */
  current: string;
}

/* ----------------------------------------------------------------------------- defaults */

export function domainDn(domain: string): string {
  return domain
    .split('.')
    .map((p) => `DC=${p}`)
    .join(',');
}

export const DEFAULT_POLICY: PasswordPolicy = { minLength: 7, complexity: true, history: 24, maxAgeDays: 42, minAgeDays: 1, lockoutThreshold: 0, lockoutDurationMin: 10, lockoutWindowMin: 10 };

let sidCounter = 0;
export function sidFor(st: Pick<AdState, 'nextRid'>, domainSid = 'S-1-5-21-3623811015-3361044348-30300820'): string {
  const rid = st.nextRid++;
  sidCounter++;
  return `${domainSid}-${rid}`;
}

export function newDirectory(domain: string, netbios: string, dcName = 'DC01'): AdState {
  const dc = domainDn(domain);
  const st: AdState = {
    domain,
    netbios,
    forestLevel: 'Windows2016Forest',
    ous: [{ name: 'Domain Controllers', dn: `OU=Domain Controllers,${dc}`, protected: true }],
    users: [],
    groups: [],
    computers: [],
    serviceAccounts: [],
    kdsRootKey: false,
    shares: [],
    passwordPolicy: { ...DEFAULT_POLICY },
    fgpps: [],
    gpos: [],
    blocked: [],
    delegations: [],
    zones: [],
    sites: [{ name: 'Default-First-Site-Name', subnets: [], dcs: [dcName] }],
    fsmo: { SchemaMaster: dcName, DomainNamingMaster: dcName, PDCEmulator: dcName, RIDMaster: dcName, InfrastructureMaster: dcName },
    recycleBin: false,
    deleted: [],
    centralStore: false,
    caTemplates: [],
    nextRid: 1103,
  };
  st.users.push({ sam: 'Administrator', name: 'Administrator', dn: `CN=Administrator,CN=Users,${dc}`, sid: `S-1-5-21-3623811015-3361044348-30300820-500`, enabled: true, hasPassword: true, passwordLength: 12 });
  st.users.push({ sam: 'Guest', name: 'Guest', dn: `CN=Guest,CN=Users,${dc}`, sid: `S-1-5-21-3623811015-3361044348-30300820-501`, enabled: false, hasPassword: false });
  const g = (name: string, scope: AdGroup['scope'], rid: number, members: string[] = []) => st.groups.push({ name, dn: `CN=${name},CN=Users,${dc}`, sid: `S-1-5-21-3623811015-3361044348-30300820-${rid}`, scope, category: 'Security', members });
  g('Domain Admins', 'Global', 512, [`CN=Administrator,CN=Users,${dc}`]);
  g('Domain Users', 'Global', 513, [`CN=Administrator,CN=Users,${dc}`]);
  g('Domain Computers', 'Global', 515);
  g('Domain Controllers', 'Global', 516);
  g('Enterprise Admins', 'Universal', 519, [`CN=Administrator,CN=Users,${dc}`]);
  g('Schema Admins', 'Universal', 518, [`CN=Administrator,CN=Users,${dc}`]);
  g('Group Policy Creator Owners', 'Global', 520, [`CN=Administrator,CN=Users,${dc}`]);
  g('Protected Users', 'Global', 525);
  g('Account Operators', 'DomainLocal', 548);
  g('Backup Operators', 'DomainLocal', 551);
  g('Print Operators', 'DomainLocal', 550);
  g('DnsAdmins', 'DomainLocal', 1101);
  g('DHCP Administrators', 'DomainLocal', 1102);
  st.computers.push({ name: dcName, dn: `CN=${dcName},OU=Domain Controllers,${dc}`, enabled: true, os: 'Windows Server 2022 Datacenter', dnsHostName: `${dcName.toLowerCase()}.${domain}` });
  st.gpos.push(newGpo('Default Domain Policy', [{ target: dc, enabled: true, enforced: false, order: 1 }]));
  st.gpos.push(newGpo('Default Domain Controllers Policy', [{ target: `OU=Domain Controllers,${dc}`, enabled: true, enforced: false, order: 1 }]));
  return st;
}

export function newGpo(name: string, links: GpoLink[] = []): Gpo {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0').slice(-w);
  return { name, id: `{${hex(h, 8)}-${hex(h >>> 3, 4)}-${hex(h >>> 7, 4)}-${hex(h >>> 11, 4)}-${hex(h * 7, 12)}}`, computer: {}, user: {}, extras: {}, links, apply: ['Authenticated Users'], userEnabled: true, computerEnabled: true, version: 0 };
}

export function newMachine(name: string, opts: Partial<Machine> = {}): Machine {
  return {
    name,
    os: 'Windows Server 2022 Datacenter',
    installType: 'Desktop Experience',
    features: [],
    nics: [{ alias: 'Ethernet', mac: macFor(name), dhcp: true, dns: [], profile: 'Public', up: true }],
    firewall: { enabled: { Domain: true, Private: true, Public: true }, rules: defaultRules() },
    services: defaultServices(),
    disks: [{ number: 0, sizeGb: 127, style: 'GPT', online: true, partitions: [{ letter: 'C', sizeGb: 126, fs: 'NTFS', label: '' }], friendlyName: 'Msft Virtual Disk' }],
    pools: [],
    shares: [],
    ntfs: {},
    printers: [],
    drivers: ['Microsoft Print To PDF', 'Microsoft enhanced Point and Print compatibility driver'],
    ports: [],
    events: [],
    tasks: [],
    fsrm: { quotas: [], screens: [] },
    dfs: { roots: [], replication: [] },
    shadows: [],
    timeOffsetMin: 0,
    remoting: true,
    timeZone: 'Greenwich Standard Time',
    activated: true,
    updatesPending: 0,
    audit: {},
    backups: [],
    ...opts,
  };
}

function macFor(name: string): string {
  let h = 7;
  for (const c of name) h = (h * 131 + c.charCodeAt(0)) >>> 0;
  const b = [0x00, 0x15, 0x5d, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
  return b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('-');
}

export function defaultRules(): FwRule[] {
  const r = (name: string, ports: string, protocol: FwRule['protocol'] = 'TCP', enabled = true): FwRule => ({ name, direction: 'Inbound', action: 'Allow', protocol, ports, profiles: ['Domain', 'Private'], remote: 'Any', enabled });
  return [
    r('Remote Desktop - User Mode (TCP-In)', '3389', 'TCP', false),
    r('Windows Remote Management (HTTP-In)', '5985'),
    r('File and Printer Sharing (SMB-In)', '445', 'TCP', false),
    r('File and Printer Sharing (Echo Request - ICMPv4-In)', 'Any', 'ICMPv4', false),
  ];
}

export function defaultServices(): Machine['services'] {
  const run = { status: 'Running' as const, start: 'Automatic' as const };
  return { Spooler: { ...run }, W32Time: { ...run }, WinRM: { ...run }, LanmanServer: { ...run }, Dnscache: { ...run }, EventLog: { ...run }, BITS: { status: 'Stopped', start: 'Manual' } };
}

/* ----------------------------------------------------------------------------- load and save */

export function loadAd(sys: { fs: DirNode }): AdState {
  try {
    return upgradeAd(JSON.parse(readFile(sys.fs, NTDS, ROOT)) as Partial<AdState>);
  } catch {
    return newDirectory('campus.local', 'CAMPUS');
  }
}

/** Older lab files only have users, groups, ous and shares: fill in the rest. */
export function upgradeAd(raw: Partial<AdState>): AdState {
  const base = newDirectory(raw.domain ?? 'campus.local', raw.netbios ?? 'CAMPUS');
  const st = { ...base, ...raw } as AdState;
  for (const k of Object.keys(base) as Array<keyof AdState>) if (st[k] === undefined) (st as unknown as Record<string, unknown>)[k] = base[k];
  for (const g of base.groups) if (!st.groups.some((x) => x.name === g.name)) st.groups.push(g);
  if (!st.gpos.length) st.gpos = base.gpos;
  if (!st.computers.length) st.computers = base.computers;
  return st;
}

export function saveAd(sys: { fs: DirNode; now: number }, st: AdState): void {
  mkdir(sys.fs, '/c/Windows/NTDS', ROOT, sys.now, true);
  writeFile(sys.fs, NTDS, JSON.stringify(st), ROOT, sys.now);
}

export function loadEstate(sys: { fs: DirNode; hostname: string }): Estate {
  try {
    return JSON.parse(readFile(sys.fs, ESTATE, ROOT)) as Estate;
  } catch {
    const m = newMachine(sys.hostname.toUpperCase(), { dc: { gc: true, site: 'Default-First-Site-Name' }, features: ['AD-Domain-Services', 'DNS', 'GPMC', 'RSAT-AD-PowerShell'], domain: 'campus.local' });
    return { machines: [m], current: m.name };
  }
}

export function saveEstate(sys: { fs: DirNode; now: number }, est: Estate): void {
  mkdir(sys.fs, '/c/Windows/Lab', ROOT, sys.now, true);
  writeFile(sys.fs, ESTATE, JSON.stringify(est), ROOT, sys.now);
}

/** VFS root of a machine's C: drive. The first machine is /c, others /m/<name>/c. */
export function driveRoot(est: Estate, machine: string, drive = 'c'): string {
  const first = est.machines[0]?.name.toLowerCase();
  const d = drive.toLowerCase();
  return machine.toLowerCase() === first ? `/${d}` : `/m/${machine.toLowerCase()}/${d}`;
}

/* ----------------------------------------------------------------------------- lab builders */

export interface WinLabSpec {
  domain?: string;
  netbios?: string;
  /** Edits applied to a fresh directory. */
  ad?: (st: AdState) => void;
  machines?: Array<Partial<Machine> & { name: string }>;
  /** Files on the first machine, as Windows paths: C:\\Onboarding\\a.csv → content. */
  files?: Record<string, string>;
  /** Files on other machines: { FS01: { 'D:\\Data\\x.txt': '...' } }. */
  machineFiles?: Record<string, Record<string, string>>;
  user?: string;
  cwd?: string;
  hostname?: string;
}

/** Builds the SystemSpec (for buildSystem) of a Windows lab. */
export function winSystemSpec(spec: WinLabSpec): Record<string, unknown> {
  const domain = spec.domain ?? 'campus.local';
  const netbios = spec.netbios ?? 'CAMPUS';
  const first = spec.hostname ?? spec.machines?.[0]?.name ?? 'DC01';
  const st = newDirectory(domain, netbios, first);
  const machines = (spec.machines?.length ? spec.machines : [{ name: first }]).map((m, i) =>
    newMachine(m.name, {
      ...(i === 0 ? { dc: { gc: true, site: 'Default-First-Site-Name' }, features: ['AD-Domain-Services', 'DNS', 'GPMC', 'RSAT-AD-PowerShell'], domain, dns: { forwarders: [], rootHints: true } } : { domain }),
      ...m,
    }),
  );
  for (const m of machines.slice(1)) if (m.domain && !st.computers.some((c) => c.name === m.name)) st.computers.push({ name: m.name, dn: `CN=${m.name},CN=Computers,${domainDn(domain)}`, enabled: true, os: m.os, dnsHostName: `${m.name.toLowerCase()}.${domain}` });
  const est: Estate = { machines, current: machines[0].name };
  spec.ad?.(st);
  if (!st.zones.length && machines[0].dc) {
    const dcIp = machines[0].nics[0]?.ip ?? '10.0.0.10';
    st.zones.push({ name: domain, kind: 'Primary', adIntegrated: true, reverse: false, dynamicUpdate: 'Secure', records: srvRecords(domain, machines.filter((m) => m.dc).map((m) => ({ name: m.name, ip: m.nics[0]?.ip ?? dcIp }))) });
    for (const m of machines.slice(1)) if (m.nics[0]?.ip) st.zones[0].records.push({ name: m.name.toLowerCase(), type: 'A', data: m.nics[0].ip });
  }
  const user = spec.user ?? 'Administrator';
  const files: Record<string, string> = {
    [NTDS]: JSON.stringify(st),
    [ESTATE]: JSON.stringify(est),
    '/c/Users/Administrator/Documents/README.txt': `Signed in to ${first} as ${netbios}\\${user}.\n`,
  };
  const toPath = (root: string, win: string) => root + '/' + win.replace(/^[A-Za-z]:\\?/, '').replace(/\\/g, '/');
  for (const [p, c] of Object.entries(spec.files ?? {})) {
    const drive = /^([A-Za-z]):/.exec(p)?.[1] ?? 'C';
    files[toPath(driveRoot(est, first, drive), p)] = c;
  }
  for (const [mname, fl] of Object.entries(spec.machineFiles ?? {})) for (const [p, c] of Object.entries(fl)) files[toPath(driveRoot(est, mname, /^([A-Za-z]):/.exec(p)?.[1] ?? 'C'), p)] = c;
  return {
    os: 'windows',
    hostname: first,
    user,
    cwd: spec.cwd ?? `/c/Users/${user}`,
    users: { [user]: { home: `/c/Users/${user}` } },
    files,
  };
}

export function srvRecords(domain: string, dcs: Array<{ name: string; ip: string }>): DnsRecord[] {
  const out: DnsRecord[] = [];
  for (const d of dcs) {
    out.push({ name: d.name.toLowerCase(), type: 'A', data: d.ip });
    out.push({ name: '_ldap._tcp.dc._msdcs', type: 'SRV', data: `0 100 389 ${d.name.toLowerCase()}.${domain}` });
    out.push({ name: '_kerberos._tcp.dc._msdcs', type: 'SRV', data: `0 100 88 ${d.name.toLowerCase()}.${domain}` });
    out.push({ name: '_ldap._tcp', type: 'SRV', data: `0 100 389 ${d.name.toLowerCase()}.${domain}` });
    out.push({ name: '_gc._tcp', type: 'SRV', data: `0 100 3268 ${d.name.toLowerCase()}.${domain}` });
  }
  out.push({ name: '@', type: 'NS', data: `${dcs[0]?.name.toLowerCase()}.${domain}` });
  return out;
}

/* ----------------------------------------------------------------------------- IPv4 helpers */

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return NaN;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
export function maskToPrefix(mask: string): number {
  const n = ipToInt(mask);
  let c = 0;
  for (let i = 31; i >= 0; i--) if ((n >>> i) & 1) c++;
  return c;
}
export function prefixToMask(p: number): string {
  return intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
}
export function sameSubnet(a: string, b: string, prefix: number): boolean {
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}
export function inCidr(ip: string, cidr: string): boolean {
  if (cidr === 'Any' || cidr === '*') return true;
  if (/^localsubnet$/i.test(cidr)) return true;
  const [net, len] = cidr.split('/');
  if (!len) return ip === net;
  return sameSubnet(ip, net, Number(len));
}
