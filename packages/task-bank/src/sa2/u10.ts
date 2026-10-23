/** Unit 10: security, troubleshooting and performance tuning, and the capstone server. */

import type { TaskTemplate } from '../types';
import { DEPTS, caseStudy, cron, file, lab, linux, out, proc, ran, script, svc, tmpl, user } from './kit';

const ATTACKERS = ['185.220.101.7', '45.155.205.33', '103.145.13.9', '194.26.29.120'];

/** sshd failure lines as they appear in /var/log/secure. */
function failedLogins(ip: string, n: number, who: string, start = 1): string {
  return Array.from({ length: n }, (_, i) => `Oct 22 03:${String(start + i).padStart(2, '0')}:1${i % 10} srv1 sshd[${900 + start}]: Failed password for ${who} from ${ip} port ${40000 + start * 7} ssh2\n`).join('');
}

/** Apache installed and running with one site. */
function apacheSite(site: string, extra: Record<string, unknown> = {}) {
  return {
    packages: { apache2: { installed: true } },
    services: { apache2: { active: true, enabled: true, package: 'apache2', port: 80 } },
    users: { wwwrun: { uid: 30, shell: '/sbin/nologin', groups: ['www'], home: '/var/lib/wwwrun' } },
    files: {
      '/etc/apache2/listen.conf': 'Listen 80\n',
      '/var/log/apache2/error_log': '',
      [`/etc/apache2/vhosts.d/${site}.conf`]: `<VirtualHost *:80>\n    ServerName ${site}.campus.lan\n    DocumentRoot /srv/www/${site}\n    <Directory "/srv/www/${site}">\n        Require all granted\n    </Directory>\n</VirtualHost>\n`,
      [`/srv/www/${site}/index.html`]: `${site} home page\n`,
      '/etc/hosts': `127.0.0.1\tlocalhost ${site}.campus.lan\n`,
      ...extra,
    } as unknown as Record<string, never>,
  };
}

const SECS: Record<string, string> = { '30m': '1800', '1h': '3600', '2h': '7200', '1d': '86400' };

export const U10: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 10.1 hardening */
  tmpl(10, 1, 'beginner', 'fail2ban-ssh', 'Stop password guessing on SSH with fail2ban', 'E4', 20, 'Configure an sshd jail, keep the admin network exempt and confirm the attacker is banned.', (v) => {
    const net = v.net();
    const attacker = v.pick(ATTACKERS);
    const admin = `${net}.${v.int(40, 90)}`;
    const maxretry = v.pick([3, 4, 5]);
    const bantime = v.pick(['30m', '1h', '2h', '1d']);
    const p = v.person();
    return {
      instructions: lab({ situation: `/var/log/secure shows a password-guessing attack on SSH from **${attacker}**. fail2ban is installed but not configured. Create **/etc/fail2ban/jail.local** (never edit jail.conf, which updates overwrite) that:\n\n- enables the **sshd** jail with **maxretry = ${maxretry}** and **bantime = ${bantime}**;\n- never bans the local network **${net}.0/24** (ignoreip, plus 127.0.0.1/8): ${p.name} at ${admin} mistyped a password a few times this morning.\n\nStart fail2ban at boot and check which addresses it banned.`, steps: ['grep "Failed password" /var/log/secure to see the attack.', 'Write jail.local with a [DEFAULT] section (ignoreip) and an [sshd] section.', 'fail2ban-client -t to test, then systemctl enable --now fail2ban.', 'fail2ban-client status sshd.'], tips: [`[DEFAULT]\nignoreip = 127.0.0.1/8 ${net}.0/24\n\n[sshd]\nenabled = true\nmaxretry = ${maxretry}\nbantime = ${bantime}`, 'fail2ban-client status sshd', 'fail2ban-client get sshd bantime'] }),
      hints: ['jail.local overrides jail.conf section by section.', 'Without ignoreip, a colleague who mistypes their password locks themselves out.'],
      initialState: linux(net, { packages: { fail2ban: { installed: true } }, services: { fail2ban: { package: 'fail2ban', active: false, enabled: false } }, files: { '/etc/fail2ban/jail.conf': '# Default jails shipped with fail2ban. Do not edit: copy settings to jail.local.\n[DEFAULT]\nbantime = 10m\nfindtime = 10m\nmaxretry = 5\n', '/var/log/secure': failedLogins(attacker, maxretry + v.int(3, 9), 'root') + failedLogins(admin, maxretry, p.sam, 40) } }),
      checks: [svc('fail2ban runs and starts at boot', 'fail2ban', { active: true, enabled: true }), out('The attacker is banned', 'fail2ban-client status sshd', { contains: attacker }), out(`${p.name}'s workstation is not banned`, 'fail2ban-client status sshd', { notContains: admin }), out(`maxretry is ${maxretry}`, 'fail2ban-client get sshd maxretry', { equals: String(maxretry) }), out(`bantime is ${bantime}`, 'fail2ban-client get sshd bantime', { equals: SECS[bantime] }), file('jail.conf is untouched', '/etc/fail2ban/jail.conf', { contains: 'maxretry = 5' })],
      solution: ['grep "Failed password" /var/log/secure', `printf '[DEFAULT]\\nignoreip = 127.0.0.1/8 ${net}.0/24\\n\\n[sshd]\\nenabled = true\\nmaxretry = ${maxretry}\\nbantime = ${bantime}\\n' > /etc/fail2ban/jail.local`, 'fail2ban-client -t', 'systemctl enable --now fail2ban', 'fail2ban-client status sshd'],
      realityNote: 'Any server with SSH open to the internet sees guessing attempts within minutes; fail2ban plus key-only logins makes them harmless.',
    };
  }),
  tmpl(10, 1, 'intermediate', 'hardening-baseline', 'Apply a hardening baseline to a web server', 'E4', 25, 'Remove services nobody needs, close their ports and tighten SSH without breaking the website.', (v) => {
    const net = v.net();
    const extras = v.some([
      { svc: 'vsftpd', fw: 'ftp', port: 21, what: 'an old FTP server' },
      { svc: 'xinetd', fw: 'telnet', port: 23, what: 'telnet through xinetd' },
      { svc: 'rpcbind', fw: 'rpc-bind', port: 111, what: 'rpcbind, left from an NFS test' },
      { svc: 'cups', fw: 'ipp', port: 631, what: 'the CUPS print service' },
    ], 2);
    const tries = v.pick([3, 4]);
    const site = v.pick(DEPTS);
    const base = apacheSite(site);
    return {
      instructions: lab({ situation: `This server's only job is the **${site}** website (Apache) and remote administration over SSH. An audit found: ${extras.map((x) => `**${x.svc}** (${x.what}) running and open in the firewall`).join(', ')}, and SSH allows **root logins**. Apply the baseline:\n\n1. Stop and disable ${extras.map((x) => x.svc).join(' and ')}, and remove their firewall services (${extras.map((x) => x.fw).join(', ')}) permanently.\n2. In sshd_config set **PermitRootLogin no** and **MaxAuthTries ${tries}**, test the file, then restart sshd.\n3. The website and SSH must keep working.`, steps: ['ss -tlnp and firewall-cmd --list-all show what is exposed.', 'systemctl disable --now SERVICE.', 'firewall-cmd --permanent --remove-service=NAME; firewall-cmd --reload.', 'Edit sshd_config, sshd -t, systemctl restart sshd.'], tips: ['ss -tlnp', 'firewall-cmd --list-all', `nmap ${net}.5`, 'sshd -T | grep -i -e permitroot -e maxauth'] }),
      hints: ['Every service you do not run is one you never have to patch.', 'sshd uses the first value it finds for a setting, so change the existing line instead of adding a second one.'],
      initialState: linux(net, { ...base, services: { ...base.services, ...Object.fromEntries(extras.map((x) => [x.svc, { description: x.what, active: true, enabled: true, port: x.port }])) }, files: { ...base.files, '/etc/ssh/sshd_config': { content: 'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\nX11Forwarding yes\n', mode: '600' } as never, '/etc/firewalld/zones/public.xml': `service:ssh\nservice:http\n${extras.map((x) => `service:${x.fw}`).join('\n')}\n` as never } }),
      checks: [...extras.map((x) => svc(`${x.svc} is stopped and disabled`, x.svc, { active: false, enabled: false })), out('Their firewall openings are closed', 'firewall-cmd --permanent --list-services', { notContains: extras.map((x) => x.fw), contains: ['ssh', 'http'] }), out('Only SSH and HTTP are reachable', `nmap ${net}.5`, { notContains: extras.map((x) => `${x.port}/`) }), out('Root cannot log in over SSH', 'sshd -T', { contains: ['permitrootlogin no', `maxauthtries ${tries}`] }), svc('sshd is still running', 'sshd', { active: true }), out('The website still works', `curl -s http://${site}.campus.lan/`, { contains: `${site} home page` })],
      solution: ['ss -tlnp', ...extras.map((x) => `systemctl disable --now ${x.svc}`), ...extras.map((x) => `firewall-cmd --permanent --remove-service=${x.fw}`), 'firewall-cmd --reload', "sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config", `echo 'MaxAuthTries ${tries}' >> /etc/ssh/sshd_config`, 'sshd -t', 'systemctl restart sshd', `nmap ${net}.5`],
      realityNote: 'Benchmarks such as the CIS Benchmarks list hundreds of settings; disabling unused services and root SSH logins are always near the top.',
    };
  }),
  tmpl(10, 1, 'advanced', 'sysctl-hardening', 'Harden the kernel network settings persistently', 'E4', 25, 'Write a sysctl.d file that wins over an old one and survives a reboot.', (v) => {
    const net = v.net();
    const pool = [
      { k: 'net.ipv4.conf.all.accept_redirects', v: '0', why: 'ignore ICMP redirects that could reroute traffic' },
      { k: 'net.ipv4.conf.all.send_redirects', v: '0', why: 'do not send redirects (this is not a router)' },
      { k: 'net.ipv4.conf.all.rp_filter', v: '1', why: 'drop packets with spoofed source addresses' },
      { k: 'net.ipv4.conf.all.log_martians', v: '1', why: 'log packets with impossible addresses' },
    ];
    const pick = v.some(pool, 3);
    const old = v.pick(['50-router-test.conf', '60-lab-forwarding.conf']);
    return {
      instructions: lab({ situation: `A security review asks for these kernel settings on this server:\n\n${pick.map((x) => `- **${x.k} = ${x.v}**: ${x.why}`).join('\n')}\n- **net.ipv4.ip_forward = 0**: this server must not route traffic\n\nPut them in **/etc/sysctl.d/99-hardening.conf** and apply them now. Someone once tested routing here and left a file in /etc/sysctl.d: make sure your settings still win **after a reboot**.`, steps: ['sysctl -a | grep for the current values.', 'ls /etc/sysctl.d and read what is there.', 'Write 99-hardening.conf.', 'sysctl --system applies all files in order: later files win.'], tips: ['sysctl net.ipv4.ip_forward', 'ls /etc/sysctl.d', 'sysctl --system'] }),
      hints: ['Files in /etc/sysctl.d are applied in name order, so 99-* is applied after 50-*.', 'sysctl -w changes only the running kernel; it is lost at reboot.'],
      initialState: linux(net, { files: { [`/etc/sysctl.d/${old}`]: '# Temporary routing test, March\nnet.ipv4.ip_forward = 1\n', '/run/lab/sysctl.json': '{"net.ipv4.ip_forward":"1"}' } }),
      checks: [...pick.map((x) => out(`${x.k} is ${x.v} now`, `sysctl -n ${x.k}`, { equals: x.v })), out('Forwarding is off now', 'sysctl -n net.ipv4.ip_forward', { equals: '0' }), ...pick.map((x) => file(`${x.k} is in the file`, '/etc/sysctl.d/99-hardening.conf', { pattern: `^${x.k.replace(/\./g, '\\.')}\\s*=\\s*${x.v}\\s*$` })), out('The settings survive a reboot', 'sysctl --system > /dev/null; sysctl -n net.ipv4.ip_forward', { equals: '0' }), out('The redirect setting survives a reboot', `sysctl --system > /dev/null; sysctl -n ${pick[0].k}`, { equals: pick[0].v })],
      solution: ['ls /etc/sysctl.d', `printf '${pick.map((x) => `${x.k} = ${x.v}`).join('\\n')}\\nnet.ipv4.ip_forward = 0\\n' > /etc/sysctl.d/99-hardening.conf`, 'sysctl --system', 'sysctl net.ipv4.ip_forward'],
      realityNote: 'Configuration management tools (Ansible, Salt) usually own /etc/sysctl.d so these baselines are identical on every server.',
    };
  }),

  /* ---------------------------------------------------------------- 10.2 troubleshooting method */
  tmpl(10, 2, 'beginner', 'journal-detective', 'Find why a service will not start, using the journal', 'E4', 20, 'Read journalctl for a failing service, fix the cause and record it.', (v) => {
    const net = v.net();
    const name = v.pick(['report-worker', 'print-relay', 'campus-api', 'exam-sync']);
    const kind = v.pick(['config', 'spool'] as const);
    const conf = `/etc/${name}/${name}.conf`;
    const bad = v.pick(['80O0', '8o80', '90O1']);
    const port = bad.replace(/[oO]/g, '0');
    const spool = `/var/lib/${name}/spool`;
    const message = kind === 'config' ? `${name}: config error in ${conf} line 2: port must be a number, got "${bad}"` : `${name}: cannot open spool directory ${spool}: No such file or directory`;
    return {
      instructions: lab({ situation: `Users report that **${name}** is down. It fails every time it is started. Use **systemctl status** and **journalctl -u ${name}** to find the cause, fix it (the intended port is ${port}; directories it needs belong to root), then start the service and make sure it starts at boot. Write the cause in one line in **/root/incident.txt**.`, steps: [`systemctl status ${name}.`, `journalctl -u ${name}: read the last error before "Failed to start".`, 'Fix the cause.', `systemctl enable --now ${name}, then check its status again.`], tips: [`journalctl -u ${name}`, `journalctl -u ${name} -n 20`, `cat ${conf}`] }),
      hints: ['The line before "Main process exited" usually names the problem.', 'Fix the cause rather than restarting repeatedly.'],
      initialState: linux(net, { services: { [name]: { description: `${name} service`, active: false, enabled: true, logs: [`Started ${name} service.`, message, `${name}.service: Main process exited, code=exited, status=1/FAILURE`, `${name}.service: Failed with result 'exit-code'.`], faults: [kind === 'config' ? { file: conf, pattern: '^port\\s*=\\s*\\d*[^\\d\\s]', message } : { missing: spool, message }] } }, files: { [conf]: `# ${name} settings\nport = ${kind === 'config' ? bad : port}\nlog_level = info\n` } }),
      checks: [svc(`${name} runs and starts at boot`, name, { active: true, enabled: true }), kind === 'config' ? file('The port is a number again', conf, { pattern: `^port\\s*=\\s*${port}\\s*$` }) : file('The spool directory exists', spool, { kind: 'dir' }), ran('You read the journal', `^journalctl.*${name}|^systemctl status`), file('The cause is recorded', '/root/incident.txt', { pattern: kind === 'config' ? '[Pp]ort' : '[Ss]pool' })],
      solution: [`systemctl status ${name}`, `journalctl -u ${name}`, ...(kind === 'config' ? [`sed -i 's/^port = ${bad}/port = ${port}/' ${conf}`, `echo 'Typo in ${conf}: port was "${bad}" (letter O), fixed to ${port}' > /root/incident.txt`] : [`mkdir -p ${spool}`, `echo 'Spool directory ${spool} was missing; recreated' > /root/incident.txt`]), `systemctl enable --now ${name}`, `systemctl status ${name}`],
      realityNote: 'systemctl status and journalctl -u answer most "service won\'t start" tickets in under a minute.',
    };
  }),
  tmpl(10, 2, 'intermediate', 'forbidden-403', 'Troubleshoot a 403 Forbidden with the error log', 'E4', 20, 'Use curl and the Apache error log to find which of several causes blocks a site.', (v) => {
    const net = v.net();
    const site = v.pick(DEPTS);
    const cause = v.pick(['denied', 'dir', 'file'] as const);
    const base = apacheSite(site);
    const files: Record<string, unknown> = { ...base.files };
    if (cause === 'denied') files[`/etc/apache2/vhosts.d/${site}.conf`] = `<VirtualHost *:80>\n    ServerName ${site}.campus.lan\n    DocumentRoot /srv/www/${site}\n    <Directory "/srv/www/${site}">\n        Require all denied\n    </Directory>\n</VirtualHost>\n`;
    if (cause === 'dir') files[`/srv/www/${site}/`] = { mode: '700' };
    if (cause === 'file') files[`/srv/www/${site}/index.html`] = { content: `${site} home page\n`, mode: '600' };
    const code = cause === 'denied' ? 'AH01630' : 'AH00132';
    return {
      instructions: lab({ situation: `After a weekend change, **http://${site}.campus.lan/** returns **403 Forbidden**. Find the cause with **curl** and the Apache error log (**/var/log/apache2/error_log**), fix it without opening permissions wider than needed (no 777 or 666), and write the AH error code you found into **/root/cause.txt**.`, steps: ['curl -I the site to reproduce.', 'tail /var/log/apache2/error_log.', 'AH01630 = the configuration denies access; AH00132 = file permissions deny the server (user wwwrun).', 'Fix, reload if you changed configuration, curl again.'], tips: [`curl -I http://${site}.campus.lan/`, 'tail -5 /var/log/apache2/error_log', `ls -ld /srv/www/${site} /srv/www/${site}/index.html`] }),
      hints: ['Reproduce first, then read the log the request produced.', 'Directories need x (755) and files need r (644) for the web server user.'],
      initialState: linux(net, { ...base, files: files as Record<string, never> }),
      checks: [out('The site loads', `curl -s http://${site}.campus.lan/`, { contains: `${site} home page` }), file('The error code is recorded', '/root/cause.txt', { contains: code }), ran('You read the error log', 'error_log'), cause === 'denied' ? file('Access is granted in the configuration', `/etc/apache2/vhosts.d/${site}.conf`, { notContains: 'Require all denied' }) : file('Permissions are not world-writable', cause === 'dir' ? `/srv/www/${site}` : `/srv/www/${site}/index.html`, { mode: cause === 'dir' ? '755' : '644' })],
      solution: [`curl -I http://${site}.campus.lan/`, 'tail -5 /var/log/apache2/error_log', ...(cause === 'denied' ? [`sed -i 's/Require all denied/Require all granted/' /etc/apache2/vhosts.d/${site}.conf`, 'apachectl configtest', 'systemctl reload apache2'] : cause === 'dir' ? [`chmod 755 /srv/www/${site}`] : [`chmod 644 /srv/www/${site}/index.html`]), `echo '${code}' > /root/cause.txt`, `curl -I http://${site}.campus.lan/`],
      realityNote: 'The error log, not the browser, says why a request failed; the AH codes are documented and searchable.',
    };
  }),
  tmpl(10, 2, 'advanced', 'troubleshooting-method', 'Work through four incidents methodically', 'E10', 20, 'Use dmesg, journalctl, df -i and strace evidence to reach root causes.', (v) => {
    const app = v.pick(['moodle', 'the student portal', 'the payroll app']);
    return caseStudy(v, {
      intro: `## Four incidents, one method\n\nObserve, form a hypothesis, test it, fix the cause, and record what happened. Each step shows the evidence you gathered for ${app}'s servers.`,
      steps: [
        { title: 'The Java process keeps vanishing', text: 'The application process disappears every few hours with nothing in its own log.', evidence: [{ title: 'dmesg | tail', kind: 'log', text: '[86412.1] Out of memory: Killed process 2211 (java) total-vm:6123456kB, anon-rss:3801224kB\n[86412.1] oom_reaper: reaped process 2211 (java)' }], choices: [{ text: 'The kernel OOM killer: the server ran out of memory. Limit the Java heap, add memory or find the leak', right: true, feedback: 'Correct. The kernel log explains deaths the application cannot log itself.' }, { text: 'Someone is running kill', feedback: 'The kernel log says it was the OOM killer.' }, { text: 'Reinstall Java', feedback: 'Nothing points at a broken installation.' }] },
        { title: '"No space left on device", but df shows 40% used', text: 'Uploads fail with "No space left on device".', evidence: [{ title: 'df -h /var and df -i /var', kind: 'log', text: 'Filesystem  Size Used Avail Use% Mounted on\n/dev/sda3    50G  20G   30G  40% /var\n\nFilesystem  Inodes  IUsed IFree IUse% Mounted on\n/dev/sda3  3276800 3276800    0  100% /var' }], choices: [{ text: 'The filesystem has run out of inodes (millions of tiny files, often old sessions or cache): clean them up and add a cleanup job', right: true, feedback: 'Correct. df -i is the check people forget.' }, { text: 'df is wrong; reboot', feedback: 'df -i shows the real limit.' }, { text: 'Grow the disk', feedback: 'More gigabytes do not add inodes on ext4 without reformatting; remove the files.' }] },
        { title: 'Service exits immediately with no useful message', text: 'The service logs only "exited, status=1".', evidence: [{ title: 'strace -f -e trace=openat /usr/local/bin/app (excerpt)', kind: 'log', text: 'openat(AT_FDCWD, "/etc/app/app.yaml", O_RDONLY) = 0\nopenat(AT_FDCWD, "/etc/app/certs/db-ca.pem", O_RDONLY) = -1 ENOENT (No such file or directory)\nexit_group(1) = ?' }], choices: [{ text: 'It cannot find /etc/app/certs/db-ca.pem: restore the certificate the configuration points to', right: true, feedback: 'Correct. strace shows what a silent program actually tried to do.' }, { text: 'app.yaml is missing', feedback: 'It opened app.yaml successfully (= 0).' }, { text: 'Increase the log level and wait', feedback: 'strace already gives the answer.' }] },
        { title: 'Order of work', text: 'Ten minutes into an outage, which order is right?', choices: [{ text: 'Restore service (with the smallest safe change), confirm, then find the root cause and write it up', right: true, feedback: 'Correct. Users first, then a post-incident review so it does not happen again.' }, { text: 'Find the perfect root cause before touching anything', feedback: 'Users wait while you investigate; capture evidence, then restore.' }, { text: 'Change several things at once to be quick', feedback: 'Then you will not know which change fixed it, or which broke something else.' }] },
      ],
      ending: { title: 'Incidents closed', text: 'The OOM killer, inode exhaustion, a missing file found with strace, and the restore-then-root-cause order of work.' },
      hints: ['Logs from the kernel (dmesg) and the system (journalctl) see what the application cannot.'],
      realityNote: 'Change one thing at a time and write down what you changed: it is the most valuable troubleshooting habit.',
    });
  }),

  /* ---------------------------------------------------------------- 10.3 performance */
  tmpl(10, 3, 'beginner', 'cpu-hog', 'Find and stop a process hogging the CPU', 'E4', 15, 'Use top to identify a runaway process, record it and stop it.', (v) => {
    const net = v.net();
    const p = v.person();
    const prog = v.pick(['scrape.py', 'sim_loop.py', 'convert_all.sh', 'stress-test']);
    const pid = v.int(3000, 9800);
    const cpu = v.int(92, 99) + 0.4;
    return {
      instructions: lab({ situation: `The server is slow and the load is high. Use **top** (or ps) to find the process using the most CPU. Record it in **/root/hog.txt** as two lines, \`pid=PID\` and \`user=USER\`, then stop **only that process** (the user's other work must keep running). Then tell the user (not part of the task).`, steps: ['top -b -n 1 (sorted by %CPU).', 'Note the PID and USER of the top line.', 'kill PID (SIGTERM; use -9 only if it ignores that).', 'Check it is gone.'], tips: ['top -b -n 1', 'ps aux --sort=-%cpu | head', 'kill PID'] }),
      hints: ['killall or pkill -u would also kill the user\'s editor session.'],
      initialState: linux(net, { users: { [p.sam]: { groups: ['users'] } }, processes: [{ pid: pid - 37, user: p.sam, cmd: 'vim thesis/chapter3.tex', cpu: 0.3, mem: 0.4 }, { pid, user: p.sam, cmd: prog.endsWith('.py') ? `/usr/bin/python3 /home/${p.sam}/${prog}` : `/home/${p.sam}/${prog}`, cpu, mem: 3.2 }, { pid: 2210, user: 'root', cmd: '/usr/sbin/rsyslogd -n', cpu: 0.1, mem: 0.3 }] }),
      checks: [proc(`${prog} is stopped`, prog, false), proc(`${p.sam}'s editor is still running`, 'vim', true), file('The PID is recorded', '/root/hog.txt', { pattern: `^pid=${pid}$` }), file('The user is recorded', '/root/hog.txt', { pattern: `^user=${p.sam}$` }), ran('You looked with top or ps', '^(top|htop|ps)\\b')],
      solution: ['top -b -n 1', `printf 'pid=${pid}\\nuser=${p.sam}\\n' > /root/hog.txt`, `kill ${pid}`, 'ps aux'],
      realityNote: 'On shared servers, cgroup limits (systemd slices) stop one user\'s job from starving everyone.',
    };
  }),
  tmpl(10, 3, 'intermediate', 'persistent-tuning', 'Tune kernel settings for a database server', 'E4', 20, 'Set swappiness and connection backlog persistently and find the setting that undoes them.', (v) => {
    const net = v.net();
    const swap = v.pick([1, 5, 10]);
    const backlog = v.pick([8192, 16384]);
    const dirty = v.pick([10, 15]);
    return {
      instructions: lab({ situation: `This server will run PostgreSQL. The DBA asks for: **vm.swappiness = ${swap}** (keep the database in memory), **net.core.somaxconn = ${backlog}** (longer queue for incoming connections) and **vm.dirty_ratio = ${dirty}** (flush writes sooner). Put them in **/etc/sysctl.d/90-database.conf**, apply them now, and make sure they survive a reboot: an old setting elsewhere has undone this kind of change before.`, steps: ['sysctl vm.swappiness to see the current value.', 'Write the file and run sysctl --system.', 'Read the output: which file is applied last?', 'Remove the conflicting old line, then sysctl --system again.'], tips: ['sysctl --system', 'grep -r swappiness /etc/sysctl.conf /etc/sysctl.d/'] }),
      hints: ['/etc/sysctl.conf is applied after everything in /etc/sysctl.d.'],
      initialState: linux(net, { files: { '/etc/sysctl.conf': '# Local settings\nvm.swappiness = 80\nkernel.panic = 10\n' } }),
      checks: [out(`vm.swappiness is ${swap}`, 'sysctl -n vm.swappiness', { equals: String(swap) }), out(`net.core.somaxconn is ${backlog}`, 'sysctl -n net.core.somaxconn', { equals: String(backlog) }), out(`vm.dirty_ratio is ${dirty}`, 'sysctl -n vm.dirty_ratio', { equals: String(dirty) }), file('The settings are in their own file', '/etc/sysctl.d/90-database.conf', { pattern: `^vm\\.swappiness\\s*=\\s*${swap}\\s*$` }), out('Swappiness survives a reboot', 'sysctl --system > /dev/null; sysctl -n vm.swappiness', { equals: String(swap) })],
      solution: [`printf 'vm.swappiness = ${swap}\\nnet.core.somaxconn = ${backlog}\\nvm.dirty_ratio = ${dirty}\\n' > /etc/sysctl.d/90-database.conf`, 'sysctl --system', "sed -i '/^vm.swappiness/d' /etc/sysctl.conf", 'sysctl --system', 'sysctl vm.swappiness'],
      realityNote: 'Tuning without measuring first is guesswork: change one setting, measure with the real workload, and keep notes.',
    };
  }),
  tmpl(10, 3, 'advanced', 'bottleneck-evidence', 'Read vmstat, iostat and sar to find the bottleneck', 'E10', 20, 'Tell CPU, memory, disk and network bottlenecks apart from tool output.', (v) => {
    const cpus = v.pick([2, 4]);
    return caseStudy(v, {
      intro: `## Four slow servers\n\nEach has ${cpus} CPUs. Decide which resource is the bottleneck from the evidence.`,
      steps: [
        { title: 'Server A', text: 'Web pages are slow.', evidence: [{ title: 'vmstat 5 3', kind: 'log', text: ` r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n${cpus * 4}  0      0 1801000  91200 920000    0    0     2    10 2210 4100 93  6  1  0  0\n${cpus * 4 + 1}  0      0 1800400  91200 920100    0    0     0     8 2300 4022 94  5  1  0  0` }], choices: [{ text: 'CPU: the run queue (r) is far above the CPU count and idle is ~0', right: true, feedback: 'Correct. Find the busy processes (top) or add CPUs.' }, { text: 'Memory', feedback: 'No swapping (si/so = 0) and plenty free.' }, { text: 'Disk', feedback: 'wa is 0.' }] },
        { title: 'Server B', text: 'Everything is slow, including logging in.', evidence: [{ title: 'vmstat 5 3 and free -m', kind: 'log', text: ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n 1  3 1980000  21000   1200  41000 2210 3105  2400  3300  900 1500 10  8 40 42  0\n\n       total  used  free  shared  buff/cache  available\nMem:    3921  3800    21      8        100         40\nSwap:   2047  1933   114' }], choices: [{ text: 'Memory: heavy swapping (si/so in the thousands) with almost nothing available', right: true, feedback: 'Correct. The wa here is caused by swapping; fix memory, not disks.' }, { text: 'Disk, because wa is 42', feedback: 'The I/O is swap traffic: memory is the root cause.' }, { text: 'CPU', feedback: 'Idle is 40%.' }] },
        { title: 'Server C', text: 'Database queries are slow at night.', evidence: [{ title: 'iostat -x 5 (excerpt)', kind: 'log', text: 'avg-cpu:  %user %system %iowait %idle\n           6.1     3.2    48.7   42.0\n\nDevice  r/s    w/s   rkB/s   wkB/s  await  %util\nsda     2.0    5.1    30.0    90.0   1.20    1.5\nsdb   410.0  220.0 52000.0 28000.0  48.30   99.8' }], choices: [{ text: 'Disk sdb: 99.8% utilised with 48 ms waits, during the night (backup or batch jobs?)', right: true, feedback: 'Correct. Move the job, spread the load, or use faster storage.' }, { text: 'CPU', feedback: 'User and system time are low.' }, { text: 'Disk sda', feedback: 'sda is nearly idle.' }] },
        { title: 'Server D', text: 'File downloads are slow; the server looks idle.', evidence: [{ title: 'sar -n DEV 5 1 (excerpt)', kind: 'log', text: 'IFACE   rxpck/s  txpck/s   rxkB/s    txkB/s  %ifutil\neth0      9200.0  81000.0   610.0  117800.0    96.5' }], choices: [{ text: 'Network: eth0 is sending ~118 MB/s, the limit of a 1 Gbit/s link', right: true, feedback: 'Correct. Faster or bonded links, a cache or CDN, or fewer bytes (compression).' }, { text: 'Disk', feedback: 'The interface is the saturated resource.' }, { text: 'Nothing: the CPU is idle', feedback: 'Idle CPUs do not mean the server is not saturated somewhere else.' }] },
      ],
      ending: { title: 'Bottlenecks found', text: 'CPU (run queue), memory (swapping), disk (%util and await) and network (link saturation).' },
      hints: ['Check each resource in turn: utilisation, saturation (queues) and errors.'],
      realityNote: 'Brendan Gregg\'s USE method (Utilisation, Saturation, Errors for every resource) is a standard checklist for this.',
    });
  }),

  /* ---------------------------------------------------------------- 10.4 monitoring and runbooks */
  tmpl(10, 4, 'beginner', 'monitoring-choices', 'Choose what and how to monitor', 'E10', 15, 'Pick a monitoring approach, the right alerts and how to avoid alert fatigue.', (v) => {
    const n = v.int(12, 60);
    return caseStudy(v, {
      intro: `## Monitoring ${n} servers\n\nThe ICT unit learns about outages from angry phone calls. You are asked to set up monitoring.`,
      steps: [
        { title: 'Which tool', text: 'Open-source options on our own servers.', choices: [{ text: 'Any of Prometheus with Grafana, Zabbix or Nagios/Icinga: pick one the team can maintain, and monitor the monitoring server too', right: true, feedback: 'Correct. The best tool is the one that is kept running.' }, { text: 'A paid cloud service that sends our data abroad', feedback: 'Possible elsewhere, but here all services stay on our own servers.' }, { text: 'Each admin checks servers by hand every morning', feedback: 'Outages at 2 a.m. still go unnoticed.' }] },
        { title: 'What to alert on', text: 'Someone proposes 50 alerts per server.', choices: [{ text: 'Alert on symptoms users feel (site down, errors, slow responses) and on things that will soon break (disk filling); record everything else as metrics', right: true, feedback: 'Correct.' }, { text: 'Alert on everything; more is safer', feedback: 'People start ignoring alerts, including the important one.' }, { text: 'Only alert when a server is completely down', feedback: 'A full disk or expired certificate breaks services while the server is "up".' }] },
        { title: 'Disk alert threshold', text: 'When should a disk alert fire?', choices: [{ text: 'When it is predicted to fill within a few days (or above ~85% for slow-growing disks)', right: true, feedback: 'Correct. Trend-based alerts give time to act.' }, { text: 'At 100%', feedback: 'Too late: services have already failed.' }, { text: 'At 50%', feedback: 'Many disks sit at 50% for years: noise.' }] },
        { title: 'Every alert', text: 'What should every alert link to?', choices: [{ text: 'A runbook: what it means, how to check, how to fix, whom to call', right: true, feedback: 'Correct. The person woken up at night may not know the system.' }, { text: 'Nothing; experienced admins know', feedback: 'Knowledge leaves with people.' }, { text: 'The vendor\'s sales page', feedback: 'Not helpful at 2 a.m.' }] },
      ],
      ending: { title: 'Monitoring planned', text: 'A maintainable tool, symptom-based alerts, trend-based disk alerts, and a runbook for every alert.' },
      hints: ['Think about the person who receives the alert.'],
      realityNote: 'Prometheus pulls metrics from exporters (node_exporter on Linux); Zabbix and Nagios use agents and checks. All three are free and self-hosted.',
    });
  }),
  tmpl(10, 4, 'intermediate', 'health-check', 'Write a health-check script and schedule it', 'E4', 25, 'Log disk usage and a service state every five minutes with a script and cron.', (v) => {
    const net = v.net();
    const service = v.pick(['sshd', 'cron', 'firewalld']);
    const log = v.pick(['/var/log/healthcheck.log', '/var/log/srv-health.log']);
    return {
      instructions: lab({ situation: `Until proper monitoring arrives, write **/usr/local/bin/healthcheck.sh** (executable) that appends one line to **${log}** each time it runs, containing the date and time, \`disk=NN%\` (the use% of the / filesystem) and \`${service}=STATE\` (from systemctl is-active). Example:\n\n\`2026-10-22 09:30:00 disk=15% ${service}=active\`\n\nSchedule it in **root's crontab every 5 minutes**.`, steps: ['Get the use% with df / | awk \'NR==2 {print $5}\'.', `Get the state with systemctl is-active ${service}.`, 'Append with >>, not >.', 'chmod +x, run it once, check the log.', 'crontab: */5 * * * * /usr/local/bin/healthcheck.sh'], tips: ["df / | awk 'NR==2 {print $5}'", `systemctl is-active ${service}`, "date '+%F %T'", 'crontab -l'] }),
      hints: ['Use full paths in scripts that cron runs.', '*/5 in the minute field means every five minutes.'],
      initialState: linux(net),
      checks: [file('The script is executable', '/usr/local/bin/healthcheck.sh', { mode: '755' }), script('It logs disk usage and the service state', '/usr/local/bin/healthcheck.sh', { creates: log }), out('The log line has the right format', `/usr/local/bin/healthcheck.sh; tail -1 ${log}`, { pattern: `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} disk=\\d+% ${service}=active$` }), out('It appends rather than overwrites', `/usr/local/bin/healthcheck.sh; /usr/local/bin/healthcheck.sh; wc -l < ${log}`, { pattern: '^([2-9]|\\d{2,})$' }), cron('It runs every five minutes', 'root', '^\\*/5\\s+\\*\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/bin/healthcheck\\.sh')],
      solution: [`cat > /usr/local/bin/healthcheck.sh <<'EOF'\n#!/bin/bash\ndisk=$(df / | awk 'NR==2 {print $5}')\nstate=$(systemctl is-active ${service})\necho "$(date '+%F %T') disk=$disk ${service}=$state" >> ${log}\nEOF`, 'chmod 755 /usr/local/bin/healthcheck.sh', '/usr/local/bin/healthcheck.sh', `cat ${log}`, "printf '*/5 * * * * /usr/local/bin/healthcheck.sh\\n' > /root/cron.txt", 'crontab /root/cron.txt', 'crontab -l'],
      realityNote: 'Home-made checks are a fine start; the same data later becomes a Prometheus exporter or a Zabbix item.',
    };
  }),
  tmpl(10, 4, 'advanced', 'write-a-runbook', 'Write and use a runbook', 'E10', 20, 'Decide what a runbook contains and follow one through an incident.', (v) => {
    const svcName = v.pick(['the library catalogue', 'the e-learning site', 'the exam results portal']);
    return caseStudy(v, {
      intro: `## Runbook: ${svcName} is down\n\nYou are writing the runbook that the on-call admin will follow when the "site down" alert fires.`,
      steps: [
        { title: 'First section', text: 'What goes at the top of the runbook?', choices: [{ text: 'What the alert means, who is affected, and the first checks to confirm it (curl the URL, systemctl status, recent changes)', right: true, feedback: 'Correct. Confirm and scope before acting.' }, { text: 'The full history of the system', feedback: 'Useful elsewhere; at 2 a.m. the reader needs actions.' }, { text: 'A reboot command', feedback: 'Reboots destroy evidence and may not fix anything.' }] },
        { title: 'Commands', text: 'How should steps be written?', choices: [{ text: 'Exact commands to copy, what output to expect, and what to do if the output differs', right: true, feedback: 'Correct.' }, { text: '"Check the web server"', feedback: 'Too vague for someone who has never seen the server.' }, { text: 'Screenshots only', feedback: 'They cannot be copied and they go out of date silently.' }] },
        { title: 'Escalation', text: 'The on-call admin cannot fix it in 30 minutes.', choices: [{ text: 'The runbook names who to escalate to, how to reach them, and who updates users', right: true, feedback: 'Correct.' }, { text: 'Keep trying alone', feedback: 'Users wait longer.' }, { text: 'Email the whole university', feedback: 'Communication is planned: one owner sends updates.' }] },
        { title: 'Afterwards', text: 'The service is back. What next?', choices: [{ text: 'A blameless post-incident review: timeline, cause, fixes, and updates to the runbook itself', right: true, feedback: 'Correct. Runbooks improve every time they are used.' }, { text: 'Nothing: it works now', feedback: 'The same incident will happen again.' }, { text: 'Find who to blame', feedback: 'Blame makes people hide mistakes; reviews focus on the system.' }] },
      ],
      ending: { title: 'Runbook ready', text: 'Meaning and scope first, exact commands with expected output, an escalation path, and a blameless review that updates the runbook.' },
      hints: ['Write for a colleague who is tired and has never seen this system.'],
      realityNote: 'Keep runbooks in version control (for example Markdown in git) next to the configuration they describe.',
    });
  }),

  /* ---------------------------------------------------------------- 10.5 capstone */
  tmpl(10, 5, 'beginner', 'capstone-web-server', 'Capstone: build a departmental web server', 'E4', 35, 'Install and publish a site, open the firewall, add an admin account and lock down root SSH.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const p = v.person();
    return {
      instructions: lab({ situation: `Build the **${dept}** department's new server:\n\n1. Install **apache2**, publish **/srv/www/htdocs/index.html** with the heading \`${dept} department\`, and run Apache now and at boot.\n2. Allow **http** permanently in the firewall.\n3. Create an administrator account **${p.sam}** (${p.name}) with a home directory, in the **wheel** group so they can use sudo, with password \`Admin@2026\`.\n4. Disable root logins over SSH (**PermitRootLogin no**) and restart sshd.`, steps: ['zypper install apache2; write the page; systemctl enable --now apache2.', 'firewall-cmd --permanent --add-service=http; --reload.', `useradd -m -G wheel ${p.sam}; passwd ${p.sam}.`, 'Edit sshd_config, sshd -t, restart sshd.'], tips: [`echo '${p.sam}:Admin@2026' | chpasswd`, 'sshd -T | grep permitroot'] }),
      hints: ['Create and test the admin account before you lock out root.'],
      initialState: linux(net, { files: { '/etc/ssh/sshd_config': { content: 'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\n', mode: '600' } as never } }),
      checks: [svc('Apache runs at boot', 'apache2', { active: true, enabled: true }), out('The page is published', 'curl -s http://localhost/', { contains: `${dept} department` }), out('HTTP is open in the firewall', 'firewall-cmd --permanent --list-services', { contains: 'http' }), user(`${p.sam} is an administrator`, p.sam, { exists: true, groups: ['wheel'], homeExists: true, hasPassword: true, sudo: true }), out('Root cannot log in over SSH', 'sshd -T', { contains: 'permitrootlogin no' }), svc('sshd is running', 'sshd', { active: true })],
      solution: ['zypper install apache2', `echo '<h1>${dept} department</h1>' > /srv/www/htdocs/index.html`, 'systemctl enable --now apache2', 'firewall-cmd --permanent --add-service=http', 'firewall-cmd --reload', `useradd -m -G wheel ${p.sam}`, `echo '${p.sam}:Admin@2026' | chpasswd`, "sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config", 'sshd -t', 'systemctl restart sshd'],
      realityNote: 'Named admin accounts with sudo, instead of a shared root password, mean every change can be traced to a person.',
    };
  }),
  tmpl(10, 5, 'intermediate', 'capstone-services', 'Capstone: add DNS, backups and intrusion protection', 'E4', 40, 'Serve a DNS zone, schedule nightly backups with a script, and ban SSH attackers.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const zone = `${dept}.lan`;
    const attacker = v.pick(ATTACKERS);
    const hour = v.int(1, 4);
    return {
      instructions: lab({ situation: `The **${dept}** server already serves the website. Add:\n\n1. **DNS**: install **bind** and serve the zone **${zone}** (file /var/lib/named/${zone}.zone) with SOA and NS records, **ns1** and **www** both at **${net}.5**. Run named at boot.\n2. **Backups**: a script **/usr/local/sbin/backup.sh** that creates **/backup/www-YYYY-MM-DD.tar.gz** (today's date, using date +%F) from /srv/www, scheduled in root's crontab daily at **0${hour}:30**.\n3. **Intrusion protection**: fail2ban is installed; enable the **sshd** jail (in /etc/fail2ban/jail.local) and run it at boot. An attack from ${attacker} is in /var/log/secure.`, steps: ['bind: named.conf zone block, zone file, named-checkzone, enable --now named, dig.', 'backup.sh: mkdir -p /backup; tar czf /backup/www-$(date +%F).tar.gz -C /srv www', `cron: 30 ${hour} * * * /usr/local/sbin/backup.sh`, 'jail.local: [sshd] enabled = true; enable --now fail2ban.'], tips: [`dig @127.0.0.1 www.${zone} +short`, 'date +%F', 'fail2ban-client status sshd'] }),
      hints: ['Test the backup script by running it once by hand.'],
      initialState: linux(net, { packages: { apache2: { installed: true }, fail2ban: { installed: true } }, services: { apache2: { active: true, enabled: true, package: 'apache2', port: 80 }, fail2ban: { package: 'fail2ban', active: false, enabled: false } }, files: { '/srv/www/htdocs/index.html': `${dept} department\n`, '/etc/fail2ban/jail.conf': '# Default jails shipped with fail2ban. Do not edit: copy settings to jail.local.\n[DEFAULT]\nbantime = 10m\nmaxretry = 5\n', '/var/log/secure': failedLogins(attacker, 12, 'root') } }),
      checks: [svc('named runs at boot', 'named', { active: true, enabled: true }), out(`www.${zone} resolves`, `dig @127.0.0.1 www.${zone} +short`, { equals: `${net}.5` }), out('The zone is valid', `named-checkzone ${zone} /var/lib/named/${zone}.zone`, { contains: 'OK' }), script('The backup script creates today\'s archive', '/usr/local/sbin/backup.sh', { creates: '/backup/www-2026-10-22.tar.gz' }), cron('Backups run nightly', 'root', `^30\\s+0?${hour}\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/sbin/backup\\.sh`), svc('fail2ban runs at boot', 'fail2ban', { active: true, enabled: true }), out('The attacker is banned', 'fail2ban-client status sshd', { contains: attacker })],
      solution: ['zypper install bind', `printf '\\nzone "${zone}" in {\\n    type master;\\n    file "${zone}.zone";\\n};\\n' >> /etc/named.conf`, `printf '$TTL 3600\\n@ IN SOA ns1.${zone}. hostmaster.${zone}. ( 2026102201 3600 900 604800 300 )\\n  IN NS ns1\\nns1 IN A ${net}.5\\nwww IN A ${net}.5\\n' > /var/lib/named/${zone}.zone`, `named-checkzone ${zone} /var/lib/named/${zone}.zone`, 'systemctl enable --now named', `cat > /usr/local/sbin/backup.sh <<'EOF'\n#!/bin/bash\nmkdir -p /backup\ntar czf /backup/www-$(date +%F).tar.gz -C /srv www\nEOF`, 'chmod 755 /usr/local/sbin/backup.sh', '/usr/local/sbin/backup.sh', `printf '30 ${hour} * * * /usr/local/sbin/backup.sh\\n' > /root/cron.txt`, 'crontab /root/cron.txt', "printf '[sshd]\\nenabled = true\\n' > /etc/fail2ban/jail.local", 'systemctl enable --now fail2ban', 'fail2ban-client status sshd'],
      realityNote: 'A real capstone server is judged on whether someone else could run it from your notes; keep a record of every change.',
    };
  }),
  tmpl(10, 5, 'advanced', 'capstone-secure-server', 'Capstone: secure, document and hand over the server', 'E4', 50, 'Add a shared folder with ACLs, a password-protected area, key-only SSH, a backup timer and documentation.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [admin, staff, auditor] = v.people(3);
    const base = apacheSite(dept);
    return {
      instructions: lab({ situation: `Finish the **${dept}** server and hand it over:\n\n1. **Shared folder** /srv/share/${dept}: group **${dept}** (members ${admin.sam} and ${staff.sam}), mode **2770**, and read-only access for the auditor **${auditor.sam}** through an ACL (u:${auditor.sam}:r-x).\n2. **Staff area**: protect /srv/www/${dept}/staff with Basic authentication using **/etc/apache2/htpasswd** with user ${staff.sam} (password \`Staff@2026\`).\n3. **SSH**: ${admin.sam}'s key is already installed. Set **PermitRootLogin no** and **PasswordAuthentication no**, test, restart sshd.\n4. **Backups**: a systemd service **share-backup.service** (ExecStart=/usr/local/sbin/share-backup.sh, which you write: tar of /srv/share into /backup) and **share-backup.timer** (OnCalendar=daily), timer enabled and started.\n5. **Documentation**: /root/SERVER.md listing every network service with its port (at least sshd 22 and apache2 80) and where the backups go.`, steps: ['groupadd, usermod -aG, mkdir, chgrp, chmod 2770, setfacl -m.', 'htpasswd -c -b, then a <Directory> block in the vhost; configtest; reload.', 'sshd_config, sshd -t, restart.', 'Write the script, the two unit files, systemctl daemon-reload, enable --now share-backup.timer.', 'Write SERVER.md.'], tips: [`setfacl -m u:${auditor.sam}:r-x /srv/share/${dept}`, 'systemctl list-timers', 'ss -tlnp'] }),
      hints: ['Test key login before you turn off passwords (here the key is already in place).', 'A timer named share-backup.timer starts share-backup.service.'],
      initialState: linux(net, { ...base, users: { ...base.users, [admin.sam]: { groups: ['wheel'] }, [staff.sam]: { groups: ['users'] }, [auditor.sam]: { groups: ['users'] } }, files: { ...base.files, [`/srv/www/${dept}/staff/index.html`]: `${dept} staff notices\n` as never, '/etc/ssh/sshd_config': { content: 'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\n', mode: '600' } as never, [`/home/${admin.sam}/.ssh/authorized_keys`]: { content: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH${admin.sam} ${admin.sam}@laptop\n`, mode: '600', owner: admin.sam } as never } }),
      checks: [file('The share has the right group and setgid', `/srv/share/${dept}`, { kind: 'dir', mode: '2770', group: dept }), file('The auditor can read it through an ACL', `/srv/share/${dept}`, { acl: `u:${auditor.sam}:r-x` }), out('The staff area asks for a password', `curl -I http://${dept}.campus.lan/staff/`, { contains: '401' }), out(`${staff.sam} can log in to it`, `curl -s -u ${staff.sam}:Staff@2026 http://${dept}.campus.lan/staff/`, { contains: `${dept} staff notices` }), out('SSH is key-only, no root', 'sshd -T', { contains: ['permitrootlogin no', 'passwordauthentication no'] }), svc('The backup timer is active', 'share-backup.timer', { active: true, enabled: true }), script('The backup script works', '/usr/local/sbin/share-backup.sh', { status: 0 }), file('The server is documented', '/root/SERVER.md', { contains: ['sshd', '22', 'apache2', '80', '/backup'] })],
      solution: [`groupadd ${dept}`, `usermod -aG ${dept} ${admin.sam}`, `usermod -aG ${dept} ${staff.sam}`, `mkdir -p /srv/share/${dept}`, `chgrp ${dept} /srv/share/${dept}`, `chmod 2770 /srv/share/${dept}`, `setfacl -m u:${auditor.sam}:r-x /srv/share/${dept}`, `htpasswd -c -b /etc/apache2/htpasswd ${staff.sam} Staff@2026`, `printf '<VirtualHost *:80>\\n    ServerName ${dept}.campus.lan\\n    DocumentRoot /srv/www/${dept}\\n    <Directory "/srv/www/${dept}/staff">\\n        AuthType Basic\\n        AuthName "Staff"\\n        AuthUserFile /etc/apache2/htpasswd\\n        Require valid-user\\n    </Directory>\\n</VirtualHost>\\n' > /etc/apache2/vhosts.d/${dept}.conf`, 'apachectl configtest', 'systemctl reload apache2', "sed -i 's/^PermitRootLogin yes/PermitRootLogin no/; s/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config", 'sshd -t', 'systemctl restart sshd', `cat > /usr/local/sbin/share-backup.sh <<'EOF'\n#!/bin/bash\nmkdir -p /backup\ntar czf /backup/share-$(date +%F).tar.gz -C /srv share\nEOF`, 'chmod 755 /usr/local/sbin/share-backup.sh', "printf '[Unit]\\nDescription=Back up /srv/share\\n\\n[Service]\\nType=oneshot\\nExecStart=/usr/local/sbin/share-backup.sh\\n' > /etc/systemd/system/share-backup.service", "printf '[Unit]\\nDescription=Daily share backup\\n\\n[Timer]\\nOnCalendar=daily\\nPersistent=true\\n\\n[Install]\\nWantedBy=timers.target\\n' > /etc/systemd/system/share-backup.timer", 'systemctl daemon-reload', 'systemctl enable --now share-backup.timer', `printf '# ${dept} server\\n\\n| Service | Port |\\n|---|---|\\n| sshd | 22 (keys only) |\\n| apache2 | 80 |\\n\\nBackups: share-backup.timer runs daily into /backup.\\n' > /root/SERVER.md`],
      realityNote: 'A server is finished when someone else can run it: documented services, tested backups and no shared root password.',
    };
  }),
];
