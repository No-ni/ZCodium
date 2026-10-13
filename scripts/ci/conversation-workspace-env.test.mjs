import assert from "node:assert/strict";
import { relative } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

// 冻结 Host→Agent 的对话根标记契约：只有「路径等于对话根且没有 remote identity」的本地
// workspace 才允许注入；任何其他形态都必须保持旧行为（不注入 = 回滚开关）。判据两侧同口径
// （trim + resolve），且「不适用」必须显式返回该键的空串而不是 `{}`——spawn env 以
// sanitizeZCodeRuntimeEnv(process.env) 起底且本键不在清洗名单里，漏覆盖就等于把宿主 shell
// 里的同名变量下发给 Agent。
const { ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV, resolveConversationWorkspaceRoot } = await tsImport(
  "../../packages/shared/src/node/conversationWorkspaceEnv.ts",
  import.meta.url,
);
const { buildAgentConversationWorkspaceEnv } = await tsImport(
  "../../packages/services/src/runtime-tools/agentProxyEnv.ts",
  import.meta.url,
);

const ROOT = "/home/dev/.zcodium/workspace/default";
const ENABLED_ENV = { [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: ROOT };
/** 未启用：键必须存在且为空串（CLI 侧 resolveConversationWorkspaceRoot 判为未启用）。 */
const DISABLED_ENV = { [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: "" };

test("环境变量名固定为 ZCODE_CONVERSATION_WORKSPACE_ROOT", () => {
  assert.equal(ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV, "ZCODE_CONVERSATION_WORKSPACE_ROOT");
});

test("路径等于对话根且无 identity 时注入标记", () => {
  assert.deepEqual(buildAgentConversationWorkspaceEnv(ROOT, undefined, ROOT), ENABLED_ENV);
  assert.deepEqual(buildAgentConversationWorkspaceEnv(ROOT, "   ", ROOT), ENABLED_ENV);
});

test("同一路径的其它写法仍能命中：尾部分隔符 / .. 段 / 相对写法 / 首尾空白", () => {
  // 判据与 CLI 侧一致地用 resolve() 归一化；裸字符串比较会把这些写法判成「另一个 workspace」，
  // 结果是会话悄悄退回旧行为（cwd = workspacePath），而 CLI 侧再看不出原因。
  assert.deepEqual(buildAgentConversationWorkspaceEnv(`${ROOT}/`, undefined, ROOT), ENABLED_ENV);
  assert.deepEqual(
    buildAgentConversationWorkspaceEnv(`${ROOT}/../default`, undefined, ROOT),
    ENABLED_ENV,
  );
  assert.deepEqual(buildAgentConversationWorkspaceEnv(` ${ROOT}/ `, undefined, ROOT), ENABLED_ENV);
  // 相对写法：以当前工作目录为基准解析后仍等于对话根。
  assert.deepEqual(
    buildAgentConversationWorkspaceEnv(relative(process.cwd(), ROOT), undefined, ROOT),
    ENABLED_ENV,
  );
});

test("项目 workspace、远端 identity、对话根未知都不注入，并显式清空该键", () => {
  assert.deepEqual(
    buildAgentConversationWorkspaceEnv("/home/dev/project", undefined, ROOT),
    DISABLED_ENV,
  );
  assert.deepEqual(buildAgentConversationWorkspaceEnv(ROOT, "remote:ssh:host", ROOT), DISABLED_ENV);
  assert.deepEqual(buildAgentConversationWorkspaceEnv(ROOT, undefined, undefined), DISABLED_ENV);
  assert.deepEqual(buildAgentConversationWorkspaceEnv(ROOT, undefined, "  "), DISABLED_ENV);
});

test("带 identity 的会话不注入（空串），空路径不因 resolve 落到 cwd 而误命中", () => {
  const disabled = buildAgentConversationWorkspaceEnv(ROOT, "remote:ssh:host", ROOT);
  assert.deepEqual(disabled, DISABLED_ENV);
  // 键必须存在（覆盖宿主继承值），而不是「没有键」。
  assert.deepEqual(Object.keys(disabled), [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]);
  assert.deepEqual(buildAgentConversationWorkspaceEnv("", undefined, ROOT), DISABLED_ENV);
});

test("CLI 侧读标记：空串与缺席等价，首尾空白被裁剪", () => {
  assert.equal(
    resolveConversationWorkspaceRoot({ [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: ROOT }),
    ROOT,
  );
  assert.equal(
    resolveConversationWorkspaceRoot({ [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: ` ${ROOT} ` }),
    ROOT,
  );
  assert.equal(
    resolveConversationWorkspaceRoot({ [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: "  " }),
    undefined,
  );
  assert.equal(resolveConversationWorkspaceRoot({}), undefined);
  assert.equal(resolveConversationWorkspaceRoot(undefined), undefined);
});
