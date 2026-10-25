/** The simulated git's saved state, and a helper that builds a repository for a lab's starting files. */

export interface GitCommit {
  id: string;
  seq: number;
  parents: string[];
  message: string;
  author: string;
  email: string;
  time: number;
  tree: Record<string, string>;
}

export interface GitState {
  head: { branch?: string; detached?: string };
  branches: Record<string, string | null>;
  commits: Record<string, GitCommit>;
  index: Record<string, string>;
  config: { name?: string; email?: string };
  tags: Record<string, string>;
  merging?: { other: string; otherName: string };
}

export const STATE = '.git/state.json';

export function hashHex(text: string): string {
  let out = '';
  for (let round = 0; out.length < 40; round++) {
    let h1 = 0xdeadbeef ^ round;
    let h2 = 0x41c6ce57 ^ round;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    out += (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

/**
 * Files for a lab's starting state: a repository at `repo` whose history is `commits` (each one
 * changes the files it lists), checked out on main, with the working tree at the last commit.
 */
export function seedRepo(repo: string, commits: Array<{ message: string; author: string; email: string; files: Record<string, string> }>, tags: Record<string, number> = {}): Record<string, string> {
  const st: GitState = { head: { branch: 'main' }, branches: { main: null }, commits: {}, index: {}, config: {}, tags: {} };
  let tree: Record<string, string> = {};
  let parent: string | null = null;
  const ids: string[] = [];
  commits.forEach((c, i) => {
    tree = { ...tree, ...c.files };
    const seq = i + 1;
    const id = hashHex(JSON.stringify([seq, parent ? [parent] : [], c.message, { name: c.author, email: c.email }, tree]));
    st.commits[id] = { id, seq, parents: parent ? [parent] : [], message: c.message, author: c.author, email: c.email, time: Date.UTC(2026, 9, 10 + i, 10, 0), tree: { ...tree } };
    parent = id;
    ids.push(id);
  });
  st.branches.main = parent;
  st.index = { ...tree };
  for (const [t, n] of Object.entries(tags)) st.tags[t] = ids[n];
  const base = repo === '/' ? '' : repo;
  return { [`${base}/${STATE}`]: JSON.stringify(st), [`${base}/.git/HEAD`]: 'ref: refs/heads/main\n', ...Object.fromEntries(Object.entries(tree).map(([p, content]) => [`${base}/${p}`, content])) };
}
