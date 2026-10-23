/**
 * Checks for terminal labs, under the "sh.*" namespace. They inspect the simulated machine
 * after the learner has worked on it, or run a command on it as root and look at the output.
 *
 *   sh.file     { path, exists?: true|false, kind?: 'file'|'dir'|'link', contains?: string|string[], pattern?: regex,
 *                 notContains?, mode?: "640", owner?, group?, minLines?, acl?: "u:kofi:rw-" }
 *   sh.output   { command, contains?: string|string[], pattern?, equals?, notContains?, status?: number }
 *   sh.ran      { pattern, message? }            some command typed by the learner matches the regex
 *   sh.user     { name, exists?: true|false, groups?: [...], shell?, home?, locked?: boolean, sudo?: boolean }
 *   sh.group    { name, exists?: true|false, members?: [...] }
 *   sh.service  { name, active?: boolean, enabled?: boolean }
 *   sh.package  { name, installed?: boolean }
 *   sh.cron     { user, pattern }
 *   sh.process  { name, running: boolean }
 *   sh.script   { path, args?: [...], stdin?, contains?/pattern?/equals?, status?, creates?: path }
 *   sh.git      { repo, branch?, branches?: [...], minCommits?, headMessage?: regex, clean?, merged?: branch, mergeCommit?, fileAtHead?: { path, contains?, notContains?, pattern? } }
 *   sh.docker   { container, exists?, running?, image?, ports?: ["8080:80"], env?: ["K=V"], mountTarget?, restart? }
 *   sh.dockerImage { image, exists?, base?: regex, notRoot?, expose?: [n], maxSizeMb?, hasFile?: path }
 *   win.ou      { dn, exists? }
 *   win.user    { sam | sams: [...], exists?, enabled?, ou?: DN, department?, groups?: [...], hasPassword? }
 *   win.group   { name, exists?, scope?, members?: [...], memberOf?: [...] }
 *   win.share   { name, path?, access?: [{ account, right }], noEveryoneFull? }
 *   win.ps      { script, machine?, equals? | contains? | notContains? | pattern? | equalsIgnoreCase? }   a read-only PowerShell query
 *   win.access  { path: "\\\\FS01\\Share" or "D:\\x", user, equals: "Modify" | "ReadAndExecute" | ... | "None", machine? }
 *   win.policy  { key?: "HKCU\\...|ValueName", setting?: "User:Drive map", user?, computer, equals }
 */

import { effectiveAccess, effectiveExtra, effectivePolicy, loadAd, loadEstate, makeEnv, psQuery } from './powershell.js';
import { ancestors, findRepo, headCommit, loadGit } from './commands-git.js';
import { loadDocker } from './commands-docker.js';
import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { lookup, modeString, type FsNode } from './fs.js';
import { buildSystem, groupName, isSudoer, type ShellSystem, type SystemSpec } from './system.js';
import { makeCtx, newSession, probe, runScript } from './shell.js';

export interface ShellState {
  /** The machine as JSON (a ShellSystem), or the spec it should be built from. */
  system: ShellSystem;
  /** Commands the learner typed. */
  history: string[];
}

export function isSystem(x: unknown): x is ShellSystem {
  return !!x && typeof x === 'object' && 'fs' in (x as object) && 'users' in (x as object);
}

export function systemFromInitial(initial: unknown): ShellSystem {
  const spec = (initial as { system?: unknown })?.system;
  if (isSystem(spec)) return JSON.parse(JSON.stringify(spec)) as ShellSystem;
  return buildSystem(spec as SystemSpec);
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

const ROOT = { user: 'root', groups: ['root'] };

function node(sys: ShellSystem, path: string): FsNode | null {
  try {
    return lookup(sys.fs, path, ROOT)?.node ?? null;
  } catch {
    return null;
  }
}

function textChecks(spec: CheckSpec, text: string, what: string): string | null {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);
  for (const c of list(spec.contains)) if (!text.includes(c)) return `${what} should contain "${c}".`;
  for (const c of list(spec.notContains)) if (text.includes(c)) return `${what} should not contain "${c}".`;
  if (spec.pattern !== undefined && !new RegExp(String(spec.pattern), 'm').test(text)) return String(spec.patternMessage ?? `${what} does not match what was asked for.`);
  if (spec.equals !== undefined && text.trim() !== String(spec.equals).trim()) return `${what} should be exactly "${String(spec.equals)}", but is "${text.trim().slice(0, 80)}".`;
  if (spec.minLines !== undefined && text.split('\n').filter((l) => l.trim()).length < Number(spec.minLines)) return `${what} should have at least ${String(spec.minLines)} lines.`;
  return null;
}

export function createShellChecks(): CheckRegistry<ShellState> {
  return new CheckRegistry<ShellState>()
    .register('win.ps', async (state, spec) => {
      const out = psQuery(state.system, String(spec.script), spec.machine ? String(spec.machine) : undefined);
      if (out.startsWith('ERROR:') && !spec.allowError) return fail(spec, String(spec.message ?? `The check could not run: ${out.slice(7)}`));
      if (spec.equalsIgnoreCase !== undefined && out.toLowerCase() !== String(spec.equalsIgnoreCase).toLowerCase()) return fail(spec, String(spec.message ?? `Expected "${String(spec.equalsIgnoreCase)}" but found "${out.slice(0, 120)}".`));
      const problem = textChecks(spec, out, `The result of "${String(spec.script).slice(0, 80)}"`);
      return problem ? fail(spec, String(spec.message ?? problem)) : pass(spec, String(spec.success ?? 'As required.'));
    })
    .register('win.access', async (state, spec) => {
      const env = makeEnv(state.system, {});
      if (spec.machine) env.est.current = String(spec.machine);
      const got = effectiveAccess(env, String(spec.path), String(spec.user));
      return got === spec.equals ? pass(spec, String(spec.success ?? `${String(spec.user)} has ${got} access to ${String(spec.path)}.`)) : fail(spec, String(spec.message ?? `${String(spec.user)} has ${got} access to ${String(spec.path)}; it should be ${String(spec.equals)}.`));
    })
    .register('win.policy', async (state, spec) => {
      const env = makeEnv(state.system, {});
      const got = spec.setting ? effectiveExtra(env, String(spec.setting), spec.user ? String(spec.user) : undefined, String(spec.computer)) : effectivePolicy(env, String(spec.key), spec.user ? String(spec.user) : undefined, String(spec.computer));
      const want = spec.equals === null ? undefined : spec.equals;
      const same = want === undefined ? got === undefined : got !== undefined && String(got).toLowerCase() === String(want).toLowerCase();
      const who = spec.user ? `${String(spec.user)} on ${String(spec.computer)}` : String(spec.computer);
      return same ? pass(spec, String(spec.success ?? 'The policy applies as required.')) : fail(spec, String(spec.message ?? `For ${who} the winning value is ${got === undefined ? 'not set' : String(got)}; it should be ${want === undefined ? 'not set' : String(want)}.`));
    })
    .register('win.ou', async (state, spec) => {
      const st = loadAd(state.system);
      const ou = st.ous.find((o) => o.dn.toLowerCase() === String(spec.dn).toLowerCase());
      if (spec.exists === false) return ou ? fail(spec, `${String(spec.dn)} should not exist.`) : pass(spec, `${String(spec.dn)} is gone.`);
      return ou ? pass(spec, String(spec.success ?? `${ou.dn} exists.`)) : fail(spec, String(spec.message ?? `There is no OU ${String(spec.dn)}. Create it with New-ADOrganizationalUnit.`));
    })
    .register('win.user', async (state, spec) => {
      const st = loadAd(state.system);
      const sams = (spec.sams as string[] | undefined) ?? [String(spec.sam)];
      for (const sam of sams) {
        const u = st.users.find((x) => x.sam.toLowerCase() === sam.toLowerCase());
        if (spec.exists === false) {
          if (u) return fail(spec, `The account ${sam} should be removed.`);
          continue;
        }
        if (!u) return fail(spec, String(spec.message ?? `There is no user with SamAccountName ${sam}.`));
        if (spec.enabled !== undefined && u.enabled !== spec.enabled) return fail(spec, `${sam} is ${u.enabled ? 'enabled' : 'disabled'}; it should be ${spec.enabled ? 'enabled' : 'disabled'}.`);
        if (spec.hasPassword && !u.hasPassword) return fail(spec, `${sam} has no password set.`);
        if (spec.ou && !u.dn.toLowerCase().endsWith(',' + String(spec.ou).toLowerCase())) return fail(spec, `${sam} is in ${u.dn.slice(u.dn.indexOf(',') + 1)}; it should be in ${String(spec.ou)}.`);
        if (spec.department !== undefined && (u.department ?? '') !== spec.department) return fail(spec, `${sam}'s department is "${u.department ?? ''}"; it should be "${String(spec.department)}".`);
        for (const gname of (spec.groups as string[] | undefined) ?? []) {
          const g = st.groups.find((x) => x.name.toLowerCase() === gname.toLowerCase());
          if (!g || !g.members.includes(u.dn)) return fail(spec, `${sam} is not a member of ${gname}.`);
        }
      }
      return pass(spec, String(spec.success ?? (sams.length > 1 ? `All ${sams.length} accounts are set up as required.` : `${sams[0]} is set up as required.`)));
    })
    .register('win.group', async (state, spec) => {
      const st = loadAd(state.system);
      const g = st.groups.find((x) => x.name.toLowerCase() === String(spec.name).toLowerCase());
      if (spec.exists === false) return g ? fail(spec, `The group ${String(spec.name)} should be removed.`) : pass(spec, `${String(spec.name)} is gone.`);
      if (!g) return fail(spec, String(spec.message ?? `There is no group called ${String(spec.name)}. Create it with New-ADGroup.`));
      if (spec.scope && g.scope !== spec.scope) return fail(spec, `${g.name} has scope ${g.scope}; it should be ${String(spec.scope)}.`);
      for (const m of (spec.members as string[] | undefined) ?? []) {
        const obj = st.users.find((u) => u.sam.toLowerCase() === m.toLowerCase()) ?? st.groups.find((x) => x.name.toLowerCase() === m.toLowerCase());
        if (!obj || !g.members.includes(obj.dn)) return fail(spec, `${m} is not a direct member of ${g.name}.`);
      }
      for (const parent of (spec.memberOf as string[] | undefined) ?? []) {
        const p = st.groups.find((x) => x.name.toLowerCase() === parent.toLowerCase());
        if (!p || !p.members.includes(g.dn)) return fail(spec, `${g.name} is not a member of ${parent}.`);
      }
      return pass(spec, String(spec.success ?? `The group ${g.name} is set up as required.`));
    })
    .register('win.share', async (state, spec) => {
      const st = loadAd(state.system);
      const est = loadEstate(state.system);
      const s = st.shares.find((x) => x.name.toLowerCase() === String(spec.name).toLowerCase()) ?? est.machines.flatMap((m) => m.shares).find((x) => x.name.toLowerCase() === String(spec.name).toLowerCase());
      if (!s) return fail(spec, String(spec.message ?? `There is no share called ${String(spec.name)}. Create it with New-SmbShare.`));
      if (spec.path && s.path.toLowerCase() !== String(spec.path).toLowerCase()) return fail(spec, `${s.name} shares ${s.path}; it should share ${String(spec.path)}.`);
      for (const a of (spec.access as Array<{ account: string; right: string }> | undefined) ?? []) {
        if (!s.access.some((x) => x.account.toLowerCase() === a.account.toLowerCase() && x.right === a.right)) return fail(spec, `${s.name} does not give ${a.account} ${a.right} access.`);
      }
      if (spec.noEveryoneFull && s.access.some((x) => /everyone/i.test(x.account) && x.right !== 'Read')) return fail(spec, `${s.name} gives Everyone more than Read access.`);
      return pass(spec, String(spec.success ?? `The share ${s.name} is set up as required.`));
    })
    .register('sh.git', async (state, spec) => {
      const ctx = makeCtx(state.system);
      const repo = findRepo(ctx, String(spec.repo));
      if (!repo || repo !== String(spec.repo)) return fail(spec, String(spec.message ?? `${String(spec.repo)} is not a git repository yet. Run git init there.`));
      const st = loadGit(ctx, repo);
      const head = headCommit(st);
      if (spec.branch && st.head.branch !== spec.branch) return fail(spec, `The current branch is ${st.head.branch ?? 'a detached HEAD'}; it should be ${String(spec.branch)}.`);
      for (const b of (spec.branches as string[] | undefined) ?? []) if (st.branches[b] === undefined) return fail(spec, `There is no branch called ${b}.`);
      const count = ancestors(st, head).size;
      if (spec.minCommits !== undefined && count < Number(spec.minCommits)) return fail(spec, `The current branch has ${count} commit${count === 1 ? '' : 's'}; at least ${String(spec.minCommits)} were expected.`);
      if (spec.headMessage && !(head && new RegExp(String(spec.headMessage), 'i').test(st.commits[head].message))) return fail(spec, String(spec.message ?? 'The latest commit message is not what was asked for.'));
      if (spec.merged) {
        const b = st.branches[String(spec.merged)];
        if (!b || !ancestors(st, head).has(b)) return fail(spec, `${String(spec.merged)} has not been merged into ${st.head.branch}.`);
      }
      if (spec.mergeCommit && !(head && st.commits[head].parents.length === 2)) return fail(spec, String(spec.message ?? 'The latest commit is not a merge commit with two parents.'));
      if (st.merging) return fail(spec, 'A merge is still in progress. Resolve the conflict, git add the file and git commit.');
      if (spec.clean) {
        const tree = head ? st.commits[head].tree : {};
        const wt: Record<string, string> = {};
        const base = repo === '/' ? '' : repo;
        const visit = (p: string, rel: string) => {
          const n = node(state.system, p);
          if (!n) return;
          if (n.type === 'dir') for (const name of Object.keys(n.children)) { if (!rel && name === '.git') continue; visit(`${p}/${name}`, rel ? `${rel}/${name}` : name); }
          else if (n.type === 'file') wt[rel] = n.content;
        };
        visit(base, '');
        const dirty = [...new Set([...Object.keys(tree), ...Object.keys(wt), ...Object.keys(st.index)])].filter((p) => tree[p] !== wt[p] || tree[p] !== st.index[p]);
        if (dirty.length) return fail(spec, `The working tree is not clean: ${dirty.slice(0, 4).join(', ')} differ from the last commit. Commit or restore them.`);
      }
      const fh = spec.fileAtHead as { path: string; contains?: string; notContains?: string; pattern?: string } | undefined;
      if (fh) {
        const content = head ? st.commits[head].tree[fh.path] : undefined;
        if (content === undefined) return fail(spec, `${fh.path} is not in the latest commit.`);
        if (fh.contains && !content.includes(fh.contains)) return fail(spec, String(spec.message ?? `${fh.path} in the latest commit should contain "${fh.contains}".`));
        if (fh.notContains && content.includes(fh.notContains)) return fail(spec, String(spec.message ?? `${fh.path} in the latest commit still contains "${fh.notContains}".`));
        if (fh.pattern && !new RegExp(fh.pattern).test(content)) return fail(spec, String(spec.message ?? `${fh.path} in the latest commit is not what was asked for.`));
      }
      return pass(spec, String(spec.success ?? 'The repository is as required.'));
    })
    .register('sh.docker', async (state, spec) => {
      const st = loadDocker(makeCtx(state.system));
      const c = st.containers.find((k) => k.name === spec.container);
      if (spec.exists === false) return c ? fail(spec, `The container ${String(spec.container)} should be removed.`) : pass(spec, `${String(spec.container)} is gone.`);
      if (!c) return fail(spec, String(spec.message ?? `There is no container called ${String(spec.container)}. Use docker run --name ${String(spec.container)}.`));
      if (spec.running !== undefined && (c.status === 'running') !== spec.running) return fail(spec, `${c.name} is ${c.status === 'running' ? 'running' : 'stopped'}; it should be ${spec.running ? 'running' : 'stopped'}.`);
      if (spec.image && c.image !== String(spec.image)) return fail(spec, `${c.name} runs ${c.image}; it should run ${String(spec.image)}.`);
      for (const p of (spec.ports as string[] | undefined) ?? []) {
        const [h, k] = p.split(':').map(Number);
        if (!c.ports.some((q) => q.host === h && q.container === k)) return fail(spec, `${c.name} does not publish host port ${h} to container port ${k}. Use -p ${p}.`);
      }
      for (const e of (spec.env as string[] | undefined) ?? []) {
        const [k, ...v] = e.split('=');
        if (c.env[k] !== v.join('=')) return fail(spec, `${c.name} does not have ${k}=${v.join('=')} in its environment. Use -e.`);
      }
      if (spec.mountTarget && !c.mounts.some((m) => m.target === spec.mountTarget)) return fail(spec, `${c.name} has nothing mounted at ${String(spec.mountTarget)}. Use -v SOURCE:${String(spec.mountTarget)}.`);
      if (spec.restart && c.restart !== spec.restart) return fail(spec, `${c.name} has restart policy "${c.restart}"; it should be "${String(spec.restart)}". Use --restart ${String(spec.restart)}.`);
      return pass(spec, String(spec.success ?? `The container ${c.name} is set up as required.`));
    })
    .register('sh.dockerImage', async (state, spec) => {
      const st = loadDocker(makeCtx(state.system));
      const ref = String(spec.image).includes(':') ? String(spec.image) : `${String(spec.image)}:latest`;
      const img = st.images.find((i) => `${i.repo}:${i.tag}` === ref);
      if (spec.exists === false) return img ? fail(spec, `The image ${ref} should be removed.`) : pass(spec, `${ref} is gone.`);
      if (!img) return fail(spec, String(spec.message ?? `There is no image called ${ref}. Build it with docker build -t ${ref} .`));
      if (spec.base && !new RegExp(String(spec.base)).test(img.base)) return fail(spec, String(spec.message ?? `${ref} is built FROM ${img.base}, which is not the base asked for.`));
      if (spec.notRoot && (img.user === 'root' || img.user === '0' || img.user === '')) return fail(spec, `${ref} runs as root. Add a USER instruction with an unprivileged user.`);
      for (const p of (spec.expose as number[] | undefined) ?? []) if (!img.expose.includes(p)) return fail(spec, `${ref} does not EXPOSE ${p}.`);
      if (spec.maxSizeMb !== undefined && img.sizeMb > Number(spec.maxSizeMb)) return fail(spec, `${ref} is ${img.sizeMb} MB; the target is at most ${String(spec.maxSizeMb)} MB. Try a slimmer base image.`);
      if (spec.hasFile && img.files[String(spec.hasFile)] === undefined) return fail(spec, `${ref} has no file at ${String(spec.hasFile)}. Check the COPY destination.`);
      return pass(spec, String(spec.success ?? `The image ${ref} is as required.`));
    })
    .register('sh.file', async (state, spec) => {
      const path = String(spec.path);
      const n = node(state.system, path);
      if (spec.exists === false) return n ? fail(spec, String(spec.message ?? `${path} should not exist.`)) : pass(spec, `${path} is gone.`);
      if (!n) return fail(spec, String(spec.message ?? `${path} does not exist yet.`));
      if (spec.kind && n.type !== spec.kind) return fail(spec, `${path} should be a ${String(spec.kind) === 'dir' ? 'directory' : String(spec.kind)}.`);
      if (spec.mode !== undefined) {
        const want = parseInt(String(spec.mode), 8);
        if ((n.mode & 0o7777) !== want) return fail(spec, `${path} has mode ${(n.mode & 0o7777).toString(8).padStart(3, '0')} (${modeString(n).slice(1, 10)}); it should be ${String(spec.mode)}.`);
      }
      if (spec.owner && n.owner !== spec.owner) return fail(spec, `${path} is owned by ${n.owner}; it should be owned by ${String(spec.owner)}.`);
      if (spec.group && n.group !== spec.group) return fail(spec, `${path} belongs to group ${n.group}; it should be ${String(spec.group)}.`);
      if (spec.acl) {
        const [kind, name, perms] = String(spec.acl).split(':');
        const entry = n.acl?.find((a) => a.kind === (kind.startsWith('u') ? 'user' : 'group') && a.name === name);
        if (!entry) return fail(spec, `${path} has no ACL entry for ${kind}:${name}. Use setfacl -m.`);
        if (perms && entry.perms !== perms) return fail(spec, `The ACL entry for ${name} on ${path} is ${entry.perms}; it should be ${perms}.`);
      }
      if (n.type === 'file') {
        const problem = textChecks(spec, n.content, path);
        if (problem) return fail(spec, String(spec.message ?? problem));
      }
      return pass(spec, String(spec.success ?? `${path} is as required.`));
    })

    .register('sh.output', async (state, spec) => {
      const sys = JSON.parse(JSON.stringify(state.system)) as ShellSystem;
      const r = probe(sys, String(spec.command));
      if (spec.status !== undefined && r.status !== Number(spec.status)) return fail(spec, String(spec.message ?? `"${String(spec.command)}" exited with status ${r.status}, expected ${String(spec.status)}.`), r.output);
      const problem = textChecks(spec, r.output, `The output of "${String(spec.command)}"`);
      if (problem) return fail(spec, String(spec.message ?? problem), r.output);
      return pass(spec, String(spec.success ?? `"${String(spec.command)}" gives the expected result.`));
    })

    .register('sh.ran', async (state, spec) => {
      const re = new RegExp(String(spec.pattern));
      return state.history.some((h) => re.test(h)) ? pass(spec, String(spec.success ?? 'You used the right command.')) : fail(spec, String(spec.message ?? 'The expected command has not been run yet.'));
    })

    .register('sh.user', async (state, spec) => {
      const name = String(spec.name);
      const u = state.system.users[name];
      if (spec.exists === false) return u ? fail(spec, String(spec.message ?? `User ${name} should be removed.`)) : pass(spec, `User ${name} is gone.`);
      if (!u) return fail(spec, String(spec.message ?? `There is no user called ${name}. Create one with useradd.`));
      const groups = [groupName(state.system, u.gid), ...u.groups];
      for (const g of (spec.groups as string[] | undefined) ?? []) if (!groups.includes(g)) return fail(spec, `${name} is not in group ${g} (groups: ${[...new Set(groups)].join(', ')}).`);
      if (spec.shell && u.shell !== spec.shell) return fail(spec, `${name}'s shell is ${u.shell}; it should be ${String(spec.shell)}.`);
      if (spec.home && u.home !== spec.home) return fail(spec, `${name}'s home is ${u.home}; it should be ${String(spec.home)}.`);
      if (spec.homeExists && !node(state.system, u.home)) return fail(spec, `${name}'s home directory ${u.home} does not exist. useradd needs -m to create it.`);
      if (spec.locked !== undefined && (u.password === 'locked') !== spec.locked) return fail(spec, spec.locked ? `${name}'s account is not locked.` : `${name}'s account is still locked.`);
      if (spec.hasPassword && u.password !== 'set') return fail(spec, `${name} has no password yet. Set one with passwd ${name}.`);
      if (spec.sudo !== undefined && isSudoer(state.system, name) !== spec.sudo) return fail(spec, spec.sudo ? `${name} cannot use sudo. Add them to the wheel group.` : `${name} should not be able to use sudo.`);
      return pass(spec, String(spec.success ?? `User ${name} is set up correctly.`));
    })

    .register('sh.group', async (state, spec) => {
      const name = String(spec.name);
      const g = state.system.groups[name];
      if (spec.exists === false) return g ? fail(spec, `Group ${name} should be removed.`) : pass(spec, `Group ${name} is gone.`);
      if (!g) return fail(spec, String(spec.message ?? `There is no group called ${name}. Create it with groupadd.`));
      const members = new Set(g.members);
      for (const [un, u] of Object.entries(state.system.users)) if (u.gid === g.gid || u.groups.includes(name)) members.add(un);
      for (const m of (spec.members as string[] | undefined) ?? []) if (!members.has(m)) return fail(spec, `${m} is not a member of ${name}.`);
      return pass(spec, String(spec.success ?? `Group ${name} has the right members.`));
    })

    .register('sh.service', async (state, spec) => {
      const name = String(spec.name);
      const s = state.system.services[name];
      if (!s) return fail(spec, String(spec.message ?? `There is no service called ${name}. Is its package installed?`));
      if (spec.active !== undefined && s.active !== spec.active) return fail(spec, spec.active ? String(spec.message ?? `${name} is not running. Check systemctl status ${name} and the logs.`) : `${name} should be stopped.`);
      if (spec.enabled !== undefined && s.enabled !== spec.enabled) return fail(spec, spec.enabled ? `${name} is not enabled, so it would not start at boot.` : `${name} should be disabled.`);
      return pass(spec, String(spec.success ?? `${name} is ${s.active ? 'running' : 'stopped'}${spec.enabled !== undefined ? (s.enabled ? ' and enabled' : ' and disabled') : ''}.`));
    })

    .register('sh.package', async (state, spec) => {
      const name = String(spec.name);
      const p = state.system.packages[name];
      const want = spec.installed !== false;
      if ((p?.installed ?? false) !== want) return fail(spec, want ? String(spec.message ?? `The package ${name} is not installed.`) : `The package ${name} should be removed.`);
      return pass(spec, want ? `${name} is installed.` : `${name} is removed.`);
    })

    .register('sh.cron', async (state, spec) => {
      const user = String(spec.user);
      const tab = state.system.crontabs[user] ?? '';
      const re = new RegExp(String(spec.pattern), 'm');
      if (!tab.trim()) return fail(spec, String(spec.message ?? `${user} has no crontab yet. Use crontab -e.`));
      return re.test(tab) ? pass(spec, String(spec.success ?? `${user}'s crontab has the right entry.`)) : fail(spec, String(spec.message ?? `${user}'s crontab does not have the entry asked for. Check the five time fields.`), tab);
    })

    .register('sh.process', async (state, spec) => {
      const name = String(spec.name);
      const running = state.system.processes.some((p) => p.cmd.includes(name));
      const want = spec.running !== false;
      return running === want ? pass(spec, want ? `${name} is running.` : `${name} is no longer running.`) : fail(spec, want ? `${name} is not running.` : String(spec.message ?? `${name} is still running. Find its PID with ps and kill it.`));
    })

    .register('sh.script', async (state, spec) => {
      const sys = JSON.parse(JSON.stringify(state.system)) as ShellSystem;
      const path = String(spec.path);
      const n = node(sys, path);
      if (!n) return fail(spec, `${path} does not exist yet.`);
      if (n.type !== 'file') return fail(spec, `${path} is not a file.`);
      if (!n.content.startsWith('#!')) return fail(spec, `${path} should start with a shebang line such as #!/bin/bash.`);
      if (spec.executable !== false && !(n.mode & 0o100)) return fail(spec, `${path} is not executable: chmod +x ${path}.`);
      const ctx = makeCtx(sys, newSession(sys));
      ctx.euser = String(spec.as ?? 'root');
      const buf: string[] = [];
      const code = runScript(ctx, n.content, ((spec.args as string[] | undefined) ?? []).map(String), path, { stdin: String(spec.stdin ?? ''), out: (s) => buf.push(s), err: (s) => buf.push(s) });
      const output = buf.join('');
      if (spec.status !== undefined && code !== Number(spec.status)) return fail(spec, String(spec.message ?? `${path} exited with status ${code}; expected ${String(spec.status)}.`), output);
      const problem = textChecks(spec, output, `The output of ${path}`);
      if (problem) return fail(spec, String(spec.message ?? problem), output);
      if (spec.creates) {
        for (const c of Array.isArray(spec.creates) ? (spec.creates as string[]) : [String(spec.creates)]) {
          const created = node(sys, c) ?? (c.includes('*') ? findGlob(sys, c) : null);
          if (!created) return fail(spec, `Running ${path} should create ${c}, but it did not.`, output);
        }
      }
      return pass(spec, String(spec.success ?? `${path} runs and does what was asked.`));
    });
}

function findGlob(sys: ShellSystem, pattern: string): FsNode | null {
  const dir = pattern.slice(0, pattern.lastIndexOf('/')) || '/';
  const d = node(sys, dir);
  if (!d || d.type !== 'dir') return null;
  const re = new RegExp('^' + pattern.slice(pattern.lastIndexOf('/') + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const name = Object.keys(d.children).find((k) => re.test(k));
  return name ? d.children[name] : null;
}
