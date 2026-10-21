/** Runs learner JavaScript off the main thread so an endless loop can be stopped by terminating the worker. */

import { executeJavaScript } from '@cslab/engine-code';

interface RunMessage {
  type: 'run';
  id: number;
  source: string;
  stdin: string;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<RunMessage | { type: 'warm' }>) => void) | null; postMessage: (m: unknown) => void };

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'warm') {
    ctx.postMessage({ type: 'status', state: 'ready' });
    return;
  }
  const result = executeJavaScript(msg.source, msg.stdin);
  ctx.postMessage({ type: 'result', id: msg.id, result });
};

ctx.postMessage({ type: 'status', state: 'ready' });
