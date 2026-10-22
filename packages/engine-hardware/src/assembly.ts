/**
 * PC assembly: parts, slots and the compatibility rules a bench applies when a part is placed.
 */

export type PartKind = 'motherboard' | 'cpu' | 'cooler' | 'ram' | 'gpu' | 'nvme' | 'sata-ssd' | 'hdd' | 'psu' | 'case' | 'cable' | 'fan';

export interface Part {
  id: string;
  kind: PartKind;
  name: string;
  /** Free-form specs used by the rules: socket, ddr, formFactor, formFactors, sockets, watts, length, gpuClearance, m2, lanes, connectors... */
  specs: Record<string, string | number | boolean>;
  /** Approximate power draw in watts, for the PSU budget. */
  watts?: number;
  price?: number;
}

export interface Slot {
  id: string;
  label: string;
  accepts: PartKind[];
  /** Slot-level specs: e.g. { pcie: 'x16' } or { form: 'DIMM' }. */
  specs?: Record<string, string | number | boolean>;
  required?: boolean;
}

export interface Build {
  parts: Part[];
  slots: Slot[];
}

export interface Placement {
  slot: string;
  part: string;
}

export interface Problem {
  slot: string;
  part: string;
  message: string;
}

export interface Validation {
  problems: Problem[];
  missing: Slot[];
  wattage: { used: number; rating: number | null; ok: boolean };
}

function spec(p: Part | undefined, key: string): string | number | boolean | undefined {
  return p?.specs[key];
}

function list(v: string | number | boolean | undefined): string[] {
  return v === undefined ? [] : String(v).split(/[,\s]+/).filter(Boolean);
}

/** Checks whether `part` may go into `slot` given what is already placed. Returns a message, or null when fine. */
export function placementProblem(build: Build, placements: Record<string, string>, slotId: string, partId: string): string | null {
  const slot = build.slots.find((s) => s.id === slotId);
  const part = build.parts.find((p) => p.id === partId);
  if (!slot || !part) return 'Unknown slot or part.';
  if (!slot.accepts.includes(part.kind)) return `${part.name} does not fit in ${slot.label}: that slot takes ${slot.accepts.join(' or ')}.`;
  const placedPart = (kind: PartKind): Part | undefined => {
    for (const [s, p] of Object.entries(placements)) {
      if (s === slotId) continue;
      const pp = build.parts.find((x) => x.id === p);
      if (pp?.kind === kind) return pp;
    }
    return undefined;
  };
  const mb = part.kind === 'motherboard' ? part : placedPart('motherboard');
  const pcCase = part.kind === 'case' ? part : placedPart('case');
  switch (part.kind) {
    case 'cpu':
      if (mb && spec(mb, 'socket') !== spec(part, 'socket')) return `${part.name} uses socket ${String(spec(part, 'socket'))}, but the motherboard has ${String(spec(mb, 'socket'))}. It will not fit.`;
      break;
    case 'cooler':
      if (mb && !list(spec(part, 'sockets')).includes(String(spec(mb, 'socket')))) return `${part.name} has no mounting kit for socket ${String(spec(mb, 'socket'))}.`;
      break;
    case 'ram':
      if (mb && spec(mb, 'ddr') !== spec(part, 'ddr')) return `${part.name} is ${String(spec(part, 'ddr'))}, but the motherboard takes ${String(spec(mb, 'ddr'))}. The notch is in a different place; it cannot be forced.`;
      if (slot.specs?.form && spec(part, 'form') && slot.specs.form !== spec(part, 'form')) return `${part.name} is a ${String(spec(part, 'form'))} module; ${slot.label} takes ${String(slot.specs.form)}.`;
      break;
    case 'gpu':
      if (slot.specs?.pcie && slot.specs.pcie !== 'x16') return `A graphics card needs a PCIe x16 slot; ${slot.label} is ${String(slot.specs.pcie)}.`;
      if (pcCase && typeof spec(part, 'length') === 'number' && typeof spec(pcCase, 'gpuClearance') === 'number' && Number(spec(part, 'length')) > Number(spec(pcCase, 'gpuClearance'))) return `${part.name} is ${String(spec(part, 'length'))} mm long; the case has ${String(spec(pcCase, 'gpuClearance'))} mm of clearance.`;
      break;
    case 'motherboard':
      if (pcCase && !list(spec(pcCase, 'formFactors')).includes(String(spec(part, 'formFactor')))) return `${part.name} is ${String(spec(part, 'formFactor'))}; the case supports ${list(spec(pcCase, 'formFactors')).join(', ')}.`;
      break;
    case 'case':
      if (mb && !list(spec(part, 'formFactors')).includes(String(spec(mb, 'formFactor')))) return `${part.name} supports ${list(spec(part, 'formFactors')).join(', ')} boards; the motherboard is ${String(spec(mb, 'formFactor'))}.`;
      break;
    case 'psu':
      if (pcCase && spec(pcCase, 'psuForm') && spec(part, 'formFactor') && spec(pcCase, 'psuForm') !== spec(part, 'formFactor')) return `${part.name} is an ${String(spec(part, 'formFactor'))} supply; the case takes ${String(spec(pcCase, 'psuForm'))}.`;
      break;
    case 'nvme':
      if (slot.specs?.m2 === false) return `${slot.label} is not an M.2 slot.`;
      break;
  }
  return null;
}

export function validateBuild(build: Build, placements: Record<string, string>, margin = 1.25): Validation {
  const problems: Problem[] = [];
  for (const [slotId, partId] of Object.entries(placements)) {
    const msg = placementProblem(build, placements, slotId, partId);
    if (msg) problems.push({ slot: slotId, part: partId, message: msg });
  }
  const placedParts = Object.values(placements).map((id) => build.parts.find((p) => p.id === id)).filter((p): p is Part => !!p);
  const psu = placedParts.find((p) => p.kind === 'psu');
  const used = placedParts.filter((p) => p.kind !== 'psu').reduce((s, p) => s + (p.watts ?? 0), 0) + 40; // 40 W for board, fans and drives
  const rating = psu ? Number(spec(psu, 'watts')) || null : null;
  const ok = rating !== null && rating >= used * margin;
  if (psu && !ok) problems.push({ slot: Object.entries(placements).find(([, p]) => p === psu.id)?.[0] ?? '', part: psu.id, message: `${psu.name} is rated ${rating} W, but the build draws about ${used} W and needs ${Math.ceil(used * margin)} W with a ${Math.round((margin - 1) * 100)}% margin.` });
  const missing = build.slots.filter((s) => s.required && !placements[s.id]);
  return { problems, missing, wattage: { used, rating, ok } };
}

/** The sum of placed parts' prices. */
export function buildCost(build: Build, placements: Record<string, string>): number {
  return Object.values(placements).reduce((s, id) => s + (build.parts.find((p) => p.id === id)?.price ?? 0), 0);
}
