import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createSessionId,
  type MessageWithParts,
} from "@zcode/contracts";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";

export function createNativeContextLedgerMessage(
  options: { namespace: string; model: NativeContextObservation["model"]; workspacePath: string },
  seq: number,
  role: "user" | "assistant",
  createdAt: number,
): MessageWithParts {
  const id = createMessageId(`${options.namespace}-${role}-${seq}`);
  const sessionID = createSessionId(options.namespace);
  const common = { id, sessionID, agent: "fixture", historyRoundCount: seq };
  return {
    info:
      role === "user"
        ? { ...common, role, time: { created: createdAt } }
        : {
            ...common,
            role,
            parentID: createMessageId(`${options.namespace}-user-${seq}`),
            modelId: createModelId(options.model.modelId),
            providerId: createModelProviderId(options.model.providerId),
            time: { created: createdAt, completed: createdAt + 1 },
            mode: "build",
            path: { cwd: options.workspacePath, root: options.workspacePath },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "completed",
          },
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID,
        messageID: id,
        type: "text",
        text: `NCTX-58 合成${role === "user" ? "请求" : "回复"} ${seq}。仅验证分页与趋势；来源是隔离夹具，不包含真实用户内容。`,
      },
    ],
  };
}
