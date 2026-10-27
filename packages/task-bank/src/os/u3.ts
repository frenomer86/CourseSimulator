/** Unit 3: concurrency and synchronisation — race conditions and critical sections, locks and
 * semaphores, deadlock (resource graphs, banker's algorithm, detection), and IPC. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U3: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 3.1 races and critical sections */
  tmpl(3, 1, 'beginner', 'lost-update', 'See how a race loses an update', 'E1', 20, 'Model an interleaving of two increments that loses an update without synchronisation.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The lost update\n\nOn **${m.host}**, two threads each do \`temp = x; temp = temp + 1; x = temp\` on a shared \`x\`. Without a lock, a bad interleaving loses one increment. Model it.\n\n1. \`sequential(x, incrs)\`: with proper synchronisation, \`incrs\` increments give \`x + incrs\`.\n2. \`lostUpdate(x)\`: model the worst interleaving of **two** threads that both read the old \`x\`, so the result is \`x + 1\` (one increment lost). Return \`x + 1\`.\n3. \`isRaceResult(start, result, threads)\`: return \`true\` if \`result\` is **less than** \`start + threads\` (evidence that at least one update was lost).`,
      hints: ['Correct result adds one per increment.', 'A lost update shows up as a result below start + threads.'],
      starter: `// ${m.host}: lost update\nfunction sequential(x, incrs) {\n}\n\nfunction lostUpdate(x) {\n}\n\nfunction isRaceResult(start, result, threads) {\n}\n`,
      checks: [
        fn('sequential increments correctly', 'sequential', [{ args: [5, 3], expected: 8 }, { args: [0, 0], expected: 0 }]),
        fn('lostUpdate loses one increment', 'lostUpdate', [{ args: [5], expected: 6 }, { args: [0], expected: 1 }]),
        fn('isRaceResult detects a lost update', 'isRaceResult', [
          { args: [5, 6, 2], expected: true }, { args: [5, 7, 2], expected: false }, { args: [0, 2, 3], expected: true },
        ]),
      ],
      solution: `function sequential(x, incrs) {\n  return x + incrs;\n}\nfunction lostUpdate(x) {\n  return x + 1;\n}\nfunction isRaceResult(start, result, threads) {\n  return result < start + threads;\n}`,
      realityNote: 'A read-modify-write on shared data is not atomic; two threads can both read the old value and one update is lost — the canonical race condition that a lock prevents.',
    });
  }),
  tmpl(3, 1, 'intermediate', 'peterson', 'Implement Peterson\'s mutual exclusion', 'E1', 25, 'Model the flag-and-turn logic that lets exactly one of two threads enter the critical section.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Peterson's algorithm\n\nFor two threads (0 and 1) on **${m.host}**, Peterson\'s algorithm uses \`flag[0]\`, \`flag[1]\` and \`turn\`. Thread \`i\` may enter when the other\'s flag is down **or** it is \`i\`\'s turn. Write:\n\n1. \`canEnter(i, flag, turn)\`: return \`true\` when thread \`i\` may enter: \`flag[1-i] === false || turn === i\`.\n2. \`mutualExclusionHolds(flag, turn)\`: given both flags up (\`flag = [true, true]\`), return \`true\` only when **at most one** of the two threads satisfies \`canEnter\` — i.e. the algorithm never lets both in. (With both flags true, \`turn\` picks exactly one.)`,
      hints: ['Enter when the other flag is down or it is your turn.', 'With both flags up, only the thread whose turn it is may enter.'],
      starter: `// ${m.host}: Peterson's algorithm\nfunction canEnter(i, flag, turn) {\n}\n\nfunction mutualExclusionHolds(flag, turn) {\n}\n`,
      checks: [
        fn('canEnter follows the flag/turn rule', 'canEnter', [
          { args: [0, [true, false], 1], expected: true },
          { args: [0, [true, true], 0], expected: true },
          { args: [0, [true, true], 1], expected: false },
        ]),
        fn('mutualExclusionHolds never admits both', 'mutualExclusionHolds', [
          { args: [[true, true], 0], expected: true },
          { args: [[true, true], 1], expected: true },
        ]),
      ],
      solution: `function canEnter(i, flag, turn) {\n  return flag[1 - i] === false || turn === i;\n}\nfunction mutualExclusionHolds(flag, turn) {\n  const both = (canEnter(0, flag, turn) ? 1 : 0) + (canEnter(1, flag, turn) ? 1 : 0);\n  return both <= 1;\n}`,
      realityNote: 'Peterson\'s algorithm gives mutual exclusion for two threads using only shared memory; the turn variable breaks the tie when both want in, so both can never enter.',
    });
  }),
  tmpl(3, 1, 'advanced', 'test-and-set', 'Build a lock from test-and-set', 'E1', 25, 'Model the atomic test-and-set and compare-and-swap primitives and a spinlock on them.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Hardware atomics\n\nReal locks on **${m.host}** build on atomic primitives. Model them as pure functions returning the new state and result.\n\n1. \`testAndSet(lock)\`: return \`{ old: lock, lock: true }\` — atomically read the old value and set to true.\n2. \`compareAndSwap(value, expected, next)\`: return \`{ value: value === expected ? next : value, swapped: value === expected }\`.\n3. \`acquireSpinlock(lock)\`: using test-and-set semantics, return \`{ acquired: lock === false, lock: true }\` — you get the lock only if it was free, but it is set either way (a spinning thread retries).`,
      hints: ['test-and-set returns the old value and unconditionally sets true.', 'CAS swaps only when the current value matches expected.'],
      starter: `// ${m.host}: hardware atomics\nfunction testAndSet(lock) {\n}\n\nfunction compareAndSwap(value, expected, next) {\n}\n\nfunction acquireSpinlock(lock) {\n}\n`,
      checks: [
        fn('testAndSet reads old and sets true', 'testAndSet', [
          { args: [false], expected: { old: false, lock: true } },
          { args: [true], expected: { old: true, lock: true } },
        ]),
        fn('compareAndSwap swaps conditionally', 'compareAndSwap', [
          { args: [0, 0, 1], expected: { value: 1, swapped: true } },
          { args: [5, 0, 1], expected: { value: 5, swapped: false } },
        ]),
        fn('acquireSpinlock grants only a free lock', 'acquireSpinlock', [
          { args: [false], expected: { acquired: true, lock: true } },
          { args: [true], expected: { acquired: false, lock: true } },
        ]),
      ],
      solution: `function testAndSet(lock) {\n  return { old: lock, lock: true };\n}\nfunction compareAndSwap(value, expected, next) {\n  return { value: value === expected ? next : value, swapped: value === expected };\n}\nfunction acquireSpinlock(lock) {\n  return { acquired: lock === false, lock: true };\n}`,
      realityNote: 'Atomic instructions like test-and-set and compare-and-swap are the hardware foundation of all locks and lock-free data structures; a spinlock is the simplest thing you build on them.',
    });
  }),

  /* ------------------------------------------------------------------ 3.2 semaphores and classic problems */
  tmpl(3, 2, 'beginner', 'semaphore', 'Implement counting-semaphore operations', 'E1', 20, 'Model wait (P) and signal (V) on a counting semaphore and whether a thread blocks.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Semaphore wait and signal\n\nOn **${m.host}**, a counting semaphore has a value. Write:\n\n1. \`wait(value)\`: (the P operation) return \`{ value: value - 1, blocked: value <= 0 }\` — decrement; a thread blocks when the value was not positive.\n2. \`signal(value)\`: (the V operation) return \`value + 1\`.\n3. \`available(value)\`: return \`Math.max(0, value)\` — how many threads can proceed without blocking.`,
      hints: ['wait decrements and blocks when the value was <= 0.', 'signal simply increments.'],
      starter: `// ${m.host}: counting semaphore\nfunction wait(value) {\n}\n\nfunction signal(value) {\n}\n\nfunction available(value) {\n}\n`,
      checks: [
        fn('wait decrements and reports blocking', 'wait', [
          { args: [2], expected: { value: 1, blocked: false } },
          { args: [1], expected: { value: 0, blocked: false } },
          { args: [0], expected: { value: -1, blocked: true } },
        ]),
        fn('signal increments', 'signal', [{ args: [0], expected: 1 }, { args: [-1], expected: 0 }]),
        fn('available clamps at zero', 'available', [{ args: [3], expected: 3 }, { args: [-2], expected: 0 }]),
      ],
      solution: `function wait(value) {\n  return { value: value - 1, blocked: value <= 0 };\n}\nfunction signal(value) {\n  return value + 1;\n}\nfunction available(value) {\n  return Math.max(0, value);\n}`,
      realityNote: 'A counting semaphore\'s value, when negative, is the number of blocked waiters; wait (P) decrements and may block, signal (V) increments and may wake a waiter.',
    });
  }),
  tmpl(3, 2, 'intermediate', 'bounded-buffer', 'Account for a bounded producer-consumer buffer', 'E1', 25, 'Track the full/empty counts so producers and consumers block at the right times.', (v) => {
    const m = machineOf(v);
    const cap = v.pick([4, 5, 8]);
    return js({
      instructions: `## Producer-consumer with a bounded buffer (capacity ${cap})\n\nOn **${m.host}**, a buffer of capacity **${cap}** uses two semaphores: \`empty\` (free slots) and \`full\` (filled slots). Write:\n\n1. \`canProduce(empty)\`: a producer may proceed when \`empty > 0\`.\n2. \`canConsume(full)\`: a consumer may proceed when \`full > 0\`.\n3. \`afterProduce(empty, full)\`: return \`{ empty: empty - 1, full: full + 1 }\`.\n4. \`afterConsume(empty, full)\`: return \`{ empty: empty + 1, full: full - 1 }\`.\n\n(At start \`empty = ${cap}\`, \`full = 0\`.)`,
      hints: ['Producing takes an empty slot and adds a full one.', 'Consuming does the reverse.'],
      starter: `// ${m.host}: bounded buffer\nfunction canProduce(empty) {\n}\n\nfunction canConsume(full) {\n}\n\nfunction afterProduce(empty, full) {\n}\n\nfunction afterConsume(empty, full) {\n}\n`,
      checks: [
        fn('canProduce checks free slots', 'canProduce', [{ args: [1], expected: true }, { args: [0], expected: false }]),
        fn('canConsume checks filled slots', 'canConsume', [{ args: [1], expected: true }, { args: [0], expected: false }]),
        fn('afterProduce updates counts', 'afterProduce', [{ args: [cap, 0], expected: { empty: cap - 1, full: 1 } }]),
        fn('afterConsume updates counts', 'afterConsume', [{ args: [cap - 1, 1], expected: { empty: cap, full: 0 } }]),
      ],
      solution: `function canProduce(empty) {\n  return empty > 0;\n}\nfunction canConsume(full) {\n  return full > 0;\n}\nfunction afterProduce(empty, full) {\n  return { empty: empty - 1, full: full + 1 };\n}\nfunction afterConsume(empty, full) {\n  return { empty: empty + 1, full: full - 1 };\n}`,
      realityNote: 'The bounded-buffer solution uses an empty and a full semaphore (plus a mutex) so producers block when full and consumers block when empty — the archetypal synchronisation problem.',
    });
  }),
  tmpl(3, 2, 'advanced', 'readers-writers', 'Coordinate readers and writers', 'E1', 25, 'Decide when a reader or writer may proceed given current readers and an active writer.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Readers-writers\n\nOn **${m.host}**, many readers may share access, but a writer needs exclusive access. Write:\n\n1. \`canRead(state)\`: \`state = { readers, writing, waitingWriters }\`. A reader may proceed when no one is \`writing\` **and** (writer-preference) there are no \`waitingWriters\`. Return \`true\`/\`false\`.\n2. \`canWrite(state)\`: a writer may proceed when \`readers === 0\` and not \`writing\`.\n3. \`startRead(state)\`/\`startWrite(state)\`: return the new state after a reader enters (\`readers + 1\`) or a writer enters (\`writing: true\`).`,
      hints: ['Writer preference: a reader waits if writers are queued.', 'A writer needs zero readers and no active writer.'],
      starter: `// ${m.host}: readers-writers\nfunction canRead(state) {\n}\n\nfunction canWrite(state) {\n}\n\nfunction startRead(state) {\n}\n\nfunction startWrite(state) {\n}\n`,
      checks: [
        fn('canRead respects writers', 'canRead', [
          { args: [{ readers: 2, writing: false, waitingWriters: 0 }], expected: true },
          { args: [{ readers: 0, writing: true, waitingWriters: 0 }], expected: false },
          { args: [{ readers: 1, writing: false, waitingWriters: 1 }], expected: false },
        ]),
        fn('canWrite needs exclusivity', 'canWrite', [
          { args: [{ readers: 0, writing: false, waitingWriters: 1 }], expected: true },
          { args: [{ readers: 2, writing: false, waitingWriters: 0 }], expected: false },
        ]),
        fn('startRead and startWrite update state', 'startRead', [
          { args: [{ readers: 1, writing: false, waitingWriters: 0 }], expected: { readers: 2, writing: false, waitingWriters: 0 } },
        ]),
      ],
      solution: `function canRead(state) {\n  return !state.writing && state.waitingWriters === 0;\n}\nfunction canWrite(state) {\n  return state.readers === 0 && !state.writing;\n}\nfunction startRead(state) {\n  return { ...state, readers: state.readers + 1 };\n}\nfunction startWrite(state) {\n  return { ...state, writing: true };\n}`,
      realityNote: 'The readers-writers problem has reader-preference, writer-preference and fair variants; writer-preference (readers wait when a writer is queued) prevents writer starvation.',
    });
  }),

  /* ------------------------------------------------------------------ 3.3 deadlock */
  tmpl(3, 3, 'beginner', 'deadlock-conditions', 'Check the four deadlock conditions', 'E10', 15, 'Reason about the four necessary conditions for deadlock and how breaking one prevents it.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## The four conditions\n\nTwo processes on **${m.host}** are stuck, each holding a resource the other needs. Reason about why, using the four necessary conditions for deadlock.`,
      steps: [
        { title: 'Mutual exclusion', text: 'Why does the resource type matter?', choices: [
          { text: 'Deadlock needs non-shareable resources held in mutual exclusion (only one holder at a time)', right: true, feedback: 'Correct. Freely shareable resources cannot deadlock.' },
          { text: 'Only shareable resources deadlock', feedback: 'It is the opposite: exclusive, non-shareable resources.' },
          { text: 'Resource type is irrelevant', feedback: 'Mutual exclusion is one of the four conditions.' },
        ] },
        { title: 'Hold and wait', text: 'What is the second condition?', choices: [
          { text: 'A process holds at least one resource while waiting for another', right: true, feedback: 'Correct. Holding while waiting is required.' },
          { text: 'Processes never hold resources', feedback: 'Then there would be nothing to deadlock over.' },
          { text: 'Processes release everything before waiting', feedback: 'That would break hold-and-wait and prevent deadlock.' },
        ] },
        { title: 'No preemption', text: 'What does "no preemption" mean here?', choices: [
          { text: 'Resources cannot be forcibly taken from a process; they are released only voluntarily', right: true, feedback: 'Correct. If the OS could preempt, it could break the cycle.' },
          { text: 'The CPU cannot be preempted', feedback: 'This condition is about the contended resources, not the CPU.' },
          { text: 'Processes can be killed any time', feedback: 'No preemption is about resources not being taken away.' },
        ] },
        { title: 'Circular wait', text: 'What completes the deadlock?', choices: [
          { text: 'A cycle of processes each waiting for a resource held by the next', right: true, feedback: 'Correct. The circular wait closes the loop; all four together cause deadlock.' },
          { text: 'A single process waiting alone', feedback: 'One process cannot deadlock itself on distinct resources this way.' },
          { text: 'Nothing; three conditions suffice', feedback: 'All four are necessary.' },
        ] },
      ],
      ending: { title: 'Break one condition to prevent it', text: 'Deadlock needs mutual exclusion, hold-and-wait, no preemption and circular wait all at once; preventing any one — e.g. ordering resources to stop circular wait — prevents deadlock.' },
      hints: ['Four conditions must all hold: mutual exclusion, hold-and-wait, no preemption, circular wait.', 'Breaking any single one prevents deadlock.'],
      realityNote: 'Coffman\'s four conditions are necessary together; practical prevention usually attacks circular wait by imposing a global order on resource acquisition.',
    });
  }),
  tmpl(3, 3, 'intermediate', 'bankers', 'Decide safety with the banker\'s algorithm', 'E1', 30, 'Implement the safety check that grants a request only if a safe sequence still exists.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The banker's algorithm (single resource type)\n\nOn **${m.host}**, use a one-resource-type banker\'s check. Each process has \`{ id, max, held }\`; the bank has \`available\` free units. A process\'s **need** is \`max - held\`. Write:\n\n1. \`need(p)\`: return \`p.max - p.held\`.\n2. \`isSafe(processes, available)\`: return \`true\` if there is an order in which every process can finish — repeatedly pick any unfinished process whose \`need <= available\`, add its \`held\` back to \`available\` when it finishes; safe if all finish.\n3. \`canGrant(processes, available, id, request)\`: tentatively give \`request\` units to process \`id\` (reduce available, increase its held), and return \`true\` only if the resulting state \`isSafe\`.`,
      hints: ['isSafe simulates finishing processes whose need fits the available pool.', 'canGrant applies the request to a copy, then checks safety.'],
      starter: `// ${m.host}: banker's algorithm\nfunction need(p) {\n}\n\nfunction isSafe(processes, available) {\n}\n\nfunction canGrant(processes, available, id, request) {\n}\n`,
      checks: [
        fn('need is max minus held', 'need', [{ args: [{ max: 5, held: 2 }], expected: 3 }]),
        fn('isSafe finds a safe sequence', 'isSafe', [
          { args: [[{ id: 'A', max: 5, held: 2 }, { id: 'B', max: 4, held: 1 }], 3], expected: true },
          { args: [[{ id: 'A', max: 10, held: 5 }, { id: 'B', max: 10, held: 4 }], 1], expected: false },
        ]),
        fn('canGrant checks the resulting state', 'canGrant', [
          { args: [[{ id: 'A', max: 5, held: 2 }, { id: 'B', max: 4, held: 1 }], 3, 'A', 1], expected: true },
          { args: [[{ id: 'A', max: 10, held: 5 }, { id: 'B', max: 10, held: 4 }], 1, 'A', 1], expected: false },
        ]),
      ],
      solution: `function need(p) {\n  return p.max - p.held;\n}\nfunction isSafe(processes, available) {\n  const work = processes.map((p) => ({ ...p, finished: false }));\n  let avail = available;\n  let progress = true;\n  while (progress) {\n    progress = false;\n    for (const p of work) {\n      if (!p.finished && need(p) <= avail) {\n        avail += p.held;\n        p.finished = true;\n        progress = true;\n      }\n    }\n  }\n  return work.every((p) => p.finished);\n}\nfunction canGrant(processes, available, id, request) {\n  const copy = processes.map((p) => (p.id === id ? { ...p, held: p.held + request } : { ...p }));\n  return isSafe(copy, available - request);\n}`,
      realityNote: 'The banker\'s algorithm grants a resource request only if the system stays in a safe state — one where some order lets every process acquire its maximum and finish.',
    });
  }),
  tmpl(3, 3, 'advanced', 'deadlock-detect', 'Detect a cycle in a wait-for graph', 'E1', 25, 'Find whether processes are deadlocked by detecting a cycle in the wait-for graph.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Detecting deadlock\n\nOn **${m.host}**, a wait-for graph has an edge \`P → Q\` meaning P waits for a resource held by Q. A cycle means deadlock. Write:\n\n1. \`hasCycle(graph)\`: \`graph\` maps a node to an array of nodes it waits for. Return \`true\` if the directed graph has any cycle.\n2. \`deadlocked(graph)\`: return \`true\` when \`hasCycle(graph)\` (there is a deadlock).`,
      hints: ['Depth-first search tracking nodes on the current recursion stack detects a back-edge (cycle).', 'A node already on the stack means a cycle.'],
      starter: `// ${m.host}: deadlock detection\nfunction hasCycle(graph) {\n}\n\nfunction deadlocked(graph) {\n}\n`,
      checks: [
        fn('hasCycle finds cycles', 'hasCycle', [
          { args: [{ A: ['B'], B: ['C'], C: ['A'] }], expected: true },
          { args: [{ A: ['B'], B: ['C'], C: [] }], expected: false },
          { args: [{ A: ['B'], B: ['A'] }], expected: true },
          { args: [{ A: [], B: [] }], expected: false },
        ]),
        fn('deadlocked reflects a cycle', 'deadlocked', [
          { args: [{ A: ['B'], B: ['A'] }], expected: true },
          { args: [{ A: ['B'], B: [] }], expected: false },
        ]),
      ],
      solution: `function hasCycle(graph) {\n  const WHITE = 0, GREY = 1, BLACK = 2;\n  const colour = {};\n  for (const n of Object.keys(graph)) colour[n] = WHITE;\n  const visit = (n) => {\n    colour[n] = GREY;\n    for (const next of graph[n] || []) {\n      if (colour[next] === GREY) return true;\n      if (colour[next] === WHITE && visit(next)) return true;\n    }\n    colour[n] = BLACK;\n    return false;\n  };\n  for (const n of Object.keys(graph)) if (colour[n] === WHITE && visit(n)) return true;\n  return false;\n}\nfunction deadlocked(graph) {\n  return hasCycle(graph);\n}`,
      realityNote: 'Deadlock detection builds a wait-for graph and looks for a cycle; with one instance per resource type, a cycle is exactly a deadlock.',
    });
  }),

  /* ------------------------------------------------------------------ 3.4 concurrency bugs */
  tmpl(3, 4, 'beginner', 'concurrency-bugs', 'Classify a concurrency bug', 'E10', 15, 'Tell atomicity violations from order violations and pick the fix.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Two kinds of concurrency bug\n\nCode on **${m.host}** has two intermittent failures. Classify each and choose the fix.`,
      steps: [
        { title: 'The first bug', text: 'A check-then-act — `if (ptr) ptr.use()` — crashes because another thread set `ptr` to null between the check and the use. Which kind?', choices: [
          { text: 'Atomicity violation — the check and act must be one atomic region under a lock', right: true, feedback: 'Correct. The two steps must not be interleaved.' },
          { text: 'Order violation', feedback: 'It is about atomicity of the check-then-act, not ordering between threads.' },
          { text: 'Not a concurrency bug', feedback: 'The interleaving is exactly the problem.' },
        ] },
        { title: 'The second bug', text: 'A thread reads a value that another thread was supposed to initialise first, but sometimes runs too early. Which kind?', choices: [
          { text: 'Order violation — the required happens-before ordering is not enforced', right: true, feedback: 'Correct. The expected order between threads is not guaranteed.' },
          { text: 'Atomicity violation', feedback: 'The issue is ordering, not an interleaved region.' },
          { text: 'A memory leak', feedback: 'It is a synchronisation-ordering bug.' },
        ] },
        { title: 'Fixing the order bug', text: 'How do you enforce the ordering?', choices: [
          { text: 'Use a condition variable or a semaphore so the reader waits until initialisation signals completion', right: true, feedback: 'Correct. Signal/wait enforces the happens-before.' },
          { text: 'Add a random sleep', feedback: 'Sleeps are a flaky non-fix; use real synchronisation.' },
          { text: 'Run on one core', feedback: 'The ordering must be enforced, not avoided by luck.' },
        ] },
        { title: 'Lock-free alternatives', text: 'When might you use a lock-free structure instead of a lock?', choices: [
          { text: 'For high-contention hot paths, using atomic compare-and-swap — but they are hard to get right', right: true, feedback: 'Correct. Lock-free can scale better but is subtle and easy to get wrong.' },
          { text: 'Always; locks are never needed', feedback: 'Locks are simpler and correct for most code.' },
          { text: 'Never; lock-free is impossible', feedback: 'Lock-free structures exist and are used in hot paths.' },
        ] },
      ],
      ending: { title: 'Name the bug, then synchronise', text: 'Atomicity violations need the interleaved steps made atomic under a lock; order violations need the required ordering enforced with a condition variable or semaphore; lock-free structures help hot paths but are hard to get right.' },
      hints: ['Atomicity violation = interleaved region; order violation = missing happens-before.', 'Fix ordering with signal/wait, not sleeps.'],
      realityNote: 'Studies of real concurrency bugs (Lu et al.) found most are atomicity or order violations; naming which one points straight at the right synchronisation fix.',
    });
  }),
  tmpl(3, 4, 'intermediate', 'lock-ordering', 'Prevent deadlock with a lock order', 'E1', 25, 'Enforce a global lock acquisition order so two threads cannot deadlock.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Always lock in the same order\n\nOn **${m.host}**, deadlock between two locks is prevented by always acquiring them in a fixed global order. Write:\n\n1. \`orderedAcquire(locks, order)\`: \`locks\` is the set of lock names a thread needs; \`order\` is the global ordering array. Return the locks sorted by their index in \`order\` (acquire in this sequence).\n2. \`isSafeOrder(sequence, order)\`: return \`true\` if \`sequence\` (the order a thread actually acquires locks) is non-decreasing in global order — i.e. it never acquires a lower-ordered lock after a higher-ordered one.`,
      hints: ['Sort the needed locks by their position in the global order.', 'A safe sequence never goes "backwards" in the global order.'],
      starter: `// ${m.host}: lock ordering\nfunction orderedAcquire(locks, order) {\n}\n\nfunction isSafeOrder(sequence, order) {\n}\n`,
      checks: [
        fn('orderedAcquire sorts by global order', 'orderedAcquire', [
          { args: [['B', 'A'], ['A', 'B', 'C']], expected: ['A', 'B'] },
          { args: [['C', 'A', 'B'], ['A', 'B', 'C']], expected: ['A', 'B', 'C'] },
        ]),
        fn('isSafeOrder checks monotonicity', 'isSafeOrder', [
          { args: [['A', 'B', 'C'], ['A', 'B', 'C']], expected: true },
          { args: [['B', 'A'], ['A', 'B', 'C']], expected: false },
          { args: [['A', 'C'], ['A', 'B', 'C']], expected: true },
        ]),
      ],
      solution: `function orderedAcquire(locks, order) {\n  return [...locks].sort((a, b) => order.indexOf(a) - order.indexOf(b));\n}\nfunction isSafeOrder(sequence, order) {\n  for (let i = 1; i < sequence.length; i++) {\n    if (order.indexOf(sequence[i]) < order.indexOf(sequence[i - 1])) return false;\n  }\n  return true;\n}`,
      realityNote: 'Imposing a global lock order is the standard way to prevent the circular wait that causes lock-based deadlock; the kernel documents lock ordering for exactly this reason.',
    });
  }),
  tmpl(3, 4, 'advanced', 'double-checked-init', 'Get lazy initialisation right', 'E1', 25, 'Model safe once-only initialisation so a value is created exactly once under contention.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Initialise exactly once\n\nOn **${m.host}**, a value must be created only once even if several threads race to use it. Model the "once" primitive on a shared state \`{ done, value }\`. Write:\n\n1. \`getOrInit(state, factory)\`: if \`state.done\` is true, return \`{ state, value: state.value, created: false }\`; otherwise produce \`factory\` (a plain value passed in, standing for the computed result), return \`{ state: { done: true, value: factory }, value: factory, created: true }\`.\n2. \`createdCount(results)\`: given an array of the \`created\` booleans from several threads, return how many actually created the value — a correct once-primitive yields **exactly 1** across a run (count the trues).`,
      hints: ['Only the first caller (done false) creates; the rest reuse.', 'createdCount sums the true flags.'],
      starter: `// ${m.host}: initialise once\nfunction getOrInit(state, factory) {\n}\n\nfunction createdCount(results) {\n}\n`,
      checks: [
        fn('getOrInit creates once then reuses', 'getOrInit', [
          { args: [{ done: false, value: null }, 42], expected: { state: { done: true, value: 42 }, value: 42, created: true } },
          { args: [{ done: true, value: 42 }, 99], expected: { state: { done: true, value: 42 }, value: 42, created: false } },
        ]),
        fn('createdCount counts the creators', 'createdCount', [
          { args: [[true, false, false]], expected: 1 },
          { args: [[false, false]], expected: 0 },
        ]),
      ],
      solution: `function getOrInit(state, factory) {\n  if (state.done) return { state, value: state.value, created: false };\n  const next = { done: true, value: factory };\n  return { state: next, value: factory, created: true };\n}\nfunction createdCount(results) {\n  return results.filter(Boolean).length;\n}`,
      realityNote: 'Lazy once-only initialisation (std::call_once, sync.Once, a correctly-done double-checked lock) must guarantee exactly one creation under contention; getting it wrong gives duplicate or torn initialisation.',
    });
  }),

  /* ------------------------------------------------------------------ 3.5 inter-process communication */
  tmpl(3, 5, 'beginner', 'ipc-choice', 'Choose an IPC mechanism', 'E10', 15, 'Match an inter-process communication need to the right mechanism.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Which IPC fits?\n\nProcesses on **${m.host}** need to communicate in different ways. Match each need to a mechanism.`,
      steps: [
        { title: 'Fastest bulk sharing', text: 'Two processes must share a large buffer with the least copying. What fits?', choices: [
          { text: 'Shared memory — map the same region into both; fastest, but needs its own synchronisation', right: true, feedback: 'Correct. Shared memory avoids copies but you must synchronise access.' },
          { text: 'A pipe, copying every byte', feedback: 'Pipes copy through the kernel; shared memory is faster for bulk data.' },
          { text: 'A network socket to itself', feedback: 'Overkill and slower for local bulk sharing.' },
        ] },
        { title: 'Simple stream between parent and child', text: 'A parent wants to stream output to a child it spawned. What fits?', choices: [
          { text: 'A pipe — a simple unidirectional byte stream between related processes', right: true, feedback: 'Correct. Pipes connect related processes with a byte stream.' },
          { text: 'Shared memory with no synchronisation', feedback: 'A pipe is simpler and already synchronised for streaming.' },
          { text: 'Signals carrying the data', feedback: 'Signals carry no data payload beyond the signal number.' },
        ] },
        { title: 'Structured messages, possibly remote', text: 'Processes (maybe on different machines) exchange discrete messages. What fits?', choices: [
          { text: 'Message passing over sockets — works locally and across the network', right: true, feedback: 'Correct. Sockets carry messages locally or over a network.' },
          { text: 'Shared memory across machines', feedback: 'Shared memory does not span separate machines.' },
          { text: 'A pipe across the internet', feedback: 'Pipes are local to related processes.' },
        ] },
        { title: 'Just a notification', text: 'One process only needs to tell another "something happened". What fits?', choices: [
          { text: 'A signal — a lightweight asynchronous notification (no data payload)', right: true, feedback: 'Correct. Signals are for simple asynchronous notification.' },
          { text: 'A full shared-memory region', feedback: 'Heavy for a mere notification.' },
          { text: 'Opening a database', feedback: 'Far too heavy for a notification.' },
        ] },
      ],
      ending: { title: 'Match the mechanism to the need', text: 'Shared memory for fast bulk sharing (with your own synchronisation), pipes for simple streams between related processes, sockets/message passing for structured and possibly remote messages, and signals for lightweight notifications.' },
      hints: ['Shared memory = fast bulk; pipe = local stream; socket = messages, maybe remote; signal = notification.', 'Shared memory needs its own synchronisation.'],
      realityNote: 'The POSIX IPC toolkit — shared memory, pipes, message queues, sockets and signals — each suits a different communication shape; choosing well avoids both overhead and complexity.',
    });
  }),
  tmpl(3, 5, 'intermediate', 'message-queue', 'Model a bounded message queue', 'E1', 20, 'Enqueue and dequeue messages with a capacity bound and FIFO order.', (v) => {
    const m = machineOf(v);
    const cap = v.pick([3, 4, 5]);
    return js({
      instructions: `## A bounded message queue (capacity ${cap})\n\nFor IPC on **${m.host}**, model a FIFO queue of capacity **${cap}**. A queue is an array of messages. Write:\n\n1. \`enqueue(queue, msg, capacity)\`: if \`queue.length < capacity\`, return \`{ ok: true, queue: [...queue, msg] }\`; else \`{ ok: false, queue }\` (sender blocks/fails when full).\n2. \`dequeue(queue)\`: if empty, return \`{ ok: false, queue: [], msg: null }\`; else return \`{ ok: true, queue: <rest>, msg: <first> }\` (FIFO).`,
      hints: ['Enqueue appends unless full; dequeue removes the front.', 'Keep FIFO order: first in, first out.'],
      starter: `// ${m.host}: bounded message queue\nfunction enqueue(queue, msg, capacity) {\n}\n\nfunction dequeue(queue) {\n}\n`,
      checks: [
        fn('enqueue respects the capacity', 'enqueue', [
          { args: [['a'], 'b', cap], expected: { ok: true, queue: ['a', 'b'] } },
          { args: [Array(cap).fill('x'), 'y', cap], expected: { ok: false, queue: Array(cap).fill('x') } },
        ]),
        fn('dequeue removes the front', 'dequeue', [
          { args: [['a', 'b']], expected: { ok: true, queue: ['b'], msg: 'a' } },
          { args: [[]], expected: { ok: false, queue: [], msg: null } },
        ]),
      ],
      solution: `function enqueue(queue, msg, capacity) {\n  if (queue.length < capacity) return { ok: true, queue: [...queue, msg] };\n  return { ok: false, queue };\n}\nfunction dequeue(queue) {\n  if (!queue.length) return { ok: false, queue: [], msg: null };\n  return { ok: true, queue: queue.slice(1), msg: queue[0] };\n}`,
      realityNote: 'A bounded message queue blocks senders when full and receivers when empty — the same flow control as the bounded buffer, applied to IPC messages.',
    });
  }),
  tmpl(3, 5, 'advanced', 'pipe-flow', 'Model pipe flow control', 'E1', 25, 'Track bytes through a fixed-size pipe buffer where writers and readers block.', (v) => {
    const m = machineOf(v);
    const cap = v.pick([8, 16]);
    return js({
      instructions: `## Flow control in a pipe (buffer ${cap} bytes)\n\nA pipe on **${m.host}** has a **${cap}**-byte kernel buffer. Writers block when it is full; readers block when it is empty. Write:\n\n1. \`write(buffered, n, capacity)\`: a writer offers \`n\` bytes. Write as many as fit: \`written = min(n, capacity - buffered)\`. Return \`{ written, buffered: buffered + written, blocked: written < n }\`.\n2. \`read(buffered, n)\`: a reader requests \`n\` bytes. Read \`got = min(n, buffered)\`. Return \`{ got, buffered: buffered - got, blocked: got < n }\`.`,
      hints: ['A writer blocks if it could not place all its bytes.', 'A reader blocks if fewer bytes were available than requested.'],
      starter: `// ${m.host}: pipe flow control\nfunction write(buffered, n, capacity) {\n}\n\nfunction read(buffered, n) {\n}\n`,
      checks: [
        fn('write fills up to capacity', 'write', [
          { args: [0, 5, cap], expected: { written: 5, buffered: 5, blocked: false } },
          { args: [cap - 2, 5, cap], expected: { written: 2, buffered: cap, blocked: true } },
        ]),
        fn('read drains up to what is buffered', 'read', [
          { args: [5, 3], expected: { got: 3, buffered: 2, blocked: false } },
          { args: [2, 5], expected: { got: 2, buffered: 0, blocked: true } },
        ]),
      ],
      solution: `function write(buffered, n, capacity) {\n  const written = Math.min(n, capacity - buffered);\n  return { written, buffered: buffered + written, blocked: written < n };\n}\nfunction read(buffered, n) {\n  const got = Math.min(n, buffered);\n  return { got, buffered: buffered - got, blocked: got < n };\n}`,
      realityNote: 'Pipes have a finite kernel buffer; a writer blocks when it fills and a reader blocks when it empties, giving automatic flow control between producer and consumer.',
    });
  }),
];
