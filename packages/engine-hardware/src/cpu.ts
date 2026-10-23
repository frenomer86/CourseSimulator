/**
 * The bench CPU: a 16-bit teaching processor with an x86-flavoured instruction subset.
 *
 * Registers AX BX CX DX SI DI BP SP and the instruction pointer; flags ZF SF CF OF.
 * Memory is 256 words, word-addressed. Data declared with DW or RESW is placed from address 0
 * in the order written; the stack starts at 256 and grows down. Code is held apart from data.
 *
 *   label:  DW 7, 3, 'A', 0x10      words of data
 *   label:  RESW 4                  four zero words
 *   label:  MOV AX, [label+SI]      an instruction, optionally labelled
 *
 * Operands: a register, an immediate (12, -3, 0x1F, 0b101, 'A', or a label's address) or memory
 * in brackets: [label], [label+3], [BX], [BX+SI], [label+SI+2]. Only BX, SI, DI and BP may appear
 * inside brackets. At most one operand may be in memory.
 *
 * Every instruction costs cycles from a table (see CYCLES), so programs can be compared by
 * instruction count, cycle count and CPI.
 */

export const REGISTERS = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP'] as const;
export type Reg = (typeof REGISTERS)[number];
export type Flag = 'ZF' | 'SF' | 'CF' | 'OF';
const INDEX_REGS = new Set(['BX', 'SI', 'DI', 'BP']);
export const MEMORY_WORDS = 256;
const MAX_STEPS = 20000;

export type Operand =
  | { kind: 'reg'; reg: Reg }
  | { kind: 'imm'; value: number; label?: string }
  | { kind: 'mem'; regs: Reg[]; offset: number; text: string };

export interface Instr {
  op: string;
  args: Operand[];
  /** For jumps and calls: the code label. */
  target?: string;
  line: number;
  text: string;
}

export interface CpuProgram {
  code: Instr[];
  codeLabels: Record<string, number>;
  dataLabels: Record<string, { addr: number; size: number }>;
  memory: number[];
  dataEnd: number;
}

export interface CpuError {
  line: number;
  message: string;
}

/** Cycles per instruction class; an operand in memory adds `memory`. */
export interface CycleTable {
  alu: number;
  mul: number;
  div: number;
  stack: number;
  call: number;
  branchTaken: number;
  branchNotTaken: number;
  memory: number;
}
export const CYCLES: CycleTable = { alu: 1, mul: 10, div: 20, stack: 2, call: 3, branchTaken: 2, branchNotTaken: 1, memory: 2 };

const ARITY: Record<string, number> = {
  MOV: 2, ADD: 2, SUB: 2, ADC: 2, SBB: 2, CMP: 2, AND: 2, OR: 2, XOR: 2, TEST: 2, SHL: 2, SHR: 2, SAR: 2,
  INC: 1, DEC: 1, NEG: 1, NOT: 1, MUL: 1, DIV: 1, PUSH: 1, POP: 1, OUT: 1,
  JMP: 1, JE: 1, JZ: 1, JNE: 1, JNZ: 1, JG: 1, JGE: 1, JL: 1, JLE: 1, JA: 1, JAE: 1, JB: 1, JBE: 1, JC: 1, JNC: 1, JS: 1, JNS: 1, LOOP: 1, CALL: 1,
  RET: 0, HLT: 0, NOP: 0,
};
const JUMPS = new Set(['JMP', 'JE', 'JZ', 'JNE', 'JNZ', 'JG', 'JGE', 'JL', 'JLE', 'JA', 'JAE', 'JB', 'JBE', 'JC', 'JNC', 'JS', 'JNS', 'LOOP', 'CALL']);

function parseNumber(t: string): number | null {
  const s = t.trim();
  if (/^'.'$/.test(s)) return s.charCodeAt(1);
  if (/^-?0x[0-9a-f]+$/i.test(s)) return parseInt(s.replace(/^(-?)0x/i, '$1'), 16);
  if (/^-?0b[01]+$/i.test(s)) return (s.startsWith('-') ? -1 : 1) * parseInt(s.replace(/^-?0b/i, ''), 2);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9a-f]+h$/i.test(s)) return parseInt(s.slice(0, -1), 16);
  return null;
}

const w16 = (x: number) => ((x % 0x10000) + 0x10000) % 0x10000;
const signed = (x: number) => (x & 0x8000 ? x - 0x10000 : x);

/** Two passes: collect labels and data, then parse instructions. */
export function assemble(source: string): { ok: true; program: CpuProgram } | { ok: false; error: CpuError } {
  const lines = source.split(/\r?\n/);
  const memory = Array<number>(MEMORY_WORDS).fill(0);
  const dataLabels: CpuProgram['dataLabels'] = {};
  const codeLabels: Record<string, number> = {};
  const pending: Array<{ line: number; text: string }> = [];
  let addr = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let text = lines[i].replace(/;.*$/, '').trim();
    if (!text || /^\.(data|code|text)\b/i.test(text)) continue;
    let label: string | undefined;
    const m = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(text) ?? /^([A-Za-z_]\w*)\s+((?:DW|RESW)\b.*)$/i.exec(text);
    if (m) {
      label = m[1];
      text = m[2].trim();
    }
    const data = /^(DW|RESW)\b\s*(.*)$/i.exec(text);
    if (data) {
      if (!label) return { ok: false, error: { line: lineNo, message: `${data[1].toUpperCase()} needs a label, for example nums: DW 1, 2, 3.` } };
      if (dataLabels[label] || codeLabels[label] !== undefined) return { ok: false, error: { line: lineNo, message: `The label ${label} is defined twice.` } };
      const words: number[] = [];
      if (data[1].toUpperCase() === 'RESW') {
        const n = parseNumber(data[2]);
        if (n === null || n < 1) return { ok: false, error: { line: lineNo, message: 'RESW needs a positive count, for example RESW 4.' } };
        for (let k = 0; k < n; k++) words.push(0);
      } else {
        for (const part of data[2].split(',')) {
          const n = parseNumber(part);
          if (n === null) return { ok: false, error: { line: lineNo, message: `"${part.trim()}" is not a number.` } };
          words.push(w16(n));
        }
      }
      if (addr + words.length > MEMORY_WORDS - 16) return { ok: false, error: { line: lineNo, message: 'Too much data: memory is 256 words and the stack needs room.' } };
      dataLabels[label] = { addr, size: words.length };
      words.forEach((v, k) => (memory[addr + k] = v));
      addr += words.length;
      continue;
    }
    if (label) {
      if (dataLabels[label] || codeLabels[label] !== undefined) return { ok: false, error: { line: lineNo, message: `The label ${label} is defined twice.` } };
      codeLabels[label] = pending.length;
    }
    if (text) pending.push({ line: lineNo, text });
  }

  const operand = (raw: string, line: number): Operand | CpuError => {
    const t = raw.trim();
    const up = t.toUpperCase();
    if ((REGISTERS as readonly string[]).includes(up)) return { kind: 'reg', reg: up as Reg };
    if (t.startsWith('[')) {
      if (!t.endsWith(']')) return { line, message: `Missing ] in ${t}.` };
      const inner = t.slice(1, -1).replace(/\s+/g, '');
      const terms = inner.match(/[+-]?[^+-]+/g) ?? [];
      const regs: Reg[] = [];
      let offset = 0;
      for (const term of terms) {
        const sign = term.startsWith('-') ? -1 : 1;
        const body = term.replace(/^[+-]/, '');
        const reg = body.toUpperCase();
        if ((REGISTERS as readonly string[]).includes(reg)) {
          if (!INDEX_REGS.has(reg)) return { line, message: `Only BX, SI, DI and BP can be used inside brackets, not ${reg}.` };
          if (sign < 0) return { line, message: 'A register inside brackets cannot be subtracted.' };
          regs.push(reg as Reg);
          continue;
        }
        const n = parseNumber(body);
        if (n !== null) {
          offset += sign * n;
          continue;
        }
        if (dataLabels[body]) {
          offset += sign * dataLabels[body].addr;
          continue;
        }
        return { line, message: `Unknown name ${body} inside brackets. Declare it with DW first.` };
      }
      return { kind: 'mem', regs, offset, text: t };
    }
    const n = parseNumber(t);
    if (n !== null) return { kind: 'imm', value: w16(n) };
    if (dataLabels[t]) return { kind: 'imm', value: dataLabels[t].addr, label: t };
    if (codeLabels[t] !== undefined) return { kind: 'imm', value: codeLabels[t], label: t };
    return { line, message: `I do not understand the operand "${t}".` };
  };

  const code: Instr[] = [];
  for (const { line, text } of pending) {
    const sp = text.search(/\s/);
    const op = (sp < 0 ? text : text.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
    if (!(op in ARITY)) return { ok: false, error: { line, message: `Unknown instruction ${op}.` } };
    const rawArgs = rest ? rest.split(/,(?![^[]*\])/).map((a) => a.trim()) : [];
    if (rawArgs.length !== ARITY[op]) return { ok: false, error: { line, message: `${op} takes ${ARITY[op]} operand${ARITY[op] === 1 ? '' : 's'}.` } };
    if (JUMPS.has(op)) {
      const target = rawArgs[0];
      if (codeLabels[target] === undefined) return { ok: false, error: { line, message: `There is no code label called ${target}.` } };
      code.push({ op, args: [], target, line, text });
      continue;
    }
    const args: Operand[] = [];
    for (const a of rawArgs) {
      const o = operand(a, line);
      if ('message' in o) return { ok: false, error: o };
      args.push(o);
    }
    if (args.filter((a) => a.kind === 'mem').length > 1) return { ok: false, error: { line, message: `${op} cannot have two memory operands. Load one into a register first.` } };
    const dest = args[0];
    if (['MOV', 'ADD', 'SUB', 'ADC', 'SBB', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR', 'INC', 'DEC', 'NEG', 'NOT', 'POP'].includes(op) && dest?.kind === 'imm')
      return { ok: false, error: { line, message: `${op} cannot write to a constant. The first operand must be a register or memory.` } };
    if (['SHL', 'SHR', 'SAR'].includes(op) && args[1].kind === 'mem') return { ok: false, error: { line, message: `The shift count of ${op} must be a constant or a register.` } };
    code.push({ op, args, line, text });
  }
  if (!code.length) return { ok: false, error: { line: 1, message: 'There are no instructions to run.' } };
  return { ok: true, program: { code, codeLabels, dataLabels, memory, dataEnd: addr } };
}

export interface CpuStep {
  ip: number;
  line: number;
  text: string;
  regs: Record<Reg, number>;
  flags: Record<Flag, boolean>;
  /** Memory word written by this instruction, as [address, value]. */
  wrote?: [number, number];
  output?: number;
  cycles: number;
}

export interface CpuRun {
  ok: boolean;
  error?: string;
  errorLine?: number;
  halted: boolean;
  regs: Record<Reg, number>;
  flags: Record<Flag, boolean>;
  memory: number[];
  initialMemory: number[];
  dataLabels: Record<string, { addr: number; size: number }>;
  output: number[];
  instructions: number;
  cycles: number;
  trace: CpuStep[];
}

export interface CpuOptions {
  /** Overwrite data before running: label → words. */
  set?: Record<string, number[]>;
  regs?: Partial<Record<Reg, number>>;
  cycles?: Partial<CycleTable>;
  maxSteps?: number;
}

/** Assemble and run to HLT, an error or the step limit. */
export function runCpu(source: string, options: CpuOptions = {}): CpuRun {
  const empty = (): Record<Reg, number> => Object.fromEntries(REGISTERS.map((r) => [r, r === 'SP' ? MEMORY_WORDS : 0])) as Record<Reg, number>;
  const blank: CpuRun = { ok: false, halted: false, regs: empty(), flags: { ZF: false, SF: false, CF: false, OF: false }, memory: Array(MEMORY_WORDS).fill(0), initialMemory: Array(MEMORY_WORDS).fill(0), dataLabels: {}, output: [], instructions: 0, cycles: 0, trace: [] };
  const asm = assemble(source);
  if (!asm.ok) return { ...blank, error: `Line ${asm.error.line}: ${asm.error.message}`, errorLine: asm.error.line };
  const p = asm.program;
  const mem = [...p.memory];
  for (const [label, words] of Object.entries(options.set ?? {})) {
    const d = p.dataLabels[label];
    if (!d) return { ...blank, error: `The program has no data label called ${label}.` };
    if (words.length > d.size) return { ...blank, error: `${label} holds ${d.size} words; ${words.length} do not fit.` };
    words.forEach((v, k) => (mem[d.addr + k] = w16(v)));
  }
  const initialMemory = [...mem];
  const regs = empty();
  for (const [r, v] of Object.entries(options.regs ?? {})) regs[r as Reg] = w16(v as number);
  const flags: Record<Flag, boolean> = { ZF: false, SF: false, CF: false, OF: false };
  const table = { ...CYCLES, ...(options.cycles ?? {}) };
  const output: number[] = [];
  const trace: CpuStep[] = [];
  const limit = options.maxSteps ?? MAX_STEPS;
  let ip = 0;
  let cycles = 0;
  let halted = false;
  let error: string | undefined;
  let errorLine: number | undefined;

  const address = (o: Extract<Operand, { kind: 'mem' }>) => o.regs.reduce((a, r) => a + regs[r], o.offset);
  const read = (o: Operand): number => {
    if (o.kind === 'reg') return regs[o.reg];
    if (o.kind === 'imm') return o.value;
    const a = address(o);
    if (a < 0 || a >= MEMORY_WORDS) throw new Error(`Address ${a} in ${o.text} is outside memory (0 to 255).`);
    return mem[a];
  };
  let wrote: [number, number] | undefined;
  const write = (o: Operand, v: number) => {
    const val = w16(v);
    if (o.kind === 'reg') regs[o.reg] = val;
    else if (o.kind === 'mem') {
      const a = address(o);
      if (a < 0 || a >= MEMORY_WORDS) throw new Error(`Address ${a} in ${o.text} is outside memory (0 to 255).`);
      mem[a] = val;
      wrote = [a, val];
    }
  };
  const setZS = (v: number) => {
    flags.ZF = w16(v) === 0;
    flags.SF = (w16(v) & 0x8000) !== 0;
  };
  const push = (v: number) => {
    regs.SP -= 1;
    if (regs.SP < p.dataEnd) throw new Error('Stack overflow: the stack has grown into the data.');
    mem[regs.SP] = w16(v);
    wrote = [regs.SP, w16(v)];
  };
  const pop = (): number => {
    if (regs.SP >= MEMORY_WORDS) throw new Error('Stack underflow: POP or RET with nothing on the stack.');
    const v = mem[regs.SP];
    regs.SP += 1;
    return v;
  };

  let count = 0;
  while (!halted) {
    if (ip < 0 || ip >= p.code.length) {
      error = 'The program ran past its last instruction. End it with HLT.';
      break;
    }
    if (count >= limit) {
      error = `The program did not halt within ${limit} instructions. Is there a loop that never ends?`;
      break;
    }
    const ins = p.code[ip];
    wrote = undefined;
    let out: number | undefined;
    let next = ip + 1;
    const memOp = ins.args.some((a) => a.kind === 'mem');
    let cost = table.alu;
    try {
      const [a, b] = ins.args;
      const jumpIf = (cond: boolean) => {
        cost = cond ? table.branchTaken : table.branchNotTaken;
        if (cond) next = p.codeLabels[ins.target!];
      };
      switch (ins.op) {
        case 'MOV':
          write(a, read(b));
          break;
        case 'ADD':
        case 'ADC': {
          const x = read(a);
          const y = read(b);
          const carry = ins.op === 'ADC' && flags.CF ? 1 : 0;
          const r = x + y + carry;
          flags.CF = r > 0xffff;
          flags.OF = (signed(x) >= 0) === (signed(y) >= 0) && (signed(w16(r)) >= 0) !== (signed(x) >= 0);
          setZS(r);
          write(a, r);
          break;
        }
        case 'SUB':
        case 'SBB':
        case 'CMP': {
          const x = read(a);
          const y = read(b);
          const borrow = ins.op === 'SBB' && flags.CF ? 1 : 0;
          const r = x - y - borrow;
          flags.CF = r < 0;
          flags.OF = (signed(x) >= 0) !== (signed(y) >= 0) && (signed(w16(r)) >= 0) !== (signed(x) >= 0);
          setZS(r);
          if (ins.op !== 'CMP') write(a, r);
          break;
        }
        case 'INC':
        case 'DEC': {
          const x = read(a);
          const r = ins.op === 'INC' ? x + 1 : x - 1;
          flags.OF = ins.op === 'INC' ? x === 0x7fff : x === 0x8000;
          setZS(r);
          write(a, r);
          break;
        }
        case 'NEG': {
          const x = read(a);
          flags.CF = x !== 0;
          flags.OF = x === 0x8000;
          setZS(-x);
          write(a, -x);
          break;
        }
        case 'AND':
        case 'OR':
        case 'XOR':
        case 'TEST': {
          const x = read(a);
          const y = read(b);
          const r = ins.op === 'OR' ? x | y : ins.op === 'XOR' ? x ^ y : x & y;
          flags.CF = false;
          flags.OF = false;
          setZS(r);
          if (ins.op !== 'TEST') write(a, r);
          break;
        }
        case 'NOT':
          write(a, ~read(a));
          break;
        case 'SHL':
        case 'SHR':
        case 'SAR': {
          const x = read(a);
          const n = read(b) & 31;
          if (n === 0) break;
          let r: number;
          if (ins.op === 'SHL') {
            flags.CF = ((x << (n - 1)) & 0x8000) !== 0;
            r = x << n;
          } else if (ins.op === 'SHR') {
            flags.CF = ((x >> (n - 1)) & 1) !== 0;
            r = x >>> n;
          } else {
            flags.CF = ((signed(x) >> (n - 1)) & 1) !== 0;
            r = signed(x) >> n;
          }
          setZS(r);
          write(a, r);
          break;
        }
        case 'MUL': {
          cost = table.mul;
          const prod = regs.AX * read(a);
          regs.AX = w16(prod);
          regs.DX = w16(Math.floor(prod / 0x10000));
          flags.CF = flags.OF = regs.DX !== 0;
          break;
        }
        case 'DIV': {
          cost = table.div;
          const d = read(a);
          if (d === 0) throw new Error('Division by zero.');
          const dividend = regs.DX * 0x10000 + regs.AX;
          const q = Math.floor(dividend / d);
          if (q > 0xffff) throw new Error('Divide overflow: the quotient does not fit in AX. Set DX to 0 before DIV.');
          regs.AX = q;
          regs.DX = dividend % d;
          break;
        }
        case 'PUSH':
          cost = table.stack;
          push(read(a));
          break;
        case 'POP':
          cost = table.stack;
          write(a, pop());
          break;
        case 'OUT':
          out = read(a);
          output.push(out);
          break;
        case 'CALL':
          cost = table.call;
          push(ip + 1);
          next = p.codeLabels[ins.target!];
          break;
        case 'RET':
          cost = table.call;
          next = pop();
          break;
        case 'JMP':
          jumpIf(true);
          break;
        case 'JE':
        case 'JZ':
          jumpIf(flags.ZF);
          break;
        case 'JNE':
        case 'JNZ':
          jumpIf(!flags.ZF);
          break;
        case 'JG':
          jumpIf(!flags.ZF && flags.SF === flags.OF);
          break;
        case 'JGE':
          jumpIf(flags.SF === flags.OF);
          break;
        case 'JL':
          jumpIf(flags.SF !== flags.OF);
          break;
        case 'JLE':
          jumpIf(flags.ZF || flags.SF !== flags.OF);
          break;
        case 'JA':
          jumpIf(!flags.CF && !flags.ZF);
          break;
        case 'JAE':
        case 'JNC':
          jumpIf(!flags.CF);
          break;
        case 'JB':
        case 'JC':
          jumpIf(flags.CF);
          break;
        case 'JBE':
          jumpIf(flags.CF || flags.ZF);
          break;
        case 'JS':
          jumpIf(flags.SF);
          break;
        case 'JNS':
          jumpIf(!flags.SF);
          break;
        case 'LOOP':
          regs.CX = w16(regs.CX - 1);
          jumpIf(regs.CX !== 0);
          break;
        case 'HLT':
          halted = true;
          break;
        case 'NOP':
          break;
      }
    } catch (err) {
      error = `Line ${ins.line}: ${err instanceof Error ? err.message : String(err)}`;
      errorLine = ins.line;
      break;
    }
    if (memOp) cost += table.memory;
    cycles += cost;
    count++;
    trace.push({ ip, line: ins.line, text: ins.text, regs: { ...regs }, flags: { ...flags }, ...(wrote ? { wrote } : {}), ...(out !== undefined ? { output: out } : {}), cycles: cost });
    ip = next;
  }
  return { ok: !error && halted, error, errorLine, halted, regs: { ...regs }, flags: { ...flags }, memory: mem, initialMemory, dataLabels: p.dataLabels, output, instructions: count, cycles, trace };
}

/** Words of a data label after a run. */
export function dataOf(run: CpuRun, label: string): number[] | undefined {
  const d = run.dataLabels[label];
  return d ? run.memory.slice(d.addr, d.addr + d.size) : undefined;
}

export const signed16 = signed;
