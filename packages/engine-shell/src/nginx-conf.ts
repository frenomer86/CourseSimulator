/**
 * The part of nginx's configuration the simulated nginx container understands: server blocks with
 * listen, server_name, root, index and location blocks (prefix and exact) that serve files, return
 * a fixed response or proxy_pass to a host or an upstream group (weights, backup, down). Errors
 * are reported the way nginx -t reports them.
 */

export interface NginxUpstreamServer {
  host: string;
  port: number;
  weight: number;
  backup?: boolean;
  down?: boolean;
}

export interface NginxLocation {
  exact: boolean;
  path: string;
  root?: string;
  alias?: string;
  index?: string[];
  proxy?: { upstream?: string; host?: string; port?: number; path?: string };
  ret?: { code: number; text?: string };
  headers?: Record<string, string>;
}

export interface NginxServer {
  listen: number[];
  names: string[];
  root?: string;
  index?: string[];
  locations: NginxLocation[];
  headers?: Record<string, string>;
}

export interface NginxConf {
  servers: NginxServer[];
  upstreams: Record<string, NginxUpstreamServer[]>;
}

interface Tok {
  t: string;
  line: number;
  file: string;
}

const KNOWN = new Set(['listen', 'server_name', 'root', 'index', 'location', 'proxy_pass', 'proxy_set_header', 'proxy_http_version', 'proxy_read_timeout', 'proxy_connect_timeout', 'proxy_next_upstream', 'proxy_buffering', 'return', 'try_files', 'add_header', 'error_page', 'access_log', 'error_log', 'upstream', 'server', 'keepalive', 'gzip', 'gzip_types', 'client_max_body_size', 'include', 'alias', 'expires', 'sendfile', 'keepalive_timeout', 'default_type', 'charset', 'autoindex', 'log_format', 'map', 'resolver', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols', 'least_conn', 'ip_hash', 'max_fails', 'fail_timeout', 'deny', 'allow', 'limit_req', 'limit_req_zone', 'set_real_ip_from', 'real_ip_header', 'rewrite', 'if']);

function tokenize(file: string, text: string): Tok[] {
  const out: Tok[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ';') {
      out.push({ t: ch, line, file });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        if (text[j] === '\n') line++;
        s += text[j++];
      }
      out.push({ t: s, line, file });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s{};]/.test(text[j])) j++;
    out.push({ t: text.slice(i, j), line, file });
    i = j;
  }
  return out;
}

interface Directive {
  name: string;
  args: string[];
  block?: Directive[];
  line: number;
  file: string;
}

class ConfError extends Error {}

function parseBlock(toks: Tok[], pos: { i: number }, depth: number, last: Tok | undefined): Directive[] {
  const out: Directive[] = [];
  while (pos.i < toks.length) {
    const first = toks[pos.i];
    if (first.t === '}') {
      if (depth === 0) throw new ConfError(`unexpected "}" in ${first.file}:${first.line}`);
      pos.i++;
      return out;
    }
    if (first.t === ';' || first.t === '{') throw new ConfError(`unexpected "${first.t}" in ${first.file}:${first.line}`);
    const name = first.t;
    const args: string[] = [];
    pos.i++;
    for (;;) {
      const t = toks[pos.i];
      if (!t) throw new ConfError(`unexpected end of file, expecting ";" or "}" in ${first.file}:${(toks[toks.length - 1] ?? first).line}`);
      if (t.t === ';') {
        pos.i++;
        out.push({ name, args, line: first.line, file: first.file });
        break;
      }
      if (t.t === '{') {
        pos.i++;
        const block = parseBlock(toks, pos, depth + 1, t);
        out.push({ name, args, block, line: first.line, file: first.file });
        break;
      }
      if (t.t === '}') throw new ConfError(`unexpected "}" in ${t.file}:${t.line}`);
      args.push(t.t);
      pos.i++;
    }
  }
  if (depth > 0) throw new ConfError(`unexpected end of file, expecting "}" in ${last?.file ?? ''}:${(toks[toks.length - 1] ?? last)?.line ?? 0}`);
  return out;
}

const at = (d: Directive) => `in ${d.file}:${d.line}`;

function proxyTarget(url: string, d: Directive): NginxLocation['proxy'] {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) throw new ConfError(`invalid URL prefix in "${url}" ${at(d)}`);
  return { host: m[1], ...(m[2] ? { port: Number(m[2]) } : {}), ...(m[3] ? { path: m[3] } : {}) };
}

/**
 * Parses the configuration files (conf.d/*.conf, in http context). resolve(host) tells whether a
 * host name in proxy_pass or an upstream resolves, as nginx checks when it loads its configuration.
 */
export function parseNginx(files: Array<{ path: string; text: string }>, resolve: (host: string) => boolean): { conf: NginxConf } | { error: string } {
  const conf: NginxConf = { servers: [], upstreams: {} };
  try {
    const top: Directive[] = [];
    for (const f of files) top.push(...parseBlock(tokenize(f.path, f.text), { i: 0 }, 0, undefined));
    const check = (d: Directive) => {
      if (!KNOWN.has(d.name)) throw new ConfError(`unknown directive "${d.name}" ${at(d)}`);
    };
    const pendingHosts: Array<{ host: string; port: number; d: Directive }> = [];
    for (const d of top) {
      check(d);
      if (d.name === 'upstream') {
        if (!d.block || d.args.length !== 1) throw new ConfError(`invalid number of arguments in "upstream" directive ${at(d)}`);
        const servers: NginxUpstreamServer[] = [];
        for (const s of d.block) {
          if (s.name !== 'server') {
            check(s);
            continue;
          }
          const [addr, ...opts] = s.args;
          if (!addr) throw new ConfError(`invalid number of arguments in "server" directive ${at(s)}`);
          const [host, port] = addr.includes(':') ? addr.split(':') : [addr, '80'];
          const srv: NginxUpstreamServer = { host, port: Number(port), weight: 1 };
          for (const op of opts) {
            const w = /^weight=(\d+)$/.exec(op);
            if (w) srv.weight = Number(w[1]);
            else if (op === 'backup') srv.backup = true;
            else if (op === 'down') srv.down = true;
            else if (/^(max_fails|fail_timeout|max_conns)=/.test(op)) continue;
            else throw new ConfError(`invalid parameter "${op}" ${at(s)}`);
          }
          if (!Number.isFinite(srv.port) || srv.port <= 0) throw new ConfError(`invalid port in upstream "${addr}" ${at(s)}`);
          pendingHosts.push({ host, port: srv.port, d: s });
          servers.push(srv);
        }
        if (!servers.length) throw new ConfError(`no servers are inside upstream ${at(d)}`);
        if (conf.upstreams[d.args[0]]) throw new ConfError(`duplicate upstream "${d.args[0]}" ${at(d)}`);
        conf.upstreams[d.args[0]] = servers;
        continue;
      }
      if (d.name !== 'server') continue;
      if (!d.block) throw new ConfError(`directive "server" has no opening "{" ${at(d)}`);
      const srv: NginxServer = { listen: [], names: [], locations: [] };
      const readLoc = (ld: Directive, parent: NginxServer): NginxLocation => {
        const exact = ld.args[0] === '=';
        const path = exact ? ld.args[1] : ld.args[0];
        if (!path || !ld.block) throw new ConfError(`invalid number of arguments in "location" directive ${at(ld)}`);
        const loc: NginxLocation = { exact, path };
        for (const x of ld.block) {
          check(x);
          if (x.name === 'root') loc.root = x.args[0];
          else if (x.name === 'alias') loc.alias = x.args[0];
          else if (x.name === 'index') loc.index = x.args;
          else if (x.name === 'proxy_pass') loc.proxy = proxyTarget(x.args[0] ?? '', x);
          else if (x.name === 'return') loc.ret = { code: Number(x.args[0]), ...(x.args[1] !== undefined ? { text: x.args[1] } : {}) };
          else if (x.name === 'add_header') loc.headers = { ...(loc.headers ?? {}), [x.args[0]]: x.args[1] ?? '' };
        }
        void parent;
        return loc;
      };
      for (const x of d.block) {
        check(x);
        if (x.name === 'listen') {
          const [addr, ...opts] = x.args;
          const port = Number((addr ?? '').split(':').pop());
          if (!addr || !Number.isFinite(port) || port <= 0) throw new ConfError(`invalid port in "${addr ?? ''}" of the "listen" directive ${at(x)}`);
          for (const op of opts) if (!['default_server', 'default', 'ssl', 'http2', 'reuseport', 'deferred'].includes(op) && !/^(ipv6only|backlog|so_keepalive)=/.test(op)) throw new ConfError(`invalid parameter "${op}" ${at(x)}`);
          srv.listen.push(port);
        } else if (x.name === 'server_name') srv.names.push(...x.args);
        else if (x.name === 'root') srv.root = x.args[0];
        else if (x.name === 'index') srv.index = x.args;
        else if (x.name === 'add_header') srv.headers = { ...(srv.headers ?? {}), [x.args[0]]: x.args[1] ?? '' };
        else if (x.name === 'location') srv.locations.push(readLoc(x, srv));
        else if (x.name === 'return') srv.locations.push({ exact: false, path: '/', ret: { code: Number(x.args[0]), ...(x.args[1] !== undefined ? { text: x.args[1] } : {}) } });
      }
      if (!srv.listen.length) srv.listen.push(80);
      conf.servers.push(srv);
      for (const loc of srv.locations) {
        if (!loc.proxy?.host) continue;
        if (conf.upstreams[loc.proxy.host] || top.some((t) => t.name === 'upstream' && t.args[0] === loc.proxy!.host)) {
          loc.proxy = { upstream: loc.proxy.host, ...(loc.proxy.path ? { path: loc.proxy.path } : {}) };
          continue;
        }
        loc.proxy.port ??= 80;
        pendingHosts.push({ host: loc.proxy.host, port: loc.proxy.port, d: { name: 'proxy_pass', args: [], line: d.line, file: d.file } });
      }
    }
    // Upstreams defined after the server that uses them.
    for (const srv of conf.servers) for (const loc of srv.locations) if (loc.proxy?.host && conf.upstreams[loc.proxy.host]) loc.proxy = { upstream: loc.proxy.host, ...(loc.proxy.path ? { path: loc.proxy.path } : {}) };
    for (const h of pendingHosts) {
      if (conf.upstreams[h.host]) continue;
      if (!resolve(h.host)) throw new ConfError(`host not found in upstream "${h.host}${h.port !== 80 ? ':' + h.port : ''}" ${at(h.d)}`);
    }
  } catch (e) {
    if (e instanceof ConfError) return { error: e.message };
    throw e;
  }
  return { conf };
}

/** The location that handles a request path: an exact match, else the longest prefix. */
export function matchLocation(srv: NginxServer, path: string): NginxLocation | null {
  const exact = srv.locations.find((l) => l.exact && l.path === path);
  if (exact) return exact;
  let best: NginxLocation | null = null;
  for (const l of srv.locations) if (!l.exact && path.startsWith(l.path) && (!best || l.path.length > best.path.length)) best = l;
  return best;
}

/** Smooth weighted round-robin, as nginx balances an upstream. state holds each server's current weight. */
export function pickUpstream(servers: NginxUpstreamServer[], state: number[], exclude: Set<number>): number {
  const live = servers.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.down && !s.backup && !exclude.has(i));
  const pool = live.length ? live : servers.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.down && s.backup && !exclude.has(i));
  if (!pool.length) return -1;
  const total = pool.reduce((a, { s }) => a + s.weight, 0);
  let best = pool[0].i;
  for (const { s, i } of pool) {
    state[i] = (state[i] ?? 0) + s.weight;
    if (state[i] > (state[best] ?? 0)) best = i;
  }
  state[best] -= total;
  return best;
}

export const NGINX_DEFAULT_CONF = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
`;

export const nginxPage = (code: number, title: string) => `<html>\n<head><title>${code} ${title}</title></head>\n<body>\n<center><h1>${code} ${title}</h1></center>\n<hr><center>nginx/1.27.2</center>\n</body>\n</html>\n`;
