import { describe, expect, it } from 'vitest';
import { buildSystem, type SystemSpec } from './system.js';
import { newSession, runLine, runLines } from './shell.js';
import { makeCert } from './cert.js';
import { apiState } from './labapi.js';
import { md5, sha1, sha256 } from './hash.js';

const sys = (extra: Partial<SystemSpec> = {}) => buildSystem({ user: 'root', hostname: 'srv1', ...extra });
/** Runs lines in one session, so $? and variables carry over. */
const session = (s: ReturnType<typeof sys>, lines: string[]) => {
  const ses = newSession(s);
  return lines.map((l) => runLine(s, l, ses).output).join('');
};

describe('bash language', () => {
  it('handles indexed and associative arrays', () => {
    const out = session(sys(), [
      'arr=(a "b c" d); arr+=(e); echo "${#arr[@]} ${arr[1]} ${arr[-1]} ${arr[@]:1:2}"',
      'for x in "${arr[@]}"; do printf "[%s]" "$x"; done; echo',
      'declare -A m=([fin]=Finance [reg]=Registry); m[lib]=Library; for k in "${!m[@]}"; do echo "$k=${m[$k]}"; done | sort',
      'nums=(3 4 5); total=0; for i in "${!nums[@]}"; do (( total += nums[i] )); done; echo total=$total',
      'unset "arr[0]"; echo "${arr[@]}"',
    ]);
    expect(out).toContain('4 b c e b c d');
    expect(out).toContain('[a][b c][d][e]');
    expect(out).toContain('fin=Finance\nlib=Library\nreg=Registry');
    expect(out).toContain('total=12');
    expect(out).toContain('b c d e');
  });

  it('scopes local variables to the function', () => {
    const out = session(sys(), ['x=outer; f() { local x=inner; echo "in $x"; }; f; echo "out $x"', 'g() { local y; y=1; }; g; echo "y=${y:-unset}"']);
    expect(out).toContain('in inner\nout outer');
    expect(out).toContain('y=unset');
  });

  it('parses options with getopts, including clusters, arguments and errors', () => {
    const s = sys({ files: { '/root/o.sh': '#!/bin/bash\nwhile getopts ":vn:" o; do case $o in v) echo V;; n) echo "N=$OPTARG";; :) echo "need -$OPTARG";; \\?) echo "bad -$OPTARG";; esac; done; shift $((OPTIND-1)); echo "rest=$*"\n' } });
    expect(runLines(s, ['bash /root/o.sh -vn kofi a b'])).toBe('V\nN=kofi\nrest=a b\n');
    expect(runLines(s, ['bash /root/o.sh -x -n'])).toBe('bad -x\nneed -n\nrest=\n');
  });

  it('runs EXIT and ERR traps and honours set -euo pipefail', () => {
    const s = sys({ files: { '/root/t.sh': '#!/bin/bash\nset -euo pipefail\ntrap \'echo cleanup\' EXIT\ntrap \'echo "failed at $LINENO"\' ERR\nfalse | true\necho never\n' } });
    expect(session(s, ['bash /root/t.sh', 'echo rc=$?'])).toBe('failed at 5\ncleanup\nrc=1\n');
  });

  it('evaluates [[ ]] with patterns, regex captures and && inside', () => {
    const out = session(sys(), ['n=kofi7; [[ $n =~ ^([a-z]+)([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"', '[[ $n == k* && -n $n ]] && echo glob', '[[ $n == "k*" ]] || echo literal', 'e=""; [[ -z $e ]] && echo empty']);
    expect(out).toBe('kofi/7\nglob\nliteral\nempty\n');
  });

  it('supports here-strings, process substitution, mapfile, read -a and printf -v', () => {
    const out = session(sys({ files: { '/root/l.txt': 'one\ntwo\n' } }), ['read -r a b <<< "x y"; echo "$a-$b"', 'while read -r l; do echo "got $l"; done < <(printf "p\\nq\\n")', 'mapfile -t L < /root/l.txt; echo "${#L[@]} ${L[1]}"', 'read -ra parts <<< "a b c"; echo "${parts[2]}"', 'printf -v p "%03d" 7; echo $p', "echo $'tab\\there'"]);
    expect(out).toBe('x-y\ngot p\ngot q\n2 two\nc\n007\ntab\there\n');
  });

  it('shows only exported variables to child scripts', () => {
    const out = session(sys(), ['v=1; bash -c \'echo "child:${v:-none}"\'', 'export v; bash -c \'echo "child:${v:-none}"\'']);
    expect(out).toBe('child:none\nchild:1\n');
  });

  it('treats a carriage return as part of the word, so CRLF scripts fail', () => {
    const s = sys({ files: { '/root/w.sh': '#!/bin/bash\r\nif true; then\r\n  echo ok\r\nfi\r\n' } });
    expect(session(s, ['bash /root/w.sh', 'echo rc=$?'])).toMatch(/syntax error[\s\S]*rc=2/);
  });
});

describe('scripting tools', () => {
  it('computes real digests', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('parses relative dates and reads certificate expiry', () => {
    const s = sys({ files: { '/etc/ssl/a.pem': makeCert({ subject: '/CN=a.lan', notBefore: '2026-01-01T00:00:00Z', notAfter: '2026-11-05T00:00:00Z' }) } });
    const out = session(s, ['date -d "30 days ago" +%F', 'date -d "2026-10-22 +2 weeks" +%F', 'openssl x509 -in /etc/ssl/a.pem -noout -enddate', 'openssl x509 -in /etc/ssl/a.pem -noout -checkend 2592000; echo rc=$?']);
    expect(out).toBe('2026-09-22\n2026-11-05\nnotAfter=Nov  5 00:00:00 2026 GMT\nCertificate will expire\nrc=1\n');
  });

  it('talks to the lab API with tokens, JSON, retries and failures', () => {
    const s = sys({ files: { '/var/lib/labapi/api.json': apiState({ token: 'T', failNext: 1, unique: { users: 'username' }, resources: { users: [{ id: 1, username: 'ama', active: true }] } }) } });
    const out = session(s, [
      'curl -s --retry 2 -H "Authorization: Bearer T" http://api.campus.lan:8080/api/users',
      'curl -s -o /dev/null -w "%{http_code}" http://api.campus.lan:8080/api/users; echo',
      'curl -s -H "Authorization: Bearer T" --json \'{"username":"esi"}\' http://api.campus.lan:8080/api/users',
      'curl -sf -H "Authorization: Bearer T" --json \'{"username":"esi"}\' http://api.campus.lan:8080/api/users; echo rc=$?',
    ]);
    expect(out).toContain('[{"id":1,"username":"ama","active":true}]');
    expect(out).toContain('401');
    expect(out).toContain('{"id":2,"username":"esi"}');
    expect(out).toContain('rc=22');
  });

  it('runs jq filters, formats and updates', () => {
    const s = sys({ packages: { jq: { installed: true } }, files: { '/root/u.json': '[{"name":"ama","dept":"fin","q":10},{"name":"kofi","dept":"lib","q":5},{"name":"esi","dept":"fin","q":7}]' } });
    const out = session(s, [
      `jq -r 'group_by(.dept) | .[] | [.[0].dept, (map(.q) | add)] | @csv' /root/u.json`,
      `jq -c 'map(select(.q > 6) | .name)' /root/u.json`,
      `jq '.[1].q = 9 | .[1].q' /root/u.json`,
      `jq -r --arg d lib '.[] | select(.dept == $d) | "\\(.name) in \\(.dept)"' /root/u.json`,
    ]);
    expect(out).toBe('"fin",17\n"lib",5\n["ama","esi"]\n9\nkofi in lib\n');
  });

  it('rotates logs as logrotate does', () => {
    const s = sys({ files: { '/var/log/app/app.log': 'a\n', '/etc/logrotate.d/app': '/var/log/app/app.log {\n  rotate 2\n  compress\n  missingok\n  create 0640 root root\n}\n' } });
    session(s, ['logrotate -f /etc/logrotate.d/app', 'echo b > /var/log/app/app.log', 'logrotate -f /etc/logrotate.d/app', 'echo c > /var/log/app/app.log', 'logrotate -f /etc/logrotate.d/app']);
    expect(session(s, ['ls /var/log/app', 'zcat /var/log/app/app.log.1.gz', 'stat -c %a /var/log/app/app.log'])).toBe('app.log  app.log.1.gz  app.log.2.gz\nc\n640\n');
  });

  it('runs bats tests and lints with shellcheck', () => {
    const s = sys({
      packages: { bats: { installed: true }, shellcheck: { installed: true } },
      files: {
        '/root/t.bats': '@test "two plus two" {\n  run expr 2 + 2\n  [ "$status" -eq 0 ]\n  [ "$output" = "4" ]\n}\n@test "fails" {\n  run false\n  [ "$status" -eq 0 ]\n}\n',
        '/root/s.sh': '#!/bin/bash\ncd $1\nfor f in $(ls); do echo $f; done\n',
      },
    });
    const out = session(s, ['bats /root/t.bats', 'shellcheck -f gcc /root/s.sh']);
    expect(out).toContain(' ✓ two plus two\n ✗ fails\n');
    expect(out).toContain('`[ "$status" -eq 0 ]\' failed');
    expect(out).toContain('2 tests, 1 failure');
    expect(out).toContain('[SC2164]');
    expect(out).toContain('[SC2045]');
    expect(out).toContain('[SC2086]');
  });
});
