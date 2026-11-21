import type { SessionEvent } from "./session-event-envelope.js";
import type { SessionProjection } from "../interfaces/session.port.js";
import type { SessionProjectionHandlers } from "./session-projection-handlers.js";
import { initialSessionProjection } from "./event-reducer-helpers.js";
import { createSessionLifecycleProjectionHandlers } from "./session-lifecycle-projection.js";
import { createSessionInputProjectionHandlers } from "./session-input-projection.js";
import { createSessionToolProjectionHandlers } from "./session-tool-projection.js";

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers: SessionProjectionHandlers = {
    ...createSessionLifecycleProjectionHandlers(),
    ...createSessionInputProjectionHandlers(),
    ...createSessionToolProjectionHandlers(),
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
