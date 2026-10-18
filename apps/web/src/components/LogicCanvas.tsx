import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  addNode,
  connect,
  evaluate,
  GATE_INFO,
  moveNode,
  relabelNode,
  removeNode,
  removeWire,
  toggleInput,
  type Bit,
  type Circuit,
  type GateType,
  type PortRef,
} from '@cslab/engine-digital-logic';

const NODE_W = 72;
const NODE_H = 48;
const PIN_R = 6;
const SNAP_RADIUS = 22;

interface Props {
  circuit: Circuit;
  onChange: (c: Circuit) => void;
  /** Gate types offered in the palette. Omit for the demo (no palette). */
  palette?: GateType[];
  /** Suggested labels for new inputs/outputs, used in order. */
  inputLabels?: string[];
  outputLabels?: string[];
  width?: number;
  height?: number;
  compact?: boolean;
  readOnlyStructure?: boolean;
}

interface Drag {
  id: string;
  dx: number;
  dy: number;
  moved: boolean;
}

interface PendingWire {
  from: PortRef;
  x: number;
  y: number;
}

function inputPinPos(n: { x: number; y: number; type: GateType }, port: number) {
  const count = GATE_INFO[n.type].inputs;
  const gap = NODE_H / (count + 1);
  return { x: n.x, y: n.y + gap * (port + 1) };
}
function outputPinPos(n: { x: number; y: number }) {
  return { x: n.x + NODE_W, y: n.y + NODE_H / 2 };
}

function wirePath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function signalColor(v: Bit | undefined) {
  if (v === 1) return 'var(--color-high-bright)';
  if (v === 0) return 'var(--color-low)';
  return 'var(--color-gold)';
}

export function LogicCanvas({
  circuit,
  onChange,
  palette,
  inputLabels = ['A', 'B', 'C', 'D'],
  outputLabels = ['Y', 'Z'],
  width = 760,
  height = 440,
  compact = false,
  readOnlyStructure = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pending, setPending] = useState<PendingWire | null>(null);
  const [selected, setSelected] = useState<{ kind: 'node' | 'wire'; id: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState('');

  const ev = useMemo(() => evaluate(circuit), [circuit]);
  const nodeById = useMemo(() => new Map(circuit.nodes.map((n) => [n.id, n])), [circuit]);

  const toSvg = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  /* ---- node dragging ---- */
  const onNodePointerDown = (e: RPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const n = nodeById.get(id)!;
    const p = toSvg(e);
    setDrag({ id, dx: p.x - n.x, dy: p.y - n.y, moved: false });
    setSelected({ kind: 'node', id });
    setLabelDraft(n.label ?? '');
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: RPointerEvent) => {
    const p = toSvg(e);
    if (drag) {
      const nx = Math.max(0, Math.min(width - NODE_W, p.x - drag.dx));
      const ny = Math.max(0, Math.min(height - NODE_H, p.y - drag.dy));
      const n = nodeById.get(drag.id);
      if (n && (Math.abs(nx - n.x) > 0.5 || Math.abs(ny - n.y) > 0.5)) {
        if (!drag.moved) setDrag({ ...drag, moved: true });
        onChange(moveNode(circuit, drag.id, nx, ny));
      }
    } else if (pending) {
      setPending({ ...pending, x: p.x, y: p.y });
    }
  };

  const onPointerUp = (e: RPointerEvent) => {
    if (drag) {
      const n = nodeById.get(drag.id);
      if (n && !drag.moved && n.type === 'INPUT') onChange(toggleInput(circuit, drag.id));
      setDrag(null);
    } else if (pending) {
      // Released somewhere on the bench: snap to the nearest free-standing input pin.
      const p = toSvg(e);
      let best: { ref: PortRef; d: number } | null = null;
      for (const n of circuit.nodes) {
        if (n.id === pending.from.node) continue;
        for (let port = 0; port < GATE_INFO[n.type].inputs; port += 1) {
          const pin = inputPinPos(n, port);
          const d = Math.hypot(pin.x - p.x, pin.y - p.y);
          if (d <= SNAP_RADIUS && (!best || d < best.d)) best = { ref: { node: n.id, port }, d };
        }
      }
      if (best) onChange(connect(circuit, pending.from, best.ref));
      setPending(null);
    }
  };

  /* ---- wiring: press an output pin, release (or tap) on an input pin ---- */
  const startWire = (e: RPointerEvent, from: PortRef) => {
    if (readOnlyStructure) return;
    e.stopPropagation();
    const p = toSvg(e);
    setPending({ from, x: p.x, y: p.y });
    setSelected(null);
  };
  const finishWire = (e: RPointerEvent, to: PortRef) => {
    e.stopPropagation();
    if (!pending) return;
    onChange(connect(circuit, pending.from, to));
    setPending(null);
  };

  const onBackgroundPointerDown = () => {
    setSelected(null);
    setPending(null);
  };

  /* ---- palette ---- */
  const usedLabels = new Set(circuit.nodes.map((n) => (n.label ?? '').toUpperCase()));
  const nextLabel = (list: string[]) => list.find((l) => !usedLabels.has(l.toUpperCase())) ?? '';
  const addGate = (type: GateType) => {
    const column = type === 'INPUT' ? 24 : type === 'OUTPUT' ? width - NODE_W - 24 : width / 2 - NODE_W / 2;
    const rows = circuit.nodes.filter((n) => Math.abs(n.x - column) < 1).length;
    const y = Math.min(height - NODE_H - 8, 24 + rows * (NODE_H + 20));
    const label = type === 'INPUT' ? nextLabel(inputLabels) : type === 'OUTPUT' ? nextLabel(outputLabels) : undefined;
    const next = addNode(circuit, type, column, y, label);
    onChange(next);
    const added = next.nodes[next.nodes.length - 1];
    setSelected({ kind: 'node', id: added.id });
    setLabelDraft(added.label ?? '');
  };

  const deleteSelected = useCallback(() => {
    if (!selected || readOnlyStructure) return;
    onChange(selected.kind === 'node' ? removeNode(circuit, selected.id) : removeWire(circuit, selected.id));
    setSelected(null);
  }, [selected, circuit, onChange, readOnlyStructure]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'Escape') {
        setPending(null);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteSelected]);

  const selectedNode = selected?.kind === 'node' ? nodeById.get(selected.id) : undefined;
  const canRelabel = selectedNode && (selectedNode.type === 'INPUT' || selectedNode.type === 'OUTPUT');

  return (
    <div className="flex flex-col gap-2">
      {palette && !readOnlyStructure && (
        <div
          className="flex flex-nowrap items-center gap-1.5 h-11 overflow-x-auto select-none [scrollbar-width:thin]"
          role="toolbar"
          aria-label="Gate palette"
        >
          {palette.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => addGate(t)}
              title={GATE_INFO[t].description}
              className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm font-mono hover:border-ink-faint active:bg-bench"
            >
              {t === 'INPUT' ? '+ switch' : t === 'OUTPUT' ? '+ lamp' : `+ ${t}`}
            </button>
          ))}
          <span className="flex-1" />
          {selected ? (
            <>
              {canRelabel && (
                <label className="flex shrink-0 items-center gap-1.5 text-sm">
                  <span className="text-ink-soft">Label</span>
                  <input
                    value={labelDraft}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 6);
                      setLabelDraft(v);
                      onChange(relabelNode(circuit, selected.id, v));
                    }}
                    className="w-20 rounded border border-line bg-surface px-2 py-1 font-mono text-sm"
                    aria-label="Signal label"
                  />
                </label>
              )}
              <button
                type="button"
                onClick={deleteSelected}
                className="shrink-0 rounded-md border border-fault/40 text-fault bg-surface px-2.5 py-1.5 text-sm hover:bg-fault-soft"
              >
                Delete {selected.kind}
              </button>
            </>
          ) : (
            <span className="shrink-0 text-xs text-ink-faint py-1.5 hidden sm:inline">Select a gate or wire to edit it</span>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto touch-none select-none rounded-md bg-surface border border-line"
        style={{ aspectRatio: `${width} / ${height}` }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setDrag(null);
          setPending(null);
        }}
        onPointerDown={onBackgroundPointerDown}
        role="img"
        aria-label="Circuit canvas"
      >
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--color-line)" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#grid)" />

        {/* wires */}
        {circuit.wires.map((w) => {
          const a = nodeById.get(w.from.node);
          const b = nodeById.get(w.to.node);
          if (!a || !b) return null;
          const v = ev.wireValues[w.id];
          const isSel = selected?.kind === 'wire' && selected.id === w.id;
          return (
            <g key={w.id} className={v === 1 ? 'wire-high' : undefined}>
              <path
                d={wirePath(outputPinPos(a), inputPinPos(b, w.to.port))}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (!readOnlyStructure) setSelected({ kind: 'wire', id: w.id });
                }}
                style={{ cursor: readOnlyStructure ? 'default' : 'pointer' }}
              />
              <path
                d={wirePath(outputPinPos(a), inputPinPos(b, w.to.port))}
                fill="none"
                stroke={isSel ? 'var(--color-ink)' : signalColor(v)}
                strokeWidth={isSel ? 4 : 3}
                strokeDasharray={v === undefined ? '6 5' : undefined}
                pointerEvents="none"
              />
            </g>
          );
        })}

        {pending && (
          <path
            d={wirePath(outputPinPos(nodeById.get(pending.from.node)!), { x: pending.x, y: pending.y })}
            fill="none"
            stroke="var(--color-ink-faint)"
            strokeWidth={2}
            strokeDasharray="4 4"
            pointerEvents="none"
          />
        )}

        {/* nodes */}
        {circuit.nodes.map((n) => {
          const info = GATE_INFO[n.type];
          const v = ev.nodeValues[n.id];
          const isSel = selected?.kind === 'node' && selected.id === n.id;
          const unconnected = ev.unconnected.includes(n.id);
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`} style={{ cursor: 'grab' }}>
              {n.type === 'INPUT' ? (
                <g onPointerDown={(e) => onNodePointerDown(e, n.id)}>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={24}
                    fill={v === 1 ? 'var(--color-high)' : 'var(--color-bench-deep)'}
                    stroke={isSel ? 'var(--color-ink)' : 'var(--color-line)'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                  />
                  <circle cx={v === 1 ? NODE_W - 24 : 24} cy={NODE_H / 2} r={17} fill="var(--color-surface)" />
                  <text
                    x={v === 1 ? 22 : NODE_W - 22}
                    y={NODE_H / 2 + 6}
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontSize={18}
                    fontWeight={500}
                    fill={v === 1 ? 'white' : 'var(--color-ink-soft)'}
                  >
                    {v}
                  </text>
                  <text x={NODE_W / 2} y={-6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={13} fill="var(--color-ink)">
                    {n.label}
                  </text>
                </g>
              ) : n.type === 'OUTPUT' ? (
                <g onPointerDown={(e) => onNodePointerDown(e, n.id)}>
                  <circle
                    cx={NODE_W / 2}
                    cy={NODE_H / 2}
                    r={20}
                    fill={v === 1 ? 'var(--color-high-bright)' : v === 0 ? 'var(--color-bench-deep)' : 'var(--color-gold-soft)'}
                    stroke={isSel ? 'var(--color-ink)' : v === undefined ? 'var(--color-gold)' : 'var(--color-line)'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                    className={v === 1 ? 'wire-high' : undefined}
                  />
                  <text
                    x={NODE_W / 2}
                    y={NODE_H / 2 + 6}
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontSize={16}
                    fontWeight={500}
                    fill={v === 1 ? 'white' : 'var(--color-ink-soft)'}
                  >
                    {v === undefined ? '?' : v}
                  </text>
                  <text x={NODE_W / 2} y={-6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={13} fill="var(--color-ink)">
                    {n.label}
                  </text>
                </g>
              ) : (
                <g onPointerDown={(e) => onNodePointerDown(e, n.id)}>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={6}
                    fill="var(--color-surface)"
                    stroke={isSel ? 'var(--color-ink)' : unconnected ? 'var(--color-gold)' : 'var(--color-ink-soft)'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                  />
                  <text
                    x={NODE_W / 2}
                    y={NODE_H / 2 - 2}
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontSize={13}
                    fontWeight={500}
                    fill="var(--color-ink)"
                  >
                    {n.type}
                  </text>
                  <text x={NODE_W / 2} y={NODE_H / 2 + 14} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={11} fill="var(--color-ink-faint)">
                    {info.symbol}
                  </text>
                  {(n.type === 'NOT' || n.type === 'NAND' || n.type === 'NOR' || n.type === 'XNOR') && (
                    <circle cx={NODE_W + 1} cy={NODE_H / 2} r={4} fill="var(--color-surface)" stroke="var(--color-ink-soft)" strokeWidth={1.5} />
                  )}
                </g>
              )}

              {/* input pins */}
              {Array.from({ length: info.inputs }).map((_, port) => {
                const p = inputPinPos({ x: 0, y: 0, type: n.type }, port);
                const wired = circuit.wires.some((w) => w.to.node === n.id && w.to.port === port);
                return (
                  <circle
                    key={port}
                    cx={p.x}
                    cy={p.y}
                    r={PIN_R}
                    fill={wired ? 'var(--color-ink-soft)' : 'var(--color-surface)'}
                    stroke="var(--color-ink-soft)"
                    strokeWidth={1.5}
                    style={{ cursor: readOnlyStructure ? 'default' : 'crosshair' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => finishWire(e, { node: n.id, port })}
                    onClick={(e) => {
                      // Tap-to-connect for touch: a pending wire ends here.
                      if (pending) finishWire(e as unknown as RPointerEvent, { node: n.id, port });
                    }}
                  />
                );
              })}
              {/* output pin */}
              {info.outputs > 0 && (
                <circle
                  cx={NODE_W}
                  cy={NODE_H / 2}
                  r={PIN_R}
                  fill={signalColor(v)}
                  stroke="var(--color-ink-soft)"
                  strokeWidth={1.5}
                  style={{ cursor: readOnlyStructure ? 'default' : 'crosshair' }}
                  onPointerDown={(e) => startWire(e, { node: n.id, port: 0 })}
                />
              )}
            </g>
          );
        })}
      </svg>

      {!compact && (
        <p className="text-xs text-ink-soft">
          Drag a gate to move it. Tap a switch to flip it. Press an output pin and release on an input pin to wire
          them. Select a gate or wire and press Delete to remove it.
          {ev.hasLoop && <span className="text-fault"> The circuit has a feedback loop, so some values are undefined.</span>}
        </p>
      )}
    </div>
  );
}
