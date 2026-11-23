import type { ObservationEventState } from "./contract.js";
// App 的实际 JSX 调用见 ../App.tsx；示例只描述离线状态，不触发服务。
const offline: ObservationEventState = { connected: false, error: null, watchedPathCount: 0 };
void offline;
