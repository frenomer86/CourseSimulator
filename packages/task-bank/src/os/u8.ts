/** Unit 8: multiple-processor and mobile operating systems — multiprocessor scheduling and NUMA,
 * distributed/cluster systems, mobile OS architecture and power, and a Linux-kernel case study. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U8: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 8.1 multiprocessor scheduling */
  tmpl(8, 1, 'beginner', 'load-balance', 'Balance load across processors', 'E1', 25, 'Assign tasks to the least-loaded CPU and measure the imbalance.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Spreading work across cores\n\nOn **${m.host}**, write:\n\n1. \`leastLoaded(loads)\`: \`loads\` is an array of per-CPU load numbers. Return the index of the smallest load (ties by lowest index).\n2. \`assign(loads, taskWeight)\`: add \`taskWeight\` to the least-loaded CPU and return the new loads array.\n3. \`imbalance(loads)\`: return \`max - min\` of the loads (0 for empty or single CPU).`,
      hints: ['Place each task on the currently least-loaded CPU.', 'Imbalance is the spread between busiest and idlest CPU.'],
      starter: `// ${m.host}: load balancing\nfunction leastLoaded(loads) {\n}\n\nfunction assign(loads, taskWeight) {\n}\n\nfunction imbalance(loads) {\n}\n`,
      checks: [
        fn('leastLoaded finds the idlest CPU', 'leastLoaded', [
          { args: [[5, 2, 8]], expected: 1 }, { args: [[3, 3, 3]], expected: 0 },
        ]),
        fn('assign places the task', 'assign', [
          { args: [[5, 2, 8], 3], expected: [5, 5, 8] },
        ]),
        fn('imbalance measures the spread', 'imbalance', [
          { args: [[5, 2, 8]], expected: 6 }, { args: [[4]], expected: 0 }, { args: [[]], expected: 0 },
        ]),
      ],
      solution: `function leastLoaded(loads) {\n  let best = 0;\n  for (let i = 1; i < loads.length; i++) if (loads[i] < loads[best]) best = i;\n  return best;\n}\nfunction assign(loads, taskWeight) {\n  const out = [...loads];\n  out[leastLoaded(out)] += taskWeight;\n  return out;\n}\nfunction imbalance(loads) {\n  if (loads.length < 2) return 0;\n  return Math.max(...loads) - Math.min(...loads);\n}`,
      realityNote: 'Multiprocessor schedulers push or pull tasks to keep per-CPU run queues balanced; the challenge is doing so without excessive migration, which hurts cache locality.',
    });
  }),
  tmpl(8, 1, 'intermediate', 'processor-affinity', 'Respect processor affinity and cache warmth', 'E1', 25, 'Decide whether to migrate a task given its affinity and cache benefit.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Affinity vs balancing\n\nMoving a task to another CPU on **${m.host}** loses its warm cache. Write:\n\n1. \`canRunOn(task, cpu)\`: \`task.affinity\` is an array of allowed CPU indices (or omitted = any). Return \`true\` if \`cpu\` is allowed.\n2. \`shouldMigrate(imbalance, migrationCost, cacheWarmth)\`: migrate only when the benefit of balancing (\`imbalance\`) exceeds the total cost (\`migrationCost + cacheWarmth\`). Return \`true\`/\`false\`.\n3. \`targetCpu(task, loads)\`: among CPUs the task may run on (\`canRunOn\`), return the index of the least-loaded one, or \`-1\` if none allowed.`,
      hints: ['Respect the affinity mask before choosing a CPU.', 'Migrate only when rebalancing beats the migration plus cache-loss cost.'],
      starter: `// ${m.host}: affinity and migration\nfunction canRunOn(task, cpu) {\n}\n\nfunction shouldMigrate(imbalance, migrationCost, cacheWarmth) {\n}\n\nfunction targetCpu(task, loads) {\n}\n`,
      checks: [
        fn('canRunOn respects affinity', 'canRunOn', [
          { args: [{ affinity: [0, 2] }, 2], expected: true },
          { args: [{ affinity: [0, 2] }, 1], expected: false },
          { args: [{}, 3], expected: true },
        ]),
        fn('shouldMigrate weighs cost against benefit', 'shouldMigrate', [
          { args: [10, 3, 2], expected: true }, { args: [4, 3, 2], expected: false },
        ]),
        fn('targetCpu picks an allowed idle CPU', 'targetCpu', [
          { args: [{ affinity: [1, 2] }, [1, 5, 2]], expected: 2 },
          { args: [{ affinity: [0] }, [9, 1]], expected: 0 },
          { args: [{ affinity: [] }, [1, 2]], expected: -1 },
        ]),
      ],
      solution: `function canRunOn(task, cpu) {\n  return !task.affinity || task.affinity.includes(cpu);\n}\nfunction shouldMigrate(imbalance, migrationCost, cacheWarmth) {\n  return imbalance > migrationCost + cacheWarmth;\n}\nfunction targetCpu(task, loads) {\n  let best = -1;\n  for (let cpu = 0; cpu < loads.length; cpu++) {\n    if (canRunOn(task, cpu) && (best === -1 || loads[cpu] < loads[best])) best = cpu;\n  }\n  return best;\n}`,
      realityNote: 'Schedulers keep a task on its last CPU (soft affinity) to reuse its warm cache, migrating only when the load imbalance justifies the cost — the balance Linux\'s CFS load balancer strikes.',
    });
  }),
  tmpl(8, 1, 'advanced', 'numa-placement', 'Place memory for NUMA locality', 'E1', 25, 'Compute access cost on a NUMA machine and choose local placement.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## NUMA: memory has a home\n\nOn **${m.host}**, each CPU node accesses its local memory faster than remote. Write:\n\n1. \`accessCost(cpuNode, memNode, localCost, remoteCost)\`: return \`localCost\` if \`cpuNode === memNode\`, else \`remoteCost\`.\n2. \`bestNode(memNode, nodes, localCost, remoteCost)\`: return the node (from \`nodes\`, an array of node ids) with the lowest access cost to \`memNode\` — that is \`memNode\` itself if present (ties by lowest id).\n3. \`totalCost(accesses, localCost, remoteCost)\`: \`accesses\` is an array of \`{ cpuNode, memNode }\`; return the summed access cost.`,
      hints: ['Local access is cheaper than remote.', 'The best node for some memory is the node that owns it.'],
      starter: `// ${m.host}: NUMA placement\nfunction accessCost(cpuNode, memNode, localCost, remoteCost) {\n}\n\nfunction bestNode(memNode, nodes, localCost, remoteCost) {\n}\n\nfunction totalCost(accesses, localCost, remoteCost) {\n}\n`,
      checks: [
        fn('accessCost reflects locality', 'accessCost', [
          { args: [0, 0, 10, 30], expected: 10 }, { args: [0, 1, 10, 30], expected: 30 },
        ]),
        fn('bestNode prefers the owning node', 'bestNode', [
          { args: [1, [0, 1, 2], 10, 30], expected: 1 },
          { args: [5, [0, 1], 10, 30], expected: 0 },
        ]),
        fn('totalCost sums the accesses', 'totalCost', [
          { args: [[{ cpuNode: 0, memNode: 0 }, { cpuNode: 0, memNode: 1 }], 10, 30], expected: 40 },
        ]),
      ],
      solution: `function accessCost(cpuNode, memNode, localCost, remoteCost) {\n  return cpuNode === memNode ? localCost : remoteCost;\n}\nfunction bestNode(memNode, nodes, localCost, remoteCost) {\n  let best = nodes[0];\n  for (const n of nodes) {\n    if (accessCost(n, memNode, localCost, remoteCost) < accessCost(best, memNode, localCost, remoteCost) || (accessCost(n, memNode, localCost, remoteCost) === accessCost(best, memNode, localCost, remoteCost) && n < best)) best = n;\n  }\n  return best;\n}\nfunction totalCost(accesses, localCost, remoteCost) {\n  return accesses.reduce((s, a) => s + accessCost(a.cpuNode, a.memNode, localCost, remoteCost), 0);\n}`,
      realityNote: 'On NUMA machines, memory local to a CPU node is faster than remote; the OS tries to allocate a process\'s memory on the node where it runs and keep it there, which matters greatly on big servers.',
    });
  }),

  /* ------------------------------------------------------------------ 8.2 distributed and cluster systems */
  tmpl(8, 2, 'beginner', 'distributed-tradeoffs', 'Reason about distributed OS trade-offs', 'E10', 15, 'Weigh transparency, partial failure and consistency in distributed systems.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Many machines, one system?\n\n**${m.host}** is part of a cluster. Reason about what changes when the "computer" spans many machines.`,
      steps: [
        { title: 'Transparency', text: 'What does a distributed system aim to hide from users?', choices: [
          { text: 'The distribution itself — location, migration and replication look like one system', right: true, feedback: 'Correct. Transparency makes many machines feel like one.' },
          { text: 'That any computers exist', feedback: 'It hides distribution, not computing itself.' },
          { text: 'The existence of files', feedback: 'It hides where things are, not that they exist.' },
        ] },
        { title: 'Partial failure', text: 'What is the hard new problem?', choices: [
          { text: 'Parts can fail while others keep running, and you cannot always tell failure from slowness', right: true, feedback: 'Correct. Partial failure and ambiguous timeouts define distributed systems.' },
          { text: 'The whole system always fails together', feedback: 'That is the easy case; partial failure is the hard one.' },
          { text: 'Nothing ever fails', feedback: 'Failures are the central concern.' },
        ] },
        { title: 'Consistency', text: 'Why is keeping replicas consistent hard?', choices: [
          { text: 'Network delays and failures force a trade-off between consistency and availability', right: true, feedback: 'Correct. The CAP trade-off is fundamental under partitions.' },
          { text: 'Replicas are always instantly identical', feedback: 'Propagation takes time and can fail.' },
          { text: 'Consistency is free', feedback: 'It costs coordination, latency or availability.' },
        ] },
        { title: 'Clusters', text: 'What does a cluster OS add over independent machines?', choices: [
          { text: 'Coordinated scheduling, shared storage and failover so the cluster acts as one pool of resources', right: true, feedback: 'Correct. The cluster is managed as a single resource pool.' },
          { text: 'Nothing; machines stay fully independent', feedback: 'A cluster coordinates them into one system.' },
          { text: 'It slows every machine down', feedback: 'It coordinates them for throughput and resilience.' },
        ] },
      ],
      ending: { title: 'One system, with new failure modes', text: 'Distributed systems aim for transparency but must handle partial failure and the consistency/availability trade-off; cluster operating systems coordinate scheduling, storage and failover so many machines act as one.' },
      hints: ['Transparency hides distribution; partial failure and consistency are the hard parts.', 'Network partitions force a consistency-versus-availability choice.'],
      realityNote: 'Partial failure and the CAP trade-off are what make distributed systems hard; cluster managers (Kubernetes, Slurm) coordinate many nodes into one schedulable pool.',
    });
  }),
  tmpl(8, 2, 'intermediate', 'quorum', 'Decide a replicated write with a quorum', 'E1', 25, 'Require a majority of replicas to agree before committing, to survive failures.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Majority quorum\n\nOn **${m.host}**, a replicated store commits only when a majority of \`n\` replicas acknowledge. Write:\n\n1. \`quorum(n)\`: the smallest majority = \`Math.floor(n / 2) + 1\`.\n2. \`committed(acks, n)\`: return \`true\` when \`acks >= quorum(n)\`.\n3. \`readWriteOverlap(readQuorum, writeQuorum, n)\`: a read sees the latest write iff \`readQuorum + writeQuorum > n\`. Return \`true\`/\`false\`.`,
      hints: ['A majority is more than half.', 'Overlapping read and write quorums guarantee a read sees the latest write.'],
      starter: `// ${m.host}: quorum\nfunction quorum(n) {\n}\n\nfunction committed(acks, n) {\n}\n\nfunction readWriteOverlap(readQuorum, writeQuorum, n) {\n}\n`,
      checks: [
        fn('quorum is the majority', 'quorum', [
          { args: [3], expected: 2 }, { args: [5], expected: 3 }, { args: [4], expected: 3 },
        ]),
        fn('committed needs a majority', 'committed', [
          { args: [2, 3], expected: true }, { args: [1, 3], expected: false },
        ]),
        fn('readWriteOverlap guarantees freshness', 'readWriteOverlap', [
          { args: [2, 2, 3], expected: true }, { args: [1, 2, 3], expected: false }, { args: [3, 3, 5], expected: true },
        ]),
      ],
      solution: `function quorum(n) {\n  return Math.floor(n / 2) + 1;\n}\nfunction committed(acks, n) {\n  return acks >= quorum(n);\n}\nfunction readWriteOverlap(readQuorum, writeQuorum, n) {\n  return readQuorum + writeQuorum > n;\n}`,
      realityNote: 'Quorum systems commit a write once a majority acknowledges, surviving a minority of failures; making read and write quorums overlap (R + W > N) guarantees reads see the latest write.',
    });
  }),
  tmpl(8, 2, 'advanced', 'lamport-clock', 'Order events with logical clocks', 'E1', 25, 'Use Lamport timestamps to order events across machines without synchronised clocks.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Logical time\n\nAcross the machines of **${m.host}**\'s cluster, Lamport clocks order events without synchronised physical clocks. Write:\n\n1. \`tickLocal(clock)\`: a local event increments the clock — return \`clock + 1\`.\n2. \`onReceive(localClock, messageTimestamp)\`: on receiving a message, the clock becomes \`max(localClock, messageTimestamp) + 1\`. Return it.\n3. \`happenedBefore(a, b)\`: \`a\` and \`b\` are \`{ time, process }\`. Return \`true\` if \`a\` happened before \`b\` by Lamport order: \`a.time < b.time\`, or (\`a.time === b.time\` and \`a.process < b.process\`) to break ties deterministically.`,
      hints: ['A send/receive advances the clock past the message timestamp.', 'Break equal timestamps by process id for a total order.'],
      starter: `// ${m.host}: Lamport clocks\nfunction tickLocal(clock) {\n}\n\nfunction onReceive(localClock, messageTimestamp) {\n}\n\nfunction happenedBefore(a, b) {\n}\n`,
      checks: [
        fn('tickLocal increments', 'tickLocal', [{ args: [4], expected: 5 }]),
        fn('onReceive takes the max plus one', 'onReceive', [
          { args: [3, 7], expected: 8 }, { args: [9, 2], expected: 10 },
        ]),
        fn('happenedBefore orders events', 'happenedBefore', [
          { args: [{ time: 2, process: 1 }, { time: 5, process: 0 }], expected: true },
          { args: [{ time: 5, process: 0 }, { time: 5, process: 1 }], expected: true },
          { args: [{ time: 5, process: 1 }, { time: 5, process: 0 }], expected: false },
        ]),
      ],
      solution: `function tickLocal(clock) {\n  return clock + 1;\n}\nfunction onReceive(localClock, messageTimestamp) {\n  return Math.max(localClock, messageTimestamp) + 1;\n}\nfunction happenedBefore(a, b) {\n  return a.time < b.time || (a.time === b.time && a.process < b.process);\n}`,
      realityNote: 'Lamport clocks give a consistent ordering of events across machines without synchronised physical clocks; ties broken by process id yield a total order used in distributed algorithms.',
    });
  }),

  /* ------------------------------------------------------------------ 8.3 mobile operating systems */
  tmpl(8, 3, 'beginner', 'app-lifecycle', 'Manage a mobile app life cycle', 'E1', 20, 'Track an app through foreground, background and stopped states under memory pressure.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The mobile app life cycle\n\nOn **${m.host}** (a mobile OS), apps move between \`"foreground"\`, \`"background"\` and \`"stopped"\`. Write:\n\n1. \`onEvent(state, event)\`: events are \`"open"\` (→ foreground), \`"leave"\` (foreground → background), \`"return"\` (background → foreground), \`"lowMemory"\` (background → stopped; foreground unaffected). Return the new state; unknown transitions keep the state.\n2. \`reclaimable(apps)\`: \`apps\` is an array of \`{ id, state }\`; return the ids of apps in \`"background"\` (candidates to stop under memory pressure), sorted.`,
      hints: ['The foreground app is never reclaimed under memory pressure.', 'Background apps are the reclaim candidates.'],
      starter: `// ${m.host}: app life cycle\nfunction onEvent(state, event) {\n}\n\nfunction reclaimable(apps) {\n}\n`,
      checks: [
        fn('onEvent follows the life cycle', 'onEvent', [
          { args: ['stopped', 'open'], expected: 'foreground' },
          { args: ['foreground', 'leave'], expected: 'background' },
          { args: ['background', 'return'], expected: 'foreground' },
          { args: ['background', 'lowMemory'], expected: 'stopped' },
          { args: ['foreground', 'lowMemory'], expected: 'foreground' },
        ]),
        fn('reclaimable lists background apps', 'reclaimable', [
          { args: [[{ id: 'a', state: 'background' }, { id: 'b', state: 'foreground' }, { id: 'c', state: 'background' }]], expected: ['a', 'c'] },
        ]),
      ],
      solution: `function onEvent(state, event) {\n  if (event === "open") return "foreground";\n  if (event === "leave" && state === "foreground") return "background";\n  if (event === "return" && state === "background") return "foreground";\n  if (event === "lowMemory" && state === "background") return "stopped";\n  return state;\n}\nfunction reclaimable(apps) {\n  return apps.filter((a) => a.state === "background").map((a) => a.id).sort();\n}`,
      realityNote: 'Mobile OSes aggressively manage app life cycles: the foreground app is protected, background apps are frozen and reclaimed under memory pressure, which is why phones can run many apps on little RAM.',
    });
  }),
  tmpl(8, 3, 'intermediate', 'app-permissions', 'Enforce mobile app permissions', 'E1', 20, 'Grant an app access only to the permissions the user approved.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The app sandbox and permissions\n\nOn **${m.host}**, an app is sandboxed and may use only the permissions the user granted. Write:\n\n1. \`hasPermission(app, permission)\`: \`app.granted\` is an array of granted permissions. Return \`true\` if \`permission\` is in it.\n2. \`access(app, permission)\`: return \`{ ok: true }\` if granted, else \`{ ok: false, error: "permission-denied" }\`.\n3. \`revoke(app, permission)\`: return a new app with \`permission\` removed from \`granted\` (order preserved).`,
      hints: ['The sandbox denies anything not explicitly granted.', 'Revoking removes the permission from the granted list.'],
      starter: `// ${m.host}: app permissions\nfunction hasPermission(app, permission) {\n}\n\nfunction access(app, permission) {\n}\n\nfunction revoke(app, permission) {\n}\n`,
      checks: [
        fn('hasPermission checks the grant', 'hasPermission', [
          { args: [{ granted: ['camera', 'location'] }, 'camera'], expected: true },
          { args: [{ granted: ['camera'] }, 'contacts'], expected: false },
        ]),
        fn('access enforces the sandbox', 'access', [
          { args: [{ granted: ['camera'] }, 'camera'], expected: { ok: true } },
          { args: [{ granted: ['camera'] }, 'location'], expected: { ok: false, error: 'permission-denied' } },
        ]),
        fn('revoke removes a permission', 'revoke', [
          { args: [{ granted: ['camera', 'location'] }, 'camera'], expected: { granted: ['location'] } },
        ]),
      ],
      solution: `function hasPermission(app, permission) {\n  return app.granted.includes(permission);\n}\nfunction access(app, permission) {\n  return hasPermission(app, permission) ? { ok: true } : { ok: false, error: "permission-denied" };\n}\nfunction revoke(app, permission) {\n  return { ...app, granted: app.granted.filter((p) => p !== permission) };\n}`,
      realityNote: 'Android and iOS sandbox each app and gate sensitive resources (camera, location, contacts) behind user-granted, revocable permissions — deny-by-default at the OS level.',
    });
  }),
  tmpl(8, 3, 'advanced', 'battery-budget', 'Budget background work against battery', 'E1', 25, 'Decide which background jobs may run given a battery and Doze-style constraints.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Doze and background limits\n\nOn **${m.host}**, the OS restricts background work to save battery. Write:\n\n1. \`mayRun(job, state)\`: \`job = { importance }\` (\`"high"|"normal"|"low"\`), \`state = { charging, batteryPercent, doze }\`. Rules: if \`charging\` → any job runs; if \`doze\` is true → only \`"high"\` runs; otherwise run \`"high"\` always, \`"normal"\` when \`batteryPercent >= 20\`, \`"low"\` when \`batteryPercent >= 50\`.\n2. \`scheduleBatch(jobs, state)\`: return the ids of jobs that \`mayRun\`, preserving order.`,
      hints: ['Charging lifts the limits; Doze allows only high-importance work.', 'Lower-importance jobs need more battery headroom.'],
      starter: `// ${m.host}: background battery budget\nfunction mayRun(job, state) {\n}\n\nfunction scheduleBatch(jobs, state) {\n}\n`,
      checks: [
        fn('mayRun applies the battery rules', 'mayRun', [
          { args: [{ importance: 'low' }, { charging: true, batteryPercent: 5, doze: true }], expected: true },
          { args: [{ importance: 'high' }, { charging: false, batteryPercent: 5, doze: true }], expected: true },
          { args: [{ importance: 'normal' }, { charging: false, batteryPercent: 5, doze: true }], expected: false },
          { args: [{ importance: 'normal' }, { charging: false, batteryPercent: 30, doze: false }], expected: true },
          { args: [{ importance: 'low' }, { charging: false, batteryPercent: 30, doze: false }], expected: false },
        ]),
        fn('scheduleBatch filters runnable jobs', 'scheduleBatch', [
          { args: [[{ id: 'a', importance: 'high' }, { id: 'b', importance: 'low' }], { charging: false, batteryPercent: 30, doze: false }], expected: ['a'] },
        ]),
      ],
      solution: `function mayRun(job, state) {\n  if (state.charging) return true;\n  if (state.doze) return job.importance === "high";\n  if (job.importance === "high") return true;\n  if (job.importance === "normal") return state.batteryPercent >= 20;\n  return state.batteryPercent >= 50;\n}\nfunction scheduleBatch(jobs, state) {\n  return jobs.filter((j) => mayRun(j, state)).map((j) => j.id);\n}`,
      realityNote: 'Android Doze and app-standby defer background work when the device is idle or low on battery, running only high-priority jobs — a scheduling policy driven by energy, not just fairness.',
    });
  }),

  /* ------------------------------------------------------------------ 8.4 Linux kernel case study */
  tmpl(8, 4, 'beginner', 'contribute-to-linux', 'Reason about contributing to the kernel', 'E10', 15, 'Walk through how a change reaches the Linux kernel and why the process is strict.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Getting a change into the kernel\n\nYou found a small bug in a driver that affects **${m.host}**. Reason about how a fix reaches the Linux kernel.`,
      steps: [
        { title: 'Where to start', text: 'What is the first step before writing a patch?', choices: [
          { text: 'Read the subsystem\'s documentation and coding style, and check if it is already reported or fixed', right: true, feedback: 'Correct. Understand the conventions and avoid duplicate work.' },
          { text: 'Email Linus directly with your idea', feedback: 'Changes go through the relevant subsystem maintainer, not straight to the top.' },
          { text: 'Post the fix on social media', feedback: 'Kernel work goes through mailing lists and maintainers.' },
        ] },
        { title: 'The patch', text: 'How is a kernel change submitted?', choices: [
          { text: 'As a well-described patch (via git) to the subsystem\'s mailing list and maintainers, following the style rules', right: true, feedback: 'Correct. Patches to the maintainer/list, in the required format.' },
          { text: 'As a zip file to a web form', feedback: 'The kernel uses email patches and maintainers.' },
          { text: 'By editing the live kernel on a server', feedback: 'Changes are proposed as patches and reviewed first.' },
        ] },
        { title: 'Review', text: 'Why the strict review and testing?', choices: [
          { text: 'The kernel runs everywhere; a bad change can break countless systems, so review and testing are rigorous', right: true, feedback: 'Correct. Huge blast radius demands careful review.' },
          { text: 'To discourage contributors', feedback: 'It is about quality and safety, not discouragement.' },
          { text: 'There is no review', feedback: 'Kernel review is famously thorough.' },
        ] },
        { title: 'Sign-off', text: 'What does the Signed-off-by line mean?', choices: [
          { text: 'A certification (Developer Certificate of Origin) that you have the right to submit the change', right: true, feedback: 'Correct. It is the DCO attestation of provenance.' },
          { text: 'That the code is perfect', feedback: 'It certifies provenance, not perfection.' },
          { text: 'Nothing; it is decorative', feedback: 'It is a legal/provenance statement, required for contributions.' },
        ] },
      ],
      ending: { title: 'Patch, review, sign-off', text: 'A kernel change starts by learning the subsystem\'s conventions, is submitted as a well-described patch to the maintainer and mailing list, goes through rigorous review and testing because the blast radius is huge, and carries a Signed-off-by certifying its provenance.' },
      hints: ['Changes go to subsystem maintainers as email patches, not to the top.', 'Rigorous review exists because the kernel runs everywhere.'],
      realityNote: 'The Linux kernel\'s patch-and-maintainer workflow, Signed-off-by DCO, and heavy review reflect that a single regression can affect billions of devices.',
    });
  }),
  tmpl(8, 4, 'intermediate', 'patch-review-gate', 'Gate a kernel patch on its checks', 'E1', 20, 'Decide whether a patch is ready to merge from its review and test results.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Is the patch ready?\n\nFor a change affecting **${m.host}**, write \`patchReady(patch)\` where \`patch = { styleClean, buildsAllArch, testsPass, reviewed, signedOff }\`, returning the first blocking reason in this order:\n\n- \`"style"\` if not \`styleClean\`;\n- \`"build"\` if not \`buildsAllArch\`;\n- \`"tests"\` if not \`testsPass\`;\n- \`"needs-review"\` if not \`reviewed\`;\n- \`"needs-signoff"\` if not \`signedOff\`;\n- otherwise \`"ready"\`.`,
      hints: ['Evaluate the gates in order; return the first failure.', 'All must pass before a patch is ready.'],
      starter: `// ${m.host}: patch review gate\nfunction patchReady(patch) {\n}\n`,
      checks: [
        fn('patchReady gates the patch', 'patchReady', [
          { args: [{ styleClean: true, buildsAllArch: true, testsPass: true, reviewed: true, signedOff: true }], expected: 'ready' },
          { args: [{ styleClean: false, buildsAllArch: true, testsPass: true, reviewed: true, signedOff: true }], expected: 'style' },
          { args: [{ styleClean: true, buildsAllArch: false, testsPass: true, reviewed: true, signedOff: true }], expected: 'build' },
          { args: [{ styleClean: true, buildsAllArch: true, testsPass: false, reviewed: true, signedOff: true }], expected: 'tests' },
          { args: [{ styleClean: true, buildsAllArch: true, testsPass: true, reviewed: false, signedOff: true }], expected: 'needs-review' },
          { args: [{ styleClean: true, buildsAllArch: true, testsPass: true, reviewed: true, signedOff: false }], expected: 'needs-signoff' },
        ]),
      ],
      solution: `function patchReady(patch) {\n  if (!patch.styleClean) return "style";\n  if (!patch.buildsAllArch) return "build";\n  if (!patch.testsPass) return "tests";\n  if (!patch.reviewed) return "needs-review";\n  if (!patch.signedOff) return "needs-signoff";\n  return "ready";\n}`,
      realityNote: 'Kernel patches must pass style checks, build on all architectures, pass tests, earn maintainer review and carry a sign-off before merging — an ordered gate much like CI for any serious project.',
    });
  }),
  tmpl(8, 4, 'advanced', 'os-future-tradeoffs', 'Weigh a future OS design choice', 'E1', 20, 'Score design options for a future OS against competing goals.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Trade-offs never go away\n\nDesigning a future OS for **${m.host}**, score options against goals. Write:\n\n1. \`score(option, weights)\`: \`option\` has numeric ratings \`{ performance, security, simplicity }\` (0–10); \`weights\` has the same keys. Return the weighted sum \`sum(rating * weight)\`.\n2. \`best(options, weights)\`: return the \`name\` of the highest-scoring option (ties by name ascending).`,
      hints: ['Multiply each rating by its weight and sum.', 'Pick the option with the highest weighted score.'],
      starter: `// ${m.host}: design trade-offs\nfunction score(option, weights) {\n}\n\nfunction best(options, weights) {\n}\n`,
      checks: [
        fn('score weights the ratings', 'score', [
          { args: [{ performance: 8, security: 5, simplicity: 3 }, { performance: 2, security: 1, simplicity: 1 }], expected: 24 },
        ]),
        fn('best picks the top option', 'best', [
          { args: [[{ name: 'micro', performance: 5, security: 9, simplicity: 7 }, { name: 'mono', performance: 9, security: 5, simplicity: 4 }], { performance: 1, security: 2, simplicity: 1 }], expected: 'micro' },
          { args: [[{ name: 'a', performance: 1, security: 1, simplicity: 1 }, { name: 'b', performance: 1, security: 1, simplicity: 1 }], { performance: 1, security: 1, simplicity: 1 }], expected: 'a' },
        ]),
      ],
      solution: `function score(option, weights) {\n  return option.performance * weights.performance + option.security * weights.security + option.simplicity * weights.simplicity;\n}\nfunction best(options, weights) {\n  let top = null;\n  for (const o of options) {\n    if (top === null || score(o, weights) > score(top, weights) || (score(o, weights) === score(top, weights) && o.name < top.name)) top = o;\n  }\n  return top.name;\n}`,
      realityNote: 'OS design is a permanent balance of performance, security and simplicity; which wins depends on the weights a given system\'s goals assign — the same trade-off from mainframes to microkernels to unikernels.',
    });
  }),
];
