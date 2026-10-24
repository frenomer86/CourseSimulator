import { describe, expect, it } from 'vitest';
import { buildSystem, loadAd, newDirectory, runLines, type AdState } from './index.js';

export const FINANCE_CSV = 'GivenName,Surname,SamAccountName,Department\nAbena,Owusu,aowusu,Finance\nKwesi,Boateng,kboateng,Finance\nEfua,Asante,easante,Finance\n';

export function campusDirectory(): AdState {
  const st = newDirectory('campus.local', 'CAMPUS');
  st.ous.push({ name: 'Staff', dn: 'OU=Staff,DC=campus,DC=local', protected: true });
  st.users.push({ sam: 'kmensah', name: 'Kofi Mensah', given: 'Kofi', surname: 'Mensah', upn: 'kmensah@campus.local', dn: 'CN=Kofi Mensah,OU=Staff,DC=campus,DC=local', department: 'Finance', enabled: true, hasPassword: true });
  return st;
}

const winBox = () =>
  buildSystem({
    os: 'windows',
    hostname: 'dc01',
    user: 'Administrator',
    cwd: '/c/Users/Administrator',
    users: { Administrator: { home: '/c/Users/Administrator' } },
    files: { '/c/Windows/NTDS/ntds.json': JSON.stringify(campusDirectory()), '/c/Onboarding/finance.csv': FINANCE_CSV, '/c/Users/Administrator/notes.txt': 'hello\n' },
  });

const PW = '$pw = ConvertTo-SecureString "Welcome@2026" -AsPlainText -Force';

describe('PowerShell basics', () => {
  it('shows Windows paths and lists files', () => {
    const out = runLines(winBox(), ['Get-Location', 'Get-ChildItem', 'Get-Content notes.txt', 'cd C:\\Onboarding', 'pwd']);
    expect(out).toMatch(/C:\\Users\\Administrator/);
    expect(out).toMatch(/notes\.txt/);
    expect(out).toMatch(/hello/);
    expect(out).toMatch(/C:\\Onboarding/);
  });
  it('explains an unknown cmdlet', () => {
    expect(runLines(winBox(), ['Get-Wibble'])).toMatch(/The term 'Get-Wibble' is not recognized as the name of a cmdlet/);
  });
  it('expands $(…) inside double quotes but not $_.Prop', () => {
    const out = runLines(winBox(), ['Import-Csv C:\\Onboarding\\finance.csv | Select-Object -First 1 | ForEach-Object { "$($_.GivenName) $($_.Surname)" }']);
    expect(out).toMatch(/Abena Owusu/);
  });
});

describe('Active Directory', () => {
  it('creates an OU and users from a CSV, with their department and OU', () => {
    const sys = winBox();
    const out = runLines(sys, [
      'New-ADOrganizationalUnit -Name "Finance" -Path "DC=campus,DC=local"',
      PW,
      'Import-Csv C:\\Onboarding\\finance.csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -Department $_.Department -Path "OU=Finance,DC=campus,DC=local" -AccountPassword $pw -Enabled $true }',
      'Get-ADUser -Filter * -SearchBase "OU=Finance,DC=campus,DC=local" | Select-Object Name,Enabled',
      "Get-ADUser -Filter \"Department -eq 'Finance'\" | Measure-Object",
    ]);
    expect(out).not.toMatch(/: The|Cannot/);
    const st = loadAd(sys);
    const finance = st.users.filter((u) => u.dn.endsWith(',OU=Finance,DC=campus,DC=local'));
    expect(finance.map((u) => u.name)).toEqual(['Abena Owusu', 'Kwesi Boateng', 'Efua Asante']);
    expect(finance.every((u) => u.enabled && u.hasPassword && u.department === 'Finance')).toBe(true);
    expect(out).toMatch(/Abena Owusu\s+True/);
    // Measure-Object prints as a list, as in Windows PowerShell.
    expect(out).toMatch(/Count\s*:\s*4/);
  });

  it('enforces password complexity and refuses an enabled account with no password', () => {
    const out = runLines(winBox(), ['New-ADUser -Name "Test One" -SamAccountName test1 -AccountPassword (ConvertTo-SecureString "short" -AsPlainText -Force) -Enabled $true', 'New-ADUser -Name "Test Two" -SamAccountName test2 -Enabled $true']);
    expect(out.match(/does not meet the length, complexity, or history requirement/g)).toHaveLength(2);
  });

  it('follows AGDLP nesting rules', () => {
    const sys = winBox();
    const out = runLines(sys, [
      'New-ADGroup -Name GG_Finance -GroupScope Global -GroupCategory Security',
      'New-ADGroup -Name DL_Share_Modify -GroupScope DomainLocal',
      'Add-ADGroupMember -Identity GG_Finance -Members kmensah',
      'Add-ADGroupMember -Identity GG_Finance -Members DL_Share_Modify',
      'Add-ADGroupMember -Identity DL_Share_Modify -Members GG_Finance',
      'Get-ADGroupMember -Identity DL_Share_Modify -Recursive | Select-Object SamAccountName',
    ]);
    expect(out).toMatch(/A DomainLocal group cannot be a member of a Global group/);
    expect(out).toMatch(/kmensah/);
    const st = loadAd(sys);
    expect(st.groups.find((g) => g.name === 'DL_Share_Modify')!.members).toEqual(['CN=GG_Finance,CN=Users,DC=campus,DC=local']);
  });

  it('disables a leaver and protects OUs from deletion', () => {
    const sys = winBox();
    const out = runLines(sys, ['Disable-ADAccount -Identity kmensah', 'Get-ADUser kmensah', 'Remove-ADOrganizationalUnit -Identity "OU=Staff,DC=campus,DC=local"']);
    expect(out).toMatch(/Enabled\s+: False/);
    expect(out).toMatch(/protected from accidental deletion/);
    expect(loadAd(sys).users.find((u) => u.sam === 'kmensah')!.enabled).toBe(false);
  });

  it('shares a folder only once it exists, to accounts that exist', () => {
    const sys = winBox();
    const out = runLines(sys, [
      'New-SmbShare -Name Finance -Path C:\\Shares\\Finance -ChangeAccess "CAMPUS\\kmensah"',
      'New-Item -Path C:\\Shares\\Finance -ItemType Directory',
      'New-SmbShare -Name Finance -Path C:\\Shares\\Finance -ChangeAccess "CAMPUS\\nobody"',
      'New-SmbShare -Name Finance -Path C:\\Shares\\Finance -ChangeAccess "CAMPUS\\kmensah"',
      'Get-SmbShareAccess -Name Finance',
    ]);
    expect(out).toMatch(/cannot find the file specified/);
    expect(out).toMatch(/No mapping between account names and security IDs/);
    expect(out).toMatch(/CAMPUS\\kmensah\s+Allow\s+Change/);
  });
});
