/**
 * output-style 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { OutputStyleContract } from "./contract.js";

/** 只读枚举内建和自定义样式；激活状态随服务读取的设置快照返回。 */
export async function exampleOutputStyle(contract: OutputStyleContract) {
  const { styles } = await contract.listStyles();
  return styles;
}
