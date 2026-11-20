// 静态翻译与行为逻辑分开，保留普通上游文案并剥离官方套餐文案。
import messages from "./ja-JP.messages.json" with { type: "json" };
const jaJP: Record<string, string> = messages;
export default jaJP;
