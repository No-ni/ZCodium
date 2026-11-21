import type { SessionEvent } from "./session-event-envelope.js";
import type { SessionProjection } from "../interfaces/session.port.js";

/** 事件只派生只读投影；运行时与持久化仍通过原 owner 写入。 */
export type SessionProjectionHandlers = Record<
  string,
  (projection: SessionProjection, event: SessionEvent) => SessionProjection
>;
