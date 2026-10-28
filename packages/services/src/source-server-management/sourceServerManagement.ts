import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type ConnectionProfile,
  type SourceServerIdentityConfirmation,
  type SourceServerManagementSnapshot,
  type SourceServerProfileOperation,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISourceServerManagementService {
  getCapabilities(): Promise<{ version: 1 }>;
  onDidChange: Event<void>;
  getSnapshot(): Promise<SourceServerManagementSnapshot>;
  saveProfile(profile: ConnectionProfile): Promise<SourceServerManagementSnapshot>;
  removeProfile(input: SourceServerProfileOperation): Promise<SourceServerManagementSnapshot>;
  connectProfile(input: SourceServerProfileOperation): Promise<SourceServerManagementSnapshot>;
  confirmIdentityChange(
    input: SourceServerIdentityConfirmation,
  ): Promise<SourceServerManagementSnapshot>;
  disconnectSource(input: { sourceServerId: string }): Promise<SourceServerManagementSnapshot>;
}

export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
