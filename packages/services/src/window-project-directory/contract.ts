import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type WindowProjectDirectorySnapshot,
  type WindowProjectDirectoryEntry,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IWindowProjectService {
  readDirectory(): Promise<WindowProjectDirectorySnapshot>;
}
export interface IWindowRemoteProjectService {
  readDirectory(): Promise<{
    version: 1;
    generation: number;
    entries: WindowProjectDirectoryEntry[];
  }>;
}
export interface IWindowProjectChangesService {
  getCapabilities(): Promise<{ version: 1 }>;
  onDidChange: Event<void>;
}
export interface WindowProjectDirectoryServices {
  projectService: IWindowProjectService;
  remoteProjectService: IWindowRemoteProjectService;
  changesService: IWindowProjectChangesService;
}
export const IWindowProjectService = createServiceDescriptor<IWindowProjectService>(
  ServiceChannels.WindowProject,
);
export const IWindowRemoteProjectService = createServiceDescriptor<IWindowRemoteProjectService>(
  ServiceChannels.WindowRemoteProjects,
);
export const IWindowProjectChangesService = createServiceDescriptor<IWindowProjectChangesService>(
  ServiceChannels.WindowProjectChanges,
);
