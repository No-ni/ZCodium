import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import { readSessionTarget } from "./contract.js";

/** 仅读取调用方已有连接，不创建或关闭数据库。 */
export function exampleCliSessionGoalSupport(db: DatabaseSync, sessionID: SessionId) {
  return readSessionTarget(db, { sessionID });
}
