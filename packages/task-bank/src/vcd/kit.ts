/** Shared builders for Version Control and DevOps: a developer's Linux machine, seeded git history and the lab forge. */

import type { SystemSpec } from '@cslab/engine-shell/src/system';
import { seedRepo, type GitState, type SeedCommit, type SeedOptions } from '@cslab/engine-shell/src/git-state';
import { FORGE_HOST, forgeFiles, forgeRepoPath, simPublicKey, simToken, type ForgeSeed, type Role } from '@cslab/engine-shell/src/forge-seed';
import type { CheckSpec } from '@cslab/lab-runtime';
import type { Person, Variant } from '../types';
import { templateMaker } from '../common';
import { baseImage, type DockerContainer, type DockerImage, type DockerState } from '@cslab/engine-shell/src/docker-engine';
import { registryPackage } from '@cslab/engine-shell/src/docker-registry';
import { clusterFiles } from '@cslab/engine-shell/src/commands-k8s';

export { caseStudy, lab, mdSafe } from '../common';
export type { Person, Variant } from '../types';
export { file, out, ran, re, script, svc, pkg, cron } from '../sa2/kit';
export { blobId, commitId, treeId } from '@cslab/engine-shell/src/git-state';
export { FORGE_HOST, forgeRepoPath, simPublicKey, simToken };

export const COURSE = 'version-control-and-devops';
export const tmpl = templateMaker(COURSE, 'vcd');

/** Small organisations whose code the labs work on. */
export const ORGS = [
  { org: 'schoolfees', project: 'fees-portal', what: 'school fees portal' },
  { org: 'healthline', project: 'clinic-booking', what: 'clinic appointment system' },
  { org: 'agrolink', project: 'market-prices', what: 'market price tracker' },
  { org: 'paywise', project: 'momo-recon', what: 'mobile money reconciliation tool' },
  { org: 'citybus', project: 'bus-tickets', what: 'bus ticketing service' },
  { org: 'farmcast', project: 'farm-alerts', what: 'farm weather alert service' },
];
export type Org = (typeof ORGS)[number];

export const email = (p: Person, org: Org | string) => `${p.sam}@${typeof org === 'string' ? org : org.org}.org`;

/** A commit by a person, for seedRepo. */
export function C(message: string, by: Person, org: Org | string, files: Record<string, string | null>, day?: number, hour?: number): SeedCommit {
  return { message, author: by.name, email: email(by, org), files, ...(day !== undefined ? { day } : {}), ...(hour !== undefined ? { hour } : {}) };
}

type FileOut = string | { content: string; mode?: string; owner?: string; group?: string };

/** Gives every file to a user (labs run as that user, not root). */
export function owned(files: Record<string, string | { content: string; mode?: string }>, user: string): Record<string, FileOut> {
  const out: Record<string, FileOut> = {};
  for (const [p, f] of Object.entries(files)) out[p] = typeof f === 'string' ? { content: f, owner: user, group: user } : { ...f, owner: user, group: user };
  return out;
}

/** A bare repository (a shared "server" copy) owned by a user, directories included so pushes can write. */
export function bare(user: string, path: string, commits: SeedCommit[], tags: Record<string, number> = {}, opts: SeedOptions = {}): Record<string, FileOut> {
  const files = owned(seedRepo(path, commits, tags, { ...opts, bare: true }), user);
  for (const d of ['', 'objects', 'refs', 'refs/heads', 'hooks']) files[d ? `${path}/${d}/` : `${path}/`] = { content: '', owner: user, group: user };
  return files;
}

/** A repository in the user's home with this history. */
export function repo(user: string, path: string, commits: SeedCommit[], tags: Record<string, number> = {}, opts: SeedOptions = {}): Record<string, FileOut> {
  return owned(seedRepo(path, commits, tags, opts), user);
}

export const gitconfig = (p: Person, org: Org | string, extra = '') => `[user]\n\tname = ${p.name}\n\temail = ${email(p, org)}\n[init]\n\tdefaultBranch = main\n${extra}`;

export interface DevOpts {
  /** The learner. */
  me: Person;
  org?: Org | string;
  /** Write ~/.gitconfig with the learner's identity (default true). */
  identity?: boolean;
  files?: Record<string, FileOut>;
  /** Extra installed packages (git is installed unless noGit). */
  packages?: string[];
  noGit?: boolean;
  users?: Record<string, { groups?: string[] }>;
  groups?: Record<string, string[]>;
  services?: SystemSpec['services'];
  hostname?: string;
  cwd?: string;
  /** Learner may use sudo (default true). */
  sudo?: boolean;
}

/** A developer's Linux machine, logged in as the learner. */
export function dev(o: DevOpts): { system: SystemSpec } {
  const login = o.me.sam;
  const home = `/home/${login}`;
  const files: Record<string, FileOut> = { ...(o.files ?? {}) };
  if (o.identity !== false && !files[`${home}/.gitconfig`]) files[`${home}/.gitconfig`] = { content: gitconfig(o.me, o.org ?? 'devteam'), owner: login, group: login };
  const packages: Record<string, { installed: boolean }> = {};
  if (!o.noGit) packages.git = { installed: true };
  for (const p of o.packages ?? []) packages[p] = { installed: true };
  return {
    system: {
      hostname: o.hostname ?? 'laptop',
      user: login,
      cwd: o.cwd ?? home,
      users: { [login]: { comment: o.me.name, groups: o.sudo === false ? [] : ['wheel'] }, ...(o.users ?? {}) },
      groups: o.groups,
      packages,
      services: o.services,
      files: files as SystemSpec['files'],
    },
  };
}

/** A machine with the lab forge: the learner plus teammates, each with an SSH key and a gh login. */
export function withForge(o: DevOpts & { seed: ForgeSeed; access?: Record<string, Role | 'none'> }): { system: SystemSpec } {
  // The learner works for the organisation: admin on its repositories unless the lab says otherwise.
  for (const [full, r] of Object.entries(o.seed.repos ?? {})) {
    const role = o.access?.[full] ?? (r.forkOf || full.startsWith(o.me.sam + '/') ? undefined : 'admin');
    if (role && role !== 'none' && !r.members?.[o.me.sam]) r.members = { ...(r.members ?? {}), [o.me.sam]: role };
  }
  const base = dev({ ...o, packages: [...new Set(['gh', ...(o.packages ?? [])])] });
  const users: Record<string, { groups?: string[] }> = { ...(base.system.users as Record<string, { groups?: string[] }>) };
  for (const [login, u] of Object.entries(o.seed.users)) if (u.local !== false && !users[login]) users[login] = {};
  // The lab's own files go last: they may change a clone the forge seed made (uncommitted work).
  return { system: { ...base.system, users, files: { ...(forgeFiles(o.seed) as Record<string, FileOut>), ...(base.system.files as Record<string, FileOut>) } as SystemSpec['files'] } };
}

/** A forge seed user entry for a person. */
export const fuser = (p: Person, org: Org | string, extra: Partial<ForgeSeed['users'][string]> = {}) => ({ name: p.name, email: email(p, org), ...extra });

/* ----------------------------------------------------------------------------- checks */

export const forge = (label: string, repo: string, spec: Record<string, unknown>): CheckSpec => ({ type: 'sh.forge', label, repo, ...spec });
export const git = (label: string, repo: string, spec: Record<string, unknown>): CheckSpec => ({ type: 'sh.git', label, repo, ...spec });

/** Shell line that writes a file from a literal here-document. */
export const write = (path: string, body: string) => `cat > ${path} <<'EOF'\n${body.endsWith('\n') ? body : body + '\n'}EOF`;

/** A deterministic pick of k distinct items. */
export function pickN<T>(v: Variant, list: readonly T[], k: number): T[] {
  return v.some([...list], k);
}

export const SH = (body: string) => `#!/bin/bash\n${body}`;
export const HOST = FORGE_HOST;
export const ssh = (full: string) => `git@${FORGE_HOST}:${full}.git`;
export const https = (full: string) => `https://${FORGE_HOST}/${full}.git`;

/** Reads, changes and writes back the saved state of a seeded repository (for reflogs, deleted branches and the like). */
export function mutate(files: Record<string, FileOut>, path: string, fn: (st: GitState) => void): GitState {
  const key = `${path}/.git/state.json`;
  const f = files[key];
  const st = JSON.parse(typeof f === 'string' ? f : f.content) as GitState;
  fn(st);
  files[key] = typeof f === 'string' ? JSON.stringify(st) : { ...f, content: JSON.stringify(st) };
  return st;
}

/** A bare repository shared by a group: set-group-ID directories and group-writable files, as `git init --shared=group` makes. */
export function sharedBare(owner: string, group: string, path: string, commits: SeedCommit[], tags: Record<string, number> = {}): Record<string, FileOut> {
  const files: Record<string, FileOut> = {};
  for (const [p, f] of Object.entries(seedRepo(path, commits, tags, { bare: true }))) files[p] = { content: typeof f === 'string' ? f : f.content, owner, group, mode: '664' };
  for (const d of ['', 'objects', 'refs', 'refs/heads', 'refs/tags', 'hooks']) files[d ? `${path}/${d}/` : `${path}/`] = { content: '', owner, group, mode: '2775' };
  return files;
}

/* ----------------------------------------------------------------------------- containers */

/** An image built on an official base, as a Dockerfile would leave it. */
export function image(ref: string, base: string, o: { files?: Record<string, string | { content: string; mode?: string; owner?: string }>; cmd?: string; entrypoint?: string; user?: string; users?: DockerImage['users']; env?: Record<string, string>; expose?: number[]; workdir?: string; memMb?: number; pkgs?: string[]; labels?: Record<string, string>; health?: DockerImage['health']; addMb?: number } = {}): DockerImage {
  const b = baseImage(base, Date.UTC(2026, 9, 1));
  if (!b) throw new Error(`no catalogue image ${base}`);
  const [repo, tag] = ref.includes(':') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [ref, 'latest'];
  const files: Record<string, string> = {};
  const modes: Record<string, string> = {};
  const owners: Record<string, string> = {};
  for (const [p, f] of Object.entries(o.files ?? {})) {
    files[p] = typeof f === 'string' ? f : f.content;
    if (typeof f !== 'string' && f.mode) modes[p] = f.mode;
    if (typeof f !== 'string' && f.owner) owners[p] = f.owner.includes(':') ? f.owner : `${f.owner}:${f.owner}`;
  }
  const added = Object.values(files).reduce((a, c) => a + c.length, 0) / 1e6;
  const img: DockerImage = {
    ...b,
    repo,
    tag,
    id: hexId(ref + JSON.stringify(files) + (o.cmd ?? '')),
    files,
    modes,
    ...(Object.keys(owners).length ? { owners } : {}),
    cmd: o.cmd ?? b.cmd,
    ...(o.entrypoint !== undefined ? { entrypoint: o.entrypoint } : {}),
    user: o.user ?? b.user,
    ...(o.users ? { users: o.users } : {}),
    env: { ...b.env, ...(o.env ?? {}) },
    expose: o.expose ?? b.expose,
    workdir: o.workdir ?? b.workdir,
    ...(o.memMb ? { memMb: o.memMb } : {}),
    ...(o.pkgs ? { pkgs: o.pkgs } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    ...(o.health ? { health: o.health } : {}),
    sizeMb: Math.round((b.sizeMb + added + (o.addMb ?? 0)) * 100) / 100,
    layers: b.layers + Object.keys(files).length,
    history: [{ by: `COPY . ${o.workdir ?? '/'}`, sizeMb: added }],
  };
  delete img.repoDigests;
  return img;
}

function hexId(seed: string): string {
  let h = 2166136261;
  let out = '';
  for (let r = 0; out.length < 12; r++) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) ^ r;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 12);
}

export interface DockerSeed {
  /** Official images already pulled. */
  pulled?: string[];
  images?: DockerImage[];
  containers?: DockerContainer[];
  networks?: string[];
  volumes?: string[];
}

/** /var/lib/docker/state.json for a lab. */
export function dockerStateFile(s: DockerSeed): Record<string, FileOut> {
  const images = [...(s.pulled ?? []).map((r) => baseImage(r, Date.UTC(2026, 9, 1))!), ...(s.images ?? [])];
  const st: DockerState = { images, containers: s.containers ?? [], volumes: s.volumes ?? [], networks: ['bridge', 'host', 'none', ...(s.networks ?? [])] };
  return { '/var/lib/docker/state.json': { content: JSON.stringify(st), owner: 'root', group: 'root', mode: '600' } };
}

/** What a machine needs to run Docker for the learner: the package, the service, the docker group. */
export function dockerBits(me: Person, seed: DockerSeed = {}, extraPackages: string[] = []): Pick<DevOpts, 'packages' | 'services' | 'groups' | 'files'> {
  return {
    packages: ['docker', ...extraPackages],
    services: { docker: { active: true, enabled: true, package: 'docker' } as never },
    groups: { docker: [me.sam] },
    files: dockerStateFile(seed),
  };
}

/** A developer machine with Docker. */
export function dockerDev(o: DevOpts & { docker?: DockerSeed }): { system: SystemSpec } {
  const bits = dockerBits(o.me, o.docker ?? {}, o.packages ?? []);
  return dev({ ...o, packages: bits.packages, services: { ...(bits.services ?? {}), ...(o.services ?? {}) }, groups: { ...(o.groups ?? {}), ...bits.groups }, files: { ...bits.files, ...(o.files ?? {}) } });
}

/** A container record as docker run leaves it (for labs that start with containers in place). */
export function container(name: string, img: DockerImage, o: Partial<DockerContainer> = {}): DockerContainer {
  return { id: hexId('c' + name) + hexId('d' + name) + hexId('e' + name) + hexId('f' + name) + hexId('g' + name).slice(0, 16), name, image: `${img.repo}:${img.tag}`, status: 'running', exitCode: 0, ports: [], env: {}, mounts: [], restart: 'no', network: 'bridge', logs: [], created: Date.UTC(2026, 9, 20, 8, 0), started: Date.UTC(2026, 9, 20, 8, 0), ...o };
}

export { registryPackage, clusterFiles };
export type { DockerImage, DockerContainer };

export const dock = (label: string, name: string, spec: Record<string, unknown>): CheckSpec => ({ type: 'sh.docker', label, container: name, ...spec });
export const dimg = (label: string, ref: string, spec: Record<string, unknown>): CheckSpec => ({ type: 'sh.dockerImage', label, image: ref, ...spec });
export const pkgCheck = (label: string, name: string, spec: Record<string, unknown>): CheckSpec => ({ type: 'sh.forge', label, package: { name, ...spec } });
/** kubectl as the learner (checks run as root, whose kubeconfig is empty). */
export const kc = (me: Person, cmd: string) => `KUBECONFIG=/home/${me.sam}/.kube/config kubectl ${cmd}`;
