/**
 * Additional server roles: Certificate Services, WSUS, WDS, Remote Desktop Services and Windows
 * Server Backup.
 */

import { lookup } from '../fs.js';
import { asList, machine, machineByName, register, registerNative, str, toVfs, type Cx, type Value } from './core.js';
import { findGroup } from './cmd-ad.js';
import { requireFeature } from './cmd-basic.js';
import type { Machine } from './model.js';

const ROOT = { user: 'root', groups: ['root'] };

const TEMPLATES = ['User', 'Computer', 'WebServer', 'DomainController', 'SubCA', 'Administrator', 'Workstation', 'KerberosAuthentication', 'DirectoryEmailReplication'];
const certs = (m: Machine) => ((m as Machine & { certs?: Array<{ subject: string; template: string; thumb: string }> }).certs ??= []);

function caMachine(cx: Cx): Machine {
  const m = cx.env.est.machines.find((x) => x.ca);
  if (!m) return cx.fail('No enterprise certification authority is installed in this domain. Install-AdcsCertificationAuthority first.');
  return m;
}

function wsus(cx: Cx): Machine {
  const m = machine(cx.env);
  requireFeature(cx, m, 'UpdateServices', 'WSUS');
  if (!m.wsus?.contentDir) cx.fail('WSUS is installed but not configured. Run wsusutil postinstall CONTENT_DIR=D:\\WSUS first.');
  return m;
}

register({
  /* ------------------------------------------------------------ AD CS */
  'install-adcscertificationauthority': (cx) => {
    const m = machine(cx.env);
    requireFeature(cx, m, 'ADCS-Cert-Authority', 'Certificate Services');
    if (m.ca) cx.fail(`A certification authority is already installed on ${m.name}.`);
    const type = str(cx.P.catype ?? 'EnterpriseRootCA');
    if (!/^(EnterpriseRootCA|EnterpriseSubordinateCA|StandaloneRootCA|StandaloneSubordinateCA)$/i.test(type)) cx.fail('Use -CAType EnterpriseRootCA, EnterpriseSubordinateCA, StandaloneRootCA or StandaloneSubordinateCA.');
    if (/^enterprise/i.test(type) && !m.domain) cx.fail('An enterprise CA must be a domain member.');
    const keyLength = Number(str(cx.P.keylength ?? 2048));
    if (keyLength < 2048) cx.fail(`A ${keyLength}-bit key is too weak for a new CA: use at least 2048, and 4096 for a root CA.`);
    const hash = str(cx.P.hashalgorithmname ?? 'SHA256').toUpperCase();
    if (/^(MD5|SHA1)$/.test(hash)) cx.fail(`${hash} is deprecated for certificate signing. Use SHA256 or stronger.`);
    m.ca = { name: str(cx.P.cacommonname ?? `${cx.env.st.netbios}-${m.name}-CA`), type, keyLength, hash, years: Number(str(cx.P.validityperiodunits ?? 5)) };
    m.services.CertSvc = { status: 'Running', start: 'Automatic' };
    if (!cx.env.st.caTemplates.length) cx.env.st.caTemplates.push('User', 'Computer', 'DomainController', 'WebServer', 'SubCA', 'Administrator');
    cx.env.dirtyEst = true;
    cx.env.dirtyAd = true;
    return [{ __type: 'select', ErrorId: 0, ErrorString: '' }];
  },
  'get-catemplate': (cx) => {
    caMachine(cx);
    return cx.env.st.caTemplates.map((t) => ({ __type: 'select', Name: t, Oid: `1.3.6.1.4.1.311.21.8.${TEMPLATES.indexOf(t) + 100}` }));
  },
  'add-catemplate': (cx) => {
    caMachine(cx);
    const n = str(cx.P.name ?? cx.pos[0]);
    const known = [...TEMPLATES, ...((cx.env.st as typeof cx.env.st & { customTemplates?: string[] }).customTemplates ?? [])];
    if (!known.some((t) => t.toLowerCase() === n.toLowerCase())) cx.fail(`The template ${n} does not exist in Active Directory. Duplicate an existing template first (New-CATemplateDuplicate in this lab).`);
    if (!cx.env.st.caTemplates.some((t) => t.toLowerCase() === n.toLowerCase())) cx.env.st.caTemplates.push(known.find((t) => t.toLowerCase() === n.toLowerCase())!);
    cx.env.dirtyAd = true;
    return [];
  },
  // Not a Microsoft cmdlet: stands in for duplicating a template in the Certificate Templates console.
  'new-catemplateduplicate': (cx) => {
    const st = cx.env.st as typeof cx.env.st & { customTemplates?: string[]; templateRights?: Record<string, string[]> };
    const from = str(cx.P.source);
    if (!TEMPLATES.some((t) => t.toLowerCase() === from.toLowerCase())) cx.fail(`There is no template called ${from} to duplicate.`);
    const n = str(cx.P.name);
    st.customTemplates = [...(st.customTemplates ?? []), n];
    const enroll = asList(cx.P.autoenroll ?? cx.P.enroll).map(str);
    for (const g of enroll) if (!findGroup(st, g)) cx.fail(`Cannot find the group ${g}.`);
    st.templateRights = { ...(st.templateRights ?? {}), [n]: enroll };
    cx.env.dirtyAd = true;
    return [];
  },
  'get-certificate': (cx) => {
    const ca = caMachine(cx);
    const m = machine(cx.env);
    const t = str(cx.P.template);
    if (!cx.env.st.caTemplates.some((x) => x.toLowerCase() === t.toLowerCase())) cx.fail(`CertEnroll::CX509Enrollment::Enroll: The requested certificate template is not supported by this CA (${ca.ca!.name}). Publish it with Add-CATemplate.`);
    const dns = asList(cx.P.dnsname).map(str);
    const thumb = (Math.abs([...m.name + t + dns.join()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) >>> 0).toString(16).toUpperCase().padStart(8, '0').repeat(5);
    certs(m).push({ subject: dns[0] ? `CN=${dns[0]}` : `CN=${m.name}`, template: t, thumb });
    cx.env.dirtyEst = true;
    return [{ __type: 'select', Status: 'Issued', Certificate: `[Subject] CN=${dns[0] ?? m.name} [Issuer] CN=${ca.ca!.name} [Thumbprint] ${thumb}` }];
  },
  'get-childitem-cert': (cx) => certs(machine(cx.env)).map((c) => ({ __type: 'select', Thumbprint: c.thumb, Subject: c.subject, Template: c.template })),

  /* ------------------------------------------------------------ WSUS */
  'get-wsusserver': (cx) => {
    const m = wsus(cx);
    return [{ __type: 'select', Name: m.name, PortNumber: 8530, ContentDirectory: m.wsus!.contentDir, ComputerTargetGroups: ['All Computers', 'Unassigned Computers', ...m.wsus!.groups].join(', ') }];
  },
  'get-wsusupdate': (cx) => {
    const m = wsus(cx);
    const cls = cx.P.classification !== undefined ? str(cx.P.classification).toLowerCase() : undefined;
    const approval = cx.P.approval !== undefined ? str(cx.P.approval).toLowerCase() : undefined;
    return m.wsus!.updates
      .filter((u) => !cls || cls === 'all' || u.classification.toLowerCase().startsWith(cls.replace(/s$/, '')))
      .filter((u) => !approval || approval === 'anyexceptdeclined' || (approval === 'unapproved' ? !m.wsus!.approved.some((a) => a.kb === u.kb) : m.wsus!.approved.some((a) => a.kb === u.kb)))
      .map((u) => ({ __type: 'select', KB: u.kb, Title: u.title, Classification: u.classification, Approved: m.wsus!.approved.filter((a) => a.kb === u.kb).map((a) => a.group).join(', ') }));
  },
  'approve-wsusupdate': (cx) => {
    const m = wsus(cx);
    const group = str(cx.P.targetgroupname);
    if (!['All Computers', ...m.wsus!.groups].some((g) => g.toLowerCase() === group.toLowerCase())) cx.fail(`The computer group ${group} does not exist on this WSUS server.`);
    if (!/^install$/i.test(str(cx.P.action ?? 'Install'))) cx.fail('Use -Action Install.');
    for (const u of cx.input ?? []) {
      const kb = str((u as Record<string, unknown>).KB ?? u);
      if (!m.wsus!.approved.some((a) => a.kb === kb && a.group.toLowerCase() === group.toLowerCase())) m.wsus!.approved.push({ kb, group });
    }
    cx.env.dirtyEst = true;
    return [];
  },

  /* ------------------------------------------------------------ WDS */
  'import-wdsbootimage': (cx) => wdsImport(cx, 'bootImages'),
  'import-wdsinstallimage': (cx) => wdsImport(cx, 'installImages'),
  'get-wdsbootimage': (cx) => (machine(cx.env).wds?.bootImages ?? []).map((n) => ({ __type: 'select', ImageName: n, Architecture: 'X64', Enabled: true })),
  'get-wdsinstallimage': (cx) => (machine(cx.env).wds?.installImages ?? []).map((n) => ({ __type: 'select', ImageName: n, ImageGroup: 'Windows 11', Architecture: 'X64' })),

  /* ------------------------------------------------------------ RDS */
  'new-rdsessiondeployment': (cx) => {
    const env = cx.env;
    for (const role of ['connectionbroker', 'sessionhost', 'webaccessserver']) {
      for (const host of asList(cx.P[role]).map(str)) {
        const m = machineByName(env, host) ?? cx.fail(`The server ${host} cannot be contacted.`);
        if (!m.domain) cx.fail(`${m.name} must be a domain member to join a Remote Desktop deployment.`);
        const f = role === 'connectionbroker' ? 'RDS-Connection-Broker' : role === 'sessionhost' ? 'RDS-RD-Server' : 'RDS-Web-Access';
        if (!m.features.includes(f)) m.features.push(f);
        m.rds = m.rds ?? { collections: [] };
      }
    }
    env.dirtyEst = true;
    return [];
  },
  'new-rdsessioncollection': (cx) => {
    const env = cx.env;
    const host = machineByName(env, str(asList(cx.P.sessionhost)[0])) ?? cx.fail(`The session host ${str(cx.P.sessionhost)} cannot be contacted.`);
    if (!host.features.includes('RDS-RD-Server')) cx.fail(`${host.name} is not a session host in a deployment. New-RDSessionDeployment first.`);
    host.rds = host.rds ?? { collections: [] };
    host.rds.collections.push({ name: str(cx.P.collectionname), users: ['Domain Users'] });
    env.dirtyEst = true;
    return [];
  },
  'set-rdsessioncollectionconfiguration': (cx) => {
    const env = cx.env;
    const name = str(cx.P.collectionname);
    const c = env.est.machines.flatMap((m) => m.rds?.collections ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? cx.fail(`The collection ${name} does not exist.`);
    if (cx.P.usergroup !== undefined) {
      const groups = asList(cx.P.usergroup).map(str);
      for (const g of groups) if (!findGroup(env.st, g)) cx.fail(`Cannot find the group ${g}.`);
      c.users = groups.map((g) => g.replace(/^[^\\]+\\/, ''));
    }
    env.dirtyEst = true;
    return [];
  },
  'get-rdsessioncollection': (cx) => cx.env.est.machines.flatMap((m) => (m.rds?.collections ?? []).map((c) => ({ __type: 'select', CollectionName: c.name, SessionHost: m.name, UserGroup: c.users.join(', ') }))),
});

function wdsImport(cx: Cx, kind: 'bootImages' | 'installImages'): Value[] {
  const m = machine(cx.env);
  requireFeature(cx, m, 'WDS', 'WDS');
  if (!m.wds?.remInst) cx.fail('WDS is not initialised. Run wdsutil /initialize-server /reminst:D:\\RemoteInstall first.');
  const p = str(cx.P.path);
  if (!lookup(cx.env.sys.fs, toVfs(cx.env, p), ROOT)) cx.fail(`The image file ${p} was not found.`);
  const name = str(cx.P.imagename ?? p.split('\\').pop());
  m.wds![kind].push(name);
  cx.env.dirtyEst = true;
  return [];
}

registerNative({
  wsusutil: (args, cx) => {
    const m = machine(cx.env);
    requireFeature(cx, m, 'UpdateServices', 'WSUS');
    if ((args[0] ?? '').toLowerCase() !== 'postinstall') return ['Usage: wsusutil postinstall CONTENT_DIR=D:\\WSUS'];
    const dir = args.find((a) => /^content_dir=/i.test(a))?.slice(12);
    if (!dir) cx.fail('wsusutil postinstall needs CONTENT_DIR=<folder on a data drive>.');
    if (/^c:/i.test(dir!)) cx.print('WARNING: Keeping WSUS content on the system drive fills it quickly; a data drive is better.\n');
    m.wsus = { contentDir: dir, groups: m.wsus?.groups ?? ['Pilot', 'Servers', 'Workstations'], approved: m.wsus?.approved ?? [], updates: m.wsus?.updates?.length ? m.wsus.updates : [
      { kb: 'KB5044281', title: '2026-10 Cumulative Update for Windows Server 2022', classification: 'Security Updates' },
      { kb: 'KB5044098', title: '2026-10 Cumulative Update for Windows 11', classification: 'Security Updates' },
      { kb: 'KB5043936', title: 'Microsoft Defender Antivirus platform update', classification: 'Definition Updates' },
      { kb: 'KB5041773', title: 'Servicing Stack Update for Windows Server 2022', classification: 'Critical Updates' },
      { kb: 'KB5040437', title: 'Feature update to Windows 11, version 24H2', classification: 'Upgrades' },
    ] };
    cx.env.dirtyEst = true;
    return ['Log file is located at C:\\Program Files\\Update Services\\Log Files\\WsusUtil.log', 'Post install has successfully completed'];
  },
  wdsutil: (args, cx) => {
    const m = machine(cx.env);
    requireFeature(cx, m, 'WDS', 'WDS');
    const a = args.map((x) => x.toLowerCase());
    if (a.some((x) => x.startsWith('/initialize-server'))) {
      const rem = args.find((x) => /^\/reminst:/i.test(x))?.slice(9);
      if (!rem) cx.fail('wdsutil /initialize-server /reminst:D:\\RemoteInstall');
      if (/^c:/i.test(rem!)) cx.fail('The RemoteInstall folder must be on an NTFS volume other than the system volume.');
      m.wds = { remInst: rem, bootImages: [], installImages: [] };
      cx.env.dirtyEst = true;
      return ['Windows Deployment Services Management Utility [Version 10.0.20348.1]', 'The command completed successfully.'];
    }
    return ['Usage: wdsutil /initialize-server /reminst:D:\\RemoteInstall'];
  },
  certutil: (args, cx) => {
    const a = (args[0] ?? '').toLowerCase();
    const ca = cx.env.est.machines.find((x) => x.ca);
    if (a === '-ping') return ca ? [`Connecting to ${ca.name}\\${ca.ca!.name} ...`, `Server "${ca.ca!.name}" ICertRequest2 interface is alive`, 'CertUtil: -ping command completed successfully.'] : ['CertUtil: -ping command FAILED: 0x800706ba (WIN32: 1722 RPC_S_SERVER_UNAVAILABLE)', '(No certification authority is installed.)'];
    if (a === '-catemplates') return ca ? [...cx.env.st.caTemplates.map((t) => `${t}: ${t} -- Auto-Enroll: Access is denied.`), 'CertUtil: -CATemplates command completed successfully.'] : ['CertUtil: No CA found.'];
    if (a === '-pulse') return ['CertUtil: -pulse command completed successfully.'];
    if (a === '-cainfo') return ca ? [`CA name: ${ca.ca!.name}`, `CA type: ${ca.ca!.type}`, `Key length: ${ca.ca!.keyLength}`, `Hash algorithm: ${ca.ca!.hash}`, `Validity: ${ca.ca!.years} years`, `CA server: ${ca.name}`, 'CertUtil: -CAInfo command completed successfully.'] : ['CertUtil: No CA found.'];
    return ['Usage: certutil -ping | -CAInfo | -CATemplates | -pulse'];
  },
  wbadmin: (args, cx) => {
    const env = cx.env;
    const m = machine(env);
    requireFeature(cx, m, 'Windows-Server-Backup', 'wbadmin');
    const verb = args.slice(0, 2).join(' ').toLowerCase();
    const target = args.find((a) => /^-backuptarget:/i.test(a))?.slice(14);
    if (verb === 'start backup' || verb === 'start systemstatebackup') {
      if (!target) cx.fail('wbadmin needs -backupTarget:<volume>, for example -backupTarget:E:');
      const vol = target!.toUpperCase().replace(/\\$/, '');
      if (!m.disks.some((d) => d.partitions.some((p) => `${p.letter}:` === vol && p.fs))) cx.fail(`The backup target ${vol} is not a formatted volume on ${m.name}.`);
      const include = args.find((a) => /^-include:/i.test(a))?.slice(9) ?? '';
      if (verb === 'start backup' && include.toUpperCase().split(',').includes(vol)) cx.fail(`The backup target ${vol} cannot also be one of the volumes being backed up.`);
      const ss = verb === 'start systemstatebackup' || args.some((a) => /^-allcritical$/i.test(a));
      m.backups.push({ target: vol, items: verb === 'start systemstatebackup' ? 'System State' : include || 'Critical volumes', time: '10/22/2026 09:30', systemState: ss });
      env.dirtyEst = true;
      return ['wbadmin 1.0 - Backup command-line tool', `Starting ${ss ? 'a backup with system state' : 'a backup'} to ${vol}...`, 'The backup operation successfully completed.'];
    }
    if (verb === 'get versions') return m.backups.length ? m.backups.map((b, i) => `Backup time: ${b.time}\nBackup target: Fixed Disk labeled ${b.target}\nVersion identifier: 10/22/2026-09:${String(30 + i).padStart(2, '0')}\nCan recover: Volume(s), File(s), Application(s)${b.systemState ? ', Bare Metal Recovery, System State' : ''}`) : ['No backups were found.'];
    return ['Usage: wbadmin start backup -backupTarget:E: -include:C: [-allCritical] -quiet | start systemstatebackup -backupTarget:E: | get versions'];
  },
});
