/** Unit 6: configuration and package automation. */

import { apiState } from '@cslab/engine-shell/src/labapi';
import type { TaskTemplate } from '../types';
import { DEPTS, HOSTS, RUNNING, STOPPED_MANUAL, caseStudy, csv, dc01, dcServices, file, lab, linux, out, pkg, ps, psWrite, ran, script, svc, tmpl, user, windows, write, writeScript } from './kit';

const KEY = (who: string, n: number) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${who.padEnd(8, 'x').slice(0, 8)}${'Kq7mZ3vTq9'.slice(0, (n % 9) + 1)}LabKey ${who}@laptop`;

export const U6: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 6.1 package managers, pinning, unattended updates */
  tmpl(6, 1, 'beginner', 'lock-a-package', 'Hold a package at its version during updates', 'E4', 15, 'Lock a package with zypper so a routine update upgrades everything else but not it.', (v) => {
    const net = v.net();
    const hold = v.pick([{ p: 'mariadb', from: '10.11.6', to: '10.11.9', why: 'the student records application is certified only on 10.11.6' }, { p: 'apache2', from: '2.4.58', to: '2.4.62', why: 'a module the library catalogue needs has not been rebuilt for 2.4.62' }]);
    const others = v.some([{ p: 'openssh', from: '9.6', to: '9.8' }, { p: 'curl', from: '8.6', to: '8.9' }, { p: 'vim', from: '9.0', to: '9.1' }], 2);
    return {
      instructions: lab({
        situation: `Updates are waiting. Install them all **except ${hold.p}**, which must stay at **${hold.from}** because ${hold.why}. Lock it with zypper first so neither you nor the nightly update job can upgrade it by accident, then run the update non-interactively.`,
        steps: ['zypper list-updates shows what is waiting.', `zypper addlock ${hold.p}`, 'zypper --non-interactive update', 'Check versions with rpm -q and the locks with zypper locks.'],
        tips: ['zypper list-updates', `zypper addlock ${hold.p}`, 'zypper --non-interactive update', 'zypper locks'],
      }),
      hints: ['A lock stays until you remove it with zypper removelock: record why it is there.', 'On Debian/Ubuntu the same idea is apt-mark hold.'],
      initialState: linux(net, { packages: { [hold.p]: { installed: true, version: hold.from, available: hold.to }, ...Object.fromEntries(others.map((o) => [o.p, { installed: true, version: o.from, available: o.to }])) } }),
      checks: [
        out(`${hold.p} stayed at ${hold.from}`, `rpm -q ${hold.p}`, { contains: `${hold.p}-${hold.from}` }),
        ...others.map((o) => out(`${o.p} was upgraded`, `rpm -q ${o.p}`, { contains: `${o.p}-${o.to}` })),
        out(`${hold.p} is locked`, 'zypper locks', { contains: hold.p }),
      ],
      solution: ['zypper list-updates', `zypper addlock ${hold.p}`, 'zypper --non-interactive update', `rpm -q ${hold.p} ${others.map((o) => o.p).join(' ')}`],
      realityNote: 'Pinning is a deliberate, documented exception; a lock forgotten for a year becomes an unpatched vulnerability, so review locks with every maintenance window.',
    };
  }),
  tmpl(6, 1, 'intermediate', 'winget-pin', 'Install a pinned version with winget', 'E4', 20, 'Install an exact version unattended, pin it, and check that winget upgrade --all leaves it alone.', (v) => {
    const net = v.net();
    const app = v.pick([{ id: '7zip.7zip', name: '7-Zip', ver: '23.01' }, { id: 'Git.Git', name: 'Git', ver: '2.45.2' }, { id: 'Notepad++.Notepad++', name: 'Notepad++', ver: '8.6.9' }]);
    const other = v.pick([{ id: 'VideoLAN.VLC', name: 'VLC' }, { id: 'PuTTY.PuTTY', name: 'PuTTY' }]);
    return {
      instructions: lab({
        situation: `The lab image needs **${app.name}** at exactly version **${app.ver}** (the coursework instructions were written for it). Install it **unattended** with winget (exact id, exact version, no prompts), **pin** it so updates skip it, then install **${other.name}** (latest) and run \`winget upgrade --all\` to show that ${app.name} is not upgraded.`,
        steps: [`winget install --id ${app.id} --exact --version ${app.ver} --silent --accept-package-agreements --accept-source-agreements`, `winget pin add --id ${app.id}`, 'winget pin list', 'winget upgrade --all ... and winget list'],
        tips: [`winget install --id ${app.id} --exact --version ${app.ver} --silent --accept-package-agreements --accept-source-agreements`, `winget pin add --id ${app.id}`, 'winget upgrade --all --silent --accept-package-agreements --accept-source-agreements'],
      }),
      hints: ['Without the agreement switches winget stops and waits for a person to type Y.', '--exact stops "Git" from matching other packages with Git in the name.'],
      initialState: windows({ machines: [dc01(net)] }),
      checks: [
        ps(`${app.name} is at ${app.ver}`, `(winget list --id ${app.id}) -join ' '`, { contains: ` ${app.ver} ` }),
        ps(`${app.name} is pinned`, '(winget pin list) -join " "', { contains: app.id }),
        ps(`${other.name} is installed`, `(winget list --id ${other.id}) -join ' '`, { contains: other.id }),
        ran('An upgrade of everything was run', 'winget upgrade[^\\n]*--all'),
      ],
      solution: [`winget install --id ${app.id} --exact --version ${app.ver} --silent --accept-package-agreements --accept-source-agreements`, `winget pin add --id ${app.id}`, `winget install --id ${other.id} --exact --silent --accept-package-agreements --accept-source-agreements`, 'winget upgrade --all --silent --accept-package-agreements --accept-source-agreements', `winget list --id ${app.id}`],
      realityNote: 'Unattended winget or Chocolatey commands in a provisioning script, with pins for the few version-sensitive tools, keep a whole lab of machines identical.',
    };
  }),
  tmpl(6, 1, 'advanced', 'unattended-updates', 'Automate updates with a timer and a lock list', 'E4', 30, 'Run non-interactive updates from a systemd timer that logs results and respects package locks.', (v) => {
    const net = v.net();
    const hold = v.pick(['mariadb', 'apache2']);
    const ups = [{ p: 'openssh', from: '9.6', to: '9.8' }, { p: 'curl', from: '8.6', to: '8.9' }];
    const day = v.pick([{ cal: 'Sun *-*-* 03:00:00', text: 'Sundays at 03:00' }, { cal: 'Wed *-*-* 02:30:00', text: 'Wednesdays at 02:30' }]);
    return {
      instructions: lab({
        situation: `Patch this server automatically, **${day.text}**, without anyone logged in:\n\n- **/usr/local/sbin/auto-update** runs \`zypper --non-interactive update\`, appends its output to **/var/log/auto-update.log** with a dated header line \`=== <date +%F> ===\`, and exits with zypper's exit code;\n- **auto-update.service** (Type=oneshot) runs it; **auto-update.timer** triggers it with OnCalendar=\`${day.cal}\`, Persistent=true and RandomizedDelaySec=1800 (so a whole fleet does not hit the mirror at once);\n- **${hold}** is version-sensitive: lock it before enabling the timer.\n\nEnable the timer, then start the service once to test it.`,
        steps: ['Write the script, then the two unit files.', `zypper addlock ${hold}`, 'systemctl daemon-reload; systemctl enable --now auto-update.timer', 'systemctl start auto-update.service; read /var/log/auto-update.log.'],
        tips: ['{ echo "=== $(date +%F) ==="; zypper --non-interactive update; } >> /var/log/auto-update.log 2>&1', 'rc=${PIPESTATUS[0]}  (or capture the exit code another way)', `[Timer]\nOnCalendar=${day.cal}\nRandomizedDelaySec=1800\nPersistent=true`],
      }),
      hints: ['Automatic updates without a log are impossible to audit after something breaks.', 'Kernel updates still need a reboot; plan a window for those separately.'],
      initialState: linux(net, { packages: { [hold]: { installed: true, version: '10.11.6', available: '10.11.9' }, ...Object.fromEntries(ups.map((u) => [u.p, { installed: true, version: u.from, available: u.to }])) } }),
      checks: [
        svc('The timer is enabled and active', 'auto-update.timer', { active: true, enabled: true }),
        file('The timer has the schedule and delay', '/etc/systemd/system/auto-update.timer', { contains: [`OnCalendar=${day.cal}`, 'RandomizedDelaySec=1800', 'Persistent=true'] }),
        ...ups.map((u) => out(`${u.p} was updated by the test run`, `rpm -q ${u.p}`, { contains: `${u.p}-${u.to}` })),
        out(`${hold} was not updated`, `rpm -q ${hold}`, { contains: `${hold}-10.11.6` }),
        file('The run was logged with a dated header', '/var/log/auto-update.log', { contains: ['=== 2026-10-22 ===', 'going to be upgraded'] }),
      ],
      solution: [`zypper addlock ${hold}`, writeScript('/usr/local/sbin/auto-update', '{\n  echo "=== $(date +%F) ==="\n  zypper --non-interactive update\n  rc=$?\n} >> /var/log/auto-update.log 2>&1\nexit $rc\n'), write('/etc/systemd/system/auto-update.service', '[Unit]\nDescription=Unattended package updates\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/auto-update\n'), write('/etc/systemd/system/auto-update.timer', `[Unit]\nDescription=Run unattended updates ${day.text}\n\n[Timer]\nOnCalendar=${day.cal}\nRandomizedDelaySec=1800\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`), 'systemctl daemon-reload', 'systemctl enable --now auto-update.timer', 'systemctl start auto-update.service', 'cat /var/log/auto-update.log'],
      realityNote: 'openSUSE ships zypper-auto-update/transactional-update, Debian unattended-upgrades and Red Hat dnf-automatic; all of them are this timer-and-log pattern.',
    };
  }),

  /* ---------------------------------------------------------------- 6.2 provisioning from a script */
  tmpl(6, 2, 'beginner', 'provision-web-server', 'Provision a web server from a script', 'E4', 20, 'Install, enable and open a web server and publish a page, in one script.', (v) => {
    const net = v.net();
    const site = v.pick(DEPTS);
    const host = v.pick(HOSTS);
    return {
      instructions: lab({
        situation: `Write **/root/provision-web.sh** that turns a fresh server into the **${site}** web server, then run it:\n\n1. install **apache2** non-interactively;\n2. write **/srv/www/htdocs/index.html** containing \`<h1>${site} - ${host}</h1>\`;\n3. enable and start apache2;\n4. open **http** permanently in firewalld and reload;\n5. stop with an error if any step fails (set -euo pipefail).`,
        steps: ['zypper --non-interactive install apache2', 'systemctl enable --now apache2', 'firewall-cmd --permanent --add-service=http && firewall-cmd --reload', 'Test with curl -s http://localhost'],
        tips: ['set -euo pipefail', 'zypper --non-interactive install apache2', 'systemctl enable --now apache2', 'firewall-cmd --permanent --add-service=http'],
      }),
      hints: ['A provisioning script is documentation that runs: anyone can rebuild the server from it.', 'Keep it in version control next to the server\'s other configuration.'],
      initialState: linux(net, { hostname: host }),
      checks: [
        pkg('apache2 is installed', 'apache2'),
        svc('apache2 runs and starts at boot', 'apache2', { active: true, enabled: true }),
        out('The page is served', 'curl -s http://localhost', { contains: `<h1>${site} - ${host}</h1>` }),
        out('http is open in the firewall', 'firewall-cmd --list-services', { contains: 'http' }),
        file('The script uses strict mode', '/root/provision-web.sh', { contains: 'set -euo pipefail' }),
      ],
      solution: [write('/root/provision-web.sh', `#!/bin/bash\nset -euo pipefail\nzypper --non-interactive install apache2\nmkdir -p /srv/www/htdocs\necho '<h1>${site} - ${host}</h1>' > /srv/www/htdocs/index.html\nsystemctl enable --now apache2\nfirewall-cmd --permanent --add-service=http\nfirewall-cmd --reload\n`), 'bash /root/provision-web.sh', 'curl -s http://localhost'],
      realityNote: 'Cloud-init user data, Packer builds and Vagrant provisioners are all "a script that turns a blank machine into a server"; writing it by hand first teaches what they automate.',
    };
  }),
  tmpl(6, 2, 'intermediate', 'admins-and-keys', 'Provision admin accounts with SSH keys', 'E4', 25, 'Create admin users from a key folder with correct .ssh permissions and sudo, idempotently.', (v) => {
    const net = v.net();
    const admins = v.people(3);
    const grp = v.pick(['wheel', 'sysadmins']);
    return {
      instructions: lab({
        situation: `**/root/keys/** holds one public key per administrator, named \`<username>.pub\`. Write **/usr/local/sbin/provision-admins** that, for each key file:\n\n- creates the user if missing (home, /bin/bash) and adds them to **${grp}**;\n- installs the key as **~/.ssh/authorized_keys**, with **~/.ssh** mode **700** and the file mode **600**, both owned by the user;\n- prints \`ok <user>\`.\n\nRunning it twice must not fail or duplicate anything.${grp === 'sysadmins' ? ' Members of sysadmins may use sudo (the group exists and has a sudoers rule).' : ''}`,
        steps: ['for f in /root/keys/*.pub; do u=$(basename "$f" .pub); ... done', 'id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"', 'install -d -m 700 -o "$u" -g "$u" /home/$u/.ssh', 'install -m 600 -o "$u" -g "$u" "$f" /home/$u/.ssh/authorized_keys'],
        tips: ['install -d -m 700 -o USER -g USER DIR', 'install -m 600 -o USER -g USER SRC DEST', 'usermod -aG GROUP USER'],
      }),
      hints: ['sshd ignores authorized_keys if ~/.ssh or the file is writable by others (StrictModes).', 'install copies and sets owner and mode in one step, so there is no moment with the wrong permissions.'],
      initialState: linux(net, { groups: { [grp]: [] }, files: { ...Object.fromEntries(admins.map((p, i) => [`/root/keys/${p.sam}.pub`, KEY(p.sam, i) + '\n'])), ...(grp === 'sysadmins' ? { '/etc/sudoers.d/sysadmins': { content: '%sysadmins ALL=(ALL) ALL\n', mode: '440' } } : {}) } as never }),
      checks: [
        ...admins.map((p) => user(`${p.sam} exists in ${grp}`, p.sam, { groups: [grp], homeExists: true, shell: '/bin/bash' })),
        file('~/.ssh is private', `/home/${admins[0].sam}/.ssh`, { kind: 'dir', mode: '700', owner: admins[0].sam }),
        file('authorized_keys has the key and mode 600', `/home/${admins[1].sam}/.ssh/authorized_keys`, { equals: KEY(admins[1].sam, 1), mode: '600', owner: admins[1].sam }),
        script('A second run succeeds and changes nothing', '/usr/local/sbin/provision-admins', { status: 0, contains: admins.map((p) => `ok ${p.sam}`) }),
        out('Keys are not duplicated', `wc -l < /home/${admins[2].sam}/.ssh/authorized_keys`, { equals: '1' }),
      ],
      solution: [writeScript('/usr/local/sbin/provision-admins', `set -euo pipefail\nfor f in /root/keys/*.pub; do\n  u=$(basename "$f" .pub)\n  id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"\n  usermod -aG ${grp} "$u"\n  install -d -m 700 -o "$u" -g "$u" "/home/$u/.ssh"\n  install -m 600 -o "$u" -g "$u" "$f" "/home/$u/.ssh/authorized_keys"\n  echo "ok $u"\ndone\n`), 'provision-admins', 'provision-admins'],
      realityNote: 'Distributing keys from a reviewed folder (or an identity provider) instead of by hand is how teams avoid forgotten keys of people who left.',
    };
  }),
  tmpl(6, 2, 'advanced', 'harden-and-verify', 'Provision with validation before restart', 'E4', 30, 'Change sshd configuration from a script, validate with sshd -t, and restart only if it is valid.', (v) => {
    const net = v.net();
    const port = v.pick([2222, 2200, 22022]);
    const grp = v.pick(['sshusers', 'remote-admins']);
    const p = v.person();
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/harden-ssh** that sets these options in **/etc/ssh/sshd_config** (replacing existing lines, adding missing ones, never duplicating): \`Port ${port}\`, \`PermitRootLogin no\`, \`PasswordAuthentication no\`, \`AllowGroups ${grp}\`. Then it must:\n\n1. keep a backup **/etc/ssh/sshd_config.bak** of the previous file;\n2. run **sshd -t**; if the configuration is invalid, restore the backup and exit **1** without restarting;\n3. open TCP ${port} in firewalld (permanently) and reload it;\n4. restart sshd.\n\n${p.sam} must stay able to log in: make sure they are in **${grp}** before you run it.`,
        steps: ['A set_option function: if grep -q "^#\\?Option " FILE then sed -i to replace it, else append it.', 'cp before editing; sshd -t || { cp backup back; exit 1; }', `firewall-cmd --permanent --add-port=${port}/tcp`, 'systemctl restart sshd'],
        tips: ['set_option() {\n  if grep -qE "^#?$1 " /etc/ssh/sshd_config; then\n    sed -i -E "s/^#?$1 .*/$1 $2/" /etc/ssh/sshd_config\n  else\n    echo "$1 $2" >> /etc/ssh/sshd_config\n  fi\n}', 'sshd -t'],
      }),
      hints: ['Locking yourself out of SSH on a remote server is the classic mistake: validate, keep a session open, test a new login before closing it.', 'Changing the port alone is not security, but it cuts log noise.'],
      initialState: linux(net, { groups: { [grp]: [] }, users: { [p.sam]: {} }, files: { '/etc/ssh/sshd_config': '#Port 22\nPermitRootLogin yes\n#PasswordAuthentication yes\nUsePAM yes\nX11Forwarding no\nSubsystem sftp /usr/lib/ssh/sftp-server\n' } }),
      checks: [
        out('The options are set once each', `sshd -T`, { contains: [`port ${port}`, 'permitrootlogin no', 'passwordauthentication no', `allowgroups ${grp}`] }),
        out('No option is duplicated', "grep -cE '^(Port|PermitRootLogin|PasswordAuthentication|AllowGroups) ' /etc/ssh/sshd_config", { equals: '4' }),
        file('A backup was kept', '/etc/ssh/sshd_config.bak', { contains: 'PermitRootLogin yes' }),
        out('The new port is open', 'firewall-cmd --list-ports', { contains: `${port}/tcp` }),
        user(`${p.sam} can still log in`, p.sam, { groups: [grp] }),
        out('An invalid configuration stops the script before the restart', `echo 'NotAnOption yes' >> /etc/ssh/sshd_config; /usr/local/sbin/harden-ssh; echo "rc=$?"; cmp -s /etc/ssh/sshd_config /etc/ssh/sshd_config.bak && echo restored`, { contains: ['rc=1', 'restored'] }),
      ],
      solution: [`usermod -aG ${grp} ${p.sam}`, writeScript('/usr/local/sbin/harden-ssh', `cfg=/etc/ssh/sshd_config\ncp "$cfg" "$cfg.bak"\nset_option() {\n  if grep -qE "^#?$1 " "$cfg"; then\n    sed -i -E "s/^#?$1 .*/$1 $2/" "$cfg"\n  else\n    echo "$1 $2" >> "$cfg"\n  fi\n}\nset_option Port ${port}\nset_option PermitRootLogin no\nset_option PasswordAuthentication no\nset_option AllowGroups ${grp}\nif ! sshd -t; then\n  cp "$cfg.bak" "$cfg"\n  echo "invalid sshd configuration: restored the backup" >&2\n  exit 1\nfi\nfirewall-cmd --permanent --add-port=${port}/tcp >/dev/null\nfirewall-cmd --reload >/dev/null\nsystemctl restart sshd\n`), 'harden-ssh', 'sshd -T | grep -E "^(port|permitrootlogin|passwordauthentication|allowgroups) "'],
      realityNote: 'Validate-then-apply (sshd -t, nginx -t, apachectl configtest, visudo -c) is the habit that separates routine changes from outages.',
    };
  }),

  /* ---------------------------------------------------------------- 6.3 configuration as code: idempotent edits, templating, drift */
  tmpl(6, 3, 'beginner', 'ensure-config-line', 'Set a configuration value idempotently', 'E4', 15, 'Write a function that sets key = value in a file: replace if present, append if not, never duplicate.', (v) => {
    const net = v.net();
    const settings = v.some([['vm.swappiness', '10'], ['net.ipv4.ip_forward', '0'], ['kernel.panic', '10'], ['fs.file-max', '200000'], ['net.core.somaxconn', '1024']], 3);
    const existing = settings[0];
    const conf = '/etc/sysctl.d/90-campus.conf';
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/set-sysctl KEY VALUE** that makes **${conf}** contain exactly one line \`KEY = VALUE\`: if a line for KEY exists (even commented out with #), replace it; otherwise append one. Running it again with the same arguments must change nothing. Then set:\n\n${settings.map(([k, val]) => `- \`${k} = ${val}\``).join('\n')}\n\nThe file already has \`${existing[0]} = 60\`.`,
        steps: ['Escape the dots of KEY for sed: ${1//./\\\\.}', 'If grep -qE "^#?\\s*KEY\\s*=" FILE, then sed -i -E "s/^#?\\s*KEY\\s*=.*/KEY = VALUE/" FILE, else append.', 'Run the three settings, then run them again and compare.'],
        tips: ['k=${1//./\\\\.}', 'if grep -qE "^#?\\s*$k\\s*=" "$f"; then sed -i -E "s/^#?\\s*$k\\s*=.*/$1 = $2/" "$f"; else echo "$1 = $2" >> "$f"; fi', `sysctl -p ${conf}`],
      }),
      hints: ['"Append if missing, replace if present" is the core of every configuration-management line module.', 'An unescaped dot in a regex matches any character, so vm.swappiness would also match vmXswappiness.'],
      initialState: linux(net, { files: { [conf]: `# campus kernel settings\n${existing[0]} = 60\n#${settings[1][0]} = 1\n` } }),
      checks: [
        ...settings.map(([k, val]) => out(`${k} is ${val}, once`, `grep -cxF '${k} = ${val}' ${conf}; grep -c '${k}' ${conf}`, { equals: '1\n1' })),
        out('Re-running changes nothing', `cp ${conf} /tmp/before; ${settings.map(([k, val]) => `/usr/local/sbin/set-sysctl ${k} ${val}`).join('; ')}; diff /tmp/before ${conf} && echo same`, { contains: 'same' }),
        file('The comment line is kept', conf, { contains: '# campus kernel settings' }),
      ],
      solution: [writeScript('/usr/local/sbin/set-sysctl', `f=${conf}\nk=\${1//./\\\\.}\nif grep -qE "^#?\\s*$k\\s*=" "$f"; then\n  sed -i -E "s/^#?\\s*$k\\s*=.*/$1 = $2/" "$f"\nelse\n  echo "$1 = $2" >> "$f"\nfi\n`), ...settings.map(([k, val]) => `set-sysctl ${k} ${val}`), `cat ${conf}`],
      realityNote: 'Ansible\'s lineinfile, Puppet\'s file_line and augeas all do exactly this; knowing the shell version helps when those tools are not available.',
    };
  }),
  tmpl(6, 3, 'intermediate', 'render-templates', 'Render configuration from a template', 'E4', 20, 'Generate per-environment configuration files from one template with envsubst, expanding only chosen variables.', (v) => {
    const net = v.net();
    const app = v.pick(['portal', 'fees-api', 'results']);
    const envs = [{ n: 'staging', port: 8081, db: `db-staging.campus.lan`, log: 'debug' }, { n: 'production', port: 8080, db: `db01.campus.lan`, log: 'warn' }];
    const tmplText = `# ${app} configuration (generated, do not edit)\nlisten_port = \${APP_PORT}\ndatabase_host = \${DB_HOST}\nlog_level = \${LOG_LEVEL}\n# literal: the application expands $HOME itself\ncache_dir = $HOME/.cache/${app}\n`;
    return {
      instructions: lab({
        situation: `**/etc/${app}/templates/app.conf.tmpl** is the one template for all environments. Write **/usr/local/sbin/render-config ENV** that reads **/etc/${app}/env/ENV.env** (lines like \`APP_PORT=8081\`) and writes **/etc/${app}/ENV.conf** from the template with **envsubst**, replacing only **APP_PORT, DB_HOST and LOG_LEVEL** (the template's \`$HOME\` must stay literal). Render **staging** and **production**.`,
        steps: ['set -a; . "/etc/APP/env/$1.env"; set +a exports everything the file defines.', "envsubst '$APP_PORT $DB_HOST $LOG_LEVEL' < template > output", 'Compare the two outputs with diff.'],
        tips: ['set -a; . FILE; set +a', "envsubst '$APP_PORT $DB_HOST $LOG_LEVEL' < IN > OUT"],
      }),
      hints: ['Without the variable list, envsubst replaces every $NAME, including $HOME.', 'Generated files should say they are generated, so nobody edits them by hand.'],
      initialState: linux(net, { files: { [`/etc/${app}/templates/app.conf.tmpl`]: tmplText, ...Object.fromEntries(envs.map((e) => [`/etc/${app}/env/${e.n}.env`, `APP_PORT=${e.port}\nDB_HOST=${e.db}\nLOG_LEVEL=${e.log}\n`])) } }),
      checks: [
        ...envs.map((e) => file(`${e.n} is rendered`, `/etc/${app}/${e.n}.conf`, { contains: [`listen_port = ${e.port}`, `database_host = ${e.db}`, `log_level = ${e.log}`] })),
        file('$HOME stays literal', `/etc/${app}/production.conf`, { contains: `cache_dir = $HOME/.cache/${app}` }),
        script('The script renders any environment', '/usr/local/sbin/render-config', { args: ['staging'], status: 0, creates: `/etc/${app}/staging.conf` }),
      ],
      solution: [writeScript('/usr/local/sbin/render-config', `set -euo pipefail\nset -a\n. "/etc/${app}/env/$1.env"\nset +a\nenvsubst '$APP_PORT $DB_HOST $LOG_LEVEL' < /etc/${app}/templates/app.conf.tmpl > "/etc/${app}/$1.conf"\n`), 'render-config staging', 'render-config production', `diff /etc/${app}/staging.conf /etc/${app}/production.conf`],
      realityNote: 'One template plus per-environment values is the model of Ansible (Jinja2), Helm and Terraform; envsubst is its smallest form.',
    };
  }),
  tmpl(6, 3, 'advanced', 'drift-detection', 'Detect and repair configuration drift', 'E4', 30, 'Compare live files with a golden copy by checksum, report drift, restore it on request, and log it.', (v) => {
    const net = v.net();
    const files = v.some(['/etc/ssh/sshd_config', '/etc/sysctl.d/90-campus.conf', '/etc/chrony.conf', '/etc/security/limits.d/90-lab.conf', '/etc/motd'], 4);
    const drifted = files.slice(0, 2);
    const gold = (p: string) => `# managed: ${p}\nsetting_a = 1\nsetting_b = ${p.length}\n`;
    return {
      instructions: lab({
        situation: `**/srv/golden/** mirrors the managed files (for example /srv/golden/etc/motd is the approved /etc/motd), and **/srv/golden/MANIFEST.sha256** lists their checksums as \`sha256sum\` prints them with **absolute live paths**. Someone edited files by hand. Write **/usr/local/sbin/drift-check [--fix]** that:\n\n- prints \`DRIFT <path>\` for each managed file whose live content no longer matches the manifest, and \`OK <path>\` for the others;\n- with **--fix**, copies the golden version back over each drifted file and logs \`fixed <path>\` with \`logger -t drift-check\`;\n- exits **1** if drift was found (even when fixed), **0** otherwise.`,
        steps: ['sha256sum -c MANIFEST prints "PATH: OK" or "PATH: FAILED" for each line.', 'Parse that output, or loop over the manifest lines yourself.', 'Golden copy of /etc/x is /srv/golden/etc/x: cp "/srv/golden$path" "$path".'],
        tips: ['sha256sum -c /srv/golden/MANIFEST.sha256 2>/dev/null', 'while read -r sum path; do ... done < /srv/golden/MANIFEST.sha256', 'logger -t drift-check "fixed $path"'],
      }),
      hints: ['The manifest is what "approved" means; keep it in version control with the golden files.', 'Report first, fix second: a drift may be an emergency fix that should go back into the golden copy.'],
      initialState: linux(net, { files: { ...Object.fromEntries(files.map((p) => [`/srv/golden${p}`, gold(p)])), ...Object.fromEntries(files.map((p) => [p, drifted.includes(p) ? gold(p) + 'edited_by_hand = yes\n' : gold(p)])) } }),
      solution: [`cd /srv/golden && for p in ${files.join(' ')}; do sha256sum "/srv/golden$p" | sed "s#/srv/golden##"; done > /srv/golden/MANIFEST.sha256`, writeScript('/usr/local/sbin/drift-check', 'fix=\n[ "${1:-}" = --fix ] && fix=1\nrc=0\nwhile read -r sum path; do\n  if [ "$(sha256sum "$path" | cut -d" " -f1)" = "$sum" ]; then\n    echo "OK $path"\n  else\n    echo "DRIFT $path"\n    rc=1\n    if [ -n "$fix" ]; then\n      cp "/srv/golden$path" "$path"\n      logger -t drift-check "fixed $path"\n    fi\n  fi\ndone < /srv/golden/MANIFEST.sha256\nexit $rc\n'), 'drift-check', 'drift-check --fix', 'drift-check'],
      checks: [
        out('Drift is reported', '/usr/local/sbin/drift-check; echo "rc=$?"', { contains: ['rc=0', ...files.map((p) => `OK ${p}`)] }),
        out('The drifted files were restored', drifted.map((p) => `cmp -s ${p} /srv/golden${p} && echo same`).join('; '), { equals: drifted.map(() => 'same').join('\n') }),
        out('Each fix was logged', 'grep drift-check /var/log/messages', { contains: drifted.map((p) => `fixed ${p}`) }),
        out('New drift is detected with exit code 1', `echo tampered >> ${files[3]}; /usr/local/sbin/drift-check; echo "rc=$?"`, { contains: [`DRIFT ${files[3]}`, 'rc=1'] }),
      ],
      realityNote: 'Drift is the reason configuration management runs continuously; tools like Puppet, AIDE and osquery report exactly these OK/DRIFT lines.',
    };
  }),

  /* ---------------------------------------------------------------- 6.4 desired-state tools */
  tmpl(6, 4, 'beginner', 'declarative-or-imperative', 'Choose between declarative and imperative automation', 'E10', 15, 'Decide how desired-state tools, inventories, idempotency and drift apply to everyday situations.', (v) => {
    const n = v.int(20, 60);
    return caseStudy(v, {
      intro: `## ${n} lab machines and one administrator\n\nYour team is moving from hand-run scripts to a desired-state tool (Ansible, Puppet or DSC). Decide how to approach each situation.`,
      steps: [
        { title: 'Describing a server', text: 'A colleague writes: "run apt install nginx, then edit nginx.conf, then restart". Another writes: "nginx is installed, nginx.conf has this content, nginx is running".', choices: [{ text: 'The second is declarative: it states the end result, so the tool can check and only act on differences', right: true, feedback: 'Correct. Declarative descriptions can be re-applied safely.' }, { text: 'They are the same thing written differently', feedback: 'The first is a sequence of actions; re-running it repeats them blindly.' }, { text: 'Imperative is always better because it is explicit', feedback: 'Explicit steps are useful, but they do not tell you whether the system is already right.' }] },
        { title: 'Running twice', text: `The playbook ran on all ${n} machines last night. Someone runs it again this morning.`, choices: [{ text: 'Nothing should change: tasks report "ok", not "changed", on machines already in the desired state', right: true, feedback: 'Correct. That is idempotency, and "changed=0" on a re-run is how you check it.' }, { text: 'Every package is reinstalled', feedback: 'A well-written playbook checks state first.' }, { text: 'It fails because the users already exist', feedback: 'That would be a non-idempotent task: fix the task.' }] },
        { title: 'The inventory', text: 'Machines are added and retired every term.', choices: [{ text: 'Keep them in an inventory grouped by role (labs, staff, servers) and target groups, not names', right: true, feedback: 'Correct. The inventory is data; playbooks stay the same.' }, { text: 'List host names inside each playbook', feedback: 'Then every change to the fleet means editing code.' }, { text: 'Run against the whole subnet each time', feedback: 'You would configure printers and phones too.' }] },
        { title: 'A hand edit', text: 'A technician edits /etc/chrony.conf on one lab machine to fix a time problem.', choices: [{ text: 'The next run reverts it; if the fix is right, put it into the managed template so it applies everywhere', right: true, feedback: 'Correct. The managed description is the source of truth.' }, { text: 'Exclude that machine from management forever', feedback: 'One special machine becomes many.' }, { text: 'Edit all machines by hand the same way', feedback: 'That is the drift the tool exists to prevent.' }] },
        { title: 'One-off work', text: 'You need to collect the BIOS versions of all machines once.', choices: [{ text: 'An ad-hoc command or a one-off script is fine: it gathers facts and changes no state', right: true, feedback: 'Correct. Not everything needs to be a declarative role.' }, { text: 'Write a full role with handlers and templates', feedback: 'Overkill for a read-only, one-time question.' }, { text: 'Log in to each machine', feedback: `${n} logins is the work automation removes.` }] },
      ],
      ending: { title: 'Ready for desired state', text: 'Declare the end state, keep the fleet in an inventory, expect changed=0 on re-runs, fix drift at the source, and use ad-hoc commands for one-off questions.' },
      hints: ['Ask: does re-running this change anything on a correct machine?', 'Data (inventory, variables) and logic (playbooks, roles) belong in different places.'],
      realityNote: 'Ansible playbooks, Puppet manifests, Salt states and PowerShell DSC configurations all share these ideas, which is why they transfer between tools.',
    });
  }),
  tmpl(6, 4, 'intermediate', 'converge-script', 'Write a small desired-state script', 'E4', 30, 'Read desired packages and services from data files, change only what differs, and report ok/changed like Ansible.', (v) => {
    const net = v.net();
    const wantPkgs = v.some(['apache2', 'git', 'tree', 'rsync', 'zip'], 3);
    const installedAlready = wantPkgs[0];
    const services = wantPkgs.includes('apache2') ? ['apache2', 'sshd'] : ['sshd', 'cron'];
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/converge** that makes this server match two data files and reports like a desired-state tool:\n\n- **/etc/desired/packages** (one package per line): install each missing package;\n- **/etc/desired/services** (one service per line): enable and start each one that is not already enabled and active.\n\nFor every item print \`ok: <item>\` (already right) or \`changed: <item>\`, and finish with \`summary: ok=N changed=M\`. Running it a second time must report **changed=0**.`,
        steps: ['rpm -q PKG >/dev/null 2>&1 tells you if a package is installed.', 'systemctl is-enabled --quiet and is-active --quiet test a service.', 'Count with two variables; read the files with while read -r.'],
        tips: ['while read -r p; do [ -n "$p" ] || continue; ... done < /etc/desired/packages', 'zypper --non-interactive install "$p" >/dev/null', 'systemctl enable --now "$s" >/dev/null'],
      }),
      hints: ['The data files are the "what"; the script is the "how". Adding a package means editing data, not code.', 'Check, then act: that is what makes the second run report changed=0.'],
      initialState: linux(net, { packages: { [installedAlready]: { installed: true }, ...(installedAlready === 'apache2' ? {} : { apache2: { installed: true } }) }, services: services.includes('apache2') ? { apache2: { active: false, enabled: false, package: 'apache2' } } : {}, files: { '/etc/desired/packages': wantPkgs.join('\n') + '\n', '/etc/desired/services': services.join('\n') + '\n' } }),
      checks: [
        ...wantPkgs.map((p) => pkg(`${p} is installed`, p)),
        ...services.map((s) => svc(`${s} is enabled and running`, s, { active: true, enabled: true })),
        script('A second run changes nothing', '/usr/local/sbin/converge', { status: 0, contains: `summary: ok=${wantPkgs.length + services.length} changed=0` }),
        out('The first run reported what it changed', 'cat /root/first-run.txt 2>/dev/null', { contains: [`ok: ${installedAlready}`, `changed: ${wantPkgs[1]}`] }),
      ],
      solution: [writeScript('/usr/local/sbin/converge', 'ok=0 changed=0\nwhile read -r p; do\n  [ -n "$p" ] || continue\n  if rpm -q "$p" >/dev/null 2>&1; then echo "ok: $p"; ok=$((ok + 1))\n  else zypper --non-interactive install "$p" >/dev/null; echo "changed: $p"; changed=$((changed + 1)); fi\ndone < /etc/desired/packages\nwhile read -r s; do\n  [ -n "$s" ] || continue\n  if systemctl is-enabled --quiet "$s" && systemctl is-active --quiet "$s"; then echo "ok: $s"; ok=$((ok + 1))\n  else systemctl enable --now "$s" >/dev/null; echo "changed: $s"; changed=$((changed + 1)); fi\ndone < /etc/desired/services\necho "summary: ok=$ok changed=$changed"\n'), 'converge | tee /root/first-run.txt', 'converge'],
      realityNote: 'The ok/changed/failed summary at the end of every Ansible run is exactly this; changed=0 on a second run is the standard idempotency test.',
    };
  }),
  tmpl(6, 4, 'advanced', 'test-set-powershell', 'Build Test/Set desired-state functions in PowerShell', 'E4', 30, 'Write Test- and Set- functions over a configuration hashtable, the pattern DSC resources use.', (v) => {
    const net = v.net();
    const want = v.some(Object.keys({ Spooler: 1, W32Time: 1, BITS: 1, WinRM: 1 }), 3);
    const startType: Record<string, string> = Object.fromEntries(want.map((s, i) => [s, i === 0 ? 'Manual' : 'Automatic']));
    const dirs = [`C:\\Data\\${v.pick(['Reports', 'Exports', 'Uploads'])}`, 'C:\\Scripts\\Logs'];
    const services = dcServices({ BITS: STOPPED_MANUAL, Spooler: { status: 'Stopped', start: 'Disabled' }, W32Time: RUNNING, WinRM: RUNNING });
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\ServerState.ps1** defining:\n\n- **$Desired**: a hashtable with \`Services\` (name → StartType: ${want.map((s) => `${s} = ${startType[s]}`).join(', ')}, and all of them Running) and \`Folders\` (${dirs.join(', ')});\n- **Test-ServerState**: returns one object per item with **Item** and **InDesiredState** ($true/$false), changing nothing;\n- **Set-ServerState** (SupportsShouldProcess): fixes only the items that are not in the desired state and outputs \`set <item>\` for each.\n\nDot-source it, run Test, then Set, then Test again (everything should be $true).`,
        steps: ['Test: for each service compare (Get-Service).StartType and .Status; for each folder Test-Path.', 'Set: Set-Service -StartupType, Start-Service, New-Item -ItemType Directory, each inside ShouldProcess.', 'Item names like "Service:Spooler" and "Folder:C:\\Data\\..." keep the output readable.'],
        tips: ["$Desired = @{ Services = @{ Spooler = 'Automatic' }; Folders = @('C:\\Data') }", "[pscustomobject]@{ Item = \"Service:$name\"; InDesiredState = $ok }", "Set-Service -Name $n -StartupType $t; Start-Service -Name $n"],
      }),
      hints: ['Test never changes anything: that is what makes it safe to run as a compliance report.', 'Set calls Test (or repeats its checks) so it only touches what differs.'],
      initialState: windows({ machines: [dc01(net, { services })] }),
      checks: [
        ps('After Set, everything is in the desired state', '. C:\\Scripts\\ServerState.ps1; @(Test-ServerState | Where-Object { -not $_.InDesiredState }).Count', { equals: '0' }),
        ...want.map((s) => ps(`${s} is ${startType[s]} and running`, `$x = Get-Service ${s}; "$($x.StartType) $($x.Status)"`, { equals: `${startType[s]} Running` })),
        ...dirs.map((d) => ps(`${d} exists`, `Test-Path ${d}`, { equals: 'True' })),
        ps('Set changes nothing when all is right', '. C:\\Scripts\\ServerState.ps1; @(Set-ServerState).Count', { equals: '0' }),
        ps('Test reports drift without fixing it', `. C:\\Scripts\\ServerState.ps1; Stop-Service ${want[1]}; $r = Test-ServerState | Where-Object Item -eq 'Service:${want[1]}'; "$($r.InDesiredState) $((Get-Service ${want[1]}).Status)"`, { equals: 'False Stopped' }),
      ],
      solution: [psWrite('C:\\Scripts\\ServerState.ps1', `$Desired = @{\n    Services = @{ ${want.map((s) => `${s} = '${startType[s]}'`).join('; ')} }\n    Folders  = @(${dirs.map((d) => `'${d}'`).join(', ')})\n}\nfunction Test-ServerState {\n    foreach ($n in $Desired.Services.Keys) {\n        $s = Get-Service -Name $n\n        [pscustomobject]@{ Item = "Service:$n"; InDesiredState = ($s.StartType -eq $Desired.Services[$n] -and $s.Status -eq 'Running') }\n    }\n    foreach ($d in $Desired.Folders) {\n        [pscustomobject]@{ Item = "Folder:$d"; InDesiredState = (Test-Path $d) }\n    }\n}\nfunction Set-ServerState {\n    [CmdletBinding(SupportsShouldProcess)]\n    param()\n    foreach ($t in Test-ServerState | Where-Object { -not $_.InDesiredState }) {\n        if (-not $PSCmdlet.ShouldProcess($t.Item, 'Set desired state')) { continue }\n        $kind, $name = $t.Item -split ':', 2\n        if ($kind -eq 'Service') {\n            Set-Service -Name $name -StartupType $Desired.Services[$name]\n            Start-Service -Name $name\n        } else {\n            New-Item -ItemType Directory -Path $name -Force | Out-Null\n        }\n        "set $($t.Item)"\n    }\n}`), '. C:\\Scripts\\ServerState.ps1', 'Test-ServerState', 'Set-ServerState', 'Test-ServerState'],
      realityNote: 'Every PowerShell DSC resource is a Get/Test/Set trio like this; the LCM runs Test on a schedule and Set when something has drifted.',
    };
  }),

  /* ---------------------------------------------------------------- 6.5 containers */
  tmpl(6, 5, 'beginner', 'run-a-container', 'Run a web server in a container', 'E4', 15, 'Start an nginx container detached, publish a port, serve a folder read-only and set a restart policy.', (v) => {
    const net = v.net();
    const port = v.pick([8080, 8081, 8088]);
    const name = v.pick(['notices', 'timetable', 'library-hours']);
    return {
      instructions: lab({
        situation: `Serve the static site in **/srv/${name}** with the official **nginx:1.27** image: container name **${name}**, running **in the background**, host port **${port}** to container port 80, the folder mounted **read-only** at /usr/share/nginx/html, and restarted automatically unless someone stops it. Docker is installed and running.`,
        steps: ['docker run -d --name ... -p HOST:CONTAINER -v SRC:DEST:ro --restart unless-stopped nginx:1.27', 'docker ps shows it; curl http://localhost:' + port + ' fetches the page.', 'docker logs ' + name + ' shows nginx starting.'],
        tips: [`docker run -d --name ${name} -p ${port}:80 -v /srv/${name}:/usr/share/nginx/html:ro --restart unless-stopped nginx:1.27`, 'docker ps', `curl -s http://localhost:${port}`],
      }),
      hints: ['Without -d the container holds your terminal.', 'A read-only mount stops a compromised web server from changing the site.'],
      initialState: linux(net, { packages: { docker: { installed: true } }, services: { docker: { active: true, enabled: true, package: 'docker' } }, files: { [`/srv/${name}/index.html`]: `<h1>${name}</h1>\n` } }),
      checks: [
        out('The container is running with the port', 'docker ps', { contains: [name, `0.0.0.0:${port}->80/tcp`] }),
        out('The site is served', `curl -s http://localhost:${port}`, { contains: `<h1>${name}</h1>` }),
        out('The restart policy and read-only mount are set', `docker inspect ${name}`, { contains: ['unless-stopped', '/usr/share/nginx/html'] }),
      ],
      solution: [`docker run -d --name ${name} -p ${port}:80 -v /srv/${name}:/usr/share/nginx/html:ro --restart unless-stopped nginx:1.27`, 'docker ps', `curl -s http://localhost:${port}`],
      realityNote: 'Containers make "the same software, the same way, on any host" cheap: the image pins the version, the run command is the whole deployment.',
    };
  }),
  tmpl(6, 5, 'intermediate', 'build-tool-image', 'Package a script as a container image', 'E4', 25, 'Write a Dockerfile that copies a shell tool into an image, sets its environment and command, and run it.', (v) => {
    const net = v.net();
    const tool = v.pick(['disk-report', 'room-check', 'site-ping']);
    const site = v.pick(['Main Campus', 'City Campus', 'Annex']);
    const ver = `1.${v.int(0, 9)}`;
    return {
      instructions: lab({
        situation: `**/srv/${tool}/${tool}.sh** is a small report tool. Package it as the image **lab/${tool}:${ver}** so anyone can run it the same way:\n\n- base image **alpine:3.20**;\n- copy the script to **/usr/local/bin/${tool}.sh**;\n- set the environment variable **SITE** to \`${site}\` by default;\n- make the script the image's command, so \`docker run --rm lab/${tool}:${ver}\` runs it.\n\nBuild it, run it once with the default and once with \`-e SITE=Remote\`.`,
        steps: ['Write /srv/' + tool + '/Dockerfile with FROM, COPY, ENV and CMD.', `docker build -t lab/${tool}:${ver} /srv/${tool}`, `docker run --rm lab/${tool}:${ver}`],
        tips: ['FROM alpine:3.20\nCOPY TOOL.sh /usr/local/bin/TOOL.sh\nENV SITE="Main Campus"\nCMD ["/usr/local/bin/TOOL.sh"]', 'docker images'],
      }),
      hints: ['The exec form CMD ["/path"] runs the program directly; the script needs a #!/bin/sh line.', 'Tag images with a version, not just latest, so you can roll back.'],
      initialState: linux(net, { packages: { docker: { installed: true } }, services: { docker: { active: true, enabled: true, package: 'docker' } }, files: { [`/srv/${tool}/${tool}.sh`]: { content: `#!/bin/sh\necho "${tool} for \${SITE:-unknown}"\n`, mode: '755' } } }),
      checks: [
        out('The image exists with its tag', 'docker images', { contains: ['lab/' + tool, ver] }),
        out('It runs the tool with the default site', `docker run --rm lab/${tool}:${ver}`, { equals: `${tool} for ${site}` }),
        out('The environment can be overridden', `docker run --rm -e SITE=Remote lab/${tool}:${ver}`, { equals: `${tool} for Remote` }),
        file('The Dockerfile uses alpine:3.20', `/srv/${tool}/Dockerfile`, { contains: ['FROM alpine:3.20', 'COPY', 'ENV SITE', 'CMD'] }),
      ],
      solution: [write(`/srv/${tool}/Dockerfile`, `FROM alpine:3.20\nCOPY ${tool}.sh /usr/local/bin/${tool}.sh\nENV SITE="${site}"\nCMD ["/usr/local/bin/${tool}.sh"]\n`), `docker build -t lab/${tool}:${ver} /srv/${tool}`, `docker run --rm lab/${tool}:${ver}`, `docker run --rm -e SITE=Remote lab/${tool}:${ver}`],
      realityNote: 'Shipping admin tools as images removes "works on my laptop": the interpreter, libraries and script travel together.',
    };
  }),
  tmpl(6, 5, 'advanced', 'compose-stack', 'Describe a stack with Docker Compose', 'E4', 30, 'Write a compose file for a web front end and a database with ports, environment, volumes, dependencies and restart policies.', (v) => {
    const net = v.net();
    const proj = v.pick(['library', 'helpdesk', 'clubs']);
    const port = v.pick([8090, 8085, 8070]);
    const pw = `${v.pick(['Kente', 'Volta', 'Sankofa'])}-${v.int(1000, 9999)}`;
    return {
      instructions: lab({
        situation: `Describe the **${proj}** stack in **/srv/${proj}/compose.yaml** and start it:\n\n- service **web**: image **nginx:1.27**, host port **${port}** → 80, the folder **./site** mounted read-only at /usr/share/nginx/html, starts **after db**, restart unless-stopped;\n- service **db**: image **postgres:16**, environment POSTGRES_PASSWORD (use \`${pw}\`), a **named volume dbdata** at /var/lib/postgresql/data, restart unless-stopped;\n- declare the **dbdata** volume.\n\nStart it in the background with \`docker compose up -d\` and check both containers.`,
        steps: ['services: with web and db; ports, volumes, environment, depends_on, restart.', 'A top-level volumes: section declares dbdata.', `cd /srv/${proj}; docker compose up -d; docker compose ps`, `curl -s http://localhost:${port}`],
        tips: [`services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "${port}:80"\n    volumes:\n      - ./site:/usr/share/nginx/html:ro\n    depends_on:\n      - db\n    restart: unless-stopped\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: CHANGE-ME\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    restart: unless-stopped\nvolumes:\n  dbdata:`],
      }),
      hints: ['YAML indentation is meaning: two spaces per level, no tabs.', 'A named volume survives docker compose down; add -v to remove it.'],
      initialState: linux(net, { packages: { docker: { installed: true } }, services: { docker: { active: true, enabled: true, package: 'docker' } }, files: { [`/srv/${proj}/site/index.html`]: `<h1>${proj} portal</h1>\n` } }),
      checks: [
        out('Both containers run', `cd /srv/${proj}; docker compose ps`, { contains: [`${proj}-web-1`, `${proj}-db-1`, `0.0.0.0:${port}->80/tcp`] }),
        out('The site is served', `curl -s http://localhost:${port}`, { contains: `<h1>${proj} portal</h1>` }),
        out('The database started with its password', `cd /srv/${proj}; docker compose logs db`, { contains: 'ready to accept connections' }),
        out('The named volume exists', 'docker volume ls', { contains: `${proj}_dbdata` }),
        file('Restart policies and the dependency are declared', `/srv/${proj}/compose.yaml`, { contains: ['depends_on', 'unless-stopped', 'dbdata'] }),
      ],
      solution: [write(`/srv/${proj}/compose.yaml`, `services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "${port}:80"\n    volumes:\n      - ./site:/usr/share/nginx/html:ro\n    depends_on:\n      - db\n    restart: unless-stopped\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${pw}\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    restart: unless-stopped\nvolumes:\n  dbdata:\n`), `cd /srv/${proj} && docker compose up -d`, `cd /srv/${proj} && docker compose ps`],
      realityNote: 'A compose file is a small desired-state description: re-running docker compose up only changes what differs, and the file goes into version control.',
    };
  }),

  /* ---------------------------------------------------------------- 6.6 calling REST APIs */
  tmpl(6, 6, 'beginner', 'curl-jq-token', 'Call an API with a token and parse JSON', 'E4', 20, 'Send an authenticated GET with curl and extract fields with jq.', (v) => {
    const net = v.net();
    const token = `lab-${v.int(100000, 999999)}`;
    const people = v.people(5).map((p, i) => ({ id: i + 1, username: p.sam, name: p.name, department: v.dept(), active: i !== 2 }));
    const active = people.filter((p) => p.active).map((p) => p.username).sort();
    return {
      instructions: lab({
        situation: `The staff directory has a REST API at **http://api.campus.lan:8080/api/**. Every request needs the header \`Authorization: Bearer ${token}\` (the token is also in /root/.api-token). Using **curl** and **jq** (install jq if needed), write the usernames of **active** staff, sorted, one per line, to **/root/active.txt**.`,
        steps: ['curl -s -H "Authorization: Bearer $(cat /root/.api-token)" http://api.campus.lan:8080/api/staff', "jq -r '.[] | select(.active) | .username'", 'sort > /root/active.txt'],
        tips: ['curl -s -H "Authorization: Bearer $TOKEN" URL', "jq -r '.[] | select(.active) | .username'", 'curl -s -o /dev/null -w "%{http_code}\\n" URL   (status code only)'],
      }),
      hints: ['Without the header the API answers 401 Unauthorized.', 'jq -r prints strings without quotes.'],
      initialState: linux(net, { files: { '/var/lib/labapi/api.json': apiState({ token, resources: { staff: people } }), '/root/.api-token': { content: token + '\n', mode: '600' } } as never }),
      checks: [file('The active usernames are listed, sorted', '/root/active.txt', { equals: active.join('\n') }), out('jq is installed', 'jq --version', { contains: 'jq-' })],
      solution: ['zypper --non-interactive install jq', 'curl -s -H "Authorization: Bearer $(cat /root/.api-token)" http://api.campus.lan:8080/api/staff | jq -r \'.[] | select(.active) | .username\' | sort > /root/active.txt', 'cat /root/active.txt'],
      realityNote: 'Keeping the token in a mode-600 file (or a secret store) and reading it at run time keeps it out of shell history and scripts.',
    };
  }),
  tmpl(6, 6, 'intermediate', 'irm-create-from-csv', 'Create records through an API with PowerShell', 'E4', 25, 'POST JSON bodies with Invoke-RestMethod, handle 409 Conflict per item, and report results.', (v) => {
    const net = v.net();
    const token = `ps-${v.int(100000, 999999)}`;
    const rooms = v.some(['LAB-1', 'LAB-2', 'LAB-3', 'LIB-A', 'LIB-B', 'HALL-1', 'SEM-4'], 5);
    const existing = rooms.slice(0, 2);
    return {
      instructions: lab({
        situation: `Register the rooms in **C:\\Data\\rooms.csv** (Code, Building, Seats) with the bookings API at **http://api.campus.lan:8080/api/rooms** (header \`Authorization: Bearer ${token}\`). POST each room as JSON with the fields **code**, **building** and **seats** (seats as a number). Some rooms already exist: the API answers **409 Conflict** for those, which is fine. Print \`created <code>\` or \`exists <code>\` for each, and nothing else.`,
        steps: ['$headers = @{ Authorization = "Bearer ..." }', "$body = @{ code = $r.Code; building = $r.Building; seats = [int]$r.Seats } | ConvertTo-Json", 'Invoke-RestMethod -Method Post -Uri ... -Headers $headers -ContentType application/json -Body $body', 'try/catch: $_.Exception.Response.StatusCode tells you it was 409.'],
        tips: ["try { Invoke-RestMethod ... -ErrorAction Stop; \"created $($r.Code)\" } catch { if ($_.Exception.Response.StatusCode -eq 409) { \"exists $($r.Code)\" } else { throw } }"],
      }),
      hints: ['Invoke-RestMethod throws for 4xx and 5xx answers; catch the one you expect and let others surface.', 'Without -ContentType application/json the API answers 415.'],
      initialState: windows({ machines: [dc01(net)], files: { '/var/lib/labapi/api.json': apiState({ token, unique: { rooms: 'code' }, resources: { rooms: existing.map((c, i) => ({ id: i + 1, code: c, building: 'Main', seats: 30 })) } }), 'C:\\Data\\rooms.csv': csv('Code,Building,Seats', rooms.map((c) => [c, v.pick(['Main', 'Annex', 'Library']), v.int(12, 80)])) } }),
      checks: [
        ps('Every room exists in the API', `(Invoke-RestMethod -Uri http://api.campus.lan:8080/api/rooms -Headers @{ Authorization = 'Bearer ${token}' } | ForEach-Object code | Sort-Object) -join ','`, { equals: [...rooms].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join(',') }),
        ps('Seats are numbers', `(Invoke-RestMethod -Uri http://api.campus.lan:8080/api/rooms -Headers @{ Authorization = 'Bearer ${token}' } | Where-Object code -eq '${rooms[3]}').seats -is [int]`, { equals: 'True' }),
        ran('POSTs were sent', 'Invoke-RestMethod[^\\n]*-Method\\s+Post|Invoke-RestMethod[^\\n]*-Method\\s+POST'),
      ],
      solution: [`$headers = @{ Authorization = 'Bearer ${token}' }`, "foreach ($r in Import-Csv C:\\Data\\rooms.csv) {\n    $body = @{ code = $r.Code; building = $r.Building; seats = [int]$r.Seats } | ConvertTo-Json\n    try {\n        Invoke-RestMethod -Method Post -Uri http://api.campus.lan:8080/api/rooms -Headers $headers -ContentType 'application/json' -Body $body -ErrorAction Stop | Out-Null\n        \"created $($r.Code)\"\n    } catch {\n        if ($_.Exception.Response.StatusCode -eq 409) { \"exists $($r.Code)\" } else { throw }\n    }\n}"],
      realityNote: 'Treating "already exists" as success is what makes an API sync script safe to re-run, the same idempotency idea as in configuration management.',
    };
  }),
  tmpl(6, 6, 'advanced', 'retries-and-pages', 'Fetch every page with retries', 'E4', 30, 'Follow pagination links and retry 503 answers with backoff, collecting all records into one file.', (v) => {
    const net = v.net();
    const token = `pg-${v.int(100000, 999999)}`;
    const n = v.int(11, 17);
    const size = v.pick([4, 5]);
    const devices = Array.from({ length: n }, (_, i) => ({ id: i + 1, tag: `PC-${String(1000 + i * 7)}`, room: v.pick(['LAB-1', 'LAB-2', 'LIB-A']), os: v.pick(['Windows 11', 'Windows 10', 'openSUSE 15.6']) }));
    const fails = v.int(2, 3);
    return {
      instructions: lab({
        situation: `The asset API at **http://api.campus.lan:8080/api/devices** returns devices in **pages**: \`{"items": [...], "page": 1, "total_pages": N, "next": "/api/devices?page=2"}\`, and is overloaded: it sometimes answers **503 Service Unavailable**. Write **/usr/local/bin/fetch-devices** (bash, curl, jq) that:\n\n1. starts at /api/devices and follows \`next\` until it is null;\n2. retries a 503 up to **5** times with a growing wait (1, 2, 4… seconds; \`sleep\` is fine);\n3. writes every device as one JSON line (\`jq -c '.items[]'\`) to **/var/lib/assets/devices.jsonl**;\n4. exits **1** if a page still fails after 5 attempts.\n\nThe token is in /root/.api-token. jq is installed.`,
        steps: ['curl -s -w "\\n%{http_code}" separates the body from the status code.', 'A retry loop: for attempt in 1 2 3 4 5; do ...; [ "$code" = 200 ] && break; sleep $delay; delay=$((delay * 2)); done', 'next=$(echo "$body" | jq -r .next); stop when it is null.'],
        tips: ['resp=$(curl -s -H "Authorization: Bearer $T" -w "\\n%{http_code}" "$base$path")', 'code=${resp##*$\'\\n\'}; body=${resp%$\'\\n\'*}', "echo \"$body\" | jq -c '.items[]' >> OUT"],
      }),
      hints: ['Never retry 4xx errors: they will not get better. 503 and 429 are meant to be retried.', 'Back off exponentially so a struggling server gets time to recover.'],
      initialState: linux(net, { packages: { jq: { installed: true } }, files: { '/var/lib/labapi/api.json': apiState({ token, failNext: fails, pageSize: size, resources: { devices } }), '/root/.api-token': { content: token + '\n', mode: '600' }, '/var/lib/assets/': null } as never }),
      checks: [
        out('Every device was fetched exactly once', "jq -r '.tag' /var/lib/assets/devices.jsonl | sort | uniq | wc -l; wc -l < /var/lib/assets/devices.jsonl", { equals: `${n}\n${n}` }),
        out('The records are complete JSON', `jq -r 'select(.tag == "${devices[n - 1].tag}") | .room' /var/lib/assets/devices.jsonl`, { equals: devices[n - 1].room }),
        out('It retried after 503s', 'grep -c " 503$" <<< "$(jq -r \'.log[]\' /var/lib/labapi/api.json)"', { pattern: '^[1-9]' }),
        script('A run against a healthy API succeeds', '/usr/local/bin/fetch-devices', { status: 0 }),
      ],
      solution: [writeScript('/usr/local/bin/fetch-devices', `T=$(cat /root/.api-token)\nbase=http://api.campus.lan:8080\nout=/var/lib/assets/devices.jsonl\n: > "$out"\npath=/api/devices\nwhile [ -n "$path" ] && [ "$path" != null ]; do\n  delay=1\n  for attempt in 1 2 3 4 5; do\n    resp=$(curl -s -H "Authorization: Bearer $T" -w "\\n%{http_code}" "$base$path")\n    code=\${resp##*$'\\n'}\n    body=\${resp%$'\\n'*}\n    [ "$code" = 200 ] && break\n    sleep "$delay"\n    delay=$((delay * 2))\n  done\n  [ "$code" = 200 ] || { echo "giving up on $path (HTTP $code)" >&2; exit 1; }\n  echo "$body" | jq -c '.items[]' >> "$out"\n  path=$(echo "$body" | jq -r '.next')\ndone\n`), 'fetch-devices', 'wc -l /var/lib/assets/devices.jsonl'],
      realityNote: 'Pagination and polite retries (exponential backoff, honouring Retry-After) are expected of every API client; most API rate limits assume them.',
    };
  }),
];
