import { type StdioTrafficDirection } from "@/data/protocolDocs.js";

export type DocsView = "capabilities" | "boundary" | "protocol" | "stdio";

export type DirectionFilter = StdioTrafficDirection | "all";

export type TrafficSourceMode = "real" | "mock";

export type RealTrafficStatus = "loading" | "ready" | "empty" | "missing" | "error";

export interface StdioTrafficApiRecordEnvelope {
  index: number;
  record: StdioTrafficTapRecord;
}

export interface StdioTrafficApiResponse {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}

export interface StdioTrafficTapRecord {
  ts?: string;
  workspaceKey?: string;
  proxyPid?: number;
  pid?: number | null;
  direction?: StdioTrafficDirection;
  bytes?: number;
  raw?: string;
  message?: unknown;
  parseError?: string | null;
  id?: unknown;
  method?: unknown;
  sessionId?: unknown;
  inputId?: unknown;
}

export interface RealTrafficState {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}
