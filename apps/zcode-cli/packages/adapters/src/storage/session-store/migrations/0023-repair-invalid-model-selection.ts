// 存量 runtime/model_selection 行的 data 若不是合法 JSON，saveSessionEntry 的
// json_type() 守卫会在 upsert 时抛 malformed JSON——该行从此永远写不进去，
// 模型切换只剩内存生效、重启回退（102/102 全败的线上签名）。
// 这里把坏行重写成显式空选择（json null），读取侧 parseModelSelectionValue
// 返回 undefined = 未绑定，由用户重新选择即可恢复；合法行原样保留。
// json_valid 是纯谓词不会抛错，坏行必须先于任何 json_type/json_extract 求值。
export const REPAIR_INVALID_MODEL_SELECTION_MIGRATION_SQL = `
UPDATE session_entry
SET data = json_object('modelSelection', NULL)
WHERE type = 'runtime/model_selection' AND NOT json_valid(data);
`;
