// 静态翻译与行为逻辑分开，保留普通上游文案并剥离官方套餐文案。
import messages from "./ru-RU.messages.json" with { type: "json" };
const ruRU: Record<string, string> = messages;
export default ruRU;
