/** Shared building blocks for the Scripting and IT Automation templates: Linux and Windows machines, scripts and checks. */

import type { WinLabSpec } from '@cslab/engine-shell/src/win/model';
import { templateMaker } from '../common';
import { system } from '../sa1/kit';

export { caseStudy, lab, mdSafe } from '../common';
export type { Person, Variant } from '../types';
export { DEPTS, HOSTS, cron, file, group, linux, out, pkg, proc, ran, re, script, svc, user } from '../sa2/kit';
export { DC, DOMAIN, NB, PW, SECURE, addGroup, addOu, addUser, answer, dc01, fs01, groupCheck, nic, ouCheck, ouDn, pc, ps, secEvent, userCheck } from '../sa1/kit';

/** A Windows estate; the first machine has the team's C:\Scripts folder. */
export function windows(spec: WinLabSpec): Record<string, unknown> {
  return system({ ...spec, files: { 'C:\\Scripts\\README.txt': 'Scripts for the ICT office. Keep one script per task.\n', ...(spec.files ?? {}) } });
}

export const COURSE = 'scripting-and-it-automation';
export const tmpl = templateMaker(COURSE, 'sia');

/** A bash script body with its shebang. */
export const SH = (body: string) => `#!/bin/bash\n${body}`;

/** A solution line that writes a file with a quoted here-document (nothing inside expands). */
export const write = (path: string, body: string) => `cat > ${path} <<'EOF'\n${body.endsWith('\n') ? body : body + '\n'}EOF`;

/** A solution line that writes a bash script and makes it executable. */
export const writeScript = (path: string, body: string) => write(path, SH(body)).replace(`<<'EOF'\n`, `<<'EOF' && chmod +x ${path}\n`);

/** A PowerShell solution line that writes a file from a literal here-string. */
export const psWrite = (path: string, body: string) => `Set-Content -Path ${path} -Value @'\n${body.replace(/\n$/, '')}\n'@`;

type WinSvc = { status: 'Running' | 'Stopped'; start: 'Automatic' | 'Manual' | 'Disabled' };
export const RUNNING: WinSvc = { status: 'Running', start: 'Automatic' };
export const STOPPED_AUTO: WinSvc = { status: 'Stopped', start: 'Automatic' };
export const STOPPED_MANUAL: WinSvc = { status: 'Stopped', start: 'Manual' };

/** The services of a domain controller, plus extra ones. */
export function dcServices(extra: Record<string, WinSvc> = {}): Record<string, WinSvc> {
  return { Spooler: RUNNING, W32Time: RUNNING, WinRM: RUNNING, LanmanServer: RUNNING, Dnscache: RUNNING, EventLog: RUNNING, BITS: STOPPED_MANUAL, DNS: RUNNING, NTDS: RUNNING, Netlogon: RUNNING, Kdc: RUNNING, ...extra };
}

/** Application services a lab server may run (service name → what it is). */
export const APP_SERVICES: Record<string, string> = { W3SVC: 'IIS web server', MSSQLSERVER: 'SQL Server', SQLSERVERAGENT: 'SQL Server Agent', LabBackupAgent: 'backup agent', PrintAudit: 'print auditing', MoodleCron: 'learning platform jobs', SnipeSync: 'asset inventory sync', TermService: 'Remote Desktop' };

/** CSV text from a header and rows. */
export const csv = (header: string, rows: Array<Array<string | number>>) => [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';
