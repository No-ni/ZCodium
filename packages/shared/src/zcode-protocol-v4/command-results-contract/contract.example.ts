import type { CommandAck } from "./contract.js";
export const example: CommandAck = {
  commandId: "fixture",
  status: "accepted",
  revisionAtDecision: 1,
};
