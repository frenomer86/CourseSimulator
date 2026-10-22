/** Administration commands: users and groups, identity, processes, services, packages, cron, editors, network stubs, man. */

import { lookup, readFile, remove, writeFile, mkdir, copy } from './fs.js';
import { allocGid, groupName, homeOf, isSudoer, nextUid, serviceFaults, type ShellSystem } from './system.js';
import { actor, currentUser, runCommand, type Ctx } from './shell.js';
import { abs, errText, fullDate, humanSize, lines, parseOpts, strftime, type IO } from './util.js';
import { MAN_PAGES } from './man.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

function needRoot(ctx: Ctx, io: IO, cmd: string, what = 'Permission denied.'): boolean {
  if (currentUser(ctx) === 'root') return false;
  io.err(`${cmd}: ${what}\n`);
  return true;
}

function logAuth(sys: ShellSystem, line: string): void {
  const root = { user: 'root', groups: ['root'] };
  try {
    writeFile(sys.fs, '/var/log/auth.log', `${strftime(sys.now, '%b %e %T')} ${sys.hostname} ${line}\n`, root, sys.now, true);
  } catch {
    /* ignore */
  }
}

export const ADMIN_COMMANDS: Record<string, Cmd> = {
  whoami: (_a, io, ctx) => {
    io.out(currentUser(ctx) + '\n');
    return 0;
  },
  logname: (_a, io, ctx) => {
    io.out((ctx.sys.userStack[0]?.user ?? ctx.sys.user) + '\n');
    return 0;
  },
  id: (args, io, ctx) => {
    const o = parseOpts(args);
    const name = o.rest[0] ?? currentUser(ctx);
    const u = ctx.sys.users[name];
    if (!u) {
      io.err(`id: '${name}': no such user\n`);
      return 1;
    }
    const primary = groupName(ctx.sys, u.gid);
    const groups = [primary, ...u.groups.filter((g) => g !== primary)];
    if (o.flags.has('u')) io.out((o.flags.has('n') ? name : String(u.uid)) + '\n');
    else if (o.flags.has('g')) io.out((o.flags.has('n') ? primary : String(u.gid)) + '\n');
    else if (o.flags.has('G')) io.out(groups.map((g) => (o.flags.has('n') ? g : String(ctx.sys.groups[g]?.gid ?? 0))).join(' ') + '\n');
    else io.out(`uid=${u.uid}(${name}) gid=${u.gid}(${primary}) groups=${groups.map((g) => `${ctx.sys.groups[g]?.gid ?? 0}(${g})`).join(',')}\n`);
    return 0;
  },
  groups: (args, io, ctx) => {
    const name = args[0] ?? currentUser(ctx);
    const u = ctx.sys.users[name];
    if (!u) {
      io.err(`groups: '${name}': no such user\n`);
      return 1;
    }
    const primary = groupName(ctx.sys, u.gid);
    io.out((args[0] ? `${name} : ` : '') + [primary, ...u.groups.filter((g) => g !== primary)].join(' ') + '\n');
    return 0;
  },
  who: (_a, io, ctx) => {
    io.out(`${ctx.sys.user.padEnd(8)} pts/0        ${strftime(ctx.sys.now, '%Y-%m-%d %H:%M')} (10.0.0.5)\n`);
    return 0;
  },
  w: (_a, io, ctx) => {
    io.out(` ${strftime(ctx.sys.now, '%H:%M:%S')} up 3 days,  4:12,  1 user,  load average: 0.08, 0.05, 0.01\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n${ctx.sys.user.padEnd(8)} pts/0    10.0.0.5         ${strftime(ctx.sys.now, '%H:%M')}    0.00s  0.05s  0.01s -bash\n`);
    return 0;
  },
  last: (_a, io, ctx) => {
    io.out(`${ctx.sys.user.padEnd(8)} pts/0        10.0.0.5         ${strftime(ctx.sys.now, '%a %b %e %H:%M')}   still logged in\nreboot   system boot  6.4.0-150600.23  ${strftime(ctx.sys.now - 3 * 86400000, '%a %b %e %H:%M')}   still running\n`);
    return 0;
  },
  hostname: (args, io, ctx) => {
    if (args[0] && !args[0].startsWith('-')) {
      if (needRoot(ctx, io, 'hostname', 'you must be root to change the host name')) return 1;
      ctx.sys.hostname = args[0];
      writeFile(ctx.sys.fs, '/etc/hostname', args[0] + '\n', { user: 'root', groups: ['root'] }, ctx.sys.now);
      return 0;
    }
    if (args.includes('-I') || args.includes('-i')) io.out((ctx.sys.network?.address ?? '10.0.0.10') + '\n');
    else io.out(ctx.sys.hostname + '\n');
    return 0;
  },
  hostnamectl: (args, io, ctx) => {
    if (args[0] === 'set-hostname' && args[1]) return ADMIN_COMMANDS.hostname([args[1]], io, ctx);
    io.out(` Static hostname: ${ctx.sys.hostname}\n Operating System: openSUSE Leap 15.6\n           Kernel: Linux 6.4.0-150600.23\n     Architecture: x86-64\n`);
    return 0;
  },
  uname: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.flags.has('a')) io.out(`Linux ${ctx.sys.hostname} 6.4.0-150600.23-default #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n`);
    else if (o.flags.has('r')) io.out('6.4.0-150600.23-default\n');
    else if (o.flags.has('n')) io.out(ctx.sys.hostname + '\n');
    else if (o.flags.has('m')) io.out('x86_64\n');
    else io.out('Linux\n');
    return 0;
  },
  date: (args, io, ctx) => {
    const fmt = args.find((a) => a.startsWith('+'));
    if (fmt) io.out(strftime(ctx.sys.now, fmt.slice(1)) + '\n');
    else io.out(fullDate(ctx.sys.now) + '\n');
    return 0;
  },
  cal: (_a, io, ctx) => {
    const d = new Date(ctx.sys.now);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const title = `${strftime(ctx.sys.now, '%B')} ${y}`;
    io.out(title.padStart(Math.floor((20 + title.length) / 2)).padEnd(20) + '\nSu Mo Tu We Th Fr Sa\n');
    let line = '   '.repeat(first);
    for (let day = 1; day <= days; day++) {
      line += String(day).padStart(2) + ' ';
      if ((first + day) % 7 === 0) {
        io.out(line.trimEnd() + '\n');
        line = '';
      }
    }
    if (line) io.out(line.trimEnd() + '\n');
    return 0;
  },
  uptime: (_a, io) => {
    io.out(' 09:30:00 up 3 days,  4:12,  1 user,  load average: 0.08, 0.05, 0.01\n');
    return 0;
  },
  free: (args, io) => {
    const h = args.includes('-h');
    const f = (kb: number) => (h ? humanSize(kb * 1024) + 'i' : String(kb));
    io.out(`               total        used        free      shared  buff/cache   available\nMem:     ${f(4015000).padStart(11)} ${f(812000).padStart(11)} ${f(2401000).padStart(11)} ${f(9000).padStart(11)} ${f(802000).padStart(11)} ${f(2950000).padStart(11)}\nSwap:    ${f(2097148).padStart(11)} ${f(0).padStart(11)} ${f(2097148).padStart(11)}\n`);
    return 0;
  },
  env: (args, io, ctx) => {
    if (args.length) return runCommand(ctx, args, io);
    for (const k of Object.keys(ctx.vars).filter((k) => ctx.exported.has(k)).sort()) io.out(`${k}=${ctx.vars[k]}\n`);
    return 0;
  },
  printenv: (args, io, ctx) => {
    if (args[0]) {
      const v = ctx.vars[args[0]];
      if (v === undefined) return 1;
      io.out(v + '\n');
      return 0;
    }
    return ADMIN_COMMANDS.env([], io, ctx);
  },
  which: (args, io, ctx) => {
    let code = 0;
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      const r = runCommand(ctx, ['command', '-v', a], io);
      if (r !== 0) {
        io.err(`which: no ${a} in (${ctx.vars.PATH ?? '/usr/bin:/bin'})\n`);
        code = 1;
      }
    }
    return code;
  },
  whereis: (args, io) => {
    for (const a of args) io.out(`${a}: /usr/bin/${a} /usr/share/man/man1/${a}.1.gz\n`);
    return 0;
  },
  clear: (_a, _io, ctx) => {
    ctx.requests.push({ kind: 'clear' });
    return 0;
  },
  reset: (_a, _io, ctx) => {
    ctx.requests.push({ kind: 'clear' });
    return 0;
  },
  sleep: () => 0,
  true: () => 0,
  false: () => 1,
  yes: (args, io) => {
    io.out(((args[0] ?? 'y') + '\n').repeat(20) + '(yes would continue forever; the simulator stops here)\n');
    return 0;
  },

  /* ---------------------------------------------------------- users and groups */
  useradd: (args, io, ctx) => {
    if (needRoot(ctx, io, 'useradd')) return 1;
    const o = parseOpts(args, ['d', 's', 'G', 'g', 'c', 'u', 'e', 'k', 'p']);
    const name = o.rest[0];
    if (!name) {
      io.err('Usage: useradd [options] LOGIN\n');
      return 2;
    }
    if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
      io.err(`useradd: invalid user name '${name}'\n`);
      return 3;
    }
    if (ctx.sys.users[name]) {
      io.err(`useradd: user '${name}' already exists\n`);
      return 9;
    }
    const sys = ctx.sys;
    const extra = o.values.G ? o.values.G.split(',').filter(Boolean) : [];
    for (const g of extra) if (!sys.groups[g]) {
      io.err(`useradd: group '${g}' does not exist\n`);
      return 6;
    }
    let gid: number;
    if (o.values.g) {
      const g = sys.groups[o.values.g];
      if (!g) {
        io.err(`useradd: group '${o.values.g}' does not exist\n`);
        return 6;
      }
      gid = g.gid;
    } else if (o.flags.has('N')) gid = sys.groups.users.gid;
    else {
      if (!sys.groups[name]) sys.groups[name] = { gid: allocGid(sys), members: [] };
      gid = sys.groups[name].gid;
    }
    const uid = o.values.u ? Number(o.values.u) : nextUid(sys);
    const home = o.values.d ?? `/home/${name}`;
    sys.users[name] = { uid, gid, home, shell: o.values.s ?? '/bin/bash', groups: [groupName(sys, gid), ...extra], comment: o.values.c ?? '', password: 'none', lastChanged: sys.now };
    for (const g of extra) if (!sys.groups[g].members.includes(name)) sys.groups[g].members.push(name);
    if (o.flags.has('m') || o.flags.has('create-home')) {
      const root = { user: 'root', groups: ['root'] };
      if (!lookup(sys.fs, home, root)) {
        mkdir(sys.fs, home, root, sys.now, true);
        const skel = lookup(sys.fs, '/etc/skel', root);
        if (skel?.node.type === 'dir') for (const k of Object.keys(skel.node.children)) copy(sys.fs, `/etc/skel/${k}`, `${home}/${k}`, root, sys.now, true);
        const h = lookup(sys.fs, home, root)!.node;
        h.owner = name;
        h.group = groupName(sys, gid);
        h.mode = 0o755;
        if (h.type === 'dir') for (const c of Object.values(h.children)) { c.owner = name; c.group = groupName(sys, gid); }
      }
    }
    logAuth(sys, `useradd[1200]: new user: name=${name}, UID=${uid}, GID=${gid}, home=${home}, shell=${sys.users[name].shell}`);
    return 0;
  },

  userdel: (args, io, ctx) => {
    if (needRoot(ctx, io, 'userdel')) return 1;
    const o = parseOpts(args);
    const name = o.rest[0];
    if (!name || !ctx.sys.users[name]) {
      io.err(`userdel: user '${name ?? ''}' does not exist\n`);
      return 6;
    }
    if (name === 'root') {
      io.err('userdel: user root cannot be deleted\n');
      return 8;
    }
    const u = ctx.sys.users[name];
    delete ctx.sys.users[name];
    for (const g of Object.values(ctx.sys.groups)) g.members = g.members.filter((m) => m !== name);
    if (ctx.sys.groups[name] && ctx.sys.groups[name].gid === u.gid && !Object.values(ctx.sys.users).some((x) => x.gid === u.gid)) delete ctx.sys.groups[name];
    if (o.flags.has('r')) {
      try {
        remove(ctx.sys.fs, u.home, { user: 'root', groups: ['root'] }, true);
      } catch {
        io.err(`userdel: ${name} home directory (${u.home}) not found\n`);
      }
    }
    delete ctx.sys.crontabs[name];
    return 0;
  },

  usermod: (args, io, ctx) => {
    if (needRoot(ctx, io, 'usermod')) return 1;
    const o = parseOpts(args, ['G', 'g', 's', 'd', 'c', 'l', 'e', 'u']);
    const name = o.rest[0];
    const u = name ? ctx.sys.users[name] : undefined;
    if (!u) {
      io.err(`usermod: user '${name ?? ''}' does not exist\n`);
      return 6;
    }
    const sys = ctx.sys;
    if (o.values.G !== undefined) {
      const wanted = o.values.G.split(',').filter(Boolean);
      for (const g of wanted) if (!sys.groups[g]) {
        io.err(`usermod: group '${g}' does not exist\n`);
        return 6;
      }
      const primary = groupName(sys, u.gid);
      if (!o.flags.has('a')) {
        for (const g of Object.keys(sys.groups)) sys.groups[g].members = sys.groups[g].members.filter((m) => m !== name);
        u.groups = [primary];
      }
      for (const g of wanted) {
        if (!u.groups.includes(g)) u.groups.push(g);
        if (!sys.groups[g].members.includes(name)) sys.groups[g].members.push(name);
      }
    }
    if (o.values.g) {
      const g = sys.groups[o.values.g];
      if (!g) {
        io.err(`usermod: group '${o.values.g}' does not exist\n`);
        return 6;
      }
      u.gid = g.gid;
    }
    if (o.values.s) u.shell = o.values.s;
    if (o.values.c !== undefined) u.comment = o.values.c;
    if (o.values.d) u.home = o.values.d;
    if (o.flags.has('L')) u.password = 'locked';
    if (o.flags.has('U')) u.password = 'set';
    if (o.values.l) {
      sys.users[o.values.l] = u;
      delete sys.users[name];
      for (const g of Object.values(sys.groups)) g.members = g.members.map((m) => (m === name ? o.values.l : m));
    }
    return 0;
  },

  groupadd: (args, io, ctx) => {
    if (needRoot(ctx, io, 'groupadd')) return 1;
    const o = parseOpts(args, ['g']);
    const name = o.rest[0];
    if (!name) {
      io.err('Usage: groupadd [options] GROUP\n');
      return 2;
    }
    if (ctx.sys.groups[name]) {
      io.err(`groupadd: group '${name}' already exists\n`);
      return 9;
    }
    ctx.sys.groups[name] = { gid: o.values.g ? Number(o.values.g) : allocGid(ctx.sys), members: [] };
    return 0;
  },
  groupdel: (args, io, ctx) => {
    if (needRoot(ctx, io, 'groupdel')) return 1;
    const name = args[0];
    const g = name ? ctx.sys.groups[name] : undefined;
    if (!g) {
      io.err(`groupdel: group '${name ?? ''}' does not exist\n`);
      return 6;
    }
    if (Object.values(ctx.sys.users).some((u) => u.gid === g.gid)) {
      io.err(`groupdel: cannot remove the primary group of user '${Object.entries(ctx.sys.users).find(([, u]) => u.gid === g.gid)![0]}'\n`);
      return 8;
    }
    delete ctx.sys.groups[name];
    for (const u of Object.values(ctx.sys.users)) u.groups = u.groups.filter((x) => x !== name);
    return 0;
  },
  gpasswd: (args, io, ctx) => {
    if (needRoot(ctx, io, 'gpasswd')) return 1;
    const o = parseOpts(args, ['a', 'd']);
    const group = o.rest[0];
    if (!group || !ctx.sys.groups[group]) {
      io.err(`gpasswd: group '${group ?? ''}' does not exist in /etc/group\n`);
      return 3;
    }
    const target = o.values.a ?? o.values.d;
    if (!target || !ctx.sys.users[target]) {
      io.err(`gpasswd: user '${target ?? ''}' does not exist\n`);
      return 3;
    }
    const g = ctx.sys.groups[group];
    const u = ctx.sys.users[target];
    if (o.values.a) {
      if (!g.members.includes(target)) g.members.push(target);
      if (!u.groups.includes(group)) u.groups.push(group);
      io.out(`Adding user ${target} to group ${group}\n`);
    } else {
      g.members = g.members.filter((m) => m !== target);
      u.groups = u.groups.filter((x) => x !== group);
      io.out(`Removing user ${target} from group ${group}\n`);
    }
    return 0;
  },
  passwd: (args, io, ctx) => {
    const o = parseOpts(args);
    const me = currentUser(ctx);
    const name = o.rest[0] ?? me;
    const u = ctx.sys.users[name];
    if (!u) {
      io.err(`passwd: user '${name}' does not exist\n`);
      return 1;
    }
    if (name !== me && me !== 'root') {
      io.err('passwd: You may not view or modify password information for other users.\n');
      return 1;
    }
    if (o.flags.has('l') || o.flags.has('u') || o.flags.has('e') || o.flags.has('S')) {
      if (o.flags.has('S')) {
        io.out(`${name} ${u.password === 'locked' ? 'L' : u.password === 'none' ? 'NP' : 'P'} ${strftime(u.lastChanged ?? ctx.sys.now, '%m/%d/%Y')} 0 ${u.maxDays ?? 99999} 7 -1\n`);
        return 0;
      }
      if (needRoot(ctx, io, 'passwd', 'Only root can do that.')) return 1;
      if (o.flags.has('l')) {
        u.password = 'locked';
        io.out(`passwd: password changed.\n`);
      } else if (o.flags.has('u')) {
        u.password = 'set';
        io.out(`passwd: password changed.\n`);
      } else {
        u.lastChanged = 0;
        io.out('passwd: password expiry information changed.\n');
      }
      return 0;
    }
    // The simulator does not prompt: the password is taken from stdin if given, else assumed typed twice.
    const typed = lines(io.stdin);
    const pw = typed[0] ?? 'changeme';
    if (typed.length && typed[1] !== undefined && typed[1] !== typed[0]) {
      io.err('Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged\n');
      return 10;
    }
    if (pw.length < 6 && me !== 'root') {
      io.err('BAD PASSWORD: The password is shorter than 6 characters\npasswd: Authentication token manipulation error\n');
      return 10;
    }
    io.out(`${me !== 'root' ? 'Changing password for user ' + name + '.\nCurrent password: ********\n' : ''}New password: ********\nRetype new password: ********\npasswd: password updated successfully\n`);
    u.password = 'set';
    u.lastChanged = ctx.sys.now;
    logAuth(ctx.sys, `passwd[1201]: pam_unix(passwd:chauthtok): password changed for ${name}`);
    return 0;
  },
  chpasswd: (_a, io, ctx) => {
    if (needRoot(ctx, io, 'chpasswd')) return 1;
    for (const l of lines(io.stdin)) {
      const [name] = l.split(':');
      const u = ctx.sys.users[name];
      if (!u) {
        io.err(`chpasswd: line 1: user '${name}' does not exist\n`);
        return 1;
      }
      u.password = 'set';
      u.lastChanged = ctx.sys.now;
    }
    return 0;
  },
  chage: (args, io, ctx) => {
    const o = parseOpts(args, ['M', 'm', 'W', 'E', 'd']);
    const name = o.rest[0];
    const u = name ? ctx.sys.users[name] : undefined;
    if (!u) {
      io.err(`chage: user '${name ?? ''}' does not exist in /etc/passwd\n`);
      return 1;
    }
    if (o.flags.has('l')) {
      if (currentUser(ctx) !== 'root' && currentUser(ctx) !== name) {
        io.err('chage: Permission denied.\n');
        return 1;
      }
      const lc = u.lastChanged ?? ctx.sys.now;
      io.out(`Last password change\t\t\t\t\t: ${lc === 0 ? 'password must be changed' : strftime(lc, '%b %d, %Y')}\nPassword expires\t\t\t\t\t: ${u.maxDays ? strftime(lc + u.maxDays * 86400000, '%b %d, %Y') : 'never'}\nPassword inactive\t\t\t\t\t: never\nAccount expires\t\t\t\t\t\t: never\nMinimum number of days between password change\t\t: 0\nMaximum number of days between password change\t\t: ${u.maxDays ?? 99999}\nNumber of days of warning before password expires\t: 7\n`);
      return 0;
    }
    if (needRoot(ctx, io, 'chage', 'Permission denied.')) return 1;
    if (o.values.M) u.maxDays = Number(o.values.M);
    if (o.values.d === '0') u.lastChanged = 0;
    return 0;
  },
  chsh: (args, io, ctx) => {
    const o = parseOpts(args, ['s']);
    const name = o.rest[0] ?? currentUser(ctx);
    if (name !== currentUser(ctx) && needRoot(ctx, io, 'chsh')) return 1;
    const u = ctx.sys.users[name];
    if (!u) {
      io.err(`chsh: user '${name}' does not exist\n`);
      return 1;
    }
    if (o.values.s) u.shell = o.values.s;
    return 0;
  },
  getent: (args, io, ctx) => {
    const [db, key] = args;
    const root = { user: 'root', groups: ['root'] };
    const file = db === 'passwd' ? '/etc/passwd' : db === 'group' ? '/etc/group' : db === 'shadow' ? '/etc/shadow' : null;
    if (!file) {
      io.err(`getent: Unknown database: ${db}\n`);
      return 2;
    }
    const ls = lines(readFile(ctx.sys.fs, file, root));
    const hits = key ? ls.filter((l) => l.split(':')[0] === key) : ls;
    io.out(hits.map((l) => l + '\n').join(''));
    return hits.length ? 0 : 2;
  },

  su: (args, io, ctx) => {
    const o = parseOpts(args.filter((a) => a !== '-'), ['c']);
    const login = o.flags.has('l') || o.flags.has('login') || args.includes('-');
    const target = o.rest.find((r) => r !== '-') ?? 'root';
    const sys = ctx.sys;
    if (!sys.users[target]) {
      io.err(`su: user ${target} does not exist or the user entry does not contain all the required fields\n`);
      return 1;
    }
    if (sys.users[target].password === 'locked' && currentUser(ctx) !== 'root') {
      io.err('su: Authentication failure\n');
      logAuth(sys, `su: FAILED SU (to ${target}) ${currentUser(ctx)} on pts/0`);
      return 1;
    }
    if (currentUser(ctx) !== 'root') io.out('Password: ********\n');
    if (o.values.c) {
      const saved = ctx.euser;
      ctx.euser = target;
      try {
        return runCommand(ctx, ['bash', '-c', o.values.c], io);
      } finally {
        ctx.euser = saved;
      }
    }
    sys.userStack.push({ user: sys.user, cwd: sys.cwd });
    sys.user = target;
    if (login) sys.cwd = homeOf(sys, target);
    ctx.vars.USER = target;
    ctx.vars.LOGNAME = target;
    ctx.vars.HOME = homeOf(sys, target);
    sys.env.USER = target;
    sys.env.HOME = ctx.vars.HOME;
    logAuth(sys, `su: (to ${target}) ${sys.userStack[sys.userStack.length - 1].user} on pts/0`);
    return 0;
  },

  sudo: (args, io, ctx) => {
    const sys = ctx.sys;
    const me = currentUser(ctx);
    const o = parseOpts(args, ['u'], {}, true);
    if (!isSudoer(sys, me)) {
      io.err(`${me} is not in the sudoers file.  This incident will be reported.\n`);
      logAuth(sys, `sudo: ${me} : user NOT in sudoers ; TTY=pts/0 ; PWD=${sys.cwd} ; USER=root ; COMMAND=${o.rest.join(' ')}`);
      return 1;
    }
    const target = o.values.u ?? 'root';
    if (!sys.users[target]) {
      io.err(`sudo: unknown user ${target}\n`);
      return 1;
    }
    if (o.flags.has('l')) {
      io.out(`User ${me} may run the following commands on ${sys.hostname}:\n    (ALL : ALL) ALL\n`);
      return 0;
    }
    if (o.flags.has('i') || o.flags.has('s') || (!o.rest.length && !o.flags.size)) {
      if (!o.rest.length) {
        sys.userStack.push({ user: sys.user, cwd: sys.cwd });
        sys.user = target;
        if (o.flags.has('i')) sys.cwd = homeOf(sys, target);
        ctx.vars.USER = target;
        ctx.vars.HOME = homeOf(sys, target);
        sys.env.USER = target;
        sys.env.HOME = ctx.vars.HOME;
        logAuth(sys, `sudo: ${me} : TTY=pts/0 ; PWD=${sys.cwd} ; USER=${target} ; COMMAND=/bin/bash`);
        return 0;
      }
    }
    if (!o.rest.length) {
      io.err('usage: sudo [-u user] command\n');
      return 1;
    }
    logAuth(sys, `sudo: ${me} : TTY=pts/0 ; PWD=${sys.cwd} ; USER=${target} ; COMMAND=${o.rest.join(' ')}`);
    const saved = ctx.euser;
    ctx.euser = target;
    const savedHome = ctx.vars.HOME;
    try {
      return runCommand(ctx, o.rest, io);
    } finally {
      ctx.euser = saved;
      ctx.vars.HOME = savedHome;
    }
  },
  visudo: (_a, io, ctx) => {
    if (needRoot(ctx, io, 'visudo', '/etc/sudoers: Permission denied')) return 1;
    ctx.requests.push({ kind: 'editor', path: '/etc/sudoers' });
    return 0;
  },

  /* ---------------------------------------------------------- processes */
  ps: (args, io, ctx) => {
    const all = args.some((a) => /a|e/.test(a)) || args.includes('aux') || args.includes('-ef');
    const me = currentUser(ctx);
    const procs = ctx.sys.processes.filter((p) => all || p.user === me);
    if (args.includes('aux') || args.includes('-aux')) {
      io.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
      for (const p of procs) io.out(`${p.user.padEnd(10)} ${String(p.pid).padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(12000 + p.pid * 7).padStart(6)} ${String(3000 + p.pid * 3).padStart(5)} ${(p.cmd === '-bash' ? 'pts/0' : '?').padEnd(8)} ${p.cpu > 50 ? 'R' : 'S'}s   ${strftime(ctx.sys.now - 1000000, '%H:%M')}   0:0${Math.round(p.cpu / 20)} ${p.cmd}\n`);
      return 0;
    }
    if (args.includes('-ef') || args.includes('-e')) {
      io.out('UID          PID    PPID  C STIME TTY          TIME CMD\n');
      for (const p of procs) io.out(`${p.user.padEnd(10)} ${String(p.pid).padStart(5)} ${String(p.pid === 1 ? 0 : 1).padStart(7)}  ${Math.round(p.cpu / 10)} ${strftime(ctx.sys.now - 1000000, '%H:%M')} ${(p.cmd === '-bash' ? 'pts/0' : '?').padEnd(8)} 00:00:0${Math.round(p.cpu / 20)} ${p.cmd}\n`);
      return 0;
    }
    io.out('    PID TTY          TIME CMD\n');
    for (const p of procs) io.out(`${String(p.pid).padStart(7)} pts/0    00:00:00 ${p.cmd.split(' ')[0].split('/').pop()}\n`);
    return 0;
  },
  pgrep: (args, io, ctx) => {
    const o = parseOpts(args, ['u']);
    const pat = o.rest[0] ?? '';
    const hits = ctx.sys.processes.filter((p) => (o.flags.has('f') ? p.cmd : p.cmd.split(' ')[0].split('/').pop() ?? '').includes(pat) && (!o.values.u || p.user === o.values.u));
    for (const p of hits) io.out(o.flags.has('l') || o.flags.has('a') ? `${p.pid} ${p.cmd}\n` : `${p.pid}\n`);
    return hits.length ? 0 : 1;
  },
  kill: (args, io, ctx) => {
    const o = parseOpts(args, ['s']);
    const sig = [...o.flags].find((f) => /^\d+$|^[A-Z]+$/.test(f)) ?? o.values.s ?? 'TERM';
    void sig;
    let code = 0;
    for (const pidText of o.rest) {
      const pid = Number(pidText);
      const idx = ctx.sys.processes.findIndex((p) => p.pid === pid);
      if (idx === -1) {
        io.err(`bash: kill: (${pidText}) - No such process\n`);
        code = 1;
        continue;
      }
      const p = ctx.sys.processes[idx];
      if (currentUser(ctx) !== 'root' && p.user !== currentUser(ctx)) {
        io.err(`bash: kill: (${pid}) - Operation not permitted\n`);
        code = 1;
        continue;
      }
      if (pid === 1) {
        io.err('bash: kill: (1) - Operation not permitted\n');
        code = 1;
        continue;
      }
      if (p.cmd === '-bash') continue;
      ctx.sys.processes.splice(idx, 1);
    }
    return code;
  },
  pkill: (args, io, ctx) => killByName(args, io, ctx, 'pkill'),
  killall: (args, io, ctx) => killByName(args, io, ctx, 'killall'),
  top: (args, io, ctx) => {
    void args;
    io.out(`top - ${strftime(ctx.sys.now, '%H:%M:%S')} up 3 days,  4:12,  1 user,  load average: 0.08, 0.05, 0.01\nTasks: ${ctx.sys.processes.length} total,   1 running, ${ctx.sys.processes.length - 1} sleeping,   0 stopped,   0 zombie\n%Cpu(s):  ${ctx.sys.processes.reduce((a, p) => a + p.cpu, 0).toFixed(1)} us,  0.3 sy,  0.0 ni, 96.5 id,  0.0 wa\nMiB Mem :   3921.0 total,   2345.1 free,    793.2 used,    782.7 buff/cache\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n`);
    for (const p of [...ctx.sys.processes].sort((a, b) => b.cpu - a.cpu)) io.out(`${String(p.pid).padStart(7)} ${p.user.padEnd(9)} 20   0 ${String(12000 + p.pid * 7).padStart(7)} ${String(3000 + p.pid * 3).padStart(6)} ${String(2000).padStart(6)} ${p.cpu > 50 ? 'R' : 'S'} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)}   0:0${Math.round(p.cpu / 20)}.00 ${p.cmd.split(' ')[0].split('/').pop()}\n`);
    io.out('(top refreshes every 3 seconds on a real system; press q to quit. The simulator shows one snapshot.)\n');
    return 0;
  },
  htop: (args, io, ctx) => ADMIN_COMMANDS.top(args, io, ctx),
  vmstat: (_a, io) => {
    io.out('procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n 1  0      0 2401000  81200 720000    0    0     3     9   52   98  2  1 97  0  0\n');
    return 0;
  },
  iostat: (_a, io) => {
    io.out('avg-cpu:  %user   %nice %system %iowait  %steal   %idle\n           2.10    0.00    0.80    0.30    0.00   96.80\n\nDevice             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn\nsda               1.90        12.40        30.10     412000     998000\n');
    return 0;
  },
  dmesg: (_a, io) => {
    io.out('[    0.000000] Linux version 6.4.0-150600.23-default (geeko@buildhost) (gcc version 7.5.0)\n[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz root=/dev/sda2 ro quiet\n[    1.204331] sd 0:0:0:0: [sda] 83886080 512-byte logical blocks: (42.9 GB/40.0 GiB)\n[    2.011923] EXT4-fs (sda2): mounted filesystem with ordered data mode\n[    4.511002] e1000: eth0 NIC Link is Up 1000 Mbps Full Duplex\n');
    return 0;
  },

  /* ---------------------------------------------------------- services */
  systemctl: (args, io, ctx) => {
    const o = parseOpts(args);
    const [action, unitRaw] = o.rest;
    const sys = ctx.sys;
    if (!action || action === 'list-units' || action === 'list-unit-files') {
      io.out('  UNIT                 LOAD   ACTIVE   SUB     DESCRIPTION\n');
      for (const [n, s] of Object.entries(sys.services)) io.out(`  ${(n + '.service').padEnd(20)} loaded ${(s.active ? 'active' : serviceFaults(sys, n).length && s.enabled ? 'failed' : 'inactive').padEnd(8)} ${(s.active ? 'running' : 'dead').padEnd(7)} ${s.description}\n`);
      return 0;
    }
    const unit = unitRaw?.replace(/\.service$/, '');
    const s = unit ? sys.services[unit] : undefined;
    if (!unit) {
      io.err(`systemctl: too few arguments for '${action}'\n`);
      return 1;
    }
    if (!s || (s.package && !sys.packages[s.package]?.installed)) {
      if (action === 'status') {
        io.err(`Unit ${unit}.service could not be found.\n`);
        return 4;
      }
      io.err(`Failed to ${action} ${unit}.service: Unit ${unit}.service not found.\n`);
      return 5;
    }
    const faults = serviceFaults(sys, unit);
    const needsRoot = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action);
    if (needsRoot && currentUser(ctx) !== 'root') {
      io.err(`Failed to ${action} ${unit}.service: Access denied\nSee system logs and 'systemctl status ${unit}.service' for details.\n`);
      return 1;
    }
    const stamp = () => strftime(sys.now, '%a %Y-%m-%d %H:%M:%S GMT');
    switch (action) {
      case 'status': {
        const failed = !s.active && s.logs.some((l) => /failed|error/i.test(l)) && faults.length > 0;
        io.out(`● ${unit}.service - ${s.description}\n     Loaded: loaded (/usr/lib/systemd/system/${unit}.service; ${s.enabled ? 'enabled' : 'disabled'}; preset: disabled)\n     Active: ${s.active ? 'active (running)' : failed ? 'failed (Result: exit-code)' : 'inactive (dead)'} since ${stamp()}\n${s.port ? `   Main PID: ${1300 + unit.length} (${unit})\n` : ''}\n`);
        for (const l of s.logs.slice(-6)) io.out(`${strftime(sys.now, '%b %d %H:%M:%S')} ${sys.hostname} ${unit}[${1300 + unit.length}]: ${l}\n`);
        return s.active ? 0 : 3;
      }
      case 'is-active':
        io.out((s.active ? 'active' : 'inactive') + '\n');
        return s.active ? 0 : 3;
      case 'is-enabled':
        io.out((s.enabled ? 'enabled' : 'disabled') + '\n');
        return s.enabled ? 0 : 1;
      case 'start':
      case 'restart':
      case 'reload': {
        if (faults.length) {
          s.active = false;
          for (const f of faults) s.logs.push(f);
          s.logs.push(`${unit}.service: Main process exited, code=exited, status=1/FAILURE`, `Failed to start ${s.description}.`);
          io.err(`Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`);
          return 1;
        }
        s.active = true;
        s.logs.push(action === 'reload' ? `Reloaded ${s.description}.` : `Started ${s.description}.`);
        if (!sys.processes.some((p) => p.cmd.includes(unit))) sys.processes.push({ pid: sys.nextPid++, user: unit === 'sshd' || unit === 'cron' ? 'root' : unit === 'apache2' ? 'wwwrun' : 'root', cmd: `/usr/sbin/${unit}`, cpu: 0.1, mem: 0.4 });
        return 0;
      }
      case 'stop':
        s.active = false;
        s.logs.push(`Stopped ${s.description}.`);
        sys.processes = sys.processes.filter((p) => !p.cmd.includes(`/usr/sbin/${unit}`));
        return 0;
      case 'enable':
        s.enabled = true;
        io.out(`Created symlink /etc/systemd/system/multi-user.target.wants/${unit}.service → /usr/lib/systemd/system/${unit}.service.\n`);
        if (o.flags.has('now')) return ADMIN_COMMANDS.systemctl(['start', unit], io, ctx);
        return 0;
      case 'disable':
        s.enabled = false;
        io.out(`Removed "/etc/systemd/system/multi-user.target.wants/${unit}.service".\n`);
        if (o.flags.has('now')) return ADMIN_COMMANDS.systemctl(['stop', unit], io, ctx);
        return 0;
      case 'daemon-reload':
        return 0;
      case 'cat':
        io.out(`# /usr/lib/systemd/system/${unit}.service\n[Unit]\nDescription=${s.description}\nAfter=network.target\n\n[Service]\nExecStart=/usr/sbin/${unit}\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`);
        return 0;
    }
    io.err(`Unknown command verb ${action}.\n`);
    return 1;
  },
  service: (args, io, ctx) => ADMIN_COMMANDS.systemctl([args[1], args[0]], io, ctx),
  journalctl: (args, io, ctx) => {
    const o = parseOpts(args, ['u', 'n', 'p']);
    const sys = ctx.sys;
    const n = o.values.n ? Number(o.values.n) : 50;
    const units = o.values.u ? [o.values.u.replace(/\.service$/, '')] : Object.keys(sys.services);
    const entries: string[] = [];
    for (const u of units) {
      const s = sys.services[u];
      if (!s) continue;
      for (const l of s.logs) entries.push(`${strftime(sys.now, '%b %d %H:%M:%S')} ${sys.hostname} ${u}[${1300 + u.length}]: ${l}`);
    }
    if (o.values.u && !sys.services[units[0]]) {
      io.out('-- No entries --\n');
      return 0;
    }
    if (currentUser(ctx) !== 'root' && !actor(ctx).groups.includes('adm') && !actor(ctx).groups.includes('wheel')) io.out('Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'wheel\' can see all messages.\n');
    const shown = entries.slice(-n);
    io.out(shown.length ? shown.map((e) => e + '\n').join('') : '-- No entries --\n');
    if (o.flags.has('f')) io.out('(journalctl -f would keep following; the simulator returns.)\n');
    return 0;
  },

  /* ---------------------------------------------------------- packages */
  zypper: (args, io, ctx) => pkgManager(args, io, ctx, 'zypper'),
  apt: (args, io, ctx) => pkgManager(args, io, ctx, 'apt'),
  'apt-get': (args, io, ctx) => pkgManager(args, io, ctx, 'apt'),
  dnf: (args, io, ctx) => pkgManager(args, io, ctx, 'dnf'),
  yum: (args, io, ctx) => pkgManager(args, io, ctx, 'dnf'),
  rpm: (args, io, ctx) => {
    const o = parseOpts(args);
    if (o.flags.has('q')) {
      if (o.flags.has('a')) {
        for (const [n, p] of Object.entries(ctx.sys.packages)) if (p.installed) io.out(`${n}-${p.version}-1.x86_64\n`);
        return 0;
      }
      let code = 0;
      for (const n of o.rest) {
        const p = ctx.sys.packages[n];
        if (p?.installed) io.out(`${n}-${p.version}-1.x86_64\n`);
        else {
          io.out(`package ${n} is not installed\n`);
          code = 1;
        }
      }
      return code;
    }
    io.err('rpm: use zypper to install packages in this lab\n');
    return 1;
  },
  dpkg: (args, io, ctx) => {
    if (args[0] === '-l') {
      for (const [n, p] of Object.entries(ctx.sys.packages)) if (p.installed) io.out(`ii  ${n.padEnd(20)} ${p.version.padEnd(12)} amd64        ${p.description}\n`);
      return 0;
    }
    if (args[0] === '-s' && args[1]) {
      const p = ctx.sys.packages[args[1]];
      if (!p?.installed) {
        io.err(`dpkg-query: package '${args[1]}' is not installed and no information is available\n`);
        return 1;
      }
      io.out(`Package: ${args[1]}\nStatus: install ok installed\nVersion: ${p.version}\nDescription: ${p.description}\n`);
      return 0;
    }
    io.err('dpkg: use apt to install packages in this lab\n');
    return 1;
  },
  pip: (args, io) => pipLike(args, io),
  pip3: (args, io) => pipLike(args, io),

  /* ---------------------------------------------------------- cron */
  crontab: (args, io, ctx) => {
    const o = parseOpts(args, ['u']);
    const sys = ctx.sys;
    const me = currentUser(ctx);
    const target = o.values.u ?? me;
    if (o.values.u && me !== 'root') {
      io.err('crontab: must be privileged to use -u\n');
      return 1;
    }
    if (o.flags.has('l')) {
      const t = sys.crontabs[target];
      if (!t) {
        io.err(`no crontab for ${target}\n`);
        return 1;
      }
      io.out(t.endsWith('\n') ? t : t + '\n');
      return 0;
    }
    if (o.flags.has('r')) {
      delete sys.crontabs[target];
      return 0;
    }
    if (o.flags.has('e')) {
      ctx.requests.push({ kind: 'crontab', user: target, content: sys.crontabs[target] ?? '' });
      return 0;
    }
    const src = o.rest[0] === '-' || !o.rest[0] ? io.stdin : (() => {
      try {
        return readFile(sys.fs, abs(ctx, o.rest[0]), actor(ctx));
      } catch (e) {
        io.err(`crontab: ${errText(e, o.rest[0])}\n`);
        return null;
      }
    })();
    if (src === null) return 1;
    const bad = validateCrontab(src);
    if (bad) {
      io.err(`"${o.rest[0] ?? '-'}":${bad.line}: bad ${bad.what}\nerrors in crontab file, can't install.\n`);
      return 1;
    }
    sys.crontabs[target] = src;
    return 0;
  },

  /* ---------------------------------------------------------- editors */
  nano: (args, io, ctx) => openEditor(args, io, ctx, 'nano'),
  vi: (args, io, ctx) => openEditor(args, io, ctx, 'vi'),
  vim: (args, io, ctx) => openEditor(args, io, ctx, 'vim'),
  emacs: (args, io, ctx) => openEditor(args, io, ctx, 'emacs'),

  /* ---------------------------------------------------------- network stubs */
  ip: (args, io, ctx) => {
    const net = ctx.sys.network ?? { address: '10.0.0.10/24', gateway: '10.0.0.1' };
    const [addr, prefix = '24'] = net.address.split('/');
    if (args[0]?.startsWith('a') || args[0] === undefined) {
      io.out(`1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000\n    link/ether 52:54:00:3a:9b:1c brd ff:ff:ff:ff:ff:ff\n    inet ${addr}/${prefix} brd ${addr.replace(/\.\d+$/, '.255')} scope global eth0\n       valid_lft forever preferred_lft forever\n`);
      return 0;
    }
    if (args[0]?.startsWith('r')) {
      io.out(`default via ${net.gateway ?? '10.0.0.1'} dev eth0 proto static metric 100\n${addr.replace(/\.\d+$/, '.0')}/${prefix} dev eth0 proto kernel scope link src ${addr}\n`);
      return 0;
    }
    if (args[0]?.startsWith('l')) {
      io.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n');
      return 0;
    }
    io.err('ip: this simulator supports "ip addr", "ip route" and "ip link"\n');
    return 1;
  },
  ifconfig: (_a, io, ctx) => ADMIN_COMMANDS.ip(['addr'], io, ctx),
  ping: (args, io, ctx) => {
    const o = parseOpts(args, ['c']);
    const host = o.rest[0];
    if (!host) {
      io.err('ping: usage error: Destination address required\n');
      return 2;
    }
    const hosts = ctx.sys.network?.hosts ?? {};
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : hosts[host];
    if (!ip) {
      io.err(`ping: ${host}: Name or service not known\n`);
      return 2;
    }
    const known = host === 'localhost' || ip === '127.0.0.1' || Object.values(hosts).includes(ip) || ip === ctx.sys.network?.gateway || ip === ctx.sys.network?.address.split('/')[0];
    const n = Number(o.values.c ?? 4);
    io.out(`PING ${host} (${ip}) 56(84) bytes of data.\n`);
    if (!known) {
      io.out(`\n--- ${host} ping statistics ---\n${n} packets transmitted, 0 received, 100% packet loss, time ${n * 1000}ms\n`);
      return 1;
    }
    for (let i = 1; i <= n; i++) io.out(`64 bytes from ${ip}: icmp_seq=${i} ttl=64 time=0.${(40 + i * 7) % 100} ms\n`);
    io.out(`\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss, time ${(n - 1) * 1000}ms\n`);
    return 0;
  },
  ss: (args, io, ctx) => netstatLike(args, io, ctx),
  netstat: (args, io, ctx) => netstatLike(args, io, ctx),
  'ssh-keygen': (args, io, ctx) => {
    const o = parseOpts(args, ['t', 'f', 'C', 'N', 'b']);
    const type = o.values.t ?? 'ed25519';
    const home = homeOf(ctx.sys, currentUser(ctx));
    const file = o.values.f ? abs(ctx, o.values.f) : `${home}/.ssh/id_${type}`;
    try {
      mkdir(ctx.sys.fs, `${home}/.ssh`, actor(ctx), ctx.sys.now, true);
      const d = lookup(ctx.sys.fs, `${home}/.ssh`, actor(ctx))!.node;
      d.mode = 0o700;
      const pub = `ssh-${type} AAAAC3NzaC1lZDI1NTE5AAAAIG${currentUser(ctx).padEnd(10, 'x').slice(0, 10)}Q2VzbGFiU2ltdWxhdG9yS2V5 ${o.values.C ?? `${currentUser(ctx)}@${ctx.sys.hostname}`}\n`;
      writeFile(ctx.sys.fs, file, `-----BEGIN OPENSSH PRIVATE KEY-----\n(simulated ${type} private key for ${currentUser(ctx)})\n-----END OPENSSH PRIVATE KEY-----\n`, actor(ctx), ctx.sys.now);
      lookup(ctx.sys.fs, file, actor(ctx))!.node.mode = 0o600;
      writeFile(ctx.sys.fs, file + '.pub', pub, actor(ctx), ctx.sys.now);
      io.out(`Generating public/private ${type} key pair.\nYour identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\nThe key fingerprint is:\nSHA256:k3bXq9/${currentUser(ctx)}SimulatedFingerprint ${o.values.C ?? `${currentUser(ctx)}@${ctx.sys.hostname}`}\n`);
      return 0;
    } catch (e) {
      io.err(`ssh-keygen: ${errText(e, file)}\n`);
      return 1;
    }
  },
  ssh: (args, io, ctx) => {
    const target = args.find((a) => !a.startsWith('-'));
    io.err(`ssh: connect to host ${target?.split('@').pop() ?? ''} port 22: Network is unreachable\n(Remote hosts are not simulated in this lab; configure sshd here and inspect /etc/ssh/sshd_config.)\n`);
    void ctx;
    return 255;
  },
  'ssh-copy-id': (args, io) => {
    io.err(`ssh-copy-id: remote hosts are not simulated in this lab (would copy your key to ${args[args.length - 1] ?? ''}).\n`);
    return 1;
  },
  scp: (_a, io) => {
    io.err('scp: remote hosts are not simulated in this lab.\n');
    return 1;
  },
  curl: (args, io, ctx) => {
    const url = args.find((a) => !a.startsWith('-')) ?? '';
    const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    const host = m?.[1] ?? '';
    const port = Number(m?.[2] ?? (url.startsWith('https') ? 443 : 80));
    if (host === 'localhost' || host === '127.0.0.1' || host === ctx.sys.hostname) {
      const svc = Object.entries(ctx.sys.services).find(([, s]) => s.port === port && s.active);
      if (!svc) {
        io.err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused\n`);
        return 7;
      }
      const root = { user: 'root', groups: ['root'] };
      const docroot = ['/srv/www/htdocs', '/var/www/html'].find((d) => lookup(ctx.sys.fs, d, root)) ?? '/srv/www/htdocs';
      const path = (m?.[3] ?? '/').replace(/\/$/, '/index.html');
      try {
        const body = readFile(ctx.sys.fs, docroot + path, root);
        if (args.includes('-I') || args.includes('--head')) io.out(`HTTP/1.1 200 OK\nServer: ${svc[0] === 'nginx' ? 'nginx/1.26' : 'Apache/2.4.59 (Linux/SUSE)'}\nContent-Type: text/html\nContent-Length: ${body.length}\n\n`);
        else io.out(body);
        return 0;
      } catch {
        io.out(`<!DOCTYPE HTML><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL ${path} was not found on this server.</p></body></html>\n`);
        return 0;
      }
    }
    io.err(`curl: (6) Could not resolve host: ${host}\n(The internet is not reachable from this simulated machine.)\n`);
    return 6;
  },
  wget: (args, io, ctx) => ADMIN_COMMANDS.curl(args, io, ctx),
  dig: (args, io) => {
    const name = args.find((a) => !a.startsWith('-') && !a.startsWith('@')) ?? '.';
    io.out(`; <<>> DiG 9.18 <<>> ${name}\n;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 4242\n;; connection timed out; no servers could be reached\n(DNS to the outside is not simulated in this lab.)\n`);
    return 9;
  },
  nslookup: (args, io) => {
    io.out(`;; connection timed out; no servers could be reached\n(DNS lookups for ${args[0] ?? ''} are not simulated in this lab.)\n`);
    return 1;
  },
  'firewall-cmd': (args, io, ctx) => {
    const o = parseOpts(args, ['add-service', 'remove-service', 'add-port', 'remove-port', 'zone']);
    const root = { user: 'root', groups: ['root'] };
    const file = '/etc/firewalld/zones/public.xml';
    const read = (): string[] => {
      try {
        return lines(readFile(ctx.sys.fs, file, root)).filter((l) => l.startsWith('service:') || l.startsWith('port:')).map((l) => l.split(':').slice(1).join(':'));
      } catch {
        return ['ssh', 'dhcpv6-client'];
      }
    };
    const write = (entries: string[]) => writeFile(ctx.sys.fs, file, entries.map((e) => (e.includes('/') ? 'port:' : 'service:') + e + '\n').join(''), root, ctx.sys.now);
    if (o.flags.has('state')) {
      io.out(ctx.sys.services.firewalld?.active ? 'running\n' : 'not running\n');
      return ctx.sys.services.firewalld?.active ? 0 : 252;
    }
    if (!ctx.sys.services.firewalld?.active) {
      io.err('FirewallD is not running\n');
      return 252;
    }
    if (o.flags.has('list-all') || o.flags.has('list-services') || o.flags.has('list-ports')) {
      const e = read();
      if (o.flags.has('list-all')) io.out(`public (active)\n  target: default\n  interfaces: eth0\n  services: ${e.filter((x) => !x.includes('/')).join(' ')}\n  ports: ${e.filter((x) => x.includes('/')).join(' ')}\n  masquerade: no\n  forward-ports:\n`);
      else io.out(e.filter((x) => (o.flags.has('list-services') ? !x.includes('/') : x.includes('/'))).join(' ') + '\n');
      return 0;
    }
    if (needRoot(ctx, io, 'firewall-cmd', 'Authorization failed.')) return 1;
    const entries = read();
    const add = o.values['add-service'] ?? o.values['add-port'];
    const rem = o.values['remove-service'] ?? o.values['remove-port'];
    if (add) {
      if (!entries.includes(add)) entries.push(add);
      write(entries);
      io.out('success\n');
      return 0;
    }
    if (rem) {
      write(entries.filter((e) => e !== rem));
      io.out('success\n');
      return 0;
    }
    if (o.flags.has('reload')) {
      io.out('success\n');
      return 0;
    }
    io.err('firewall-cmd: unsupported option in this simulator\n');
    return 1;
  },
  'fail2ban-client': (args, io, ctx) => {
    if (!ctx.sys.services.fail2ban?.active) {
      io.err('2026-10-22 09:30:00,000 fail2ban                [1400]: ERROR   Failed to access socket path: /var/run/fail2ban/fail2ban.sock. Is fail2ban running?\n');
      return 255;
    }
    io.out(args[0] === 'status' ? 'Status\n|- Number of jail:\t1\n`- Jail list:\tsshd\n' : 'OK\n');
    return 0;
  },
  apachectl: (args, io, ctx) => {
    if (args[0] === 'configtest' || args[0] === '-t') {
      const faults = serviceFaults(ctx.sys, 'apache2');
      if (faults.length) {
        io.err(faults.map((f) => `AH00526: ${f}`).join('\n') + '\n');
        return 1;
      }
      io.out('Syntax OK\n');
      return 0;
    }
    return ADMIN_COMMANDS.systemctl([args[0], 'apache2'], io, ctx);
  },
  'named-checkconf': (_a, io, ctx) => {
    const faults = serviceFaults(ctx.sys, 'named');
    if (faults.length) {
      io.err(faults.join('\n') + '\n');
      return 1;
    }
    return 0;
  },
  'named-checkzone': (args, io, ctx) => {
    const [zone, file] = args.filter((a) => !a.startsWith('-'));
    if (!zone || !file) {
      io.err('usage: named-checkzone zonename filename\n');
      return 1;
    }
    try {
      const content = readFile(ctx.sys.fs, abs(ctx, file), actor(ctx));
      if (!/\bSOA\b/.test(content)) {
        io.err(`zone ${zone}/IN: has no SOA record\nzone ${zone}/IN: not loaded due to errors.\n`);
        return 1;
      }
      if (!/\bNS\b/.test(content)) {
        io.err(`zone ${zone}/IN: has no NS records\nzone ${zone}/IN: not loaded due to errors.\n`);
        return 1;
      }
      io.out(`zone ${zone}/IN: loaded serial ${/(\d{8,10})/.exec(content)?.[1] ?? '1'}\nOK\n`);
      return 0;
    } catch (e) {
      io.err(`named-checkzone: ${errText(e, file)}\n`);
      return 1;
    }
  },
  shellcheck: (args, io, ctx) => {
    let code = 0;
    for (const f of args.filter((a) => !a.startsWith('-'))) {
      let src: string;
      try {
        src = readFile(ctx.sys.fs, abs(ctx, f), actor(ctx));
      } catch (e) {
        io.err(`shellcheck: ${errText(e, f)}\n`);
        return 2;
      }
      const ls = src.split('\n');
      if (!src.startsWith('#!')) {
        io.out(`\nIn ${f} line 1:\n${ls[0]}\n^-- SC2148 (error): Tips depend on target shell and yours is unknown. Add a shebang.\n`);
        code = 1;
      }
      ls.forEach((l, i) => {
        const m = /(?:^|[\s=])(?:rm|cp|mv|cat|cd|ls|echo|tar|chmod|chown)\s[^|]*?(\$[A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_"'}])/.exec(l);
        if (m && !/^\s*#/.test(l) && !/"[^"]*\$[A-Za-z_]+[^"]*"/.test(l)) {
          io.out(`\nIn ${f} line ${i + 1}:\n${l}\n${' '.repeat(Math.max(0, l.indexOf(m[1])))}^-- SC2086 (info): Double quote to prevent globbing and word splitting.\n`);
          code = 1;
        }
      });
    }
    if (code === 0) io.out('');
    return code;
  },

  man: (args, io) => {
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) {
      io.err('What manual page do you want?\nFor example, try \'man ls\'.\n');
      return 1;
    }
    const page = MAN_PAGES[name];
    if (!page) {
      io.err(`No manual entry for ${name}\n`);
      return 16;
    }
    io.out(`${name.toUpperCase()}(1)                     User Commands                     ${name.toUpperCase()}(1)\n\nNAME\n       ${page.name}\n\nSYNOPSIS\n       ${page.synopsis}\n\nDESCRIPTION\n${page.description.split('\n').map((l) => '       ' + l).join('\n')}\n${page.options ? '\nOPTIONS\n' + page.options.map((o) => `       ${o}`).join('\n') + '\n' : ''}${page.examples ? '\nEXAMPLES\n' + page.examples.map((o) => `       ${o}`).join('\n') + '\n' : ''}`);
    return 0;
  },
  info: (args, io) => ADMIN_COMMANDS.man(args, io, undefined as unknown as Ctx),
  apropos: (args, io) => {
    const q = args[0]?.toLowerCase() ?? '';
    const hits = Object.entries(MAN_PAGES).filter(([n, p]) => n.includes(q) || p.name.toLowerCase().includes(q));
    if (!hits.length) {
      io.err(`${q}: nothing appropriate.\n`);
      return 16;
    }
    for (const [n, p] of hits) io.out(`${n} (1)                - ${p.name.replace(/^[^-]*- /, '')}\n`);
    return 0;
  },
  whatis: (args, io) => ADMIN_COMMANDS.apropos(args, io, undefined as unknown as Ctx),
};

function killByName(args: string[], io: IO, ctx: Ctx, cmd: string): number {
  const o = parseOpts(args, ['u']);
  const name = o.rest[0];
  if (!name) {
    io.err(`${cmd}: no process name given\n`);
    return 2;
  }
  const before = ctx.sys.processes.length;
  const me = currentUser(ctx);
  const mine = ctx.sys.processes.filter((p) => (p.cmd.split(' ')[0].split('/').pop() ?? '') === name || (o.flags.has('f') && p.cmd.includes(name)));
  const denied = mine.filter((p) => me !== 'root' && p.user !== me);
  for (const p of denied) io.err(`${cmd}: killing pid ${p.pid} failed: Operation not permitted\n`);
  ctx.sys.processes = ctx.sys.processes.filter((p) => !mine.includes(p) || denied.includes(p) || p.cmd === '-bash' || p.pid === 1);
  if (ctx.sys.processes.length === before && !denied.length) {
    io.err(`${cmd}: no process found\n`);
    return 1;
  }
  return denied.length ? 1 : 0;
}

function pipLike(args: string[], io: IO): number {
  if (args[0] === 'install') {
    io.out(`error: externally-managed-environment\n\n× This environment is externally managed\n╰─> To install Python packages system-wide, use zypper, or create a virtual environment:\n    python3 -m venv .venv && source .venv/bin/activate\n`);
    return 1;
  }
  io.out('pip 24.0 from /usr/lib/python3.12/site-packages/pip (python 3.12)\n');
  return 0;
}

function netstatLike(args: string[], io: IO, ctx: Ctx): number {
  const listening = Object.entries(ctx.sys.services).filter(([, s]) => s.active && s.port);
  io.out('Netid  State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port  Process\n');
  for (const [n, s] of listening) io.out(`tcp    LISTEN  0       128      0.0.0.0:${String(s.port).padEnd(13)} 0.0.0.0:*          ${args.some((a) => a.includes('p')) ? `users:(("${n}",pid=${1300 + n.length},fd=3))` : ''}\n`);
  return 0;
}

function pkgManager(args: string[], io: IO, ctx: Ctx, flavour: 'zypper' | 'apt' | 'dnf'): number {
  const o = parseOpts(args);
  const [verb, ...names] = o.rest;
  const sys = ctx.sys;
  const name = flavour === 'apt' ? 'apt' : flavour;
  if (!verb || verb === 'help') {
    io.out(`Usage: ${name} [options] command\n  install <pkg>   remove <pkg>   search <text>   info <pkg>   update   upgrade   list --installed\n`);
    return 0;
  }
  const isInstall = ['install', 'in'].includes(verb);
  const isRemove = ['remove', 'rm', 'purge', 'autoremove'].includes(verb);
  if (['search', 'se'].includes(verb)) {
    const q = (names[0] ?? '').toLowerCase();
    const hits = Object.entries(sys.packages).filter(([n, p]) => n.includes(q) || p.description.toLowerCase().includes(q));
    if (!hits.length) {
      io.out('No matching items found.\n');
      return 104;
    }
    io.out('S  | Name       | Summary                                  | Type\n---+------------+------------------------------------------+--------\n');
    for (const [n, p] of hits) io.out(`${p.installed ? 'i+' : '  '} | ${n.padEnd(10)} | ${p.description.padEnd(40)} | package\n`);
    return 0;
  }
  if (['info', 'show'].includes(verb)) {
    const p = sys.packages[names[0]];
    if (!p) {
      io.out(`package '${names[0]}' not found.\n`);
      return 104;
    }
    io.out(`Information for package ${names[0]}:\n  Name        : ${names[0]}\n  Version     : ${p.version}\n  Installed   : ${p.installed ? 'Yes' : 'No'}\n  Summary     : ${p.description}\n`);
    return 0;
  }
  if (verb === 'list' || verb === 'packages') {
    for (const [n, p] of Object.entries(sys.packages)) if (p.installed || !o.flags.has('installed')) io.out(`${p.installed ? 'i' : ' '} | ${n.padEnd(12)} | ${p.version.padEnd(8)} | ${p.description}\n`);
    return 0;
  }
  if (['update', 'refresh', 'ref', 'upgrade', 'up', 'dist-upgrade', 'patch', 'dup', 'check-update'].includes(verb)) {
    if (currentUser(ctx) !== 'root') {
      io.err(flavour === 'apt' ? 'E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\n' : 'Root privileges are required for refreshing services.\n');
      return 1;
    }
    io.out(flavour === 'apt' ? (verb === 'update' ? 'Hit:1 http://download.opensuse.org/update  InRelease\nReading package lists... Done\nAll packages are up to date.\n' : 'Reading package lists... Done\nBuilding dependency tree... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n') : verb === 'refresh' || verb === 'ref' ? 'Repository \'Main Repository\' is up to date.\nRepository \'Main Update Repository\' is up to date.\nAll repositories have been refreshed.\n' : 'Loading repository data...\nReading installed packages...\nNothing to do.\n');
    return 0;
  }
  if (!isInstall && !isRemove) {
    io.err(`${name}: unknown command '${verb}'\n`);
    return 1;
  }
  if (currentUser(ctx) !== 'root') {
    io.err(flavour === 'apt' ? 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n' : `Root privileges are required for ${isInstall ? 'installing or uninstalling' : 'uninstalling'} packages.\n`);
    return 1;
  }
  const targets = names.filter((n) => !n.startsWith('-'));
  if (!targets.length) {
    io.err(`${name}: ${verb} needs at least one package name\n`);
    return 1;
  }
  for (const t of targets) {
    const p = sys.packages[t];
    if (!p) {
      io.err(flavour === 'apt' ? `E: Unable to locate package ${t}\n` : `Package '${t}' not found.\n`);
      return 104;
    }
    if (isInstall) {
      if (p.installed) {
        io.out(flavour === 'apt' ? `${t} is already the newest version (${p.version}).\n` : `'${t}' is already installed.\nNo update candidate for '${t}-${p.version}'. The highest available version is already installed.\n`);
        continue;
      }
      p.installed = true;
      if (p.service && !sys.services[p.service]) sys.services[p.service] = { description: p.description, active: false, enabled: false, logs: [], package: t, port: p.service === 'apache2' || p.service === 'nginx' ? 80 : p.service === 'named' ? 53 : p.service === 'mariadb' ? 3306 : undefined };
      if (p.service && sys.services[p.service]) sys.services[p.service].package = t;
      installFiles(ctx, t);
      io.out(flavour === 'apt' ? `Reading package lists... Done\nBuilding dependency tree... Done\nThe following NEW packages will be installed:\n  ${t}\n0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\nSetting up ${t} (${p.version}) ...\n` : `Loading repository data...\nReading installed packages...\nResolving package dependencies...\n\nThe following NEW package is going to be installed:\n  ${t}\n\n1 new package to install.\nOverall download size: 1.2 MiB. Already cached: 0 B. After the operation, additional 3.4 MiB will be used.\nContinue? [y/n/v/...? shows all options] (y): y\nRetrieving: ${t}-${p.version}-1.x86_64.rpm .......[done]\nChecking for file conflicts: .......[done]\n(1/1) Installing: ${t}-${p.version}-1.x86_64 .......[done]\n`);
    } else {
      if (!p.installed) {
        io.out(flavour === 'apt' ? `Package '${t}' is not installed, so not removed\n` : `'${t}' is not installed.\n`);
        continue;
      }
      p.installed = false;
      if (p.service && sys.services[p.service]) {
        sys.services[p.service].active = false;
        sys.processes = sys.processes.filter((pr) => !pr.cmd.includes(`/usr/sbin/${p.service}`));
      }
      io.out(flavour === 'apt' ? `Removing ${t} (${p.version}) ...\n` : `(1/1) Removing ${t}-${p.version}-1.x86_64 .......[done]\n`);
    }
  }
  return 0;
}

function installFiles(ctx: Ctx, pkg: string): void {
  const root = { user: 'root', groups: ['root'] };
  const sys = ctx.sys;
  const put = (path: string, content: string) => {
    if (lookup(sys.fs, path, root)) return;
    mkdir(sys.fs, path.slice(0, path.lastIndexOf('/')), root, sys.now, true);
    writeFile(sys.fs, path, content, root, sys.now);
  };
  if (pkg === 'apache2') {
    put('/etc/apache2/httpd.conf', '# Main Apache configuration (openSUSE layout)\nListen 80\nInclude /etc/apache2/listen.conf\nIncludeOptional /etc/apache2/vhosts.d/*.conf\nDocumentRoot "/srv/www/htdocs"\nErrorLog /var/log/apache2/error_log\n');
    put('/etc/apache2/listen.conf', 'Listen 80\n');
    put('/etc/apache2/vhosts.d/vhost.template', '<VirtualHost *:80>\n    ServerName www.example.com\n    DocumentRoot /srv/www/vhosts/example\n    <Directory "/srv/www/vhosts/example">\n        Require all granted\n    </Directory>\n</VirtualHost>\n');
    put('/srv/www/htdocs/index.html', '<html><body><h1>It works!</h1></body></html>\n');
    put('/var/log/apache2/error_log', '');
    put('/var/log/apache2/access_log', '');
    if (!sys.users.wwwrun) {
      sys.groups.www = sys.groups.www ?? { gid: 8, members: [] };
      sys.users.wwwrun = { uid: 30, gid: 8, home: '/var/lib/wwwrun', shell: '/sbin/nologin', groups: ['www'], comment: 'WWW daemon apache', password: 'locked' };
    }
  } else if (pkg === 'nginx') {
    put('/etc/nginx/nginx.conf', 'user nginx;\nworker_processes auto;\nhttp {\n    include /etc/nginx/vhosts.d/*.conf;\n    server {\n        listen 80;\n        root /srv/www/htdocs;\n    }\n}\n');
    put('/srv/www/htdocs/index.html', '<html><body><h1>Welcome to nginx!</h1></body></html>\n');
  } else if (pkg === 'bind') {
    put('/etc/named.conf', 'options {\n    directory "/var/lib/named";\n    listen-on port 53 { any; };\n    allow-query { any; };\n    recursion yes;\n};\n\nzone "." in {\n    type hint;\n    file "root.hint";\n};\n');
    put('/var/lib/named/root.hint', '; root hints\n');
  } else if (pkg === 'fail2ban') {
    put('/etc/fail2ban/jail.conf', '[DEFAULT]\nbantime = 10m\nfindtime = 10m\nmaxretry = 5\n\n[sshd]\nenabled = false\n');
  } else if (pkg === 'mariadb') {
    put('/etc/my.cnf', '[mysqld]\ndatadir=/var/lib/mysql\nbind-address=127.0.0.1\n');
  }
}

function openEditor(args: string[], io: IO, ctx: Ctx, editor: string): number {
  const file = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (!file) {
    io.out(`(${editor} needs a file name in this simulator: ${editor} FILE)\n`);
    return 0;
  }
  const path = abs(ctx, file);
  const l = lookup(ctx.sys.fs, path, actor(ctx));
  if (l?.node.type === 'dir') {
    io.err(`${editor}: ${file}: Is a directory\n`);
    return 1;
  }
  let content = '';
  if (l?.node.type === 'file') {
    try {
      content = readFile(ctx.sys.fs, path, actor(ctx));
    } catch {
      io.err(`${editor}: ${file}: Permission denied\n`);
      return 1;
    }
  } else {
    const parent = lookup(ctx.sys.fs, path.slice(0, path.lastIndexOf('/')) || '/', actor(ctx));
    if (!parent) {
      io.err(`${editor}: ${file}: No such file or directory\n`);
      return 1;
    }
  }
  ctx.requests.push({ kind: 'editor', path, content });
  return 0;
}

function validateCrontab(src: string): { line: number; what: string } | null {
  const ls = src.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i].trim();
    if (!l || l.startsWith('#') || /^[A-Z_]+=/.test(l)) continue;
    if (/^@(reboot|hourly|daily|weekly|monthly|yearly|annually)\s+\S/.test(l)) continue;
    const parts = l.split(/\s+/);
    if (parts.length < 6) return { line: i + 1, what: 'command' };
    const ok = (f: string, max: number) => f.split(',').every((p) => /^(\*|\d+(-\d+)?)(\/\d+)?$/.test(p) && (p.startsWith('*') || Number(p.split(/[-/]/)[0]) <= max));
    if (!ok(parts[0], 59)) return { line: i + 1, what: 'minute' };
    if (!ok(parts[1], 23)) return { line: i + 1, what: 'hour' };
    if (!ok(parts[2], 31)) return { line: i + 1, what: 'day-of-month' };
    if (!ok(parts[3], 12)) return { line: i + 1, what: 'month' };
    if (!ok(parts[4], 7)) return { line: i + 1, what: 'day-of-week' };
  }
  return null;
}

/** Writes a crontab from the editor (used by the UI after `crontab -e`). */
export function installCrontab(sys: ShellSystem, user: string, src: string): string | null {
  const bad = validateCrontab(src);
  if (bad) return `"/tmp/crontab.${user}":${bad.line}: bad ${bad.what}\nerrors in crontab file, can't install.`;
  sys.crontabs[user] = src;
  return null;
}
