/**
 * Check handlers for the digital logic engine. Registered under the "logic.*" namespace.
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { countGates, truthTable, type Bit, type Circuit, type GateType } from './circuit';
import { evaluateExpression } from './expression';

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

/**
 * logic.truthTable
 *   inputs:  ["A","B"]                   required input labels
 *   outputs: { "Y": "A & B", "C": "..." } expected expression per output label
 */
function checkTruthTable(circuit: Circuit, spec: CheckSpec): CheckResult {
  const wantInputs = ((spec.inputs as string[]) ?? []).map((s) => s.toUpperCase()).sort();
  const wantOutputs = (spec.outputs as Record<string, string>) ?? {};
  const table = truthTable(circuit);
  const haveInputs = table.inputs.map((s) => s.toUpperCase()).sort();
  const haveOutputs = table.outputs.map((s) => s.toUpperCase());

  const missingIn = wantInputs.filter((l) => !haveInputs.includes(l));
  const extraIn = haveInputs.filter((l) => !wantInputs.includes(l));
  if (missingIn.length || extraIn.length) {
    const parts: string[] = [];
    if (missingIn.length) parts.push(`add input switch${missingIn.length > 1 ? 'es' : ''} ${missingIn.join(', ')}`);
    if (extraIn.length) parts.push(`remove or relabel extra input${extraIn.length > 1 ? 's' : ''} ${extraIn.join(', ')}`);
    return fail(spec, `The circuit needs exactly these inputs: ${wantInputs.join(', ')}. Please ${parts.join(' and ')}.`);
  }

  const missingOut = Object.keys(wantOutputs)
    .map((l) => l.toUpperCase())
    .filter((l) => !haveOutputs.includes(l));
  if (missingOut.length) {
    return fail(spec, `Add an output lamp labelled ${missingOut.join(', ')}.`);
  }

  const failures: Array<{ inputs: Bit[]; output: string; expected: Bit; actual: Bit | undefined }> = [];
  for (const row of table.rows) {
    const env: Record<string, Bit> = {};
    table.inputs.forEach((label, i) => {
      env[label] = row.inputs[i];
    });
    for (const [outLabel, expr] of Object.entries(wantOutputs)) {
      const idx = haveOutputs.indexOf(outLabel.toUpperCase());
      const actual = row.outputs[idx];
      const expected = evaluateExpression(expr, env);
      if (actual !== expected) failures.push({ inputs: row.inputs, output: outLabel, expected, actual });
    }
  }

  if (failures.length === 0) {
    return pass(spec, `All ${table.rows.length} input combinations give the right output.`);
  }
  const first = failures[0];
  const assignment = table.inputs.map((l, i) => `${l}=${first.inputs[i]}`).join(', ');
  const actualText = first.actual === undefined ? 'nothing (an input is not connected)' : String(first.actual);
  return fail(
    spec,
    `${failures.length} of ${table.rows.length * Object.keys(wantOutputs).length} cases are wrong. For example when ${assignment}, ${first.output} should be ${first.expected} but is ${actualText}.`,
    failures,
  );
}

/** logic.allowedGates  gates: ["NAND"] */
function checkAllowedGates(circuit: Circuit, spec: CheckSpec): CheckResult {
  const allowed = new Set(((spec.gates as GateType[]) ?? []).concat(['INPUT', 'OUTPUT']));
  const bad = [...new Set(circuit.nodes.filter((n) => !allowed.has(n.type)).map((n) => n.type))];
  if (bad.length) return fail(spec, `Only ${(spec.gates as string[]).join(', ')} gates are allowed here. Remove the ${bad.join(', ')} gate${bad.length > 1 ? 's' : ''}.`);
  return pass(spec, 'Only the allowed gates are used.');
}

/** logic.maxGates  max: 4 */
function checkMaxGates(circuit: Circuit, spec: CheckSpec): CheckResult {
  const max = Number(spec.max);
  const n = countGates(circuit);
  if (n > max) return fail(spec, `You used ${n} gates; the target is at most ${max}. Look for a shared sub-expression.`);
  return pass(spec, `${n} gate${n === 1 ? '' : 's'} used, within the limit of ${max}.`);
}

/** logic.minGates  min: 1   (useful for "actually build something" beginner checks) */
function checkMinGates(circuit: Circuit, spec: CheckSpec): CheckResult {
  const min = Number(spec.min);
  const n = countGates(circuit);
  if (n < min) return fail(spec, `Place at least ${min} gate${min === 1 ? '' : 's'} from the palette.`);
  return pass(spec, `${n} gate${n === 1 ? '' : 's'} placed.`);
}

/** logic.allConnected  — every gate input has a wire */
function checkAllConnected(circuit: Circuit, spec: CheckSpec): CheckResult {
  const table = truthTable(circuit);
  const dangling = table.rows.some((r) => r.outputs.some((o) => o === undefined));
  if (dangling) return fail(spec, 'Some gate inputs or output lamps are not wired. Every input pin needs a wire.');
  return pass(spec, 'Every pin is connected.');
}

export function createLogicChecks(): CheckRegistry<Circuit> {
  return new CheckRegistry<Circuit>()
    .register('logic.truthTable', checkTruthTable)
    .register('logic.allowedGates', checkAllowedGates)
    .register('logic.maxGates', checkMaxGates)
    .register('logic.minGates', checkMinGates)
    .register('logic.allConnected', checkAllConnected);
}
