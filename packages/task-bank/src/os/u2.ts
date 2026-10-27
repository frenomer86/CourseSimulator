/** Unit 2: process management — process states and the PCB, threads, and CPU scheduling
 * algorithms (FCFS, SJF/SRTF, round robin, priority) with turnaround and waiting metrics. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U2: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 2.1 process states and the PCB */
  tmpl(2, 1, 'beginner', 'process-states', 'Follow a process through its states', 'E1', 20, 'Validate the legal transitions of the process state model.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The five-state model\n\nA process on **${m.host}** moves between \`"new"\`, \`"ready"\`, \`"running"\`, \`"waiting"\` and \`"terminated"\`. Write \`legalTransition(from, to)\` returning \`true\` only for these moves:\n\n- \`new → ready\`;\n- \`ready → running\` (dispatched);\n- \`running → ready\` (preempted/time-slice);\n- \`running → waiting\` (blocks on I/O);\n- \`waiting → ready\` (I/O done);\n- \`running → terminated\` (exit).\n\nEvery other pair is \`false\`.`,
      hints: ['Encode the six legal edges as a set of "from->to" strings.', 'A process can only wait or terminate from running.'],
      starter: `// ${m.host}: process state transitions\nfunction legalTransition(from, to) {\n}\n`,
      checks: [
        fn('legalTransition allows only valid moves', 'legalTransition', [
          { args: ['new', 'ready'], expected: true },
          { args: ['ready', 'running'], expected: true },
          { args: ['running', 'waiting'], expected: true },
          { args: ['waiting', 'ready'], expected: true },
          { args: ['running', 'terminated'], expected: true },
          { args: ['ready', 'waiting'], expected: false },
          { args: ['waiting', 'running'], expected: false },
          { args: ['terminated', 'ready'], expected: false },
        ]),
      ],
      solution: `function legalTransition(from, to) {\n  const edges = new Set(["new->ready", "ready->running", "running->ready", "running->waiting", "waiting->ready", "running->terminated"]);\n  return edges.has(from + "->" + to);\n}`,
      realityNote: 'The five-state process model is standard; a process reaches "waiting" or "terminated" only from "running", and returns to "ready" (never directly to "running") after I/O.',
    });
  }),
  tmpl(2, 1, 'intermediate', 'context-switch-cost', 'Account for context-switch overhead', 'E1', 20, 'Compute how much CPU time is lost to context switches at a given rate.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The cost of switching\n\nEach context switch on **${m.host}** costs a fixed overhead. Write:\n\n1. \`switchOverhead(switches, costEach)\`: return \`switches * costEach\` (microseconds).\n2. \`usefulFraction(quantum, switchCost)\`: with a time quantum \`quantum\` and a switch costing \`switchCost\`, the CPU does useful work for \`quantum\` out of every \`quantum + switchCost\`. Return the fraction \`quantum / (quantum + switchCost)\` rounded to 4 decimals.\n3. \`betterQuantum(q1, q2, switchCost)\`: return whichever of \`q1\`, \`q2\` gives the higher useful fraction (the larger quantum), or \`q1\` on a tie.`,
      hints: ['A larger quantum wastes proportionally less on switching.', 'usefulFraction = quantum / (quantum + switchCost).'],
      starter: `// ${m.host}: context-switch cost\nfunction switchOverhead(switches, costEach) {\n}\n\nfunction usefulFraction(quantum, switchCost) {\n}\n\nfunction betterQuantum(q1, q2, switchCost) {\n}\n`,
      checks: [
        fn('switchOverhead multiplies', 'switchOverhead', [
          { args: [100, 5], expected: 500 }, { args: [0, 5], expected: 0 },
        ]),
        fn('usefulFraction computes efficiency', 'usefulFraction', [
          { args: [10, 0], expected: 1 }, { args: [10, 10], expected: 0.5 }, { args: [95, 5], expected: 0.95 },
        ]),
        fn('betterQuantum picks the more efficient', 'betterQuantum', [
          { args: [10, 100, 5], expected: 100 }, { args: [50, 50, 5], expected: 50 },
        ]),
      ],
      solution: `function switchOverhead(switches, costEach) {\n  return switches * costEach;\n}\nfunction usefulFraction(quantum, switchCost) {\n  return Math.round((quantum / (quantum + switchCost)) * 10000) / 10000;\n}\nfunction betterQuantum(q1, q2, switchCost) {\n  return usefulFraction(q2, switchCost) > usefulFraction(q1, switchCost) ? q2 : q1;\n}`,
      realityNote: 'Context switches are pure overhead; too small a time quantum spends a large fraction of the CPU switching, which is why quanta are tuned to amortise the cost.',
    });
  }),
  tmpl(2, 1, 'advanced', 'pcb-save-restore', 'Save and restore process context', 'E1', 20, 'Model saving a process\'s registers to its PCB and restoring another\'s on a switch.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The context switch\n\nOn **${m.host}**, a context switch saves the running process\'s CPU registers into its PCB and loads the next process\'s. Write:\n\n1. \`saveContext(pcb, registers)\`: return a new PCB (copy of \`pcb\`) with its \`registers\` field set to a copy of \`registers\`.\n2. \`switchTo(cpuRegisters, outgoing, incoming)\`: return \`{ outgoing: <outgoing pcb with cpuRegisters saved>, cpuRegisters: <copy of incoming.registers> }\` — save the current CPU state into the outgoing PCB and load the incoming PCB\'s saved registers.`,
      hints: ['Copy objects so the saved state is independent.', 'switchTo saves outgoing, then loads incoming.registers into the CPU.'],
      starter: `// ${m.host}: PCB save/restore\nfunction saveContext(pcb, registers) {\n}\n\nfunction switchTo(cpuRegisters, outgoing, incoming) {\n}\n`,
      checks: [
        fn('saveContext stores the registers', 'saveContext', [
          { args: [{ pid: 1, registers: {} }, { ax: 5, bx: 7 }], expected: { pid: 1, registers: { ax: 5, bx: 7 } } },
        ]),
        fn('switchTo swaps context', 'switchTo', [
          { args: [{ ax: 9 }, { pid: 1, registers: {} }, { pid: 2, registers: { ax: 3 } }], expected: { outgoing: { pid: 1, registers: { ax: 9 } }, cpuRegisters: { ax: 3 } } },
        ]),
      ],
      solution: `function saveContext(pcb, registers) {\n  return { ...pcb, registers: { ...registers } };\n}\nfunction switchTo(cpuRegisters, outgoing, incoming) {\n  return { outgoing: saveContext(outgoing, cpuRegisters), cpuRegisters: { ...incoming.registers } };\n}`,
      realityNote: 'The process control block holds a process\'s saved registers, program counter and state; a context switch is exactly this save-then-restore, and its cost is why switches are minimised.',
    });
  }),

  /* ------------------------------------------------------------------ 2.2 threads */
  tmpl(2, 2, 'beginner', 'why-threads', 'Decide when threads help', 'E10', 15, 'Reason about what threads share, and when they are the right tool.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Threads within a process\n\nA program on **${m.host}** could use multiple processes or multiple threads. Reason about threads.`,
      steps: [
        { title: 'What threads share', text: 'What do threads of one process share?', choices: [
          { text: 'The same address space (code, heap, globals) and open files, but each has its own stack and registers', right: true, feedback: 'Correct. Shared memory, separate execution context.' },
          { text: 'Nothing; they are fully isolated like processes', feedback: 'Threads share the address space; that is the point.' },
          { text: 'Only the stack', feedback: 'They share the heap and globals; each has its own stack.' },
        ] },
        { title: 'The benefit', text: 'Why use threads over separate processes for a parallel task?', choices: [
          { text: 'Cheaper creation and switching, and easy sharing of data through common memory', right: true, feedback: 'Correct. Lightweight and share data directly.' },
          { text: 'Stronger isolation between tasks', feedback: 'Processes give more isolation; threads give sharing and lightness.' },
          { text: 'They cannot run in parallel', feedback: 'On multiple cores threads run truly in parallel.' },
        ] },
        { title: 'The danger', text: 'What new problem do shared-memory threads introduce?', choices: [
          { text: 'Race conditions — concurrent access to shared data needs synchronisation', right: true, feedback: 'Correct. Shared mutable state must be synchronised.' },
          { text: 'They cannot share data', feedback: 'They share easily; the risk is unsynchronised sharing.' },
          { text: 'They use no CPU', feedback: 'Threads consume CPU like any execution.' },
        ] },
        { title: 'When processes are better', text: 'When would you still choose separate processes?', choices: [
          { text: 'When you need fault isolation or security boundaries between the parts', right: true, feedback: 'Correct. Isolation favours processes (e.g. browser tabs).' },
          { text: 'Never; threads are always better', feedback: 'Isolation needs make processes the right choice sometimes.' },
          { text: 'Only on single-core machines', feedback: 'The reason is isolation, not core count.' },
        ] },
      ],
      ending: { title: 'Share memory, mind the races', text: 'Threads share a process\'s address space and files with their own stacks, making them light and good for sharing data — at the cost of needing synchronisation; processes are chosen when isolation matters.' },
      hints: ['Threads share memory and files; each has its own stack and registers.', 'Sharing brings races; isolation needs favour processes.'],
      realityNote: 'Modern browsers use processes per site for isolation but threads within each for concurrency — a deliberate split of the threads-vs-processes trade-off.',
    });
  }),
  tmpl(2, 2, 'intermediate', 'thread-pool', 'Size and use a thread pool', 'E1', 20, 'Decide how a thread pool assigns tasks and when work must queue.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## A pool of worker threads\n\nOn **${m.host}**, a thread pool of fixed size runs tasks; extra tasks queue. Write:\n\n1. \`assign(poolSize, busy, taskCount)\`: with \`poolSize\` threads, \`busy\` already running, and \`taskCount\` new tasks arriving, return \`{ started, queued }\` — start as many as there are free threads (\`poolSize - busy\`, at least 0), queue the rest.\n2. \`idealPoolSize(cores, blockingFraction)\`: a rough rule — if tasks are CPU-bound (\`blockingFraction === 0\`) use \`cores\`; otherwise use \`Math.round(cores / (1 - blockingFraction))\` (more threads to cover blocked ones).`,
      hints: ['Free threads = max(0, poolSize - busy).', 'More blocking means more threads to keep cores busy.'],
      starter: `// ${m.host}: thread pool\nfunction assign(poolSize, busy, taskCount) {\n}\n\nfunction idealPoolSize(cores, blockingFraction) {\n}\n`,
      checks: [
        fn('assign starts up to the free threads', 'assign', [
          { args: [4, 1, 5], expected: { started: 3, queued: 2 } },
          { args: [4, 4, 2], expected: { started: 0, queued: 2 } },
          { args: [4, 0, 2], expected: { started: 2, queued: 0 } },
        ]),
        fn('idealPoolSize accounts for blocking', 'idealPoolSize', [
          { args: [8, 0], expected: 8 }, { args: [8, 0.5], expected: 16 }, { args: [4, 0.75], expected: 16 },
        ]),
      ],
      solution: `function assign(poolSize, busy, taskCount) {\n  const free = Math.max(0, poolSize - busy);\n  const started = Math.min(free, taskCount);\n  return { started, queued: taskCount - started };\n}\nfunction idealPoolSize(cores, blockingFraction) {\n  return blockingFraction === 0 ? cores : Math.round(cores / (1 - blockingFraction));\n}`,
      realityNote: 'Thread pools cap concurrency to avoid the overhead of unbounded threads; the right size depends on cores and how much time tasks spend blocked on I/O.',
    });
  }),
  tmpl(2, 2, 'advanced', 'amdahl', 'Predict speed-up with Amdahl\'s law', 'E1', 25, 'Compute the maximum speed-up from parallelism given a serial fraction.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Diminishing returns from more cores\n\nFor a workload on **${m.host}**, Amdahl\'s law bounds the speed-up. Write:\n\n1. \`speedup(serialFraction, processors)\`: return \`1 / (serialFraction + (1 - serialFraction) / processors)\`, rounded to 2 decimals.\n2. \`maxSpeedup(serialFraction)\`: the limit as processors → ∞ is \`1 / serialFraction\`, rounded to 2 decimals (return the string \`"unbounded"\` if \`serialFraction === 0\`).`,
      hints: ['Plug directly into Amdahl\'s formula.', 'The ceiling is 1 / serialFraction; return "unbounded" when the serial fraction is 0.'],
      starter: `// ${m.host}: Amdahl's law\nfunction speedup(serialFraction, processors) {\n}\n\nfunction maxSpeedup(serialFraction) {\n}\n`,
      checks: [
        fn('speedup applies Amdahl', 'speedup', [
          { args: [0.5, 2], expected: 1.33 }, { args: [0.1, 10], expected: 5.26 }, { args: [0, 4], expected: 4 },
        ]),
        fn('maxSpeedup gives the ceiling', 'maxSpeedup', [
          { args: [0.1], expected: 10 }, { args: [0.25], expected: 4 }, { args: [0], expected: "unbounded" },
        ]),
      ],
      solution: `function speedup(serialFraction, processors) {\n  return Math.round((1 / (serialFraction + (1 - serialFraction) / processors)) * 100) / 100;\n}\nfunction maxSpeedup(serialFraction) {\n  return serialFraction === 0 ? "unbounded" : Math.round((1 / serialFraction) * 100) / 100;\n}`,
      realityNote: 'Amdahl\'s law shows the serial fraction caps speed-up: even a 10% serial part limits you to 10× no matter how many cores you add.',
    });
  }),

  /* ------------------------------------------------------------------ 2.3 CPU scheduling */
  tmpl(2, 3, 'beginner', 'fcfs', 'Schedule with first-come first-served', 'E1', 25, 'Compute completion, turnaround and waiting times for FCFS.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## FCFS scheduling\n\nOn **${m.host}**, jobs run in arrival order (ties by the given order), non-preemptive. Each job is \`{ id, arrival, burst }\`. Write \`fcfs(jobs)\` returning an array of \`{ id, completion, turnaround, waiting }\` in the **input order**, where:\n\n- the CPU runs jobs in order of arrival (stable);\n- it idles until a job arrives if needed: \`start = max(currentTime, arrival)\`, \`completion = start + burst\`;\n- \`turnaround = completion - arrival\`; \`waiting = turnaround - burst\`.\n\nAlso \`avgWaiting(jobs)\`: the mean waiting time over all jobs, rounded to 2 decimals.`,
      hints: ['Sort a copy by arrival (stable), simulate a clock, then map results back to input order by id.', 'The CPU idles to the next arrival when it is ahead.'],
      starter: `// ${m.host}: FCFS\nfunction fcfs(jobs) {\n}\n\nfunction avgWaiting(jobs) {\n}\n`,
      checks: [
        fn('fcfs computes the metrics', 'fcfs', [
          { args: [[{ id: 'A', arrival: 0, burst: 4 }, { id: 'B', arrival: 1, burst: 3 }, { id: 'C', arrival: 2, burst: 1 }]], expected: [{ id: 'A', completion: 4, turnaround: 4, waiting: 0 }, { id: 'B', completion: 7, turnaround: 6, waiting: 3 }, { id: 'C', completion: 8, turnaround: 6, waiting: 5 }] },
          { args: [[{ id: 'X', arrival: 5, burst: 2 }]], expected: [{ id: 'X', completion: 7, turnaround: 2, waiting: 0 }] },
        ]),
        fn('avgWaiting averages correctly', 'avgWaiting', [
          { args: [[{ id: 'A', arrival: 0, burst: 4 }, { id: 'B', arrival: 1, burst: 3 }, { id: 'C', arrival: 2, burst: 1 }]], expected: 2.67 },
        ]),
      ],
      solution: `function fcfs(jobs) {\n  const order = jobs.map((j, i) => ({ ...j, i })).sort((a, b) => a.arrival - b.arrival || a.i - b.i);\n  let time = 0;\n  const byId = {};\n  for (const j of order) {\n    const start = Math.max(time, j.arrival);\n    const completion = start + j.burst;\n    byId[j.id] = { id: j.id, completion, turnaround: completion - j.arrival, waiting: completion - j.arrival - j.burst };\n    time = completion;\n  }\n  return jobs.map((j) => byId[j.id]);\n}\nfunction avgWaiting(jobs) {\n  const r = fcfs(jobs);\n  return Math.round((r.reduce((s, x) => s + x.waiting, 0) / r.length) * 100) / 100;\n}`,
      realityNote: 'FCFS is simple and fair in arrival order but suffers the convoy effect: one long job delays everything behind it, inflating average waiting time.',
    });
  }),
  tmpl(2, 3, 'intermediate', 'sjf', 'Schedule with shortest job first', 'E1', 30, 'Compute metrics for non-preemptive SJF and see why it minimises average waiting.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## SJF scheduling\n\nOn **${m.host}**, non-preemptive shortest-job-first picks, among jobs that have arrived, the one with the smallest burst (ties by arrival, then input order). Write \`sjf(jobs)\` returning \`{ id, completion, turnaround, waiting }\` per job in **input order**, simulating:\n\n- at each step, among arrived & unfinished jobs, run the shortest burst to completion;\n- if none has arrived, idle to the next arrival;\n- same turnaround/waiting formulas as FCFS.\n\nAlso \`avgWaiting(jobs)\`: mean waiting, 2 decimals.`,
      hints: ['Loop: advance time to the next arrival if nothing is ready, else pick the min-burst ready job.', 'Track finished jobs; map results back by id.'],
      starter: `// ${m.host}: SJF\nfunction sjf(jobs) {\n}\n\nfunction avgWaiting(jobs) {\n}\n`,
      checks: [
        fn('sjf computes the metrics', 'sjf', [
          { args: [[{ id: 'A', arrival: 0, burst: 7 }, { id: 'B', arrival: 2, burst: 4 }, { id: 'C', arrival: 4, burst: 1 }, { id: 'D', arrival: 5, burst: 4 }]], expected: [{ id: 'A', completion: 7, turnaround: 7, waiting: 0 }, { id: 'B', completion: 12, turnaround: 10, waiting: 6 }, { id: 'C', completion: 8, turnaround: 4, waiting: 3 }, { id: 'D', completion: 16, turnaround: 11, waiting: 7 }] },
        ]),
        fn('avgWaiting averages correctly', 'avgWaiting', [
          { args: [[{ id: 'A', arrival: 0, burst: 7 }, { id: 'B', arrival: 2, burst: 4 }, { id: 'C', arrival: 4, burst: 1 }, { id: 'D', arrival: 5, burst: 4 }]], expected: 4 },
        ]),
      ],
      solution: `function sjf(jobs) {\n  const pending = jobs.map((j, i) => ({ ...j, i, done: false }));\n  let time = 0, finished = 0;\n  const byId = {};\n  while (finished < pending.length) {\n    const ready = pending.filter((j) => !j.done && j.arrival <= time);\n    if (!ready.length) { time = Math.min(...pending.filter((j) => !j.done).map((j) => j.arrival)); continue; }\n    ready.sort((a, b) => a.burst - b.burst || a.arrival - b.arrival || a.i - b.i);\n    const j = ready[0];\n    const completion = time + j.burst;\n    byId[j.id] = { id: j.id, completion, turnaround: completion - j.arrival, waiting: completion - j.arrival - j.burst };\n    time = completion;\n    j.done = true;\n    finished++;\n  }\n  return jobs.map((j) => byId[j.id]);\n}\nfunction avgWaiting(jobs) {\n  const r = sjf(jobs);\n  return Math.round((r.reduce((s, x) => s + x.waiting, 0) / r.length) * 100) / 100;\n}`,
      realityNote: 'Non-preemptive SJF gives the minimum average waiting time for a given set of jobs, but needs the burst lengths in advance and can starve long jobs.',
    });
  }),
  tmpl(2, 3, 'advanced', 'round-robin', 'Schedule with round robin', 'E1', 30, 'Simulate round-robin scheduling with a time quantum and compute the metrics.', (v) => {
    const m = machineOf(v);
    const q = v.pick([2, 3, 4]);
    return js({
      instructions: `## Round robin (quantum ${q})\n\nOn **${m.host}**, round robin gives each ready job a time quantum of **${q}** then moves to the next. A job arriving at the same time as a preemption is enqueued **before** the preempted job re-joins. Write \`roundRobin(jobs, quantum)\` returning \`{ id, completion, turnaround, waiting }\` per job in **input order**:\n\n- maintain a ready queue; run the head for \`min(quantum, remaining)\`;\n- when a job\'s quantum ends, enqueue any jobs that arrived during that slice (in arrival/index order), then re-enqueue the running job if it still has time;\n- metrics as before (waiting = turnaround − burst).\n\nAssume at least one job arrives at time 0.`,
      hints: ['Advance a clock by each slice; add newly-arrived jobs to the queue before re-adding the current one.', 'A job with remaining 0 completes at the current time.'],
      starter: `// ${m.host}: round robin\nfunction roundRobin(jobs, quantum) {\n}\n`,
      checks: [
        fn('roundRobin computes the metrics', 'roundRobin', [
          { args: [[{ id: 'A', arrival: 0, burst: 5 }, { id: 'B', arrival: 1, burst: 4 }, { id: 'C', arrival: 2, burst: 2 }], 2], expected: [{ id: 'A', completion: 11, turnaround: 11, waiting: 6 }, { id: 'B', completion: 10, turnaround: 9, waiting: 5 }, { id: 'C', completion: 6, turnaround: 4, waiting: 2 }] },
        ]),
        fn('roundRobin handles a single job', 'roundRobin', [
          { args: [[{ id: 'X', arrival: 0, burst: 3 }], 2], expected: [{ id: 'X', completion: 3, turnaround: 3, waiting: 0 }] },
        ]),
      ],
      solution: `function roundRobin(jobs, quantum) {\n  const js = jobs.map((j, i) => ({ ...j, i, remaining: j.burst }));\n  const byId = {};\n  let time = 0;\n  const arrivedSet = new Set();\n  const queue = [];\n  const enqueueArrivals = (upto) => {\n    js.filter((j) => !arrivedSet.has(j.i) && j.arrival <= upto)\n      .sort((a, b) => a.arrival - b.arrival || a.i - b.i)\n      .forEach((j) => { arrivedSet.add(j.i); queue.push(j); });\n  };\n  enqueueArrivals(time);\n  while (queue.length) {\n    const j = queue.shift();\n    const slice = Math.min(quantum, j.remaining);\n    time += slice;\n    j.remaining -= slice;\n    enqueueArrivals(time);\n    if (j.remaining > 0) queue.push(j);\n    else byId[j.id] = { id: j.id, completion: time, turnaround: time - j.arrival, waiting: time - j.arrival - j.burst };\n  }\n  return jobs.map((j) => byId[j.id]);\n}`,
      realityNote: 'Round robin gives good response time and fairness; the quantum tunes the trade-off between responsiveness and the overhead of frequent context switches.',
    });
  }),

  /* ------------------------------------------------------------------ 2.4 priority and other scheduling */
  tmpl(2, 4, 'beginner', 'priority-sched', 'Schedule by priority with aging', 'E1', 25, 'Run non-preemptive priority scheduling and apply aging to avoid starvation.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Priority scheduling\n\nOn **${m.host}**, non-preemptive priority scheduling runs the highest-priority ready job (lower number = higher priority; ties by arrival then index). Write:\n\n1. \`pickNext(ready)\`: \`ready\` is an array of \`{ id, priority, arrival, i }\`. Return the \`id\` to run next (highest priority), or \`null\` if empty.\n2. \`age(job, waitedTicks, step)\`: return a new job whose \`priority\` is reduced (improved) by \`Math.floor(waitedTicks / step)\` but never below 0 — aging prevents starvation.`,
      hints: ['Lowest priority number wins; break ties by arrival then index.', 'Aging raises priority (lowers the number) the longer a job waits.'],
      starter: `// ${m.host}: priority scheduling with aging\nfunction pickNext(ready) {\n}\n\nfunction age(job, waitedTicks, step) {\n}\n`,
      checks: [
        fn('pickNext chooses the highest priority', 'pickNext', [
          { args: [[{ id: 'A', priority: 3, arrival: 0, i: 0 }, { id: 'B', priority: 1, arrival: 2, i: 1 }, { id: 'C', priority: 1, arrival: 1, i: 2 }]], expected: 'C' },
          { args: [[]], expected: null },
        ]),
        fn('age improves priority over time', 'age', [
          { args: [{ id: 'A', priority: 5 }, 10, 5], expected: { id: 'A', priority: 3 } },
          { args: [{ id: 'A', priority: 1 }, 100, 5], expected: { id: 'A', priority: 0 } },
          { args: [{ id: 'A', priority: 5 }, 2, 5], expected: { id: 'A', priority: 5 } },
        ]),
      ],
      solution: `function pickNext(ready) {\n  if (!ready.length) return null;\n  let best = ready[0];\n  for (const j of ready) {\n    if (j.priority < best.priority || (j.priority === best.priority && (j.arrival < best.arrival || (j.arrival === best.arrival && j.i < best.i)))) best = j;\n  }\n  return best.id;\n}\nfunction age(job, waitedTicks, step) {\n  return { ...job, priority: Math.max(0, job.priority - Math.floor(waitedTicks / step)) };\n}`,
      realityNote: 'Pure priority scheduling can starve low-priority jobs forever; aging — gradually raising a waiting job\'s priority — is the standard fix.',
    });
  }),
  tmpl(2, 4, 'intermediate', 'mlfq', 'Classify jobs with a multilevel feedback queue', 'E1', 25, 'Move jobs between priority queues based on how they use the CPU.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Multilevel feedback queue\n\nAn MLFQ on **${m.host}** demotes CPU-bound jobs and keeps interactive ones high. Levels are 0 (highest) to \`maxLevel\`. Write:\n\n1. \`afterSlice(level, usedWholeQuantum, maxLevel)\`: if the job used its **whole** quantum (CPU-bound), demote it one level (not past \`maxLevel\`); if it gave up the CPU early (interactive/blocked), keep its level.\n2. \`priorityBoost(jobs)\`: periodic boost — return a new array of jobs each with \`level: 0\` (move everyone to the top to avoid starvation).`,
      hints: ['Using the full quantum means CPU-bound → demote.', 'The periodic boost resets everyone to level 0.'],
      starter: `// ${m.host}: MLFQ\nfunction afterSlice(level, usedWholeQuantum, maxLevel) {\n}\n\nfunction priorityBoost(jobs) {\n}\n`,
      checks: [
        fn('afterSlice demotes CPU-bound jobs', 'afterSlice', [
          { args: [0, true, 2], expected: 1 }, { args: [2, true, 2], expected: 2 }, { args: [1, false, 2], expected: 1 },
        ]),
        fn('priorityBoost resets levels', 'priorityBoost', [
          { args: [[{ id: 'A', level: 2 }, { id: 'B', level: 1 }]], expected: [{ id: 'A', level: 0 }, { id: 'B', level: 0 }] },
        ]),
      ],
      solution: `function afterSlice(level, usedWholeQuantum, maxLevel) {\n  return usedWholeQuantum ? Math.min(maxLevel, level + 1) : level;\n}\nfunction priorityBoost(jobs) {\n  return jobs.map((j) => ({ ...j, level: 0 }));\n}`,
      realityNote: 'MLFQ approximates SJF without knowing burst lengths by watching behaviour: jobs that hog the CPU sink, interactive jobs stay responsive, and a periodic boost prevents starvation.',
    });
  }),
  tmpl(2, 4, 'advanced', 'edf', 'Check real-time schedulability with EDF', 'E1', 25, 'Decide whether a set of periodic tasks is schedulable and which to run next under EDF.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Earliest-deadline-first\n\nOn **${m.host}**, real-time tasks have a period and a compute time. Write:\n\n1. \`utilisation(tasks)\`: \`tasks\` is \`{ compute, period }\`; return the sum of \`compute / period\`, rounded to 4 decimals.\n2. \`edfSchedulable(tasks)\`: EDF can schedule a set on one CPU iff total utilisation \`<= 1\`. Return \`true\`/\`false\`.\n3. \`nextTaskEDF(ready)\`: \`ready\` is \`{ id, absoluteDeadline }\`; return the \`id\` with the earliest deadline (ties by \`id\` ascending), or \`null\` if empty.`,
      hints: ['Utilisation sums compute/period.', 'EDF is optimal on one CPU up to 100% utilisation.'],
      starter: `// ${m.host}: EDF real-time scheduling\nfunction utilisation(tasks) {\n}\n\nfunction edfSchedulable(tasks) {\n}\n\nfunction nextTaskEDF(ready) {\n}\n`,
      checks: [
        fn('utilisation sums the load', 'utilisation', [
          { args: [[{ compute: 1, period: 4 }, { compute: 2, period: 8 }]], expected: 0.5 },
          { args: [[{ compute: 3, period: 4 }, { compute: 3, period: 4 }]], expected: 1.5 },
        ]),
        fn('edfSchedulable checks the bound', 'edfSchedulable', [
          { args: [[{ compute: 1, period: 4 }, { compute: 2, period: 8 }]], expected: true },
          { args: [[{ compute: 3, period: 4 }, { compute: 3, period: 4 }]], expected: false },
        ]),
        fn('nextTaskEDF picks the earliest deadline', 'nextTaskEDF', [
          { args: [[{ id: 'A', absoluteDeadline: 10 }, { id: 'B', absoluteDeadline: 5 }]], expected: 'B' },
          { args: [[]], expected: null },
        ]),
      ],
      solution: `function utilisation(tasks) {\n  return Math.round(tasks.reduce((s, t) => s + t.compute / t.period, 0) * 10000) / 10000;\n}\nfunction edfSchedulable(tasks) {\n  return utilisation(tasks) <= 1;\n}\nfunction nextTaskEDF(ready) {\n  if (!ready.length) return null;\n  let best = ready[0];\n  for (const t of ready) if (t.absoluteDeadline < best.absoluteDeadline || (t.absoluteDeadline === best.absoluteDeadline && t.id < best.id)) best = t;\n  return best.id;\n}`,
      realityNote: 'EDF is optimal for single-processor real-time scheduling: a task set is schedulable exactly when total utilisation does not exceed 1, and you always run the nearest deadline.',
    });
  }),

  /* ------------------------------------------------------------------ 2.5 measuring a scheduler */
  tmpl(2, 5, 'beginner', 'scheduling-metrics', 'Compute scheduling metrics', 'E1', 20, 'Derive turnaround, waiting and response times from a schedule.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The numbers that matter\n\nFor a schedule on **${m.host}**, each job records \`{ id, arrival, burst, firstRun, completion }\`. Write:\n\n1. \`turnaround(job)\`: \`completion - arrival\`.\n2. \`waiting(job)\`: \`turnaround(job) - burst\`.\n3. \`response(job)\`: \`firstRun - arrival\` (time until it first gets the CPU).\n4. \`averages(jobs)\`: return \`{ turnaround, waiting, response }\`, each the mean over jobs rounded to 2 decimals.`,
      hints: ['Response time is until first execution, not completion.', 'Average each metric across the jobs.'],
      starter: `// ${m.host}: scheduling metrics\nfunction turnaround(job) {\n}\n\nfunction waiting(job) {\n}\n\nfunction response(job) {\n}\n\nfunction averages(jobs) {\n}\n`,
      checks: [
        fn('turnaround is completion minus arrival', 'turnaround', [{ args: [{ arrival: 2, burst: 3, firstRun: 4, completion: 9 }], expected: 7 }]),
        fn('waiting is turnaround minus burst', 'waiting', [{ args: [{ arrival: 2, burst: 3, firstRun: 4, completion: 9 }], expected: 4 }]),
        fn('response is first run minus arrival', 'response', [{ args: [{ arrival: 2, burst: 3, firstRun: 4, completion: 9 }], expected: 2 }]),
        fn('averages means the metrics', 'averages', [
          { args: [[{ arrival: 0, burst: 2, firstRun: 0, completion: 2 }, { arrival: 0, burst: 2, firstRun: 2, completion: 4 }]], expected: { turnaround: 3, waiting: 1, response: 1 } },
        ]),
      ],
      solution: `function turnaround(job) {\n  return job.completion - job.arrival;\n}\nfunction waiting(job) {\n  return turnaround(job) - job.burst;\n}\nfunction response(job) {\n  return job.firstRun - job.arrival;\n}\nfunction averages(jobs) {\n  const mean = (f) => Math.round((jobs.reduce((s, j) => s + f(j), 0) / jobs.length) * 100) / 100;\n  return { turnaround: mean(turnaround), waiting: mean(waiting), response: mean(response) };\n}`,
      realityNote: 'Turnaround, waiting and response time are the standard scheduling metrics; interactive systems optimise response time, batch systems optimise turnaround.',
    });
  }),
  tmpl(2, 5, 'intermediate', 'compare-schedulers', 'Compare two schedulers on a workload', 'E1', 20, 'Decide which scheduler gives lower average waiting for a given workload.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Which scheduler wins here?\n\nFor **${m.host}**, compare schedulers by their resulting per-job waiting times. Write:\n\n1. \`avg(nums)\`: mean of an array, rounded to 2 decimals (0 for empty).\n2. \`better(resultA, resultB)\`: each is an array of waiting times. Return \`"A"\` if A\'s average is lower, \`"B"\` if B\'s is lower, \`"tie"\` if equal.\n3. \`improvement(baseline, candidate)\`: percentage reduction in average waiting from \`baseline\` to \`candidate\` = \`(avgBase - avgCand) / avgBase * 100\`, rounded to 1 decimal (0 if \`avgBase\` is 0).`,
      hints: ['Compare the averages of the two waiting-time arrays.', 'Improvement is the relative drop from baseline to candidate.'],
      starter: `// ${m.host}: compare schedulers\nfunction avg(nums) {\n}\n\nfunction better(resultA, resultB) {\n}\n\nfunction improvement(baseline, candidate) {\n}\n`,
      checks: [
        fn('avg averages the array', 'avg', [{ args: [[2, 4, 6]], expected: 4 }, { args: [[]], expected: 0 }]),
        fn('better compares averages', 'better', [
          { args: [[1, 2], [3, 4]], expected: 'A' }, { args: [[5, 5], [1, 1]], expected: 'B' }, { args: [[2], [2]], expected: 'tie' },
        ]),
        fn('improvement computes the reduction', 'improvement', [
          { args: [[4, 4], [2, 2]], expected: 50 }, { args: [[0], [0]], expected: 0 },
        ]),
      ],
      solution: `function avg(nums) {\n  return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : 0;\n}\nfunction better(resultA, resultB) {\n  const a = avg(resultA), b = avg(resultB);\n  if (a < b) return "A";\n  if (b < a) return "B";\n  return "tie";\n}\nfunction improvement(baseline, candidate) {\n  const base = avg(baseline);\n  if (base === 0) return 0;\n  return Math.round(((base - avg(candidate)) / base) * 1000) / 10;\n}`,
      realityNote: 'No scheduler is best for every workload; teams measure average waiting and response on representative workloads before choosing or tuning one.',
    });
  }),
  tmpl(2, 5, 'advanced', 'gantt-from-schedule', 'Build a Gantt chart from a run log', 'E1', 25, 'Collapse a tick-by-tick run log into contiguous Gantt segments.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## From run log to Gantt\n\nFor **${m.host}**, a scheduler produces a per-tick log of which job ran (or \`"idle"\`). Write \`gantt(log)\` collapsing consecutive equal entries into segments \`{ id, start, end }\` (end exclusive). \`log[t]\` is the job id running during tick \`t\`.\n\nAlso \`cpuBusyFraction(log)\`: the fraction of ticks that are not \`"idle"\`, rounded to 2 decimals (0 for empty).`,
      hints: ['Walk the log, starting a new segment when the id changes.', 'Busy fraction counts non-idle ticks over total ticks.'],
      starter: `// ${m.host}: Gantt from a run log\nfunction gantt(log) {\n}\n\nfunction cpuBusyFraction(log) {\n}\n`,
      checks: [
        fn('gantt collapses segments', 'gantt', [
          { args: [['A', 'A', 'B', 'B', 'B', 'A']], expected: [{ id: 'A', start: 0, end: 2 }, { id: 'B', start: 2, end: 5 }, { id: 'A', start: 5, end: 6 }] },
          { args: [['idle', 'A']], expected: [{ id: 'idle', start: 0, end: 1 }, { id: 'A', start: 1, end: 2 }] },
          { args: [[]], expected: [] },
        ]),
        fn('cpuBusyFraction measures utilisation', 'cpuBusyFraction', [
          { args: [['A', 'idle', 'B', 'idle']], expected: 0.5 },
          { args: [[]], expected: 0 },
        ]),
      ],
      solution: `function gantt(log) {\n  const out = [];\n  for (let t = 0; t < log.length; t++) {\n    const last = out[out.length - 1];\n    if (last && last.id === log[t]) last.end = t + 1;\n    else out.push({ id: log[t], start: t, end: t + 1 });\n  }\n  return out;\n}\nfunction cpuBusyFraction(log) {\n  if (!log.length) return 0;\n  const busy = log.filter((x) => x !== "idle").length;\n  return Math.round((busy / log.length) * 100) / 100;\n}`,
      realityNote: 'Gantt charts visualise a schedule; collapsing a tick log into segments is how profilers and schedulers render which job held the CPU when.',
    });
  }),
];
