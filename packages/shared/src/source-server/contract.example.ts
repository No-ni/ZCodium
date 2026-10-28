import type { SourceServerDirectorySnapshot } from "./contract.js";
export const emptyDirectory: SourceServerDirectorySnapshot = {
  schemaVersion: 1,
  generation: 0,
  profiles: [],
  servers: [],
};
