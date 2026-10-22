/**
 * The workspace for cloud labs (engine E12): a simulated provider console with resources,
 * networking, IAM, a posture scanner, a workload monitor with failure injection, billing,
 * and an infrastructure-as-code editor with plan and apply.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  DB_ENGINES,
  IMAGES,
  REGIONS,
  SIZES,
  addResource,
  apply,
  byId,
  createCloudChecks,
  desiredResources,
  estimateCost,
  findings,
  formatPlan,
  parseHcl,
  plan,
  removeResource,
  simulate,
  summaryOf,
  updateResource,
  type CloudConfig,
  type CloudState,
  type Resource,
  type ResourceType,
  type SimResult,
} from '@cslab/engine-cloud';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const cloudChecks = createCloudChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

type Panel = NonNullable<CloudConfig['panels']>[number];
const PANEL_LABEL: Record<Panel, string> = { resources: 'Resources', network: 'Networking', iam: 'IAM', scanner: 'Security scanner', monitor: 'Monitor', billing: 'Billing', iac: 'Infrastructure as code' };
const TYPE_LABEL: Record<ResourceType, string> = { vm: 'Virtual machine', sg: 'Security group', bucket: 'Storage bucket', db: 'Managed database', lb: 'Load balancer', asg: 'Autoscaling group', user: 'IAM user', policy: 'IAM policy', role: 'IAM role', waf: 'Web application firewall', budget: 'Budget', function: 'Function', queue: 'Queue' };
const RESOURCE_TYPES: ResourceType[] = ['vm', 'bucket', 'db', 'lb', 'asg', 'function', 'queue', 'waf', 'budget'];
const NETWORK_TYPES: ResourceType[] = ['sg'];
const IAM_TYPES: ResourceType[] = ['user', 'policy', 'role'];

export function CloudLab({ lab }: { lab: LabSpec<CloudState> }) {
  const course = courseBySlug(lab.course);
  const config = (lab.config ?? {}) as unknown as CloudConfig;
  const panels: Panel[] = config.panels ?? ['resources', 'network', 'iam', 'scanner', 'monitor', 'billing'];
  const saved = useProgress((s) => s.workspaces[lab.id]) as CloudState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const initial = useMemo<CloudState>(() => ({ resources: [], ...(lab.initialState ?? {}), hcl: lab.initialState?.hcl ?? config.starterHcl }), [lab, config.starterHcl]);
  const [state, setState] = useState<CloudState>(() => (saved?.resources ? saved : initial));
  const [panel, setPanel] = useState<Panel>(panels[0]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const update = (next: CloudState | ((s: CloudState) => CloudState)) => {
    setState((s) => (typeof next === 'function' ? next(s) : next));
    setResult(null);
  };

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, state), 400);
    return () => clearTimeout(t);
  }, [state, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);
  const interact = (action: string, detail?: Record<string, unknown>) => track('interacted', labObject(lab), undefined, { action, ...detail });

  const check = async () => {
    const r = await cloudChecks.run(lab, state);
    setResult(r);
    recordResult(lab, r, hintsShown);
    const outcome = {
      passed: r.passed,
      score: Math.round(r.score * 10000) / 100,
      checksPassed: r.checks.filter((c) => c.passed).length,
      checksTotal: r.checks.length,
      failedChecks: r.checks.filter((c) => !c.passed).map((c) => c.type),
      hintsUsed: hintsShown,
      attempt: (progress?.attempts ?? 0) + 1,
      durationS: secondsSince(openedAt.current),
    };
    track('submitted', labObject(lab), outcome);
    track(r.passed ? 'passed' : 'failed', labObject(lab), outcome);
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { resources: state.resources, hcl: state.hcl, answers: state.answers } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Delete everything in this account and start again?')) return;
    interact('reset');
    clearWorkspace(lab.id);
    setState(initial);
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => c.type === 'cloud.answer' && typeof c.id === 'string');

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <nav className="text-sm text-ink-soft flex flex-wrap items-center gap-x-2">
        <Link to="/#courses" className="hover:text-ink">
          Courses
        </Link>
        <span>/</span>
        {course && (
          <Link to={`/courses/${course.slug}`} className="hover:text-ink">
            {course.title}
          </Link>
        )}
        {course && unit && (
          <>
            <span>/</span>
            <Link to={`/courses/${course.slug}/units/${unit.number}`} className="hover:text-ink">
              Unit {unit.number}
            </Link>
          </>
        )}
        <span>/</span>
        <span>{LEVEL_LABEL[lab.level]}</span>
      </nav>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{lab.title}</h1>
        <span className="text-sm text-ink-soft">
          {lab.topic}, about {lab.estimatedMinutes} min
          {progress?.passed && <span className="ml-3 text-high font-medium">Completed</span>}
        </span>
      </div>

      <ContestBanner entry={contest} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
        <aside className="order-1 lg:order-none space-y-4">
          <details open className="rounded-lg border border-line bg-surface lg:open">
            <summary className="cursor-pointer px-4 py-3 font-medium lg:pointer-events-none">Instructions</summary>
            <div className="px-4 pb-4 -mt-1">
              <Markdown source={lab.instructions} className="text-[15px]" />
              {lab.hints.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                  {lab.hints.slice(0, hintsShown).map((h, i) => (
                    <p key={i} className="text-sm rounded-md bg-gold-soft border border-gold/40 px-3 py-2 mb-2 leading-relaxed">
                      <span className="font-medium">Hint {i + 1}.</span> {h}
                    </p>
                  ))}
                  {hintsShown < lab.hints.length ? (
                    <button
                      type="button"
                      onClick={() => {
                        track('asked-for-hint', labObject(lab), { hintIndex: hintsShown + 1, hintsTotal: lab.hints.length });
                        setHintsShown((n) => n + 1);
                      }}
                      className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
                    >
                      {hintsShown === 0 ? 'Show a hint' : 'Show another hint'} ({lab.hints.length - hintsShown} left)
                    </button>
                  ) : (
                    <span className="text-sm text-ink-faint">No more hints.</span>
                  )}
                </div>
              )}
            </div>
          </details>
        </aside>

        <section className="order-0 lg:order-none min-w-0">
          <div className="rounded-lg border border-line bg-surface overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-[#1b2a44] text-white text-sm">
              <span className="font-semibold tracking-tight">☁ Nimbus Console</span>
              <span className="text-white/60 text-xs">simulated provider · account 4120-lab</span>
            </div>
            <div className="flex flex-wrap gap-1 px-2 py-1.5 border-b border-line bg-bench" role="tablist">
              {panels.map((p) => (
                <button key={p} type="button" role="tab" aria-selected={panel === p} onClick={() => setPanel(p)} className={`rounded-md px-3 py-1 text-sm font-medium ${panel === p ? 'bg-surface border border-line' : 'text-ink-soft hover:text-ink'}`}>
                  {PANEL_LABEL[p]}
                </button>
              ))}
            </div>
            <div className="p-3">
              {panel === 'resources' && <ResourcesPanel state={state} update={update} types={RESOURCE_TYPES.filter((t) => !config.allowed || config.allowed.includes(t))} interact={interact} />}
              {panel === 'network' && <ResourcesPanel state={state} update={update} types={NETWORK_TYPES} interact={interact} />}
              {panel === 'iam' && <ResourcesPanel state={state} update={update} types={IAM_TYPES} interact={interact} />}
              {panel === 'scanner' && <ScannerPanel state={state} />}
              {panel === 'monitor' && <MonitorPanel state={state} update={update} config={config} interact={interact} />}
              {panel === 'billing' && <BillingPanel state={state} />}
              {panel === 'iac' && <IacPanel state={state} update={update} config={config} interact={interact} />}
            </div>
          </div>
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Tasks</h2>
            {questions.length > 0 && (
              <ol className="mt-3 space-y-3">
                {questions.map((q, i) => (
                  <li key={String(q.id)}>
                    <label className="block text-sm">
                      <span className="block">
                        <span className="font-mono text-ink-faint mr-1">{i + 1}.</span>
                        {String(q.question ?? q.label)}
                      </span>
                      {Array.isArray(q.options) ? (
                        <select value={state.answers?.[String(q.id)] ?? ''} onChange={(e) => update((s) => ({ ...s, answers: { ...(s.answers ?? {}), [String(q.id)]: e.target.value } }))} className="input mt-1" aria-label={String(q.question ?? q.label)}>
                          <option value="">choose…</option>
                          {(q.options as string[]).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input type="text" value={state.answers?.[String(q.id)] ?? ''} onChange={(e) => update((s) => ({ ...s, answers: { ...(s.answers ?? {}), [String(q.id)]: e.target.value } }))} className="input mt-1 font-mono" aria-label={String(q.question ?? q.label)} spellCheck={false} />
                      )}
                    </label>
                  </li>
                ))}
              </ol>
            )}
            <h3 className="mt-3 text-xs uppercase tracking-wide text-ink-faint font-medium">What will be checked</h3>
            <ul className="mt-1 space-y-1 text-sm text-ink-soft list-disc pl-4">
              {lab.checks.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={check} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
                Check my deployment
              </button>
              <button type="button" onClick={reset} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
                Start again
              </button>
            </div>
            {result && (
              <div className={`mt-3 rounded-lg border p-3 ${result.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`} role="status">
                <p className="font-medium text-sm">
                  {result.passed ? 'Correct. Every check passed.' : `${result.checks.filter((c) => c.passed).length} of ${result.checks.length} checks passed.`}
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {result.checks.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={`font-mono shrink-0 ${c.passed ? 'text-high' : 'text-fault'}`}>{c.passed ? '✓' : '✗'}</span>
                      <span>
                        <span className="font-medium">{c.label}.</span> {c.message}
                      </span>
                    </li>
                  ))}
                </ul>
                {result.passed && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {topicCheck && (
                      <Link to={`/courses/${lab.course}/units/${lab.unit}/topics/${lab.topicIndex}/check`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench">
                        Take the topic check
                      </Link>
                    )}
                    {following && (
                      <Link to={`/labs/${following.id}`} className="rounded-md border border-high text-high px-3 py-1.5 text-sm font-medium hover:bg-high-soft">
                        Next lab: {following.title}
                      </Link>
                    )}
                  </div>
                )}
                {result.passed && lab.realityNote && (
                  <p className="mt-3 text-sm text-ink-soft border-t border-high/30 pt-3">
                    <span className="font-medium text-ink">On a real provider:</span> {lab.realityNote}
                  </p>
                )}
              </div>
            )}
          </div>
          <QuestionsAbout labId={lab.id} title="Questions about this lab" />
        </aside>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- resources */

type Updater = (next: CloudState | ((s: CloudState) => CloudState)) => void;

function ResourcesPanel({ state, update, types, interact }: { state: CloudState; update: Updater; types: ResourceType[]; interact: (a: string, d?: Record<string, unknown>) => void }) {
  const [creating, setCreating] = useState<ResourceType | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const list = state.resources.filter((r) => types.includes(r.type));
  return (
    <div className="text-sm">
      <div className="flex flex-wrap gap-2">
        {types.map((t) => (
          <button key={t} type="button" onClick={() => { setCreating(t); setEditing(null); }} className="rounded-md border border-high text-high px-3 py-1 font-medium hover:bg-high-soft">
            + {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {creating && (
        <ResourceForm
          state={state}
          type={creating}
          onCancel={() => setCreating(null)}
          onSave={(r) => {
            update((s) => addResource(s, r).state);
            interact('create', { type: creating });
            setCreating(null);
          }}
        />
      )}
      <table className="mt-3 w-full">
        <thead>
          <tr className="text-xs text-ink-soft text-left border-b border-line">
            <th className="py-1 pr-2 font-medium">Name</th>
            <th className="py-1 pr-2 font-medium">Type</th>
            <th className="py-1 pr-2 font-medium">Details</th>
            <th className="py-1 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-ink-faint">
                Nothing here yet. Create something with the buttons above.
              </td>
            </tr>
          )}
          {list.map((r) => (
            <tr key={r.id} className="border-b border-line align-top">
              <td className="py-1.5 pr-2 font-mono">
                {r.name}
                <span className="block text-[11px] text-ink-faint">{r.id}</span>
              </td>
              <td className="py-1.5 pr-2">{TYPE_LABEL[r.type]}</td>
              <td className="py-1.5 pr-2 text-xs text-ink-soft">{describe(state, r)}</td>
              <td className="py-1.5 whitespace-nowrap">
                <button type="button" onClick={() => { setEditing(editing === r.id ? null : r.id); setCreating(null); }} className="text-high hover:underline mr-2">
                  edit
                </button>
                <button type="button" onClick={() => { update((s) => removeResource(s, r.id)); interact('delete', { type: r.type }); }} className="text-ink-faint hover:text-fault">
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && byId(state, editing) && (
        <ResourceForm
          state={state}
          type={byId(state, editing)!.type}
          existing={byId(state, editing)}
          onCancel={() => setEditing(null)}
          onSave={(r) => {
            update((s) => updateResource(s, editing, r));
            interact('update', { type: r.type });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function describe(state: CloudState, r: Resource): string {
  switch (r.type) {
    case 'vm':
      return `${r.size} · ${r.region}${r.zone} · ${r.image} · ${r.publicIp ? 'public IP' : 'private'} · ${r.status} · SG ${byId(state, r.sg)?.name ?? 'none'}`;
    case 'sg':
      return (r.rules ?? []).map((x) => `${x.protocol}/${x.port} from ${x.source}`).join(', ') || 'no inbound rules';
    case 'bucket':
      return `${r.region} · ${r.storageGb} GB · ${r.public ? 'PUBLIC' : 'private'} · ${r.encrypted ? 'encrypted' : 'not encrypted'}${r.versioning ? ' · versioned' : ''}${r.website ? ' · website' : ''}`;
    case 'db':
      return `${r.engine} · ${r.size} · ${r.region}${r.zone ?? 'a'} · ${r.multiAz ? 'Multi-AZ' : 'single AZ'} · ${r.encrypted ? 'encrypted' : 'not encrypted'} · ${r.public ? 'PUBLIC' : 'private'} · backups ${r.backupDays ?? 0} d`;
    case 'lb':
      return `${r.region} · port ${r.listenerPort} · targets: ${(r.targets ?? []).map((t) => byId(state, t)?.name ?? t).join(', ') || 'none'} · health ${r.healthCheck}`;
    case 'asg':
      return `${r.size} × ${r.min}–${r.max} (desired ${r.desired}) · zones ${(r.zones ?? []).join(',')} · scale at ${r.targetCpu}% CPU · LB ${byId(state, r.lb)?.name ?? r.lb ?? 'none'}`;
    case 'user':
      return `policies: ${(r.policies ?? []).map((p) => byId(state, p)?.name ?? p).join(', ') || 'none'} · MFA ${r.mfa ? 'on' : 'off'} · ${r.accessKeys ?? 0} access keys`;
    case 'role':
      return `policies: ${(r.policies ?? []).map((p) => byId(state, p)?.name ?? p).join(', ') || 'none'}`;
    case 'policy':
      return (r.statements ?? []).map((s) => `${s.effect} ${s.actions.join(',')} on ${s.resources.join(',')}`).join('; ') || 'no statements';
    case 'waf':
      return `rate limit ${r.rateLimit} req/5 min per IP`;
    case 'budget':
      return `$${r.monthlyUsd}/month, alert at ${r.alertAt}%`;
    case 'function':
      return `${r.region} · ${r.memoryMb} MB · ${r.avgMs} ms · ${((r.invocationsPerMonth ?? 0) / 1e6).toFixed(1)} M/month`;
    case 'queue':
      return r.region ?? '';
  }
}

interface Field {
  key: Exclude<keyof Resource, 'id'>;
  label: string;
  kind: 'text' | 'number' | 'bool' | 'select' | 'multi' | 'rules' | 'statements';
  options?: string[] | (() => string[]);
  help?: string;
}

function fieldsFor(type: ResourceType, state: CloudState): Field[] {
  const regions = REGIONS.map((r) => `${r.id}`);
  const sizes = SIZES.map((s) => s.id);
  switch (type) {
    case 'vm':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'zone', label: 'Availability zone', kind: 'select', options: ['a', 'b', 'c'] },
        { key: 'size', label: 'Size', kind: 'select', options: sizes, help: SIZES.map((s) => `${s.id}: ${s.vcpu} vCPU, ${s.memoryGb} GB, $${s.hourlyUsd}/h, ~${s.rps} req/s`).join(' · ') },
        { key: 'image', label: 'Image', kind: 'select', options: IMAGES },
        { key: 'sg', label: 'Security group', kind: 'select', options: () => ['', ...state.resources.filter((r) => r.type === 'sg').map((r) => r.id)] },
        { key: 'publicIp', label: 'Public IP address', kind: 'bool' },
        { key: 'diskGb', label: 'Disk (GB)', kind: 'number' },
        { key: 'status', label: 'State', kind: 'select', options: ['running', 'stopped'] },
      ];
    case 'sg':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'rules', label: 'Inbound rules', kind: 'rules' },
      ];
    case 'bucket':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'storageGb', label: 'Expected size (GB)', kind: 'number' },
        { key: 'public', label: 'Public read access', kind: 'bool' },
        { key: 'encrypted', label: 'Encryption at rest', kind: 'bool' },
        { key: 'versioning', label: 'Versioning', kind: 'bool' },
        { key: 'website', label: 'Static website hosting', kind: 'bool' },
      ];
    case 'db':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'engine', label: 'Engine', kind: 'select', options: DB_ENGINES },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'zone', label: 'Primary zone', kind: 'select', options: ['a', 'b', 'c'] },
        { key: 'size', label: 'Size', kind: 'select', options: sizes },
        { key: 'storageGb', label: 'Storage (GB)', kind: 'number' },
        { key: 'multiAz', label: 'Multi-AZ standby', kind: 'bool' },
        { key: 'encrypted', label: 'Encryption at rest', kind: 'bool' },
        { key: 'public', label: 'Publicly accessible', kind: 'bool' },
        { key: 'backupDays', label: 'Backup retention (days)', kind: 'number' },
      ];
    case 'lb':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'listenerPort', label: 'Listener port', kind: 'number' },
        { key: 'healthCheck', label: 'Health check path', kind: 'text' },
        { key: 'targets', label: 'Targets', kind: 'multi', options: () => state.resources.filter((r) => r.type === 'vm').map((r) => r.id) },
      ];
    case 'asg':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'zones', label: 'Zones', kind: 'multi', options: ['a', 'b', 'c'] },
        { key: 'size', label: 'Instance size', kind: 'select', options: sizes },
        { key: 'min', label: 'Minimum', kind: 'number' },
        { key: 'desired', label: 'Desired', kind: 'number' },
        { key: 'max', label: 'Maximum', kind: 'number' },
        { key: 'targetCpu', label: 'Target CPU (%)', kind: 'number' },
        { key: 'lb', label: 'Load balancer', kind: 'select', options: () => ['', ...state.resources.filter((r) => r.type === 'lb').map((r) => r.id)] },
      ];
    case 'user':
      return [
        { key: 'name', label: 'User name', kind: 'text' },
        { key: 'policies', label: 'Policies', kind: 'multi', options: () => state.resources.filter((r) => r.type === 'policy').map((r) => r.id) },
        { key: 'mfa', label: 'MFA enabled', kind: 'bool' },
        { key: 'accessKeys', label: 'Access keys', kind: 'number' },
      ];
    case 'role':
      return [
        { key: 'name', label: 'Role name', kind: 'text' },
        { key: 'policies', label: 'Policies', kind: 'multi', options: () => state.resources.filter((r) => r.type === 'policy').map((r) => r.id) },
      ];
    case 'policy':
      return [
        { key: 'name', label: 'Policy name', kind: 'text' },
        { key: 'statements', label: 'Statements', kind: 'statements' },
      ];
    case 'waf':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'rateLimit', label: 'Rate limit (requests per 5 min per IP)', kind: 'number' },
      ];
    case 'budget':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'monthlyUsd', label: 'Monthly amount (USD)', kind: 'number' },
        { key: 'alertAt', label: 'Alert at (%)', kind: 'number' },
      ];
    case 'function':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
        { key: 'memoryMb', label: 'Memory (MB)', kind: 'number' },
        { key: 'avgMs', label: 'Average duration (ms)', kind: 'number' },
        { key: 'invocationsPerMonth', label: 'Invocations per month', kind: 'number' },
      ];
    case 'queue':
      return [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'region', label: 'Region', kind: 'select', options: regions },
      ];
  }
}

function ResourceForm({ state, type, existing, onSave, onCancel }: { state: CloudState; type: ResourceType; existing?: Resource; onSave: (r: Omit<Resource, 'id'>) => void; onCancel: () => void }) {
  const fields = fieldsFor(type, state);
  const [draft, setDraft] = useState<Omit<Resource, 'id'>>(() => existing ?? ({ ...(addResource({ resources: [] }, { type, name: '' }).resource as Resource), id: undefined } as unknown as Omit<Resource, 'id'>));
  const set = (k: Exclude<keyof Resource, 'id'>, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <form
      className="mt-3 rounded-md border border-high bg-high-soft/40 p-3 grid gap-2 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.name?.trim()) return;
        onSave({ ...draft, type });
      }}
      aria-label={`${existing ? 'Edit' : 'Create'} ${TYPE_LABEL[type]}`}
    >
      <h3 className="md:col-span-2 font-medium">
        {existing ? 'Edit' : 'Create'} {TYPE_LABEL[type].toLowerCase()}
      </h3>
      {fields.map((f) => {
        const value = draft[f.key];
        const options = typeof f.options === 'function' ? f.options() : f.options ?? [];
        if (f.kind === 'rules') return <RulesEditor key={f.key} rules={(value as Resource['rules']) ?? []} onChange={(rules) => set('rules', rules)} />;
        if (f.kind === 'statements') return <StatementsEditor key={f.key} statements={(value as Resource['statements']) ?? []} onChange={(s) => set('statements', s)} />;
        if (f.kind === 'bool')
          return (
            <label key={f.key} className="flex items-center gap-2">
              <input type="checkbox" checked={!!value} onChange={(e) => set(f.key, e.target.checked)} aria-label={f.label} />
              {f.label}
            </label>
          );
        if (f.kind === 'multi')
          return (
            <fieldset key={f.key} className="md:col-span-2">
              <legend className="text-xs text-ink-soft">{f.label}</legend>
              <div className="flex flex-wrap gap-2 mt-1">
                {options.length === 0 && <span className="text-xs text-ink-faint">nothing available yet</span>}
                {options.map((o) => {
                  const arr = (value as string[] | undefined) ?? [];
                  const label = f.key === 'zones' ? o : byId(state, o)?.name ?? o;
                  return (
                    <label key={o} className="flex items-center gap-1 text-xs rounded border border-line px-2 py-1 bg-surface">
                      <input type="checkbox" checked={arr.includes(o)} onChange={(e) => set(f.key, e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} aria-label={`${f.label} ${label}`} />
                      {label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        return (
          <label key={f.key} className="block text-xs text-ink-soft">
            {f.label}
            {f.kind === 'select' ? (
              <select value={String(value ?? '')} onChange={(e) => set(f.key, e.target.value || undefined)} className="input mt-0.5 text-sm text-ink" aria-label={f.label}>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o === '' ? 'none' : f.key === 'sg' || f.key === 'lb' ? byId(state, o)?.name ?? o : o}
                  </option>
                ))}
              </select>
            ) : (
              <input type={f.kind === 'number' ? 'number' : 'text'} value={value === undefined ? '' : String(value)} onChange={(e) => set(f.key, f.kind === 'number' ? Number(e.target.value) : e.target.value)} className="input mt-0.5 text-sm text-ink font-mono" aria-label={f.label} />
            )}
            {f.help && <span className="block text-[11px] text-ink-faint mt-0.5">{f.help}</span>}
          </label>
        );
      })}
      <div className="md:col-span-2 flex gap-2">
        <button type="submit" className="rounded-md bg-high px-3 py-1.5 text-white text-sm font-medium hover:bg-[#0c5a46]">
          {existing ? 'Save changes' : 'Create'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-bench">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RulesEditor({ rules, onChange }: { rules: NonNullable<Resource['rules']>; onChange: (r: NonNullable<Resource['rules']>) => void }) {
  const [port, setPort] = useState('80');
  const [source, setSource] = useState('0.0.0.0/0');
  return (
    <div className="md:col-span-2 text-xs">
      <span className="text-ink-soft">Inbound rules</span>
      <ul className="mt-1 space-y-1 font-mono">
        {rules.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <span>
              {r.protocol}/{r.port} from {r.source}
            </span>
            <button type="button" onClick={() => onChange(rules.filter((_, k) => k !== i))} className="text-ink-faint hover:text-fault" aria-label="Remove rule">
              ×
            </button>
          </li>
        ))}
        {!rules.length && <li className="text-ink-faint">no inbound rules (everything blocked)</li>}
      </ul>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        <label>
          Port
          <input type="text" value={port} onChange={(e) => setPort(e.target.value)} className="input mt-0.5 w-20 font-mono text-sm" aria-label="Rule port" />
        </label>
        <label>
          Source CIDR
          <input type="text" value={source} onChange={(e) => setSource(e.target.value)} className="input mt-0.5 w-36 font-mono text-sm" aria-label="Rule source" />
        </label>
        <button type="button" onClick={() => { const p = port === 'all' ? 'all' : Number(port); if (p !== 'all' && !Number.isFinite(p)) return; onChange([...rules, { port: p, protocol: 'tcp', source: source.trim() || '0.0.0.0/0' }]); }} className="rounded-md border border-high text-high px-2 py-1 font-medium hover:bg-high-soft">
          Add rule
        </button>
      </div>
    </div>
  );
}

function StatementsEditor({ statements, onChange }: { statements: NonNullable<Resource['statements']>; onChange: (s: NonNullable<Resource['statements']>) => void }) {
  const [actions, setActions] = useState('s3:GetObject');
  const [resources, setResources] = useState('bucket:results');
  return (
    <div className="md:col-span-2 text-xs">
      <span className="text-ink-soft">Statements</span>
      <ul className="mt-1 space-y-1 font-mono">
        {statements.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span>
              {s.effect} [{s.actions.join(', ')}] on [{s.resources.join(', ')}]
            </span>
            <button type="button" onClick={() => onChange(statements.filter((_, k) => k !== i))} className="text-ink-faint hover:text-fault" aria-label="Remove statement">
              ×
            </button>
          </li>
        ))}
        {!statements.length && <li className="text-ink-faint">no statements (denies everything)</li>}
      </ul>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        <label>
          Actions (comma separated, * allowed)
          <input type="text" value={actions} onChange={(e) => setActions(e.target.value)} className="input mt-0.5 w-56 font-mono text-sm" aria-label="Statement actions" />
        </label>
        <label>
          Resources
          <input type="text" value={resources} onChange={(e) => setResources(e.target.value)} className="input mt-0.5 w-40 font-mono text-sm" aria-label="Statement resources" />
        </label>
        <button type="button" onClick={() => onChange([...statements, { effect: 'Allow', actions: actions.split(',').map((a) => a.trim()).filter(Boolean), resources: resources.split(',').map((a) => a.trim()).filter(Boolean) }])} className="rounded-md border border-high text-high px-2 py-1 font-medium hover:bg-high-soft">
          Allow
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- scanner, monitor, billing, iac */

function ScannerPanel({ state }: { state: CloudState }) {
  const f = findings(state);
  return (
    <div className="text-sm">
      <h3 className="font-medium">Security posture</h3>
      {f.length === 0 ? (
        <p className="mt-2 text-high">No findings. The account passes the baseline checks.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {f.map((x, i) => (
            <li key={i} className="flex gap-2">
              <span className={`shrink-0 rounded px-1.5 text-xs font-medium ${x.severity === 'high' ? 'bg-fault-soft text-fault' : x.severity === 'medium' ? 'bg-gold-soft text-ink' : 'bg-bench text-ink-soft'}`}>{x.severity}</span>
              <span>{x.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-ink-faint">Scanned against a baseline like the CIS Foundations Benchmark: public storage, open management ports, unencrypted data, wildcard policies, missing MFA and backups.</p>
    </div>
  );
}

function MonitorPanel({ state, update, config, interact }: { state: CloudState; update: Updater; config: CloudConfig; interact: (a: string, d?: Record<string, unknown>) => void }) {
  const scenarios = Object.entries(config.scenarios ?? {});
  const [key, setKey] = useState(scenarios[0]?.[0] ?? '');
  const [run, setRun] = useState<SimResult | null>(null);
  const go = () => {
    const sc = config.scenarios?.[key];
    if (!sc) return;
    const r = simulate(state, sc);
    setRun(r);
    update((s) => ({ ...s, lastSim: summaryOf(r) }));
    interact('simulate', { scenario: key, availability: r.availability });
  };
  if (!scenarios.length) return <p className="text-sm text-ink-soft">This lab has no traffic scenario to run.</p>;
  const sc = config.scenarios?.[key];
  const W = 640;
  const H = 160;
  const maxRps = run ? Math.max(...run.steps.map((s) => Math.max(s.rps, s.capacity)), 1) : 1;
  const maxInst = run ? Math.max(...run.steps.map((s) => s.instances), 1) : 1;
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          Scenario
          <select value={key} onChange={(e) => setKey(e.target.value)} className="input mt-0.5" aria-label="Scenario">
            {scenarios.map(([k, s]) => (
              <option key={k} value={k}>
                {k} ({s.durationMin} min)
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={go} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
          Run traffic
        </button>
        {sc && (
          <span className="text-xs text-ink-soft">
            peak {Math.max(...sc.traffic.map((t) => t[1]))} req/s · {sc.events?.length ? sc.events.map((e) => `${e.kind} at ${e.at} min`).join(', ') : 'no failures injected'} · SLO {((sc.sloAvailability ?? 0.999) * 100).toFixed(2)}% / p95 ≤ {sc.sloP95Ms ?? 500} ms
          </span>
        )}
      </div>
      {run && (
        <div className="mt-3" role="status" aria-label="Simulation result">
          <div className={`rounded-md border p-2 text-sm ${run.sloMet ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`}>
            <span className="font-medium">{run.sloMet ? 'SLO met.' : 'SLO missed.'}</span> Availability {(run.availability * 100).toFixed(3)}%, p95 {run.p95Ms} ms, {run.errors.toLocaleString()} failed of {run.totalRequests.toLocaleString()} requests, peak {run.maxInstances} instance{run.maxInstances === 1 ? '' : 's'}, run cost ${run.costUsd}.
            <ul className="mt-1 text-xs text-ink-soft list-disc pl-4">
              {run.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
          <svg viewBox={`0 0 ${W} ${H + 30}`} className="w-full h-auto mt-2" role="img" aria-label="Traffic, capacity and instances over time">
            {run.steps.map((s, i) => {
              const x = 40 + (i / run.steps.length) * (W - 50);
              const w = (W - 50) / run.steps.length;
              return (
                <g key={i}>
                  <rect x={x} y={10 + H - (s.served / maxRps) * H} width={w} height={(s.served / maxRps) * H} fill="var(--color-high)" opacity={0.6} />
                  {s.errors > 0 && <rect x={x} y={10 + H - (s.rps / maxRps) * H} width={w} height={(s.errors / maxRps) * H} fill="var(--color-fault)" opacity={0.7} />}
                  {s.note && <circle cx={x + w / 2} cy={H + 22} r={3} fill="var(--color-gold)" />}
                </g>
              );
            })}
            <polyline points={run.steps.map((s, i) => `${40 + ((i + 0.5) / run.steps.length) * (W - 50)},${10 + H - (s.capacity / maxRps) * H}`).join(' ')} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="4 3" />
            <polyline points={run.steps.map((s, i) => `${40 + ((i + 0.5) / run.steps.length) * (W - 50)},${10 + H - (s.instances / maxInst) * H * 0.5}`).join(' ')} fill="none" stroke="#2b6cb0" strokeWidth={1.5} />
            <text x={0} y={16} fontSize={10} fill="var(--color-ink-soft)">{maxRps} r/s</text>
            <text x={0} y={H + 10} fontSize={10} fill="var(--color-ink-soft)">0</text>
            <text x={40} y={H + 28} fontSize={10} fill="var(--color-ink-soft)">0 min</text>
            <text x={W - 60} y={H + 28} fontSize={10} fill="var(--color-ink-soft)">{run.steps.length} min</text>
          </svg>
          <p className="text-xs text-ink-faint">Green: requests served. Red: requests failed. Dashed: capacity. Blue: instances (half scale). Dots: events.</p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-ink-soft">Minute-by-minute log</summary>
            <ul className="mt-1 font-mono max-h-40 overflow-y-auto">
              {run.steps.filter((s) => s.note || s.errors > 0).map((s) => (
                <li key={s.t}>
                  t={s.t}: {s.rps} r/s, cap {s.capacity}, {s.healthy}/{s.instances} up, cpu {s.cpu}%{s.errors ? `, ${s.errors} r/s failed` : ''} {s.note ?? ''}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

function BillingPanel({ state }: { state: CloudState }) {
  const c = estimateCost(state);
  return (
    <div className="text-sm">
      <h3 className="font-medium">Monthly estimate</h3>
      <table className="mt-2 w-full">
        <tbody>
          {c.lines.map((l) => (
            <tr key={l.id} className="border-b border-line">
              <td className="py-1 pr-2 font-mono">{l.name}</td>
              <td className="py-1 pr-2 text-xs text-ink-soft">{l.detail}</td>
              <td className="py-1 text-right font-mono">${l.usd.toFixed(2)}</td>
            </tr>
          ))}
          <tr className="font-medium">
            <td className="py-1.5" colSpan={2}>
              Total
            </td>
            <td className="py-1.5 text-right font-mono">${c.totalUsd.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-faint">On-demand prices, 730 hours a month, with a regional price factor. About GH₵{Math.round(c.totalUsd * 15.5).toLocaleString()} at 15.5 GH₵ per dollar.</p>
    </div>
  );
}

function IacPanel({ state, update, config, interact }: { state: CloudState; update: Updater; config: CloudConfig; interact: (a: string, d?: Record<string, unknown>) => void }) {
  const [output, setOutput] = useState<string>('');
  const src = state.hcl ?? '';
  const doPlan = () => {
    try {
      const { desired, errors } = desiredResources(parseHcl(src), config.variables);
      if (errors.length) {
        setOutput('Error: ' + errors.join('\n'));
        return null;
      }
      const p = plan(state, desired);
      setOutput(formatPlan(p));
      interact('plan');
      return desired;
    } catch (e) {
      setOutput(`Error: ${(e as Error).message}`);
      return null;
    }
  };
  const doApply = () => {
    const desired = doPlan();
    if (!desired) return;
    const r = apply(state, desired);
    update(() => ({ ...r.state, hcl: src }));
    setOutput((o) => o + `\n\nApply complete! Resources: ${r.applied.filter((l) => l.action === 'create').length} added, ${r.applied.filter((l) => l.action === 'update').length} changed, ${r.applied.filter((l) => l.action === 'destroy').length} destroyed.`);
    interact('apply', { resources: desired.length });
  };
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs">main.tf</span>
        <div className="flex gap-2">
          <button type="button" onClick={doPlan} className="rounded-md border border-high text-high px-3 py-1 font-medium hover:bg-high-soft">
            terraform plan
          </button>
          <button type="button" onClick={doApply} className="rounded-md bg-high px-3 py-1 text-white font-medium hover:bg-[#0c5a46]">
            terraform apply
          </button>
        </div>
      </div>
      <textarea value={src} onChange={(e) => update((s) => ({ ...s, hcl: e.target.value }))} className="mt-2 w-full h-72 p-3 font-mono text-[13px] leading-5 bg-[#1b1f23] text-[#e6edf3] rounded-md outline-none resize-y" aria-label="Infrastructure code" spellCheck={false} />
      {output && <pre className="mt-2 rounded-md bg-bench border border-line p-3 text-xs whitespace-pre-wrap font-mono" aria-label="Plan output">{output}</pre>}
      <p className="mt-2 text-xs text-ink-faint">
        Resource types: cloud_vm, cloud_security_group (with ingress blocks), cloud_bucket, cloud_db, cloud_lb, cloud_asg, cloud_user, cloud_policy (with statement blocks), cloud_waf, cloud_budget, cloud_function. Reference another resource with type.name.id.
      </p>
    </div>
  );
}
