/** Unit 1: introduction to operating systems — what an OS does, kernel/user mode and system calls,
 * OS structures, process creation with fork/exec/wait, and running a teaching kernel. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U1: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 1.1 what an OS does */
  tmpl(1, 1, 'beginner', 'what-os-does', 'Identify what an operating system does', 'E10', 15, 'Reason about the core jobs of an OS: abstraction, virtualisation, resource management and protection.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## The jobs of the OS\n\nOn **${m.host}** (${m.use}), many programs share one machine. Reason about what the operating system does for them.`,
      steps: [
        { title: 'Abstraction', text: 'Why does a program open a "file" instead of addressing disk sectors?', choices: [
          { text: 'The OS abstracts hardware into clean interfaces (files, processes, sockets) so programs are portable and simple', right: true, feedback: 'Correct. Abstraction hides messy hardware behind tidy interfaces.' },
          { text: 'Because disks have no sectors', feedback: 'Disks do have sectors; the OS hides them behind the file abstraction.' },
          { text: 'To make programs slower', feedback: 'Abstraction is for portability and simplicity, not slowness.' },
        ] },
        { title: 'Virtualisation', text: 'Two programs both think they have the whole CPU and memory. How?', choices: [
          { text: 'The OS virtualises the CPU (time-sharing) and memory (per-process address spaces) so each gets its own illusion', right: true, feedback: 'Correct. Virtualisation gives each process its own view of the machine.' },
          { text: 'Each program really owns all the hardware', feedback: 'They share it; the OS creates the illusion of ownership.' },
          { text: 'The CPU is duplicated for each program', feedback: 'One CPU is time-shared, not duplicated.' },
        ] },
        { title: 'Resource management', text: 'Many processes want the CPU, memory and disk at once. What does the OS do?', choices: [
          { text: 'Schedules and allocates shared resources fairly and efficiently among competing processes', right: true, feedback: 'Correct. The OS is a resource manager and arbiter.' },
          { text: 'Lets whichever process asks first keep everything', feedback: 'That would starve others; the OS arbitrates.' },
          { text: 'Refuses all but one program', feedback: 'The OS multiplexes resources among many programs.' },
        ] },
        { title: 'Protection', text: 'One buggy program must not corrupt another or the OS. What enforces this?', choices: [
          { text: 'Hardware-supported protection: separate address spaces and privilege levels the OS controls', right: true, feedback: 'Correct. Isolation and privilege levels protect processes and the kernel.' },
          { text: 'Asking programmers to be careful', feedback: 'Protection is enforced by hardware and the OS, not by goodwill.' },
          { text: 'Nothing; crashes are unavoidable', feedback: 'Isolation contains a crashing process.' },
        ] },
      ],
      ending: { title: 'Abstraction, virtualisation, management, protection', text: 'The OS turns raw hardware into clean abstractions, virtualises the CPU and memory so each process gets its own view, manages shared resources, and enforces protection between processes and the kernel.' },
      hints: ['Four jobs: abstraction, virtualisation, resource management, protection.', 'Each process gets the illusion of its own machine.'],
      realityNote: 'These four roles — abstraction, virtualisation, resource management and protection — are the standard way textbooks (Silberschatz, OSTEP) frame what an operating system is for.',
    });
  }),
  tmpl(1, 1, 'intermediate', 'classify-resource', 'Classify the resources an OS manages', 'E1', 20, 'Map operations to the hardware resource the OS arbitrates for them.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Which resource is being managed?\n\nOn **${m.host}**, map each operation to the resource the OS manages for it. Write \`resourceFor(op)\`:\n\n- \`"run-instructions"\`, \`"schedule-thread"\` → \`"cpu"\`;\n- \`"allocate-pages"\`, \`"map-memory"\` → \`"memory"\`;\n- \`"read-file"\`, \`"write-file"\` → \`"storage"\`;\n- \`"send-packet"\`, \`"open-socket"\` → \`"network"\`;\n- anything else → \`"other"\`.\n\nAlso \`countByResource(ops)\`: given an array of operations, return an object mapping each resource that appears to how many operations map to it.`,
      hints: ['A simple lookup with a default of "other".', 'For the count, tally resourceFor over the array.'],
      starter: `// ${m.host}: classify managed resources\nfunction resourceFor(op) {\n}\n\nfunction countByResource(ops) {\n}\n`,
      checks: [
        fn('resourceFor maps operations', 'resourceFor', [
          { args: ['run-instructions'], expected: 'cpu' }, { args: ['allocate-pages'], expected: 'memory' },
          { args: ['read-file'], expected: 'storage' }, { args: ['send-packet'], expected: 'network' }, { args: ['beep'], expected: 'other' },
        ]),
        fn('countByResource tallies them', 'countByResource', [
          { args: [['read-file', 'write-file', 'run-instructions']], expected: { storage: 2, cpu: 1 } },
          { args: [[]], expected: {} },
        ]),
      ],
      solution: `function resourceFor(op) {\n  const map = {\n    "run-instructions": "cpu", "schedule-thread": "cpu",\n    "allocate-pages": "memory", "map-memory": "memory",\n    "read-file": "storage", "write-file": "storage",\n    "send-packet": "network", "open-socket": "network",\n  };\n  return map[op] || "other";\n}\nfunction countByResource(ops) {\n  const out = {};\n  for (const op of ops) {\n    const r = resourceFor(op);\n    out[r] = (out[r] || 0) + 1;\n  }\n  return out;\n}`,
      realityNote: 'The CPU, memory, storage and network are the four big resources an OS arbitrates; every system call ultimately asks for one of them.',
    });
  }),
  tmpl(1, 1, 'advanced', 'os-history', 'Trace the evolution of operating systems', 'E10', 20, 'Reason about why OS design moved from batch to time-sharing to cloud and mobile.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Why OS design changed\n\nThe ideas behind **${m.host}**\'s OS evolved over decades. Reason about each step and what drove it.`,
      steps: [
        { title: 'Batch systems', text: 'Early batch systems ran one job after another. What was the limitation?', choices: [
          { text: 'The CPU sat idle during slow I/O, and users waited a long time for results', right: true, feedback: 'Correct. Poor CPU use and long turnaround drove the next step.' },
          { text: 'They were too interactive', feedback: 'Batch systems were the opposite of interactive.' },
          { text: 'They used too little memory', feedback: 'The problem was idle CPU and turnaround, not memory.' },
        ] },
        { title: 'Multiprogramming and time-sharing', text: 'What did keeping several jobs in memory enable?', choices: [
          { text: 'The CPU switches to another job during I/O, and time-sharing gives interactive response to many users', right: true, feedback: 'Correct. Overlap I/O with compute, and share the CPU interactively.' },
          { text: 'Running without any scheduler', feedback: 'Multiprogramming needs scheduling to pick the next job.' },
          { text: 'Eliminating the need for memory protection', feedback: 'Sharing memory among jobs made protection more necessary.' },
        ] },
        { title: 'Personal and networked', text: 'What did personal computers and networks add to the picture?', choices: [
          { text: 'A machine per user with a GUI, and later networked services and shared resources', right: true, feedback: 'Correct. Cheap hardware put an OS on every desk, then connected them.' },
          { text: 'A return to single-job batch processing', feedback: 'The trend was toward interactivity and connectivity.' },
          { text: 'The end of operating systems', feedback: 'Each PC still needed an OS.' },
        ] },
        { title: 'Cloud and mobile', text: 'What do cloud and mobile operating systems emphasise today?', choices: [
          { text: 'Virtualisation and containers at scale in the cloud; power, security and sandboxing on mobile', right: true, feedback: 'Correct. Scale and isolation in the cloud; energy and app isolation on mobile.' },
          { text: 'Exactly the same concerns as 1960s batch systems', feedback: 'The constraints (power, scale, security) are new.' },
          { text: 'No operating system at all', feedback: 'Both rely heavily on OS services.' },
        ] },
      ],
      ending: { title: 'Driven by hardware and use', text: 'OS design moved from batch (use the CPU better) to time-sharing (interactive sharing) to personal and networked machines, and now to cloud virtualisation and power- and security-conscious mobile systems — each step driven by changing hardware and how people use computers.' },
      hints: ['Each era solved the previous one\'s main limitation.', 'Idle CPU drove multiprogramming; interactivity drove time-sharing.'],
      realityNote: 'The batch → multiprogramming → time-sharing → personal → networked → cloud/mobile arc is the standard history; each transition was driven by hardware cost and new ways of using machines.',
    });
  }),

  /* ------------------------------------------------------------------ 1.2 kernel/user mode and system calls */
  tmpl(1, 2, 'beginner', 'privileged-ops', 'Tell privileged operations from unprivileged', 'E1', 20, 'Classify operations as needing kernel mode or allowed in user mode.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Only the kernel may do some things\n\nOn **${m.host}**, some operations are privileged (kernel mode only); user programs must ask via a system call. Write \`isPrivileged(op)\`: return \`true\` for operations only the kernel may do directly — \`"disable-interrupts"\`, \`"set-page-table"\`, \`"access-io-port"\`, \`"halt-cpu"\`, \`"switch-to-kernel-mode"\` — and \`false\` for ordinary user operations like \`"add"\`, \`"load-register"\`, \`"compare"\`, \`"jump"\`.\n\nAlso \`needsSyscall(op)\`: a user program that wants a privileged effect must use a system call; return \`true\` exactly when \`isPrivileged(op)\`.`,
      hints: ['Keep the privileged set and test membership.', 'User programs reach privileged effects only through system calls.'],
      starter: `// ${m.host}: privileged vs unprivileged\nfunction isPrivileged(op) {\n}\n\nfunction needsSyscall(op) {\n}\n`,
      checks: [
        fn('isPrivileged knows the privileged set', 'isPrivileged', [
          { args: ['disable-interrupts'], expected: true }, { args: ['set-page-table'], expected: true }, { args: ['halt-cpu'], expected: true },
          { args: ['add'], expected: false }, { args: ['jump'], expected: false }, { args: ['load-register'], expected: false },
        ]),
        fn('needsSyscall matches privileged ops', 'needsSyscall', [
          { args: ['access-io-port'], expected: true }, { args: ['compare'], expected: false },
        ]),
      ],
      solution: `function isPrivileged(op) {\n  return ["disable-interrupts", "set-page-table", "access-io-port", "halt-cpu", "switch-to-kernel-mode"].includes(op);\n}\nfunction needsSyscall(op) {\n  return isPrivileged(op);\n}`,
      realityNote: 'A privileged instruction run in user mode traps to the kernel; this user/kernel split, enforced by hardware, is what lets the OS protect itself and the hardware.',
    });
  }),
  tmpl(1, 2, 'intermediate', 'syscall-dispatch', 'Dispatch a system call by number', 'E1', 25, 'Route a system-call number to its handler and validate the arguments.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The system-call boundary\n\nOn **${m.host}**, a trap enters the kernel with a syscall number and arguments. Write \`dispatch(num, args, table)\` where \`table\` maps a number to \`{ name, arity }\`:\n\n- if \`num\` is not a key of \`table\` → \`{ error: "ENOSYS" }\` (no such syscall);\n- if \`args.length !== table[num].arity\` → \`{ error: "EINVAL" }\`;\n- otherwise → \`{ ok: true, name: table[num].name }\`.\n\nAlso \`validNumbers(table)\`: return the syscall numbers (keys) as a sorted array of numbers.`,
      hints: ['Use hasOwnProperty to check the number is known.', 'Compare args.length to the declared arity.'],
      starter: `// ${m.host}: syscall dispatch\nfunction dispatch(num, args, table) {\n}\n\nfunction validNumbers(table) {\n}\n`,
      checks: [
        fn('dispatch routes and validates', 'dispatch', [
          { args: [1, ['x'], { 1: { name: 'write', arity: 1 }, 2: { name: 'exit', arity: 0 } }], expected: { ok: true, name: 'write' } },
          { args: [2, [], { 1: { name: 'write', arity: 1 }, 2: { name: 'exit', arity: 0 } }], expected: { ok: true, name: 'exit' } },
          { args: [1, [], { 1: { name: 'write', arity: 1 } }], expected: { error: 'EINVAL' } },
          { args: [9, [], { 1: { name: 'write', arity: 1 } }], expected: { error: 'ENOSYS' } },
        ]),
        fn('validNumbers lists the syscalls', 'validNumbers', [
          { args: [{ 2: { name: 'exit', arity: 0 }, 1: { name: 'write', arity: 1 } }], expected: [1, 2] },
        ]),
      ],
      solution: `function dispatch(num, args, table) {\n  if (!Object.prototype.hasOwnProperty.call(table, num)) return { error: "ENOSYS" };\n  if (args.length !== table[num].arity) return { error: "EINVAL" };\n  return { ok: true, name: table[num].name };\n}\nfunction validNumbers(table) {\n  return Object.keys(table).map(Number).sort((a, b) => a - b);\n}`,
      realityNote: 'A real kernel has a syscall table indexed by number; the trap handler validates the number and arguments before calling the handler — exactly this dispatch.',
    });
  }),
  tmpl(1, 2, 'advanced', 'interrupt-priority', 'Service interrupts by priority', 'E1', 25, 'Decide which pending interrupt the CPU services next and whether one preempts another.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Interrupts and priority\n\nOn **${m.host}**, several interrupts can be pending; higher priority is serviced first and can preempt a lower-priority handler. Write:\n\n1. \`nextToService(pending)\`: \`pending\` is an array of \`{ irq, priority }\` (higher number = higher priority). Return the \`irq\` of the highest priority; break ties by lowest \`irq\`. Return \`null\` if empty.\n2. \`preempts(running, arriving)\`: both are \`{ priority }\` (or \`running\` is \`null\` if the CPU is in normal execution). Return \`true\` if \`arriving\` should preempt — i.e. \`running\` is \`null\`, or \`arriving.priority > running.priority\`.`,
      hints: ['Pick max priority, tie-break on lowest irq.', 'A higher-priority interrupt preempts a lower-priority handler.'],
      starter: `// ${m.host}: interrupt servicing\nfunction nextToService(pending) {\n}\n\nfunction preempts(running, arriving) {\n}\n`,
      checks: [
        fn('nextToService picks highest priority', 'nextToService', [
          { args: [[{ irq: 3, priority: 1 }, { irq: 7, priority: 5 }, { irq: 2, priority: 5 }]], expected: 2 },
          { args: [[{ irq: 1, priority: 9 }]], expected: 1 },
          { args: [[]], expected: null },
        ]),
        fn('preempts compares priorities', 'preempts', [
          { args: [null, { priority: 1 }], expected: true },
          { args: [{ priority: 3 }, { priority: 5 }], expected: true },
          { args: [{ priority: 5 }, { priority: 3 }], expected: false },
          { args: [{ priority: 4 }, { priority: 4 }], expected: false },
        ]),
      ],
      solution: `function nextToService(pending) {\n  if (!pending.length) return null;\n  let best = pending[0];\n  for (const p of pending) {\n    if (p.priority > best.priority || (p.priority === best.priority && p.irq < best.irq)) best = p;\n  }\n  return best.irq;\n}\nfunction preempts(running, arriving) {\n  if (running === null) return true;\n  return arriving.priority > running.priority;\n}`,
      realityNote: 'Interrupt controllers prioritise IRQs and allow higher-priority interrupts to preempt lower ones; the kernel masks and nests handlers accordingly.',
    });
  }),

  /* ------------------------------------------------------------------ 1.3 OS structures */
  tmpl(1, 3, 'beginner', 'os-structures', 'Compare monolithic and microkernel designs', 'E10', 15, 'Weigh the trade-offs of monolithic, layered and microkernel OS structures.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## How the kernel is organised\n\nThe OS for **${m.host}** could be built several ways. Compare the structures and their trade-offs.`,
      steps: [
        { title: 'Monolithic', text: 'What characterises a monolithic kernel (like classic Linux)?', choices: [
          { text: 'Most OS services run together in kernel space — fast calls, but a bug anywhere can crash the kernel', right: true, feedback: 'Correct. Performance from shared space; less isolation between components.' },
          { text: 'Every service runs as a separate user process', feedback: 'That is a microkernel, not monolithic.' },
          { text: 'It has no device drivers', feedback: 'Monolithic kernels include drivers, often in kernel space.' },
        ] },
        { title: 'Microkernel', text: 'What does a microkernel do differently?', choices: [
          { text: 'Keeps the kernel tiny and runs drivers and services as user-space processes that communicate by messages', right: true, feedback: 'Correct. Small trusted core; services isolated in user space.' },
          { text: 'Puts everything in one address space for speed', feedback: 'That is monolithic; microkernels isolate services.' },
          { text: 'Removes the need for system calls', feedback: 'Microkernels still use message-based system calls.' },
        ] },
        { title: 'The trade-off', text: 'What is the cost of the microkernel\'s isolation?', choices: [
          { text: 'Message passing between isolated services adds overhead compared with in-kernel calls', right: true, feedback: 'Correct. Isolation costs inter-process communication overhead.' },
          { text: 'It cannot be secure', feedback: 'Isolation generally improves security; the cost is performance.' },
          { text: 'It uses no memory', feedback: 'The trade-off is performance, not memory to zero.' },
        ] },
        { title: 'In practice', text: 'Why do real systems often use a hybrid or modular approach?', choices: [
          { text: 'To balance performance and modularity — e.g. loadable modules in a mostly monolithic kernel', right: true, feedback: 'Correct. Hybrids take performance from monolithic and flexibility from modules.' },
          { text: 'Because pure designs are illegal', feedback: 'Hybrids are a practical engineering choice.' },
          { text: 'There is never any reason to', feedback: 'Real kernels (Linux modules, Windows) are pragmatically hybrid.' },
        ] },
      ],
      ending: { title: 'A spectrum of trade-offs', text: 'Monolithic kernels are fast but less isolated; microkernels isolate services at the cost of message-passing overhead; real systems use modular and hybrid designs to balance performance and flexibility.' },
      hints: ['Monolithic = fast, shared space; microkernel = isolated, message-passing.', 'Real kernels are usually pragmatic hybrids.'],
      realityNote: 'Linux is monolithic with loadable modules; QNX and seL4 are microkernels; Windows is a hybrid — each a different point on the performance/isolation trade-off.',
    });
  }),
  tmpl(1, 3, 'intermediate', 'layer-call-rules', 'Enforce layering call rules', 'E1', 20, 'Check that a call respects a layered OS design where a layer may only call the one below.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Layers call downward\n\nIn a strictly layered OS for **${m.host}**, layer *n* may call only layer *n − 1* (and use its own layer). Write \`callAllowed(fromLayer, toLayer)\`: return \`true\` only when \`toLayer === fromLayer\` or \`toLayer === fromLayer - 1\`.\n\nAlso \`violations(calls)\`: \`calls\` is an array of \`{ from, to }\` layer numbers. Return the sub-array of calls that are **not** allowed, in order.`,
      hints: ['A call is allowed to the same layer or exactly one below.', 'Filter the calls that break the rule.'],
      starter: `// ${m.host}: layered call rules\nfunction callAllowed(fromLayer, toLayer) {\n}\n\nfunction violations(calls) {\n}\n`,
      checks: [
        fn('callAllowed enforces downward calls', 'callAllowed', [
          { args: [3, 2], expected: true }, { args: [3, 3], expected: true }, { args: [3, 1], expected: false }, { args: [2, 4], expected: false },
        ]),
        fn('violations finds illegal calls', 'violations', [
          { args: [[{ from: 3, to: 2 }, { from: 3, to: 1 }, { from: 2, to: 5 }]], expected: [{ from: 3, to: 1 }, { from: 2, to: 5 }] },
          { args: [[{ from: 2, to: 1 }]], expected: [] },
        ]),
      ],
      solution: `function callAllowed(fromLayer, toLayer) {\n  return toLayer === fromLayer || toLayer === fromLayer - 1;\n}\nfunction violations(calls) {\n  return calls.filter((c) => !callAllowed(c.from, c.to));\n}`,
      realityNote: 'Strict layering (as in THE and early systems) makes reasoning easy but can be rigid; most real kernels relax it for performance while keeping the idea of layers.',
    });
  }),
  tmpl(1, 3, 'advanced', 'trusted-computing-base', 'Reason about the trusted computing base', 'E1', 20, 'Compute how much code runs with full privilege under different OS structures.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## How much code must you trust?\n\nThe trusted computing base (TCB) is the code that runs with full privilege; smaller is safer. For **${m.host}**, write \`tcbSize(components)\` where \`components\` is an array of \`{ name, kloc, inKernel }\`. Return the total \`kloc\` of components with \`inKernel === true\`.\n\nAlso \`saferDesign(designA, designB)\`: each is an array of components; return the name string \`"A"\` or \`"B"\` whose TCB is **smaller** (less privileged code), or \`"equal"\` if they tie.`,
      hints: ['Sum kloc only for in-kernel components.', 'Smaller in-kernel TCB is the safer design.'],
      starter: `// ${m.host}: trusted computing base\nfunction tcbSize(components) {\n}\n\nfunction saferDesign(designA, designB) {\n}\n`,
      checks: [
        fn('tcbSize sums privileged code', 'tcbSize', [
          { args: [[{ name: 'sched', kloc: 5, inKernel: true }, { name: 'driver', kloc: 20, inKernel: false }, { name: 'mm', kloc: 8, inKernel: true }]], expected: 13 },
          { args: [[{ name: 'x', kloc: 3, inKernel: false }]], expected: 0 },
        ]),
        fn('saferDesign picks the smaller TCB', 'saferDesign', [
          { args: [[{ name: 'a', kloc: 10, inKernel: true }], [{ name: 'b', kloc: 40, inKernel: true }]], expected: 'A' },
          { args: [[{ name: 'a', kloc: 40, inKernel: true }], [{ name: 'b', kloc: 10, inKernel: true }]], expected: 'B' },
          { args: [[{ name: 'a', kloc: 10, inKernel: true }], [{ name: 'b', kloc: 10, inKernel: true }]], expected: 'equal' },
        ]),
      ],
      solution: `function tcbSize(components) {\n  return components.filter((c) => c.inKernel).reduce((sum, c) => sum + c.kloc, 0);\n}\nfunction saferDesign(designA, designB) {\n  const a = tcbSize(designA), b = tcbSize(designB);\n  if (a < b) return "A";\n  if (b < a) return "B";\n  return "equal";\n}`,
      realityNote: 'Microkernels aim for a tiny TCB (seL4 is ~10 kLOC, formally verified) because less privileged code means fewer places a flaw can compromise the whole system.',
    });
  }),

  /* ------------------------------------------------------------------ 1.4 processes with fork/exec/wait */
  tmpl(1, 4, 'beginner', 'count-processes', 'Count processes after fork calls', 'E1', 20, 'Work out how many processes exist after a sequence of unconditional forks.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Each fork doubles the processes\n\nOn **${m.host}**, after a program with one process calls \`fork()\` once there are 2 processes; each existing process runs the next \`fork()\` too. Write:\n\n1. \`processesAfter(forks)\`: with \`forks\` unconditional \`fork()\` calls in a line, return the number of processes, \`2 ** forks\`.\n2. \`childrenCreated(forks)\`: return how many **new** processes were created (total minus the original 1).`,
      hints: ['n unconditional forks give 2^n processes.', 'Children created is the total minus the one you started with.'],
      starter: `// ${m.host}: counting forks\nfunction processesAfter(forks) {\n}\n\nfunction childrenCreated(forks) {\n}\n`,
      checks: [
        fn('processesAfter doubles per fork', 'processesAfter', [
          { args: [0], expected: 1 }, { args: [1], expected: 2 }, { args: [3], expected: 8 }, { args: [5], expected: 32 },
        ]),
        fn('childrenCreated excludes the original', 'childrenCreated', [
          { args: [0], expected: 0 }, { args: [3], expected: 7 },
        ]),
      ],
      solution: `function processesAfter(forks) {\n  return 2 ** forks;\n}\nfunction childrenCreated(forks) {\n  return 2 ** forks - 1;\n}`,
      realityNote: 'The classic "how many processes after N forks" question tests that you see each fork is executed by every process already running — the count doubles each time.',
    });
  }),
  tmpl(1, 4, 'intermediate', 'fork-exec-wait', 'Model fork, exec and wait', 'E1', 25, 'Track a parent and child through fork, exec and wait to predict the output order.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## fork, exec, wait\n\nOn **${m.host}**, model the core process calls. Implement a tiny interpreter: \`run(program)\` where \`program\` is an array of steps for a parent that forks once. Each step is \`{ who, action, value }\` with \`who\` \`"parent"\` or \`"child"\`, \`action\` \`"print"\`. The parent calls \`fork\`, then (if the program says so) \`wait\`s for the child before its later prints.\n\nSimplify to: \`output(childPrints, parentPrintsBeforeWait, parentPrintsAfterWait)\` — all arrays of strings. If the parent waits, the order is: \`parentPrintsBeforeWait\`, then \`childPrints\`, then \`parentPrintsAfterWait\`. Return the concatenated array. Also \`outputNoWait(childPrints, parentPrints)\`: without wait the order is not guaranteed, so return \`{ parent: parentPrints, child: childPrints }\` separately (the point: only wait imposes an order).`,
      hints: ['With wait, the parent\'s after-wait prints come strictly after the child finishes.', 'Without wait, parent and child order is unspecified — keep them separate.'],
      starter: `// ${m.host}: fork/exec/wait ordering\nfunction output(childPrints, parentPrintsBeforeWait, parentPrintsAfterWait) {\n}\n\nfunction outputNoWait(childPrints, parentPrints) {\n}\n`,
      checks: [
        fn('output orders around wait', 'output', [
          { args: [['c1', 'c2'], ['p-before'], ['p-after']], expected: ['p-before', 'c1', 'c2', 'p-after'] },
          { args: [['child'], [], []], expected: ['child'] },
        ]),
        fn('outputNoWait keeps streams separate', 'outputNoWait', [
          { args: [['c'], ['p']], expected: { parent: ['p'], child: ['c'] } },
        ]),
      ],
      solution: `function output(childPrints, parentPrintsBeforeWait, parentPrintsAfterWait) {\n  return [...parentPrintsBeforeWait, ...childPrints, ...parentPrintsAfterWait];\n}\nfunction outputNoWait(childPrints, parentPrints) {\n  return { parent: parentPrints, child: childPrints };\n}`,
      realityNote: 'fork creates a child, exec replaces its image, and wait makes the parent block until the child exits — wait is what imposes ordering between parent and child.',
    });
  }),
  tmpl(1, 4, 'advanced', 'reap-zombies', 'Reap children to avoid zombies', 'E1', 25, 'Track child exit status and decide which terminated children are still unreaped zombies.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Zombies and reaping\n\nA terminated child on **${m.host}** stays a "zombie" until the parent \`wait\`s to collect its exit status. Model this. A child is \`{ pid, state, reaped }\` where \`state\` is \`"running"\` or \`"terminated"\`. Write:\n\n1. \`isZombie(child)\`: return \`true\` when \`state === "terminated"\` and \`reaped !== true\`.\n2. \`zombies(children)\`: return the sorted array of \`pid\`s that are zombies.\n3. \`reap(children, pid)\`: return a new array where the child with that \`pid\` has \`reaped: true\` (others unchanged).`,
      hints: ['A zombie is terminated but not yet waited for.', 'reap sets reaped:true on the matching child.'],
      starter: `// ${m.host}: reaping zombies\nfunction isZombie(child) {\n}\n\nfunction zombies(children) {\n}\n\nfunction reap(children, pid) {\n}\n`,
      checks: [
        fn('isZombie spots unreaped terminated children', 'isZombie', [
          { args: [{ pid: 5, state: 'terminated', reaped: false }], expected: true },
          { args: [{ pid: 5, state: 'terminated', reaped: true }], expected: false },
          { args: [{ pid: 5, state: 'running', reaped: false }], expected: false },
        ]),
        fn('zombies lists unreaped pids', 'zombies', [
          { args: [[{ pid: 7, state: 'terminated', reaped: false }, { pid: 3, state: 'terminated', reaped: false }, { pid: 2, state: 'running' }]], expected: [3, 7] },
        ]),
        fn('reap marks a child reaped', 'reap', [
          { args: [[{ pid: 5, state: 'terminated', reaped: false }], 5], expected: [{ pid: 5, state: 'terminated', reaped: true }] },
        ]),
      ],
      solution: `function isZombie(child) {\n  return child.state === "terminated" && child.reaped !== true;\n}\nfunction zombies(children) {\n  return children.filter(isZombie).map((c) => c.pid).sort((a, b) => a - b);\n}\nfunction reap(children, pid) {\n  return children.map((c) => (c.pid === pid ? { ...c, reaped: true } : c));\n}`,
      realityNote: 'A terminated child lingers as a zombie holding its exit status until the parent calls wait; a parent that never reaps leaks zombie entries in the process table.',
    });
  }),

  /* ------------------------------------------------------------------ 1.5 running a teaching kernel */
  tmpl(1, 5, 'beginner', 'boot-sequence', 'Order the boot sequence', 'E10', 15, 'Reason through what happens from power-on to a running user shell.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## From power-on to a shell\n\nWhen **${m.host}** starts, a sequence hands control from firmware up to a user shell. Reason through it.`,
      steps: [
        { title: 'First code', text: 'What runs first when the machine powers on?', choices: [
          { text: 'Firmware (BIOS/UEFI) does hardware self-test and finds a bootloader', right: true, feedback: 'Correct. Firmware initialises hardware and locates the bootloader.' },
          { text: 'The user\'s shell', feedback: 'The shell comes much later, after the kernel is up.' },
          { text: 'The web browser', feedback: 'Applications start only once the OS is running.' },
        ] },
        { title: 'Loading the kernel', text: 'What does the bootloader do?', choices: [
          { text: 'Loads the kernel image into memory and transfers control to it', right: true, feedback: 'Correct. The bootloader brings in and starts the kernel.' },
          { text: 'Runs the user\'s programs directly', feedback: 'It loads the kernel, which then manages programs.' },
          { text: 'Formats the disk', feedback: 'Booting does not format the disk.' },
        ] },
        { title: 'Kernel init', text: 'What does the kernel do as it starts?', choices: [
          { text: 'Initialises data structures and drivers, sets up memory and interrupts, then starts the first user process', right: true, feedback: 'Correct. The kernel sets up the machine and launches init.' },
          { text: 'Immediately shuts down', feedback: 'It initialises the system and starts user space.' },
          { text: 'Nothing until a key is pressed', feedback: 'Initialisation is automatic.' },
        ] },
        { title: 'User space', text: 'How does the user get a shell?', choices: [
          { text: 'The first user process (init) starts system services and eventually a login/shell', right: true, feedback: 'Correct. init brings up user space and the shell.' },
          { text: 'The firmware draws the shell', feedback: 'User space, not firmware, provides the shell.' },
          { text: 'The shell was always running', feedback: 'It is started by init after boot.' },
        ] },
      ],
      ending: { title: 'Firmware → bootloader → kernel → init → shell', text: 'Power-on runs firmware, which finds a bootloader, which loads the kernel; the kernel initialises the machine and starts the first user process (init), which brings up services and a shell.' },
      hints: ['Control passes upward: firmware, bootloader, kernel, init, shell.', 'The kernel sets up the machine before any user program runs.'],
      realityNote: 'The firmware → bootloader → kernel → init → shell chain is how every general-purpose machine boots; teaching kernels like xv6 let you read each step in small, real code.',
    });
  }),
  tmpl(1, 5, 'intermediate', 'emulator-benefits', 'Use an emulator to study a kernel safely', 'E10', 15, 'Reason about why a teaching kernel is run in an emulator rather than on bare metal.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Why an emulator\n\nTo study a small teaching kernel (like xv6) for **${m.host}**, you run it in an emulator such as QEMU rather than on real hardware. Reason about why.`,
      steps: [
        { title: 'Safety and iteration', text: 'What does an emulator give you while developing a kernel?', choices: [
          { text: 'A safe, disposable machine you can reset instantly when the kernel crashes', right: true, feedback: 'Correct. Crash, reset, retry — no hardware risk or slow reboots.' },
          { text: 'Faster-than-hardware execution always', feedback: 'Emulation is often slower; the benefit is safety and control.' },
          { text: 'It removes the need for the kernel', feedback: 'You still run the real kernel, just inside the emulator.' },
        ] },
        { title: 'Debugging', text: 'How does an emulator help debugging?', choices: [
          { text: 'You can attach a debugger, single-step, inspect registers and memory, and set breakpoints in kernel code', right: true, feedback: 'Correct. Emulators expose full machine state to a debugger.' },
          { text: 'It hides the kernel state', feedback: 'It exposes state for inspection.' },
          { text: 'Debugging is impossible in emulation', feedback: 'Emulation makes kernel debugging far easier.' },
        ] },
        { title: 'Reproducibility', text: 'Why does reproducibility matter here?', choices: [
          { text: 'The same virtual hardware behaves identically for everyone, so results and bugs reproduce', right: true, feedback: 'Correct. Consistent virtual hardware makes teaching and testing reliable.' },
          { text: 'It makes every run different', feedback: 'The point is consistent, reproducible behaviour.' },
          { text: 'Reproducibility is irrelevant to kernels', feedback: 'It is essential for learning and testing.' },
        ] },
        { title: 'Reading the code', text: 'Why is a small kernel like xv6 valuable for learning?', choices: [
          { text: 'It is small and readable enough to understand end to end, unlike a production kernel\'s millions of lines', right: true, feedback: 'Correct. A few thousand lines you can actually read and modify.' },
          { text: 'Because it has no source code', feedback: 'Its readable source is exactly the point.' },
          { text: 'Because it runs only on phones', feedback: 'xv6 is a teaching kernel for study, not a phone OS.' },
        ] },
      ],
      ending: { title: 'Safe, debuggable, reproducible, readable', text: 'An emulator gives a disposable machine you can reset and debug with full visibility and reproducible behaviour, and a small kernel like xv6 is short enough to read and modify end to end.' },
      hints: ['Emulators make kernel work safe, debuggable and reproducible.', 'A small teaching kernel can be understood completely.'],
      realityNote: 'MIT\'s xv6 on QEMU is a standard teaching setup precisely because a small kernel on a reset-able, debuggable virtual machine makes OS internals approachable.',
    });
  }),
  tmpl(1, 5, 'advanced', 'kernel-vs-user-crash', 'Reason about crash isolation', 'E1', 20, 'Decide the blast radius of a crash depending on whether code runs in the kernel or user space.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Where a crash lands\n\nOn **${m.host}**, the impact of a crash depends on where the code runs. Write \`crashImpact(component)\` where \`component = { space }\` (\`"kernel"\` or \`"user"\`):\n\n- \`"kernel"\` → \`"whole-system"\` (a kernel fault can take down the machine);\n- \`"user"\` → \`"single-process"\` (the OS kills just that process);\n- anything else → \`"unknown"\`.\n\nAlso \`survivesCrash(components)\`: \`components\` is an array with \`{ name, space }\`; return the names of components whose crash would **not** bring down the whole system (i.e. user-space), sorted.`,
      hints: ['Kernel crash = whole system; user crash = one process.', 'User-space components survive each other\'s crashes.'],
      starter: `// ${m.host}: crash isolation\nfunction crashImpact(component) {\n}\n\nfunction survivesCrash(components) {\n}\n`,
      checks: [
        fn('crashImpact reflects the space', 'crashImpact', [
          { args: [{ space: 'kernel' }], expected: 'whole-system' },
          { args: [{ space: 'user' }], expected: 'single-process' },
          { args: [{ space: 'firmware' }], expected: 'unknown' },
        ]),
        fn('survivesCrash lists user-space components', 'survivesCrash', [
          { args: [[{ name: 'driver', space: 'kernel' }, { name: 'editor', space: 'user' }, { name: 'browser', space: 'user' }]], expected: ['browser', 'editor'] },
          { args: [[{ name: 'sched', space: 'kernel' }]], expected: [] },
        ]),
      ],
      solution: `function crashImpact(component) {\n  if (component.space === "kernel") return "whole-system";\n  if (component.space === "user") return "single-process";\n  return "unknown";\n}\nfunction survivesCrash(components) {\n  return components.filter((c) => c.space === "user").map((c) => c.name).sort();\n}`,
      realityNote: 'A fault in kernel code can crash the whole machine, while a user-space fault is contained to one process — the core argument for moving drivers and services out of the kernel.',
    });
  }),
];
