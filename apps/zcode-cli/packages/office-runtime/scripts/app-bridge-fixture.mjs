import assert from "node:assert/strict";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";

/** Actual App/AppBridge protocol with the actual built MCP client. No browser or simulated screenshot. */
export async function verifyAppBridge(client, name, sample, anchor) {
  const bridge = new AppBridge(
    null,
    { name: "office-fixture", version: "1" },
    {
      serverTools: {},
      serverResources: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    },
    { hostContext: { theme: "dark", locale: "zh-CN", displayMode: "fullscreen" } },
  );
  const app = new App(
    { name, version: "1" },
    { tools: {}, availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  let context, message;
  const results = [];
  let initialized = 0;
  bridge.oncalltool = (args) => client.callTool(args);
  bridge.onreadresource = (args) => client.readResource(args);
  bridge.onupdatemodelcontext = async (value) => {
    context = value;
    return {};
  };
  bridge.onmessage = async (value) => {
    message = value;
    return {};
  };
  bridge.oninitialized = () => {
    initialized++;
  };
  app.ontoolresult = (result) => {
    results.push(result);
  };
  const pair = InMemoryTransport.createLinkedPair();
  try {
    await bridge.connect(pair[0]);
    await app.connect(pair[1]);
    assert.equal(initialized, 1);
    assert.equal(app.getHostContext().locale, "zh-CN");
    const opened = await client.callTool({ name: "open_document", arguments: { path: sample } });
    assert.ok(!opened.isError);
    await bridge.sendToolInput({ arguments: { path: sample } });
    await bridge.sendToolResult(opened);
    await Promise.resolve();
    assert.equal(results.length, 1, "initial result is delivered before the fixture consumes it");
    assert.equal(results[0].structuredContent.document.path, sample);
    const loaded = await app.callServerTool({ name: "load_document", arguments: { path: sample } });
    assert.ok(!loaded.isError);
    const resource = await app.readServerResource({
      uri: `ui://${name}/file/${loaded.structuredContent.file.token}/0`,
    });
    assert.ok(resource.contents[0].blob.length > 0);
    await app.updateModelContext({
      content: [{ type: "text", text: `- ${anchor}: "synthetic fixture reference"` }],
    });
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Question about ${anchor}` }],
    });
    assert.ok(context.content[0].text.includes(anchor));
    assert.ok(message.content[0].text.includes(anchor));
    assert.ok((await app.callServerTool({ name: "begin_file_import", arguments: {} })).isError);
  } finally {
    await Promise.all([app.close(), bridge.close()]);
  }
}
