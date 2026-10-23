/**
 * Core cmdlets: files, the pipeline, sessions and remoting, and the machine itself (features,
 * services, processes, events, counters, scheduled tasks, storage, Hyper-V, time, activation).
 */

import { FsError, listDir, lookup, mkdir, readFile, remove, writeFile } from '../fs.js';
import { asList, bool, condition, isObj, isSecure, machine, machineByName, normWin, num, prop, register, registerNative, render, SECURE, show, str, toVfs, toWin, type Cx, type Obj, type Secure, type Value } from './core.js';
import { driveRoot, type Machine, type Disk } from './model.js';

const ROOT = { user: 'root', groups: ['root'] };
const NOW = '10/22/2026  9:30 AM';

export function fileItem(name: string, isDir: boolean, length: number | ''): Obj {
  return { __type: 'file', Mode: isDir ? 'd-----' : '-a----', LastWriteTime: NOW, Length: length, Name: name };
}

/** Reads a file, including from a shadow copy path \\server\D$\@GMT-...\x. */
export function readWinFile(cx: Cx, p: string): string {
  const gmt = /@GMT-[\d.-]+/i.exec(p);
  if (gmt) {
    const unc = /^\\\\([^\\]+)\\([a-z])\$\\@GMT-[\d.-]+(\\.*)$/i.exec(p);
    const m = unc ? machineByName(cx.env, unc[1]) : undefined;
    const snap = m?.shadows.find((s) => s.volume.toUpperCase() === `${unc![2].toUpperCase()}:` && p.includes(`@GMT-${s.time}`));
    const inner = unc ? normWin(`${unc[2]}:${unc[3]}`) : '';
    if (!snap || snap.files[inner] === undefined) cx.fail(`Cannot find path '${p}' because it does not exist.`);
    return snap!.files[inner];
  }
  return readFile(cx.env.sys.fs, toVfs(cx.env, p), ROOT);
}

const path = (cx: Cx, dflt = '.') => str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0] ?? dflt);

export function features(): Array<{ name: string; display: string; parent?: string }> {
  return [
    { name: 'AD-Domain-Services', display: 'Active Directory Domain Services' },
    { name: 'DNS', display: 'DNS Server' },
    { name: 'DHCP', display: 'DHCP Server' },
    { name: 'FS-FileServer', display: 'File Server' },
    { name: 'FS-Resource-Manager', display: 'File Server Resource Manager' },
    { name: 'FS-DFS-Namespace', display: 'DFS Namespaces' },
    { name: 'FS-DFS-Replication', display: 'DFS Replication' },
    { name: 'Print-Services', display: 'Print and Document Services' },
    { name: 'Print-Server', display: 'Print Server', parent: 'Print-Services' },
    { name: 'Web-Server', display: 'Web Server (IIS)' },
    { name: 'Hyper-V', display: 'Hyper-V' },
    { name: 'ADCS-Cert-Authority', display: 'Certification Authority' },
    { name: 'ADFS-Federation', display: 'Active Directory Federation Services' },
    { name: 'RDS-RD-Server', display: 'Remote Desktop Session Host' },
    { name: 'RDS-Connection-Broker', display: 'Remote Desktop Connection Broker' },
    { name: 'RDS-Web-Access', display: 'Remote Desktop Web Access' },
    { name: 'Web-Application-Proxy', display: 'Web Application Proxy' },
    { name: 'UpdateServices', display: 'Windows Server Update Services' },
    { name: 'WDS', display: 'Windows Deployment Services' },
    { name: 'Windows-Server-Backup', display: 'Windows Server Backup' },
    { name: 'GPMC', display: 'Group Policy Management' },
    { name: 'RSAT-AD-PowerShell', display: 'Active Directory module for Windows PowerShell' },
    { name: 'Failover-Clustering', display: 'Failover Clustering' },
    { name: 'Telnet-Client', display: 'Telnet Client' },
  ];
}

/** Features that Server Core cannot install because they need the desktop. */
const NEEDS_DESKTOP = new Set(['RDS-Web-Access']);

const SERVICE_OF: Record<string, string> = { DHCP: 'DHCPServer', DNS: 'DNS', 'Print-Server': 'Spooler', 'Web-Server': 'W3SVC', 'AD-Domain-Services': 'NTDS', UpdateServices: 'WsusService', WDS: 'WDSServer', 'ADCS-Cert-Authority': 'CertSvc', 'FS-Resource-Manager': 'SrmSvc', 'FS-DFS-Replication': 'DFSR', 'FS-DFS-Namespace': 'Dfs', 'RDS-RD-Server': 'TermService', 'Hyper-V': 'vmms' };

export function hasFeature(m: Machine, name: string): boolean {
  return m.features.some((f) => f.toLowerCase() === name.toLowerCase());
}

export function requireFeature(cx: Cx, m: Machine, feature: string, what: string): void {
  if (!hasFeature(m, feature)) cx.fail(`The term is not available on ${m.name}: install the ${feature} feature first (Install-WindowsFeature ${feature} -IncludeManagementTools) to use ${what}.`);
}

function diskView(d: Disk): Obj {
  const used = d.partitions.reduce((a, p) => a + p.sizeGb, 0);
  return { __type: 'disk', Number: d.number, 'Friendly Name': d.friendlyName ?? 'Msft Virtual Disk', 'Operational Status': d.online ? 'Online' : 'Offline', 'Total Size': `${d.sizeGb} GB`, 'Partition Style': d.style, Free: `${d.sizeGb - used} GB` };
}

function sessionTarget(cx: Cx, name: string): Machine {
  const env = cx.env;
  const m = machineByName(env, name);
  if (!m) return cx.fail(`Connecting to remote server ${name} failed with the following error message : WinRM cannot process the request. The computer name could not be resolved.`);
  const winrm = m.firewall.rules.find((r) => r.name.startsWith('Windows Remote Management') && r.direction === 'Inbound');
  const fwOn = Object.values(m.firewall.enabled).some(Boolean);
  if (!m.remoting || m.services.WinRM?.status !== 'Running' || (fwOn && winrm && !winrm.enabled))
    cx.fail(`Connecting to remote server ${m.name} failed with the following error message : WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, and that a firewall exception for the WinRM service is enabled (Enable-PSRemoting on ${m.name}).`);
  return m;
}

register(
  {
    /* ------------------------------------------------------------ files */
    'get-location': (cx) => [{ __type: 'path', Path: toWin(cx.env.sys.cwd) }],
    'set-location': (cx) => {
      const target = toVfs(cx.env, path(cx, '~'));
      const l = lookup(cx.env.sys.fs, target, ROOT);
      if (!l || l.node.type !== 'dir') cx.fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      cx.env.sys.cwd = target;
      return [];
    },
    'get-childitem': (cx) => {
      const target = toVfs(cx.env, path(cx));
      const recurse = !!cx.P.recurse;
      const out: Obj[] = [];
      const walk = (p: string, prefix: string) => {
        let entries;
        try {
          entries = listDir(cx.env.sys.fs, p, ROOT);
        } catch {
          return cx.fail(`Cannot find path '${toWin(p)}' because it does not exist.`);
        }
        for (const { name, node } of entries) {
          out.push(fileItem(prefix + name, node.type === 'dir', node.type === 'file' ? node.content.length : ''));
          if (recurse && node.type === 'dir') walk(`${p}/${name}`, `${prefix}${name}\\`);
        }
      };
      walk(target, '');
      const filter = cx.P.filter !== undefined ? str(cx.P.filter) : cx.P.include !== undefined ? str(cx.P.include) : undefined;
      return filter ? out.filter((o) => new RegExp('^' + filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(o.Name).split('\\').pop()!)) : out;
    },
    'get-content': (cx) => {
      try {
        return readWinFile(cx, path(cx)).replace(/\n$/, '').split('\n');
      } catch (e) {
        if (e instanceof FsError) return cx.fail(`Cannot find path '${path(cx)}' because it does not exist.`);
        throw e;
      }
    },
    'set-content': (cx) => writeContent(cx, false),
    'add-content': (cx) => writeContent(cx, true),
    'out-file': (cx) => {
      const target = toVfs(cx.env, str(cx.P.filepath ?? cx.P.path ?? cx.pos[0]));
      const text = render(cx.input ?? []).replace(/^\n/, '');
      try {
        writeFile(cx.env.sys.fs, target, cx.P.append ? safeRead(cx, target) + text : text, ROOT, cx.env.sys.now);
      } catch {
        cx.fail(`Could not find a part of the path '${toWin(target)}'.`);
      }
      return [];
    },
    'new-item': (cx) => {
      const target = toVfs(cx.env, str(cx.P.path ?? cx.pos[0]) + (cx.P.name ? '\\' + str(cx.P.name) : ''));
      const kind = str(cx.P.itemtype ?? (['mkdir', 'md'].includes(cx.call.name.toLowerCase()) ? 'Directory' : 'File')).toLowerCase();
      if (lookup(cx.env.sys.fs, target, ROOT) && !cx.P.force) cx.fail(`An item with the specified name ${toWin(target)} already exists.`);
      if (!lookup(cx.env.sys.fs, target.replace(/^(\/m\/[^/]+)?\/([a-z]).*$/, '$1/$2'), ROOT) && !/^\/[a-z]$/.test(target)) {
        const drive = /^(\/m\/[^/]+)?\/([a-z])/.exec(target);
        const m = machine(cx.env);
        const letter = drive?.[2]?.toUpperCase();
        if (letter && letter !== 'C' && !m.disks.some((d) => d.partitions.some((p) => p.letter === letter && p.fs))) cx.fail(`Cannot find drive. A drive with the name '${letter}' does not exist.`);
      }
      if (kind === 'directory') mkdir(cx.env.sys.fs, target, ROOT, cx.env.sys.now, true);
      else {
        mkdir(cx.env.sys.fs, target.slice(0, target.lastIndexOf('/')) || '/', ROOT, cx.env.sys.now, true);
        writeFile(cx.env.sys.fs, target, cx.P.value !== undefined ? str(cx.P.value) + '\n' : '', ROOT, cx.env.sys.now);
      }
      return [fileItem(target.split('/').pop()!, kind === 'directory', '')];
    },
    'remove-item': (cx) => {
      const target = toVfs(cx.env, path(cx));
      try {
        remove(cx.env.sys.fs, target, ROOT, !!cx.P.recurse);
      } catch {
        cx.fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      }
      return [];
    },
    'test-path': (cx) => [!!lookup(cx.env.sys.fs, toVfs(cx.env, path(cx)), ROOT)],
    'import-csv': (cx) => {
      let text: string;
      try {
        text = readWinFile(cx, path(cx));
      } catch {
        return cx.fail(`Could not find file '${path(cx)}'.`);
      }
      const rows = text.split(/\r?\n/).filter((l) => l.trim());
      const split = (l: string) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const header = split(rows[0] ?? '');
      return rows.slice(1).map((r) => {
        const cells = split(r);
        return Object.fromEntries([['__type', 'csv'], ...header.map((h, i) => [h, cells[i] ?? ''])]);
      });
    },
    'export-csv': (cx) => {
      const target = toVfs(cx.env, path(cx));
      const objs = (cx.input ?? []).filter(isObj) as Obj[];
      const keys = objs.length ? Object.keys(objs[0]).filter((k) => k !== '__type') : [];
      writeFile(cx.env.sys.fs, target, [keys.map((k) => `"${k}"`).join(','), ...objs.map((o) => keys.map((k) => `"${show(o[k])}"`).join(','))].join('\n') + '\n', ROOT, cx.env.sys.now);
      return [];
    },
    'write-output': (cx) => (cx.pos.length > 1 ? [cx.pos.map(show).join(' ')] : cx.pos.length ? asList(cx.pos[0]) : asList(cx.P.inputobject)),
    'write-host': (cx) => {
      cx.print(cx.pos.map(show).join(' ') + '\n');
      return [];
    },
    'clear-host': (cx) => {
      cx.print('\u001bc');
      return [];
    },
    'out-null': () => [],

    /* ------------------------------------------------------------ pipeline */
    'foreach-object': (cx) => {
      const block = cx.call.block ?? (cx.P.process && isObj(cx.P.process) ? String((cx.P.process as Obj).src) : undefined);
      if (!block && cx.P.membername === undefined && cx.pos[0] === undefined) cx.fail('ForEach-Object needs a script block: ForEach-Object { ... }');
      const out: Value[] = [];
      for (const item of cx.input ?? []) {
        if (block) out.push(...cx.run(block, { _: item }));
        else out.push(prop(item, str(cx.P.membername ?? cx.pos[0])));
      }
      return out;
    },
    'where-object': (cx) => {
      if (cx.call.block) return (cx.input ?? []).filter((item) => condition(cx.env, cx.call.block!, item, false));
      // Where-Object Enabled -eq $false
      const p = str(cx.pos[0] ?? cx.P.property);
      const op = Object.keys(cx.P).find((k) => ['eq', 'ne', 'like', 'notlike', 'gt', 'lt', 'ge', 'le', 'match'].includes(k));
      if (!p || !op) cx.fail("Where-Object needs a script block: Where-Object { $_.Name -like 'A*' }");
      return (cx.input ?? []).filter((item) => condition(cx.env, `$_.${p} -${op} '${str(cx.P[op!])}'`, item, false));
    },
    'select-object': (cx) => {
      const first = cx.P.first !== undefined ? Number(str(cx.P.first)) : undefined;
      const last = cx.P.last !== undefined ? Number(str(cx.P.last)) : undefined;
      const props = asList(cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined)).map(str).filter(Boolean);
      let items = cx.input ?? [];
      if (cx.P.unique) items = items.filter((x, i) => items.findIndex((y) => show(y) === show(x)) === i);
      if (first !== undefined) items = items.slice(0, first);
      if (last !== undefined) items = items.slice(-last);
      if (cx.P.expandproperty) return items.flatMap((o) => asList(prop(o, str(cx.P.expandproperty))));
      if (!props.length || (props.length === 1 && props[0] === '*')) return items;
      return items.map((o) => Object.fromEntries([['__type', 'select'], ...props.map((p) => [isObj(o) ? Object.keys(o).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p : p, prop(o, p)])]));
    },
    'sort-object': (cx) => {
      const by = str(cx.P.property ?? cx.pos[0]);
      const items = [...(cx.input ?? [])];
      const key = (v: Value) => (by ? prop(v, by) : v);
      items.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return typeof x === 'number' && typeof y === 'number' ? x - y : show(x).localeCompare(show(y), undefined, { numeric: true });
      });
      if (cx.P.descending) items.reverse();
      return cx.P.unique ? items.filter((x, i) => items.findIndex((y) => show(key(y)) === show(key(x))) === i) : items;
    },
    'measure-object': (cx) => {
      const items = cx.input ?? [];
      const p = cx.P.property !== undefined ? str(cx.P.property) : undefined;
      const o: Obj = { __type: 'measure', Count: items.length };
      if (p && (cx.P.sum || cx.P.average || cx.P.maximum)) {
        const vals = items.map((i) => Number(prop(i, p)));
        if (cx.P.sum) o.Sum = vals.reduce((a, b) => a + b, 0);
        if (cx.P.average) o.Average = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        if (cx.P.maximum) o.Maximum = Math.max(...vals);
      }
      return [o];
    },
    'group-object': (cx) => {
      const by = str(cx.P.property ?? cx.pos[0]);
      const groups = new Map<string, Value[]>();
      for (const i of cx.input ?? []) {
        const k = show(prop(i, by));
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      return [...groups].map(([k, v]) => ({ __type: 'select', Count: v.length, Name: k }));
    },
    'format-table': (cx) => {
      const props = asList(cx.P.property ?? cx.pos[0]).map(str).filter(Boolean);
      const items = props.length ? (cx.input ?? []).map((o) => Object.fromEntries([['__type', 'select'], ...props.map((p) => [p, prop(o, p)])])) : cx.input ?? [];
      cx.print(render(items, true));
      return [];
    },
    'format-list': (cx) => {
      const props = asList(cx.P.property ?? cx.pos[0]).map(str).filter(Boolean);
      const items = props.length && props[0] !== '*' ? (cx.input ?? []).map((o) => Object.fromEntries([['__type', 'list'], ...props.map((p) => [p, prop(o, p)])])) : cx.input ?? [];
      cx.print(render(items, false, true));
      return [];
    },
    'select-string': (cx) => {
      const pattern = str(cx.P.pattern ?? cx.pos[0]);
      const re = cx.P.simplematch ? new RegExp(pattern.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'), 'i') : new RegExp(pattern, 'i');
      const lines = cx.input ?? (cx.P.path ? readWinFile(cx, str(cx.P.path)).split('\n') : []);
      return lines.map(show).flatMap((l) => l.split('\n')).filter((l) => re.test(l));
    },
    'convertto-securestring': (cx) => {
      if (!cx.P.asplaintext) cx.fail('Use -AsPlainText -Force to convert a typed password in this lab.');
      return [{ [SECURE]: true, plain: str(cx.pos[0] ?? cx.P.string) } as Secure];
    },
    'get-credential': (cx) => [{ __type: 'credential', UserName: str(cx.pos[0] ?? cx.P.credential ?? cx.P.username ?? `${cx.env.st.netbios}\\Administrator`), Password: { [SECURE]: true, plain: 'lab-session' } }],
    'get-date': () => ['Thursday, 22 October 2026 09:30:00'],
    'start-sleep': () => [],
    'get-help': (cx) => {
      const topic = str(cx.P.name ?? cx.pos[0]).toLowerCase();
      return [HELP_TEXT(topic)];
    },
    'get-command': (cx) => {
      const pat = cx.pos[0] ?? cx.P.name;
      const names = Object.keys(TABLE_NAMES()).sort();
      return names.filter((c) => !pat || new RegExp('^' + str(pat).replace(/\*/g, '.*') + '$', 'i').test(c)).map((c) => ({ __type: 'cmd', CommandType: 'Cmdlet', Name: TABLE_NAMES()[c] }));
    },

    /* ------------------------------------------------------------ sessions */
    'enter-pssession': (cx) => {
      const env = cx.env;
      const target = sessionTarget(cx, str(cx.P.computername ?? cx.pos[0]));
      if (target.name === machine(env).name) return [];
      env.vars.set('__localcwd', env.vars.get('__localcwd') ?? env.sys.cwd);
      env.est.current = target.name;
      env.dirtyEst = true;
      const home = driveRoot(env.est, target.name) + '/Users/Administrator/Documents';
      mkdir(env.sys.fs, home, ROOT, env.sys.now, true);
      env.sys.cwd = home;
      return [];
    },
    'exit-pssession': (cx) => {
      const env = cx.env;
      env.est.current = env.est.machines[0].name;
      env.dirtyEst = true;
      env.sys.cwd = str(env.vars.get('__localcwd') ?? '/c/Users/Administrator') || '/c/Users/Administrator';
      env.vars.delete('__localcwd');
      return [];
    },
    'invoke-command': (cx) => {
      const env = cx.env;
      const block = cx.call.block ?? (isObj(cx.P.scriptblock) ? String((cx.P.scriptblock as Obj).src) : undefined);
      if (!block) cx.fail('Invoke-Command needs -ScriptBlock { ... }.');
      const targets = asList(cx.P.computername ?? cx.pos[0] ?? machine(env).name).map(str);
      const out: Value[] = [];
      for (const t of targets) {
        const m = sessionTarget(cx, t);
        const savedCurrent = env.est.current;
        const savedCwd = env.sys.cwd;
        env.est.current = m.name;
        env.sys.cwd = driveRoot(env.est, m.name) + '/Users/Administrator/Documents';
        mkdir(env.sys.fs, env.sys.cwd, ROOT, env.sys.now, true);
        try {
          out.push(...cx.run(block!).map((v) => (isObj(v) ? { ...v, PSComputerName: m.name } : v)));
        } finally {
          env.est.current = savedCurrent;
          env.sys.cwd = savedCwd;
        }
      }
      return out;
    },
    'enable-psremoting': (cx) => {
      const m = machine(cx.env);
      m.remoting = true;
      m.services.WinRM = { status: 'Running', start: 'Automatic' };
      const rule = m.firewall.rules.find((r) => r.name.startsWith('Windows Remote Management'));
      if (rule) rule.enabled = true;
      cx.env.dirtyEst = true;
      return [];
    },
    'test-wsman': (cx) => {
      sessionTarget(cx, str(cx.P.computername ?? cx.pos[0] ?? machine(cx.env).name));
      return [{ __type: 'wsman', wsmid: 'http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd', ProtocolVersion: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd', ProductVendor: 'Microsoft Corporation', ProductVersion: 'OS: 0.0.0 SP: 0.0 Stack: 3.0' }];
    },

    /* ------------------------------------------------------------ the machine */
    'get-computerinfo': (cx) => {
      const m = machine(cx.env);
      return [{ __type: 'info', CsName: m.name, CsDomain: m.domain ?? 'WORKGROUP', WindowsProductName: m.os, WindowsInstallationType: m.installType === 'Server Core' ? 'Server Core' : m.installType === 'Client' ? 'Client' : 'Server', OsVersion: '10.0.20348', TimeZone: m.timeZone }];
    },
    'rename-computer': (cx) => {
      const env = cx.env;
      const m = machine(env);
      const newName = str(cx.P.newname ?? cx.pos[0]);
      if (!/^[A-Za-z0-9-]{1,15}$/.test(newName) || /^\d+$/.test(newName)) cx.fail(`Skip computer '${m.name}' with new name '${newName}' because the new name is not valid: up to 15 letters, digits and hyphens, not all digits.`);
      if (machineByName(env, newName)) cx.fail(`The new name ${newName} is already used by another computer.`);
      const old = m.name;
      const wasFirst = env.est.machines[0] === m;
      m.name = newName.toUpperCase();
      if (env.est.current.toLowerCase() === old.toLowerCase()) env.est.current = m.name;
      if (wasFirst) env.sys.hostname = m.name;
      const comp = env.st.computers.find((c) => c.name.toLowerCase() === old.toLowerCase());
      if (comp) {
        comp.name = m.name;
        comp.dn = comp.dn.replace(/^CN=[^,]+/, `CN=${m.name}`);
        env.dirtyAd = true;
      }
      env.dirtyEst = true;
      cx.print(`WARNING: The changes will take effect after you restart the computer ${old}.\n`);
      return [];
    },
    'restart-computer': (cx) => {
      const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) : machine(cx.env);
      if (!m) cx.fail(`Computer ${str(cx.P.computername)} was not found.`);
      m!.updatesPending = 0;
      for (const [svc, s] of Object.entries(m!.services)) if (s.start === 'Automatic') m!.services[svc] = { ...s, status: 'Running' };
      cx.env.dirtyEst = true;
      cx.print(`(${m!.name} restarted.)\n`);
      return [];
    },
    'set-timezone': (cx) => {
      const id = str(cx.P.id ?? cx.P.name ?? cx.pos[0]);
      if (!/^(Greenwich Standard Time|GMT Standard Time|UTC|W\. Central Africa Standard Time|E\. Africa Standard Time|South Africa Standard Time)$/i.test(id)) cx.fail(`The time zone ID '${id}' was not found on the local computer. Try 'Greenwich Standard Time' for Ghana.`);
      machine(cx.env).timeZone = id;
      cx.env.dirtyEst = true;
      return [];
    },
    'get-timezone': (cx) => [{ __type: 'tz', Id: machine(cx.env).timeZone, DisplayName: '(UTC+00:00) Monrovia, Reykjavik', BaseUtcOffset: '00:00:00' }],
    'get-windowsfeature': (cx) => {
      const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) : machine(cx.env);
      const want = cx.P.name ?? cx.pos[0];
      return features()
        .filter((f) => !want || asList(want).some((w) => new RegExp('^' + str(w).replace(/\*/g, '.*') + '$', 'i').test(f.name)))
        .map((f) => ({ __type: 'feature', 'Display Name': `[${hasFeature(m!, f.name) ? 'X' : ' '}] ${f.display}`, Name: f.name, 'Install State': hasFeature(m!, f.name) ? 'Installed' : 'Available' }));
    },
    'install-windowsfeature': (cx) => {
      const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername)) : machine(cx.env);
      if (!m) cx.fail(`The computer ${str(cx.P.computername)} was not found.`);
      const names = asList(cx.P.name ?? cx.pos[0]).map(str);
      const out: Obj[] = [];
      for (const n of names) {
        const f = features().find((x) => x.name.toLowerCase() === n.toLowerCase());
        if (!f) cx.fail(`ArgumentNotValid: The role, role service, or feature name is not valid: '${n}'. The name was not found. Use Get-WindowsFeature to list names.`);
        if (m!.installType === 'Server Core' && NEEDS_DESKTOP.has(f!.name)) cx.fail(`${f!.name} needs the Desktop Experience and cannot be installed on Server Core.`);
        for (const name of [f!.parent, f!.name].filter(Boolean) as string[]) if (!hasFeature(m!, name)) m!.features.push(name);
        if (cx.P.includemanagementtools && f!.name === 'AD-Domain-Services' && !hasFeature(m!, 'RSAT-AD-PowerShell')) m!.features.push('RSAT-AD-PowerShell', 'GPMC');
        const svc = SERVICE_OF[f!.name];
        if (svc) m!.services[svc] = { status: f!.name === 'AD-Domain-Services' ? 'Stopped' : 'Running', start: 'Automatic' };
        if (f!.name === 'DHCP' && !m!.dhcp) m!.dhcp = { authorized: false, scopes: [] };
        if (f!.name === 'DNS' && !m!.dns) m!.dns = { forwarders: [], rootHints: true };
        out.push({ __type: 'select', Success: true, 'Restart Needed': f!.name === 'Hyper-V' ? 'Yes' : 'No', 'Exit Code': 'Success', 'Feature Result': `{${f!.display}}` });
      }
      cx.env.dirtyEst = true;
      return out;
    },
    'uninstall-windowsfeature': (cx) => {
      const m = machine(cx.env);
      for (const n of asList(cx.P.name ?? cx.pos[0]).map(str)) m.features = m.features.filter((f) => f.toLowerCase() !== n.toLowerCase());
      cx.env.dirtyEst = true;
      return [];
    },
    'get-hotfix': (cx) => [{ __type: 'select', Source: machine(cx.env).name, Description: 'Security Update', HotFixID: 'KB5044281', InstalledOn: '10/8/2026' }],
    'get-service': (cx) => {
      const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername))! : machine(cx.env);
      const want = cx.P.name ?? cx.pos[0];
      return Object.entries(m.services)
        .filter(([n]) => !want || asList(want).some((w) => new RegExp('^' + str(w).replace(/\*/g, '.*') + '$', 'i').test(n)))
        .map(([n, s]) => ({ __type: 'service', Status: s.status, Name: n, StartType: s.start }));
    },
    'start-service': (cx) => serviceChange(cx, 'Running'),
    'stop-service': (cx) => serviceChange(cx, 'Stopped'),
    'restart-service': (cx) => serviceChange(cx, 'Running', true),
    'set-service': (cx) => {
      const m = machine(cx.env);
      const n = str(cx.P.name ?? cx.pos[0]);
      const key = Object.keys(m.services).find((k) => k.toLowerCase() === n.toLowerCase());
      if (!key) cx.fail(`Service '${n}' was not found on computer '${m.name}'.`);
      if (cx.P.startuptype) m.services[key!].start = str(cx.P.startuptype) as 'Automatic';
      if (cx.P.status) m.services[key!].status = str(cx.P.status) as 'Running';
      cx.env.dirtyEst = true;
      return [];
    },
    'get-process': (cx) => {
      const m = machine(cx.env);
      const procs = [
        { Name: 'System', CPU: 210.2, WS: 2 },
        { Name: 'lsass', CPU: 98.4, WS: 70 },
        { Name: 'svchost', CPU: 45.1, WS: 40 },
        ...Object.entries(m.services).filter(([, s]) => s.status === 'Running').map(([n], i) => ({ Name: n.toLowerCase(), CPU: 5 + i, WS: 20 + i })),
        ...((m as Machine & { hogs?: Array<{ Name: string; CPU: number; WS: number }> }).hogs ?? []),
      ];
      return procs.map((p, i) => ({ __type: 'process', Id: 400 + i * 4, ProcessName: p.Name, 'CPU(s)': p.CPU, 'WS(MB)': p.WS }));
    },
    'stop-process': (cx) => {
      const m = machine(cx.env) as Machine & { hogs?: Array<{ Name: string; CPU: number; WS: number }> };
      const n = str(cx.P.name ?? cx.pos[0]);
      if (!m.hogs?.some((h) => h.Name.toLowerCase() === n.toLowerCase())) cx.fail(`Cannot find a process with the name "${n}". (System processes cannot be stopped in this lab.)`);
      m.hogs = m.hogs!.filter((h) => h.Name.toLowerCase() !== n.toLowerCase());
      cx.env.dirtyEst = true;
      return [];
    },
    'get-winevent': (cx) => {
      const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername))! : machine(cx.env);
      const fh = isObj(cx.P.filterhashtable) ? (cx.P.filterhashtable as Obj) : undefined;
      const log = str(cx.P.logname ?? fh?.LogName ?? fh?.logname ?? cx.pos[0]);
      const ids = asList(fh?.Id ?? fh?.id ?? cx.P.id).map((x) => Number(str(x))).filter((x) => !Number.isNaN(x));
      const max = cx.P.maxevents !== undefined ? Number(str(cx.P.maxevents)) : undefined;
      let evs = m.events.filter((e) => !log || e.log.toLowerCase() === log.toLowerCase());
      if (ids.length) evs = evs.filter((e) => ids.includes(e.id));
      if (fh?.Level !== undefined) evs = evs.filter((e) => ({ 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information' } as Record<string, string>)[str(fh.Level)] === e.level);
      if (!evs.length) cx.fail('No events were found that match the specified selection criteria.');
      const list = [...evs].reverse();
      return (max ? list.slice(0, max) : list).map((e) => ({ __type: 'event', TimeCreated: e.time, Id: e.id, LevelDisplayName: e.level, Message: e.message, ...(e.data ?? {}) }));
    },
    'get-counter': (cx) => {
      const m = machine(cx.env) as Machine & { counters?: Record<string, number> };
      const c = m.counters ?? {};
      const want = asList(cx.P.counter ?? cx.pos[0]).map(str);
      const known: Record<string, number> = { '\\processor(_total)\\% processor time': c.cpu ?? 12, '\\memory\\available mbytes': c.mem ?? 2048, '\\logicaldisk(c:)\\% free space': c.disk ?? 48, '\\physicaldisk(_total)\\avg. disk queue length': c.queue ?? 0.3, '\\network interface(*)\\bytes total/sec': c.net ?? 12000 };
      return want.map((w) => {
        const v = known[w.toLowerCase()];
        if (v === undefined) cx.fail(`The specified counter path could not be interpreted: ${w}. Try \\Processor(_Total)\\% Processor Time.`);
        return { __type: 'counter', Path: `\\\\${m.name.toLowerCase()}${w.toLowerCase()}`, CookedValue: v };
      });
    },
    'new-scheduledtaskaction': (cx) => [{ __type: 'taskaction', Execute: str(cx.P.execute), Argument: str(cx.P.argument ?? '') }],
    'new-scheduledtasktrigger': (cx) => [{ __type: 'tasktrigger', Text: cx.P.daily ? `Daily at ${str(cx.P.at)}` : cx.P.weekly ? `Weekly on ${str(cx.P.daysofweek)} at ${str(cx.P.at)}` : cx.P.atstartup ? 'At startup' : cx.P.atlogon ? 'At log on' : `Once at ${str(cx.P.at)}` }],
    'register-scheduledtask': (cx) => {
      const m = machine(cx.env);
      const name = str(cx.P.taskname ?? cx.pos[0]);
      if (!name) cx.fail('Register-ScheduledTask needs -TaskName.');
      if (m.tasks.some((t) => t.name.toLowerCase() === name.toLowerCase()) && !cx.P.force) cx.fail(`Cannot create a file when that file already exists: task ${name}. Use -Force to replace it.`);
      const action = cx.P.action as Obj | undefined;
      const trigger = cx.P.trigger as Obj | undefined;
      if (!action || !trigger) cx.fail('Register-ScheduledTask needs -Action (New-ScheduledTaskAction) and -Trigger (New-ScheduledTaskTrigger).');
      m.tasks = m.tasks.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
      m.tasks.push({ name, action: `${str(action!.Execute)} ${str(action!.Argument)}`.trim(), trigger: str(trigger!.Text), user: str(cx.P.user ?? 'SYSTEM'), enabled: true });
      cx.env.dirtyEst = true;
      return [{ __type: 'task', TaskPath: '\\', TaskName: name, State: 'Ready' }];
    },
    'get-scheduledtask': (cx) => machine(cx.env).tasks.filter((t) => !(cx.P.taskname ?? cx.pos[0]) || t.name.toLowerCase() === str(cx.P.taskname ?? cx.pos[0]).toLowerCase()).map((t) => ({ __type: 'task', TaskPath: '\\', TaskName: t.name, State: t.enabled ? 'Ready' : 'Disabled', Trigger: t.trigger, Action: t.action, User: t.user })),
    'unregister-scheduledtask': (cx) => {
      const m = machine(cx.env);
      m.tasks = m.tasks.filter((t) => t.name.toLowerCase() !== str(cx.P.taskname ?? cx.pos[0]).toLowerCase());
      cx.env.dirtyEst = true;
      return [];
    },

    /* ------------------------------------------------------------ storage */
    'get-disk': (cx) => machine(cx.env).disks.filter((d) => cx.P.number === undefined || d.number === Number(str(cx.P.number))).map(diskView),
    'get-physicaldisk': (cx) => machine(cx.env).disks.map((d) => ({ __type: 'disk', DeviceId: d.number, FriendlyName: d.friendlyName ?? 'Msft Virtual Disk', CanPool: d.style === 'RAW' && !d.pooled && d.number !== 0, Size: `${d.sizeGb} GB` })),
    'set-disk': (cx) => {
      const d = diskOf(cx);
      if (cx.P.isoffline !== undefined) d.online = !bool(cx.P.isoffline);
      cx.env.dirtyEst = true;
      return [];
    },
    'initialize-disk': (cx) => {
      const d = diskOf(cx);
      if (!d.online) cx.fail(`Disk ${d.number} is offline. Bring it online first: Set-Disk -Number ${d.number} -IsOffline $false`);
      if (d.style !== 'RAW') cx.fail(`Disk ${d.number} has already been initialized.`);
      d.style = str(cx.P.partitionstyle ?? 'GPT').toUpperCase() === 'MBR' ? 'MBR' : 'GPT';
      if (d.style === 'MBR' && d.sizeGb > 2048) cx.fail('An MBR disk cannot use more than 2 TB. Use -PartitionStyle GPT.');
      cx.env.dirtyEst = true;
      return [];
    },
    'new-partition': (cx) => {
      const d = diskOf(cx);
      if (d.style === 'RAW') cx.fail(`Disk ${d.number} is not initialized. Use Initialize-Disk first.`);
      const used = d.partitions.reduce((a, p) => a + p.sizeGb, 0);
      const size = cx.P.usemaximumsize ? d.sizeGb - used : num(cx.P.size) / 1024;
      if (size <= 0 || used + size > d.sizeGb + 0.01) cx.fail(`Not enough available capacity on disk ${d.number}.`);
      const letter = cx.P.driveletter !== undefined ? str(cx.P.driveletter).toUpperCase().replace(':', '') : cx.P.assigndriveletter ? nextLetter(machine(cx.env)) : undefined;
      if (letter && machine(cx.env).disks.some((x) => x.partitions.some((p) => p.letter === letter))) cx.fail(`The drive letter ${letter} is already in use.`);
      d.partitions.push({ letter, sizeGb: Math.round(size * 100) / 100 });
      cx.env.dirtyEst = true;
      return [{ __type: 'volume', DiskNumber: d.number, DriveLetter: letter ?? '', Size: `${Math.round(size)} GB` }];
    },
    'format-volume': (cx) => {
      const m = machine(cx.env);
      const letter = str(cx.P.driveletter ?? cx.pos[0] ?? prop(cx.input?.[0], 'DriveLetter')).toUpperCase().replace(':', '');
      const part = m.disks.flatMap((d) => d.partitions).find((p) => p.letter === letter);
      if (!part) cx.fail(`No MSFT_Volume objects found with property 'DriveLetter' equal to '${letter}'.`);
      const fs = str(cx.P.filesystem ?? 'NTFS').toUpperCase();
      if (!['NTFS', 'REFS', 'FAT32'].includes(fs)) cx.fail(`Cannot validate argument on parameter 'FileSystem'. Use NTFS or ReFS.`);
      part!.fs = fs === 'REFS' ? 'ReFS' : (fs as 'NTFS');
      part!.label = str(cx.P.newfilesystemlabel ?? '');
      mkdir(cx.env.sys.fs, driveRoot(cx.env.est, m.name, letter), ROOT, cx.env.sys.now, true);
      cx.env.dirtyEst = true;
      return [{ __type: 'volume', DriveLetter: letter, FileSystemLabel: part!.label, FileSystem: part!.fs, Size: `${part!.sizeGb} GB` }];
    },
    'get-volume': (cx) => machine(cx.env).disks.flatMap((d) => d.partitions.filter((p) => p.letter).map((p) => ({ __type: 'volume', DriveLetter: p.letter, FileSystemLabel: p.label ?? '', FileSystem: p.fs ?? 'RAW', HealthStatus: 'Healthy', Size: `${p.sizeGb} GB` }))),
    'get-partition': (cx) => machine(cx.env).disks.flatMap((d) => d.partitions.map((p, i) => ({ __type: 'volume', DiskNumber: d.number, PartitionNumber: i + 1, DriveLetter: p.letter ?? '', Size: `${p.sizeGb} GB` }))),
    'new-storagepool': (cx) => {
      const m = machine(cx.env);
      const name = str(cx.P.friendlyname ?? cx.pos[0]);
      const disks = asList(cx.P.physicaldisks ?? cx.input).map((d) => Number(prop(d, 'DeviceId') ?? d));
      if (disks.length < 1) cx.fail('New-StoragePool needs -PhysicalDisks (Get-PhysicalDisk -CanPool $true).');
      for (const n of disks) {
        const d = m.disks.find((x) => x.number === n);
        if (!d || d.style !== 'RAW' || d.pooled || n === 0) cx.fail(`Physical disk ${n} cannot be pooled: it must be blank and not the system disk.`);
        d!.pooled = name;
      }
      m.pools.push({ name, disks, virtualDisks: [] });
      cx.env.dirtyEst = true;
      return [{ __type: 'select', FriendlyName: name, OperationalStatus: 'OK', HealthStatus: 'Healthy', Size: `${disks.reduce((a, n) => a + (m.disks.find((x) => x.number === n)?.sizeGb ?? 0), 0)} GB` }];
    },
    'get-storagepool': (cx) => machine(cx.env).pools.map((p) => ({ __type: 'select', FriendlyName: p.name, Disks: p.disks.length, VirtualDisks: p.virtualDisks.map((v) => v.name).join(', ') })),
    'new-virtualdisk': (cx) => {
      const m = machine(cx.env);
      const pool = m.pools.find((p) => p.name.toLowerCase() === str(cx.P.storagepoolfriendlyname ?? cx.pos[0]).toLowerCase());
      if (!pool) cx.fail(`No storage pool called ${str(cx.P.storagepoolfriendlyname)}.`);
      const res = str(cx.P.resiliencysettingname ?? 'Simple') as 'Simple' | 'Mirror' | 'Parity';
      const minDisks = res === 'Mirror' ? 2 : res === 'Parity' ? 3 : 1;
      if (pool!.disks.length < minDisks) cx.fail(`A ${res} virtual disk needs at least ${minDisks} physical disks in the pool; ${pool!.name} has ${pool!.disks.length}.`);
      const raw = pool!.disks.reduce((a, n) => a + (m.disks.find((x) => x.number === n)?.sizeGb ?? 0), 0);
      const usable = res === 'Mirror' ? raw / 2 : res === 'Parity' ? (raw * (pool!.disks.length - 1)) / pool!.disks.length : raw;
      const used = pool!.virtualDisks.reduce((a, v) => a + v.sizeGb * (v.resiliency === 'Mirror' ? 2 : v.resiliency === 'Parity' ? pool!.disks.length / (pool!.disks.length - 1) : 1), 0);
      const size = cx.P.usemaximumsize ? (raw - used) * (usable / raw) : num(cx.P.size) / 1024;
      if (size * (raw / usable) > raw - used + 0.01) cx.fail(`Not enough available capacity: a ${res} disk of ${size} GB needs ${Math.round(size * (raw / usable))} GB of pool space.`);
      const name = str(cx.P.friendlyname);
      pool!.virtualDisks.push({ name, resiliency: res, sizeGb: Math.round(size * 100) / 100 });
      m.disks.push({ number: Math.max(...m.disks.map((d) => d.number)) + 1, sizeGb: Math.round(size * 100) / 100, style: 'RAW', online: true, partitions: [], friendlyName: name });
      cx.env.dirtyEst = true;
      return [{ __type: 'select', FriendlyName: name, ResiliencySettingName: res, Size: `${Math.round(size * 100) / 100} GB` }];
    },

    /* ------------------------------------------------------------ Hyper-V */
    'new-vmswitch': (cx) => {
      const m = hyperv(cx);
      const name = str(cx.P.name ?? cx.pos[0]);
      const type = cx.P.netadaptername ? 'External' : (str(cx.P.switchtype ?? 'Private') as 'Internal' | 'Private');
      if (!['External', 'Internal', 'Private'].includes(type)) cx.fail('SwitchType must be Internal or Private (use -NetAdapterName for External).');
      m.hyperv!.switches.push({ name, type });
      cx.env.dirtyEst = true;
      return [{ __type: 'select', Name: name, SwitchType: type, NetAdapterInterfaceDescription: type === 'External' ? str(cx.P.netadaptername) : '' }];
    },
    'get-vmswitch': (cx) => hyperv(cx).hyperv!.switches.map((s) => ({ __type: 'select', Name: s.name, SwitchType: s.type })),
    'new-vm': (cx) => {
      const m = hyperv(cx);
      const name = str(cx.P.name ?? cx.pos[0]);
      if (m.hyperv!.vms.some((v) => v.name.toLowerCase() === name.toLowerCase())) cx.fail(`A virtual machine called ${name} already exists.`);
      const sw = cx.P.switchname !== undefined ? str(cx.P.switchname) : undefined;
      if (sw && !m.hyperv!.switches.some((s) => s.name.toLowerCase() === sw.toLowerCase())) cx.fail(`The virtual switch '${sw}' does not exist. Create it with New-VMSwitch.`);
      m.hyperv!.vms.push({ name, memoryMb: num(cx.P.memorystartupbytes ?? '2048MB'), generation: Number(str(cx.P.generation ?? 2)), cpus: 1, switch: sw, state: 'Off', checkpoints: [], vhd: cx.P.newvhdpath ? str(cx.P.newvhdpath) : undefined });
      cx.env.dirtyEst = true;
      return [{ __type: 'vm', Name: name, State: 'Off', 'CPUUsage(%)': 0, 'MemoryAssigned(M)': 0, Uptime: '00:00:00', Status: 'Operating normally' }];
    },
    'get-vm': (cx) => hyperv(cx).hyperv!.vms.filter((v) => !(cx.P.name ?? cx.pos[0]) || v.name.toLowerCase() === str(cx.P.name ?? cx.pos[0]).toLowerCase()).map((v) => ({ __type: 'vm', Name: v.name, State: v.state, Generation: v.generation, 'MemoryStartup(M)': v.memoryMb, ProcessorCount: v.cpus, Switch: v.switch ?? '' })),
    'start-vm': (cx) => vmState(cx, 'Running'),
    'stop-vm': (cx) => vmState(cx, 'Off'),
    'set-vmprocessor': (cx) => {
      const v = vmOf(cx);
      if (v.state === 'Running') cx.fail(`Cannot change the processor count of ${v.name} while it is running. Stop-VM first.`);
      v.cpus = Number(str(cx.P.count));
      cx.env.dirtyEst = true;
      return [];
    },
    'set-vmmemory': (cx) => {
      const v = vmOf(cx);
      v.memoryMb = num(cx.P.startupbytes ?? cx.P.startup);
      cx.env.dirtyEst = true;
      return [];
    },
    'connect-vmnetworkadapter': (cx) => {
      const v = vmOf(cx, str(cx.P.vmname ?? cx.pos[0]));
      const sw = str(cx.P.switchname);
      if (!hyperv(cx).hyperv!.switches.some((s) => s.name.toLowerCase() === sw.toLowerCase())) cx.fail(`The virtual switch '${sw}' does not exist.`);
      v.switch = sw;
      cx.env.dirtyEst = true;
      return [];
    },
    'checkpoint-vm': (cx) => {
      const v = vmOf(cx);
      v.checkpoints.push(str(cx.P.snapshotname ?? `${v.name} - (10/22/2026 - 9:30:00 AM)`));
      cx.env.dirtyEst = true;
      return [];
    },
    'get-vmsnapshot': (cx) => vmOf(cx, str(cx.P.vmname ?? cx.pos[0])).checkpoints.map((c) => ({ __type: 'select', VMName: vmOf(cx, str(cx.P.vmname ?? cx.pos[0])).name, Name: c, SnapshotType: 'Standard' })),
    'restore-vmsnapshot': (cx) => {
      const v = vmOf(cx, str(cx.P.vmname));
      if (!v.checkpoints.includes(str(cx.P.name))) cx.fail(`No checkpoint called ${str(cx.P.name)} on ${v.name}.`);
      v.state = 'Off';
      cx.env.dirtyEst = true;
      return [];
    },
  },
  {
    'get-childitem': 'Get-ChildItem [-Path] <folder> [-Recurse] [-Filter *.txt]',
    'install-windowsfeature': 'Install-WindowsFeature -Name <feature>[,<feature>] [-IncludeManagementTools] [-ComputerName <server>]',
    'get-windowsfeature': 'Get-WindowsFeature [-Name <pattern>]   (X marks installed features)',
    'invoke-command': 'Invoke-Command -ComputerName <server>[,<server>] -ScriptBlock { <commands> }',
    'enter-pssession': 'Enter-PSSession -ComputerName <server>   (Exit-PSSession to come back)',
    'new-partition': 'New-Partition -DiskNumber <n> (-UseMaximumSize | -Size 20GB) [-DriveLetter E | -AssignDriveLetter]',
    'format-volume': 'Format-Volume -DriveLetter E -FileSystem NTFS|ReFS [-NewFileSystemLabel Data]',
    'new-virtualdisk': 'New-VirtualDisk -StoragePoolFriendlyName <pool> -FriendlyName <name> -ResiliencySettingName Simple|Mirror|Parity (-Size 100GB | -UseMaximumSize)',
    'register-scheduledtask': 'Register-ScheduledTask -TaskName <name> -Action (New-ScheduledTaskAction -Execute ...) -Trigger (New-ScheduledTaskTrigger -Daily -At 2am) [-User SYSTEM]',
    'get-winevent': "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } [-MaxEvents 10]",
    'new-vm': 'New-VM -Name <name> -MemoryStartupBytes 4GB -Generation 2 [-SwitchName <switch>] [-NewVHDPath <file> -NewVHDSizeBytes 60GB]',
  },
  { dir: 'get-childitem', ls: 'get-childitem', gci: 'get-childitem', cd: 'set-location', sl: 'set-location', pwd: 'get-location', gl: 'get-location', cat: 'get-content', type: 'get-content', gc: 'get-content', echo: 'write-output', write: 'write-output', cls: 'clear-host', clear: 'clear-host', mkdir: 'new-item', md: 'new-item', del: 'remove-item', rm: 'remove-item', erase: 'remove-item', '%': 'foreach-object', foreach: 'foreach-object', '?': 'where-object', where: 'where-object', select: 'select-object', sort: 'sort-object', measure: 'measure-object', ft: 'format-table', fl: 'format-list', man: 'get-help', help: 'get-help', 'add-windowsfeature': 'install-windowsfeature', 'remove-windowsfeature': 'uninstall-windowsfeature', etsn: 'enter-pssession', exsn: 'exit-pssession', icm: 'invoke-command', gsv: 'get-service', ps: 'get-process', sls: 'select-string', findstr: 'select-string', group: 'group-object' },
);

function writeContent(cx: Cx, append: boolean): Value[] {
  const target = toVfs(cx.env, path(cx));
  const text = asList(cx.P.value ?? cx.pos[1] ?? cx.input).map(show).join('\n') + '\n';
  const prev = append ? safeRead(cx, target) : '';
  try {
    writeFile(cx.env.sys.fs, target, prev + text, ROOT, cx.env.sys.now);
  } catch (e) {
    cx.fail(e instanceof FsError ? `Could not find a part of the path '${toWin(target)}'.` : String(e));
  }
  return [];
}

function safeRead(cx: Cx, vfs: string): string {
  try {
    return readFile(cx.env.sys.fs, vfs, ROOT);
  } catch {
    return '';
  }
}

function serviceChange(cx: Cx, status: 'Running' | 'Stopped', restart = false): Value[] {
  const m = cx.P.computername ? machineByName(cx.env, str(cx.P.computername))! : machine(cx.env);
  const n = str(cx.P.name ?? cx.pos[0] ?? prop(cx.input?.[0], 'Name'));
  const key = Object.keys(m.services).find((k) => k.toLowerCase() === n.toLowerCase());
  if (!key) cx.fail(`Cannot find any service with service name '${n}'.`);
  if (m.services[key!].start === 'Disabled' && status === 'Running') cx.fail(`Service '${key}' cannot be started because it is disabled. Set-Service ${key} -StartupType Automatic first.`);
  m.services[key!].status = status;
  if (key === 'Spooler' && (restart || status === 'Stopped')) for (const p of m.printers) p.jobs = p.jobs.filter((j) => j.status !== 'Error' || !restart || !(m as Machine & { spoolCleared?: boolean }).spoolCleared);
  if (key === 'Netlogon' && restart) registerDcRecords(cx);
  cx.env.dirtyEst = true;
  return [];
}

/** Netlogon registers the DC's SRV records again when it restarts. */
function registerDcRecords(cx: Cx): void {
  const m = machine(cx.env);
  if (!m.dc) return;
  const zone = cx.env.st.zones.find((z) => z.name.toLowerCase() === cx.env.st.domain.toLowerCase());
  if (!zone) return;
  const fqdn = `${m.name.toLowerCase()}.${cx.env.st.domain}`;
  for (const [name, port] of [['_ldap._tcp.dc._msdcs', 389], ['_kerberos._tcp.dc._msdcs', 88], ['_ldap._tcp', 389], ['_gc._tcp', 3268]] as const) {
    if (!zone.records.some((r) => r.type === 'SRV' && r.name === name && r.data.endsWith(fqdn))) zone.records.push({ name, type: 'SRV', data: `0 100 ${port} ${fqdn}` });
  }
  cx.env.dirtyAd = true;
}

function diskOf(cx: Cx): Disk {
  const n = Number(str(cx.P.number ?? cx.P.disknumber ?? cx.pos[0] ?? prop(cx.input?.[0], 'Number')));
  const d = machine(cx.env).disks.find((x) => x.number === n);
  if (!d) return cx.fail(`No MSFT_Disk objects found with property 'Number' equal to '${n}'.`);
  return d;
}

function nextLetter(m: Machine): string {
  const used = new Set(m.disks.flatMap((d) => d.partitions.map((p) => p.letter)));
  for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(l)) return l;
  return 'Z';
}

function hyperv(cx: Cx): Machine {
  const m = machine(cx.env);
  if (!hasFeature(m, 'Hyper-V')) cx.fail(`The term is not recognized: the Hyper-V role is not installed on ${m.name}. Install-WindowsFeature Hyper-V -IncludeManagementTools -Restart`);
  if (!m.hyperv) m.hyperv = { switches: [], vms: [] };
  return m;
}

function vmOf(cx: Cx, name = str(cx.P.vmname ?? cx.P.name ?? cx.pos[0])) {
  const v = hyperv(cx).hyperv!.vms.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!v) return cx.fail(`Hyper-V was unable to find a virtual machine with name "${name}".`);
  return v;
}

function vmState(cx: Cx, state: 'Running' | 'Off'): Value[] {
  const v = vmOf(cx);
  if (state === 'Running' && hyperv(cx).hyperv!.vms.filter((x) => x.state === 'Running').reduce((a, x) => a + x.memoryMb, 0) + v.memoryMb > 16384) cx.fail(`'${v.name}' could not start: not enough memory on the host. Stop another VM or lower its startup memory.`);
  v.state = state;
  cx.env.dirtyEst = true;
  return [];
}

/* ----------------------------------------------------------------------------- natives */

registerNative({
  hostname: (_a, cx) => [machine(cx.env).name],
  whoami: (args, cx) => {
    const user = cx.env.st.users.find((u) => u.sam.toLowerCase() === cx.env.sys.user.toLowerCase());
    const who = `${cx.env.st.netbios.toLowerCase()}\\${cx.env.sys.user.toLowerCase()}`;
    if (args.some((a) => /^\/(groups|all)$/i.test(a))) {
      const groups = cx.env.st.groups.filter((g) => user && g.members.includes(user.dn));
      const lines = ['', 'GROUP INFORMATION', '-----------------', '', 'Group Name                                 Type             SID', ...groups.map((g) => `${(cx.env.st.netbios + '\\' + g.name).padEnd(42)} Group            ${g.sid ?? ''}`)];
      if (args.some((a) => /^\/all$/i.test(a))) lines.unshift('', 'USER INFORMATION', '----------------', '', `User Name             SID`, `${who.padEnd(21)} ${user?.sid ?? ''}`);
      return [lines.join('\n')];
    }
    if (args.some((a) => /^\/user$/i.test(a))) return [`${who} ${user?.sid ?? ''}`];
    return [who];
  },
  slmgr: (args, cx) => {
    const m = machine(cx.env);
    const a = (args[0] ?? '').toLowerCase();
    if (a === '/ato') {
      m.activated = true;
      cx.env.dirtyEst = true;
      return ['Activating Windows(R), ServerDatacenter edition ...', 'Product activated successfully.'];
    }
    if (a === '/dli' || a === '/xpr') return [`Name: ${m.os}`, `License Status: ${m.activated ? 'Licensed' : 'Notification (activation needed)'}`];
    return ['Usage: slmgr /ato | /dli | /xpr'];
  },
  w32tm: (args, cx) => {
    const m = machine(cx.env);
    const a = args.join(' ').toLowerCase();
    if (a.includes('/resync')) {
      if (m.services.W32Time?.status !== 'Running') return ['The following error occurred: The service has not been started. (0x80070426)'];
      m.timeOffsetMin = 0;
      cx.env.dirtyEst = true;
      return ['Sending resync command to local computer', 'The command completed successfully.'];
    }
    if (a.includes('/query') && a.includes('/status')) return [`Leap Indicator: 0(no warning)`, `Stratum: 3`, `Source: ${m.dc ? 'Local CMOS Clock' : `${cx.env.est.machines[0].name.toLowerCase()}.${cx.env.st.domain}`}`, `Phase Offset: ${(m.timeOffsetMin * 60).toFixed(7)}s`];
    if (a.includes('/stripchart')) return [`Tracking ${args.find((x) => /^\/computer:/i.test(x))?.slice(10) ?? 'dc'}.`, `09:30:00, ${m.timeOffsetMin >= 0 ? '+' : ''}${(m.timeOffsetMin * 60).toFixed(7)}s`];
    return ['Usage: w32tm /query /status | /resync | /stripchart /computer:<dc> /samples:1'];
  },
  shutdown: (_a, cx) => {
    machine(cx.env).updatesPending = 0;
    cx.env.dirtyEst = true;
    return ['(The computer restarted.)'];
  },
});

function TABLE_NAMES(): Record<string, string> {
  return NAME_CACHE;
}
const NAME_CACHE: Record<string, string> = {};
export function rememberName(display: string): void {
  NAME_CACHE[display.toLowerCase()] = display;
}

function HELP_TEXT(topic: string): string {
  // Filled in by index.ts with every module's help text.
  return HELP_LOOKUP(topic);
}
let HELP_LOOKUP: (topic: string) => string = () => 'Get-Help <cmdlet>. Try Get-Command to list the cmdlets this server knows.';
export function setHelpLookup(fn: (topic: string) => string): void {
  HELP_LOOKUP = fn;
}

export { isSecure };
