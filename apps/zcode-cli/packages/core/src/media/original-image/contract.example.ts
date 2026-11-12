import type { OriginalImagePersistence } from "./contract.js";

export function describeOriginalImageBoundary(boundary: OriginalImagePersistence): string {
  return boundary.fromMetadata(undefined) ? "original" : "unavailable";
}
