/**
 * Simulated X.509 certificates: a PEM block whose base64 body holds the certificate's fields as
 * JSON. openssl in the terminal reads and writes them; labs seed them with makeCert().
 */

import { fromBase64, sha1, toBase64 } from './hash.js';

export interface CertFields {
  subject: string;
  issuer?: string;
  notBefore: string;
  notAfter: string;
  serial?: string;
  san?: string[];
}

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';

/** A PEM certificate for the given fields (dates as ISO strings, e.g. 2026-12-01T00:00:00Z). */
export function makeCert(f: CertFields): string {
  const body = toBase64(JSON.stringify({ v: 3, issuer: f.issuer ?? f.subject, serial: f.serial ?? sha1(f.subject + f.notAfter).slice(0, 16).toUpperCase(), ...f }));
  return `${BEGIN}\n${body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n${END}\n`;
}

/** Reads the first certificate in PEM text, or null when the text holds none. */
export function readCert(pem: string): (CertFields & { issuer: string; serial: string }) | null {
  const m = new RegExp(`${BEGIN}\\s*([A-Za-z0-9+/=\\s]+?)\\s*${END}`).exec(pem);
  if (!m) return null;
  try {
    const f = JSON.parse(fromBase64(m[1])) as CertFields & { issuer: string; serial: string };
    return f.subject && f.notAfter ? f : null;
  } catch {
    return null;
  }
}

/** openssl's date style: "Dec  1 00:00:00 2026 GMT". */
export function opensslDate(iso: string): string {
  const d = new Date(iso);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

/** A fake private key block (labs only check where keys live and who can read them). */
export function makeKey(seed: string): string {
  const body = toBase64(sha1(seed).repeat(12));
  return `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END PRIVATE KEY-----\n`;
}
