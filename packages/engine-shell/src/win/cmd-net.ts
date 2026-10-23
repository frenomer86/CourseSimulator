/**
 * Windows networking: TCP/IP and IPv6 settings, network profiles, Windows Firewall, reachability
 * (Test-NetConnection, ping), the DHCP and DNS server roles, name resolution (Resolve-DnsName,
 * nslookup, ipconfig) and AD health tools (dcdiag, repadmin, nltest).
 */

import { asList, bool, machine, machineByName, register, registerNative, str, type Cx, type Env, type Obj, type Value } from './core.js';
import { findComputer } from './cmd-ad.js';
import { hasFeature, requireFeature } from './cmd-basic.js';
import { inCidr, intToIp, ipToInt, maskToPrefix, prefixToMask, sameSubnet, type DhcpScope, type DnsRecord, type DnsZone, type FwRule, type Machine, type Nic } from './model.js';

/* ----------------------------------------------------------------------------- helpers */

function nicOf(cx: Cx, m: Machine, alias?: string): Nic {
  const a = alias ?? str(cx.P.interfacealias ?? cx.P.interfaceindex ?? '');
  const nic = a ? m.nics.find((n) => n.alias.toLowerCase() === a.toLowerCase() || a === '12') : m.nics[0];
  if (!nic) return cx.fail(`No MSFT_NetIPInterface objects found with property 'InterfaceAlias' equal to '${a}'. Get-NetAdapter lists the adapters.`);
  return nic;
}

const portOf = (svc: string): number[] =>
  ({ LanmanServer: [445, 139], DNS: [53], DHCPServer: [67], NTDS: [389, 636, 3268, 88], W3SVC: [80, 443], TermService: [3389], WinRM: [5985], Spooler: [], WsusService: [8530], CertSvc: [135], WDSServer: [69, 4011], MSSQLSERVER: [1433] })[svc] ?? [];

/** Ports a machine listens on, from its running services. */
export function listening(m: Machine): Set<number> {
  const out = new Set<number>();
  for (const [svc, s] of Object.entries(m.services)) if (s.status === 'Running') for (const p of portOf(svc)) out.add(p);
  for (const p of ((m as Machine & { listen?: number[] }).listen ?? [])) out.add(p);
  return out;
}

function ruleMatches(r: FwRule, port: number | 'icmp', profile: string, fromIp: string): boolean {
  if (!r.enabled || r.direction !== 'Inbound') return false;
  if (!r.profiles.includes('Any') && !r.profiles.includes(profile === 'DomainAuthenticated' ? 'Domain' : profile)) return false;
  if (!r.remote.split(',').some((c) => inCidr(fromIp, c.trim()))) return false;
  if (port === 'icmp') return r.protocol === 'ICMPv4' || r.protocol === 'Any';
  if (r.protocol === 'ICMPv4') return false;
  return r.ports === 'Any' || r.ports.split(',').some((p) => {
    const [a, b] = p.split('-').map(Number);
    return b ? port >= a && port <= b : port === a;
  });
}

/** Whether a packet from `src` reaches `dst` on a port, and why not. */
export function reach(src: Machine, dst: Machine, port: number | 'icmp'): { ok: boolean; reason: string } {
  const sn = src.nics.find((n) => n.up && n.ip);
  const dn = dst.nics.find((n) => n.up && n.ip);
  if (!sn) return { ok: false, reason: `${src.name} has no IPv4 address.` };
  if (!dn) return { ok: false, reason: `${dst.name} has no IPv4 address.` };
  if (!sameSubnet(sn.ip!, dn.ip!, sn.prefix ?? 24) && !sn.gateway) return { ok: false, reason: `${dst.name} (${dn.ip}) is on another subnet and ${src.name} has no default gateway.` };
  const profileName = dn.profile === 'DomainAuthenticated' ? 'Domain' : dn.profile;
  const fwOn = dst.firewall.enabled[profileName as 'Domain' | 'Private' | 'Public'];
  if (port !== 'icmp' && !listening(dst).has(port)) return { ok: false, reason: `Nothing on ${dst.name} is listening on TCP ${port}.` };
  if (fwOn) {
    const block = dst.firewall.rules.find((r) => r.action === 'Block' && ruleMatches(r, port, dn.profile, sn.ip!));
    if (block) return { ok: false, reason: `${dst.name}'s firewall rule "${block.name}" blocks it.` };
    const allow = dst.firewall.rules.find((r) => r.action === 'Allow' && ruleMatches(r, port, dn.profile, sn.ip!));
    if (!allow) return { ok: false, reason: `${dst.name}'s firewall (${profileName} profile) has no enabled inbound rule allowing ${port === 'icmp' ? 'ICMP echo' : `TCP ${port}`} from ${sn.ip}.` };
  }
  return { ok: true, reason: '' };
}

function targetMachine(env: Env, nameOrIp: string): Machine | undefined {
  const byName = machineByName(env, nameOrIp);
  if (byName) return byName;
  return env.est.machines.find((m) => m.nics.some((n) => n.ip === nameOrIp));
}

/** Resolves a name through the machine's DNS servers. */
export function resolve(env: Env, from: Machine, name: string, type: DnsRecord['type'] = 'A', serverOverride?: string): { records: DnsRecord[]; server?: Machine; error?: string; fqdn: string } {
  const servers = serverOverride ? [serverOverride] : from.nics[0]?.dns ?? [];
  const fq = name.replace(/\.$/, '').toLowerCase();
  if (!servers.length) return { records: [], error: 'No DNS servers are configured.', fqdn: fq };
  for (const ip of servers) {
    const srv = targetMachine(env, ip);
    if (!srv || !hasFeature(srv, 'DNS') || srv.services.DNS?.status !== 'Running') continue;
    const zones = env.st.zones.filter((z) => z.kind !== 'Forwarder');
    const candidates = fq.includes('.') ? [fq] : [`${fq}.${env.st.domain}`];
    for (const cand of candidates) {
      const zone = [...zones].filter((z) => cand === z.name.toLowerCase() || cand.endsWith('.' + z.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) continue;
      const host = cand === zone.name.toLowerCase() ? '@' : cand.slice(0, -(zone.name.length + 1));
      let recs = zone.records.filter((r) => r.name.toLowerCase() === host && r.type === type);
      if (!recs.length && type === 'A') {
        const cname = zone.records.find((r) => r.name.toLowerCase() === host && r.type === 'CNAME');
        if (cname) {
          const inner = resolve(env, from, cname.data, 'A', ip);
          return { records: [cname, ...inner.records], server: srv, fqdn: cand };
        }
      }
      if (recs.length || zone) return { records: recs, server: srv, fqdn: cand, ...(recs.length ? {} : { error: `${cand} : DNS name does not exist` }) };
    }
    const cond = env.st.zones.find((z) => z.kind === 'Forwarder' && (fq === z.name.toLowerCase() || fq.endsWith('.' + z.name.toLowerCase())));
    if (cond) return { records: [{ name: fq, type, data: (cond as DnsZone & { ext?: Record<string, string> }).records[0]?.data ?? '10.99.0.10' }], server: srv, fqdn: fq };
    const fwd = srv.dns?.forwarders ?? [];
    if (fwd.length || srv.dns?.rootHints) {
      const known: Record<string, string> = { 'www.google.com': '142.250.184.4', 'www.microsoft.com': '23.62.178.12', 'update.microsoft.com': '13.107.4.50', 'www.gov.gh': '197.255.127.12' };
      if (known[fq]) return { records: [{ name: fq, type: 'A', data: known[fq] }], server: srv, fqdn: fq };
      if (!fwd.length && fq.includes('.') && /\.(com|org|gh|net)$/.test(fq)) return { records: [], server: srv, fqdn: fq, error: `${fq} : DNS server failure (root hints could not reach the internet from this lab; add a forwarder)` };
    }
    return { records: [], server: srv, fqdn: fq, error: `${fq} : DNS name does not exist` };
  }
  return { records: [], error: `The DNS server(s) ${servers.join(', ')} did not answer: no reachable DNS server with the DNS role running.`, fqdn: fq };
}

function zoneOf(cx: Cx, name = str(cx.P.zonename ?? cx.P.name ?? cx.pos[0])): DnsZone {
  const z = cx.env.st.zones.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!z) return cx.fail(`The zone ${name} was not found on server ${machine(cx.env).name}.`);
  return z;
}

function dnsServer(cx: Cx): Machine {
  const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) ?? cx.fail(`Failed to connect to ${str(cx.P.computername)}.`) : machine(cx.env);
  requireFeature(cx, m, 'DNS', 'DNS server cmdlets');
  return m;
}

function dhcpServer(cx: Cx): Machine {
  const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) ?? cx.fail(`Failed to get the DHCP server ${str(cx.P.computername)}.`) : machine(cx.env);
  requireFeature(cx, m, 'DHCP', 'DHCP server cmdlets');
  if (!m.dhcp) m.dhcp = { authorized: false, scopes: [] };
  return m;
}

function scopeOf(cx: Cx, m: Machine): DhcpScope {
  const id = str(cx.P.scopeid ?? cx.pos[0]);
  const s = m.dhcp!.scopes.find((x) => x.id === id);
  if (!s) return cx.fail(`Failed to get the scope ${id}: the scope does not exist on ${m.name}. Use the network address, for example 10.0.10.0.`);
  return s;
}

function ipInScope(s: DhcpScope, ip: string): boolean {
  return ipToInt(ip) >= ipToInt(s.start) && ipToInt(ip) <= ipToInt(s.end);
}

/** The next free address of a scope, or null. */
function nextFree(s: DhcpScope): string | null {
  const taken = new Set([...s.leases.map((l) => l.ip), ...s.reservations.map((r) => r.ip)]);
  for (let n = ipToInt(s.start); n <= ipToInt(s.end); n++) {
    const ip = intToIp(n);
    if (taken.has(ip)) continue;
    if (s.exclusions.some(([a, b]) => n >= ipToInt(a) && n <= ipToInt(b))) continue;
    return ip;
  }
  return null;
}

function ruleView(r: FwRule): Obj {
  return { __type: 'rule', DisplayName: r.name, Enabled: r.enabled, Profile: r.profiles.join(', '), Direction: r.direction, Action: r.action, Protocol: r.protocol, LocalPort: r.ports, RemoteAddress: r.remote };
}

/** Rules matching -DisplayName (wildcards) or -DisplayGroup. */
function rulesOf(cx: Cx, m: Machine): FwRule[] {
  const name = cx.P.displayname ?? cx.P.name ?? cx.pos[0];
  const group = cx.P.displaygroup;
  const re = (s: string) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  const hits = m.firewall.rules.filter((r) => (name !== undefined && asList(name).some((n) => re(str(n)).test(r.name))) || (group !== undefined && r.name.toLowerCase().startsWith(str(group).toLowerCase())));
  if ((name !== undefined || group !== undefined) && !hits.length) cx.fail(`No MSFT_NetFirewallRule objects found with property 'DisplayName' equal to '${str(name ?? group)}'.`);
  return hits;
}

const profilesOf = (v: Value): string[] => (v === undefined ? ['Any'] : asList(v).flatMap((p) => str(p).split(',')).map((p) => p.trim()).map((p) => (/^any$/i.test(p) ? 'Any' : p[0].toUpperCase() + p.slice(1).toLowerCase())));

/* ----------------------------------------------------------------------------- cmdlets */

register({
  /* ------------------------------------------------------------ TCP/IP */
  'get-netadapter': (cx) => machine(cx.env).nics.map((n, i) => ({ __type: 'ip', Name: n.alias, InterfaceDescription: 'Microsoft Hyper-V Network Adapter', ifIndex: 12 + i, Status: n.up ? 'Up' : 'Disabled', MacAddress: n.mac, LinkSpeed: '10 Gbps' })),
  'disable-netadapter': (cx) => {
    nicOf(cx, machine(cx.env), str(cx.P.name ?? cx.pos[0])).up = false;
    cx.env.dirtyEst = true;
    return [];
  },
  'enable-netadapter': (cx) => {
    nicOf(cx, machine(cx.env), str(cx.P.name ?? cx.pos[0])).up = true;
    cx.env.dirtyEst = true;
    return [];
  },
  'get-netipaddress': (cx) => {
    const m = machine(cx.env);
    const v6 = str(cx.P.addressfamily).toLowerCase() === 'ipv6';
    return m.nics.flatMap((n, i) => (v6 ? ['fe80::' + n.mac.slice(-8).replace(/-/g, '').toLowerCase().replace(/(....)(..)/, '$1:$2ff:fe00:1') + '%' + (12 + i), ...(n.ipv6 ?? [])].map((ip) => ({ __type: 'ip', IPAddress: ip, InterfaceAlias: n.alias, AddressFamily: 'IPv6', PrefixLength: 64, PrefixOrigin: ip.startsWith('fe80') ? 'WellKnown' : 'Manual' })) : n.ip ? [{ __type: 'ip', IPAddress: n.ip, InterfaceAlias: n.alias, AddressFamily: 'IPv4', PrefixLength: n.prefix ?? 24, PrefixOrigin: n.dhcp ? 'Dhcp' : 'Manual' }] : []));
  },
  'new-netipaddress': (cx) => {
    const env = cx.env;
    const m = machine(env);
    const nic = nicOf(cx, m);
    const ip = str(cx.P.ipaddress ?? cx.pos[0]);
    const prefix = Number(str(cx.P.prefixlength ?? 24));
    if (str(cx.P.addressfamily).toLowerCase() === 'ipv6' || ip.includes(':')) {
      if (!/^[0-9a-f:]+$/i.test(ip) || prefix < 1 || prefix > 128) cx.fail(`The IPv6 address ${ip}/${prefix} is not valid.`);
      nic.ipv6 = [...(nic.ipv6 ?? []), ip];
      env.dirtyEst = true;
      return [{ __type: 'ip', IPAddress: ip, InterfaceAlias: nic.alias, AddressFamily: 'IPv6', PrefixLength: prefix }];
    }
    if (Number.isNaN(ipToInt(ip))) cx.fail(`Cannot convert value "${ip}" to type IPAddress.`);
    if (prefix < 8 || prefix > 30) cx.fail(`The prefix length ${prefix} is not valid here: use 8 to 30.`);
    const netmask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    const net = (ipToInt(ip) & netmask) >>> 0;
    const bcast = (net | (~netmask >>> 0)) >>> 0;
    if (ipToInt(ip) === net || ipToInt(ip) === bcast) cx.fail(`${ip} is the ${ipToInt(ip) === net ? 'network' : 'broadcast'} address of ${intToIp(net)}/${prefix}, not a host address.`);
    const gw = cx.P.defaultgateway !== undefined ? str(cx.P.defaultgateway) : undefined;
    if (gw && !sameSubnet(ip, gw, prefix)) cx.fail(`The default gateway ${gw} is not on the ${intToIp(net)}/${prefix} subnet of ${ip}.`);
    const clash = env.est.machines.find((x) => x !== m && x.nics.some((n) => n.ip === ip));
    if (clash) cx.print(`WARNING: ${ip} is already used by ${clash.name}. Windows will detect the conflict and stop using it.\n`);
    if (nic.ip && !nic.dhcp && !cx.P.force) cx.fail(`Instance ${nic.ip} already exists on ${nic.alias}. Remove-NetIPAddress -InterfaceAlias ${nic.alias} first.`);
    Object.assign(nic, { ip, prefix, dhcp: false, ...(gw ? { gateway: gw } : {}) });
    env.dirtyEst = true;
    return [{ __type: 'ip', IPAddress: ip, InterfaceAlias: nic.alias, AddressFamily: 'IPv4', PrefixLength: prefix, PrefixOrigin: 'Manual' }];
  },
  'remove-netipaddress': (cx) => {
    const nic = nicOf(cx, machine(cx.env));
    nic.ip = undefined;
    nic.prefix = undefined;
    nic.gateway = undefined;
    cx.env.dirtyEst = true;
    return [];
  },
  'remove-netroute': (cx) => {
    nicOf(cx, machine(cx.env)).gateway = undefined;
    cx.env.dirtyEst = true;
    return [];
  },
  'set-netipinterface': (cx) => {
    const nic = nicOf(cx, machine(cx.env));
    if (cx.P.dhcp !== undefined) nic.dhcp = /enabled|true/i.test(str(cx.P.dhcp));
    cx.env.dirtyEst = true;
    return [];
  },
  'set-dnsclientserveraddress': (cx) => {
    const nic = nicOf(cx, machine(cx.env));
    if (cx.P.resetserveraddresses) nic.dns = [];
    else {
      const list = asList(cx.P.serveraddresses ?? cx.pos[1]).flatMap((x) => str(x).split(',')).map((x) => x.trim()).filter(Boolean);
      for (const ip of list) if (Number.isNaN(ipToInt(ip))) cx.fail(`${ip} is not a valid DNS server address.`);
      nic.dns = list;
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dnsclientserveraddress': (cx) => machine(cx.env).nics.map((n) => ({ __type: 'ip', InterfaceAlias: n.alias, AddressFamily: 'IPv4', ServerAddresses: `{${n.dns.join(', ')}}` })),
  'get-netipconfiguration': (cx) => machine(cx.env).nics.map((n) => ({ __type: 'ipconfig', InterfaceAlias: n.alias, IPv4Address: n.ip ?? '', IPv4DefaultGateway: n.gateway ?? '', DNSServer: n.dns.join(', '), NetProfile: n.profile })),
  'get-netconnectionprofile': (cx) => machine(cx.env).nics.map((n) => ({ __type: 'ip', Name: n.profile === 'DomainAuthenticated' ? cx.env.st.domain : 'Network', InterfaceAlias: n.alias, NetworkCategory: n.profile, IPv4Connectivity: n.ip ? 'Internet' : 'NoTraffic' })),
  'set-netconnectionprofile': (cx) => {
    const m = machine(cx.env);
    const nic = nicOf(cx, m);
    const cat = str(cx.P.networkcategory);
    if (!/^(public|private)$/i.test(cat)) cx.fail(/domain/i.test(cat) ? 'DomainAuthenticated cannot be set by hand: Windows chooses it when a domain member can reach a domain controller.' : 'Use -NetworkCategory Private or Public.');
    nic.profile = /private/i.test(cat) ? 'Private' : 'Public';
    cx.env.dirtyEst = true;
    return [];
  },

  /* ------------------------------------------------------------ firewall */
  'get-netfirewallprofile': (cx) => Object.entries(machine(cx.env).firewall.enabled).filter(([p]) => !cx.P.name && !cx.P.profile ? true : asList(cx.P.name ?? cx.P.profile).some((x) => str(x).toLowerCase() === p.toLowerCase())).map(([p, on]) => ({ __type: 'select', Name: p, Enabled: on, DefaultInboundAction: 'Block', DefaultOutboundAction: 'Allow' })),
  'set-netfirewallprofile': (cx) => {
    const m = machine(cx.env);
    const profiles = asList(cx.P.profile ?? cx.P.name ?? 'Domain,Private,Public').flatMap((p) => str(p).split(',')).map((p) => p.trim());
    for (const p of profiles) {
      const key = (['Domain', 'Private', 'Public'] as const).find((x) => x.toLowerCase() === p.toLowerCase());
      if (!key) cx.fail(`Unknown firewall profile ${p}.`);
      if (cx.P.enabled !== undefined) m.firewall.enabled[key!] = bool(cx.P.enabled);
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'get-netfirewallrule': (cx) => {
    const m = machine(cx.env);
    const list = cx.P.displayname !== undefined || cx.P.displaygroup !== undefined || cx.pos[0] !== undefined ? rulesOf(cx, m) : m.firewall.rules;
    return list.filter((r) => cx.P.enabled === undefined || r.enabled === bool(cx.P.enabled)).map(ruleView);
  },
  'new-netfirewallrule': (cx) => {
    const m = machine(cx.env);
    const name = str(cx.P.displayname ?? cx.P.name);
    if (!name) cx.fail('New-NetFirewallRule needs -DisplayName.');
    const protocol = str(cx.P.protocol ?? 'Any').toUpperCase();
    const proto = (protocol === 'TCP' || protocol === 'UDP' ? protocol : /ICMP/.test(protocol) ? 'ICMPv4' : 'Any') as FwRule['protocol'];
    const ports = cx.P.localport !== undefined ? asList(cx.P.localport).map(str).join(',') : 'Any';
    if (ports !== 'Any' && proto !== 'TCP' && proto !== 'UDP') cx.fail('A rule with -LocalPort needs -Protocol TCP or UDP.');
    const dir = str(cx.P.direction ?? 'Inbound');
    if (!/^(inbound|outbound)$/i.test(dir)) cx.fail('Use -Direction Inbound or Outbound.');
    const action = str(cx.P.action ?? 'Allow');
    if (!/^(allow|block)$/i.test(action)) cx.fail('Use -Action Allow or Block.');
    const remote = cx.P.remoteaddress !== undefined ? asList(cx.P.remoteaddress).map(str).join(',') : 'Any';
    for (const r of remote.split(',')) if (r !== 'Any' && !/^localsubnet$/i.test(r) && Number.isNaN(ipToInt(r.split('/')[0]))) cx.fail(`The address ${r} is not valid for -RemoteAddress. Use 10.0.0.0/24, an IP address or LocalSubnet.`);
    const rule: FwRule = { name, direction: /in/i.test(dir) ? 'Inbound' : 'Outbound', action: /allow/i.test(action) ? 'Allow' : 'Block', protocol: proto, ports, profiles: profilesOf(cx.P.profile), remote, enabled: cx.P.enabled === undefined ? true : bool(cx.P.enabled), program: cx.P.program !== undefined ? str(cx.P.program) : undefined };
    m.firewall.rules.push(rule);
    cx.env.dirtyEst = true;
    return [ruleView(rule)];
  },
  'set-netfirewallrule': (cx) => {
    const m = machine(cx.env);
    for (const r of rulesOf(cx, m)) {
      if (cx.P.enabled !== undefined) r.enabled = bool(cx.P.enabled);
      if (cx.P.remoteaddress !== undefined) r.remote = asList(cx.P.remoteaddress).map(str).join(',');
      if (cx.P.profile !== undefined) r.profiles = profilesOf(cx.P.profile);
      if (cx.P.localport !== undefined) r.ports = asList(cx.P.localport).map(str).join(',');
      if (cx.P.action !== undefined) r.action = /allow/i.test(str(cx.P.action)) ? 'Allow' : 'Block';
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'enable-netfirewallrule': (cx) => {
    for (const r of rulesOf(cx, machine(cx.env))) r.enabled = true;
    cx.env.dirtyEst = true;
    return [];
  },
  'disable-netfirewallrule': (cx) => {
    for (const r of rulesOf(cx, machine(cx.env))) r.enabled = false;
    cx.env.dirtyEst = true;
    return [];
  },
  'remove-netfirewallrule': (cx) => {
    const m = machine(cx.env);
    const gone = new Set(rulesOf(cx, m));
    m.firewall.rules = m.firewall.rules.filter((r) => !gone.has(r));
    cx.env.dirtyEst = true;
    return [];
  },
  'test-netconnection': (cx) => {
    const env = cx.env;
    const from = machine(env);
    const target = str(cx.P.computername ?? cx.pos[0]);
    const port = cx.P.port !== undefined ? Number(str(cx.P.port)) : cx.P.commontcpport !== undefined ? ({ smb: 445, rdp: 3389, http: 80, winrm: 5985 } as Record<string, number>)[str(cx.P.commontcpport).toLowerCase()] : undefined;
    let dst = targetMachine(env, target);
    let ip = dst?.nics[0]?.ip;
    if (!dst && !/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
      const r = resolve(env, from, target);
      ip = r.records.find((x) => x.type === 'A')?.data;
      dst = ip ? targetMachine(env, ip) : undefined;
      if (!ip) {
        cx.print(`WARNING: Name resolution of ${target} failed -- ${r.error ?? 'no address'}\n`);
        return [{ __type: 'tnc', ComputerName: target, RemoteAddress: '', TcpTestSucceeded: false, PingSucceeded: false }];
      }
    }
    if (!dst) return [{ __type: 'tnc', ComputerName: target, RemoteAddress: ip ?? target, InterfaceAlias: from.nics[0]?.alias, SourceAddress: from.nics[0]?.ip, ...(port ? { TcpTestSucceeded: false } : { PingSucceeded: false }) }];
    const res = reach(from, dst, port ?? 'icmp');
    if (!res.ok) cx.print(`WARNING: ${port ? `TCP connect to (${ip} : ${port}) failed` : `Ping to ${target} failed`} -- ${res.reason}\n`);
    return [{ __type: 'tnc', ComputerName: target, RemoteAddress: ip, ...(port ? { RemotePort: port } : {}), InterfaceAlias: from.nics[0]?.alias, SourceAddress: from.nics[0]?.ip, ...(port ? { TcpTestSucceeded: res.ok } : { PingSucceeded: res.ok }) }];
  },
  'resolve-dnsname': (cx) => {
    const env = cx.env;
    const name = str(cx.P.name ?? cx.pos[0]);
    const type = str(cx.P.type ?? 'A').toUpperCase() as DnsRecord['type'];
    const r = resolve(env, machine(env), name, type, cx.P.server !== undefined ? (targetMachine(env, str(cx.P.server))?.nics[0]?.ip ?? str(cx.P.server)) : undefined);
    if (!r.records.length) cx.fail(r.error ?? `${name} : DNS name does not exist`);
    return r.records.map((x) => ({ __type: 'record', Name: x.type === 'SRV' ? r.fqdn : r.fqdn, Type: x.type, TTL: x.ttl ?? 3600, Section: 'Answer', ...(x.type === 'A' || x.type === 'AAAA' ? { IPAddress: x.data } : x.type === 'SRV' ? { NameTarget: x.data.split(' ')[3], Port: Number(x.data.split(' ')[2]) } : { NameHost: x.data }) }));
  },
  'clear-dnsclientcache': () => [],

  /* ------------------------------------------------------------ DHCP server */
  'add-dhcpserverindc': (cx) => {
    const env = cx.env;
    const m = machineByName(env, str(cx.P.dnsname ?? cx.pos[0] ?? machine(env).name)) ?? machine(env);
    requireFeature(cx, m, 'DHCP', 'DHCP authorisation');
    if (!m.domain || !findComputer(env.st, m.name)) cx.fail(`${m.name} is not a domain member: only domain members can be authorised in Active Directory.`);
    m.dhcp = m.dhcp ?? { authorized: false, scopes: [] };
    m.dhcp.authorized = true;
    env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverindc': (cx) => cx.env.est.machines.filter((m) => m.dhcp?.authorized).map((m) => ({ __type: 'select', IPAddress: m.nics[0]?.ip ?? '', DnsName: `${m.name.toLowerCase()}.${cx.env.st.domain}` })),
  'add-dhcpserverv4scope': (cx) => {
    const m = dhcpServer(cx);
    const start = str(cx.P.startrange);
    const end = str(cx.P.endrange);
    const mask = str(cx.P.subnetmask);
    if ([start, end, mask].some((x) => Number.isNaN(ipToInt(x)))) cx.fail('Add-DhcpServerv4Scope needs -StartRange, -EndRange and -SubnetMask as IPv4 addresses.');
    const prefix = maskToPrefix(mask);
    if (!sameSubnet(start, end, prefix)) cx.fail(`${start} and ${end} are not in the same subnet with mask ${mask}.`);
    if (ipToInt(end) < ipToInt(start)) cx.fail('The end of the range is before its start.');
    const id = intToIp((ipToInt(start) & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0);
    if (m.dhcp!.scopes.some((s) => s.id === id)) cx.fail(`The scope ${id} already exists.`);
    const leaseDays = cx.P.leaseduration !== undefined ? Number(str(cx.P.leaseduration).split('.')[0]) || 8 : 8;
    m.dhcp!.scopes.push({ id, name: str(cx.P.name ?? id), start, end, mask, active: str(cx.P.state ?? 'Active').toLowerCase() === 'active', exclusions: [], reservations: [], options: {}, leaseDays, leases: [] });
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverv4scope': (cx) => dhcpServer(cx).dhcp!.scopes.map((s) => ({ __type: 'scope', ScopeId: s.id, SubnetMask: s.mask, Name: s.name, State: s.active ? 'Active' : 'Inactive', StartRange: s.start, EndRange: s.end, LeaseDuration: `${s.leaseDays}.00:00:00` })),
  'set-dhcpserverv4scope': (cx) => {
    const m = dhcpServer(cx);
    const s = scopeOf(cx, m);
    if (cx.P.state !== undefined) s.active = str(cx.P.state).toLowerCase() === 'active';
    if (cx.P.startrange !== undefined) s.start = str(cx.P.startrange);
    if (cx.P.endrange !== undefined) s.end = str(cx.P.endrange);
    if (cx.P.leaseduration !== undefined) s.leaseDays = Number(str(cx.P.leaseduration).split('.')[0]);
    cx.env.dirtyEst = true;
    return [];
  },
  'remove-dhcpserverv4scope': (cx) => {
    const m = dhcpServer(cx);
    const s = scopeOf(cx, m);
    m.dhcp!.scopes = m.dhcp!.scopes.filter((x) => x !== s);
    cx.env.dirtyEst = true;
    return [];
  },
  'add-dhcpserverv4exclusionrange': (cx) => {
    const m = dhcpServer(cx);
    const s = scopeOf(cx, m);
    const a = str(cx.P.startrange);
    const b = str(cx.P.endrange);
    if (!ipInScope(s, a) || !ipInScope(s, b)) cx.fail(`The exclusion ${a}-${b} is outside the scope range ${s.start}-${s.end}.`);
    s.exclusions.push([a, b]);
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverv4exclusionrange': (cx) => {
    const s = scopeOf(cx, dhcpServer(cx));
    return s.exclusions.map(([a, b]) => ({ __type: 'select', ScopeId: s.id, StartRange: a, EndRange: b }));
  },
  'set-dhcpserverv4optionvalue': (cx) => {
    const m = dhcpServer(cx);
    const scopes = cx.P.scopeid !== undefined ? [scopeOf(cx, m)] : m.dhcp!.scopes;
    for (const s of scopes) {
      if (cx.P.router !== undefined) {
        const r = str(cx.P.router);
        if (!sameSubnet(r, s.start, maskToPrefix(s.mask))) cx.fail(`The router ${r} is not on the ${s.id}/${maskToPrefix(s.mask)} subnet.`);
        s.options.router = r;
      }
      if (cx.P.dnsserver !== undefined) s.options.dns = asList(cx.P.dnsserver).flatMap((x) => str(x).split(','));
      if (cx.P.dnsdomain !== undefined) s.options.domain = str(cx.P.dnsdomain);
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverv4optionvalue': (cx) => {
    const s = scopeOf(cx, dhcpServer(cx));
    return [
      ...(s.options.router ? [{ __type: 'option', OptionId: 3, Name: 'Router', Value: s.options.router }] : []),
      ...(s.options.dns ? [{ __type: 'option', OptionId: 6, Name: 'DNS Servers', Value: `{${s.options.dns.join(', ')}}` }] : []),
      ...(s.options.domain ? [{ __type: 'option', OptionId: 15, Name: 'DNS Domain Name', Value: s.options.domain }] : []),
      { __type: 'option', OptionId: 51, Name: 'Lease', Value: s.leaseDays * 86400 },
    ];
  },
  'add-dhcpserverv4reservation': (cx) => {
    const m = dhcpServer(cx);
    const s = scopeOf(cx, m);
    const ip = str(cx.P.ipaddress);
    const mac = str(cx.P.clientid).toUpperCase().replace(/:/g, '-');
    if (!/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/.test(mac)) cx.fail(`-ClientId must be the MAC address, for example 00-15-5D-01-02-03 (got ${str(cx.P.clientid)}).`);
    if (!ipInScope(s, ip)) cx.fail(`${ip} is not in the scope range ${s.start}-${s.end}.`);
    if (s.reservations.some((r) => r.ip === ip || r.mac === mac)) cx.fail('The specified IP address or client ID is already reserved.');
    s.reservations.push({ ip, mac, name: cx.P.name !== undefined ? str(cx.P.name) : undefined });
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverv4reservation': (cx) => {
    const s = scopeOf(cx, dhcpServer(cx));
    return s.reservations.map((r) => ({ __type: 'reservation', IPAddress: r.ip, ScopeId: s.id, ClientId: r.mac, Name: r.name ?? '', Type: 'Both' }));
  },
  'get-dhcpserverv4lease': (cx) => {
    const s = scopeOf(cx, dhcpServer(cx));
    return s.leases.map((l) => ({ __type: 'lease', IPAddress: l.ip, ScopeId: s.id, ClientId: l.mac, HostName: l.host, AddressState: 'Active' }));
  },
  'add-dhcpserverv4failover': (cx) => {
    const env = cx.env;
    const m = dhcpServer(cx);
    const partner = machineByName(env, str(cx.P.partnerserver)) ?? cx.fail(`Failed to contact the partner server ${str(cx.P.partnerserver)}.`);
    if (!hasFeature(partner, 'DHCP')) cx.fail(`The DHCP role is not installed on ${partner.name}.`);
    if (!partner.dhcp?.authorized) cx.fail(`The partner ${partner.name} is not authorised in Active Directory (Add-DhcpServerInDC).`);
    const s = scopeOf(cx, m);
    const mode = cx.P.serverrole !== undefined ? 'HotStandby' : 'LoadBalance';
    s.failover = { partner: partner.name, mode };
    partner.dhcp!.scopes = partner.dhcp!.scopes.filter((x) => x.id !== s.id);
    partner.dhcp!.scopes.push({ ...JSON.parse(JSON.stringify(s)), failover: { partner: m.name, mode } });
    env.dirtyEst = true;
    return [];
  },
  'get-dhcpserverv4failover': (cx) => dhcpServer(cx).dhcp!.scopes.filter((s) => s.failover).map((s) => ({ __type: 'select', Name: `${s.id}-failover`, PartnerServer: s.failover!.partner, Mode: s.failover!.mode, ScopeId: s.id, State: 'Normal' })),

  /* ------------------------------------------------------------ DNS server */
  'add-dnsserverprimaryzone': (cx) => {
    const st = cx.env.st;
    dnsServer(cx);
    const netId = cx.P.networkid !== undefined ? str(cx.P.networkid) : undefined;
    let name = str(cx.P.name ?? cx.pos[0]);
    if (netId) {
      const [net, len] = netId.split('/');
      const octets = net.split('.').slice(0, Math.floor(Number(len) / 8));
      name = `${octets.reverse().join('.')}.in-addr.arpa`;
    }
    if (!name) cx.fail('Add-DnsServerPrimaryZone needs -Name or -NetworkId.');
    if (st.zones.some((z) => z.name.toLowerCase() === name.toLowerCase())) cx.fail(`The zone ${name} already exists.`);
    const ad = cx.P.replicationscope !== undefined;
    if (!ad && cx.P.zonefile === undefined) cx.fail('Use -ReplicationScope Domain|Forest (AD-integrated) or -ZoneFile <name>.dns (file-backed).');
    const dyn = str(cx.P.dynamicupdate ?? (ad ? 'Secure' : 'None'));
    if (!ad && /^secure$/i.test(dyn)) cx.fail('Secure dynamic updates need an AD-integrated zone (-ReplicationScope).');
    st.zones.push({ name, kind: 'Primary', adIntegrated: ad, reverse: !!netId || /in-addr\.arpa$/i.test(name), dynamicUpdate: /^secure$/i.test(dyn) ? 'Secure' : /nonsecure/i.test(dyn) ? 'NonsecureAndSecure' : 'None', records: [] });
    cx.env.dirtyAd = true;
    return [];
  },
  'add-dnsserversecondaryzone': (cx) => {
    dnsServer(cx);
    cx.env.st.zones.push({ name: str(cx.P.name), kind: 'Secondary', adIntegrated: false, reverse: false, dynamicUpdate: 'None', records: [] });
    cx.env.dirtyAd = true;
    return [];
  },
  'add-dnsserverconditionalforwarderzone': (cx) => {
    dnsServer(cx);
    const name = str(cx.P.name);
    const masters = asList(cx.P.masterservers).map(str);
    if (!masters.length) cx.fail('Add-DnsServerConditionalForwarderZone needs -MasterServers.');
    cx.env.st.zones.push({ name, kind: 'Forwarder', adIntegrated: cx.P.replicationscope !== undefined, reverse: false, dynamicUpdate: 'None', records: [{ name: '@', type: 'NS', data: masters[0] }] });
    cx.env.dirtyAd = true;
    return [];
  },
  'get-dnsserverzone': (cx) => {
    dnsServer(cx);
    return cx.env.st.zones.filter((z) => !(cx.P.name ?? cx.pos[0]) || z.name.toLowerCase() === str(cx.P.name ?? cx.pos[0]).toLowerCase()).map((z) => ({ __type: 'zone', ZoneName: z.name, ZoneType: z.kind, IsAutoCreated: false, IsDsIntegrated: z.adIntegrated, IsReverseLookupZone: z.reverse, IsSigned: false, DynamicUpdate: z.dynamicUpdate, Aging: !!z.scavenging }));
  },
  'remove-dnsserverzone': (cx) => {
    const z = zoneOf(cx);
    cx.env.st.zones = cx.env.st.zones.filter((x) => x !== z);
    cx.env.dirtyAd = true;
    return [];
  },
  'set-dnsserverprimaryzone': (cx) => {
    const z = zoneOf(cx);
    if (cx.P.dynamicupdate !== undefined) {
      const d = str(cx.P.dynamicupdate);
      if (/^secure$/i.test(d) && !z.adIntegrated) cx.fail('Secure dynamic updates need an AD-integrated zone.');
      z.dynamicUpdate = /^secure$/i.test(d) ? 'Secure' : /nonsecure/i.test(d) ? 'NonsecureAndSecure' : 'None';
    }
    cx.env.dirtyAd = true;
    return [];
  },
  'add-dnsserverresourcerecorda': (cx) => addRecord(cx, 'A', str(cx.P.ipv4address)),
  'add-dnsserverresourcerecordaaaa': (cx) => addRecord(cx, 'AAAA', str(cx.P.ipv6address)),
  'add-dnsserverresourcerecordcname': (cx) => addRecord(cx, 'CNAME', str(cx.P.hostnamealias)),
  'add-dnsserverresourcerecordmx': (cx) => addRecord(cx, 'MX', `${str(cx.P.preference ?? 10)} ${str(cx.P.mailexchange)}`),
  'add-dnsserverresourcerecordptr': (cx) => addRecord(cx, 'PTR', str(cx.P.ptrdomainname)),
  'add-dnsserverresourcerecord': (cx) => {
    if (cx.P.srv) return addRecord(cx, 'SRV', `${str(cx.P.priority ?? 0)} ${str(cx.P.weight ?? 100)} ${str(cx.P.port)} ${str(cx.P.domainname)}`);
    if (cx.P.txt) return addRecord(cx, 'TXT', str(cx.P.descriptivetext));
    return cx.fail('Use -Srv or -Txt with Add-DnsServerResourceRecord, or the A, AAAA, CName, MX and Ptr cmdlets.');
  },
  'get-dnsserverresourcerecord': (cx) => {
    const z = zoneOf(cx, str(cx.P.zonename ?? cx.pos[0]));
    const type = cx.P.rrtype !== undefined ? str(cx.P.rrtype).toUpperCase() : undefined;
    const name = cx.P.name !== undefined ? str(cx.P.name).toLowerCase() : undefined;
    return z.records.filter((r) => (!type || r.type === type) && (!name || r.name.toLowerCase() === name)).map((r) => ({ __type: 'record', HostName: r.name, RecordType: r.type, Type: 0, Timestamp: '0', TimeToLive: '01:00:00', RecordData: r.data }));
  },
  'remove-dnsserverresourcerecord': (cx) => {
    const z = zoneOf(cx);
    const type = str(cx.P.rrtype).toUpperCase();
    const name = str(cx.P.name).toLowerCase();
    const before = z.records.length;
    z.records = z.records.filter((r) => !(r.name.toLowerCase() === name && r.type === type && (cx.P.recorddata === undefined || r.data === str(cx.P.recorddata))));
    if (z.records.length === before) cx.fail(`No ${type} record named ${name} was found in ${z.name}.`);
    cx.env.dirtyAd = true;
    return [];
  },
  'add-dnsserverforwarder': (cx) => {
    const m = dnsServer(cx);
    m.dns = m.dns ?? { forwarders: [], rootHints: true };
    for (const ip of asList(cx.P.ipaddress ?? cx.pos[0]).map(str)) {
      if (Number.isNaN(ipToInt(ip))) cx.fail(`${ip} is not a valid IPv4 address.`);
      if (!m.dns.forwarders.includes(ip)) m.dns.forwarders.push(ip);
    }
    cx.env.dirtyEst = true;
    return [];
  },
  'set-dnsserverforwarder': (cx) => {
    const m = dnsServer(cx);
    m.dns = m.dns ?? { forwarders: [], rootHints: true };
    m.dns.forwarders = asList(cx.P.ipaddress).map(str);
    if (cx.P.useroothint !== undefined) m.dns.rootHints = bool(cx.P.useroothint);
    cx.env.dirtyEst = true;
    return [];
  },
  'get-dnsserverforwarder': (cx) => {
    const m = dnsServer(cx);
    return [{ __type: 'select', UseRootHint: m.dns?.rootHints ?? true, Timeout: 3, IPAddress: `{${(m.dns?.forwarders ?? []).join(', ')}}` }];
  },
  'set-dnsserverscavenging': (cx) => {
    dnsServer(cx);
    for (const z of cx.env.st.zones) if (cx.P.applyonallzones || cx.P.scavengingstate !== undefined) z.scavenging = bool(cx.P.scavengingstate ?? true);
    cx.env.dirtyAd = true;
    return [];
  },
  'set-dnsserverzoneaging': (cx) => {
    const z = zoneOf(cx);
    z.scavenging = bool(cx.P.aging ?? true);
    cx.env.dirtyAd = true;
    return [];
  },
  'clear-dnsservercache': (cx) => {
    dnsServer(cx);
    return [];
  },
});

function addRecord(cx: Cx, type: DnsRecord['type'], data: string): Value[] {
  dnsServer(cx);
  const z = zoneOf(cx, str(cx.P.zonename));
  const name = str(cx.P.name).toLowerCase();
  if (!name) cx.fail('The record needs -Name.');
  if (type === 'A' && Number.isNaN(ipToInt(data))) cx.fail(`${data} is not a valid IPv4 address.`);
  if (type === 'PTR' && !z.reverse) cx.fail(`${z.name} is a forward lookup zone; PTR records go in a reverse zone (x.x.x.in-addr.arpa).`);
  if (type !== 'PTR' && z.reverse) cx.fail(`${z.name} is a reverse lookup zone; it holds PTR records.`);
  if (type === 'CNAME' && z.records.some((r) => r.name.toLowerCase() === name)) cx.fail(`A CNAME cannot share the name ${name} with another record.`);
  if (z.records.some((r) => r.name.toLowerCase() === name && r.type === type && r.data.toLowerCase() === data.toLowerCase())) cx.fail('The resource record already exists.');
  z.records.push({ name, type, data });
  if (type === 'A' && cx.P.createptr) {
    const rev = cx.env.st.zones.find((x) => x.reverse && `${data.split('.').slice(0, 3).reverse().join('.')}.in-addr.arpa` === x.name);
    if (!rev) cx.print(`WARNING: No reverse zone covers ${data}, so no PTR record was created.\n`);
    else rev.records.push({ name: data.split('.')[3], type: 'PTR', data: `${name}.${z.name}` });
  }
  cx.env.dirtyAd = true;
  return [];
}

/* ----------------------------------------------------------------------------- natives */

registerNative({
  ipconfig: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    const a = (args[0] ?? '').toLowerCase();
    if (a === '/renew') {
      const nic = m.nics[0];
      if (!nic.dhcp) return ['Windows IP Configuration', '', `An error occurred while renewing interface ${nic.alias} : DHCP is not enabled on this adapter (it has a static address).`];
      const servers = env.est.machines.filter((x) => x.dhcp?.authorized && x.services.DHCPServer?.status === 'Running' && hasFeature(x, 'DHCP'));
      for (const srv of servers) {
        const scope = srv.dhcp!.scopes.find((s) => s.active && sameSubnet(s.start, srv.nics[0]?.ip ?? s.start, maskToPrefix(s.mask)));
        if (!scope) continue;
        const res = scope.reservations.find((r) => r.mac === nic.mac);
        const existing = scope.leases.find((l) => l.mac === nic.mac);
        const ip = res?.ip ?? existing?.ip ?? nextFree(scope);
        if (!ip) return ['Windows IP Configuration', '', `An error occurred while renewing interface ${nic.alias} : unable to contact your DHCP server. (The scope ${scope.id} has no free addresses.)`];
        if (!existing) scope.leases.push({ ip, mac: nic.mac, host: `${m.name.toLowerCase()}.${env.st.domain}` });
        Object.assign(nic, { ip, prefix: maskToPrefix(scope.mask), gateway: scope.options.router, dns: scope.options.dns ?? [] });
        env.dirtyEst = true;
        return ['Windows IP Configuration', '', `Ethernet adapter ${nic.alias}:`, '', `   Connection-specific DNS Suffix  . : ${scope.options.domain ?? ''}`, `   IPv4 Address. . . . . . . . . . . : ${ip}`, `   Subnet Mask . . . . . . . . . . . : ${scope.mask}`, `   Default Gateway . . . . . . . . . : ${scope.options.router ?? ''}`];
      }
      nic.ip = `169.254.${(m.name.length * 37) % 254}.${(m.name.length * 91) % 254 || 1}`;
      nic.prefix = 16;
      nic.gateway = undefined;
      env.dirtyEst = true;
      return ['Windows IP Configuration', '', `An error occurred while renewing interface ${nic.alias} : unable to contact your DHCP server. Request has timed out.`, `(No authorised, running DHCP server with an active scope answered. The adapter fell back to the APIPA address ${nic.ip}.)`];
    }
    if (a === '/release') {
      const nic = m.nics[0];
      if (nic.dhcp) Object.assign(nic, { ip: undefined, gateway: undefined });
      env.dirtyEst = true;
      return ['Windows IP Configuration', '', `Ethernet adapter ${nic.alias}:`, '   Media State . . . . . . . . . . . : released'];
    }
    if (a === '/flushdns') return ['Windows IP Configuration', '', 'Successfully flushed the DNS Resolver Cache.'];
    if (a === '/registerdns') {
      const zone = env.st.zones.find((z) => z.name.toLowerCase() === env.st.domain.toLowerCase());
      const ip = m.nics[0]?.ip;
      if (zone && ip && zone.dynamicUpdate !== 'None' && m.domain) {
        zone.records = zone.records.filter((r) => !(r.type === 'A' && r.name === m.name.toLowerCase()));
        zone.records.push({ name: m.name.toLowerCase(), type: 'A', data: ip });
        env.dirtyAd = true;
      }
      return ['Windows IP Configuration', '', 'Registration of the DNS resource records for all adapters of this computer has been initiated.'];
    }
    const all = a === '/all';
    const lines = ['', 'Windows IP Configuration', ''];
    if (all) lines.push(`   Host Name . . . . . . . . . . . . : ${m.name}`, `   Primary Dns Suffix  . . . . . . . : ${m.domain ?? ''}`, '');
    for (const n of m.nics) {
      lines.push(`Ethernet adapter ${n.alias}:`, '');
      if (all) lines.push(`   Physical Address. . . . . . . . . : ${n.mac}`, `   DHCP Enabled. . . . . . . . . . . : ${n.dhcp ? 'Yes' : 'No'}`);
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${n.ip ?? ''}`, `   Subnet Mask . . . . . . . . . . . : ${n.prefix ? prefixToMask(n.prefix) : ''}`, `   Default Gateway . . . . . . . . . : ${n.gateway ?? ''}`);
      if (all) lines.push(`   DNS Servers . . . . . . . . . . . : ${n.dns.join('\n                                       ')}`);
      lines.push('');
    }
    return [lines.join('\n')];
  },
  ping: (args, cx) => {
    const env = cx.env;
    const from = machine(env);
    const target = args.find((x) => !x.startsWith('-')) ?? '';
    let dst = targetMachine(env, target);
    let ip = dst?.nics[0]?.ip;
    if (!dst && !/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
      const r = resolve(env, from, target);
      ip = r.records.find((x) => x.type === 'A')?.data;
      if (!ip) return [`Ping request could not find host ${target}. Please check the name and try again.`];
      dst = targetMachine(env, ip);
    }
    if (!dst) return [`Pinging ${target} with 32 bytes of data:`, 'Request timed out.', 'Request timed out.', '', `Ping statistics for ${target}:`, '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss),'];
    const res = reach(from, dst, 'icmp');
    if (!res.ok) return [`Pinging ${target} [${ip}] with 32 bytes of data:`, 'Request timed out.', 'Request timed out.', '', `Ping statistics for ${ip}:`, '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss),', `(${res.reason})`];
    return [`Pinging ${target} [${ip}] with 32 bytes of data:`, `Reply from ${ip}: bytes=32 time<1ms TTL=128`, `Reply from ${ip}: bytes=32 time<1ms TTL=128`, '', `Ping statistics for ${ip}:`, '    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),'];
  },
  nslookup: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    const typeArg = args.find((a) => /^-(type|q|querytype)=/i.test(a));
    const type = (typeArg ? typeArg.split('=')[1] : 'A').toUpperCase() as DnsRecord['type'];
    const rest = args.filter((a) => !a.startsWith('-'));
    const name = rest[0] ?? '';
    const serverArg = rest[1];
    const serverIp = serverArg ? targetMachine(env, serverArg)?.nics[0]?.ip ?? serverArg : m.nics[0]?.dns[0];
    const srv = serverIp ? targetMachine(env, serverIp) : undefined;
    const head = [`Server:  ${srv ? `${srv.name.toLowerCase()}.${env.st.domain}` : 'UnKnown'}`, `Address:  ${serverIp ?? ''}`, ''];
    if (!serverIp) return ['*** Default servers are not available', `*** Can't find ${name}: No DNS servers configured`];
    const r = resolve(env, m, name, type, serverIp);
    if (!r.records.length) return [...head, `*** ${srv?.name.toLowerCase() ?? serverIp} can't find ${name}: ${/does not exist/.test(r.error ?? '') ? 'Non-existent domain' : r.error ?? 'No answer'}`];
    if (type === 'SRV') return [...head, ...r.records.map((x) => `${r.fqdn}\tSRV service location:\n\t  priority       = ${x.data.split(' ')[0]}\n\t  weight         = ${x.data.split(' ')[1]}\n\t  port           = ${x.data.split(' ')[2]}\n\t  svr hostname   = ${x.data.split(' ')[3]}`)];
    if (type === 'PTR') return [...head, `${r.fqdn}\tname = ${r.records[0].data}`];
    if (type === 'MX') return [...head, ...r.records.map((x) => `${r.fqdn}\tMX preference = ${x.data.split(' ')[0]}, mail exchanger = ${x.data.split(' ')[1]}`)];
    const cname = r.records.find((x) => x.type === 'CNAME');
    return [...head, `Name:    ${cname ? cname.data : r.fqdn}`, `Address${r.records.filter((x) => x.type === 'A').length > 1 ? 'es' : ''}:  ${r.records.filter((x) => x.type === 'A').map((x) => x.data).join(', ')}`, ...(cname ? [`Aliases:  ${r.fqdn}`] : [])];
  },
  dcdiag: (args, cx) => {
    const env = cx.env;
    const dc = env.est.machines.find((x) => x.dc) ?? machine(env);
    const zone = env.st.zones.find((z) => z.name.toLowerCase() === env.st.domain.toLowerCase());
    const fqdn = `${dc.name.toLowerCase()}.${env.st.domain}`;
    const srvOk = !!zone?.records.some((r) => r.type === 'SRV' && r.name === '_ldap._tcp.dc._msdcs' && r.data.endsWith(fqdn));
    const aOk = !!zone?.records.some((r) => r.type === 'A' && r.name === dc.name.toLowerCase());
    const dnsSelf = (dc.nics[0]?.dns ?? []).some((ip) => env.est.machines.some((x) => x.dc && x.nics.some((n) => n.ip === ip)));
    const timeOk = Math.abs(dc.timeOffsetMin) <= 5;
    const tests: Array<[string, boolean, string]> = [
      ['Connectivity', aOk, aOk ? '' : `The host ${fqdn} could not be resolved to an IP address (missing A record).`],
      ['Advertising', srvOk && dc.services.Netlogon?.status !== 'Stopped', srvOk ? 'Netlogon is stopped' : 'The DC is not advertising: its SRV records are missing.'],
      ['NetLogons', dc.services.Netlogon?.status !== 'Stopped', 'The Netlogon service is not running.'],
      ['Services', dc.services.NTDS?.status !== 'Stopped', 'The NTDS service is stopped.'],
      ['SystemLog', true, ''],
      ['DNS', srvOk && aOk && dnsSelf, !dnsSelf ? `${dc.name}'s DNS client points at ${dc.nics[0]?.dns.join(', ') || 'nothing'}, not a domain controller.` : 'Missing SRV or A records for the DC.'],
      ['Time', timeOk, `The clock is ${dc.timeOffsetMin} minutes off.`],
    ];
    const only = args.find((a) => /^\/test:/i.test(a))?.slice(6).toLowerCase();
    const sel = only ? tests.filter(([n]) => n.toLowerCase() === only) : tests;
    const quiet = args.some((a) => /^\/q$/i.test(a));
    const out = ['', 'Directory Server Diagnosis', '', 'Performing initial setup:', `   Home Server = ${dc.name}`, ''];
    for (const [n, ok, why] of sel) {
      if (quiet && ok) continue;
      out.push(`   Starting test: ${n}`, ...(ok ? [] : [`      ${why}`]), `      ......................... ${dc.name} ${ok ? 'passed' : 'failed'} test ${n}`);
    }
    return [out.join('\n')];
  },
  repadmin: (args, cx) => {
    const env = cx.env;
    const dcs = env.est.machines.filter((x) => x.dc);
    const a = (args[0] ?? '').toLowerCase();
    const broken = (d: Machine) => d.services.NTDS?.status === 'Stopped' || !d.nics.some((n) => n.up) || Math.abs(d.timeOffsetMin) > 5;
    if (a === '/replsummary') {
      const lines = ['Replication Summary Start Time: 2026-10-22 09:30:00', '', 'Source DSA          largest delta    fails/total %%   error'];
      for (const d of dcs) lines.push(` ${d.name.padEnd(19)}${broken(d) ? '   03d.04h:12m' : '      :02m:11s'}    ${broken(d) ? `${dcs.length - 1} /  ${dcs.length - 1}  100` : `0 /  ${Math.max(1, dcs.length - 1)}    0`}${broken(d) ? `  (${d.services.NTDS?.status === 'Stopped' ? '8524 The DSA operation is unable to proceed because of a DNS lookup failure.' : Math.abs(d.timeOffsetMin) > 5 ? '1398 There is a time and/or date difference between the client and server.' : '1722 The RPC server is unavailable.'})` : ''}`);
      return [lines.join('\n')];
    }
    if (a === '/showrepl') return [dcs.map((d) => `${d.dc!.site}\\${d.name}\n    DC=${env.st.domain.split('.').join(',DC=')}\n        ${broken(d) ? 'Last attempt failed' : 'Last attempt was successful'}`).join('\n\n')];
    if (a === '/syncall') return dcs.some(broken) ? ['SyncAll terminated with errors: replication to at least one DC failed. Run repadmin /replsummary.'] : ['SyncAll terminated with no errors.'];
    return ['Usage: repadmin /replsummary | /showrepl | /syncall /AdeP'];
  },
  nltest: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    const a = (args[0] ?? '').toLowerCase();
    if (a.startsWith('/dsgetdc:')) {
      const r = resolve(env, m, `_ldap._tcp.dc._msdcs.${a.slice(9)}`, 'SRV');
      if (!r.records.length) return ['Getting DC name failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN', '(No _ldap._tcp.dc._msdcs SRV records were found through this computer\'s DNS servers.)'];
      const host = r.records[0].data.split(' ')[3];
      return [`           DC: \\\\${host}`, `      Address: \\\\${resolve(env, m, host).records.find((x) => x.type === 'A')?.data ?? ''}`, `     Dom Name: ${env.st.domain}`, 'The command completed successfully'];
    }
    if (a === '/dsregdns') {
      if (!m.dc) return ['Flags: 0', 'Connection Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN', '(/dsregdns re-registers a domain controller\'s records; run it on a DC.)'];
      const zone = env.st.zones.find((z) => z.name.toLowerCase() === env.st.domain.toLowerCase());
      const fqdn = `${m.name.toLowerCase()}.${env.st.domain}`;
      if (zone) {
        for (const [name, port] of [['_ldap._tcp.dc._msdcs', 389], ['_kerberos._tcp.dc._msdcs', 88], ['_ldap._tcp', 389], ['_gc._tcp', 3268]] as const) if (!zone.records.some((r) => r.type === 'SRV' && r.name === name && r.data.endsWith(fqdn))) zone.records.push({ name, type: 'SRV', data: `0 100 ${port} ${fqdn}` });
        if (!zone.records.some((r) => r.type === 'A' && r.name === m.name.toLowerCase()) && m.nics[0]?.ip) zone.records.push({ name: m.name.toLowerCase(), type: 'A', data: m.nics[0].ip });
        env.dirtyAd = true;
      }
      return ['The command completed successfully'];
    }
    if (a.startsWith('/sc_query:')) return ['Flags: 30 HAS_IP  HAS_TIMESERV', `Trusted DC Name \\\\${(env.est.machines.find((x) => x.dc)?.name ?? 'DC01').toLowerCase()}.${env.st.domain}`, 'Trusted DC Connection Status Status = 0 0x0 NERR_Success', 'The command completed successfully'];
    return ['Usage: nltest /dsgetdc:<domain> | /dsregdns | /sc_query:<domain>'];
  },
  tracert: (args, cx) => {
    const env = cx.env;
    const from = machine(env);
    const target = args.find((x) => !x.startsWith('-')) ?? '';
    const dst = targetMachine(env, target);
    const ip = dst?.nics[0]?.ip ?? target;
    if (dst && sameSubnet(from.nics[0]?.ip ?? '0.0.0.0', ip, from.nics[0]?.prefix ?? 24)) return [`Tracing route to ${target} [${ip}]`, `  1    <1 ms    <1 ms    <1 ms  ${ip}`, '', 'Trace complete.'];
    if (!from.nics[0]?.gateway) return [`Tracing route to ${target}`, '  1  Transmit error: code 1231 (no default gateway).'];
    return [`Tracing route to ${target} [${ip}]`, `  1    <1 ms    <1 ms    <1 ms  ${from.nics[0].gateway}`, `  2     1 ms     1 ms     1 ms  ${ip}`, '', 'Trace complete.'];
  },
});

export type { Obj };
