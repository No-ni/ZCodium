import type { WindowExtensionState } from "./windowHostExtensionsTypes.js";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
} from "@zcode/rpc";
import {
  EXTENSION_HOST_CHANNEL,
  EXTENSION_WINDOW_CHANNEL,
  applyContributionMessage,
  contributionMessageSchema,
  type IExtensionHostChannel,
} from "@zcode/shared/extension-host";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createCapabilityGateway,
  createCapabilityHandlers,
  type CapabilityGrantFacts,
} from "#src/extensions/capabilityGateway.js";
import { createExtensionViewRelay } from "#src/extensions/viewRelay.js";
import type { ExtensionsContributionsMessage } from "#src/extensions/contract.js";
interface Context {
  state: WindowExtensionState;
  detach(reason: string): void;
  handlers: ReturnType<typeof createCapabilityHandlers>;
  grantFacts: CapabilityGrantFacts;
  logger: ReturnType<typeof createServiceLogger>;
  contributions: Emitter<ExtensionsContributionsMessage>;
  views: ReturnType<typeof createExtensionViewRelay>;
  enqueueStatic(label: string, task: () => Promise<void>): Promise<void>;
  pushDeclarations(): Promise<void>;
}
export function attachWindowExtensionHost(
  gen: number,
  port: MessagePortLike,
  onClose: (listener: () => void) => void,
  {
    state,
    detach,
    handlers,
    grantFacts,
    logger,
    contributions,
    views,
    enqueueStatic,
    pushDeclarations,
  }: Context,
) {
  detach(`replaced by gen=${gen}`);
  const protocol = new MessagePortProtocol(port);
  const server = new ChannelServer(protocol, "extension-window");
  server.registerChannel(
    EXTENSION_WINDOW_CHANNEL,
    ProxyChannel.fromService(createCapabilityGateway(handlers, grantFacts, logger, gen)),
  );
  const client = new ChannelClient(protocol);
  const host = ProxyChannel.toService<IExtensionHostChannel>(
    client.getChannel(EXTENSION_HOST_CHANNEL),
  );
  const subscription = host.onDynamicContributions(undefined)((raw) => {
    if (state.connection?.gen !== gen) return;
    const parsed = contributionMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(undefined, `dropped an invalid contribution message gen=${gen}`);
      return;
    }
    const next = applyContributionMessage(state.snapshot, parsed.data);
    if (!next) {
      logger.debug(undefined, `dropped a stale contribution message gen=${gen}`);
      return;
    }
    state.snapshot = next;
    if (parsed.data.kind === "snapshot") {
      logger.info(
        undefined,
        `contributions snapshot gen=${next.gen} rev=${next.rev} extensions=${next.extensions.length}`,
      );
    }
    contributions.fire(parsed.data);
  });
  state.connection = { gen, protocol, server, client, host, subscription };
  views.attach(gen, host);
  onClose(() => {
    if (state.connection?.protocol === protocol) detach(`port closed gen=${gen}`);
  });
  logger.info(undefined, `extension host paired gen=${gen}`);
  // 新代际收一份声明：排在在途的重读之后，推的总是最新一份；还没读完清单时由重读完成后推。
  void enqueueStatic("push extension declarations", pushDeclarations);
}
