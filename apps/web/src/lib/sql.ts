/** Configures the SQL engine for the browser: the SQLite WebAssembly file is bundled with the app, so it works offline. */

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { setSqlLoader } from '@cslab/engine-sql';

let configured = false;

export function configureSqlEngine(): void {
  if (configured) return;
  configured = true;
  setSqlLoader(() => initSqlJs({ locateFile: () => wasmUrl }));
}
