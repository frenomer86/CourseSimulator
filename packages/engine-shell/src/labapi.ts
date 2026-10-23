/**
 * A small REST API that labs can stand up on the simulated network, so scripts can practise
 * calling APIs: tokens, JSON bodies, status codes, pagination and retries. Its state lives in
 * /var/lib/labapi/api.json; curl (Linux) and Invoke-RestMethod (Windows) both call handleApi().
 */

import { lookup, readFile, writeFile } from './fs.js';
import type { ShellSystem } from './system.js';

export const API_STATE = '/var/lib/labapi/api.json';
const ROOT = { user: 'root', groups: ['root'] };

type Item = Record<string, unknown>;

export interface ApiState {
  /** Host name the API answers to (localhost and 127.0.0.1 also work on the API's own port). */
  host: string;
  port: number;
  /** When set, every route except /api/health needs "Authorization: Bearer <token>". */
  token?: string;
  resources: Record<string, Item[]>;
  /** A field that must be unique per resource (POST of a duplicate gives 409), e.g. { users: 'username' }. */
  unique?: Record<string, string>;
  /** The next N requests fail with 503 Service Unavailable (to practise retries). */
  failNext?: number;
  /** Page size for list requests (?page=N); unset means lists are not paginated. */
  pageSize?: number;
  /** Every request so far: "METHOD /path STATUS". */
  log?: string[];
}

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiResponse {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: string;
}

const REASONS: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

export function loadApi(sys: ShellSystem): ApiState | null {
  const l = lookup(sys.fs, API_STATE, ROOT);
  if (!l || l.node.type !== 'file') return null;
  try {
    return JSON.parse(readFile(sys.fs, API_STATE, ROOT)) as ApiState;
  } catch {
    return null;
  }
}

/** The API, if a URL's host and port reach it. */
export function apiAt(sys: ShellSystem, host: string, port: number): ApiState | null {
  const api = loadApi(sys);
  if (!api || port !== api.port) return null;
  const h = host.toLowerCase();
  return h === api.host.toLowerCase() || h === 'localhost' || h === '127.0.0.1' || h === sys.hostname.toLowerCase() ? api : null;
}

/** A starting state for labs (resources are copied). */
export function apiState(spec: Partial<ApiState> & { resources: Record<string, Item[]> }): string {
  return JSON.stringify({ host: 'api.campus.lan', port: 8080, log: [], ...spec });
}

function json(status: number, data: unknown, extra: Record<string, string> = {}): ApiResponse {
  const body = status === 204 ? '' : JSON.stringify(data) + '\n';
  return { status, reason: REASONS[status] ?? 'OK', headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...extra }, body };
}

export function handleApi(sys: ShellSystem, req: ApiRequest): ApiResponse {
  const api = loadApi(sys)!;
  const res = route(api, req);
  const [path] = req.path.split('?');
  (api.log ??= []).push(`${req.method} ${path} ${res.status}`);
  writeFile(sys.fs, API_STATE, JSON.stringify(api), ROOT, sys.now);
  return res;
}

function route(api: ApiState, req: ApiRequest): ApiResponse {
  const header = (k: string) => Object.entries(req.headers).find(([h]) => h.toLowerCase() === k.toLowerCase())?.[1];
  const [rawPath, rawQuery = ''] = req.path.split('?');
  const query = Object.fromEntries(rawQuery.split('&').filter(Boolean).map((kv) => kv.split('=').map(decodeURIComponent) as [string, string]));
  const parts = rawPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  if (parts[0] !== 'api') return json(404, { error: `no route ${rawPath}`, hint: 'the API lives under /api/' });
  if (parts[1] === 'health') return json(200, { status: 'ok' });
  if (api.failNext && api.failNext > 0) {
    api.failNext--;
    return json(503, { error: 'service temporarily unavailable, retry shortly' }, { 'Retry-After': '1' });
  }
  if (api.token) {
    const auth = header('Authorization') ?? '';
    if (!auth) return json(401, { error: 'missing token: send Authorization: Bearer <token>' }, { 'WWW-Authenticate': 'Bearer' });
    if (auth !== `Bearer ${api.token}`) return json(401, { error: 'invalid token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  }
  if (!parts[1]) return json(200, { resources: Object.keys(api.resources) });
  const coll = api.resources[parts[1]];
  if (!coll) return json(404, { error: `unknown resource '${parts[1]}'`, resources: Object.keys(api.resources) });
  const parseBody = (): Item | ApiResponse => {
    const ct = header('Content-Type') ?? '';
    if (!/json/i.test(ct)) return json(415, { error: 'send JSON with Content-Type: application/json' });
    try {
      const v = JSON.parse(req.body ?? '');
      if (!v || typeof v !== 'object' || Array.isArray(v)) return json(400, { error: 'the body must be a JSON object' });
      return v as Item;
    } catch {
      return json(400, { error: 'the body is not valid JSON' });
    }
  };
  const idOf = (x: Item) => String(x.id);
  if (parts.length === 2) {
    if (method === 'GET') {
      const filters = Object.entries(query).filter(([k]) => k !== 'page' && k !== 'per_page');
      let items = coll.filter((x) => filters.every(([k, v]) => String(x[k] ?? '').toLowerCase() === v.toLowerCase()));
      if (api.pageSize) {
        const size = Number(query.per_page) || api.pageSize;
        const pages = Math.max(1, Math.ceil(items.length / size));
        const page = Math.min(Math.max(1, Number(query.page) || 1), pages);
        items = items.slice((page - 1) * size, page * size);
        return json(200, { items, page, total_pages: pages, next: page < pages ? `/api/${parts[1]}?page=${page + 1}` : null });
      }
      return json(200, items);
    }
    if (method === 'POST') {
      const b = parseBody();
      if ('status' in b && 'reason' in b) return b as ApiResponse;
      const item = b as Item;
      const uniq = api.unique?.[parts[1]];
      if (uniq && item[uniq] !== undefined && coll.some((x) => String(x[uniq]).toLowerCase() === String(item[uniq]).toLowerCase())) return json(409, { error: `${parts[1]} with ${uniq} '${item[uniq]}' already exists` });
      const id = coll.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
      const created = { id, ...item };
      coll.push(created);
      return json(201, created, { Location: `/api/${parts[1]}/${id}` });
    }
    return json(405, { error: `${method} is not allowed on /api/${parts[1]}` }, { Allow: 'GET, POST' });
  }
  const idx = coll.findIndex((x) => idOf(x) === parts[2]);
  if (idx === -1) return json(404, { error: `no ${parts[1]} with id ${parts[2]}` });
  if (method === 'GET') return json(200, coll[idx]);
  if (method === 'DELETE') {
    coll.splice(idx, 1);
    return json(204, null);
  }
  if (method === 'PUT' || method === 'PATCH') {
    const b = parseBody();
    if ('status' in b && 'reason' in b) return b as ApiResponse;
    coll[idx] = method === 'PUT' ? { id: coll[idx].id, ...(b as Item) } : { ...coll[idx], ...(b as Item), id: coll[idx].id };
    return json(200, coll[idx]);
  }
  return json(405, { error: `${method} is not allowed on /api/${parts[1]}/${parts[2]}` }, { Allow: 'GET, PUT, PATCH, DELETE' });
}
