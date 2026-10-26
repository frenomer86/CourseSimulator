import { describe, expect, it } from 'vitest';
import { buildSystem, runLines } from './index.js';

const box = (files: Record<string, string> = {}, tools: string[] = []) =>
  buildSystem({
    hostname: 'dev1',
    user: 'kofi',
    users: { kofi: {} },
    groups: { docker: ['kofi'] },
    packages: Object.fromEntries(['git', 'jq', 'docker', ...tools].map((p) => [p, { installed: true }])),
    services: { docker: { active: true, enabled: true } },
    files,
  } as never);

const git = ['git config --global user.name Kofi', 'git config --global user.email kofi@lab', 'git config --global init.defaultBranch main'];

describe('git for slow links', () => {
  it('deepens a shallow clone one step at a time', () => {
    const sys = box();
    runLines(sys, [...git, 'git init -q src', 'cd src', 'for i in 1 2 3 4 5 6; do echo $i > f; git add f; git commit -qm "c$i"; done']);
    const out = runLines(sys, ['git clone -q --depth 1 file:///home/kofi/src shallow', 'cd shallow', 'git rev-list --count HEAD', 'git fetch -q --deepen=2', 'git rev-list --count HEAD', 'git rev-parse --is-shallow-repository', 'git fetch -q --unshallow', 'git rev-list --count HEAD', 'git rev-parse --is-shallow-repository']);
    expect(out).toBe('1\n3\ntrue\n6\nfalse\n');
  });
});

describe('secret scanning', () => {
  it('scans only commits still in history, so a rewritten leak is gone', () => {
    const sys = box({}, ['gitleaks']);
    runLines(sys, [...git, 'git init -q app', 'cd app', 'echo hi > a; git add a; git commit -qm one', 'echo AWS_ACCESS_KEY_ID=AKIAQ4J5WXYZ7ABCD123 > s.env; git add s.env; git commit -qm leak']);
    expect(runLines(sys, ['cd ~/app', 'gitleaks git >/dev/null 2>&1; echo $?'])).toBe('1\n');
    expect(runLines(sys, ['cd ~/app', 'git reset -q --hard HEAD~1', 'gitleaks git >/dev/null 2>&1; echo $?'])).toBe('0\n');
  });
});

describe('jq', () => {
  it('reads other files with --slurpfile and --rawfile', () => {
    const sys = box({ '/home/kofi/d.json': '[{"id":1},{"id":2}]\n', '/home/kofi/n.txt': 'hello\n' });
    const out = runLines(sys, ["jq -n -c --slurpfile d d.json --rawfile n n.txt '[($d[0] | length), $n]'"]);
    expect(out).toBe('[2,"hello\\n"]\n');
  });
});

describe('ansible', () => {
  it('runs a local playbook with a handler and reports changes', () => {
    const sys = box({ '/home/kofi/site.yml': '- hosts: localhost\n  connection: local\n  gather_facts: false\n  tasks:\n    - name: Write the config\n      copy:\n        dest: /home/kofi/app.conf\n        content: "port=8080\\n"\n      notify: Reload app\n  handlers:\n    - name: Reload app\n      debug:\n        msg: reloaded\n' }, ['ansible']);
    const first = runLines(sys, ['ansible-playbook site.yml']);
    expect(first).toMatch(/RUNNING HANDLER \[Reload app\]/);
    expect(first).toMatch(/changed=1/);
    expect(runLines(sys, ['ansible-playbook site.yml'])).toMatch(/ok=1\s+changed=0/);
  });
});

describe('monitoring config checks', () => {
  it('rejects a rule whose expression does not parse', () => {
    const sys = box({ '/home/kofi/ok.yml': 'groups:\n  - name: app\n    rules:\n      - alert: Down\n        expr: up == 0\n        for: 5m\n', '/home/kofi/bad.yml': 'groups:\n  - name: app\n    rules:\n      - alert: Down\n        expr: up = = 0\n' }, ['prometheus']);
    expect(runLines(sys, ['promtool check rules ok.yml >/dev/null; echo $?', 'promtool check rules bad.yml >/dev/null 2>&1; echo $?'])).toBe('0\n1\n');
  });
});
