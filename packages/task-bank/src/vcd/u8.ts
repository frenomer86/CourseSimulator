/** Unit 8: automated deployment — environments, deploying from CI, deployment strategies and release gates. */

import type { TaskTemplate } from '../types';
import type { Org, Person, Variant } from './kit';
import { C, HOST, ORGS, caseStudy, dockerBits, dockerDev, dockerStateFile, file, forge, fuser, image, lab, out, owned, registryPackage, repo, simToken, svc, tmpl, withForge, write } from './kit';

const home = (me: Person) => `/home/${me.sam}`;

/** A small web app image: serves a page naming its version and environment. */
function webImage(o: Org, ver: string, extra = '') {
  const start = `#!/bin/sh\n${extra}mkdir -p /srv/www\necho "<h1>${o.what} \${APP_VERSION} (\${APP_ENV:-dev})</h1>" > /srv/www/index.html\necho "\${APP_VERSION}" > /srv/www/version\necho "\${APP_ENV:-dev}" > /srv/www/env\necho ok > /srv/www/healthz\necho "listening on 8080"\nexec httpd -f -p 8080 -h /srv/www\n`;
  return image(`${o.org}/${o.project}:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: start, mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, expose: [8080] });
}

const auth = (me: Person) => btoa(`${me.sam}:${simToken(me.sam)}`);
const dockerLogin = (me: Person) => ({ [`${home(me)}/.docker/config.json`]: JSON.stringify({ auths: { [HOST]: { auth: auth(me) } } }, null, '\t') + '\n' });

export const U8: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 8.1 environments, configuration and secrets */
  tmpl(8, 1, 'beginner', 'environments-and-config', 'Plan environments, configuration and secrets', 'E10', 15, 'Decide how development, staging and production differ, where configuration lives and how secrets are kept and rotated.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## One server, one config file\n\n${o.org}'s ${o.what} runs straight from a developer's laptop configuration: the database password is in config.py in the repository, and "testing" happens on the production server after hours. A failed change last month corrupted real payments data. You are asked to set up proper environments.`,
      steps: [
        { title: 'Which environments', text: 'What should exist besides production?', choices: [{ text: 'Development on each machine, and a staging environment that mirrors production (same image, same kind of database) where every release is tried first', right: true, feedback: 'Correct. Staging catches what only shows up in a production-like setup, before customers see it.' }, { text: 'Only production; test carefully', feedback: 'That is how the payments data was damaged.' }, { text: 'A staging server that runs a different OS and database "because it is only for testing"', feedback: 'The more staging differs from production, the less it proves.' }] },
        { title: 'Where configuration lives', text: 'The app needs a database URL, an API base URL and a feature switch that differ per environment.', choices: [{ text: 'In the environment (environment variables or mounted files), not in the code; the same build runs everywhere with different settings', right: true, feedback: 'Correct. This is the "config" factor of the twelve-factor app: one artifact, configured at deploy time.' }, { text: 'Separate code branches per environment', feedback: 'Branches drift; you would be testing different code from what you ship.' }, { text: 'if/else on the server\'s host name inside the code', feedback: 'Hard-coded environment logic breaks as soon as a host is renamed or added.' }] },
        { title: 'Where secrets live', text: 'The database password is in config.py in git.', choices: [{ text: 'Move it to a secret store (CI environment secrets, a vault, or files only the service can read), remove it from the repository, and rotate it, since it is already in the history', right: true, feedback: 'Correct. Removing a secret from the latest commit does not remove it from history: assume it is leaked and change it.' }, { text: 'Delete the line and commit; problem solved', feedback: 'The old value is still in every clone\'s history.' }, { text: 'Base64-encode it in the file', feedback: 'Encoding is not encryption: anyone can decode it.' }] },
        { title: 'Separate credentials', text: 'Should staging and production share the database password and API keys?', choices: [{ text: 'No: each environment has its own credentials, and staging can never write to production data', right: true, feedback: 'Correct. Separate credentials limit the damage of a leak or a bad staging test.' }, { text: 'Yes, it is simpler', feedback: 'Then a staging mistake can reach production.' }, { text: 'Staging uses production credentials but read-only', feedback: 'Still exposes production data to a less protected environment.' }] },
        { title: 'Promotion', text: 'A release passed staging. How does it reach production?', choices: [{ text: 'The exact same artifact (image digest) is deployed to production with production\'s configuration', right: true, feedback: 'Correct. Build once, promote everywhere: what was tested is what runs.' }, { text: 'Rebuild from the same commit for production', feedback: 'A rebuild can pull different dependencies; you would ship something untested.' }, { text: 'Copy the staging server\'s files to production', feedback: 'Manual copying is error-prone and skips the configuration step.' }] },
      ],
      ending: { title: 'Environments done right', text: 'Development, a production-like staging and production; configuration and secrets outside the code, separate per environment; and one tested artifact promoted unchanged.' },
      hints: ['Twelve-factor app: store config in the environment.', 'A secret that was ever committed must be rotated.'],
      realityNote: 'GitHub and GitLab environments, Kubernetes Secrets and HashiCorp Vault all implement this separation of configuration and credentials per environment.',
    });
  }),
  tmpl(8, 1, 'intermediate', 'ci-environments', 'Use deployment environments in CI', 'E4', 30, 'Create staging and production environments with their own variables and secrets, require a reviewer for production, and deploy through them from a workflow.', (v) => {
    const o = v.pick(ORGS);
    const [me, mate] = v.people(2);
    const full = `${o.org}/${o.project}`;
    const urls = { staging: `https://staging.${o.org}.org/api`, production: `https://api.${o.org}.org` };
    const tokens = { staging: `stg-${v.int(100000, 999999)}`, production: `prd-${v.int(100000, 999999)}` };
    const deploy = '#!/bin/bash\n# Deploys the current build to the named environment.\nset -euo pipefail\nenv="${1:?usage: deploy.sh ENVIRONMENT}"\n: "${DEPLOY_TOKEN:?DEPLOY_TOKEN is not set for $env}"\necho "deploying to $env at ${API_URL:?API_URL is not set}"\necho "token ends in ...${DEPLOY_TOKEN: -2}"\n';
    const wf = `name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  staging:\n    runs-on: ubuntu-latest\n    environment: staging\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy.sh staging\n        env:\n          API_URL: \${{ vars.API_URL }}\n          DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n  production:\n    needs: staging\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy.sh production\n        env:\n          API_URL: \${{ vars.API_URL }}\n          DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n`;
    const id = 2;
    return {
      instructions: lab({
        situation: `**${full}** (cloned at ~/${o.project}) has **deploy.sh**, which needs **API_URL** and **DEPLOY_TOKEN**. Set up deployment environments on the forge and a workflow that uses them:\n\n- environment **staging**: variable API_URL = \`${urls.staging}\`, secret DEPLOY_TOKEN = \`${tokens.staging}\`;\n- environment **production**: variable API_URL = \`${urls.production}\`, secret DEPLOY_TOKEN = \`${tokens.production}\`, and **${mate.sam}** as a **required reviewer** (production deployments wait for their approval);\n- **.github/workflows/deploy.yml**, workflow **Deploy** on pushes to main: job **staging** (environment staging) runs \`./deploy.sh staging\`, then job **production** (needs staging, environment production) runs \`./deploy.sh production\`; both pass the variable and the secret as API_URL and DEPLOY_TOKEN.\n\nPush it. Staging should deploy; production should wait for ${mate.sam}.`,
        steps: [`gh api -X PUT repos/${full}/environments/staging`, `gh api users/${mate.sam} --jq .id`, `gh api -X PUT repos/${full}/environments/production --input -   (with {"reviewers":[{"type":"User","id":ID}]})`, 'gh variable set API_URL --env staging --body …; gh secret set DEPLOY_TOKEN --env staging --body …', 'Same for production', 'Write the workflow, commit, push', 'gh run list; gh run view'],
        tips: ['echo \'{"reviewers":[{"type":"User","id":2}]}\' | gh api -X PUT repos/OWNER/REPO/environments/production --input -', 'In a job with environment: NAME, ${{ vars.X }} and ${{ secrets.Y }} come from that environment.', 'gh variable list --env staging'],
      }),
      hints: ['A job only sees an environment\'s variables and secrets if it declares environment: NAME.', 'Required reviewers turn a deployment job into "waiting" until someone approves it.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [mate.sam]: fuser(mate, o, { local: false }) }, repos: { [full]: { members: { [mate.sam]: 'write' }, commits: [C('Add deploy script', me, o, { 'deploy.sh': deploy, 'README.md': `# ${o.project}\n` })], seed: { executable: ['deploy.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        forge('staging has its variable and secret', full, { variable: { name: 'API_URL', value: urls.staging, env: 'staging' }, secret: { name: 'DEPLOY_TOKEN', env: 'staging' } }),
        forge('production has its variable and secret', full, { variable: { name: 'API_URL', value: urls.production, env: 'production' }, secret: { name: 'DEPLOY_TOKEN', env: 'production' } }),
        forge(`production requires ${mate.sam}'s approval`, full, { environment: { name: 'production', reviewers: [mate.sam] } }),
        forge('Staging deployed with staging settings; production waits for approval', full, { run: { workflow: 'Deploy', headOfBranch: 'main', log: `deploying to staging at ${urls.staging.replace(/[.]/g, '\\.')}`, jobStatus: { staging: 'success', production: 'waiting' } } }),
      ],
      solution: [`cd ~/${o.project}`, `gh api -X PUT repos/${full}/environments/staging --silent`, `echo '{"reviewers":[{"type":"User","id":${id}}]}' | gh api -X PUT repos/${full}/environments/production --input - --silent`, `gh variable set API_URL --env staging --body '${urls.staging}'`, `gh secret set DEPLOY_TOKEN --env staging --body '${tokens.staging}'`, `gh variable set API_URL --env production --body '${urls.production}'`, `gh secret set DEPLOY_TOKEN --env production --body '${tokens.production}'`, 'mkdir -p .github/workflows', write('.github/workflows/deploy.yml', wf), 'git add .github && git commit -qm "Deploy through environments" && git push -q', 'gh run list', 'gh run view'],
      realityNote: 'This is GitHub Actions\' environment model (Gitea and Forgejo follow it too): scoped variables and secrets, plus protection rules such as required reviewers, per environment.',
    };
  }),
  tmpl(8, 1, 'advanced', 'promote-same-image', 'Promote the tested image to production', 'E4', 30, 'Run staging and production from one compose file with different environment files, and promote exactly the image digest staging tested.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const ver = `1.${v.int(2, 9)}.${v.int(0, 9)}`;
    const next = `1.${v.int(10, 12)}.0-rc1`;
    const [sp, pp] = v.pick([[8081, 8080], [8181, 8180], [9081, 9080]]);
    const tested = webImage(o, ver);
    const rc = webImage(o, next);
    const pkg = registryPackage(o.org, o.project, { [ver]: tested, latest: rc }, 'private', `${o.org}/${o.project}`);
    const digest = pkg.tags[ver];
    const remote = `${HOST}/${o.org}/${o.project}`;
    const dir = `${home(me)}/${o.project}`;
    const compose = 'services:\n  app:\n    image: ${APP_IMAGE}\n    ports:\n      - "${PORT}:8080"\n    environment:\n      APP_ENV: ${APP_ENV}\n    restart: unless-stopped\n';
    const files = owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/staging.env`]: `APP_ENV=staging\nPORT=${sp}\nAPP_IMAGE=${remote}@${digest}\n`, [`${dir}/production.env`]: `APP_ENV=production\nPORT=${pp}\nAPP_IMAGE=${remote}:latest\n`, ...dockerLogin(me) }, me.sam);
    const full = `${o.org}/${o.project}`;
    return {
      instructions: lab({
        situation: `~/${o.project} has one **compose.yaml** for every environment and an env file per environment. **Staging** runs from **staging.env** (project name **${o.project}-staging**, port ${sp}) and has been tested. **production.env** still says \`:latest\`, which now points at an untested release candidate.\n\n1. Start staging: \`docker compose -p ${o.project}-staging --env-file staging.env up -d\`.\n2. Promote: make **production.env** use **exactly the image staging runs** (the same digest), keep APP_ENV=production and port ${pp}.\n3. Start production as project **${o.project}-production** with production.env.\n\nBoth must run the same image; each must report its own environment at /env.`,
        steps: [`cd ~/${o.project}; docker compose -p ${o.project}-staging --env-file staging.env up -d`, `docker inspect -f '{{.Config.Image}}' ${o.project}-staging-app-1`, 'Edit production.env: APP_IMAGE=…@sha256:…', `docker compose -p ${o.project}-production --env-file production.env config`, `docker compose -p ${o.project}-production --env-file production.env up -d`, `curl -s localhost:${pp}/env; curl -s localhost:${pp}/version`],
        tips: ['-p gives each environment its own project (and container names) from the same file.', '--env-file chooses the values ${…} in compose.yaml is filled with.', 'A digest pins the exact image; :latest can move.'],
      }),
      hints: ['docker compose … config shows the file with the environment file\'s values filled in.', 'Copy the APP_IMAGE line from staging.env: it already has the digest.'],
      initialState: withForge({ me, org: o, ...dockerBits(me, { pulled: ['alpine:3.20'] }), files: { ...dockerStateFile({ pulled: ['alpine:3.20'] }), ...files }, seed: { users: { [me.sam]: fuser(me, o, { scopes: ['repo', 'read:org', 'read:packages'] }) }, repos: { [full]: { commits: [C('Initial', me, o, { 'README.md': `# ${o.project}\n` })] } }, packages: { [full]: pkg } } }),
      checks: [
        out('Staging runs the tested image', `docker inspect -f '{{.Config.Image}}' ${o.project}-staging-app-1`, { equals: `${remote}@${digest}` }),
        out('Production runs the same image', `docker inspect -f '{{.Config.Image}}' ${o.project}-production-app-1`, { equals: `${remote}@${digest}` }),
        out('Production reports production and the tested version', `curl -s localhost:${pp}/env; curl -s localhost:${pp}/version`, { equals: `production\n${ver}` }),
        out('Staging still reports staging', `curl -s localhost:${sp}/env`, { equals: 'staging' }),
        file('production.env is pinned to the digest', `${dir}/production.env`, { contains: [`APP_IMAGE=${remote}@${digest}`, 'APP_ENV=production'], notContains: ':latest' }),
      ],
      solution: [`cd ~/${o.project} && docker compose -p ${o.project}-staging --env-file staging.env up -d`, `docker inspect -f '{{.Config.Image}}' ${o.project}-staging-app-1`, `cd ~/${o.project} && sed -i "s|^APP_IMAGE=.*|$(grep ^APP_IMAGE= staging.env)|" production.env`, `cd ~/${o.project} && docker compose -p ${o.project}-production --env-file production.env up -d`, `curl -s localhost:${pp}/env; curl -s localhost:${pp}/version`],
      realityNote: '"Build once, deploy many" is how mature pipelines work: the artifact\'s digest is recorded when it passes staging, and production deploys that digest with production\'s configuration.',
    };
  }),

  /* ---------------------------------------------------------------- 8.2 deploying to a static host, a VPS; infrastructure as code */
  tmpl(8, 2, 'beginner', 'pages-deploy', 'Deploy a static site from CI', 'E4', 25, 'Build a site in a workflow and publish it to the forge\'s Pages hosting with the Pages actions.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}-site`;
    const repoName = `${o.project}-site`;
    const title = `${o.what} — ${v.city()} office`;
    const build = `#!/bin/bash\n# Builds the site into _site/.\nset -euo pipefail\nrm -rf _site && mkdir -p _site\nfor f in pages/*.txt; do\n  name=$(basename "$f" .txt)\n  { echo "<html><head><title>${title}</title></head><body>"; sed 's|^|<p>|; s|$|</p>|' "$f"; echo "</body></html>"; } > "_site/$name.html"\ndone\necho "built $(ls _site | wc -l) pages"\n`;
    const pages = { 'pages/index.txt': `Welcome to the ${o.what}.\nOpening hours: 8:00 to 17:00.\n`, 'pages/contact.txt': `Call 030 ${v.int(200, 299)} ${v.int(1000, 9999)}.\n` };
    const wf = `name: Pages\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\n  pages: write\n  id-token: write\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./build.sh\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: _site\n  deploy:\n    needs: build\n    runs-on: ubuntu-latest\n    environment:\n      name: github-pages\n      url: \${{ steps.deployment.outputs.page_url }}\n    steps:\n      - id: deployment\n        uses: actions/deploy-pages@v4\n`;
    const url = `http://${o.org}.pages.${HOST}/${repoName}/`;
    return {
      instructions: lab({
        situation: `**${full}** (cloned at ~/${repoName}) builds its pages with \`./build.sh\` into **_site/**. Publish it on the forge's static hosting (Pages, like GitHub Pages):\n\n1. Turn Pages on for the repository with the **workflow** build type: \`gh api -X POST repos/${full}/pages -f build_type=workflow\`.\n2. Add **.github/workflows/pages.yml**, workflow **Pages** on pushes to main: a **build** job that runs ./build.sh and uploads _site with **actions/upload-pages-artifact**, and a **deploy** job (needs build) that runs **actions/deploy-pages** (it needs the \`pages: write\` and \`id-token: write\` permissions).\n3. Push, and check the site at **${url}**.`,
        steps: [`gh api -X POST repos/${full}/pages -f build_type=workflow`, 'Write .github/workflows/pages.yml', 'git add . && git commit -m … && git push', 'gh run view', `curl -s ${url}`, `curl -s ${url}contact.html`],
        tips: ['permissions:\n  pages: write\n  id-token: write', '- uses: actions/upload-pages-artifact@v3\n  with:\n    path: _site', '- uses: actions/deploy-pages@v4'],
      }),
      hints: ['The build job and the deploy job run on different machines; the artifact carries the files between them.', 'If curl shows "There isn\'t a Pages site here", check that Pages is on and the deploy job succeeded.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { visibility: 'public', commits: [C('Site sources', me, o, { 'build.sh': build, ...pages, '.gitignore': '_site/\n' })], seed: { executable: ['build.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        forge('The Pages workflow built and deployed', full, { run: { workflow: 'Pages', headOfBranch: 'main', conclusion: 'success', jobStatus: { build: 'success', deploy: 'success' } } }),
        out('The site is published', `curl -s ${url}`, { contains: [title, `Welcome to the ${o.what}.`] }),
        out('Every page is published', `curl -s -o /dev/null -w '%{http_code}' ${url}contact.html`, { equals: '200' }),
      ],
      solution: [`cd ~/${repoName}`, `gh api -X POST repos/${full}/pages -f build_type=workflow --silent`, 'mkdir -p .github/workflows', write('.github/workflows/pages.yml', wf), 'git add .github && git commit -qm "Publish with Pages" && git push -q', 'gh run list', `curl -s ${url}`],
      realityNote: 'This is the standard GitHub Pages workflow (configure, upload-pages-artifact, deploy-pages); Netlify, Cloudflare Pages and GitLab Pages work the same way: build in CI, upload the static files, publish.',
    };
  }),
  tmpl(8, 2, 'intermediate', 'push-to-deploy', 'Deploy to a VPS with git push', 'E4', 30, 'Set up a bare repository on the server whose post-receive hook checks the pushed branch out into the web root, and deploy by pushing.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const v1 = `<h1>${o.what}</h1>\n<p>Version 1</p>\n`;
    const v2 = `<h1>${o.what}</h1>\n<p>Now open on Saturdays</p>\n`;
    const site = `${home(me)}/site`;
    const commits = [C('First page', me, o, { 'index.html': v1 }), C('Saturday opening', me, o, { 'index.html': v2 }, 1)];
    const hook = `#!/bin/sh\n# Deploys main into the web root after every push.\nwhile read old new ref; do\n  [ "$ref" = refs/heads/main ] || continue\n  git --work-tree=/srv/www/htdocs --git-dir=/srv/git/site.git checkout -f main\n  echo "deployed $(git --git-dir=/srv/git/site.git rev-parse --short main)"\ndone\n`;
    return {
      instructions: lab({
        situation: `This machine is ${o.org}'s web server: nginx serves **/srv/www/htdocs** (which you own). Your site's repository is **~/site**. Set up "push to deploy":\n\n1. Create a bare repository **/srv/git/site.git** (you own /srv/git).\n2. Give it a **post-receive** hook that, when **main** is pushed, checks main out into /srv/www/htdocs (\`git --work-tree=/srv/www/htdocs --git-dir=/srv/git/site.git checkout -f main\`). Make it executable.\n3. In ~/site, add the bare repository as a remote called **production** and push main to it.\n\nThe site at http://localhost must then show the latest commit's page.`,
        steps: ['git init --bare /srv/git/site.git', 'Write /srv/git/site.git/hooks/post-receive; chmod +x it', 'cd ~/site; git remote add production /srv/git/site.git', 'git push production main', 'curl -s localhost'],
        tips: ['A bare repository has no working files: the hook puts them where the web server reads them.', 'The hook reads "old new ref" lines on standard input, one per pushed branch.'],
      }),
      hints: ['If the push succeeds but the site does not change, check that the hook is executable and named exactly post-receive.', 'git --work-tree and --git-dir let one command use a repository and a work tree that live in different places.'],
      initialState: dockerDev({ me, files: { ...repo(me.sam, site, commits), '/srv/git/': { content: '', owner: me.sam, group: me.sam }, '/srv/www/htdocs/index.html': { content: '<h1>Under construction</h1>\n', owner: me.sam, group: me.sam }, '/srv/www/htdocs/': { content: '', owner: me.sam, group: me.sam }, [`${home(me)}/.gitconfig`]: { content: `[user]\n\tname = ${me.name}\n\temail = ${me.sam}@${o.org}.org\n[init]\n\tdefaultBranch = main\n`, owner: me.sam, group: me.sam } }, services: { nginx: { active: true, enabled: true, port: 80 } }, packages: ['nginx'] }),
      checks: [
        out('The site shows the latest commit', 'curl -s localhost', { contains: 'Now open on Saturdays' }),
        out('The web root matches main in the bare repository', `git --git-dir=/srv/git/site.git show main:index.html | diff - /srv/www/htdocs/index.html >/dev/null && echo same`, { equals: 'same' }),
        file('The hook is executable', '/srv/git/site.git/hooks/post-receive', { contains: 'checkout', mode: '755' }),
        out('~/site pushes to production', `git -C ${site} remote get-url production`, { equals: '/srv/git/site.git' }),
      ],
      solution: ['git init -q --bare /srv/git/site.git', write('/srv/git/site.git/hooks/post-receive', hook), 'chmod 755 /srv/git/site.git/hooks/post-receive', 'cd ~/site && git remote add production /srv/git/site.git', 'cd ~/site && git push production main', 'curl -s localhost'],
      realityNote: 'Push-to-deploy with a bare repository and a post-receive hook is how many small servers (and older PaaS platforms like Heroku) deploy; larger setups move the same steps into a CI job.',
    };
  }),
  tmpl(8, 2, 'advanced', 'ansible-provision', 'Provision a server with Ansible', 'E4', 40, 'Write an idempotent playbook that installs and configures nginx, creates the deploy user, hardens SSH with a handler, and converges with no changes on a second run.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const deployUser = v.pick(['deploy', 'webdeploy', 'release']);
    const site = `${o.what}`;
    const dir = `${home(me)}/infra`;
    const playbook = `- name: Provision the web server\n  hosts: web\n  become: true\n  vars_files:\n    - vars.yml\n  tasks:\n    - name: Install nginx\n      ansible.builtin.package:\n        name: nginx\n        state: present\n    - name: Deploy user\n      ansible.builtin.user:\n        name: "{{ deploy_user }}"\n        groups: wheel\n        append: true\n    - name: Web root owned by the deploy user\n      ansible.builtin.file:\n        path: /srv/www/htdocs\n        state: directory\n        owner: "{{ deploy_user }}"\n        mode: "0755"\n    - name: Home page\n      ansible.builtin.template:\n        src: index.html.j2\n        dest: /srv/www/htdocs/index.html\n        owner: "{{ deploy_user }}"\n        mode: "0644"\n    - name: No password logins over SSH\n      ansible.builtin.lineinfile:\n        path: /etc/ssh/sshd_config\n        regexp: '^#?PasswordAuthentication'\n        line: PasswordAuthentication no\n      notify: restart sshd\n    - name: nginx running and enabled\n      ansible.builtin.service:\n        name: nginx\n        state: started\n        enabled: true\n  handlers:\n    - name: restart sshd\n      ansible.builtin.service:\n        name: sshd\n        state: restarted\n`;
    const files = owned({ [`${dir}/inventory.ini`]: '[web]\nlocalhost ansible_connection=local\n', [`${dir}/vars.yml`]: `deploy_user: ${deployUser}\nsite_name: ${site}\nopening_hours: "8:00-17:00"\n`, [`${dir}/templates/index.html.j2`]: '<h1>{{ site_name }}</h1>\n<p>Open {{ opening_hours }}</p>\n<p>Managed by Ansible on {{ ansible_hostname }}</p>\n' }, me.sam);
    const run = `cd ${dir} && ansible-playbook -i inventory.ini site.yml`;
    return {
      instructions: lab({
        situation: `~/infra has an inventory (this machine, group **web**), **vars.yml** and a template **templates/index.html.j2**. Write **~/infra/site.yml**, a playbook for group web, with become, that loads vars.yml and makes sure that:\n\n- the **nginx** package is installed, and the nginx service is **started and enabled**;\n- user **{{ deploy_user }}** exists and is in group **wheel** (keep its other groups);\n- **/srv/www/htdocs** is a directory owned by the deploy user, mode 0755, and **index.html** in it is rendered from the template;\n- **/etc/ssh/sshd_config** has \`PasswordAuthentication no\` (replacing any existing PasswordAuthentication line), and **sshd is restarted only when that line changed** (a handler);\n\nRun it with \`--check\` first, then for real, then **again**: the second run must report **changed=0**.`,
        steps: ['ansible-inventory -i inventory.ini --graph', 'Write site.yml with tasks and a handler', 'ansible-playbook -i inventory.ini site.yml --syntax-check', 'ansible-playbook -i inventory.ini site.yml --check --diff', 'ansible-playbook -i inventory.ini site.yml', 'ansible-playbook -i inventory.ini site.yml   (changed=0)', 'curl -s localhost'],
        tips: ['Modules: ansible.builtin.package, user, file, template, lineinfile, service.', 'notify: restart sshd on the task, and a handlers: section with that name.', 'append: true keeps a user\'s existing groups.'],
      }),
      hints: ['Idempotent means describing the end state ("installed", "started", this line present), not running commands: modules then change only what differs.', 'A command or shell task reports changed every run; avoid them when a module exists.'],
      initialState: dockerDev({ me, files, packages: ['ansible'], services: { nginx: { package: 'nginx' } } }),
      checks: [
        out('A further run changes nothing', `${run} | grep -o 'changed=[0-9]*' | head -1`, { equals: 'changed=0', message: 'Running the playbook again still changes things: it is not idempotent (avoid command/shell tasks; describe states).' }),
        svc('nginx runs and starts at boot', 'nginx', { active: true, enabled: true }),
        out(`${deployUser} is in wheel`, `id -nG ${deployUser}`, { contains: 'wheel' }),
        file('The home page is rendered and owned by the deploy user', '/srv/www/htdocs/index.html', { contains: [site, 'Open 8:00-17:00'], owner: deployUser }),
        file('SSH no longer accepts passwords', '/etc/ssh/sshd_config', { contains: 'PasswordAuthentication no', notContains: '#PasswordAuthentication' }),
        file('The playbook uses a handler for sshd', `${dir}/site.yml`, { contains: ['handlers:', 'notify:'] }),
      ],
      solution: [`cd ~/infra`, write('site.yml', playbook), 'ansible-playbook -i inventory.ini site.yml --syntax-check', 'ansible-playbook -i inventory.ini site.yml --check', 'ansible-playbook -i inventory.ini site.yml', 'ansible-playbook -i inventory.ini site.yml', 'curl -s localhost'],
      realityNote: 'This playbook would run unchanged against a real openSUSE server; Ansible (and Terraform for cloud resources) is how infrastructure is kept as reviewed, repeatable code instead of hand-typed commands.',
    };
  }),

  /* ---------------------------------------------------------------- 8.3 deployment strategies; database migrations */
  tmpl(8, 3, 'beginner', 'blue-green', 'Switch traffic with a blue-green deployment', 'E4', 30, 'Run the old and new versions side by side behind nginx and switch traffic by reloading the proxy configuration, keeping the old version ready for rollback.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const oldV = `2.${v.int(0, 4)}.${v.int(0, 9)}`;
    const newV = `2.${v.int(5, 9)}.0`;
    const port = v.pick([8080, 8088, 8000]);
    const dir = `${home(me)}/${o.project}`;
    const proj = o.project;
    const conf = (to: string) => `upstream app {\n    server ${to}:8080;\n}\n\nserver {\n    listen 80;\n    location / {\n        proxy_pass http://app;\n    }\n}\n`;
    const compose = `services:\n  blue:\n    image: ${o.org}/${o.project}:${oldV}\n    environment:\n      APP_ENV: blue\n  green:\n    image: ${o.org}/${o.project}:${newV}\n    environment:\n      APP_ENV: green\n  proxy:\n    image: nginx:1.27-alpine\n    ports:\n      - "${port}:80"\n    volumes:\n      - ./proxy/default.conf:/etc/nginx/conf.d/default.conf:ro\n    depends_on:\n      - blue\n      - green\n`;
    return {
      instructions: lab({
        situation: `~/${proj}/compose.yaml runs **blue** (the live version, ${oldV}), **green** (the new version, ${newV}) and an nginx **proxy** on port ${port} that sends every request to the upstream in **proxy/default.conf** — currently blue.\n\n1. Start the stack and check http://localhost:${port}/version shows ${oldV}.\n2. Switch traffic to **green** by editing proxy/default.conf, testing the configuration (\`nginx -t\` in the proxy container) and **reloading** nginx (not restarting the container), so no request is dropped.\n3. Leave **blue running**: rolling back is then just switching the upstream back.`,
        steps: [`cd ~/${proj}; docker compose up -d; curl -s localhost:${port}/version`, 'Edit proxy/default.conf: server green:8080;', 'docker compose exec proxy nginx -t', 'docker compose exec proxy nginx -s reload', `curl -s localhost:${port}/version`, 'docker compose ps'],
        tips: ['nginx -t checks the configuration without applying it; nginx -s reload applies it gracefully.', 'Editing the file alone changes nothing: nginx reads its configuration at start and on reload.'],
      }),
      hints: ['If /version still shows the old version, nginx has not re-read its configuration yet.', 'docker compose logs proxy shows "reconfiguring" after a reload.'],
      initialState: dockerDev({ me, docker: { pulled: ['nginx:1.27-alpine', 'alpine:3.20'], images: [webImage(o, oldV), webImage(o, newV)] }, files: owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/proxy/default.conf`]: conf('blue') }, me.sam) }),
      checks: [
        out(`Traffic goes to green (${newV})`, `curl -s localhost:${port}/version; curl -s localhost:${port}/env`, { equals: `${newV}\ngreen` }),
        out('Blue is still running for a rollback', `docker inspect -f '{{.State.Status}}' ${proj}-blue-1`, { equals: 'running' }),
        out('nginx was reloaded, not restarted', `docker logs ${proj}-proxy-1`, { contains: 'reconfiguring', message: 'The proxy\'s log shows no reload: use nginx -s reload inside the container instead of restarting it.' }),
        file('The proxy configuration points at green', `${dir}/proxy/default.conf`, { contains: 'server green:8080', notContains: 'server blue:8080' }),
      ],
      solution: [`cd ~/${proj} && docker compose up -d`, `curl -s localhost:${port}/version`, `sed -i 's/server blue:8080;/server green:8080;/' ~/${proj}/proxy/default.conf`, `cd ~/${proj} && docker compose exec proxy nginx -t`, `cd ~/${proj} && docker compose exec proxy nginx -s reload`, `curl -s localhost:${port}/version`],
      realityNote: 'Blue-green deployment keeps two complete versions and moves traffic in one step at the router (nginx, a load balancer, or a Kubernetes Service selector); rollback is the same step in reverse.',
    };
  }),
  tmpl(8, 3, 'intermediate', 'canary', 'Send a small share of traffic to a canary', 'E4', 30, 'Give a new version a weighted share of requests through nginx, measure the split, and record it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const stable = `3.${v.int(0, 4)}.0`;
    const canary = `3.${v.int(5, 9)}.0`;
    const [ws, wc] = v.pick([[9, 1], [4, 1], [3, 1]]);
    const port = v.pick([8080, 8090]);
    const n = 20;
    const dir = `${home(me)}/${o.project}`;
    const proj = o.project;
    const compose = `services:\n  stable:\n    image: ${o.org}/${o.project}:${stable}\n  canary:\n    image: ${o.org}/${o.project}:${canary}\n  proxy:\n    image: nginx:1.27-alpine\n    ports:\n      - "${port}:80"\n    volumes:\n      - ./proxy/default.conf:/etc/nginx/conf.d/default.conf:ro\n    depends_on:\n      - stable\n      - canary\n`;
    const conf = (canaryLine: string) => `upstream app {\n    server stable:8080${canaryLine ? ` weight=${ws}` : ''};\n${canaryLine}}\n\nserver {\n    listen 80;\n    location / {\n        proxy_pass http://app;\n    }\n}\n`;
    const pct = Math.round((wc / (ws + wc)) * 100);
    const expect = `${String((n * ws) / (ws + wc)).padStart(7)} ${stable}\n${String((n * wc) / (ws + wc)).padStart(7)} ${canary}`;
    return {
      instructions: lab({
        situation: `~/${proj} runs **stable** (${stable}) and a **canary** (${canary}) behind an nginx proxy on port ${port}; proxy/default.conf sends everything to stable.\n\n1. Change the upstream so the canary gets **${pct}%** of requests: stable with **weight=${ws}**, canary with **weight=${wc}**. Test and reload nginx.\n2. Measure: send ${n} requests to http://localhost:${port}/version and save the count per version, as \`sort | uniq -c\` prints it, to **~/canary.txt**.`,
        steps: [`cd ~/${proj}; docker compose up -d`, `Edit proxy/default.conf: server stable:8080 weight=${ws}; server canary:8080 weight=${wc};`, 'docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload', `for i in $(seq ${n}); do curl -s localhost:${port}/version; done | sort | uniq -c > ~/canary.txt`, 'cat ~/canary.txt'],
        tips: ['nginx spreads requests over an upstream\'s servers in proportion to their weights.', 'A canary is watched closely (errors, latency) before it gets more traffic, or is removed.'],
      }),
      hints: ['Weights 9 and 1 mean 9 of every 10 requests go to the first server.', 'Reload after editing, or nginx keeps the old upstream.'],
      initialState: dockerDev({ me, docker: { pulled: ['nginx:1.27-alpine', 'alpine:3.20'], images: [webImage(o, stable), webImage(o, canary)] }, files: owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/proxy/default.conf`]: conf('') }, me.sam) }),
      checks: [
        file('The upstream is weighted', `${dir}/proxy/default.conf`, { contains: [`server stable:8080 weight=${ws}`, `server canary:8080 weight=${wc}`] }),
        out('nginx uses the weights', `for i in $(seq ${ws + wc}); do curl -s localhost:${port}/version; done | sort | uniq -c`, { equals: `${String(ws).padStart(7)} ${stable}\n${String(wc).padStart(7)} ${canary}` }),
        file('The measured split is recorded', `${home(me)}/canary.txt`, { equals: expect }),
      ],
      solution: [`cd ~/${proj} && docker compose up -d`, write(`~/${proj}/proxy/default.conf`, conf(`    server canary:8080 weight=${wc};\n`)), `cd ~/${proj} && docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`, `for i in $(seq ${n}); do curl -s localhost:${port}/version; done | sort | uniq -c > ~/canary.txt`, 'cat ~/canary.txt'],
      realityNote: 'Weighted routing is how canaries are run with nginx, HAProxy, cloud load balancers and service meshes; tools such as Argo Rollouts and Flagger move the weights automatically while watching error rates.',
    };
  }),
  tmpl(8, 3, 'advanced', 'db-migration', 'Deploy a release that needs a database migration', 'E4', 40, 'Add a backward-compatible migration, run it as a one-off Compose service before the new version starts, and keep the old schema working.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const pw = v.password();
    const port = v.pick([8080, 8000]);
    const people = v.people(3);
    const dir = `${home(me)}/crm`;
    const appImg = (ver: string, cols: string) => image(`${o.org}/crm:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: `#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8 9 10; do pg_isready -h "$PGHOST" -q && break; sleep 1; done\npsql -c "SELECT ${cols} FROM customers" >/dev/null || { echo "schema check failed: crm ${ver} needs ${cols}"; exit 1; }\necho "crm ${ver}: schema ok"\nmkdir -p /srv/www && echo "${ver}" > /srv/www/version && echo ok > /srv/www/healthz\nexec httpd -f -p 8080 -h /srv/www\n`, mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, pkgs: ['psql'], expose: [8080] });
    const v1 = appImg('1.0', 'id, name');
    const v2 = appImg('2.0', 'id, name, phone');
    const db = { tables: { customers: { cols: ['id', 'name'], types: { id: 'int', name: 'text' }, rows: people.map((p, i) => [String(i + 1), p.name]) }, schema_migrations: { cols: ['version'], types: { version: 'text' }, rows: [['001']] } } };
    const compose = `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      retries: 10\n  app:\n    image: ${o.org}/crm:1.0\n    ports:\n      - "${port}:8080"\n    environment:\n      PGHOST: db\n      PGUSER: postgres\n      PGPASSWORD: \${DB_PASSWORD}\n    depends_on:\n      db:\n        condition: service_healthy\nvolumes:\n  dbdata:\n`;
    const after = `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      retries: 10\n  migrate:\n    image: postgres:16\n    command: ["psql", "-h", "db", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "/migrations/002_add_phone.sql"]\n    environment:\n      PGPASSWORD: \${DB_PASSWORD}\n    volumes:\n      - ./migrations:/migrations:ro\n    depends_on:\n      db:\n        condition: service_healthy\n  app:\n    image: ${o.org}/crm:2.0\n    ports:\n      - "${port}:8080"\n    environment:\n      PGHOST: db\n      PGUSER: postgres\n      PGPASSWORD: \${DB_PASSWORD}\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\nvolumes:\n  dbdata:\n`;
    const mig = "ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone text DEFAULT '';\nINSERT INTO schema_migrations VALUES ('002');\n";
    const vol = '/var/lib/docker/volumes/crm_dbdata/_data';
    const files = { ...owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/.env`]: `DB_PASSWORD=${pw}\n`, [`${dir}/migrations/001_init.sql`]: "CREATE TABLE customers (id int, name text);\nCREATE TABLE schema_migrations (version text);\nINSERT INTO schema_migrations VALUES ('001');\n", [`${dir}/RELEASE.md`]: '# crm 2.0\n\nShows a phone number for each customer. Needs a `phone` column (text) in `customers`.\n' }, me.sam), [`${vol}/PG_VERSION`]: { content: '16\n', owner: 'root', group: 'root' }, [`${vol}/cslab-db.json`]: { content: JSON.stringify(db), owner: 'root', group: 'root' } };
    const dc = `cd ${dir} && docker compose`;
    return {
      instructions: lab({
        situation: `~/crm runs **crm 1.0** with PostgreSQL in Compose (the data is in the volume dbdata; migration 001 is applied). **crm 2.0** (image ${o.org}/crm:2.0) needs a new **phone** column — see RELEASE.md. Deploy it safely:\n\n1. Write **migrations/002_add_phone.sql**: add \`phone\` (text, default empty) to customers **without breaking 1.0** (expand: add, never rename or drop yet), safe to run twice (IF NOT EXISTS), and record version **002** in schema_migrations.\n2. Add a **migrate** service to compose.yaml that runs it once with psql (postgres:16 image, \`-v ON_ERROR_STOP=1\`, the migrations folder mounted read-only) after db is healthy.\n3. Switch **app** to **${o.org}/crm:2.0** and make it start only after migrate **completed successfully**.\n4. \`docker compose up -d\`; the customers must all still be there.`,
        steps: [`cd ~/crm; docker compose up -d; docker compose logs app`, 'Write migrations/002_add_phone.sql', 'Add the migrate service; change app\'s image and depends_on', 'docker compose up -d', 'docker compose ps -a; docker compose logs migrate app', "docker compose exec db psql -U postgres -c '\\d customers'"],
        tips: ['depends_on:\n  migrate:\n    condition: service_completed_successfully', 'command: ["psql", "-h", "db", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "/migrations/002_add_phone.sql"]', 'Expand/contract: add the new column now; remove old ones only when no running version uses them.'],
      }),
      hints: ['Starting 2.0 before the migration makes it exit with "schema check failed".', 'ON_ERROR_STOP makes psql exit non-zero on the first error, so a failed migration stops the deployment.'],
      initialState: dockerDev({ me, docker: { pulled: ['postgres:16', 'alpine:3.20'], images: [v1, v2], volumes: ['crm_dbdata'] }, files }),
      checks: [
        out('crm 2.0 runs and its schema check passed', `${dc} logs app`, { contains: 'crm 2.0: schema ok' }),
        out('The app answers as 2.0', `curl -s localhost:${port}/version`, { equals: '2.0' }),
        out('The migration ran once and succeeded', `docker inspect -f '{{.State.ExitCode}}' crm-migrate-1`, { equals: '0' }),
        out('customers keeps name and gains phone', `${dc} exec db psql -U postgres -c '\\d customers'`, { contains: [' name ', ' phone '] }),
        out('No customer was lost', `${dc} exec db psql -U postgres -tc 'SELECT count(*) FROM customers'`, { contains: String(people.length) }),
        out('Version 002 is recorded', `${dc} exec db psql -U postgres -tc 'SELECT version FROM schema_migrations'`, { contains: '002' }),
        file('The migration is safe to run again', `${dir}/migrations/002_add_phone.sql`, { contains: 'IF NOT EXISTS' }),
        file('2.0 waits for the migration', `${dir}/compose.yaml`, { contains: ['service_completed_successfully', 'ON_ERROR_STOP=1'] }),
      ],
      solution: ['cd ~/crm && docker compose up -d', write('~/crm/migrations/002_add_phone.sql', mig), write('~/crm/compose.yaml', after), 'cd ~/crm && docker compose up -d', 'cd ~/crm && docker compose ps -a', 'cd ~/crm && docker compose logs migrate app', "cd ~/crm && docker compose exec db psql -U postgres -c '\\d customers'"],
      realityNote: 'Running migrations as a separate, ordered step (a Compose service, a Kubernetes Job or an init container) and keeping them backward compatible (expand, migrate, contract) is how teams change schemas without downtime; tools like Flyway, Liquibase and Alembic keep the schema_migrations bookkeeping.',
    };
  }),

  /* ---------------------------------------------------------------- 8.4 continuous delivery vs deployment; gates and approvals */
  tmpl(8, 4, 'beginner', 'delivery-vs-deployment', 'Choose between continuous delivery and deployment', 'E10', 15, 'Decide where automation stops and people approve, and which gates a release must pass.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## From green build to production\n\n${o.org}'s pipeline builds and tests every commit to main. Releases to the ${o.what} still happen once a month by hand, from a checklist. The team wants faster, safer releases.`,
      steps: [
        { title: 'The two terms', text: 'What is the difference?', choices: [{ text: 'Continuous delivery: every passing change is ready to release and a person decides when. Continuous deployment: every passing change goes to production automatically', right: true, feedback: 'Correct. Both automate everything up to production; they differ only in that last step.' }, { text: 'They are two names for the same thing', feedback: 'They differ in whether a human approves the final release.' }, { text: 'Delivery is for mobile apps, deployment for web apps', feedback: 'Neither is tied to a platform.' }] },
        { title: 'Which fits first', text: 'Tests are decent but not yet trusted for everything; payments are involved.', choices: [{ text: 'Continuous delivery with an approval gate for production, moving to automatic deployment as confidence in tests and monitoring grows', right: true, feedback: 'Correct. Automation plus a deliberate human gate is a common, safe step from monthly releases.' }, { text: 'Continuous deployment straight away', feedback: 'Without trusted tests and monitoring, automatic production releases are risky for payments.' }, { text: 'Keep monthly manual releases', feedback: 'Large, rare releases are riskier, not safer.' }] },
        { title: 'Gates', text: 'What should a release pass before production?', choices: [{ text: 'Tests in CI, a successful staging deployment with smoke checks, and (for now) an approval on the production environment', right: true, feedback: 'Correct. Each gate is automated evidence, plus one explicit decision.' }, { text: 'Only that it compiles', feedback: 'Compiling proves very little about behaviour.' }, { text: 'A meeting of all developers', feedback: 'A meeting is slow and adds little evidence.' }] },
        { title: 'Who approves', text: 'Who should be the required reviewer for production deployments?', choices: [{ text: 'Someone other than the author (or a small rota), recorded by the platform', right: true, feedback: 'Correct. Separation of duties and an audit trail of who approved what.' }, { text: 'The author, since they know the change best', feedback: 'Self-approval removes the point of the gate.' }, { text: 'Nobody; approvals slow things down', feedback: 'That is continuous deployment — a later step, not where to start.' }] },
        { title: 'What triggers production', text: 'Which event should deploy to production?', choices: [{ text: 'A version tag (v1.4.0) on a commit that already passed staging, so every production release is named and traceable', right: true, feedback: 'Correct. Tags make releases explicit and easy to roll back to.' }, { text: 'Every push to any branch', feedback: 'Unreviewed branches would reach production.' }, { text: 'A cron job every Friday at 17:00', feedback: 'Deploying on a schedule before the weekend, regardless of what changed, is asking for trouble.' }] },
      ],
      ending: { title: 'Delivery first, deployment later', text: 'Every change built, tested and staged automatically; production behind a recorded approval for tagged releases; automatic deployment once tests and monitoring earn that trust.' },
      hints: ['The difference is only the last step to production.', 'A gate should produce evidence or a recorded decision.'],
      realityNote: 'Jez Humble and David Farley\'s "Continuous Delivery" defines the terms; environment protection rules in GitHub, GitLab and Azure DevOps implement the approval gates.',
    });
  }),
  tmpl(8, 4, 'intermediate', 'approve-deployment', 'Review and approve a production deployment', 'E4', 25, 'Find the deployment waiting for you, check what it would release, and approve it through the API.', (v) => {
    const o = v.pick(ORGS);
    const [me, author] = v.people(2);
    const full = `${o.org}/${o.project}`;
    const change = v.pick(['Round fees to the nearest pesewa', 'Add Saturday opening hours', 'Fix date format on receipts']);
    const wf = 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./test.sh\n  production:\n    needs: test\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "deploying $(cat VERSION) to production"\n';
    const ver = `1.${v.int(2, 9)}.${v.int(0, 9)}`;
    return {
      instructions: lab({
        situation: `${author.name} merged "${change}" into **${full}**. The **Deploy** workflow tested it and its **production** job is now **waiting for approval**: you (${me.sam}) are the environment's required reviewer.\n\n1. Find the waiting run and look at what it deploys (the commit and the test job's result).\n2. Approve the **production** environment for that run through the API, with the comment \`Reviewed: ${change}\`.\n3. Confirm the run finished and production was deployed.`,
        steps: [`gh run list -R ${full}`, `gh run view RUN_ID -R ${full}`, `gh api repos/${full}/actions/runs/RUN_ID/pending_deployments`, `gh api -X POST repos/${full}/actions/runs/RUN_ID/pending_deployments -F 'environment_ids[]=ENV_ID' -f state=approved -f comment='…'`, `gh run view RUN_ID -R ${full}`],
        tips: ['The GET on pending_deployments lists the waiting environments with their ids.', `gh run list -R ${full} --json databaseId,status --jq '.[0].databaseId'`],
      }),
      hints: ['Only a required reviewer can approve; the API answers 422 otherwise.', 'Approving resumes the run: the waiting job runs and the run completes.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [author.sam]: fuser(author, o, { local: false }) }, repos: { [full]: { members: { [author.sam]: 'write' }, environments: { production: { reviewers: [me.sam] } }, commits: [C('Initial', author, o, { 'test.sh': '#!/bin/bash\necho "all 12 tests passed"\n', VERSION: '1.0.0\n', '.github/workflows/deploy.yml': wf }), C(change, author, o, { VERSION: `${ver}\n` }, 1)], seed: { executable: ['test.sh'] } } } } }),
      checks: [forge('The production deployment was approved and ran', full, { run: { workflow: 'Deploy', headOfBranch: 'main', conclusion: 'success', log: `deploying ${ver.replace(/\./g, '\\.')} to production`, jobStatus: { test: 'success', production: 'success' } } })],
      solution: [`gh run list -R ${full}`, `run=$(gh run list -R ${full} --json databaseId --jq '.[0].databaseId'); gh run view $run -R ${full}`, `run=$(gh run list -R ${full} --json databaseId --jq '.[0].databaseId'); gh api repos/${full}/actions/runs/$run/pending_deployments`, `run=$(gh run list -R ${full} --json databaseId --jq '.[0].databaseId'); env=$(gh api repos/${full}/environments/production --jq .id); gh api -X POST repos/${full}/actions/runs/$run/pending_deployments -F "environment_ids[]=$env" -f state=approved -f comment='Reviewed: ${change}'`, `gh run list -R ${full}`],
      realityNote: 'Approvals through the REST API (POST …/pending_deployments) are exactly how GitHub records environment reviews; the web interface\'s "Review deployments" button calls the same endpoint.',
    };
  }),
  tmpl(8, 4, 'advanced', 'release-gates', 'Gate production releases on tags and approvals', 'E4', 35, 'Write a pipeline that tests every push, deploys main to staging automatically, and deploys to production only for version tags, after approval.', (v) => {
    const o = v.pick(ORGS);
    const [me, lead] = v.people(2);
    const full = `${o.org}/${o.project}`;
    const tag = `v1.${v.int(3, 9)}.0`;
    const wf = `name: Release\non:\n  push:\n    branches: [main]\n    tags: ['v*']\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./test.sh\n  staging:\n    needs: test\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    environment: staging\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy.sh staging\n  production:\n    needs: test\n    if: startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy.sh production\n`;
    const deploy = '#!/bin/bash\nset -euo pipefail\necho "deploying ${GITHUB_REF_NAME:-local} to ${1:?environment}"\n';
    return {
      instructions: lab({
        situation: `Give **${full}** (clone: ~/${o.project}) a release pipeline in **.github/workflows/release.yml**, workflow **Release**, triggered by pushes to **main** and by tags matching **v***:\n\n- **test**: runs ./test.sh on every trigger;\n- **staging**: after test, **only for main**, environment staging, runs \`./deploy.sh staging\`;\n- **production**: after test, **only for tags starting with v**, environment production, runs \`./deploy.sh production\`.\n\nThe **production** environment must require **${lead.sam}**'s approval (create it). Push main, then create and push an annotated tag **${tag}**: staging must run for main and be skipped for the tag; production must be skipped for main and wait for ${lead.sam} on the tag.`,
        steps: ['Write release.yml with on.push.branches and on.push.tags', 'if: github.ref == \'refs/heads/main\' / if: startsWith(github.ref, \'refs/tags/v\')', `gh api users/${lead.sam} --jq .id; set the production environment's reviewer`, 'git push', `git tag -a ${tag} -m "Release ${tag}" && git push origin ${tag}`, 'gh run list'],
        tips: ['on:\n  push:\n    branches: [main]\n    tags: [\'v*\']', 'A job whose if: is false shows as skipped.'],
      }),
      hints: ['github.ref is refs/heads/main for the branch push and refs/tags/v… for the tag push.', 'A job that needs a skipped job is skipped too, so make staging and production both need only test.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [lead.sam]: fuser(lead, o, { local: false }) }, repos: { [full]: { members: { [lead.sam]: 'maintain' }, environments: { staging: {} }, commits: [C('Tests and deploy script', me, o, { 'test.sh': '#!/bin/bash\necho "tests passed"\n', 'deploy.sh': deploy })], seed: { executable: ['test.sh', 'deploy.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        forge(`production requires ${lead.sam}`, full, { environment: { name: 'production', reviewers: [lead.sam] } }),
        forge('main deployed to staging and skipped production', full, { run: { workflow: 'Release', branch: 'main', jobStatus: { test: 'success', staging: 'success', production: 'skipped' } } }),
        forge(`${tag} skipped staging and waits for approval for production`, full, { run: { workflow: 'Release', branch: tag, jobStatus: { test: 'success', staging: 'skipped', production: 'waiting' } } }),
        forge(`${tag} is an annotated tag`, full, { tag: { name: tag, annotated: true } }),
      ],
      solution: [`cd ~/${o.project}`, `echo '{"reviewers":[{"type":"User","id":2}]}' | gh api -X PUT repos/${full}/environments/production --input - --silent`, 'mkdir -p .github/workflows', write('.github/workflows/release.yml', wf), 'git add .github && git commit -qm "Release pipeline" && git push -q', `git tag -a ${tag} -m "Release ${tag}" && git push -q origin ${tag}`, 'gh run list'],
      realityNote: 'Tag-triggered production jobs with environment protection are a widespread pattern (GitHub Actions, GitLab "only: tags" plus protected environments): every production release is a named version with a recorded approval.',
    };
  }),
];

export type { Org, Variant };
