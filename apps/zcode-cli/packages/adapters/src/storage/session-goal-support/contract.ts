/** 既有 SQLite 目标辅助；连接由原 Store 注入，不建连接或持有业务状态。 */
export {
  readSessionTarget,
  mustReadTarget,
  touchSessionForTarget,
  createStorageTargetId,
  elapsedSecondsBetween,
} from "./support.js";
