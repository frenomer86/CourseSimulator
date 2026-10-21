/**
 * Runs learner Python with Pyodide (CPython compiled to WebAssembly) inside a worker.
 * The runtime (about 10 MB) is fetched from the jsDelivr CDN the first time a Python lab
 * is opened and then kept by the service worker, so later visits work offline.
 */

const PYODIDE_VERSION = '0.28.3';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyProxyDict {
  set(key: string, value: unknown): void;
  destroy(): void;
}
interface Pyodide {
  runPythonAsync(code: string, options?: { globals?: PyProxyDict }): Promise<unknown>;
  globals: { get(name: string): () => PyProxyDict };
  setStdin(options: { stdin: () => string | null; isatty?: boolean; autoEOF?: boolean }): void;
  setStdout(options: { batched: (line: string) => void }): void;
  setStderr(options: { batched: (line: string) => void }): void;
}

interface RunMessage {
  type: 'run';
  id: number;
  source: string;
  stdin: string;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<RunMessage | { type: 'warm' }>) => void) | null; postMessage: (m: unknown) => void };

let booting: Promise<Pyodide> | null = null;

function boot(): Promise<Pyodide> {
  if (!booting) {
    ctx.postMessage({ type: 'status', state: 'loading' });
    booting = (async () => {
      const mod = (await import(/* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`)) as { loadPyodide: (o: { indexURL: string }) => Promise<Pyodide> };
      const py = await mod.loadPyodide({ indexURL: PYODIDE_BASE });
      ctx.postMessage({ type: 'status', state: 'ready' });
      return py;
    })().catch((err) => {
      booting = null;
      ctx.postMessage({ type: 'status', state: 'error' });
      throw err;
    });
  }
  return booting;
}

/** Turns Pyodide's long traceback into "NameError: name 'x' is not defined (line 3)" plus a trimmed traceback. */
function summarise(err: unknown): { error: string; stderr: string } {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1] ?? 'Error';
  const where = [...text.matchAll(/File "<exec>", line (\d+)/g)].pop()?.[1];
  const trimmed = lines.filter((l) => !/pyodide|_pyodide|site-packages/.test(l)).join('\n');
  return { error: where ? `${last} (line ${where})` : last, stderr: trimmed };
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'warm') {
    void boot().catch(() => {});
    return;
  }
  let py: Pyodide;
  try {
    py = await boot();
  } catch (err) {
    ctx.postMessage({
      type: 'result',
      id: msg.id,
      result: { stdout: '', stderr: '', error: `Could not load Python: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`, timeMs: 0 },
    });
    return;
  }
  const out: string[] = [];
  const errLines: string[] = [];
  const input = msg.stdin.replace(/\r\n/g, '\n').split('\n');
  if (input.length && input[input.length - 1] === '') input.pop();
  py.setStdin({ stdin: () => (input.length ? `${input.shift()}\n` : null), isatty: false, autoEOF: true });
  py.setStdout({ batched: (line) => out.push(line) });
  py.setStderr({ batched: (line) => errLines.push(line) });
  const started = Date.now();
  let error: string | null = null;
  let stderr = '';
  // A fresh namespace per run, so nothing leaks between runs; __name__ makes the usual main guard work.
  const ns = py.globals.get('dict')();
  ns.set('__name__', '__main__');
  try {
    await py.runPythonAsync(msg.source, { globals: ns });
  } catch (err) {
    const s = summarise(err);
    error = s.error;
    stderr = s.stderr;
  } finally {
    ns.destroy();
  }
  ctx.postMessage({
    type: 'result',
    id: msg.id,
    result: { stdout: out.join('\n'), stderr: [errLines.join('\n'), stderr].filter(Boolean).join('\n'), error, timeMs: Date.now() - started },
  });
};
