/**
 * An Arduino-style board simulator. The learner writes a sketch in Arduino C (a subset, translated
 * to JavaScript) or directly in JavaScript; the harness runs setup() and loop() with a virtual clock,
 * virtual inputs that change on a schedule, and records every pin write and serial line.
 * The program it builds runs in the ordinary JavaScript code runner.
 */

export type ComponentKind = 'led' | 'rgb-led' | 'button' | 'pot' | 'ldr' | 'tmp36' | 'dht' | 'buzzer' | 'servo' | 'relay' | 'ultrasonic' | 'motor';

export interface BoardComponent {
  kind: ComponentKind;
  /** Digital pin number or analog pin name (A0..A5). */
  pin: number | string;
  label?: string;
  /** Inputs: the value over time, as [ms, value] steps (value 0/1 for buttons, 0..1023 for analog). */
  schedule?: Array<[number, number]>;
  /** Inputs: a constant value when there is no schedule. */
  value?: number;
  /** Sensors with two readings (DHT): temperature and humidity. */
  temperature?: number;
  humidity?: number;
  /** Ultrasonic: distance in cm over time. */
  trigPin?: number;
}

export interface BoardConfig {
  board?: 'uno' | 'nano' | 'esp32';
  components: BoardComponent[];
  /** How long the virtual run lasts, in ms of board time. */
  runMs?: number;
  maxLoops?: number;
  language?: 'arduino' | 'javascript';
}

export interface TraceEvent {
  t: number;
  pin: string;
  ev: 'mode' | 'digital' | 'pwm' | 'tone' | 'servo';
  v: number | string;
}

export interface BoardRun {
  trace: TraceEvent[];
  serial: string;
  loops: number;
  endMs: number;
  error: string | null;
}

export interface BoardState {
  source: string;
  run?: BoardRun;
}

export const MARKER = '__CSLAB_BOARD__';

/** Translates common Arduino C constructs to JavaScript. Heuristic, meant for teaching sketches. */
export function transpileArduino(src: string): string {
  let s = src;
  s = s.replace(/^\s*#include\b.*$/gm, '');
  s = s.replace(/^\s*#define\s+(\w+)\s+(.+)$/gm, 'const $1 = $2;');
  // Library objects: Servo myServo;  DHT dht(2, DHT11);  LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
  s = s.replace(/^(\s*)(Servo|DHT|LiquidCrystal|SoftwareSerial|Stepper)\s+(\w+)\s*(?:\(([^)]*)\))?\s*;/gm, '$1let $3 = new $2($4);');
  // Function definitions: type name(type a, type b) {
  s = s.replace(/^(\s*)(?:void|int|long|unsigned\s+long|unsigned\s+int|float|double|bool|boolean|char|byte|String|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm, (_, ind: string, name: string, params: string) => {
    const ps = params
      .split(',')
      .map((p) => p.trim().split(/\s+/).pop()?.replace(/^\*/, '') ?? '')
      .filter(Boolean)
      .join(', ');
    return `${ind}function ${name}(${ps}) {`;
  });
  // Arrays: int readings[10]; int xs[] = {1,2,3};
  s = s.replace(/\b(?:const\s+)?(?:int|long|float|double|bool|boolean|char|byte|unsigned\s+long|unsigned\s+int|uint8_t|uint16_t|uint32_t|String)\s+(\w+)\s*\[\s*(\d+)\s*\]\s*;/g, 'let $1 = new Array($2).fill(0);');
  s = s.replace(/\b(?:const\s+)?(?:int|long|float|double|bool|boolean|char|byte|unsigned\s+long|unsigned\s+int|uint8_t|uint16_t|uint32_t|String)\s+(\w+)\s*\[\s*\]\s*=\s*\{([^}]*)\}\s*;/g, 'let $1 = [$2];');
  // Variable declarations with or without const.
  s = s.replace(/\bconst\s+(?:int|long|float|double|bool|boolean|char|byte|unsigned\s+long|unsigned\s+int|uint8_t|uint16_t|uint32_t|String)\s+/g, 'const ');
  s = s.replace(/\b(?:static\s+)?(?:volatile\s+)?(?:int|long|float|double|bool|boolean|char|byte|unsigned\s+long|unsigned\s+int|uint8_t|uint16_t|uint32_t|String)\s+(?=\w+\s*(?:=|;|,))/g, 'let ');
  s = s.replace(/\bfor\s*\(\s*(?:int|long|unsigned\s+int|uint8_t|byte)\s+/g, 'for (let ');
  // Type casts and string helpers.
  s = s.replace(/\((?:int|long)\)\s*/g, 'Math.trunc');
  s = s.replace(/\((?:float|double)\)\s*/g, '');
  s = s.replace(/\bString\(([^)]*)\)/g, 'String($1)');
  s = s.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
  s = s.replace(/\bNULL\b/g, 'null');
  return s;
}

/** Builds the JavaScript program for the runner: harness + sketch + driver. */
export function buildSketchProgram(source: string, cfg: BoardConfig): string {
  const sketch = (cfg.language ?? 'arduino') === 'arduino' ? transpileArduino(source) : source;
  const runMs = cfg.runMs ?? 5000;
  const maxLoops = cfg.maxLoops ?? 5000;
  const inputs = cfg.components.map((c) => ({ kind: c.kind, pin: String(c.pin), schedule: c.schedule ?? null, value: c.value ?? defaultValue(c), temperature: c.temperature ?? 25, humidity: c.humidity ?? 60, trigPin: c.trigPin ?? null }));
  const harness = `
const __B = { t: 0, trace: [], serial: [], loops: 0, inputs: ${JSON.stringify(inputs)}, runMs: ${runMs}, servo: {} };
const __STOP = { stop: true };
const HIGH = 1, LOW = 0, INPUT = 'INPUT', OUTPUT = 'OUTPUT', INPUT_PULLUP = 'INPUT_PULLUP', LED_BUILTIN = 13;
const A0 = 'A0', A1 = 'A1', A2 = 'A2', A3 = 'A3', A4 = 'A4', A5 = 'A5';
const DHT11 = 11, DHT22 = 22, CHANGE = 'CHANGE', RISING = 'RISING', FALLING = 'FALLING';
function __pin(p) { return String(p); }
function __inputAt(pin) {
  const inp = __B.inputs.find((i) => i.pin === pin || ('A' + i.pin) === pin);
  if (!inp) return 0;
  let v = inp.value;
  if (inp.schedule) for (const [t, val] of inp.schedule) if (__B.t >= t) v = val;
  if (inp.kind === 'button') return v ? 1 : 0;
  return v;
}
function __record(pin, ev, v) { __B.trace.push({ t: __B.t, pin, ev, v }); if (__B.trace.length > 20000) throw __STOP; }
function pinMode(p, m) { __record(__pin(p), 'mode', m); }
function digitalWrite(p, v) { __record(__pin(p), 'digital', v ? 1 : 0); }
function analogWrite(p, v) { __record(__pin(p), 'pwm', Math.max(0, Math.min(255, Math.round(v)))); }
function digitalRead(p) { const pin = __pin(p); const inp = __B.inputs.find((i) => i.pin === pin); if (!inp) return 0; const v = __inputAt(pin); const pulled = __B.trace.some((e) => e.pin === pin && e.ev === 'mode' && e.v === 'INPUT_PULLUP'); return inp.kind === 'button' ? (pulled ? (v ? 0 : 1) : v) : (v >= 512 ? 1 : 0); }
function analogRead(p) { const v = __inputAt(__pin(p)); return Math.max(0, Math.min(1023, Math.round(v))); }
function __advance(ms) { __B.t += ms; if (__B.t > __B.runMs) throw __STOP; }
function delay(ms) { __advance(Math.max(0, Number(ms) || 0)); }
function delayMicroseconds(us) { __advance((Number(us) || 0) / 1000); }
function millis() { return Math.floor(__B.t); }
function micros() { return Math.floor(__B.t * 1000); }
function map(x, a, b, c, d) { return Math.trunc((x - a) * (d - c) / (b - a) + c); }
function constrain(x, a, b) { return Math.min(Math.max(x, a), b); }
function random(a, b) { if (b === undefined) { b = a; a = 0; } return Math.floor(a + Math.random() * (b - a)); }
function randomSeed() {}
function abs(x) { return Math.abs(x); }
function min(a, b) { return Math.min(a, b); }
function max(a, b) { return Math.max(a, b); }
function sqrt(x) { return Math.sqrt(x); }
function pow(a, b) { return Math.pow(a, b); }
function round(x) { return Math.round(x); }
function tone(p, f, d) { __record(__pin(p), 'tone', Number(f) || 0); if (d) __advance(d); }
function noTone(p) { __record(__pin(p), 'tone', 0); }
function pulseIn(p) { const inp = __B.inputs.find((i) => i.kind === 'ultrasonic'); return inp ? Math.round(__inputAt(inp.pin) * 58) : 0; }
function attachInterrupt() {} function detachInterrupt() {} function digitalPinToInterrupt(p) { return p; }
function isnan(x) { return Number.isNaN(x); }
const Serial = { begin() {}, end() {}, available() { return 0; }, read() { return -1; }, print(x) { __B.serial.push(String(x)); }, println(x) { __B.serial.push(String(x === undefined ? '' : x) + '\\n'); }, write(x) { __B.serial.push(String(x)); }, flush() {}, printf(f, ...a) { let i = 0; __B.serial.push(String(f).replace(/%[dfs]/g, () => String(a[i++]))); } };
class Servo { attach(p) { this.pin = __pin(p); } write(a) { __record(this.pin, 'servo', Math.max(0, Math.min(180, Math.round(a)))); } read() { return 0; } detach() {} }
class DHT { constructor(p, type) { this.pin = __pin(p); this.type = type; } begin() {} readTemperature() { const i = __B.inputs.find((x) => x.pin === this.pin); return i ? i.temperature : 25; } readHumidity() { const i = __B.inputs.find((x) => x.pin === this.pin); return i ? i.humidity : 60; } }
class LiquidCrystal { constructor() { this.lines = []; } begin() {} clear() { this.lines = []; } setCursor(c, r) { this.row = r; this.col = c; } print(x) { __B.serial.push('[LCD] ' + String(x) + '\\n'); } }
const lcd = new LiquidCrystal();
`;
  const driver = `
;(function () {
  try {
    if (typeof setup !== 'function') throw new Error('The sketch needs a setup() function.');
    if (typeof loop !== 'function') throw new Error('The sketch needs a loop() function.');
    setup();
    for (let k = 0; k < ${maxLoops}; k++) {
      __B.loops = k + 1;
      loop();
      __advance(0.2);
    }
  } catch (e) {
    if (e !== __STOP) { console.log(${JSON.stringify(MARKER)} + JSON.stringify({ trace: __B.trace, serial: __B.serial.join(''), loops: __B.loops, endMs: __B.t, error: String(e && e.message ? e.message : e) })); return; }
  }
  console.log(${JSON.stringify(MARKER)} + JSON.stringify({ trace: __B.trace, serial: __B.serial.join(''), loops: __B.loops, endMs: __B.t, error: null }));
})();
`;
  return harness + '\n' + sketch + '\n' + driver;
}

function defaultValue(c: BoardComponent): number {
  switch (c.kind) {
    case 'button':
      return 0;
    case 'pot':
      return 512;
    case 'ldr':
      return 700;
    case 'tmp36':
      return 153; // 25 °C: 0.75 V on a 5 V reference
    case 'ultrasonic':
      return 50; // cm
    default:
      return 0;
  }
}

/** Extracts the run record from the runner's stdout. */
export function parseBoardOutput(stdout: string, stderr: string, error: string | null): BoardRun {
  const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
  if (!line) return { trace: [], serial: '', loops: 0, endMs: 0, error: error ?? stderr.trim() ?? 'The sketch produced no run record.' };
  try {
    const r = JSON.parse(line.slice(MARKER.length)) as BoardRun;
    return { ...r, error: r.error ?? error };
  } catch {
    return { trace: [], serial: '', loops: 0, endMs: 0, error: 'Could not read the run record.' };
  }
}

/* ------------------------------------------------------------------ trace analysis */

export function pinTimeline(run: BoardRun, pin: number | string, ev: TraceEvent['ev'] = 'digital'): Array<{ t: number; v: number }> {
  const p = String(pin);
  return run.trace.filter((e) => e.pin === p && e.ev === ev && typeof e.v === 'number').map((e) => ({ t: e.t, v: e.v as number }));
}

/** Digital level of a pin at a time (last write before t), or null if never written. */
export function levelAt(run: BoardRun, pin: number | string, t: number): number | null {
  let v: number | null = null;
  for (const e of pinTimeline(run, pin)) {
    if (e.t <= t) v = e.v;
    else break;
  }
  return v;
}

/** Rising-edge period statistics for a blinking pin. */
export function blinkStats(run: BoardRun, pin: number | string): { toggles: number; periodMs: number | null; onMs: number | null; dutyCycle: number | null } {
  const tl = pinTimeline(run, pin);
  const edges: Array<{ t: number; v: number }> = [];
  let last: number | null = null;
  for (const e of tl) {
    if (e.v !== last) edges.push(e);
    last = e.v;
  }
  const rises = edges.filter((e) => e.v === 1).map((e) => e.t);
  const periods: number[] = [];
  for (let i = 1; i < rises.length; i++) periods.push(rises[i] - rises[i - 1]);
  const ons: number[] = [];
  for (let i = 0; i < edges.length - 1; i++) if (edges[i].v === 1) ons.push(edges[i + 1].t - edges[i].t);
  const periodMs = periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : null;
  const onMs = ons.length ? ons.reduce((a, b) => a + b, 0) / ons.length : null;
  return { toggles: Math.max(0, edges.length - 1), periodMs, onMs, dutyCycle: periodMs && onMs !== null ? onMs / periodMs : null };
}

/** Does the output pin follow an input's schedule (sampled just before each input change and at the end)? */
export function followsInput(run: BoardRun, outPin: number | string, input: BoardComponent, inverted = false, settleMs = 60): { ok: boolean; detail: string } {
  const schedule = input.schedule ?? [[0, input.value ?? 0]];
  const samples: Array<{ t: number; expect: number }> = [];
  for (let i = 0; i < schedule.length; i++) {
    const [t, v] = schedule[i];
    const next = schedule[i + 1]?.[0] ?? run.endMs;
    const sampleAt = Math.min(next - 1, t + settleMs + (next - t) / 2);
    if (sampleAt <= t) continue;
    const want = (v ? 1 : 0) ^ (inverted ? 1 : 0);
    samples.push({ t: sampleAt, expect: want });
  }
  for (const s of samples) {
    const got = levelAt(run, outPin, s.t);
    if (got !== s.expect) return { ok: false, detail: `At ${Math.round(s.t)} ms the input was ${schedule.filter(([t]) => t <= s.t).pop()?.[1] ? 'pressed' : 'released'}, so pin ${String(outPin)} should be ${s.expect ? 'HIGH' : 'LOW'}, but it was ${got === null ? 'never written' : got ? 'HIGH' : 'LOW'}.` };
  }
  return { ok: samples.length > 0, detail: samples.length ? 'The output followed the input every time it changed.' : 'The input never changed.' };
}

export function pwmStats(run: BoardRun, pin: number | string): { writes: number; min: number; max: number; distinct: number } {
  const tl = pinTimeline(run, pin, 'pwm');
  if (!tl.length) return { writes: 0, min: 0, max: 0, distinct: 0 };
  const vs = tl.map((e) => e.v);
  return { writes: vs.length, min: Math.min(...vs), max: Math.max(...vs), distinct: new Set(vs).size };
}

export function servoAngles(run: BoardRun, pin: number | string): number[] {
  return pinTimeline(run, pin, 'servo').map((e) => e.v);
}
