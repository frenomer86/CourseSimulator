/**
 * The CPU bench for assembly labs: write a program, run it to HLT or step through it, and watch
 * registers, flags, data memory, output and the cycle count.
 */

import { useMemo, useState } from 'react';
import { CYCLES, REGISTERS, runCpu, signed16, type CpuRun, type HardwareConfig, type HardwareState } from '@cslab/engine-hardware';

type Props = { config: HardwareConfig; state: HardwareState; update: (patch: Partial<HardwareState>) => void; interact?: (action: string, detail?: Record<string, unknown>) => void };

const hex = (v: number) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');

export function CpuBench({ config, state, update, interact }: Props) {
  const source = state.source ?? '';
  const [run, setRun] = useState<CpuRun | null>(null);
  const [at, setAt] = useState(0);
  const table = { ...CYCLES, ...(config.cpu?.cycles ?? {}) };

  const execute = (toEnd: boolean) => {
    const r = runCpu(source, { cycles: config.cpu?.cycles, maxSteps: config.cpu?.maxSteps });
    setRun(r);
    setAt(toEnd ? r.trace.length : 0);
    interact?.(toEnd ? 'run' : 'step', { ok: r.ok, instructions: r.instructions, cycles: r.cycles });
  };

  // State after `at` executed instructions: replay memory writes from the initial memory.
  const view = useMemo(() => {
    if (!run) return null;
    const n = Math.min(at, run.trace.length);
    const mem = [...run.initialMemory];
    let cycles = 0;
    const output: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = run.trace[i];
      if (s.wrote) mem[s.wrote[0]] = s.wrote[1];
      if (s.output !== undefined) output.push(s.output);
      cycles += s.cycles;
    }
    const last = n > 0 ? run.trace[n - 1] : undefined;
    const regs = last?.regs ?? Object.fromEntries(REGISTERS.map((r) => [r, r === 'SP' ? 256 : 0]));
    const flags = last?.flags ?? { ZF: false, SF: false, CF: false, OF: false };
    const nextStep = run.trace[n];
    return { n, mem, cycles, output, regs: regs as Record<string, number>, flags, last, nextStep, finished: n >= run.trace.length };
  }, [run, at]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-surface overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line text-sm">
          <span className="font-medium mr-auto">
            program.asm <span className="text-ink-faint font-normal">(16-bit bench CPU, x86-style)</span>
          </span>
          <button type="button" onClick={() => execute(true)} className="rounded-md bg-high px-4 py-1.5 text-white font-medium hover:bg-[#0c5a46]">
            Run to HLT
          </button>
          <button type="button" onClick={() => (run ? setAt((i) => Math.min(run.trace.length, i + 1)) : execute(false))} className="rounded-md border border-line bg-surface px-3 py-1.5 font-medium hover:bg-bench" aria-label="Step one instruction">
            Step ▶
          </button>
          <button type="button" onClick={() => setAt((i) => Math.max(0, i - 1))} disabled={!run || at === 0} className="rounded-md border border-line bg-surface px-3 py-1.5 font-medium hover:bg-bench disabled:opacity-50" aria-label="Step back">
            ◀ Back
          </button>
        </div>
        <textarea
          value={source}
          onChange={(e) => {
            update({ source: e.target.value });
            setRun(null);
            setAt(0);
          }}
          rows={Math.min(26, Math.max(14, source.split('\n').length + 2))}
          spellCheck={false}
          className="w-full font-mono text-[13px] leading-5 bg-surface px-3 py-2 outline-none resize-y"
          aria-label="Assembly program"
        />
      </div>

      {run?.error && (
        <p className="rounded-md border border-fault/40 bg-fault-soft px-3 py-2 text-sm" role="alert">
          {run.error}
        </p>
      )}

      {view && (
        <div className="rounded-lg border border-line bg-bench p-3 text-sm space-y-3">
          <p className="font-mono text-xs">
            {view.finished ? (run?.halted ? 'Halted.' : 'Stopped.') : view.nextStep ? <>Next: line {view.nextStep.line}: <span className="font-medium">{view.nextStep.text}</span></> : null}
            <span className="ml-3 text-ink-soft">
              instructions {view.n} · cycles {view.cycles}
              {view.n > 0 ? ` · CPI ${(view.cycles / view.n).toFixed(2)}` : ''}
            </span>
          </p>
          <div className="grid gap-3 md:grid-cols-[auto_1fr]">
            <table className="font-mono text-xs" aria-label="Registers">
              <tbody>
                {REGISTERS.map((r) => {
                  const v = view.regs[r] ?? 0;
                  const changed = view.last && view.n > 1 && run!.trace[view.n - 2]?.regs[r] !== v;
                  return (
                    <tr key={r} className={changed ? 'bg-gold-soft' : ''}>
                      <td className="pr-2 font-medium">{r}</td>
                      <td className="pr-2 text-right">{signed16(v)}</td>
                      <td className="text-ink-soft">{hex(v)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5" aria-label="Flags">
                {(['ZF', 'SF', 'CF', 'OF'] as const).map((f) => (
                  <span key={f} className={`rounded px-2 py-0.5 font-mono text-xs border ${view.flags[f] ? 'border-high bg-high-soft text-high' : 'border-line bg-surface text-ink-faint'}`}>
                    {f}={view.flags[f] ? 1 : 0}
                  </span>
                ))}
              </div>
              <div aria-label="Data memory">
                <h3 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Data</h3>
                <table className="mt-1 font-mono text-xs">
                  <tbody>
                    {Object.entries(run!.dataLabels).map(([label, d]) => (
                      <tr key={label}>
                        <td className="pr-2 text-ink-soft">{label}</td>
                        <td className="pr-2 text-ink-faint">@{d.addr}</td>
                        <td>{view.mem.slice(d.addr, d.addr + d.size).map((x) => signed16(x)).join(', ')}</td>
                      </tr>
                    ))}
                    {Object.keys(run!.dataLabels).length === 0 && (
                      <tr>
                        <td className="text-ink-faint">no data declared</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="font-mono text-xs" aria-label="Output">
                <span className="text-ink-soft">OUT:</span> {view.output.length ? view.output.map((x) => signed16(x)).join(' ') : '(nothing yet)'}
              </p>
            </div>
          </div>
        </div>
      )}

      <details className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Instruction set and cycle costs</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
          <p>
            <span className="font-medium">Data:</span> <code>name: DW 1, 2, 3</code>, <code>name: RESW 4</code>. <span className="font-medium">Memory operands:</span> <code>[name]</code>, <code>[name+SI]</code>, <code>[BX]</code>, <code>[BX+SI+2]</code>.
            <br />
            <span className="font-medium">Instructions:</span> MOV ADD ADC SUB SBB CMP INC DEC NEG AND OR XOR NOT TEST SHL SHR SAR MUL DIV PUSH POP CALL RET OUT HLT NOP, jumps JMP JE/JZ JNE/JNZ JG JGE JL JLE JA JAE JB JBE JC JNC JS JNS and LOOP.
          </p>
          <table className="font-mono">
            <tbody>
              <tr><td className="pr-3">MOV, ALU, shifts, OUT, HLT</td><td>{table.alu}</td></tr>
              <tr><td className="pr-3">MUL / DIV</td><td>{table.mul} / {table.div}</td></tr>
              <tr><td className="pr-3">PUSH, POP</td><td>{table.stack}</td></tr>
              <tr><td className="pr-3">CALL, RET</td><td>{table.call}</td></tr>
              <tr><td className="pr-3">jump taken / not taken</td><td>{table.branchTaken} / {table.branchNotTaken}</td></tr>
              <tr><td className="pr-3">extra for a memory operand</td><td>+{table.memory}</td></tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
