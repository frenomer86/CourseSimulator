/**
 * Every E7 lab must be solvable: a reference answer set per lab id passes every check and the
 * empty answer set does not. Labs from the first maths batch are verified in the browser and listed as legacy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createMathsChecks, type MathsState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');
const LEGACY = new Set(['discrete-mathematics', 'mathematics-for-computer-science', 'calculus', 'probability-and-statistics', 'numerical-methods-and-computation', 'fundamentals-of-computer-science']);

const SOLUTIONS: Record<string, Record<string, string>> = {
  "mobile-and-cellular-networks-i1-lte-peak-rate-from-resource-blocks": {"q1":"180","q2":"100","q3":"168","q4":"100.8","q5":"201.6","q6":"151.2"},
  'linear-algebra-for-data-science-i1-vectors-and-matrices': { q1: '12', q2: '5', q3: '0.7071', q4: '2 1; 4 3', q5: '1', q6: '3 -1; -5 2' },
  'biostatistics-b1-describe-the-readings': { q1: '126', q2: '124', q3: '59.67', q4: '7.72', q5: '2.92' },
  'data-communications-b1-nyquist-and-shannon': { q1: '12000', q2: '16', q3: '30', q4: '29902', q5: '800' },
  'financial-mathematics-b1-time-value-of-money': { q1: '1331', q2: '4286.69', q3: '12.68', q4: '10.24', q5: '888.49' },
  'signals-and-systems-i1-convolution-by-hand': { q1: '1 3 3 1', q2: '4', q3: '6', q4: '0.5^n', q5: '0.125', q6: 'yes' },
  'statistical-inference-b1-confidence-interval': { q1: '1.5', q2: '2.94', q3: '69.06', q4: '74.94', q5: '312' },
  'optimisation-for-machine-learning-b1-gradient-descent-steps': { q1: '2x - 6', q2: '1.5', q3: '2.25', q4: '2.625', q5: '3', q6: '0.5' },
  'control-systems-i1-first-order-step-response': { q1: '0.5', q2: '2', q3: '0.5', q4: '2', q5: '0.0909', q6: '-11' },
  'digital-signal-processing-i1-a-four-point-dft': { q1: '0', q2: '2', q3: '2000', q4: '2000', q5: '4000', q6: '8' },
  'epidemiology-and-public-health-data-b1-measures-of-frequency': { q1: '8', q2: '24', q3: '5', q4: '5', q5: '8' },
  'robot-kinematics-and-dynamics-i1-two-link-arm': { q1: 'cos(a) + cos(a+b)', q2: '1', q3: '1', q4: '2', q5: '2', q6: '90' },
  'telecommunication-systems-i1-erlang-traffic': { q1: '6', q2: '4.31', q3: '5.74', q4: '57.4' },
  'game-physics-and-simulation-b1-euler-steps': { q1: '5', q2: '2.55', q3: '3.775', q4: '5.102', q5: '1.0204' },
  'time-series-analysis-and-forecasting-b1-smoothing-and-naive-forecasts': { q1: '26', q2: '24', q3: '22', q4: '22', q5: '24', q6: '3.333' },
  'cryptography-and-network-security-i1-rsa-by-hand': { q1: '143', q2: '120', q3: '103', q4: '47', q5: '8' },
  'wireless-communication-i1-cellular-reuse-and-path-loss': { q1: '60', q2: '4.58', q3: '6000', q4: '105', q5: '91.53' },
  "real-time-systems-i1-rate-monotonic-by-hand": {"q1":"0.7083","q2":"0.7798","q3":"3","q4":"4","q5":"24"},
  "reinforcement-learning-i1-value-iteration-by-hand": {"q1":"8.1","q2":"10","q3":"0","q4":"9","q5":"9","q6":"5"},
  "phylogenetics-and-molecular-evolution-i1-upgma-and-jukes-cantor": {"q1":"A, B","q2":"1","q3":"6","q4":"3","q5":"5","q6":"0.3831"},
};

function allLabs(): LabSpec<MathsState>[] {
  const out: LabSpec<MathsState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<MathsState>;
      if (raw.engine === 'E7') out.push(raw);
    }
  }
  return out;
}

describe('E7 lab content', () => {
  const checks = createMathsChecks();
  const labs = allLabs();
  it('finds the maths labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(24);
  });
  for (const lab of labs) {
    if (LEGACY.has(lab.course)) continue;
    describe(lab.id, () => {
      it('has a reference answer set', () => {
        expect(SOLUTIONS[lab.id], `no reference answers for ${lab.id}`).toBeDefined();
      });
      it('does not pass with no answers', async () => {
        const r = await checks.run(lab, { answers: {}, tables: {} });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference answers', async () => {
        const r = await checks.run(lab, { answers: SOLUTIONS[lab.id], tables: {} });
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
