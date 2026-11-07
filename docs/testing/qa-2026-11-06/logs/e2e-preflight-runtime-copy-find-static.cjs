"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {pathToFileURL}=require("node:url");
const {execFileSync}=require("node:child_process");
const {createHash}=require("node:crypto");
const {createRequire}=require("node:module");
const vm=require("node:vm");
const repository=path.resolve(__dirname,"../../../..");
const runtime=path.join(repository,"docs/testing/qa-2026-11-06/runtime/qa-runtime-copy-find-static");
const source=path.join(repository,"docs/testing/qa-2026-11-06/manual-review/pending/qa-runtime-copy-find-20261106.test.ts");
const helper=path.join(repository,"docs/testing/qa-2026-11-06/qa-menu-dom.ts");
const fixture=path.join(repository,"packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-chat-find-refocus.json");
const common=path.join(repository,"packages/desktop/test/e2e/fixtures/upstream/common.json");
const guard=path.join(repository,"docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
for(const target of [runtime,__dirname,source,helper,fixture,common,guard]) {
  if(!target.startsWith(repository+path.sep))throw new Error("RFC static path escapes tree");
  for(let cursor=target;;cursor=path.dirname(cursor)){if(fs.existsSync(cursor)&&(fs.lstatSync(cursor).isSymbolicLink()||fs.realpathSync.native(cursor).toLowerCase()!==cursor.toLowerCase()))throw new Error("RFC static redirects rejected");if(cursor===path.dirname(cursor))break;}
}
const audit=fs.readFileSync(guard,"utf8")+"\n$ErrorActionPreference='Stop';$target=$env:RFC_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RFC static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe",["-NoProfile","-NonInteractive","-Command",audit],{env:{...process.env,RFC_STATIC_TARGET:runtime,QA_REPARSE_WORKTREE:repository},windowsHide:true,stdio:"pipe",timeout:30000});
for(const key of ["HOME","USERPROFILE","TEMP","TMP","TMPDIR","APPDATA","LOCALAPPDATA","COREPACK_HOME","PNPM_HOME","npm_config_cache","npm_config_store_dir","npm_config_userconfig","TSX_CACHE_DIR","NODE_COMPILE_CACHE","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZCODE_E2E_HOME_DIR","ZCODE_E2E_ARTIFACT_DIR"]){process.env[key]=path.join(runtime,key.toLowerCase());if(key==="npm_config_userconfig"){fs.mkdirSync(path.dirname(process.env[key]),{recursive:true});fs.writeFileSync(process.env[key],"");}else fs.mkdirSync(process.env[key],{recursive:true});}
process.env.E2E_PROVIDER_HTTP_MODE="replay";process.env.ZCODE_E2E_MANUAL_REVIEW="1";process.env.NODE_OPTIONS="";
const ts=require("typescript");
const configPath=path.join(repository,"docs/testing/qa-2026-11-06/tsconfig.qa.json");
const config=ts.readConfigFile(configPath,ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
const options={...parsed.options,rootDir:repository,composite:false,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,options)).map(item=>({file:item.file?.fileName??null,code:item.code,line:item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start).line+1:null,message:ts.flattenDiagnosticMessageText(item.messageText,"\n")}));
const esbuild=createRequire(require.resolve("tsx/esm/api"))("esbuild");
let ast;let checkedCallbacks=0;let checkedRawScripts=0;const closureFindings=[];const rawSyntaxErrors=[];
function visit(node){
  if(ts.isCallExpression(node)&&/^(browser\.execute|browser\.electron\.execute)$/u.test(node.expression.getText(ast))&&node.arguments[0]&&(ts.isArrowFunction(node.arguments[0])||ts.isFunctionExpression(node.arguments[0]))){checkedCallbacks++;const callback=node.arguments[0];const compiled=esbuild.transformSync("module.exports=("+callback.getText(ast)+");",{loader:"ts",target:"es2022",keepNames:true}).code;const context={module:{exports:null}};vm.runInNewContext(compiled,context);if(/__name\d*\(/u.test(context.module.exports.toString()))closureFindings.push({source:ast.fileName,line:ast.getLineAndCharacterOfPosition(callback.getStart(ast)).line+1});}
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==="browser.execute"&&node.arguments[0]&&(ts.isNoSubstitutionTemplateLiteral(node.arguments[0])||ts.isStringLiteral(node.arguments[0]))){checkedRawScripts++;try{new vm.Script("(function(){"+node.arguments[0].text+"})");}catch(error){rawSyntaxErrors.push({source:ast.fileName,error:error.message});}}
  ts.forEachChild(node,visit);
}
for(const file of [source,helper]){ast=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);visit(ast);}
const cases=[];globalThis.describe=(_title,callback)=>callback();globalThis.it=(title,_callback)=>cases.push(title);globalThis.before=globalThis.after=globalThis.beforeEach=globalThis.afterEach=()=>undefined;
const caseFixture=JSON.parse(fs.readFileSync(fixture,"utf8")).fixtures.find(row=>row.id==="chat-find-refocus-long-body");
const expected=caseFixture.response.text.text;
const evidence={capturedAt:new Date().toISOString(),evidenceKind:"all external QA noEmit; actual module import/3 registrations; finite existing fixture source audit; lint/serialized callback syntax only; no UI/Host/provider execution",sources:[source,helper,fixture,common].map(file=>({file,sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")})),diagnostics,registeredCases:cases,checkedCallbacks,closureFindings,checkedRawScripts,rawSyntaxErrors,fixture:{id:caseFixture.id,metadata:caseFixture.metadata,expectedBodyLength:expected.length,expectedBodySha256:createHash("sha256").update(expected).digest("hex"),markerCount:expected.split("E2E_CHAT_FIND_REFOCUS_NEEDLE").length-1,pureText:Boolean(caseFixture.response.text&&!caseFixture.response.toolUse&&!caseFixture.response.toolUses&&!caseFixture.response.body&&!caseFixture.response.chunks)}};
function save(){fs.writeFileSync(path.join(__dirname,"e2e-preflight-runtime-copy-find-static.json"),JSON.stringify(evidence,null,2)+"\n");process.stdout.write(JSON.stringify(evidence,null,2)+"\n");}
(async()=>{
  const {tsImport}=require("tsx/esm/api");await tsImport(pathToFileURL(source).href,{parentURL:pathToFileURL(__filename).href,tsconfig:path.join(repository,"packages/desktop/tsconfig.e2e.json")});
  const oxlint=path.join(path.dirname(require.resolve("oxlint/package.json")),"bin/oxlint");
  try{evidence.targetedLint={exitCode:0,output:execFileSync(process.execPath,[oxlint,"--deny-warnings","--no-ignore",source,helper],{cwd:repository,env:process.env,windowsHide:true,encoding:"utf8"}).trim()};}
  catch(error){evidence.targetedLint={exitCode:error.status??1,output:String(error.stdout??"")+String(error.stderr??"")};process.exitCode=1;}
  try{evidence.canonicalFixtureCheck={exitCode:0,output:execFileSync(process.execPath,[path.join(repository,"packages/desktop/scripts/check-e2e-fixtures.mjs"),"--spec",path.join(repository,"packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-chat-find-refocus.test.ts")],{cwd:repository,env:process.env,windowsHide:true,encoding:"utf8"}).trim()};}
  catch(error){evidence.canonicalFixtureCheck={exitCode:error.status??1,output:String(error.stdout??"")+String(error.stderr??"")};process.exitCode=1;}
  save();if(diagnostics.length||closureFindings.length||rawSyntaxErrors.length||cases.length!==3||evidence.fixture.markerCount!==1||!evidence.fixture.pureText)process.exitCode=1;
})().catch(error=>{evidence.importError=error.stack;save();process.exitCode=1;});
