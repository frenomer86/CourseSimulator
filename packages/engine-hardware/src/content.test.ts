/**
 * Every E8 lab must be solvable: a reference state (or sketch) per lab id passes every check,
 * and the starting state does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { buildSketchProgram, createHardwareChecks, parseBoardOutput, type HardwareConfig, type HardwareState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

type Solution = HardwareState | { sketch: string };

const SOLUTIONS: Record<string, Solution> = {
  "assembly-language-and-microprocessors-i1-sum-and-maximum": {"source":"nums:    DW 7, 3, 12, 5, 9\ncount:   DW 5\ntotal:   DW 0\nbiggest: DW 0\n\n        MOV SI, 0\n        MOV CX, [count]\n        MOV AX, 0\n        MOV BX, 0\nnext:   MOV DX, [nums+SI]\n        ADD AX, DX\n        CMP DX, BX\n        JLE skip\n        MOV BX, DX\nskip:   INC SI\n        LOOP next\n        MOV [total], AX\n        MOV [biggest], BX\n        HLT\n"},
  "computer-organization-and-architecture-i1-cycles-and-cpi": {"source":"nums:  DW 3, 1, 4, 1, 5, 9, 2, 6\ntotal: DW 0\n\n        MOV SI, 0\n        MOV CX, 8\n        MOV AX, 0\nnext:   ADD AX, [nums+SI]\n        INC SI\n        LOOP next\n        SHL AX, 3\n        MOV [total], AX\n        HLT\n","answers":{"q1":"51","q2":"162","q3":"3.18","q4":"40.5"}},
  'basic-electronics-b1-series-and-parallel': { answers: { req: '3k', itot: '4m', vr1: '4', ir3: '1.333m' }, measurements: [{ kind: 'V', a: 'n2', b: '0', reading: 8 }, { kind: 'I', component: 'R1', reading: 0.004 }] },
  'basic-electronics-b2-design-a-divider': { values: { R2: 500 }, answers: { i: '6m' }, measurements: [{ kind: 'V', a: 'n2', b: '0', reading: 3 }] },
  'basic-electronics-i1-light-an-led': { values: { R1: 220 }, answers: { p: '41m' }, measurements: [{ kind: 'I', component: 'D1', reading: 0.0136 }] },
  'basic-electronics-i2-kirchhoff-two-loops': { answers: { vb: '4', i1: '3m', i3: '1m', i2: '4m' }, measurements: [{ kind: 'V', a: 'b', b: '0', reading: 4 }] },
  'circuit-analysis-i1-thevenin-at-the-bench': { answers: { vth: '7.2', rth: '2.4k', in: '3m' }, measurements: [{ kind: 'V', a: 'b', b: '0', reading: 7.2 }, { kind: 'R', a: 'b', b: '0', reading: 2400 }] },
  'computer-hardware-b1-assemble-a-desktop': { placements: { case: 'case1', mb: 'mb1', socket: 'cpu1', cooler: 'cool1', dimm: 'ram1', pcie16: 'gpu1', m2: 'ssd1', psu: 'psu1' } },
  'computer-hardware-b2-identify-connectors': { matches: { rj45: 'Wired Ethernet network cable', usbc: 'Reversible USB data, power and video', hdmi: 'Digital video and audio to a monitor or TV', sata: 'Hard disk or 2.5-inch SSD to the motherboard', m2: 'NVMe SSD mounted flat on the board', atx24: 'Main power from the PSU to the motherboard', pcie8: 'Extra power to a graphics card', jack: 'Analogue headphones or microphone', vga: 'Legacy analogue video to an old monitor or projector', rj11: 'Telephone line or DSL modem' } },
  'computer-hardware-i1-bios-for-an-install': { settings: { boot1: 'USB: SanDisk Installer', secureboot: 'Enabled', tpm: 'Enabled', sata: 'AHCI', svm: 'Enabled', fastboot: 'Disabled', csm: 'Disabled' } },
  'embedded-systems-b1-blink': { sketch: 'void setup() {\n  pinMode(13, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(13, HIGH);\n  delay(500);\n  digitalWrite(13, LOW);\n  delay(500);\n}' },
  'embedded-systems-b2-pwm-fade': { sketch: 'int brightness = 0;\nint step = 5;\nvoid setup() { pinMode(9, OUTPUT); }\nvoid loop() {\n  analogWrite(9, brightness);\n  brightness = brightness + step;\n  if (brightness <= 0 || brightness >= 255) { step = -step; }\n  delay(10);\n}' },
  'embedded-systems-i1-read-a-temperature': { sketch: 'void setup() { Serial.begin(9600); }\nvoid loop() {\n  int raw = analogRead(A0);\n  float volts = raw * 5.0 / 1023.0;\n  float temp = (volts - 0.5) * 100.0;\n  Serial.print("Temp: ");\n  Serial.print(temp);\n  Serial.println(" C");\n  delay(1000);\n}' },
  'internet-of-things-b1-button-and-led': { sketch: 'void setup() { pinMode(9, OUTPUT); pinMode(2, INPUT); }\nvoid loop() {\n  if (digitalRead(2) == HIGH) { digitalWrite(9, HIGH); } else { digitalWrite(9, LOW); }\n  delay(20);\n}' },
  'internet-of-things-i1-soil-moisture-monitor': { sketch: 'const int PUMP = 7;\nconst int THRESHOLD = 500;\nvoid setup() { Serial.begin(9600); pinMode(PUMP, OUTPUT); }\nvoid loop() {\n  int moisture = analogRead(A0);\n  if (moisture > THRESHOLD) { digitalWrite(PUMP, HIGH); } else { digitalWrite(PUMP, LOW); }\n  Serial.print("Moisture: ");\n  Serial.print(moisture);\n  Serial.println(moisture > THRESHOLD ? " pump ON" : " pump OFF");\n  delay(200);\n}' },
  'sensors-and-actuators-b1-servo-sweep': { sketch: '#include <Servo.h>\nServo myServo;\nvoid setup() { myServo.attach(9); }\nvoid loop() {\n  for (int angle = 0; angle <= 180; angle += 10) { myServo.write(angle); delay(100); }\n  for (int angle = 180; angle >= 0; angle -= 10) { myServo.write(angle); delay(100); }\n}' },
};

function runProgram(program: string): string {
  const out: string[] = [];
  const console = { log: (...a: unknown[]) => out.push(a.join(' ')), error: (...a: unknown[]) => out.push(a.join(' ')) };
  new Function('console', program)(console);
  return out.join('\n');
}

function allLabs(): LabSpec<HardwareState>[] {
  const out: LabSpec<HardwareState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<HardwareState>;
      if (raw.engine === 'E8') out.push(raw);
    }
  }
  return out;
}

describe('E8 lab content', () => {
  const checks = createHardwareChecks();
  const labs = allLabs();
  it('finds the hardware labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(14);
  });
  for (const lab of labs) {
    const config = lab.config as unknown as HardwareConfig;
    describe(lab.id, () => {
      it('has a bench mode, a solution and only hw.* checks', () => {
        expect(['circuit', 'assembly', 'match', 'bios', 'board', 'cpu']).toContain(config.mode);
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('hw.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const r = await checks.run(lab, { ...(lab.initialState ?? {}), source: config.starter });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference solution', async () => {
        const sol = SOLUTIONS[lab.id];
        let state: HardwareState;
        if ('sketch' in sol) {
          const program = buildSketchProgram(sol.sketch, config.board!);
          const run = parseBoardOutput(runProgram(program), '', null);
          state = { source: sol.sketch, run };
        } else state = { ...(lab.initialState ?? {}), ...sol };
        const r = await checks.run(lab, state);
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
