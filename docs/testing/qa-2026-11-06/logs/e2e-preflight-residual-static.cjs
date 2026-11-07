"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {execFileSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {createRequire} = require("node:module");
const repository = path.resolve(__dirname,"../../../..");
const runtime = path.join(repository,"docs/testing/qa-2026-11-06/runtime/qa-residual-static");
const source = path.join(repository,"docs/testing/qa-2026-11-06/manual-review/pending/qa-residual-local-menus-20261106.test.ts");
const guard = path.join(repository,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
for(const target of [runtime,__dirname,source,guard]) {
  if(!target.startsWith(repository+path.sep)) throw new Error("RLM static probe escapes tree");
  for(let cursor=target;;cursor=path.dirname(cursor)) {if(fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink()||fs.realpathSync.native(cursor).toLowerCase()!==cursor.toLowerCase()))throw new Error("RLM static rejects links");if(cursor===path.dirname(cursor))break;}
}
const audit = fs.readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$target=$env:RLM_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RLM static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe",["-NoProfile","-NonInteractive","-Command",audit],{env:{...process.env,RLM_STATIC_TARGET:runtime,QA_REPARSE_WORKTREE:repository},windowsHide:true,stdio:"pipe",timeout:30000});
for(const key of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"]){process.env[key]=path.join(runtime,key.toLowerCase());if(key==="npm_config_userconfig"){fs.mkdirSync(path.dirname(process.env[key]),{recursive:true});fs.writeFileSync(process.env[key],"");}else fs.mkdirSync(process.env[key],{recursive:true});}
process.env.E2E_PROVIDER_HTTP_MODE="replay";process.env.ZCODE_E2E_MANUAL_REVIEW="1";process.env.NODE_OPTIONS="";
const ts=require("typescript");
const configPath=path.join(repository,"packages/desktop/tsconfig.e2e.json");
const config=ts.readConfigFile(configPath,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
const options={...parsed.options,rootDir:repository,composite:false,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
// 使用 services 自己已有的第三方声明，不用 QA shim 假造产品类型。
const declarationSources=[path.join(repository,"packages/services/src/types/yazl.d.ts"),path.join(repository,"packages/services/src/runtime-tools/node-forge.d.ts")];
const program=ts.createProgram([source,...declarationSources],options);
const diagnostics=ts.getPreEmitDiagnostics(program).map(item=>({file:item.file?.fileName??null,code:item.code,line:item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start).line+1:null,message:ts.flattenDiagnosticMessageText(item.messageText,"\n")}));
const cases=[];globalThis.describe=(_title,callback)=>callback();globalThis.it=(title,_callback)=>cases.push(title);globalThis.before=globalThis.after=globalThis.beforeEach=globalThis.afterEach=()=>undefined;
const evidence={capturedAt:new Date().toISOString(),evidenceKind:"TypeScript noEmit, actual tsx import/13-case registration, public archive encode+decode only; no hooks/cases/UI/Host import executed",source,sourceSha256:createHash("sha256").update(fs.readFileSync(source)).digest("hex"),declarationSources,diagnostics,registeredCases:cases};
function saveEvidence(){fs.writeFileSync(path.join(__dirname,"e2e-preflight-residual-static.json"),JSON.stringify(evidence,null,2)+"\n");process.stdout.write(JSON.stringify(evidence,null,2)+"\n");}
(async()=>{
  const {tsImport}=require("tsx/esm/api");const imported=await tsImport(pathToFileURL(source).href,{parentURL:pathToFileURL(__filename).href,tsconfig:configPath});
  const publicEntry=createRequire(path.join(repository,"packages/desktop/package.json")).resolve("@zcode/services/node");
  const service=await tsImport(pathToFileURL(publicEntry).href,{parentURL:pathToFileURL(__filename).href,tsconfig:configPath});
  const bytes=await service.encodeConversationArchive(imported.residualArchiveInput());const decoded=await service.decodeConversationArchive(bytes);
  evidence.publicEntry=publicEntry;evidence.fixture={byteLength:bytes.length,title:decoded.content.title,rows:decoded.content.rows,artifacts:decoded.artifacts.size};
  const oxlintEntry=path.join(path.dirname(require.resolve("oxlint/package.json")),"bin/oxlint");
  try {evidence.targetedLint={exitCode:0,output:execFileSync(process.execPath,[oxlintEntry,"--deny-warnings","--no-ignore",source],{cwd:repository,env:process.env,windowsHide:true,encoding:"utf8"}).trim()};}
  catch(error){evidence.targetedLint={exitCode:error.status??1,output:String(error.stdout??"")+String(error.stderr??"")};process.exitCode=1;}
  saveEvidence();if(diagnostics.length||cases.length!==13||decoded.content.rows.length!==3||decoded.artifacts.size!==0)process.exitCode=1;
})().catch(error=>{evidence.importError=error.stack;saveEvidence();process.exitCode=1;});
