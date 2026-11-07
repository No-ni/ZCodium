import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, parse, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../../..');
const runtime = resolve(root, '.run-logs/qa-2026-11-06/validation/bug004');
const workerSource = resolve(root, 'packages/desktop/src/host/database-startup/tasksStorageWorker.ts');
const tsxApi = resolve(root, 'node_modules/tsx/dist/esm/api/index.mjs');
const invocation = process.argv.includes('--before-fix') ? 'before-fix' : 'after-fix';
async function safePath(path) {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('BUG004 fixture outside worktree');
  for (let current = absolute; ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('BUG004 linked path');
      if ((await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('BUG004 redirected path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === parse(current).root) break;
  }
}
async function safeTree(path) {
  await safePath(path);
  try {
    if ((await lstat(path)).isDirectory()) for (const entry of await readdir(path)) await safeTree(join(path, entry));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await safeTree(runtime);
await safePath(workerSource);
await safePath(tsxApi);
await mkdir(runtime, {recursive: true});
const bootstrap = join(runtime, `worker-bootstrap-${invocation}.mjs`);
await safePath(bootstrap);
await writeFile(bootstrap, `import {tsImport} from ${JSON.stringify(pathToFileURL(tsxApi).href)};\nawait tsImport(${JSON.stringify(pathToFileURL(workerSource).href)}, import.meta.url);\n`, 'utf8');
const oldSchemaSource = await readFile(resolve(root, 'packages/services/src/session/tasksDatabase/schema-v1.ts'), 'utf8');
const oldSchemaModule = ts.transpileModule(oldSchemaSource, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
const oldSchema = {};
new Function('exports', oldSchemaModule)(oldSchema);
const migrationTablesSource = await readFile(resolve(root, 'packages/services/src/project-storage/schema.ts'), 'utf8');
const tableMatch = migrationTablesSource.match(/export const PROJECT_MIGRATION_TABLES = \[([\s\S]+?)\] as const;/u);
assert.ok(tableMatch);
const touchedTables = new Set([...tableMatch[1].matchAll(/"([a-z_]+)"/gu)].map(match => match[1]));
const cases = [];
async function fixture(label, settings = {}) {
  const path = join(runtime, `${invocation}-${label}`);
  await safePath(path);
  try { await lstat(path); throw new Error('BUG004 fixture name already used'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path);
  const directories = Object.fromEntries(['home','tmp','cache','appdata','localappdata','config','data','logs'].map(name => [name, join(path, name)]));
  for (const directory of Object.values(directories)) { await safePath(directory); await mkdir(directory); }
  const configuration = join(directories.home, '.zcodium/v2/setting.json');
  await safePath(configuration); await mkdir(dirname(configuration), {recursive:true});
  await writeFile(configuration, JSON.stringify({closeToTrayOnWindowsMigrationInitialized:true,messageStreamShowReasoningMigrationInitialized:true,taskAutoArchiveResetVersion:1,...settings}), 'utf8');
  const dbPath = join(directories.data, '.zcodium/v2/tasks-index.sqlite');
  await safePath(dbPath); await mkdir(dirname(dbPath), {recursive:true});
  const fixed = {
    HOME:directories.home,USERPROFILE:directories.home,ZCODE_DESKTOP_HOME_DIR:directories.home,
    TEMP:directories.tmp,TMP:directories.tmp,TMPDIR:directories.tmp,APPDATA:directories.appdata,LOCALAPPDATA:directories.localappdata,
    XDG_CACHE_HOME:directories.cache,XDG_CONFIG_HOME:directories.config,XDG_DATA_HOME:directories.data,
    ZCODE_DATA_BASE_DIR:directories.data,ZCODIUM_DATA_DIR:directories.data,ZCODE_STORAGE_DIR:join(directories.data,'.zcodium'),ZCODE_LOG_DIR:directories.logs,
    TSX_CACHE_DIR:join(directories.cache,'tsx'),TSX_DISABLE_CACHE:'1',NODE_DISABLE_COMPILE_CACHE:'1',DISABLE_V8_COMPILE_CACHE:'1',
    NODE_COMPILE_CACHE:join(directories.cache,'node'),V8_COMPILE_CACHE_CACHE_DIR:join(directories.cache,'v8'),
    COREPACK_HOME:resolve(runtime,'../corepack'),COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_AUTO_PIN:'0',
    npm_config_cache:join(directories.cache,'npm'),npm_config_store_dir:join(directories.cache,'store'),npm_config_userconfig:join(directories.config,'npmrc'),
    ZCODE_RUNTIME_ENV:'test',ZCODE_ENV:'test',ZCODE_LOCAL_RESOURCE_MONITORING:'0',
  };
  const removed = new Set(['NODE_OPTIONS','NODE_TEST_CONTEXT',...Object.keys(fixed)].map(name=>name.toUpperCase()));
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([name])=>!removed.has(name.toUpperCase())&&!name.toUpperCase().startsWith('ZCODE_')&&!name.toUpperCase().startsWith('ZCODIUM_'))),...fixed};
  await safeTree(path);
  return {path,dbPath,configuration,env};
}
async function runWorker(target) {
  await safeTree(target.path);
  const frames=[];
  const child = new Worker(bootstrap,{workerData:{path:target.dbPath},env:target.env,execArgv:[],stdout:true,stderr:true});
  child.stdout.resume(); child.stderr.resume();
  let failure;
  child.on('message',value=>frames.push(value));
  child.on('error',error=>{failure=error;});
  const exit = await new Promise(resolveExit=>child.on('exit',resolveExit));
  if(failure) throw failure;
  assert.equal(exit,0);assert.equal(frames.filter(frame=>frame.type==='done').length,1);assert.equal(frames.filter(frame=>frame.type==='failed').length,0);
  return frames;
}
function snapshot(dbPath) {
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const hashes=Object.fromEntries(tables.map(name=>[name,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all())).digest('hex')]));
    return {tables,hashes,projects:tables.includes('projects')?db.prepare('SELECT * FROM projects ORDER BY position,project_id').all():[],roots:tables.includes('project_roots')?db.prepare('SELECT * FROM project_roots ORDER BY project_id,position').all():[],tasks:db.prepare('SELECT * FROM tasks ORDER BY task_id').all(),ledger:tables.includes('schema_migration')?db.prepare('SELECT * FROM schema_migration ORDER BY id').all():[]};
  } finally {db.close();}
}
async function seedLegacy(target,workspaces) {
  const db=new DatabaseSync(target.dbPath);
  try {
    db.exec(oldSchema.TASK_INDEX_SCHEMA);db.exec('CREATE TABLE fixture_unrelated(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO fixture_unrelated VALUES(?,?)').run('sentinel','unrelated-preserved');
    for(const [index,workspace] of workspaces.entries()) db.prepare("INSERT INTO tasks(workspace_key,workspace_path,task_id,title,task_status,provider,created_at,updated_at,pinned,archived,unread_at,meta_json) VALUES(?,?,?,?,?,'glm',?,?,1,0,?,?)").run(workspace,workspace,`fixture-${index}`,`legacy-${index}`,'completed',10+index,20+index,30+index,'{}');
  } finally {db.close();}
}
test('BUG004: real storage Worker migrates saved local projects before ready and reopens idempotently',async()=>{
  const target=await fixture('saved-projects');
  const savedA=join(target.path,'workspaces','saved-a'),savedB=join(target.path,'workspaces','empty-saved'),conversation=join(target.path,'workspaces','conversation'),taskOnly=join(target.path,'workspaces','removed-project'),recentOnly=join(target.path,'workspaces','recent-only');
  for(const path of [savedA,savedB,conversation,taskOnly,recentOnly]){await safePath(path);await mkdir(path,{recursive:true});}
  await writeFile(target.configuration,JSON.stringify({closeToTrayOnWindowsMigrationInitialized:true,messageStreamShowReasoningMigrationInitialized:true,taskAutoArchiveResetVersion:1,lastWorkspaceSession:[{kind:'local',workspacePath:savedA,workspacePurpose:'project'},{kind:'local',workspacePath:conversation,workspacePurpose:'conversation'},{kind:'local',workspacePath:savedA,workspacePurpose:'project'},{kind:'local',workspacePath:savedB,workspacePurpose:'project'}],recentProjects:[recentOnly]}),'utf8');
  await seedLegacy(target,[savedA,taskOnly,conversation]);
  const before=snapshot(target.dbPath);const frames=await runWorker(target);const after=snapshot(target.dbPath);
  cases.push({label:'saved-projects',frames,before,after});
  assert.deepEqual(after.projects.map(row=>row.name),['saved-a','empty-saved']);
  assert.deepEqual(after.projects.map(row=>row.position),[0,1]);
  assert.deepEqual(after.roots.map(row=>row.root_path).sort(),[savedA,savedB].sort());
  assert.ok(after.roots.every(row=>row.is_primary===1&&row.position===0));
  for(const original of before.tasks){const actual=after.tasks.find(row=>row.task_id===original.task_id);for(const key of ['workspace_key','workspace_path','task_id','title','created_at','updated_at','pinned','archived','unread_at','deleted'])assert.equal(actual[key],original[key],key);assert.equal(actual.host_id,'local');assert.equal(actual.root_path,original.workspace_path);assert.equal(actual.project_id,original.workspace_path===savedA?after.projects[0].project_id:null);}
  for(const table of before.tables)if(!touchedTables.has(table))assert.equal(after.hashes[table],before.hashes[table],table);
  assert.equal(after.ledger.find(row=>row.id==='0005_projects').checksum,'ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da');
  await runWorker(target);const reopened=snapshot(target.dbPath);assert.deepEqual(reopened.hashes,after.hashes);cases.push({label:'saved-projects-reopen',reopened});
});
test('BUG004: first install without saved projects remains empty',async()=>{
  const target=await fixture('fresh-install');await seedLegacy(target,[]);await runWorker(target);const after=snapshot(target.dbPath);assert.equal(after.projects.length,0);assert.equal(after.roots.length,0);cases.push({label:'fresh-install',after});
});
test('BUG004: an already committed empty 0005 ledger is not silently replayed',async()=>{
  const target=await fixture('existing-ledger');await seedLegacy(target,[]);await runWorker(target);const before=snapshot(target.dbPath);const saved=join(target.path,'workspaces','later-saved');await safePath(saved);await mkdir(saved,{recursive:true});await writeFile(target.configuration,JSON.stringify({closeToTrayOnWindowsMigrationInitialized:true,messageStreamShowReasoningMigrationInitialized:true,taskAutoArchiveResetVersion:1,lastWorkspaceSession:[{kind:'local',workspacePath:saved,workspacePurpose:'project'}]}),'utf8');await runWorker(target);const after=snapshot(target.dbPath);assert.deepEqual(after.hashes,before.hashes);assert.equal(after.projects.length,0);cases.push({label:'existing-ledger',before,after});
});
test.after(async()=>{
  const evidence=resolve(import.meta.dirname,`validation-bug004-worker-${invocation}.json`);await safePath(evidence);await writeFile(evidence,JSON.stringify({capturedAt:new Date().toISOString(),scope:'Actual source Worker module loaded by tsx, original SettingService/startup/Repo/migrations, project-owned synthetic profile. Not Electron UI, installer, macOS, phone, remote, or real-user migration.',invocation,cases},null,2)+'\n','utf8');
});
