/** Unit 7: safe testing of scripts. */

import { seedRepo } from '@cslab/engine-shell/src/git-state';
import type { TaskTemplate } from '../types';
import { DEPTS, SH, caseStudy, dc01, file, group, lab, linux, nic, out, ps, psWrite, ran, script, tmpl, windows, write, writeScript } from './kit';

export const U7: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 7.1 dry runs and tracing */
  tmpl(7, 1, 'beginner', 'shellcheck-clean', 'Make a script pass ShellCheck', 'E4', 20, 'Install ShellCheck and fix the quoting, backtick and unused-variable warnings in a script.', (v) => {
    const net = v.net();
    const dir = `/srv/${v.pick(DEPTS)}/incoming`;
    const name = v.pick(['list-incoming', 'show-uploads', 'count-files']);
    return {
      instructions: lab({
        situation: `**/usr/local/bin/${name} DIR** prints each file name in DIR and then \`total N\`. It works on simple names, but ShellCheck finds problems that will bite one day. Install **shellcheck**, run it on the script, and fix every warning until \`shellcheck /usr/local/bin/${name}\` prints nothing and exits 0. The script must still give the same output (test it on ${dir}, which has a file name with a space).`,
        steps: ['zypper --non-interactive install shellcheck', `shellcheck /usr/local/bin/${name}`, 'Read each SC code: SC2086 quoting, SC2006 backticks, SC2034 unused variable.', 'Fix, re-run shellcheck, re-test the script.'],
        tips: [`shellcheck /usr/local/bin/${name}`, 'for f in "$1"/*; do', 'n=$((n + 1))'],
      }),
      hints: ['Iterating over $(ls ...) breaks on spaces; a glob does not.', 'Remove a variable nobody reads rather than silencing the warning.'],
      initialState: linux(net, { files: { [`${dir}/report one.txt`]: 'x\n', [`${dir}/minutes.txt`]: 'y\n', [`/usr/local/bin/${name}`]: { content: SH('dir=$1\nstamp=`date +%F`\nn=0\nfor f in $dir/*; do\n  echo $(basename $f)\n  n=`expr $n + 1`\ndone\necho total $n\n'), mode: '755' } } }),
      checks: [
        out('ShellCheck finds nothing', `shellcheck /usr/local/bin/${name}; echo "rc=$?"`, { equals: 'rc=0' }),
        script('The script still works, spaces included', `/usr/local/bin/${name}`, { args: [dir], equals: 'minutes.txt\nreport one.txt\ntotal 2' }),
      ],
      solution: ['zypper --non-interactive install shellcheck', `shellcheck /usr/local/bin/${name}`, writeScript(`/usr/local/bin/${name}`, 'dir=$1\nn=0\nfor f in "$dir"/*; do\n  basename "$f"\n  n=$((n + 1))\ndone\necho "total $n"\n'), `shellcheck /usr/local/bin/${name}`, `${name} ${dir}`],
      realityNote: 'ShellCheck in the editor and in CI catches most shell bugs before they run; many teams refuse to merge a script with warnings.',
    };
  }),
  tmpl(7, 1, 'intermediate', 'debug-trace-switch', 'Add a debug switch with set -x and PS4', 'E4', 20, 'Trace a script with file and line numbers only when DEBUG is set, and find a bug with it.', (v) => {
    const net = v.net();
    const name = v.pick(['sum-claims', 'sum-fees', 'sum-orders']);
    const rows = Array.from({ length: 4 }, () => v.int(10, 90));
    const total = rows.reduce((a, b) => a + b, 0);
    return {
      instructions: lab({
        situation: `**/usr/local/bin/${name} FILE** should print the total of the second column of a CSV, but prints 0. Add a **debug switch** to it: when the environment variable **DEBUG** is set, the script traces each command with \`set -x\`, prefixed by its file and line number (\`PS4='+ \${BASH_SOURCE}:\${LINENO}: '\`); without DEBUG it prints only the result. Use the trace to find the bug and fix it so that \`${name} /srv/data/${name.split('-')[1]}.csv\` prints \`total ${total}\`.`,
        steps: ['Near the top: PS4=\'+ ${BASH_SOURCE}:${LINENO}: \' and [[ -n ${DEBUG:-} ]] && set -x', `Run DEBUG=1 ${name} FILE and read the trace on standard error.`, 'Fix the line that is wrong and run it again without DEBUG.'],
        tips: ["PS4='+ ${BASH_SOURCE}:${LINENO}: '", '[[ -n ${DEBUG:-} ]] && set -x', `DEBUG=1 ${name} /srv/data/FILE.csv`],
      }),
      hints: ['The trace shows each command after expansion, so a wrong variable name is easy to spot.', 'bash -x script does the same for one run without editing the script.'],
      initialState: linux(net, { files: { [`/srv/data/${name.split('-')[1]}.csv`]: ['id,amount', ...rows.map((r, i) => `${i + 1},${r}`)].join('\n') + '\n', [`/usr/local/bin/${name}`]: { content: SH('file=$1\ntotal=0\nwhile IFS=, read -r id amount; do\n  [ "$id" = id ] && continue\n  total=$((total + amonut))\ndone < "$file"\necho "total $total"\n'), mode: '755' } } }),
      checks: [
        script('The total is right', `/usr/local/bin/${name}`, { args: [`/srv/data/${name.split('-')[1]}.csv`], equals: `total ${total}` }),
        out('DEBUG=1 traces with file and line', `DEBUG=1 /usr/local/bin/${name} /srv/data/${name.split('-')[1]}.csv 2>&1 >/dev/null | head -3`, { pattern: `^\\+ /usr/local/bin/${name}:\\d+: ` }),
        out('Without DEBUG there is no trace', `/usr/local/bin/${name} /srv/data/${name.split('-')[1]}.csv 2>&1 | wc -l`, { equals: '1' }),
      ],
      solution: [`DEBUG=1 bash -x /usr/local/bin/${name} /srv/data/${name.split('-')[1]}.csv`, writeScript(`/usr/local/bin/${name}`, "PS4='+ ${BASH_SOURCE}:${LINENO}: '\n[[ -n ${DEBUG:-} ]] && set -x\nfile=$1\ntotal=0\nwhile IFS=, read -r id amount; do\n  [ \"$id\" = id ] && continue\n  total=$((total + amount))\ndone < \"$file\"\necho \"total $total\"\n"), `${name} /srv/data/${name.split('-')[1]}.csv`],
      realityNote: 'A DEBUG switch with a useful PS4 turns "it does not work" reports into a trace you can read, without editing the script on a production server.',
    };
  }),
  tmpl(7, 1, 'advanced', 'scriptanalyzer-clean', 'Clean up a script with PSScriptAnalyzer', 'E4', 25, 'Fix verb, Write-Host, plain-text password and ShouldProcess findings until Invoke-ScriptAnalyzer is silent.', (v) => {
    const net = v.net();
    const noun = v.pick(['TempFolder', 'OldReports', 'PrintQueue']);
    const target = noun === 'PrintQueue' ? 'C:\\Spool' : `C:\\${noun}`;
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Maintenance.ps1** defines a function that empties **${target}**. Install **PSScriptAnalyzer** and run \`Invoke-ScriptAnalyzer\` on it. Fix every finding:\n\n- use an **approved verb** (Clear-${noun});\n- replace **Write-Host** with Write-Verbose or output;\n- take the credential as a **[pscredential]**, not a plain-text password string;\n- support **-WhatIf/-Confirm** (SupportsShouldProcess) because it deletes things.\n\nWhen \`Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1\` returns nothing, dot-source the file and run \`Clear-${noun} -WhatIf\` to prove nothing is deleted.`,
        steps: ['Install-Module PSScriptAnalyzer -Force', 'Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1', 'Get-Verb shows the approved verbs.', 'Rewrite, re-run the analyzer.'],
        tips: ['Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1 | Select-Object RuleName, Line, Message', '[CmdletBinding(SupportsShouldProcess)]', 'param([pscredential]$Credential)', "if ($PSCmdlet.ShouldProcess($path, 'Remove contents')) { ... }"],
      }),
      hints: ['If the credential is not used, drop the parameter: the analyzer also flags unused parameters.', 'Write-Host bypasses the output streams, so callers cannot capture or silence it.'],
      initialState: windows({ machines: [dc01(net)], files: { [`${target}\\old1.tmp`]: 'x\n', [`${target}\\old2.tmp`]: 'y\n', 'C:\\Scripts\\Maintenance.ps1': `function Empty-${noun} {\n    param([string]$Password)\n    Write-Host "emptying ${target}"\n    Remove-Item ${target}\\* -Recurse -Force\n}\n` } }),
      checks: [
        ps('The analyzer finds nothing', '@(Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1).Count', { equals: '0' }),
        ps('-WhatIf deletes nothing', `. C:\\Scripts\\Maintenance.ps1; Clear-${noun} -WhatIf | Out-Null; @(Get-ChildItem ${target}).Count`, { equals: '2' }),
        ps('Without -WhatIf it empties the folder', `. C:\\Scripts\\Maintenance.ps1; Clear-${noun} -Confirm:$false; @(Get-ChildItem ${target}).Count`, { equals: '0' }),
        ps('It uses an approved verb', `. C:\\Scripts\\Maintenance.ps1; (Get-Command Clear-${noun}).Name`, { equals: `Clear-${noun}` }),
      ],
      solution: ['Install-Module PSScriptAnalyzer -Force', 'Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1', psWrite('C:\\Scripts\\Maintenance.ps1', `function Clear-${noun} {\n    [CmdletBinding(SupportsShouldProcess)]\n    param()\n    Write-Verbose "emptying ${target}"\n    if ($PSCmdlet.ShouldProcess('${target}', 'Remove contents')) {\n        Remove-Item ${target}\\* -Recurse -Force\n    }\n}`), '@(Invoke-ScriptAnalyzer -Path C:\\Scripts\\Maintenance.ps1).Count', `. C:\\Scripts\\Maintenance.ps1; Clear-${noun} -WhatIf`],
      realityNote: 'PSScriptAnalyzer is what the PowerShell Gallery runs on every module; adding it to CI keeps a team\'s scripts consistent and safer.',
    };
  }),

  /* ---------------------------------------------------------------- 7.2 disposable test environments */
  tmpl(7, 2, 'beginner', 'where-to-test', 'Choose where to test a change', 'E10', 15, 'Pick snapshots, test VMs, containers or production for different script changes.', (v) => {
    const svc = v.pick(['the student portal', 'the payroll server', 'the library catalogue']);
    return caseStudy(v, {
      intro: `## Somewhere safe to break things\n\nYou have three changes to test this week. Each needs a place to fail safely before it touches ${svc}.`,
      steps: [
        { title: 'A cleanup script that deletes files', text: 'The script removes old uploads. You are not sure the path logic is right.', choices: [{ text: 'Run it in a throw-away container or VM against a copy of the data first', right: true, feedback: 'Correct. A disposable copy can be deleted and recreated in seconds.' }, { text: 'Run it on production with -n and hope the dry run is complete', feedback: 'A dry run helps, but only if the script implements it correctly, which is what you are testing.' }, { text: 'Read it carefully and run it', feedback: 'Review is good; it is not a test.' }] },
        { title: 'A risky upgrade on a VM', text: 'You must upgrade a package on a virtual server that has no test copy.', choices: [{ text: 'Take a checkpoint, upgrade, test, and either delete the checkpoint or restore it', right: true, feedback: 'Correct. Then remove the checkpoint: they are not backups and slow the disk over time.' }, { text: 'Rely on last night\'s backup', feedback: 'A restore from backup takes far longer than reverting a checkpoint.' }, { text: 'Keep checkpoints forever, just in case', feedback: 'Old checkpoints grow and hurt performance; they are short-term safety nets.' }] },
        { title: 'Testing on many distributions', text: 'A script must work on openSUSE, Debian and Rocky Linux.', choices: [{ text: 'Run it in containers of each distribution, from a script, every time it changes', right: true, feedback: 'Correct. Containers start in seconds and are identical every run.' }, { text: 'Keep three long-lived test servers and update them by hand', feedback: 'They drift and stop matching production.' }, { text: 'Test on openSUSE only; they are all Linux', feedback: 'Package names, paths and tools differ.' }] },
        { title: 'Data in the test environment', text: 'The test copy needs realistic student data.', choices: [{ text: 'Use generated or anonymised data, never a raw copy of real records', right: true, feedback: 'Correct. Test environments are less protected, and data protection law still applies.' }, { text: 'Copy the production database; it is internal anyway', feedback: 'That exposes real personal data on a less secure system.' }, { text: 'Test with an empty database', feedback: 'Then you never test the cases real data creates.' }] },
      ],
      ending: { title: 'Safe places to fail', text: 'Containers for quick isolated runs, checkpoints around risky changes on VMs (removed afterwards), and generated data instead of real records.' },
      hints: ['Ask: if this goes wrong, how fast can I get back?', 'A test environment should be cheap to throw away.'],
      realityNote: 'Infrastructure that can be rebuilt from scripts makes test environments cheap; that, more than any tool, is what makes testing routine.',
    });
  }),
  tmpl(7, 2, 'intermediate', 'checkpoint-before-change', 'Protect a change with a VM checkpoint', 'E4', 20, 'Checkpoint a test VM, make a change, restore when it goes wrong, and remove the checkpoint.', (v) => {
    const net = v.net();
    const vm = v.pick(['LAB-TEST01', 'APP-STAGING', 'WEB-TEST02']);
    const mem = v.pick([2048, 4096]);
    const cp = v.pick(['before-tuning', 'pre-change', 'baseline']);
    return {
      instructions: lab({
        situation: `On the Hyper-V host **HV01**, test a change on **${vm}** safely:\n\n1. take a checkpoint named **${cp}**;\n2. make the change: set the VM's notes to \`tuning test\` and its processor count to **8** (the planned tuning);\n3. the tuning turns out to be wrong: **restore** the checkpoint so the VM is back to its original settings;\n4. **remove** the checkpoint so it does not grow on disk.\n\nWork on HV01 with Enter-PSSession or Invoke-Command.`,
        steps: ['Enter-PSSession HV01', `Checkpoint-VM -Name ${vm} -SnapshotName ${cp}`, `Set-VM -Name ${vm} -Notes 'tuning test' -ProcessorCount 8`, `Restore-VMSnapshot -VMName ${vm} -Name ${cp} -Confirm:$false; Remove-VMSnapshot -VMName ${vm} -Name ${cp}`],
        tips: [`Checkpoint-VM -Name ${vm} -SnapshotName ${cp}`, `Get-VMSnapshot -VMName ${vm}`, `Restore-VMSnapshot -VMName ${vm} -Name ${cp} -Confirm:$false`, `Remove-VMSnapshot -VMName ${vm} -Name ${cp}`],
      }),
      hints: ['A checkpoint is not a backup: it lives on the same storage and depends on the parent disk.', 'Production checkpoints use VSS inside the guest so applications restore consistently.'],
      initialState: windows({ machines: [dc01(net), { name: 'HV01', features: ['Hyper-V'], nics: [nic(`${net}.30`, net)], hyperv: { switches: [{ name: 'LabSwitch', type: 'Internal' }], vms: [{ name: vm, memoryMb: mem, generation: 2, cpus: 2, state: 'Running', checkpoints: [], notes: 'baseline build' }] } } as never] }),
      checks: [
        ps('The VM is back to 2 processors', `(Get-VM -Name ${vm}).ProcessorCount`, { machine: 'HV01', equals: '2' }),
        ps('The notes are back too', `(Get-VM -Name ${vm}).Notes`, { machine: 'HV01', equals: 'baseline build' }),
        ps('The checkpoint was removed', `@(Get-VMSnapshot -VMName ${vm}).Count`, { machine: 'HV01', equals: '0' }),
        ran('A checkpoint was taken and restored', `Restore-VMSnapshot[^\\n]*${cp}|Restore-VMCheckpoint[^\\n]*${cp}`),
      ],
      solution: [`Invoke-Command -ComputerName HV01 -ScriptBlock { Checkpoint-VM -Name ${vm} -SnapshotName ${cp} }`, `Invoke-Command -ComputerName HV01 -ScriptBlock { Set-VM -Name ${vm} -Notes 'tuning test' -ProcessorCount 8 }`, `Invoke-Command -ComputerName HV01 -ScriptBlock { Restore-VMSnapshot -VMName ${vm} -Name ${cp} -Confirm:$false; Remove-VMSnapshot -VMName ${vm} -Name ${cp} }`],
      realityNote: 'Checkpoint, change, verify, then restore or delete: the discipline matters more than the tool, and leftover checkpoints are a common cause of full datastores.',
    };
  }),
  tmpl(7, 2, 'advanced', 'test-in-container', 'Test a destructive script in a container', 'E4', 25, 'Run a cleanup script against a copy of test data inside a throw-away container, then compare.', (v) => {
    const net = v.net();
    const days = v.pick([7, 30]);
    const keepers = v.some(['register.csv', 'minutes.docx', 'photo.jpg', 'notes.txt'], 2);
    const junk = v.some(['scan 01.tmp', 'draft.tmp', 'export.tmp', 'old copy.tmp'], 2);
    return {
      instructions: lab({
        situation: `**/srv/scripts/purge.sh DIR** deletes \`*.tmp\` files in DIR. Before it runs on the file server, test it **without touching real data**:\n\n1. copy **/srv/sample** (test data, including names with spaces) to **/tmp/testrun**;\n2. run the script inside a throw-away **alpine:3.20** container: mount /srv/scripts **read-only** at /scripts and /tmp/testrun at /data, and run \`sh /scripts/purge.sh /data\`, removing the container afterwards (--rm);\n3. write the remaining file names in /tmp/testrun, sorted, to **/root/purge-test.txt**.\n\n/srv/sample itself must be unchanged. Docker is installed and running.`,
        steps: ['cp -a /srv/sample /tmp/testrun', 'docker run --rm -v /srv/scripts:/scripts:ro -v /tmp/testrun:/data alpine:3.20 sh /scripts/purge.sh /data', 'ls /tmp/testrun | sort > /root/purge-test.txt'],
        tips: ['docker run --rm -v SRC:DEST:ro -v SRC2:DEST2 IMAGE sh /scripts/purge.sh /data', 'diff <(ls /srv/sample) <(ls /tmp/testrun)'],
      }),
      hints: ['The read-only mount means the script cannot change itself or the scripts folder, even by accident.', '--rm removes the container when it exits, so nothing is left behind.'],
      initialState: linux(net, { packages: { docker: { installed: true } }, services: { docker: { active: true, enabled: true, package: 'docker' } }, files: { '/srv/scripts/purge.sh': { content: `#!/bin/sh\nfind "$1" -type f -name '*.tmp' -mtime +${days} -delete\nfind "$1" -type f -name '*.tmp' -delete\necho "purged $1"\n`, mode: '755' }, ...Object.fromEntries(keepers.map((k) => [`/srv/sample/${k}`, 'keep\n'])), ...Object.fromEntries(junk.map((j) => [`/srv/sample/${j}`, 'junk\n'])) } as never }),
      checks: [
        file('The test result lists only the kept files', '/root/purge-test.txt', { equals: [...keepers].sort().join('\n') }),
        out('The sample data is untouched', 'ls /srv/sample | wc -l', { equals: String(keepers.length + junk.length) }),
        out('No container is left behind', 'docker ps -a | wc -l', { equals: '1' }),
        ran('The script ran in a container with a read-only mount', 'docker run[^\\n]*--rm[^\\n]*:/scripts:ro|docker run[^\\n]*:/scripts:ro[^\\n]*--rm'),
      ],
      solution: ['cp -a /srv/sample /tmp/testrun', 'docker run --rm -v /srv/scripts:/scripts:ro -v /tmp/testrun:/data alpine:3.20 sh /scripts/purge.sh /data', 'ls /tmp/testrun | sort > /root/purge-test.txt', 'cat /root/purge-test.txt'],
      realityNote: 'Running scripts against copies in containers is cheap enough to do on every change, which is how CI pipelines test infrastructure code.',
    };
  }),

  /* ---------------------------------------------------------------- 7.3 bats and Pester */
  tmpl(7, 3, 'beginner', 'bats-tests', 'Write bats tests for a script', 'E4', 20, 'Write bats tests that check a script\'s output and exit codes for good and bad input.', (v) => {
    const net = v.net();
    const cmd = v.pick(['validate-phone', 'check-phone']);
    const good = `0${v.pick(['20', '24', '27', '55'])}${v.int(1000000, 9999999)}`;
    return {
      instructions: lab({
        situation: `**/usr/local/bin/${cmd} NUMBER** prints \`valid\` and exits 0 for a 10-digit number starting with 0, and prints \`invalid\` and exits 1 otherwise. Write **/root/tests/${cmd}.bats** with at least **three** tests:\n\n1. a valid number (such as ${good}) gives status 0 and output \`valid\`;\n2. a number that is too short gives status 1;\n3. letters give status 1 and output \`invalid\`.\n\nInstall **bats** and run \`bats /root/tests\` until all tests pass.`,
        steps: ['@test "description" { run COMMAND; [ "$status" -eq 0 ]; [ "$output" = "valid" ]; }', 'zypper --non-interactive install bats', 'bats /root/tests'],
        tips: [`@test "a valid number passes" {\n  run ${cmd} ${good}\n  [ "$status" -eq 0 ]\n  [ "$output" = "valid" ]\n}`, 'bats /root/tests'],
      }),
      hints: ['run captures the exit status in $status and the output in $output, so the test itself does not stop on failure.', 'Tests that describe behaviour ("too short is rejected") make good documentation.'],
      initialState: linux(net, { files: { [`/usr/local/bin/${cmd}`]: { content: SH('if [[ $1 =~ ^0[0-9]{9}$ ]]; then\n  echo valid\nelse\n  echo invalid\n  exit 1\nfi\n'), mode: '755' }, '/root/tests/': null } }),
      checks: [
        out('All tests pass', 'bats /root/tests; echo "rc=$?"', { contains: ['0 failures', 'rc=0'] }),
        out('There are at least three tests', `grep -c '^@test' /root/tests/${cmd}.bats`, { pattern: '^([3-9]|\\d{2,})$' }),
        out('The tests catch a broken script', `cp /usr/local/bin/${cmd} /tmp/keep; printf '#!/bin/bash\\necho valid\\n' > /usr/local/bin/${cmd}; bats /root/tests; echo "rc=$?"`, { contains: 'rc=1' }),
      ],
      solution: ['zypper --non-interactive install bats', write(`/root/tests/${cmd}.bats`, `@test "a valid number passes" {\n  run ${cmd} ${good}\n  [ "$status" -eq 0 ]\n  [ "$output" = "valid" ]\n}\n\n@test "a short number fails" {\n  run ${cmd} 02412\n  [ "$status" -eq 1 ]\n}\n\n@test "letters fail" {\n  run ${cmd} abcdefghij\n  [ "$status" -eq 1 ]\n  [ "$output" = "invalid" ]\n}\n`), 'bats /root/tests'],
      realityNote: 'bats brings unit tests to shell scripts; a failing test in CI is far cheaper than a failing script at 2 a.m.',
    };
  }),
  tmpl(7, 3, 'intermediate', 'pester-testcases', 'Test a PowerShell function with Pester', 'E4', 25, 'Write Pester tests with -TestCases for a username function, including edge cases.', (v) => {
    const net = v.net();
    const people = v.people(3);
    const max = v.pick([12, 15]);
    const make = (g: string, s: string) => (g[0] + s).toLowerCase().replace(/[^a-z]/g, '').slice(0, max);
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Naming.ps1** defines **ConvertTo-Username -GivenName -Surname**: first letter of the given name plus the surname, lower case, letters only, at most ${max} characters. Write **C:\\Scripts\\Naming.Tests.ps1** with Pester tests that dot-source it in **BeforeAll** and use **-TestCases** to check at least:\n\n- ${people.map((p) => `${p.name} → \`${make(p.given, p.surname)}\``).join('\n- ')}\n- a surname with an apostrophe or hyphen (letters only);\n- a long name cut to ${max} characters.\n\nInstall Pester and run \`Invoke-Pester C:\\Scripts\\Naming.Tests.ps1\` until all tests pass.`,
        steps: ['Install-Module Pester -Force', 'BeforeAll { . $PSScriptRoot\\Naming.ps1 }', "It 'turns <GivenName> <Surname> into <Expected>' -TestCases @(@{ GivenName = 'Ama'; Surname = 'Mensah'; Expected = 'amensah' }) { ConvertTo-Username -GivenName $GivenName -Surname $Surname | Should -Be $Expected }", 'Invoke-Pester'],
        tips: ["Describe 'ConvertTo-Username' {\n    It 'turns <GivenName> <Surname> into <Expected>' -TestCases @(\n        @{ GivenName = 'Ama'; Surname = 'Mensah'; Expected = 'amensah' }\n    ) {\n        ConvertTo-Username -GivenName $GivenName -Surname $Surname | Should -Be $Expected\n    }\n}"],
      }),
      hints: ['<Name> in the test title is replaced by each test case\'s value, so failures say exactly which input broke.', 'Edge cases (apostrophes, long names) are where naming code breaks in production.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\Naming.ps1': `function ConvertTo-Username {\n    param([string]$GivenName, [string]$Surname)\n    $u = ($GivenName.Substring(0, 1) + $Surname).ToLower() -replace '[^a-z]', ''\n    $u.Substring(0, [math]::Min(${max}, $u.Length))\n}\n` } }),
      checks: [
        ps('All tests pass', '$r = Invoke-Pester C:\\Scripts\\Naming.Tests.ps1 -PassThru; "$($r.FailedCount) $($r.PassedCount -ge 5)"', { equals: '0 True' }),
        ps('The tests use -TestCases', 'Get-Content C:\\Scripts\\Naming.Tests.ps1 -Raw', { contains: ['-TestCases', 'BeforeAll'] }),
        ps('The tests catch a broken function', "Set-Content C:\\Scripts\\Naming.ps1 -Value 'function ConvertTo-Username { param($GivenName, $Surname) \"$GivenName$Surname\" }'; (Invoke-Pester C:\\Scripts\\Naming.Tests.ps1 -PassThru).FailedCount -gt 0", { equals: 'True' }),
      ],
      solution: ['Install-Module Pester -Force', psWrite('C:\\Scripts\\Naming.Tests.ps1', `BeforeAll { . $PSScriptRoot\\Naming.ps1 }\nDescribe 'ConvertTo-Username' {\n    It 'turns <GivenName> <Surname> into <Expected>' -TestCases @(\n${people.map((p) => `        @{ GivenName = '${p.given}'; Surname = '${p.surname}'; Expected = '${make(p.given, p.surname)}' }`).join('\n')}\n        @{ GivenName = 'Kwame'; Surname = "O'Neil-Asante"; Expected = '${make('Kwame', "O'Neil-Asante")}' }\n        @{ GivenName = 'Oluwaseyifunmi'; Surname = 'Adebayo-Ogunleye'; Expected = '${make('Oluwaseyifunmi', 'Adebayo-Ogunleye')}' }\n    ) {\n        ConvertTo-Username -GivenName $GivenName -Surname $Surname | Should -Be $Expected\n    }\n}`), 'Invoke-Pester C:\\Scripts\\Naming.Tests.ps1'],
      realityNote: 'Data-driven tests (-TestCases) make adding a new edge case a one-line change, so bugs found in production become permanent tests.',
    };
  }),
  tmpl(7, 3, 'advanced', 'pester-mocks', 'Test with mocks instead of real services', 'E4', 30, 'Use Pester Mock and Should -Invoke so a test of a restart function never touches real services.', (v) => {
    const net = v.net();
    const fn = v.pick(['Repair-Service', 'Restore-Service']);
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Watchdog.ps1** defines **${fn} -Name X**: if the service is not Running it calls Restart-Service and returns \`restarted\`, otherwise it returns \`ok\`. Its tests must not restart real services. Write **C:\\Scripts\\Watchdog.Tests.ps1** that:\n\n- **mocks Get-Service** to return a fake object with the Status you want;\n- **mocks Restart-Service** so nothing really restarts;\n- checks the return value, and with **Should -Invoke** that Restart-Service was called **exactly once** for a stopped service and **never** for a running one.\n\nRun it with Invoke-Pester.`,
        steps: ["Mock Get-Service { [pscustomobject]@{ Status = 'Stopped' } }", 'Mock Restart-Service {}', `${fn} -Name Spooler | Should -Be 'restarted'`, 'Should -Invoke Restart-Service -Times 1 -Exactly'],
        tips: ["It 'restarts a stopped service' {\n    Mock Get-Service { [pscustomobject]@{ Status = 'Stopped' } }\n    Mock Restart-Service {}\n    " + fn + " -Name Spooler | Should -Be 'restarted'\n    Should -Invoke Restart-Service -Times 1 -Exactly\n}"],
      }),
      hints: ['A mock replaces the command only inside the test, so the real Spooler is never touched.', '-Times 0 -Exactly asserts something did not happen, which is as important as asserting it did.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\Watchdog.ps1': `function ${fn} {\n    param([string]$Name)\n    if ((Get-Service -Name $Name).Status -ne 'Running') {\n        Restart-Service -Name $Name\n        'restarted'\n    } else {\n        'ok'\n    }\n}\n` } }),
      checks: [
        ps('The tests pass', '$r = Invoke-Pester C:\\Scripts\\Watchdog.Tests.ps1 -PassThru; "$($r.FailedCount) $($r.PassedCount)"', { pattern: '^0 [2-9]' }),
        ps('Mocks and invocation checks are used', 'Get-Content C:\\Scripts\\Watchdog.Tests.ps1 -Raw', { contains: ['Mock Get-Service', 'Mock Restart-Service', 'Should -Invoke'] }),
        ps('No real service was restarted by the tests', "(Get-Service BITS).Status", { equals: 'Stopped' }),
        ps('The tests catch a function that always restarts', `Set-Content C:\\Scripts\\Watchdog.ps1 -Value 'function ${fn} { param($Name) Restart-Service -Name $Name; ''restarted'' }'; (Invoke-Pester C:\\Scripts\\Watchdog.Tests.ps1 -PassThru).FailedCount -gt 0`, { equals: 'True' }),
      ],
      solution: ['Install-Module Pester -Force', psWrite('C:\\Scripts\\Watchdog.Tests.ps1', `BeforeAll { . $PSScriptRoot\\Watchdog.ps1 }\nDescribe '${fn}' {\n    It 'restarts a stopped service' {\n        Mock Get-Service { [pscustomobject]@{ Status = 'Stopped' } }\n        Mock Restart-Service {}\n        ${fn} -Name BITS | Should -Be 'restarted'\n        Should -Invoke Restart-Service -Times 1 -Exactly\n    }\n    It 'leaves a running service alone' {\n        Mock Get-Service { [pscustomobject]@{ Status = 'Running' } }\n        Mock Restart-Service {}\n        ${fn} -Name BITS | Should -Be 'ok'\n        Should -Invoke Restart-Service -Times 0 -Exactly\n    }\n}`), 'Invoke-Pester C:\\Scripts\\Watchdog.Tests.ps1'],
      realityNote: 'Mocks let you test the decision logic of scripts that touch AD, services or APIs on any laptop, with no access to the real systems.',
    };
  }),

  /* ---------------------------------------------------------------- 7.4 defensive scripting */
  tmpl(7, 4, 'beginner', 'rm-guard-rails', 'Put guard rails around rm', 'E4', 20, 'Protect a delete script from empty variables, paths outside its folder and option-like names.', (v) => {
    const net = v.net();
    const base = `/srv/${v.pick(['exams', 'scans', 'uploads'])}/archive`;
    const name = v.pick(['remove-batch', 'drop-batch']);
    return {
      instructions: lab({
        situation: `**/usr/local/sbin/${name} NAME** deletes the folder **${base}/NAME**. It is written as \`rm -rf $BASE/$1\`: with an empty argument it would delete the whole archive, and \`../\` in the name would escape it. Rewrite it so that:\n\n- an empty or missing NAME is refused (\`\${1:?}\` or a test), exit **2**;\n- a NAME containing **/** or starting with **.** or **-** is refused, exit **2**;\n- a NAME that does not exist prints \`no such batch\` and exits **1**;\n- otherwise it deletes the folder with \`rm -rf -- "$BASE/$1"\` and prints \`removed NAME\`.`,
        steps: ['Validate first, delete last.', 'case $1 in */*|.*|-*) refuse ;; esac', 'Quote everything and put -- before the path.'],
        tips: ['set -euo pipefail', 'BASE=' + base, ': "${1:?usage: ' + name + ' NAME}"', 'case $1 in */*|.*|-*) echo "bad name" >&2; exit 2 ;; esac', 'rm -rf -- "$BASE/$1"'],
      }),
      hints: ['"rm -rf $DIR/" with an unset DIR is how whole servers have been wiped.', '-- tells rm that everything after it is a file name, even if it starts with -.'],
      initialState: linux(net, { files: { [`${base}/batch-01/a.txt`]: 'a\n', [`${base}/batch-02/b.txt`]: 'b\n', [`${base}/keep/c.txt`]: 'c\n', [`/usr/local/sbin/${name}`]: { content: SH(`BASE=${base}\nrm -rf $BASE/$1\necho removed $1\n`), mode: '755' } } }),
      checks: [
        script('An empty name is refused', `/usr/local/sbin/${name}`, { status: 2 }),
        out('An empty name deletes nothing', `/usr/local/sbin/${name} 2>/dev/null; ls ${base} | wc -l`, { equals: '3' }),
        script('A path with ../ is refused', `/usr/local/sbin/${name}`, { args: ['../../etc'], status: 2 }),
        script('An option-like name is refused', `/usr/local/sbin/${name}`, { args: ['-rf'], status: 2 }),
        script('A missing batch exits 1', `/usr/local/sbin/${name}`, { args: ['batch-99'], status: 1, contains: 'no such batch' }),
        script('A real batch is removed and reported', `/usr/local/sbin/${name}`, { args: ['batch-01'], status: 0, equals: 'removed batch-01' }),
        out('Only that batch is gone', `/usr/local/sbin/${name} batch-01 >/dev/null; ls ${base}`, { equals: 'batch-02\nkeep' }),
      ],
      solution: [writeScript(`/usr/local/sbin/${name}`, `set -euo pipefail\nBASE=${base}\nif [ -z "\${1:-}" ]; then echo "usage: ${name} NAME" >&2; exit 2; fi\ncase $1 in\n  */*|.*|-*) echo "bad name: $1" >&2; exit 2 ;;\nesac\n[ -d "$BASE/$1" ] || { echo "no such batch"; exit 1; }\nrm -rf -- "\${BASE:?}/$1"\necho "removed $1"\n`), `${name} ''; ${name} ../etc; ${name} batch-99`],
      realityNote: 'The infamous "rm -rf $STEAMROOT/*" bug in a games client wiped users\' home directories; ${VAR:?} and validation before deletion prevent it.',
    };
  }),
  tmpl(7, 4, 'intermediate', 'no-eval-injection', 'Remove an eval injection', 'E4', 25, 'Replace eval on user input with an allow-list so crafted arguments cannot run commands.', (v) => {
    const net = v.net();
    const tool = v.pick(['report', 'helpdesk-report']);
    const reports = v.some(['disk', 'users', 'services', 'uptime'], 3);
    const cmds: Record<string, string> = { disk: 'df -h /', users: 'who', services: 'systemctl list-units --state=failed', uptime: 'uptime' };
    return {
      instructions: lab({
        situation: `Helpdesk staff run **/usr/local/bin/${tool} NAME** through sudo to see a report. It builds a command and runs it with **eval**, so \`${tool} "disk; touch /tmp/pwned"\` runs the extra command as root. Rewrite it without eval: only **${reports.join(', ')}** are allowed (a case statement mapping each name to its fixed command); anything else prints \`unknown report: NAME\` and exits **2**.`,
        steps: ['Read the script and try the injection yourself (check /tmp afterwards).', 'case "$1" in disk) df -h / ;; ... *) echo "unknown report: $1" >&2; exit 2 ;; esac', 'Try the injection again.'],
        tips: [`${tool} "disk; touch /tmp/pwned"; ls /tmp`, 'case "$1" in\n  disk) df -h / ;;\n  *) echo "unknown report: $1" >&2; exit 2 ;;\nesac'],
      }),
      hints: ['eval re-parses its input as shell code: ; | & $( ) in the input become commands.', 'An allow-list is safer than trying to strip "bad" characters.'],
      initialState: linux(net, { files: { [`/usr/local/bin/${tool}`]: { content: SH(`report=$1\ncmd_disk="df -h /"\ncmd_users="who"\ncmd_services="systemctl list-units --state=failed"\ncmd_uptime="uptime"\neval "\\$cmd_$report"\n`), mode: '755' } } }),
      checks: [
        out('The injection no longer runs', `rm -f /tmp/pwned; /usr/local/bin/${tool} "${reports[0]}; touch /tmp/pwned"; echo "rc=$?"; ls /tmp/pwned 2>/dev/null || echo safe`, { contains: ['rc=2', 'safe'] }),
        script('An allowed report still works', `/usr/local/bin/${tool}`, { args: [reports.includes('uptime') ? 'uptime' : reports[0]], status: 0 }),
        script('An unknown report is refused', `/usr/local/bin/${tool}`, { args: ['passwords'], status: 2, contains: 'unknown report: passwords' }),
        file('eval is gone', `/usr/local/bin/${tool}`, { notContains: 'eval' }),
      ],
      solution: [writeScript(`/usr/local/bin/${tool}`, `case "$1" in\n${reports.map((r) => `  ${r}) ${cmds[r]} ;;`).join('\n')}\n  *) echo "unknown report: $1" >&2; exit 2 ;;\nesac\n`), `${tool} "${reports[0]}; touch /tmp/pwned"; ls /tmp`],
      realityNote: 'Command injection through eval, system() and shell=True is consistently among the most exploited weaknesses (CWE-78).',
    };
  }),
  tmpl(7, 4, 'advanced', 'least-privilege-wrapper', 'Give sudo a safe wrapper, not a shell', 'E4', 30, 'Grant a group sudo on one root-owned, validated wrapper script instead of on the commands it runs.', (v) => {
    const net = v.net();
    const grp = v.pick(['printdesk', 'helpdesk']);
    const tech = v.person();
    const queues = v.some(['lab1-laser', 'lib-colour', 'office-a3', 'hall-mono'], 3);
    return {
      instructions: lab({
        situation: `Members of **${grp}** (for example ${tech.sam}) must be able to clear a stuck print queue, which needs root. Instead of letting them run \`cancel\` or a shell as root, create **/usr/local/sbin/clear-queue QUEUE** and allow only that through sudo:\n\n- the script is owned by **root**, mode **755** (nobody else can change what it does);\n- it accepts only the queue names in **/etc/print-queues** (one per line) and refuses anything else with exit **2**;\n- for a valid queue it writes \`cleared QUEUE\` to the log with \`logger -t clear-queue\` and prints \`cleared QUEUE\`;\n- **/etc/sudoers.d/${grp}** allows the group to run exactly \`/usr/local/sbin/clear-queue\` as root, mode 0440, valid in visudo.`,
        steps: ['grep -qxF -- "$1" /etc/print-queues || refuse', 'chown root:root and chmod 755 the script.', `%${grp} ALL=(root) /usr/local/sbin/clear-queue`, `sudo -l -U ${tech.sam} to check.`],
        tips: ['grep -qxF -- "$1" /etc/print-queues', `echo '%${grp} ALL=(root) /usr/local/sbin/clear-queue' > /etc/sudoers.d/${grp}`, `visudo -cf /etc/sudoers.d/${grp}`],
      }),
      hints: ['If a sudo-allowed script is writable by the user, they can make it do anything as root.', 'Validate against an allow-list file: adding a queue is then a data change, not a code change.'],
      initialState: linux(net, { groups: { [grp]: [tech.sam] }, users: { [tech.sam]: { groups: [grp] } }, files: { '/etc/print-queues': queues.join('\n') + '\n' } }),
      checks: [
        file('The wrapper is root-owned and not writable by others', '/usr/local/sbin/clear-queue', { owner: 'root', mode: '755' }),
        script('A valid queue is cleared and logged', '/usr/local/sbin/clear-queue', { args: [queues[1]], status: 0, equals: `cleared ${queues[1]}` }),
        script('Anything else is refused', '/usr/local/sbin/clear-queue', { args: ['lab1-laser; id'], status: 2 }),
        out(`${tech.sam} may run only the wrapper`, `sudo -l -U ${tech.sam}`, { contains: '/usr/local/sbin/clear-queue', notContains: 'ALL) ALL' }),
        out('The sudoers file is valid', `visudo -cf /etc/sudoers.d/${grp}`, { contains: 'parsed OK' }),
        group(`${tech.sam} is in ${grp}`, grp, { members: [tech.sam] }),
      ],
      solution: [writeScript('/usr/local/sbin/clear-queue', 'q=${1:-}\nif [ -z "$q" ] || ! grep -qxF -- "$q" /etc/print-queues; then\n  echo "unknown queue: $q" >&2\n  exit 2\nfi\nlogger -t clear-queue "cleared $q"\necho "cleared $q"\n'), 'chown root:root /usr/local/sbin/clear-queue', 'chmod 755 /usr/local/sbin/clear-queue', write(`/etc/sudoers.d/${grp}`, `%${grp} ALL=(root) /usr/local/sbin/clear-queue\n`), `chmod 440 /etc/sudoers.d/${grp}`, `visudo -cf /etc/sudoers.d/${grp}`, `sudo -l -U ${tech.sam}`],
      realityNote: 'A narrow, validated wrapper is the standard way to delegate one privileged action; it is also the only place you need to audit.',
    };
  }),

  /* ---------------------------------------------------------------- 7.5 version control, review, signing, rollout, rollback */
  tmpl(7, 5, 'beginner', 'scripts-in-git', 'Put scripts under version control', 'E4', 20, 'Initialise a repository for scripts, commit with meaningful messages, and tag a release.', (v) => {
    const net = v.net();
    const scripts = v.some(['backup.sh', 'cleanup.sh', 'report.sh', 'sync.sh'], 3);
    const who = v.person();
    const tag = `v1.${v.int(0, 4)}.0`;
    return {
      instructions: lab({
        situation: `The team's scripts live in **/srv/scripts** with no history. Put them under git:\n\n1. \`git init\` the folder and set your name (${who.name}) and e-mail (${who.sam}@campus.lan) for this repository;\n2. add a **.gitignore** that ignores \`*.log\` and \`*.tmp\` files (there are some lying around);\n3. commit all the scripts and the .gitignore with the message \`Add operations scripts\`;\n4. tag that commit **${tag}**.`,
        steps: ['cd /srv/scripts && git init', 'git config user.name "..."; git config user.email "..."', "printf '*.log\\n*.tmp\\n' > .gitignore", 'git add . && git commit -m "Add operations scripts" && git tag ' + tag],
        tips: ['git init', 'git config user.name "Your Name"', 'git status', `git tag ${tag}`, 'git log --oneline --decorate'],
      }),
      hints: ['Log and temporary files change constantly and do not belong in history.', 'A tag marks exactly what was deployed, so you can always get back to it.'],
      initialState: linux(net, { packages: { git: { installed: true } }, files: { ...Object.fromEntries(scripts.map((s) => [`/srv/scripts/${s}`, { content: `#!/bin/bash\necho ${s}\n`, mode: '755' }])), '/srv/scripts/run.log': 'old log\n', '/srv/scripts/cache.tmp': 'x\n' } as never }),
      checks: [
        out('The scripts are committed', 'cd /srv/scripts && git ls-files', { contains: [...scripts, '.gitignore'], notContains: ['run.log', 'cache.tmp'] }),
        out('The commit message and author are right', 'cd /srv/scripts && git log -1', { contains: ['Add operations scripts', `${who.name} <${who.sam}@campus.lan>`] }),
        out('The release is tagged', 'cd /srv/scripts && git tag', { equals: tag }),
        out('Nothing is left uncommitted', 'cd /srv/scripts && git status', { contains: 'nothing to commit' }),
      ],
      solution: [`cd /srv/scripts && git init && git config user.name "${who.name}" && git config user.email ${who.sam}@campus.lan`, "printf '*.log\\n*.tmp\\n' > /srv/scripts/.gitignore", `cd /srv/scripts && git add . && git commit -m "Add operations scripts" && git tag ${tag}`, 'cd /srv/scripts && git log --oneline --decorate'],
      realityNote: 'Scripts in version control get history, review and rollback for free; "which version ran last night?" becomes a one-line answer.',
    };
  }),
  tmpl(7, 5, 'intermediate', 'sign-scripts', 'Sign scripts for an AllSigned policy', 'E4', 25, 'Create a code-signing certificate, sign a script, and run it under the AllSigned execution policy.', (v) => {
    const net = v.net();
    const script = v.pick(['Get-LabReport.ps1', 'Reset-LabPrinters.ps1']);
    return {
      instructions: lab({
        situation: `The security baseline sets the execution policy to **AllSigned** on servers: only signed scripts may run. Sign **C:\\Scripts\\${script}** so it runs:\n\n1. create a code-signing certificate with \`New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Campus Scripts' -CertStoreLocation Cert:\\CurrentUser\\My\` (in a real organisation it would come from the internal CA);\n2. sign the script with **Set-AuthenticodeSignature**;\n3. set the **LocalMachine** policy to **AllSigned**;\n4. run the script, then prove that editing it breaks the signature (Get-AuthenticodeSignature shows HashMismatch) and sign it again.`,
        steps: ['$cert = New-SelfSignedCertificate ...', `Set-AuthenticodeSignature -FilePath C:\\Scripts\\${script} -Certificate $cert`, 'Set-ExecutionPolicy AllSigned -Scope LocalMachine -Force', `Get-AuthenticodeSignature C:\\Scripts\\${script}`],
        tips: ["$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Campus Scripts' -CertStoreLocation Cert:\\CurrentUser\\My", `Set-AuthenticodeSignature -FilePath C:\\Scripts\\${script} -Certificate $cert`],
      }),
      hints: ['Any change to a signed script, even a space, changes its hash and invalidates the signature.', 'A self-signed certificate is only trusted where you install it; an internal CA makes every server trust it.'],
      initialState: windows({ machines: [dc01(net)], files: { [`C:\\Scripts\\${script}`]: "\"report from $env:COMPUTERNAME\"\n" } }),
      checks: [
        ps('The policy is AllSigned', 'Get-ExecutionPolicy -Scope LocalMachine', { equals: 'AllSigned' }),
        ps('The script is signed and valid', `(Get-AuthenticodeSignature C:\\Scripts\\${script}).Status`, { equals: 'Valid' }),
        ps('The signed script runs', `& C:\\Scripts\\${script}`, { equals: 'report from DC01' }),
        ps('An edited copy is refused', `Copy-Item C:\\Scripts\\${script} C:\\Scripts\\Edited.ps1; Add-Content C:\\Scripts\\Edited.ps1 -Value '# changed'; try { & C:\\Scripts\\Edited.ps1 -ErrorAction Stop; 'ran' } catch { 'refused' }`, { equals: 'refused' }),
      ],
      solution: ["$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Campus Scripts' -CertStoreLocation Cert:\\CurrentUser\\My", `Set-AuthenticodeSignature -FilePath C:\\Scripts\\${script} -Certificate $cert`, 'Set-ExecutionPolicy AllSigned -Scope LocalMachine -Force', `& C:\\Scripts\\${script}`, `Get-AuthenticodeSignature C:\\Scripts\\${script}`],
      realityNote: 'Signing gives integrity (the script is what was approved) and accountability (who approved it); release pipelines sign scripts automatically after review.',
    };
  }),
  tmpl(7, 5, 'advanced', 'rollback-with-git', 'Roll back a bad change with git revert', 'E4', 25, 'Find the commit that broke a deployed script, revert it, redeploy, and tag the fixed release.', (v) => {
    const net = v.net();
    const good = v.int(14, 30);
    const tagNew = `v2.${v.int(1, 5)}.1`;
    const [who, other] = v.people(2);
    return {
      instructions: lab({
        situation: `**/srv/scripts** is a git repository; **/usr/local/sbin/rotate-backups** is deployed from \`rotate-backups.sh\` in it. Yesterday's commit "Keep fewer backups" changed retention from **${good}** days to **1**, and backups are disappearing. Do not edit the file by hand:\n\n1. find the bad commit with git log;\n2. **git revert** it (a new commit that undoes it, keeping history);\n3. redeploy: install the reverted file to /usr/local/sbin/rotate-backups with mode 755;\n4. tag the fixed commit **${tagNew}**.`,
        steps: ['cd /srv/scripts; git log --oneline', 'git show COMMIT to read the change.', 'git revert --no-edit COMMIT', 'install -m 755 rotate-backups.sh /usr/local/sbin/rotate-backups; git tag ' + tagNew],
        tips: ['git log --oneline', 'git revert --no-edit HEAD', 'install -m 755 SRC DEST'],
      }),
      hints: ['revert adds a commit; reset would rewrite history others may already have.', 'Deploying from the repository (not hand-editing the server copy) keeps the two identical.'],
      initialState: linux(net, {
        packages: { git: { installed: true } },
        files: {
          ...seedRepo('/srv/scripts', [
            { message: 'Add backup rotation', author: who.name, email: `${who.sam}@campus.lan`, files: { 'rotate-backups.sh': `#!/bin/bash\nfind /backup -name "*.tar.gz" -mtime +${good} -delete\n` } },
            { message: 'Add README', author: who.name, email: `${who.sam}@campus.lan`, files: { 'README.md': '# Operations scripts\n' } },
            { message: 'Keep fewer backups', author: other.name, email: `${other.sam}@campus.lan`, files: { 'rotate-backups.sh': '#!/bin/bash\nfind /backup -name "*.tar.gz" -mtime +1 -delete\n' } },
          ], { 'v2.0.0': 1 }),
          '/root/.gitconfig': `[user]\n\tname = ${who.name}\n\temail = ${who.sam}@campus.lan\n`,
          '/usr/local/sbin/rotate-backups': { content: '#!/bin/bash\nfind /backup -name "*.tar.gz" -mtime +1 -delete\n', mode: '755' },
        } as never,
      }),
      solution: ['cd /srv/scripts && git log --oneline', 'cd /srv/scripts && git revert --no-edit HEAD', 'install -m 755 /srv/scripts/rotate-backups.sh /usr/local/sbin/rotate-backups', `cd /srv/scripts && git tag ${tagNew}`, 'cd /srv/scripts && git log --oneline --decorate'],
      checks: [
        out('The bad commit was reverted, not removed', 'cd /srv/scripts && git log --oneline', { contains: ['Revert "Keep fewer backups"', 'Keep fewer backups'] }),
        file('The deployed script keeps the original retention', '/usr/local/sbin/rotate-backups', { contains: `-mtime +${good}`, mode: '755' }),
        out('The fix is tagged', 'cd /srv/scripts && git tag', { contains: tagNew }),
        out('The deployed file matches the repository', 'cmp -s /srv/scripts/rotate-backups.sh /usr/local/sbin/rotate-backups && echo same', { equals: 'same' }),
      ],
      realityNote: 'Revert-and-redeploy from version control is the safest rollback; it also leaves a record of what went wrong for the post-incident review.',
    };
  }),
];
