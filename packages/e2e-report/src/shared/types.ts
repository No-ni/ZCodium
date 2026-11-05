// 协议类型由公共contract唯一持有；旧shared路径仅转发，避免Node/UI间形成反向依赖。
export type * from "../contract.js";
