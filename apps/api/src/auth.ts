/** Password hashing (scrypt, built into Node) and opaque session tokens. No external crypto. */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), 64);
  const want = Buffer.from(keyB64, 'base64');
  return key.length === want.length && timingSafeEqual(key, want);
}

/** A random bearer token for the client, and the hash we keep. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export const SESSION_DAYS = 60;

/** Derives a username from an email: lower-case, [a-z0-9_], 3 to 20 characters. */
export function usernameFromEmail(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  return base.length >= 3 ? base : `${base}user`.slice(0, 20).padEnd(3, '0');
}

/** A tiny in-memory rate limit for sign-in and sign-up: `limit` hits per `windowMs` per key. */
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear(); // keep memory bounded under abuse
    return true;
  };
}
