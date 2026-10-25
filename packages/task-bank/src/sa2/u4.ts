/** Unit 4: shell scripts. */

import type { TaskTemplate } from '../types';
import { DEPTS, caseStudy, cron, file, group, lab, linux, out, script, svc, tmpl, user } from './kit';

const SH = (body: string) => `#!/bin/bash\n${body}`;

export const U4: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 4.1 variables, arguments, exit codes, conditionals, loops, functions */
  tmpl(4, 1, 'beginner', 'first-script', 'Write a script with an argument and exit codes', 'E4', 15, 'Create an executable script that uses $1, checks it and returns proper exit codes.', (v) => {
    const net = v.net();
    const name = v.pick(['greet', 'welcome', 'hello']);
    const word = v.pick(['Hello', 'Welcome', 'Akwaaba']);
    return {
      instructions: lab({ situation: `Write **/usr/local/bin/${name}**. Run as \`${name} Ama\` it prints exactly \`${word}, Ama!\` and exits 0. Run with no argument it prints \`usage: ${name} NAME\` and exits **2**. Make it executable so it runs by name from anywhere.`, steps: ['Start with the shebang #!/bin/bash.', 'Test the number of arguments with [ $# -eq 0 ].', 'Print with echo and exit with the right code.', 'chmod +x and try both cases; echo $? shows the exit code.'], tips: ["cat > /usr/local/bin/NAME <<'EOF'", 'if [ $# -eq 0 ]; then echo "usage: ..."; exit 2; fi', 'chmod +x /usr/local/bin/NAME', 'echo $?'] }),
      hints: ['Exit code 0 means success; anything else signals a kind of failure.', 'Quote "$1" so names with spaces work.'],
      initialState: linux(net),
      checks: [script('It greets by name', `/usr/local/bin/${name}`, { args: ['Ama'], status: 0, equals: `${word}, Ama!` }), script('It handles a name with spaces', `/usr/local/bin/${name}`, { args: ['Kofi Boateng'], equals: `${word}, Kofi Boateng!` }), script('No argument: usage and exit 2', `/usr/local/bin/${name}`, { status: 2, contains: `usage: ${name} NAME` })],
      solution: [`cat > /usr/local/bin/${name} <<'EOF'\n${SH(`if [ $# -eq 0 ]; then\n  echo "usage: ${name} NAME"\n  exit 2\nfi\necho "${word}, $1!"\n`)}EOF`, `chmod +x /usr/local/bin/${name}`, `${name} Ama`],
      realityNote: 'Distinct exit codes let other scripts, cron and systemd tell success from each kind of failure.',
    };
  }),
  tmpl(4, 1, 'intermediate', 'service-check', 'Loop over arguments to check services', 'E4', 20, 'Write a script that checks each named service and returns failure if any is down.', (v) => {
    const net = v.net();
    const up = v.some(['sshd', 'cron', 'firewalld'], 2);
    const down = v.pick(['apache2', 'named', 'mariadb']);
    const pkgs: Record<string, string> = { apache2: 'apache2', named: 'bind', mariadb: 'mariadb' };
    return {
      instructions: lab({ situation: 'Write **/usr/local/bin/svccheck** that takes service names as arguments and, for each one, prints `NAME: active` or `NAME: inactive` (using systemctl is-active). It exits **0** if all are active and **1** if any is not. On this server some services are down, so test it.', steps: ['Loop with for svc in "$@".', 'Use systemctl is-active --quiet or capture its output.', 'Remember whether anything failed and exit accordingly.'], tips: ['for svc in "$@"; do ... done', 'if systemctl is-active "$svc" >/dev/null; then ...; else ...; fi'] }),
      hints: ['"$@" keeps each argument separate.', 'Set a variable such as rc=1 when a service is inactive, then exit $rc at the end.'],
      initialState: linux(net, { packages: { [pkgs[down]]: { installed: true } }, services: { [down]: { active: false, enabled: true, package: pkgs[down] } } }),
      checks: [script('All active: exit 0', '/usr/local/bin/svccheck', { args: up, status: 0, contains: up.map((s) => `${s}: active`) }), script('One down: reports it and exits 1', '/usr/local/bin/svccheck', { args: [...up, down], status: 1, contains: [`${down}: inactive`, `${up[0]}: active`] })],
      solution: [`cat > /usr/local/bin/svccheck <<'EOF'\n${SH('rc=0\nfor svc in "$@"; do\n  if systemctl is-active "$svc" >/dev/null; then\n    echo "$svc: active"\n  else\n    echo "$svc: inactive"\n    rc=1\n  fi\ndone\nexit $rc\n')}EOF`, 'chmod +x /usr/local/bin/svccheck', `svccheck ${up.join(' ')} ${down}`],
      realityNote: 'Monitoring systems such as Nagios run exactly this kind of check script and read its exit code: 0 OK, non-zero problem.',
    };
  }),
  tmpl(4, 1, 'advanced', 'validated-account-script', 'Write a validating account-creation script with functions', 'E4', 25, 'Use functions, validation and distinct exit codes to create student accounts safely.', (v) => {
    const net = v.net();
    const grp = v.pick(['students', 'learners', 'cs-students']);
    const existing = String(v.int(10000000, 19999999));
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/mkstudent ID "FULL NAME"** to create student accounts named **s<ID>**:\n\n- ID must be exactly 8 digits, otherwise print an error and exit **3**.\n- If the account already exists, print an error and exit **4**.\n- Otherwise create it with a home directory, the full name as the comment and supplementary group **${grp}**, print \`created s<ID>\` and exit 0.\n\nUse at least one function (for example \`die\` that prints a message and exits with a code). Student s${existing} already exists.`,
        steps: ['Write a die() function.', 'Validate the ID (echo "$1" | grep -Eq \'^[0-9]{8}$\').', 'Check existence with id.', 'Create the account with useradd -m -c "$2" -G ' + grp + '.'],
        tips: ['die() { echo "$2" >&2; exit "$1"; }', "echo \"$1\" | grep -Eq '^[0-9]{8}$' || die 3 \"bad id\"", 'id "s$1" >/dev/null 2>&1 && die 4 "exists"'],
      }),
      hints: ['>&2 sends a message to standard error.', 'Always quote "$2": names contain spaces.'],
      initialState: linux(net, { groups: { [grp]: [] }, users: { [`s${existing}`]: { groups: [grp] } } }),
      checks: [script('A bad ID exits 3', '/usr/local/sbin/mkstudent', { args: ['12AB', 'Ama Mensah'], status: 3 }), script('An existing student exits 4', '/usr/local/sbin/mkstudent', { args: [existing, 'Someone'], status: 4 }), script('A new student is created', '/usr/local/sbin/mkstudent', { args: ['20260117', 'Kofi Boateng'], status: 0, contains: 'created s20260117', creates: '/home/s20260117' }), file('The script uses a function', '/usr/local/sbin/mkstudent', { pattern: '^\\s*(function\\s+)?[a-z_]+\\s*\\(\\)\\s*\\{' })],
      solution: [`cat > /usr/local/sbin/mkstudent <<'EOF'\n${SH(`die() {\n  echo "$2" >&2\n  exit "$1"\n}\n[ $# -eq 2 ] || die 3 "usage: mkstudent ID NAME"\necho "$1" | grep -Eq '^[0-9]{8}$' || die 3 "ID must be 8 digits"\nid "s$1" >/dev/null 2>&1 && die 4 "s$1 already exists"\nuseradd -m -c "$2" -G ${grp} "s$1"\necho "created s$1"\n`)}EOF`, 'chmod +x /usr/local/sbin/mkstudent', 'mkstudent 20260118 "Ama Owusu"'],
      realityNote: 'Validating input and failing with specific codes is what separates a script you can hand to the helpdesk from one only its author can use.',
    };
  }),

  /* ---------------------------------------------------------------- 4.2 here documents, command substitution, arithmetic */
  tmpl(4, 2, 'beginner', 'heredoc-config', 'Generate configuration files with a here document', 'E4', 20, 'Write a script that creates an Apache virtual host file and its document root from a template.', (v) => {
    const net = v.net();
    const site = v.pick(DEPTS);
    return {
      instructions: lab({ situation: `Creating department websites by hand leads to mistakes. Write **/usr/local/bin/mkvhost NAME** that creates **/srv/www/NAME/index.html** (containing \`NAME website\`) and **/etc/apache2/vhosts.d/NAME.conf** from a here document:\n\n\`\`\`\n<VirtualHost *:80>\n    ServerName NAME.campus.lan\n    DocumentRoot /srv/www/NAME\n</VirtualHost>\n\`\`\`\n\nThen run it for **${site}**.`, steps: ['In the script, use cat > FILE <<EOF ... EOF (unquoted EOF so $1 expands inside).', 'mkdir -p the document root.', `Run mkvhost ${site}.`], tips: ['cat > "/etc/apache2/vhosts.d/$1.conf" <<EOF', 'mkdir -p "/srv/www/$1"'] }),
      hints: ['With <<EOF variables expand; with <<\'EOF\' they stay literal.', 'When the script itself is written with a here document, quote the outer one so the inner $1 survives.'],
      initialState: linux(net, { files: { '/etc/apache2/vhosts.d/': null } }),
      checks: [script('It creates both files for a new name', '/usr/local/bin/mkvhost', { args: ['testsite'], status: 0, creates: ['/etc/apache2/vhosts.d/testsite.conf', '/srv/www/testsite/index.html'] }), file(`${site}.conf is right`, `/etc/apache2/vhosts.d/${site}.conf`, { contains: [`ServerName ${site}.campus.lan`, `DocumentRoot /srv/www/${site}`, '</VirtualHost>'] }), file(`The ${site} page exists`, `/srv/www/${site}/index.html`, { contains: `${site} website` })],
      solution: [`cat > /usr/local/bin/mkvhost <<'OUTER'\n${SH('mkdir -p "/srv/www/$1"\necho "$1 website" > "/srv/www/$1/index.html"\ncat > "/etc/apache2/vhosts.d/$1.conf" <<EOF\n<VirtualHost *:80>\n    ServerName $1.campus.lan\n    DocumentRoot /srv/www/$1\n</VirtualHost>\nEOF\n')}OUTER`, 'chmod +x /usr/local/bin/mkvhost', `mkvhost ${site}`],
      realityNote: 'Templating configuration with here documents is the shell ancestor of Jinja templates in Ansible and Salt.',
    };
  }),
  tmpl(4, 2, 'intermediate', 'directory-report', 'Report on a directory with command substitution and arithmetic', 'E4', 20, 'Count files and bytes with command substitution and compute an average with $(( )).', (v) => {
    const net = v.net();
    const n = v.int(4, 8);
    const sizes = Array.from({ length: n }, () => v.int(100, 2000));
    const total = sizes.reduce((a, b) => a + b, 0);
    return {
      instructions: lab({ situation: 'Write **/usr/local/bin/dirreport DIR** that prints three lines about the regular files in DIR (not subdirectories):\n\n```\nfiles: N\nbytes: B\naverage: A\n```\n\nwhere A is B divided by N, rounded down (shell integer arithmetic). If DIR has no files, print `average: 0`. Test it on **/srv/submissions**.', steps: ['Count with n=$(find "$1" -maxdepth 1 -type f | wc -l).', 'Sum the sizes, for example with a loop over the files and wc -c.', 'Compute with $(( b / n )), guarding against n = 0.'], tips: ['n=$(find "$1" -maxdepth 1 -type f | wc -l)', 'for f in "$1"/*; do [ -f "$f" ] && b=$(( b + $(wc -c < "$f") )); done', 'echo "average: $(( b / n ))"'] }),
      hints: ['$( ) captures a command\'s output; $(( )) does integer arithmetic.', 'Dividing by zero is an error: test n first.'],
      initialState: linux(net, { files: { ...Object.fromEntries(sizes.map((s, i) => [`/srv/submissions/work-${i + 1}.pdf`, 'x'.repeat(s)])), '/srv/submissions/late/': null, '/srv/empty/': null } }),
      checks: [script('The report is right for /srv/submissions', '/usr/local/bin/dirreport', { args: ['/srv/submissions'], status: 0, contains: [`files: ${n}`, `bytes: ${total}`, `average: ${Math.floor(total / n)}`] }), script('An empty directory gives average 0', '/usr/local/bin/dirreport', { args: ['/srv/empty'], contains: ['files: 0', 'average: 0'] })],
      solution: [`cat > /usr/local/bin/dirreport <<'EOF'\n${SH('n=0\nb=0\nfor f in "$1"/*; do\n  if [ -f "$f" ]; then\n    n=$(( n + 1 ))\n    b=$(( b + $(wc -c < "$f") ))\n  fi\ndone\necho "files: $n"\necho "bytes: $b"\nif [ "$n" -eq 0 ]; then\n  echo "average: 0"\nelse\n  echo "average: $(( b / n ))"\nfi\n')}EOF`, 'chmod +x /usr/local/bin/dirreport', 'dirreport /srv/submissions'],
      realityNote: 'Shell arithmetic is integer-only; for decimals scripts reach for bc or awk.',
    };
  }),
  tmpl(4, 2, 'advanced', 'csv-accounts', 'Create accounts from a CSV with a read loop', 'E4', 25, 'Read a CSV line by line, create missing groups and users, and print a summary.', (v) => {
    const net = v.net();
    const depts = v.some(DEPTS, 2);
    const people = v.people(4).map((p, i) => ({ p, d: depts[i % 2] }));
    const already = people[0];
    const csv = ['username,fullname,department', ...people.map((x) => `${x.p.sam},${x.p.name},${x.d}`)].join('\n') + '\n';
    return {
      instructions: lab({ situation: `HR sends **/root/new-staff.csv** (username,fullname,department, with a header). Write **/root/import.sh** that reads it with a \`while IFS=, read -r ...\` loop and, for each row: creates the group named after the department if it does not exist, creates the user with a home directory, the full name as comment and that group as a supplementary group (skipping users that already exist), and finally prints \`created N\`. ${already.p.sam} already has an account. Run it.`, steps: ['Skip the header with tail -n +2.', 'getent group "$dept" || groupadd "$dept".', 'id "$user" || useradd -m -c "$name" -G "$dept" "$user".', 'Count the users you created and print the total.'], tips: ['tail -n +2 /root/new-staff.csv | while IFS=, read -r user name dept; do ... done', 'count=$((count + 1))'] }),
      hints: ['A pipe into while runs the loop in a subshell, so a counter set inside is lost: use done < <(tail -n +2 file) or read from a temporary file.', 'getent group NAME exits non-zero when the group does not exist.'],
      initialState: linux(net, { users: { [already.p.sam]: {} }, files: { '/root/new-staff.csv': csv } }),
      checks: [...people.slice(1).map((x) => user(`${x.p.sam} exists in ${x.d}`, x.p.sam, { groups: [x.d], homeExists: true })), ...depts.map((d) => group(`Group ${d} exists`, d)), out(`${already.p.sam} was left alone`, `getent passwd ${already.p.sam}`, { notContains: already.p.name }), script('Run again it creates nobody and says so', '/root/import.sh', { contains: 'created 0' })],
      solution: [`cat > /root/import.sh <<'EOF'\n${SH('count=0\ntail -n +2 /root/new-staff.csv > /tmp/rows.csv\nwhile IFS=, read -r user name dept; do\n  getent group "$dept" >/dev/null || groupadd "$dept"\n  if ! id "$user" >/dev/null 2>&1; then\n    useradd -m -c "$name" -G "$dept" "$user"\n    count=$((count + 1))\n  fi\ndone < /tmp/rows.csv\necho "created $count"\n')}EOF`, 'chmod +x /root/import.sh', '/root/import.sh'],
      realityNote: 'The "counter lost in a piped while loop" trap catches almost everyone once; redirecting the file into the loop avoids it.',
    };
  }),

  /* ---------------------------------------------------------------- 4.3 error handling, logging, cron, timers */
  tmpl(4, 3, 'beginner', 'schedule-with-cron', 'Schedule jobs with cron', 'E4', 15, 'Write crontab entries with the right five time fields.', (v) => {
    const net = v.net();
    const [h, m] = [v.int(0, 4), v.pick([0, 15, 30, 45])];
    const day = v.pick([['Sunday', 0], ['Monday', 1], ['Friday', 5]] as const);
    return {
      instructions: lab({ situation: `Root needs two scheduled jobs:\n\n1. **/usr/local/bin/backup.sh** every day at **${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}**.\n2. **/usr/local/bin/weekly-report.sh** every **${day[0]}** at **06:00**, with its output appended to **/var/log/weekly-report.log**.\n\nInstall them in root's crontab.`, steps: ['Fields: minute hour day-of-month month day-of-week command.', 'Edit with crontab -e, or write a file and install it with crontab FILE.', 'Check with crontab -l.'], tips: [`${m} ${h} * * * /usr/local/bin/backup.sh`, 'crontab -l', '(crontab -l; echo "LINE") | crontab -'] }),
      hints: [`${day[0]} is day-of-week ${day[1]}.`, '>> appends; 2>&1 sends errors to the same place.'],
      initialState: linux(net, { files: { '/usr/local/bin/backup.sh': { content: '#!/bin/bash\necho backup\n', mode: '755' }, '/usr/local/bin/weekly-report.sh': { content: '#!/bin/bash\necho report\n', mode: '755' } } }),
      checks: [cron('The daily backup is scheduled', 'root', `^${m}\\s+${h}\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/bin/backup\\.sh`), cron(`The weekly report runs on ${day[0]} at 06:00 and logs`, 'root', `^0\\s+6\\s+\\*\\s+\\*\\s+(${day[1]}|${day[0].slice(0, 3)})\\s+/usr/local/bin/weekly-report\\.sh\\s+>>\\s*/var/log/weekly-report\\.log`)],
      solution: [`printf '${m} ${h} * * * /usr/local/bin/backup.sh\\n0 6 * * ${day[1]} /usr/local/bin/weekly-report.sh >> /var/log/weekly-report.log 2>&1\\n' > /root/cron.txt`, 'crontab /root/cron.txt', 'crontab -l'],
      realityNote: 'crontab.guru exists because everyone mixes up the five fields at least once; always check with crontab -l.',
    };
  }),
  tmpl(4, 3, 'intermediate', 'strict-mode', 'Make a fragile backup script fail safely and log', 'E4', 20, 'Add set -euo pipefail, a log function and an explicit check to an existing script.', (v) => {
    const net = v.net();
    const src = v.pick(['/srv/www', '/srv/data', '/home']);
    return {
      instructions: lab({ situation: `**/usr/local/bin/nightly.sh** archives the directory given as \`$1\` into /srv/backup. If the directory is missing it still prints "backup complete", so nobody notices failures. Improve it:\n\n1. \`set -euo pipefail\` at the top.\n2. A \`log\` function that appends \`<date> <message>\` lines to **/var/log/nightly.log**.\n3. If \`$1\` is not a directory, log \`ERROR: <dir> missing\` and exit **2**.\n4. On success, log \`backup complete\` (and still print it).`, steps: ['Read the current script.', 'Rewrite it with the four changes.', `Test it with an existing (${src}) and a missing directory.`], tips: ['log() { echo "$(date +%F_%T) $*" >> /var/log/nightly.log; }', '[ -d "$1" ] || { log "ERROR: $1 missing"; exit 2; }'] }),
      hints: ['set -u makes unset variables an error; -o pipefail makes a pipeline fail if any part fails.'],
      initialState: linux(net, { files: { '/usr/local/bin/nightly.sh': { content: '#!/bin/bash\ntar czf /srv/backup/nightly.tar.gz $1\necho "backup complete"\n', mode: '755' }, '/srv/backup/': null, [`${src}/keep.txt`]: 'data\n' } }),
      checks: [file('Strict mode is on', '/usr/local/bin/nightly.sh', { contains: 'set -euo pipefail' }), script('A missing directory exits 2', '/usr/local/bin/nightly.sh', { args: ['/srv/nothing-here'], status: 2, creates: '/var/log/nightly.log' }), script('A real directory succeeds', '/usr/local/bin/nightly.sh', { args: [src], status: 0, contains: 'backup complete', creates: '/srv/backup/nightly.tar.gz' }), file('The log records failures', '/var/log/nightly.log', { contains: 'ERROR: /srv/nothing-here missing' })],
      solution: [`cat > /usr/local/bin/nightly.sh <<'EOF'\n${SH('set -euo pipefail\nlog() {\n  echo "$(date +%F_%T) $*" >> /var/log/nightly.log\n}\nif [ ! -d "${1:-}" ]; then\n  log "ERROR: ${1:-} missing"\n  exit 2\nfi\ntar czf /srv/backup/nightly.tar.gz "$1"\nlog "backup complete"\necho "backup complete"\n')}EOF`, '/usr/local/bin/nightly.sh /srv/nothing-here || true', `/usr/local/bin/nightly.sh ${src}`],
      realityNote: '"Unofficial bash strict mode" (set -euo pipefail) turns silent failures into loud ones, which is what you want in anything run unattended.',
    };
  }),
  tmpl(4, 3, 'advanced', 'systemd-timer', 'Replace a cron job with a systemd service and timer', 'E4', 25, 'Write a oneshot service and a timer unit, enable the timer and check it is scheduled.', (v) => {
    const net = v.net();
    const name = v.pick(['disk-report', 'db-dump', 'cert-check']);
    const day = v.pick(['Mon', 'Wed', 'Fri']);
    const hh = v.pick(['06', '07']);
    return {
      instructions: lab({ situation: `Move the **${name}** job from cron to systemd, which logs every run in the journal and catches up after downtime. Create **/etc/systemd/system/${name}.service** (Type=oneshot, running **/usr/local/bin/${name}.sh**) and **/etc/systemd/system/${name}.timer** that runs it every **${day}** at **${hh}:00** and is **Persistent**. Reload systemd, enable and start the timer, and remove the old cron line.`, steps: ['Write the two unit files.', 'systemctl daemon-reload.', `systemctl enable --now ${name}.timer.`, 'Check systemctl list-timers.', 'Remove the cron entry (crontab -r if it is the only one).'], tips: ['[Service]\\nType=oneshot\\nExecStart=/usr/local/bin/NAME.sh', `[Timer]\\nOnCalendar=${day} *-*-* ${hh}:00:00\\nPersistent=true`, '[Install]\\nWantedBy=timers.target'] }),
      hints: ['Enable the timer, not the service: the timer starts the service.', 'Persistent=true runs a missed job at the next boot.'],
      initialState: linux(net, { files: { [`/usr/local/bin/${name}.sh`]: { content: `#!/bin/bash\necho ${name}\n`, mode: '755' } }, crontabs: { root: `0 ${Number(hh)} * * ${day === 'Mon' ? 1 : day === 'Wed' ? 3 : 5} /usr/local/bin/${name}.sh\n` } }),
      checks: [file('The service runs the script once', `/etc/systemd/system/${name}.service`, { contains: ['Type=oneshot', `ExecStart=/usr/local/bin/${name}.sh`] }), file('The timer has the schedule', `/etc/systemd/system/${name}.timer`, { pattern: `OnCalendar=${day}[ ,]` , contains: ['Persistent=true', 'WantedBy=timers.target'] }), svc('The timer is enabled and active', `${name}.timer`, { active: true, enabled: true }), out('systemd lists it', 'systemctl list-timers', { contains: `${name}.timer` }), out('The cron job is gone', 'crontab -l', { notContains: name })],
      solution: [`printf '[Unit]\\nDescription=${name}\\n\\n[Service]\\nType=oneshot\\nExecStart=/usr/local/bin/${name}.sh\\n' > /etc/systemd/system/${name}.service`, `printf '[Unit]\\nDescription=Run ${name} weekly\\n\\n[Timer]\\nOnCalendar=${day} *-*-* ${hh}:00:00\\nPersistent=true\\n\\n[Install]\\nWantedBy=timers.target\\n' > /etc/systemd/system/${name}.timer`, 'systemctl daemon-reload', `systemctl enable --now ${name}.timer`, 'systemctl list-timers', 'crontab -r'],
      realityNote: 'Most distributions now ship their own periodic jobs (logrotate, fstrim, updates) as systemd timers rather than cron entries.',
    };
  }),

  /* ---------------------------------------------------------------- 4.4 admin scripts and ShellCheck */
  tmpl(4, 4, 'beginner', 'users-from-list', 'Create users from a list with a script', 'E4', 15, 'Loop over names in a file and create the missing accounts.', (v) => {
    const net = v.net();
    const names = v.people(4).map((p) => p.sam);
    const exists = names[1];
    return {
      instructions: lab({ situation: `**/root/names.txt** has one user name per line. Write **/root/addusers.sh** that creates each account with a home directory if it does not already exist, and prints \`exists: NAME\` for the ones that do. ${exists} already exists. Run it.`, steps: ['while read -r name; do ... done < /root/names.txt', 'id "$name" to test.', 'useradd -m "$name".'], tips: ['while read -r name; do id "$name" >/dev/null 2>&1 && echo "exists: $name" || useradd -m "$name"; done < /root/names.txt'] }),
      hints: ['read -r stops backslashes being treated as escapes.'],
      initialState: linux(net, { users: { [exists]: {} }, files: { '/root/names.txt': names.join('\n') + '\n' } }),
      checks: [...names.filter((n) => n !== exists).map((n) => user(`${n} exists with a home`, n, { homeExists: true })), script('It reports existing accounts', '/root/addusers.sh', { contains: `exists: ${exists}` })],
      solution: [`cat > /root/addusers.sh <<'EOF'\n${SH('while read -r name; do\n  if id "$name" >/dev/null 2>&1; then\n    echo "exists: $name"\n  else\n    useradd -m "$name"\n  fi\ndone < /root/names.txt\n')}EOF`, 'chmod +x /root/addusers.sh', '/root/addusers.sh'],
      realityNote: 'Small scripts like this are the first automation every administrator writes; the next step is the same logic in a configuration management tool.',
    };
  }),
  tmpl(4, 4, 'intermediate', 'keep-newest-backups', 'Rotate backups: keep only the newest N', 'E4', 20, 'Write a script that deletes all but the newest N backup archives.', (v) => {
    const net = v.net();
    const keep = v.int(3, 5);
    const total = keep + v.int(3, 5);
    const dates = Array.from({ length: total }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    return {
      instructions: lab({ situation: `/srv/backup holds daily archives named **backup-YYYY-MM-DD.tar.gz**. Write **/usr/local/bin/prune-backups DIR KEEP** that deletes all but the newest KEEP archives (the date in the name sorts correctly as text) and prints the name of each file it deletes. Other files in the directory must not be touched. Run it on /srv/backup keeping **${keep}**.`, steps: ['List the archives sorted newest first: ls -1 "$1"/backup-*.tar.gz | sort -r.', 'Skip the first KEEP lines: tail -n +$((KEEP + 1)).', 'Delete the rest in a while read loop, printing each.'], tips: ['ls -1 "$1"/backup-*.tar.gz | sort -r | tail -n +$(( $2 + 1 )) | while read -r f; do echo "$f"; rm -- "$f"; done'] }),
      hints: ['ISO dates (YYYY-MM-DD) sort the same as text and as time.', 'Test with echo before adding rm.'],
      initialState: linux(net, { files: { ...Object.fromEntries(dates.map((d) => [`/srv/backup/backup-${d}.tar.gz`, `archive ${d}\n`])), '/srv/backup/README.txt': 'do not delete\n' } }),
      checks: [...dates.slice(-keep).map((d) => file(`backup-${d} is kept`, `/srv/backup/backup-${d}.tar.gz`)), ...dates.slice(0, total - keep).map((d) => file(`backup-${d} is deleted`, `/srv/backup/backup-${d}.tar.gz`, { exists: false })), file('README.txt is untouched', '/srv/backup/README.txt'), script('It works on another directory too', '/usr/local/bin/prune-backups', { args: ['/srv/backup', '1'], status: 0, contains: `backup-${dates[total - keep]}` })],
      solution: [`cat > /usr/local/bin/prune-backups <<'EOF'\n${SH('ls -1 "$1"/backup-*.tar.gz | sort -r | tail -n +$(( $2 + 1 )) | while read -r f; do\n  echo "$f"\n  rm -- "$f"\ndone\n')}EOF`, 'chmod +x /usr/local/bin/prune-backups', `prune-backups /srv/backup ${keep}`],
      realityNote: 'Retention by count is the simplest backup policy; tools like restic and borg offer richer rules (keep 7 daily, 4 weekly, 12 monthly).',
    };
  }),
  tmpl(4, 4, 'advanced', 'health-check', 'Write a ShellCheck-clean health check', 'E4', 25, 'Write a script that checks services and a directory, reports OK/FAIL lines, sets the exit code and passes ShellCheck.', (v) => {
    const net = v.net();
    const dir = v.pick(['/srv/www', '/srv/data']);
    return {
      instructions: lab({ situation: `Write **/usr/local/bin/health.sh** for the monitoring system. It checks:\n\n- each service in the variable \`SERVICES="sshd cron firewalld"\` is active, printing \`OK service NAME\` or \`FAIL service NAME\`,\n- that **${dir}** exists and is writable by root, printing \`OK dir ${dir}\` or \`FAIL dir ${dir}\`.\n\nIt exits 0 if everything is OK and 1 otherwise. It must pass **shellcheck** with no warnings (quote your variables).`, steps: ['Write it with a function for each kind of check.', 'Install ShellCheck (zypper install shellcheck) and run it.', 'Fix every warning and test the script.'], tips: ['for s in $SERVICES; do ... done   # here word splitting is wanted: SC2086 does not apply to for-in lists of a deliberately split variable', 'shellcheck /usr/local/bin/health.sh'] }),
      hints: ['ShellCheck SC2086: "Double quote to prevent globbing and word splitting".', 'Use [ -d "$d" ] && [ -w "$d" ].'],
      initialState: linux(net, { files: { [`${dir}/index.html`]: 'ok\n' } }),
      checks: [script('Everything healthy: OK lines and exit 0', '/usr/local/bin/health.sh', { status: 0, contains: ['OK service sshd', 'OK service cron', `OK dir ${dir}`] }), out('ShellCheck finds nothing', 'shellcheck /usr/local/bin/health.sh', { status: 0 }), file('Services come from the SERVICES variable', '/usr/local/bin/health.sh', { pattern: 'SERVICES="sshd cron firewalld"' })],
      solution: ['zypper install shellcheck', `cat > /usr/local/bin/health.sh <<'EOF'\n${SH(`SERVICES="sshd cron firewalld"\nrc=0\ncheck_service() {\n  if systemctl is-active "$1" >/dev/null; then\n    echo "OK service $1"\n  else\n    echo "FAIL service $1"\n    rc=1\n  fi\n}\ncheck_dir() {\n  if [ -d "$1" ] && [ -w "$1" ]; then\n    echo "OK dir $1"\n  else\n    echo "FAIL dir $1"\n    rc=1\n  fi\n}\nfor s in $SERVICES; do\n  check_service "$s"\ndone\ncheck_dir "${dir}"\nexit "$rc"\n`)}EOF`, 'chmod +x /usr/local/bin/health.sh', 'shellcheck /usr/local/bin/health.sh', '/usr/local/bin/health.sh'],
      realityNote: 'Running ShellCheck in CI on every admin script catches quoting bugs before they delete the wrong files.',
    };
  }),

  /* ---------------------------------------------------------------- 4.5 Python for administration */
  tmpl(4, 5, 'beginner', 'bash-or-python', 'Choose Bash or Python for an admin task', 'E10', 15, 'Decide which language fits each automation job.', (v) => {
    const n = v.int(50, 400);
    return caseStudy(v, {
      intro: '## Which tool for the job?\n\nThe team is writing automation. For each job, choose the better language.',
      steps: [
        { title: 'Restart a service and check it', text: 'Three commands, run by cron.', choices: [{ text: 'Bash: it glues commands together with no extra dependencies', right: true, feedback: 'Correct.' }, { text: 'Python with the subprocess module', feedback: 'It works, but adds ceremony for three commands.' }, { text: 'C, for speed', feedback: 'Speed is not the problem here.' }] },
        { title: 'Parse a JSON API', text: `Pull ${n} user records from the HR system's JSON API and reconcile them with /etc/passwd.`, choices: [{ text: 'Python: real data structures, json and requests libraries, testable functions', right: true, feedback: 'Correct. Parsing JSON in Bash quickly becomes unreadable.' }, { text: 'Bash with grep and cut on the JSON', feedback: 'Fragile: any formatting change breaks it.' }, { text: 'Do it by hand in a spreadsheet', feedback: 'Not repeatable.' }] },
        { title: 'Error handling', text: 'The job must retry network errors and report clearly what failed.', choices: [{ text: 'Python: exceptions and structured logging make this manageable', right: true, feedback: 'Correct.' }, { text: 'Bash: set -e handles everything', feedback: 'set -e stops; it does not retry or explain.' }, { text: 'Ignore errors and rerun daily', feedback: 'Silent failures pile up.' }] },
        { title: 'Installing libraries', text: 'The script needs the requests library on the server.', choices: [{ text: 'Use the distribution package (python3-requests) or a virtual environment, not pip into the system Python', right: true, feedback: 'Correct. Modern distributions mark the system Python as externally managed.' }, { text: 'sudo pip install requests', feedback: 'That can break system tools that depend on the distribution\'s packages.' }, { text: 'Copy the library from a laptop', feedback: 'Unmanaged and unpatched.' }] },
      ],
      ending: { title: 'Tools chosen', text: 'Bash for gluing commands, Python for data, APIs and robust error handling, with libraries from packages or a virtual environment.' },
      hints: ['How much data handling is there?'],
      realityNote: 'Most configuration management and cloud tools (Ansible, Salt, cloud SDKs) are written in Python for the same reasons.',
    });
  }),
  tmpl(4, 5, 'intermediate', 'read-a-python-script', 'Read and review a Python admin script', 'E10', 20, 'Predict what a Python disk-check script does and spot its bugs.', (v) => {
    const limit = v.pick([80, 85, 90]);
    const code = `import shutil, subprocess\n\nLIMIT = ${limit}\nfor mount in ["/", "/var", "/home"]:\n    usage = shutil.disk_usage(mount)\n    percent = usage.used / usage.total * 100\n    if percent > LIMIT:\n        subprocess.run(f"logger disk {mount} at {percent:.0f}%", shell=True)\n        print("WARN", mount, round(percent))\n`;
    return caseStudy(v, {
      intro: '## Code review\n\nA colleague wrote this Python script to warn about full disks. Review it.',
      steps: [
        { title: 'What it does', text: 'What does the script do for each mount point?', evidence: [{ title: 'disk_check.py', kind: 'code', text: code }], choices: [{ text: `Computes the used percentage and, above ${limit}%, writes a syslog message and prints a warning`, right: true, feedback: 'Correct.' }, { text: 'Deletes files when the disk is full', feedback: 'Nothing is deleted.' }, { text: 'Prints every mount point\'s usage', feedback: 'It only prints those over the limit.' }] },
        { title: 'A missing mount', text: 'On a server without a separate /home... actually /home always exists as a directory. What if a path in the list does not exist?', choices: [{ text: 'shutil.disk_usage raises FileNotFoundError and the script stops before checking the rest', right: true, feedback: 'Correct. Wrap each check in try/except so one bad path does not hide the others.' }, { text: 'It silently skips it', feedback: 'Python raises an exception.' }, { text: 'It reports 0%', feedback: 'No: it raises.' }] },
        { title: 'shell=True', text: 'Is subprocess.run(..., shell=True) with an f-string a problem here?', choices: [{ text: 'It is risky style: pass a list (["logger", msg]) so no shell parses the text', right: true, feedback: 'Correct. Here the values are fixed, but the habit leads to injection bugs.' }, { text: 'No, shell=True is always fine', feedback: 'With any outside input it allows command injection.' }, { text: 'It does not work at all', feedback: 'It works; it is just unsafe practice.' }] },
        { title: 'Exit status', text: 'The monitoring system needs to know if any disk was over the limit.', choices: [{ text: 'Track a flag and sys.exit(1) at the end when any warning was printed', right: true, feedback: 'Correct. Exit codes are how monitoring tools read results.' }, { text: 'Print "ERROR" and exit 0', feedback: 'Monitoring tools would see success.' }, { text: 'Raise an exception on purpose', feedback: 'Crashes are not a clean signal.' }] },
      ],
      ending: { title: 'Review done', text: 'Handle missing paths, avoid shell=True, and return a meaningful exit code.' },
      hints: ['Read each line and ask what happens if it fails.'],
      realityNote: 'Python\'s shutil, subprocess, pathlib and logging cover most administration scripting without extra packages.',
    });
  }),
  tmpl(4, 5, 'advanced', 'python-in-production', 'Run Python automation properly on servers', 'E10', 20, 'Decide on virtual environments, packaging, scheduling and secrets for Python admin tools.', (v) => {
    const tool = v.pick(['an account-sync tool', 'a certificate-expiry checker', 'a backup verifier']);
    return caseStudy(v, {
      intro: `## Putting ${tool} into production\n\nThe script works on a laptop. Now it must run on three servers every night.`,
      steps: [
        { title: 'Dependencies', text: 'It needs two libraries not packaged by the distribution.', choices: [{ text: 'A virtual environment owned by a service account, with pinned versions in requirements.txt', right: true, feedback: 'Correct. Reproducible and isolated from the system Python.' }, { text: 'pip install into the system Python as root', feedback: 'Can break distribution tools; blocked by PEP 668 on modern systems.' }, { text: 'Install whatever versions are newest each night', feedback: 'Unpinned dependencies change under you.' }] },
        { title: 'Running it', text: 'How should it run nightly?', choices: [{ text: 'A systemd service plus timer, running as a dedicated unprivileged user', right: true, feedback: 'Correct. Logs go to the journal and it does not run as root.' }, { text: 'Root\'s crontab', feedback: 'Works, but more privilege than needed and weaker logging.' }, { text: 'Someone starts it by hand each morning', feedback: 'Not automation.' }] },
        { title: 'Secrets', text: 'It needs an API token for the HR system.', choices: [{ text: 'A file readable only by the service user (or a credential store), never in the script or the git repository', right: true, feedback: 'Correct.' }, { text: 'Hard-code it in the script', feedback: 'Anyone who can read the script, or the repository, gets the token.' }, { text: 'Pass it on the command line', feedback: 'Command lines are visible to every user through ps.' }] },
        { title: 'Logging', text: 'How should it report what it did?', choices: [{ text: 'Python logging to stdout/stderr, collected by journald, with clear error messages', right: true, feedback: 'Correct.' }, { text: 'print() to a file in /tmp', feedback: 'Lost on reboot and readable by everyone.' }, { text: 'No logging; it works', feedback: 'Until it does not.' }] },
      ],
      ending: { title: 'Production ready', text: 'Virtual environment with pinned dependencies, a systemd timer as an unprivileged user, protected secrets and journald logging.' },
      hints: ['Least privilege and reproducibility.'],
      realityNote: 'PEP 668 made "externally managed" system Pythons the norm on Debian, Ubuntu and openSUSE, pushing admin tools into virtual environments or distribution packages.',
    });
  }),
];
