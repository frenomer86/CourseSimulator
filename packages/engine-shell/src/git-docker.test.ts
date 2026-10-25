import { describe, expect, it } from 'vitest';
import { buildSystem, findRepo, headCommit, loadDocker, loadGit, makeCtx, runLines } from './index.js';

const gitBox = () =>
  buildSystem({ hostname: 'dev', user: 'ama', packages: { git: { installed: true } }, files: { '/home/ama/shop/fees.txt': 'Tuition: 2500\nHostel: 900\nLibrary: 50\n' } });
const repoState = (sys: ReturnType<typeof gitBox>) => {
  const ctx = makeCtx(sys);
  return loadGit(ctx, findRepo(ctx, '/home/ama/shop')!);
};
const IDENTITY = ['git config --global user.name "Ama Mensah"', 'git config --global user.email ama@example.com'];

describe('git', () => {
  it('asks who you are before the first commit', () => {
    const sys = gitBox();
    const out = runLines(sys, ['cd shop', 'git init', 'git add .', 'git commit -m "First"']);
    expect(out).toMatch(/Please tell me who you are/);
    expect(headCommit(repoState(sys))).toBeNull();
  });

  it('commits, branches and fast-forwards', () => {
    const sys = gitBox();
    const out = runLines(sys, [...IDENTITY, 'cd shop', 'git init', 'git add fees.txt', 'git commit -m "Add fees"', 'git switch -c raise', "sed -i 's/Library: 50/Library: 60/' fees.txt", 'git commit -am "Raise library fee"', 'git switch main', 'cat fees.txt', 'git merge raise', 'git log --oneline']);
    expect(out).toMatch(/Initialized empty Git repository in \/home\/ama\/shop\/.git/);
    expect(out).toMatch(/\[main \(root-commit\) [0-9a-f]{7}\] Add fees/);
    expect(out).toMatch(/Library: 50/);
    expect(out).toMatch(/Fast-forward/);
    expect(out).toMatch(/\(HEAD -> main, raise\) Raise library fee/);
    const st = repoState(sys);
    expect(st.commits[headCommit(st)!].tree['fees.txt']).toContain('Library: 60');
  });

  it('marks a conflict line by line and completes the merge after it is fixed', () => {
    const sys = gitBox();
    const out = runLines(sys, [
      ...IDENTITY,
      'cd shop',
      'git init',
      'git add .',
      'git commit -m "Add fees"',
      'git switch -c board',
      "sed -i 's/Tuition: 2500/Tuition: 2600/' fees.txt",
      'git commit -am "Board rate"',
      'git switch main',
      "sed -i 's/Tuition: 2500/Tuition: 2550/' fees.txt",
      'git commit -am "Bursar rate"',
      'git merge board',
      'cat fees.txt',
      'git status',
      'git commit -m "Merge"',
    ]);
    expect(out).toMatch(/CONFLICT \(content\): Merge conflict in fees.txt/);
    expect(out).toMatch(/<<<<<<< HEAD\nTuition: 2550\n=======\nTuition: 2600\n>>>>>>> board\nHostel: 900/);
    expect(out).toMatch(/both modified: {3}fees.txt/);
    expect(out).toMatch(/Committing is not possible because you have unmerged files/);
    runLines(sys, ["printf 'Tuition: 2600\\nHostel: 900\\nLibrary: 50\\n' > fees.txt", 'git add fees.txt', 'git commit -m "Merge board rate"']);
    const st = repoState(sys);
    const head = st.commits[headCommit(st)!];
    expect(head.parents).toHaveLength(2);
    expect(head.tree['fees.txt']).toBe('Tuition: 2600\nHostel: 900\nLibrary: 50\n');
    expect(st.merging).toBeUndefined();
    expect(runLines(sys, ['git status'])).toMatch(/nothing to commit, working tree clean/);
  });

  it('merges changes to separate lines without a conflict', () => {
    const sys = gitBox();
    runLines(sys, [...IDENTITY, 'cd shop', 'git init', 'git add .', 'git commit -m "Add fees"', 'git switch -c lib', "sed -i 's/Library: 50/Library: 60/' fees.txt", 'git commit -am "Library"', 'git switch main', "sed -i 's/Tuition: 2500/Tuition: 2600/' fees.txt", 'git commit -am "Tuition"', 'git merge lib']);
    const st = repoState(sys);
    expect(st.commits[headCommit(st)!].tree['fees.txt']).toBe('Tuition: 2600\nHostel: 900\nLibrary: 60\n');
    expect(st.commits[headCommit(st)!].parents).toHaveLength(2);
  });

  it('refuses to switch away from changes that the other branch would overwrite', () => {
    const sys = gitBox();
    const out = runLines(sys, [...IDENTITY, 'cd shop', 'git init', 'git add .', 'git commit -m "Add fees"', 'git switch -c lib', "sed -i 's/Library: 50/Library: 60/' fees.txt", 'git commit -am "Library"', 'git switch main', "sed -i 's/Library: 50/Library: 55/' fees.txt", 'git switch lib']);
    expect(out).toMatch(/would be overwritten by checkout/);
  });
});

const dockerBox = (inGroup = true) =>
  buildSystem({
    hostname: 'node1',
    user: 'kofi',
    users: { kofi: {} },
    groups: inGroup ? { docker: ['kofi'] } : {},
    packages: { docker: { installed: true } },
    services: { docker: { active: true, enabled: true } },
    files: {
      '/home/kofi/site/index.html': '<h1>Ho Technical Market</h1>\n',
      '/home/kofi/site/about.html': '<p>Open daily</p>\n',
      '/home/kofi/Dockerfile': 'FROM nginx:1.27-alpine\nCOPY site/ /usr/share/nginx/html/\nEXPOSE 80\n',
    },
  });

describe('docker', () => {
  it('needs the docker group or sudo', () => {
    expect(runLines(dockerBox(false), ['docker ps'])).toMatch(/permission denied while trying to connect to the Docker daemon/);
  });

  it('publishes a port that curl can reach, and refuses a second container on it', () => {
    const sys = dockerBox();
    const out = runLines(sys, ['docker run -d --name web -p 8080:80 nginx:1.27-alpine', 'curl -s http://localhost:8080/', 'docker run -d --name web2 -p 8080:80 nginx:1.27-alpine', 'docker ps']);
    expect(out).toMatch(/Welcome to nginx!/);
    expect(out).toMatch(/port is already allocated/);
    expect(out).toMatch(/0\.0\.0\.0:8080->80\/tcp\s+web/);
    expect(loadDocker(makeCtx(sys)).containers.map((c) => c.name)).toEqual(['web']);
  });

  it('builds an image from a Dockerfile and serves its files', () => {
    const sys = dockerBox();
    const out = runLines(sys, ['docker build -t market:1.0 .', 'docker run -d --name market -p 8081:80 market:1.0', 'curl -s localhost:8081/', 'curl -s localhost:8081/about.html']);
    expect(out).toMatch(/naming to docker.io\/library\/market:1.0 done/);
    expect(out).toMatch(/Ho Technical Market/);
    expect(out).toMatch(/Open daily/);
    const img = loadDocker(makeCtx(sys)).images.find((i) => i.repo === 'market')!;
    expect(img).toMatchObject({ base: 'nginx:1.27-alpine', layers: 9, expose: [80] });
    expect(img.files['/usr/share/nginx/html/index.html']).toContain('Ho Technical Market');
  });

  it('serves a bind mount live from the host', () => {
    const sys = dockerBox();
    runLines(sys, ['docker run -d --name live -p 9000:80 -v /home/kofi/site:/usr/share/nginx/html nginx:1.27-alpine']);
    expect(runLines(sys, ['curl -s localhost:9000/'])).toMatch(/Ho Technical Market/);
    runLines(sys, ["echo '<h1>Closed for Easter</h1>' > site/index.html"]);
    expect(runLines(sys, ['curl -s localhost:9000/'])).toMatch(/Closed for Easter/);
    expect(runLines(sys, ['docker stop live', 'curl -s localhost:9000/'])).toMatch(/Connection refused/);
  });
});

describe('interactive here documents', () => {
  it('knows when the closing delimiter is still to come', async () => {
    const { awaitsHeredoc } = await import('./index.js');
    expect(awaitsHeredoc("cat > Dockerfile <<'EOF'")).toBe(true);
    expect(awaitsHeredoc("cat > Dockerfile <<'EOF'\nFROM nginx:1.27-alpine")).toBe(true);
    expect(awaitsHeredoc("cat > Dockerfile <<'EOF'\nFROM nginx:1.27-alpine\nEOF")).toBe(false);
    expect(awaitsHeredoc('cat <<-END\n\tx\n\tEND')).toBe(false);
    expect(awaitsHeredoc('grep x <<< "text"')).toBe(false);
  });
});

describe('sed change command', () => {
  it('replaces a whole address range with one copy of the text, as GNU sed does', () => {
    const sys = gitBox();
    const out = runLines(sys, ["printf 'a\\n<<<<<<< HEAD\\nx\\n=======\\ny\\n>>>>>>> b\\nz\\n' > /home/ama/m.txt", "sed -i '/^<<<<<<< /,/^>>>>>>> /c merged' /home/ama/m.txt", 'cat /home/ama/m.txt']);
    expect(out).toMatch(/^a\nmerged\nz\n$/m);
    expect(out.match(/merged/g)).toHaveLength(1);
  });
});
