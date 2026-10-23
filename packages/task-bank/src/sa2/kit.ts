/** Shared building blocks for the Systems Administration II (Linux) templates. */

import type { CheckSpec } from '@cslab/lab-runtime';
import type { SystemSpec } from '@cslab/engine-shell/src/system';
import { templateMaker } from '../common';

export { caseStudy, lab, mdSafe } from '../common';
export type { Variant } from '../types';

export const COURSE = 'systems-administration-ii';
export const tmpl = templateMaker(COURSE, 'sa2');

export const HOSTS = ['web01', 'files01', 'lab-srv', 'dept-srv', 'lib-srv', 'reg-srv', 'mail01', 'ict-srv02'];
export const DEPTS = ['finance', 'registry', 'library', 'estates', 'research', 'exams', 'admissions', 'procurement'];

/** A Linux machine on a variant subnet. `net` is "10.A.B"; the machine is .5 unless `last` says otherwise. */
export function linux(net: string, spec: Partial<SystemSpec> & { last?: number } = {}): Record<string, unknown> {
  const { last = 5, ...rest } = spec;
  return {
    system: {
      user: 'root',
      hostname: 'srv1',
      network: { address: `${net}.${last}/24`, gateway: `${net}.1`, hosts: {} },
      ...rest,
      files: { '/etc/hosts': `127.0.0.1\tlocalhost\n${net}.${last}\t${rest.hostname ?? 'srv1'}\n`, '/etc/resolv.conf': `nameserver ${net}.1\n`, ...(rest.files ?? {}) },
    } satisfies SystemSpec,
  };
}

type Text = { contains?: string | string[]; notContains?: string | string[]; pattern?: string; equals?: string; message?: string };
export const file = (label: string, path: string, o: Text & { exists?: boolean; kind?: 'file' | 'dir' | 'link'; mode?: string; owner?: string; group?: string; acl?: string } = {}): CheckSpec => ({ type: 'sh.file', label, path, ...o });
export const out = (label: string, command: string, o: Text & { status?: number } = {}): CheckSpec => ({ type: 'sh.output', label, command, ...o });
export const ran = (label: string, pattern: string, message?: string): CheckSpec => ({ type: 'sh.ran', label, pattern, ...(message ? { message } : {}) });
export const user = (label: string, name: string, o: { exists?: boolean; groups?: string[]; shell?: string; home?: string; homeExists?: boolean; locked?: boolean; hasPassword?: boolean; sudo?: boolean; message?: string } = {}): CheckSpec => ({ type: 'sh.user', label, name, ...o });
export const group = (label: string, name: string, o: { exists?: boolean; members?: string[] } = {}): CheckSpec => ({ type: 'sh.group', label, name, ...o });
export const svc = (label: string, name: string, o: { active?: boolean; enabled?: boolean; message?: string } = {}): CheckSpec => ({ type: 'sh.service', label, name, ...o });
export const pkg = (label: string, name: string, installed = true): CheckSpec => ({ type: 'sh.package', label, name, installed });
export const cron = (label: string, userName: string, pattern: string, message?: string): CheckSpec => ({ type: 'sh.cron', label, user: userName, pattern, ...(message ? { message } : {}) });
export const proc = (label: string, name: string, running: boolean): CheckSpec => ({ type: 'sh.process', label, name, running });
export const script = (label: string, path: string, o: Text & { args?: string[]; stdin?: string; status?: number; creates?: string | string[]; as?: string } = {}): CheckSpec => ({ type: 'sh.script', label, path, ...o });

/** Escapes a string for use inside a check pattern. */
export const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Storage state for the LVM commands: extra blank disks sdb, sdc, ... */
export function disks(...sizes: number[]): Record<string, string> {
  return { '/etc/lvm/lab-state.json': JSON.stringify({ disks: sizes.map((s, i) => ({ name: `sd${String.fromCharCode(98 + i)}`, sizeGb: s })) }) };
}

/** A local BIND server with one forward zone. */
export function bindZone(zone: string, net: string, records: string, opts: { serial?: number; extraConf?: string; zoneOpts?: string } = {}): Record<string, string> {
  return {
    '/etc/named.conf': `options {\n    directory "/var/lib/named";\n    listen-on port 53 { any; };\n    allow-query { any; };\n    recursion yes;\n};\n\nzone "${zone}" in {\n    type master;\n    file "${zone}.zone";${opts.zoneOpts ? `\n    ${opts.zoneOpts}` : ''}\n};\n${opts.extraConf ?? ''}`,
    [`/var/lib/named/${zone}.zone`]: `$TTL 3600\n@\tIN\tSOA\tns1.${zone}. hostmaster.${zone}. ( ${opts.serial ?? 2026102101} 3600 900 604800 300 )\n\tIN\tNS\tns1\nns1\tIN\tA\t${net}.5\n${records}`,
  };
}
