import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import {
  blinkStats,
  buildSketchProgram,
  createHardwareChecks,
  evalCircuitExpr,
  followsInput,
  formatQuantity,
  isLit,
  parseBoardOutput,
  parseNumberWithPrefix,
  placementProblem,
  resistanceBetween,
  solve,
  transpileArduino,
  validateBuild,
  type BoardConfig,
  type Build,
  type Circuit,
  type HardwareState,
} from './index.js';

const divider: Circuit = {
  components: [
    { id: 'V1', type: 'V', value: 12, nodes: ['n1', '0'] },
    { id: 'R1', type: 'R', value: 1000, nodes: ['n1', 'n2'] },
    { id: 'R2', type: 'R', value: 2000, nodes: ['n2', '0'] },
  ],
};

describe('circuit solver', () => {
  it('solves a voltage divider and reports currents and power', () => {
    const s = solve(divider);
    expect(s.ok).toBe(true);
    expect(s.voltages.n2).toBeCloseTo(8, 6);
    expect(s.currents.R1).toBeCloseTo(0.004, 9);
    expect(s.currents.V1).toBeCloseTo(0.004, 9); // supplied by the source
    expect(s.power.R2).toBeCloseTo(0.032, 9);
    expect(s.power.V1).toBeCloseTo(-0.048, 9);
    expect(evalCircuitExpr('V(n1,n2) * 1000', divider, s)).toBeCloseTo(4000, 6);
    expect(evalCircuitExpr('I(R2) + I(R1)', divider, s)).toBeCloseTo(0.008, 9);
    // With the source zeroed (shorted), n1 is at ground; n2 sees R1 in parallel with R2.
    expect(resistanceBetween(divider, 'n1', '0')).toBeCloseTo(0, 6);
    expect(resistanceBetween(divider, 'n2', '0')).toBeCloseTo(2000 * 1000 / 3000, 6);
    const series: Circuit = { components: [{ id: 'R1', type: 'R', value: 1000, nodes: ['n1', 'n2'] }, { id: 'R2', type: 'R', value: 2000, nodes: ['n2', '0'] }] };
    expect(resistanceBetween(series, 'n1', '0')).toBeCloseTo(3000, 6);
  });
  it('handles parallel branches, current sources and adjustable values', () => {
    const c: Circuit = {
      components: [
        { id: 'I1', type: 'I', value: 0.003, nodes: ['0', 'a'] },
        { id: 'R1', type: 'R', value: 1000, nodes: ['a', '0'] },
        { id: 'R2', type: 'R', value: 1000, nodes: ['a', '0'] },
      ],
    };
    const s = solve(c);
    expect(s.voltages.a).toBeCloseTo(1.5, 9);
    expect(solve(c, { R2: 3000 }).voltages.a).toBeCloseTo(2.25, 9);
  });
  it('switches an LED on and off and finds the diode state by iteration', () => {
    const c: Circuit = {
      components: [
        { id: 'V1', type: 'V', value: 5, nodes: ['p', '0'] },
        { id: 'S1', type: 'SW', nodes: ['p', 'a'], closed: false },
        { id: 'R1', type: 'R', value: 220, nodes: ['a', 'b'] },
        { id: 'D1', type: 'LED', nodes: ['b', '0'], vf: 2 },
      ],
    };
    const off = solve(c);
    expect(off.ok).toBe(true);
    expect(isLit(c.components[3], off)).toBe(false);
    const on = solve(c, {}, { S1: true });
    expect(on.currents.D1).toBeCloseTo(3 / 220, 6);
    expect(isLit(c.components[3], on)).toBe(true);
    const reversed: Circuit = { components: [{ id: 'V1', type: 'V', value: 5, nodes: ['p', '0'] }, { id: 'R1', type: 'R', value: 220, nodes: ['p', 'b'] }, { id: 'D1', type: 'D', nodes: ['0', 'b'] }] };
    const r = solve(reversed);
    expect(r.on.D1).toBe(false);
    expect(r.currents.R1).toBeCloseTo(0, 9);
  });
  it('explains unsolvable circuits and formats readings', () => {
    expect(solve({ components: [{ id: 'R1', type: 'R', value: 10, nodes: ['a', 'b'] }] }).error).toMatch(/ground/);
    expect(solve({ components: [{ id: 'V1', type: 'V', value: 5, nodes: ['a', '0'] }, { id: 'V2', type: 'V', value: 3, nodes: ['a', '0'] }] }).error).toMatch(/cannot be solved/);
    expect(formatQuantity(0.0047, 'A')).toBe('4.7 mA');
    expect(formatQuantity(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatQuantity(12, 'V')).toBe('12 V');
    expect(parseNumberWithPrefix('4.7k')).toBe(4700);
    expect(parseNumberWithPrefix('12 mA')).toBeCloseTo(0.012, 9);
  });
});

const build: Build = {
  parts: [
    { id: 'mb1', kind: 'motherboard', name: 'B650 board', specs: { socket: 'AM5', ddr: 'DDR5', formFactor: 'ATX', m2: 2 }, watts: 30 },
    { id: 'cpu1', kind: 'cpu', name: 'Ryzen 5 7600', specs: { socket: 'AM5' }, watts: 65 },
    { id: 'cpu2', kind: 'cpu', name: 'Core i5-12400', specs: { socket: 'LGA1700' }, watts: 65 },
    { id: 'ram1', kind: 'ram', name: '16 GB DDR5', specs: { ddr: 'DDR5', form: 'DIMM' }, watts: 5 },
    { id: 'ram2', kind: 'ram', name: '16 GB DDR4', specs: { ddr: 'DDR4', form: 'DIMM' }, watts: 5 },
    { id: 'gpu1', kind: 'gpu', name: 'RTX 4060', specs: { length: 240 }, watts: 115 },
    { id: 'psu1', kind: 'psu', name: '250 W supply', specs: { watts: 250, formFactor: 'ATX' } },
    { id: 'psu2', kind: 'psu', name: '650 W supply', specs: { watts: 650, formFactor: 'ATX' } },
    { id: 'case1', kind: 'case', name: 'Mid tower', specs: { formFactors: 'ATX,microATX', gpuClearance: 330, psuForm: 'ATX' } },
    { id: 'ssd1', kind: 'nvme', name: '1 TB NVMe', specs: {}, watts: 5 },
  ],
  slots: [
    { id: 'case', label: 'Case', accepts: ['case'], required: true },
    { id: 'mb', label: 'Motherboard tray', accepts: ['motherboard'], required: true },
    { id: 'socket', label: 'CPU socket', accepts: ['cpu'], required: true },
    { id: 'dimm1', label: 'DIMM slot A2', accepts: ['ram'], specs: { form: 'DIMM' }, required: true },
    { id: 'pcie1', label: 'PCIe x16 slot', accepts: ['gpu'], specs: { pcie: 'x16' } },
    { id: 'm2a', label: 'M.2 slot', accepts: ['nvme'], required: true },
    { id: 'psu', label: 'PSU bay', accepts: ['psu'], required: true },
  ],
};

describe('assembly rules', () => {
  it('rejects wrong sockets, memory generations and undersized supplies', () => {
    const placed = { case: 'case1', mb: 'mb1' };
    expect(placementProblem(build, placed, 'socket', 'cpu2')).toMatch(/LGA1700/);
    expect(placementProblem(build, placed, 'socket', 'cpu1')).toBeNull();
    expect(placementProblem(build, placed, 'dimm1', 'ram2')).toMatch(/DDR4/);
    expect(placementProblem(build, placed, 'pcie1', 'ram1')).toMatch(/does not fit/);
    const full = { ...placed, socket: 'cpu1', dimm1: 'ram1', pcie1: 'gpu1', m2a: 'ssd1', psu: 'psu1' };
    const v = validateBuild(build, full);
    expect(v.missing).toEqual([]);
    expect(v.problems.map((p) => p.message).join(' ')).toMatch(/250 W/);
    expect(validateBuild(build, { ...full, psu: 'psu2' }).problems).toEqual([]);
  });
});

function runProgram(program: string): string {
  const out: string[] = [];
  const console = { log: (...a: unknown[]) => out.push(a.join(' ')), error: (...a: unknown[]) => out.push(a.join(' ')) };
  new Function('console', program)(console);
  return out.join('\n');
}

describe('board simulator', () => {
  it('transpiles Arduino C to JavaScript', () => {
    const js = transpileArduino('#include <Servo.h>\nconst int LED = 13;\nint count = 0;\nunsigned long last = 0;\nint readings[10];\nvoid setup() {\n  pinMode(LED, OUTPUT);\n}\nint twice(int x) { return x * 2; }\nvoid loop() {\n  for (int i = 0; i < 3; i++) { count++; }\n}');
    expect(js).toContain('const LED = 13;');
    expect(js).toContain('let count = 0;');
    expect(js).toContain('let readings = new Array(10).fill(0);');
    expect(js).toContain('function setup() {');
    expect(js).toContain('function twice(x) {');
    expect(js).toContain('for (let i = 0;');
    expect(js).not.toContain('#include');
  });
  it('runs a blink sketch and measures the period', () => {
    const cfg: BoardConfig = { components: [{ kind: 'led', pin: 13 }], runMs: 5000 };
    const src = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); delay(500); }';
    const run = parseBoardOutput(runProgram(buildSketchProgram(src, cfg)), '', null);
    expect(run.error).toBeNull();
    const s = blinkStats(run, 13);
    expect(s.periodMs).toBeCloseTo(1000, 0);
    expect(s.toggles).toBeGreaterThanOrEqual(8);
  });
  it('reads a button on a schedule and follows it', () => {
    const cfg: BoardConfig = { components: [{ kind: 'led', pin: 9 }, { kind: 'button', pin: 2, schedule: [[0, 0], [1000, 1], [2000, 0], [3000, 1]] }], runMs: 4000 };
    const good = 'void setup() { pinMode(9, OUTPUT); pinMode(2, INPUT); }\nvoid loop() { if (digitalRead(2) == HIGH) digitalWrite(9, HIGH); else digitalWrite(9, LOW); delay(20); }';
    const run = parseBoardOutput(runProgram(buildSketchProgram(good, cfg)), '', null);
    expect(followsInput(run, 9, cfg.components[1]).ok).toBe(true);
    const bad = 'void setup() { pinMode(9, OUTPUT); }\nvoid loop() { digitalWrite(9, HIGH); delay(20); }';
    const run2 = parseBoardOutput(runProgram(buildSketchProgram(bad, cfg)), '', null);
    expect(followsInput(run2, 9, cfg.components[1]).ok).toBe(false);
  });
  it('reports sketch errors and serial output', () => {
    const cfg: BoardConfig = { components: [{ kind: 'tmp36', pin: 'A0', value: 153 }], runMs: 3000 };
    const src = 'void setup() { Serial.begin(9600); }\nvoid loop() { int raw = analogRead(A0); float v = raw * 5.0 / 1023.0; float c = (v - 0.5) * 100; Serial.print("Temp: "); Serial.println(c); delay(1000); }';
    const run = parseBoardOutput(runProgram(buildSketchProgram(src, cfg)), '', null);
    expect(run.serial).toMatch(/Temp: 24\.\d+/);
    expect(run.serial.split('\n').filter(Boolean).length).toBe(3);
    const broken = 'void setup() { }\nvoid loop() { undefinedThing(); }';
    expect(parseBoardOutput(runProgram(buildSketchProgram(broken, cfg)), '', null).error).toMatch(/undefinedThing/);
  });
});

describe('hw.* checks', () => {
  const checks = createHardwareChecks();
  const lab = (config: Record<string, unknown>, specs: LabSpec['checks']): LabSpec<HardwareState> => ({ id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E8', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1, config });
  it('judges circuit quantities, answers and measurements', async () => {
    const spec = lab(
      { mode: 'circuit', circuit: divider },
      [
        { type: 'hw.expr', label: 'Vout', expr: 'V(n2)', expected: 8, unit: 'V' },
        { type: 'hw.answer', label: 'current', id: 'q1', expected: 'I(R1)', unit: 'A' },
        { type: 'hw.measured', label: 'measured', kind: 'V', a: 'n2', b: '0' },
      ],
    );
    const good = await checks.run(spec, { answers: { q1: '4 mA' }, measurements: [{ kind: 'V', a: '0', b: 'n2', reading: 8 }] });
    expect(good.checks.map((c) => c.passed)).toEqual([true, true, true]);
    const bad = await checks.run(spec, { values: { R2: 1000 }, answers: { q1: '8' }, measurements: [] });
    expect(bad.checks[0].message).toMatch(/6 V/);
    expect(bad.checks.map((c) => c.passed)).toEqual([false, false, false]);
  });
  it('judges builds, matches, settings and board runs', async () => {
    const cfg: BoardConfig = { components: [{ kind: 'led', pin: 13 }], runMs: 3000 };
    const src = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250); }';
    const run = parseBoardOutput(runProgram(buildSketchProgram(src, cfg)), '', null);
    const spec = lab(
      { mode: 'board', board: cfg, build, match: { items: [{ id: 'a', name: 'RJ-45', answer: 'ethernet' }], options: ['ethernet', 'usb'] }, bios: { settings: [{ key: 'boot', label: 'Boot order', options: ['USB', 'SSD'] }] } },
      [
        { type: 'hw.blink', label: 'blink', pin: 13, periodMs: 500 },
        { type: 'hw.buildValid', label: 'build' },
        { type: 'hw.matches', label: 'match' },
        { type: 'hw.setting', label: 'boot', key: 'boot', value: 'USB' },
        { type: 'hw.source', label: 'uses delay', contains: 'delay(' },
      ],
    );
    const r = await checks.run(spec, { source: src, run, placements: { case: 'case1', mb: 'mb1', socket: 'cpu1', dimm1: 'ram1', m2a: 'ssd1', psu: 'psu2' }, matches: { a: 'ethernet' }, settings: { boot: 'USB' } });
    expect(r.checks.filter((c) => !c.passed).map((c) => c.message)).toEqual([]);
    const r2 = await checks.run(spec, { source: src, run, placements: { case: 'case1' }, matches: { a: 'usb' }, settings: {} });
    expect(r2.checks.slice(1, 4).map((c) => c.passed)).toEqual([false, false, false]);
  });
});
