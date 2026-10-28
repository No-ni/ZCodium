import { createServer } from "node:http";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPluginName } from "./plugin-name.mjs";

/** Isolated, loopback-only fixture for the official browser-use capability; never starts a browser. */
export async function startOfficeFixture(plugin, dist, workspace, port = 0) {
  const name = await readPluginName(plugin);
  const pkg = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
  const client = new Client({ name: "office-gui-fixture", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(dist, "server.mjs")],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", ZCODE_WORKSPACE_ROOT: workspace },
      stderr: "pipe",
    }),
  );
  const panel = await client.readResource({ uri: `ui://${name}/panel.html` });
  const meta = panel.contents[0]._meta;
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' blob:${meta?.["zcode/csp"]?.wasmUnsafeEval ? " 'wasm-unsafe-eval'" : ""}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "worker-src blob:",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const host = await build({
    stdin: {
      resolveDir: root,
      contents: `
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const status = document.querySelector('#status');
const rpc = async (method,args) => { const r = await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})}); const value = await r.json(); if(!r.ok)throw Error(value.error);return value; };
const params = new URLSearchParams(location.search);
const bridge = new AppBridge(null,{name:'office-gui-fixture',version:'1'}, {serverTools:{},serverResources:{},message:{text:{}},updateModelContext:{text:{},structuredContent:{}},experimental:{'zcode/surface':{id:${JSON.stringify(name)}}}}, {hostContext:{theme:params.get('theme')||'light',locale:params.get('locale')||'en-US',displayMode:'fullscreen'}});
bridge.oncalltool = (args)=>rpc('callTool',args); bridge.onreadresource = (args)=>rpc('readResource',args);
bridge.onmessage = async (value)=>{document.querySelector('#message').textContent=value.content.map(v=>v.text||'').join('\\n');return {};};
bridge.onupdatemodelcontext=async(value)=>{document.querySelector('#context').textContent=value.content.map(v=>v.text||'').join('\\n');return {};};
bridge.onsizechange=()=>{};
const frame = document.querySelector('iframe');
bridge.oninitialized=async()=>{status.textContent='Panel connected'; const tools=await bridge.listTools({});document.querySelector('#tools').textContent=tools.tools.map(t=>t.name).join(', ');};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow)); frame.src='/panel';
document.querySelector('#open').onclick=async()=>{try{const path=document.querySelector('#path').value; const r=await rpc('callTool',{name:'open_document',arguments:{path}});if(r.isError)throw Error(r.content[0].text);await bridge.sendToolInput({arguments:{path}});await bridge.sendToolResult(r);status.textContent='Document opened';}catch{status.textContent='Open failed';}};
document.querySelector('#reveal').onclick=async()=>{try{const anchor=document.querySelector('#anchor').value;const r=await rpc('callTool',{name:'show_in_viewer',arguments:{targets:[{anchor}],note:'Fixture location'}});if(r.isError)throw Error('invalid');await bridge.sendToolInput({arguments:{targets:[{anchor}]}});await bridge.sendToolResult(r);status.textContent='Location shown';}catch{status.textContent='Reveal failed';}};
document.querySelector('#capture').onclick=async()=>{try{const anchor=document.querySelector('#anchor').value;const r=await bridge.callTool({name:'capture_view',arguments:anchor?{anchor}:{}});const image=r.content.find(c=>c.type==='image');if(r.isError||!image){status.textContent=r.content.find(c=>c.type==='text')?.text||'Capture failed';return;}document.querySelector('#shot').src='data:'+image.mimeType+';base64,'+image.data;status.textContent=r.content.find(c=>c.type==='text')?.text||'Captured';}catch{status.textContent='Capture failed';}};
`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const samples = {
    docx: ["report.docx", "p:4"],
    xlsx: ["budget.xlsx", "Revenue!B2:D4"],
    pptx: ["launch.pptx", "slide:2/shape:3"],
    pdf: ["paper.pdf", "page:1"],
  };
  const [file, at] = samples[pkg.office.kinds[0]];
  const escape = (value) =>
    value.replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          `<style>body{margin:0;font:14px system-ui}header{padding:8px;display:flex;flex-wrap:wrap;gap:8px}iframe{width:100%;height:75vh;border:0}pre{white-space:pre-wrap}#shot{max-width:100%}</style><header><input id="path" aria-label="Document path" value="docs/${file}"><button id="open">Open document</button><input id="anchor" aria-label="Anchor" value="docs/${escape(file)}#${escape(at)}"><button id="reveal">Show location</button><button id="capture">Capture view</button><span id="status" role="status">Connecting</span><span id="tools"></span></header><iframe title="Office viewer" sandbox="allow-scripts allow-same-origin"></iframe><details><summary>Reference and question received by fixture host</summary><pre id="context"></pre><pre id="message"></pre></details><img id="shot" alt="Captured view"><script type="module" src="/host.js"></script>`,
        );
      } else if (url.pathname === "/host.js")
        response
          .writeHead(200, { "Content-Type": "text/javascript" })
          .end(host.outputFiles[0].text);
      else if (url.pathname === "/panel")
        response
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": csp,
          })
          .end(panel.contents[0].text);
      else if (url.pathname === "/rpc" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 64 * 1024) throw new Error("request too large");
        }
        const { method, args } = JSON.parse(body);
        if (!["callTool", "readResource"].includes(method)) throw new Error("invalid method");
        const result =
          method === "callTool" ? await client.callTool(args) : await client.readResource(args);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } else response.writeHead(url.pathname === "/favicon.ico" ? 204 : 404).end();
    } catch {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Office fixture request failed." }));
    }
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await client.close();
    },
  };
}
