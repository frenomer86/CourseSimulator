/**
 * Image registries: Docker Hub's official images come from the catalogue; git.lab runs a container
 * registry (like ghcr.io) inside the lab forge, with docker login by personal access token,
 * write:packages / read:packages scopes, and package visibility.
 */

import { lookup, mkdir, readFile, writeFile } from './fs.js';
import { FORGE_DB, FORGE_HOST, FORGE_HOSTS, type ForgeDb } from './forge-seed.js';
import { actor, currentUser, type Ctx } from './shell.js';
import { homeOf } from './system.js';
import type { IO } from './util.js';
import { CATALOGUE, findImage, hex, imageDigest, imageFromCatalogue, parseRef, type DockerImage, type DockerState } from './docker-engine.js';

const ROOT = { user: 'root', groups: ['root'] };
/** A file that makes this machine offline: no registry, no package mirror. */
export const OFFLINE = '/etc/cslab/offline';


export interface RegistryPackage {
  owner: string;
  name: string;
  visibility: 'private' | 'public';
  /** tag → digest */
  tags: Record<string, string>;
  /** digest → image */
  manifests: Record<string, DockerImage>;
  /** The repository the package is linked to, if any. */
  repo?: string;
  updated: number;
}

/** The machine holding the forge: this one, or the host a CI runner belongs to. */
function forgeCtx(ctx: Ctx): Ctx {
  return (FORGE_HOSTS.get(ctx.sys) as Ctx | undefined) ?? ctx;
}

function loadForge(ctx: Ctx): ForgeDb | null {
  const f = forgeCtx(ctx);
  try {
    return JSON.parse(readFile(f.sys.fs, FORGE_DB, ROOT)) as ForgeDb;
  } catch {
    return null;
  }
}

function saveForge(ctx: Ctx, db: ForgeDb): void {
  const f = forgeCtx(ctx);
  writeFile(f.sys.fs, FORGE_DB, JSON.stringify(db), ROOT, f.sys.now);
}

export function packagesOf(db: ForgeDb): Record<string, RegistryPackage> {
  return ((db as ForgeDb & { packages?: Record<string, RegistryPackage> }).packages ??= {});
}

/* ----------------------------------------------------------------------------- credentials */

const configPath = (ctx: Ctx) => `${homeOf(ctx.sys, currentUser(ctx))}/.docker/config.json`;

function readConfig(ctx: Ctx): { auths: Record<string, { auth: string }> } {
  try {
    const j = JSON.parse(readFile(ctx.sys.fs, configPath(ctx), actor(ctx)));
    return { ...j, auths: j.auths ?? {} };
  } catch {
    return { auths: {} };
  }
}

function writeConfig(ctx: Ctx, cfg: { auths: Record<string, { auth: string }> }): void {
  const p = configPath(ctx);
  const dir = p.slice(0, p.lastIndexOf('/'));
  mkdir(ctx.sys.fs, dir, actor(ctx), ctx.sys.now, true);
  writeFile(ctx.sys.fs, p, JSON.stringify(cfg, null, '\t') + '\n', actor(ctx), ctx.sys.now);
  const l = lookup(ctx.sys.fs, p, actor(ctx));
  if (l) l.node.mode = 0o600;
}

const b64 = (s: string) => btoa(s);
const unb64 = (s: string) => {
  try {
    return atob(s);
  } catch {
    return '';
  }
};

interface Who {
  login: string;
  scopes: string[];
  /** A CI job token: limited to the run's repository owner. */
  job?: { owner: string; write: boolean };
}

/** Who the stored credentials for a registry belong to. */
function credentials(ctx: Ctx, db: ForgeDb, registry: string): Who | null {
  const auth = readConfig(ctx).auths[registry]?.auth;
  if (!auth) return null;
  const [login, ...rest] = unb64(auth).split(':');
  return checkToken(ctx, db, login, rest.join(':'));
}

function checkToken(ctx: Ctx, db: ForgeDb, login: string, token: string): Who | null {
  const job = (FORGE_HOSTS.get(ctx.sys) as Ctx | undefined) ? jobToken(ctx, token) : null;
  if (job) return { login, scopes: job.write ? ['write:packages', 'read:packages'] : ['read:packages'], job };
  for (const [name, u] of Object.entries(db.users)) {
    const t = u.tokens.find((x) => x.token === token);
    if (t) return name === login || !login ? { login: name, scopes: t.scopes } : null;
  }
  return null;
}

/** CI runs register their job tokens here: token → owner and whether packages: write was granted. */
export const JOB_TOKENS = new Map<string, { owner: string; write: boolean }>();
function jobToken(_ctx: Ctx, token: string): { owner: string; write: boolean } | null {
  return JOB_TOKENS.get(token) ?? null;
}

const hasScope = (w: Who, s: string) => w.scopes.includes(s) || (s === 'read:packages' && w.scopes.includes('write:packages')) || w.scopes.includes('repo') && s === 'read:packages';

function canWrite(db: ForgeDb, w: Who, owner: string, name: string): boolean {
  if (w.job) return w.job.write && w.job.owner === owner;
  if (owner === w.login) return true;
  const repo = db.repos[`${owner}/${name}`];
  const rank = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 } as const;
  if (repo && repo.members[w.login] && rank[repo.members[w.login]] >= 3) return true;
  // Organisation members with write on any of its repositories may publish new packages there.
  return Object.values(db.repos).some((r) => r.owner === owner && r.members[w.login] && rank[r.members[w.login]] >= 3);
}

function canRead(db: ForgeDb, w: Who | null, pkg: RegistryPackage): boolean {
  if (pkg.visibility === 'public') return true;
  if (!w) return false;
  if (w.job) return w.job.owner === pkg.owner;
  if (pkg.owner === w.login) return true;
  return Object.values(db.repos).some((r) => r.owner === pkg.owner && r.members[w.login]);
}

/* ----------------------------------------------------------------------------- docker login / logout */

export function dockerLogin(ctx: Ctx, args: string[], io: IO): number {
  let user: string | undefined;
  let pass: string | undefined;
  let stdin = false;
  let server: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u' || a === '--username') user = args[++i];
    else if (a.startsWith('--username=')) user = a.slice(11);
    else if (a === '-p' || a === '--password') pass = args[++i];
    else if (a.startsWith('--password=')) pass = a.slice(11);
    else if (a === '--password-stdin') stdin = true;
    else if (!a.startsWith('-')) server = a;
  }
  const registry = server ?? 'docker.io';
  if (pass !== undefined) io.err('WARNING! Using --password via the CLI is insecure. Use --password-stdin.\n');
  if (stdin) pass = io.stdin.replace(/\r?\n$/, '');
  if (!user || pass === undefined) {
    io.err(`Error: Cannot perform an interactive login from a non TTY device\n(Give the user name with -u and the token on standard input with --password-stdin.)\n`);
    return 1;
  }
  if (registry !== FORGE_HOST) {
    io.err(`Error response from daemon: Get "https://${registry === 'docker.io' ? 'registry-1.docker.io' : registry}/v2/": dial tcp: lookup ${registry === 'docker.io' ? 'registry-1.docker.io' : registry}: no such host\n(This lab's private registry is ${FORGE_HOST}.)\n`);
    return 1;
  }
  const db = loadForge(ctx);
  if (!db) {
    io.err(`Error response from daemon: Get "https://${registry}/v2/": dial tcp: lookup ${registry}: no such host\n`);
    return 1;
  }
  const who = checkToken(ctx, db, user, pass);
  if (!who) {
    io.err(`Error response from daemon: Get "https://${registry}/v2/": denied: denied\n`);
    return 1;
  }
  const cfg = readConfig(ctx);
  cfg.auths[registry] = { auth: b64(`${user}:${pass}`) };
  writeConfig(ctx, cfg);
  io.out(`WARNING! Your password will be stored unencrypted in ${configPath(ctx)}.\nConfigure a credential helper to remove this warning. See\nhttps://docs.docker.com/engine/reference/commandline/login/#credential-stores\n\nLogin Succeeded\n`);
  return 0;
}

export function dockerLogout(ctx: Ctx, args: string[], io: IO): number {
  const registry = args.find((a) => !a.startsWith('-')) ?? 'docker.io';
  const cfg = readConfig(ctx);
  if (!cfg.auths[registry]) {
    io.out(`Not logged in to ${registry}\n`);
    return 0;
  }
  delete cfg.auths[registry];
  writeConfig(ctx, cfg);
  io.out(`Removing login credentials for ${registry}\n`);
  return 0;
}

/* ----------------------------------------------------------------------------- pull and push */

/** Finds an image locally, else pulls it from the catalogue or git.lab. Returns null (with the error printed) when it cannot. */
export function pullImage(ctx: Ctx, st: DockerState, ref: string, io: IO, quiet = false): DockerImage | null {
  const existing = findImage(st, ref);
  if (existing) return existing;
  const r = parseRef(ref);
  // A machine without internet access (the lab marks it with /etc/cslab/offline) reaches no registry.
  if (lookup(forgeCtx(ctx).sys.fs, OFFLINE, ROOT) || lookup(ctx.sys.fs, OFFLINE, ROOT)) {
    const host = r.registry === 'docker.io' ? 'registry-1.docker.io' : r.registry;
    io.err(`Error response from daemon: Get "https://${host}/v2/": dial tcp: lookup ${host} on 127.0.0.53:53: no such host\n`);
    return null;
  }
  if (r.registry === 'docker.io') {
    const img = imageFromCatalogue(ctx, `${r.repo}:${r.tag}`);
    if (!img || (r.digest && !(img.repoDigests ?? []).some((d) => d.endsWith('@' + r.digest)))) {
      io.err(`Error response from daemon: pull access denied for ${r.repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied\n(This lab's mirror of Docker Hub has: ${Object.keys(CATALOGUE).join(', ')}.)\n`);
      return null;
    }
    if (!quiet) io.out(`${r.digest ? r.digest : r.tag}: Pulling from ${r.path}\n${Array.from({ length: img.layers }, (_, i) => `${hex(r.repo + r.tag + i)}: Pull complete\n`).join('')}Digest: ${img.repoDigests![0].split('@')[1]}\nStatus: Downloaded newer image for ${r.repo}:${r.tag}\ndocker.io/${r.path}:${r.tag}\n`);
    st.images.push(img);
    return img;
  }
  if (r.registry !== FORGE_HOST) {
    io.err(`Error response from daemon: Get "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host\n`);
    return null;
  }
  const db = loadForge(ctx);
  if (!db) {
    io.err(`Error response from daemon: Get "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host\n`);
    return null;
  }
  const [owner, ...nameParts] = r.path.split('/');
  const name = nameParts.join('/');
  const pkg = packagesOf(db)[`${owner}/${name}`];
  const who = credentials(ctx, db, r.registry);
  if (!pkg || !canRead(db, who, pkg)) {
    io.err(`Error response from daemon: ${who ? `manifest unknown` : `Head "https://${r.registry}/v2/${r.path}/manifests/${r.digest ?? r.tag}": unauthorized`}\n`);
    return null;
  }
  const digest = r.digest ?? pkg.tags[r.tag];
  const manifest = digest ? pkg.manifests[digest] : undefined;
  if (!manifest) {
    io.err(`Error response from daemon: manifest for ${r.repo}:${r.tag} not found: manifest unknown: manifest unknown\n`);
    return null;
  }
  const img: DockerImage = { ...structuredClone(manifest), repo: r.repo, tag: r.digest ? '<none>' : r.tag, repoDigests: [`${r.repo}@${digest}`], created: manifest.created };
  if (!quiet) io.out(`${r.digest ?? r.tag}: Pulling from ${r.path}\n${Array.from({ length: Math.min(img.layers, 6) }, (_, i) => `${hex(digest + i)}: Pull complete\n`).join('')}Digest: ${digest}\nStatus: Downloaded newer image for ${r.repo}${r.digest ? '@' + r.digest : ':' + r.tag}\n${r.repo}${r.digest ? '@' + r.digest : ':' + r.tag}\n`);
  // A tag pulled again replaces the local copy.
  st.images = st.images.filter((i) => !(i.repo === img.repo && i.tag === img.tag));
  st.images.push(img);
  return img;
}

export function pushImage(ctx: Ctx, st: DockerState, ref: string, io: IO, allTags = false): number {
  const r = parseRef(ref);
  const locals = allTags ? st.images.filter((i) => i.repo === r.repo) : [findImage(st, `${r.repo}:${r.tag}`)].filter((x): x is DockerImage => !!x);
  if (!locals.length) {
    io.err(`An image does not exist locally with the tag: ${r.repo}${allTags ? '' : ':' + r.tag}\n(Tag it first: docker tag SOURCE ${r.repo}:${r.tag})\n`);
    return 1;
  }
  if (r.registry === 'docker.io') {
    io.err(`The push refers to repository [docker.io/${r.path}]\ndenied: requested access to the resource is denied\n(Push to this lab's registry instead: ${FORGE_HOST}/OWNER/${r.repo.split('/').pop()}:${r.tag})\n`);
    return 1;
  }
  if (r.registry !== FORGE_HOST) {
    io.err(`The push refers to repository [${r.repo}]\nGet "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host\n`);
    return 1;
  }
  const db = loadForge(ctx);
  if (!db) {
    io.err(`Get "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host\n`);
    return 1;
  }
  const [owner, ...nameParts] = r.path.split('/');
  const name = nameParts.join('/');
  io.out(`The push refers to repository [${r.repo}]\n`);
  const who = credentials(ctx, db, r.registry);
  if (!who) {
    io.err('unauthorized: authentication required\n(Log in first: docker login git.lab -u USER --password-stdin)\n');
    return 1;
  }
  if (!hasScope(who, 'write:packages')) {
    io.err('denied: permission_denied: The token provided does not match expected scopes.\n(The token needs the write:packages scope.)\n');
    return 1;
  }
  if (!db.users[owner] && !Object.values(db.repos).some((x) => x.owner === owner)) {
    io.err(`denied: permission_denied: The requested installation does not exist.\n(There is no user or organisation called ${owner} on ${FORGE_HOST}.)\n`);
    return 1;
  }
  if (!canWrite(db, who, owner, name)) {
    io.err('denied: permission_denied: write_package\n');
    return 1;
  }
  const pkgs = packagesOf(db);
  const key = `${owner}/${name}`;
  const pkg = (pkgs[key] ??= { owner, name, visibility: 'private', tags: {}, manifests: {}, repo: db.repos[key] ? key : undefined, updated: ctx.sys.now });
  for (const img of locals) {
    const digest = imageDigest(img);
    const fresh = !pkg.manifests[digest];
    for (let i = 0; i < Math.min(img.layers, 5); i++) io.out(`${hex(img.id + i)}: ${fresh && i < 2 ? 'Pushed' : 'Layer already exists'}\n`);
    const { repoDigests: _d, ...clean } = img;
    void _d;
    pkg.manifests[digest] = { ...structuredClone(clean), repo: key, tag: img.tag };
    pkg.tags[img.tag] = digest;
    pkg.updated = ctx.sys.now;
    img.repoDigests = [...new Set([...(img.repoDigests ?? []).filter((d) => !d.startsWith(r.repo + '@')), `${r.repo}@${digest}`])];
    io.out(`${img.tag}: digest: ${digest} size: ${1200 + img.layers * 211}\n`);
  }
  saveForge(ctx, db);
  return 0;
}

/**
 * Resolves an image the way a cluster node pulls it: the Docker Hub mirror, or git.lab with the
 * credentials of the pod's imagePullSecrets. Returns the image, or the error the kubelet reports.
 */
export function resolveImage(ctx: Ctx, ref: string, creds: Array<{ server: string; user: string; pass: string }>): { img: DockerImage } | { error: string } {
  const r = parseRef(ref);
  const full = r.registry === 'docker.io' ? `docker.io/${r.path}:${r.tag}` : `${r.repo}:${r.tag}`;
  if (r.registry === 'docker.io') {
    const img = imageFromCatalogue(ctx, `${r.repo}:${r.tag}`);
    if (!img) return { error: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": ${full}: not found` };
    return { img };
  }
  const db = r.registry === FORGE_HOST ? loadForge(ctx) : null;
  if (!db) return { error: `failed to resolve reference "${full}": failed to do request: Head "https://${r.registry}/v2/${r.path}/manifests/${r.tag}": dial tcp: lookup ${r.registry}: no such host` };
  const [owner, ...nameParts] = r.path.split('/');
  const pkg = packagesOf(db)[`${owner}/${nameParts.join('/')}`];
  const cred = creds.find((c) => c.server === r.registry || c.server === `https://${r.registry}`);
  const who = cred ? checkToken(ctx, db, cred.user, cred.pass) : null;
  if (!pkg || !canRead(db, who, pkg)) return { error: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://${r.registry}/token?scope=repository%3A${r.path}%3Apull: 401 Unauthorized` };
  const digest = r.digest ?? pkg.tags[r.tag];
  const manifest = digest ? pkg.manifests[digest] : undefined;
  if (!manifest) return { error: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": ${full}: not found` };
  return { img: { ...structuredClone(manifest), repo: r.repo, tag: r.tag, repoDigests: [`${r.repo}@${digest}`] } };
}

/** A package for seeding a lab's registry: tag -> image. */
export function registryPackage(owner: string, name: string, tags: Record<string, DockerImage>, visibility: 'public' | 'private' = 'private', repo?: string): RegistryPackage {
  const pkg: RegistryPackage = { owner, name, visibility, tags: {}, manifests: {}, ...(repo ? { repo } : {}), updated: 0 };
  for (const [tag, img] of Object.entries(tags)) {
    const clean: DockerImage = { ...structuredClone(img), repo: `${owner}/${name}`, tag };
    delete clean.repoDigests;
    const digest = imageDigest(clean);
    pkg.manifests[digest] = clean;
    pkg.tags[tag] = digest;
  }
  return pkg;
}
