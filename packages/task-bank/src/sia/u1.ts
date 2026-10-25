/** Unit 1: shell scripting fundamentals. */

import type { TaskTemplate } from '../types';
import { DEPTS, HOSTS, SH, csv, file, lab, linux, out, script, tmpl, writeScript } from './kit';

export const U1: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 1.1 variables, quoting, exit codes, pipes, redirection, here-documents */
  tmpl(1, 1, 'beginner', 'quote-the-path', 'Fix a script that breaks on spaces', 'E4', 15, 'Quote variables so a line-counting script works for file names with spaces.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const lines = v.int(4, 12);
    const path = `/srv/${dept}/${v.pick(['weekly report', 'stock list', 'staff notes', 'room bookings'])}.txt`;
    return {
      instructions: lab({
        situation: `**/usr/local/bin/countlines FILE** should print \`N lines in FILE\`. It works for simple names but fails for **${path}**, because the variables are not quoted. Fix the script so that \`countlines "${path}"\` prints \`${lines} lines in ${path}\`.`,
        steps: ['Read the script with cat.', `Run it on "${path}" and read the error.`, 'Put double quotes around every use of $1 and of the variable that holds the count.', 'Run it again.'],
        tips: ['cat /usr/local/bin/countlines', `countlines "${path}"`, 'n=$(wc -l < "$1")'],
      }),
      hints: ['Without quotes, the shell splits $1 at the space into two words.', 'Double quotes keep $1 as one word but still expand it; single quotes would stop the expansion.'],
      initialState: linux(net, { files: { [path]: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n', '/usr/local/bin/countlines': { content: SH('n=$(wc -l < $1)\necho $n lines in $1\n'), mode: '755' } } }),
      checks: [script('It counts a file whose name has spaces', '/usr/local/bin/countlines', { args: [path], equals: `${lines} lines in ${path}` }), script('It still works for a simple name', '/usr/local/bin/countlines', { args: ['/etc/hostname'], equals: '1 lines in /etc/hostname' })],
      solution: [`countlines "${path}"`, writeScript('/usr/local/bin/countlines', 'n=$(wc -l < "$1")\necho "$n lines in $1"\n'), `countlines "${path}"`],
      realityNote: 'Unquoted variables are the most common shell bug: file names with spaces, empty values and wildcards all break them. ShellCheck warns about every one (SC2086).',
    };
  }),
  tmpl(1, 1, 'intermediate', 'exit-codes-and-pipes', 'Return meaningful exit codes', 'E4', 20, 'Write a check script that combines a pipe, grep -q and distinct exit codes.', (v) => {
    const net = v.net();
    const people = v.people(3);
    const missing = v.person();
    const name = v.pick(['hasuser', 'userok', 'checkacct']);
    return {
      instructions: lab({
        situation: `The helpdesk wants **/usr/local/bin/${name} NAME**:\n\n- If NAME is an account in /etc/passwd, print \`NAME exists\` and exit **0**.\n- If not, print \`NAME not found\` and exit **1**.\n- With no argument, print \`usage: ${name} NAME\` to standard error and exit **2**.\n\nThe accounts ${people.map((p) => p.sam).join(', ')} exist; ${missing.sam} does not.`,
        steps: ['Check $# for the missing argument.', 'Search with grep -q "^$1:" /etc/passwd: -q prints nothing and only sets the exit code.', 'Test both cases and look at echo $? after each.'],
        tips: ['grep -q "^$1:" /etc/passwd', 'echo "usage: ..." >&2', 'echo $?'],
      }),
      hints: ['Anchor the pattern with ^ and end it with : so "ama" does not match "amaboateng".', '>&2 sends a message to standard error, where usage errors belong.'],
      initialState: linux(net, { users: Object.fromEntries(people.map((p) => [p.sam, { comment: p.name }])) }),
      checks: [script('An existing account: exit 0', `/usr/local/bin/${name}`, { args: [people[1].sam], status: 0, equals: `${people[1].sam} exists` }), script('A missing account: exit 1', `/usr/local/bin/${name}`, { args: [missing.sam], status: 1, equals: `${missing.sam} not found` }), script('A prefix of a name does not count', `/usr/local/bin/${name}`, { args: [people[0].sam.slice(0, 3)], status: 1 }), script('No argument: usage and exit 2', `/usr/local/bin/${name}`, { status: 2, contains: `usage: ${name} NAME` }), out('The usage message goes to standard error', `/usr/local/bin/${name} 2>/dev/null | wc -c`, { equals: '0' })],
      solution: [writeScript(`/usr/local/bin/${name}`, `if [ $# -eq 0 ]; then\n  echo "usage: ${name} NAME" >&2\n  exit 2\nfi\nif grep -q "^$1:" /etc/passwd; then\n  echo "$1 exists"\nelse\n  echo "$1 not found"\n  exit 1\nfi\n`), `${name} ${people[0].sam}; echo $?`],
      realityNote: 'Exit codes are how scripts talk to cron, systemd, CI pipelines and monitoring. grep, test and most tools follow the same rule: 0 is success, anything else is a reason.',
    };
  }),
  tmpl(1, 1, 'advanced', 'heredoc-report', 'Write a report with a here-document and redirection', 'E4', 25, 'Generate a server report with command substitution, a here-document, appends and a silent standard output.', (v) => {
    const net = v.net();
    const host = v.pick(HOSTS);
    const dir = v.pick(['/var/reports', '/srv/reports', '/var/lib/sysreport']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/bin/sysreport** for **${host}**. Each run must:\n\n1. Write **${dir}/${host}.txt** from a here-document with exactly these lines:\n   - \`Host: <hostname>\`\n   - \`Kernel: <uname -r>\`\n   - \`Accounts: <number of lines in /etc/passwd>\`\n   - \`Root use: <the Use% of / from df, such as 23%>\`\n2. **Append** one line \`<date +%F> report written\` to **/var/log/sysreport.log**.\n3. Print **nothing** on the terminal, so it is quiet under cron.\n\nCreate ${dir} if it is missing.`,
        steps: ['Collect each value with command substitution, such as accounts=$(wc -l < /etc/passwd).', 'df / | awk \'NR==2 {print $5}\' gives the Use% column.', 'Write the report with cat > FILE <<EOF (unquoted, so variables expand).', 'Append the log line with >>.'],
        tips: [`mkdir -p ${dir}`, "df / | awk 'NR==2 {print $5}'", 'cat > "$out" <<EOF\nHost: $(hostname)\nEOF', 'echo "$(date +%F) report written" >> /var/log/sysreport.log'],
      }),
      hints: ['<<EOF expands $variables and $(commands); <<\'EOF\' keeps them literal.', '> replaces a file; >> adds to the end.'],
      initialState: linux(net, { hostname: host }),
      checks: [
        script('It runs quietly', '/usr/local/bin/sysreport', { status: 0, equals: '', creates: `${dir}/${host}.txt` }),
        out('The report has the host and kernel', `/usr/local/bin/sysreport; cat ${dir}/${host}.txt`, { contains: [`Host: ${host}`, `Kernel: ${'6.4.0-150600.23-default'}`] }),
        out('The account count is right', `/usr/local/bin/sysreport; grep -c "^Accounts: $(wc -l < /etc/passwd)$" ${dir}/${host}.txt`, { equals: '1' }),
        out('The root use is a percentage', `/usr/local/bin/sysreport; grep '^Root use: ' ${dir}/${host}.txt`, { pattern: '^Root use: \\d+%$' }),
        out('Each run appends to the log', '/usr/local/bin/sysreport; /usr/local/bin/sysreport; grep -c "report written" /var/log/sysreport.log', { pattern: '^([2-9]|\\d{2,})$' }),
      ],
      solution: [writeScript('/usr/local/bin/sysreport', `out=${dir}/$(hostname).txt\nmkdir -p ${dir}\naccounts=$(wc -l < /etc/passwd)\nuse=$(df / | awk 'NR==2 {print $5}')\ncat > "$out" <<END\nHost: $(hostname)\nKernel: $(uname -r)\nAccounts: $accounts\nRoot use: $use\nEND\necho "$(date +%F) report written" >> /var/log/sysreport.log\n`), 'sysreport', `cat ${dir}/${host}.txt`],
      realityNote: 'Scripts that run from cron should be silent when all is well and write their results to files or logs; cron mails any output to the owner.',
    };
  }),

  /* ---------------------------------------------------------------- 1.2 conditionals, test expressions, loops, case */
  tmpl(1, 2, 'beginner', 'grade-a-score', 'Grade a score with if and case', 'E4', 15, 'Validate a number with a test expression and map it to a grade.', (v) => {
    const net = v.net();
    const a = v.pick([75, 80]);
    const pass = v.pick([40, 45, 50]);
    const name = v.pick(['grade', 'mark2grade', 'scoregrade']);
    const mid = Math.round((a + pass) / 2);
    return {
      instructions: lab({
        situation: `Write **/usr/local/bin/${name} SCORE** for the examinations office:\n\n- SCORE must be a whole number from 0 to 100; otherwise print \`invalid score\` and exit **2**.\n- **${a}** or more prints \`A\`; **${mid}** to ${a - 1} prints \`B\`; **${pass}** to ${mid - 1} prints \`C\`; below ${pass} prints \`F\`.`,
        steps: ['Check the input with [[ $1 =~ ^[0-9]+$ ]] and a range test.', 'Use if/elif/else with -ge to choose the grade.', 'Try 100, ' + a + ', ' + (mid - 1) + ', 0 and "abc".'],
        tips: ['[[ $1 =~ ^[0-9]+$ ]] || { echo "invalid score"; exit 2; }', 'if [ "$1" -ge 80 ]; then echo A; elif ...; fi'],
      }),
      hints: ['-ge compares numbers; >= inside [ ] would compare text.', 'Check the highest band first, so each elif only sees what is left.'],
      initialState: linux(net),
      checks: [
        script(`${a} is an A`, `/usr/local/bin/${name}`, { args: [String(a)], equals: 'A' }),
        script(`${a - 1} is a B`, `/usr/local/bin/${name}`, { args: [String(a - 1)], equals: 'B' }),
        script(`${mid - 1} is a C`, `/usr/local/bin/${name}`, { args: [String(mid - 1)], equals: 'C' }),
        script(`${pass - 1} fails`, `/usr/local/bin/${name}`, { args: [String(pass - 1)], equals: 'F' }),
        script('Text is rejected with exit 2', `/usr/local/bin/${name}`, { args: ['abc'], status: 2, contains: 'invalid score' }),
        script('101 is rejected', `/usr/local/bin/${name}`, { args: ['101'], status: 2 }),
      ],
      solution: [writeScript(`/usr/local/bin/${name}`, `if ! [[ $1 =~ ^[0-9]+$ ]] || [ "$1" -gt 100 ]; then\n  echo "invalid score"\n  exit 2\nfi\nif [ "$1" -ge ${a} ]; then\n  echo A\nelif [ "$1" -ge ${mid} ]; then\n  echo B\nelif [ "$1" -ge ${pass} ]; then\n  echo C\nelse\n  echo F\nfi\n`), `${name} ${a}`],
      realityNote: 'Validating input before acting on it is the first line of every robust script; a script that guesses what bad input meant does damage quietly.',
    };
  }),
  tmpl(1, 2, 'intermediate', 'sort-the-inbox', 'Loop over files and sort them', 'E4', 20, 'Process each CSV in a folder with a for loop and file tests, including names with spaces.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const names = v.some(['jan payments', 'feb-payments', 'march', 'q1 summary', 'staff list', 'claims-week2', 'refunds', 'fees 2026'], 5);
    const empty = names.slice(3);
    const full = names.slice(0, 3);
    const base = `/srv/${dept}`;
    return {
      instructions: lab({
        situation: `Files arrive in **${base}/inbox**. Write **/usr/local/bin/sort-inbox** that looks at every **.csv** file there:\n\n- a file with data (not empty) moves to **${base}/processed/** and the script prints \`processed NAME\`;\n- an empty file moves to **${base}/rejected/** and the script prints \`rejected NAME\`.\n\nOther files (such as .txt) stay where they are. Some names contain spaces. Create the two folders if they are missing.`,
        steps: [`Loop with for f in ${base}/inbox/*.csv.`, 'Test with [ -s "$f" ] (exists and is not empty).', 'Move with mv and print the base name (basename "$f").', 'Run it and list all three folders.'],
        tips: [`for f in ${base}/inbox/*.csv; do ... done`, 'if [ -s "$f" ]; then ...; else ...; fi', 'mv "$f" DIR/', 'basename "$f"'],
      }),
      hints: ['Quote "$f" everywhere: some names contain spaces.', 'If nothing matches, the pattern stays as literal text; [ -e "$f" ] || continue skips it.'],
      initialState: linux(net, { files: { ...Object.fromEntries(full.map((n) => [`${base}/inbox/${n}.csv`, 'date,amount\n2026-10-01,100\n'])), ...Object.fromEntries(empty.map((n) => [`${base}/inbox/${n}.csv`, ''])), [`${base}/inbox/readme.txt`]: 'Drop CSV files here.\n' } }),
      checks: [
        out('Files with data are in processed', `ls ${base}/processed`, { contains: full.map((n) => `${n}.csv`), notContains: empty.map((n) => `${n}.csv`) }),
        out('Empty files are in rejected', `ls ${base}/rejected`, { contains: empty.map((n) => `${n}.csv`) }),
        out('Other files stay in the inbox', `ls ${base}/inbox`, { equals: 'readme.txt' }),
        out('It reports each file it moves', `printf 'date,amount\n' > "${base}/inbox/late arrival.csv"; : > ${base}/inbox/blank.csv; /usr/local/bin/sort-inbox`, { contains: ['processed late arrival.csv', 'rejected blank.csv'] }),
      ],
      solution: [writeScript('/usr/local/bin/sort-inbox', `base=${base}\nmkdir -p "$base/processed" "$base/rejected"\nfor f in "$base"/inbox/*.csv; do\n  [ -e "$f" ] || continue\n  name=$(basename "$f")\n  if [ -s "$f" ]; then\n    mv "$f" "$base/processed/"\n    echo "processed $name"\n  else\n    mv "$f" "$base/rejected/"\n    echo "rejected $name"\n  fi\ndone\n`), 'sort-inbox'],
      realityNote: 'Drop-folder processing like this is everywhere in back offices: bank statements, payroll exports and scanner output all land in an inbox a script sorts.',
    };
  }),
  tmpl(1, 2, 'advanced', 'service-menu', 'Build a menu with while, read and case', 'E4', 25, 'Write an interactive helpdesk menu that loops until quit and controls a service.', (v) => {
    const net = v.net();
    const service = v.pick(['apache2', 'named', 'mariadb']);
    const pkgs: Record<string, string> = { apache2: 'apache2', named: 'bind', mariadb: 'mariadb' };
    const keys = v.pick([{ s: '1', start: '2', stop: '3', quit: 'q' }, { s: 's', start: 'u', stop: 'd', quit: 'x' }]);
    return {
      instructions: lab({
        situation: `Helpdesk staff need a simple menu for **${service}** so they do not type systemctl commands. Write **/usr/local/sbin/svcmenu** that repeats until the user quits. Each round it reads one choice:\n\n- \`${keys.s}\` prints the state: \`${service} is active\` or \`${service} is inactive\`\n- \`${keys.start}\` starts the service and prints \`started\`\n- \`${keys.stop}\` stops it and prints \`stopped\`\n- \`${keys.quit}\` prints \`bye\` and exits 0\n- anything else prints \`invalid choice\`\n\nIf the input ends (no more lines), it should also exit 0.`,
        steps: ['Use while read -r -p "choice: " choice; do ... done.', 'Inside, a case "$choice" in ... esac with one branch per key and *) for the rest.', 'Use systemctl is-active --quiet to decide which state to print.', `Test it: printf '${keys.s}\\n${keys.start}\\n${keys.s}\\n${keys.quit}\\n' | svcmenu`],
        tips: ['while read -r choice; do\n  case "$choice" in\n    1) ... ;;\n    q) echo bye; exit 0 ;;\n    *) echo "invalid choice" ;;\n  esac\ndone', `systemctl is-active --quiet ${service}`],
      }),
      hints: ['read returns non-zero at the end of the input, which ends the while loop.', 'Each case branch ends with ;;'],
      initialState: linux(net, { packages: { [pkgs[service]]: { installed: true } }, services: { [service]: { active: false, enabled: false, package: pkgs[service] } } }),
      checks: [
        script('It shows the state, starts the service and quits', '/usr/local/sbin/svcmenu', { stdin: `${keys.s}\n${keys.start}\n${keys.s}\n${keys.quit}\n`, status: 0, pattern: `${service} is inactive[\\s\\S]*started[\\s\\S]*${service} is active[\\s\\S]*bye` }),
        script('It stops the service', '/usr/local/sbin/svcmenu', { stdin: `${keys.start}\n${keys.stop}\n${keys.s}\n`, pattern: `stopped[\\s\\S]*${service} is inactive` }),
        script('A wrong key is reported and the loop continues', '/usr/local/sbin/svcmenu', { stdin: `zz\n${keys.s}\n${keys.quit}\n`, pattern: `invalid choice[\\s\\S]*${service} is` }),
        script('The end of input exits 0', '/usr/local/sbin/svcmenu', { stdin: `${keys.s}\n`, status: 0 }),
      ],
      solution: [writeScript('/usr/local/sbin/svcmenu', `svc=${service}\nwhile read -r -p "choice: " choice; do\n  case "$choice" in\n    ${keys.s})\n      if systemctl is-active --quiet "$svc"; then echo "$svc is active"; else echo "$svc is inactive"; fi ;;\n    ${keys.start}) systemctl start "$svc" && echo started ;;\n    ${keys.stop}) systemctl stop "$svc" && echo stopped ;;\n    ${keys.quit}) echo bye; exit 0 ;;\n    *) echo "invalid choice" ;;\n  esac\ndone\nexit 0\n`), `printf '${keys.s}\\n${keys.quit}\\n' | svcmenu`],
      realityNote: 'Small menus like this let first-line support do safe, common actions without root shells; sudo can allow just the menu script.',
    };
  }),

  /* ---------------------------------------------------------------- 1.3 functions, positional parameters, getopts, shebang, strict mode */
  tmpl(1, 3, 'beginner', 'function-library', 'Move repeated code into a function library', 'E4', 20, 'Write a sourced library with log and die functions that an existing script uses.', (v) => {
    const net = v.net();
    const org = v.pick(['ict', 'campus', 'labops', 'infra']);
    const lib = `/usr/local/lib/${org}/common.sh`;
    const dir = `/srv/${v.pick(DEPTS)}/tmp`;
    const n = v.int(3, 7);
    return {
      instructions: lab({
        situation: `The script **/usr/local/bin/clean-tmp** already calls two functions from a shared library it sources, **${lib}**, but nobody has written the library yet. Write it with:\n\n- \`log LEVEL MESSAGE\`: prints \`LEVEL: MESSAGE\` (for example \`INFO: cleaned 3 files\`)\n- \`die MESSAGE\`: prints \`ERROR: MESSAGE\` to standard error and exits **1**\n\nDo not change clean-tmp. Then run it.`,
        steps: ['Read clean-tmp to see how it calls the functions.', `Create ${lib}.`, 'A function uses $1, $2 and so on for its own arguments; "${*:2}" means "everything from the second argument on".', 'Run clean-tmp.'],
        tips: ['cat /usr/local/bin/clean-tmp', 'log() {\n  echo "$1: ${*:2}"\n}', 'die() { echo "ERROR: $*" >&2; exit 1; }'],
      }),
      hints: ['A sourced file runs in the same shell, so its functions become available to the script.', 'Inside a function, $1 is the function\'s first argument, not the script\'s.'],
      initialState: linux(net, { files: { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/scratch${i + 1}.tmp`, 'x\n'])), '/usr/local/bin/clean-tmp': { content: SH(`. ${lib}\ndir=\${1:-${dir}}\n[ -d "$dir" ] || die "$dir is not a directory"\ncount=$(find "$dir" -name '*.tmp' | wc -l)\nfind "$dir" -name '*.tmp' -delete\nlog INFO "cleaned $count files"\n`), mode: '755' } } }),
      checks: [
        file('The library exists', lib, { exists: true }),
        out('The old files were cleaned', `ls ${dir} | wc -l`, { equals: '0' }),
        out('clean-tmp logs through the library', `touch ${dir}/new1.tmp ${dir}/new2.tmp; /usr/local/bin/clean-tmp; echo "rc=$?"`, { equals: 'INFO: cleaned 2 files\nrc=0' }),
        script('die stops with exit 1', '/usr/local/bin/clean-tmp', { args: ['/no/such/dir'], status: 1, equals: 'ERROR: /no/such/dir is not a directory' }),
        out('die writes to standard error', '/usr/local/bin/clean-tmp /no/such/dir 2>/dev/null | wc -c', { equals: '0' }),
      ],
      solution: ['cat /usr/local/bin/clean-tmp', `mkdir -p /usr/local/lib/${org}`, `cat > ${lib} <<'EOF'\nlog() {\n  echo "$1: \${*:2}"\n}\ndie() {\n  echo "ERROR: $*" >&2\n  exit 1\n}\nEOF`, 'clean-tmp'],
      realityNote: 'Shared libraries of log, die and retry functions keep a team\'s scripts consistent; one fix to the library fixes every script that sources it.',
    };
  }),
  tmpl(1, 3, 'intermediate', 'getopts-backup', 'Parse options with getopts', 'E4', 25, 'Write a backup script with -s, -d and -n options, usage text and a dry run.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const dest = v.pick(['/backup', '/srv/backup', '/var/backups/data']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/backup** with options:\n\n- \`-s DIR\` the folder to back up (required)\n- \`-d DIR\` where the archive goes (required)\n- \`-n\` dry run: print \`would create DEST/NAME-DATE.tar.gz\` and create nothing\n\nNAME is the base name of the source folder and DATE is \`date +%F\`. Without -n, create the archive with tar and print \`created DEST/NAME-DATE.tar.gz\`. A missing required option or an unknown option prints \`usage: backup -s SRC -d DEST [-n]\` and exits **2**. Back up **/srv/${dept}** to **${dest}**.`,
        steps: ['Loop with while getopts "s:d:n" opt; do case $opt in ... esac; done.', 'After the loop, check both -s and -d were given.', 'Build the archive name with $(basename "$src") and $(date +%F).', `Test: backup -n -s /srv/${dept} -d ${dest}, then without -n.`],
        tips: ['while getopts "s:d:n" opt; do\n  case $opt in\n    s) src=$OPTARG ;;\n    d) dest=$OPTARG ;;\n    n) dry=1 ;;\n    *) usage ;;\n  esac\ndone', 'tar -czf "$archive" -C "$(dirname "$src")" "$(basename "$src")"'],
      }),
      hints: ['A colon after a letter in the optstring means the option takes a value, which arrives in $OPTARG.', 'getopts sets opt to ? for an unknown option.'],
      initialState: linux(net, { files: { [`/srv/${dept}/minutes.txt`]: 'Meeting minutes\n', [`/srv/${dept}/budget.csv`]: 'item,amount\npaper,300\n' } }),
      checks: [
        script('A dry run creates nothing', '/usr/local/sbin/backup', { args: ['-n', '-s', `/srv/${dept}`, '-d', dest], status: 0, equals: `would create ${dest}/${dept}-2026-10-22.tar.gz` }),
        out('A dry run creates no archive', `/usr/local/sbin/backup -n -s /srv/${dept} -d /tmp/drytest >/dev/null; ls /tmp/drytest 2>/dev/null | grep -c tar.gz`, { equals: '0' }),
        script('A real run creates the archive', '/usr/local/sbin/backup', { args: ['-s', `/srv/${dept}`, '-d', dest], status: 0, contains: `created ${dest}/${dept}-2026-10-22.tar.gz`, creates: `${dest}/${dept}-2026-10-22.tar.gz` }),
        out('The archive holds the files', `/usr/local/sbin/backup -s /srv/${dept} -d ${dest} >/dev/null; tar -tzf ${dest}/${dept}-2026-10-22.tar.gz`, { contains: ['minutes.txt', 'budget.csv'] }),
        script('A missing option prints usage and exits 2', '/usr/local/sbin/backup', { args: ['-s', `/srv/${dept}`], status: 2, contains: 'usage: backup -s SRC -d DEST [-n]' }),
        script('An unknown option exits 2', '/usr/local/sbin/backup', { args: ['-x'], status: 2 }),
      ],
      solution: [writeScript('/usr/local/sbin/backup', `usage() {\n  echo "usage: backup -s SRC -d DEST [-n]" >&2\n  exit 2\n}\nsrc= dest= dry=0\nwhile getopts "s:d:n" opt; do\n  case $opt in\n    s) src=$OPTARG ;;\n    d) dest=$OPTARG ;;\n    n) dry=1 ;;\n    *) usage ;;\n  esac\ndone\n[ -n "$src" ] && [ -n "$dest" ] || usage\narchive="$dest/$(basename "$src")-$(date +%F).tar.gz"\nif [ "$dry" -eq 1 ]; then\n  echo "would create $archive"\n  exit 0\nfi\nmkdir -p "$dest"\ntar -czf "$archive" -C "$(dirname "$src")" "$(basename "$src")"\necho "created $archive"\n`), `backup -n -s /srv/${dept} -d ${dest}`, `backup -s /srv/${dept} -d ${dest}`],
      realityNote: 'getopts gives scripts the same option style as every Unix tool, and a -n dry run lets an operator see what will happen before it does.',
    };
  }),
  tmpl(1, 3, 'advanced', 'strict-mode-repair', 'Repair a script with strict mode', 'E4', 25, 'Add set -euo pipefail, fix the bug it reveals and make failures stop the script.', (v) => {
    const net = v.net();
    const subject = v.pick(['fees', 'sales', 'claims', 'orders']);
    const rows = Array.from({ length: v.int(4, 7) }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, v.int(50, 900)]);
    const total = rows.reduce((s, r) => s + Number(r[1]), 0);
    return {
      instructions: lab({
        situation: `**/usr/local/bin/total-${subject} [FILE]** adds up the second column of a CSV and writes \`total=N\` to /var/reports/NAME-total.txt. It always reports \`total=0\`, and when the input file is missing it still writes a report, which has fooled the finance office.\n\n1. Add \`set -euo pipefail\` near the top.\n2. Fix the bug strict mode reveals.\n3. The result for **/srv/data/${subject}.csv** must be \`total=${total}\`; a missing file must make the script fail (non-zero exit) **without** writing a report.`,
        steps: ['Read the script and run it on the CSV.', 'Add set -euo pipefail after the shebang and run it again: read the error.', 'Fix it, then try a missing file such as /srv/data/none.csv.'],
        tips: ['set -euo pipefail', 'bash -x /usr/local/bin/total-' + subject],
      }),
      hints: ['-u turns a misspelled variable from "empty" into an error.', 'pipefail makes a pipe fail when any command in it fails, not just the last one.'],
      initialState: linux(net, { files: { [`/srv/data/${subject}.csv`]: csv('date,amount', rows), '/var/reports/': null, [`/usr/local/bin/total-${subject}`]: { content: SH(`input=\${1:-/srv/data/${subject}.csv}\nout=/var/reports/$(basename "$input" .csv)-total.txt\ntotal=$(tail -n +2 "$inptu" | cut -d, -f2 | awk '{s += $1} END {print s + 0}')\necho "total=$total" > "$out"\n`), mode: '755' } } }),
      checks: [
        file('Strict mode is on', `/usr/local/bin/total-${subject}`, { pattern: '^set -euo pipefail' }),
        out('The total is right', `/usr/local/bin/total-${subject}; cat /var/reports/${subject}-total.txt`, { equals: `total=${total}` }),
        out('A missing file fails', `/usr/local/bin/total-${subject} /srv/data/none.csv; echo "rc=$?"`, { pattern: 'rc=[1-9]' }),
        out('A missing file writes no report', `/usr/local/bin/total-${subject} /srv/data/none.csv; ls /var/reports`, { notContains: 'none-total.txt' }),
      ],
      solution: [`total-${subject}`, writeScript(`/usr/local/bin/total-${subject}`, `set -euo pipefail\ninput=\${1:-/srv/data/${subject}.csv}\nout=/var/reports/$(basename "$input" .csv)-total.txt\ntotal=$(tail -n +2 "$input" | cut -d, -f2 | awk '{s += $1} END {print s + 0}')\necho "total=$total" > "$out"\n`), `total-${subject}`, `cat /var/reports/${subject}-total.txt`],
      realityNote: 'Strict mode turns silent wrong answers into loud failures. It has sharp edges (a grep that finds nothing exits 1), so learn where to add || true deliberately.',
    };
  }),

  /* ---------------------------------------------------------------- 1.4 grep, sed, awk, cut, sort, uniq, tr, xargs, find */
  tmpl(1, 4, 'beginner', 'top-clients', 'Find the busiest clients in an access log', 'E4', 15, 'Count requests per IP address with a pipeline of awk, sort, uniq and head.', (v) => {
    const net = v.net();
    const counts = v.some([3, 4, 5, 6, 7, 8, 9, 11, 12, 14], 5).sort((a, b) => b - a);
    const ips = counts.map((_, i) => `${net}.${v.int(20 + i * 40, 59 + i * 40)}`);
    const pages = ['/index.html', '/timetable', '/results', '/library', '/login'];
    const lines: string[] = [];
    ips.forEach((ip, i) => { for (let k = 0; k < counts[i]; k++) lines.push(`${ip} - - [22/Oct/2026:08:${String(10 + k).padStart(2, '0')}:00 +0000] "GET ${pages[(i + k) % pages.length]} HTTP/1.1" 200 ${v.int(300, 9000)}`); });
    const shuffled = v.some(lines, lines.length);
    const top = v.pick([3, 3, 2]);
    return {
      instructions: lab({
        situation: `The web server is slow and you suspect a few clients. From **/var/log/apache2/access_log**, write the **${top}** addresses with the most requests to **/root/top-clients.txt**, busiest first, one per line as \`COUNT ADDRESS\` (for example \`14 ${net}.7\`) with a single space.`,
        steps: ['The client address is the first field of each line.', 'Count with sort | uniq -c, then sort the counts with sort -rn.', `Keep the first ${top} with head and tidy the spacing with awk '{print $1, $2}'.`],
        tips: ["awk '{print $1}' /var/log/apache2/access_log | sort | uniq -c | sort -rn | head -3"],
      }),
      hints: ['uniq only merges neighbouring lines, so sort first.', 'uniq -c pads the counts with spaces; awk \'{print $1, $2}\' prints them with one space.'],
      initialState: linux(net, { files: { '/var/log/apache2/access_log': shuffled.join('\n') + '\n' } }),
      checks: [file('The top clients are listed busiest first', '/root/top-clients.txt', { equals: ips.slice(0, top).map((ip, i) => `${counts[i]} ${ip}`).join('\n') })],
      solution: [`awk '{print $1}' /var/log/apache2/access_log | sort | uniq -c | sort -rn | head -${top} | awk '{print $1, $2}' > /root/top-clients.txt`, 'cat /root/top-clients.txt'],
      realityNote: 'This pipeline is the classic first look at any web incident; tools like GoAccess and the ELK stack do the same aggregation at scale.',
    };
  }),
  tmpl(1, 4, 'intermediate', 'totals-per-department', 'Total a CSV per department with awk', 'E4', 20, 'Use awk with a field separator and an associative array, then sort the result.', (v) => {
    const net = v.net();
    const depts = v.some(['Finance', 'Registry', 'Library', 'Estates', 'Research', 'Exams', 'Admissions'], 4);
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 14; i++) rows.push([`2026-10-${String(v.int(1, 21)).padStart(2, '0')}`, depts[i % depts.length], v.int(20, 800)]);
    const totals = new Map<string, number>();
    for (const [, d, a] of rows) totals.set(d, (totals.get(d) ?? 0) + a);
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const file_ = v.pick(['/srv/finance/payments.csv', '/srv/finance/requisitions.csv', '/srv/finance/claims.csv']);
    return {
      instructions: lab({
        situation: `**${file_}** has a header line and then \`date,department,amount\`. Write **/root/dept-totals.csv** with a header \`department,total\` and one line per department, **largest total first**.`,
        steps: ['Skip the header with NR > 1 inside awk.', 'Add up with an array: t[$2] += $3.', 'Print each entry in the END block, then sort numerically on the second field.', 'Put the header on top.'],
        tips: [`awk -F, 'NR > 1 {t[$2] += $3} END {for (d in t) print d "," t[d]}' ${file_}`, 'sort -t, -k2,2nr', "{ echo department,total; ...; } > /root/dept-totals.csv"],
      }),
      hints: ['-F, makes the comma the field separator.', 'for (d in t) visits the keys in no particular order, so sort afterwards.'],
      initialState: linux(net, { files: { [file_]: csv('date,department,amount', rows) } }),
      checks: [file('The totals are right and sorted', '/root/dept-totals.csv', { equals: ['department,total', ...sorted.map(([d, t]) => `${d},${t}`)].join('\n') })],
      solution: [`{ echo department,total; awk -F, 'NR > 1 {t[$2] += $3} END {for (d in t) print d "," t[d]}' ${file_} | sort -t, -k2,2nr; } > /root/dept-totals.csv`, 'cat /root/dept-totals.csv'],
      realityNote: 'awk\'s associative arrays make one-line group-by reports; when the data grows, the same idea moves to Python, SQL or a spreadsheet pivot.',
    };
  }),
  tmpl(1, 4, 'advanced', 'find-and-clean', 'Clean old files safely with find and xargs', 'E4', 25, 'Remove old temporary files with find -mtime, -print0 and xargs -0, and keep a record.', (v) => {
    const net = v.net();
    const dir = v.pick(['/srv/uploads', '/srv/scans', '/var/spool/exports']);
    const days = v.pick([7, 14, 30]);
    const oldNames = v.some(['scan 001.tmp', 'draft.tmp', 'upload part1.tmp', 'export-old.tmp', 'tmp copy.tmp'], 3);
    const newNames = v.some(['today.tmp', 'in progress.tmp', 'fresh.tmp'], 2);
    const keep = v.pick(['report.pdf', 'register.csv', 'photo.jpg']);
    const files: Record<string, unknown> = {};
    oldNames.forEach((n, i) => (files[`${dir}/${i % 2 ? 'sub/' : ''}${n}`] = { content: 'x\n', ageDays: days + 5 + i }));
    newNames.forEach((n) => (files[`${dir}/${n}`] = { content: 'x\n', ageDays: 1 }));
    files[`${dir}/${keep}`] = { content: 'keep me\n', ageDays: days + 40 };
    return {
      instructions: lab({
        situation: `**${dir}** (and its subfolders) fills up with **.tmp** files. Delete only the .tmp files older than **${days} days**, keep everything else, and record the paths you removed in **/root/removed.txt**, one per line. Several names contain spaces, so the method must cope with them.`,
        steps: [`List them first: find ${dir} -name '*.tmp' -mtime +${days}.`, 'Save the list with find ... > /root/removed.txt.', 'Delete with find ... -print0 | xargs -0 rm -f (NUL separators survive spaces).', 'Check what is left.'],
        tips: [`find ${dir} -type f -name '*.tmp' -mtime +${days}`, `find ${dir} -type f -name '*.tmp' -mtime +${days} -print0 | xargs -0 -r rm -f`],
      }),
      hints: ['Plain find | xargs rm splits "scan 001.tmp" into two names.', `-mtime +${days} means "more than ${days} days ago".`, 'Always run find without the delete step first and read the list.'],
      initialState: linux(net, { files: files as never }),
      checks: [
        out('The old .tmp files are gone', `find ${dir} -name '*.tmp' -mtime +${days} | wc -l`, { equals: '0' }),
        out('The recent .tmp files remain', `ls ${dir}`, { contains: newNames }),
        out('Other files remain', `ls ${dir}`, { contains: keep }),
        file('The removed paths are recorded', '/root/removed.txt', { contains: oldNames }),
      ],
      solution: [`find ${dir} -type f -name '*.tmp' -mtime +${days}`, `find ${dir} -type f -name '*.tmp' -mtime +${days} > /root/removed.txt`, `find ${dir} -type f -name '*.tmp' -mtime +${days} -print0 | xargs -0 -r rm -f`, `ls -R ${dir}`],
      realityNote: 'systemd-tmpfiles and tmpwatch do this cleanup on most servers; when you script it yourself, -print0 with xargs -0 (or find -delete) is the safe pattern.',
    };
  }),

  /* ---------------------------------------------------------------- 1.5 regular expressions */
  tmpl(1, 5, 'beginner', 'extract-emails', 'Extract addresses with grep -Eo', 'E4', 15, 'Pull every e-mail address out of messy text with an extended regular expression.', (v) => {
    const net = v.net();
    const people = v.people(5);
    const domains = v.some(['campus.lan', 'mail.example.org', 'staff.example.edu', 'example.com'], 2);
    const emails = people.map((p, i) => `${p.given.toLowerCase()}.${p.surname.toLowerCase()}@${domains[i % 2]}`);
    const text = [
      `From the meeting: ${people[0].name} <${emails[0]}> will send the minutes.`,
      `Contact ${emails[1]} or ${emails[2]}; the office phone is 030 222 ${v.int(1000, 9999)}.`,
      `Not an address: user@ (incomplete), @${domains[0]} (no name).`,
      `Copy ${emails[3]}, and ${emails[1]} again for the budget.`,
      `Late addition - ${emails[4]}.`,
    ];
    const uniq = [...new Set(emails)].sort();
    return {
      instructions: lab({
        situation: `**/srv/registry/notes.txt** is a page of meeting notes with e-mail addresses scattered through it. Write the distinct addresses, sorted, one per line, to **/root/emails.txt**. Incomplete fragments such as \`user@\` must not appear.`,
        steps: ['grep -E uses extended regular expressions; -o prints only the matching part.', 'An address is: letters, digits, dots or dashes; then @; then a domain with at least one dot.', 'Sort with sort -u to remove repeats.'],
        tips: ["grep -Eo '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\\.[A-Za-z]+' /srv/registry/notes.txt", 'sort -u'],
      }),
      hints: ['The + means "one or more", so user@ followed by a space does not match.', 'A dot means "any character" unless you escape it as \\.'],
      initialState: linux(net, { files: { '/srv/registry/notes.txt': text.join('\n') + '\n' } }),
      checks: [file('Every address, sorted and distinct', '/root/emails.txt', { equals: uniq.join('\n') })],
      solution: ["grep -Eo '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\\.[A-Za-z]+' /srv/registry/notes.txt | sort -u > /root/emails.txt", 'cat /root/emails.txt'],
      realityNote: 'Matching e-mail addresses perfectly takes a page of regex; a practical pattern plus a review is what administrators really use.',
    };
  }),
  tmpl(1, 5, 'intermediate', 'validate-ids', 'Validate IDs and capture their parts', 'E4', 20, 'Use [[ =~ ]] with groups and BASH_REMATCH to check and split an ID.', (v) => {
    const net = v.net();
    const progs = v.some(['CS', 'IT', 'EE', 'ME', 'BA', 'AC'], 3);
    const name = v.pick(['checkid', 'idcheck', 'parseid']);
    const sep = v.pick(['/', '-']);
    const good = `${progs[1]}${sep}2025${sep}0${v.int(100, 999)}`;
    return {
      instructions: lab({
        situation: `Student IDs look like \`PROG${sep}YEAR${sep}NUMBER\`, for example \`${progs[0]}${sep}2024${sep}0123\`: PROG is two capital letters, YEAR is four digits starting with 20, and NUMBER is exactly four digits.\n\nWrite **/usr/local/bin/${name} ID**. For a valid ID print \`programme=PROG year=YEAR number=NUMBER\` and exit 0; otherwise print \`invalid: ID\` and exit **1**.`,
        steps: ['Write the pattern with three groups: ( ) around each part, anchored with ^ and $.', 'Test with [[ $1 =~ $re ]] (keep the pattern in a variable, unquoted on the right).', 'The groups are in ${BASH_REMATCH[1]}, [2] and [3].'],
        tips: [`re='^([A-Z]{2})${sep === '/' ? '/' : '-'}(20[0-9]{2})${sep === '/' ? '/' : '-'}([0-9]{4})$'`, 'if [[ $1 =~ $re ]]; then ... fi', 'echo "programme=${BASH_REMATCH[1]}"'],
      }),
      hints: ['Without ^ and $, "xx' + good + 'yy" would also match.', 'Quoting the pattern on the right of =~ makes it a plain string, not a regex.'],
      initialState: linux(net),
      checks: [
        script('A valid ID is split into its parts', `/usr/local/bin/${name}`, { args: [good], status: 0, equals: `programme=${good.split(sep)[0]} year=2025 number=${good.split(sep)[2]}` }),
        script('Lower-case programme is invalid', `/usr/local/bin/${name}`, { args: [good.toLowerCase()], status: 1, equals: `invalid: ${good.toLowerCase()}` }),
        script('A five-digit number is invalid', `/usr/local/bin/${name}`, { args: [`${good}1`], status: 1 }),
        script('Extra text around a valid ID is invalid', `/usr/local/bin/${name}`, { args: [`x${good}`], status: 1 }),
        script('A year not starting with 20 is invalid', `/usr/local/bin/${name}`, { args: [`${progs[2]}${sep}1999${sep}0001`], status: 1 }),
      ],
      solution: [writeScript(`/usr/local/bin/${name}`, `re='^([A-Z]{2})${sep}(20[0-9]{2})${sep}([0-9]{4})$'\nif [[ $1 =~ $re ]]; then\n  echo "programme=\${BASH_REMATCH[1]} year=\${BASH_REMATCH[2]} number=\${BASH_REMATCH[3]}"\nelse\n  echo "invalid: $1"\n  exit 1\nfi\n`), `${name} ${good}`],
      realityNote: 'Validating identifiers at the edge of a script stops bad data before it reaches a directory, database or payroll system.',
    };
  }),
  tmpl(1, 5, 'advanced', 'rewrite-dates', 'Rewrite dates in place with sed groups', 'E4', 25, 'Convert DD/MM/YYYY dates to YYYY-MM-DD with sed -E back-references, keeping a backup.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const dates = people.map(() => [v.int(1, 28), v.int(1, 12), v.pick([2025, 2026])] as const);
    const fmt = (d: readonly [number, number, number]) => `${String(d[0]).padStart(2, '0')}/${String(d[1]).padStart(2, '0')}/${d[2]}`;
    const iso = (d: readonly [number, number, number]) => `${d[2]}-${String(d[1]).padStart(2, '0')}-${String(d[0]).padStart(2, '0')}`;
    const ver = `${v.int(1, 3)}.${v.int(0, 9)}/${v.int(10, 99)}`;
    const path = v.pick(['/srv/hr/leave.txt', '/srv/hr/contracts.txt', '/srv/estates/keys.txt']);
    const body = people.map((p, i) => `${p.name}: from ${fmt(dates[i])}`).join('\n') + `\nForm version ${ver} (not a date)\n`;
    return {
      instructions: lab({
        situation: `The new HR system needs ISO dates. In **${path}**, change every date written \`DD/MM/YYYY\` to \`YYYY-MM-DD\`, editing the file in place and keeping the original as **${path}.bak**. The form version number \`${ver}\` must not change.`,
        steps: ['Write a pattern with three groups: two digits, two digits, four digits, separated by slashes.', 'In the replacement, \\3-\\2-\\1 puts the groups in a new order.', 'sed -E -i.bak edits in place and keeps a backup.', 'Compare the two files with diff.'],
        tips: ["sed -E 's#([0-9]{2})/([0-9]{2})/([0-9]{4})#\\3-\\2-\\1#g' FILE", 'sed -E -i.bak ...', `diff ${path}.bak ${path}`],
      }),
      hints: ['Using # as the s command delimiter avoids escaping every slash.', 'Exactly two and exactly four digits keep the version number out.'],
      initialState: linux(net, { files: { [path]: body } }),
      checks: [
        file('The dates are in ISO form', path, { contains: dates.map(iso), notContains: dates.map(fmt) }),
        file('The version number is unchanged', path, { contains: `Form version ${ver} (not a date)` }),
        file('The original is kept as .bak', `${path}.bak`, { equals: body.replace(/\n$/, '') }),
      ],
      solution: [`sed -E -i.bak 's#([0-9]{2})/([0-9]{2})/([0-9]{4})#\\3-\\2-\\1#g' ${path}`, `diff ${path}.bak ${path}`],
      realityNote: 'In-place edits are risky; -i.bak (or version control) is the cheap undo, and testing the expression without -i first is the habit to keep.',
    };
  }),

  /* ---------------------------------------------------------------- 1.6 mktemp, traps and cleanup */
  tmpl(1, 6, 'beginner', 'mktemp-and-trap', 'Use mktemp and clean up on exit', 'E4', 15, 'Replace a fixed temporary file with mktemp and a trap that removes it.', (v) => {
    const net = v.net();
    const people = v.people(3);
    const name = v.pick(['list-staff', 'staff-users', 'human-accounts']);
    return {
      instructions: lab({
        situation: `**/usr/local/bin/${name}** lists the human accounts (UID 1000 or more), sorted. It uses the fixed file **/tmp/users.tmp** and never deletes it: two runs at once overwrite each other, and the file is left behind. Change it to create its temporary file with **mktemp** and remove it with a **trap ... EXIT**, so nothing is left in /tmp after it runs.`,
        steps: ['Read the script.', 'Replace the fixed name with tmp=$(mktemp).', 'Add trap \'rm -f "$tmp"\' EXIT right after creating it.', 'Run it and check that /tmp has nothing new.'],
        tips: ['tmp=$(mktemp)', "trap 'rm -f \"$tmp\"' EXIT", 'ls -A /tmp'],
      }),
      hints: ['mktemp makes a new file with a unique random name and prints the name.', 'An EXIT trap runs however the script ends, even after an error.'],
      initialState: linux(net, { users: Object.fromEntries(people.map((p) => [p.sam, { comment: p.name }])), files: { [`/usr/local/bin/${name}`]: { content: SH("awk -F: '$3 >= 1000 && $3 < 60000 {print $1}' /etc/passwd > /tmp/users.tmp\nsort /tmp/users.tmp\n"), mode: '755' } } }),
      checks: [
        script('It still lists the accounts, sorted', `/usr/local/bin/${name}`, { equals: people.map((p) => p.sam).sort().join('\n') }),
        file('It uses mktemp', `/usr/local/bin/${name}`, { contains: 'mktemp', notContains: '/tmp/users.tmp' }),
        out('Nothing is left in /tmp', `rm -f /tmp/users.tmp; before=$(ls -A /tmp | wc -l); /usr/local/bin/${name} >/dev/null; after=$(ls -A /tmp | wc -l); echo $((after - before))`, { equals: '0' }),
      ],
      solution: [writeScript(`/usr/local/bin/${name}`, "tmp=$(mktemp)\ntrap 'rm -f \"$tmp\"' EXIT\nawk -F: '$3 >= 1000 && $3 < 60000 {print $1}' /etc/passwd > \"$tmp\"\nsort \"$tmp\"\n"), name],
      realityNote: 'Predictable names in /tmp are also a security hole: another user can create the file first as a symlink. mktemp avoids both the clash and the attack.',
    };
  }),
  tmpl(1, 6, 'intermediate', 'atomic-write', 'Replace a configuration file atomically', 'E4', 20, 'Write a new file next to the old one and mv it into place, leaving nothing behind on failure.', (v) => {
    const net = v.net();
    const target = v.pick(['/etc/motd', '/etc/issue.net', '/etc/lab/banner.txt']);
    const name = v.pick(['set-banner', 'banner', 'update-banner']);
    const msg = v.pick(['Maintenance on Saturday 06:00-08:00', 'Authorised use only. Activity is logged.', 'New backup schedule from Monday']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/${name} "TEXT"** that replaces **${target}** with TEXT. A program reading the file must never see it half-written, so:\n\n1. Write TEXT to a temporary file **in the same directory** made with \`mktemp ${target}.XXXXXX\`.\n2. Give it mode 644, then \`mv\` it over ${target} (a rename is atomic within one file system).\n3. With no TEXT, print \`usage: ${name} TEXT\`, exit **2**, and leave ${target} unchanged.\n4. Never leave ${target}.XXXXXX files behind, even if a step fails.\n\nThen set the banner to: ${msg}`,
        steps: ['Create the temporary file with mktemp and a trap that removes it.', 'printf \'%s\\n\' "$1" > "$tmp", chmod 644, mv.', 'Test with and without an argument, and list the directory.'],
        tips: [`tmp=$(mktemp ${target}.XXXXXX)`, "trap 'rm -f \"$tmp\"' EXIT", `mv "$tmp" ${target}`],
      }),
      hints: ['mktemp makes files with mode 600; readers of a banner need 644.', 'After mv the temporary name no longer exists, so the trap\'s rm -f does nothing.'],
      initialState: linux(net, { files: { [target]: 'Welcome\n' } }),
      checks: [
        file('The banner is set', target, { equals: msg, mode: '644' }),
        script('No text: usage and exit 2', `/usr/local/sbin/${name}`, { status: 2, contains: `usage: ${name} TEXT` }),
        out('A failed run leaves the file unchanged', `/usr/local/sbin/${name}; cat ${target}`, { contains: msg }),
        out('No temporary files are left', `/usr/local/sbin/${name} test; /usr/local/sbin/${name} 2>/dev/null; ls ${target.slice(0, target.lastIndexOf('/'))} | grep -c '${target.slice(target.lastIndexOf('/') + 1)}\\.'`, { equals: '0' }),
        file('It uses mktemp in the same directory and mv', `/usr/local/sbin/${name}`, { contains: [`mktemp ${target}.`, 'mv '] }),
      ],
      solution: [writeScript(`/usr/local/sbin/${name}`, `if [ $# -eq 0 ] || [ -z "$1" ]; then\n  echo "usage: ${name} TEXT" >&2\n  exit 2\nfi\ntmp=$(mktemp ${target}.XXXXXX)\ntrap 'rm -f "$tmp"' EXIT\nprintf '%s\\n' "$1" > "$tmp"\nchmod 644 "$tmp"\nmv "$tmp" ${target}\n`), `${name} "${msg}"`, `cat ${target}`],
      realityNote: 'Package managers, editors and configuration tools all write a temporary file and rename it; that is why a power cut leaves the old or the new file, never half of one.',
    };
  }),
  tmpl(1, 6, 'advanced', 'lock-and-cleanup', 'Prevent overlapping runs with a lock and traps', 'E4', 30, 'Use a lock directory and EXIT/INT/TERM traps so a job never runs twice and always cleans up.', (v) => {
    const net = v.net();
    const job = v.pick(['sync-results', 'export-grades', 'import-payroll']);
    const lock = `/run/lock/${job}.lock`;
    const src = `/srv/${v.pick(DEPTS)}/outgoing`;
    const n = v.int(2, 5);
    return {
      instructions: lab({
        situation: `**/usr/local/sbin/${job}** runs from cron every minute and must never overlap. Write it so that:\n\n1. It takes the lock with \`mkdir ${lock}\` (mkdir either creates the directory or fails, in one step). If the lock is held, it prints \`already running\` to standard error and exits **3** without touching the lock.\n2. Once it has the lock, a trap on **EXIT** removes the lock and its temporary files, and traps on **INT** and **TERM** exit so the EXIT trap runs.\n3. Its work: count the files in **${src}** (or the folder given as $1) into a temporary file made with mktemp, then print \`synced N files\`. If the folder does not exist, print an error and exit **1**, still releasing the lock.`,
        steps: ['Take the lock first; set the trap only after you hold it, or a second copy would delete the first copy\'s lock.', 'trap cleanup EXIT and trap \'exit 1\' INT TERM.', 'Test: a normal run, a run with a missing folder, and a run while you hold the lock yourself (mkdir it by hand).'],
        tips: [`mkdir ${lock} 2>/dev/null || { echo "already running" >&2; exit 3; }`, 'cleanup() { rm -rf "$tmp" ' + lock + '; }', 'trap cleanup EXIT', "trap 'exit 1' INT TERM"],
      }),
      hints: ['Testing for a lock file and then creating it is two steps; two copies can both pass the test. mkdir is one step.', 'flock(1) is the other common way; this lab uses mkdir so you can see the lock.'],
      initialState: linux(net, { files: { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`${src}/batch${i + 1}.csv`, 'x\n'])), '/run/lock/': null } }),
      checks: [
        script('A normal run works', `/usr/local/sbin/${job}`, { status: 0, equals: `synced ${n} files` }),
        out('The lock is released afterwards', `/usr/local/sbin/${job} >/dev/null; [ -d ${lock} ] && echo held || echo free`, { equals: 'free' }),
        out('A second copy refuses to run and leaves the lock alone', `mkdir ${lock}; /usr/local/sbin/${job}; echo "rc=$?"; [ -d ${lock} ] && echo held`, { contains: ['already running', 'rc=3', 'held'] }),
        out('A failure still releases the lock', `/usr/local/sbin/${job} /no/such/dir; echo "rc=$?"; [ -d ${lock} ] && echo held || echo free`, { contains: ['rc=1', 'free'] }),
        file('It traps INT and TERM', `/usr/local/sbin/${job}`, { pattern: 'trap .*(INT.*TERM|TERM.*INT)' }),
      ],
      solution: [writeScript(`/usr/local/sbin/${job}`, `lock=${lock}\nmkdir "$lock" 2>/dev/null || { echo "already running" >&2; exit 3; }\ntmp=\ncleanup() {\n  rm -f "$tmp"\n  rmdir "$lock"\n}\ntrap cleanup EXIT\ntrap 'exit 1' INT TERM\nsrc=\${1:-${src}}\n[ -d "$src" ] || { echo "no such folder: $src" >&2; exit 1; }\ntmp=$(mktemp)\nfind "$src" -type f > "$tmp"\necho "synced $(wc -l < "$tmp") files"\n`), job],
      realityNote: 'Overlapping cron runs corrupt data in subtle ways; a lock plus an EXIT trap (or systemd timers, which never start a running unit twice) prevents it.',
    };
  }),
];
