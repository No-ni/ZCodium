import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const facadePath = resolve(import.meta.dirname, '../reload-observation.cjs');
const implementationPath = resolve(import.meta.dirname, '../qa-reload-observer.ts');
const facade = require(facadePath);
const loaded = await facade.loadObserverForStaticCheck();
for (const exportName of ['beginReloadObservation', 'finishReloadObservation']) {
  if (typeof facade[exportName] !== 'function' || typeof loaded[exportName] !== 'function') throw new Error(`Missing observer export: ${exportName}`);
}
const hashes = {};
for (const source of [facadePath, implementationPath]) hashes[source] = createHash('sha256').update(await readFile(source)).digest('hex');
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), check: 'CJS facade + tsImport static loading; zero browser methods, zero process scans, zero hooks executed', exports: ['beginReloadObservation', 'finishReloadObservation'], hashes }));
