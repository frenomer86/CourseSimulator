import { describe, expect, it } from 'vitest';
import { buildSystem, type SystemSpec } from '../system.js';
import { newSession, runLine } from '../shell.js';
import { winSystemSpec } from './model.js';
import { apiState } from '../labapi.js';

function machine(files: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const spec = winSystemSpec({ files }) as unknown as SystemSpec & { files: Record<string, string> };
  Object.assign(spec.files, extra);
  const sys = buildSystem(spec);
  const ses = newSession(sys);
  return (lines: string[]) => lines.map((l) => runLine(sys, l, ses).output).join('');
}

describe('PowerShell language', () => {
  it('evaluates operators, casts, formatting and member access', () => {
    const ps = machine();
    const out = ps(['1..3 -join ","', '"{0:N2}|{1,-4}|{2:D3}" -f 1234.5, "ab", 7', '[int]"42" + 1', "'a-b-c' -split '-' | Measure-Object | Select-Object -ExpandProperty Count", "'x1y2' -replace '\\d', '#'", "@(1,2,3) -contains 2", "'Ama' -like 'a*'", '[math]::Round(2.5)', '(Get-Date "2026-10-01").AddDays(30).ToString("yyyy-MM-dd")']);
    expect(out).toBe('1,2,3\n1,234.50|ab  |007\n43\n3\nx#y#\nTrue\nTrue\n2\n2026-10-31\n');
  });

  it('runs functions with validated, typed parameters and -Verbose', () => {
    const ps = machine();
    const out = ps(['function Get-Square { [CmdletBinding()] param([Parameter(Mandatory)][ValidateRange(1,10)][int]$N) Write-Verbose "squaring $N"; $N * $N }', 'Get-Square -N 4 -Verbose', "Get-Square -N 40; 'next'", 'Get-Square']);
    expect(out).toContain('VERBOSE: squaring 4\n16\n');
    expect(out).toContain('The 40 argument is greater than the maximum allowed range of 10');
    expect(out).toContain('next\n');
    expect(out).toContain('missing mandatory parameters: N.');
  });

  it('treats cmdlet errors as non-terminating unless -ErrorAction Stop', () => {
    const ps = machine();
    const out = ps(["try { Get-Item C:\\Missing } catch { 'caught' }; 'continued'", "try { Get-Item C:\\Missing -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { \"typed: $($_.Exception.Message)\" }", "Get-Item C:\\Nope -ErrorAction SilentlyContinue -ErrorVariable e; \"errors=$($e.Count)\"", "throw 'halt'; 'never'"]);
    expect(out).toContain("Get-Item : Cannot find path 'C:\\Missing' because it does not exist.\ncontinued\n");
    expect(out).toContain("typed: Cannot find path 'C:\\Missing' because it does not exist.");
    expect(out).toContain('errors=1');
    expect(out).toContain('halt');
    expect(out).not.toContain('never');
  });

  it('shapes objects through the pipeline', () => {
    const ps = machine();
    const out = ps(['$u = 1..4 | ForEach-Object { [pscustomobject]@{ Name = "u$_"; Dept = @("Fin","Lib")[$_ % 2]; Score = $_ * 10 } }', '$u | Group-Object Dept | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }', '($u | Where-Object Score -ge 20 | Measure-Object Score -Sum).Sum', "$u | Sort-Object Score -Descending | Select-Object -First 1 -ExpandProperty Name", '$total = 0; 1..4 | ForEach-Object { $total += $_ }; $total', '$h = @{ a = 1 }; $h.b = 2; $h.Keys.Count']);
    expect(out).toBe('Fin=2\nLib=2\n90\nu4\n10\n2\n');
  });

  it('converts JSON and CSV', () => {
    const ps = machine();
    const out = ps(["[pscustomobject]@{a=1;b='x'} | ConvertTo-Json -Compress", "('{\"n\":[1,2]}' | ConvertFrom-Json).n.Count", "'Name,Dept','Ama,Finance' | ConvertFrom-Csv | Export-Csv C:\\Users\\Administrator\\o.csv -NoTypeInformation; Get-Content C:\\Users\\Administrator\\o.csv"]);
    expect(out).toBe('{"a":1,"b":"x"}\n2\n"Name","Dept"\n"Ama","Finance"\n');
  });

  it('runs scripts with parameters, switch statements and loops', () => {
    const ps = machine({ 'C:\\Scripts\\hello.ps1': 'param([string]$Name = "world")\nswitch -Wildcard ($Name) { "A*" { "starts with A" } default { "other" } }\n"Hello, $Name!"\n' });
    expect(ps(['& C:\\Scripts\\hello.ps1 -Name Ama', '.\\..\\..\\Scripts\\hello.ps1'])).toBe('starts with A\nHello, Ama!\nother\nHello, world!\n');
  });
});

describe('PowerShell tools', () => {
  it('runs Pester tests with test cases and mocks', () => {
    const ps = machine({
      'C:\\Scripts\\Get-Square.ps1': 'function Get-Square { param([int]$N) $N * $N }\n',
      'C:\\Scripts\\Get-Square.Tests.ps1': "BeforeAll { . $PSScriptRoot\\Get-Square.ps1 }\nDescribe 'Get-Square' {\n  It 'squares <n>' -TestCases @(@{n=2; want=4}, @{n=5; want=26}) { Get-Square $n | Should -Be $want }\n  It 'mocks' { Mock Get-Date { 'fake' }; Get-Date | Should -Be 'fake'; Should -Invoke Get-Date -Times 1 -Exactly }\n}\n",
    });
    const out = ps(['Invoke-Pester C:\\Scripts']);
    expect(out).toContain('Expected 26, but got 25.');
    expect(out).toContain('Get-Square.Tests.ps1:3');
    expect(out).toContain('Tests Passed: 2, Failed: 1, Skipped: 0');
  });

  it('calls the lab API and reports HTTP errors', () => {
    const ps = machine({}, { '/var/lib/labapi/api.json': apiState({ token: 'T', resources: { users: [{ id: 1, username: 'ama' }] } }) });
    const out = ps(["(Invoke-RestMethod http://api.campus.lan:8080/api/users -Headers @{ Authorization = 'Bearer T' }).username", "try { Invoke-RestMethod http://api.campus.lan:8080/api/users } catch { \"status=$($_.Exception.Response.StatusCode)\" }", "Invoke-RestMethod -Method Post -Uri http://api.campus.lan:8080/api/users -Headers @{ Authorization = 'Bearer T' } -Body (@{ username = 'esi' } | ConvertTo-Json) -ContentType 'application/json' | Select-Object -ExpandProperty id"]);
    expect(out).toBe('ama\nstatus=401\n2\n');
  });

  it('runs a scheduled task script and copies with robocopy', () => {
    const ps = machine({ 'C:\\Scripts\\job.ps1': 'Add-Content C:\\Logs\\job.log -Value "ran"\n', 'C:\\Logs\\keep.txt': 'x', 'C:\\Data\\a.txt': 'alpha\n' });
    const out = ps(["Register-ScheduledTask -TaskName Nightly -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument '-File C:\\Scripts\\job.ps1') -Trigger (New-ScheduledTaskTrigger -Daily -At 2am) | Out-Null", 'Start-ScheduledTask Nightly; (Get-ScheduledTaskInfo Nightly).LastTaskResult; Get-Content C:\\Logs\\job.log', 'robocopy C:\\Data C:\\Backup /MIR | Out-Null; $LASTEXITCODE; Get-Content C:\\Backup\\a.txt']);
    expect(out).toBe('0\nran\n1\nalpha\n');
  });

  it('flags script problems with PSScriptAnalyzer once installed', () => {
    const ps = machine({ 'C:\\Scripts\\bad.ps1': 'function Create-Users { param([string]$Password) gci C:\\ | % { Write-Host $_.Name } }\n' });
    expect(ps(['Invoke-ScriptAnalyzer C:\\Scripts\\bad.ps1'])).toContain('Install-Module PSScriptAnalyzer');
    const out = ps(['Install-Module PSScriptAnalyzer -Force; (Invoke-ScriptAnalyzer C:\\Scripts\\bad.ps1).RuleName -join ","']);
    expect(out).toContain('PSUseApprovedVerbs');
    expect(out).toContain('PSAvoidUsingPlainTextForPassword');
    expect(out).toContain('PSAvoidUsingCmdletAliases');
    expect(out).toContain('PSAvoidUsingWriteHost');
  });
});
