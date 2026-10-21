/**
 * Runs learner JavaScript in the current realm with a console shim and line-based input.
 *
 * In the browser this is called inside a Web Worker (apps/web), which has no DOM and can be
 * terminated on a timeout. In tests it runs directly in Node. It is not a security boundary
 * against a hostile learner, only an isolation of their own program's output and errors.
 */

import type { RunResult } from './types.js';

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function executeJavaScript(source: string, stdin = ''): RunResult {
  const out: string[] = [];
  const err: string[] = [];
  const lines = stdin.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let cursor = 0;

  const log = (...args: unknown[]) => out.push(args.map(show).join(' '));
  const consoleShim = {
    log,
    info: log,
    debug: log,
    warn: (...args: unknown[]) => err.push(args.map(show).join(' ')),
    error: (...args: unknown[]) => err.push(args.map(show).join(' ')),
    table: log,
  };
  /** input() and prompt() hand back the next line of standard input, or null at the end. */
  const input = (promptText?: unknown) => {
    if (promptText !== undefined && promptText !== null && promptText !== '') out.push(show(promptText));
    return cursor < lines.length ? lines[cursor++] : null;
  };

  const started = Date.now();
  try {
    const fn = new Function('console', 'input', 'prompt', 'readLine', 'print', source);
    fn(consoleShim, input, input, input, log);
    return { stdout: out.join('\n'), stderr: err.join('\n'), error: null, timeMs: Date.now() - started };
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { stdout: out.join('\n'), stderr: err.join('\n'), error, timeMs: Date.now() - started };
  }
}
