/**
 * Checks for network labs, under the "net.*" namespace.
 *
 *   net.ping       { from, to, expect?: true|false }               ping succeeds (or is meant to fail)
 *   net.interface  { device, iface, subnet: "a.b.c.d/p", not?: [...] }   address set, valid host in the subnet
 *   net.gateway    { device, subnet }                              the PC's gateway is a host in that subnet (and exists)
 *   net.noDuplicates {}                                            no two interfaces share an address
 *   net.answer     { id, expected, question }                      an IP, mask, CIDR or number typed by the learner
 *   net.answers    { id, expected: [...], question }               a list (e.g. four network addresses), any order
 *   net.cable      { link, ok: true }                              a link must be in working order
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { formatCidr, formatIp, inSubnet, isNetworkOrBroadcast, networkOf, parseCidr, parseIp, parsePrefix } from './ip.js';
import { addressesInUse, deviceById, duplicateAddresses, ping, type Topology } from './sim.js';

export interface NetState {
  topology: Topology;
  answers: Record<string, string>;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

/** "192.168.1.0/24", "255.255.255.192", "/26", "62" and plain text all normalise to a comparable string. */
export function normaliseAnswer(text: string): string {
  const s = text.trim().toLowerCase();
  const cidr = parseCidr(s);
  if (cidr) return formatCidr(cidr.network, cidr.prefix);
  const ip = parseIp(s);
  if (ip !== null) return formatIp(ip);
  const p = /^\/(\d{1,2})$/.exec(s);
  if (p) return `/${Number(p[1])}`;
  const n = Number(s.replace(/,/g, ''));
  if (s !== '' && !Number.isNaN(n)) return String(n);
  return s.replace(/\s+/g, ' ');
}

/** A mask may be given as dotted or /prefix; both compare equal. */
function sameAnswer(a: string, b: string): boolean {
  const na = normaliseAnswer(a);
  const nb = normaliseAnswer(b);
  if (na === nb) return true;
  const pa = parsePrefix(a.trim());
  const pb = parsePrefix(b.trim());
  return pa !== null && pb !== null && pa === pb && (a.includes('.') || a.includes('/') || b.includes('.') || b.includes('/'));
}

export function createNetworkChecks(): CheckRegistry<NetState> {
  return new CheckRegistry<NetState>()
    .register('net.ping', async (state, spec) => {
      const from = String(spec.from);
      const to = String(spec.to);
      const expect = spec.expect !== false;
      const r = ping(state.topology, from, to);
      const src = deviceById(state.topology, from)?.name ?? from;
      if (r.ok === expect) {
        return pass(spec, expect ? `${src} reaches ${to} and the reply comes back (${r.pathDevices.length - 1} hop${r.pathDevices.length === 2 ? '' : 's'}).` : `${src} cannot reach ${to}, as intended.`);
      }
      return fail(spec, expect ? `Ping from ${src} to ${to} fails: ${r.reason}` : `Ping from ${src} to ${to} succeeds, but this lab needs it blocked.`, r);
    })

    .register('net.interface', async (state, spec) => {
      const d = deviceById(state.topology, String(spec.device));
      const i = d?.interfaces.find((x) => x.id === String(spec.iface));
      if (!d || !i) return fail(spec, `No interface ${String(spec.iface)} on ${String(spec.device)}. This is a content error, not yours.`);
      const cidr = parseCidr(String(spec.subnet));
      if (!cidr) return fail(spec, 'This check has an invalid subnet. This is a content error, not yours.');
      if (!i.ip || parseIp(i.ip) === null) return fail(spec, `Give ${d.name} (${i.id}) an IP address.`);
      const prefix = i.mask ? parsePrefix(i.mask) : null;
      if (prefix === null) return fail(spec, `Give ${d.name} (${i.id}) a valid subnet mask (for example ${formatIp(((0xffffffff << (32 - cidr.prefix)) >>> 0))} or /${cidr.prefix}).`);
      const ip = parseIp(i.ip)!;
      if (prefix !== cidr.prefix) return fail(spec, `${d.name}'s mask is /${prefix}, but ${String(spec.subnet)} needs /${cidr.prefix} (${formatIp(((0xffffffff << (32 - cidr.prefix)) >>> 0))}).`);
      if (!inSubnet(ip, cidr.network, cidr.prefix)) return fail(spec, `${d.name}'s address ${i.ip} is not inside ${String(spec.subnet)}.`);
      if (isNetworkOrBroadcast(ip, prefix)) return fail(spec, `${i.ip} is the network or broadcast address of ${String(spec.subnet)}; pick an address in between.`);
      const not = ((spec.not as string[] | undefined) ?? []).map((x) => parseIp(x));
      if (not.includes(ip)) return fail(spec, `${i.ip} is reserved in this lab; choose a different host address.`);
      return pass(spec, `${d.name} has ${i.ip} /${prefix} in ${formatCidr(networkOf(ip, prefix), prefix)}.`);
    })

    .register('net.gateway', async (state, spec) => {
      const d = deviceById(state.topology, String(spec.device));
      if (!d) return fail(spec, `No device ${String(spec.device)}. This is a content error, not yours.`);
      const cidr = parseCidr(String(spec.subnet));
      if (!cidr) return fail(spec, 'This check has an invalid subnet. This is a content error, not yours.');
      const gw = d.gateway ? parseIp(d.gateway) : null;
      if (gw === null) return fail(spec, `Set a default gateway on ${d.name}.`);
      if (!inSubnet(gw, cidr.network, cidr.prefix)) return fail(spec, `${d.name}'s gateway ${d.gateway} is not in its subnet ${String(spec.subnet)}.`);
      const owner = addressesInUse(state.topology).find((a) => parseIp(a.ip) === gw);
      const ownerDevice = owner ? deviceById(state.topology, owner.device) : undefined;
      if (!ownerDevice) return fail(spec, `No device has the address ${d.gateway}; the gateway must be a router interface.`);
      if (ownerDevice.kind !== 'router') return fail(spec, `${d.gateway} belongs to ${ownerDevice.name}, which is not a router.`);
      return pass(spec, `${d.name}'s gateway is ${ownerDevice.name} at ${d.gateway}.`);
    })

    .register('net.noDuplicates', async (state, spec) => {
      const dups = duplicateAddresses(state.topology);
      return dups.length ? fail(spec, `The address${dups.length > 1 ? 'es' : ''} ${dups.join(', ')} ${dups.length > 1 ? 'are' : 'is'} used by more than one device.`) : pass(spec, 'Every address is unique.');
    })

    .register('net.cable', async (state, spec) => {
      const l = state.topology.links.find((x) => x.id === String(spec.link));
      if (!l) return fail(spec, `No link ${String(spec.link)}. This is a content error, not yours.`);
      return l.broken ? fail(spec, String(spec.message ?? 'A cable is still faulty. Click it on the diagram and replace it.')) : pass(spec, 'The cable is in working order.');
    })

    .register('net.answer', async (state, spec) => {
      const text = (state.answers[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      return sameAnswer(text, String(spec.expected)) ? pass(spec, String(spec.success ?? `Right: ${String(spec.expected)}.`)) : fail(spec, String(spec.message ?? 'Not quite. Use the subnet calculator and check your working.'));
    })

    .register('net.answers', async (state, spec) => {
      const text = (state.answers[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      const got = text.split(/[,\s;]+/).filter(Boolean);
      const expected = (spec.expected as string[]).map(String);
      const missing = expected.filter((e) => !got.some((g) => sameAnswer(g, e)));
      const extra = got.filter((g) => !expected.some((e) => sameAnswer(g, e)));
      if (!missing.length && !extra.length) return pass(spec, String(spec.success ?? `Right: ${expected.join(', ')}.`));
      const parts = [];
      if (missing.length) parts.push(`missing ${missing.join(', ')}`);
      if (extra.length) parts.push(`${extra.join(', ')} should not be there`);
      return fail(spec, `Not quite: ${parts.join('; ')}.`);
    });
}
