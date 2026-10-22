/**
 * A small network simulator: PCs, switches and routers joined by links. Switches forward
 * within a broadcast domain; routers forward between subnets using connected and static
 * routes with longest-prefix match. ping() traces the request to the destination and the
 * reply back, and explains the first thing that goes wrong in plain words.
 */

import { formatIp, inSubnet, isNetworkOrBroadcast, networkOf, parseCidr, parseIp, parsePrefix, sameSubnet } from './ip.js';

export type DeviceKind = 'pc' | 'switch' | 'router' | 'server';

export interface Iface {
  id: string;
  ip?: string;
  mask?: string;
  /** Administratively down. Default up. */
  down?: boolean;
}

export interface Route {
  /** "192.168.2.0/24" or "0.0.0.0/0" */
  network: string;
  via: string;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  x: number;
  y: number;
  interfaces: Iface[];
  /** PCs and servers: default gateway. */
  gateway?: string;
  /** Routers: static routes. */
  routes?: Route[];
}

export interface Link {
  id: string;
  a: { device: string; iface: string };
  b: { device: string; iface: string };
  /** A faulty cable. */
  broken?: boolean;
}

export interface Topology {
  devices: Device[];
  links: Link[];
}

export interface Hop {
  device: string;
  iface: string;
  ip?: string;
  note: string;
}

export interface PingResult {
  ok: boolean;
  /** Plain-language reason when not ok. */
  reason: string | null;
  request: Hop[];
  reply: Hop[];
  /** Devices the packet passed through on the way there (including source and destination). */
  pathDevices: string[];
}

export function deviceById(t: Topology, id: string): Device | undefined {
  return t.devices.find((d) => d.id === id);
}

function ifaceOf(d: Device, id: string): Iface | undefined {
  return d.interfaces.find((i) => i.id === id);
}

function ifacePrefix(i: Iface): number | null {
  return i.mask ? parsePrefix(i.mask) : null;
}

function ifaceIp(i: Iface): number | null {
  return i.ip ? parseIp(i.ip) : null;
}

/** Interfaces (device + iface) on the same layer-2 segment as the given interface, going through switches. */
export function segmentOf(t: Topology, deviceId: string, ifaceId: string): Array<{ device: Device; iface: Iface }> {
  const out: Array<{ device: Device; iface: Iface }> = [];
  const seen = new Set<string>();
  const stack: Array<{ device: string; iface: string }> = [{ device: deviceId, iface: ifaceId }];
  while (stack.length) {
    const cur = stack.pop()!;
    const key = `${cur.device}:${cur.iface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dev = deviceById(t, cur.device);
    if (!dev) continue;
    const ifc = ifaceOf(dev, cur.iface);
    if (!ifc || ifc.down) continue;
    if (dev.kind !== 'switch') out.push({ device: dev, iface: ifc });
    // Follow the cable on this interface.
    for (const l of t.links) {
      if (l.broken) continue;
      let other: { device: string; iface: string } | null = null;
      if (l.a.device === cur.device && l.a.iface === cur.iface) other = l.b;
      else if (l.b.device === cur.device && l.b.iface === cur.iface) other = l.a;
      if (!other) continue;
      const od = deviceById(t, other.device);
      if (!od) continue;
      if (od.kind === 'switch') {
        const port = ifaceOf(od, other.iface);
        if (port?.down) continue;
        // A switch floods to every other port.
        for (const p of od.interfaces) if (!p.down) stack.push({ device: od.id, iface: p.id });
      } else stack.push(other);
    }
  }
  return out.filter((e) => !(e.device.id === deviceId && e.iface.id === ifaceId));
}

interface Lookup {
  egress: Iface;
  nextHop: number;
  how: string;
}

/** Where a device sends a packet for dst: directly (same subnet) or via a gateway/route. */
function lookup(d: Device, dst: number): Lookup | string {
  const ifaces = d.interfaces.filter((i) => ifaceIp(i) !== null && ifacePrefix(i) !== null && !i.down);
  if (ifaces.length === 0) return `${d.name} has no interface with an IP address and mask.`;
  // Connected networks first (longest prefix).
  let best: { prefix: number; egress: Iface; nextHop: number; how: string } | null = null;
  for (const i of ifaces) {
    const p = ifacePrefix(i)!;
    if (sameSubnet(ifaceIp(i)!, dst, p) && (!best || p > best.prefix)) best = { prefix: p, egress: i, nextHop: dst, how: `${formatIp(dst)} is on the same subnet as ${i.id}` };
  }
  if (d.kind === 'router') {
    for (const r of d.routes ?? []) {
      const c = parseCidr(r.network);
      const via = parseIp(r.via);
      if (!c || via === null) continue;
      if (!inSubnet(dst, c.network, c.prefix)) continue;
      if (best && c.prefix <= best.prefix) continue;
      const egress = ifaces.find((i) => sameSubnet(ifaceIp(i)!, via, ifacePrefix(i)!));
      if (!egress) return `${d.name} has a route to ${r.network} via ${r.via}, but no interface is on that gateway's subnet.`;
      best = { prefix: c.prefix, egress, nextHop: via, how: `route ${r.network} via ${r.via}` };
    }
    if (!best) return `${d.name} has no route to ${formatIp(dst)}: it is not a connected network and no static or default route matches.`;
  } else if (!best) {
    if (!d.gateway) return `${d.name} cannot reach ${formatIp(dst)}: it is on another subnet and ${d.name} has no default gateway.`;
    const gw = parseIp(d.gateway);
    if (gw === null) return `${d.name} has an invalid default gateway "${d.gateway}".`;
    const egress = ifaces.find((i) => sameSubnet(ifaceIp(i)!, gw, ifacePrefix(i)!));
    if (!egress) return `${d.name}'s default gateway ${d.gateway} is not on ${d.name}'s own subnet (${describeIface(ifaces[0])}).`;
    best = { prefix: 0, egress, nextHop: gw, how: `${formatIp(dst)} is on another subnet, so send to the default gateway ${d.gateway}` };
  }
  return { egress: best.egress, nextHop: best.nextHop, how: best.how };
}

function describeIface(i: Iface): string {
  return `${i.ip ?? '?'} /${ifacePrefix(i) ?? '?'}`;
}

/** Traces an IP packet from a device to an address. */
function trace(t: Topology, fromId: string, dst: number): { hops: Hop[]; arrived: Device | null; reason: string | null } {
  const hops: Hop[] = [];
  let cur = deviceById(t, fromId);
  if (!cur) return { hops, arrived: null, reason: `No device "${fromId}".` };
  const visited = new Set<string>();
  for (let ttl = 0; ttl < 16; ttl++) {
    if (visited.has(cur.id)) return { hops, arrived: null, reason: `The packet is going round in a loop at ${cur.name}: check the routes.` };
    visited.add(cur.id);
    // Does this device itself own the destination?
    if (cur.interfaces.some((i) => ifaceIp(i) === dst && !i.down)) {
      hops.push({ device: cur.id, iface: cur.interfaces.find((i) => ifaceIp(i) === dst)!.id, ip: formatIp(dst), note: `${cur.name} receives the packet.` });
      return { hops, arrived: cur, reason: null };
    }
    const l = lookup(cur, dst);
    if (typeof l === 'string') return { hops, arrived: null, reason: l };
    hops.push({ device: cur.id, iface: l.egress.id, ip: l.egress.ip, note: `${cur.name}: ${l.how}; send out of ${l.egress.id}.` });
    // Resolve the next hop on the segment (ARP).
    const seg = segmentOf(t, cur.id, l.egress.id);
    const owners = seg.filter((e) => ifaceIp(e.iface) === l.nextHop);
    const egressPrefix = ifacePrefix(l.egress)!;
    if (owners.length === 0) {
      const dup = seg.length === 0 ? ` Nothing answers on ${l.egress.id}: check the cable and that the other end is up.` : '';
      const nh = formatIp(l.nextHop);
      const wrongMask = seg.find((e) => ifaceIp(e.iface) !== null && !sameSubnet(ifaceIp(e.iface)!, ifaceIp(l.egress)!, egressPrefix) && sameSubnet(ifaceIp(e.iface)!, ifaceIp(l.egress)!, ifacePrefix(e.iface) ?? egressPrefix));
      const hint = wrongMask ? ` ${wrongMask.device.name} is on the cable but its address ${describeIface(wrongMask.iface)} is not in ${cur.name}'s subnet: check the masks.` : '';
      return { hops, arrived: null, reason: `${cur.name} cannot find ${nh} on the network attached to ${l.egress.id} (no ARP reply).${dup}${hint}` };
    }
    if (owners.length > 1) {
      return { hops, arrived: null, reason: `Two devices answer for ${formatIp(l.nextHop)}: ${owners.map((o) => o.device.name).join(' and ')}. Duplicate IP address.` };
    }
    const next = owners[0];
    if (next.device.kind !== 'router' && ifaceIp(next.iface) !== dst) {
      return { hops, arrived: null, reason: `${cur.name} sent the packet to ${next.device.name}, which is not a router and will not forward it.` };
    }
    if (next.device.kind === 'router' && ifaceIp(next.iface) === dst) {
      hops.push({ device: next.device.id, iface: next.iface.id, ip: next.iface.ip, note: `${next.device.name} receives the packet.` });
      return { hops, arrived: next.device, reason: null };
    }
    if (next.device.kind !== 'router') {
      hops.push({ device: next.device.id, iface: next.iface.id, ip: next.iface.ip, note: `${next.device.name} receives the packet.` });
      return { hops, arrived: next.device, reason: null };
    }
    hops.push({ device: next.device.id, iface: next.iface.id, ip: next.iface.ip, note: `${next.device.name} receives it on ${next.iface.id} and looks up ${formatIp(dst)}.` });
    cur = next.device;
  }
  return { hops, arrived: null, reason: 'The packet travelled through too many routers (TTL exceeded).' };
}

export function resolveTarget(t: Topology, target: string): number | null {
  const ip = parseIp(target);
  if (ip !== null) return ip;
  const d = t.devices.find((x) => x.id === target || x.name.toLowerCase() === target.toLowerCase());
  const withIp = d?.interfaces.find((i) => ifaceIp(i) !== null && !i.down);
  return withIp ? ifaceIp(withIp) : null;
}

export function ping(t: Topology, fromId: string, target: string): PingResult {
  const src = deviceById(t, fromId);
  if (!src) return { ok: false, reason: `No device "${fromId}".`, request: [], reply: [], pathDevices: [] };
  const dst = resolveTarget(t, target);
  if (dst === null) return { ok: false, reason: `"${target}" is not an IP address or a device with an address.`, request: [], reply: [], pathDevices: [] };
  const srcIface = src.interfaces.find((i) => ifaceIp(i) !== null && !i.down);
  if (!srcIface) return { ok: false, reason: `${src.name} has no IP address.`, request: [], reply: [], pathDevices: [] };
  const p = ifacePrefix(srcIface);
  if (p === null) return { ok: false, reason: `${src.name} has an invalid subnet mask "${srcIface.mask}".`, request: [], reply: [], pathDevices: [] };
  if (isNetworkOrBroadcast(ifaceIp(srcIface)!, p)) return { ok: false, reason: `${src.name}'s address ${srcIface.ip} is the network or broadcast address of its subnet; a host cannot use it.`, request: [], reply: [], pathDevices: [] };
  const req = trace(t, fromId, dst);
  if (req.reason || !req.arrived) return { ok: false, reason: req.reason ?? 'Request lost.', request: req.hops, reply: [], pathDevices: req.hops.map((h) => h.device) };
  const rep = trace(t, req.arrived.id, ifaceIp(srcIface)!);
  if (rep.reason || !rep.arrived) {
    return {
      ok: false,
      reason: `The request reached ${req.arrived.name}, but the reply could not get back: ${rep.reason ?? 'reply lost.'}`,
      request: req.hops,
      reply: rep.hops,
      pathDevices: [...new Set(req.hops.map((h) => h.device))],
    };
  }
  return { ok: true, reason: null, request: req.hops, reply: rep.hops, pathDevices: [...new Set(req.hops.map((h) => h.device))] };
}

/** Every address in use, with its owner, for duplicate checks. */
export function addressesInUse(t: Topology): Array<{ ip: string; device: string; iface: string }> {
  const out: Array<{ ip: string; device: string; iface: string }> = [];
  for (const d of t.devices) for (const i of d.interfaces) if (i.ip && parseIp(i.ip) !== null) out.push({ ip: formatIp(parseIp(i.ip)!), device: d.id, iface: i.id });
  return out;
}

export function duplicateAddresses(t: Topology): string[] {
  const seen = new Map<string, number>();
  for (const a of addressesInUse(t)) seen.set(a.ip, (seen.get(a.ip) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([ip]) => ip);
}

/** A copy of the topology with one interface changed. */
export function setIface(t: Topology, deviceId: string, ifaceId: string, patch: Partial<Iface>): Topology {
  return {
    ...t,
    devices: t.devices.map((d) => (d.id !== deviceId ? d : { ...d, interfaces: d.interfaces.map((i) => (i.id !== ifaceId ? i : { ...i, ...patch })) })),
  };
}

export function setDevice(t: Topology, deviceId: string, patch: Partial<Device>): Topology {
  return { ...t, devices: t.devices.map((d) => (d.id !== deviceId ? d : { ...d, ...patch })) };
}

export function setLink(t: Topology, linkId: string, patch: Partial<Link>): Topology {
  return { ...t, links: t.links.map((l) => (l.id !== linkId ? l : { ...l, ...patch })) };
}

export function validateTopology(raw: unknown): raw is Topology {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as Topology;
  if (!Array.isArray(t.devices) || !Array.isArray(t.links)) return false;
  const ids = new Set<string>();
  for (const d of t.devices) {
    if (!d || typeof d.id !== 'string' || !['pc', 'switch', 'router', 'server'].includes(d.kind) || !Array.isArray(d.interfaces)) return false;
    if (ids.has(d.id)) return false;
    ids.add(d.id);
  }
  for (const l of t.links) {
    for (const end of [l.a, l.b]) {
      const d = t.devices.find((x) => x.id === end?.device);
      if (!d || !d.interfaces.some((i) => i.id === end.iface)) return false;
    }
  }
  return true;
}

export { networkOf };
