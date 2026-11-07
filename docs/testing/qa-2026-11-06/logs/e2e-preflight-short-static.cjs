"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {execFileSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {createRequire} = require("node:module");
const repository = path.resolve(__dirname,"../../../..");
const runtime = path.join(repository,"docs/testing/qa-2026-11-06/runtime/qa-short-static");
const source = path.join(repository,"docs/testing/qa-2026-11-06/manual-review/pending/qa-short-local-menus-20261106.test.ts");
const guard = path.join(repository,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
for(const target of [runtime,__dirname,source,guard]) {
  if(!target.startsWith(repository+path.sep)) throw new Error("SLM static probe escapes tree");
  for(let cursor=target;;cursor=path.dirname(cursor)) {if(fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink()||fs.realpathSync.native(cursor).toLowerCase()!==cursor.toLowerCase()))throw new Error("SLM static rejects links");if(cursor===path.dirname(cursor))break;}
}
const audit = fs.readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$target=$env:SLM_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SLM static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe",["-NoProfile","-NonInteractive","-Command",audit],{env:{...process.env,SLM_STATIC_TARGET:runtime,QA_REPARSE_WORKTREE:repository},windowsHide:true,stdio:"pipe",timeout:30000});
for(const key of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"]){process.env[key]=path.join(runtime,key.toLowerCase());if(key==="npm_config_userconfig"){fs.mkdirSync(path.dirname(process.env[key]),{recursive:true});fs.writeFileSync(process.env[key],"");}else fs.mkdirSync(process.env[key],{recursive:true});}
process.env.E2E_PROVIDER_HTTP_MODE="replay";process.env.ZCODE_E2E_MANUAL_REVIEW="1";process.env.NODE_OPTIONS="";
const ts=require("typescript");
const configPath=path.join(repository,"docs/testing/qa-2026-11-06/tsconfig.qa.json");
const config=ts.readConfigFile(configPath,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
const options={...parsed.options,rootDir:repository,composite:false,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
const program=ts.createProgram(parsed.fileNames,options);
const diagnostics=ts.getPreEmitDiagnostics(program).map(item=>({file:item.file?.fileName??null,code:item.code,line:item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start).line+1:null,message:ts.flattenDiagnosticMessageText(item.messageText,"\n")}));
// 已发现SPFV的tsx keepNames闭包风险：只求值回调函数本身，不执行其UI/Node操作。
const esbuild=createRequire(require.resolve("tsx/esm/api"))("esbuild");
const vm=require("node:vm");
const callbackClosureFindings=[];let checkedCallbacks=0;
const rawScriptDiagnostics=[];let checkedRawScripts=0;
let sourceAst;
function visitCallbacks(node){
  if(ts.isCallExpression(node)&&/^(browser\.execute|browser\.electron\.execute)$/u.test(node.expression.getText(sourceAst))&&node.arguments[0]&&(ts.isArrowFunction(node.arguments[0])||ts.isFunctionExpression(node.arguments[0]))){
    checkedCallbacks++;const callback=node.arguments[0];const output=esbuild.transformSync("module.exports=("+callback.getText(sourceAst)+");",{loader:"ts",target:"es2022",keepNames:true}).code;
    const context={module:{exports:null}};vm.runInNewContext(output,context);if(/__name\d*\(/u.test(context.module.exports.toString()))callbackClosureFindings.push({source:sourceAst.fileName,line:sourceAst.getLineAndCharacterOfPosition(callback.getStart(sourceAst)).line+1,helper:"esbuild keepNames __name inside serialized callback"});
  }
  if(ts.isCallExpression(node)&&node.expression.getText(sourceAst)==="browser.execute"&&node.arguments[0]&&(ts.isNoSubstitutionTemplateLiteral(node.arguments[0])||ts.isStringLiteral(node.arguments[0]))){checkedRawScripts++;try{new vm.Script("(function(){"+node.arguments[0].text+"})");}catch(error){rawScriptDiagnostics.push({source:sourceAst.fileName,line:sourceAst.getLineAndCharacterOfPosition(node.arguments[0].getStart(sourceAst)).line+1,error:error.message});}}
  ts.forEachChild(node,visitCallbacks);
}
for(const name of ["qa-short-local-menus-20261106.test.ts","qa-local-menu-actions-20261106.test.ts","qa-residual-local-menus-20261106.test.ts"]){const file=path.join(repository,"docs/testing/qa-2026-11-06/manual-review/pending",name);sourceAst=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);visitCallbacks(sourceAst);}
for (const helper of ["qa-local-rpc-probe.ts","qa-menu-dom.ts"]) { sourceAst=ts.createSourceFile(path.join(repository,"docs/testing/qa-2026-11-06",helper),fs.readFileSync(path.join(repository,"docs/testing/qa-2026-11-06",helper),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);visitCallbacks(sourceAst); }
const cases=[];globalThis.describe=(_title,callback)=>callback();globalThis.it=(title,_callback)=>cases.push(title);globalThis.before=globalThis.after=globalThis.beforeEach=globalThis.afterEach=()=>undefined;
const sourceFiles=[source,path.join(path.dirname(source),"qa-local-menu-actions-20261106.test.ts"),path.join(path.dirname(source),"qa-residual-local-menus-20261106.test.ts"),path.join(repository,"docs/testing/qa-2026-11-06/qa-local-rpc-probe.ts"),path.join(repository,"docs/testing/qa-2026-11-06/qa-menu-dom.ts")];
const evidence={capturedAt:new Date().toISOString(),evidenceKind:"All external QA TypeScript noEmit; actual tsx import/15-case registration; serialized callback keepNames audit; public archive encode/decode; no hooks/cases/UI/Host/PTY executed",source,sourceSha256:createHash("sha256").update(fs.readFileSync(source)).digest("hex"),sourceFiles:sourceFiles.map(file=>({file,sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")})),diagnostics,registeredCases:cases,checkedCallbacks,callbackClosureFindings,checkedRawScripts,rawScriptDiagnostics};
function saveEvidence(){fs.writeFileSync(path.join(__dirname,"e2e-preflight-short-static.json"),JSON.stringify(evidence,null,2)+"\n");process.stdout.write(JSON.stringify(evidence,null,2)+"\n");}
(async()=>{
  const {tsImport}=require("tsx/esm/api");const imported=await tsImport(pathToFileURL(source).href,{parentURL:pathToFileURL(__filename).href,tsconfig:path.join(repository,"packages/desktop/tsconfig.e2e.json")});
  const goodProbe={profiles:Array.from({length:4},(_,index)=>({path:path.join(runtime,"synthetic-profile-"+index),exists:false})),modules:[{path:path.join(runtime,"synthetic-module"),exists:false}]};
  const badProbes=[null,[],{...goodProbe,extra:0},{...goodProbe,profiles:goodProbe.profiles.slice(1)},{...goodProbe,profiles:[goodProbe.profiles[0],...goodProbe.profiles.slice(0,3)]},{...goodProbe,profiles:[{path:"relative-profile",exists:false},...goodProbe.profiles.slice(1)]},{...goodProbe,modules:[{path:path.join(runtime,"synthetic-module"),exists:"false"}]},{...goodProbe,modules:[]}];
  evidence.terminalProbeShape={accepted:[],rejected:[]};
  for(const [name,value] of [["structured-object",goodProbe],["JSON-string",JSON.stringify(goodProbe)]]){const parsedProbe=imported.parseShortTerminalProbe(value);evidence.terminalProbeShape.accepted.push({name,profileCount:parsedProbe.profiles.length,moduleCount:parsedProbe.modules.length});}
  for(let index=0;index<badProbes.length;index++){let rejected=false;try{imported.parseShortTerminalProbe(badProbes[index]);}catch{rejected=true;}evidence.terminalProbeShape.rejected.push({index,rejected});if(!rejected)process.exitCode=1;}
  const publicEntry=createRequire(path.join(repository,"packages/desktop/package.json")).resolve("@zcode/services/node");
  const service=await tsImport(pathToFileURL(publicEntry).href,{parentURL:pathToFileURL(__filename).href,tsconfig:path.join(repository,"packages/desktop/tsconfig.e2e.json")});
  const bytes=await service.encodeConversationArchive(imported.shortArchiveInput());const decoded=await service.decodeConversationArchive(bytes);
  evidence.publicEntry=publicEntry;evidence.fixture={byteLength:bytes.length,title:decoded.content.title,rowCount:decoded.content.rows.length,artifacts:decoded.artifacts.size,assistantTextLength:decoded.content.rows.find(row=>row.kind==="assistantText")?.text?.length};
  const oxlintEntry=path.join(path.dirname(require.resolve("oxlint/package.json")),"bin/oxlint");
  try {evidence.targetedLint={exitCode:0,output:execFileSync(process.execPath,[oxlintEntry,"--deny-warnings","--no-ignore",...sourceFiles],{cwd:repository,env:process.env,windowsHide:true,encoding:"utf8"}).trim()};}
  catch(error){evidence.targetedLint={exitCode:error.status??1,output:String(error.stdout??"")+String(error.stderr??"")};process.exitCode=1;}
  saveEvidence();if(diagnostics.length||callbackClosureFindings.length||rawScriptDiagnostics.length||cases.length!==15||decoded.content.rows.length!==3||decoded.artifacts.size!==0)process.exitCode=1;
})().catch(error=>{evidence.importError=error.stack;saveEvidence();process.exitCode=1;});
