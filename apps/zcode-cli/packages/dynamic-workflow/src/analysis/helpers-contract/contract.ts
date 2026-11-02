/** 只消费原 TaintState/Evaluator 持有的值图、map/set 和当前发射参数；不保存第二份不动点状态，不增加 IO，公开方法与发射顺序沿原 owner。 */
export type Entry1 = typeof import("../state-helpers.js");
export type Entry2 = typeof import("../state-emission.js");
export type Entry3 = typeof import("../domain-types.js");
export type Entry4 = typeof import("../call-substitution.js");
