/**
 * Active Directory cmdlets: domain, forest and DCs; OUs, users, groups, computers and managed
 * service accounts; LDAP filters; password and lockout policy including fine-grained policies;
 * sites, FSMO roles, promotion and domain join; the recycle bin; delegation, auditing and Kerberos.
 */

import { asList, bool, condition, isObj, isSecure, machine, machineByName, num, prop, register, registerNative, str, type Cx, type Env, type Obj, type Secure, type Value } from './core.js';
import { makeDate, parseDateText } from './lang.js';
import { dcRules as dcRulesFor, domainDn, sameSubnet, srvRecords, type AdComputer, type AdGroup, type AdOu, type AdState, type AdUser, type Fgpp, type PasswordPolicy, type WinEvent } from './model.js';

/* ----------------------------------------------------------------------------- lookups */

export function findUser(st: AdState, id: Value): AdUser | undefined {
  const s = str(isObj(id) ? (id as Obj).SamAccountName ?? (id as Obj).DistinguishedName ?? id : id).toLowerCase().replace(/^[^\\]+\\/, '');
  return st.users.find((u) => u.sam.toLowerCase() === s || u.dn.toLowerCase() === s || u.name.toLowerCase() === s || u.upn?.toLowerCase() === s);
}
export function findGroup(st: AdState, id: Value): AdGroup | undefined {
  const s = str(isObj(id) ? (id as Obj).Name ?? id : id).toLowerCase().replace(/^[^\\]+\\/, '');
  return st.groups.find((g) => g.name.toLowerCase() === s || g.dn.toLowerCase() === s);
}
export function findComputer(st: AdState, id: Value): AdComputer | undefined {
  const s = str(isObj(id) ? (id as Obj).Name ?? id : id).toLowerCase().replace(/\$$/, '').replace(/\..*$/, '');
  return st.computers.find((c) => c.name.toLowerCase() === s || c.dn.toLowerCase() === s);
}
export function findOu(st: AdState, id: Value): AdOu | undefined {
  const s = str(id).toLowerCase();
  return st.ous.find((o) => o.dn.toLowerCase() === s || o.name.toLowerCase() === s);
}
export function containerExists(st: AdState, dn: string): boolean {
  const d = dn.toLowerCase();
  const dc = domainDn(st.domain).toLowerCase();
  return d === dc || d === `cn=users,${dc}` || d === `cn=computers,${dc}` || d === `cn=managed service accounts,${dc}` || st.ous.some((o) => o.dn.toLowerCase() === d);
}
export const parentOf = (dn: string) => dn.slice(dn.indexOf(',') + 1);

/** Every group the object is in, directly or through nesting. */
export function groupsOf(st: AdState, dn: string): AdGroup[] {
  const out = new Map<string, AdGroup>();
  const queue = [dn];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of st.groups) if (g.members.includes(cur) && !out.has(g.dn)) {
      out.set(g.dn, g);
      queue.push(g.dn);
    }
  }
  if (st.users.some((u) => u.dn === dn)) {
    const du = st.groups.find((g) => g.name === 'Domain Users');
    if (du) out.set(du.dn, du);
  }
  return [...out.values()];
}

/** The password policy that applies to a user: the lowest-precedence FGPP among theirs, else the domain policy. */
export function resultantPolicy(st: AdState, u: AdUser): { policy: PasswordPolicy; source: string } {
  const mine = new Set([u.dn, ...groupsOf(st, u.dn).map((g) => g.dn)]);
  const direct = st.fgpps.filter((f) => f.subjects.includes(u.dn)).sort((a, b) => a.precedence - b.precedence);
  const viaGroups = st.fgpps.filter((f) => f.subjects.some((s) => mine.has(s))).sort((a, b) => a.precedence - b.precedence);
  const fg = direct[0] ?? viaGroups[0];
  return fg ? { policy: fg, source: fg.name } : { policy: st.passwordPolicy, source: 'Default Domain Policy' };
}

export function passwordProblem(p: PasswordPolicy, pw: string, u?: Pick<AdUser, 'sam' | 'name'>): string | null {
  if (pw.length < p.minLength) return `The password does not meet the length, complexity, or history requirement of the domain: at least ${p.minLength} characters are required.`;
  if (p.complexity) {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
    if (classes < 3) return 'The password does not meet the length, complexity, or history requirement of the domain: use three of upper case, lower case, digits and symbols.';
    if (u && u.sam.length >= 3 && pw.toLowerCase().includes(u.sam.toLowerCase())) return 'The password does not meet the length, complexity, or history requirement of the domain: it may not contain the account name.';
  }
  return null;
}

const SID_BASE = 'S-1-5-21-3623811015-3361044348-30300820';
const nextSid = (st: AdState) => `${SID_BASE}-${st.nextRid++}`;

export function audit(env: Env, sub: string, ev: Omit<WinEvent, 'log' | 'time' | 'level'> & { level?: WinEvent['level'] }): void {
  const dc = env.est.machines.find((m) => m.dc) ?? env.est.machines[0];
  const a = dc.audit[sub];
  if (!a?.success) return;
  dc.events.push({ log: 'Security', time: '10/22/2026 09:30:00', level: 'Audit Success', ...ev });
  env.dirtyEst = true;
}

/* ----------------------------------------------------------------------------- views */

const PROPS_EXTRA: Record<string, (u: AdUser, st: AdState) => Value> = {
  department: (u) => u.department ?? '',
  title: (u) => u.title ?? '',
  office: (u) => u.office ?? '',
  description: (u) => u.description ?? '',
  homedirectory: (u) => u.homeDirectory ?? '',
  homedrive: (u) => u.homeDrive ?? '',
  profilepath: (u) => u.profilePath ?? '',
  lockedout: (u) => !!u.lockedOut,
  passwordneverexpires: (u) => !!u.passwordNeverExpires,
  memberof: (u, st) => st.groups.filter((g) => g.members.includes(u.dn)).map((g) => g.dn),
  manager: (u) => u.manager ?? '',
  mail: (u) => `${u.sam}@${(u.upn ?? '').split('@')[1] ?? ''}`,
  lastlogondate: (u) => (u.lastLogon ? makeDate(parseDateText(u.lastLogon) ?? 0) : null),
  whencreated: (u) => makeDate(parseDateText(u.whenCreated ?? '2025-09-01T08:00:00') ?? 0),
  // pwdLastSet 0 means "must change password at next logon".
  pwdlastset: (u) => (u.changeAtLogon ? 0 : u.hasPassword ? 134058822000000000 : 0),
  passwordlastset: (u) => (u.changeAtLogon || !u.hasPassword ? null : makeDate(Date.UTC(2026, 9, 1, 8, 0))),
};
const KEY_NAMES: Record<string, string> = { department: 'Department', title: 'Title', office: 'Office', description: 'Description', homedirectory: 'HomeDirectory', homedrive: 'HomeDrive', profilepath: 'ProfilePath', lockedout: 'LockedOut', passwordneverexpires: 'PasswordNeverExpires', memberof: 'MemberOf', manager: 'Manager', mail: 'mail', lastlogondate: 'LastLogonDate', whencreated: 'whenCreated', pwdlastset: 'pwdLastSet', passwordlastset: 'PasswordLastSet' };

export function userView(u: AdUser, st: AdState, props: string[] = []): Obj {
  const o: Obj = { __type: 'ADUser', DistinguishedName: u.dn, Enabled: u.enabled, GivenName: u.given ?? '', Name: u.name, ObjectClass: 'user', SamAccountName: u.sam, SID: u.sid ?? '', Surname: u.surname ?? '', UserPrincipalName: u.upn ?? '' };
  const all = props.some((p) => p === '*');
  for (const [k, f] of Object.entries(PROPS_EXTRA)) if (all || props.some((p) => p.toLowerCase() === k)) o[KEY_NAMES[k]] = f(u, st);
  return o;
}
export function groupView(g: AdGroup): Obj {
  return { __type: 'ADGroup', DistinguishedName: g.dn, GroupCategory: g.category, GroupScope: g.scope, Name: g.name, ObjectClass: 'group', SamAccountName: g.name, SID: g.sid ?? '' };
}
function ouView(o: AdOu): Obj {
  return { __type: 'ADOU', DistinguishedName: o.dn, Name: o.name, ObjectClass: 'organizationalUnit', ProtectedFromAccidentalDeletion: o.protected };
}
function computerView(c: AdComputer): Obj {
  return { __type: 'ADComputer', DistinguishedName: c.dn, DNSHostName: c.dnsHostName ?? '', Enabled: c.enabled, Name: c.name, ObjectClass: 'computer', SamAccountName: `${c.name}$`, OperatingSystem: c.os ?? '' };
}

/* ----------------------------------------------------------------------------- LDAP filters */

type Ldap = { op: '&' | '|' | '!'; parts: Ldap[] } | { attr: string; cmp: '=' | '>=' | '<=' | 'bit'; value: string };

export function parseLdap(src: string): Ldap {
  let i = 0;
  const s = src.trim();
  const expr = (): Ldap => {
    if (s[i] !== '(') throw new Error(`LDAP filter: expected "(" at position ${i + 1}.`);
    i++;
    if (s[i] === '&' || s[i] === '|' || s[i] === '!') {
      const op = s[i++] as '&' | '|' | '!';
      const parts: Ldap[] = [];
      while (s[i] === '(') parts.push(expr());
      if (s[i] !== ')') throw new Error('LDAP filter: missing ")".');
      i++;
      return { op, parts };
    }
    const end = s.indexOf(')', i);
    if (end < 0) throw new Error('LDAP filter: missing ")".');
    const body = s.slice(i, end);
    i = end + 1;
    const bit = /^([\w-]+):1\.2\.840\.113556\.1\.4\.80[34]:=(\d+)$/.exec(body);
    if (bit) return { attr: bit[1], cmp: 'bit', value: bit[2] };
    const m = /^([\w-]+)(>=|<=|=)(.*)$/.exec(body);
    if (!m) throw new Error(`LDAP filter: cannot read "${body}".`);
    return { attr: m[1], cmp: m[2] as '=', value: m[3] };
  };
  const f = expr();
  if (i !== s.length) throw new Error('LDAP filter: unexpected text after the filter.');
  return f;
}

type AdObj = { kind: 'user'; o: AdUser } | { kind: 'group'; o: AdGroup } | { kind: 'computer'; o: AdComputer } | { kind: 'ou'; o: AdOu };

function ldapAttr(st: AdState, x: AdObj, attr: string): string[] {
  const a = attr.toLowerCase();
  const o = x.o as unknown as Record<string, unknown>;
  if (a === 'objectclass') return x.kind === 'user' ? ['top', 'person', 'organizationalPerson', 'user'] : x.kind === 'group' ? ['top', 'group'] : x.kind === 'computer' ? ['top', 'person', 'organizationalPerson', 'user', 'computer'] : ['top', 'organizationalUnit'];
  if (a === 'objectcategory') return [x.kind === 'user' ? 'person' : x.kind === 'ou' ? 'organizationalUnit' : x.kind];
  if (a === 'samaccountname') return [x.kind === 'computer' ? `${x.o.name}$` : x.kind === 'user' ? (x.o as AdUser).sam : x.o.name];
  if (a === 'cn' || a === 'name') return [x.o.name];
  if (a === 'ou' && x.kind === 'ou') return [x.o.name];
  if (a === 'distinguishedname') return [x.o.dn];
  if (a === 'givenname') return [(o.given as string) ?? ''];
  if (a === 'sn') return [(o.surname as string) ?? ''];
  if (a === 'department' || a === 'title' || a === 'description') return [(o[a] as string) ?? ''];
  if (a === 'physicaldeliveryofficename') return [(o.office as string) ?? ''];
  if (a === 'userprincipalname') return [(o.upn as string) ?? ''];
  if (a === 'memberof') return st.groups.filter((g) => g.members.includes(x.o.dn)).map((g) => g.dn);
  if (a === 'member' && x.kind === 'group') return (x.o as AdGroup).members;
  if (a === 'useraccountcontrol') return [String((x.kind === 'user' || x.kind === 'computer') && !(x.o as AdUser).enabled ? 514 : 512)];
  if (a === 'grouptype' && x.kind === 'group') {
    const g = x.o as AdGroup;
    return [String((g.scope === 'Global' ? 2 : g.scope === 'DomainLocal' ? 4 : 8) | (g.category === 'Security' ? 0x80000000 : 0))];
  }
  return [];
}

function ldapMatch(st: AdState, x: AdObj, f: Ldap): boolean {
  if ('op' in f) return f.op === '&' ? f.parts.every((p) => ldapMatch(st, x, p)) : f.op === '|' ? f.parts.some((p) => ldapMatch(st, x, p)) : !ldapMatch(st, x, f.parts[0]);
  const vals = ldapAttr(st, x, f.attr);
  if (f.cmp === 'bit') return vals.some((v) => ((Number(v) >>> 0) & Number(f.value)) !== 0);
  if (f.cmp === '=' && f.value === '*') return vals.some((v) => v !== '');
  if (f.cmp === '>=' || f.cmp === '<=') return vals.some((v) => (f.cmp === '>=' ? Number(v) >= Number(f.value) : Number(v) <= Number(f.value)));
  const re = new RegExp('^' + f.value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return vals.some((v) => re.test(v));
}

function allObjects(st: AdState): AdObj[] {
  return [...st.users.map((o) => ({ kind: 'user' as const, o })), ...st.groups.map((o) => ({ kind: 'group' as const, o })), ...st.computers.map((o) => ({ kind: 'computer' as const, o })), ...st.ous.map((o) => ({ kind: 'ou' as const, o }))];
}

function ldapSearch(cx: Cx, kinds: AdObj['kind'][]): AdObj[] {
  let f: Ldap;
  try {
    f = parseLdap(str(cx.P.ldapfilter));
  } catch (e) {
    return cx.fail(`The search filter cannot be recognized. ${(e as Error).message}`);
  }
  const base = cx.P.searchbase !== undefined ? str(cx.P.searchbase).toLowerCase() : null;
  return allObjects(cx.env.st).filter((x) => kinds.includes(x.kind) && (!base || x.o.dn.toLowerCase() === base || x.o.dn.toLowerCase().endsWith(',' + base)) && ldapMatch(cx.env.st, x, f));
}

/* ----------------------------------------------------------------------------- helpers */

function nestingProblem(group: AdGroup, member: AdUser | AdGroup | AdComputer): string | null {
  if (!('scope' in member)) return null;
  if (member.dn === group.dn) return 'A group cannot be a member of itself.';
  if (group.scope === 'Global' && member.scope !== 'Global') return `A ${member.scope} group cannot be a member of a Global group. Global groups hold accounts and other Global groups (the G in AGDLP).`;
  if (group.scope === 'Universal' && member.scope === 'DomainLocal') return 'A DomainLocal group cannot be a member of a Universal group.';
  return null;
}

function identityOf(cx: Cx): Value {
  return cx.P.identity ?? cx.pos[0] ?? (cx.input?.length ? cx.input[0] : undefined) ?? cx.fail("Cannot validate argument on parameter 'Identity'. The argument is null.");
}

function targets(cx: Cx): Value[] {
  if (cx.P.identity === undefined && cx.pos[0] === undefined && cx.input?.length) return cx.input;
  return asList(identityOf(cx));
}

function dcOf(cx: Cx) {
  return cx.env.est.machines.find((m) => m.dc) ?? cx.env.est.machines[0];
}

function lockoutFromEvents(env: Env, u: AdUser): void {
  const p = resultantPolicy(env.st, u).policy;
  if (p.lockoutThreshold > 0) {
    const fails = dcOfEnv(env).events.filter((e) => e.id === 4625 && e.data?.TargetUserName?.toLowerCase() === u.sam.toLowerCase()).length;
    if (fails >= p.lockoutThreshold) u.lockedOut = true;
  }
}
const dcOfEnv = (env: Env) => env.est.machines.find((m) => m.dc) ?? env.est.machines[0];

/* ----------------------------------------------------------------------------- cmdlets */

register(
  {
    'get-addomain': (cx) => {
      const st = cx.env.st;
      const dc = domainDn(st.domain);
      return [{ __type: 'ADDomain', DistinguishedName: dc, DNSRoot: st.domain, NetBIOSName: st.netbios, DomainMode: 'Windows2016Domain', PDCEmulator: `${st.fsmo.PDCEmulator}.${st.domain}`, RIDMaster: `${st.fsmo.RIDMaster}.${st.domain}`, InfrastructureMaster: `${st.fsmo.InfrastructureMaster}.${st.domain}`, UsersContainer: `CN=Users,${dc}`, ComputersContainer: `CN=Computers,${dc}` }];
    },
    'get-adforest': (cx) => {
      const st = cx.env.st;
      return [{ __type: 'ADForest', Name: st.domain, RootDomain: st.domain, Domains: [st.domain], ForestMode: st.forestLevel, SchemaMaster: `${st.fsmo.SchemaMaster}.${st.domain}`, DomainNamingMaster: `${st.fsmo.DomainNamingMaster}.${st.domain}`, GlobalCatalogs: cx.env.est.machines.filter((m) => m.dc?.gc).map((m) => `${m.name}.${st.domain}`), Sites: st.sites.map((s) => s.name), UPNSuffixes: st.upnSuffixes ?? [] }];
    },
    'set-adforest': (cx) => {
      const st = cx.env.st;
      const v = cx.P.upnsuffixes;
      if (!isObj(v)) cx.fail('Use Set-ADForest -Identity <forest> -UPNSuffixes @{Add="example.edu.gh"} (or Remove=).');
      const o = v as Obj;
      const list = new Set(st.upnSuffixes ?? []);
      for (const s of asList(o.Add ?? o.add).map(str)) {
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) cx.fail(`${s} is not a valid DNS suffix.`);
        list.add(s.toLowerCase());
      }
      for (const s of asList(o.Remove ?? o.remove).map(str)) list.delete(s.toLowerCase());
      st.upnSuffixes = [...list];
      cx.env.dirtyAd = true;
      return [];
    },
    'get-addomaincontroller': (cx) => {
      const st = cx.env.st;
      const dcs = cx.env.est.machines.filter((m) => m.dc);
      const filter = cx.P.filter;
      const want = cx.P.identity ?? cx.pos[0];
      return dcs
        .filter((m) => !want || m.name.toLowerCase() === str(want).toLowerCase().replace(/\..*$/, ''))
        .filter(() => filter === undefined || true)
        .map((m) => ({ __type: 'ADDC', Name: m.name, HostName: `${m.name.toLowerCase()}.${st.domain}`, IPv4Address: m.nics[0]?.ip ?? '', IsGlobalCatalog: !!m.dc!.gc, Site: m.dc!.site, OperationMasterRoles: Object.entries(st.fsmo).filter(([, v]) => v.toLowerCase() === m.name.toLowerCase()).map(([k]) => k) }));
    },
    'move-addirectoryserveroperationmasterrole': (cx) => {
      const st = cx.env.st;
      const target = str(cx.P.identity ?? cx.pos[0]).replace(/\..*$/, '');
      const m = machineByName(cx.env, target);
      if (!m?.dc) cx.fail(`${target} is not a domain controller of ${st.domain}.`);
      const roles = asList(cx.P.operationmasterrole ?? cx.pos[1]).map(str);
      const names: Record<string, keyof AdState['fsmo']> = { schemamaster: 'SchemaMaster', '0': 'PDCEmulator', domainnamingmaster: 'DomainNamingMaster', pdcemulator: 'PDCEmulator', ridmaster: 'RIDMaster', infrastructuremaster: 'InfrastructureMaster', '1': 'RIDMaster', '2': 'InfrastructureMaster', '3': 'SchemaMaster', '4': 'DomainNamingMaster' };
      for (const r of roles) {
        const key = names[r.toLowerCase()];
        if (!key) cx.fail(`Unknown operation master role ${r}. Use PDCEmulator, RIDMaster, InfrastructureMaster, SchemaMaster or DomainNamingMaster.`);
        st.fsmo[key] = m!.name;
      }
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adrootdse': (cx) => [{ __type: 'rootdse', defaultNamingContext: domainDn(cx.env.st.domain), configurationNamingContext: `CN=Configuration,${domainDn(cx.env.st.domain)}`, dnsHostName: `${dcOf(cx).name.toLowerCase()}.${cx.env.st.domain}`, isGlobalCatalogReady: true }],

    /* ------------------------------------------------------------ OUs */
    'new-adorganizationalunit': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (!n) cx.fail("Cannot validate argument on parameter 'Name'.");
      const parent = str(cx.P.path ?? domainDn(st.domain));
      if (!containerExists(st, parent)) cx.fail(`Directory object not found: ${parent}. Create the parent OU first, or check the -Path DN.`);
      const dn = `OU=${n},${parent}`;
      if (st.ous.some((o) => o.dn.toLowerCase() === dn.toLowerCase())) cx.fail('An attempt was made to add an object to the directory with a name that is already in use.');
      st.ous.push({ name: n, dn, protected: cx.P.protectedfromaccidentaldeletion === undefined ? true : bool(cx.P.protectedfromaccidentaldeletion), description: cx.P.description !== undefined ? str(cx.P.description) : undefined });
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adorganizationalunit': (cx) => {
      const st = cx.env.st;
      if (cx.P.ldapfilter !== undefined) return ldapSearch(cx, ['ou']).map((x) => ouView(x.o as AdOu));
      const id = cx.P.identity ?? cx.pos[0];
      if (id !== undefined && cx.P.filter === undefined) {
        const o = findOu(st, id);
        return o ? [ouView(o)] : cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
      }
      const base = cx.P.searchbase !== undefined ? str(cx.P.searchbase).toLowerCase() : null;
      return st.ous.filter((o) => !base || o.dn.toLowerCase().endsWith(',' + base) || o.dn.toLowerCase() === base).map(ouView).filter((o) => condition(cx.env, str(cx.P.filter ?? '*'), o, true));
    },
    'set-adorganizationalunit': (cx) => {
      const o = findOu(cx.env.st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      if (cx.P.protectedfromaccidentaldeletion !== undefined) o.protected = bool(cx.P.protectedfromaccidentaldeletion);
      if (cx.P.description !== undefined) o.description = str(cx.P.description);
      cx.env.dirtyAd = true;
      return [];
    },
    'set-adobject': (cx) => {
      const st = cx.env.st;
      const id = str(identityOf(cx)).toLowerCase();
      const o = st.ous.find((x) => x.dn.toLowerCase() === id);
      if (!o) cx.fail(`Cannot find an object with identity: '${id}'.`);
      if (cx.P.protectedfromaccidentaldeletion !== undefined) o!.protected = bool(cx.P.protectedfromaccidentaldeletion);
      cx.env.dirtyAd = true;
      return [];
    },
    'remove-adorganizationalunit': (cx) => {
      const st = cx.env.st;
      const o = findOu(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      if (o.protected) cx.fail('Access is denied. The OU is protected from accidental deletion: Set-ADOrganizationalUnit -Identity <DN> -ProtectedFromAccidentalDeletion $false first.');
      const inside = (dn: string) => dn.toLowerCase().endsWith(',' + o.dn.toLowerCase());
      if ([...st.users, ...st.groups, ...st.ous, ...st.computers].some((x) => inside(x.dn)) && !cx.P.recursive) cx.fail('The directory service can perform the requested operation only on a leaf object. The OU is not empty (use -Recursive).');
      st.ous = st.ous.filter((x) => x !== o && !inside(x.dn));
      st.users = st.users.filter((x) => !inside(x.dn));
      st.groups = st.groups.filter((x) => !inside(x.dn));
      if (st.recycleBin) st.deleted.push({ kind: 'ou', obj: o });
      cx.env.dirtyAd = true;
      return [];
    },

    /* ------------------------------------------------------------ users */
    'new-aduser': (cx) => {
      const env = cx.env;
      const st = env.st;
      const tmpl = isObj(cx.P.instance) ? findUser(st, cx.P.instance) : undefined;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (!n) cx.fail("Cannot validate argument on parameter 'Name'. The argument is null or empty.");
      const sam = str(cx.P.samaccountname ?? n);
      if (sam.length > 20) cx.fail(`The SamAccountName "${sam}" is longer than 20 characters.`);
      if (/[\s"/\\[\]:;|=,+*?<>]/.test(sam)) cx.fail(`The SamAccountName "${sam}" contains characters that are not allowed.`);
      if (st.users.some((u) => u.sam.toLowerCase() === sam.toLowerCase()) || st.groups.some((g) => g.name.toLowerCase() === sam.toLowerCase())) cx.fail('The specified account already exists');
      const parent = str(cx.P.path ?? (tmpl ? parentOf(tmpl.dn) : `CN=Users,${domainDn(st.domain)}`));
      if (!containerExists(st, parent)) cx.fail(`Directory object not found: ${parent}.`);
      const pw = cx.P.accountpassword;
      if (pw !== undefined && !isSecure(pw)) cx.fail("Cannot bind parameter 'AccountPassword': use ConvertTo-SecureString to make a SecureString.");
      if (pw) {
        const problem = passwordProblem(st.passwordPolicy, (pw as Secure).plain, { sam, name: n });
        if (problem) cx.fail(problem);
      }
      const enabled = cx.P.enabled === undefined ? false : bool(cx.P.enabled);
      if (enabled && !pw) cx.fail('The password does not meet the length, complexity, or history requirement of the domain. (An enabled account needs -AccountPassword.)');
      const dn = `CN=${n},${parent}`;
      if ([...st.users, ...st.groups].some((x) => x.dn.toLowerCase() === dn.toLowerCase())) cx.fail('An attempt was made to add an object to the directory with a name that is already in use.');
      const sv = (k: string, from?: string) => (cx.P[k] !== undefined ? str(cx.P[k]) : from);
      const expand = (v?: string) => v?.replace(/%username%/gi, sam);
      const u: AdUser = {
        sam,
        name: n,
        given: sv('givenname'),
        surname: sv('surname'),
        upn: sv('userprincipalname') ?? `${sam}@${st.domain}`,
        dn,
        sid: nextSid(st),
        department: sv('department', tmpl?.department),
        title: sv('title', tmpl?.title),
        office: sv('office', tmpl?.office),
        description: sv('description', tmpl?.description),
        homeDirectory: expand(sv('homedirectory', tmpl?.homeDirectory)),
        homeDrive: sv('homedrive', tmpl?.homeDrive),
        profilePath: expand(sv('profilepath', tmpl?.profilePath)),
        enabled,
        hasPassword: !!pw,
        passwordLength: pw ? (pw as Secure).plain.length : undefined,
        changeAtLogon: cx.P.changepasswordatlogon !== undefined ? bool(cx.P.changepasswordatlogon) : undefined,
        passwordNeverExpires: cx.P.passwordneverexpires !== undefined ? bool(cx.P.passwordneverexpires) : undefined,
      };
      st.users.push(u);
      if (tmpl) for (const g of st.groups) if (g.members.includes(tmpl.dn) && g.name !== 'Domain Users') g.members.push(dn);
      st.groups.find((g) => g.name === 'Domain Users')?.members.push(dn);
      audit(env, 'User Account Management', { id: 4720, source: 'Microsoft-Windows-Security-Auditing', message: `A user account was created. New Account: ${st.netbios}\\${sam}`, data: { TargetUserName: sam, SubjectUserName: env.sys.user } });
      env.dirtyAd = true;
      return cx.P.passthru ? [userView(u, st)] : [];
    },
    'get-aduser': (cx) => {
      const st = cx.env.st;
      const props = asList(cx.P.properties).map(str);
      if (cx.P.ldapfilter !== undefined) return ldapSearch(cx, ['user']).map((x) => userView(x.o as AdUser, st, props));
      const id = cx.P.identity ?? (cx.pos[0] !== undefined && cx.P.filter === undefined ? cx.pos[0] : undefined);
      if (id !== undefined) {
        const u = findUser(st, id);
        return u ? [userView(u, st, props)] : cx.fail(`Cannot find an object with identity: '${str(id)}' under: '${domainDn(st.domain)}'.`);
      }
      if (cx.P.filter === undefined) cx.fail('Use -Identity <name>, -Filter or -LDAPFilter, for example Get-ADUser -Filter *');
      const base = cx.P.searchbase !== undefined ? str(cx.P.searchbase).toLowerCase() : null;
      const oneLevel = str(cx.P.searchscope).toLowerCase() === 'onelevel';
      return st.users
        .filter((u) => !base || (oneLevel ? parentOf(u.dn).toLowerCase() === base : u.dn.toLowerCase().endsWith(',' + base)))
        .filter((u) => condition(cx.env, str(cx.P.filter), userView(u, st, ['*']), true))
        .map((u) => userView(u, st, props));
    },
    'set-aduser': (cx) => {
      const st = cx.env.st;
      for (const id of targets(cx)) {
        const u = findUser(st, id) ?? cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
        const set = (k: string, f: keyof AdUser) => {
          if (cx.P[k] !== undefined) (u as unknown as Record<string, unknown>)[f] = str(cx.P[k]).replace(/%username%/gi, u.sam);
        };
        set('department', 'department');
        set('title', 'title');
        set('office', 'office');
        set('description', 'description');
        set('givenname', 'given');
        set('surname', 'surname');
        set('homedirectory', 'homeDirectory');
        set('homedrive', 'homeDrive');
        set('profilepath', 'profilePath');
        if (cx.P.userprincipalname !== undefined) {
          const suffix = str(cx.P.userprincipalname).split('@')[1]?.toLowerCase();
          if (!suffix) cx.fail('A UPN looks like name@suffix.');
          if (suffix !== st.domain.toLowerCase() && !(st.upnSuffixes ?? []).includes(suffix!)) cx.fail(`The UPN suffix ${suffix} is not one of this forest's UPN suffixes. Add it first: Set-ADForest -Identity ${st.domain} -UPNSuffixes @{Add="${suffix}"}`);
        }
        set('userprincipalname', 'upn');
        if (cx.P.manager !== undefined) u.manager = findUser(st, cx.P.manager)?.dn ?? cx.fail(`Cannot find an object with identity: '${str(cx.P.manager)}'.`);
        if (cx.P.passwordneverexpires !== undefined) u.passwordNeverExpires = bool(cx.P.passwordneverexpires);
        if (cx.P.changepasswordatlogon !== undefined) u.changeAtLogon = bool(cx.P.changepasswordatlogon);
        if (cx.P.enabled !== undefined) u.enabled = bool(cx.P.enabled);
        const rep = cx.P.replace;
        if (isObj(rep)) for (const [k, v] of Object.entries(rep)) if (k !== '__type') (u as unknown as Record<string, unknown>)[k.toLowerCase() === 'physicaldeliveryofficename' ? 'office' : k.toLowerCase()] = str(v);
      }
      cx.env.dirtyAd = true;
      return [];
    },
    'remove-aduser': (cx) => {
      const st = cx.env.st;
      const u = findUser(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      st.users = st.users.filter((x) => x !== u);
      for (const g of st.groups) g.members = g.members.filter((m) => m !== u.dn);
      if (st.recycleBin) st.deleted.push({ kind: 'user', obj: u });
      audit(cx.env, 'User Account Management', { id: 4726, source: 'Microsoft-Windows-Security-Auditing', message: `A user account was deleted. Target Account: ${st.netbios}\\${u.sam}`, data: { TargetUserName: u.sam } });
      cx.env.dirtyAd = true;
      return [];
    },
    'enable-adaccount': (cx) => accountState(cx, true),
    'disable-adaccount': (cx) => accountState(cx, false),
    'unlock-adaccount': (cx) => {
      for (const id of targets(cx)) {
        const u = findUser(cx.env.st, id) ?? cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
        u.lockedOut = false;
        dcOf(cx).events = dcOf(cx).events.filter((e) => !(e.id === 4625 && e.data?.TargetUserName?.toLowerCase() === u.sam.toLowerCase()));
        audit(cx.env, 'User Account Management', { id: 4767, source: 'Microsoft-Windows-Security-Auditing', message: `A user account was unlocked. Target Account: ${u.sam}`, data: { TargetUserName: u.sam } });
      }
      cx.env.dirtyAd = true;
      cx.env.dirtyEst = true;
      return [];
    },
    'set-adaccountpassword': (cx) => {
      const st = cx.env.st;
      const u = findUser(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      const pw = cx.P.newpassword;
      if (!isSecure(pw)) cx.fail("Use -Reset -NewPassword (ConvertTo-SecureString 'password' -AsPlainText -Force).");
      const problem = passwordProblem(resultantPolicy(st, u).policy, (pw as Secure).plain, u);
      if (problem) cx.fail(problem);
      u.hasPassword = true;
      u.passwordLength = (pw as Secure).plain.length;
      cx.env.dirtyAd = true;
      return [];
    },
    'search-adaccount': (cx) => {
      const st = cx.env.st;
      for (const u of st.users) lockoutFromEvents(cx.env, u);
      let list = st.users;
      if (cx.P.lockedout) list = list.filter((u) => u.lockedOut);
      if (cx.P.accountdisabled) list = list.filter((u) => !u.enabled);
      if (cx.P.passwordneverexpires) list = list.filter((u) => u.passwordNeverExpires);
      if (cx.P.accountinactive) {
        // -TimeSpan 90.00:00:00 (default 15 days in the real cmdlet; labs pass it explicitly).
        const span = cx.P.timespan !== undefined ? spanDays(cx.P.timespan) : 15;
        const cutoff = cx.env.sys.now - span * 86400000;
        list = list.filter((u) => (u as AdUser & { inactive?: boolean }).inactive || (u.lastLogon !== undefined && (parseDateText(u.lastLogon) ?? 0) < cutoff) || (u.lastLogon === undefined && u.whenCreated !== undefined && (parseDateText(u.whenCreated) ?? 0) < cutoff));
      }
      if (cx.P.usersonly === undefined && !cx.P.lockedout && !cx.P.accountdisabled && !cx.P.passwordneverexpires && !cx.P.accountinactive) cx.fail('Search-ADAccount needs -LockedOut, -AccountDisabled, -AccountInactive or -PasswordNeverExpires.');
      return list.map((u) => ({ __type: 'select', Name: u.name, SamAccountName: u.sam, Enabled: u.enabled, LockedOut: !!u.lockedOut, DistinguishedName: u.dn, __extra: { LastLogonDate: u.lastLogon ? makeDate(parseDateText(u.lastLogon) ?? 0) : null } }));
    },
    'move-adobject': (cx) => {
      const st = cx.env.st;
      const id = str(identityOf(cx)).toLowerCase();
      const target = str(cx.P.targetpath ?? cx.pos[1]);
      if (!containerExists(st, target)) cx.fail(`Directory object not found: ${target}.`);
      const obj = [...st.users, ...st.groups, ...st.computers].find((x) => x.dn.toLowerCase() === id || x.name.toLowerCase() === id || ('sam' in x && x.sam.toLowerCase() === id));
      const ou = st.ous.find((x) => x.dn.toLowerCase() === id);
      if (!obj && !ou) cx.fail(`Cannot find an object with identity: '${id}'.`);
      if (ou) {
        if (ou.protected) cx.fail('Access is denied: the OU is protected from accidental deletion, which also blocks moving it.');
        const old = ou.dn;
        ou.dn = `OU=${ou.name},${target}`;
        for (const x of [...st.users, ...st.groups, ...st.computers, ...st.ous]) if (x.dn.toLowerCase().endsWith(',' + old.toLowerCase())) x.dn = x.dn.slice(0, -old.length) + ou.dn;
      } else {
        const oldDn = obj!.dn;
        obj!.dn = `CN=${obj!.name},${target}`;
        for (const g of st.groups) g.members = g.members.map((m) => (m === oldDn ? obj!.dn : m));
      }
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adobject': (cx) => {
      const st = cx.env.st;
      if (cx.P.includedeletedobjects) {
        return st.deleted
          .filter((d) => cx.P.filter === undefined || condition(cx.env, str(cx.P.filter).replace(/isDeleted\s+-eq\s+\$true/i, '$true'), { Name: d.obj.name, ObjectClass: d.kind, isDeleted: true, samAccountName: 'sam' in d.obj ? d.obj.sam : d.obj.name }, true))
          .map((d) => ({ __type: 'deleted', Deleted: true, DistinguishedName: `CN=${d.obj.name}\\0ADEL:${'sid' in d.obj ? d.obj.sid : ''},CN=Deleted Objects,${domainDn(st.domain)}`, Name: `${d.obj.name}\nDEL:${'sid' in d.obj ? d.obj.sid?.slice(-4) : ''}`, ObjectClass: d.kind, LastKnownParent: parentOf(d.obj.dn), SamAccountName: 'sam' in d.obj ? d.obj.sam : d.obj.name }));
      }
      if (cx.P.ldapfilter !== undefined) return ldapSearch(cx, ['user', 'group', 'computer', 'ou']).map((x) => ({ __type: 'select', DistinguishedName: x.o.dn, Name: x.o.name, ObjectClass: x.kind === 'ou' ? 'organizationalUnit' : x.kind }));
      const id = cx.P.identity ?? cx.pos[0];
      const all = allObjects(st);
      const hit = all.filter((x) => (id !== undefined ? x.o.dn.toLowerCase() === str(id).toLowerCase() : condition(cx.env, str(cx.P.filter ?? '*'), { Name: x.o.name, ObjectClass: x.kind, DistinguishedName: x.o.dn }, true)));
      if (id !== undefined && !hit.length) cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
      return hit.map((x) => ({ __type: 'select', DistinguishedName: x.o.dn, Name: x.o.name, ObjectClass: x.kind === 'ou' ? 'organizationalUnit' : x.kind }));
    },
    'restore-adobject': (cx) => {
      const st = cx.env.st;
      if (!st.recycleBin) cx.fail('The AD Recycle Bin is not enabled, so deleted objects can only come back through an authoritative restore from backup.');
      const items = cx.input?.length ? cx.input : asList(identityOf(cx));
      for (const it of items) {
        const sam = str(prop(it, 'SamAccountName') ?? it).toLowerCase();
        const idx = st.deleted.findIndex((d) => ('sam' in d.obj ? d.obj.sam : d.obj.name).toLowerCase() === sam);
        if (idx < 0) cx.fail(`Cannot find a deleted object with identity: '${sam}'.`);
        const [d] = st.deleted.splice(idx, 1);
        if (!containerExists(st, parentOf(d.obj.dn))) cx.fail(`The object's last known parent ${parentOf(d.obj.dn)} no longer exists. Restore the parent OU first.`);
        if (d.kind === 'user') st.users.push(d.obj as AdUser);
        else if (d.kind === 'group') st.groups.push(d.obj as AdGroup);
        else if (d.kind === 'ou') st.ous.push(d.obj as AdOu);
        else st.computers.push(d.obj as AdComputer);
      }
      cx.env.dirtyAd = true;
      return [];
    },
    'enable-adoptionalfeature': (cx) => {
      const f = str(cx.P.identity ?? cx.pos[0]);
      if (!/recycle bin/i.test(f)) cx.fail(`Unknown optional feature ${f}. Use 'Recycle Bin Feature'.`);
      if (cx.env.st.recycleBin) cx.fail('The feature is already enabled. (Enabling the Recycle Bin cannot be undone.)');
      cx.env.st.recycleBin = true;
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adoptionalfeature': (cx) => [{ __type: 'select', Name: 'Recycle Bin Feature', EnabledScopes: cx.env.st.recycleBin ? [`CN=Partitions,CN=Configuration,${domainDn(cx.env.st.domain)}`] : [] }],

    /* ------------------------------------------------------------ groups */
    'new-adgroup': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      const scopeRaw = str(cx.P.groupscope ?? cx.pos[1]);
      const scope = (['Global', 'DomainLocal', 'Universal'] as const).find((s) => s.toLowerCase() === scopeRaw.toLowerCase());
      if (!n) cx.fail("Cannot validate argument on parameter 'Name'.");
      if (!scope) cx.fail("Cannot bind parameter 'GroupScope'. Use Global, DomainLocal or Universal.");
      const parent = str(cx.P.path ?? `CN=Users,${domainDn(st.domain)}`);
      if (!containerExists(st, parent)) cx.fail(`Directory object not found: ${parent}.`);
      if (findGroup(st, n) || st.users.some((u) => u.sam.toLowerCase() === n.toLowerCase())) cx.fail('The specified group already exists');
      const category = str(cx.P.groupcategory ?? 'Security').toLowerCase() === 'distribution' ? 'Distribution' : 'Security';
      st.groups.push({ name: n, dn: `CN=${n},${parent}`, sid: nextSid(st), scope: scope!, category, members: [], description: cx.P.description !== undefined ? str(cx.P.description) : undefined });
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adgroup': (cx) => {
      const st = cx.env.st;
      if (cx.P.ldapfilter !== undefined) return ldapSearch(cx, ['group']).map((x) => groupView(x.o as AdGroup));
      const id = cx.P.identity ?? (cx.pos[0] !== undefined && cx.P.filter === undefined ? cx.pos[0] : undefined);
      if (id !== undefined) {
        const g = findGroup(st, id);
        return g ? [groupView(g)] : cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
      }
      return st.groups.map(groupView).filter((o) => condition(cx.env, str(cx.P.filter ?? '*'), o, true));
    },
    'set-adgroup': (cx) => {
      const g = findGroup(cx.env.st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      if (cx.P.groupscope !== undefined) {
        const to = str(cx.P.groupscope);
        const scope = (['Global', 'DomainLocal', 'Universal'] as const).find((s) => s.toLowerCase() === to.toLowerCase());
        if (!scope) cx.fail('Use Global, DomainLocal or Universal.');
        if ((g.scope === 'Global' && scope === 'DomainLocal') || (g.scope === 'DomainLocal' && scope === 'Global')) cx.fail(`A ${g.scope} group cannot be converted directly to ${scope}: convert it to Universal first.`);
        g.scope = scope!;
      }
      if (cx.P.description !== undefined) g.description = str(cx.P.description);
      cx.env.dirtyAd = true;
      return [];
    },
    'remove-adgroup': (cx) => {
      const st = cx.env.st;
      const g = findGroup(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      st.groups = st.groups.filter((x) => x !== g);
      for (const x of st.groups) x.members = x.members.filter((m) => m !== g.dn);
      if (st.recycleBin) st.deleted.push({ kind: 'group', obj: g });
      cx.env.dirtyAd = true;
      return [];
    },
    'add-adgroupmember': (cx) => membership(cx, true),
    'remove-adgroupmember': (cx) => membership(cx, false),
    'get-adgroupmember': (cx) => {
      const st = cx.env.st;
      const g = findGroup(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      const collect = (grp: AdGroup, seen: Set<string>): Obj[] =>
        grp.members.flatMap((dn) => {
          const u = st.users.find((x) => x.dn === dn);
          if (u) return [{ __type: 'member', distinguishedName: u.dn, name: u.name, objectClass: 'user', SamAccountName: u.sam }];
          const c = st.computers.find((x) => x.dn === dn);
          if (c) return [{ __type: 'member', distinguishedName: c.dn, name: c.name, objectClass: 'computer', SamAccountName: `${c.name}$` }];
          const sub = st.groups.find((x) => x.dn === dn);
          if (!sub) return [];
          if (cx.P.recursive && !seen.has(sub.dn)) return collect(sub, new Set([...seen, sub.dn]));
          return [{ __type: 'member', distinguishedName: sub.dn, name: sub.name, objectClass: 'group', SamAccountName: sub.name }];
        });
      const out = collect(g, new Set([g.dn]));
      return out.filter((o, i) => out.findIndex((x) => x.distinguishedName === o.distinguishedName) === i);
    },
    'get-adprincipalgroupmembership': (cx) => {
      const st = cx.env.st;
      const id = identityOf(cx);
      const obj = findUser(st, id) ?? findGroup(st, id) ?? findComputer(st, id) ?? cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
      return st.groups.filter((g) => g.members.includes(obj.dn) || (g.name === 'Domain Users' && 'sam' in obj)).map(groupView);
    },

    /* ------------------------------------------------------------ computers and service accounts */
    'new-adcomputer': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]).toUpperCase();
      if (!/^[A-Z0-9-]{1,15}$/.test(n)) cx.fail(`The computer name ${n} is not valid: up to 15 letters, digits and hyphens.`);
      if (findComputer(st, n)) cx.fail('The specified account already exists');
      const parent = str(cx.P.path ?? `CN=Computers,${domainDn(st.domain)}`);
      if (!containerExists(st, parent)) cx.fail(`Directory object not found: ${parent}.`);
      st.computers.push({ name: n, dn: `CN=${n},${parent}`, sid: nextSid(st), enabled: cx.P.enabled === undefined ? true : bool(cx.P.enabled), dnsHostName: `${n.toLowerCase()}.${st.domain}` });
      st.groups.find((g) => g.name === 'Domain Computers')?.members.push(`CN=${n},${parent}`);
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adcomputer': (cx) => {
      const st = cx.env.st;
      if (cx.P.ldapfilter !== undefined) return ldapSearch(cx, ['computer']).map((x) => computerView(x.o as AdComputer));
      const id = cx.P.identity ?? (cx.pos[0] !== undefined && cx.P.filter === undefined ? cx.pos[0] : undefined);
      if (id !== undefined) {
        const c = findComputer(st, id);
        return c ? [computerView(c)] : cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
      }
      const base = cx.P.searchbase !== undefined ? str(cx.P.searchbase).toLowerCase() : null;
      return st.computers.filter((c) => !base || c.dn.toLowerCase().endsWith(',' + base)).map(computerView).filter((o) => condition(cx.env, str(cx.P.filter ?? '*'), o, true));
    },
    'remove-adcomputer': (cx) => {
      const st = cx.env.st;
      const c = findComputer(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      st.computers = st.computers.filter((x) => x !== c);
      for (const g of st.groups) g.members = g.members.filter((m) => m !== c.dn);
      cx.env.dirtyAd = true;
      return [];
    },
    'add-kdsrootkey': (cx) => {
      cx.env.st.kdsRootKey = true;
      cx.env.dirtyAd = true;
      return ['{9a1c3f62-31d5-4a8e-b6b4-2b0e8e5d7a11}'];
    },
    'new-adserviceaccount': (cx) => {
      const st = cx.env.st;
      if (!st.kdsRootKey) cx.fail('Key does not exist: create the KDS root key first with Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10)) in a lab, or -EffectiveImmediately and wait 10 hours in production.');
      const n = str(cx.P.name ?? cx.pos[0]);
      if (n.length > 15) cx.fail('The name of a group managed service account can be at most 15 characters.');
      if (cx.P.dnshostname === undefined) cx.fail('New-ADServiceAccount needs -DNSHostName for a group managed service account.');
      if (st.serviceAccounts.some((s) => s.name.toLowerCase() === n.toLowerCase())) cx.fail('The specified account already exists');
      const principals = asList(cx.P.principalsallowedtoretrievemanagedpassword).map(str);
      for (const p of principals) if (!findGroup(st, p) && !findComputer(st, p)) cx.fail(`Cannot find an object with identity: '${p}'.`);
      st.serviceAccounts.push({ name: n, dn: `CN=${n},CN=Managed Service Accounts,${domainDn(st.domain)}`, dnsHostName: str(cx.P.dnshostname), principals, installedOn: [] });
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adserviceaccount': (cx) => cx.env.st.serviceAccounts.filter((s) => !(cx.P.identity ?? cx.pos[0]) || s.name.toLowerCase() === str(cx.P.identity ?? cx.pos[0]).replace(/\$$/, '').toLowerCase()).map((s) => ({ __type: 'select', Name: s.name, DistinguishedName: s.dn, DNSHostName: s.dnsHostName ?? '', PrincipalsAllowedToRetrieveManagedPassword: s.principals })),
    'set-adserviceaccount': (cx) => {
      const s = cx.env.st.serviceAccounts.find((x) => x.name.toLowerCase() === str(identityOf(cx)).replace(/\$$/, '').toLowerCase()) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      if (cx.P.principalsallowedtoretrievemanagedpassword !== undefined) s.principals = asList(cx.P.principalsallowedtoretrievemanagedpassword).map(str);
      cx.env.dirtyAd = true;
      return [];
    },
    'install-adserviceaccount': (cx) => {
      const st = cx.env.st;
      const m = machine(cx.env);
      const s = st.serviceAccounts.find((x) => x.name.toLowerCase() === str(identityOf(cx)).replace(/\$$/, '').toLowerCase()) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      const comp = findComputer(st, m.name);
      const allowed = !!comp && s.principals.some((p) => {
        const g = findGroup(st, p);
        return (g && groupsOf(st, comp.dn).some((x) => x.dn === g.dn)) || findComputer(st, p)?.dn === comp.dn;
      });
      if (!allowed) cx.fail(`Cannot install service account. Error Message: '${m.name} is not allowed to retrieve the managed password. Add the computer (or a group it belongs to) to PrincipalsAllowedToRetrieveManagedPassword, then restart it so its group membership refreshes.'`);
      if (!s.installedOn.includes(m.name)) s.installedOn.push(m.name);
      cx.env.dirtyAd = true;
      return [];
    },
    'test-adserviceaccount': (cx) => {
      const s = cx.env.st.serviceAccounts.find((x) => x.name.toLowerCase() === str(identityOf(cx)).replace(/\$$/, '').toLowerCase());
      return [!!s && s.installedOn.includes(machine(cx.env).name)];
    },

    /* ------------------------------------------------------------ password policies */
    'get-addefaultdomainpasswordpolicy': (cx) => [policyView(cx.env.st.passwordPolicy, 'Default Domain Policy')],
    'set-addefaultdomainpasswordpolicy': (cx) => {
      setPolicy(cx, cx.env.st.passwordPolicy);
      cx.env.dirtyAd = true;
      return [];
    },
    'new-adfinegrainedpasswordpolicy': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (cx.P.precedence === undefined) cx.fail('New-ADFineGrainedPasswordPolicy needs -Precedence (lower numbers win).');
      if (st.fgpps.some((f) => f.name.toLowerCase() === n.toLowerCase())) cx.fail('The specified object already exists');
      const f: Fgpp = { ...st.passwordPolicy, name: n, precedence: Number(str(cx.P.precedence)), subjects: [] };
      setPolicy(cx, f);
      st.fgpps.push(f);
      cx.env.dirtyAd = true;
      return [];
    },
    'set-adfinegrainedpasswordpolicy': (cx) => {
      const f = cx.env.st.fgpps.find((x) => x.name.toLowerCase() === str(identityOf(cx)).toLowerCase()) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      setPolicy(cx, f);
      if (cx.P.precedence !== undefined) f.precedence = Number(str(cx.P.precedence));
      cx.env.dirtyAd = true;
      return [];
    },
    'add-adfinegrainedpasswordpolicysubject': (cx) => {
      const st = cx.env.st;
      const f = st.fgpps.find((x) => x.name.toLowerCase() === str(identityOf(cx)).toLowerCase()) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      for (const s of asList(cx.P.subjects ?? cx.pos[1])) {
        const g = findGroup(st, s);
        const u = findUser(st, s);
        if (g && g.scope !== 'Global') cx.fail(`A fine-grained password policy applies only to users and Global security groups; ${g.name} is ${g.scope}.`);
        const dn = g?.dn ?? u?.dn;
        if (!dn) cx.fail(`Cannot find an object with identity: '${str(s)}'.`);
        if (!f.subjects.includes(dn!)) f.subjects.push(dn!);
      }
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adfinegrainedpasswordpolicy': (cx) => cx.env.st.fgpps.map((f) => ({ ...policyView(f, f.name), Precedence: f.precedence, AppliesTo: f.subjects })),
    'get-aduserresultantpasswordpolicy': (cx) => {
      const st = cx.env.st;
      const u = findUser(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
      const r = resultantPolicy(st, u);
      return r.source === 'Default Domain Policy' ? [] : [{ ...policyView(r.policy, r.source), Name: r.source, Precedence: (r.policy as Fgpp).precedence }];
    },

    /* ------------------------------------------------------------ sites */
    'new-adreplicationsite': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (st.sites.some((s) => s.name.toLowerCase() === n.toLowerCase())) cx.fail('The specified site already exists.');
      st.sites.push({ name: n, subnets: [], dcs: [] });
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adreplicationsite': (cx) => cx.env.st.sites.filter((s) => !(cx.P.identity ?? cx.pos[0]) || s.name.toLowerCase() === str(cx.P.identity ?? cx.pos[0]).toLowerCase()).map((s) => ({ __type: 'select', Name: s.name, Subnets: s.subnets, DomainControllers: s.dcs })),
    'new-adreplicationsubnet': (cx) => {
      const st = cx.env.st;
      const n = str(cx.P.name ?? cx.pos[0]);
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(n)) cx.fail(`The subnet name ${n} is not valid: use network/prefix, for example 10.20.0.0/24.`);
      const site = st.sites.find((s) => s.name.toLowerCase() === str(cx.P.site).toLowerCase()) ?? cx.fail(`There is no site called ${str(cx.P.site)}. Create it with New-ADReplicationSite.`);
      if (st.sites.some((s) => s.subnets.includes(n))) cx.fail('The specified subnet already exists.');
      site.subnets.push(n);
      cx.env.dirtyAd = true;
      return [];
    },
    'get-adreplicationsubnet': (cx) => cx.env.st.sites.flatMap((s) => s.subnets.map((n) => ({ __type: 'select', Name: n, Site: s.name }))),
    'move-addirectoryserver': (cx) => {
      const st = cx.env.st;
      const dcName = str(cx.P.identity ?? cx.pos[0]).replace(/\..*$/, '');
      const m = machineByName(cx.env, dcName);
      if (!m?.dc) cx.fail(`${dcName} is not a domain controller.`);
      const site = st.sites.find((s) => s.name.toLowerCase() === str(cx.P.site).toLowerCase()) ?? cx.fail(`There is no site called ${str(cx.P.site)}.`);
      for (const s of st.sites) s.dcs = s.dcs.filter((d) => d.toLowerCase() !== m!.name.toLowerCase());
      site.dcs.push(m!.name);
      m!.dc!.site = site.name;
      cx.env.dirtyAd = true;
      cx.env.dirtyEst = true;
      return [];
    },

    /* ------------------------------------------------------------ promotion and join */
    'install-addsforest': (cx) => promote(cx, true),
    'install-addsdomaincontroller': (cx) => promote(cx, false),
    'add-computer': (cx) => {
      const env = cx.env;
      const m = machine(env);
      const domain = str(cx.P.domainname ?? cx.pos[0]).toLowerCase();
      if (m.domain && m.domain.toLowerCase() === domain && env.st.computers.some((c) => c.name === m.name)) cx.fail(`Computer '${m.name}' is already in domain '${domain}'.`);
      if (domain !== env.st.domain.toLowerCase()) cx.fail(`Computer '${m.name}' failed to join domain '${domain}' because the domain does not exist or could not be contacted.`);
      if (cx.P.credential === undefined) cx.fail(`Computer '${m.name}' failed to join domain '${domain}': Access is denied. Supply -Credential with an account allowed to join computers (Get-Credential ${env.st.netbios}\\Administrator).`);
      const dcs = env.est.machines.filter((x) => x.dc);
      const dns = m.nics[0]?.dns ?? [];
      if (!dns.some((ip) => dcs.some((d) => d.nics.some((n) => n.ip === ip))))
        cx.fail(`Computer '${m.name}' failed to join domain '${domain}' from its current workgroup 'WORKGROUP' with following error message: The specified domain either does not exist or could not be contacted. (Its DNS server is ${dns.join(', ') || 'not set'}; a domain member must use a domain controller for DNS so it can find the _ldap._tcp.dc._msdcs SRV records.)`);
      const ou = cx.P.oupath !== undefined ? str(cx.P.oupath) : `CN=Computers,${domainDn(env.st.domain)}`;
      if (!containerExists(env.st, ou)) cx.fail(`Directory object not found: ${ou}.`);
      m.domain = env.st.domain;
      if (!env.st.computers.some((c) => c.name === m.name)) {
        env.st.computers.push({ name: m.name, dn: `CN=${m.name},${ou}`, sid: nextSid(env.st), enabled: true, os: m.os, dnsHostName: `${m.name.toLowerCase()}.${env.st.domain}` });
        env.st.groups.find((g) => g.name === 'Domain Computers')?.members.push(`CN=${m.name},${ou}`);
      }
      for (const n of m.nics) if (n.profile !== 'DomainAuthenticated') n.profile = 'DomainAuthenticated';
      env.dirtyAd = true;
      env.dirtyEst = true;
      cx.print(`WARNING: The changes will take effect after you restart the computer ${m.name}.\n`);
      return [];
    },
    'remove-computer': (cx) => {
      const m = machine(cx.env);
      m.domain = undefined;
      cx.env.dirtyEst = true;
      return [];
    },
  },
  {
    'new-aduser': 'New-ADUser -Name <string> [-GivenName] [-Surname] [-SamAccountName] [-UserPrincipalName] [-Department] [-Title] [-Path <OU DN>] [-AccountPassword <SecureString>] [-Enabled $true] [-HomeDirectory \\\\server\\share\\%username%] [-HomeDrive H:] [-Instance $template]',
    'new-adgroup': 'New-ADGroup -Name <string> -GroupScope Global|DomainLocal|Universal [-GroupCategory Security|Distribution] [-Path <OU DN>]',
    'add-adgroupmember': 'Add-ADGroupMember -Identity <group> -Members <user, group or computer>[,<...>]',
    'new-adorganizationalunit': 'New-ADOrganizationalUnit -Name <string> [-Path <parent DN>] [-ProtectedFromAccidentalDeletion $true]',
    'get-aduser': 'Get-ADUser -Identity <user> | -Filter <condition> | -LDAPFilter "(&(objectClass=user)(department=Finance))" [-SearchBase <DN>] [-Properties <names>|*]',
    'set-addefaultdomainpasswordpolicy': 'Set-ADDefaultDomainPasswordPolicy -Identity <domain> [-MinPasswordLength 12] [-ComplexityEnabled $true] [-LockoutThreshold 5] [-LockoutDuration 00:30:00] [-LockoutObservationWindow 00:30:00] [-MaxPasswordAge 90.00:00:00] [-PasswordHistoryCount 24]',
    'new-adfinegrainedpasswordpolicy': 'New-ADFineGrainedPasswordPolicy -Name <name> -Precedence <n> [-MinPasswordLength 15] [-LockoutThreshold 3] [-ComplexityEnabled $true] ... then Add-ADFineGrainedPasswordPolicySubject -Identity <name> -Subjects <global group>',
    'install-addsforest': 'Install-ADDSForest -DomainName campus.local -DomainNetbiosName CAMPUS -SafeModeAdministratorPassword (ConvertTo-SecureString ... -AsPlainText -Force) [-InstallDns]',
    'add-computer': 'Add-Computer -DomainName <domain> -Credential (Get-Credential CAMPUS\\Administrator) [-OUPath <DN>] [-Restart]',
    'new-adserviceaccount': 'New-ADServiceAccount -Name <name> -DNSHostName <fqdn> -PrincipalsAllowedToRetrieveManagedPassword <computer or group>',
    'search-adaccount': 'Search-ADAccount -LockedOut | -AccountDisabled | -PasswordNeverExpires | -AccountInactive [-UsersOnly]',
  },
);

function accountState(cx: Cx, enabled: boolean): Value[] {
  const env = cx.env;
  for (const id of targets(cx)) {
    const u = findUser(env.st, id);
    const c = u ? undefined : findComputer(env.st, id);
    if (!u && !c) cx.fail(`Cannot find an object with identity: '${str(id)}'.`);
    if (u) {
      if (enabled && !u.hasPassword) cx.fail('The password does not meet the length, complexity, or history requirement of the domain. Set a password with Set-ADAccountPassword -Reset first.');
      u.enabled = enabled;
      audit(env, 'User Account Management', { id: enabled ? 4722 : 4725, source: 'Microsoft-Windows-Security-Auditing', message: `A user account was ${enabled ? 'enabled' : 'disabled'}. Target Account: ${u.sam}`, data: { TargetUserName: u.sam } });
    } else c!.enabled = enabled;
  }
  env.dirtyAd = true;
  return [];
}

function membership(cx: Cx, add: boolean): Value[] {
  const env = cx.env;
  const st = env.st;
  const g = findGroup(st, identityOf(cx)) ?? cx.fail(`Cannot find an object with identity: '${str(identityOf(cx))}'.`);
  const members = asList(cx.P.members ?? cx.pos[1] ?? cx.input?.map((o) => prop(o, 'SamAccountName') ?? o));
  if (!members.length) cx.fail("Cannot validate argument on parameter 'Members'.");
  for (const m of members) {
    const obj = findUser(st, m) ?? findGroup(st, m) ?? findComputer(st, m);
    if (!obj) cx.fail(`Cannot find an object with identity: '${str(m)}' under: '${domainDn(st.domain)}'.`);
    if (!add) {
      g.members = g.members.filter((x) => x !== obj!.dn);
      continue;
    }
    const problem = nestingProblem(g, obj!);
    if (problem) cx.fail(problem);
    if (!g.members.includes(obj!.dn)) g.members.push(obj!.dn);
    audit(env, 'Security Group Management', { id: g.scope === 'Global' ? 4728 : g.scope === 'DomainLocal' ? 4732 : 4756, source: 'Microsoft-Windows-Security-Auditing', message: `A member was added to a security-enabled ${g.scope.toLowerCase()} group. Member: ${obj!.dn} Group: ${g.name}`, data: { TargetUserName: g.name, MemberName: obj!.dn } });
  }
  env.dirtyAd = true;
  return [];
}

function policyView(p: PasswordPolicy, name: string): Obj {
  return { __type: 'policy', Name: name, ComplexityEnabled: p.complexity, LockoutDuration: `00:${String(p.lockoutDurationMin).padStart(2, '0')}:00`, LockoutObservationWindow: `00:${String(p.lockoutWindowMin).padStart(2, '0')}:00`, LockoutThreshold: p.lockoutThreshold, MaxPasswordAge: `${p.maxAgeDays}.00:00:00`, MinPasswordAge: `${p.minAgeDays}.00:00:00`, MinPasswordLength: p.minLength, PasswordHistoryCount: p.history };
}

function minutes(v: Value): number {
  const s = str(v);
  const m = /^(?:(\d+)\.)?(\d+):(\d+)(?::(\d+))?$/.exec(s);
  if (m) return Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  return Number(s);
}
function days(v: Value): number {
  const s = str(v);
  const m = /^(\d+)(?:\.\d+:\d+:\d+)?$/.exec(s);
  return m ? Number(m[1]) : Number(s);
}

function setPolicy(cx: Cx, p: PasswordPolicy): void {
  const P = cx.P;
  if (P.minpasswordlength !== undefined) p.minLength = Number(str(P.minpasswordlength));
  if (P.complexityenabled !== undefined) p.complexity = bool(P.complexityenabled);
  if (P.passwordhistorycount !== undefined) p.history = Number(str(P.passwordhistorycount));
  if (P.maxpasswordage !== undefined) p.maxAgeDays = days(P.maxpasswordage);
  if (P.minpasswordage !== undefined) p.minAgeDays = days(P.minpasswordage);
  if (P.lockoutthreshold !== undefined) p.lockoutThreshold = Number(str(P.lockoutthreshold));
  if (P.lockoutduration !== undefined) p.lockoutDurationMin = minutes(P.lockoutduration);
  if (P.lockoutobservationwindow !== undefined) p.lockoutWindowMin = minutes(P.lockoutobservationwindow);
  if (p.lockoutWindowMin > p.lockoutDurationMin && p.lockoutDurationMin > 0) cx.fail('The lockout observation window cannot be longer than the lockout duration.');
  if (p.minLength > 14 && cx.name === 'set-addefaultdomainpasswordpolicy') cx.fail('The domain policy accepts a minimum length of at most 14 here; use a fine-grained password policy for longer minimums.');
}

function promote(cx: Cx, forest: boolean): Value[] {
  const env = cx.env;
  const m = machine(env);
  if (!m.features.includes('AD-Domain-Services')) cx.fail('The AD DS role is not installed. Install-WindowsFeature AD-Domain-Services -IncludeManagementTools first.');
  if (!isSecure(cx.P.safemodeadministratorpassword)) cx.fail('Supply -SafeModeAdministratorPassword (the DSRM password) as a SecureString.');
  if (passwordProblem(env.st.passwordPolicy, (cx.P.safemodeadministratorpassword as Secure).plain)) cx.fail('The DSRM password does not meet the complexity requirements.');
  if (!m.nics[0]?.ip || m.nics[0].dhcp) cx.fail('A domain controller needs a static IP address. Set one with New-NetIPAddress before promoting.');
  if (m.dc) cx.fail(`${m.name} is already a domain controller.`);
  if (forest) {
    const name = str(cx.P.domainname).toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) cx.fail('Use a fully qualified DNS name for -DomainName, for example campus.local.');
    const nb = str(cx.P.domainnetbiosname ?? name.split('.')[0]).toUpperCase();
    // A new forest replaces the lab's directory.
    const fresh = JSON.parse(JSON.stringify(env.st)) as AdState;
    Object.assign(env.st, fresh, { domain: name, netbios: nb });
    const dc = domainDn(name);
    env.st.ous = [{ name: 'Domain Controllers', dn: `OU=Domain Controllers,${dc}`, protected: true }];
    env.st.users = env.st.users.filter((u) => u.sam === 'Administrator' || u.sam === 'Guest').map((u) => ({ ...u, dn: `CN=${u.name},CN=Users,${dc}`, upn: `${u.sam}@${name}` }));
    env.st.groups = env.st.groups.map((g) => ({ ...g, dn: `CN=${g.name},CN=Users,${dc}`, members: g.members.filter((x) => /CN=Administrator,/.test(x)).map(() => `CN=Administrator,CN=Users,${dc}`) }));
    env.st.computers = [{ name: m.name, dn: `CN=${m.name},OU=Domain Controllers,${dc}`, enabled: true, os: m.os, dnsHostName: `${m.name.toLowerCase()}.${name}` }];
    env.st.fsmo = { SchemaMaster: m.name, DomainNamingMaster: m.name, PDCEmulator: m.name, RIDMaster: m.name, InfrastructureMaster: m.name };
    env.st.zones = [{ name, kind: 'Primary', adIntegrated: true, reverse: false, dynamicUpdate: 'Secure', records: srvRecords(name, [{ name: m.name, ip: m.nics[0].ip! }]) }];
    env.st.sites = [{ name: 'Default-First-Site-Name', subnets: [], dcs: [m.name] }];
    for (const g of env.st.gpos) g.links = g.links.map((l) => ({ ...l, target: l.target.replace(/DC=.*$/, dc) }));
  } else {
    const name = str(cx.P.domainname).toLowerCase();
    if (name !== env.st.domain.toLowerCase()) cx.fail(`The domain ${name} could not be contacted.`);
    if (cx.P.credential === undefined) cx.fail('Supply -Credential with a Domain Admins account to add a domain controller.');
    const dcs = env.est.machines.filter((x) => x.dc);
    if (!(m.nics[0]?.dns ?? []).some((ip) => dcs.some((d) => d.nics.some((n) => n.ip === ip)))) cx.fail('An Active Directory domain controller for the domain could not be contacted: point this server\'s DNS at an existing domain controller first.');
    const dc = domainDn(env.st.domain);
    env.st.computers = env.st.computers.filter((c) => c.name !== m.name);
    env.st.computers.push({ name: m.name, dn: `CN=${m.name},OU=Domain Controllers,${dc}`, enabled: true, os: m.os, dnsHostName: `${m.name.toLowerCase()}.${env.st.domain}` });
    const zone = env.st.zones.find((z) => z.name === env.st.domain);
    zone?.records.push(...srvRecords(env.st.domain, [{ name: m.name, ip: m.nics[0].ip! }]).filter((r) => r.type !== 'NS'));
    const site = str(cx.P.sitename ?? 'Default-First-Site-Name');
    env.st.sites.find((s) => s.name === site)?.dcs.push(m.name);
  }
  m.domain = env.st.domain;
  m.dc = { gc: forest || cx.P.noglobalcatalog === undefined, site: str(cx.P.sitename ?? 'Default-First-Site-Name') };
  if (!m.features.includes('DNS') && (cx.P.installdns !== undefined || forest)) m.features.push('DNS');
  m.services.NTDS = { status: 'Running', start: 'Automatic' };
  for (const r of dcRulesFor()) if (!m.firewall.rules.some((x) => x.name === r.name)) m.firewall.rules.push(r);
  m.services.Netlogon = { status: 'Running', start: 'Automatic' };
  m.services.DNS = { status: 'Running', start: 'Automatic' };
  m.dns = m.dns ?? { forwarders: [], rootHints: true };
  env.dirtyAd = true;
  env.dirtyEst = true;
  cx.print(`WARNING: ${m.name} will restart and come back as a domain controller of ${env.st.domain}.\n`);
  return [{ __type: 'select', Message: 'Operation completed successfully', Context: forest ? 'DCPromo.General.1' : 'DCPromo.General.3', RebootRequired: true, Status: 'Success' }];
}

/* ----------------------------------------------------------------------------- natives */

registerNative({
  netdom: (args, cx) => {
    if (args.map((a) => a.toLowerCase()).join(' ') !== 'query fsmo') return ['Usage: netdom query fsmo'];
    const st = cx.env.st;
    return [
      `Schema master               ${st.fsmo.SchemaMaster}.${st.domain}`,
      `Domain naming master        ${st.fsmo.DomainNamingMaster}.${st.domain}`,
      `PDC                         ${st.fsmo.PDCEmulator}.${st.domain}`,
      `RID pool manager            ${st.fsmo.RIDMaster}.${st.domain}`,
      `Infrastructure master       ${st.fsmo.InfrastructureMaster}.${st.domain}`,
      'The command completed successfully.',
    ];
  },
  dsacls: (args, cx) => {
    const st = cx.env.st;
    const ou = args[0];
    if (!ou) return ['Usage: dsacls "OU=..." /G "DOMAIN\\group:CA;Reset Password;user"'];
    if (!containerExists(st, ou)) cx.fail(`dsacls failed: ${ou} was not found.`);
    const gi = args.findIndex((a) => /^\/g$/i.test(a));
    if (gi < 0) return [`Access list for ${ou}`, ...st.delegations.filter((d) => d.ou.toLowerCase() === ou.toLowerCase()).map((d) => `Allow ${d.trustee}  SPECIAL ACCESS for ${d.task}`), 'The command completed successfully'];
    const grant = args[gi + 1] ?? '';
    const m = /^([^:]+):(.+)$/.exec(grant);
    if (!m) cx.fail('dsacls: use /G "DOMAIN\\trustee:permission[;object type]".');
    const trustee = m![1];
    const short = trustee.replace(/^[^\\]+\\/, '');
    if (!findGroup(st, short) && !findUser(st, short)) cx.fail(`dsacls: No mapping between account names and security IDs was done: ${trustee}.`);
    const perm = m![2];
    const task = /reset password/i.test(perm) ? 'Reset Password' : /^GA$/i.test(perm) ? 'Full Control' : /^CCDC;user/i.test(perm) ? 'Create and delete user objects' : /^RPWP;.*lockouttime/i.test(perm) ? 'Unlock accounts' : /^RP/i.test(perm) ? 'Read properties' : perm;
    st.delegations.push({ ou, trustee: `${st.netbios}\\${short}`, task });
    cx.env.dirtyAd = true;
    return ['The command completed successfully'];
  },
  auditpol: (args, cx) => {
    const dc = dcOf(cx);
    const joined = args.join(' ');
    const sub = /\/subcategory:"?([^"/]+?)"?(?=\s+\/|$)/i.exec(joined)?.[1]?.trim();
    if (/^\/set/i.test(args[0] ?? '')) {
      if (!sub) cx.fail('auditpol /set /subcategory:"Logon" /success:enable /failure:enable');
      const known = ['Logon', 'Account Lockout', 'User Account Management', 'Security Group Management', 'Directory Service Changes', 'Credential Validation', 'Kerberos Authentication Service', 'File System', 'Audit Policy Change'];
      const k = known.find((x) => x.toLowerCase() === sub!.toLowerCase());
      if (!k) cx.fail(`Error 0x00000057 occurred: The parameter is incorrect. Subcategory "${sub}" is not known. Try one of: ${known.join(', ')}.`);
      const cur = dc.audit[k!] ?? { success: false, failure: false };
      if (/\/success:enable/i.test(joined)) cur.success = true;
      if (/\/success:disable/i.test(joined)) cur.success = false;
      if (/\/failure:enable/i.test(joined)) cur.failure = true;
      if (/\/failure:disable/i.test(joined)) cur.failure = false;
      dc.audit[k!] = cur;
      cx.env.dirtyEst = true;
      return ['The command was successfully executed.'];
    }
    if (/^\/get/i.test(args[0] ?? '')) {
      const rows = Object.entries(dc.audit).filter(([k]) => !sub || /^\*$/.test(sub) || k.toLowerCase() === sub.toLowerCase());
      return ['Category/Subcategory                      Setting', ...rows.map(([k, v]) => `  ${k.padEnd(40)}${v.success && v.failure ? 'Success and Failure' : v.success ? 'Success' : v.failure ? 'Failure' : 'No Auditing'}`)];
    }
    return ['Usage: auditpol /get /category:* | /set /subcategory:"name" /success:enable /failure:enable'];
  },
  klist: (args, cx) => {
    const m = machine(cx.env);
    if ((args[0] ?? '').toLowerCase() === 'purge') return ['Current LogonId is 0:0x3e7', '\tDeleting all tickets:', '\tTicket(s) purged!'];
    if (Math.abs(m.timeOffsetMin) > 5) return ['Current LogonId is 0:0x3e7', '', 'Cached Tickets: (0)', '', `(No Kerberos tickets: the clock on ${m.name} is ${m.timeOffsetMin} minutes from the domain controller, more than the 5 minutes Kerberos allows. Fix the time with w32tm /resync.)`];
    const st = cx.env.st;
    return ['Current LogonId is 0:0x3e7', '', 'Cached Tickets: (2)', '', `#0>     Client: ${cx.env.sys.user} @ ${st.domain.toUpperCase()}`, `        Server: krbtgt/${st.domain.toUpperCase()} @ ${st.domain.toUpperCase()}`, '        KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96', '', `#1>     Client: ${cx.env.sys.user} @ ${st.domain.toUpperCase()}`, `        Server: cifs/${(cx.env.est.machines[1]?.name ?? m.name).toLowerCase()}.${st.domain} @ ${st.domain.toUpperCase()}`, '        KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96'];
  },
  setspn: (args, cx) => {
    const st = cx.env.st;
    const flag = (args[0] ?? '').toLowerCase();
    if (flag === '-q') return [`Checking domain ${domainDn(st.domain)}`, 'Existing SPN found!'];
    if (flag === '-x') return ['Checking domain forest-wide for duplicate SPNs', 'found 0 group of duplicate SPNs.'];
    if (flag === '-s' || flag === '-a') {
      const acct = args[2];
      if (!acct || (!findUser(st, acct) && !findComputer(st, acct))) cx.fail(`setspn: cannot find account ${acct}.`);
      return [`Registering ServicePrincipalNames for ${acct}`, `\t${args[1]}`, 'Updated object'];
    }
    return ['Usage: setspn -S <spn> <account> | -Q <spn> | -X'];
  },
});

/** True when two machines can reach each other on the network. */
export function routable(a: { nics: Array<{ ip?: string; prefix?: number; gateway?: string; up: boolean }> }, b: { nics: Array<{ ip?: string; up: boolean }> }): boolean {
  const na = a.nics.find((n) => n.up && n.ip);
  const nb = b.nics.find((n) => n.up && n.ip);
  if (!na || !nb) return false;
  return sameSubnet(na.ip!, nb.ip!, na.prefix ?? 24) || !!na.gateway;
}

export { num };

/** Days in a -TimeSpan value: a timespan object, 90.00:00:00 text, or a number of days. */
function spanDays(v: Value): number {
  if (isObj(v) && (v as Obj).__type === 'timespan') return Number((v as Obj).__ms) / 86400000;
  const m = /^(\d+)(?:\.(\d{1,2}):(\d{2}))?/.exec(str(v));
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 24 : 0) : 15;
}
