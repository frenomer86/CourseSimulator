/** Unit 6: the I/O system — I/O hardware and data-transfer methods (polling, interrupts, DMA),
 * the I/O subsystem (drivers, buffering, spooling), driver/interrupt handling, and timers. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U6: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 6.1 I/O hardware and methods */
  tmpl(6, 1, 'beginner', 'io-methods', 'Compare polling, interrupts and DMA', 'E10', 15, 'Choose the right data-transfer method for a device by cost and data volume.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Moving data to and from devices\n\n**${m.host}** talks to devices in three ways. Choose the right one for each situation.`,
      steps: [
        { title: 'Polling', text: 'What is the drawback of programmed I/O with polling?', choices: [
          { text: 'The CPU busy-waits checking a status bit, wasting cycles while the device is slow', right: true, feedback: 'Correct. Polling burns CPU waiting on the device.' },
          { text: 'It cannot read device status', feedback: 'Polling reads status repeatedly — that is the problem.' },
          { text: 'It needs no CPU at all', feedback: 'It consumes the CPU in the wait loop.' },
        ] },
        { title: 'Interrupts', text: 'How do interrupts improve on polling?', choices: [
          { text: 'The CPU does other work and the device raises an interrupt when ready, avoiding busy-waiting', right: true, feedback: 'Correct. The device signals completion so the CPU need not poll.' },
          { text: 'They make the device faster', feedback: 'They free the CPU, not speed the device.' },
          { text: 'They remove the need for a driver', feedback: 'A driver still handles the interrupt.' },
        ] },
        { title: 'DMA', text: 'For a large block transfer, why use direct memory access?', choices: [
          { text: 'A DMA controller moves the whole block to/from memory and interrupts the CPU once at the end', right: true, feedback: 'Correct. DMA offloads bulk transfer, one interrupt per block.' },
          { text: 'The CPU copies every byte itself', feedback: 'That is programmed I/O; DMA avoids per-byte CPU work.' },
          { text: 'It interrupts the CPU for every byte', feedback: 'DMA interrupts once per block, not per byte.' },
        ] },
        { title: 'Choosing', text: 'When is simple polling still acceptable?', choices: [
          { text: 'For a very fast device or a short wait, where the overhead of interrupts would exceed the wait', right: true, feedback: 'Correct. For tiny waits, polling can be cheaper than an interrupt.' },
          { text: 'Never; polling is always wrong', feedback: 'For very short, fast operations polling can win.' },
          { text: 'Only for network cards', feedback: 'It depends on wait length, not device type alone.' },
        ] },
      ],
      ending: { title: 'Match the method to the device', text: 'Polling busy-waits (fine only for very short waits), interrupts free the CPU until the device signals readiness, and DMA offloads bulk transfers with a single completion interrupt.' },
      hints: ['Polling wastes CPU; interrupts free it; DMA offloads bulk transfer.', 'One interrupt per block is DMA\'s advantage for large data.'],
      realityNote: 'Real drivers mix these: interrupts for readiness, DMA for bulk data, and sometimes polling (NAPI in Linux networking) when traffic is so high that interrupts themselves become the bottleneck.',
    });
  }),
  tmpl(6, 1, 'intermediate', 'interrupt-vs-poll-cost', 'Compare the CPU cost of polling and interrupts', 'E1', 25, 'Compute CPU overhead for polling versus interrupt-driven I/O at a given rate.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Which costs the CPU less?\n\nOn **${m.host}**, write:\n\n1. \`pollingCost(pollsPerSecond, cyclesPerPoll)\`: CPU cycles per second spent polling = \`pollsPerSecond * cyclesPerPoll\`.\n2. \`interruptCost(eventsPerSecond, cyclesPerInterrupt)\`: cycles per second handling interrupts = \`eventsPerSecond * cyclesPerInterrupt\`.\n3. \`cheaper(pollsPerSecond, cyclesPerPoll, eventsPerSecond, cyclesPerInterrupt)\`: return \`"polling"\`, \`"interrupts"\` or \`"tie"\` by comparing the two costs.`,
      hints: ['Each is a simple rate × cost product.', 'High event rates can make interrupts more expensive than polling.'],
      starter: `// ${m.host}: polling vs interrupts\nfunction pollingCost(pollsPerSecond, cyclesPerPoll) {\n}\n\nfunction interruptCost(eventsPerSecond, cyclesPerInterrupt) {\n}\n\nfunction cheaper(pollsPerSecond, cyclesPerPoll, eventsPerSecond, cyclesPerInterrupt) {\n}\n`,
      checks: [
        fn('pollingCost multiplies', 'pollingCost', [{ args: [1000, 50], expected: 50000 }]),
        fn('interruptCost multiplies', 'interruptCost', [{ args: [1000, 200], expected: 200000 }]),
        fn('cheaper compares the costs', 'cheaper', [
          { args: [1000, 50, 1000, 200], expected: 'polling' },
          { args: [100000, 50, 10, 200], expected: 'interrupts' },
          { args: [100, 100, 100, 100], expected: 'tie' },
        ]),
      ],
      solution: `function pollingCost(pollsPerSecond, cyclesPerPoll) {\n  return pollsPerSecond * cyclesPerPoll;\n}\nfunction interruptCost(eventsPerSecond, cyclesPerInterrupt) {\n  return eventsPerSecond * cyclesPerInterrupt;\n}\nfunction cheaper(pollsPerSecond, cyclesPerPoll, eventsPerSecond, cyclesPerInterrupt) {\n  const p = pollingCost(pollsPerSecond, cyclesPerPoll);\n  const i = interruptCost(eventsPerSecond, cyclesPerInterrupt);\n  if (p < i) return "polling";\n  if (i < p) return "interrupts";\n  return "tie";\n}`,
      realityNote: 'At very high event rates the per-interrupt overhead dominates, which is why high-speed network drivers switch to polling (NAPI) under load — a real cost crossover.',
    });
  }),
  tmpl(6, 1, 'advanced', 'dma-transfer', 'Account for a DMA transfer', 'E1', 20, 'Compute block counts and the single completion interrupt of a DMA transfer.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## A DMA transfer\n\nOn **${m.host}**, DMA moves data in fixed-size blocks and raises **one** interrupt when the whole transfer finishes. Write:\n\n1. \`blocksNeeded(bytes, blockSize)\`: the number of blocks to move \`bytes\`, rounding up. 0 bytes needs 0 blocks.\n2. \`cpuInterrupts(bytes, blockSize, perBlock)\`: if \`perBlock\` is true, one interrupt per block; otherwise exactly one interrupt for the whole transfer (0 if there is nothing to move).\n3. \`cpuFreeDuringTransfer()\`: return \`true\` (the CPU is free to run other work while the DMA controller transfers).`,
      hints: ['Round up the block count.', 'Classic DMA interrupts once at the end, not per block.'],
      starter: `// ${m.host}: DMA transfer\nfunction blocksNeeded(bytes, blockSize) {\n}\n\nfunction cpuInterrupts(bytes, blockSize, perBlock) {\n}\n\nfunction cpuFreeDuringTransfer() {\n}\n`,
      checks: [
        fn('blocksNeeded rounds up', 'blocksNeeded', [
          { args: [1000, 512], expected: 2 }, { args: [512, 512], expected: 1 }, { args: [0, 512], expected: 0 },
        ]),
        fn('cpuInterrupts counts correctly', 'cpuInterrupts', [
          { args: [1000, 512, false], expected: 1 },
          { args: [1000, 512, true], expected: 2 },
          { args: [0, 512, false], expected: 0 },
        ]),
        fn('cpuFreeDuringTransfer is true', 'cpuFreeDuringTransfer', [{ args: [], expected: true }]),
      ],
      solution: `function blocksNeeded(bytes, blockSize) {\n  return Math.ceil(bytes / blockSize);\n}\nfunction cpuInterrupts(bytes, blockSize, perBlock) {\n  const blocks = blocksNeeded(bytes, blockSize);\n  if (blocks === 0) return 0;\n  return perBlock ? blocks : 1;\n}\nfunction cpuFreeDuringTransfer() {\n  return true;\n}`,
      realityNote: 'DMA lets the CPU continue working while a dedicated controller moves a block of data, raising a single completion interrupt — the key to efficient high-volume I/O.',
    });
  }),

  /* ------------------------------------------------------------------ 6.2 the I/O subsystem */
  tmpl(6, 2, 'beginner', 'block-vs-char', 'Classify devices as block or character', 'E1', 20, 'Decide the device class and whether random access is supported.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Block and character devices\n\nOn **${m.host}**, write \`deviceClass(device)\`: block devices transfer fixed-size blocks and support random access (disks, SSDs); character devices are byte streams (keyboards, serial ports, mice). Return \`"block"\` for \`"disk"\`, \`"ssd"\`, \`"cdrom"\`; \`"character"\` for \`"keyboard"\`, \`"serial"\`, \`"mouse"\`, \`"terminal"\`; else \`"unknown"\`.\n\nAlso \`supportsRandomAccess(device)\`: return \`true\` only for block devices.`,
      hints: ['Block devices are seekable storage; character devices are streams.', 'Random access maps to the block class.'],
      starter: `// ${m.host}: device classes\nfunction deviceClass(device) {\n}\n\nfunction supportsRandomAccess(device) {\n}\n`,
      checks: [
        fn('deviceClass classifies devices', 'deviceClass', [
          { args: ['disk'], expected: 'block' }, { args: ['ssd'], expected: 'block' },
          { args: ['keyboard'], expected: 'character' }, { args: ['serial'], expected: 'character' }, { args: ['gpu'], expected: 'unknown' },
        ]),
        fn('supportsRandomAccess for block devices', 'supportsRandomAccess', [
          { args: ['disk'], expected: true }, { args: ['keyboard'], expected: false },
        ]),
      ],
      solution: `function deviceClass(device) {\n  if (["disk", "ssd", "cdrom"].includes(device)) return "block";\n  if (["keyboard", "serial", "mouse", "terminal"].includes(device)) return "character";\n  return "unknown";\n}\nfunction supportsRandomAccess(device) {\n  return deviceClass(device) === "block";\n}`,
      realityNote: 'Unix exposes block devices (seekable, buffered, fixed-size blocks) and character devices (byte streams) through different driver interfaces — the /dev split you see as b and c in ls -l.',
    });
  }),
  tmpl(6, 2, 'intermediate', 'double-buffering', 'Overlap I/O and compute with buffering', 'E1', 25, 'Model double buffering so the CPU processes one buffer while I/O fills the other.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Double buffering\n\nOn **${m.host}**, two buffers let I/O fill one while the CPU processes the other. Write:\n\n1. \`totalTimeSingle(blocks, ioTime, cpuTime)\`: with one buffer, I/O and compute cannot overlap, so each block costs \`ioTime + cpuTime\`; total = \`blocks * (ioTime + cpuTime)\`.\n2. \`totalTimeDouble(blocks, ioTime, cpuTime)\`: with double buffering, steady-state each stage overlaps, so total ≈ \`ioTime + blocks * Math.max(ioTime, cpuTime)\` (first fill, then the slower stage paces the rest). Return that.\n3. \`speedup(blocks, ioTime, cpuTime)\`: \`totalTimeSingle / totalTimeDouble\`, rounded to 2 decimals.`,
      hints: ['Single buffering serialises I/O and compute.', 'Double buffering is paced by the slower of the two stages.'],
      starter: `// ${m.host}: double buffering\nfunction totalTimeSingle(blocks, ioTime, cpuTime) {\n}\n\nfunction totalTimeDouble(blocks, ioTime, cpuTime) {\n}\n\nfunction speedup(blocks, ioTime, cpuTime) {\n}\n`,
      checks: [
        fn('totalTimeSingle serialises', 'totalTimeSingle', [
          { args: [10, 5, 3], expected: 80 },
        ]),
        fn('totalTimeDouble overlaps', 'totalTimeDouble', [
          { args: [10, 5, 3], expected: 55 },
          { args: [4, 2, 6], expected: 26 },
        ]),
        fn('speedup compares the two', 'speedup', [
          { args: [10, 5, 5], expected: 1.82 },
        ]),
      ],
      solution: `function totalTimeSingle(blocks, ioTime, cpuTime) {\n  return blocks * (ioTime + cpuTime);\n}\nfunction totalTimeDouble(blocks, ioTime, cpuTime) {\n  return ioTime + blocks * Math.max(ioTime, cpuTime);\n}\nfunction speedup(blocks, ioTime, cpuTime) {\n  return Math.round((totalTimeSingle(blocks, ioTime, cpuTime) / totalTimeDouble(blocks, ioTime, cpuTime)) * 100) / 100;\n}`,
      realityNote: 'Double buffering overlaps I/O with computation so throughput is paced by the slower stage rather than their sum — the idea behind buffered and pipelined I/O everywhere.',
    });
  }),
  tmpl(6, 2, 'advanced', 'spooling', 'Manage a print spool queue', 'E1', 25, 'Serialise concurrent print jobs through a spool so one device is shared fairly.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Spooling a shared device\n\nA printer on **${m.host}** can serve one job at a time; a spool queues the rest. Jobs are \`{ id, submitTime, pages }\`. Write:\n\n1. \`spoolOrder(jobs)\`: return job \`id\`s ordered by \`submitTime\` (ties by \`id\` ascending) — FCFS spooling.\n2. \`completionTimes(jobs, pagesPerSecond)\`: processing in spool order, each job starts when the previous finishes (or at its submit time if the printer is idle) and takes \`pages / pagesPerSecond\` seconds. Return an object mapping \`id\` to completion time (seconds). Assume \`pagesPerSecond\` divides evenly.`,
      hints: ['Sort by submit time for FCFS spooling.', 'The printer idles to the next submit time when it is ahead.'],
      starter: `// ${m.host}: print spooling\nfunction spoolOrder(jobs) {\n}\n\nfunction completionTimes(jobs, pagesPerSecond) {\n}\n`,
      checks: [
        fn('spoolOrder is FCFS', 'spoolOrder', [
          { args: [[{ id: 'B', submitTime: 2, pages: 1 }, { id: 'A', submitTime: 0, pages: 1 }, { id: 'C', submitTime: 2, pages: 1 }]], expected: ['A', 'B', 'C'] },
        ]),
        fn('completionTimes serialises the jobs', 'completionTimes', [
          { args: [[{ id: 'A', submitTime: 0, pages: 10 }, { id: 'B', submitTime: 1, pages: 10 }], 10], expected: { A: 1, B: 2 } },
          { args: [[{ id: 'A', submitTime: 0, pages: 10 }, { id: 'B', submitTime: 5, pages: 10 }], 10], expected: { A: 1, B: 6 } },
        ]),
      ],
      solution: `function spoolOrder(jobs) {\n  return [...jobs].sort((a, b) => a.submitTime - b.submitTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((j) => j.id);\n}\nfunction completionTimes(jobs, pagesPerSecond) {\n  const order = [...jobs].sort((a, b) => a.submitTime - b.submitTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));\n  let time = 0;\n  const out = {};\n  for (const j of order) {\n    const start = Math.max(time, j.submitTime);\n    time = start + j.pages / pagesPerSecond;\n    out[j.id] = time;\n  }\n  return out;\n}`,
      realityNote: 'Spooling (Simultaneous Peripheral Operation On-Line) buffers jobs for a slow shared device like a printer, letting many processes submit while the device serves them one at a time.',
    });
  }),

  /* ------------------------------------------------------------------ 6.3 drivers and interrupt handling */
  tmpl(6, 3, 'beginner', 'driver-interface', 'Dispatch through a driver\'s operations', 'E1', 20, 'Route a request to the right driver entry point and reject unsupported operations.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The uniform driver interface\n\nOn **${m.host}**, the kernel calls drivers through a fixed set of operations (\`open\`, \`read\`, \`write\`, \`close\`, \`ioctl\`). Write \`callDriver(driver, op, arg)\` where \`driver\` is an object whose keys are supported op names mapping to a small result value:\n\n- if \`op\` is not a supported operation (not an own key of \`driver\`) → \`{ error: "ENOTSUP" }\`;\n- otherwise → \`{ ok: true, result: driver[op] }\`.\n\nAlso \`supportedOps(driver)\`: return the supported op names, sorted.`,
      hints: ['A driver advertises the ops it implements.', 'An unsupported op returns ENOTSUP.'],
      starter: `// ${m.host}: driver dispatch\nfunction callDriver(driver, op, arg) {\n}\n\nfunction supportedOps(driver) {\n}\n`,
      checks: [
        fn('callDriver routes to the op', 'callDriver', [
          { args: [{ read: 1, write: 2 }, 'read', 0], expected: { ok: true, result: 1 } },
          { args: [{ read: 1 }, 'ioctl', 0], expected: { error: 'ENOTSUP' } },
        ]),
        fn('supportedOps lists the operations', 'supportedOps', [
          { args: [{ write: 2, read: 1 }], expected: ['read', 'write'] },
        ]),
      ],
      solution: `function callDriver(driver, op, arg) {\n  if (!Object.prototype.hasOwnProperty.call(driver, op)) return { error: "ENOTSUP" };\n  return { ok: true, result: driver[op] };\n}\nfunction supportedOps(driver) {\n  return Object.keys(driver).sort();\n}`,
      realityNote: 'The kernel calls every driver through the same operation table (open/read/write/ioctl/…), so devices look uniform to the rest of the system — the essence of the device-independent I/O layer.',
    });
  }),
  tmpl(6, 3, 'intermediate', 'top-bottom-half', 'Split interrupt work into halves', 'E1', 25, 'Decide what runs in the fast interrupt handler and what is deferred.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Top half and bottom half\n\nOn **${m.host}**, an interrupt handler should do the minimum urgently (acknowledge the device, grab data) and defer the rest. Write \`schedule(task)\` where \`task = { name, urgent }\`:\n\n- return \`"top-half"\` when \`urgent\` is true (runs now, with interrupts disabled, must be short);\n- return \`"bottom-half"\` when \`urgent\` is false (deferred work, runs later with interrupts enabled).\n\nAlso \`partition(tasks)\`: return \`{ top, bottom }\` arrays of task names split by this rule, preserving order.`,
      hints: ['Urgent, short work goes in the top half; the rest is deferred.', 'Partition keeps the original order within each half.'],
      starter: `// ${m.host}: interrupt halves\nfunction schedule(task) {\n}\n\nfunction partition(tasks) {\n}\n`,
      checks: [
        fn('schedule assigns the half', 'schedule', [
          { args: [{ name: 'ack', urgent: true }], expected: 'top-half' },
          { args: [{ name: 'process', urgent: false }], expected: 'bottom-half' },
        ]),
        fn('partition splits the tasks', 'partition', [
          { args: [[{ name: 'ack', urgent: true }, { name: 'copy', urgent: true }, { name: 'parse', urgent: false }]], expected: { top: ['ack', 'copy'], bottom: ['parse'] } },
        ]),
      ],
      solution: `function schedule(task) {\n  return task.urgent ? "top-half" : "bottom-half";\n}\nfunction partition(tasks) {\n  const top = [], bottom = [];\n  for (const t of tasks) (t.urgent ? top : bottom).push(t.name);\n  return { top, bottom };\n}`,
      realityNote: 'Linux splits interrupt handling into a short top half (hard IRQ) and a deferred bottom half (softirq/tasklet/workqueue) so interrupts stay disabled for as little time as possible.',
    });
  }),
  tmpl(6, 3, 'advanced', 'interrupt-coalescing', 'Coalesce interrupts to cut overhead', 'E1', 25, 'Batch device events so one interrupt covers several, trading latency for throughput.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Interrupt coalescing\n\nOn **${m.host}**, a device can hold events and raise one interrupt per batch, cutting overhead at a small latency cost. Write:\n\n1. \`interruptsFor(events, batchSize)\`: with \`batchSize\` events per interrupt, the number of interrupts is \`Math.ceil(events / batchSize)\` (0 for 0 events).\n2. \`overheadSaved(events, batchSize, cyclesPerInterrupt)\`: cycles saved versus one interrupt per event = \`(events - interruptsFor(events, batchSize)) * cyclesPerInterrupt\`.\n3. \`worthCoalescing(events, batchSize, cyclesPerInterrupt, maxLatencyBudget, perEventLatency)\`: coalescing adds up to \`(batchSize - 1) * perEventLatency\` latency; return \`true\` only when that added latency is \`<= maxLatencyBudget\`.`,
      hints: ['Ceil-divide events by the batch size for the interrupt count.', 'Coalescing is worth it only if the added latency fits the budget.'],
      starter: `// ${m.host}: interrupt coalescing\nfunction interruptsFor(events, batchSize) {\n}\n\nfunction overheadSaved(events, batchSize, cyclesPerInterrupt) {\n}\n\nfunction worthCoalescing(events, batchSize, cyclesPerInterrupt, maxLatencyBudget, perEventLatency) {\n}\n`,
      checks: [
        fn('interruptsFor batches events', 'interruptsFor', [
          { args: [100, 10], expected: 10 }, { args: [105, 10], expected: 11 }, { args: [0, 10], expected: 0 },
        ]),
        fn('overheadSaved counts saved cycles', 'overheadSaved', [
          { args: [100, 10, 200], expected: 18000 },
        ]),
        fn('worthCoalescing checks the latency budget', 'worthCoalescing', [
          { args: [100, 10, 200, 100, 5], expected: true },
          { args: [100, 10, 200, 20, 5], expected: false },
        ]),
      ],
      solution: `function interruptsFor(events, batchSize) {\n  return Math.ceil(events / batchSize);\n}\nfunction overheadSaved(events, batchSize, cyclesPerInterrupt) {\n  return (events - interruptsFor(events, batchSize)) * cyclesPerInterrupt;\n}\nfunction worthCoalescing(events, batchSize, cyclesPerInterrupt, maxLatencyBudget, perEventLatency) {\n  return (batchSize - 1) * perEventLatency <= maxLatencyBudget;\n}`,
      realityNote: 'Network cards coalesce interrupts — one interrupt per batch of packets — to cut per-interrupt overhead at high rates, trading a little latency for a lot of throughput.',
    });
  }),

  /* ------------------------------------------------------------------ 6.4 clocks, timers and power */
  tmpl(6, 4, 'beginner', 'timer-wheel', 'Fire timers that have expired', 'E1', 20, 'Advance a clock and collect the timers due to fire.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Expiring timers\n\nOn **${m.host}**, the kernel keeps timers with an \`expiry\` time. Write:\n\n1. \`dueTimers(timers, now)\`: return the \`id\`s of timers with \`expiry <= now\`, sorted by \`expiry\` then \`id\`.\n2. \`advance(timers, now)\`: return \`{ fired, remaining }\` — \`fired\` is the due ids (as from dueTimers), \`remaining\` is the timers whose \`expiry > now\` (in original order).`,
      hints: ['A timer is due when its expiry is at or before now.', 'Sort due timers by expiry, then id.'],
      starter: `// ${m.host}: timers\nfunction dueTimers(timers, now) {\n}\n\nfunction advance(timers, now) {\n}\n`,
      checks: [
        fn('dueTimers finds expired timers', 'dueTimers', [
          { args: [[{ id: 'a', expiry: 10 }, { id: 'b', expiry: 5 }, { id: 'c', expiry: 20 }], 10], expected: ['b', 'a'] },
          { args: [[{ id: 'a', expiry: 100 }], 10], expected: [] },
        ]),
        fn('advance fires and keeps the rest', 'advance', [
          { args: [[{ id: 'a', expiry: 5 }, { id: 'b', expiry: 20 }], 10], expected: { fired: ['a'], remaining: [{ id: 'b', expiry: 20 }] } },
        ]),
      ],
      solution: `function dueTimers(timers, now) {\n  return timers.filter((t) => t.expiry <= now).sort((a, b) => a.expiry - b.expiry || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((t) => t.id);\n}\nfunction advance(timers, now) {\n  return { fired: dueTimers(timers, now), remaining: timers.filter((t) => t.expiry > now) };\n}`,
      realityNote: 'The kernel maintains timers and fires those that have expired on each tick; efficient structures (timer wheels, hierarchical timing wheels) make this scale to many timers.',
    });
  }),
  tmpl(6, 4, 'intermediate', 'tickless-idle', 'Save power with a tickless idle', 'E1', 20, 'Decide the next wake time so an idle CPU can sleep instead of ticking.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Tickless idle\n\nOn **${m.host}**, instead of waking every tick, an idle CPU sleeps until the next timer. Write:\n\n1. \`nextWake(timers, now)\`: return the earliest \`expiry\` strictly greater than \`now\`, or \`null\` if there is none.\n2. \`sleepDuration(timers, now)\`: \`nextWake - now\`, or \`null\` if there is no next timer (can sleep indefinitely until an interrupt).\n3. \`ticksSaved(sleepDuration, tickInterval)\`: how many periodic ticks are avoided by sleeping = \`Math.floor(sleepDuration / tickInterval)\` (0 if sleepDuration is null).`,
      hints: ['The CPU sleeps until the nearest future timer.', 'Each avoided tick is a saved wake-up.'],
      starter: `// ${m.host}: tickless idle\nfunction nextWake(timers, now) {\n}\n\nfunction sleepDuration(timers, now) {\n}\n\nfunction ticksSaved(sleepDuration, tickInterval) {\n}\n`,
      checks: [
        fn('nextWake finds the next timer', 'nextWake', [
          { args: [[{ expiry: 100 }, { expiry: 50 }], 10], expected: 50 },
          { args: [[{ expiry: 5 }], 10], expected: null },
        ]),
        fn('sleepDuration is the gap', 'sleepDuration', [
          { args: [[{ expiry: 50 }], 10], expected: 40 },
          { args: [[{ expiry: 5 }], 10], expected: null },
        ]),
        fn('ticksSaved counts avoided ticks', 'ticksSaved', [
          { args: [40, 10], expected: 4 }, { args: [null, 10], expected: 0 },
        ]),
      ],
      solution: `function nextWake(timers, now) {\n  const future = timers.filter((t) => t.expiry > now).map((t) => t.expiry);\n  return future.length ? Math.min(...future) : null;\n}\nfunction sleepDuration(timers, now) {\n  const w = nextWake(timers, now);\n  return w === null ? null : w - now;\n}\nfunction ticksSaved(sleepDuration, tickInterval) {\n  return sleepDuration === null ? 0 : Math.floor(sleepDuration / tickInterval);\n}`,
      realityNote: 'A tickless (NOHZ) kernel stops the periodic timer interrupt when a CPU is idle and sleeps until the next real event, saving significant power on laptops and phones.',
    });
  }),
  tmpl(6, 4, 'advanced', 'dvfs', 'Scale frequency to save energy', 'E1', 25, 'Pick the lowest CPU frequency that still meets a deadline, to save power.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Dynamic voltage and frequency scaling\n\nOn **${m.host}**, running slower saves energy (roughly with the square of frequency) but must still meet deadlines. A job needs \`cycles\` cycles by a \`deadline\` (seconds). Write:\n\n1. \`minFrequency(cycles, deadline)\`: the lowest frequency (cycles/sec) that finishes in time = \`cycles / deadline\` (round **up** to an integer).\n2. \`feasible(freq, cycles, deadline)\`: return \`true\` if running at \`freq\` finishes by the deadline (\`cycles / freq <= deadline\`).\n3. \`relativeEnergy(freq, baseFreq)\`: energy scales ~ frequency squared; return \`(freq / baseFreq) ** 2\`, rounded to 3 decimals.`,
      hints: ['The minimum frequency is work divided by time, rounded up.', 'Energy grows with the square of frequency, so slower is much cheaper.'],
      starter: `// ${m.host}: DVFS\nfunction minFrequency(cycles, deadline) {\n}\n\nfunction feasible(freq, cycles, deadline) {\n}\n\nfunction relativeEnergy(freq, baseFreq) {\n}\n`,
      checks: [
        fn('minFrequency meets the deadline', 'minFrequency', [
          { args: [1000, 2], expected: 500 }, { args: [1001, 2], expected: 501 },
        ]),
        fn('feasible checks the deadline', 'feasible', [
          { args: [500, 1000, 2], expected: true }, { args: [400, 1000, 2], expected: false },
        ]),
        fn('relativeEnergy scales with freq squared', 'relativeEnergy', [
          { args: [500, 1000], expected: 0.25 }, { args: [1000, 1000], expected: 1 },
        ]),
      ],
      solution: `function minFrequency(cycles, deadline) {\n  return Math.ceil(cycles / deadline);\n}\nfunction feasible(freq, cycles, deadline) {\n  return cycles / freq <= deadline;\n}\nfunction relativeEnergy(freq, baseFreq) {\n  return Math.round(((freq / baseFreq) ** 2) * 1000) / 1000;\n}`,
      realityNote: 'DVFS runs the CPU at the lowest frequency that still meets deadlines because dynamic power rises roughly with the square of frequency (and more with voltage) — the basis of mobile power management.',
    });
  }),
];
