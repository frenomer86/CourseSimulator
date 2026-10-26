/**
 * Web hosts other than localhost that the simulated curl and wget can reach inside the lab (the
 * forge's Pages sites, for example). Modules register a resolver; the first one that answers wins.
 */

import type { Ctx } from './shell.js';

export interface HostReply {
  status: number;
  body: string;
  server?: string;
  type?: string;
  location?: string;
}

export const NAMED_HOSTS: Array<(ctx: Ctx, host: string, port: number, path: string) => HostReply | null> = [];

export function namedHost(ctx: Ctx, host: string, port: number, path: string): HostReply | null {
  for (const p of NAMED_HOSTS) {
    const r = p(ctx, host, port, path);
    if (r) return r;
  }
  return null;
}

export const STATUS_TEXT: Record<number, string> = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** Other things that answer HTTP on a host port (kubectl port-forward registers here). Kept in this leaf module so registering at import time cannot hit a circular import. */
export const HTTP_PROVIDERS: Array<(ctx: Ctx, port: number, path: string) => { body: string; server: string; status?: number } | null> = [];
