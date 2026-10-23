/** A stable filesystem UUID for a device path, as blkid shows it. It has no imports, so labs can use it without loading the command tables. */
export function uuidOf(dev: string): string {
  let h = 2166136261;
  for (const c of dev) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const x = (n: number) => (Math.abs(Math.imul(h, n)) >>> 0).toString(16).padStart(8, '0');
  return `${x(3)}-${x(5).slice(0, 4)}-${x(7).slice(0, 4)}-${x(11).slice(0, 4)}-${x(13)}${x(17).slice(0, 4)}`;
}
