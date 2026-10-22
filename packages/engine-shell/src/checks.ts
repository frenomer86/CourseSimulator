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
 */

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
