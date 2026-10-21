/**
 * Test harnesses: code appended to the learner's program so the checker can call their
 * functions, or run an assertion script, and read the outcome back from standard output.
 */

import type { CodeLanguage } from './types.js';

export const MARKER = '__CSLAB_RESULT__';

export interface FunctionCase {
  args: unknown[];
  expected: unknown;
}

export type CaseOutcome = { value: unknown } | { error: string };

function pythonLiteral(json: string): string {
  // A raw triple-quoted string is safe as long as the JSON does not contain ''' (it cannot, JSON escapes quotes inside strings only as \"; a lone ''' would need three quote characters in a row, which JSON strings can contain). Guard anyway.
  return json.replace(/'''/g, "''\\'");
}

/** Appends a harness that calls `name(*args)` for each case and prints the outcomes as JSON after MARKER. */
export function functionHarness(language: CodeLanguage, name: string, cases: FunctionCase[]): string {
  const json = JSON.stringify(cases.map((c) => c.args));
  if (language === 'python') {
    return `

import json as __json
__cases = __json.loads(r'''${pythonLiteral(json)}''')
__out = []
for __c in __cases:
    try:
        __out.append({"value": ${name}(*__c)})
    except Exception as __e:
        __out.append({"error": type(__e).__name__ + ": " + str(__e)})
print("${MARKER}" + __json.dumps(__out, default=str))
`;
  }
  return `
;(function () {
  var __cases = ${json};
  var __out = __cases.map(function (c) {
    try { return { value: ${name}.apply(null, c) }; }
    catch (e) { return { error: (e && e.name ? e.name + ': ' + e.message : String(e)) }; }
  });
  console.log("${MARKER}" + JSON.stringify(__out, function (k, v) { return v === undefined ? null : v; }));
})();
`;
}

/** Appends an assertion script. It should raise/throw on failure and print nothing on success. */
export function scriptHarness(language: CodeLanguage, script: string): string {
  if (language === 'python') {
    return `

${script}
print("${MARKER}ok")
`;
  }
  return `
;(function () {
${script}
console.log("${MARKER}ok");
})();
`;
}

/** Splits the program's own output from the harness result. */
export function splitHarnessOutput(stdout: string): { userOutput: string; payload: string | null } {
  const i = stdout.lastIndexOf(MARKER);
  if (i < 0) return { userOutput: stdout, payload: null };
  const userOutput = stdout.slice(0, i).replace(/\n$/, '');
  const payload = stdout.slice(i + MARKER.length).split('\n')[0].trim();
  return { userOutput, payload };
}

export function parseOutcomes(payload: string | null): CaseOutcome[] | null {
  if (payload === null) return null;
  try {
    const v = JSON.parse(payload);
    return Array.isArray(v) ? (v as CaseOutcome[]) : null;
  } catch {
    return null;
  }
}
