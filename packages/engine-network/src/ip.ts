/** IPv4 addressing helpers. Addresses are dotted decimal strings; masks are dotted or /prefix. */

export function parseIp(text: string): number | null {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(text ?? '');
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function formatIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isValidIp(text: string): boolean {
  return parseIp(text) !== null;
}

/** Accepts "255.255.255.0", "/24" or "24". Returns the prefix length or null. */
export function parsePrefix(mask: string): number | null {
  const s = (mask ?? '').trim();
  const p = /^\/?(\d{1,2})$/.exec(s);
  if (p) {
    const n = Number(p[1]);
    return n >= 0 && n <= 32 ? n : null;
  }
  const v = parseIp(s);
  if (v === null) return null;
  // must be contiguous ones followed by zeros
  let ones = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    const bit = (v >>> i) & 1;
    if (bit) {
      if (seenZero) return null;
      ones++;
    } else seenZero = true;
  }
  return ones;
}

export function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function formatMask(prefix: number): string {
  return formatIp(maskOf(prefix));
}

export function networkOf(ip: number, prefix: number): number {
  return (ip & maskOf(prefix)) >>> 0;
}

export function broadcastOf(ip: number, prefix: number): number {
  return (networkOf(ip, prefix) | (~maskOf(prefix) >>> 0)) >>> 0;
}

export function usableHosts(prefix: number): number {
  if (prefix >= 31) return prefix === 31 ? 2 : 1;
  return Math.pow(2, 32 - prefix) - 2;
}

export function sameSubnet(a: number, b: number, prefix: number): boolean {
  return networkOf(a, prefix) === networkOf(b, prefix);
}

export function inSubnet(ip: number, network: number, prefix: number): boolean {
  return networkOf(ip, prefix) === networkOf(network, prefix);
}

/** "192.168.1.0/24" → { network, prefix }, or null. */
export function parseCidr(text: string): { network: number; prefix: number } | null {
  const m = /^\s*([\d.]+)\s*\/\s*(\d{1,2})\s*$/.exec(text ?? '');
  if (!m) return null;
  const ip = parseIp(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  return { network: networkOf(ip, prefix), prefix };
}

export function formatCidr(network: number, prefix: number): string {
  return `${formatIp(network)}/${prefix}`;
}

export function toBinary(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map((o) => o.toString(2).padStart(8, '0')).join('.');
}

/** Smallest prefix that gives at least `hosts` usable addresses. */
export function prefixForHosts(hosts: number): number {
  for (let p = 30; p >= 0; p--) if (usableHosts(p) >= hosts) return p;
  return 0;
}

export interface SubnetInfo {
  cidr: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  mask: string;
  prefix: number;
  usable: number;
}

export function describeSubnet(ip: number, prefix: number): SubnetInfo {
  const net = networkOf(ip, prefix);
  const bc = broadcastOf(ip, prefix);
  return {
    cidr: formatCidr(net, prefix),
    network: formatIp(net),
    broadcast: formatIp(bc),
    firstHost: formatIp(prefix >= 31 ? net : net + 1),
    lastHost: formatIp(prefix >= 31 ? bc : bc - 1),
    mask: formatMask(prefix),
    prefix,
    usable: usableHosts(prefix),
  };
}

/** Splits a block into equal subnets of the given prefix. */
export function splitEqually(network: number, prefix: number, newPrefix: number): SubnetInfo[] {
  const count = Math.pow(2, newPrefix - prefix);
  const size = Math.pow(2, 32 - newPrefix);
  const out: SubnetInfo[] = [];
  for (let i = 0; i < count; i++) out.push(describeSubnet((network + i * size) >>> 0, newPrefix));
  return out;
}

/** VLSM: allocates subnets for host counts, largest first, from the start of the block. */
export function vlsm(network: number, prefix: number, hostCounts: Array<{ name: string; hosts: number }>): Array<SubnetInfo & { name: string; hosts: number }> {
  const sorted = [...hostCounts].sort((a, b) => b.hosts - a.hosts);
  let cursor = network;
  const end = broadcastOf(network, prefix) + 1;
  const out: Array<SubnetInfo & { name: string; hosts: number }> = [];
  for (const h of sorted) {
    const p = prefixForHosts(h.hosts);
    const size = Math.pow(2, 32 - p);
    if (cursor + size > end) throw new Error(`The block ${formatCidr(network, prefix)} is too small for ${h.name} (${h.hosts} hosts).`);
    out.push({ ...describeSubnet(cursor, p), name: h.name, hosts: h.hosts });
    cursor = (cursor + size) >>> 0;
  }
  return out;
}

/** True for addresses a host may not use: the network and broadcast addresses of its subnet. */
export function isNetworkOrBroadcast(ip: number, prefix: number): boolean {
  if (prefix >= 31) return false;
  return ip === networkOf(ip, prefix) || ip === broadcastOf(ip, prefix);
}
