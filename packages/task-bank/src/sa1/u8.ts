/** Unit 8: additional AD server roles. */

import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { HK, addGroup, addOu, addUser, dataDisk, dc01, gpSet, lab, nic, ouDn, pc, placeComputer, policy, ps, systemDisk, system, tmpl } from './kit';

const server = (name: string, net: string, last: number, extra: Record<string, unknown> = {}) => ({ name, nics: [nic(`${net}.${last}`, net)], ...extra });

export const U8: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 8.1 AD CS */
  tmpl(8, 1, 'beginner', 'install-ca', 'Install an enterprise root CA', 'E4', 20, 'Install AD CS and set up an enterprise root CA with a strong key and hash.', (v) => {
    const net = v.net();
    const name = v.pick(['CAMPUS-Root-CA', 'Campus Issuing CA', 'CAMPUS-CA01']);
    const years = v.pick([5, 10]);
    return {
      instructions: lab({
        situation: `The campus needs its own certificates for Wi-Fi, web servers and VPN. Install an **enterprise root CA** on **CA01** called **${name}**, with a **4096-bit** key, **SHA256**, valid for **${years} years**.`,
        steps: ['Install the ADCS-Cert-Authority role on CA01 with its tools.', 'Configure the CA with Install-AdcsCertificationAuthority.', 'Check it with certutil -ping and certutil -cainfo.'],
        tips: [`Install-AdcsCertificationAuthority -CAType EnterpriseRootCA -CACommonName "${name}" -KeyLength 4096 -HashAlgorithmName SHA256 -ValidityPeriod Years -ValidityPeriodUnits ${years}`],
      }),
      hints: ['An enterprise CA publishes into Active Directory, so domain members trust it automatically.', 'SHA1 and keys under 2048 bits are no longer accepted for new CAs.'],
      initialState: system({ machines: [dc01(net), server('CA01', net, 15)] }),
      checks: [ps(`The CA is ${name}`, 'certutil -cainfo', { contains: `CA name: ${name}` }), ps('It is an enterprise root', 'certutil -cainfo', { contains: 'CA type: EnterpriseRootCA' }), ps('4096-bit key', 'certutil -cainfo', { contains: 'Key length: 4096' }), ps('SHA256', 'certutil -cainfo', { contains: 'Hash algorithm: SHA256' }), ps(`Valid for ${years} years`, 'certutil -cainfo', { contains: `Validity: ${years} years` })],
      solution: [`Invoke-Command -ComputerName CA01 -ScriptBlock { Install-WindowsFeature ADCS-Cert-Authority -IncludeManagementTools; Install-AdcsCertificationAuthority -CAType EnterpriseRootCA -CACommonName "${name}" -KeyLength 4096 -HashAlgorithmName SHA256 -ValidityPeriod Years -ValidityPeriodUnits ${years} }`, 'certutil -ping'],
      realityNote: 'Large estates use an offline root and online issuing CAs; a single enterprise root is common in smaller institutions and labs.',
    };
  }),
  tmpl(8, 1, 'intermediate', 'web-certificate', 'Issue a web server certificate from a custom template', 'E4', 25, 'Duplicate the Web Server template for a group, publish it and enrol a certificate.', (v) => {
    const net = v.net();
    const site = v.pick(['intranet', 'portal', 'moodle', 'library']);
    const tmplName = v.pick(['Campus Web Server', 'Campus TLS Server', 'Campus WebSrv']);
    return {
      instructions: lab({
        situation: `**WEB01** will serve **https://${site}.campus.local**. The CA **CAMPUS-Root-CA** on CA01 has the default templates. The policy says web certificates come from a campus template that only web servers can enrol for: duplicate **WebServer** as **${tmplName}** with enrol rights for **GG_WebServers**, publish it on the CA, put WEB01 in GG_WebServers, and request the certificate on WEB01.`,
        steps: ['Create GG_WebServers and add WEB01.', `Duplicate WebServer as ${tmplName} (this lab's New-CATemplateDuplicate stands in for the Certificate Templates console).`, 'Publish the template on the CA with Add-CATemplate.', `On WEB01, request a certificate for ${site}.campus.local.`],
        tips: [`New-CATemplateDuplicate -Source WebServer -Name "${tmplName}" -Enroll GG_WebServers`, `Add-CATemplate -Name "${tmplName}"`, `Get-Certificate -Template "${tmplName}" -DnsName ${site}.campus.local -CertStoreLocation Cert:\\LocalMachine\\My`],
      }),
      hints: ['A template must be published on a CA before anyone can enrol for it.', 'Get-ChildItem Cert:\\LocalMachine\\My lists the machine\'s certificates.'],
      initialState: system({ machines: [dc01(net), server('CA01', net, 15, { features: ['ADCS-Cert-Authority'], ca: { name: 'CAMPUS-Root-CA', type: 'EnterpriseRootCA', keyLength: 4096, hash: 'SHA256', years: 10 } }), server('WEB01', net, 31, { features: ['Web-Server'] })], ad: (st) => { st.caTemplates.push('User', 'Computer', 'DomainController', 'WebServer', 'SubCA', 'Administrator'); } }),
      checks: [ps(`${tmplName} is published`, 'certutil -catemplates', { contains: tmplName }), ps('WEB01 is in GG_WebServers', 'Get-ADGroupMember GG_WebServers | ForEach-Object { $_.name }', { contains: 'WEB01' }), ps(`WEB01 has a certificate for ${site}.campus.local`, 'Get-ChildItem Cert:\\LocalMachine\\My | ForEach-Object { $_.Subject }', { machine: 'WEB01', contains: `CN=${site}.campus.local` }), ps(`It came from ${tmplName}`, 'Get-ChildItem Cert:\\LocalMachine\\My | ForEach-Object { $_.Template }', { machine: 'WEB01', contains: tmplName })],
      solution: ['New-ADGroup -Name GG_WebServers -GroupScope Global', 'Add-ADGroupMember -Identity GG_WebServers -Members WEB01$', `New-CATemplateDuplicate -Source WebServer -Name "${tmplName}" -Enroll GG_WebServers`, `Add-CATemplate -Name "${tmplName}"`, `Invoke-Command -ComputerName WEB01 -ScriptBlock { Get-Certificate -Template "${tmplName}" -DnsName ${site}.campus.local -CertStoreLocation Cert:\\LocalMachine\\My }`],
      realityNote: 'Duplicating templates rather than editing the defaults, and limiting enrolment to a group, is the AD CS hardening advice that stops anyone requesting server certificates.',
    };
  }),
  tmpl(8, 1, 'advanced', 'auto-enrolment', 'Turn on certificate auto-enrolment for computers', 'E4', 30, 'Publish a workstation template for Domain Computers and enable auto-enrolment by Group Policy.', (v) => {
    const net = v.net();
    const tmplName = v.pick(['Campus Workstation', 'Campus Wi-Fi Computer', 'Campus 802.1X']);
    const pcName = `OFF-PC${v.int(10, 90)}`;
    const srv = v.pick(['APP01', 'FS02']);
    return {
      instructions: lab({
        situation: `The new Wi-Fi uses 802.1X with computer certificates. Every **workstation** must get one automatically, servers must not. Duplicate the **Workstation** template as **${tmplName}** with **auto-enrol** for **Domain Computers**, publish it, and turn on certificate auto-enrolment (HKLM\\Software\\Policies\\Microsoft\\Cryptography\\AutoEnrollment, **AEPolicy = 7**: enrol, renew and update) with a GPO **Cert Autoenrol - Workstations** linked to **OU=Workstations**.`,
        steps: ['Duplicate and publish the template.', 'Create the GPO, set AEPolicy and link it to OU=Workstations.', `Check ${pcName} and ${srv}.`],
        tips: [`New-CATemplateDuplicate -Source Workstation -Name "${tmplName}" -AutoEnroll "Domain Computers"`, gpSet('Cert Autoenrol - Workstations', HK.autoEnroll, 'DWord', 7)],
      }),
      hints: ['Auto-enrolment needs both a template permission (Autoenroll) and the client policy.', 'AEPolicy 7 = enrol, renew expired, update pending; 1 only enrols.'],
      initialState: system({ machines: [dc01(net), server('CA01', net, 15, { features: ['ADCS-Cert-Authority'], ca: { name: 'CAMPUS-Root-CA', type: 'EnterpriseRootCA', keyLength: 4096, hash: 'SHA256', years: 10 } }), pc(pcName, net, 66), server(srv, net, 36)], ad: (st) => { st.caTemplates.push('User', 'Computer', 'DomainController', 'WebServer'); placeComputer(st, pcName, addOu(st, 'Workstations')); placeComputer(st, srv, addOu(st, 'Servers')); } }),
      checks: [ps(`${tmplName} is published`, 'certutil -catemplates', { contains: tmplName }), policy(`${pcName} auto-enrols`, HK.autoEnroll, pcName, 7), policy(`${srv} does not`, HK.autoEnroll, srv, null)],
      solution: [`New-CATemplateDuplicate -Source Workstation -Name "${tmplName}" -AutoEnroll "Domain Computers"`, `Add-CATemplate -Name "${tmplName}"`, 'New-GPO -Name "Cert Autoenrol - Workstations"', gpSet('Cert Autoenrol - Workstations', HK.autoEnroll, 'DWord', 7), `New-GPLink -Name "Cert Autoenrol - Workstations" -Target "${ouDn('Workstations')}"`],
      realityNote: 'Auto-enrolment is what makes certificate-based Wi-Fi and VPN practical: nobody requests certificates by hand, and renewals happen on their own.',
    };
  }),

  /* ---------------------------------------------------------------- 8.2 federation and hybrid identity */
  tmpl(8, 2, 'beginner', 'federation-basics', 'Explain federation and hybrid identity', 'E10', 15, 'Match federation, claims, trusts and sync to what they do.', (v) => {
    const app = v.pick(['the e-learning platform', 'the library e-resources portal', 'the national research network portal']);
    return caseStudy(v, {
      intro: `## One login for everything\n\nStaff want to use their campus account for Microsoft 365 and for ${app}, which is run by an outside provider. Work through how that can happen.`,
      steps: [
        { title: 'Federation', text: `What does federation with ${app} mean?`, choices: [{ text: 'The provider trusts security tokens issued by the campus identity provider, so it never sees passwords', right: true, feedback: 'Correct. Authentication happens at home; the app accepts a signed token.' }, { text: 'The provider copies all campus accounts', feedback: 'That is synchronisation, not federation.' }, { text: 'Users type their campus password into the provider\'s site', feedback: 'That is exactly what federation avoids.' }] },
        { title: 'Claims', text: 'The token says: name, email, "staff", department. What are these?', choices: [{ text: 'Claims: statements the identity provider makes about the user', right: true, feedback: 'Correct. Apps make access decisions from claims.' }, { text: 'Kerberos tickets', feedback: 'Kerberos is used inside the domain; federation tokens are SAML or OpenID Connect.' }, { text: 'Group Policy settings', feedback: 'Group Policy configures machines; it is not sent to web apps.' }] },
        { title: 'Who trusts whom', text: 'In AD FS terms, the outside app is a...', choices: [{ text: 'Relying party: it relies on tokens from the campus', right: true, feedback: 'Correct. AD FS is the claims provider; the app is the relying party.' }, { text: 'Domain controller', feedback: 'The app has nothing to do with the campus domain.' }, { text: 'Forest trust partner', feedback: 'Forest trusts join AD forests; web apps use federation trusts.' }] },
        { title: 'Microsoft 365', text: 'For Microsoft 365, accounts must also exist in Entra ID. What puts them there?', choices: [{ text: 'Entra Connect (Cloud Sync) synchronises users from AD', right: true, feedback: 'Correct. Sync creates the cloud accounts; the sign-in method is a separate choice.' }, { text: 'AD FS creates them at first logon', feedback: 'AD FS issues tokens; it does not create cloud accounts.' }, { text: 'Group Policy', feedback: 'Group Policy does not talk to Entra ID.' }] },
        { title: 'Signing certificate', text: 'What breaks every federated sign-in at once if it expires?', choices: [{ text: 'The token-signing certificate', right: true, feedback: 'Correct. Relying parties check the signature on every token.' }, { text: 'The DHCP lease of the AD FS server', feedback: 'Servers have static addresses; leases are not the issue.' }, { text: 'A user\'s password', feedback: 'That only affects that user.' }] },
      ],
      ending: { title: 'Picture complete', text: 'Sync puts accounts in the cloud; federation lets apps trust campus-issued tokens; claims carry what apps need.' },
      hints: ['Synchronisation copies identities; federation shares trust.', 'Relying parties rely on tokens.'],
      realityNote: 'Research and education federations (eduGAIN and national federations) use exactly this model to let campus accounts reach shared services.',
    });
  }),
  tmpl(8, 2, 'intermediate', 'upn-for-sync', 'Prepare UPNs for cloud synchronisation', 'E4', 20, 'Add a routable UPN suffix and move staff UPNs onto it before syncing to Entra ID.', (v) => {
    const net = v.net();
    const suffix = v.pick(['campus.edu.gh', 'college.edu.gh', 'learn.edu.gh']);
    const people = v.people(4);
    const keep = v.person();
    return {
      instructions: lab({
        situation: `Staff will be synchronised to Entra ID for Microsoft 365. Cloud sign-in names must use a **routable** domain the institution owns, **${suffix}**, but the AD domain is **campus.local**, which is not routable. Add **${suffix}** as a UPN suffix and change the UPN of every user in **OU=Staff** to **<logon name>@${suffix}**. Service accounts in OU=Service Accounts are not synchronised: leave them alone.`,
        steps: ['Look at the current UPNs.', `Add the suffix with Set-ADForest.`, 'Change the UPNs of OU=Staff users in one pipeline.', 'Check the results.'],
        tips: [`Set-ADForest -Identity campus.local -UPNSuffixes @{Add="${suffix}"}`, `Get-ADUser -Filter * -SearchBase "${ouDn('Staff')}" | ForEach-Object { Set-ADUser -Identity $_.SamAccountName -UserPrincipalName "$($_.SamAccountName)@${suffix}" }`],
      }),
      hints: ['.local names cannot be verified in Microsoft 365.', 'A UPN suffix must exist in the forest before users can use it.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const so = addOu(st, 'Staff'); for (const p of people) addUser(st, p, so); addUser(st, keep, addOu(st, 'Service Accounts')); } }),
      checks: [ps(`${suffix} is a UPN suffix`, '(Get-ADForest).UPNSuffixes', { contains: suffix }), ...people.map((p) => ps(`${p.sam}'s UPN is ${p.sam}@${suffix}`, `(Get-ADUser ${p.sam}).UserPrincipalName`, { equals: `${p.sam}@${suffix}` })), ps(`${keep.sam} (not synced) is unchanged`, `(Get-ADUser ${keep.sam}).UserPrincipalName`, { equals: `${keep.sam}@campus.local` })],
      solution: [`Set-ADForest -Identity campus.local -UPNSuffixes @{Add="${suffix}"}`, `Get-ADUser -Filter * -SearchBase "${ouDn('Staff')}" | ForEach-Object { Set-ADUser -Identity $_.SamAccountName -UserPrincipalName "$($_.SamAccountName)@${suffix}" }`],
      realityNote: 'Matching on-premises UPNs to a verified cloud domain is the first step in every Entra Connect deployment; IdFix finds the accounts that would fail.',
    };
  }),
  tmpl(8, 2, 'advanced', 'hybrid-auth-choice', 'Choose a hybrid sign-in method', 'E10', 20, 'Compare password hash sync, pass-through authentication and federation for a university.', (v) => {
    const sites = v.int(2, 4);
    const power = v.pick(['frequent power cuts on campus', 'a single internet link that fails a few times a month', 'a small IT team with no one on call at night']);
    return caseStudy(v, {
      intro: `## Signing in to the cloud\n\nThe university is moving email to Microsoft 365. Accounts will sync from AD. The infrastructure has ${sites} campuses and ${power}. Choose how cloud sign-in should work.`,
      steps: [
        { title: 'Resilience', text: `With ${power}, which method keeps cloud sign-in working when the campus is unreachable?`, choices: [{ text: 'Password hash synchronisation: Entra ID can verify the password itself', right: true, feedback: 'Correct. Sign-in does not depend on campus servers being up.' }, { text: 'AD FS federation', feedback: 'If the AD FS servers or WAP are down, nobody can sign in to the cloud.' }, { text: 'Pass-through authentication', feedback: 'PTA agents on campus must answer every sign-in.' }] },
        { title: 'Security concern', text: 'A committee member worries that password hash sync "sends our passwords to Microsoft".', choices: [{ text: 'It sends a hash of the AD hash, salted and re-hashed; passwords are not sent in clear', right: true, feedback: 'Correct. And it enables leaked-credential detection.' }, { text: 'They are right: use federation to be safe', feedback: 'Federation moves risk to internet-facing servers you must run perfectly.' }, { text: 'Turn on reversible encryption first', feedback: 'Never: reversible encryption stores passwords decryptably.' }] },
        { title: 'Seamless experience', text: 'Staff on domain-joined PCs want no extra password prompt.', choices: [{ text: 'Seamless single sign-on (or Entra hybrid join) uses their Kerberos/PRT sign-in', right: true, feedback: 'Correct. Works with password hash sync or PTA.' }, { text: 'Only federation can give single sign-on', feedback: 'Seamless SSO and hybrid join give it without AD FS.' }, { text: 'Save the password in the browser', feedback: 'That is not single sign-on.' }] },
        { title: 'When federation still makes sense', text: 'In which case might the university still run AD FS?', choices: [{ text: 'A requirement such as smart-card sign-in or a third-party MFA that only works on-premises', right: true, feedback: 'Correct. Some on-premises authentication requirements still need federation.' }, { text: 'Always, for any university', feedback: 'Microsoft now recommends cloud authentication unless there is a specific need.' }, { text: 'Never', feedback: 'Some requirements do still need it.' }] },
        { title: 'Lockout behaviour', text: 'With cloud authentication, what protects accounts from password spraying?', choices: [{ text: 'Entra ID smart lockout and MFA, plus banned-password lists', right: true, feedback: 'Correct. Cloud protections apply before any on-premises lockout.' }, { text: 'The AD lockout threshold only', feedback: 'With PHS the AD lockout policy is not consulted for cloud sign-ins.' }, { text: 'Nothing: cloud accounts cannot be attacked', feedback: 'They are attacked constantly.' }] },
      ],
      ending: { title: 'Decision recorded', text: 'Password hash sync with seamless SSO and MFA, with federation kept only for a specific requirement.' },
      hints: ['Ask what still works when the campus is offline.', 'Seamless SSO is not exclusive to federation.'],
      realityNote: 'Microsoft\'s current guidance recommends password hash synchronisation as the default, alone or as a backup to other methods.',
    });
  }),

  /* ---------------------------------------------------------------- 8.3 RDS and Web Application Proxy */
  tmpl(8, 3, 'beginner', 'rds-collection', 'Deploy Remote Desktop Services with one collection', 'E4', 20, 'Build a session-based RDS deployment and create a collection.', (v) => {
    const net = v.net();
    const coll = v.pick(['Lecturer Apps', 'Finance Apps', 'Statistics Lab', 'Library Kiosk']);
    return {
      instructions: lab({
        situation: `Staff need a Windows desktop with campus applications from home and from old PCs. Build a session-based RDS deployment: **RDCB01** as Connection Broker, **RDWEB01** as Web Access and **RDSH01** as Session Host, then create a collection **${coll}** on RDSH01.`,
        steps: ['Create the deployment with New-RDSessionDeployment.', 'Create the collection.', 'Check it with Get-RDSessionCollection.'],
        tips: ['New-RDSessionDeployment -ConnectionBroker RDCB01 -WebAccessServer RDWEB01 -SessionHost RDSH01', `New-RDSessionCollection -CollectionName "${coll}" -SessionHost RDSH01 -ConnectionBroker RDCB01`],
      }),
      hints: ['The Connection Broker keeps track of sessions and reconnects users to them.', 'Session hosts must be domain members.'],
      initialState: system({ machines: [dc01(net), server('RDCB01', net, 41), server('RDWEB01', net, 42), server('RDSH01', net, 43)] }),
      checks: [ps(`${coll} exists on RDSH01`, `(Get-RDSessionCollection | Where-Object { $_.CollectionName -eq '${coll}' }).SessionHost`, { equals: 'RDSH01' }), ps('RDSH01 is a session host', '(Get-WindowsFeature -Name RDS-RD-Server).InstallState', { machine: 'RDSH01', equals: 'Installed' }), ps('RDCB01 is the broker', '(Get-WindowsFeature -Name RDS-Connection-Broker).InstallState', { machine: 'RDCB01', equals: 'Installed' })],
      solution: ['New-RDSessionDeployment -ConnectionBroker RDCB01 -WebAccessServer RDWEB01 -SessionHost RDSH01', `New-RDSessionCollection -CollectionName "${coll}" -SessionHost RDSH01 -ConnectionBroker RDCB01`],
      realityNote: 'Session-based RDS gives many users one shared server desktop; it is how many institutions publish finance and statistics software.',
    };
  }),
  tmpl(8, 3, 'intermediate', 'rds-lockdown', 'Restrict a collection and lock down the session host', 'E4', 25, 'Limit a collection to one group and apply loopback lockdown to the session host.', (v) => {
    const net = v.net();
    const dept = v.pick(['Finance', 'Registry', 'Examinations', 'Research']);
    const [u] = v.people(1);
    return {
      instructions: lab({
        situation: `The collection **${dept} Apps** on RDSH01 is open to **Domain Users**. Only **GG_${dept}_Staff** may use it. On the session host, every user must get a locked-down desktop (no Control Panel) whatever OU they come from: create **RDS Lockdown** linked to **OU=RDS Servers** with the user setting and **loopback replace** mode.`,
        steps: ['Change the collection\'s user group.', 'Create the GPO with NoControlPanel = 1 (user) and UserPolicyMode = 2 (computer), and link it to OU=RDS Servers.', `Check ${u.sam} on RDSH01.`],
        tips: [`Set-RDSessionCollectionConfiguration -CollectionName "${dept} Apps" -UserGroup "CAMPUS\\GG_${dept}_Staff"`, gpSet('RDS Lockdown', HK.loopback, 'DWord', 2)],
      }),
      hints: ['Loopback is set in a GPO that applies to the session host computer.', 'Without loopback, user settings follow the user\'s own OU.'],
      initialState: system({ machines: [dc01(net), server('RDSH01', net, 43, { features: ['RDS-RD-Server'], rds: { collections: [{ name: `${dept} Apps`, users: ['Domain Users'] }] } })], ad: (st) => { const so = addOu(st, 'Staff'); const d = addUser(st, u, so); addGroup(st, `GG_${dept}_Staff`, 'Global', so, [d]); placeComputer(st, 'RDSH01', addOu(st, 'RDS Servers')); } }),
      checks: [ps(`Only GG_${dept}_Staff can use the collection`, 'Get-RDSessionCollection | ForEach-Object { $_.UserGroup }', { equals: `GG_${dept}_Staff` }), policy('Loopback replace on RDSH01', HK.loopback, 'RDSH01', 2), policy(`${u.sam} has no Control Panel on RDSH01`, HK.noControlPanel, 'RDSH01', 1, u.sam)],
      solution: [`Set-RDSessionCollectionConfiguration -CollectionName "${dept} Apps" -UserGroup "CAMPUS\\GG_${dept}_Staff"`, 'New-GPO -Name "RDS Lockdown"', gpSet('RDS Lockdown', HK.noControlPanel, 'DWord', 1), gpSet('RDS Lockdown', HK.loopback, 'DWord', 2), `New-GPLink -Name "RDS Lockdown" -Target "${ouDn('RDS Servers')}"`],
      realityNote: 'Loopback on session hosts is standard practice: the shared server, not each user\'s office policy, decides what the desktop allows.',
    };
  }),
  tmpl(8, 3, 'advanced', 'remote-access-design', 'Publish remote desktops and web apps safely', 'E10', 20, 'Choose RD Gateway, Web Application Proxy, NLA and MFA for remote access.', (v) => {
    const app = v.pick(['the student records system', 'the HR portal', 'the finance web app']);
    return caseStudy(v, {
      intro: `## Working from home\n\nStaff need their RDS desktops and ${app} from home. The network team proposes simply forwarding ports on the firewall.`,
      steps: [
        { title: 'RDP from the internet', text: 'Forward TCP 3389 from the internet to RDSH01?', choices: [{ text: 'No: publish through RD Gateway over HTTPS 443, with MFA', right: true, feedback: 'Correct. Exposed RDP is constantly scanned and brute-forced.' }, { text: 'Yes, with a strong password policy', feedback: 'Passwords alone do not stop RDP exploitation or spraying.' }, { text: 'Yes, but on port 3390', feedback: 'Port changes are found by scanners in minutes.' }] },
        { title: 'Network Level Authentication', text: 'Should the session host require NLA?', choices: [{ text: 'Yes: users authenticate before a session (and its resources) is created', right: true, feedback: 'Correct. NLA reduces exposure to pre-authentication attacks.' }, { text: 'No: it slows logons', feedback: 'The cost is tiny; the protection is significant.' }, { text: 'Only for administrators', feedback: 'All users benefit.' }] },
        { title: 'Web app', text: `How should ${app} be published?`, choices: [{ text: 'Through Web Application Proxy with pre-authentication (AD FS) or an identity-aware proxy', right: true, feedback: 'Correct. Only authenticated requests reach the internal server.' }, { text: 'Forward 443 straight to the internal server', feedback: 'Then the app itself faces the internet unauthenticated.' }, { text: 'Put the server in the DMZ and join it to the domain', feedback: 'Domain-joined servers in the DMZ widen the attack path into AD.' }] },
        { title: 'Where the proxy sits', text: 'Where do RD Gateway and WAP live?', choices: [{ text: 'In a perimeter network, reachable from the internet on 443 only', right: true, feedback: 'Correct. The internal servers stay internal.' }, { text: 'On a domain controller', feedback: 'Never put internet-facing roles on DCs.' }, { text: 'On the session host itself', feedback: 'That removes the separation the gateway provides.' }] },
        { title: 'Certificates', text: 'What certificate does RD Gateway need?', choices: [{ text: 'A publicly trusted certificate for its external name', right: true, feedback: 'Correct. Home PCs do not trust the internal campus CA.' }, { text: 'A self-signed certificate', feedback: 'Users would learn to click through warnings.' }, { text: 'None if NLA is on', feedback: 'TLS still needs a certificate.' }] },
      ],
      ending: { title: 'Remote access designed', text: 'RD Gateway and WAP in the perimeter on 443 with public certificates, NLA and MFA, and nothing internal exposed directly.' },
      hints: ['Count what is reachable from the internet.', 'Pre-authentication means unauthenticated requests never reach the app.'],
      realityNote: 'Exposed RDP has been one of the top initial access vectors in ransomware reports for years; gateways with MFA close it.',
    });
  }),

  /* ---------------------------------------------------------------- 8.4 WSUS and WDS */
  tmpl(8, 4, 'beginner', 'configure-wsus', 'Install and configure WSUS', 'E4', 15, 'Install the WSUS role and put its content on a data drive.', (v) => {
    const net = v.net();
    const dir = v.pick(['D:\\WSUS', 'D:\\Updates', 'D:\\WSUSContent']);
    return {
      instructions: lab({
        situation: `**WSUS01** will cache and approve Windows updates for the campus so 2,000 PCs do not each download them over the internet link. Install the **UpdateServices** role and run the post-install step with its content on **${dir}** (not the system drive).`,
        steps: ['Install UpdateServices on WSUS01 with its tools.', `Run wsusutil postinstall CONTENT_DIR=${dir}.`, 'Check with Get-WsusServer.'],
        tips: ['Install-WindowsFeature UpdateServices -IncludeManagementTools', `wsusutil postinstall CONTENT_DIR=${dir}`],
      }),
      hints: ['Update content grows to hundreds of gigabytes: keep it off C:.'],
      initialState: system({ machines: [dc01(net), server('WSUS01', net, 50, { disks: [systemDisk(), dataDisk(1, 'D', 500, 'Content')] })] }),
      checks: [ps('WSUS is installed', '(Get-WindowsFeature -Name UpdateServices).InstallState', { machine: 'WSUS01', equals: 'Installed' }), ps(`Content is on ${dir}`, '(Get-WsusServer).ContentDirectory', { machine: 'WSUS01', equals: dir }), ps('The WSUS service runs', '(Get-Service WsusService).Status', { machine: 'WSUS01', equals: 'Running' })],
      solution: [`Invoke-Command -ComputerName WSUS01 -ScriptBlock { Install-WindowsFeature UpdateServices -IncludeManagementTools; wsusutil postinstall CONTENT_DIR=${dir} }`],
      realityNote: 'WSUS saves bandwidth and lets ICT test updates before release; on low-bandwidth campus links that matters even more.',
    };
  }),
  tmpl(8, 4, 'intermediate', 'approve-updates', 'Approve updates for the pilot group first', 'E4', 20, 'Approve security and critical updates to Pilot only and keep feature upgrades back.', (v) => {
    const net = v.net();
    const which = v.pick([['Security', 'security'], ['Critical', 'critical']] as const);
    return {
      instructions: lab({
        situation: `Patch Tuesday. The release process says: approve this month's **${which[0]}** updates (and the other of Security/Critical too) for the **Pilot** group only. After a week without problems they go to Workstations. **Upgrades** (feature updates) are never auto-approved.`,
        steps: ['List the unapproved updates with Get-WsusUpdate.', 'Approve Security Updates and Critical Updates for Pilot.', 'Check that nothing is approved for Workstations and no Upgrade is approved.'],
        tips: ['Get-WsusUpdate -Classification Security -Approval Unapproved | Approve-WsusUpdate -Action Install -TargetGroupName Pilot'],
      }),
      hints: ['Approve-WsusUpdate takes updates from the pipeline.', 'Get-WsusUpdate -Classification All shows everything.'],
      initialState: system({ machines: [dc01(net), server('WSUS01', net, 50, { features: ['UpdateServices'], disks: [systemDisk(), dataDisk(1, 'D', 500)], wsus: { contentDir: 'D:\\WSUS', groups: ['Pilot', 'Servers', 'Workstations'], approved: [], updates: [{ kb: 'KB5044281', title: '2026-10 Cumulative Update for Windows Server 2022', classification: 'Security Updates' }, { kb: 'KB5044098', title: '2026-10 Cumulative Update for Windows 11', classification: 'Security Updates' }, { kb: 'KB5041773', title: 'Servicing Stack Update', classification: 'Critical Updates' }, { kb: 'KB5040437', title: 'Feature update to Windows 11, version 24H2', classification: 'Upgrades' }] } })] }),
      checks: [ps('Security updates are approved for Pilot', 'Get-WsusUpdate -Classification Security | ForEach-Object { $_.Approved }', { machine: 'WSUS01', pattern: '^(Pilot\\s*)+$' }), ps('Critical updates are approved for Pilot', 'Get-WsusUpdate -Classification Critical | ForEach-Object { $_.Approved }', { machine: 'WSUS01', equals: 'Pilot' }), ps('The feature upgrade is not approved', 'Get-WsusUpdate -Classification Upgrades | ForEach-Object { $_.Approved }', { machine: 'WSUS01', equals: '' }), ps('Nothing went to Workstations yet', 'Get-WsusUpdate -Classification All | ForEach-Object { $_.Approved }', { machine: 'WSUS01', notContains: 'Workstations' })],
      solution: ['Invoke-Command -ComputerName WSUS01 -ScriptBlock { Get-WsusUpdate -Classification Security -Approval Unapproved | Approve-WsusUpdate -Action Install -TargetGroupName Pilot; Get-WsusUpdate -Classification Critical -Approval Unapproved | Approve-WsusUpdate -Action Install -TargetGroupName Pilot }'],
      realityNote: 'Ring-based approval (pilot, then broad) catches bad updates on a few machines instead of all of them.',
    };
  }),
  tmpl(8, 4, 'advanced', 'wds-deploy', 'Set up network deployment of Windows with WDS', 'E4', 25, 'Install and initialise WDS on a data volume and import boot and install images.', (v) => {
    const net = v.net();
    const img = v.pick(['Windows 11 Education', 'Windows 11 Pro', 'Windows 11 Lab Image']);
    return {
      instructions: lab({
        situation: `Reimaging 40 lab PCs from USB sticks takes two days. Set up **WDS01** for network (PXE) deployment: install the **WDS** role, initialise it with the RemoteInstall folder on **D:** (WDS refuses the system drive), import **D:\\Sources\\boot.wim** as a boot image and **D:\\Sources\\install.wim** as an install image named **${img}**.`,
        steps: ['Install WDS on WDS01.', 'Initialise it with wdsutil /initialize-server /reminst:D:\\RemoteInstall.', 'Import the two images.', 'Check with Get-WdsBootImage and Get-WdsInstallImage.'],
        tips: ['wdsutil /initialize-server /reminst:D:\\RemoteInstall', 'Import-WdsBootImage -Path D:\\Sources\\boot.wim', `Import-WdsInstallImage -Path D:\\Sources\\install.wim -ImageName "${img}"`],
      }),
      hints: ['Try C:\\RemoteInstall once and read the error.', 'Boot images start the installer over the network; install images are what gets installed.'],
      initialState: system({ machines: [dc01(net), server('WDS01', net, 51, { disks: [systemDisk(), dataDisk(1, 'D', 500, 'Deploy')] })], machineFiles: { WDS01: { 'D:\\Sources\\boot.wim': 'WIM boot\n', 'D:\\Sources\\install.wim': 'WIM install\n' } } }),
      checks: [ps('A boot image is loaded', 'Get-WdsBootImage | ForEach-Object { $_.ImageName }', { machine: 'WDS01', contains: 'boot.wim' }), ps(`${img} is an install image`, 'Get-WdsInstallImage | ForEach-Object { $_.ImageName }', { machine: 'WDS01', contains: img })],
      solution: ['Invoke-Command -ComputerName WDS01 -ScriptBlock { Install-WindowsFeature WDS -IncludeManagementTools; wdsutil /initialize-server /reminst:D:\\RemoteInstall; Import-WdsBootImage -Path D:\\Sources\\boot.wim; Import-WdsInstallImage -Path D:\\Sources\\install.wim -ImageName "' + img + '" }'],
      realityNote: 'WDS (often with MDT on top) is still the free way to image labs over the network; Configuration Manager and Autopilot cover larger fleets.',
    };
  }),
];

export { addUser };
