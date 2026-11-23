import { createProjectId } from "../deps.js";
import { createHash } from "node:crypto";
import type { ProjectId } from "../deps.js";

export function titleFromInput(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled session";
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

export function projectIdFromDirectory(directory: string, emptySlug = "session"): ProjectId {
  const normalizedDirectory = directory.toLowerCase();
  const slug = normalizedDirectory.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // 长目录截断会串用权限；Core 落盘与 Bootstrap 准入必须通过同一算法派生 ID。
  const key = slug.length > 80
    ? `${slug.slice(0, 15)}-${createHash("sha256").update(normalizedDirectory).digest("hex")}`
    : slug || emptySlug;
  return createProjectId(key);
}
