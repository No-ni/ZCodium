import {
  createUnsupportedConversationShareService,
  type IConversationShareService,
} from "#src/conversation-share/conversationShare.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import {
  readTrustedZCodeAgentV4Connection,
  withTrustedZCodeAgentV4Connection,
  type ZCodeAgentV4ConnectionContext,
} from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { conversationShareConnectionScopeFactory } from "#src/conversation-share/conversationShareService.js";
import type { ShareWorkflowReader } from "#src/conversation-share/conversationShareWorkflowSnapshot.js";

type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;
type ScopableService = IConversationShareService & {
  [conversationShareConnectionScopeFactory](
    agent: ConversationShareAgentService,
  ): IConversationShareService;
};
function isScopable(service: IConversationShareService): service is ScopableService {
  return (
    conversationShareConnectionScopeFactory in service &&
    typeof service[conversationShareConnectionScopeFactory] === "function"
  );
}

function scopedReader(
  agent: ConversationShareAgentService,
  connection: ZCodeAgentV4ConnectionContext,
): ConversationShareAgentService {
  return {
    conversationRowsRangeV4: (input) =>
      agent.conversationRowsRangeV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationFileChangesV4: (input) =>
      agent.conversationFileChangesV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationAttachmentReadV4: (input) =>
      agent.conversationAttachmentReadV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationAttachmentStatV4: (input) =>
      agent.conversationAttachmentStatV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationWorkflowRunsV4: (input) =>
      agent.conversationWorkflowRunsV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationWorkflowRunEventsV4: (input) =>
      agent.conversationWorkflowRunEventsV4(withTrustedZCodeAgentV4Connection(input, connection)),
    conversationWorkflowRunArtifactsV4: (input) =>
      agent.conversationWorkflowRunArtifactsV4(
        withTrustedZCodeAgentV4Connection(input, connection),
      ),
    conversationWorkflowRunArtifactDataV4: (input) =>
      agent.conversationWorkflowRunArtifactDataV4(
        withTrustedZCodeAgentV4Connection(input, connection),
      ),
    conversationWorkflowRunArtifactReadV4: (input) =>
      agent.conversationWorkflowRunArtifactReadV4(
        withTrustedZCodeAgentV4Connection(input, connection),
      ),
  };
}

// archive token 和导入缓冲仍由原服务唯一持有；façade 只选择受信正文读取路径。
function archiveFacade(
  service: IConversationShareService,
  forInput: (input: unknown) => IConversationShareService,
  connection?: ZCodeAgentV4ConnectionContext,
): IConversationShareService {
  return {
    getCapabilities: () => service.getCapabilities(),
    canImport: () => service.canImport(),
    preflight: (input) =>
      forInput(input).preflight(
        connection ? withTrustedZCodeAgentV4Connection(input, connection) : input,
      ),
    publish: (input, id) =>
      forInput(input).publish(
        connection ? withTrustedZCodeAgentV4Connection(input, connection) : input,
        id,
      ),
    readExportChunk: (id, offset) => service.readExportChunk(id, offset),
    releaseExport: (id) => service.releaseExport(id),
    onDynamicPublishProgress: (id) => service.onDynamicPublishProgress(id),
    beginArchiveImport: (bytes) => service.beginArchiveImport(bytes),
    appendArchiveImport: (id, offset, bytes) => service.appendArchiveImport(id, offset, bytes),
    releaseArchiveImport: (id) => service.releaseArchiveImport(id),
    importShare: (input, id) =>
      service.importShare(
        connection ? withTrustedZCodeAgentV4Connection(input, connection) : input,
        id,
      ),
    onDynamicImportProgress: (id) => service.onDynamicImportProgress(id),
    getImportedConversation: (input) => service.getImportedConversation(input),
  };
}

export function scopeConversationShareServiceForAttachment(
  service: IConversationShareService,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  agentService?: ConversationShareAgentService,
  connection?: ZCodeAgentV4ConnectionContext,
): IConversationShareService {
  if (clientMode !== "desktop-continuous") {
    return createUnsupportedConversationShareService({
      message: "Conversation archives are only available from Desktop",
    });
  }
  if (connection?.role === "trusted-host-relay") {
    return archiveFacade(service, (input) => {
      const downstream = readTrustedZCodeAgentV4Connection(input);
      if (
        !downstream ||
        downstream.clientMode !== "desktop-continuous" ||
        !agentService ||
        !isScopable(service)
      ) {
        throw Object.assign(new Error("Conversation archive connection is not trusted"), {
          kind: "connection_unavailable" as const,
        });
      }
      // 修复依据：新工作流读取与旧正文读取必须共享同一受信 downstream，不能落回 base service。
      return service[conversationShareConnectionScopeFactory](
        scopedReader(agentService, downstream),
      );
    });
  }
  if (!isScopable(service))
    return connection ? archiveFacade(service, () => service, connection) : service;
  if (agentService)
    return service[conversationShareConnectionScopeFactory](
      connection ? scopedReader(agentService, connection) : agentService,
    );
  const facade = archiveFacade(service, () => service, connection);
  facade.publish = async () => {
    throw Object.assign(new Error("Conversation archive connection is not ready"), {
      kind: "connection_unavailable" as const,
    });
  };
  return facade;
}
