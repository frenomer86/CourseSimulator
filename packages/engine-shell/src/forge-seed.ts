/**
 * The lab forge's data model (a GitHub-like service on host git.lab) and a builder for a lab's
 * starting files: the forge database, bare repositories, and each user's gh login and SSH keys.
 * A leaf module (it imports only git-state), so lab templates can import it.
 */

import { seedRepo, type SeedCommit, type SeedOptions } from './git-state.js';

export const FORGE_HOST = 'git.lab';
export const FORGE_DIR = '/srv/forge';
export const FORGE_DB = `${FORGE_DIR}/forge.json`;
/** A CI runner's system -> the host Ctx whose forge it belongs to (set by ci.ts). */
export const FORGE_HOSTS = new WeakMap<object, unknown>();
export const forgeRepoPath = (full: string) => `${FORGE_DIR}/repos/${full}.git`;

export type Role = 'read' | 'triage' | 'write' | 'maintain' | 'admin';

export interface ForgeToken {
  token: string;
  name?: string;
  scopes: string[];
}

export interface ForgeUser {
  name: string;
  email: string;
  keys: string[];
  tokens: ForgeToken[];
}

export interface Protection {
  required_pull_request_reviews?: { required_approving_review_count: number; dismiss_stale_reviews?: boolean; require_code_owner_reviews?: boolean } | null;
  required_status_checks?: { strict?: boolean; contexts: string[] } | null;
  enforce_admins?: boolean;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
  required_linear_history?: boolean;
}

export interface ForgeEnvironment {
  id: number;
  reviewers?: string[];
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
  prevent_self_review?: boolean;
}

export interface ForgeRepo {
  owner: string;
  name: string;
  visibility: 'public' | 'private' | 'internal';
  members: Record<string, Role>;
  description?: string;
  defaultBranch: string;
  protection: Record<string, Protection>;
  secrets: Record<string, string>;
  variables: Record<string, string>;
  environments: Record<string, ForgeEnvironment>;
  forkOf?: string;
  disabledWorkflows?: string[];
  allowAutoMerge?: boolean;
  deleteBranchOnMerge?: boolean;
  allowMergeCommit?: boolean;
  allowSquashMerge?: boolean;
  allowRebaseMerge?: boolean;
  pushProtection?: boolean;
  labels?: string[];
  /** Pages: published from a branch (and folder), or by a workflow's deploy-pages step. */
  pages?: { branch?: string; path?: string; buildType?: 'legacy' | 'workflow' };

}

export interface ForgeReview {
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  body: string;
  commit: string;
  at: number;
}

export interface ForgeComment {
  user: string;
  body: string;
  at: number;
}

export interface ForgePr {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  head: string;
  /** The repository the head branch lives in (a fork, or the same repository). */
  headRepo: string;
  base: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft?: boolean;
  reviews: ForgeReview[];
  comments: ForgeComment[];
  labels: string[];
  reviewers: string[];
  assignees: string[];
  createdAt: number;
  mergedAt?: number;
  mergedBy?: string;
  mergeCommit?: string;
  autoMerge?: 'merge' | 'squash' | 'rebase';
}

export interface ForgeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  comments: ForgeComment[];
  createdAt: number;
  closedBy?: string;
  stateReason?: string;
}

export interface ForgeRelease {
  repo: string;
  tag: string;
  name: string;
  notes: string;
  author: string;
  draft: boolean;
  prerelease: boolean;
  assets: Record<string, string>;
  createdAt: number;
  target: string;
}

export interface ForgeDb {
  host: string;
  users: Record<string, ForgeUser>;
  repos: Record<string, ForgeRepo>;
  prs: ForgePr[];
  issues: ForgeIssue[];
  /** Workflow runs (see ci.ts CiRun). */
  runs: unknown[];
  releases: ForgeRelease[];
  /** Next issue/PR number per repository. */
  counters: Record<string, number>;
  runCounter: number;
  /** actions/cache entries per repository. */
  cache: Record<string, Record<string, Record<string, string>>>;
  /** Container images pushed to the forge registry: "owner/name:tag" -> image JSON. */
  registry?: Record<string, unknown>;
  envCounter?: number;
}

/** The key text `ssh-keygen` writes for a user in this simulator. */
export function simPublicKey(user: string, host = 'pc', type = 'ed25519'): string {
  return `ssh-${type} AAAAC3NzaC1lZDI1NTE5AAAAIG${user.padEnd(10, 'x').slice(0, 10)}Q2VzbGFiU2ltdWxhdG9yS2V5 ${user}@${host}`;
}
export function simPrivateKey(user: string, type = 'ed25519'): string {
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n(simulated ${type} private key for ${user})\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A deterministic personal access token for a lab user. */
export function simToken(user: string, kind = 'ghp'): string {
  let h = 2166136261;
  for (const c of user + kind) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 36; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    s += alphabet[(h >>> 0) % alphabet.length];
  }
  return `${kind}_${s}`;
}

export interface SeedUser {
  name: string;
  email: string;
  /** Has a personal access token (default true), with these scopes (default repo, workflow, read:org). */
  token?: boolean;
  scopes?: string[];
  /** Has an SSH key pair in ~/.ssh registered on the forge (default true). */
  sshKey?: boolean;
  /** Logged in to gh (default true), using this git protocol. */
  ghLogin?: boolean;
  protocol?: 'ssh' | 'https';
  /** Also a Linux user on the machine (default true). */
  local?: boolean;
  /** Write ~/.gitconfig with the name and e-mail (default true). */
  gitIdentity?: boolean;
}

export interface SeedRepo {
  visibility?: ForgeRepo['visibility'];
  members?: Record<string, Role>;
  description?: string;
  defaultBranch?: string;
  commits?: SeedCommit[];
  tags?: Record<string, number>;
  seed?: SeedOptions;
  protection?: Record<string, Protection>;
  secrets?: Record<string, string>;
  variables?: Record<string, string>;
  environments?: Record<string, Omit<ForgeEnvironment, 'id'>>;
  forkOf?: string;
  pushProtection?: boolean;
  allowAutoMerge?: boolean;
  deleteBranchOnMerge?: boolean;
  allowMergeCommit?: boolean;
  pages?: ForgeRepo['pages'];
  /** Clone it for these users into their home directories (name -> directory, default ~/<repo>). */
  clones?: Record<string, string>;
}

export interface ForgeSeed {
  users: Record<string, SeedUser>;
  repos?: Record<string, SeedRepo>;
  prs?: Array<Partial<ForgePr> & { repo: string; title: string; author: string; head: string; base?: string }>;
  issues?: Array<Partial<ForgeIssue> & { repo: string; title: string; author: string }>;
  releases?: Array<Partial<ForgeRelease> & { repo: string; tag: string }>;
  /** Container images already in the registry: "owner/name" -> package (see docker-registry.ts registryPackage). */
  packages?: Record<string, unknown>;
}

type FileOut = string | { content: string; mode?: string; owner?: string; group?: string };

/** Files for a lab's starting state with the forge and its users set up. */
export function forgeFiles(seed: ForgeSeed): Record<string, FileOut> {
  const files: Record<string, FileOut> = {};
  const db: ForgeDb = { host: FORGE_HOST, users: {}, repos: {}, prs: [], issues: [], runs: [], releases: [], counters: {}, runCounter: 100, cache: {}, envCounter: 1 };
  for (const [login, u] of Object.entries(seed.users)) {
    const token = u.token === false ? [] : [{ token: simToken(login), name: 'lab', scopes: u.scopes ?? ['repo', 'workflow', 'read:org'] }];
    const keys = u.sshKey === false ? [] : [simPublicKey(login)];
    db.users[login] = { name: u.name, email: u.email, keys, tokens: token };
    if (u.local === false) continue;
    const home = `/home/${login}`;
    const own = { owner: login, group: login };
    if (u.sshKey !== false) {
      files[`${home}/.ssh/id_ed25519`] = { content: simPrivateKey(login), mode: '600', ...own };
      files[`${home}/.ssh/id_ed25519.pub`] = { content: simPublicKey(login) + '\n', mode: '644', ...own };
      files[`${home}/.ssh/known_hosts`] = { content: `${FORGE_HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIForgeHostKeyOfTheLab\n`, mode: '644', ...own };
    }
    if (u.ghLogin !== false && u.token !== false) {
      files[`${home}/.config/gh/hosts.yml`] = { content: `${FORGE_HOST}:\n    users:\n        ${login}:\n            oauth_token: ${simToken(login)}\n    git_protocol: ${u.protocol ?? 'ssh'}\n    oauth_token: ${simToken(login)}\n    user: ${login}\n`, mode: '600', ...own };
    }
    if (u.gitIdentity !== false) files[`${home}/.gitconfig`] = { content: `[user]\n\tname = ${u.name}\n\temail = ${u.email}\n[init]\n\tdefaultBranch = main\n`, ...own };
  }
  for (const [full, rs] of Object.entries(seed.repos ?? {})) {
    const [owner, name] = full.split('/');
    let envId = db.envCounter ?? 1;
    db.repos[full] = {
      owner,
      name,
      visibility: rs.visibility ?? 'private',
      members: { [owner]: 'admin', ...(rs.members ?? {}) },
      description: rs.description,
      defaultBranch: rs.defaultBranch ?? 'main',
      protection: rs.protection ?? {},
      secrets: rs.secrets ?? {},
      variables: rs.variables ?? {},
      environments: Object.fromEntries(Object.entries(rs.environments ?? {}).map(([k, e]) => [k, { id: envId++, ...e }])),
      forkOf: rs.forkOf,
      pushProtection: rs.pushProtection,
      allowAutoMerge: rs.allowAutoMerge,
      deleteBranchOnMerge: rs.deleteBranchOnMerge,
      allowMergeCommit: rs.allowMergeCommit,
      pages: rs.pages,
      labels: ['bug', 'documentation', 'enhancement', 'good first issue', 'question'],
    };
    db.envCounter = envId;
    db.counters[full] = 1;
    if (rs.commits?.length) {
      const bare = seedRepo(forgeRepoPath(full), rs.commits, rs.tags ?? {}, { ...(rs.seed ?? {}), bare: true, defaultBranch: rs.defaultBranch ?? 'main' });
      for (const [p, c] of Object.entries(bare)) files[p] = typeof c === 'string' ? { content: c, mode: '644', owner: 'root', group: 'root' } : { ...c, owner: 'root', group: 'root' };
      for (const [login, dir] of Object.entries(rs.clones ?? {})) {
        const proto = seed.users[login]?.protocol ?? 'ssh';
        const url = proto === 'ssh' ? `git@${FORGE_HOST}:${full}.git` : `https://${FORGE_HOST}/${full}.git`;
        const clone = seedRepo(dir || `/home/${login}/${name}`, rs.commits, rs.tags ?? {}, { ...(rs.seed ?? {}), origin: url, defaultBranch: rs.defaultBranch ?? 'main' });
        for (const [p, c] of Object.entries(clone)) files[p] = typeof c === 'string' ? { content: c, owner: login, group: login } : { ...c, owner: login, group: login };
      }
    } else {
      // An empty repository, as the forge creates it.
      files[`${forgeRepoPath(full)}/objects/state.json`] = { content: JSON.stringify({ head: { branch: rs.defaultBranch ?? 'main' }, branches: {}, commits: {}, index: {}, config: {}, tags: {}, bare: true }), owner: 'root', group: 'root' };
      files[`${forgeRepoPath(full)}/HEAD`] = { content: `ref: refs/heads/${rs.defaultBranch ?? 'main'}\n`, owner: 'root', group: 'root' };
    }
  }
  for (const p of seed.prs ?? []) {
    const n = db.counters[p.repo] ?? 1;
    db.counters[p.repo] = n + 1;
    db.prs.push({ number: n, body: '', base: db.repos[p.repo]?.defaultBranch ?? 'main', headRepo: p.repo, state: 'OPEN', reviews: [], comments: [], labels: [], reviewers: [], assignees: [], createdAt: Date.UTC(2026, 9, 21, 15, 0), ...p });
  }
  for (const i of seed.issues ?? []) {
    const n = db.counters[i.repo] ?? 1;
    db.counters[i.repo] = n + 1;
    db.issues.push({ number: n, body: '', state: 'OPEN', labels: [], assignees: [], comments: [], createdAt: Date.UTC(2026, 9, 20, 9, 0), ...i });
  }
  for (const r of seed.releases ?? []) db.releases.push({ name: r.tag, notes: '', author: db.repos[r.repo]?.owner ?? '', draft: false, prerelease: false, assets: {}, createdAt: Date.UTC(2026, 9, 15, 12, 0), target: 'main', ...r });
  if (seed.packages) (db as ForgeDb & { packages?: Record<string, unknown> }).packages = structuredClone(seed.packages);
  files[FORGE_DB] = { content: JSON.stringify(db), mode: '600', owner: 'root', group: 'root' };
  return files;
}
