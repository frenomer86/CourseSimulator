/** Unit 5: file systems — the file/directory interface and permissions, on-disk structures
 * (inodes, bitmaps, directories), crash consistency, disk scheduling, and RAID. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U5: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 5.1 interface and permissions */
  tmpl(5, 1, 'beginner', 'permission-bits', 'Check Unix permission bits', 'E1', 25, 'Decide whether an operation is allowed from the owner/group/other permission bits.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## rwx for owner, group, other\n\nOn **${m.host}**, a file has a 9-bit mode (three rwx triples). Write:\n\n1. \`parseMode(octal)\`: \`octal\` is a 3-digit string like \`"755"\`. Return \`{ owner, group, other }\`, each \`{ r, w, x }\` booleans.\n2. \`allowed(mode, who, action)\`: \`who\` is \`"owner"\`, \`"group"\` or \`"other"\`; \`action\` is \`"r"\`, \`"w"\` or \`"x"\`. Return the matching boolean from \`parseMode(mode)\`.`,
      hints: ['Each octal digit 0–7 encodes r(4) w(2) x(1).', 'Index the parsed mode by who and action.'],
      starter: `// ${m.host}: permission bits\nfunction parseMode(octal) {\n}\n\nfunction allowed(mode, who, action) {\n}\n`,
      checks: [
        fn('parseMode decodes the triples', 'parseMode', [
          { args: ['755'], expected: { owner: { r: true, w: true, x: true }, group: { r: true, w: false, x: true }, other: { r: true, w: false, x: true } } },
          { args: ['640'], expected: { owner: { r: true, w: true, x: false }, group: { r: true, w: false, x: false }, other: { r: false, w: false, x: false } } },
        ]),
        fn('allowed reads the right bit', 'allowed', [
          { args: ['755', 'group', 'w'], expected: false },
          { args: ['755', 'owner', 'x'], expected: true },
          { args: ['640', 'other', 'r'], expected: false },
        ]),
      ],
      solution: `function parseMode(octal) {\n  const digit = (d) => ({ r: (d & 4) !== 0, w: (d & 2) !== 0, x: (d & 1) !== 0 });\n  const ds = octal.split("").map(Number);\n  return { owner: digit(ds[0]), group: digit(ds[1]), other: digit(ds[2]) };\n}\nfunction allowed(mode, who, action) {\n  return parseMode(mode)[who][action];\n}`,
      realityNote: 'Unix permission bits pack read/write/execute for owner, group and other into three octal digits; chmod 755 is the everyday shorthand for exactly this encoding.',
    });
  }),
  tmpl(5, 1, 'intermediate', 'path-resolution', 'Resolve a path through directories', 'E1', 25, 'Walk a path from a root directory tree, following names and rejecting bad components.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Walking a path\n\nOn **${m.host}**, resolve an absolute path through a tree. A directory is an object mapping a name to either another directory (object) or a file marker \`{ file: true }\`. Write \`resolve(root, path)\`:\n\n- split \`path\` on \`/\` and drop empty parts;\n- walk from \`root\`; if a component is missing, return \`{ error: "ENOENT" }\`;\n- if a component in the **middle** is a file (not a directory), return \`{ error: "ENOTDIR" }\`;\n- return \`{ node }\` with the final node reached (the empty path "/" resolves to the root).`,
      hints: ['Walk component by component; the last one may be a file.', 'A non-final file component is ENOTDIR.'],
      starter: `// ${m.host}: path resolution\nfunction resolve(root, path) {\n}\n`,
      checks: [
        fn('resolve walks the tree', 'resolve', [
          { args: [{ etc: { hosts: { file: true } } }, '/etc/hosts'], expected: { node: { file: true } } },
          { args: [{ etc: { hosts: { file: true } } }, '/etc/missing'], expected: { error: 'ENOENT' } },
          { args: [{ etc: { hosts: { file: true } } }, '/etc/hosts/x'], expected: { error: 'ENOTDIR' } },
          { args: [{ a: {} }, '/'], expected: { node: { a: {} } } },
        ]),
      ],
      solution: `function resolve(root, path) {\n  const parts = path.split("/").filter(Boolean);\n  let node = root;\n  for (let i = 0; i < parts.length; i++) {\n    if (node && node.file) return { error: "ENOTDIR" };\n    if (!node || !Object.prototype.hasOwnProperty.call(node, parts[i])) return { error: "ENOENT" };\n    node = node[parts[i]];\n  }\n  return { node };\n}`,
      realityNote: 'Path resolution walks directory entries component by component; the VFS does exactly this, returning ENOENT for a missing name and ENOTDIR when a path component is not a directory.',
    });
  }),
  tmpl(5, 1, 'advanced', 'hard-vs-symlink', 'Reason about hard and symbolic links', 'E1', 25, 'Track link counts and decide when a file\'s data is freed, and how symlinks differ.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Links and reference counts\n\nOn **${m.host}**, a file\'s data persists while its inode link count is above 0. Write:\n\n1. \`afterHardLink(linkCount)\`: creating a hard link increments the count — return \`linkCount + 1\`.\n2. \`afterUnlink(linkCount)\`: unlinking decrements — return \`{ linkCount: linkCount - 1, freed: linkCount - 1 === 0 }\` (data is freed when the count reaches 0).\n3. \`symlinkResolves(target, files)\`: a symlink stores a path string \`target\`; return \`true\` if \`target\` is a key in \`files\` (a dangling symlink points nowhere → \`false\`).`,
      hints: ['Hard links share an inode and bump its link count; data frees at 0.', 'A symlink is just a stored path; it can dangle.'],
      starter: `// ${m.host}: hard and symbolic links\nfunction afterHardLink(linkCount) {\n}\n\nfunction afterUnlink(linkCount) {\n}\n\nfunction symlinkResolves(target, files) {\n}\n`,
      checks: [
        fn('afterHardLink increments the count', 'afterHardLink', [{ args: [1], expected: 2 }, { args: [3], expected: 4 }]),
        fn('afterUnlink frees at zero', 'afterUnlink', [
          { args: [2], expected: { linkCount: 1, freed: false } },
          { args: [1], expected: { linkCount: 0, freed: true } },
        ]),
        fn('symlinkResolves checks the target', 'symlinkResolves', [
          { args: ['/etc/hosts', { '/etc/hosts': 1 }], expected: true },
          { args: ['/missing', { '/etc/hosts': 1 }], expected: false },
        ]),
      ],
      solution: `function afterHardLink(linkCount) {\n  return linkCount + 1;\n}\nfunction afterUnlink(linkCount) {\n  const next = linkCount - 1;\n  return { linkCount: next, freed: next === 0 };\n}\nfunction symlinkResolves(target, files) {\n  return Object.prototype.hasOwnProperty.call(files, target);\n}`,
      realityNote: 'A hard link is another directory entry for the same inode (data frees when the link count hits 0); a symlink is a separate file holding a path, which can dangle if the target is removed.',
    });
  }),

  /* ------------------------------------------------------------------ 5.2 on-disk structures */
  tmpl(5, 2, 'beginner', 'free-bitmap', 'Manage free blocks with a bitmap', 'E1', 25, 'Find and flip bits in a free-space bitmap to allocate and free blocks.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The free-space bitmap\n\nOn **${m.host}**, a bitmap tracks free blocks: \`bitmap[i] === 0\` means block \`i\` is free, \`1\` means used. Write:\n\n1. \`firstFree(bitmap)\`: return the index of the first free block, or \`-1\` if none.\n2. \`allocate(bitmap)\`: return \`{ block, bitmap }\` — allocate the first free block (set it to 1) and return its index (\`-1\` and the unchanged bitmap if full).\n3. \`free(bitmap, index)\`: return a new bitmap with \`index\` set to 0.`,
      hints: ['Scan for the first 0.', 'allocate flips one bit; free clears one.'],
      starter: `// ${m.host}: free-space bitmap\nfunction firstFree(bitmap) {\n}\n\nfunction allocate(bitmap) {\n}\n\nfunction free(bitmap, index) {\n}\n`,
      checks: [
        fn('firstFree finds a free block', 'firstFree', [
          { args: [[1, 1, 0, 1]], expected: 2 }, { args: [[1, 1, 1]], expected: -1 }, { args: [[0]], expected: 0 },
        ]),
        fn('allocate takes the first free block', 'allocate', [
          { args: [[1, 0, 0]], expected: { block: 1, bitmap: [1, 1, 0] } },
          { args: [[1, 1]], expected: { block: -1, bitmap: [1, 1] } },
        ]),
        fn('free clears a block', 'free', [
          { args: [[1, 1, 1], 1], expected: [1, 0, 1] },
        ]),
      ],
      solution: `function firstFree(bitmap) {\n  return bitmap.indexOf(0);\n}\nfunction allocate(bitmap) {\n  const block = firstFree(bitmap);\n  if (block === -1) return { block: -1, bitmap };\n  const next = [...bitmap];\n  next[block] = 1;\n  return { block, bitmap: next };\n}\nfunction free(bitmap, index) {\n  const next = [...bitmap];\n  next[index] = 0;\n  return next;\n}`,
      realityNote: 'A bitmap with one bit per block is a compact free-space map; the file system scans it to allocate and clears bits to free, as ext and many file systems do.',
    });
  }),
  tmpl(5, 2, 'intermediate', 'inode-blocks', 'Map a file offset through an inode', 'E1', 30, 'Resolve a byte offset to a disk block via direct and single-indirect pointers.', (v) => {
    const m = machineOf(v);
    const bs = v.pick([512, 1024]);
    return js({
      instructions: `## inode block mapping (${bs}-byte blocks)\n\nOn **${m.host}**, an inode has **12 direct** pointers and **1 single-indirect** pointer to a block holding \`${bs} / 4 = ${bs / 4}\` more pointers. Block size is **${bs}**. Write:\n\n1. \`blockIndex(offset, blockSize)\`: the file-relative block number = \`Math.floor(offset / blockSize)\`.\n2. \`resolve(fileBlock, inode, blockSize)\`: \`inode = { direct: [...12], indirect: [...] }\`. For \`fileBlock < 12\` return \`inode.direct[fileBlock]\`; for \`12 <= fileBlock < 12 + blockSize/4\` return \`inode.indirect[fileBlock - 12]\`; otherwise return \`null\` (beyond the file\'s addressable range here). Return \`null\` if the pointer is undefined.`,
      hints: ['First 12 file blocks use direct pointers.', 'The next blockSize/4 use the indirect block.'],
      starter: `// ${m.host}: inode block mapping\nfunction blockIndex(offset, blockSize) {\n}\n\nfunction resolve(fileBlock, inode, blockSize) {\n}\n`,
      checks: [
        fn('blockIndex finds the file block', 'blockIndex', [
          { args: [0, bs], expected: 0 }, { args: [bs, bs], expected: 1 }, { args: [bs * 5 + 3, bs], expected: 5 },
        ]),
        fn('resolve maps direct and indirect', 'resolve', [
          { args: [2, { direct: [10, 11, 12], indirect: [] }, bs], expected: 12 },
          { args: [12, { direct: Array(12).fill(0), indirect: [99] }, bs], expected: 99 },
          { args: [13, { direct: Array(12).fill(0), indirect: [99] }, bs], expected: null },
          { args: [12 + bs / 4, { direct: Array(12).fill(0), indirect: Array(bs / 4).fill(1) }, bs], expected: null },
        ]),
      ],
      solution: `function blockIndex(offset, blockSize) {\n  return Math.floor(offset / blockSize);\n}\nfunction resolve(fileBlock, inode, blockSize) {\n  const perBlock = blockSize / 4;\n  if (fileBlock < 12) return inode.direct[fileBlock] ?? null;\n  if (fileBlock < 12 + perBlock) return inode.indirect[fileBlock - 12] ?? null;\n  return null;\n}`,
      realityNote: 'The classic Unix inode uses direct pointers for small files and indirect blocks for large ones, so small files are fast while large files remain addressable.',
    });
  }),
  tmpl(5, 2, 'advanced', 'fat-chain', 'Follow a FAT cluster chain', 'E1', 25, 'Walk a File Allocation Table chain to list a file\'s clusters and detect a cycle.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The FAT cluster chain\n\nOn **${m.host}**, FAT stores, for each cluster, the next cluster number, or \`-1\` for end-of-chain. Write:\n\n1. \`chain(fat, start)\`: return the array of clusters from \`start\` following \`fat[c]\` until \`-1\`. Guard against cycles: if a cluster repeats, stop and return the clusters collected so far.\n2. \`fileSize(fat, start, clusterSize)\`: return \`chain(fat, start).length * clusterSize\`.`,
      hints: ['Follow next-pointers until -1, tracking visited clusters.', 'A repeated cluster means a corrupt (cyclic) chain; stop.'],
      starter: `// ${m.host}: FAT chain\nfunction chain(fat, start) {\n}\n\nfunction fileSize(fat, start, clusterSize) {\n}\n`,
      checks: [
        fn('chain follows the links', 'chain', [
          { args: [{ 2: 3, 3: 5, 5: -1 }, 2], expected: [2, 3, 5] },
          { args: [{ 7: -1 }, 7], expected: [7] },
          { args: [{ 2: 3, 3: 2 }, 2], expected: [2, 3] },
        ]),
        fn('fileSize multiplies by cluster size', 'fileSize', [
          { args: [{ 2: 3, 3: 5, 5: -1 }, 2, 1024], expected: 3072 },
        ]),
      ],
      solution: `function chain(fat, start) {\n  const out = [];\n  const seen = new Set();\n  let c = start;\n  while (c !== -1 && c !== undefined && !seen.has(c)) {\n    seen.add(c);\n    out.push(c);\n    c = fat[c];\n  }\n  return out;\n}\nfunction fileSize(fat, start, clusterSize) {\n  return chain(fat, start).length * clusterSize;\n}`,
      realityNote: 'FAT keeps a linked chain of clusters per file in a table; it is simple and widely compatible but slow for random access and prone to fragmentation.',
    });
  }),

  /* ------------------------------------------------------------------ 5.3 crash consistency */
  tmpl(5, 3, 'beginner', 'crash-consistency', 'Keep a file system consistent across crashes', 'E10', 15, 'Reason about how journaling and copy-on-write survive a crash mid-update.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## A crash in the middle of a write\n\n**${m.host}** loses power while updating a file\'s data and metadata. Reason about keeping the file system consistent.`,
      steps: [
        { title: 'The problem', text: 'Why is a multi-block update dangerous across a crash?', choices: [
          { text: 'A crash can leave some blocks written and others not, so metadata and data disagree (an inconsistent state)', right: true, feedback: 'Correct. Partial updates leave the file system inconsistent.' },
          { text: 'Writes are always atomic, so there is no problem', feedback: 'Multi-block writes are not atomic; a crash can split them.' },
          { text: 'The disk refuses to write during a crash', feedback: 'Some writes may have completed and others not.' },
        ] },
        { title: 'fsck', text: 'What does fsck do, and what is its drawback?', choices: [
          { text: 'Scans the whole file system after a crash to find and repair inconsistencies — correct but slow on large disks', right: true, feedback: 'Correct. Thorough but O(disk size) to recover.' },
          { text: 'Prevents all crashes', feedback: 'It repairs after the fact; it does not prevent crashes.' },
          { text: 'Runs instantly regardless of size', feedback: 'A full scan is slow on big file systems.' },
        ] },
        { title: 'Journaling', text: 'How does journaling avoid the full scan?', choices: [
          { text: 'It writes intended changes to a log first; after a crash it replays or discards the log, recovering in bounded time', right: true, feedback: 'Correct. Write-ahead logging makes recovery fast and bounded.' },
          { text: 'It never writes metadata', feedback: 'It writes metadata, but via the journal first.' },
          { text: 'It scans the whole disk like fsck', feedback: 'The journal is small, so recovery is fast.' },
        ] },
        { title: 'Copy-on-write', text: 'How do copy-on-write file systems (ZFS, Btrfs) stay consistent?', choices: [
          { text: 'They never overwrite live data — new versions are written elsewhere and a single atomic pointer switch commits them', right: true, feedback: 'Correct. The old state stays intact until the atomic switch.' },
          { text: 'They overwrite in place and hope', feedback: 'That is exactly what COW avoids.' },
          { text: 'They disable writing', feedback: 'They write new copies, then switch atomically.' },
        ] },
      ],
      ending: { title: 'Log it or copy it, then commit atomically', text: 'A crash can leave a partial update inconsistent; fsck repairs by full scan (slow), journaling logs changes and replays them (fast, bounded), and copy-on-write writes new versions and commits with one atomic pointer switch.' },
      hints: ['The danger is a partial multi-block update after a crash.', 'Journaling (log first) and copy-on-write (new copy, atomic switch) both give fast, consistent recovery.'],
      realityNote: 'ext4 journals metadata; ZFS and Btrfs use copy-on-write; both avoid the slow full-disk fsck by making updates recoverable or atomic.',
    });
  }),
  tmpl(5, 3, 'intermediate', 'journal-replay', 'Replay a write-ahead journal', 'E1', 25, 'Apply only committed transactions from a journal after a crash.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Replaying the journal\n\nOn **${m.host}**, a journal is a list of records: \`{ txn, type, block, value }\` where \`type\` is \`"write"\` or \`"commit"\`. On recovery, apply the writes of a transaction **only if that transaction has a commit record**. Write \`replay(journal, disk)\`:\n\n- find the set of committed txn ids (those with a \`"commit"\` record);\n- apply each \`"write"\` whose \`txn\` is committed, in order, setting \`disk[block] = value\`;\n- return the updated \`disk\` (a copy).\n\nAlso \`committedTxns(journal)\`: return the sorted array of committed txn ids.`,
      hints: ['A write counts only if its transaction committed.', 'Scan for commit records first, then apply matching writes.'],
      starter: `// ${m.host}: journal replay\nfunction committedTxns(journal) {\n}\n\nfunction replay(journal, disk) {\n}\n`,
      checks: [
        fn('committedTxns lists committed ids', 'committedTxns', [
          { args: [[{ txn: 1, type: 'write', block: 0, value: 'a' }, { txn: 1, type: 'commit' }, { txn: 2, type: 'write', block: 1, value: 'b' }]], expected: [1] },
        ]),
        fn('replay applies only committed writes', 'replay', [
          { args: [[{ txn: 1, type: 'write', block: 0, value: 'a' }, { txn: 1, type: 'commit' }, { txn: 2, type: 'write', block: 1, value: 'b' }], { 0: 'old0', 1: 'old1' }], expected: { 0: 'a', 1: 'old1' } },
          { args: [[{ txn: 5, type: 'write', block: 2, value: 'x' }, { txn: 5, type: 'commit' }], {}], expected: { 2: 'x' } },
        ]),
      ],
      solution: `function committedTxns(journal) {\n  return journal.filter((r) => r.type === "commit").map((r) => r.txn).sort((a, b) => a - b);\n}\nfunction replay(journal, disk) {\n  const committed = new Set(committedTxns(journal));\n  const out = { ...disk };\n  for (const r of journal) {\n    if (r.type === "write" && committed.has(r.txn)) out[r.block] = r.value;\n  }\n  return out;\n}`,
      realityNote: 'Write-ahead logging applies a transaction only if its commit record is present; a crash before commit discards the partial writes, keeping the file system consistent.',
    });
  }),
  tmpl(5, 3, 'advanced', 'atomic-pointer-switch', 'Commit with an atomic pointer switch', 'E1', 25, 'Model copy-on-write: build the new state aside, then switch the root atomically.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Copy-on-write commit\n\nOn **${m.host}**, a COW file system writes new blocks without touching the old ones, then switches the root pointer in one atomic step. Model it. The state is \`{ root, blocks }\` where \`blocks\` maps an id to data and \`root\` is the committed root id. Write:\n\n1. \`writeNewVersion(state, newId, data)\`: add \`blocks[newId] = data\` but **do not** change \`root\` — return the new state (old root still live).\n2. \`commit(state, newId)\`: return a new state with \`root\` set to \`newId\` (the atomic switch).\n3. \`liveRootData(state)\`: return \`blocks[root]\`.\n\nSo before commit, a crash leaves the old root intact; after commit, the new version is live.`,
      hints: ['Writing a new version never disturbs the current root.', 'Commit is the single pointer change that makes it live.'],
      starter: `// ${m.host}: copy-on-write commit\nfunction writeNewVersion(state, newId, data) {\n}\n\nfunction commit(state, newId) {\n}\n\nfunction liveRootData(state) {\n}\n`,
      checks: [
        fn('writeNewVersion keeps the old root', 'writeNewVersion', [
          { args: [{ root: 'a', blocks: { a: 'old' } }, 'b', 'new'], expected: { root: 'a', blocks: { a: 'old', b: 'new' } } },
        ]),
        fn('commit switches the root', 'commit', [
          { args: [{ root: 'a', blocks: { a: 'old', b: 'new' } }, 'b'], expected: { root: 'b', blocks: { a: 'old', b: 'new' } } },
        ]),
        fn('liveRootData reads the committed root', 'liveRootData', [
          { args: [{ root: 'b', blocks: { a: 'old', b: 'new' } }], expected: 'new' },
          { args: [{ root: 'a', blocks: { a: 'old', b: 'new' } }], expected: 'old' },
        ]),
      ],
      solution: `function writeNewVersion(state, newId, data) {\n  return { root: state.root, blocks: { ...state.blocks, [newId]: data } };\n}\nfunction commit(state, newId) {\n  return { root: newId, blocks: state.blocks };\n}\nfunction liveRootData(state) {\n  return state.blocks[state.root];\n}`,
      realityNote: 'Copy-on-write file systems write a whole new tree of changed blocks and commit by atomically updating one root pointer (an uberblock/superblock), so a crash never exposes a half-written state.',
    });
  }),

  /* ------------------------------------------------------------------ 5.4 disk scheduling */
  tmpl(5, 4, 'beginner', 'disk-fcfs-sstf', 'Schedule disk requests with FCFS and SSTF', 'E1', 25, 'Compute head movement for first-come and shortest-seek scheduling.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Minimising head movement\n\nOn **${m.host}**, the disk head is at a track and several requests wait. Write:\n\n1. \`fcfsDistance(start, requests)\`: serve requests in the given order; return the total head movement (sum of absolute differences).\n2. \`sstfOrder(start, requests)\`: shortest-seek-time-first — repeatedly serve the nearest pending request (ties by lower track number). Return the order served as an array.`,
      hints: ['FCFS sums |diff| in the request order.', 'SSTF always jumps to the closest remaining track.'],
      starter: `// ${m.host}: disk scheduling\nfunction fcfsDistance(start, requests) {\n}\n\nfunction sstfOrder(start, requests) {\n}\n`,
      checks: [
        fn('fcfsDistance sums the movement', 'fcfsDistance', [
          { args: [50, [82, 170, 43]], expected: 32 + 88 + 127 },
          { args: [0, []], expected: 0 },
        ]),
        fn('sstfOrder serves the nearest first', 'sstfOrder', [
          { args: [50, [82, 170, 43, 140]], expected: [43, 82, 140, 170] },
          { args: [50, [51, 49]], expected: [49, 51] },
        ]),
      ],
      solution: `function fcfsDistance(start, requests) {\n  let pos = start, total = 0;\n  for (const r of requests) { total += Math.abs(r - pos); pos = r; }\n  return total;\n}\nfunction sstfOrder(start, requests) {\n  const pending = [...requests];\n  let pos = start;\n  const order = [];\n  while (pending.length) {\n    let best = 0;\n    for (let i = 1; i < pending.length; i++) {\n      const d = Math.abs(pending[i] - pos), bd = Math.abs(pending[best] - pos);\n      if (d < bd || (d === bd && pending[i] < pending[best])) best = i;\n    }\n    pos = pending[best];\n    order.push(pos);\n    pending.splice(best, 1);\n  }\n  return order;\n}`,
      realityNote: 'SSTF cuts head movement versus FCFS but can starve far-away requests; it is the greedy baseline that SCAN and C-SCAN improve on for fairness.',
    });
  }),
  tmpl(5, 4, 'intermediate', 'disk-scan', 'Schedule with the elevator (SCAN) algorithm', 'E1', 30, 'Serve requests in one direction then reverse, like an elevator.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## SCAN (the elevator)\n\nOn **${m.host}**, SCAN moves the head in one direction serving requests, then reverses. Write \`scanOrder(start, requests, direction, maxTrack)\` where \`direction\` is \`"up"\` or \`"down"\`:\n\n- for \`"up"\`: serve all requests \`>= start\` in ascending order, then all requests \`< start\` in descending order;\n- for \`"down"\`: serve all requests \`<= start\` in descending order, then all \`> start\` in ascending order.\n\nReturn the order served (assume requests are distinct). Also \`scanDistance(start, requests, direction, maxTrack)\`: total head movement over that order.`,
      hints: ['Partition into the two groups around start, sort each, concatenate.', 'Distance is the sum of |diff| along the served order.'],
      starter: `// ${m.host}: SCAN scheduling\nfunction scanOrder(start, requests, direction, maxTrack) {\n}\n\nfunction scanDistance(start, requests, direction, maxTrack) {\n}\n`,
      checks: [
        fn('scanOrder sweeps then reverses', 'scanOrder', [
          { args: [50, [82, 170, 43, 140, 24], 'up', 199], expected: [82, 140, 170, 43, 24] },
          { args: [50, [82, 170, 43, 140, 24], 'down', 199], expected: [43, 24, 82, 140, 170] },
        ]),
        fn('scanDistance totals the movement', 'scanDistance', [
          { args: [50, [82, 170, 43], 'up', 199], expected: 120 + 127 },
        ]),
      ],
      solution: `function scanOrder(start, requests, direction, maxTrack) {\n  const up = requests.filter((r) => r >= start).sort((a, b) => a - b);\n  const down = requests.filter((r) => r < start).sort((a, b) => b - a);\n  if (direction === "up") return [...up, ...down];\n  const downIncl = requests.filter((r) => r <= start).sort((a, b) => b - a);\n  const upExcl = requests.filter((r) => r > start).sort((a, b) => a - b);\n  return [...downIncl, ...upExcl];\n}\nfunction scanDistance(start, requests, direction, maxTrack) {\n  const order = scanOrder(start, requests, direction, maxTrack);\n  let pos = start, total = 0;\n  for (const r of order) { total += Math.abs(r - pos); pos = r; }\n  return total;\n}`,
      realityNote: 'SCAN (the elevator algorithm) serves requests in one direction then reverses, bounding the wait for any request and avoiding the starvation SSTF can cause.',
    });
  }),
  tmpl(5, 4, 'advanced', 'ssd-wear', 'Account for SSD wear levelling', 'E1', 25, 'Spread erases across flash blocks and decide which block to write for even wear.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Flash wear levelling\n\nAn SSD on **${m.host}** erases flash blocks a limited number of times; the controller spreads writes to level wear. Write:\n\n1. \`leastWorn(eraseCounts)\`: return the index of the block with the **fewest** erases (ties by lowest index) — the next place to write.\n2. \`wearSpread(eraseCounts)\`: return \`max - min\` of the erase counts (lower is more even wear).\n3. \`needsLevelling(eraseCounts, threshold)\`: return \`true\` when \`wearSpread > threshold\` (the controller should relocate data to even things out).`,
      hints: ['Write to the least-worn block to balance erases.', 'The spread (max − min) measures how uneven wear is.'],
      starter: `// ${m.host}: SSD wear levelling\nfunction leastWorn(eraseCounts) {\n}\n\nfunction wearSpread(eraseCounts) {\n}\n\nfunction needsLevelling(eraseCounts, threshold) {\n}\n`,
      checks: [
        fn('leastWorn picks the freshest block', 'leastWorn', [
          { args: [[5, 2, 2, 8]], expected: 1 }, { args: [[3, 3, 3]], expected: 0 },
        ]),
        fn('wearSpread measures unevenness', 'wearSpread', [
          { args: [[5, 2, 8]], expected: 6 }, { args: [[4, 4]], expected: 0 },
        ]),
        fn('needsLevelling thresholds the spread', 'needsLevelling', [
          { args: [[5, 2, 20], 10], expected: true }, { args: [[5, 2, 8], 10], expected: false },
        ]),
      ],
      solution: `function leastWorn(eraseCounts) {\n  let best = 0;\n  for (let i = 1; i < eraseCounts.length; i++) if (eraseCounts[i] < eraseCounts[best]) best = i;\n  return best;\n}\nfunction wearSpread(eraseCounts) {\n  return Math.max(...eraseCounts) - Math.min(...eraseCounts);\n}\nfunction needsLevelling(eraseCounts, threshold) {\n  return wearSpread(eraseCounts) > threshold;\n}`,
      realityNote: 'Flash cells wear out after a bounded number of erases, so an SSD\'s flash translation layer directs writes to the least-worn blocks and relocates data to keep wear even.',
    });
  }),

  /* ------------------------------------------------------------------ 5.5 RAID and reliability */
  tmpl(5, 5, 'beginner', 'raid-levels', 'Compute RAID capacity and redundancy', 'E1', 25, 'Work out usable capacity and fault tolerance for common RAID levels.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## RAID trade-offs\n\nOn **${m.host}**, with \`n\` disks each of size \`size\`, write \`usableCapacity(level, n, size)\` for:\n\n- \`"raid0"\` (striping): \`n * size\`;\n- \`"raid1"\` (mirroring, assume a pair): \`size\` (half of 2 disks);\n- \`"raid5"\` (one parity disk): \`(n - 1) * size\`;\n- \`"raid6"\` (two parity disks): \`(n - 2) * size\`;\n- anything else: \`0\`.\n\nAlso \`toleratesFailures(level)\`: disks that can fail without data loss — raid0: 0, raid1: 1, raid5: 1, raid6: 2, else 0.`,
      hints: ['Parity levels lose one (raid5) or two (raid6) disks\' worth of capacity.', 'Fault tolerance is 0/1/1/2 for raid0/1/5/6.'],
      starter: `// ${m.host}: RAID capacity\nfunction usableCapacity(level, n, size) {\n}\n\nfunction toleratesFailures(level) {\n}\n`,
      checks: [
        fn('usableCapacity by level', 'usableCapacity', [
          { args: ['raid0', 4, 100], expected: 400 },
          { args: ['raid1', 2, 100], expected: 100 },
          { args: ['raid5', 4, 100], expected: 300 },
          { args: ['raid6', 4, 100], expected: 200 },
          { args: ['raid7', 4, 100], expected: 0 },
        ]),
        fn('toleratesFailures by level', 'toleratesFailures', [
          { args: ['raid0'], expected: 0 }, { args: ['raid1'], expected: 1 }, { args: ['raid5'], expected: 1 }, { args: ['raid6'], expected: 2 },
        ]),
      ],
      solution: `function usableCapacity(level, n, size) {\n  if (level === "raid0") return n * size;\n  if (level === "raid1") return size;\n  if (level === "raid5") return (n - 1) * size;\n  if (level === "raid6") return (n - 2) * size;\n  return 0;\n}\nfunction toleratesFailures(level) {\n  return { raid0: 0, raid1: 1, raid5: 1, raid6: 2 }[level] || 0;\n}`,
      realityNote: 'RAID trades capacity for redundancy: RAID 0 maximises space with no safety, RAID 5/6 give single/double-disk fault tolerance at the cost of one or two disks of parity.',
    });
  }),
  tmpl(5, 5, 'intermediate', 'parity-recover', 'Recover a lost block from parity', 'E1', 25, 'Reconstruct a failed disk\'s block using XOR parity.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## XOR parity\n\nOn **${m.host}**, RAID 5 stores the XOR of the data blocks as parity; any one lost block is the XOR of the rest. Write:\n\n1. \`parity(blocks)\`: return the XOR of all numbers in \`blocks\` (0 for empty).\n2. \`recover(survivors, parityValue)\`: the lost block = XOR of the surviving data blocks XOR the parity. Return it.\n3. \`verify(dataBlocks, parityValue)\`: return \`true\` if \`parity(dataBlocks) === parityValue\` (consistent stripe).`,
      hints: ['XOR is its own inverse, so a missing operand is recovered by XOR-ing the rest.', 'reduce with ^ starting from 0.'],
      starter: `// ${m.host}: XOR parity\nfunction parity(blocks) {\n}\n\nfunction recover(survivors, parityValue) {\n}\n\nfunction verify(dataBlocks, parityValue) {\n}\n`,
      checks: [
        fn('parity XORs the blocks', 'parity', [
          { args: [[1, 2, 3]], expected: 0 }, { args: [[5, 3]], expected: 6 }, { args: [[]], expected: 0 },
        ]),
        fn('recover rebuilds the lost block', 'recover', [
          { args: [[1, 2], 0], expected: 3 },
          { args: [[5], 6], expected: 3 },
        ]),
        fn('verify checks the stripe', 'verify', [
          { args: [[1, 2, 3], 0], expected: true }, { args: [[1, 2, 3], 5], expected: false },
        ]),
      ],
      solution: `function parity(blocks) {\n  return blocks.reduce((x, b) => x ^ b, 0);\n}\nfunction recover(survivors, parityValue) {\n  return parity(survivors) ^ parityValue;\n}\nfunction verify(dataBlocks, parityValue) {\n  return parity(dataBlocks) === parityValue;\n}`,
      realityNote: 'RAID 5 parity is a simple XOR across the stripe; because XOR is self-inverse, any single lost block is recovered by XOR-ing the survivors with the parity.',
    });
  }),
  tmpl(5, 5, 'advanced', 'mtbf-reliability', 'Reason about array reliability', 'E1', 25, 'Estimate how redundancy and rebuild time affect the chance of data loss.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Reliability of a redundant array\n\nOn **${m.host}**, write:\n\n1. \`arrayMtbfNoRedundancy(diskMtbf, n)\`: with \`n\` independent disks and no redundancy, the array fails when **any** disk fails, so its MTBF is \`diskMtbf / n\`, rounded to 2 decimals.\n2. \`vulnerableToSecondFailure(level)\`: during a rebuild, is a second disk failure fatal? RAID 5 → \`true\` (no further redundancy), RAID 6 → \`false\` (survives one more), RAID 1 (pair) → \`true\`, else \`true\`.\n3. \`rebuildRiskHours(rebuildHours, diskMtbfHours)\`: a rough exposure ratio = \`rebuildHours / diskMtbfHours\`, rounded to 6 decimals (longer rebuilds raise the risk window).`,
      hints: ['n independent disks fail n times as often as one.', 'RAID 6 tolerates a second failure during rebuild; RAID 5 does not.'],
      starter: `// ${m.host}: array reliability\nfunction arrayMtbfNoRedundancy(diskMtbf, n) {\n}\n\nfunction vulnerableToSecondFailure(level) {\n}\n\nfunction rebuildRiskHours(rebuildHours, diskMtbfHours) {\n}\n`,
      checks: [
        fn('arrayMtbfNoRedundancy divides by n', 'arrayMtbfNoRedundancy', [
          { args: [1000000, 10], expected: 100000 }, { args: [500000, 4], expected: 125000 },
        ]),
        fn('vulnerableToSecondFailure by level', 'vulnerableToSecondFailure', [
          { args: ['raid5'], expected: true }, { args: ['raid6'], expected: false }, { args: ['raid1'], expected: true },
        ]),
        fn('rebuildRiskHours is the exposure ratio', 'rebuildRiskHours', [
          { args: [24, 1000000], expected: 0.000024 },
        ]),
      ],
      solution: `function arrayMtbfNoRedundancy(diskMtbf, n) {\n  return Math.round((diskMtbf / n) * 100) / 100;\n}\nfunction vulnerableToSecondFailure(level) {\n  return level !== "raid6";\n}\nfunction rebuildRiskHours(rebuildHours, diskMtbfHours) {\n  return Math.round((rebuildHours / diskMtbfHours) * 1000000) / 1000000;\n}`,
      realityNote: 'More disks mean more frequent failures, and RAID 5\'s exposure during a long rebuild (when a second failure is fatal) is why RAID 6 is preferred for large, slow-rebuilding drives.',
    });
  }),
];
