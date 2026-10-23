/** Unit 9: Apache web server and DNS. */

import type { TaskTemplate } from '../types';
import { DEPTS, bindZone, caseStudy, file, lab, linux, out, pkg, ran, svc, tmpl } from './kit';

/** Apache installed and running, laid out as the openSUSE package installs it. */
function apache(extraFiles: Record<string, unknown> = {}) {
  return {
    packages: { apache2: { installed: true } },
    services: { apache2: { active: true, enabled: true, package: 'apache2', port: 80 } },
    users: { wwwrun: { uid: 30, shell: '/sbin/nologin', groups: ['www'], home: '/var/lib/wwwrun' } },
    files: {
      '/etc/apache2/httpd.conf': '# Main Apache configuration (openSUSE layout)\nInclude /etc/apache2/listen.conf\nIncludeOptional /etc/apache2/vhosts.d/*.conf\nDocumentRoot "/srv/www/htdocs"\n',
      '/etc/apache2/listen.conf': 'Listen 80\n',
      '/etc/apache2/vhosts.d/': null,
      '/srv/www/htdocs/index.html': '<html><body><h1>It works!</h1></body></html>\n',
      ...extraFiles,
    } as unknown as Record<string, never>,
  };
}

export const U9: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 9.1 Apache: install, configuration, virtual hosts, logs */
  tmpl(9, 1, 'beginner', 'first-website', 'Publish a department website with Apache', 'E4', 20, 'Install Apache, publish a page, start it at boot and open the firewall.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    return {
      instructions: lab({ situation: `The ${dept} office wants a simple website on this server. Install **apache2**, replace the default page **/srv/www/htdocs/index.html** with one whose heading reads \`${dept} office\`, make Apache start now and at boot, and allow **http** through the firewall permanently.`, steps: ['zypper install apache2.', 'Write the page.', 'systemctl enable --now apache2.', 'firewall-cmd --permanent --add-service=http; firewall-cmd --reload.', 'curl http://localhost/ to check.'], tips: ['zypper install apache2', `echo '<h1>${dept} office</h1>' > /srv/www/htdocs/index.html`, 'systemctl enable --now apache2'] }),
      hints: ['openSUSE serves /srv/www/htdocs; Debian and Ubuntu use /var/www/html.'],
      initialState: linux(net),
      checks: [pkg('Apache is installed', 'apache2'), svc('Apache runs and starts at boot', 'apache2', { active: true, enabled: true }), out('The page is served', 'curl -s http://localhost/', { contains: `${dept} office` }), out('Other hosts can reach port 80', `nmap ${net}.5`, { pattern: '80/tcp\\s+open' })],
      solution: ['zypper install apache2', `echo '<h1>${dept} office</h1>' > /srv/www/htdocs/index.html`, 'systemctl enable --now apache2', 'firewall-cmd --permanent --add-service=http', 'firewall-cmd --reload', 'curl -s http://localhost/'],
      realityNote: 'Apache httpd still serves a large share of university websites; Nginx is its most common alternative.',
    };
  }),
  tmpl(9, 1, 'intermediate', 'virtual-hosts', 'Host two sites on one server with virtual hosts', 'E4', 25, 'Create name-based virtual hosts with their own document roots and test each by name.', (v) => {
    const net = v.net();
    const [a, b] = v.some(DEPTS, 2);
    return {
      instructions: lab({ situation: `Host **${a}.campus.lan** and **${b}.campus.lan** on this Apache server, each with its own document root **/srv/www/${a}** and **/srv/www/${b}** and its own index.html (\`${a} site\` and \`${b} site\`). Write one file per site in **/etc/apache2/vhosts.d/** ending in .conf. Until DNS is updated, add both names for 127.0.0.1 to /etc/hosts so you can test.`, steps: ['Create the document roots and pages.', 'Write the two <VirtualHost *:80> blocks with ServerName and DocumentRoot (and a <Directory> with Require all granted).', 'apachectl configtest, then systemctl reload apache2.', 'curl each name.'], tips: [`<VirtualHost *:80>\n    ServerName ${a}.campus.lan\n    DocumentRoot /srv/www/${a}\n</VirtualHost>`, 'apachectl configtest', `curl http://${a}.campus.lan/`] }),
      hints: ['Apache picks the virtual host whose ServerName matches the Host header the browser sends.'],
      initialState: linux(net, apache()),
      checks: [out(`${a}.campus.lan serves its own page`, `curl -s http://${a}.campus.lan/`, { contains: `${a} site` }), out(`${b}.campus.lan serves its own page`, `curl -s http://${b}.campus.lan/`, { contains: `${b} site` }), out('The configuration is valid', 'apachectl configtest', { contains: 'Syntax OK' }), out('Apache lists both virtual hosts', 'apachectl -S', { contains: [`${a}.campus.lan`, `${b}.campus.lan`] })],
      solution: [`mkdir -p /srv/www/${a} /srv/www/${b}`, `echo '${a} site' > /srv/www/${a}/index.html`, `echo '${b} site' > /srv/www/${b}/index.html`, `printf '<VirtualHost *:80>\\n    ServerName ${a}.campus.lan\\n    DocumentRoot /srv/www/${a}\\n    <Directory "/srv/www/${a}">\\n        Require all granted\\n    </Directory>\\n</VirtualHost>\\n' > /etc/apache2/vhosts.d/${a}.conf`, `printf '<VirtualHost *:80>\\n    ServerName ${b}.campus.lan\\n    DocumentRoot /srv/www/${b}\\n    <Directory "/srv/www/${b}">\\n        Require all granted\\n    </Directory>\\n</VirtualHost>\\n' > /etc/apache2/vhosts.d/${b}.conf`, `echo '127.0.0.1 ${a}.campus.lan ${b}.campus.lan' >> /etc/hosts`, 'apachectl configtest', 'systemctl reload apache2', `curl -s http://${a}.campus.lan/`],
      realityNote: 'Name-based virtual hosting lets one server and one IP address host dozens of department sites.',
    };
  }),
  tmpl(9, 1, 'advanced', 'broken-apache', 'Repair a broken Apache configuration', 'E4', 30, 'Fix a syntax error, a permissions problem and a missing Listen directive using logs and tests.', (v) => {
    const net = v.net();
    const [a, b] = v.some(DEPTS, 2);
    const port = v.pick([8080, 8081]);
    return {
      instructions: lab({ situation: `After a colleague's changes Apache will not restart. Two sites must work: **${a}.campus.lan** on port 80 (document root /srv/www/${a}) and **${b}.campus.lan** on port **${port}** (document root /srv/www/${b}). There are three separate faults. Use **apachectl configtest**, **journalctl -u apache2** and **curl** to find them, and fix them without weakening permissions (no 777).`, steps: ['apachectl configtest and read the error.', 'Fix it, restart, then curl each site.', 'A 403 means Apache (user wwwrun) cannot read the files: fix ownership or modes sensibly.', 'A refused connection on the second port means Apache is not listening there.'], tips: ['apachectl configtest', 'journalctl -u apache2', `curl -I http://${a}.campus.lan/`, 'ls -l /srv/www/' + a, 'cat /etc/apache2/listen.conf'] }),
      hints: ['Every <VirtualHost> needs a matching </VirtualHost>.', 'Files must be readable (644) and directories enterable (755) by the web server user.', `A VirtualHost on *:${port} needs "Listen ${port}".`],
      initialState: linux(net, apache({ [`/etc/apache2/vhosts.d/${a}.conf`]: `<VirtualHost *:80>\n    ServerName ${a}.campus.lan\n    DocumentRoot /srv/www/${a}\n` as never, [`/etc/apache2/vhosts.d/${b}.conf`]: `<VirtualHost *:${port}>\n    ServerName ${b}.campus.lan\n    DocumentRoot /srv/www/${b}\n</VirtualHost>\n` as never, [`/srv/www/${a}/`]: { mode: '700' } as never, [`/srv/www/${a}/index.html`]: { content: `${a} site\n`, mode: '600' } as never, [`/srv/www/${b}/index.html`]: `${b} site\n` as never, '/etc/hosts': `127.0.0.1\tlocalhost ${a}.campus.lan ${b}.campus.lan\n` as never })),
      checks: [out('The configuration is valid', 'apachectl configtest', { contains: 'Syntax OK' }), svc('Apache is running', 'apache2', { active: true }), out(`${a} answers on port 80`, `curl -s http://${a}.campus.lan/`, { contains: `${a} site` }), out(`${b} answers on port ${port}`, `curl -s http://${b}.campus.lan:${port}/`, { contains: `${b} site` }), file('No world-writable fix was used', `/srv/www/${a}/index.html`, { mode: '644' })],
      solution: ['apachectl configtest', `echo '</VirtualHost>' >> /etc/apache2/vhosts.d/${a}.conf`, `chmod 755 /srv/www/${a}`, `chmod 644 /srv/www/${a}/index.html`, `echo 'Listen ${port}' >> /etc/apache2/listen.conf`, 'apachectl configtest', 'systemctl restart apache2', `curl -s http://${b}.campus.lan:${port}/`],
      realityNote: 'Syntax errors, file permissions and missing Listen lines cover most "Apache will not serve my site" tickets; configtest and the error log find them.',
    };
  }),

  /* ---------------------------------------------------------------- 9.2 HTTPS, redirects, basic auth, Nginx */
  tmpl(9, 2, 'beginner', 'https-concepts', 'Understand HTTPS and certificates for a website', 'E10', 15, 'Choose certificates, Let\'s Encrypt validation and redirects for a public site.', (v) => {
    const site = v.pick(['admissions', 'library', 'alumni']);
    return caseStudy(v, {
      intro: `## Securing ${site}.example.edu.gh\n\nThe ${site} site must move to HTTPS.`,
      steps: [
        { title: 'Which certificate', text: 'The site is public. Which certificate?', choices: [{ text: 'A publicly trusted certificate, for example free from Let\'s Encrypt via certbot', right: true, feedback: 'Correct. Browsers trust it with no warnings.' }, { text: 'A self-signed certificate', feedback: 'Every visitor would see a warning and learn to click through it.' }, { text: 'No certificate: HTTPS is only for payments', feedback: 'Every site with logins or forms needs HTTPS; browsers flag HTTP as "Not secure".' }] },
        { title: 'Validation', text: 'Let\'s Encrypt must check that you control the name. The HTTP-01 challenge needs...', choices: [{ text: 'Port 80 reachable from the internet for the name, serving the challenge file', right: true, feedback: 'Correct. DNS-01 is the alternative when port 80 is not reachable.' }, { text: 'An email to the ICT director', feedback: 'That is not how ACME validation works.' }, { text: 'A paid account', feedback: 'Let\'s Encrypt is free.' }] },
        { title: 'Renewal', text: 'Let\'s Encrypt certificates last 90 days.', choices: [{ text: 'Automate renewal (certbot\'s timer) and monitor expiry', right: true, feedback: 'Correct.' }, { text: 'Set a calendar reminder every three months', feedback: 'Manual renewals are the classic cause of expired certificates.' }, { text: 'Buy a 10-year certificate instead', feedback: 'Public certificates are limited to about a year now, and shrinking.' }] },
        { title: 'HTTP visitors', text: 'Old links point to http://.', choices: [{ text: 'Keep port 80 open only to redirect permanently (301) to https://', right: true, feedback: 'Correct.' }, { text: 'Close port 80 entirely', feedback: 'Old links would just fail, and HTTP-01 renewals would break.' }, { text: 'Serve the full site on both', feedback: 'Then logins can still happen over plain HTTP.' }] },
        { title: 'Private key', text: 'Who may read the certificate\'s private key file?', choices: [{ text: 'Only root (mode 600); the web server reads it at start-up', right: true, feedback: 'Correct.' }, { text: 'Everyone: it is part of the certificate', feedback: 'The key is the secret; anyone with it can impersonate the site.' }, { text: 'Put it in the web root for backup', feedback: 'Then anyone could download it.' }] },
      ],
      ending: { title: 'HTTPS planned', text: 'A trusted certificate, automated renewal, an HTTP-to-HTTPS redirect and a protected private key.' },
      hints: ['What does a visitor\'s browser have to trust?'],
      realityNote: 'Let\'s Encrypt issues most of the web\'s certificates; its ACME protocol made HTTPS free and automatic.',
    });
  }),
  tmpl(9, 2, 'intermediate', 'basic-auth', 'Protect a staff area with a password', 'E4', 20, 'Add HTTP basic authentication to one directory of a site with htpasswd.', (v) => {
    const net = v.net();
    const site = v.pick(DEPTS);
    const [p1, p2] = v.people(2);
    return {
      instructions: lab({ situation: `The ${site} site (**${site}.campus.lan**, document root /srv/www/${site}) has a **/staff/** area that must ask for a password. Create **/etc/apache2/htpasswd-${site}** with users **${p1.sam}** and **${p2.sam}**, and protect the directory **/srv/www/${site}/staff** with Basic authentication (AuthType Basic, AuthName, AuthUserFile, Require valid-user) in the virtual host. The public home page must stay open. (Basic auth sends passwords readable to anyone on the network unless the site uses HTTPS: this server is behind the campus TLS proxy.)`, steps: ['htpasswd -c for the first user, without -c for the second.', 'Add a <Directory> block for the staff directory to the vhost.', 'configtest and reload.', 'curl -I without and with -u user:password.'], tips: [`htpasswd -c -b /etc/apache2/htpasswd-${site} ${p1.sam} PASSWORD`, `curl -I http://${site}.campus.lan/staff/`, `curl -u ${p1.sam}:PASSWORD http://${site}.campus.lan/staff/`] }),
      hints: ['-c creates (and overwrites) the file: use it only for the first user.', 'Keep the password file outside the document root.'],
      initialState: linux(net, apache({ [`/etc/apache2/vhosts.d/${site}.conf`]: `<VirtualHost *:80>\n    ServerName ${site}.campus.lan\n    DocumentRoot /srv/www/${site}\n</VirtualHost>\n` as never, [`/srv/www/${site}/index.html`]: `${site} public page\n` as never, [`/srv/www/${site}/staff/index.html`]: `${site} staff only\n` as never, '/etc/hosts': `127.0.0.1\tlocalhost ${site}.campus.lan\n` as never })),
      checks: [out('The staff area asks for a password', `curl -I http://${site}.campus.lan/staff/`, { contains: '401 Unauthorized' }), out(`${p2.sam} can log in`, `curl -s -u ${p2.sam}:Staff@2026 http://${site}.campus.lan/staff/`, { contains: `${site} staff only` }), out('The home page stays public', `curl -s http://${site}.campus.lan/`, { contains: `${site} public page` }), file('The password file is outside the web root', `/etc/apache2/htpasswd-${site}`, { contains: [`${p1.sam}:`, `${p2.sam}:`] }), out('The configuration is valid', 'apachectl configtest', { contains: 'Syntax OK' })],
      solution: [`htpasswd -c -b /etc/apache2/htpasswd-${site} ${p1.sam} Staff@2026`, `htpasswd -b /etc/apache2/htpasswd-${site} ${p2.sam} Staff@2026`, `printf '<VirtualHost *:80>\\n    ServerName ${site}.campus.lan\\n    DocumentRoot /srv/www/${site}\\n    <Directory "/srv/www/${site}/staff">\\n        AuthType Basic\\n        AuthName "Staff area"\\n        AuthUserFile /etc/apache2/htpasswd-${site}\\n        Require valid-user\\n    </Directory>\\n</VirtualHost>\\n' > /etc/apache2/vhosts.d/${site}.conf`, 'apachectl configtest', 'systemctl reload apache2', `curl -I http://${site}.campus.lan/staff/`],
      realityNote: 'Basic authentication is fine behind HTTPS for small internal areas; anything bigger should use the institution\'s single sign-on.',
    };
  }),
  tmpl(9, 2, 'advanced', 'redirect-to-https', 'Redirect a site permanently to HTTPS and a new name', 'E4', 20, 'Use virtual hosts to send old names and plain HTTP to one canonical HTTPS address.', (v) => {
    const net = v.net();
    const oldName = v.pick(['library-old.campus.lan', 'lib.campus.lan', 'elib.campus.lan']);
    const newName = v.pick(['library.campus.lan', 'books.campus.lan']);
    return {
      instructions: lab({ situation: `The library site moved to **https://${newName}/**. Plain HTTP requests for **${newName}** and every request for the old name **${oldName}** must get a **permanent redirect (301)** to \`https://${newName}/\`. Create **/etc/apache2/vhosts.d/redirects.conf** with port-80 virtual hosts that do only this (the HTTPS site itself runs on the campus TLS proxy).`, steps: ['One <VirtualHost *:80> with ServerName ' + newName + ' and ServerAlias ' + oldName + '.', 'Inside it: Redirect permanent / https://' + newName + '/', 'configtest, reload, and curl -I both names.'], tips: [`Redirect permanent / https://${newName}/`, `curl -I http://${oldName}/`, 'apachectl -S'] }),
      hints: ['301 is permanent (browsers and search engines remember it); 302 is temporary.'],
      initialState: linux(net, apache({ '/etc/hosts': `127.0.0.1\tlocalhost ${newName} ${oldName}\n` as never })),
      checks: [out(`The old name redirects permanently`, `curl -I http://${oldName}/`, { contains: ['301 Moved Permanently', `Location: https://${newName}/`] }), out('Plain HTTP for the new name redirects', `curl -I http://${newName}/`, { contains: ['301', `Location: https://${newName}/`] }), out('Apache knows the names', 'apachectl -S', { contains: newName }), out('The configuration is valid', 'apachectl configtest', { contains: 'Syntax OK' })],
      solution: [`printf '<VirtualHost *:80>\\n    ServerName ${newName}\\n    ServerAlias ${oldName}\\n    Redirect permanent / https://${newName}/\\n</VirtualHost>\\n' > /etc/apache2/vhosts.d/redirects.conf`, 'apachectl configtest', 'systemctl reload apache2', `curl -I http://${oldName}/`],
      realityNote: 'Nginx does the same with "return 301 https://$host$request_uri;"; either way, one canonical HTTPS name is better for users and search engines.',
    };
  }),

  /* ---------------------------------------------------------------- 9.3 BIND */
  tmpl(9, 3, 'beginner', 'forward-zone', 'Set up an authoritative forward zone in BIND', 'E4', 25, 'Install BIND, add a zone with A records, check it and query it.', (v) => {
    const net = v.net();
    const zone = v.pick(['campus.lan', 'faculty.lan', 'college.lan']);
    const hosts = v.some(['www', 'mail', 'files', 'print', 'moodle'], 3).map((h, i) => ({ h, ip: `${net}.${20 + i * 5}` }));
    return {
      instructions: lab({ situation: `Make this server (${net}.5) the authoritative DNS server for **${zone}**. Install **bind**, add a master zone for ${zone} with the file **/var/lib/named/${zone}.zone** containing an SOA record, an NS record for **ns1.${zone}** (A ${net}.5), and these A records: ${hosts.map((x) => `**${x.h}** ${x.ip}`).join(', ')}. Check both the configuration and the zone, start named at boot, and query it.`, steps: ['zypper install bind.', 'Append a zone block to /etc/named.conf.', 'Write the zone file (with $TTL, SOA, NS and A records).', 'named-checkconf and named-checkzone.', 'systemctl enable --now named; dig @127.0.0.1.'], tips: [`zone "${zone}" in {\n    type master;\n    file "${zone}.zone";\n};`, `@ IN SOA ns1.${zone}. hostmaster.${zone}. ( 2026102201 3600 900 604800 300 )`, `named-checkzone ${zone} /var/lib/named/${zone}.zone`, `dig @127.0.0.1 www.${zone}`] }),
      hints: ['Names ending in a dot are absolute; names without a dot get the zone name appended.', 'The serial is usually the date plus a two-digit counter.'],
      initialState: linux(net),
      checks: [pkg('BIND is installed', 'bind'), svc('named runs at boot', 'named', { active: true, enabled: true }), out('The zone loads', `named-checkzone ${zone} /var/lib/named/${zone}.zone`, { contains: 'OK' }), ...hosts.map((x) => out(`${x.h}.${zone} resolves`, `dig @127.0.0.1 ${x.h}.${zone} +short`, { equals: x.ip })), out('The server is authoritative (aa flag)', `dig @127.0.0.1 ${hosts[0].h}.${zone}`, { contains: 'flags: qr aa' })],
      solution: ['zypper install bind', `printf '\\nzone "${zone}" in {\\n    type master;\\n    file "${zone}.zone";\\n};\\n' >> /etc/named.conf`, `printf '$TTL 3600\\n@ IN SOA ns1.${zone}. hostmaster.${zone}. ( 2026102201 3600 900 604800 300 )\\n  IN NS ns1\\nns1 IN A ${net}.5\\n${hosts.map((x) => `${x.h} IN A ${x.ip}`).join('\\n')}\\n' > /var/lib/named/${zone}.zone`, 'named-checkconf', `named-checkzone ${zone} /var/lib/named/${zone}.zone`, 'systemctl enable --now named', `dig @127.0.0.1 ${hosts[0].h}.${zone} +short`],
      realityNote: 'BIND remains the reference DNS server; its zone file format is shared by most other DNS software.',
    };
  }),
  tmpl(9, 3, 'intermediate', 'reverse-zone', 'Add a reverse zone with PTR records', 'E4', 25, 'Create the in-addr.arpa zone for a subnet so addresses resolve back to names.', (v) => {
    const net = v.net();
    const [, b, c] = net.split('.');
    const rev = `${c}.${b}.10.in-addr.arpa`;
    const zone = 'campus.lan';
    const hosts = v.some(['www', 'mail', 'files', 'print'], 3).map((h, i) => ({ h, last: 20 + i * 5 }));
    return {
      instructions: lab({ situation: `Forward lookups for **${zone}** already work on this server. Logs and some services need **reverse** lookups too. Add the zone **${rev}** (file **/var/lib/named/${rev}.zone**) with SOA and NS records and PTR records for ${hosts.map((x) => `**${net}.${x.last}** → ${x.h}.${zone}`).join(', ')}. Restart named and test with dig -x.`, steps: ['Add the zone block to named.conf.', 'Write the zone file: PTR records are named by the last octet.', 'named-checkzone, then systemctl restart named.', `dig -x ${net}.${hosts[0].last} @127.0.0.1.`], tips: [`zone "${rev}" in { type master; file "${rev}.zone"; };`, `${hosts[0].last} IN PTR ${hosts[0].h}.${zone}.`, `dig -x ${net}.${hosts[0].last} @127.0.0.1 +short`] }),
      hints: ['PTR targets need the trailing dot, or the zone name is appended to them.'],
      initialState: linux(net, { packages: { bind: { installed: true } }, services: { named: { active: true, enabled: true, package: 'bind', port: 53 } }, files: bindZone(zone, net, hosts.map((x) => `${x.h}\tIN\tA\t${net}.${x.last}`).join('\n') + '\n') }),
      checks: [...hosts.map((x) => out(`${net}.${x.last} resolves to ${x.h}.${zone}`, `dig -x ${net}.${x.last} @127.0.0.1 +short`, { equals: `${x.h}.${zone}.` })), out('The reverse zone loads', `named-checkzone ${rev} /var/lib/named/${rev}.zone`, { contains: 'OK' }), svc('named is running', 'named', { active: true })],
      solution: [`printf '\\nzone "${rev}" in {\\n    type master;\\n    file "${rev}.zone";\\n};\\n' >> /etc/named.conf`, `printf '$TTL 3600\\n@ IN SOA ns1.${zone}. hostmaster.${zone}. ( 2026102201 3600 900 604800 300 )\\n  IN NS ns1.${zone}.\\n${hosts.map((x) => `${x.last} IN PTR ${x.h}.${zone}.`).join('\\n')}\\n' > /var/lib/named/${rev}.zone`, `named-checkzone ${rev} /var/lib/named/${rev}.zone`, 'systemctl restart named', `dig -x ${net}.${hosts[0].last} @127.0.0.1 +short`],
      realityNote: 'Mail servers and many security tools check reverse DNS; missing PTR records cause rejected mail and unreadable logs.',
    };
  }),
  tmpl(9, 3, 'advanced', 'forwarding-and-transfers', 'Configure forwarding and restrict zone transfers', 'E4', 25, 'Forward external names to upstream resolvers and allow zone transfers only to the secondary.', (v) => {
    const net = v.net();
    const zone = 'campus.lan';
    const secondary = `${net}.6`;
    const fwd = v.pick([['41.66.199.10', '41.66.199.11'], ['197.251.243.5', '197.251.243.6']]);
    return {
      instructions: lab({ situation: `This server is authoritative for **${zone}** and also answers staff PCs' queries for internet names. Two problems: anyone can download the whole zone (**AXFR**), and it resolves internet names slowly from the root servers. Fix both in /etc/named.conf:\n\n1. Allow zone transfers of ${zone} **only** to the secondary server **${secondary}** (allow-transfer in the zone block).\n2. Forward internet queries to the ISP resolvers **${fwd.join(' and ')}** (forwarders in options).\n\nCheck the configuration, restart, and confirm a transfer from this machine is now refused.`, steps: ['Edit the zone block and the options block.', 'named-checkconf.', 'systemctl restart named.', `dig @127.0.0.1 ${zone} AXFR should say "Transfer failed".`, 'dig @127.0.0.1 www.google.com should still work.'], tips: [`allow-transfer { ${secondary}; };`, `forwarders { ${fwd.join('; ')}; };`] }),
      hints: ['Every statement inside { } ends with a semicolon, including the last one.'],
      initialState: linux(net, { packages: { bind: { installed: true } }, services: { named: { active: true, enabled: true, package: 'bind', port: 53 } }, files: bindZone(zone, net, `www\tIN\tA\t${net}.20\n`, { zoneOpts: 'allow-transfer { any; };' }) }),
      checks: [out('Zone transfers to others are refused', `dig @127.0.0.1 ${zone} AXFR`, { contains: 'Transfer failed' }), file('Only the secondary may transfer', '/etc/named.conf', { pattern: `allow-transfer\\s*\\{\\s*${secondary.replace(/\./g, '\\.')};\\s*\\}`, notContains: 'allow-transfer { any; }' }), file('Forwarders are set', '/etc/named.conf', { contains: fwd }), out('The configuration is valid', 'named-checkconf', { status: 0 }), out('Local names still resolve', `dig @127.0.0.1 www.${zone} +short`, { equals: `${net}.20` }), out('Internet names resolve through the forwarders', 'dig @127.0.0.1 www.google.com +short', { equals: '142.250.184.4' })],
      solution: [`sed -i 's/allow-transfer { any; };/allow-transfer { ${secondary}; };/' /etc/named.conf`, `sed -i 's/    recursion yes;/    recursion yes;\\n    forwarders { ${fwd.join('; ')}; };/' /etc/named.conf`, 'named-checkconf', 'systemctl restart named', `dig @127.0.0.1 ${zone} AXFR`],
      realityNote: 'Open zone transfers leak a map of the whole network; restricting AXFR (better, with TSIG keys) is basic DNS hygiene.',
    };
  }),

  /* ---------------------------------------------------------------- 9.4 testing DNS, common misconfigurations */
  tmpl(9, 4, 'beginner', 'query-tools', 'Answer questions with dig, host and nslookup', 'E4', 15, 'Use three DNS tools to look up addresses and names.', (v) => {
    const net = v.net();
    const zone = 'campus.lan';
    const web = `${net}.${v.int(20, 40)}`;
    return {
      instructions: lab({ situation: `Use the local DNS server to answer: the address of **www.${zone}** (with **host**), the name of **${net}.5** (reverse lookup with **nslookup**), and the TTL of the www record (with **dig**). Write them to **/root/dns.txt** as \`address=...\`, \`name=...\` (without the final dot) and \`ttl=...\`.`, steps: ['host www.' + zone, `nslookup ${net}.5`, 'dig www.' + zone + ': the TTL is the number after the name in the ANSWER SECTION.'], tips: ['host www.' + zone, `nslookup ${net}.5`, `dig www.${zone}`] }),
      hints: ['The resolver here already points at 127.0.0.1.'],
      initialState: linux(net, { packages: { bind: { installed: true } }, services: { named: { active: true, enabled: true, package: 'bind', port: 53 } }, files: { ...bindZone(zone, net, `www\tIN\tA\t${web}\n`, { extraConf: `\nzone "${net.split('.').slice(1).reverse().join('.')}.10.in-addr.arpa" in {\n    type master;\n    file "rev.zone";\n};\n` }), '/var/lib/named/rev.zone': `$TTL 3600\n@\tIN\tSOA\tns1.${zone}. hostmaster.${zone}. ( 2026102101 3600 900 604800 300 )\n\tIN\tNS\tns1.${zone}.\n5\tIN\tPTR\tns1.${zone}.\n`, '/etc/resolv.conf': `search ${zone}\nnameserver 127.0.0.1\n` } }),
      checks: [file('The address is right', '/root/dns.txt', { contains: `address=${web}` }), file('The name is right', '/root/dns.txt', { contains: `name=ns1.${zone}` }), file('The TTL is right', '/root/dns.txt', { contains: 'ttl=3600' }), ran('You used host', '^host '), ran('You used nslookup', '^nslookup ')],
      solution: [`host www.${zone}`, `nslookup ${net}.5`, `dig www.${zone}`, `printf 'address=${web}\\nname=ns1.${zone}\\nttl=3600\\n' > /root/dns.txt`],
      realityNote: 'host is quick, nslookup is everywhere (including Windows) and dig shows the full answer; administrators use all three.',
    };
  }),
  tmpl(9, 4, 'intermediate', 'fix-zone-errors', 'Fix the classic zone file mistakes', 'E4', 25, 'Repair a missing trailing dot, a bad address and an unchanged serial, then reload.', (v) => {
    const net = v.net();
    const zone = 'campus.lan';
    const alias = v.pick(['portal', 'elearn', 'library']);
    const goodIp = `${net}.${v.int(20, 40)}`;
    return {
      instructions: lab({ situation: `Someone edited **/var/lib/named/${zone}.zone** and now: \`${alias}.${zone}\` points to a strange name, \`files.${zone}\` does not resolve, and secondaries never pick up changes. Fix the zone: (1) the CNAME target is missing its trailing dot, (2) the A record for **files** has an invalid address (it should be **${goodIp}**), and (3) increase the **serial** so secondaries notice. Check, restart named, and test.`, steps: ['named-checkzone shows some errors.', `dig @127.0.0.1 ${alias}.${zone} shows the CNAME problem.`, 'Edit the file (sed or an editor).', 'Increase the serial, check again, restart named.'], tips: [`named-checkzone ${zone} /var/lib/named/${zone}.zone`, `dig @127.0.0.1 ${alias}.${zone}`] }),
      hints: [`"www.${zone}" without a dot becomes "www.${zone}.${zone}".`, 'Serials only ever go up; YYYYMMDDnn is the usual format.'],
      initialState: linux(net, { packages: { bind: { installed: true } }, services: { named: { active: true, enabled: true, package: 'bind', port: 53 } }, files: bindZone(zone, net, `www\tIN\tA\t${net}.10\nfiles\tIN\tA\t${net}.300\n${alias}\tIN\tCNAME\twww.${zone}\n`, { serial: 2026101501 }) }),
      checks: [out('The zone is valid', `named-checkzone ${zone} /var/lib/named/${zone}.zone`, { contains: 'OK' }), out(`${alias} points at www`, `dig @127.0.0.1 ${alias}.${zone}`, { contains: `CNAME\twww.${zone}.`, notContains: `www.${zone}.${zone}` }), out('files resolves', `dig @127.0.0.1 files.${zone} +short`, { equals: goodIp }), file('The serial was increased', `/var/lib/named/${zone}.zone`, { pattern: '\\( 20261(0(1[6-9]|[23]\\d)|[12]\\d{2})\\d{2} |\\( 202610150[2-9] |\\( 20261015[1-9]\\d ' })],
      solution: [`named-checkzone ${zone} /var/lib/named/${zone}.zone`, `sed -i 's/CNAME\\twww\\.${zone.replace('.', '\\.')}$/CNAME\\twww.${zone}./' /var/lib/named/${zone}.zone`, `sed -i 's/${net.replace(/\./g, '\\.')}\\.300/${goodIp}/' /var/lib/named/${zone}.zone`, `sed -i 's/2026101501/2026102201/' /var/lib/named/${zone}.zone`, `named-checkzone ${zone} /var/lib/named/${zone}.zone`, 'systemctl restart named', `dig @127.0.0.1 ${alias}.${zone}`],
      realityNote: 'The missing trailing dot and the forgotten serial bump are the two most famous BIND mistakes; named-checkzone and dig catch both.',
    };
  }),
  tmpl(9, 4, 'advanced', 'dns-diagnosis', 'Diagnose DNS problems from dig output', 'E10', 20, 'Read dig answers to find lame delegation, stale caches, missing glue and split-horizon issues.', (v) => {
    const zone = v.pick(['campus.lan', 'faculty.lan']);
    return caseStudy(v, {
      intro: '## Four DNS tickets\n\nRead the dig output for each and decide the cause.',
      steps: [
        { title: 'Old address everywhere', text: 'You changed www\'s address an hour ago, but some users still reach the old server.', evidence: [{ title: 'dig www (from a staff PC\'s resolver)', kind: 'log', text: `;; ANSWER SECTION:\nwww.${zone}.\t\t82800\tIN\tA\t10.0.0.80` }], choices: [{ text: 'Resolvers cached the old record for its TTL (a day): lower TTLs before planned changes', right: true, feedback: 'Correct. The remaining TTL shows 23 hours left.' }, { text: 'The zone was not saved', feedback: 'Your server answers correctly; caches elsewhere do not.' }, { text: 'Restart every PC', feedback: 'The cache is in the resolver, not the PC.' }] },
        { title: 'SERVFAIL', text: 'Queries for the zone fail from outside.', evidence: [{ title: 'dig +trace (excerpt)', kind: 'log', text: `${zone}.\t86400\tIN\tNS\tns2.${zone}.\n;; Received ... from ns2.${zone}: status: REFUSED` }], choices: [{ text: 'Lame delegation: ns2 is listed as authoritative but does not serve the zone', right: true, feedback: 'Correct. Fix ns2\'s configuration or remove it from the NS records.' }, { text: 'The internet is down', feedback: 'Other queries work.' }, { text: 'The TTL is too long', feedback: 'TTLs do not cause REFUSED.' }] },
        { title: 'Different answers inside and outside', text: 'Inside campus, intranet resolves to 10.x; outside, it resolves to nothing. Is that a fault?', choices: [{ text: 'No: split-horizon DNS on purpose, internal names only on internal servers', right: true, feedback: 'Correct. Many institutions deliberately hide internal names.' }, { text: 'Yes: every name must resolve everywhere', feedback: 'Exposing internal names helps attackers map the network.' }, { text: 'Yes: delete the internal record', feedback: 'Staff need it.' }] },
        { title: 'Secondary out of date', text: 'The secondary server still answers with last week\'s data.', choices: [{ text: 'The serial was not increased, or transfers to the secondary are blocked: check the serial and allow-transfer', right: true, feedback: 'Correct.' }, { text: 'Secondaries never update', feedback: 'They update when the serial increases.' }, { text: 'Delete the secondary', feedback: 'You lose redundancy.' }] },
      ],
      ending: { title: 'Tickets solved', text: 'Caches and TTLs, lame delegation, deliberate split horizon and serial or transfer problems.' },
      hints: ['The number after the name in an answer is the remaining TTL.'],
      realityNote: 'dig +trace follows a lookup from the root servers down and is the standard way to find delegation problems.',
    });
  }),

  /* ---------------------------------------------------------------- 9.5 NFS, Samba, mail, databases */
  tmpl(9, 5, 'beginner', 'nfs-export', 'Share a directory over NFS', 'E4', 20, 'Export a directory read-write to one subnet and open the firewall.', (v) => {
    const net = v.net();
    const dir = v.pick(['/srv/nfs/home', '/srv/nfs/projects', '/srv/nfs/scratch']);
    return {
      instructions: lab({ situation: `The compute lab's Linux PCs (${net}.0/24) need **${dir}** over NFS, read-write, with root squashing (a root user on a client must not be root on the server). Install the NFS server, add the export to **/etc/exports**, apply it, start the server at boot and allow nfs in the firewall.`, steps: ['zypper install nfs-kernel-server.', `mkdir -p ${dir}.`, `echo "${dir} ${net}.0/24(rw,sync,root_squash)" >> /etc/exports.`, 'exportfs -ra; systemctl enable --now nfs-server.', 'firewall-cmd --permanent --add-service=nfs; reload; showmount -e.'], tips: ['exportfs -v', 'showmount -e localhost'] }),
      hints: ['There is no space between the client and the opening bracket of its options.'],
      initialState: linux(net, { packages: { 'nfs-kernel-server': { installed: false, version: '2.6', description: 'NFS server', service: 'nfs-server' } } }),
      checks: [pkg('The NFS server is installed', 'nfs-kernel-server'), file('The export is configured', '/etc/exports', { pattern: `^${dir.replace(/\//g, '\\/')}\\s+${net.replace(/\./g, '\\.')}\\.0\\/24\\(rw,sync,root_squash\\)` }), out('The export is valid', 'exportfs -v', { contains: dir }), svc('nfs-server runs at boot', 'nfs-server', { active: true, enabled: true }), out('It is advertised', 'showmount -e', { contains: dir }), out('The firewall allows NFS', 'firewall-cmd --list-services', { contains: 'nfs' })],
      solution: ['zypper install nfs-kernel-server', `mkdir -p ${dir}`, `echo "${dir} ${net}.0/24(rw,sync,root_squash)" >> /etc/exports`, 'exportfs -ra', 'systemctl enable --now nfs-server', 'firewall-cmd --permanent --add-service=nfs', 'firewall-cmd --reload', 'showmount -e'],
      realityNote: 'NFS is the native file sharing of Unix; on campus networks it is usually paired with Kerberos (sec=krb5) so clients cannot simply claim any user ID.',
    };
  }),
  tmpl(9, 5, 'intermediate', 'samba-share', 'Share a directory with Windows PCs using Samba', 'E4', 25, 'Configure a Samba share for one group, validate it with testparm and start the service.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const p = v.person();
    return {
      instructions: lab({ situation: `The ${dept} office uses Windows PCs. Share **/srv/samba/${dept}** as **[${dept}]**, writable only by members of the Linux group **${dept}**, not browseable by guests. Validate with **testparm**, enable and start **smb**, and allow **samba** through the firewall. ${p.sam} is in the group; give them a Samba password with smbpasswd later (not needed here).`, steps: ['zypper install samba.', 'Create the directory with group ' + dept + ' and mode 2770.', 'Add the share section to /etc/samba/smb.conf.', 'testparm; systemctl enable --now smb; firewall-cmd --permanent --add-service=samba; reload.'], tips: [`[${dept}]\n   path = /srv/samba/${dept}\n   valid users = @${dept}\n   writable = yes\n   guest ok = no`, 'testparm -s'] }),
      hints: ['@name in valid users means a group.', 'Samba permissions sit on top of the Linux file permissions: both must allow access.'],
      initialState: linux(net, { groups: { [dept]: [p.sam] }, users: { [p.sam]: { groups: [dept] } }, packages: { samba: { installed: false, version: '4.19', description: 'SMB file server', service: 'smb' } }, files: { '/etc/samba/smb.conf': '[global]\n   workgroup = CAMPUS\n   security = user\n   map to guest = Bad User\n' } }),
      checks: [file('The share is defined', '/etc/samba/smb.conf', { pattern: `\\[${dept}\\][\\s\\S]*path\\s*=\\s*\\/srv\\/samba\\/${dept}[\\s\\S]*valid users\\s*=\\s*@${dept}` }), out('testparm accepts it', 'testparm -s', { contains: `[${dept}]`, notContains: 'ERROR' }), file('The directory belongs to the group with setgid', `/srv/samba/${dept}`, { kind: 'dir', mode: '2770', group: dept }), svc('smb runs at boot', 'smb', { active: true, enabled: true }), out('The firewall allows Samba', 'firewall-cmd --list-services', { contains: 'samba' })],
      solution: ['zypper install samba', `mkdir -p /srv/samba/${dept}`, `chgrp ${dept} /srv/samba/${dept}`, `chmod 2770 /srv/samba/${dept}`, `printf '\\n[${dept}]\\n   path = /srv/samba/${dept}\\n   valid users = @${dept}\\n   writable = yes\\n   guest ok = no\\n   browseable = yes\\n' >> /etc/samba/smb.conf`, 'testparm -s', 'systemctl enable --now smb', 'firewall-cmd --permanent --add-service=samba', 'firewall-cmd --reload'],
      realityNote: 'Samba lets Linux serve Windows clients and even act as an Active Directory domain controller.',
    };
  }),
  tmpl(9, 5, 'advanced', 'choose-services', 'Choose and secure file, mail and database services', 'E10', 20, 'Pick NFS, Samba or web sharing, decide about running mail, and keep databases private.', (v) => {
    const n = v.int(200, 800);
    return caseStudy(v, {
      intro: `## Services for ${n} staff\n\nThe faculty asks for several services on its Linux servers. Advise on each.`,
      steps: [
        { title: 'Shared drive for Windows staff', text: 'Most staff use Windows laptops.', choices: [{ text: 'Samba (SMB) shares tied to the campus directory', right: true, feedback: 'Correct. Native to Windows clients.' }, { text: 'NFS', feedback: 'Windows supports NFS poorly; SMB is native.' }, { text: 'An FTP server', feedback: 'Clear-text and awkward for daily work.' }] },
        { title: 'Home directories for the Linux compute lab', text: 'Linux PCs need the same home directories everywhere.', choices: [{ text: 'NFS (ideally with Kerberos) with automount', right: true, feedback: 'Correct.' }, { text: 'Copy homes to each PC nightly', feedback: 'Files diverge between PCs.' }, { text: 'Samba mounted by every user by hand', feedback: 'Possible, but NFS with automount is the Unix-native answer.' }] },
        { title: 'Run our own mail server?', text: 'Someone suggests hosting the faculty\'s email on a Linux server with Postfix.', choices: [{ text: 'Use the university\'s central or cloud mail; running mail well needs spam filtering, SPF/DKIM/DMARC and constant care', right: true, feedback: 'Correct for a faculty. Local Postfix is fine for sending server notifications through the central relay.' }, { text: 'Yes, it is easy', feedback: 'Deliverability and spam make it hard.' }, { text: 'Use the web server to send mail directly to the internet', feedback: 'It will be blocked as spam or abused as a relay.' }] },
        { title: 'Database for the web app', text: 'A MariaDB database serves a web application on the same server.', choices: [{ text: 'Bind it to 127.0.0.1 (or a socket), use a dedicated database user with least privilege', right: true, feedback: 'Correct. Nothing on the network needs to reach it.' }, { text: 'Open 3306 to the campus so staff can run reports', feedback: 'Give reporting a read-only replica or an API, not the production database port.' }, { text: 'Use the root database account in the app', feedback: 'A compromise of the app would own every database.' }] },
      ],
      ending: { title: 'Services planned', text: 'Samba for Windows staff, NFS for Linux homes, central mail with a local relay, and a private, least-privilege database.' },
      hints: ['Match protocols to clients, and keep databases off the network.'],
      realityNote: 'Most security incidents on small servers involve a service that did not need to be exposed; the cheapest fix is not running or exposing it.',
    });
  }),
];

