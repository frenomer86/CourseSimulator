/**
 * The workspace for network labs (engine E3): a topology diagram, device configuration,
 * a ping tool that traces the packet and explains failures, a subnet calculator and questions.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  createNetworkChecks,
  describeSubnet,
  parseCidr,
  parseIp,
  parsePrefix,
  ping,
  setDevice,
  setIface,
  setLink,
  splitEqually,
  toBinary,
  validateTopology,
  type Device,
  type NetState,
  type PingResult,
  type Topology,
} from '@cslab/engine-network';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const netChecks = createNetworkChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

export function NetworkLab({ lab }: { lab: LabSpec<NetState> }) {
  const course = courseBySlug(lab.course);
  const starter = lab.initialState?.topology;
  const valid = validateTopology(starter);
  const saved = useProgress((s) => s.workspaces[lab.id]) as NetState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const editable = (lab.config?.editable as { addresses?: boolean; routes?: boolean; cables?: boolean } | undefined) ?? { addresses: true, routes: true, cables: true };

  const [topology, setTopology] = useState<Topology>(() => (saved?.topology && validateTopology(saved.topology) ? saved.topology : (starter as Topology)));
  const [answers, setAnswers] = useState<Record<string, string>>(() => saved?.answers ?? {});
  const [selected, setSelected] = useState<string | null>(null);
  const [pingFrom, setPingFrom] = useState<string>(() => (starter as Topology | undefined)?.devices.find((d) => d.kind !== 'switch')?.id ?? '');
  const [pingTo, setPingTo] = useState<string>('');
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [tool, setTool] = useState<'ping' | 'subnet'>('ping');
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { topology, answers } satisfies NetState), 400);
    return () => clearTimeout(t);
  }, [topology, answers, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const runPing = () => {
    const r = ping(topology, pingFrom, pingTo);
    setPingResult(r);
    track('interacted', labObject(lab), { ok: r.ok }, { action: 'ping' });
  };

  const check = async () => {
    const r = await netChecks.run(lab, { topology, answers });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { topology, answers } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Put the network back to its starting state and clear your answers?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setTopology(starter as Topology);
    setAnswers({});
    setSelected(null);
    setPingResult(null);
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => (c.type === 'net.answer' || c.type === 'net.answers') && typeof c.id === 'string');
  const selectedDevice = selected ? topology.devices.find((d) => d.id === selected) : undefined;
  const selectedLink = selected ? topology.links.find((l) => l.id === selected) : undefined;

  if (!valid) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="text-2xl font-semibold">{lab.title}</h1>
        <p className="mt-2 text-ink-soft">This lab's network is not valid. This is a content error, not yours.</p>
      </div>
    );
  }

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

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
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

        <section className="order-0 lg:order-none min-w-0 space-y-3">
          <TopologyCanvas topology={topology} selected={selected} onSelect={setSelected} highlight={pingResult?.pathDevices ?? []} />

          {selectedDevice && (
            <DevicePanel
              device={selectedDevice}
              editable={editable}
              onIface={(ifaceId, patch) => {
                setTopology((t) => setIface(t, selectedDevice.id, ifaceId, patch));
                setResult(null);
                setPingResult(null);
              }}
              onDevice={(patch) => {
                setTopology((t) => setDevice(t, selectedDevice.id, patch));
                setResult(null);
                setPingResult(null);
              }}
            />
          )}
          {selectedLink && (
            <div className="rounded-lg border border-line bg-surface p-4 text-sm">
              <h2 className="font-medium">
                Cable {selectedLink.id}: {topology.devices.find((d) => d.id === selectedLink.a.device)?.name} ({selectedLink.a.iface}) to {topology.devices.find((d) => d.id === selectedLink.b.device)?.name} ({selectedLink.b.iface})
              </h2>
              <p className="mt-1 text-ink-soft">{selectedLink.broken ? 'This cable is faulty: no link light at either end.' : 'The link light is on at both ends.'}</p>
              {editable.cables !== false && selectedLink.broken && (
                <button type="button" onClick={() => { setTopology((t) => setLink(t, selectedLink.id, { broken: false })); setResult(null); setPingResult(null); }} className="mt-2 rounded-md bg-high px-3 py-1.5 text-white text-sm font-medium hover:bg-[#0c5a46]">
                  Replace the cable
                </button>
              )}
            </div>
          )}

          <div className="rounded-lg border border-line bg-surface">
            <div className="flex gap-1 p-2 border-b border-line" role="tablist">
              <button type="button" role="tab" aria-selected={tool === 'ping'} onClick={() => setTool('ping')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tool === 'ping' ? 'bg-high text-white' : 'text-ink-soft hover:bg-bench'}`}>
                Ping
              </button>
              <button type="button" role="tab" aria-selected={tool === 'subnet'} onClick={() => setTool('subnet')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tool === 'subnet' ? 'bg-high text-white' : 'text-ink-soft hover:bg-bench'}`}>
                Subnet calculator
              </button>
            </div>
            <div className="p-4">
              {tool === 'ping' ? (
                <div>
                  <div className="flex flex-wrap items-end gap-2 text-sm">
                    <label>
                      From
                      <select value={pingFrom} onChange={(e) => setPingFrom(e.target.value)} className="input mt-1" aria-label="Ping from">
                        {topology.devices.filter((d) => d.kind !== 'switch').map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex-1 min-w-[160px]">
                      To (address or device name)
                      <input type="text" value={pingTo} onChange={(e) => setPingTo(e.target.value)} className="input mt-1 font-mono" placeholder="192.168.1.20 or PC2" aria-label="Ping to" />
                    </label>
                    <button type="button" onClick={runPing} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
                      ping
                    </button>
                  </div>
                  {pingResult && (
                    <div className={`mt-3 rounded-md border p-3 text-sm ${pingResult.ok ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`} role="status">
                      <p className="font-medium">{pingResult.ok ? `Reply received. The packet passed through ${pingResult.pathDevices.map((id) => topology.devices.find((d) => d.id === id)?.name ?? id).join(' → ')}.` : `Request timed out. ${pingResult.reason}`}</p>
                      {pingResult.request.length > 0 && (
                        <ol className="mt-2 list-decimal pl-5 space-y-0.5 text-ink-soft">
                          {pingResult.request.map((h, i) => (
                            <li key={i}>{h.note}</li>
                          ))}
                        </ol>
                      )}
                      {pingResult.reply.length > 0 && pingResult.ok && <p className="mt-1 text-xs text-ink-soft">The reply came back through {pingResult.reply.length} step{pingResult.reply.length === 1 ? '' : 's'}.</p>}
                    </div>
                  )}
                </div>
              ) : (
                <SubnetCalculator />
              )}
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
                      <input type="text" value={answers[String(q.id)] ?? ''} onChange={(e) => { setAnswers((a) => ({ ...a, [String(q.id)]: e.target.value })); setResult(null); }} className="input mt-1 font-mono" placeholder={q.type === 'net.answers' ? 'e.g. 10.0.0.0, 10.0.0.64' : 'e.g. 255.255.255.0'} aria-label={String(q.question ?? q.label)} spellCheck={false} />
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
                Check my network
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
                    <span className="font-medium text-ink">On real equipment:</span> {lab.realityNote}
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

/* ----------------------------------------------------------------------------- topology */

const KIND_LABEL: Record<Device['kind'], string> = { pc: 'PC', switch: 'Switch', router: 'Router', server: 'Server' };

function TopologyCanvas({ topology, selected, onSelect, highlight }: { topology: Topology; selected: string | null; onSelect: (id: string | null) => void; highlight: string[] }) {
  const w = 640;
  const h = 320;
  const pos = new Map(topology.devices.map((d) => [d.id, { x: d.x, y: d.y }]));
  return (
    <div className="rounded-lg border border-line bg-bench p-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" role="img" aria-label="Network diagram. Click a device or cable to configure it.">
        {topology.links.map((l) => {
          const a = pos.get(l.a.device);
          const b = pos.get(l.b.device);
          if (!a || !b) return null;
          const isSel = selected === l.id;
          return (
            <g key={l.id} onClick={() => onSelect(l.id)} className="cursor-pointer">
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={l.broken ? 'var(--color-fault)' : isSel ? 'var(--color-high)' : 'var(--color-ink-faint)'} strokeWidth={isSel ? 3 : 2} strokeDasharray={l.broken ? '6 4' : undefined} />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fontSize={9} textAnchor="middle" fill="var(--color-ink-faint)" fontFamily="var(--font-mono)">
                {l.a.iface}–{l.b.iface}
              </text>
            </g>
          );
        })}
        {topology.devices.map((d) => {
          const isSel = selected === d.id;
          const lit = highlight.includes(d.id);
          const ip = d.interfaces.find((i) => i.ip)?.ip;
          const r = d.kind === 'switch' ? 14 : 20;
          return (
            <g key={d.id} onClick={() => onSelect(d.id)} className="cursor-pointer">
              {d.kind === 'router' ? (
                <circle cx={d.x} cy={d.y} r={r} fill={lit ? 'var(--color-high-soft)' : 'var(--color-surface)'} stroke={isSel ? 'var(--color-high)' : 'var(--color-ink)'} strokeWidth={isSel ? 3 : 1.5} />
              ) : (
                <rect x={d.x - (d.kind === 'switch' ? 28 : 22)} y={d.y - r} width={d.kind === 'switch' ? 56 : 44} height={r * 2} rx={4} fill={lit ? 'var(--color-high-soft)' : 'var(--color-surface)'} stroke={isSel ? 'var(--color-high)' : 'var(--color-ink)'} strokeWidth={isSel ? 3 : 1.5} />
              )}
              <text x={d.x} y={d.y + 4} fontSize={10} textAnchor="middle" fill="var(--color-ink)" fontFamily="var(--font-sans)" fontWeight={600}>
                {d.name}
              </text>
              <text x={d.x} y={d.y + r + 12} fontSize={9} textAnchor="middle" fill="var(--color-ink-soft)" fontFamily="var(--font-mono)">
                {d.kind === 'switch' ? KIND_LABEL[d.kind] : ip ?? 'no address'}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-ink-soft px-1">Click a device to configure it, or a cable to inspect it. Dashed red cables are faulty.</p>
    </div>
  );
}

function DevicePanel({
  device,
  editable,
  onIface,
  onDevice,
}: {
  device: Device;
  editable: { addresses?: boolean; routes?: boolean; cables?: boolean };
  onIface: (ifaceId: string, patch: { ip?: string; mask?: string }) => void;
  onDevice: (patch: Partial<Device>) => void;
}) {
  const [newNet, setNewNet] = useState('');
  const [newVia, setNewVia] = useState('');
  if (device.kind === 'switch') {
    return (
      <div className="rounded-lg border border-line bg-surface p-4 text-sm">
        <h2 className="font-medium">{device.name} (switch)</h2>
        <p className="mt-1 text-ink-soft">A switch forwards frames between its ports by MAC address. It needs no IP address to do its job. Ports: {device.interfaces.map((i) => i.id).join(', ')}.</p>
      </div>
    );
  }
  const canEdit = editable.addresses !== false;
  return (
    <div className="rounded-lg border border-line bg-surface p-4 text-sm">
      <h2 className="font-medium">
        {device.name} ({KIND_LABEL[device.kind]})
      </h2>
      <table className="mt-2 w-full">
        <thead>
          <tr className="text-xs text-ink-soft text-left">
            <th className="py-1 pr-2 font-medium">Interface</th>
            <th className="py-1 pr-2 font-medium">IP address</th>
            <th className="py-1 font-medium">Subnet mask</th>
          </tr>
        </thead>
        <tbody>
          {device.interfaces.map((i) => {
            const ipOk = !i.ip || parseIp(i.ip) !== null;
            const maskOk = !i.mask || parsePrefix(i.mask) !== null;
            return (
              <tr key={i.id}>
                <td className="py-1 pr-2 font-mono">{i.id}</td>
                <td className="py-1 pr-2">
                  <input type="text" value={i.ip ?? ''} onChange={(e) => onIface(i.id, { ip: e.target.value })} disabled={!canEdit} className={`input font-mono ${ipOk ? '' : 'border-fault'}`} placeholder="192.168.1.10" aria-label={`${device.name} ${i.id} IP address`} spellCheck={false} />
                </td>
                <td className="py-1">
                  <input type="text" value={i.mask ?? ''} onChange={(e) => onIface(i.id, { mask: e.target.value })} disabled={!canEdit} className={`input font-mono ${maskOk ? '' : 'border-fault'}`} placeholder="255.255.255.0 or /24" aria-label={`${device.name} ${i.id} subnet mask`} spellCheck={false} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {device.kind !== 'router' && (
        <label className="block mt-2">
          Default gateway
          <input type="text" value={device.gateway ?? ''} onChange={(e) => onDevice({ gateway: e.target.value || undefined })} disabled={!canEdit} className="input mt-1 font-mono max-w-xs" placeholder="192.168.1.1" aria-label={`${device.name} default gateway`} spellCheck={false} />
        </label>
      )}
      {device.kind === 'router' && (
        <div className="mt-3">
          <h3 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Static routes</h3>
          <ul className="mt-1 space-y-1 font-mono text-xs">
            {(device.routes ?? []).map((r, k) => (
              <li key={k} className="flex items-center gap-2">
                <span>
                  ip route {r.network} via {r.via}
                </span>
                {editable.routes !== false && (
                  <button type="button" onClick={() => onDevice({ routes: (device.routes ?? []).filter((_, j) => j !== k) })} className="text-ink-faint hover:text-fault" aria-label="Remove route">
                    ×
                  </button>
                )}
              </li>
            ))}
            {(device.routes ?? []).length === 0 && <li className="text-ink-faint">none (only directly connected networks)</li>}
          </ul>
          {editable.routes !== false && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Network (CIDR)
                <input type="text" value={newNet} onChange={(e) => setNewNet(e.target.value)} className="input mt-1 font-mono" placeholder="192.168.2.0/24 or 0.0.0.0/0" aria-label="Route network" spellCheck={false} />
              </label>
              <label className="text-xs">
                Via (next hop)
                <input type="text" value={newVia} onChange={(e) => setNewVia(e.target.value)} className="input mt-1 font-mono" placeholder="10.0.0.2" aria-label="Route next hop" spellCheck={false} />
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!parseCidr(newNet) || parseIp(newVia) === null) return;
                  onDevice({ routes: [...(device.routes ?? []), { network: newNet.trim(), via: newVia.trim() }] });
                  setNewNet('');
                  setNewVia('');
                }}
                disabled={!parseCidr(newNet) || parseIp(newVia) === null}
                className="rounded-md border border-high text-high px-3 py-1.5 text-sm font-medium hover:bg-high-soft disabled:opacity-50"
              >
                Add route
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubnetCalculator() {
  const [text, setText] = useState('192.168.10.0/24');
  const [splitTo, setSplitTo] = useState(26);
  const cidr = parseCidr(text);
  const ipOnly = !cidr ? parseIp(text) : null;
  const info = cidr ? describeSubnet(cidr.network, cidr.prefix) : null;
  return (
    <div className="text-sm">
      <label className="block">
        Address with prefix
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} className="input mt-1 font-mono max-w-xs" placeholder="192.168.10.77/26" aria-label="Address with prefix" spellCheck={false} />
      </label>
      {!cidr && <p className="mt-1 text-xs text-ink-soft">{ipOnly !== null ? 'Add a prefix such as /24.' : 'Enter an address like 192.168.10.0/24.'}</p>}
      {info && cidr && (
        <>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
            <dt className="text-ink-soft">network</dt>
            <dd>{info.network}</dd>
            <dt className="text-ink-soft">mask</dt>
            <dd>
              {info.mask} (/{info.prefix})
            </dd>
            <dt className="text-ink-soft">broadcast</dt>
            <dd>{info.broadcast}</dd>
            <dt className="text-ink-soft">hosts</dt>
            <dd>
              {info.firstHost} to {info.lastHost} ({info.usable} usable)
            </dd>
            <dt className="text-ink-soft">binary mask</dt>
            <dd className="text-xs">{toBinary(((0xffffffff << (32 - info.prefix)) >>> 0))}</dd>
          </dl>
          <div className="mt-3 flex items-end gap-2">
            <label className="text-xs">
              Split into /
              <input type="number" min={cidr.prefix + 1} max={30} value={splitTo} onChange={(e) => setSplitTo(Number(e.target.value))} className="input mt-1 w-20 font-mono" aria-label="Split prefix" />
            </label>
            <span className="text-xs text-ink-soft pb-2">
              {splitTo > cidr.prefix && splitTo <= 30 ? `${Math.pow(2, splitTo - cidr.prefix)} subnets of ${Math.pow(2, 32 - splitTo) - 2} hosts` : ''}
            </span>
          </div>
          {splitTo > cidr.prefix && splitTo <= 30 && splitTo - cidr.prefix <= 5 && (
            <table className="mt-2 font-mono text-xs border-collapse">
              <thead>
                <tr>
                  {['subnet', 'first host', 'last host', 'broadcast'].map((h) => (
                    <th key={h} className="border border-line px-2 py-0.5 bg-bench text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {splitEqually(cidr.network, cidr.prefix, splitTo).map((s) => (
                  <tr key={s.cidr}>
                    <td className="border border-line px-2 py-0.5">{s.cidr}</td>
                    <td className="border border-line px-2 py-0.5">{s.firstHost}</td>
                    <td className="border border-line px-2 py-0.5">{s.lastHost}</td>
                    <td className="border border-line px-2 py-0.5">{s.broadcast}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
