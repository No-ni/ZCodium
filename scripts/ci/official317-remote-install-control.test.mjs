// 官方 3.17.1 合并的远端连接表单收口门：自动安装/下载方式控件已退休，其余连接字段必须保留。
// 规则出处 docs/specs/official-3.17.1-integration.md：不接受安装确认，不自动部署、下载、升级或重装。
// 纯静态断言，不装依赖、不起浏览器、不写文件。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../../packages/ui/src/RemoteConnectionFields.tsx", import.meta.url);

async function loadForm() {
  const source = await readFile(sourceUrl, "utf8");
  const file = ts.createSourceFile(
    "RemoteConnectionFields.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const fields = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "RemoteConnectionFields",
  );
  assert.ok(fields?.body, "RemoteConnectionFields 组件缺失");
  const segmented = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "RemoteSegmentedControl",
  );
  assert.ok(segmented?.body, "RemoteSegmentedControl 分段控件缺失");
  return { file, fields: fields.body, segmented: segmented.body };
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function collect(root) {
  const identifiers = new Set();
  const literals = new Set();
  const testIds = new Set();
  walk(root, (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isStringLiteral(node)) literals.add(node.text);
    if (ts.isJsxAttribute(node) && node.name.getText() === "data-testid") {
      // data-testid={TID_*} 的初值外面还包一层 JsxExpression，先剥掉再取标识符。
      const initializer = node.initializer;
      const value =
        initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
      if (value && ts.isIdentifier(value)) testIds.add(value.text);
    }
  });
  return { identifiers, literals, testIds };
}

test("远端连接表单不再渲染自动安装模式控件", async () => {
  const { file, fields } = await loadForm();
  // 控件、状态 prop 与下载方式取值都不允许残留：官方自动远端部署 UI 已退休。
  for (const root of [file, fields]) {
    const { identifiers, literals } = collect(root);
    for (const name of [...identifiers, ...literals]) {
      assert.doesNotMatch(name, /assetInstallMode/i, `自动安装模式标识仍在使用：${name}`);
    }
    for (const literal of literals) {
      assert.ok(
        !/remote-download|local-download-upload/.test(literal),
        `远端下载方式取值仍在使用：${literal}`,
      );
    }
  }
});

test("分段控件不再保留只为安装模式服务的 wrap 分支", async () => {
  const { segmented } = await loadForm();
  assert.equal(collect(segmented).identifiers.has("wrap"), false);
});

test("SSH/WSL/Docker/Server 连接字段与手动预部署说明仍然保留", async () => {
  const { fields } = await loadForm();
  const { identifiers, literals, testIds } = collect(fields);
  // 输入类字段必须仍以 data-testid 落在表单上，避免退化成只声明不渲染的死常量。
  for (const testId of [
    "TID_SSH_HOST_INPUT",
    "TID_SSH_PORT_INPUT",
    "TID_SSH_USERNAME_INPUT",
    "TID_SSH_PASSWORD_INPUT",
    "TID_SSH_PRIVATE_KEY_INPUT",
    "TID_SSH_CONFIG_ALIAS_SELECT",
    "TID_WSL_DISTRO_SELECT",
    "TID_WSL_USER_INPUT",
    "TID_DOCKER_CONTAINER_SELECT",
    "TID_DOCKER_CONTAINER_INPUT",
    "TID_SERVER_URL_INPUT",
    "TID_SERVER_NAME_INPUT",
    "TID_SERVER_TOKEN_INPUT",
    "TID_SERVER_WORKSPACE_PATH_INPUT",
  ]) {
    assert.ok(testIds.has(testId), `连接字段 ${testId} 不再渲染`);
  }
  // 认证方式与 Docker 输入方式的分段选项不是 data-testid 属性，只要求仍被表单引用。
  for (const testId of ["TID_SSH_AUTH_PASSWORD", "TID_SSH_AUTH_PRIVATE_KEY"]) {
    assert.ok(identifiers.has(testId), `连接字段 ${testId} 不再渲染`);
  }
  for (const messageId of [
    "server.description",
    "ssh.advancedOptions",
    "ssh.configAlias",
    "ssh.privateKeyPassphrase",
    "wsl.userDescription",
    "docker.manualContainerHint",
  ]) {
    assert.ok(literals.has(messageId), `连接说明 ${messageId} 不再渲染`);
  }
});
