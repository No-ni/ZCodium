// 静态翻译与行为逻辑分开，保留普通上游文案并剥离官方套餐文案。
import messages from "./ko-KR.messages.json" with { type: "json" };
const koKR: Record<string, string> = messages;
export default koKR;
