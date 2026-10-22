import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { buildSystem, createShellChecks, newSession, runLine, runLines, type ShellState, type ShellSystem } from './index.js';

function fresh(extra: Partial<Parameters<typeof buildSystem>[0]> = {}): ShellSystem {
  return buildSystem({
    user: 'ama',
    users: { ama: { sudo: true }, kofi: {} },
    groups: { staff: ['ama'] },
    files: { '/home/ama/notes.txt': 'milk\neggs\nbread\n', '/home/ama/docs/': null, '/var/log/app.log': 'INFO start\nERROR disk full\nINFO retry\nERROR timeout\n' },
    ...extra,
  });
}

function run(sys: ShellSystem, ...lines: string[]): string {
  return runLines(sys, lines);
}

describe('file commands and permissions', () => {
  it('navigates, lists and creates files', () => {
    const sys = fresh();
    expect(run(sys, 'pwd')).toBe('/home/ama\n');
    expect(run(sys, 'ls')).toBe('docs  notes.txt\n');
    expect(run(sys, 'mkdir -p projects/thesis', 'cd projects/thesis', 'pwd')).toBe('/home/ama/projects/thesis\n');
    expect(run(sys, 'echo hello > hi.txt', 'cat hi.txt')).toBe('hello\n');
    expect(run(sys, 'echo again >> hi.txt', 'wc -l hi.txt')).toBe('2 hi.txt\n');
    expect(run(sys, 'cp hi.txt copy.txt', 'mv copy.txt moved.txt', 'ls')).toBe('hi.txt  moved.txt\n');
    expect(run(sys, 'rm moved.txt', 'ls -l')).toMatch(/^total \d+\n-rw-r--r-- 1 ama staff 12 Oct 22 09:3\d hi.txt\n$/);
    expect(run(sys, 'cat nope')).toBe('cat: nope: No such file or directory\n');
  });
  it('enforces permissions and explains them', () => {
    const sys = fresh();
    expect(run(sys, 'cat /etc/shadow')).toBe('cat: /etc/shadow: Permission denied\n');
    expect(run(sys, 'touch /etc/x')).toBe("touch: cannot touch '/etc/x': Permission denied\n");
    expect(run(sys, 'sudo touch /etc/x', 'ls -l /etc/x')).toMatch(/-rw-r--r-- 1 root root/);
    expect(run(sys, 'chmod 600 notes.txt', 'stat -c %a notes.txt')).toBe('600\n');
    expect(run(sys, 'chmod g+r,o+r notes.txt', 'chmod u-w notes.txt', 'stat -c %A notes.txt')).toBe('-r--r--r--\n');
    expect(run(sys, 'echo x > notes.txt')).toBe('bash: notes.txt: Permission denied\n');
    expect(run(sys, 'su - kofi', 'cat /home/ama/notes.txt', 'exit')).toContain('milk');
    expect(run(sys, 'chmod 700 /home/ama', 'su - kofi', 'cat /home/ama/notes.txt', 'exit')).toContain('Permission denied');
    expect(run(sys, 'whoami')).toBe('ama\n');
    expect(run(sys, 'sudo chown kofi:kofi notes.txt', 'ls -l notes.txt')).toMatch(/kofi kofi/);
    expect(run(sys, 'umask 027', 'touch m.txt', 'mkdir mdir', 'stat -c %a m.txt mdir')).toBe('640\n750\n');
  });
  it('supports ACLs, links, find, tar and gzip', () => {
    const sys = fresh();
    expect(run(sys, 'setfacl -m u:kofi:rw- notes.txt', 'getfacl notes.txt')).toContain('user:kofi:rw-');
    expect(run(sys, 'ls -l notes.txt')).toMatch(/-rw-r--r--\+/);
    expect(run(sys, 'ln -s notes.txt link.txt', 'cat link.txt', 'ls -l link.txt')).toMatch(/milk[\s\S]*link.txt -> notes.txt/);
    expect(run(sys, 'find . -name "*.txt" -type f')).toBe('./notes.txt\n');
    expect(run(sys, 'find /var/log -name "app*"')).toBe('/var/log/app.log\n');
    expect(run(sys, 'tar -czf backup.tar.gz notes.txt docs', 'tar -tf backup.tar.gz')).toBe('notes.txt\ndocs/\n');
    expect(run(sys, 'mkdir restore', 'tar -xzf backup.tar.gz -C restore', 'cat restore/notes.txt')).toBe('milk\neggs\nbread\n');
    expect(run(sys, 'gzip notes.txt', 'ls', 'gunzip notes.txt.gz', 'ls')).toBe('backup.tar.gz  docs  link.txt  notes.txt.gz  restore\nbackup.tar.gz  docs  link.txt  notes.txt  restore\n');
  });
});

describe('text processing and pipes', () => {
  it('grep, sort, uniq, cut, wc, head, tail, tr, sed, awk', () => {
    const sys = fresh();
    expect(run(sys, 'grep ERROR /var/log/app.log')).toBe('ERROR disk full\nERROR timeout\n');
    expect(run(sys, 'grep -c ERROR /var/log/app.log', 'grep -n -i error /var/log/app.log | head -n 1')).toBe('2\n2:ERROR disk full\n');
    expect(run(sys, 'grep -v INFO /var/log/app.log | wc -l')).toBe('2\n');
    expect(run(sys, 'sort notes.txt', 'sort -r notes.txt | head -1')).toBe('bread\neggs\nmilk\nmilk\n');
    expect(run(sys, 'printf "b\\na\\nb\\n" | sort | uniq -c')).toBe('      1 a\n      2 b\n');
    expect(run(sys, 'cut -d: -f1 /etc/passwd | grep -E "^(ama|kofi)$" | sort')).toBe('ama\nkofi\n');
    expect(run(sys, "echo hello world | tr 'a-z' 'A-Z'")).toBe('HELLO WORLD\n');
    expect(run(sys, 'tail -n 2 notes.txt', 'tail -n +2 notes.txt')).toBe('eggs\nbread\neggs\nbread\n');
    expect(run(sys, "sed 's/milk/tea/' notes.txt")).toBe('tea\neggs\nbread\n');
    expect(run(sys, "sed -n '2p' notes.txt", "sed -i 's/eggs/EGGS/' notes.txt", 'cat notes.txt')).toBe('eggs\nmilk\nEGGS\nbread\n');
    expect(run(sys, "awk -F: '$3 >= 1000 {print $1}' /etc/passwd")).toBe('ama\nkofi\n');
    expect(run(sys, "printf '3 4\\n5 6\\n' | awk '{sum += $1 * $2} END {print \"total\", sum}'")).toBe('total 42\n');
    expect(run(sys, "awk 'NR==1 {print NF, $NF, length($0)}' /home/ama/notes.txt")).toBe('1 milk 4\n');
    expect(run(sys, 'ls /var/log | xargs -n1 echo file:')).toContain('file: app.log\n');
    expect(run(sys, 'echo "a b c" | tee out.txt | wc -w', 'cat out.txt')).toBe('3\na b c\n');
  });
  it('redirects stderr and handles exit status', () => {
    const sys = fresh();
    expect(run(sys, 'cat nope 2> err.txt', 'cat err.txt')).toBe('cat: nope: No such file or directory\n');
    expect(run(sys, 'cat nope 2>&1 | wc -l')).toBe('1\n');
    expect(run(sys, 'cat nope; echo $?', 'true && echo yes || echo no', 'false && echo yes || echo no')).toBe('cat: nope: No such file or directory\n1\nyes\nno\n');
    expect(run(sys, 'ls nope > /dev/null 2>&1; echo done')).toContain('done');
  });
});

describe('shell language', () => {
  it('variables, quoting, globbing, substitution, arithmetic', () => {
    const sys = fresh();
    expect(run(sys, 'name=Ama', 'echo "Hello, $name!"', "echo 'Hello, $name!'")).toBe('Hello, Ama!\nHello, $name!\n');
    expect(run(sys, 'echo *.txt', 'echo "*.txt"')).toBe('notes.txt\n*.txt\n');
    expect(run(sys, 'n=$(wc -l < notes.txt); echo "$n lines"', 'echo `whoami`')).toBe('3 lines\nama\n');
    expect(run(sys, 'x=5; echo $((x * 2 + 1))', 'name=Ama; echo ${#name}', 'echo ${missing:-default}', 'f=/var/log/app.log; echo ${f##*/} ${f%.log}')).toBe('11\n3\ndefault\napp.log /var/log/app\n');
    expect(run(sys, 'export GREETING=hi', 'env | grep GREETING')).toBe('GREETING=hi\n');
    expect(run(sys, 'cat <<EOF\nhome is $HOME\nEOF')).toBe('home is /home/ama\n');
    expect(run(sys, 'echo ~', 'echo ~kofi')).toBe('/home/ama\n/home/kofi\n');
  });
  it('runs scripts with arguments, conditionals, loops, functions and set -e', () => {
    const sys = fresh();
    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      'usage() { echo "usage: $0 DIR"; exit 2; }',
      '[ $# -eq 1 ] || usage',
      'dir=$1',
      'if [ ! -d "$dir" ]; then',
      '  echo "no such directory: $dir" >&2',
      '  exit 1',
      'fi',
      'count=0',
      'for f in "$dir"/*; do',
      '  if [ -f "$f" ]; then count=$((count + 1)); fi',
      'done',
      'i=0',
      'while [ $i -lt 3 ]; do i=$((i+1)); done',
      'case "$dir" in',
      '  /home/*) kind=home ;;',
      '  *) kind=other ;;',
      'esac',
      'echo "$count files in $dir ($kind, i=$i)"',
    ].join('\n');
    runLine(sys, 'cat > count.sh <<\'EOF\'\n' + script + '\nEOF', newSession(sys));
    expect(run(sys, 'bash count.sh')).toBe('usage: count.sh DIR\n');
    expect(run(sys, './count.sh /home/ama')).toBe('bash: ./count.sh: Permission denied\n');
    expect(run(sys, 'chmod +x count.sh', './count.sh /home/ama', './count.sh /nope; echo "status $?"')).toBe('2 files in /home/ama (home, i=3)\nno such directory: /nope\nstatus 1\n');
    expect(run(sys, 'for n in 1 2 3; do echo -n "$n "; done; echo')).toBe('1 2 3 \n');
    expect(run(sys, 'greet() { echo "hi $1"; }; greet Kofi; greet Ama')).toBe('hi Kofi\nhi Ama\n');
    expect(run(sys, 'for ((k=0; k<3; k++)); do echo $k; done')).toBe('0\n1\n2\n');
    expect(run(sys, 'printf "ama\\nkofi\\n" | while read u; do echo "user=$u"; done')).toBe('user=ama\nuser=kofi\n');
    expect(run(sys, 'if grep -q milk notes.txt; then echo found; fi')).toBe('found\n');
    expect(run(sys, 'echo "if [ -z "" ]; then echo empty; fi" > t.sh; bash t.sh')).toBe('empty\n');
    expect(run(sys, 'bash -n count.sh; echo ok')).toBe('ok\n');
    expect(run(sys, 'echo "echo \\$1-\\$2" > args.sh; bash args.sh a b')).toBe('a-b\n');
  });
  it('reports syntax errors and unknown commands helpfully', () => {
    const sys = fresh();
    expect(run(sys, 'tree')).toContain("command not found\nThe program 'tree' can be found in the package 'tree'");
    expect(run(sys, 'frobnicate')).toBe('bash: frobnicate: command not found\n');
    expect(run(sys, 'if true; then echo x')).toMatch(/syntax error/);
    expect(run(sys, 'echo "unterminated')).toMatch(/unexpected EOF/);
  });
});

describe('administration', () => {
  it('manages users, groups, passwords and sudo', () => {
    const sys = fresh();
    expect(run(sys, 'useradd -m yaw')).toBe('useradd: Permission denied.\n');
    expect(run(sys, 'sudo useradd -m -c "Yaw Owusu" -G staff yaw', 'id yaw', 'ls -ld /home/yaw')).toMatch(/uid=100\d\(yaw\) gid=100\d\(yaw\) groups=100\d\(yaw\),100\d\(staff\)\ndrwxr-xr-x 2 yaw yaw/);
    expect(run(sys, 'sudo groupadd auditors', 'sudo usermod -aG auditors yaw', 'groups yaw', 'grep auditors /etc/group')).toBe('yaw : yaw staff auditors\nauditors:x:100\\d:yaw\n'.replace('100\\d', String(sys.groups.auditors.gid)));
    expect(run(sys, 'sudo passwd yaw', 'sudo passwd -l yaw', 'sudo passwd -S yaw')).toMatch(/password updated successfully[\s\S]*yaw L /);
    expect(run(sys, 'su - kofi', 'sudo ls /root', 'exit')).toContain('kofi is not in the sudoers file');
    expect(run(sys, 'sudo cat /var/log/auth.log')).toMatch(/useradd.*name=yaw[\s\S]*sudo: kofi : user NOT in sudoers/);
    expect(run(sys, 'sudo userdel -r yaw', 'id yaw', 'ls /home')).toBe("id: 'yaw': no such user\nama  kofi\n");
    expect(run(sys, 'sudo -i', 'whoami', 'pwd', 'exit', 'whoami')).toBe('root\n/root\nlogout\nama\n');
  });
  it('manages processes, services, packages, cron and logs', () => {
    const sys = fresh({ processes: [{ cmd: '/usr/bin/python3 runaway.py', user: 'kofi', cpu: 97, mem: 12 }], services: { apache2: { description: 'The Apache Webserver', faults: [{ file: '/etc/apache2/listen.conf', pattern: 'Listen 8o', message: 'AH00526: Syntax error on line 1 of /etc/apache2/listen.conf: Port must be specified' }] } }, packages: { apache2: { installed: true } }, files: { '/etc/apache2/listen.conf': 'Listen 8o\n', '/srv/www/htdocs/index.html': '<h1>hi</h1>\n' } });
    const pid = sys.processes.find((p) => p.cmd.includes('runaway'))!.pid;
    expect(run(sys, 'ps aux | grep runaway | grep -v grep')).toMatch(new RegExp('kofi\\s+' + pid + '\\s+97\\.0'));
    expect(run(sys, `kill ${pid}`)).toContain('Operation not permitted');
    expect(run(sys, `sudo kill -9 ${pid}`, 'pgrep -f runaway; echo "status $?"')).toBe('status 1\n');
    expect(run(sys, 'sudo systemctl start apache2')).toContain('Job for apache2.service failed');
    expect(run(sys, 'systemctl status apache2')).toMatch(/failed[\s\S]*Port must be specified/);
    expect(run(sys, 'sudo journalctl -u apache2 -n 3')).toContain('Failed to start');
    expect(run(sys, "sudo sed -i 's/8o/80/' /etc/apache2/listen.conf", 'sudo systemctl enable --now apache2', 'systemctl is-active apache2', 'curl http://localhost/')).toContain('active\n<h1>hi</h1>');
    expect(run(sys, 'sudo zypper install tree', 'tree /home/kofi')).toContain('0 directories, 0 files');
    expect(run(sys, 'zypper install htop')).toContain('Root privileges are required');
    expect(run(sys, 'echo "0 2 * * * /usr/local/bin/backup.sh" | crontab -', 'crontab -l')).toBe('0 2 * * * /usr/local/bin/backup.sh\n');
    expect(run(sys, 'echo "99 2 * * * x" | crontab -')).toContain('bad minute');
    expect(run(sys, 'man chmod')).toContain('change file mode bits');
    expect(run(sys, 'history | tail -n 2 | head -n 1')).toMatch(/man chmod/);
  });
});

describe('sh.* checks', () => {
  const checks = createShellChecks();
  const lab = (specs: LabSpec['checks']): LabSpec<ShellState> => ({ id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E4', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1 });
  it('judges files, output, users, services, cron and scripts', async () => {
    const sys = fresh();
    run(sys, 'mkdir -p reports', 'echo "weekly" > reports/week1.txt', 'chmod 640 reports/week1.txt', 'sudo useradd -m -G staff yaw', "printf '#!/bin/bash\\necho \"hello $1\"\\n' > hello.sh", 'chmod +x hello.sh', 'echo "30 6 * * 1-5 /home/ama/hello.sh" | crontab -');
    const spec = lab([
      { type: 'sh.file', label: 'report', path: '/home/ama/reports/week1.txt', contains: 'weekly', mode: '640', owner: 'ama' },
      { type: 'sh.file', label: 'dir', path: '/home/ama/reports', kind: 'dir' },
      { type: 'sh.output', label: 'count', command: 'ls /home/ama/reports | wc -l', equals: '1' },
      { type: 'sh.user', label: 'yaw', name: 'yaw', groups: ['staff'], homeExists: true },
      { type: 'sh.ran', label: 'used chmod', pattern: '^chmod' },
      { type: 'sh.cron', label: 'cron', user: 'ama', pattern: '^30 6 \\* \\* 1-5 .*hello' },
      { type: 'sh.script', label: 'script', path: '/home/ama/hello.sh', args: ['world'], contains: 'hello world', status: 0 },
      { type: 'sh.service', label: 'sshd', name: 'sshd', active: true },
      { type: 'sh.package', label: 'tree', name: 'tree', installed: false },
    ]);
    const good = await checks.run(spec, { system: sys, history: sys.history });
    expect(good.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
    const bad = await checks.run(spec, { system: fresh(), history: [] });
    expect(bad.checks.map((c) => c.passed)).toEqual([false, false, false, false, false, false, false, true, true]);
    expect(bad.checks[3].message).toMatch(/no user called yaw/);
  });
});
