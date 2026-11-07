import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from '../../../../node_modules/typescript/lib/typescript.js';

const root = resolve(import.meta.dirname, '../../../..');
const spec = join(root, 'docs/testing/qa-2026-11-06/manual-review/pending/qa-bug004-desktop-migration-20261107.test.ts');
const output = join(import.meta.dirname, 'validation-bug004-e2e-static.json');
const corepack = 'C:/Program Files/nodejs/node_modules/corepack/dist/corepack.js';
async function safe(path) {
  assert.ok(isAbsolute(path));
  const rel = relative(root, path);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try { assert.ok(!(await lstat(cursor)).isSymbolicLink()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === parse(cursor).root) break;
  }
}

test('BUG004 pending E2E static admission; does not run UI', async () => {
  await safe(spec); await safe(output);
  for (const key of ['HOME','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA','COREPACK_HOME','TSX_CACHE_DIR','npm_config_cache','npm_config_store_dir'])
    await safe(resolve(process.env[key] ?? ''));
  assert.equal(process.env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(process.env.npm_config_manage_package_manager_versions, 'false');
  const source = await readFile(spec, 'utf8');
  const transpiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }, reportDiagnostics: true, fileName: spec });
  assert.equal((transpiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const rawScripts = [...source.matchAll(/String\.raw`([\s\S]*?)`/gu)].map(match => match[1]);
  assert.equal(rawScripts.length, 1);
  for (const script of rawScripts) { assert.ok(!script.includes('__name')); new Function(script); }

  const titles = [], hooks = [], stack = [];
  let browserAccesses = 0;
  globalThis.describe = (title, body) => { stack.push(title); body(); stack.pop(); };
  globalThis.it = (title) => { titles.push([...stack, title].join(' ')); };
  globalThis.before = () => { hooks.push('before'); };
  globalThis.afterEach = () => { hooks.push('afterEach'); };
  globalThis.browser = new Proxy({}, {get() { browserAccesses++; throw new Error('Static admission must not access browser'); }});
  const { tsImport } = await import(pathToFileURL(join(root, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
  await tsImport(pathToFileURL(spec).href, import.meta.url);
  assert.equal(titles.length, 2); assert.equal(browserAccesses, 0);
  assert.deepEqual(hooks, ['before', 'afterEach']);
  assert.ok(titles.every(title => /(?:^| )B4UI0[12]：/u.test(title)));

  const startupFiles = ['packages/desktop/wdio.conf.ts', 'packages/desktop/test/e2e/helpers/e2e-before-session.ts'];
  const startupSources = await Promise.all(startupFiles.map(path => readFile(join(root, path), 'utf8')));
  assert.ok(startupSources[0].includes('resetHome: resetE2EHome'));
  assert.ok(startupSources[0].includes('seedE2EStartupState(specs);'));
  assert.ok(startupSources[0].includes('workspacePath: legacyDefaultProjectPath,'));
  assert.ok(startupSources[1].includes('await options.resetHome(options.specs);'));
  assert.ok(!source.includes('prepareV4ConversationE2E'));
  assert.ok(!source.includes('new DatabaseSync(DATABASE)'));

  const lintArgs = [corepack, 'pnpm', 'exec', 'oxlint', relative(root, spec), 'docs/testing/qa-2026-11-06/logs/validation-bug004-e2e-static.mjs'];
  // 使用父 runner 已审查的固定工具/隔离环境；不下载、不生成声明或启动桌面。
  const child = spawn(process.execPath, lintArgs, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
  const lintCode = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('close', resolveExit); });
  const lintOutput = Buffer.concat(chunks).toString('utf8');
  await safe(join(import.meta.dirname, 'validation-bug004-e2e-owned-lint.log'));
  await writeFile(join(import.meta.dirname, 'validation-bug004-e2e-owned-lint.log'), lintOutput, 'utf8');
  const evidence = { capturedAt: new Date().toISOString(), scope: 'Static only; 2 registered E2E cases, no hook/body/browser/build execution. Full typecheck is owned by root.',
    sourceSha256: createHash('sha256').update(source).digest('hex'), node: process.version,
    transpileErrors: 0, rawScriptSyntaxCount: rawScripts.length, registeredFullTitles: titles, registeredHooks: hooks, browserAccesses,
    startupSourceHashes: Object.fromEntries(startupFiles.map((path,index) => [path,createHash('sha256').update(startupSources[index]).digest('hex')])),
    startupEvidenceBoundary: 'Current default prelaunch seed contract inspected statically; actual UI/runtime evidence is pending root execution.',
    lint: { command: 'corepack pnpm exec oxlint ' + lintArgs.slice(4).join(' '), code: lintCode, output: lintOutput } };
  await writeFile(output, JSON.stringify(evidence, null, 2), 'utf8');
  assert.equal(lintCode, 0);
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
});
