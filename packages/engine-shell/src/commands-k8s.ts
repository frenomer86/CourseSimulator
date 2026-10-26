/**
 * A simulated Kubernetes cluster and kubectl. The cluster is a JSON file the kubeconfig's server
 * points at (/var/lib/cslab/k8s/<cluster>.json). Deployments own ReplicaSets, which own Pods; each
 * pod template is evaluated by really starting its container in the container runtime
 * (docker-engine.ts): images are pulled from the Docker Hub mirror or git.lab (with
 * imagePullSecrets), environment comes from ConfigMaps and Secrets, commands run, and readiness
 * probes are checked. Services select ready pods and resolve by name inside the cluster.
 * Rolling updates follow maxSurge/maxUnavailable, so a bad image stalls a rollout instead of
 * taking the application down.
 */

import { lookup, mkdir, readFile, writeFile } from './fs.js';
import { actor, currentUser, type Ctx } from './shell.js';
import { homeOf } from './system.js';
import { abs, type IO } from './util.js';
import { dumpYaml, parseYamlAll, type Yaml } from './yaml.js';
import { resolveImage } from './docker-registry.js';
import { HTTP_PROVIDERS } from './http-hosts.js';
import {
  BoxError,
  containerHttp,
  findImage,
  hex,
  listening,
  openBox,
  parseBytes,
  removeProcess,
  runInBox,
  shq,
  startContainer,
  type DockerContainer,
  type DockerImage,
  type DockerState,
  type Peer,
} from './docker-engine.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
type Obj = Record<string, unknown>;
const ROOT = { user: 'root', groups: ['root'] };
export const K8S_DIR = '/var/lib/cslab/k8s';

/* ----------------------------------------------------------------------------- objects and state */

export interface Meta {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: number;
  generation?: number;
  ownerReferences?: Array<{ kind: string; name: string; uid: string }>;
}

export interface KObj {
  apiVersion: string;
  kind: string;
  metadata: Meta;
  spec?: Obj;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
  status?: Obj;
}

interface PodEval {
  outcome: 'running' | 'crash' | 'completed' | 'oom' | 'pull' | 'config' | 'mount';
  message?: string;
  exitCode?: number;
  logs: string[];
  container?: DockerContainer;
  image?: DockerImage;
  at: number;
}

export interface K8sState {
  cluster: string;
  objects: KObj[];
  events: Array<{ at: number; type: string; reason: string; object: string; ns: string; message: string }>;
  seq: number;
  forwards: Array<{ local: number; ns: string; target: string; port: number }>;
  evals: Record<string, PodEval>;
  created?: number;
}

const NAMESPACED = new Set(['Pod', 'Deployment', 'ReplicaSet', 'Service', 'ConfigMap', 'Secret', 'Endpoints', 'Job']);
const KINDS: Record<string, { kind: string; api: string; plural: string }> = {};
for (const [names, kind, api, plural] of [
  [['pod', 'pods', 'po'], 'Pod', 'v1', 'pods'],
  [['deployment', 'deployments', 'deploy'], 'Deployment', 'apps/v1', 'deployments.apps'],
  [['replicaset', 'replicasets', 'rs'], 'ReplicaSet', 'apps/v1', 'replicasets.apps'],
  [['service', 'services', 'svc'], 'Service', 'v1', 'services'],
  [['configmap', 'configmaps', 'cm'], 'ConfigMap', 'v1', 'configmaps'],
  [['secret', 'secrets'], 'Secret', 'v1', 'secrets'],
  [['namespace', 'namespaces', 'ns'], 'Namespace', 'v1', 'namespaces'],
  [['node', 'nodes', 'no'], 'Node', 'v1', 'nodes'],
  [['endpoints', 'ep'], 'Endpoints', 'v1', 'endpoints'],
  [['event', 'events', 'ev'], 'Event', 'v1', 'events'],
] as Array<[string[], string, string, string]>) for (const n of names) KINDS[n] = { kind, api, plural };

const kindOf = (s: string) => KINDS[s.toLowerCase().replace(/\.apps$/, '').replace(/\.v1$/, '')];
const lower = (k: string) => k.toLowerCase();
const resName = (o: KObj) => `${lower(o.kind)}${o.apiVersion === 'apps/v1' ? '.apps' : ''}/${o.metadata.name}`;

const NUMERIC = new Set(['replicas', 'containerPort', 'port', 'targetPort', 'nodePort', 'revisionHistoryLimit', 'initialDelaySeconds', 'periodSeconds', 'failureThreshold', 'successThreshold', 'timeoutSeconds', 'progressDeadlineSeconds', 'minReadySeconds', 'terminationGracePeriodSeconds', 'backoffLimit', 'runAsUser', 'runAsGroup', 'fsGroup', 'defaultMode']);

/** YAML gives strings; Kubernetes fields have types. */
function typed(v: Yaml, key = ''): unknown {
  if (typeof v === 'string') {
    if (NUMERIC.has(key) && /^\d+$/.test(v)) return Number(v);
    if (v === 'true' && !['labels', 'annotations', 'data', 'stringData', 'matchLabels', 'selector'].includes(key)) return true;
    if (v === 'false' && !['labels', 'annotations', 'data', 'stringData', 'matchLabels', 'selector'].includes(key)) return false;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => typed(x, key));
  const keepStrings = ['labels', 'annotations', 'data', 'stringData', 'matchLabels'].includes(key);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keepStrings ? x : typed(x, k)]));
}

const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/* ----------------------------------------------------------------------------- kubeconfig */

interface Kube {
  cfgPath: string;
  context: string;
  namespace: string;
  cluster: string;
  statePath: string;
}

function kubeconfigPath(ctx: Ctx): string {
  const env = ctx.exported.has('KUBECONFIG') ? ctx.vars.KUBECONFIG : ctx.sys.env.KUBECONFIG;
  return env ? abs(ctx, env.split(':')[0]) : `${homeOf(ctx.sys, currentUser(ctx))}/.kube/config`;
}

function readKubeconfig(ctx: Ctx): { doc: Obj; path: string } | null {
  const path = kubeconfigPath(ctx);
  try {
    const doc = o(typed(parseYamlAll(readFile(ctx.sys.fs, path, actor(ctx)))[0] ?? {}));
    return { doc, path };
  } catch {
    return null;
  }
}

function writeKubeconfig(ctx: Ctx, path: string, doc: Obj): void {
  writeFile(ctx.sys.fs, path, dumpYaml(doc as Yaml), actor(ctx), ctx.sys.now);
}

function currentKube(ctx: Ctx, nsFlag?: string): Kube | { error: string } {
  const k = readKubeconfig(ctx);
  const refused = 'E1025 10:00:00.000000   4242 memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp [::1]:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?';
  if (!k) return { error: refused };
  const ctxName = str(k.doc['current-context']);
  const c = arr(k.doc.contexts).find((x) => str(x.name) === ctxName);
  if (!c) return { error: ctxName ? `error: context "${ctxName}" does not exist` : refused };
  const cc = o(c.context);
  const cluster = arr(k.doc.clusters).find((x) => str(x.name) === str(cc.cluster));
  if (!cluster) return { error: `error: cluster "${str(cc.cluster)}" not found in the kubeconfig` };
  const statePath = `${K8S_DIR}/${str(cluster.name)}.json`;
  if (!lookup(ctx.sys.fs, statePath, ROOT)) {
    const server = str(o(cluster.cluster).server);
    return { error: `E1025 10:00:00.000000   4242 memcache.go:265] couldn't get current server API group list: Get "${server}/api?timeout=32s": dial tcp ${server.replace(/^https?:\/\//, '')}: connect: connection refused\nThe connection to the server ${server.replace(/^https?:\/\//, '')} was refused - did you specify the right host or port?` };
  }
  return { cfgPath: k.path, context: ctxName, namespace: nsFlag ?? (str(cc.namespace) || 'default'), cluster: str(cluster.name), statePath };
}

function loadState(ctx: Ctx, path: string): K8sState {
  const st = JSON.parse(readFile(ctx.sys.fs, path, ROOT)) as K8sState;
  st.objects ??= [];
  st.events ??= [];
  st.seq ??= 1;
  st.forwards ??= [];
  st.evals ??= {};
  // The cluster has existed for a while: built 12 days ago, the lab's own objects a day after.
  st.created ??= ctx.sys.now - 12 * 86400000;
  for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease']) {
    if (!st.objects.some((x) => x.kind === 'Namespace' && x.metadata.name === ns)) st.objects.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, uid: hex('ns' + ns, 32), creationTimestamp: st.created, labels: { 'kubernetes.io/metadata.name': ns } } });
  }
  if (!st.objects.some((x) => x.kind === 'Service' && x.metadata.name === 'kubernetes' && x.metadata.namespace === 'default')) st.objects.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', uid: hex('svc-kubernetes', 32), creationTimestamp: st.created, labels: { component: 'apiserver', provider: 'kubernetes' } }, spec: { type: 'ClusterIP', ports: [{ name: 'https', port: 443, targetPort: 6443, protocol: 'TCP' }] } });
  for (const x of st.objects) x.metadata.creationTimestamp ??= st.created + 86400000;
  return st;
}

/** Fills in what the API server defaults, so a stored object compares equal to the same manifest applied again. */
function defaults(obj: KObj): void {
  if (obj.kind === 'Secret' && obj.stringData) {
    obj.data = { ...(obj.data ?? {}), ...Object.fromEntries(Object.entries(obj.stringData).map(([k, v]) => [k, b64(String(v))])) };
    delete obj.stringData;
  }
  if (obj.kind === 'Secret') obj.type ??= 'Opaque';
  if (obj.kind === 'Service') {
    const spec = o(obj.spec);
    spec.type ??= 'ClusterIP';
    for (const [i, p] of arr(spec.ports).entries()) {
      p.protocol ??= 'TCP';
      p.targetPort ??= p.port;
      if (spec.type === 'NodePort' && p.nodePort === undefined) p.nodePort = 30000 + (parseInt(hex(obj.metadata.name + i, 4), 16) % 2767);
    }
    obj.spec = spec;
  }
}

function saveState(ctx: Ctx, path: string, st: K8sState): void {
  mkdir(ctx.sys.fs, K8S_DIR, ROOT, ctx.sys.now, true);
  writeFile(ctx.sys.fs, path, JSON.stringify(st), ROOT, ctx.sys.now);
}

/** Files that give a lab a running cluster and a kubeconfig for a user. */
export function clusterFiles(user: string, opts: { cluster?: string; namespace?: string; manifests?: string } = {}): Record<string, { content: string; mode?: string; owner?: string; group?: string }> {
  const cluster = opts.cluster ?? 'kind-lab';
  const home = user === 'root' ? '/root' : `/home/${user}`;
  const state: K8sState = { cluster, objects: [], events: [], seq: 1, forwards: [], evals: {} };
  for (const doc of parseYamlAll(opts.manifests ?? '')) {
    const obj = typed(doc) as KObj;
    if (!obj || !obj.kind) continue;
    obj.metadata = { ...obj.metadata, uid: hex('seed' + obj.kind + obj.metadata.name, 32), ...(NAMESPACED.has(obj.kind) ? { namespace: obj.metadata.namespace ?? 'default' } : {}) };
    if (obj.kind === 'Deployment') obj.metadata.generation = 1;
    defaults(obj);
    state.objects.push(obj);
  }
  return {
    [`${home}/.kube/config`]: { content: `apiVersion: v1\nkind: Config\ncurrent-context: ${cluster}\nclusters:\n- name: ${cluster}\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==\ncontexts:\n- name: ${cluster}\n  context:\n    cluster: ${cluster}\n    user: ${cluster}\n    namespace: ${opts.namespace ?? 'default'}\nusers:\n- name: ${cluster}\n  user:\n    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==\n    client-key-data: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCg==\n`, mode: '600', owner: user, group: user },
    [`${K8S_DIR}/${cluster}.json`]: { content: JSON.stringify(state) },
  };
}

/* ----------------------------------------------------------------------------- quantities and helpers */

export function memQuantity(q: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T|m)?$/.exec(q.trim());
  if (!m) return parseBytes(q);
  const mult: Record<string, number> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 0.001 };
  return Math.round(Number(m[1]) * mult[m[2] ?? '']);
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return '';
  }
};

function labelsMatch(sel: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!sel || !Object.keys(sel).length) return false;
  return Object.entries(sel).every(([k, v]) => labels?.[k] === v);
}

function parseSelector(s: string): (l: Record<string, string> | undefined) => boolean {
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  return (l) =>
    parts.every((p) => {
      const ne = /^([\w./-]+)!=(.*)$/.exec(p);
      if (ne) return l?.[ne[1]] !== ne[2];
      const eq = /^([\w./-]+)==?(.*)$/.exec(p);
      if (eq) return l?.[eq[1]] === eq[2];
      if (p.startsWith('!')) return l?.[p.slice(1)] === undefined;
      return l?.[p] !== undefined;
    });
}

/* ----------------------------------------------------------------------------- the controllers */

class Cluster {
  constructor(public ctx: Ctx, public st: K8sState) {}
  get now() {
    return this.ctx.sys.now;
  }
  list(kind: string, ns?: string): KObj[] {
    return this.st.objects.filter((x) => x.kind === kind && (ns === undefined || !NAMESPACED.has(kind) || x.metadata.namespace === ns));
  }
  get(kind: string, ns: string, name: string): KObj | undefined {
    return this.st.objects.find((x) => x.kind === kind && x.metadata.name === name && (!NAMESPACED.has(kind) || x.metadata.namespace === ns));
  }
  add(obj: KObj): KObj {
    obj.metadata.uid ??= hex(`${obj.kind}${obj.metadata.name}${this.now}${this.st.seq++}`, 32);
    obj.metadata.creationTimestamp ??= this.now;
    this.st.objects.push(obj);
    return obj;
  }
  remove(obj: KObj): void {
    const gone = new Set([obj.metadata.uid]);
    // Garbage collection: owned objects go too.
    let changed = true;
    while (changed) {
      changed = false;
      for (const x of this.st.objects) if (!gone.has(x.metadata.uid) && x.metadata.ownerReferences?.some((r) => gone.has(r.uid))) {
        gone.add(x.metadata.uid);
        changed = true;
      }
    }
    this.st.objects = this.st.objects.filter((x) => !gone.has(x.metadata.uid));
    for (const u of gone) delete this.st.evals[u ?? ''];
  }
  event(type: string, reason: string, obj: KObj, message: string): void {
    this.st.events.push({ at: this.now, type, reason, object: `${lower(obj.kind)}/${obj.metadata.name}`, ns: obj.metadata.namespace ?? 'default', message });
    if (this.st.events.length > 200) this.st.events = this.st.events.slice(-200);
  }

  /* --------------------------------------------------------------- pods */

  podIp(pod: KObj): string {
    const h = parseInt(hex(pod.metadata.uid ?? pod.metadata.name, 4), 16);
    return `10.244.${1 + (h % 2)}.${2 + (h % 250)}`;
  }
  nodeOf(pod: KObj): string {
    return parseInt(hex(pod.metadata.uid ?? '', 2), 16) % 2 ? 'lab-worker2' : 'lab-worker';
  }
  serviceIp(svc: KObj): string {
    const h = parseInt(hex(svc.metadata.namespace + '/' + svc.metadata.name, 4), 16);
    return `10.96.${h % 255}.${1 + ((h >> 8) % 250)}`;
  }

  /** The env, files and image a pod template needs; or why it cannot start. */
  prepare(ns: string, spec: Obj, podName: string, podIp: string): { image: DockerImage; env: Record<string, string>; files: Record<string, string>; c: Obj } | Pick<PodEval, 'outcome' | 'message'> {
    const c = arr(spec.containers)[0];
    if (!c) return { outcome: 'config', message: 'the pod has no containers' };
    const creds: Array<{ server: string; user: string; pass: string }> = [];
    for (const ref of arr(spec.imagePullSecrets)) {
      const sec = this.get('Secret', ns, str(ref.name));
      const cfg = sec?.data?.['.dockerconfigjson'];
      if (!cfg) continue;
      try {
        const auths = o(o(JSON.parse(unb64(cfg))).auths);
        for (const [server, a] of Object.entries(auths)) {
          const au = o(a);
          const [user, ...pass] = (au.auth ? unb64(str(au.auth)) : `${str(au.username)}:${str(au.password)}`).split(':');
          creds.push({ server, user, pass: pass.join(':') });
        }
      } catch {
        /* a broken secret gives no credentials */
      }
    }
    const pulled = resolveImage(this.ctx, str(c.image), creds);
    if ('error' in pulled) return { outcome: 'pull', message: `Failed to pull image "${str(c.image)}": ${pulled.error}` };
    const env: Record<string, string> = {};
    const lookupKey = (kind: 'ConfigMap' | 'Secret', name: string, key: string, optional: boolean): string | { error: string } | undefined => {
      const src = this.get(kind, ns, name);
      if (!src) return optional ? undefined : { error: `${kind === 'ConfigMap' ? 'configmap' : 'secret'} "${name}" not found` };
      const raw = kind === 'Secret' ? (src.data?.[key] !== undefined ? unb64(src.data[key]) : src.stringData?.[key]) : src.data?.[key];
      if (raw === undefined) return optional ? undefined : { error: `couldn't find key ${key} in ${kind} ${ns}/${name}` };
      return raw;
    };
    for (const ef of arr(c.envFrom)) {
      const ref = o(ef.configMapRef ?? ef.secretRef);
      const kind = ef.configMapRef ? 'ConfigMap' : 'Secret';
      const src = this.get(kind, ns, str(ref.name));
      if (!src) {
        if (ref.optional === true) continue;
        return { outcome: 'config', message: `${kind === 'ConfigMap' ? 'configmap' : 'secret'} "${str(ref.name)}" not found` };
      }
      for (const [k, v] of Object.entries(src.data ?? {})) env[str(ef.prefix) + k] = kind === 'Secret' ? unb64(v) : v;
    }
    for (const e of arr(c.env)) {
      const name = str(e.name);
      if (e.value !== undefined) {
        env[name] = str(e.value).replace(/\$\((\w+)\)/g, (m, v) => env[v] ?? m);
        continue;
      }
      const vf = o(e.valueFrom);
      if (vf.configMapKeyRef || vf.secretKeyRef) {
        const ref = o(vf.configMapKeyRef ?? vf.secretKeyRef);
        const v = lookupKey(vf.configMapKeyRef ? 'ConfigMap' : 'Secret', str(ref.name), str(ref.key), ref.optional === true);
        if (v && typeof v === 'object') return { outcome: 'config', message: v.error };
        if (v !== undefined) env[name] = v;
      } else if (vf.fieldRef) {
        const path = str(o(vf.fieldRef).fieldPath);
        env[name] = path === 'metadata.name' ? podName : path === 'metadata.namespace' ? ns : path === 'status.podIP' ? podIp : '';
      }
    }
    // Volumes: ConfigMaps and Secrets become files.
    const files: Record<string, string> = {};
    const vols = Object.fromEntries(arr(spec.volumes).map((v) => [str(v.name), v]));
    for (const vm of arr(c.volumeMounts)) {
      const v = vols[str(vm.name)];
      if (!v) return { outcome: 'config', message: `spec.containers[0].volumeMounts[0].name: Not found: "${str(vm.name)}"` };
      const mountPath = str(vm.mountPath).replace(/\/$/, '');
      const src = v.configMap ? this.get('ConfigMap', ns, str(o(v.configMap).name)) : v.secret ? this.get('Secret', ns, str(o(v.secret).secretName)) : null;
      if ((v.configMap || v.secret) && !src) return { outcome: 'mount', message: `MountVolume.SetUp failed for volume "${str(vm.name)}" : ${v.configMap ? 'configmap' : 'secret'} "${str(o(v.configMap ?? v.secret).name ?? o(v.secret).secretName)}" not found` };
      if (src) {
        const items = arr(o(v.configMap ?? v.secret).items);
        const keys = items.length ? items.map((it) => [str(it.key), str(it.path)]) : Object.keys(src.data ?? {}).map((k) => [k, k]);
        for (const [k, p] of keys) {
          const raw = src.kind === 'Secret' ? unb64(src.data?.[k] ?? '') : src.data?.[k] ?? '';
          if (vm.subPath) {
            if (str(vm.subPath) === p) files[mountPath] = raw;
          } else files[`${mountPath}/${p}`] = raw;
        }
      }
    }
    return { image: pulled.img, env, files, c };
  }

  /** The containers of running pods, for DNS and for reaching services. */
  clusterView(): { st: DockerState; peers: (ns: string) => Record<string, Peer> } {
    const st: DockerState = { images: [], containers: [], volumes: [], networks: ['bridge', 'host', 'none'] };
    const byPod = new Map<string, DockerContainer>();
    for (const pod of this.list('Pod')) {
      const ev = this.st.evals[pod.metadata.uid ?? ''];
      if (!ev?.container || ev.outcome !== 'running' || pod.metadata.annotations?.['cslab/terminating']) continue;
      const c = ev.container;
      byPod.set(pod.metadata.uid!, c);
      st.containers.push(c);
      if (ev.image && !st.images.some((i) => i.repo === ev.image!.repo && i.tag === ev.image!.tag)) st.images.push(ev.image);
    }
    const peers = (ns: string): Record<string, Peer> => {
      const out: Record<string, Peer> = {};
      for (const svc of this.list('Service')) {
        const ready = this.endpoints(svc);
        const c = ready.map((p) => byPod.get(p.metadata.uid!)).find(Boolean) ?? ({ id: 'none', name: 'none', image: '', status: 'exited', exitCode: 0, ports: [], env: {}, mounts: [], restart: 'no', network: 'none', logs: [], created: 0 } as DockerContainer);
        const ports: Record<number, number> = {};
        for (const p of arr(o(svc.spec).ports)) ports[Number(p.port)] = this.targetPort(svc, p, ready[0]);
        const peer: Peer = { name: svc.metadata.name, ip: this.serviceIp(svc), container: c, ports };
        const names = [`${svc.metadata.name}.${svc.metadata.namespace}`, `${svc.metadata.name}.${svc.metadata.namespace}.svc`, `${svc.metadata.name}.${svc.metadata.namespace}.svc.cluster.local`];
        if (svc.metadata.namespace === ns) names.unshift(svc.metadata.name);
        for (const n of names) out[n] = peer;
      }
      for (const pod of this.list('Pod')) {
        const c = byPod.get(pod.metadata.uid!);
        if (c) out[this.podIp(pod)] = { name: pod.metadata.name, ip: this.podIp(pod), container: c };
      }
      return out;
    };
    return { st, peers };
  }

  targetPort(_svc: KObj, p: Obj, pod?: KObj): number {
    const t = p.targetPort ?? p.port;
    if (typeof t === 'number') return t;
    if (/^\d+$/.test(str(t))) return Number(t);
    const c = pod ? arr(o(pod.spec).containers)[0] : undefined;
    const named = arr(c?.ports).find((x) => str(x.name) === str(t));
    return named ? Number(named.containerPort) : Number(p.port);
  }

  /** Starts a pod's container in the runtime and records what happened. */
  evaluate(pod: KObj): PodEval {
    const ns = pod.metadata.namespace ?? 'default';
    const spec = o(pod.spec);
    const prep = this.prepare(ns, spec, pod.metadata.name, this.podIp(pod));
    if (!('image' in prep)) return { ...prep, logs: [], at: this.now };
    const { image, env, files, c } = prep;
    const command = arr(c.command).length ? (c.command as unknown[]).map((x) => shq(str(x))).join(' ') : undefined;
    const args = arr(c.args).length ? (c.args as unknown[]).map((x) => shq(str(x))).join(' ') : undefined;
    const limits = o(o(c.resources).limits);
    const memory = limits.memory ? memQuantity(str(limits.memory)) ?? undefined : undefined;
    const container: DockerContainer = {
      id: hex('pod' + pod.metadata.uid, 64),
      name: pod.metadata.name,
      image: `${image.repo}:${image.tag}`,
      status: 'created',
      exitCode: 0,
      ports: [],
      env,
      mounts: [],
      restart: 'no',
      network: 'none',
      logs: [],
      created: this.now,
      ...(command !== undefined ? { entrypoint: command, command: args ?? '' } : args !== undefined ? { command: args } : {}),
      ...(memory ? { memory } : {}),
      ...(o(c.securityContext).runAsUser !== undefined ? { user: str(o(c.securityContext).runAsUser) } : {}),
      ...(c.workingDir ? { workdir: str(c.workingDir) } : {}),
      rw: { files },
    };
    const view = this.clusterView();
    const st: DockerState = { ...view.st, images: [...view.st.images.filter((i) => !(i.repo === image.repo && i.tag === image.tag)), image], containers: [...view.st.containers, container] };
    const r = startContainer(this.ctx, st, container, undefined, { peers: view.peers(ns), hostname: pod.metadata.name, ip: this.podIp(pod) });
    removeProcess(this.ctx, container);
    const logs = container.logs;
    if (r.error) return { outcome: 'crash', message: r.error, exitCode: r.code, logs, at: this.now, image };
    if (container.oomKilled) return { outcome: 'oom', exitCode: 137, logs, at: this.now, image };
    if (container.status === 'running') return { outcome: 'running', logs, container, image, at: this.now };
    return { outcome: container.exitCode === 0 ? 'completed' : 'crash', exitCode: container.exitCode, logs, at: this.now, image };
  }

  /** A probe's result right now, with the kubelet's message when it fails. */
  probe(pod: KObj, kind: 'readinessProbe' | 'livenessProbe'): { ok: boolean; message?: string } {
    const c = arr(o(pod.spec).containers)[0];
    const pr = o(c?.[kind]);
    const ev = this.st.evals[pod.metadata.uid ?? ''];
    if (!c?.[kind] || !ev?.container) return { ok: true };
    const view = this.clusterView();
    const st: DockerState = { ...view.st, containers: [...view.st.containers.filter((x) => x.id !== ev.container!.id), ev.container], images: [...view.st.images, ...(ev.image ? [ev.image] : [])] };
    const portOf = (p: unknown) => (typeof p === 'number' ? p : /^\d+$/.test(str(p)) ? Number(p) : Number(arr(c.ports).find((x) => str(x.name) === str(p))?.containerPort ?? 0));
    const what = kind === 'readinessProbe' ? 'Readiness' : 'Liveness';
    if (pr.httpGet) {
      const g = o(pr.httpGet);
      const port = portOf(g.port);
      const r = containerHttp(this.ctx, st, ev.container, port, str(g.path) || '/');
      if (!r) return { ok: false, message: `${what} probe failed: Get "http://${this.podIp(pod)}:${port}${str(g.path) || '/'}": dial tcp ${this.podIp(pod)}:${port}: connect: connection refused` };
      if (r === 'empty') return { ok: false, message: `${what} probe failed: Get "http://${this.podIp(pod)}:${port}${str(g.path)}": EOF` };
      return r.status < 400 ? { ok: true } : { ok: false, message: `${what} probe failed: HTTP probe failed with statuscode: ${r.status}` };
    }
    if (pr.tcpSocket) {
      const port = portOf(o(pr.tcpSocket).port);
      return listening(st, ev.container, port, this.now) === 'open' ? { ok: true } : { ok: false, message: `${what} probe failed: dial tcp ${this.podIp(pod)}:${port}: connect: connection refused` };
    }
    if (pr.exec) {
      const cmd = arr(o(pr.exec).command).map((x) => shq(str(x))).join(' ');
      try {
        const box = openBox(this.ctx, st, ev.image!, ev.container, { peers: view.peers(pod.metadata.namespace ?? 'default'), hostname: pod.metadata.name, ip: this.podIp(pod) });
        const r = runInBox(box, cmd);
        return r.code === 0 ? { ok: true } : { ok: false, message: `${what} probe failed: ${r.out.trim()}` };
      } catch {
        return { ok: false, message: `${what} probe failed` };
      }
    }
    return { ok: true };
  }

  /** Pods whose readiness makes them a service's endpoints. */
  endpoints(svc: KObj): KObj[] {
    const sel = o(o(svc.spec).selector) as Record<string, string>;
    return this.list('Pod', svc.metadata.namespace).filter((p) => labelsMatch(sel, p.metadata.labels) && this.podView(p).ready);
  }

  /** What kubectl shows for a pod. */
  podView(pod: KObj): { phase: string; status: string; ready: boolean; restarts: number; reason?: string; message?: string; started?: number; lastState?: string } {
    const ev = this.st.evals[pod.metadata.uid ?? ''];
    const created = pod.metadata.creationTimestamp ?? 0;
    const since = this.now - created;
    if (pod.metadata.annotations?.['cslab/terminating']) return { phase: 'Running', status: 'Terminating', ready: false, restarts: 0 };
    if (!ev) return { phase: 'Pending', status: 'Pending', ready: false, restarts: 0 };
    const restartsFor = (elapsed: number) => {
      // Back-off doubles from 10 s up to 5 minutes.
      let t = 0;
      let n = 0;
      let d = 10000;
      while (t + d <= elapsed && n < 50) {
        t += d;
        n++;
        d = Math.min(d * 2, 300000);
      }
      return n;
    };
    const never = str(o(pod.spec).restartPolicy) === 'Never';
    switch (ev.outcome) {
      case 'pull':
        return { phase: 'Pending', status: since < 5000 ? 'ErrImagePull' : 'ImagePullBackOff', ready: false, restarts: 0, reason: since < 5000 ? 'ErrImagePull' : 'ImagePullBackOff', message: ev.message };
      case 'config':
        return { phase: 'Pending', status: 'CreateContainerConfigError', ready: false, restarts: 0, reason: 'CreateContainerConfigError', message: ev.message };
      case 'mount':
        return { phase: 'Pending', status: 'ContainerCreating', ready: false, restarts: 0, reason: 'ContainerCreating', message: ev.message };
      case 'completed':
      case 'crash':
      case 'oom': {
        if (never) return { phase: ev.outcome === 'completed' ? 'Succeeded' : 'Failed', status: ev.outcome === 'completed' ? 'Completed' : ev.outcome === 'oom' ? 'OOMKilled' : 'Error', ready: false, restarts: 0, reason: ev.outcome === 'oom' ? 'OOMKilled' : undefined };
        const n = restartsFor(this.now - ev.at);
        const last = ev.outcome === 'oom' ? 'OOMKilled' : ev.outcome === 'completed' ? 'Completed' : 'Error';
        return { phase: 'Running', status: n === 0 && this.now - ev.at < 3000 ? last : 'CrashLoopBackOff', ready: false, restarts: n, reason: 'CrashLoopBackOff', message: `back-off ${Math.min(10 * 2 ** Math.max(0, n - 1), 300)}s restarting failed container=${str(arr(o(pod.spec).containers)[0]?.name)} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`, lastState: last };
      }
      case 'running': {
        if (since < 2000) return { phase: 'Pending', status: 'ContainerCreating', ready: false, restarts: 0 };
        const live = this.probe(pod, 'livenessProbe');
        if (!live.ok) {
          const n = Math.max(1, restartsFor(this.now - ev.at));
          return { phase: 'Running', status: 'CrashLoopBackOff', ready: false, restarts: n, reason: 'CrashLoopBackOff', message: live.message, lastState: 'Error' };
        }
        const readyProbe = this.probe(pod, 'readinessProbe');
        const delay = Number(o(arr(o(pod.spec).containers)[0]?.readinessProbe).initialDelaySeconds ?? 0) * 1000;
        const ready = readyProbe.ok && since >= 2000 + delay;
        return { phase: 'Running', status: 'Running', ready, restarts: 0, started: ev.at, message: readyProbe.ok ? undefined : readyProbe.message };
      }
    }
  }

  /** The pod-template hash a ReplicaSet carries. */
  templateHash(t: Obj): string {
    return hex(JSON.stringify(t), 10).replace(/[0-9]/g, (d) => 'bcdfghjklm'[Number(d)]);
  }

  newPod(owner: KObj, template: Obj, extraLabels: Record<string, string>): KObj {
    const meta = o(template.metadata);
    const name = `${owner.metadata.name}-${hex(`pod${this.st.seq++}${owner.metadata.uid}${this.now}`, 5).replace(/[0-9]/g, (d) => 'vwxzbcdfgh'[Number(d)])}`;
    const pod = this.add({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: owner.metadata.namespace, labels: { ...(meta.labels as Record<string, string>), ...extraLabels }, ownerReferences: [{ kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid! }] }, spec: structuredClone(o(template.spec)) });
    this.st.evals[pod.metadata.uid!] = this.evaluate(pod);
    return pod;
  }

  /** One pass of every controller: deployments, replica sets, pods' retries. */
  reconcile(): void {
    for (const d of this.list('Deployment')) this.reconcileDeployment(d);
    for (const rs of this.list('ReplicaSet')) {
      const want = Number(o(rs.spec).replicas ?? 1);
      const pods = this.list('Pod', rs.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === rs.metadata.uid));
      for (let i = pods.length; i < want; i++) this.newPod(rs, o(o(rs.spec).template), { 'pod-template-hash': rs.metadata.labels?.['pod-template-hash'] ?? '' });
      if (pods.length > want) {
        // Scale down: not-ready pods go first.
        const order = [...pods].sort((a, b) => Number(this.podView(a).ready) - Number(this.podView(b).ready));
        for (const p of order.slice(0, pods.length - want)) this.remove(p);
      }
      const now = this.list('Pod', rs.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === rs.metadata.uid));
      rs.status = { replicas: now.length, readyReplicas: now.filter((p) => this.podView(p).ready).length, availableReplicas: now.filter((p) => this.podView(p).ready).length };
    }
    // Pods that failed retry: a missing ConfigMap or image may exist now.
    for (const pod of this.list('Pod')) {
      const ev = this.st.evals[pod.metadata.uid ?? ''];
      if (!ev) {
        this.st.evals[pod.metadata.uid!] = this.evaluate(pod);
        continue;
      }
      if (ev.outcome !== 'running' && this.now - ev.at >= 10000 && !(str(o(pod.spec).restartPolicy) === 'Never' && (ev.outcome === 'completed' || ev.outcome === 'crash' || ev.outcome === 'oom'))) {
        const next = this.evaluate(pod);
        // Keep the original start so the restart count keeps growing while it still fails.
        this.st.evals[pod.metadata.uid!] = next.outcome === ev.outcome ? { ...next, at: ev.at } : next;
      }
    }
  }

  reconcileDeployment(d: KObj): void {
    const spec = o(d.spec);
    const template = o(spec.template);
    const hash = this.templateHash(template);
    const replicas = Number(spec.replicas ?? 1);
    const owned = this.list('ReplicaSet', d.metadata.namespace).filter((rs) => rs.metadata.ownerReferences?.some((r) => r.uid === d.metadata.uid));
    const rev = (rs: KObj) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
    let cur = owned.find((rs) => rs.metadata.labels?.['pod-template-hash'] === hash);
    if (!cur) {
      const maxRev = Math.max(0, ...owned.map(rev));
      cur = this.add({ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: `${d.metadata.name}-${hash}`, namespace: d.metadata.namespace, labels: { ...(o(template.metadata).labels as Record<string, string>), 'pod-template-hash': hash }, annotations: { 'deployment.kubernetes.io/revision': String(maxRev + 1), ...(d.metadata.annotations?.['kubernetes.io/change-cause'] ? { 'kubernetes.io/change-cause': d.metadata.annotations['kubernetes.io/change-cause'] } : {}) }, ownerReferences: [{ kind: 'Deployment', name: d.metadata.name, uid: d.metadata.uid! }] }, spec: { replicas: 0, selector: { matchLabels: { ...(o(o(spec.selector).matchLabels) as Record<string, string>), 'pod-template-hash': hash } }, template: structuredClone(template) } });
      d.metadata.annotations = { ...(d.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': String(maxRev + 1) };
      (d.status ??= {}).updatedAt = this.now;
    } else if (rev(cur) < Math.max(0, ...owned.map(rev))) {
      // Rolling back to an old template gives it the next revision number.
      cur.metadata.annotations = { ...(cur.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': String(Math.max(...owned.map(rev)) + 1) };
      if (d.metadata.annotations?.['kubernetes.io/change-cause']) cur.metadata.annotations['kubernetes.io/change-cause'] = d.metadata.annotations['kubernetes.io/change-cause'];
      d.metadata.annotations = { ...(d.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': cur.metadata.annotations['deployment.kubernetes.io/revision'] };
      (d.status ??= {}).updatedAt = this.now;
    }
    // The controller keeps the newest ReplicaSet's change-cause in step with the Deployment's.
    const cause = d.metadata.annotations?.['kubernetes.io/change-cause'];
    if (cause && cur.metadata.annotations?.['kubernetes.io/change-cause'] !== cause) cur.metadata.annotations = { ...(cur.metadata.annotations ?? {}), 'kubernetes.io/change-cause': cause };
    const olds = owned.filter((rs) => rs !== cur);
    const strat = o(o(spec.strategy).rollingUpdate);
    const pct = (v: unknown, dflt: string, up: boolean) => {
      const s = str(v ?? dflt);
      return s.endsWith('%') ? (up ? Math.ceil : Math.floor)((replicas * Number(s.slice(0, -1))) / 100) : Number(s);
    };
    const surge = pct(strat.maxSurge, '25%', true);
    const unavailable = pct(strat.maxUnavailable, '25%', false);
    const recreate = str(o(spec.strategy).type) === 'Recreate';
    const setReplicas = (rs: KObj, n: number) => {
      const before = Number(o(rs.spec).replicas ?? 0);
      if (before === n) return;
      rs.spec = { ...o(rs.spec), replicas: n };
      this.event('Normal', 'ScalingReplicaSet', d, `Scaled ${n > before ? 'up' : 'down'} replica set ${rs.metadata.name} to ${n}${n < before ? ` from ${before}` : ''}`);
    };
    // Will the new template's pods come up? Ask one (an existing pod, or a trial).
    const curPods = this.list('Pod', d.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === cur!.metadata.uid));
    const healthy = () => {
      const ps = this.list('Pod', d.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === cur!.metadata.uid));
      if (!ps.length) return null;
      return ps.every((p) => {
        const ev = this.st.evals[p.metadata.uid ?? ''];
        return ev?.outcome === 'running' && this.probe(p, 'livenessProbe').ok && this.probe(p, 'readinessProbe').ok;
      });
    };
    if (recreate) {
      for (const rs of olds) setReplicas(rs, 0);
      setReplicas(cur, replicas);
    } else if (!olds.some((rs) => Number(o(rs.spec).replicas ?? 0) > 0)) {
      setReplicas(cur, replicas);
    } else {
      if (!curPods.length) setReplicas(cur, Math.max(1, Math.min(replicas, surge + unavailable)));
      this.reconcileOwned(cur);
      if (healthy()) {
        setReplicas(cur, replicas);
        for (const rs of olds) setReplicas(rs, 0);
      } else {
        // The rollout is stuck: keep enough old pods to stay available.
        let keep = replicas - unavailable;
        for (const rs of [...olds].sort((a, b) => rev(b) - rev(a))) {
          const n = Math.min(Number(o(rs.spec).replicas ?? 0), Math.max(0, keep));
          setReplicas(rs, n);
          keep -= n;
        }
        setReplicas(cur, Math.max(1, Math.min(replicas, surge + unavailable)));
      }
    }
    // Old ReplicaSets beyond the history limit are deleted.
    const limit = Number(spec.revisionHistoryLimit ?? 10);
    const idle = olds.filter((rs) => Number(o(rs.spec).replicas ?? 0) === 0).sort((a, b) => rev(b) - rev(a));
    for (const rs of idle.slice(limit)) this.remove(rs);
    this.reconcileOwned(cur);
    for (const rs of olds) this.reconcileOwned(rs);
    const all = this.list('Pod', d.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => owned.concat(cur!).some((rs) => rs.metadata.uid === r.uid)));
    const newPods = all.filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === cur!.metadata.uid));
    const ready = all.filter((p) => this.podView(p).ready).length;
    const updatedAt = Number(o(d.status).updatedAt ?? d.metadata.creationTimestamp ?? 0);
    const deadline = Number(spec.progressDeadlineSeconds ?? 600) * 1000;
    const complete = newPods.length === replicas && newPods.every((p) => this.podView(p).ready) && all.length === replicas;
    d.status = {
      ...o(d.status),
      observedGeneration: d.metadata.generation ?? 1,
      replicas: all.length,
      updatedReplicas: newPods.length,
      readyReplicas: ready,
      availableReplicas: ready,
      unavailableReplicas: Math.max(0, replicas - ready),
      conditions: [
        { type: 'Available', status: ready >= replicas - unavailable && ready > 0 ? 'True' : 'False', reason: ready >= replicas - unavailable && ready > 0 ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', message: ready >= replicas - unavailable && ready > 0 ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.' },
        complete ? { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: `ReplicaSet "${cur.metadata.name}" has successfully progressed.` } : this.now - updatedAt > deadline ? { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${cur.metadata.name}" has timed out progressing.` } : { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: `ReplicaSet "${cur.metadata.name}" is progressing.` },
      ],
    };
  }

  reconcileOwned(rs: KObj): void {
    const want = Number(o(rs.spec).replicas ?? 0);
    const pods = this.list('Pod', rs.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === rs.metadata.uid));
    for (let i = pods.length; i < want; i++) this.newPod(rs, o(o(rs.spec).template), { 'pod-template-hash': rs.metadata.labels?.['pod-template-hash'] ?? '' });
    if (pods.length > want) {
      const order = [...pods].sort((a, b) => Number(this.podView(a).ready) - Number(this.podView(b).ready));
      for (const p of order.slice(0, pods.length - want)) this.remove(p);
    }
  }
}

/* ----------------------------------------------------------------------------- validation and apply */

const SPEC_FIELDS: Record<string, string[]> = {
  Deployment: ['replicas', 'selector', 'template', 'strategy', 'revisionHistoryLimit', 'progressDeadlineSeconds', 'minReadySeconds', 'paused'],
  Service: ['selector', 'ports', 'type', 'clusterIP', 'externalTrafficPolicy', 'sessionAffinity', 'externalName'],
  Pod: ['containers', 'initContainers', 'volumes', 'restartPolicy', 'imagePullSecrets', 'nodeSelector', 'securityContext', 'serviceAccountName', 'terminationGracePeriodSeconds', 'affinity', 'tolerations', 'hostname'],
};
const CONTAINER_FIELDS = ['name', 'image', 'command', 'args', 'env', 'envFrom', 'ports', 'resources', 'volumeMounts', 'readinessProbe', 'livenessProbe', 'startupProbe', 'imagePullPolicy', 'workingDir', 'securityContext', 'lifecycle', 'stdin', 'tty'];

function validate(obj: KObj, file: string): string | null {
  const api: Record<string, string> = { Deployment: 'apps/v1', ReplicaSet: 'apps/v1', Pod: 'v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1', Namespace: 'v1' };
  if (!obj.kind || !obj.apiVersion) return `error: error validating "${file}": error validating data: [apiVersion not set, kind not set]; if you choose to ignore these errors, turn validation off with --validate=false`;
  if (!api[obj.kind]) return `error: resource mapping not found for name: "${obj.metadata?.name ?? ''}" namespace: "" from "${file}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first`;
  if (api[obj.kind] !== obj.apiVersion) return `error: resource mapping not found for name: "${obj.metadata?.name ?? ''}" namespace: "" from "${file}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first`;
  if (!obj.metadata?.name) return `error: error when retrieving current configuration of:\nResource: "${KINDS[lower(obj.kind)].plural}", GroupVersionKind: "${obj.apiVersion}, Kind=${obj.kind}"\nfrom server for: "${file}": resource name may not be empty`;
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(obj.metadata.name)) return `The ${obj.kind} "${obj.metadata.name}" is invalid: metadata.name: Invalid value: "${obj.metadata.name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`;
  const strict = (path: string, have: Obj, allowed: string[]) => {
    const bad = Object.keys(have).find((k) => !allowed.includes(k));
    return bad ? `Error from server (BadRequest): error when creating "${file}": ${obj.kind} in version "${obj.apiVersion.split('/').pop()}" cannot be handled as a ${obj.kind}: strict decoding error: unknown field "${path}.${bad}"` : null;
  };
  const spec = o(obj.spec);
  if (SPEC_FIELDS[obj.kind]) {
    const e = strict('spec', spec, SPEC_FIELDS[obj.kind]);
    if (e) return e;
  }
  const podSpec = obj.kind === 'Pod' ? spec : obj.kind === 'Deployment' ? o(o(spec.template).spec) : null;
  if (podSpec) {
    const pre = obj.kind === 'Pod' ? 'spec' : 'spec.template.spec';
    if (obj.kind !== 'Pod') {
      const e = strict(pre, podSpec, SPEC_FIELDS.Pod);
      if (e) return e;
    }
    const cs = arr(podSpec.containers);
    if (!cs.length) return `The ${obj.kind} "${obj.metadata.name}" is invalid: ${pre}.containers: Required value`;
    for (const [i, c] of cs.entries()) {
      const e = strict(`${pre}.containers[${i}]`, c, CONTAINER_FIELDS);
      if (e) return e;
      if (!c.name) return `The ${obj.kind} "${obj.metadata.name}" is invalid: ${pre}.containers[${i}].name: Required value`;
      if (!c.image) return `The ${obj.kind} "${obj.metadata.name}" is invalid: ${pre}.containers[${i}].image: Required value`;
      for (const [j, e2] of arr(c.env).entries()) if (e2.value !== undefined && typeof e2.value !== 'string') return `Error from server (BadRequest): error when creating "${file}": ${obj.kind} in version "${obj.apiVersion.split('/').pop()}" cannot be handled as a ${obj.kind}: json: cannot unmarshal ${typeof e2.value === 'number' ? 'number' : 'bool'} into Go struct field EnvVar.${pre}.containers.env.value of type string (env[${j}]: quote the value)`;
    }
  }
  if (obj.kind === 'Deployment') {
    const sel = o(o(spec.selector).matchLabels) as Record<string, string>;
    if (!spec.selector) return `The Deployment "${obj.metadata.name}" is invalid: spec.selector: Required value`;
    const labels = o(o(o(spec.template).metadata).labels) as Record<string, string>;
    if (!Object.entries(sel).every(([k, v]) => labels[k] === v) || !Object.keys(sel).length) return `The Deployment "${obj.metadata.name}" is invalid: spec.template.metadata.labels: Invalid value: map[string]string{${Object.entries(labels).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``;
  }
  if (obj.kind === 'Service') {
    for (const [i, p] of arr(spec.ports).entries()) {
      if (p.port === undefined) return `The Service "${obj.metadata.name}" is invalid: spec.ports[${i}].port: Required value`;
      if (p.nodePort !== undefined && (Number(p.nodePort) < 30000 || Number(p.nodePort) > 32767)) return `The Service "${obj.metadata.name}" is invalid: spec.ports[${i}].nodePort: Invalid value: ${str(p.nodePort)}: provided port is not in the valid range. The range of valid ports is 30000-32767`;
    }
    if (spec.type && !['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(str(spec.type))) return `The Service "${obj.metadata.name}" is invalid: spec.type: Unsupported value: "${str(spec.type)}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`;
  }
  return null;
}

/** Creates or updates an object as kubectl apply does; returns the verb for the message. */
function applyObject(cl: Cluster, obj: KObj, ns: string, file: string, mode: 'apply' | 'create' | 'replace'): { verb: string } | { error: string } {
  const err = validate(obj, file);
  if (err) return { error: err };
  if (NAMESPACED.has(obj.kind)) {
    // A manifest's own namespace wins over the current context's.
    const target = obj.metadata.namespace ?? ns;
    obj.metadata.namespace = target;
    if (!cl.get('Namespace', '', target)) return { error: `Error from server (NotFound): error when creating "${file}": namespaces "${target}" not found` };
  }
  defaults(obj);
  const existing = cl.get(obj.kind, obj.metadata.namespace ?? '', obj.metadata.name);
  if (existing) {
    if (mode === 'create') return { error: `Error from server (AlreadyExists): error when creating "${file}": ${KINDS[lower(obj.kind)].plural.split('.')[0]} "${obj.metadata.name}" already exists` };
    if (obj.kind === 'Deployment' && JSON.stringify(o(o(existing.spec).selector)) !== JSON.stringify(o(o(obj.spec).selector))) return { error: `The Deployment "${obj.metadata.name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(o(o(o(obj.spec).selector).matchLabels)).map(([k, v]) => `"${k}":"${str(v)}"`).join(', ')}}}: field is immutable` };
    const same = JSON.stringify([existing.spec, existing.data, existing.metadata.labels, existing.metadata.annotations?.['kubernetes.io/change-cause']]) === JSON.stringify([obj.spec, obj.data, obj.metadata.labels, obj.metadata.annotations?.['kubernetes.io/change-cause']]);
    if (same) return { verb: 'unchanged' };
    const keepAnn = Object.fromEntries(Object.entries(existing.metadata.annotations ?? {}).filter(([k]) => k.startsWith('deployment.kubernetes.io/')));
    existing.spec = obj.spec;
    existing.data = obj.data;
    existing.type = obj.type ?? existing.type;
    existing.metadata.labels = obj.metadata.labels;
    existing.metadata.annotations = { ...keepAnn, ...(obj.metadata.annotations ?? {}) };
    existing.metadata.generation = (existing.metadata.generation ?? 1) + 1;
    return { verb: 'configured' };
  }
  const fresh: KObj = { ...obj, metadata: { ...obj.metadata, ...(obj.kind === 'Deployment' ? { generation: 1 } : {}) } };
  cl.add(fresh);
  if (obj.kind === 'Pod') cl.st.evals[fresh.metadata.uid!] = cl.evaluate(fresh);
  return { verb: 'created' };
}

/* ----------------------------------------------------------------------------- output */

function jsonpath(expr: string, data: unknown): string {
  const src = expr.replace(/^'|'$/g, '');
  let out = '';
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const stack: Array<{ items: unknown[]; idx: number; start: number; saved: unknown }> = [];
  let dot: unknown = data;
  const evalPath = (p: string, base: unknown): unknown[] => {
    if (p === '@' || p === '.' || p === '') return [base];
    let cur: unknown[] = [p.startsWith('@') ? base : p.startsWith('$') ? data : base];
    const parts = p.replace(/^[@$]/, '').match(/\.[^.[]+|\[[^\]]*\]/g) ?? [];
    for (const part of parts) {
      const next: unknown[] = [];
      for (const c of cur) {
        if (part.startsWith('[')) {
          const inner = part.slice(1, -1);
          if (inner === '*') next.push(...(Array.isArray(c) ? c : c && typeof c === 'object' ? Object.values(c) : []));
          else if (/^-?\d+$/.test(inner) && Array.isArray(c)) next.push(c[Number(inner) < 0 ? c.length + Number(inner) : Number(inner)]);
          else if (/^\?\(@\.([\w.]+)=="?([^"]*)"?\)$/.test(inner) && Array.isArray(c)) {
            const fm = /^\?\(@\.([\w.]+)=="?([^"]*)"?\)$/.exec(inner)!;
            next.push(...c.filter((x) => str(fm[1].split('.').reduce<unknown>((a, k) => o(a)[k], x)) === fm[2]));
          } else if (c && typeof c === 'object') next.push((c as Obj)[inner.replace(/^'|'$/g, '')]);
        } else {
          const key = part.slice(1);
          if (key === '*') next.push(...(c && typeof c === 'object' ? Object.values(c) : []));
          else if (c && typeof c === 'object') next.push((c as Obj)[key.replace(/\\\./g, '.')]);
        }
      }
      cur = next;
    }
    return cur.filter((x) => x !== undefined);
  };
  const fmt = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : str(v));
  const body: Array<{ text?: string; act?: string }> = [];
  while ((m = re.exec(src))) {
    if (m.index > last) body.push({ text: src.slice(last, m.index) });
    body.push({ act: m[1] });
    last = re.lastIndex;
  }
  if (last < src.length) body.push({ text: src.slice(last) });
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.text !== undefined) {
      out += t.text;
      continue;
    }
    const a = t.act!.trim();
    if (a.startsWith('range ')) {
      stack.push({ items: evalPath(a.slice(6).trim(), dot), idx: 0, start: i, saved: dot });
      const top = stack[stack.length - 1];
      if (!top.items.length) {
        let depth = 0;
        for (i = i + 1; i < body.length; i++) {
          if (body[i].act?.trim().startsWith('range ')) depth++;
          if (body[i].act?.trim() === 'end') {
            if (depth === 0) break;
            depth--;
          }
        }
        stack.pop();
        continue;
      }
      dot = top.items[0];
      continue;
    }
    if (a === 'end') {
      const top = stack[stack.length - 1];
      if (!top) continue;
      top.idx++;
      if (top.idx < top.items.length) {
        dot = top.items[top.idx];
        i = top.start;
      } else {
        dot = top.saved;
        stack.pop();
      }
      continue;
    }
    if (/^".*"$/.test(a)) {
      out += a.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      continue;
    }
    out += evalPath(a, dot).map(fmt).join(' ');
  }
  return out;
}

function objJson(cl: Cluster, x: KObj): Obj {
  const meta: Obj = { name: x.metadata.name, ...(x.metadata.namespace ? { namespace: x.metadata.namespace } : {}), uid: x.metadata.uid, creationTimestamp: new Date(x.metadata.creationTimestamp ?? 0).toISOString().replace(/\.\d+Z$/, 'Z'), ...(x.metadata.labels ? { labels: x.metadata.labels } : {}), ...(x.metadata.annotations && Object.keys(x.metadata.annotations).filter((k) => !k.startsWith('cslab/')).length ? { annotations: Object.fromEntries(Object.entries(x.metadata.annotations).filter(([k]) => !k.startsWith('cslab/'))) } : {}), ...(x.metadata.generation ? { generation: x.metadata.generation } : {}), ...(x.metadata.ownerReferences ? { ownerReferences: x.metadata.ownerReferences.map((r) => ({ apiVersion: r.kind === 'Deployment' || r.kind === 'ReplicaSet' ? 'apps/v1' : 'v1', kind: r.kind, name: r.name, uid: r.uid, controller: true })) } : {}) };
  const out: Obj = { apiVersion: x.apiVersion, kind: x.kind, metadata: meta };
  if (x.spec) out.spec = x.spec;
  if (x.data) out.data = x.data;
  if (x.type) out.type = x.type;
  if (x.kind === 'Pod') {
    const v = cl.podView(x);
    const c = arr(o(x.spec).containers)[0];
    out.status = { phase: v.phase, podIP: cl.podIp(x), hostIP: x.metadata.uid ? '172.18.0.3' : '', conditions: [{ type: 'Ready', status: v.ready ? 'True' : 'False' }], containerStatuses: [{ name: str(c?.name), image: str(c?.image), ready: v.ready, restartCount: v.restarts, state: v.status === 'Running' ? { running: { startedAt: new Date(v.started ?? 0).toISOString() } } : v.reason ? { waiting: { reason: v.reason, message: v.message } } : { terminated: { reason: v.status } }, ...(v.lastState ? { lastState: { terminated: { reason: v.lastState, exitCode: v.lastState === 'OOMKilled' ? 137 : 1 } } } : {}) }] };
  } else if (x.status) out.status = x.status;
  if (x.kind === 'Service') out.spec = { ...o(x.spec), clusterIP: cl.serviceIp(x) };
  return out;
}

function table(io: IO, head: string[], rows: string[][]): void {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  io.out(head.map((h, i) => (i < head.length - 1 ? h.padEnd(w[i] + 3) : h)).join('') + '\n');
  for (const r of rows) io.out(r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i] + 3) : c)).join('').trimEnd() + '\n');
}

function rowsFor(cl: Cluster, kind: string, items: KObj[], wide: boolean, allNs: boolean, showLabels: boolean): { head: string[]; rows: string[][] } {
  const now = cl.now;
  const ageOf = (x: KObj) => age(now - (x.metadata.creationTimestamp ?? 0));
  let head: string[] = [];
  let rows: string[][] = [];
  switch (kind) {
    case 'Pod':
      head = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])];
      rows = items.map((p) => {
        const v = cl.podView(p);
        return [p.metadata.name, `${v.ready ? 1 : 0}/1`, v.status, v.restarts ? `${v.restarts} (${age(Math.min(now - (cl.st.evals[p.metadata.uid ?? '']?.at ?? now), 10000))} ago)` : '0', ageOf(p), ...(wide ? [cl.podIp(p), cl.nodeOf(p), '<none>', '<none>'] : [])];
      });
      break;
    case 'Deployment':
      head = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])];
      rows = items.map((d) => {
        const s = o(d.status);
        const c = arr(o(o(o(d.spec).template).spec).containers);
        return [d.metadata.name, `${Number(s.readyReplicas ?? 0)}/${Number(o(d.spec).replicas ?? 1)}`, String(s.updatedReplicas ?? 0), String(s.availableReplicas ?? 0), ageOf(d), ...(wide ? [c.map((x) => str(x.name)).join(','), c.map((x) => str(x.image)).join(','), Object.entries(o(o(o(d.spec).selector).matchLabels)).map(([k, v]) => `${k}=${str(v)}`).join(',')] : [])];
      });
      break;
    case 'ReplicaSet':
      head = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])];
      rows = items.map((r) => {
        const c = arr(o(o(o(r.spec).template).spec).containers);
        return [r.metadata.name, String(o(r.spec).replicas ?? 0), String(o(r.status).replicas ?? 0), String(o(r.status).readyReplicas ?? 0), ageOf(r), ...(wide ? [c.map((x) => str(x.name)).join(','), c.map((x) => str(x.image)).join(','), Object.entries(o(o(o(r.spec).selector).matchLabels)).map(([k, v]) => `${k}=${str(v)}`).join(',')] : [])];
      });
      break;
    case 'Service':
      head = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : [])];
      rows = items.map((s) => [s.metadata.name, str(o(s.spec).type) || 'ClusterIP', s.metadata.name === 'kubernetes' ? '10.96.0.1' : cl.serviceIp(s), str(o(s.spec).type) === 'LoadBalancer' ? '<pending>' : '<none>', arr(o(s.spec).ports).map((p) => `${str(p.port)}${p.nodePort ? `:${str(p.nodePort)}` : ''}/${str(p.protocol) || 'TCP'}`).join(','), ageOf(s), ...(wide ? [Object.entries(o(o(s.spec).selector)).map(([k, v]) => `${k}=${str(v)}`).join(',') || '<none>'] : [])]);
      break;
    case 'ConfigMap':
      head = ['NAME', 'DATA', 'AGE'];
      rows = items.map((c) => [c.metadata.name, String(Object.keys(c.data ?? {}).length), ageOf(c)]);
      break;
    case 'Secret':
      head = ['NAME', 'TYPE', 'DATA', 'AGE'];
      rows = items.map((c) => [c.metadata.name, c.type ?? 'Opaque', String(Object.keys(c.data ?? {}).length), ageOf(c)]);
      break;
    case 'Namespace':
      head = ['NAME', 'STATUS', 'AGE'];
      rows = items.map((n) => [n.metadata.name, 'Active', ageOf(n)]);
      break;
    case 'Endpoints':
      head = ['NAME', 'ENDPOINTS', 'AGE'];
      rows = items.map((s) => {
        const eps = cl.endpoints(s).flatMap((p) => arr(o(s.spec).ports).map((sp) => `${cl.podIp(p)}:${cl.targetPort(s, sp, p)}`));
        return [s.metadata.name, eps.length ? eps.slice(0, 3).join(',') + (eps.length > 3 ? ` + ${eps.length - 3} more...` : '') : '<none>', ageOf(s)];
      });
      break;
  }
  if (allNs && kind !== 'Namespace' && kind !== 'Node') {
    head = ['NAMESPACE', ...head];
    rows = rows.map((r, i) => [items[i].metadata.namespace ?? '', ...r]);
  }
  if (showLabels) {
    head = [...head, 'LABELS'];
    rows = rows.map((r, i) => [...r, Object.entries(items[i].metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>']);
  }
  return { head, rows };
}

function podEvents(cl: Cluster, p: KObj): Array<[string, string, string, string, string]> {
  const ev = cl.st.evals[p.metadata.uid ?? ''];
  const c = arr(o(p.spec).containers)[0];
  const v = cl.podView(p);
  const a = age(cl.now - (p.metadata.creationTimestamp ?? 0));
  const out: Array<[string, string, string, string, string]> = [['Normal', 'Scheduled', a, 'default-scheduler', `Successfully assigned ${p.metadata.namespace}/${p.metadata.name} to ${cl.nodeOf(p)}`]];
  if (!ev) return out;
  if (ev.outcome === 'mount') {
    out.push(['Warning', 'FailedMount', a, 'kubelet', ev.message ?? '']);
    return out;
  }
  out.push(['Normal', 'Pulling', a, 'kubelet', `Pulling image "${str(c?.image)}"`]);
  if (ev.outcome === 'pull') {
    out.push(['Warning', 'Failed', a, 'kubelet', ev.message ?? ''], ['Warning', 'Failed', a, 'kubelet', 'Error: ErrImagePull'], ['Normal', 'BackOff', a, 'kubelet', `Back-off pulling image "${str(c?.image)}"`], ['Warning', 'Failed', a, 'kubelet', 'Error: ImagePullBackOff']);
    return out;
  }
  out.push(['Normal', 'Pulled', a, 'kubelet', `Successfully pulled image "${str(c?.image)}" in 1.2s (1.2s including waiting)`]);
  if (ev.outcome === 'config') {
    out.push(['Warning', 'Failed', a, 'kubelet', `Error: ${ev.message}`]);
    return out;
  }
  out.push(['Normal', 'Created', a, 'kubelet', `Created container ${str(c?.name)}`], ['Normal', 'Started', a, 'kubelet', `Started container ${str(c?.name)}`]);
  if (v.status === 'CrashLoopBackOff' || v.restarts) out.push(['Warning', 'BackOff', age(Math.min(cl.now - ev.at, 10000)), 'kubelet', `Back-off restarting failed container ${str(c?.name)} in pod ${p.metadata.name}_${p.metadata.namespace}(${p.metadata.uid})`]);
  if (v.message && ev.outcome === 'running') out.push(['Warning', 'Unhealthy', age(Math.min(cl.now - ev.at, 10000)), 'kubelet', v.message]);
  return out;
}

function describe(cl: Cluster, x: KObj, io: IO): void {
  const lines: string[] = [];
  const labels = (l?: Record<string, string>) => {
    const e = Object.entries(l ?? {});
    return e.length ? e.map(([k, v], i) => `${i ? ' '.repeat(18) : ''}${k}=${v}`).join('\n') : '<none>';
  };
  lines.push(`Name:             ${x.metadata.name}`);
  if (x.metadata.namespace) lines.push(`Namespace:        ${x.metadata.namespace}`);
  if (x.kind === 'Pod') {
    const v = cl.podView(x);
    const c = arr(o(x.spec).containers)[0] ?? {};
    const ev = cl.st.evals[x.metadata.uid ?? ''];
    lines.push(`Node:             ${cl.nodeOf(x)}/172.18.0.${cl.nodeOf(x) === 'lab-worker' ? 3 : 4}`, `Start Time:       ${new Date(x.metadata.creationTimestamp ?? 0).toUTCString()}`, `Labels:           ${labels(x.metadata.labels)}`, `Status:           ${v.phase}`, `IP:               ${cl.podIp(x)}`);
    if (x.metadata.ownerReferences?.length) lines.push(`Controlled By:    ${x.metadata.ownerReferences[0].kind}/${x.metadata.ownerReferences[0].name}`);
    lines.push('Containers:', `  ${str(c.name)}:`, `    Image:          ${str(c.image)}`);
    const ports = arr(c.ports);
    lines.push(`    Port:           ${ports.length ? ports.map((p) => `${str(p.containerPort)}/TCP`).join(', ') : '<none>'}`);
    if (c.command) lines.push('    Command:', ...arr(c.command).map((w) => `      ${str(w)}`));
    if (c.args) lines.push('    Args:', ...arr(c.args).map((w) => `      ${str(w)}`));
    if (v.status === 'Running') lines.push('    State:          Running', `      Started:      ${new Date(v.started ?? 0).toUTCString()}`);
    else if (v.reason) lines.push('    State:          Waiting', `      Reason:       ${v.reason}`);
    else lines.push('    State:          Terminated', `      Reason:       ${v.status}`, `      Exit Code:    ${ev?.exitCode ?? 0}`);
    if (v.lastState) lines.push('    Last State:     Terminated', `      Reason:       ${v.lastState}`, `      Exit Code:    ${v.lastState === 'OOMKilled' ? 137 : ev?.exitCode ?? 1}`);
    lines.push(`    Ready:          ${v.ready ? 'True' : 'False'}`, `    Restart Count:  ${v.restarts}`);
    const res = o(c.resources);
    if (res.limits) lines.push('    Limits:', ...Object.entries(o(res.limits)).map(([k, val]) => `      ${k}:  ${str(val)}`));
    if (res.requests) lines.push('    Requests:', ...Object.entries(o(res.requests)).map(([k, val]) => `      ${k}:  ${str(val)}`));
    const probe = (name: string, p: Obj) => {
      const g = o(p.httpGet);
      const kind = p.httpGet ? `http-get http://:${str(g.port)}${str(g.path) || '/'}` : p.tcpSocket ? `tcp-socket :${str(o(p.tcpSocket).port)}` : `exec [${arr(o(p.exec).command).map(str).join(' ')}]`;
      lines.push(`    ${name}:${' '.repeat(Math.max(1, 11 - name.length))}${kind} delay=${str(p.initialDelaySeconds ?? 0)}s timeout=${str(p.timeoutSeconds ?? 1)}s period=${str(p.periodSeconds ?? 10)}s #success=1 #failure=${str(p.failureThreshold ?? 3)}`);
    };
    if (c.livenessProbe) probe('Liveness', o(c.livenessProbe));
    if (c.readinessProbe) probe('Readiness', o(c.readinessProbe));
    lines.push('    Environment:');
    const env = arr(c.env);
    for (const ef of arr(c.envFrom)) lines.push(`      ${ef.configMapRef ? 'ConfigMap' : 'Secret'}  ${str(o(ef.configMapRef ?? ef.secretRef).name)}  Optional: false`);
    if (!env.length && !arr(c.envFrom).length) lines.push('      <none>');
    for (const e of env) {
      const vf = o(e.valueFrom);
      lines.push(`      ${str(e.name)}:  ${e.value !== undefined ? str(e.value) : vf.configMapKeyRef ? `<set to the key '${str(o(vf.configMapKeyRef).key)}' of config map '${str(o(vf.configMapKeyRef).name)}'>  Optional: false` : vf.secretKeyRef ? `<set to the key '${str(o(vf.secretKeyRef).key)}' in secret '${str(o(vf.secretKeyRef).name)}'>  Optional: false` : '<field ref>'}`);
    }
    lines.push('Conditions:', '  Type              Status', `  Initialized       True`, `  Ready             ${v.ready ? 'True' : 'False'}`, `  ContainersReady   ${v.ready ? 'True' : 'False'}`, `  PodScheduled      True`);
    lines.push('Events:', '  Type     Reason     Age   From               Message', '  ----     ------     ----  ----               -------');
    for (const [t, r, a, f, m] of podEvents(cl, x)) lines.push(`  ${t.padEnd(9)}${r.padEnd(11)}${a.padEnd(6)}${f.padEnd(19)}${m}`);
  } else if (x.kind === 'Deployment') {
    const s = o(x.status);
    const spec = o(x.spec);
    const c = arr(o(o(spec.template).spec).containers);
    lines.push(`CreationTimestamp:  ${new Date(x.metadata.creationTimestamp ?? 0).toUTCString()}`, `Labels:             ${labels(x.metadata.labels)}`, `Annotations:        ${Object.entries(x.metadata.annotations ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n                    ') || '<none>'}`, `Selector:           ${Object.entries(o(o(spec.selector).matchLabels)).map(([k, v]) => `${k}=${str(v)}`).join(',')}`, `Replicas:           ${str(spec.replicas ?? 1)} desired | ${str(s.updatedReplicas ?? 0)} updated | ${str(s.replicas ?? 0)} total | ${str(s.availableReplicas ?? 0)} available | ${str(s.unavailableReplicas ?? 0)} unavailable`, `StrategyType:       ${str(o(spec.strategy).type) || 'RollingUpdate'}`, `RollingUpdateStrategy:  ${str(o(o(spec.strategy).rollingUpdate).maxUnavailable ?? '25%')} max unavailable, ${str(o(o(spec.strategy).rollingUpdate).maxSurge ?? '25%')} max surge`, 'Pod Template:', `  Labels:  ${Object.entries(o(o(o(spec.template).metadata).labels)).map(([k, v]) => `${k}=${str(v)}`).join(',')}`, '  Containers:');
    for (const k of c) lines.push(`   ${str(k.name)}:`, `    Image:      ${str(k.image)}`, `    Port:       ${arr(k.ports).map((p) => `${str(p.containerPort)}/TCP`).join(', ') || '<none>'}`);
    lines.push('Conditions:', '  Type           Status  Reason', '  ----           ------  ------', ...arr(s.conditions).map((cd) => `  ${str(cd.type).padEnd(15)}${str(cd.status).padEnd(8)}${str(cd.reason)}`));
    const rss = cl.list('ReplicaSet', x.metadata.namespace).filter((r) => r.metadata.ownerReferences?.some((ow) => ow.uid === x.metadata.uid));
    const curHash = cl.templateHash(o(spec.template));
    lines.push(`OldReplicaSets:  ${rss.filter((r) => r.metadata.labels?.['pod-template-hash'] !== curHash && Number(o(r.spec).replicas) > 0).map((r) => `${r.metadata.name} (${str(o(r.status).replicas ?? 0)}/${str(o(r.spec).replicas)} replicas created)`).join(', ') || '<none>'}`, `NewReplicaSet:   ${rss.filter((r) => r.metadata.labels?.['pod-template-hash'] === curHash).map((r) => `${r.metadata.name} (${str(o(r.status).replicas ?? 0)}/${str(o(r.spec).replicas)} replicas created)`).join(', ') || '<none>'}`);
    lines.push('Events:', '  Type    Reason             Age   From                   Message', '  ----    ------             ----  ----                   -------');
    for (const e of cl.st.events.filter((e) => e.object === `deployment/${x.metadata.name}` && e.ns === x.metadata.namespace)) lines.push(`  ${e.type.padEnd(8)}${e.reason.padEnd(19)}${age(cl.now - e.at).padEnd(6)}deployment-controller  ${e.message}`);
  } else if (x.kind === 'Service') {
    const spec = o(x.spec);
    const eps = cl.endpoints(x);
    lines.push(`Labels:            ${labels(x.metadata.labels)}`, `Selector:          ${Object.entries(o(spec.selector)).map(([k, v]) => `${k}=${str(v)}`).join(',') || '<none>'}`, `Type:              ${str(spec.type) || 'ClusterIP'}`, `IP:                ${cl.serviceIp(x)}`);
    for (const p of arr(spec.ports)) lines.push(`Port:              ${str(p.name) || '<unset>'}  ${str(p.port)}/TCP`, `TargetPort:        ${str(p.targetPort ?? p.port)}/TCP`, ...(p.nodePort ? [`NodePort:          ${str(p.name) || '<unset>'}  ${str(p.nodePort)}/TCP`] : []), `Endpoints:         ${eps.map((e) => `${cl.podIp(e)}:${cl.targetPort(x, p, e)}`).join(',') || '<none>'}`);
    lines.push('Events:            <none>');
  } else if (x.kind === 'ConfigMap' || x.kind === 'Secret') {
    lines.push(`Labels:       ${labels(x.metadata.labels)}`, '');
    if (x.kind === 'Secret') lines.push(`Type:  ${x.type ?? 'Opaque'}`, '', 'Data', '====', ...Object.entries(x.data ?? {}).map(([k, v]) => `${k}:  ${unb64(v).length} bytes`));
    else lines.push('Data', '====', ...Object.entries(x.data ?? {}).flatMap(([k, v]) => [`${k}:`, '----', v.replace(/\n$/, ''), '']));
  } else {
    lines.push(`Labels:           ${labels(x.metadata.labels)}`);
  }
  io.out(lines.join('\n') + '\n');
}

/* ----------------------------------------------------------------------------- kubectl */

function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(n + '=')) return args[i].slice(n.length + 1);
      if (n.length === 2 && args[i].startsWith(n) && !args[i].startsWith('--') && args[i].length > 2) return args[i].slice(2);
    }
  }
  return undefined;
}
const flags = (args: string[], ...names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) for (const n of names) {
    if (args[i] === n) out.push(args[i + 1] ?? '');
    else if (args[i].startsWith(n + '=')) out.push(args[i].slice(n.length + 1));
  }
  return out;
};
const has = (args: string[], ...names: string[]) => args.some((a) => names.includes(a));
const VALUED = ['-n', '--namespace', '-o', '--output', '-l', '--selector', '-f', '--filename', '-c', '--container', '--image', '--replicas', '--port', '--target-port', '--type', '--name', '--from-literal', '--from-file', '--from-env-file', '--to-revision', '--timeout', '--for', '--tail', '--context', '--docker-server', '--docker-username', '--docker-password', '--docker-email', '--restart', '-p', '--patch', '--type', '--overrides', '--env', '--labels', '--field-selector', '--sort-by', '--kubeconfig', '--dry-run', '--protocol', '--cluster', '--user', '--current'];
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (VALUED.includes(a) && a !== '--current') i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const kubectl: Cmd = (args, io, ctx) => {
  if (!args.length || has(args, '--help', '-h') && args.length === 1) {
    io.out('kubectl controls the Kubernetes cluster manager.\n\nBasic Commands: create, expose, run, set, get, explain, edit, delete\nDeploy Commands: rollout, scale\nTroubleshooting: describe, logs, exec, port-forward, top, events\nAdvanced: apply, patch, wait\nSettings: label, annotate\nOther: config, version, cluster-info, api-resources\n');
    return 0;
  }
  const [verb, ...rest] = args;
  if (verb === 'version') {
    io.out('Client Version: v1.31.1\nKustomize Version: v5.4.2\n');
    if (has(rest, '--client')) return 0;
  }
  if (verb === 'config') return kubeConfig(ctx, rest, io);
  const nsFlag = flag(args, '-n', '--namespace');
  const k = currentKube(ctx, nsFlag);
  if ('error' in k) {
    io.err(k.error + '\n');
    return 1;
  }
  if (verb === 'version') {
    io.out('Server Version: v1.31.0\n');
    return 0;
  }
  const st = loadState(ctx, k.statePath);
  const cl = new Cluster(ctx, st);
  cl.reconcile();
  const save = (code = 0) => {
    cl.reconcile();
    saveState(ctx, k.statePath, st);
    return code;
  };
  const ns = k.namespace;
  const allNs = has(args, '-A', '--all-namespaces');
  if (!['create', 'apply'].includes(verb) && !allNs && !cl.get('Namespace', '', ns)) {
    io.err(`Error from server (NotFound): namespaces "${ns}" not found\n`);
    return 1;
  }
  const findRef = (ref: string, dfltKind?: string): KObj | { error: string } => {
    let [kindName, name] = ref.includes('/') ? ref.split('/') : [dfltKind ?? '', ref];
    const kd = kindOf(kindName);
    if (!kd) return { error: `error: the server doesn't have a resource type "${kindName}"` };
    const x = cl.get(kd.kind, ns, name);
    if (!x) return { error: `Error from server (NotFound): ${kd.plural} "${name}" not found` };
    return x;
  };
  const pos = positionals(rest);
  const output = flag(rest, '-o', '--output');
  switch (verb) {
    case 'cluster-info':
      io.out(`Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.\n`);
      return 0;
    case 'api-resources':
      io.out('NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND\nconfigmaps    cm           v1           true         ConfigMap\nendpoints     ep           v1           true         Endpoints\nevents        ev           v1           true         Event\nnamespaces    ns           v1           false        Namespace\nnodes         no           v1           false        Node\npods          po           v1           true         Pod\nsecrets                    v1           true         Secret\nservices      svc          v1           true         Service\ndeployments   deploy       apps/v1      true         Deployment\nreplicasets   rs           apps/v1      true         ReplicaSet\n');
      return 0;
    case 'get': {
      const what = pos[0];
      if (!what) {
        io.err('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples\n');
        return 1;
      }
      const sel = flag(rest, '-l', '--selector');
      const match = sel ? parseSelector(sel) : () => true;
      const kindsWanted = what === 'all' ? ['Pod', 'Service', 'Deployment', 'ReplicaSet'] : what.split(',').map((w) => (w.includes('/') ? w.split('/')[0] : w)).map((w) => kindOf(w)?.kind ?? '');
      if (kindsWanted.includes('')) {
        io.err(`error: the server doesn't have a resource type "${what.split(',').find((w) => !kindOf(w.split('/')[0]))}"\n`);
        return 1;
      }
      if (kindsWanted[0] === 'Node') {
        if (output?.startsWith('json')) {
          io.out(output.startsWith('jsonpath') ? jsonpath(output.split('=').slice(1).join('='), { items: ['lab-control-plane', 'lab-worker', 'lab-worker2'].map((n) => ({ metadata: { name: n } })) }) : JSON.stringify({ items: [] }) + '\n');
          return 0;
        }
        table(io, ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(output === 'wide' ? ['INTERNAL-IP', 'OS-IMAGE', 'CONTAINER-RUNTIME'] : [])], ['lab-control-plane', 'lab-worker', 'lab-worker2'].map((n, i) => [n, 'Ready', i ? '<none>' : 'control-plane', '12d', 'v1.31.0', ...(output === 'wide' ? [`172.18.0.${2 + i}`, 'Debian GNU/Linux 12 (bookworm)', 'containerd://1.7.18'] : [])]));
        return 0;
      }
      if (kindsWanted[0] === 'Event') {
        const evs = [...cl.st.events.filter((e) => allNs || e.ns === ns).map((e) => [age(cl.now - e.at), e.type, e.reason, e.object, e.message]), ...cl.list('Pod', allNs ? undefined : ns).flatMap((p) => podEvents(cl, p).map(([t, r, a, , m]) => [a, t, r, `pod/${p.metadata.name}`, m]))];
        if (!evs.length) {
          io.out(`No resources found in ${ns} namespace.\n`);
          return 0;
        }
        table(io, ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], evs);
        return 0;
      }
      const names = pos.slice(1).concat(what.includes('/') ? what.split(',').map((w) => w.split('/')[1]) : []);
      const results: Array<{ kind: string; items: KObj[] }> = [];
      for (const kind of kindsWanted) {
        const source = kind === 'Endpoints' ? cl.list('Service', allNs ? undefined : ns) : cl.list(kind, allNs ? undefined : ns);
        let items = source.filter((x) => match(x.metadata.labels));
        if (names.length) {
          const missing = names.find((n) => !items.some((x) => x.metadata.name === n));
          if (missing) {
            io.err(`Error from server (NotFound): ${KINDS[lower(kind)]?.plural ?? kind} "${missing}" not found\n`);
            return save(1);
          }
          items = items.filter((x) => names.includes(x.metadata.name));
        }
        results.push({ kind, items });
      }
      if (output && /^(json|yaml|jsonpath|name|custom-columns)/.test(output)) {
        const all = results.flatMap((r) => r.items.map((x) => (r.kind === 'Endpoints' ? { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: x.metadata.name, namespace: x.metadata.namespace }, subsets: [{ addresses: cl.endpoints(x).map((p) => ({ ip: cl.podIp(p), targetRef: { kind: 'Pod', name: p.metadata.name } })) }] } : objJson(cl, x))));
        const single = names.length === 1 && results.length === 1;
        const data = single ? all[0] : { apiVersion: 'v1', kind: 'List', items: all };
        if (output === 'name') for (const r of results) for (const x of r.items) io.out(`${resName(x)}\n`);
        else if (output === 'json') io.out(JSON.stringify(data, null, 4) + '\n');
        else if (output === 'yaml') io.out(dumpYaml(data as Yaml));
        else if (output.startsWith('jsonpath')) io.out(jsonpath(output.slice(output.indexOf('=') + 1), data));
        else if (output.startsWith('custom-columns')) {
          const cols = output.slice(output.indexOf('=') + 1).split(',').map((c) => c.split(':'));
          table(io, cols.map((c) => c[0]), all.map((x) => cols.map((c) => jsonpath(`{${c[1].startsWith('.') ? c[1] : '.' + c[1]}}`, x) || '<none>')));
        }
        return save();
      }
      let printed = false;
      for (const r of results) {
        if (!r.items.length) continue;
        const t = rowsFor(cl, r.kind, r.items, output === 'wide', allNs, has(rest, '--show-labels'));
        if (results.length > 1) t.rows = t.rows.map((row) => [`${lower(r.kind)}${['Deployment', 'ReplicaSet'].includes(r.kind) ? '.apps' : ''}/${row[0]}`, ...row.slice(1)]);
        if (printed) io.out('\n');
        table(io, t.head, t.rows);
        printed = true;
      }
      if (!printed) io.out(allNs ? 'No resources found\n' : `No resources found in ${ns} namespace.\n`);
      if (has(rest, '-w', '--watch')) io.out('(kubectl get -w keeps watching; the simulator shows the current state. Run the command again to see changes.)\n');
      return save();
    }
    case 'describe': {
      const target = pos[0];
      if (!target) {
        io.err('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.\n');
        return 1;
      }
      const refs = target.includes('/') ? [target] : pos.slice(1).length ? pos.slice(1).map((n) => `${target}/${n}`) : cl.list(kindOf(target)?.kind ?? '', ns).map((x) => `${target}/${x.metadata.name}`);
      let code = 0;
      refs.forEach((ref, i) => {
        const x = findRef(ref);
        if ('error' in x) {
          io.err(x.error + '\n');
          code = 1;
          return;
        }
        if (i) io.out('\n\n');
        describe(cl, x, io);
      });
      return save(code);
    }
    case 'apply':
    case 'create':
    case 'replace': {
      const files = flags(rest, '-f', '--filename');
      const dry = flag(rest, '--dry-run');
      if (verb === 'create' && !files.length) return save(createImperative(cl, ctx, ns, pos, rest, io, dry, output));
      if (!files.length) {
        io.err('error: must specify one of -f and -k\n');
        return 1;
      }
      let code = 0;
      for (const f of files) {
        const docs: Array<{ file: string; text: string }> = [];
        if (f === '-') docs.push({ file: 'STDIN', text: io.stdin });
        else {
          const path = abs(ctx, f);
          const l = lookup(ctx.sys.fs, path, actor(ctx));
          if (!l) {
            io.err(`error: the path "${f}" does not exist\n`);
            code = 1;
            continue;
          }
          if (l.node.type === 'dir') {
            for (const [n, c] of Object.entries(l.node.children).sort(([a], [b]) => a.localeCompare(b))) if (c.type === 'file' && /\.(ya?ml|json)$/.test(n)) docs.push({ file: `${f.replace(/\/$/, '')}/${n}`, text: c.content });
          } else if (l.node.type === 'file') docs.push({ file: f, text: l.node.content });
        }
        for (const d of docs) {
          let parsed: Yaml[];
          try {
            parsed = d.text.trim().startsWith('{') ? [JSON.parse(d.text)] : parseYamlAll(d.text);
          } catch (e) {
            io.err(`error: error parsing ${d.file}: error converting YAML to JSON: yaml: ${(e as Error).message}\n`);
            code = 1;
            continue;
          }
          for (const y of parsed) {
            if (!y || typeof y !== 'object' || Array.isArray(y)) continue;
            const obj = typed(y) as KObj;
            obj.metadata = { ...(obj.metadata ?? { name: '' }) };
            if (dry) {
              const err = validate(obj, d.file);
              if (err) {
                io.err(err + '\n');
                code = 1;
                continue;
              }
              if (output === 'yaml') io.out(dumpYaml(obj as unknown as Yaml) + '---\n');
              else io.out(`${resName(obj)} ${verb === 'apply' ? 'created' : 'created'} (dry run)\n`);
              continue;
            }
            const r = applyObject(cl, obj, nsFlag ?? (obj.metadata.namespace ? obj.metadata.namespace : ns), d.file, verb === 'replace' ? 'replace' : verb);
            if ('error' in r) {
              io.err(r.error + '\n');
              code = 1;
            } else io.out(`${resName(obj)} ${verb === 'replace' ? 'replaced' : r.verb}\n`);
          }
        }
      }
      if (verb === 'apply' && has(rest, '--prune')) io.err('(--prune is not simulated.)\n');
      return save(code);
    }
    case 'delete': {
      const files = flags(rest, '-f', '--filename');
      let code = 0;
      const targets: KObj[] = [];
      if (files.length) {
        for (const f of files) {
          try {
            for (const y of parseYamlAll(readFile(ctx.sys.fs, abs(ctx, f), actor(ctx)))) {
              const obj = typed(y) as KObj;
              const x = obj?.kind ? cl.get(obj.kind, obj.metadata?.namespace ?? ns, obj.metadata?.name ?? '') : undefined;
              if (x) targets.push(x);
              else if (obj?.kind) {
                io.err(`Error from server (NotFound): error when deleting "${f}": ${KINDS[lower(obj.kind)]?.plural ?? obj.kind} "${obj.metadata?.name}" not found\n`);
                code = 1;
              }
            }
          } catch {
            io.err(`error: the path "${f}" does not exist\n`);
            return 1;
          }
        }
      } else {
        const [what, ...names] = pos;
        if (!what) {
          io.err('error: resource(s) were provided, but no name was specified\n');
          return 1;
        }
        const refs = what.includes('/') ? [what, ...names] : names.map((n) => `${what}/${n}`);
        if (has(rest, '--all') && !what.includes('/')) for (const x of cl.list(kindOf(what)?.kind ?? '', ns)) targets.push(x);
        for (const r of refs) {
          const x = findRef(r);
          if ('error' in x) {
            io.err(x.error + '\n');
            code = 1;
          } else targets.push(x);
        }
      }
      for (const x of targets) {
        if (x.kind === 'Namespace' && ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(x.metadata.name)) {
          io.err(`Error from server (Forbidden): namespaces "${x.metadata.name}" is forbidden: this namespace may not be deleted\n`);
          code = 1;
          continue;
        }
        if (x.kind === 'Namespace') for (const y of st.objects.filter((o2) => o2.metadata.namespace === x.metadata.name)) cl.remove(y);
        cl.remove(x);
        io.out(`${lower(x.kind)}${x.apiVersion === 'apps/v1' ? '.apps' : ''} "${x.metadata.name}" deleted\n`);
      }
      return save(code);
    }
    case 'scale': {
      const replicas = flag(rest, '--replicas');
      const ref = pos[0]?.includes('/') ? pos[0] : `${pos[0]}/${pos[1]}`;
      const x = findRef(ref ?? '');
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      if (replicas === undefined || !/^\d+$/.test(replicas)) {
        io.err('error: required flag(s) "replicas" not set\n');
        return 1;
      }
      x.spec = { ...o(x.spec), replicas: Number(replicas) };
      io.out(`${resName(x)} scaled\n`);
      return save();
    }
    case 'set': {
      if (pos[0] !== 'image' && pos[0] !== 'env') {
        io.err(`error: unknown command "set ${pos[0] ?? ''}"\n`);
        return 1;
      }
      const ref = pos[1]?.includes('/') ? pos[1] : `deployment/${pos[1]}`;
      const x = findRef(ref ?? '');
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      const cs = arr(o(o(o(x.spec).template).spec).containers);
      if (pos[0] === 'image') {
        for (const pair of pos.slice(2)) {
          const [cn, img] = pair.split('=');
          const c = cn === '*' ? cs : cs.filter((k) => str(k.name) === cn);
          if (!c.length) {
            io.err(`error: unable to find container named "${cn}"\n`);
            return 1;
          }
          for (const k of c) k.image = img;
        }
      } else {
        for (const pair of pos.slice(2)) {
          const [kk, ...vv] = pair.split('=');
          for (const c of cs) {
            const env = arr(c.env).filter((e) => str(e.name) !== kk.replace(/-$/, ''));
            if (!kk.endsWith('-')) env.push({ name: kk, value: vv.join('=') });
            c.env = env;
          }
        }
      }
      x.metadata.generation = (x.metadata.generation ?? 1) + 1;
      io.out(`${resName(x)} ${pos[0] === 'image' ? 'image' : 'env'} updated\n`);
      return save();
    }
    case 'annotate':
    case 'label': {
      const ref = pos[0]?.includes('/') ? pos[0] : `${pos[0]}/${pos[1]}`;
      const x = findRef(ref ?? '');
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      const pairs = pos.slice(pos[0]?.includes('/') ? 1 : 2);
      const field = verb === 'label' ? 'labels' : 'annotations';
      const m = { ...(x.metadata[field] ?? {}) };
      for (const p of pairs) {
        if (p.endsWith('-')) delete m[p.slice(0, -1)];
        else {
          const [kk, ...vv] = p.split('=');
          if (m[kk] !== undefined && !has(rest, '--overwrite')) {
            io.err(`error: '${kk}' already has a value (${m[kk]}), and --overwrite is false\n`);
            return 1;
          }
          m[kk] = vv.join('=');
        }
      }
      x.metadata[field] = m;
      io.out(`${resName(x)} ${verb === 'label' ? 'labeled' : 'annotated'}\n`);
      return save();
    }
    case 'expose': {
      const ref = pos[0]?.includes('/') ? pos[0] : `${pos[0]}/${pos[1]}`;
      const x = findRef(ref ?? '');
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      const port = flag(rest, '--port');
      const containerPort = arr(o(o(o(x.spec).template).spec).containers)[0];
      const p = port ?? str(arr(containerPort?.ports)[0]?.containerPort);
      if (!p) {
        io.err(`error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples\n`);
        return 1;
      }
      const sel = x.kind === 'Deployment' ? o(o(x.spec).selector).matchLabels : x.metadata.labels;
      const svc: KObj = { apiVersion: 'v1', kind: 'Service', metadata: { name: flag(rest, '--name') ?? x.metadata.name, namespace: ns, labels: x.metadata.labels }, spec: { type: flag(rest, '--type') ?? 'ClusterIP', selector: sel as Obj, ports: [{ port: Number(p), targetPort: Number(flag(rest, '--target-port') ?? p), protocol: 'TCP' }] } };
      const r = applyObject(cl, svc, ns, 'expose', 'create');
      if ('error' in r) {
        io.err(r.error.replace(/error when creating "expose": /, '') + '\n');
        return 1;
      }
      io.out(`service/${svc.metadata.name} exposed\n`);
      return save();
    }
    case 'rollout':
      return save(rollout(cl, ns, pos, rest, io, findRef));
    case 'logs': {
      let ref = pos[0] ?? '';
      if (!ref) {
        io.err('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\n');
        return 1;
      }
      let pod: KObj | undefined;
      if (ref.includes('/') && !ref.startsWith('pod/') && !ref.startsWith('pods/')) {
        const x = findRef(ref);
        if ('error' in x) {
          io.err(x.error + '\n');
          return 1;
        }
        const sel = o(o(x.spec).selector);
        const ml = (x.kind === 'Service' ? sel : o(sel.matchLabels)) as Record<string, string>;
        pod = cl.list('Pod', ns).filter((p) => labelsMatch(ml, p.metadata.labels)).sort((a, b) => Number(cl.podView(b).ready) - Number(cl.podView(a).ready))[0];
        if (!pod) {
          io.err(`error: no pods found for ${ref}\n`);
          return 1;
        }
        if (cl.list('Pod', ns).filter((p) => labelsMatch(ml, p.metadata.labels)).length > 1) io.err(`Found ${cl.list('Pod', ns).filter((p) => labelsMatch(ml, p.metadata.labels)).length} pods, using pod/${pod.metadata.name}\n`);
      } else {
        ref = ref.replace(/^pods?\//, '');
        pod = cl.get('Pod', ns, ref);
        if (!pod) {
          io.err(`Error from server (NotFound): pods "${ref}" not found\n`);
          return 1;
        }
      }
      const ev = st.evals[pod.metadata.uid ?? ''];
      const v = cl.podView(pod);
      if (!ev || ['pull', 'config', 'mount'].includes(ev.outcome)) {
        io.err(`Error from server (BadRequest): container "${str(arr(o(pod.spec).containers)[0]?.name)}" in pod "${pod.metadata.name}" is waiting to start: ${v.status === 'ImagePullBackOff' || v.status === 'ErrImagePull' ? 'trying and failing to pull image' : v.status === 'CreateContainerConfigError' ? 'CreateContainerConfigError' : 'ContainerCreating'}\n`);
        return 1;
      }
      const tail = flag(rest, '--tail');
      const ls = tail && tail !== '-1' ? ev.logs.slice(-Number(tail)) : ev.logs;
      for (const l of ls) io.out(l + '\n');
      if (has(rest, '-f', '--follow')) io.out('(kubectl logs -f would keep following; the simulator returns.)\n');
      return save();
    }
    case 'exec': {
      const dash = rest.indexOf('--');
      const before = dash >= 0 ? rest.slice(0, dash) : rest;
      const cmd = dash >= 0 ? rest.slice(dash + 1) : positionals(rest).slice(1);
      let ref = positionals(before)[0] ?? '';
      if (ref.includes('/') && !ref.startsWith('pod')) {
        const x = findRef(ref);
        if ('error' in x) {
          io.err(x.error + '\n');
          return 1;
        }
        const ml = o(o(x.spec).selector).matchLabels as Record<string, string>;
        const p = cl.list('Pod', ns).find((pp) => labelsMatch(ml, pp.metadata.labels) && cl.podView(pp).status === 'Running');
        ref = p?.metadata.name ?? '';
      }
      ref = ref.replace(/^pods?\//, '');
      const pod = cl.get('Pod', ns, ref);
      if (!pod) {
        io.err(`Error from server (NotFound): pods "${ref}" not found\n`);
        return 1;
      }
      const ev = st.evals[pod.metadata.uid ?? ''];
      if (!ev?.container || ev.outcome !== 'running') {
        io.err(`error: unable to upgrade connection: container not found ("${str(arr(o(pod.spec).containers)[0]?.name)}")\n`);
        return 1;
      }
      if (!cmd.length) {
        io.err('error: you must specify at least one command for the container\n');
        return 1;
      }
      if (has(before, '-it', '-ti') && cmd.length === 1 && /sh$/.test(cmd[0])) {
        io.out(`(You would now be inside ${pod.metadata.name}'s shell. The simulator does not keep interactive sessions: run commands with kubectl exec ${pod.metadata.name} -- COMMAND.)\n`);
        return 0;
      }
      const view = cl.clusterView();
      const dst: DockerState = { ...view.st, containers: [...view.st.containers.filter((x) => x.id !== ev.container!.id), ev.container], images: [...view.st.images, ...(ev.image ? [ev.image] : [])] };
      try {
        const box = openBox(ctx, dst, ev.image!, ev.container, { peers: view.peers(ns), hostname: pod.metadata.name, ip: cl.podIp(pod) });
        const r = runInBox(box, cmd.map(shq).join(' '), { out: io.out, err: io.err, stdin: has(before, '-i', '-it', '-ti') ? io.stdin : '' });
        box.finish('container');
        if (r.out.startsWith('__OCI__')) {
          io.err(`error: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec: OCI runtime exec failed: exec failed: unable to start container process: ${r.out.slice(7)}: unknown\n`);
          return save(126);
        }
        if (r.code) io.err(`command terminated with exit code ${r.code}\n`);
        return save(r.code);
      } catch (e) {
        if (e instanceof BoxError) {
          io.err(`error: ${e.message}\n`);
          return 1;
        }
        throw e;
      }
    }
    case 'run': {
      const name = pos[0];
      const image = flag(rest, '--image');
      if (!name || !image) {
        io.err('error: NAME and --image are required for run\n');
        return 1;
      }
      if (cl.get('Pod', ns, name)) {
        io.err(`Error from server (AlreadyExists): pods "${name}" already exists\n`);
        return 1;
      }
      const dash = rest.indexOf('--');
      const cmd = dash >= 0 ? rest.slice(dash + 1) : [];
      const envs = flags(rest, '--env').map((e) => ({ name: e.split('=')[0], value: e.split('=').slice(1).join('=') }));
      const pod: KObj = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels: { run: name } }, spec: { restartPolicy: flag(rest, '--restart') ?? 'Always', containers: [{ name, image, ...(cmd.length ? (has(rest, '--command') ? { command: cmd } : { args: cmd }) : {}), ...(envs.length ? { env: envs } : {}), ...(flag(rest, '--port') ? { ports: [{ containerPort: Number(flag(rest, '--port')) }] } : {}) }] } };
      if (flag(rest, '--dry-run')) {
        io.out(output === 'yaml' ? dumpYaml(pod as unknown as Yaml) : `pod/${name} created (dry run)\n`);
        return 0;
      }
      const r = applyObject(cl, pod, ns, 'run', 'create');
      if ('error' in r) {
        io.err(r.error + '\n');
        return 1;
      }
      const created = cl.get('Pod', ns, name)!;
      const attach = has(rest, '-it', '-ti', '-i', '--attach') || (has(rest, '--rm') && has(rest, '-t'));
      if (attach) {
        const ev = st.evals[created.metadata.uid ?? ''];
        if (ev && ['pull', 'config', 'mount'].includes(ev.outcome)) io.err(`error: timed out waiting for the condition\n(${ev.message})\n`);
        else for (const l of ev?.logs ?? []) io.out(l + '\n');
        if (has(rest, '--rm')) {
          cl.remove(created);
          io.out(`pod "${name}" deleted\n`);
        }
        return save(ev?.outcome === 'crash' ? ev.exitCode ?? 1 : 0);
      }
      io.out(`pod/${name} created\n`);
      return save();
    }
    case 'port-forward': {
      const target = pos[0] ?? '';
      const ports = pos.slice(1);
      if (!target || !ports.length) {
        io.err('error: TYPE/NAME and list of ports are required for port-forward\n');
        return 1;
      }
      const ref = target.includes('/') ? target : `pod/${target}`;
      const x = findRef(ref);
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      for (const p of ports) {
        const [local, remote] = p.includes(':') ? p.split(':') : [p, p];
        const lp = Number(local);
        if (Object.values(ctx.sys.services).some((s) => s.active && s.port === lp)) {
          io.err(`Unable to listen on port ${lp}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${lp}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${lp} ${remote}}]\n`);
          return 1;
        }
        st.forwards = st.forwards.filter((f) => f.local !== lp);
        st.forwards.push({ local: lp, ns, target: `${x.kind}/${x.metadata.name}`, port: Number(remote) });
        io.out(`Forwarding from 127.0.0.1:${lp} -> ${remote}\nForwarding from [::1]:${lp} -> ${remote}\n`);
      }
      io.out('(kubectl port-forward runs until Ctrl+C. Here it keeps forwarding in the background so you can use other commands; a new port-forward on the same local port replaces it.)\n');
      return save();
    }
    case 'top': {
      if (pos[0] === 'nodes' || pos[0] === 'node' || pos[0] === 'no') {
        table(io, ['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%'], [['lab-control-plane', '180m', '4%', '812Mi', '20%'], ['lab-worker', '95m', '2%', '540Mi', '13%'], ['lab-worker2', '88m', '2%', '501Mi', '12%']]);
        return 0;
      }
      const pods = cl.list('Pod', ns).filter((p) => cl.podView(p).status === 'Running');
      if (!pods.length) {
        io.err(`No resources found in ${ns} namespace.\n`);
        return 1;
      }
      table(io, ['NAME', 'CPU(cores)', 'MEMORY(bytes)'], pods.map((p) => [p.metadata.name, `${1 + (parseInt(hex(p.metadata.name, 2), 16) % 9)}m`, `${st.evals[p.metadata.uid ?? '']?.image?.memMb ?? findImage({ images: [], containers: [], volumes: [], networks: [] }, '')?.memMb ?? 12}Mi`]));
      return 0;
    }
    case 'wait': {
      const cond = flag(rest, '--for') ?? '';
      const timeout = Number(/^(\d+)s?$/.exec(flag(rest, '--timeout') ?? '30s')?.[1] ?? 30) * 1000;
      const ref = pos[0] ?? '';
      const x = findRef(ref.includes('/') ? ref : `${ref}/${pos[1] ?? ''}`);
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      const met = () => {
        if (cond === 'delete') return !cl.get(x.kind, ns, x.metadata.name);
        const m = /^condition=(\w+)(?:=(\w+))?$/i.exec(cond);
        if (!m) return false;
        if (x.kind === 'Pod') return m[1].toLowerCase() === 'ready' && cl.podView(x).ready;
        return arr(o(x.status).conditions).some((c) => str(c.type).toLowerCase() === m[1].toLowerCase() && str(c.status) === (m[2] ?? 'True'));
      };
      const end = ctx.sys.now + timeout;
      while (!met() && ctx.sys.now < end) {
        ctx.sys.now += 2000;
        cl.reconcile();
      }
      if (met()) {
        io.out(`${resName(x)} condition met\n`);
        return save();
      }
      io.err(`error: timed out waiting for the condition on ${KINDS[lower(x.kind)].plural}/${x.metadata.name}\n`);
      return save(1);
    }
    case 'patch': {
      const ref = pos[0]?.includes('/') ? pos[0] : `${pos[0]}/${pos[1]}`;
      const x = findRef(ref ?? '');
      if ('error' in x) {
        io.err(x.error + '\n');
        return 1;
      }
      let patch: Obj;
      try {
        patch = JSON.parse(flag(rest, '-p', '--patch') ?? '{}');
      } catch {
        io.err('error: unable to parse "' + (flag(rest, '-p', '--patch') ?? '') + '": yaml: did not find expected node content\n');
        return 1;
      }
      const mergeP = (a: Obj, b: Obj): Obj => {
        const out: Obj = { ...a };
        for (const [kk, v] of Object.entries(b)) {
          if (v === null) delete out[kk];
          else if (Array.isArray(v) && kk === 'containers' && Array.isArray(a[kk])) out[kk] = (a[kk] as Obj[]).map((c) => {
            const m = (v as Obj[]).find((p) => p.name === c.name);
            return m ? mergeP(c, m) : c;
          });
          else if (v && typeof v === 'object' && !Array.isArray(v)) out[kk] = mergeP(o(a[kk]), v as Obj);
          else out[kk] = v;
        }
        return out;
      };
      const merged = mergeP(x as unknown as Obj, patch) as unknown as KObj;
      Object.assign(x, merged);
      io.out(`${resName(x)} patched\n`);
      return save();
    }
    case 'events':
      return kubectl(['get', 'events', ...rest], io, ctx);
    case 'explain':
      io.out(`KIND:       ${kindOf(pos[0]?.split('.')[0] ?? '')?.kind ?? pos[0]}\nVERSION:    ${kindOf(pos[0]?.split('.')[0] ?? '')?.api ?? 'v1'}\n\n(The simulator does not include the API reference; see https://kubernetes.io/docs/reference/kubernetes-api/)\n`);
      return 0;
    default:
      io.err(`error: unknown command "${verb}" for "kubectl"\n`);
      return 1;
  }
};

function createImperative(cl: Cluster, ctx: Ctx, ns: string, pos: string[], rest: string[], io: IO, dry: string | undefined, output: string | undefined): number {
  const [what, sub, name0] = pos;
  const emit = (obj: KObj) => {
    if (dry) {
      if (output === 'yaml') io.out(dumpYaml(obj as unknown as Yaml));
      else if (output === 'json') io.out(JSON.stringify(obj, null, 4) + '\n');
      else io.out(`${resName(obj)} created (dry run)\n`);
      return 0;
    }
    const r = applyObject(cl, obj, ns, what, 'create');
    if ('error' in r) {
      io.err(r.error.replace(/error when creating "[^"]*": /, '') + '\n');
      return 1;
    }
    io.out(`${resName(obj)} created\n`);
    return 0;
  };
  const readFrom = (spec: string): [string, string] | null => {
    const [key, path] = spec.includes('=') ? spec.split('=') : [spec.split('/').pop()!, spec];
    try {
      return [key, readFile(ctx.sys.fs, abs(ctx, path), actor(ctx))];
    } catch {
      io.err(`error: open ${path}: no such file or directory\n`);
      return null;
    }
  };
  switch (what) {
    case 'namespace':
    case 'ns':
      return emit({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: sub } });
    case 'deployment':
    case 'deploy': {
      const image = flag(rest, '--image');
      if (!sub || !image) {
        io.err('error: required flag(s) "image" not set\n');
        return 1;
      }
      const port = flag(rest, '--port');
      const replicas = Number(flag(rest, '--replicas') ?? 1);
      const cname = image.split('/').pop()!.split(':')[0].split('@')[0];
      return emit({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: sub, namespace: dry ? undefined : ns, labels: { app: sub } }, spec: { replicas, selector: { matchLabels: { app: sub } }, template: { metadata: { labels: { app: sub } }, spec: { containers: [{ name: cname, image, ...(port ? { ports: [{ containerPort: Number(port) }] } : {}) }] } } } });
    }
    case 'configmap':
    case 'cm': {
      const data: Record<string, string> = {};
      for (const l of flags(rest, '--from-literal')) data[l.split('=')[0]] = l.split('=').slice(1).join('=');
      for (const f of flags(rest, '--from-file')) {
        const r = readFrom(f);
        if (!r) return 1;
        data[r[0]] = r[1];
      }
      for (const f of flags(rest, '--from-env-file')) {
        const r = readFrom(f);
        if (!r) return 1;
        for (const line of r[1].split('\n')) {
          const m = /^\s*([\w.-]+)\s*=(.*)$/.exec(line);
          if (m && !line.trim().startsWith('#')) data[m[1]] = m[2];
        }
      }
      return emit({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: sub }, data });
    }
    case 'secret': {
      if (sub === 'docker-registry') {
        const server = flag(rest, '--docker-server') ?? 'https://index.docker.io/v1/';
        const user = flag(rest, '--docker-username') ?? '';
        const pass = flag(rest, '--docker-password') ?? '';
        if (!user || !pass) {
          io.err('error: either --from-file or the combination of --docker-username, --docker-password and --docker-server is required\n');
          return 1;
        }
        return emit({ apiVersion: 'v1', kind: 'Secret', metadata: { name: name0 }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': b64(JSON.stringify({ auths: { [server]: { username: user, password: pass, auth: b64(`${user}:${pass}`) } } })) } });
      }
      if (sub !== 'generic' && sub !== 'tls') {
        io.err(`error: unknown command "secret ${sub ?? ''}"\n`);
        return 1;
      }
      const data: Record<string, string> = {};
      for (const l of flags(rest, '--from-literal')) data[l.split('=')[0]] = b64(l.split('=').slice(1).join('='));
      for (const f of flags(rest, '--from-file')) {
        const r = readFrom(f);
        if (!r) return 1;
        data[r[0]] = b64(r[1]);
      }
      for (const f of flags(rest, '--from-env-file')) {
        const r = readFrom(f);
        if (!r) return 1;
        for (const line of r[1].split('\n')) {
          const m = /^\s*([\w.-]+)\s*=(.*)$/.exec(line);
          if (m && !line.trim().startsWith('#')) data[m[1]] = b64(m[2]);
        }
      }
      return emit({ apiVersion: 'v1', kind: 'Secret', metadata: { name: name0 }, type: 'Opaque', data });
    }
    default:
      io.err(`error: unknown command "create ${what ?? ''}"\nUse create -f FILE, or create deployment|configmap|secret|namespace\n`);
      return 1;
  }
}

function rollout(cl: Cluster, ns: string, pos: string[], rest: string[], io: IO, findRef: (ref: string, dflt?: string) => KObj | { error: string }): number {
  const [sub, refRaw, nameMaybe] = pos;
  const ref = refRaw?.includes('/') ? refRaw : `${refRaw}/${nameMaybe ?? ''}`;
  const d = findRef(ref ?? '');
  if ('error' in d) {
    io.err(d.error + '\n');
    return 1;
  }
  if (d.kind !== 'Deployment') {
    io.err(`error: no rollout ${sub} for ${lower(d.kind)} "${d.metadata.name}"\n`);
    return 1;
  }
  const rss = () => cl.list('ReplicaSet', ns).filter((r) => r.metadata.ownerReferences?.some((ow) => ow.uid === d.metadata.uid));
  const rev = (rs: KObj) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
  switch (sub) {
    case 'status': {
      const timeoutText = flag(rest, '--timeout');
      const timeout = timeoutText ? Number(/^(\d+)/.exec(timeoutText)?.[1] ?? 0) * (timeoutText.endsWith('m') ? 60000 : 1000) : Infinity;
      const start = cl.now;
      const replicas = Number(o(d.spec).replicas ?? 1);
      let lastMsg = '';
      for (;;) {
        cl.reconcile();
        const s = o(d.status);
        const prog = arr(s.conditions).find((c) => str(c.type) === 'Progressing');
        if (str(prog?.reason) === 'NewReplicaSetAvailable') {
          io.out(`deployment "${d.metadata.name}" successfully rolled out\n`);
          return 0;
        }
        if (str(prog?.reason) === 'ProgressDeadlineExceeded') {
          io.err(`error: deployment "${d.metadata.name}" exceeded its progress deadline\n`);
          return 1;
        }
        const updated = Number(s.updatedReplicas ?? 0);
        const total = Number(s.replicas ?? 0);
        const available = Number(s.availableReplicas ?? 0);
        const msg = updated < replicas ? `Waiting for deployment "${d.metadata.name}" rollout to finish: ${updated} out of ${replicas} new replicas have been updated...` : total > updated ? `Waiting for deployment "${d.metadata.name}" rollout to finish: ${total - updated} old replicas are pending termination...` : `Waiting for deployment "${d.metadata.name}" rollout to finish: ${available} of ${replicas} updated replicas are available...`;
        if (msg !== lastMsg) io.out(msg + '\n');
        lastMsg = msg;
        if (cl.now - start >= timeout) {
          io.err('error: timed out waiting for the condition\n');
          return 1;
        }
        cl.ctx.sys.now += Math.min(15000, timeout === Infinity ? 15000 : Math.max(1000, timeout / 4));
      }
    }
    case 'history': {
      const list = rss().sort((a, b) => rev(a) - rev(b));
      const want = flag(rest, '--revision');
      if (want) {
        const r = list.find((x) => rev(x) === Number(want));
        if (!r) {
          io.err(`error: unable to find the specified revision\n`);
          return 1;
        }
        const c = arr(o(o(o(r.spec).template).spec).containers);
        io.out(`deployment.apps/${d.metadata.name} with revision #${want}\nPod Template:\n  Labels:\t${Object.entries(o(o(o(r.spec).template).metadata).labels as Obj).map(([k, v]) => `${k}=${str(v)}`).join('\n\t')}\n${r.metadata.annotations?.['kubernetes.io/change-cause'] ? `  Annotations:\tkubernetes.io/change-cause: ${r.metadata.annotations['kubernetes.io/change-cause']}\n` : ''}  Containers:\n${c.map((k) => `   ${str(k.name)}:\n    Image:\t${str(k.image)}\n`).join('')}`);
        return 0;
      }
      io.out(`deployment.apps/${d.metadata.name} \nREVISION  CHANGE-CAUSE\n${list.map((r) => `${String(rev(r)).padEnd(10)}${r.metadata.annotations?.['kubernetes.io/change-cause'] ?? '<none>'}`).join('\n')}\n\n`);
      return 0;
    }
    case 'undo': {
      const list = rss().sort((a, b) => rev(b) - rev(a));
      const to = flag(rest, '--to-revision');
      const curHash = cl.templateHash(o(o(d.spec).template));
      const target = to ? list.find((r) => rev(r) === Number(to)) : list.find((r) => r.metadata.labels?.['pod-template-hash'] !== curHash);
      if (!target) {
        io.err(to ? `error: unable to find specified revision ${to} in history\n` : `error: no rollout history found for deployment "${d.metadata.name}"\n`);
        return 1;
      }
      if (target.metadata.labels?.['pod-template-hash'] === curHash) {
        io.out(`deployment.apps/${d.metadata.name} skipped rollback (current template already matches revision ${to})\n`);
        return 0;
      }
      const t = structuredClone(o(o(target.spec).template));
      d.spec = { ...o(d.spec), template: t };
      const cause = target.metadata.annotations?.['kubernetes.io/change-cause'];
      if (cause) d.metadata.annotations = { ...(d.metadata.annotations ?? {}), 'kubernetes.io/change-cause': cause };
      else if (d.metadata.annotations) delete d.metadata.annotations['kubernetes.io/change-cause'];
      d.metadata.generation = (d.metadata.generation ?? 1) + 1;
      io.out(`deployment.apps/${d.metadata.name} rolled back\n`);
      return 0;
    }
    case 'restart': {
      const t = o(o(d.spec).template);
      const meta = o(t.metadata);
      meta.annotations = { ...o(meta.annotations), 'kubectl.kubernetes.io/restartedAt': new Date(cl.now).toISOString().replace(/\.\d+Z$/, 'Z') };
      t.metadata = meta;
      d.metadata.generation = (d.metadata.generation ?? 1) + 1;
      io.out(`deployment.apps/${d.metadata.name} restarted\n`);
      return 0;
    }
    case 'pause':
    case 'resume':
      io.out(`deployment.apps/${d.metadata.name} ${sub}d\n`);
      return 0;
  }
  io.err(`error: unknown command "rollout ${sub ?? ''}"\n`);
  return 1;
}

function kubeConfig(ctx: Ctx, args: string[], io: IO): number {
  const k = readKubeconfig(ctx);
  const [sub, ...rest] = args;
  if (!k) {
    if (sub === 'view') {
      io.out('apiVersion: v1\nclusters: null\ncontexts: null\ncurrent-context: ""\nkind: Config\nusers: null\n');
      return 0;
    }
    io.err(`error: current-context is not set\n`);
    return 1;
  }
  switch (sub) {
    case 'current-context':
      io.out(str(k.doc['current-context']) + '\n');
      return 0;
    case 'get-contexts': {
      const cur = str(k.doc['current-context']);
      table(io, ['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], arr(k.doc.contexts).map((c) => [str(c.name) === cur ? '*' : '', str(c.name), str(o(c.context).cluster), str(o(c.context).user), str(o(c.context).namespace)]));
      return 0;
    }
    case 'use-context': {
      const name = rest[0];
      if (!arr(k.doc.contexts).some((c) => str(c.name) === name)) {
        io.err(`error: no context exists with the name: "${name}"\n`);
        return 1;
      }
      k.doc['current-context'] = name;
      writeKubeconfig(ctx, k.path, k.doc);
      io.out(`Switched to context "${name}".\n`);
      return 0;
    }
    case 'set-context': {
      const name = has(rest, '--current') ? str(k.doc['current-context']) : positionals(rest)[0];
      const c = arr(k.doc.contexts).find((x) => str(x.name) === name);
      const nsv = flag(rest, '--namespace', '-n');
      if (!c) {
        const fresh = { name, context: { cluster: flag(rest, '--cluster') ?? '', user: flag(rest, '--user') ?? '', ...(nsv ? { namespace: nsv } : {}) } };
        k.doc.contexts = [...arr(k.doc.contexts), fresh];
        io.out(`Context "${name}" created.\n`);
      } else {
        c.context = { ...o(c.context), ...(nsv ? { namespace: nsv } : {}), ...(flag(rest, '--cluster') ? { cluster: flag(rest, '--cluster') } : {}) };
        io.out(`Context "${name}" modified.\n`);
      }
      writeKubeconfig(ctx, k.path, k.doc);
      return 0;
    }
    case 'view': {
      const redacted = structuredClone(k.doc);
      for (const u of arr(redacted.users)) for (const kk of Object.keys(o(u.user))) if (/data|token/.test(kk)) (u.user as Obj)[kk] = has(rest, '--raw') ? (u.user as Obj)[kk] : 'DATA+OMITTED';
      for (const c of arr(redacted.clusters)) if (o(c.cluster)['certificate-authority-data']) (c.cluster as Obj)['certificate-authority-data'] = 'DATA+OMITTED';
      io.out(dumpYaml(redacted as Yaml));
      return 0;
    }
  }
  io.err(`error: unknown command "config ${sub ?? ''}"\n`);
  return 1;
}

/* ----------------------------------------------------------------------------- port-forward over HTTP */

HTTP_PROVIDERS.push((ctx, port, path) => {
  const k = currentKube(ctx);
  if ('error' in k) return null;
  let st: K8sState;
  try {
    st = loadState(ctx, k.statePath);
  } catch {
    return null;
  }
  const f = st.forwards.find((x) => x.local === port);
  if (!f) return null;
  const cl = new Cluster(ctx, st);
  cl.reconcile();
  const [kind, name] = f.target.split('/');
  const x = cl.get(kind, f.ns, name);
  let pod: KObj | undefined;
  let targetPort = f.port;
  if (x?.kind === 'Pod') pod = x;
  else if (x?.kind === 'Service') {
    pod = cl.endpoints(x)[0];
    const sp = arr(o(x.spec).ports).find((p) => Number(p.port) === f.port);
    if (sp && pod) targetPort = cl.targetPort(x, sp, pod);
  } else if (x?.kind === 'Deployment') pod = cl.list('Pod', f.ns).find((p) => labelsMatch(o(o(x.spec).selector).matchLabels as Record<string, string>, p.metadata.labels) && cl.podView(p).ready);
  saveState(ctx, k.statePath, st);
  const ev = pod ? st.evals[pod.metadata.uid ?? ''] : undefined;
  if (!ev?.container) return { body: '', server: 'none' };
  const view = cl.clusterView();
  const r = containerHttp(ctx, { ...view.st, images: [...view.st.images, ...(ev.image ? [ev.image] : [])] }, ev.container, targetPort, path);
  if (!r || r === 'empty') return { body: '', server: 'none' };
  return { body: r.body, server: r.server, status: r.status };
});

export function k8sState(ctx: Ctx, cluster = 'kind-lab'): { cluster: Cluster; save: () => void } | null {
  const path = `${K8S_DIR}/${cluster}.json`;
  if (!lookup(ctx.sys.fs, path, ROOT)) return null;
  const st = loadState(ctx, path);
  const cl = new Cluster(ctx, st);
  cl.reconcile();
  return { cluster: cl, save: () => saveState(ctx, path, st) };
}

export { Cluster };
export const K8S_COMMANDS: Record<string, Cmd> = { kubectl };
