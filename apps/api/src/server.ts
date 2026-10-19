/**
 * Starts the API and, when WEB_DIST is set, serves the built web app from the same origin.
 *
 * Environment:
 *   PORT          default 8787
 *   DATABASE_URL  postgres://user:pass@host:5432/db (production). Absent = embedded PGlite in DATA_DIR.
 *   DATA_DIR      folder for the embedded database (development), default ./.data/pglite
 *   WEB_DIST      path to apps/web/dist to serve the app; absent in development (Vite serves it)
 *   CORS_ORIGIN   comma-separated origins allowed to call the API cross-origin (rarely needed)
 *   RESEARCH_SALT secret that derives research ids from user ids for learning analytics.
 *                 Required in production (DATABASE_URL set); never change it once data exists.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { migrate } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../.data/pglite');

const researchSalt = process.env.RESEARCH_SALT;
if (process.env.DATABASE_URL && (!researchSalt || researchSalt.length < 32)) {
  console.error('RESEARCH_SALT must be a long random secret (32+ characters) in production. See .env.example.');
  process.exit(1);
}

const db = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir });
const applied = await migrate(db);
const app = await buildApp({ db, corsOrigin: process.env.CORS_ORIGIN, logger: true, researchSalt });

const webDist = process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : undefined;
if (webDist && existsSync(path.join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, wildcard: true });
  // The service worker and the HTML shell must always be revalidated; hashed assets never change.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) return;
    const path = req.url.split('?')[0];
    if (path.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else reply.header('Cache-Control', 'no-cache');
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'No such API route.' });
    return reply.sendFile('index.html');
  });
}

app.log.info({ database: db.kind, migrationsApplied: applied, webDist: webDist ?? null }, 'starting');
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => db.close()).finally(() => process.exit(0));
  });
}
