import { TITLE } from "#office/wording.ts";
import { readText } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";
import { parseAssetManifest, verifyScriptParts } from "#ui/resourceManifest.ts";

// Small loader inlined in panel.html: connect once, then pull the UI bundle through MCP resources
// (one large HTML resource would exceed host limits) and run it in the same page and App.
(async () => {
  getHost();
  const manifest = parseAssetManifest(JSON.parse(await readText("assets.json")));
  const [css, ...parts] = await Promise.all([
    readText("panel.css"),
    ...manifest.scripts.map(readText),
  ]);
  verifyScriptParts(parts, manifest.scriptBytes);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const script = document.createElement("script");
  script.textContent = parts.join("");
  document.body.append(script);
})().catch(() => {
  const root = document.getElementById("root");
  // 资源/宿主异常可能含路径，页面仅展示固定加载失败提示。
  if (root) root.textContent = `${TITLE} failed to load. Reload the panel.`;
});
