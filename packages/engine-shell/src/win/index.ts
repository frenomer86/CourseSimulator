/**
 * The Windows PowerShell subset. Importing this module registers every cmdlet module.
 */

import './cmd-basic.js';
import './cmd-ad.js';
import './cmd-files.js';
import './cmd-gpo.js';
import './cmd-net.js';
import './cmd-roles.js';
import { ALIASES, CMDLET_TABLE, HELP, NATIVE_TABLE, register, str } from './core.js';

/** Display names for Get-Command and tab completion, with the usual capitalisation. */
const SPECIAL: Record<string, string> = { ad: 'AD', gp: 'GP', gpo: 'GPO', smb: 'Smb', dns: 'Dns', dhcp: 'Dhcp', fsrm: 'Fsrm', dfsn: 'Dfsn', dfsr: 'Dfsr', vm: 'VM', ca: 'CA', wsus: 'Wsus', wds: 'Wds', rd: 'RD', ip: 'IP', net: 'Net', kds: 'Kds', adcs: 'Adcs', adds: 'ADDS', ldap: 'LDAP', ntfs: 'NTFS', wsman: 'WSMan', pssession: 'PSSession', psremoting: 'PSRemoting', dhcpserverv4: 'DhcpServerv4', dhcpserver: 'DhcpServer' };

export function displayName(key: string): string {
  return key
    .split('-')
    .map((part, i) => {
      if (i === 0) return part[0].toUpperCase() + part.slice(1);
      let out = '';
      let rest = part;
      // Greedy prefixes like "adgroupmember" → "ADGroupMember".
      for (const [k, v] of Object.entries(SPECIAL).sort((a, b) => b[0].length - a[0].length)) {
        if (rest.startsWith(k)) {
          out = v;
          rest = rest.slice(k.length);
          break;
        }
      }
      return out + rest.replace(/^./, (c) => c.toUpperCase()).replace(/(account|group|member|policy|value|range|scope|zone|record|server|share|access|rule|profile|address|interface|configuration|connection|adapter|feature|task|trigger|action|unit|object|optional|password|fine|grained|subject|resultant|replication|site|subnet|directory|operation|master|role|controller|forest|domain|computer|service|certificate|template|update|image|session|collection|deployment|printer|driver|port|job|quota|screen|file|folder|target|root|link|inheritance|permission|registry|status|report|setting|counter|event|disk|partition|volume|pool|virtual|switch|processor|memory|snapshot|location|item|content|credential|string|object|help|command|date|host|null|list|table|sort|select|measure|where|foreach|group)/g, (w) => w[0].toUpperCase() + w.slice(1));
    })
    .join('-');
}

export function cmdletList(): string[] {
  return Object.keys(CMDLET_TABLE).map(displayName).sort();
}

export function nativeList(): string[] {
  return Object.keys(NATIVE_TABLE).sort();
}

register({
  'get-command': (cx) => {
    const pat = cx.pos[0] ?? cx.P.name;
    const re = pat ? new RegExp('^' + str(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i') : null;
    const cmdlets = cmdletList().filter((c) => !re || re.test(c)).map((c) => ({ __type: 'cmd', CommandType: 'Cmdlet', Name: c }));
    const natives = nativeList().filter((c) => !re || re.test(c)).map((c) => ({ __type: 'cmd', CommandType: 'Application', Name: `${c}.exe` }));
    return [...cmdlets, ...natives];
  },
  'get-help': (cx) => {
    const topic = str(cx.P.name ?? cx.pos[0]).toLowerCase();
    const key = ALIASES[topic] ?? topic;
    if (!topic) return ['Get-Help <cmdlet> shows how to use a cmdlet. Get-Command lists every cmdlet and tool on this server; Get-Command *ADUser* filters them.'];
    if (HELP[key]) return [HELP[key]];
    if (CMDLET_TABLE[key]) return [`${displayName(key)}: no detailed help in this lab. Try the examples in the lab instructions, or Get-Command ${displayName(key)}.`];
    if (NATIVE_TABLE[key]) return [`${key}.exe: run it with /? style arguments; the lab instructions list the forms this server supports.`];
    return [`Get-Help could not find ${topic}. Use Get-Command *${topic}* to search.`];
  },
});

export { runPowerShell, promptPowerShell, psAwaitsMore, psQuery, makeEnv, commit, evalSource, toVfs, toWin, normWin, machine, machineByName } from './core.js';
export type { Env, Value, Obj } from './core.js';
export * from './model.js';
export { effectiveAccess, ntfsAccess, shareAccess, aclOf } from './cmd-files.js';
export { rsop, effectivePolicy, effectiveExtra } from './cmd-gpo.js';
export { reach, resolve, listening } from './cmd-net.js';
export { findUser, findGroup, findComputer, groupsOf, resultantPolicy, parseLdap } from './cmd-ad.js';
