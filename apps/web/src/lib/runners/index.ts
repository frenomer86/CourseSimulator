/**
 * Code runners for the browser: one worker per language, restarted when a program runs past
 * its time limit. The Python runtime is loaded on demand and its status is shown in the UI.
 */

import { create } from 'zustand';
import { DEFAULT_TIMEOUT_MS, type CodeLanguage, type CodeRunner, type RunResult, type Runners } from '@cslab/engine-code';

export type RunnerState = 'idle' | 'loading' | 'ready' | 'error';

export const useRunnerStatus = create<Record<CodeLanguage, RunnerState>>()(() => ({ python: 'idle', javascript: 'idle' }));

type Pending = { resolve: (r: RunResult) => void; timer: ReturnType<typeof setTimeout> };

class WorkerRunner implements CodeRunner {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(
    readonly language: CodeLanguage,
    private readonly create: () => Worker,
  ) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.create();
    w.onmessage = (e: MessageEvent<{ type: 'status'; state: RunnerState } | { type: 'result'; id: number; result: RunResult }>) => {
      const m = e.data;
      if (m.type === 'status') {
        useRunnerStatus.setState({ [this.language]: m.state } as Partial<Record<CodeLanguage, RunnerState>>);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      p.resolve(m.result);
    };
    w.onerror = (ev) => {
      useRunnerStatus.setState({ [this.language]: 'error' } as Partial<Record<CodeLanguage, RunnerState>>);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve({ stdout: '', stderr: '', error: `The ${this.language} runner failed: ${ev.message || 'unknown error'}`, timeMs: 0 });
      }
    };
    this.worker = w;
    return w;
  }

  /** Starts loading the runtime so the first run is quick. */
  warm(): void {
    this.ensure().postMessage({ type: 'warm' });
  }

  run(source: string, stdin = '', timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
    const w = this.ensure();
    const id = ++this.seq;
    // Loading Python the first time can take a while on a slow connection; only the run itself is timed.
    const loading = useRunnerStatus.getState()[this.language] !== 'ready';
    const budget = loading ? timeoutMs + 120_000 : timeoutMs;
    return new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.worker?.terminate();
        this.worker = null;
        useRunnerStatus.setState({ [this.language]: 'idle' } as Partial<Record<CodeLanguage, RunnerState>>);
        for (const [otherId, p] of this.pending) {
          clearTimeout(p.timer);
          this.pending.delete(otherId);
          p.resolve({ stdout: '', stderr: '', error: 'Stopped: another program ran out of time.', timeMs: timeoutMs, timedOut: true });
        }
        resolve({ stdout: '', stderr: '', error: 'The program ran out of time.', timeMs: timeoutMs, timedOut: true });
      }, budget);
      this.pending.set(id, { resolve, timer });
      w.postMessage({ type: 'run', id, source, stdin });
    });
  }
}

const instances: Partial<Record<CodeLanguage, WorkerRunner>> = {};

function runnerFor(language: CodeLanguage): WorkerRunner {
  let r = instances[language];
  if (!r) {
    r =
      language === 'python'
        ? new WorkerRunner('python', () => new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module' }))
        : new WorkerRunner('javascript', () => new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module' }));
    instances[language] = r;
  }
  return r;
}

export const runners: Runners = { get: (language) => runnerFor(language) };

export function warmRunner(language: CodeLanguage): void {
  runnerFor(language).warm();
}
