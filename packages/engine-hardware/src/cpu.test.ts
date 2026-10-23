/** Every expected value below was worked out by hand from the documented semantics and cycle table. */
import { describe, expect, it } from 'vitest';
import { assemble, dataOf, runCpu } from './cpu.js';

export const SUM_MAX_DATA = 'nums:    DW 7, 3, 12, 5, 9\ncount:   DW 5\ntotal:   DW 0\nbiggest: DW 0\n';
export const SUM_MAX_SOLUTION = `${SUM_MAX_DATA}
        MOV SI, 0
        MOV CX, [count]
        MOV AX, 0          ; running total
        MOV BX, 0          ; biggest so far
next:   MOV DX, [nums+SI]
        ADD AX, DX
        CMP DX, BX
        JLE skip
        MOV BX, DX
skip:   INC SI
        LOOP next
        MOV [total], AX
        MOV [biggest], BX
        HLT
`;

export const COST_DATA = 'nums:  DW 3, 1, 4, 1, 5, 9, 2, 6\ntotal: DW 0\n';
export const COST_STARTER = `${COST_DATA}
        MOV SI, 0
        MOV CX, 8
next:   MOV AX, [nums+SI]
        MOV BX, 8
        MUL BX
        ADD [total], AX
        INC SI
        LOOP next
        HLT
`;
export const COST_FAST = `${COST_DATA}
        MOV SI, 0
        MOV CX, 8
        MOV AX, 0
next:   ADD AX, [nums+SI]
        INC SI
        LOOP next
        SHL AX, 3
        MOV [total], AX
        HLT
`;

describe('flags', () => {
  it('sets carry and zero on unsigned wrap-around', () => {
    const r = runCpu('MOV AX, 0xFFFF\nADD AX, 1\nHLT');
    expect(r.regs.AX).toBe(0);
    expect(r.flags).toEqual({ ZF: true, SF: false, CF: true, OF: false });
  });
  it('sets sign and overflow on signed overflow', () => {
    const r = runCpu('MOV AX, 0x7FFF\nADD AX, 1\nHLT');
    expect(r.regs.AX).toBe(0x8000);
    expect(r.flags).toEqual({ ZF: false, SF: true, CF: false, OF: true });
  });
  it('compares like subtraction without storing', () => {
    const r = runCpu('MOV AX, 3\nCMP AX, 5\nHLT');
    expect(r.regs.AX).toBe(3);
    expect(r.flags).toEqual({ ZF: false, SF: true, CF: true, OF: false });
  });
});

describe('jumps', () => {
  it('JG compares signed and JA unsigned', () => {
    const src = (j: string) => `MOV AX, -1\nCMP AX, 1\n${j} yes\nMOV BX, 1\nHLT\nyes: MOV BX, 2\nHLT`;
    expect(runCpu(src('JG')).regs.BX).toBe(1);
    expect(runCpu(src('JA')).regs.BX).toBe(2);
  });
  it('LOOP counts CX down', () => {
    const r = runCpu('MOV CX, 4\nMOV AX, 0\nagain: ADD AX, 10\nLOOP again\nHLT');
    expect(r.regs).toMatchObject({ AX: 40, CX: 0 });
  });
});

describe('stack, calls and division', () => {
  it('CALL and RET use the stack and leave SP where it started', () => {
    const r = runCpu('MOV AX, 5\nCALL double\nOUT AX\nHLT\ndouble: ADD AX, AX\nRET');
    expect(r.output).toEqual([10]);
    expect(r.regs.SP).toBe(256);
  });
  it('PUSH and POP reverse order', () => {
    const r = runCpu('PUSH 1\nPUSH 2\nPOP AX\nPOP BX\nHLT');
    expect(r.regs).toMatchObject({ AX: 2, BX: 1, SP: 256 });
  });
  it('DIV puts the quotient in AX and the remainder in DX', () => {
    const r = runCpu('MOV DX, 0\nMOV AX, 17\nMOV BX, 5\nDIV BX\nHLT');
    expect(r.regs).toMatchObject({ AX: 3, DX: 2 });
    expect(runCpu('MOV AX, 1\nMOV BX, 0\nDIV BX\nHLT').error).toMatch(/Division by zero/);
  });
});

describe('errors', () => {
  it('reports assembly and run-time mistakes with a line number', () => {
    expect(runCpu('MOV AX, 1').error).toMatch(/past its last instruction/);
    expect(runCpu('top: JMP top').error).toMatch(/did not halt/);
    expect(runCpu('FOO AX\nHLT').error).toMatch(/Line 1: Unknown instruction FOO/);
    expect(runCpu('a: DW 1\nb: DW 2\nMOV [a], [b]\nHLT').error).toMatch(/two memory operands/);
    expect(assemble('JMP nowhere\nHLT').ok).toBe(false);
  });
});

describe('lab programs', () => {
  it('sums an array and finds its maximum, for the lab data and for other data', () => {
    const r = runCpu(SUM_MAX_SOLUTION);
    expect(r.ok).toBe(true);
    expect(dataOf(r, 'total')).toEqual([36]);
    expect(dataOf(r, 'biggest')).toEqual([12]);
    const other = runCpu(SUM_MAX_SOLUTION, { set: { nums: [20, 4, 20, 1], count: [4] } });
    expect(dataOf(other, 'total')).toEqual([45]);
    expect(dataOf(other, 'biggest')).toEqual([20]);
  });
  it('counts instructions and cycles with the documented table', () => {
    const slow = runCpu(COST_STARTER);
    expect(dataOf(slow, 'total')).toEqual([248]);
    expect(slow).toMatchObject({ instructions: 51, cycles: 162 });
    const fast = runCpu(COST_FAST);
    expect(dataOf(fast, 'total')).toEqual([248]);
    expect(fast).toMatchObject({ instructions: 30, cycles: 55 });
  });
});
