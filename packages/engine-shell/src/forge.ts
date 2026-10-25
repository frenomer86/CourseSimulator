/**
 * The lab forge: a GitHub-like service on host git.lab inside the simulated machine. Repositories
 * are bare repositories under /srv/forge/repos; everything else (users, SSH keys, tokens, pull
 * requests, reviews, branch protection, secrets, workflow runs, releases) is in /srv/forge/forge.json.
 *
 * git reaches it through ssh (git@git.lab:owner/repo.git) or https URLs and is authenticated by the
 * user's SSH key or token. After a push, workflows in .github/workflows run (ci.ts). The `gh` command
 * here is the forge's command-line client.
 */

import { lookup, mkdir, readFile, writeFile } from './fs.js';
import { homeOf } from './system.js';
import { actor, currentUser, runCommand, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { compile, formatJ, runJq, type JqValue } from './jq.js';
import { parseYaml, yMap, yStr } from './yaml.js';
import { FORGE_DB, FORGE_DIR, FORGE_HOST, forgeRepoPath, simToken, type ForgeDb, type ForgePr, type ForgeRelease, type ForgeRepo, type ForgeUser, type Protection, type Role } from './forge-seed.js';
import type { GitState } from './git-state.js';
import { commitId } from './git-state.js';
import { ROOT, ancestors, configGet, findRepo, loadGit, mergeTrees, openRepo, readConfigFile, relative, saveRepo, short, subject, hunks, type Repo } from './git-core.js';
import { ADMIN_COMMANDS } from './commands-admin.js';
import { mark, readWorkflows, runLogText, runWorkflow, triggers, type CiInput, type CiRun } from './ci.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

export interface RefUpdate {
  ref: string;
  old: string | null;
  new: string | null;
  force: boolean;
}

/* ----------------------------------------------------------------------------- the database */

export function forgeExists(ctx: Ctx): boolean {
  return !!lookup(ctx.sys.fs, FORGE_DB, ROOT);
}

export function loadDb(ctx: Ctx): ForgeDb {
  return JSON.parse(readFile(ctx.sys.fs, FORGE_DB, ROOT)) as ForgeDb;
}

export function saveDb(ctx: Ctx, db: ForgeDb): void {
  writeFile(ctx.sys.fs, FORGE_DB, JSON.stringify(db), ROOT, ctx.sys.now);
}

const roleRank: Record<Role, number> = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
function roleOf(repo: ForgeRepo, user: string | null): number {
  if (!user) return repo.visibility === 'public' ? 1 : 0;
  const r = repo.members[user];
  if (r) return roleRank[r];
  return repo.visibility === 'private' ? 0 : 1;
}

/* ----------------------------------------------------------------------------- URLs and authentication */

interface ForgeUrl {
  host: string;
  full: string;
  proto: 'ssh' | 'https';
  user?: string;
  pass?: string;
}

export function parseForgeUrl(url: string): ForgeUrl | null {
  let m = /^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (m) return { host: m[1], full: m[2], proto: 'ssh' };
  m = /^https?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (m) return { host: m[3], full: m[4], proto: 'https', user: m[1], pass: m[2] };
  return null;
}

function publicKeysOf(ctx: Ctx): string[] {
  const home = homeOf(ctx.sys, currentUser(ctx));
  const out: string[] = [];
  const files = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  try {
    const cfg = readFile(ctx.sys.fs, `${home}/.ssh/config`, actor(ctx));
    for (const m of cfg.matchAll(/^\s*IdentityFile\s+(\S+)/gim)) files.unshift(m[1].replace(/^~\/\.ssh\//, '').replace(/^~/, home));
  } catch {
    /* no config */
  }
  for (const f of files) {
    const priv = f.startsWith('/') ? f : `${home}/.ssh/${f}`;
    try {
      readFile(ctx.sys.fs, priv, actor(ctx));
      const pub = readFile(ctx.sys.fs, priv + '.pub', actor(ctx)).trim();
      out.push(pub);
    } catch {
      /* missing */
    }
  }
  return out;
}

const keyId = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ');

export function userForToken(db: ForgeDb, token: string | undefined): { login: string; scopes: string[] } | null {
  if (!token) return null;
  for (const [login, u] of Object.entries(db.users)) {
    const t = u.tokens.find((x) => x.token === token);
    if (t) return { login, scopes: t.scopes };
  }
  return null;
}

/** The gh login of the current Linux user: GH_TOKEN, or ~/.config/gh/hosts.yml. */
export function ghLogin(ctx: Ctx): { token: string; protocol: 'ssh' | 'https' } | null {
  const env = (n: string) => (ctx.exported.has(n) ? ctx.vars[n] : ctx.sys.env[n]);
  const t = env('GH_TOKEN') ?? env('GITHUB_TOKEN');
  if (t) return { token: t, protocol: 'https' };
  try {
    const doc = yMap(parseYaml(readFile(ctx.sys.fs, `${homeOf(ctx.sys, currentUser(ctx))}/.config/gh/hosts.yml`, actor(ctx))));
    const h = yMap(doc[FORGE_HOST]);
    const token = yStr(h.oauth_token);
    if (!token) return null;
    return { token, protocol: yStr(h.git_protocol) === 'https' ? 'https' : 'ssh' };
  } catch {
    return null;
  }
}

function httpsCredential(ctx: Ctx, u: ForgeUrl): string | undefined {
  if (u.pass) return u.pass;
  const helper = configGet(ctx, null, `credential.https://${u.host}.helper`) ?? configGet(ctx, null, 'credential.helper');
  if (helper && /gh auth git-credential/.test(helper)) return ghLogin(ctx)?.token;
  if (helper === 'store' || helper?.startsWith('store')) {
    const file = /--file[= ](\S+)/.exec(helper)?.[1] ?? `${homeOf(ctx.sys, currentUser(ctx))}/.git-credentials`;
    try {
      for (const line of readFile(ctx.sys.fs, file.replace(/^~/, homeOf(ctx.sys, currentUser(ctx))), actor(ctx)).split('\n')) {
        const m = /^https?:\/\/([^:@]+):([^@]+)@([^/\s]+)/.exec(line.trim());
        if (m && m[3] === u.host) return decodeURIComponent(m[2]);
      }
    } catch {
      /* no store */
    }
  }
  return undefined;
}

/** Called by git for every remote URL: null when it is not a forge URL. */
export function forgeResolve(ctx: Ctx, url: string, intent: 'fetch' | 'push'): { path: string; user: string | null; scopes?: string[] | null } | { error: string } | null {
  const u = parseForgeUrl(url);
  if (!u || !forgeExists(ctx)) return null;
  const db = loadDb(ctx);
  if (u.host !== db.host) return null;
  const notFound = u.proto === 'ssh' ? `ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.` : `remote: Repository not found.\nfatal: repository 'https://${u.host}/${u.full}.git/' not found`;
  let login: string | null = null;
  let scopes: string[] | null = null;
  if (u.proto === 'ssh') {
    const mine = publicKeysOf(ctx).map(keyId);
    login = Object.entries(db.users).find(([, x]) => x.keys.some((k) => mine.includes(keyId(k))))?.[0] ?? null;
    if (!login) return { error: `git@${u.host}: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.` };
  } else {
    const token = httpsCredential(ctx, u);
    if (token) {
      const who = userForToken(db, token);
      if (!who) return { error: `remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://${u.host}/${u.full}.git/'` };
      login = who.login;
      scopes = who.scopes;
    } else if (intent === 'push' || db.repos[u.full]?.visibility !== 'public') {
      return { error: `fatal: could not read Username for 'https://${u.host}': terminal prompts disabled` };
    }
  }
  const repo = db.repos[u.full] ?? db.repos[Object.keys(db.repos).find((k) => k.toLowerCase() === u.full.toLowerCase()) ?? ''];
  if (!repo || roleOf(repo, login) < 1) return { error: notFound };
  if (intent === 'push') {
    if (roleOf(repo, login) < 3 || (scopes && !scopes.includes('repo') && !(repo.visibility === 'public' && scopes.includes('public_repo'))))
      return { error: u.proto === 'ssh' ? `ERROR: Permission to ${repo.owner}/${repo.name}.git denied to ${login}.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.` : `remote: Permission to ${repo.owner}/${repo.name}.git denied to ${login}.\nfatal: unable to access 'https://${u.host}/${u.full}.git/': The requested URL returned error: 403` };
  }
  return { path: forgeRepoPath(`${repo.owner}/${repo.name}`), user: login, scopes };
}

const repoKeyOfPath = (path: string) => path.replace(`${FORGE_DIR}/repos/`, '').replace(/\.git$/, '');

export function protectionFor(repo: ForgeRepo, branch: string): Protection | null {
  if (repo.protection[branch]) return repo.protection[branch];
  const pat = Object.keys(repo.protection).find((p) => /[*?]/.test(p) && new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$').test(branch));
  return pat ? repo.protection[pat] : null;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['GitHub Personal Access Token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ['Amazon AWS Access Key ID', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack API Token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['Stripe API Key', /\bsk_live_[0-9a-zA-Z]{24,}\b/],
  ['Private Key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
}

/** Branch protection, push protection and token scopes: ref -> rejection (first line short reason, then remote: lines). */
export function forgeBeforePush(ctx: Ctx, path: string, user: string | null, updates: RefUpdate[], local: GitState, scopes?: string[] | null): Record<string, string> {
  const db = loadDb(ctx);
  const key = repoKeyOfPath(path);
  const repo = db.repos[key];
  const out: Record<string, string> = {};
  if (!repo) return out;
  const admin = roleOf(repo, user) >= 5;
  for (const u of updates) {
    if (!u.ref.startsWith('refs/heads/')) continue;
    const branch = u.ref.slice(11);
    const old = u.old ? local.commits[u.old]?.tree ?? {} : {};
    const neu = u.new ? local.commits[u.new]?.tree ?? {} : {};
    if (scopes && !scopes.includes('workflow')) {
      const wf = Object.keys({ ...old, ...neu }).find((p) => p.startsWith('.github/workflows/') && old[p] !== neu[p]);
      if (wf) {
        out[u.ref] = `refusing to allow a Personal Access Token to create or update workflow \`${wf}\` without \`workflow\` scope`;
        continue;
      }
    }
    if (repo.pushProtection && u.new) {
      const newCommits = [...ancestors(local, u.new)].filter((c) => !u.old || !ancestors(local, u.old).has(c));
      for (const c of newCommits) {
        const tree = local.commits[c].tree;
        const parent = local.commits[c].parents[0] ? local.commits[local.commits[c].parents[0]]?.tree ?? {} : {};
        for (const [p, content] of Object.entries(tree)) {
          if (parent[p] === content) continue;
          const kinds = findSecrets(content);
          if (kinds.length) {
            const line = content.split('\n').findIndex((l) => findSecrets(l).length) + 1;
            out[u.ref] = `push declined due to repository rule violations\nerror: GH013: Repository rule violations found for ${u.ref}.\n\n- GITHUB PUSH PROTECTION\n  —————————————————————————————————————————\n    Resolve the following violations before pushing again\n\n    - Push cannot contain secrets\n\n      —— ${kinds[0]} ————————————————————————\n       locations:\n         - commit: ${c}\n           path: ${p}:${line}\n\n       Remove the secret from the commit (rewrite history with git commit --amend\n       or git rebase -i) and push again.\n`;
            break;
          }
        }
        if (out[u.ref]) break;
      }
      if (out[u.ref]) continue;
    }
    const rule = protectionFor(repo, branch);
    if (!rule || (admin && !rule.enforce_admins)) continue;
    const head = `protected branch hook declined\nerror: GH006: Protected branch update failed for ${u.ref}.`;
    if (!u.new) {
      if (!rule.allow_deletions) out[u.ref] = `${head}\nerror: Cannot delete this protected branch`;
      continue;
    }
    if (u.old && !ancestors(local, u.new).has(u.old) && !rule.allow_force_pushes) {
      out[u.ref] = `${head}\nerror: Cannot force-push to this branch`;
      continue;
    }
    if (rule.required_pull_request_reviews) {
      out[u.ref] = `${head}\nerror: Changes must be made through a pull request.`;
      continue;
    }
    if (rule.required_status_checks?.contexts.length) {
      const needed = rule.required_status_checks.contexts;
      const runs = (db.runs as CiRun[]).filter((r) => r.repo === key && r.sha === u.new);
      const missing = needed.filter((c) => !runs.some((r) => r.jobs.some((j) => j.name === c && j.conclusion === 'success')));
      if (missing.length) out[u.ref] = `${head}\nerror: ${missing.length === 1 ? `Required status check "${missing[0]}" is expected.` : `${missing.length} of ${needed.length} required status checks are expected.`}`;
    }
    if (rule.required_linear_history && local.commits[u.new]?.parents.length > 1) out[u.ref] = `${head}\nerror: This branch must not contain merge commits.`;
  }
  return out;
}

/** After a push: run workflows, update pull requests, and suggest opening one for a new branch. */
export function forgeAfterPush(ctx: Ctx, path: string, user: string | null, accepted: RefUpdate[], local: GitState): string {
  const db = loadDb(ctx);
  const key = repoKeyOfPath(path);
  const repo = db.repos[key];
  if (!repo) return '';
  let msg = '';
  for (const u of accepted) {
    if (!u.new) continue;
    const changed = changedPaths(local, u.old, u.new);
    triggerRuns(ctx, db, key, 'push', u.ref, u.new, user ?? repo.owner, undefined, changed);
    if (u.ref.startsWith('refs/heads/')) {
      const branch = u.ref.slice(11);
      for (const pr of db.prs.filter((p) => p.state === 'OPEN' && p.headRepo === key && p.head === branch)) {
        triggerRuns(ctx, db, pr.repo, 'pull_request', `refs/heads/${pr.base}`, u.new, user ?? pr.author, pr, changed);
        // New commits make earlier approvals stale where the rule says so.
        const rule = protectionFor(db.repos[pr.repo], pr.base);
        if (rule?.required_pull_request_reviews?.dismiss_stale_reviews) for (const rv of pr.reviews) if (rv.state === 'APPROVED') rv.state = 'DISMISSED';
      }
      if (!u.old && branch !== repo.defaultBranch && !db.prs.some((p) => p.state === 'OPEN' && p.head === branch && p.headRepo === key)) msg += `\nCreate a pull request for '${branch}' on ${db.host} by visiting:\n     https://${db.host}/${key}/pull/new/${branch}\n`;
    }
  }
  saveDb(ctx, db);
  tryAutoMerge(ctx, null);
  return msg.replace(/\n$/, '');
}

function changedPaths(st: GitState, from: string | null, to: string): string[] {
  const a = from ? st.commits[from]?.tree ?? {} : {};
  const b = st.commits[to]?.tree ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]);
}

/* ----------------------------------------------------------------------------- CI */

function repoState(ctx: Ctx, key: string): GitState {
  return loadGit(ctx, forgeRepoPath(key));
}

export function triggerRuns(ctx: Ctx, db: ForgeDb, key: string, event: string, ref: string, sha: string, actorName: string, pr?: ForgePr, changed?: string[], inputs?: Record<string, string>, onlyFile?: string): CiRun[] {
  const repo = db.repos[key];
  const headKey = pr?.headRepo ?? key;
  const st = repoState(ctx, headKey);
  const c = st.commits[sha];
  if (!c) return [];
  const files = c.tree;
  const out: CiRun[] = [];
  const fromFork = !!pr && pr.headRepo !== pr.repo;
  for (const wf of readWorkflows(files)) {
    if (onlyFile && wf.path !== onlyFile && !wf.path.endsWith('/' + onlyFile) && wf.name !== onlyFile) continue;
    if (repo.disabledWorkflows?.includes(wf.path)) continue;
    if (!wf.error && !triggers(wf.doc, event, ref, changed, pr?.base)) continue;
    db.runCounter++;
    const input: CiInput = {
      ctx,
      repo: key,
      files,
      exec: c.x ?? [],
      history: st,
      event,
      ref: pr ? `refs/pull/${pr.number}/merge` : ref,
      sha,
      actor: actorName,
      secrets: fromFork ? {} : { ...repo.secrets, GITHUB_TOKEN: simToken(`${key}-${db.runCounter}`, 'ghs') },
      vars: { ...repo.variables },
      inputs,
      pr: pr ? { number: pr.number, base: pr.base, head: pr.head, title: pr.title } : undefined,
      cache: (db.cache[key] ??= {}),
      environments: fromFork ? {} : repo.environments,
      serverUrl: `https://${db.host}`,
      runId: db.runCounter,
      runNumber: (db.runs as CiRun[]).filter((r) => r.repo === key && r.file === wf.path).length + 1,
      title: pr ? pr.title : subject(c.message),
    };
    const run = runWorkflow(input, wf);
    (db.runs as CiRun[]).push(run);
    out.push(run);
  }
  return out;
}

/* ----------------------------------------------------------------------------- pull requests */

interface Mergeability {
  ok: boolean;
  reasons: string[];
  conflict: boolean;
  approvals: number;
  checks: Array<{ name: string; conclusion: string | null; status: string; run: number; job: number; seconds: number; workflow: string }>;
}

function headSha(ctx: Ctx, pr: ForgePr): string | null {
  return repoState(ctx, pr.headRepo).branches[pr.head] ?? null;
}

/** A pull request that came with the lab has had its CI run already: run it the first time anyone looks. */
export function ensurePrRuns(ctx: Ctx, db: ForgeDb, pr: ForgePr): void {
  if (pr.state !== 'OPEN') return;
  const sha = headSha(ctx, pr);
  if (!sha || (db.runs as CiRun[]).some((r) => r.repo === pr.repo && r.pr === pr.number && r.sha === sha)) return;
  triggerRuns(ctx, db, pr.repo, 'pull_request', `refs/heads/${pr.base}`, sha, pr.author, pr);
  saveDb(ctx, db);
}

/** A repository that came with the lab has already run CI on its default branch: run it the first time anyone looks. */
export function ensureBranchRuns(ctx: Ctx, db: ForgeDb, key: string): void {
  const repo = db.repos[key];
  if (!repo) return;
  const st = repoState(ctx, key);
  const sha = st.branches[repo.defaultBranch];
  if (!sha || (db.runs as CiRun[]).some((r) => r.repo === key && r.sha === sha)) return;
  if (!triggerRuns(ctx, db, key, 'push', `refs/heads/${repo.defaultBranch}`, sha, st.commits[sha].author, undefined, undefined).length) return;
  saveDb(ctx, db);
}

export function prChecks(db: ForgeDb, pr: ForgePr, sha: string | null): Mergeability['checks'] {
  const runs = (db.runs as CiRun[]).filter((r) => r.repo === pr.repo && r.sha === sha && (r.pr === pr.number || r.event === 'push'));
  const latest = new Map<string, Mergeability['checks'][number]>();
  for (const r of runs) for (const j of r.jobs) latest.set(`${r.workflow}/${j.name}`, { name: j.name, conclusion: j.conclusion, status: j.status, run: r.id, job: j.id, seconds: j.seconds, workflow: r.workflow });
  return [...latest.values()];
}

function latestReviews(pr: ForgePr): Map<string, ForgePr['reviews'][number]> {
  const m = new Map<string, ForgePr['reviews'][number]>();
  for (const rv of pr.reviews) if (rv.state !== 'COMMENTED') m.set(rv.user, rv);
  return m;
}

function mergeability(ctx: Ctx, db: ForgeDb, pr: ForgePr, user: string | null, admin = false): Mergeability {
  ensurePrRuns(ctx, db, pr);
  const repo = db.repos[pr.repo];
  const base = repoState(ctx, pr.repo);
  const sha = headSha(ctx, pr);
  const reasons: string[] = [];
  const headSt = repoState(ctx, pr.headRepo);
  let conflict = false;
  const baseTip = base.branches[pr.base];
  if (sha && baseTip) {
    const all = { ...headSt.commits, ...base.commits };
    const merged = { ...base, commits: all } as GitState;
    const A = ancestors(merged, baseTip);
    const common = [...ancestors(merged, sha)].filter((c) => A.has(c)).sort((a, b) => all[b].seq - all[a].seq)[0];
    const fake = { ctx, io: { stdin: '', out: () => {}, err: () => {} }, root: forgeRepoPath(pr.repo), gitDir: forgeRepoPath(pr.repo), bare: true, st: merged } as Repo;
    const m = mergeTrees(fake, common ? all[common].tree : {}, all[baseTip].tree, all[sha].tree, { base: [], ours: [], theirs: [] }, { ours: pr.base, theirs: pr.head });
    conflict = Object.keys(m.conflicts).length > 0;
  }
  if (conflict) reasons.push('the merge commit cannot be cleanly created');
  const reviews = latestReviews(pr);
  const approvals = [...reviews.values()].filter((r) => r.state === 'APPROVED' && r.user !== pr.author).length;
  const checks = prChecks(db, pr, sha);
  const rule = protectionFor(repo, pr.base);
  if (rule && !(admin && !rule.enforce_admins)) {
    const need = rule.required_pull_request_reviews?.required_approving_review_count ?? 0;
    if ([...reviews.values()].some((r) => r.state === 'CHANGES_REQUESTED')) reasons.push('changes were requested');
    else if (approvals < need) reasons.push(`${need} approving review${need === 1 ? ' is' : 's are'} required`);
    if (rule.required_pull_request_reviews?.require_code_owner_reviews) {
      const owners = codeOwnersFor(ctx, pr);
      if (owners.length && ![...reviews.values()].some((r) => r.state === 'APPROVED' && owners.includes(r.user))) reasons.push(`a review from a code owner (${owners.join(', ')}) is required`);
    }
    for (const ctxName of rule.required_status_checks?.contexts ?? []) {
      const c = checks.find((x) => x.name === ctxName);
      if (!c) reasons.push(`required check "${ctxName}" has not run`);
      else if (c.status !== 'completed') reasons.push(`required check "${ctxName}" is ${c.status}`);
      else if (c.conclusion !== 'success') reasons.push(`required check "${ctxName}" failed`);
    }
    if (rule.required_status_checks?.strict && baseTip && sha && !ancestors({ ...headSt, commits: { ...headSt.commits, ...base.commits } } as GitState, sha).has(baseTip)) reasons.push('the head branch is not up to date with the base branch');
  }
  void user;
  return { ok: !reasons.length, reasons, conflict, approvals, checks };
}

function codeOwnersFor(ctx: Ctx, pr: ForgePr): string[] {
  const base = repoState(ctx, pr.repo);
  const tip = base.branches[pr.base];
  const tree = tip ? base.commits[tip].tree : {};
  const text = tree['.github/CODEOWNERS'] ?? tree['CODEOWNERS'] ?? tree['docs/CODEOWNERS'];
  if (!text) return [];
  const headSt = repoState(ctx, pr.headRepo);
  const sha = headSt.branches[pr.head];
  const changed = sha && tip ? changedPaths({ ...headSt, commits: { ...headSt.commits, ...base.commits } } as GitState, tip, sha) : [];
  const owners = new Set<string>();
  const rules = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  for (const p of changed) {
    let hit: string[] | null = null;
    for (const [pat, ...who] of rules) {
      const rx = new RegExp((pat.startsWith('/') ? '^' : '(^|/)') + pat.replace(/^\//, '').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + (pat.endsWith('/') ? '' : '(/|$)'));
      if (pat === '*' || rx.test(p)) hit = who;
    }
    for (const w of hit ?? []) owners.add(w.replace(/^@/, ''));
  }
  return [...owners];
}

function doMergePr(ctx: Ctx, db: ForgeDb, pr: ForgePr, method: 'merge' | 'squash' | 'rebase', user: string, subjectOverride?: string, bodyOverride?: string): { ok: true; sha: string } | { ok: false; why: string } {
  const repo = db.repos[pr.repo];
  const basePath = forgeRepoPath(pr.repo);
  const base = loadGit(ctx, basePath);
  const headSt = repoState(ctx, pr.headRepo);
  const sha = headSt.branches[pr.head];
  const baseTip = base.branches[pr.base];
  if (!sha || !baseTip) return { ok: false, why: 'the head branch no longer exists' };
  for (const id of ancestors(headSt, sha)) if (!base.commits[id]) base.commits[id] = { ...headSt.commits[id], seq: Object.keys(base.commits).length + 1 };
  const fake: Repo = { ctx, io: { stdin: '', out: () => {}, err: () => {} }, root: basePath, gitDir: basePath, bare: true, st: base };
  const A = ancestors(base, baseTip);
  const head = ancestors(base, sha);
  const commonList = [...head].filter((c) => A.has(c)).sort((a, b) => base.commits[b].seq - base.commits[a].seq);
  const common = commonList[0];
  const u = db.users[user];
  const now = Math.max(ctx.sys.now, ...Object.values(base.commits).map((c) => c.ctime ?? c.time)) + 60000;
  const mk = (message: string, parents: string[], tree: Record<string, string>, x: string[], author?: { name: string; email: string; time: number }) => {
    const body = { parents, message, author: author?.name ?? u.name, email: author?.email ?? u.email, time: author?.time ?? now, tree, ...(x.length ? { x } : {}), committer: 'GitHub', cemail: `noreply@${db.host}`, ctime: now };
    const id = commitId(body);
    base.commits[id] = { id, seq: Object.keys(base.commits).length + 1, ...body };
    return id;
  };
  let newTip: string;
  const own = [...head].filter((c) => !A.has(c));
  if (method === 'rebase') {
    let tip = baseTip;
    for (const id of [...own].sort((a, b) => base.commits[a].seq - base.commits[b].seq)) {
      const c = base.commits[id];
      const m = mergeTrees(fake, base.commits[c.parents[0]]?.tree ?? {}, base.commits[tip].tree, c.tree, { base: [], ours: base.commits[tip].x ?? [], theirs: c.x ?? [] }, { ours: pr.base, theirs: pr.head });
      if (Object.keys(m.conflicts).length) return { ok: false, why: 'This branch can\'t be rebased' };
      tip = mk(c.message, [tip], m.tree, m.x, { name: c.author, email: c.email, time: c.time });
    }
    newTip = tip;
  } else {
    const m = mergeTrees(fake, common ? base.commits[common].tree : {}, base.commits[baseTip].tree, base.commits[sha].tree, { base: [], ours: base.commits[baseTip].x ?? [], theirs: base.commits[sha].x ?? [] }, { ours: pr.base, theirs: pr.head });
    if (Object.keys(m.conflicts).length) return { ok: false, why: 'the merge commit cannot be cleanly created' };
    if (method === 'squash') {
      const subjects = own.sort((a, b) => base.commits[a].seq - base.commits[b].seq).map((id) => `* ${subject(base.commits[id].message)}`);
      const au = db.users[pr.author];
      newTip = mk(`${subjectOverride ?? `${pr.title} (#${pr.number})`}\n\n${bodyOverride ?? subjects.join('\n\n')}`, [baseTip], m.tree, m.x, au ? { name: au.name, email: au.email, time: now } : undefined);
    } else {
      const headOwner = pr.headRepo.split('/')[0];
      newTip = mk(`${subjectOverride ?? `Merge pull request #${pr.number} from ${headOwner}/${pr.head}`}\n\n${bodyOverride ?? pr.title}`, [baseTip, sha], m.tree, m.x);
    }
  }
  base.branches[pr.base] = newTip;
  saveRepo({ ...fake, st: base }, ROOT);
  pr.state = 'MERGED';
  pr.mergedAt = ctx.sys.now;
  pr.mergedBy = user;
  pr.mergeCommit = newTip;
  delete pr.autoMerge;
  // "Closes #12" in the description closes the issue.
  for (const m of `${pr.title}\n${pr.body}`.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
    const issue = db.issues.find((i) => i.repo === pr.repo && i.number === Number(m[1]));
    if (issue && issue.state === 'OPEN') {
      issue.state = 'CLOSED';
      issue.closedBy = `#${pr.number}`;
      issue.stateReason = 'completed';
    }
  }
  if (repo.deleteBranchOnMerge && pr.headRepo === pr.repo) {
    const fresh = loadGit(ctx, basePath);
    delete fresh.branches[pr.head];
    saveRepo({ ...fake, st: fresh }, ROOT);
  }
  triggerRuns(ctx, db, pr.repo, 'push', `refs/heads/${pr.base}`, newTip, user, undefined, changedPaths(base, baseTip, newTip));
  return { ok: true, sha: newTip };
}

/** Merges pull requests with auto-merge enabled once they are ready. */
function tryAutoMerge(ctx: Ctx, io: IO | null): void {
  const db = loadDb(ctx);
  let changed = false;
  for (const pr of db.prs.filter((p) => p.state === 'OPEN' && p.autoMerge)) {
    const m = mergeability(ctx, db, pr, null);
    if (!m.ok || m.checks.some((c) => c.status !== 'completed')) continue;
    const r = doMergePr(ctx, db, pr, pr.autoMerge!, pr.mergedBy ?? pr.author);
    if (r.ok) {
      changed = true;
      io?.err(`✓ Pull request ${pr.repo}#${pr.number} was merged automatically\n`);
    }
  }
  if (changed) saveDb(ctx, db);
}

/* ----------------------------------------------------------------------------- gh */

class GhExit extends Error {
  constructor(
    public text: string,
    public code = 1,
  ) {
    super(text);
  }
}
const fail = (text: string, code = 1): never => {
  throw new GhExit(text, code);
};

interface Gh {
  ctx: Ctx;
  io: IO;
  db: ForgeDb;
  user: string;
  scopes: string[];
  protocol: 'ssh' | 'https';
}

function ghSession(ctx: Ctx, io: IO): Gh {
  if (!forgeExists(ctx)) fail(`error connecting to ${FORGE_HOST}\ncheck your internet connection or https://${FORGE_HOST}/status`);
  const login = ghLogin(ctx);
  if (!login) fail(`To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.`, 4);
  const db = loadDb(ctx);
  const who = userForToken(db, login!.token);
  if (!who) fail(`HTTP 401: Bad credentials (https://${FORGE_HOST}/api/v3/user)\nTry authenticating with:  gh auth login`, 4);
  return { ctx, io, db, user: who!.login, scopes: who!.scopes, protocol: login!.protocol };
}

function urlFor(db: ForgeDb, full: string, protocol: 'ssh' | 'https'): string {
  return protocol === 'ssh' ? `git@${db.host}:${full}.git` : `https://${db.host}/${full}.git`;
}

/** Which repository a gh command is about: -R, or the current git repository's forge remote. */
function targetRepo(g: Gh, args: string[]): { key: string; repo: ForgeRepo; local: Repo | null } {
  const ri = args.findIndex((a) => a === '-R' || a === '--repo' || a.startsWith('--repo='));
  let key: string | null = null;
  if (ri !== -1) {
    const v = args[ri].includes('=') ? args[ri].split('=')[1] : args[ri + 1];
    args.splice(ri, args[ri].includes('=') ? 1 : 2);
    key = v.replace(new RegExp(`^${g.db.host}/`), '');
  }
  const dir = findRepo(g.ctx);
  const local = dir ? openRepo(g.ctx, g.io, dir) : null;
  if (!key) {
    if (!local) fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git');
    const remotes = local!.st.remotes ?? {};
    const pick = remotes.upstream ?? remotes.origin ?? Object.values(remotes)[0];
    const parsed = pick ? parseForgeUrl(pick.url) : null;
    if (!parsed || parsed.host !== g.db.host) fail('no git remotes found');
    key = parsed!.full;
  }
  const repo = g.db.repos[key!];
  if (!repo || roleOf(repo, g.user) < 1) fail(`GraphQL: Could not resolve to a Repository with the name '${key}'. (repository)`);
  return { key: key!, repo, local };
}

function flagVal(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(n + '=')) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}
function flagVals(args: string[], ...names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) for (const n of names) if (args[i] === n && args[i + 1] !== undefined) out.push(args[i + 1]);
  else if (args[i].startsWith(n + '=')) out.push(args[i].slice(n.length + 1));
  return out.flatMap((v) => v.split(','));
}
const hasFlag = (args: string[], ...names: string[]) => args.some((a) => names.includes(a));
function positional(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
}

function ago(g: Gh, t: number): string {
  const r = relative(t, g.ctx.sys.now);
  return r.startsWith('0 ') || /^\d+ seconds/.test(r) ? 'less than a minute ago' : `about ${r}`.replace('about 1 minutes', 'about 1 minute').replace('about 1 hours', 'about 1 hour').replace('about 1 days', 'about 1 day');
}

/** --json fields [--jq expr] [-q expr] output for list/view commands. */
function jsonOut(g: Gh, args: string[], value: unknown): boolean {
  const fields = flagVal(args, '--json');
  if (fields === undefined) return false;
  const pick = (o: Record<string, unknown>) => (fields ? Object.fromEntries(fields.split(',').map((f) => [f, o[f] ?? null])) : o);
  const v = Array.isArray(value) ? value.map((x) => pick(x as Record<string, unknown>)) : pick(value as Record<string, unknown>);
  const jq = flagVal(args, '--jq', '-q');
  if (jq) {
    for (const r of runJq(compile(jq), v as JqValue)) g.io.out((typeof r === 'string' ? r : formatJ(r, { compact: true })) + '\n');
  } else g.io.out(JSON.stringify(v, null, 2) + '\n');
  return true;
}

function prJson(g: Gh, pr: ForgePr): Record<string, unknown> {
  const sha = headSha(g.ctx, pr);
  const reviews = latestReviews(pr);
  const checks = prChecks(g.db, pr, sha);
  const decision = [...reviews.values()].some((r) => r.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : [...reviews.values()].some((r) => r.state === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    author: { login: pr.author },
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: sha,
    isDraft: !!pr.draft,
    url: `https://${g.db.host}/${pr.repo}/pull/${pr.number}`,
    reviewDecision: decision,
    reviews: pr.reviews.map((r) => ({ author: { login: r.user }, state: r.state, body: r.body })),
    labels: pr.labels.map((name) => ({ name })),
    mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    statusCheckRollup: checks.map((c) => ({ name: c.name, status: c.status.toUpperCase(), conclusion: (c.conclusion ?? '').toUpperCase(), workflowName: c.workflow })),
    createdAt: new Date(pr.createdAt).toISOString(),
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt).toISOString() : null,
  };
}

function runJson(r: CiRun): Record<string, unknown> {
  return {
    databaseId: r.id,
    number: r.number,
    status: r.status,
    conclusion: r.conclusion ?? '',
    name: r.workflow,
    workflowName: r.workflow,
    displayTitle: r.title,
    headBranch: r.branch,
    headSha: r.sha,
    event: r.event,
    createdAt: new Date(r.createdAt).toISOString(),
    url: `https://${FORGE_HOST}/${r.repo}/actions/runs/${r.id}`,
    jobs: r.jobs.map((j) => ({ databaseId: j.id, name: j.name, status: j.status, conclusion: j.conclusion ?? '', steps: j.steps.map((s) => ({ name: s.name, conclusion: s.conclusion, number: s.number })) })),
    attempt: r.attempt,
  };
}

function findPr(g: Gh, key: string, arg: string | undefined, local: Repo | null): ForgePr {
  const pr = findPr0(g, key, arg, local);
  ensurePrRuns(g.ctx, g.db, pr);
  return pr;
}

function findPr0(g: Gh, key: string, arg: string | undefined, local: Repo | null): ForgePr {
  let pr: ForgePr | undefined;
  if (arg && /^#?\d+$/.test(arg)) pr = g.db.prs.find((p) => p.repo === key && p.number === Number(arg.replace('#', '')));
  else if (arg && /\/pull\/(\d+)/.test(arg)) pr = g.db.prs.find((p) => p.repo === key && p.number === Number(/\/pull\/(\d+)/.exec(arg)![1]));
  else {
    const branch = arg ?? local?.st.head.branch;
    pr = [...g.db.prs].reverse().find((p) => p.repo === key && p.head === branch && (arg ? true : p.state === 'OPEN')) ?? [...g.db.prs].reverse().find((p) => p.repo === key && p.head === branch);
    if (!pr) fail(`no pull requests found for branch "${branch}"`);
  }
  if (!pr) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${arg}. (repository.pullRequest)`);
  return pr!;
}

function checksSummary(checks: Mergeability['checks']): string {
  if (!checks.length) return 'No checks';
  const failing = checks.filter((c) => c.conclusion === 'failure').length;
  const pending = checks.filter((c) => c.status !== 'completed').length;
  if (failing) return `X ${failing}/${checks.length} checks failing`;
  if (pending) return `- Checks pending`;
  return '✓ Checks passing';
}

function ghPr(g: Gh, sub: string, args: string[]): number {
  const { key, repo, local } = targetRepo(g, args);
  const io = g.io;
  const db = g.db;
  const pos = positional(args, ['-t', '--title', '-b', '--body', '-B', '--base', '-H', '--head', '-r', '--reviewer', '-l', '--label', '-a', '--assignee', '-s', '--state', '-A', '--author', '-L', '--limit', '-F', '--body-file', '--json', '--jq', '-q', '--subject', '--match-head-commit', '-c', '--comment', '--add-label', '--remove-label']);
  switch (sub) {
    case 'create': {
      if (roleOf(repo, g.user) < 1) fail('pull request create failed: you do not have access');
      let head = flagVal(args, '-H', '--head') ?? local?.st.head.branch;
      if (!head) fail('could not determine the current branch: not on any branch');
      let headRepo = key;
      if (head!.includes(':')) {
        const [owner, b] = head!.split(':');
        headRepo = Object.keys(db.repos).find((k) => k.startsWith(owner + '/') && db.repos[k].forkOf === key) ?? `${owner}/${repo.name}`;
        head = b;
      } else if (local) {
        // From a fork's clone: the head lives in "origin" when "upstream" is the target.
        const origin = local.st.remotes?.origin ? parseForgeUrl(local.st.remotes.origin.url) : null;
        if (origin && origin.full !== key && db.repos[origin.full]?.forkOf === key) headRepo = origin.full;
      }
      const base = flagVal(args, '-B', '--base') ?? repo.defaultBranch;
      const hs = repoState(g.ctx, headRepo);
      const sha = hs.branches[head!];
      if (!sha) fail(`aborted: you must first push the current branch to a remote, or use the --head flag`);
      if (local?.st.branches[head!] && local.st.branches[head!] !== sha && !hasFlag(args, '--no-maintainer-edit')) io.err(`Warning: 1 uncommitted change\n`.replace('1 uncommitted change', `your local ${head} has commits that are not pushed yet`));
      const baseSt = repoState(g.ctx, key);
      const baseTip = baseSt.branches[base];
      if (!baseTip) fail(`pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, Base ref must be a branch (createPullRequest)`);
      const merged = { ...hs, commits: { ...hs.commits, ...baseSt.commits } } as GitState;
      if (ancestors(merged, baseTip).has(sha!)) fail(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
      const existing = db.prs.find((p) => p.repo === key && p.head === head && p.headRepo === headRepo && p.base === base && p.state === 'OPEN');
      if (existing) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\nhttps://${db.host}/${key}/pull/${existing.number}`);
      let title = flagVal(args, '-t', '--title');
      let body = flagVal(args, '-b', '--body') ?? (flagVal(args, '-F', '--body-file') ? readFile(g.ctx.sys.fs, abs(g.ctx, flagVal(args, '-F', '--body-file')!), actor(g.ctx)) : undefined);
      if (hasFlag(args, '-f', '--fill', '--fill-first')) {
        const own = [...ancestors(merged, sha!)].filter((c) => !ancestors(merged, baseTip).has(c)).sort((a, b) => merged.commits[a].seq - merged.commits[b].seq);
        const first = merged.commits[own[0]];
        title ??= own.length === 1 || hasFlag(args, '--fill-first') ? subject(first.message) : head!.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
        body ??= own.length === 1 ? first.message.split('\n').slice(2).join('\n') : own.map((c) => `- ${subject(merged.commits[c].message)}`).join('\n');
      }
      if (!title) fail('must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively');
      const n = db.counters[key] ?? 1;
      db.counters[key] = n + 1;
      const pr: ForgePr = { repo: key, number: n, title: title!, body: body ?? '', author: g.user, head: head!, headRepo, base, state: 'OPEN', draft: hasFlag(args, '-d', '--draft'), reviews: [], comments: [], labels: flagVals(args, '-l', '--label'), reviewers: flagVals(args, '-r', '--reviewer'), assignees: flagVals(args, '-a', '--assignee').map((a) => (a === '@me' ? g.user : a)), createdAt: g.ctx.sys.now };
      db.prs.push(pr);
      io.err(`\nCreating ${pr.draft ? 'draft ' : ''}pull request for ${headRepo !== key ? headRepo.split('/')[0] + ':' : ''}${head} into ${base} in ${key}\n\n`);
      triggerRuns(g.ctx, db, key, 'pull_request', `refs/heads/${base}`, sha!, g.user, pr, changedPaths(merged, baseTip, sha!));
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/pull/${n}\n`);
      return 0;
    }
    case 'list': {
      const state = (flagVal(args, '-s', '--state') ?? 'open').toUpperCase();
      let list = db.prs.filter((p) => p.repo === key && (state === 'ALL' || p.state === state));
      const author = flagVal(args, '-A', '--author');
      if (author) list = list.filter((p) => p.author === (author === '@me' ? g.user : author));
      const baseF = flagVal(args, '-B', '--base');
      if (baseF) list = list.filter((p) => p.base === baseF);
      const label = flagVals(args, '-l', '--label');
      if (label.length) list = list.filter((p) => label.every((l) => p.labels.includes(l)));
      list = list.sort((a, b) => b.number - a.number).slice(0, Number(flagVal(args, '-L', '--limit') ?? 30));
      if (jsonOut(g, args, list.map((p) => prJson(g, p)))) return 0;
      if (!list.length) {
        io.err(`no ${state === 'ALL' ? '' : state.toLowerCase() + ' '}pull requests match your search in ${key}\n`);
        return 0;
      }
      io.out(`\nShowing ${list.length} of ${list.length} ${state === 'ALL' ? '' : state.toLowerCase() + ' '}pull request${list.length === 1 ? '' : 's'} in ${key}\n\n`);
      const w = Math.max(5, ...list.map((p) => p.title.length));
      const bw = Math.max(6, ...list.map((p) => p.head.length));
      io.out(`${'ID'.padEnd(5)} ${'TITLE'.padEnd(w)}  ${'BRANCH'.padEnd(bw)}  CREATED AT\n`);
      for (const p of list) io.out(`${('#' + p.number).padEnd(5)} ${p.title.padEnd(w)}  ${p.head.padEnd(bw)}  ${ago(g, p.createdAt)}\n`);
      return 0;
    }
    case 'view': {
      const pr = findPr(g, key, pos[0], local);
      if (jsonOut(g, args, prJson(g, pr))) return 0;
      const sha = headSha(g.ctx, pr);
      const base = repoState(g.ctx, key);
      const hs = repoState(g.ctx, pr.headRepo);
      const merged = { ...hs, commits: { ...hs.commits, ...base.commits } } as GitState;
      const baseTip = base.branches[pr.base];
      const own = sha && baseTip ? [...ancestors(merged, sha)].filter((c) => !ancestors(merged, pr.mergeCommit ? merged.commits[pr.mergeCommit]?.parents[0] ?? baseTip : baseTip).has(c)) : [];
      let add = 0;
      let del = 0;
      if (sha && baseTip) {
        const a = merged.commits[baseTip].tree;
        const b = merged.commits[sha].tree;
        for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (a[p] === b[p]) continue;
          for (const l of hunks(a[p] ?? '', b[p] ?? '')) {
            if (l.startsWith('+')) add++;
            else if (l.startsWith('-')) del++;
          }
        }
      }
      const reviews = latestReviews(pr);
      const state = pr.state === 'OPEN' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'MERGED' ? 'Merged' : 'Closed';
      let s = `${pr.title} ${key}#${pr.number}\n${state} • ${pr.author} ${pr.state === 'MERGED' ? 'merged' : 'wants to merge'} ${plural(own.length, 'commit')} into ${pr.base} from ${pr.head} • ${ago(g, pr.createdAt)}\n+${add} -${del} • ${checksSummary(prChecks(db, pr, sha))}\n`;
      if (reviews.size || pr.reviewers.length) s += `Reviewers: ${[...new Set([...reviews.keys(), ...pr.reviewers])].map((u) => `${u} (${reviews.get(u)?.state === 'APPROVED' ? 'Approved' : reviews.get(u)?.state === 'CHANGES_REQUESTED' ? 'Requested changes' : reviews.get(u)?.state === 'DISMISSED' ? 'Dismissed' : 'Requested'})`).join(', ')}\n`;
      if (pr.assignees.length) s += `Assignees: ${pr.assignees.join(', ')}\n`;
      if (pr.labels.length) s += `Labels: ${pr.labels.join(', ')}\n`;
      if (pr.autoMerge) s += `Auto-merge: enabled (${pr.autoMerge})\n`;
      s += `\n${pr.body ? pr.body.split('\n').map((l) => '  ' + l).join('\n') : '  No description provided'}\n\n`;
      if (hasFlag(args, '-c', '--comments')) for (const c of pr.comments) s += `${c.user} • ${ago(g, c.at)}\n  ${c.body}\n\n`;
      else if (pr.comments.length + pr.reviews.filter((r) => r.body).length) s += `———————— Not showing ${plural(pr.comments.length + pr.reviews.filter((r) => r.body).length, 'comment')} ————————\n\n`;
      s += `View this pull request on ${db.host}: https://${db.host}/${key}/pull/${pr.number}\n`;
      io.out(s);
      return 0;
    }
    case 'diff': {
      const pr = findPr(g, key, pos[0], local);
      const base = repoState(g.ctx, key);
      const hs = repoState(g.ctx, pr.headRepo);
      const sha = hs.branches[pr.head] ?? pr.mergeCommit;
      const merged = { ...hs, commits: { ...hs.commits, ...base.commits } } as GitState;
      const baseTip = base.branches[pr.base];
      if (!sha || !baseTip) return 0;
      const A = ancestors(merged, baseTip);
      const common = [...ancestors(merged, sha)].filter((c) => A.has(c)).sort((a, b) => merged.commits[b].seq - merged.commits[a].seq)[0];
      const a = common ? merged.commits[common].tree : {};
      const b = merged.commits[sha].tree;
      if (hasFlag(args, '--name-only')) {
        for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (a[p] !== b[p]) io.out(p + '\n');
        return 0;
      }
      for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[p] === b[p]) continue;
        io.out(`diff --git a/${p} b/${p}\n${a[p] === undefined ? 'new file mode 100644\n--- /dev/null' : `--- a/${p}`}\n${b[p] === undefined ? '+++ /dev/null' : `+++ b/${p}`}\n${hunks(a[p] ?? '', b[p] ?? '').join('\n')}\n`);
      }
      return 0;
    }
    case 'checkout': {
      const pr = findPr(g, key, pos[0], local);
      if (!local) fail('not a git repository');
      const remoteName = Object.entries(local!.st.remotes ?? {}).find(([, r]) => parseForgeUrl(r.url)?.full === pr.headRepo)?.[0];
      const git = (a: string[]) => runCommand(g.ctx, ['git', ...a], io);
      if (remoteName) {
        let code = git(['fetch', remoteName, pr.head]);
        if (code) return code;
        const fresh = openRepo(g.ctx, io, local!.root);
        if (fresh.st.branches[pr.head] !== undefined) {
          code = git(['switch', pr.head]);
          return code || git(['merge', '--ff-only', `${remoteName}/${pr.head}`]);
        }
        return git(['switch', '-c', pr.head, '--track', `${remoteName}/${pr.head}`]);
      }
      const url = urlFor(db, pr.headRepo, g.protocol);
      const code = git(['fetch', url, pr.head]);
      if (code) return code;
      return git(['switch', '-c', `${pr.headRepo.split('/')[0]}-${pr.head}`, 'FETCH_HEAD']);
    }
    case 'review': {
      const pr = findPr(g, key, pos[0], local);
      if (pr.state !== 'OPEN') fail(`Pull request ${key}#${pr.number} is ${pr.state.toLowerCase()}`);
      const body = flagVal(args, '-b', '--body') ?? (flagVal(args, '-F', '--body-file') ? readFile(g.ctx.sys.fs, abs(g.ctx, flagVal(args, '-F', '--body-file')!), actor(g.ctx)) : '');
      const state = hasFlag(args, '-a', '--approve') ? 'APPROVED' : hasFlag(args, '-r', '--request-changes') ? 'CHANGES_REQUESTED' : hasFlag(args, '-c', '--comment') ? 'COMMENTED' : null;
      if (!state) fail('--approve, --request-changes, or --comment required when not running interactively');
      if (state !== 'APPROVED' && !body) fail(`body cannot be blank for ${state === 'COMMENTED' ? 'comment' : 'request-changes'} review`);
      if (pr.author === g.user && state !== 'COMMENTED') fail(`failed to create review: GraphQL: Review Can not ${state === 'APPROVED' ? 'approve' : 'request changes on'} your own pull request (addPullRequestReview)`);
      if (roleOf(repo, g.user) < 3 && state === 'APPROVED') io.err(`! ${g.user} does not have write access, so the approval will not count toward branch protection\n`);
      pr.reviews.push({ user: g.user, state: state!, body, commit: headSha(g.ctx, pr) ?? '', at: g.ctx.sys.now });
      saveDb(g.ctx, db);
      io.err(state === 'APPROVED' ? `✓ Approved pull request ${key}#${pr.number}\n` : state === 'CHANGES_REQUESTED' ? `+ Requested changes to pull request ${key}#${pr.number}\n` : `- Reviewed pull request ${key}#${pr.number}\n`);
      tryAutoMerge(g.ctx, io);
      return 0;
    }
    case 'merge': {
      const pr = findPr(g, key, pos[0], local);
      if (pr.state === 'MERGED') fail(`X Pull request ${key}#${pr.number} was already merged`);
      if (pr.state === 'CLOSED') fail(`X Pull request ${key}#${pr.number} is closed`);
      if (pr.draft) fail(`X Pull request ${key}#${pr.number} is still a draft`);
      if (roleOf(repo, g.user) < 3) fail(`GraphQL: ${g.user} does not have the correct permissions to execute \`MergePullRequest\` (mergePullRequest)`);
      const method = hasFlag(args, '-s', '--squash') ? 'squash' : hasFlag(args, '-r', '--rebase') ? 'rebase' : hasFlag(args, '-m', '--merge') ? 'merge' : null;
      if (!method) fail('--merge, --rebase, or --squash required when not running interactively');
      const rule = protectionFor(repo, pr.base);
      if (method === 'merge' && (repo.allowMergeCommit === false || rule?.required_linear_history)) fail(`X Pull request ${key}#${pr.number} is not mergeable: Merge commits are not allowed on this repository.`);
      const admin = hasFlag(args, '--admin') && roleOf(repo, g.user) >= 5;
      const m = mergeability(g.ctx, db, pr, g.user, admin);
      if (!m.ok) {
        if (hasFlag(args, '--auto')) {
          if (!repo.allowAutoMerge) fail(`GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`);
          pr.autoMerge = method!;
          pr.mergedBy = g.user;
          saveDb(g.ctx, db);
          io.err(`✓ Pull request ${key}#${pr.number} will be automatically merged via ${method} when all requirements are met\n`);
          return 0;
        }
        fail(`X Pull request ${key}#${pr.number} is not mergeable: ${m.conflict ? 'the merge commit cannot be cleanly created' : 'the base branch policy prohibits the merge'}.\n${m.reasons.map((r) => `  - ${r}`).join('\n')}\nTo have the pull request merged after all the requirements have been met, add the \`--auto\` flag.\nTo use administrator privileges to immediately merge the pull request, add the \`--admin\` flag.`);
      }
      const r = doMergePr(g.ctx, db, pr, method!, g.user, flagVal(args, '-t', '--subject'), flagVal(args, '-b', '--body'));
      if (!r.ok) fail(`X Pull request ${key}#${pr.number} is not mergeable: ${(r as { why: string }).why}.`);
      saveDb(g.ctx, db);
      io.err(`✓ ${method === 'squash' ? 'Squashed and merged' : method === 'rebase' ? 'Rebased and merged' : 'Merged'} pull request ${key}#${pr.number} (${pr.title})\n`);
      if (hasFlag(args, '-d', '--delete-branch')) {
        if (local && local.st.head.branch === pr.head) {
          const git = (a: string[]) => runCommand(g.ctx, ['git', ...a], { stdin: '', out: () => {}, err: () => {} });
          git(['switch', pr.base]);
          if (git(['pull', '--ff-only']) !== 0) io.err(`! warning: not possible to fast-forward to: "${pr.base}"\n`);
          git(['branch', '-D', pr.head]);
          io.err(`✓ Deleted local branch ${pr.head} and switched to branch ${pr.base}\n`);
        } else if (local?.st.branches[pr.head] !== undefined) {
          runCommand(g.ctx, ['git', 'branch', '-D', pr.head], { stdin: '', out: () => {}, err: () => {} });
          io.err(`✓ Deleted local branch ${pr.head}\n`);
        }
        if (pr.headRepo === key) {
          const path = forgeRepoPath(key);
          const st = loadGit(g.ctx, path);
          delete st.branches[pr.head];
          saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st }, ROOT);
          io.err(`✓ Deleted remote branch ${pr.head}\n`);
        }
      }
      return 0;
    }
    case 'checks': {
      const pr = findPr(g, key, pos[0], local);
      const checks = prChecks(db, pr, headSha(g.ctx, pr));
      const required = protectionFor(repo, pr.base)?.required_status_checks?.contexts ?? [];
      const list = hasFlag(args, '--required') ? checks.filter((c) => required.includes(c.name)) : checks;
      if (!list.length) {
        io.err(`no checks reported on the '${pr.head}' branch\n`);
        return 1;
      }
      if (jsonOut(g, args, list.map((c) => ({ name: c.name, state: c.status === 'completed' ? (c.conclusion ?? '').toUpperCase() : c.status.toUpperCase(), workflow: c.workflow, link: `https://${db.host}/${key}/actions/runs/${c.run}/job/${c.job}` })))) return 0;
      const failing = list.filter((c) => c.conclusion === 'failure').length;
      const pending = list.filter((c) => c.status !== 'completed').length;
      const ok = list.filter((c) => c.conclusion === 'success').length;
      const skipped = list.filter((c) => c.conclusion === 'skipped').length;
      io.out(`${failing ? 'Some checks were not successful' : pending ? 'Some checks are still pending' : 'All checks were successful'}\n0 cancelled, ${failing} failing, ${ok} successful, ${skipped} skipped, and ${pending} pending checks\n\n`);
      const w = Math.max(4, ...list.map((c) => `${c.workflow}/${c.name}`.length));
      io.out(`   ${'NAME'.padEnd(w)}  ELAPSED  URL\n`);
      for (const c of list) io.out(`${mark(c.conclusion, c.status)}  ${`${c.workflow}/${c.name}`.padEnd(w)}  ${(c.seconds + 's').padEnd(7)}  https://${db.host}/${key}/actions/runs/${c.run}/job/${c.job}\n`);
      return failing ? 1 : pending ? 8 : 0;
    }
    case 'close':
    case 'reopen': {
      const pr = findPr(g, key, pos[0], local);
      if (sub === 'close') {
        if (pr.state !== 'OPEN') fail(`! Pull request ${key}#${pr.number} (${pr.title}) is already ${pr.state.toLowerCase()}`);
        pr.state = 'CLOSED';
        const c = flagVal(args, '-c', '--comment');
        if (c) pr.comments.push({ user: g.user, body: c, at: g.ctx.sys.now });
        io.err(`✓ Closed pull request ${key}#${pr.number} (${pr.title})\n`);
        if (hasFlag(args, '-d', '--delete-branch') && pr.headRepo === key) {
          const path = forgeRepoPath(key);
          const st = loadGit(g.ctx, path);
          delete st.branches[pr.head];
          saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st }, ROOT);
          io.err(`✓ Deleted remote branch ${pr.head}\n`);
        }
      } else {
        if (pr.state !== 'CLOSED') fail(`! Pull request ${key}#${pr.number} (${pr.title}) is ${pr.state.toLowerCase()}`);
        pr.state = 'OPEN';
        io.err(`✓ Reopened pull request ${key}#${pr.number} (${pr.title})\n`);
      }
      saveDb(g.ctx, db);
      return 0;
    }
    case 'comment': {
      const pr = findPr(g, key, pos[0], local);
      const body = flagVal(args, '-b', '--body') ?? fail('--body or --body-file required when not running interactively');
      pr.comments.push({ user: g.user, body: body!, at: g.ctx.sys.now });
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/pull/${pr.number}#issuecomment-${1000 + pr.comments.length}\n`);
      return 0;
    }
    case 'ready': {
      const pr = findPr(g, key, pos[0], local);
      pr.draft = hasFlag(args, '--undo');
      saveDb(g.ctx, db);
      io.err(pr.draft ? `✓ Pull request ${key}#${pr.number} is converted to "draft"\n` : `✓ Pull request ${key}#${pr.number} is marked as "ready for review"\n`);
      return 0;
    }
    case 'edit': {
      const pr = findPr(g, key, pos[0], local);
      const t = flagVal(args, '-t', '--title');
      const b = flagVal(args, '-b', '--body');
      const base = flagVal(args, '-B', '--base');
      if (t) pr.title = t;
      if (b !== undefined) pr.body = b;
      if (base) pr.base = base;
      for (const l of flagVals(args, '--add-label')) if (!pr.labels.includes(l)) pr.labels.push(l);
      pr.labels = pr.labels.filter((l) => !flagVals(args, '--remove-label').includes(l));
      for (const r of flagVals(args, '--add-reviewer')) if (!pr.reviewers.includes(r)) pr.reviewers.push(r);
      for (const a of flagVals(args, '--add-assignee')) if (!pr.assignees.includes(a)) pr.assignees.push(a === '@me' ? g.user : a);
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/pull/${pr.number}\n`);
      return 0;
    }
    case 'status': {
      const mine = db.prs.filter((p) => p.repo === key && p.state === 'OPEN' && p.author === g.user);
      const asked = db.prs.filter((p) => p.repo === key && p.state === 'OPEN' && p.reviewers.includes(g.user));
      const cur = local?.st.head.branch ? db.prs.find((p) => p.repo === key && p.head === local.st.head.branch && p.state === 'OPEN') : undefined;
      let s = `\nRelevant pull requests in ${key}\n\nCurrent branch\n`;
      s += cur ? `  #${cur.number}  ${cur.title} [${cur.head}]\n   - ${checksSummary(prChecks(db, cur, headSha(g.ctx, cur)))}\n` : `  There is no pull request associated with [${local?.st.head.branch ?? 'HEAD'}]\n`;
      s += `\nCreated by you\n${mine.length ? mine.map((p) => `  #${p.number}  ${p.title} [${p.head}]\n`).join('') : '  You have no open pull requests\n'}`;
      s += `\nRequesting a code review from you\n${asked.length ? asked.map((p) => `  #${p.number}  ${p.title} [${p.head}]\n`).join('') : '  You have no pull requests to review\n'}\n`;
      io.out(s);
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh pr"`);
}

function plural(n: number, w: string): string {
  return `${n} ${n === 1 ? w : w + 's'}`;
}

function ghIssue(g: Gh, sub: string, args: string[]): number {
  const { key } = targetRepo(g, args);
  const db = g.db;
  const io = g.io;
  const pos = positional(args, ['-t', '--title', '-b', '--body', '-l', '--label', '-a', '--assignee', '-s', '--state', '-L', '--limit', '--json', '--jq', '-q', '-c', '--comment', '--reason', '--add-label', '--remove-label', '-F', '--body-file']);
  const find = (n: string | undefined) => db.issues.find((i) => i.repo === key && i.number === Number((n ?? '').replace('#', ''))) ?? fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${n}. (repository.issue)`);
  switch (sub) {
    case 'create': {
      const title = flagVal(args, '-t', '--title') ?? fail('must provide `--title` and `--body` when not running interactively');
      const n = db.counters[key] ?? 1;
      db.counters[key] = n + 1;
      db.issues.push({ repo: key, number: n, title: title!, body: flagVal(args, '-b', '--body') ?? '', author: g.user, state: 'OPEN', labels: flagVals(args, '-l', '--label'), assignees: flagVals(args, '-a', '--assignee').map((a) => (a === '@me' ? g.user : a)), comments: [], createdAt: g.ctx.sys.now });
      saveDb(g.ctx, db);
      io.err(`\nCreating issue in ${key}\n\n`);
      io.out(`https://${db.host}/${key}/issues/${n}\n`);
      return 0;
    }
    case 'list': {
      const state = (flagVal(args, '-s', '--state') ?? 'open').toUpperCase();
      let list = db.issues.filter((i) => i.repo === key && (state === 'ALL' || i.state === state));
      const label = flagVals(args, '-l', '--label');
      if (label.length) list = list.filter((i) => label.every((l) => i.labels.includes(l)));
      const as = flagVal(args, '-a', '--assignee');
      if (as) list = list.filter((i) => i.assignees.includes(as === '@me' ? g.user : as));
      list = list.sort((a, b) => b.number - a.number).slice(0, Number(flagVal(args, '-L', '--limit') ?? 30));
      if (jsonOut(g, args, list.map((i) => ({ number: i.number, title: i.title, state: i.state, body: i.body, labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((login) => ({ login })), author: { login: i.author }, url: `https://${db.host}/${key}/issues/${i.number}` })))) return 0;
      if (!list.length) {
        io.err(`no ${state === 'ALL' ? '' : state.toLowerCase() + ' '}issues match your search in ${key}\n`);
        return 0;
      }
      io.out(`\nShowing ${list.length} of ${list.length} ${state === 'ALL' ? '' : state.toLowerCase() + ' '}issue${list.length === 1 ? '' : 's'} in ${key}\n\n`);
      const w = Math.max(5, ...list.map((i) => i.title.length));
      io.out(`${'ID'.padEnd(5)} ${'TITLE'.padEnd(w)}  ${'LABELS'.padEnd(12)}  UPDATED\n`);
      for (const i of list) io.out(`${('#' + i.number).padEnd(5)} ${i.title.padEnd(w)}  ${i.labels.join(', ').padEnd(12)}  ${ago(g, i.createdAt)}\n`);
      return 0;
    }
    case 'view': {
      const i = find(pos[0]);
      if (jsonOut(g, args, { number: i.number, title: i.title, state: i.state, body: i.body, labels: i.labels.map((name) => ({ name })), author: { login: i.author } })) return 0;
      io.out(`${i.title} ${key}#${i.number}\n${i.state === 'OPEN' ? 'Open' : 'Closed'} • ${i.author} opened ${ago(g, i.createdAt)} • ${plural(i.comments.length, 'comment')}\n${i.labels.length ? `Labels: ${i.labels.join(', ')}\n` : ''}${i.assignees.length ? `Assignees: ${i.assignees.join(', ')}\n` : ''}\n${i.body ? i.body.split('\n').map((l) => '  ' + l).join('\n') : '  No description provided'}\n\n${hasFlag(args, '-c', '--comments') ? i.comments.map((c) => `${c.user} • ${ago(g, c.at)}\n  ${c.body}\n\n`).join('') : ''}View this issue on ${db.host}: https://${db.host}/${key}/issues/${i.number}\n`);
      return 0;
    }
    case 'close':
    case 'reopen': {
      const i = find(pos[0]);
      if (sub === 'close') {
        i.state = 'CLOSED';
        i.stateReason = flagVal(args, '-r', '--reason') ?? 'completed';
        const c = flagVal(args, '-c', '--comment');
        if (c) i.comments.push({ user: g.user, body: c, at: g.ctx.sys.now });
        io.err(`✓ Closed issue ${key}#${i.number} (${i.title})\n`);
      } else {
        i.state = 'OPEN';
        io.err(`✓ Reopened issue ${key}#${i.number} (${i.title})\n`);
      }
      saveDb(g.ctx, db);
      return 0;
    }
    case 'comment': {
      const i = find(pos[0]);
      i.comments.push({ user: g.user, body: flagVal(args, '-b', '--body') ?? fail('--body or --body-file required when not running interactively'), at: g.ctx.sys.now });
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/issues/${i.number}#issuecomment-${2000 + i.comments.length}\n`);
      return 0;
    }
    case 'edit': {
      const i = find(pos[0]);
      const t = flagVal(args, '-t', '--title');
      if (t) i.title = t;
      for (const l of flagVals(args, '--add-label')) if (!i.labels.includes(l)) i.labels.push(l);
      i.labels = i.labels.filter((l) => !flagVals(args, '--remove-label').includes(l));
      for (const a of flagVals(args, '--add-assignee')) if (!i.assignees.includes(a)) i.assignees.push(a === '@me' ? g.user : a);
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/issues/${i.number}\n`);
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh issue"`);
}

function latestRunFor(g: Gh, key: string, local: Repo | null): CiRun {
  const runs = (g.db.runs as CiRun[]).filter((r) => r.repo === key);
  const branch = local?.st.head.branch;
  const r = [...runs].reverse().find((x) => !branch || x.branch === branch) ?? runs[runs.length - 1];
  if (!r) fail('found no runs');
  return r!;
}

function runSummary(g: Gh, r: CiRun, verbose: boolean): string {
  let s = `\n${mark(r.conclusion, r.status)} ${r.branch} ${r.workflow} · ${r.id}\nTriggered via ${r.event} ${ago(g, r.createdAt)}\n\nJOBS\n`;
  for (const j of r.jobs) {
    s += `${mark(j.conclusion, j.status)} ${j.name}${j.status === 'completed' && j.conclusion !== 'skipped' ? ` in ${j.seconds}s` : j.status === 'waiting' ? ` (waiting for approval: ${j.environment})` : ''} (ID ${j.id})\n`;
    if (verbose || j.conclusion === 'failure') for (const st of j.steps) s += `  ${mark(st.conclusion)} ${st.name}\n`;
  }
  const ann = r.annotations;
  if (ann.length) {
    s += `\nANNOTATIONS\n`;
    for (const a of ann) s += `${a.level === 'error' ? 'X' : '!'} ${a.message}\n${a.job}${a.file ? `: ${a.file}${a.line ? '#' + a.line : ''}` : ''}\n\n`;
  }
  if (r.artifacts.length) s += `\nARTIFACTS\n${r.artifacts.map((a) => a.name).join('\n')}\n`;
  if (r.status === 'waiting') s += `\nThis run is waiting for a reviewer to approve the "${r.jobs.find((j) => j.status === 'waiting')?.environment}" environment.\n`;
  if (r.conclusion === 'failure') s += `\nTo see what failed, try: gh run view ${r.id} --log-failed\n`;
  s += `View this run on ${g.db.host}: https://${g.db.host}/${r.repo}/actions/runs/${r.id}\n`;
  return s;
}

/** Re-runs a workflow run (all jobs, or only failed ones), or resumes it after an approval. */
function rerun(g: Gh, r: CiRun, onlyFailed: boolean, approved?: string[]): CiRun | null {
  const st = repoState(g.ctx, r.pr ? g.db.prs.find((p) => p.repo === r.repo && p.number === r.pr)?.headRepo ?? r.repo : r.repo);
  const c = st.commits[r.sha];
  if (!c) return null;
  const wf = readWorkflows(c.tree).find((w) => w.path === r.file);
  if (!wf) return null;
  const repo = g.db.repos[r.repo];
  const pr = r.pr ? g.db.prs.find((p) => p.repo === r.repo && p.number === r.pr) : undefined;
  const keep: CiRun | undefined = onlyFailed || approved ? { ...r, jobs: r.jobs.filter((j) => j.status === 'completed' && (approved ? true : j.conclusion === 'success')) } : undefined;
  const input: CiInput = {
    ctx: g.ctx,
    repo: r.repo,
    files: c.tree,
    exec: c.x ?? [],
    history: st,
    event: r.event,
    ref: pr ? `refs/pull/${pr.number}/merge` : r.branch && st.tags[r.branch] ? `refs/tags/${r.branch}` : `refs/heads/${r.branch}`,
    sha: r.sha,
    actor: g.user,
    secrets: pr && pr.headRepo !== pr.repo ? {} : { ...repo.secrets },
    vars: { ...repo.variables },
    inputs: r.inputs,
    pr: pr ? { number: pr.number, base: pr.base, head: pr.head, title: pr.title } : undefined,
    cache: (g.db.cache[r.repo] ??= {}),
    environments: repo.environments,
    approved,
    serverUrl: `https://${g.db.host}`,
    runId: r.id,
    runNumber: r.number,
    previous: keep ? { ...keep, attempt: approved ? r.attempt : r.attempt + 1 } : { ...r, jobs: [], attempt: r.attempt + 1 },
    title: r.title,
  };
  const next = runWorkflow(input, wf);
  next.createdAt = r.createdAt;
  const runs = g.db.runs as CiRun[];
  runs[runs.findIndex((x) => x.id === r.id)] = next;
  return next;
}

function ghRun(g: Gh, sub: string, args: string[]): number {
  const { key, local } = targetRepo(g, args);
  const io = g.io;
  const db = g.db;
  ensureBranchRuns(g.ctx, db, key);
  const runs = (db.runs as CiRun[]).filter((r) => r.repo === key);
  const pos = positional(args, ['-w', '--workflow', '-b', '--branch', '-L', '--limit', '-s', '--status', '-e', '--event', '-c', '--commit', '--json', '--jq', '-q', '-j', '--job', '-n', '--name', '-D', '--dir', '-u', '--user']);
  const byId = (id: string | undefined) => (id ? runs.find((r) => r.id === Number(id)) ?? fail(`HTTP 404: Not Found (https://${db.host}/api/v3/repos/${key}/actions/runs/${id})`) : latestRunFor(g, key, local));
  switch (sub) {
    case 'list': {
      let list = [...runs].reverse();
      const wf = flagVal(args, '-w', '--workflow');
      if (wf) list = list.filter((r) => r.workflow === wf || r.file.endsWith('/' + wf));
      const b = flagVal(args, '-b', '--branch');
      if (b) list = list.filter((r) => r.branch === b);
      const e = flagVal(args, '-e', '--event');
      if (e) list = list.filter((r) => r.event === e);
      const s = flagVal(args, '-s', '--status');
      if (s) list = list.filter((r) => r.status === s || r.conclusion === s);
      const c = flagVal(args, '-c', '--commit');
      if (c) list = list.filter((r) => r.sha.startsWith(c));
      list = list.slice(0, Number(flagVal(args, '-L', '--limit') ?? 20));
      if (jsonOut(g, args, list.map(runJson))) return 0;
      if (!list.length) {
        io.err('no runs found\n');
        return 0;
      }
      const tw = Math.max(5, ...list.map((r) => r.title.length));
      const ww = Math.max(8, ...list.map((r) => r.workflow.length));
      const bw = Math.max(6, ...list.map((r) => r.branch.length));
      io.out(`${'STATUS'.padEnd(7)} ${'TITLE'.padEnd(tw)}  ${'WORKFLOW'.padEnd(ww)}  ${'BRANCH'.padEnd(bw)}  ${'EVENT'.padEnd(12)}  ${'ID'.padEnd(5)}  ELAPSED  AGE\n`);
      for (const r of list) io.out(`${mark(r.conclusion, r.status).padEnd(7)} ${r.title.padEnd(tw)}  ${r.workflow.padEnd(ww)}  ${r.branch.padEnd(bw)}  ${r.event.padEnd(12)}  ${String(r.id).padEnd(5)}  ${(r.jobs.reduce((n, j) => n + j.seconds, 0) + 's').padEnd(7)}  ${ago(g, r.createdAt)}\n`);
      return 0;
    }
    case 'view': {
      const jobArg = flagVal(args, '-j', '--job');
      const r = jobArg ? runs.find((x) => x.jobs.some((j) => j.id === Number(jobArg))) ?? fail(`HTTP 404: Not Found`) : byId(pos[0]);
      if (jsonOut(g, args, runJson(r!))) return 0;
      if (hasFlag(args, '--log') || hasFlag(args, '--log-failed')) {
        const view = jobArg ? { ...r!, jobs: r!.jobs.filter((j) => j.id === Number(jobArg)) } : r!;
        io.out(runLogText(view, hasFlag(args, '--log-failed')));
        return 0;
      }
      io.out(runSummary(g, r!, hasFlag(args, '-v', '--verbose')));
      return hasFlag(args, '--exit-status') && r!.conclusion !== 'success' ? 1 : 0;
    }
    case 'watch': {
      const r = byId(pos[0]);
      io.out(runSummary(g, r!, false));
      io.out(`\n${mark(r!.conclusion, r!.status)} Run ${r!.workflow} (${r!.id}) ${r!.status === 'completed' ? `completed with '${r!.conclusion}'` : `is ${r!.status}`}\n`);
      return hasFlag(args, '--exit-status') && r!.conclusion !== 'success' ? 1 : 0;
    }
    case 'rerun': {
      const r = byId(pos[0]);
      const next = rerun(g, r!, hasFlag(args, '--failed'));
      if (!next) fail('the workflow file is no longer in that commit');
      saveDb(g.ctx, db);
      io.err(`✓ Requested rerun${hasFlag(args, '--failed') ? ' (failed jobs)' : ''} of run ${r!.id}\n`);
      tryAutoMerge(g.ctx, io);
      return 0;
    }
    case 'cancel': {
      const r = byId(pos[0]);
      if (r!.status === 'completed') fail(`Cannot cancel a workflow run that is completed`);
      r!.status = 'completed';
      r!.conclusion = 'cancelled';
      for (const j of r!.jobs) if (j.status !== 'completed') Object.assign(j, { status: 'completed', conclusion: 'cancelled' });
      saveDb(g.ctx, db);
      io.err(`✓ Request to cancel workflow ${r!.id} submitted.\n`);
      return 0;
    }
    case 'delete': {
      const r = byId(pos[0]);
      db.runs = (db.runs as CiRun[]).filter((x) => x.id !== r!.id);
      saveDb(g.ctx, db);
      io.err(`✓ Request to delete workflow run submitted.\n`);
      return 0;
    }
    case 'download': {
      const r = byId(pos[0]);
      const names = flagVals(args, '-n', '--name');
      const dir = abs(g.ctx, flagVal(args, '-D', '--dir') ?? '.');
      const arts = r!.artifacts.filter((a) => !names.length || names.includes(a.name));
      if (!arts.length) fail(names.length ? `no artifact matches any of the names or patterns provided` : 'no valid artifacts found to download');
      for (const a of arts) {
        const into = arts.length > 1 || !names.length ? `${dir}/${a.name}` : dir;
        for (const [p, c] of Object.entries(a.files)) {
          const full = `${into}/${p}`;
          mkdir(g.ctx.sys.fs, full.slice(0, full.lastIndexOf('/')), actor(g.ctx), g.ctx.sys.now, true);
          writeFile(g.ctx.sys.fs, full, c, actor(g.ctx), g.ctx.sys.now);
        }
      }
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh run"`);
}

function ghWorkflow(g: Gh, sub: string, args: string[]): number {
  const { key, repo, local } = targetRepo(g, args);
  const io = g.io;
  const st = repoState(g.ctx, key);
  const tip = st.branches[flagVal(args, '-r', '--ref') ?? repo.defaultBranch];
  const files = tip ? st.commits[tip].tree : {};
  const wfs = readWorkflows(files);
  const pos = positional(args, ['-r', '--ref', '-f', '--raw-field', '-F', '--field', '--json']);
  const find = (n: string | undefined) => wfs.find((w) => w.name === n || w.path === n || w.path.endsWith('/' + n)) ?? fail(`could not find any workflows named ${n}`);
  switch (sub) {
    case 'list':
      for (const w of wfs) io.out(`${w.name}\t${repo.disabledWorkflows?.includes(w.path) ? 'disabled_manually' : 'active'}\t${1000 + wfs.indexOf(w)}\n`);
      return 0;
    case 'view': {
      const w = find(pos[0]);
      if (hasFlag(args, '-y', '--yaml')) {
        io.out(files[w!.path]);
        return 0;
      }
      const runs = (g.db.runs as CiRun[]).filter((r) => r.repo === key && r.file === w!.path).reverse();
      io.out(`${w!.name} - ${w!.path.split('/').pop()}\nID: ${1000 + wfs.indexOf(w!)}\n\nTotal runs ${runs.length}\nRecent runs\n${runs.slice(0, 5).map((r) => `${mark(r.conclusion, r.status)}  ${r.title}  ${r.branch}  ${r.event}  ${r.id}\n`).join('')}\nTo see more runs for this workflow, try: gh run list --workflow ${w!.path.split('/').pop()}\nTo see the YAML for this workflow, try: gh workflow view ${w!.path.split('/').pop()} --yaml\n`);
      return 0;
    }
    case 'run': {
      const w = find(pos[0]);
      if (!triggers(w!.doc, 'workflow_dispatch', `refs/heads/${repo.defaultBranch}`)) fail(`could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://${g.db.host}/api/v3/repos/${key}/actions/workflows/${w!.path.split('/').pop()}/dispatches)`);
      const inputs: Record<string, string> = {};
      const declared = yMap(yMap(yMap(w!.doc.on ?? w!.doc.true).workflow_dispatch).inputs);
      for (const [k, d] of Object.entries(declared)) if (yStr(yMap(d).default)) inputs[k] = yStr(yMap(d).default);
      for (const kv of [...flagVals(args, '-f', '--raw-field'), ...flagVals(args, '-F', '--field')]) {
        const eq = kv.indexOf('=');
        inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      for (const [k, d] of Object.entries(declared)) if (yStr(yMap(d).required) === 'true' && !inputs[k]) fail(`could not create workflow dispatch event: HTTP 422: Required input '${k}' not provided`);
      const ref = flagVal(args, '-r', '--ref') ?? repo.defaultBranch;
      const sha = st.branches[ref] ?? fail(`could not create workflow dispatch event: HTTP 422: No ref found for: ${ref}`);
      triggerRuns(g.ctx, g.db, key, 'workflow_dispatch', `refs/heads/${ref}`, sha!, g.user, undefined, undefined, inputs, w!.path);
      saveDb(g.ctx, g.db);
      io.err(`✓ Created workflow_dispatch event for ${w!.path.split('/').pop()} at ${ref}\n\nTo see runs for this workflow, try: gh run list --workflow=${w!.path.split('/').pop()}\n`);
      return 0;
    }
    case 'disable':
    case 'enable': {
      const w = find(pos[0]);
      repo.disabledWorkflows ??= [];
      if (sub === 'disable') repo.disabledWorkflows.push(w!.path);
      else repo.disabledWorkflows = repo.disabledWorkflows.filter((p) => p !== w!.path);
      saveDb(g.ctx, g.db);
      io.err(`✓ ${sub === 'disable' ? 'Disabled' : 'Enabled'} ${w!.name}\n`);
      return 0;
    }
  }
  void local;
  return fail(`unknown command "${sub}" for "gh workflow"`);
}

function ghSecret(g: Gh, sub: string, args: string[], kind: 'secret' | 'variable'): number {
  const { key, repo } = targetRepo(g, args);
  if (roleOf(repo, g.user) < 5) fail(`HTTP 403: Must have admin rights to Repository. (https://${g.db.host}/api/v3/repos/${key}/actions/${kind}s)`);
  const io = g.io;
  const envName = flagVal(args, '-e', '--env');
  const store = envName ? ((repo.environments[envName] ??= { id: (g.db.envCounter = (g.db.envCounter ?? 1) + 1) })[kind === 'secret' ? 'secrets' : 'vars'] ??= {}) : kind === 'secret' ? repo.secrets : repo.variables;
  const pos = positional(args, ['-b', '--body', '-e', '--env', '-a', '--app', '-f', '--env-file', '--json']);
  switch (sub) {
    case 'set': {
      const name = pos[0] ?? fail(`must pass name argument`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name!) || /^GITHUB_/i.test(name!)) fail(`${kind === 'secret' ? 'Secret' : 'Variable'} names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or underscores (_). Spaces are not allowed. Must start with a letter ([a-z], [A-Z]) or underscores (_). Cannot start with GITHUB_.`);
      const value = flagVal(args, '-b', '--body') ?? g.io.stdin.replace(/\n$/, '');
      if (!value) fail(`no ${kind} value given: use --body or pipe it on standard input`);
      store[name!] = value;
      saveDb(g.ctx, g.db);
      io.err(`✓ Set Actions ${kind} ${name} for ${envName ? `environment ${envName} in ` : ''}${key}\n`);
      return 0;
    }
    case 'list':
      for (const k of Object.keys(store).sort()) io.out(kind === 'secret' ? `${k}\tUpdated ${new Date(g.ctx.sys.now).toISOString().slice(0, 10)}\n` : `${k}\t${store[k]}\tUpdated ${new Date(g.ctx.sys.now).toISOString().slice(0, 10)}\n`);
      return 0;
    case 'get':
      if (kind === 'secret') fail('secrets cannot be read back; set them again to change them');
      io.out((store[pos[0]] ?? fail(`variable ${pos[0]} was not found`)) + '\n');
      return 0;
    case 'delete':
    case 'remove': {
      if (store[pos[0]] === undefined) fail(`failed to delete ${kind} ${pos[0]}: HTTP 404: Not Found`);
      delete store[pos[0]];
      saveDb(g.ctx, g.db);
      io.err(`✓ Deleted Actions ${kind} ${pos[0]} from ${key}\n`);
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh ${kind}"`);
}

function ghRelease(g: Gh, sub: string, args: string[]): number {
  const { key, repo, local } = targetRepo(g, args);
  const io = g.io;
  const db = g.db;
  const pos = positional(args, ['-t', '--title', '-n', '--notes', '-F', '--notes-file', '--target', '-p', '--pattern', '-D', '--dir', '-A', '--archive', '-L', '--limit', '--json', '--jq', '-q', '--notes-start-tag']);
  const find = (tag: string | undefined) => db.releases.find((r) => r.repo === key && r.tag === tag) ?? fail('release not found');
  switch (sub) {
    case 'create': {
      if (roleOf(repo, g.user) < 3) fail(`HTTP 403: Resource not accessible`);
      const tag = pos[0] ?? fail('could not create: no tag name provided');
      if (db.releases.some((r) => r.repo === key && r.tag === tag)) fail(`a release with the same tag name already exists: ${tag}`);
      const path = forgeRepoPath(key);
      const st = loadGit(g.ctx, path);
      if (!st.tags[tag!]) {
        if (hasFlag(args, '--verify-tag')) fail(`tag ${tag} doesn't exist in the repo ${key}, aborting due to --verify-tag flag`);
        const target = flagVal(args, '--target') ?? repo.defaultBranch;
        const id = st.branches[target] ?? (Object.keys(st.commits).find((c) => c.startsWith(target)) as string | undefined) ?? fail(`HTTP 422: Validation Failed: target_commitish is invalid`);
        st.tags[tag!] = id!;
        saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st }, ROOT);
      }
      let notes = flagVal(args, '-n', '--notes') ?? (flagVal(args, '-F', '--notes-file') ? readFile(g.ctx.sys.fs, abs(g.ctx, flagVal(args, '-F', '--notes-file')!), actor(g.ctx)) : '');
      if (hasFlag(args, '--generate-notes')) {
        const prev = [...db.releases].filter((r) => r.repo === key && !r.draft).sort((a, b) => b.createdAt - a.createdAt)[0];
        const since = prev ? st.tags[prev.tag] : null;
        const reach = since ? ancestors(st, since) : new Set<string>();
        const prs = db.prs.filter((p) => p.repo === key && p.state === 'MERGED' && p.mergeCommit && !reach.has(p.mergeCommit) && ancestors(st, st.tags[tag!]).has(p.mergeCommit));
        notes = `${notes ? notes + '\n\n' : ''}## What's Changed\n${prs.map((p) => `* ${p.title} by @${p.author} in https://${db.host}/${key}/pull/${p.number}`).join('\n') || '* No pull requests were merged'}\n\n**Full Changelog**: https://${db.host}/${key}/${prev ? `compare/${prev.tag}...${tag}` : `commits/${tag}`}`;
      }
      const assets: Record<string, string> = {};
      for (const f of pos.slice(1)) {
        const [file, label] = f.split('#');
        try {
          assets[file.split('/').pop()!] = readFile(g.ctx.sys.fs, abs(g.ctx, file), actor(g.ctx));
          void label;
        } catch {
          fail(`could not open ${file}: no such file or directory`);
        }
      }
      const rel: ForgeRelease = { repo: key, tag: tag!, name: flagVal(args, '-t', '--title') ?? tag!, notes, author: g.user, draft: hasFlag(args, '-d', '--draft'), prerelease: hasFlag(args, '-p', '--prerelease'), assets, createdAt: g.ctx.sys.now, target: flagVal(args, '--target') ?? repo.defaultBranch };
      db.releases.push(rel);
      if (!rel.draft) triggerRuns(g.ctx, db, key, 'release', `refs/tags/${tag}`, loadGit(g.ctx, path).tags[tag!], g.user);
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/releases/tag/${tag}\n`);
      return 0;
    }
    case 'list': {
      const list = db.releases.filter((r) => r.repo === key).sort((a, b) => b.createdAt - a.createdAt);
      if (jsonOut(g, args, list.map((r, i) => ({ tagName: r.tag, name: r.name, isDraft: r.draft, isPrerelease: r.prerelease, isLatest: i === 0 && !r.draft && !r.prerelease, createdAt: new Date(r.createdAt).toISOString() })))) return 0;
      const latest = list.find((r) => !r.draft && !r.prerelease);
      for (const r of list) io.out(`${r.name}\t${r.draft ? 'Draft' : r.prerelease ? 'Pre-release' : r === latest ? 'Latest' : ''}\t${r.tag}\t${ago(g, r.createdAt)}\n`);
      return 0;
    }
    case 'view': {
      const r = pos[0] ? find(pos[0]) : db.releases.filter((x) => x.repo === key && !x.draft).sort((a, b) => b.createdAt - a.createdAt)[0] ?? fail('release not found');
      if (jsonOut(g, args, { tagName: r!.tag, name: r!.name, body: r!.notes, isDraft: r!.draft, assets: Object.keys(r!.assets).map((name) => ({ name })) })) return 0;
      io.out(`${r!.name}\n${r!.author} released this ${ago(g, r!.createdAt)}\n\n${r!.notes ? r!.notes.split('\n').map((l) => '  ' + l).join('\n') + '\n\n' : ''}${Object.keys(r!.assets).length ? `Assets\n${Object.entries(r!.assets).map(([n, c]) => `${n}\t${c.length} B\n`).join('')}\n` : ''}View on ${db.host}: https://${db.host}/${key}/releases/tag/${r!.tag}\n`);
      return 0;
    }
    case 'download': {
      const r = pos[0] ? find(pos[0]) : db.releases.filter((x) => x.repo === key && !x.draft).sort((a, b) => b.createdAt - a.createdAt)[0] ?? fail('release not found');
      const dir = abs(g.ctx, flagVal(args, '-D', '--dir') ?? '.');
      const pats = flagVals(args, '-p', '--pattern');
      const archive = flagVal(args, '-A', '--archive');
      mkdir(g.ctx.sys.fs, dir, actor(g.ctx), g.ctx.sys.now, true);
      if (archive) {
        const prefix = `${repo.name}-${r!.tag.replace(/^v/, '')}`;
        const st = repoState(g.ctx, key);
        const tree = st.commits[st.tags[r!.tag]].tree;
        const stage = `/tmp/.release-${g.ctx.sys.nextPid++}`;
        for (const [p, c] of Object.entries(tree)) {
          const full = `${stage}/${prefix}/${p}`;
          mkdir(g.ctx.sys.fs, full.slice(0, full.lastIndexOf('/')), actor(g.ctx), g.ctx.sys.now, true);
          writeFile(g.ctx.sys.fs, full, c, actor(g.ctx), g.ctx.sys.now);
        }
        const out = `${dir}/${prefix}.${archive === 'zip' ? 'zip' : 'tar.gz'}`;
        const cwd = g.ctx.sys.cwd;
        g.ctx.sys.cwd = stage;
        try {
          runCommand(g.ctx, archive === 'zip' ? ['zip', '-qr', out, prefix] : ['tar', '-czf', out, prefix], io);
        } finally {
          g.ctx.sys.cwd = cwd;
        }
        return 0;
      }
      const names = Object.keys(r!.assets).filter((n) => !pats.length || pats.some((p) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(n)));
      if (!names.length) fail('no assets to download');
      for (const n of names) {
        const target = `${dir}/${n}`;
        if (lookup(g.ctx.sys.fs, target, ROOT) && !hasFlag(args, '--clobber', '--skip-existing')) fail(`${target} already exists (use --clobber to overwrite file or --skip-existing to skip file)`);
        writeFile(g.ctx.sys.fs, target, r!.assets[n], actor(g.ctx), g.ctx.sys.now);
      }
      return 0;
    }
    case 'upload': {
      const r = find(pos[0]);
      for (const f of pos.slice(1)) {
        const name = f.split('/').pop()!;
        if (r!.assets[name] !== undefined && !hasFlag(args, '--clobber')) fail(`asset under the same name already exists: [${name}]`);
        r!.assets[name] = readFile(g.ctx.sys.fs, abs(g.ctx, f), actor(g.ctx));
      }
      saveDb(g.ctx, db);
      io.err(`Successfully uploaded ${plural(pos.length - 1, 'asset')} to ${r!.tag}\n`);
      return 0;
    }
    case 'delete': {
      const r = find(pos[0]);
      if (!hasFlag(args, '-y', '--yes')) fail(`--yes required when not running interactively`);
      db.releases = db.releases.filter((x) => x !== r);
      if (hasFlag(args, '--cleanup-tag')) {
        const path = forgeRepoPath(key);
        const st = loadGit(g.ctx, path);
        delete st.tags[r!.tag];
        saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st }, ROOT);
      }
      saveDb(g.ctx, db);
      io.err(`✓ Deleted release ${r!.tag}\n`);
      return 0;
    }
    case 'edit': {
      const r = find(pos[0]);
      const t = flagVal(args, '-t', '--title');
      const n = flagVal(args, '-n', '--notes');
      if (t) r!.name = t;
      if (n !== undefined) r!.notes = n;
      if (hasFlag(args, '--draft=false')) r!.draft = false;
      if (hasFlag(args, '--prerelease=false')) r!.prerelease = false;
      saveDb(g.ctx, db);
      io.out(`https://${db.host}/${key}/releases/tag/${r!.tag}\n`);
      return 0;
    }
  }
  void local;
  return fail(`unknown command "${sub}" for "gh release"`);
}

function ghRepo(g: Gh, sub: string, args: string[]): number {
  const io = g.io;
  const db = g.db;
  const pos = positional(args, ['-d', '--description', '--source', '-s', '--remote', '-r', '--json', '--jq', '-q', '--default-branch', '--visibility', '-L', '--limit', '--fork-name', '--org', '-t', '--template']);
  const git = (a: string[], quiet = false) => runCommand(g.ctx, ['git', ...a], quiet ? { stdin: '', out: () => {}, err: () => {} } : io);
  switch (sub) {
    case 'create': {
      let name: string | undefined = pos[0];
      const source = flagVal(args, '-s', '--source');
      if (!name && source) name = abs(g.ctx, source).split('/').pop();
      if (!name) fail('at least one argument required in non-interactive mode');
      const full = name!.includes('/') ? name! : `${g.user}/${name}`;
      if (db.repos[full]) fail(`GraphQL: Name already exists on this account (createRepository)`);
      const visibility = hasFlag(args, '--public') ? 'public' : hasFlag(args, '--internal') ? 'internal' : hasFlag(args, '--private') ? 'private' : fail('`--public`, `--private`, or `--internal` required when not running interactively');
      const [owner, rname] = full.split('/');
      db.repos[full] = { owner, name: rname, visibility: visibility as ForgeRepo['visibility'], members: { [g.user]: 'admin' }, description: flagVal(args, '-d', '--description'), defaultBranch: 'main', protection: {}, secrets: {}, variables: {}, environments: {}, labels: ['bug', 'documentation', 'enhancement'] };
      db.counters[full] = 1;
      const path = forgeRepoPath(full);
      mkdir(g.ctx.sys.fs, path, ROOT, g.ctx.sys.now, true);
      const st: GitState = { head: { branch: 'main' }, branches: {}, commits: {}, index: {}, config: {}, tags: {}, bare: true };
      if (hasFlag(args, '--add-readme')) {
        const body = { parents: [], message: 'Initial commit', author: db.users[g.user].name, email: db.users[g.user].email, time: g.ctx.sys.now, tree: { 'README.md': `# ${rname}\n${flagVal(args, '-d', '--description') ? '\n' + flagVal(args, '-d', '--description') + '\n' : ''}` } };
        const id = commitId(body);
        st.commits[id] = { id, seq: 1, ...body };
        st.branches.main = id;
      }
      saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st }, ROOT);
      saveDb(g.ctx, db);
      const url = urlFor(db, full, g.protocol);
      io.err(`✓ Created repository ${full} on ${db.host}\n  https://${db.host}/${full}\n`);
      if (source) {
        const dir = abs(g.ctx, source);
        const remote = flagVal(args, '-r', '--remote') ?? 'origin';
        const cwd = g.ctx.sys.cwd;
        g.ctx.sys.cwd = dir;
        try {
          git(['remote', 'add', remote, url], true);
          io.err(`✓ Added remote ${url}\n`);
          if (hasFlag(args, '--push')) {
            const code = git(['push', '-u', remote, 'HEAD'], true);
            if (code) fail(`failed to push: run "git push -u ${remote} HEAD" to see why`);
            io.err(`✓ Pushed commits to ${url}\n`);
          }
        } finally {
          g.ctx.sys.cwd = cwd;
        }
      } else if (hasFlag(args, '-c', '--clone')) git(['clone', url]);
      return 0;
    }
    case 'clone': {
      const spec = pos[0] ?? fail('cannot clone: repository argument required');
      const full = spec!.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').includes('/') ? spec!.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '') : `${g.user}/${spec}`;
      const repo = db.repos[full];
      if (!repo || roleOf(repo, g.user) < 1) fail(`GraphQL: Could not resolve to a Repository with the name '${full}'. (repository)`);
      const code = git(['clone', urlFor(db, full, g.protocol), ...(pos[1] ? [pos[1]] : [])]);
      if (code) return code;
      if (repo.forkOf) {
        const dir = abs(g.ctx, pos[1] ?? repo.name);
        const cwd = g.ctx.sys.cwd;
        g.ctx.sys.cwd = dir;
        try {
          git(['remote', 'add', 'upstream', urlFor(db, repo.forkOf, g.protocol)], true);
          git(['fetch', 'upstream'], true);
        } finally {
          g.ctx.sys.cwd = cwd;
        }
        io.err(`! Repository ${repo.forkOf} set as the default repository. To learn more or change the selection, see: gh repo set-default\n`);
      }
      return 0;
    }
    case 'fork': {
      const dir = findRepo(g.ctx);
      const local = dir ? openRepo(g.ctx, io, dir) : null;
      let full = pos[0];
      if (!full) {
        const o = local?.st.remotes?.origin ? parseForgeUrl(local.st.remotes.origin.url) : null;
        full = o?.full ?? fail('no repository given and the current directory has no forge remote');
      }
      const src = db.repos[full!] ?? fail(`GraphQL: Could not resolve to a Repository with the name '${full}'. (repository)`);
      const forkName = `${g.user}/${flagVal(args, '--fork-name') ?? src!.name}`;
      if (db.repos[forkName]) io.err(`! ${forkName} already exists\n`);
      else {
        db.repos[forkName] = { ...JSON.parse(JSON.stringify(src)), owner: g.user, name: forkName.split('/')[1], members: { [g.user]: 'admin' }, protection: {}, secrets: {}, variables: {}, environments: {}, forkOf: full, visibility: src!.visibility };
        db.counters[forkName] = 1;
        const st = repoState(g.ctx, full!);
        const path = forgeRepoPath(forkName);
        mkdir(g.ctx.sys.fs, path, ROOT, g.ctx.sys.now, true);
        saveRepo({ ctx: g.ctx, io, root: path, gitDir: path, bare: true, st: { ...st, bare: true } }, ROOT);
        saveDb(g.ctx, db);
        io.err(`✓ Created fork ${forkName}\n`);
      }
      if (local && (hasFlag(args, '--remote') || !pos[0])) {
        const cwd = g.ctx.sys.cwd;
        g.ctx.sys.cwd = local.root;
        try {
          git(['remote', 'rename', 'origin', 'upstream'], true);
          git(['remote', 'add', 'origin', urlFor(db, forkName, g.protocol)], true);
        } finally {
          g.ctx.sys.cwd = cwd;
        }
        io.err(`✓ Renamed remote origin to upstream\n✓ Added remote origin\n`);
      } else if (hasFlag(args, '--clone')) {
        git(['clone', urlFor(db, forkName, g.protocol)]);
        const cwd = g.ctx.sys.cwd;
        g.ctx.sys.cwd = abs(g.ctx, forkName.split('/')[1]);
        try {
          git(['remote', 'add', 'upstream', urlFor(db, full!, g.protocol)], true);
          git(['fetch', 'upstream'], true);
        } finally {
          g.ctx.sys.cwd = cwd;
        }
        io.err(`✓ Cloned fork\n`);
      }
      return 0;
    }
    case 'view': {
      const { key, repo } = targetRepo(g, pos[0] ? ['-R', pos[0]] : args);
      const st = repoState(g.ctx, key);
      const tip = st.branches[repo.defaultBranch];
      if (jsonOut(g, args, { name: repo.name, nameWithOwner: key, owner: { login: repo.owner }, visibility: repo.visibility.toUpperCase(), description: repo.description ?? '', defaultBranchRef: { name: repo.defaultBranch }, isFork: !!repo.forkOf, parent: repo.forkOf ? { nameWithOwner: repo.forkOf } : null, url: `https://${db.host}/${key}`, sshUrl: `git@${db.host}:${key}.git` })) return 0;
      io.out(`name:\t${key}\ndescription:\t${repo.description ?? ''}\n--\n${tip && st.commits[tip].tree['README.md'] ? st.commits[tip].tree['README.md'] : `${key} does not have a README`}\n\nView this repository on ${db.host}: https://${db.host}/${key}\n`);
      return 0;
    }
    case 'list': {
      const owner = pos[0] ?? g.user;
      const list = Object.entries(db.repos).filter(([k, r]) => k.startsWith(owner + '/') && roleOf(r, g.user) >= 1);
      if (jsonOut(g, args, list.map(([k, r]) => ({ nameWithOwner: k, visibility: r.visibility.toUpperCase(), isFork: !!r.forkOf, description: r.description ?? '' })))) return 0;
      io.out(`\nShowing ${list.length} of ${list.length} repositories in @${owner}\n\n`);
      for (const [k, r] of list) io.out(`${k}\t${r.description ?? ''}\t${r.visibility}${r.forkOf ? ', fork' : ''}\n`);
      return 0;
    }
    case 'edit': {
      const { key, repo } = targetRepo(g, pos[0] ? ['-R', pos[0]] : args);
      if (roleOf(repo, g.user) < 5) fail(`HTTP 403: Must have admin rights to Repository.`);
      const db2 = flagVal(args, '--default-branch');
      if (db2) repo.defaultBranch = db2;
      const vis = flagVal(args, '--visibility');
      if (vis) {
        if (!hasFlag(args, '--accept-visibility-change-consequences')) fail('use of --visibility flag requires --accept-visibility-change-consequences flag');
        repo.visibility = vis as ForgeRepo['visibility'];
      }
      if (hasFlag(args, '--enable-auto-merge')) repo.allowAutoMerge = true;
      if (hasFlag(args, '--delete-branch-on-merge')) repo.deleteBranchOnMerge = true;
      if (hasFlag(args, '--enable-merge-commit=false')) repo.allowMergeCommit = false;
      const desc = flagVal(args, '-d', '--description');
      if (desc !== undefined) repo.description = desc;
      saveDb(g.ctx, db);
      io.err(`✓ Edited repository ${key}\n`);
      return 0;
    }
    case 'delete': {
      const { key, repo } = targetRepo(g, pos[0] ? ['-R', pos[0]] : args);
      if (roleOf(repo, g.user) < 5) fail(`HTTP 403: Must have admin rights to Repository.`);
      if (!hasFlag(args, '--yes')) fail('--yes required when not running interactively');
      delete db.repos[key];
      saveDb(g.ctx, db);
      io.err(`✓ Deleted repository ${key}\n`);
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh repo"`);
}

function ghAuth(ctx: Ctx, io: IO, sub: string, args: string[]): number {
  const home = homeOf(ctx.sys, currentUser(ctx));
  const hostsFile = `${home}/.config/gh/hosts.yml`;
  if (!forgeExists(ctx)) fail(`error connecting to ${FORGE_HOST}`);
  const db = loadDb(ctx);
  switch (sub) {
    case 'login': {
      if (!hasFlag(args, '--with-token')) fail(`--with-token required when not running interactively (pipe a token: gh auth login --with-token < token.txt)`);
      const token = io.stdin.trim();
      const who = userForToken(db, token);
      if (!who) fail(`error validating token: HTTP 401: Bad credentials (https://${FORGE_HOST}/api/v3/)\nTry authenticating with:  gh auth login`);
      if (!who!.scopes.includes('repo') || !who!.scopes.includes('read:org')) fail(`error validating token: missing required scope${!who!.scopes.includes('read:org') ? " 'read:org'" : " 'repo'"}`);
      const proto = flagVal(args, '-p', '--git-protocol') ?? 'https';
      mkdir(ctx.sys.fs, `${home}/.config/gh`, actor(ctx), ctx.sys.now, true);
      writeFile(ctx.sys.fs, hostsFile, `${FORGE_HOST}:\n    users:\n        ${who!.login}:\n            oauth_token: ${token}\n    git_protocol: ${proto}\n    oauth_token: ${token}\n    user: ${who!.login}\n`, actor(ctx), ctx.sys.now);
      const l = lookup(ctx.sys.fs, hostsFile, ROOT);
      if (l) l.node.mode = 0o600;
      return 0;
    }
    case 'status': {
      const login = ghLogin(ctx);
      if (!login) {
        io.err(`You are not logged into any GitHub hosts. To log in, run: gh auth login\n`);
        return 1;
      }
      const who = userForToken(db, login.token);
      if (!who) {
        io.out(`${FORGE_HOST}\n  X Failed to log in to ${FORGE_HOST} using token (${hostsFile})\n  - Active account: true\n  - The token in ${hostsFile} is invalid.\n  - To re-authenticate, run: gh auth login -h ${FORGE_HOST}\n`);
        return 1;
      }
      const shown = hasFlag(args, '-t', '--show-token') ? login.token : login.token.slice(0, 4) + '*'.repeat(login.token.length - 4);
      io.out(`${FORGE_HOST}\n  ✓ Logged in to ${FORGE_HOST} account ${who.login} (${ctx.exported.has('GH_TOKEN') ? 'GH_TOKEN' : hostsFile})\n  - Active account: true\n  - Git operations protocol: ${login.protocol}\n  - Token: ${shown}\n  - Token scopes: ${who.scopes.map((s) => `'${s}'`).join(', ')}\n`);
      return 0;
    }
    case 'token': {
      const login = ghLogin(ctx) ?? fail('no oauth token found for ' + FORGE_HOST);
      io.out(login!.token + '\n');
      return 0;
    }
    case 'logout': {
      if (!lookup(ctx.sys.fs, hostsFile, ROOT)) fail('not logged in to any hosts');
      writeFile(ctx.sys.fs, hostsFile, '', actor(ctx), ctx.sys.now);
      io.err(`✓ Logged out of ${FORGE_HOST}\n`);
      return 0;
    }
    case 'setup-git': {
      const file = `${home}/.gitconfig`;
      const map = readConfigFile(ctx, file);
      map[`credential.https://${FORGE_HOST}.helper`] = '!/usr/bin/gh auth git-credential';
      let text = '';
      try {
        text = readFile(ctx.sys.fs, file, actor(ctx));
      } catch {
        /* new */
      }
      if (!text.includes(`[credential "https://${FORGE_HOST}"]`)) text += `[credential "https://${FORGE_HOST}"]\n\thelper = \n\thelper = !/usr/bin/gh auth git-credential\n`;
      writeFile(ctx.sys.fs, file, text, actor(ctx), ctx.sys.now);
      return 0;
    }
    case 'git-credential': {
      const login = ghLogin(ctx);
      if (args[0] !== 'get' || !login) return 0;
      const who = userForToken(db, login.token);
      io.out(`protocol=https\nhost=${FORGE_HOST}\nusername=${who?.login ?? 'x-access-token'}\npassword=${login.token}\n`);
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh auth"`);
}

function ghSshKey(g: Gh, sub: string, args: string[]): number {
  const u = g.db.users[g.user];
  const pos = positional(args, ['-t', '--title', '--type']);
  switch (sub) {
    case 'add': {
      if (!g.scopes.includes('admin:public_key') && !g.scopes.includes('write:public_key')) fail(`HTTP 404: Not Found (https://${g.db.host}/api/v3/user/keys)\nThis API operation needs the "admin:public_key" scope. To request it, run:  gh auth refresh -h ${g.db.host} -s admin:public_key`);
      const text = (pos[0] ? readFile(g.ctx.sys.fs, abs(g.ctx, pos[0]), actor(g.ctx)) : g.io.stdin).trim();
      if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) \S+/.test(text)) fail('provided key is not in a valid format');
      if (text.includes('PRIVATE KEY')) fail('provided key is not in a valid format (that is a private key: add the .pub file)');
      if (Object.values(g.db.users).some((x) => x.keys.some((k) => keyId(k) === keyId(text)))) {
        g.io.err('✓ Public key already exists on your account\n');
        return 0;
      }
      u.keys.push(text);
      saveDb(g.ctx, g.db);
      g.io.err('✓ Public key added to your account\n');
      return 0;
    }
    case 'list':
      u.keys.forEach((k, i) => g.io.out(`${k.split(' ')[2] ?? 'key'}\t${k.split(' ')[0]} ${k.split(' ')[1].slice(0, 20)}...\t${1000 + i}\t${new Date(g.ctx.sys.now).toISOString().slice(0, 10)}\tauthentication\n`));
      return 0;
    case 'delete': {
      const i = Number(pos[0]) - 1000;
      if (!u.keys[i]) fail('HTTP 404: Not Found');
      u.keys.splice(i, 1);
      saveDb(g.ctx, g.db);
      g.io.err('✓ SSH key deleted from your account\n');
      return 0;
    }
  }
  return fail(`unknown command "${sub}" for "gh ssh-key"`);
}

/* ----------------------------------------------------------------------------- gh api */

function ghApi(g: Gh, args: string[]): number {
  const pos = positional(args, ['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '--jq', '-q', '-t', '--template']);
  let endpoint = (pos[0] ?? fail('must provide an endpoint')).replace(/^\//, '');
  const io = g.io;
  const db = g.db;
  const needsRepo = endpoint.includes('{owner}') || endpoint.includes('{repo}');
  if (needsRepo) {
    const { key } = targetRepo(g, args.filter((a) => a !== pos[0]));
    const [owner, repo] = key.split('/');
    endpoint = endpoint.replace('{owner}', owner).replace('{repo}', repo);
  }
  const fields: Record<string, unknown> = {};
  for (const kv of flagVals(args, '-f', '--raw-field')) fields[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  for (const kv of flagVals(args, '-F', '--field')) {
    const v = kv.slice(kv.indexOf('=') + 1);
    fields[kv.slice(0, kv.indexOf('='))] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^\d+$/.test(v) ? Number(v) : v;
  }
  const inputArg = flagVal(args, '--input');
  let body: Record<string, unknown> = fields;
  if (inputArg) body = JSON.parse(inputArg === '-' ? io.stdin : readFile(g.ctx.sys.fs, abs(g.ctx, inputArg), actor(g.ctx)));
  const method = (flagVal(args, '-X', '--method') ?? (Object.keys(body).length ? 'POST' : 'GET')).toUpperCase();
  const reply = (status: number, value: unknown): number => {
    if (status >= 400) {
      io.out(JSON.stringify(value) + '\n');
      io.err(`gh: ${(value as { message?: string }).message ?? 'error'} (HTTP ${status})\n`);
      return 1;
    }
    if (value === null) return 0;
    const jq = flagVal(args, '--jq', '-q');
    if (jq) for (const r of runJq(compile(jq), value as JqValue)) io.out((typeof r === 'string' ? r : formatJ(r, { compact: true })) + '\n');
    else io.out(JSON.stringify(value, null, 2) + '\n');
    return 0;
  };
  const notFound = () => reply(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  if (endpoint === 'user') return reply(200, { login: g.user, name: db.users[g.user].name, email: db.users[g.user].email, type: 'User' });
  if (endpoint === 'user/keys') return reply(200, db.users[g.user].keys.map((k, i) => ({ id: 1000 + i, key: keyId(k), title: k.split(' ')[2] ?? '' })));
  const m = /^repos\/([\w.-]+)\/([\w.-]+)(?:\/(.*))?$/.exec(endpoint.replace(/\?.*$/, ''));
  if (!m) return notFound();
  const key = `${m[1]}/${m[2]}`;
  const repo = db.repos[key];
  if (!repo || roleOf(repo, g.user) < 1) return notFound();
  const rest = m[3] ?? '';
  const admin = roleOf(repo, g.user) >= 5;
  const forbid = () => reply(403, { message: 'Must have admin rights to Repository.' });
  const st = repoState(g.ctx, key);
  if (!rest) {
    if (method === 'PATCH') {
      if (!admin) return forbid();
      if (body.default_branch) repo.defaultBranch = String(body.default_branch);
      if (body.delete_branch_on_merge !== undefined) repo.deleteBranchOnMerge = !!body.delete_branch_on_merge;
      if (body.allow_auto_merge !== undefined) repo.allowAutoMerge = !!body.allow_auto_merge;
      if (body.allow_merge_commit !== undefined) repo.allowMergeCommit = !!body.allow_merge_commit;
      if (body.visibility) repo.visibility = body.visibility as ForgeRepo['visibility'];
      if (body.description !== undefined) repo.description = String(body.description);
      saveDb(g.ctx, db);
    }
    return reply(200, { name: repo.name, full_name: key, owner: { login: repo.owner }, private: repo.visibility !== 'public', visibility: repo.visibility, default_branch: repo.defaultBranch, fork: !!repo.forkOf, description: repo.description ?? null, delete_branch_on_merge: !!repo.deleteBranchOnMerge, allow_auto_merge: !!repo.allowAutoMerge, allow_merge_commit: repo.allowMergeCommit !== false, html_url: `https://${db.host}/${key}`, ssh_url: `git@${db.host}:${key}.git`, clone_url: `https://${db.host}/${key}.git` });
  }
  let mm: RegExpExecArray | null;
  if (rest === 'branches') return reply(200, Object.entries(st.branches).filter(([, id]) => id).map(([name, id]) => ({ name, commit: { sha: id }, protected: !!protectionFor(repo, name) })));
  if ((mm = /^branches\/([^/]+)$/.exec(rest))) {
    const id = st.branches[mm[1]];
    return id ? reply(200, { name: mm[1], commit: { sha: id, commit: { message: st.commits[id].message } }, protected: !!protectionFor(repo, mm[1]) }) : notFound();
  }
  if ((mm = /^branches\/([^/]+)\/protection$/.exec(rest))) {
    const b = mm[1];
    if (method === 'GET') {
      const p = repo.protection[b];
      if (!p) return reply(404, { message: 'Branch not protected' });
      return reply(200, protectionJson(db, key, b, p));
    }
    if (!admin) return forbid();
    if (method === 'DELETE') {
      delete repo.protection[b];
      saveDb(g.ctx, db);
      return reply(204, null);
    }
    if (method === 'PUT') {
      const missing = ['required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions'].filter((k) => !(k in body));
      if (missing.length) return reply(422, { message: `Invalid request.\n\n${missing.map((k) => `"${k}" wasn't supplied.`).join('\n')}`, documentation_url: 'https://docs.github.com/rest/branches/branch-protection#update-branch-protection' });
      const rsc = body.required_status_checks as { strict?: boolean; contexts?: string[]; checks?: Array<{ context: string }> } | null;
      const rpr = body.required_pull_request_reviews as Protection['required_pull_request_reviews'];
      repo.protection[b] = {
        required_status_checks: rsc ? { strict: !!rsc.strict, contexts: rsc.contexts ?? rsc.checks?.map((c) => c.context) ?? [] } : null,
        required_pull_request_reviews: rpr ? { required_approving_review_count: Number(rpr.required_approving_review_count ?? 1), dismiss_stale_reviews: !!rpr.dismiss_stale_reviews, require_code_owner_reviews: !!rpr.require_code_owner_reviews } : null,
        enforce_admins: !!body.enforce_admins,
        allow_force_pushes: !!body.allow_force_pushes,
        allow_deletions: !!body.allow_deletions,
        required_linear_history: !!body.required_linear_history,
      };
      saveDb(g.ctx, db);
      return reply(200, protectionJson(db, key, b, repo.protection[b]));
    }
  }
  if ((mm = /^collaborators(?:\/([\w.-]+))?$/.exec(rest))) {
    if (!mm[1]) return reply(200, Object.entries(repo.members).map(([login, role]) => ({ login, role_name: role, permissions: { admin: role === 'admin', push: roleRank[role] >= 3, pull: true } })));
    if (method === 'PUT') {
      if (!admin) return forbid();
      if (!db.users[mm[1]]) return notFound();
      const perm = String(body.permission ?? 'push');
      repo.members[mm[1]] = (perm === 'push' ? 'write' : perm === 'pull' ? 'read' : perm) as Role;
      saveDb(g.ctx, db);
      return reply(201, { invitee: { login: mm[1] }, permissions: repo.members[mm[1]] });
    }
    if (method === 'DELETE') {
      if (!admin) return forbid();
      delete repo.members[mm[1]];
      saveDb(g.ctx, db);
      return reply(204, null);
    }
    return repo.members[mm[1]] ? reply(204, null) : notFound();
  }
  if ((mm = /^environments(?:\/([\w.-]+))?$/.exec(rest))) {
    if (!mm[1]) return reply(200, { total_count: Object.keys(repo.environments).length, environments: Object.entries(repo.environments).map(([name, e]) => ({ id: e.id, name, protection_rules: e.reviewers?.length ? [{ type: 'required_reviewers', reviewers: e.reviewers.map((r) => ({ type: 'User', reviewer: { login: r } })) }] : [] })) });
    if (method === 'PUT') {
      if (!admin) return forbid();
      const env = (repo.environments[mm[1]] ??= { id: (db.envCounter = (db.envCounter ?? 1) + 1) });
      const rv = body.reviewers as Array<{ type: string; id: number | string }> | undefined;
      if (rv) env.reviewers = rv.map((r) => String(typeof r.id === 'number' ? Object.keys(db.users)[r.id - 1] ?? r.id : r.id));
      if (body.prevent_self_review !== undefined) env.prevent_self_review = !!body.prevent_self_review;
      saveDb(g.ctx, db);
      return reply(200, { id: env.id, name: mm[1], protection_rules: env.reviewers?.length ? [{ type: 'required_reviewers', reviewers: env.reviewers.map((r) => ({ type: 'User', reviewer: { login: r } })) }] : [] });
    }
    const env = repo.environments[mm[1]];
    return env ? reply(200, { id: env.id, name: mm[1], reviewers: env.reviewers ?? [] }) : notFound();
  }
  if (rest === 'actions/runs') return reply(200, { total_count: (db.runs as CiRun[]).filter((r) => r.repo === key).length, workflow_runs: (db.runs as CiRun[]).filter((r) => r.repo === key).reverse().map((r) => ({ id: r.id, name: r.workflow, head_branch: r.branch, head_sha: r.sha, event: r.event, status: r.status, conclusion: r.conclusion, run_number: r.number, run_attempt: r.attempt })) });
  if ((mm = /^actions\/runs\/(\d+)(?:\/(jobs|pending_deployments|approvals))?$/.exec(rest))) {
    const run = (db.runs as CiRun[]).find((r) => r.repo === key && r.id === Number(mm![1]));
    if (!run) return notFound();
    if (!mm[2]) return reply(200, { id: run.id, name: run.workflow, status: run.status, conclusion: run.conclusion, head_branch: run.branch, head_sha: run.sha, event: run.event });
    if (mm[2] === 'jobs') return reply(200, { total_count: run.jobs.length, jobs: run.jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, steps: j.steps.map((s) => ({ name: s.name, conclusion: s.conclusion, number: s.number })) })) });
    const waitingEnvs = [...new Set(run.jobs.filter((j) => j.status === 'waiting').map((j) => j.environment!))];
    if (method === 'GET') return reply(200, waitingEnvs.map((e) => ({ environment: { id: repo.environments[e]?.id, name: e }, current_user_can_approve: !!repo.environments[e]?.reviewers?.includes(g.user), reviewers: (repo.environments[e]?.reviewers ?? []).map((r) => ({ type: 'User', reviewer: { login: r } })) })));
    const ids = ((body.environment_ids as Array<number | string>) ?? []).map(Number);
    const envs = waitingEnvs.filter((e) => ids.includes(repo.environments[e]?.id));
    if (!envs.length) return reply(422, { message: 'No pending deployments for the given environment ids' });
    for (const e of envs) {
      if (!repo.environments[e]?.reviewers?.includes(g.user)) return reply(422, { message: `${g.user} is not a required reviewer for environment ${e}` });
      if (repo.environments[e]?.prevent_self_review && run.actor === g.user) return reply(422, { message: 'Self-review is not allowed for this environment' });
    }
    if (String(body.state) === 'rejected') {
      for (const j of run.jobs) if (j.status === 'waiting' && envs.includes(j.environment!)) Object.assign(j, { status: 'completed', conclusion: 'failure' });
      for (const j of run.jobs) if (j.status === 'pending') Object.assign(j, { status: 'completed', conclusion: 'skipped' });
      run.status = 'completed';
      run.conclusion = 'failure';
      saveDb(g.ctx, db);
      return reply(200, envs.map((e) => ({ environment: e, state: 'rejected' })));
    }
    const next = rerun(g, run, false, envs);
    saveDb(g.ctx, db);
    return reply(200, envs.map((e) => ({ environment: e, state: 'approved', run_status: next?.status })));
  }
  if (rest === 'pulls') return reply(200, db.prs.filter((p) => p.repo === key && (fields.state === 'all' || p.state === 'OPEN')).map((p) => ({ number: p.number, title: p.title, state: p.state === 'OPEN' ? 'open' : 'closed', merged: p.state === 'MERGED', user: { login: p.author }, head: { ref: p.head }, base: { ref: p.base } })));
  if ((mm = /^pulls\/(\d+)(?:\/(reviews|merge))?$/.exec(rest))) {
    const pr = db.prs.find((p) => p.repo === key && p.number === Number(mm![1]));
    if (!pr) return notFound();
    if (mm[2] === 'reviews') return reply(200, pr.reviews.map((r, i) => ({ id: i + 1, user: { login: r.user }, state: r.state, body: r.body, commit_id: r.commit })));
    if (mm[2] === 'merge') return reply(pr.state === 'MERGED' ? 204 : 404, pr.state === 'MERGED' ? null : { message: 'Not Found' });
    return reply(200, { number: pr.number, title: pr.title, body: pr.body, state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.state === 'MERGED', mergeable: mergeability(g.ctx, db, pr, g.user).conflict ? false : true, user: { login: pr.author }, head: { ref: pr.head, sha: headSha(g.ctx, pr) }, base: { ref: pr.base } });
  }
  if (rest === 'issues') return reply(200, db.issues.filter((i) => i.repo === key).map((i) => ({ number: i.number, title: i.title, state: i.state.toLowerCase(), labels: i.labels.map((name) => ({ name })) })));
  if (rest === 'releases') return reply(200, db.releases.filter((r) => r.repo === key).map((r) => ({ tag_name: r.tag, name: r.name, draft: r.draft, prerelease: r.prerelease, body: r.notes, assets: Object.keys(r.assets).map((name) => ({ name })) })));
  if (rest === 'releases/latest') {
    const r = db.releases.filter((x) => x.repo === key && !x.draft && !x.prerelease).sort((a, b) => b.createdAt - a.createdAt)[0];
    return r ? reply(200, { tag_name: r.tag, name: r.name, body: r.notes }) : notFound();
  }
  if ((mm = /^commits\/([^/]+)(?:\/(status|check-runs))?$/.exec(rest))) {
    const sha = st.branches[mm[1]] ?? st.tags[mm[1]] ?? Object.keys(st.commits).find((c) => c.startsWith(mm![1]));
    if (!sha) return notFound();
    const runs = (db.runs as CiRun[]).filter((r) => r.repo === key && r.sha === sha);
    if (mm[2] === 'check-runs') return reply(200, { total_count: runs.reduce((n, r) => n + r.jobs.length, 0), check_runs: runs.flatMap((r) => r.jobs.map((j) => ({ id: j.id, name: j.name, status: j.status === 'completed' ? 'completed' : 'queued', conclusion: j.conclusion }))) });
    if (mm[2] === 'status') {
      const jobs = runs.flatMap((r) => r.jobs);
      const state = jobs.some((j) => j.conclusion === 'failure') ? 'failure' : jobs.some((j) => j.status !== 'completed') ? 'pending' : jobs.length ? 'success' : 'pending';
      return reply(200, { state, sha, total_count: jobs.length });
    }
    const c = st.commits[sha];
    return reply(200, { sha, commit: { message: c.message, author: { name: c.author, email: c.email, date: new Date(c.time).toISOString() } }, parents: c.parents.map((p) => ({ sha: p })) });
  }
  if ((mm = /^contents\/(.+)$/.exec(rest))) {
    const ref = /[?&]ref=([^&]+)/.exec(endpoint)?.[1] ?? repo.defaultBranch;
    const sha = st.branches[ref] ?? st.tags[ref];
    const content = sha ? st.commits[sha].tree[mm[1]] : undefined;
    if (content === undefined) return notFound();
    return reply(200, { name: mm[1].split('/').pop(), path: mm[1], encoding: 'base64', content: btoaUtf8(content) });
  }
  return notFound();
}

function btoaUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function protectionJson(db: ForgeDb, key: string, b: string, p: Protection): unknown {
  const url = `https://${db.host}/api/v3/repos/${key}/branches/${b}/protection`;
  return {
    url,
    required_status_checks: p.required_status_checks ? { strict: !!p.required_status_checks.strict, contexts: p.required_status_checks.contexts, checks: p.required_status_checks.contexts.map((context) => ({ context, app_id: null })) } : null,
    required_pull_request_reviews: p.required_pull_request_reviews ?? null,
    enforce_admins: { url: `${url}/enforce_admins`, enabled: !!p.enforce_admins },
    required_linear_history: { enabled: !!p.required_linear_history },
    allow_force_pushes: { enabled: !!p.allow_force_pushes },
    allow_deletions: { enabled: !!p.allow_deletions },
  };
}

/* ----------------------------------------------------------------------------- the gh command */

const GH_HELP = `Work seamlessly with the lab forge (git.lab) from the command line.

USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS
  auth:        Authenticate gh and git with the forge
  issue:       Manage issues
  pr:          Manage pull requests
  release:     Manage releases
  repo:        Manage repositories

ACTIONS COMMANDS
  run:         View details about workflow runs
  workflow:    View details about workflows

ADDITIONAL COMMANDS
  api:         Make an authenticated API request
  secret:      Manage secrets
  ssh-key:     Manage SSH keys
  variable:    Manage variables
`;

const gh: Cmd = (args, io, ctx) => {
  const [group, sub = '', ...rest] = args;
  try {
    if (!group || group === 'help' || group === '--help') {
      io.out(GH_HELP);
      return 0;
    }
    if (group === '--version' || group === 'version') {
      io.out('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n');
      return 0;
    }
    if (group === 'auth') return ghAuth(ctx, io, sub, rest);
    const g = ghSession(ctx, io);
    switch (group) {
      case 'pr':
        return ghPr(g, sub, rest);
      case 'issue':
        return ghIssue(g, sub, rest);
      case 'run':
        return ghRun(g, sub, rest);
      case 'workflow':
        return ghWorkflow(g, sub, rest);
      case 'secret':
        return ghSecret(g, sub, rest, 'secret');
      case 'variable':
        return ghSecret(g, sub, rest, 'variable');
      case 'release':
        return ghRelease(g, sub, rest);
      case 'repo':
        return ghRepo(g, sub, rest);
      case 'ssh-key':
        return ghSshKey(g, sub, rest);
      case 'api':
        return ghApi(g, [sub, ...rest]);
      case 'browse': {
        const { key } = targetRepo(g, [sub, ...rest].filter(Boolean));
        io.out(`https://${g.db.host}/${key}\n`);
        io.err(`(this simulator has no browser: open the address above in your notes)\n`);
        return 0;
      }
    }
    return fail(`unknown command "${group}" for "gh"\n\n${GH_HELP}`);
  } catch (e) {
    if (e instanceof GhExit) {
      io.err(e.text.endsWith('\n') ? e.text : e.text + '\n');
      return e.code;
    }
    throw e;
  }
};

/** ssh to the forge host authenticates the key and refuses a shell, as forges do; other hosts are not simulated. */
const ssh: Cmd = (args, io, ctx) => {
  const target = args.filter((a, i) => !a.startsWith('-') && !['-i', '-p', '-o', '-l'].includes(args[i - 1] ?? '')).find(Boolean);
  const host = target?.split('@').pop();
  if (host && forgeExists(ctx) && host === loadDb(ctx).host) {
    const db = loadDb(ctx);
    const mine = publicKeysOf(ctx).map(keyId);
    const login = Object.entries(db.users).find(([, x]) => x.keys.some((k) => mine.includes(keyId(k))))?.[0];
    if (!login) {
      io.err(`${target}: Permission denied (publickey).
`);
      return 255;
    }
    io.err(`Hi ${login}! You've successfully authenticated, but ${db.host} does not provide shell access.
`);
    return 1;
  }
  return ADMIN_COMMANDS.ssh(args, io, ctx);
};

export const FORGE_COMMANDS: Record<string, Cmd> = { gh, ssh };

void short;
void (null as unknown as ForgeUser);
