import { createCliSessionControl } from "@zcode/session-control/cli";
import { SessionControlError, type CliTrustedContext } from "@zcode/session-control/contracts";
import { scopeKey, page } from "./runtimeFacts.js";
import type { RuntimeMethodContext } from "./runtimeMethodContext.js";
import { createCliRuntimeExecution } from "./runtimeExecution.js";
export function buildCliRuntimeControl(context: RuntimeMethodContext) {
  const {
    roots,
    workspace,
    options,
    observations,
    assertOpen,
    ref,
    owner,
    writable,
    reserveRoot,
    fence,
    validate,
    validateRead,
    listStored,
    trace,
    remember,
    commandId,
    attach,
    track,
    storedRef,
    storedSummary,
    readStored,
    readVisibleMessages,
    summary,
    releaseRootReservation,
  } = context;
  return createCliSessionControl({
    access: {
      async authorize(ctx, request) {
        assertOpen();
        owner(ctx.rootSession);
        // 读本机会话库不要求目标由本进程托管；仍要求调用者是本 manager 的根。
        if (
          (ctx as CliTrustedContext).readAnyLocalSession &&
          (request.action === "listSessions" || request.action === "readSession")
        )
          return { scope: request.scope, fence: fence(ctx) };
        if (scopeKey(request.scope) !== scopeKey(workspace))
          throw new SessionControlError(
            "forbidden",
            "This CLI owner is bound to a different workspace",
          );
        if (request.session) {
          const target = owner(request.session);
          if (!target.verified)
            throw new SessionControlError(
              "unavailable",
              "Session source is not verified as an independent CLI root",
            );
        }
        return { scope: workspace, fence: fence(ctx) };
      },
    },
    sessions: {
      async resolveSession(ctx, sessionId) {
        assertOpen();
        owner(ctx.rootSession);
        // 托管根返回 manager 的规范引用，保证与 create/list 结果及写操作授权使用同一身份。
        if (roots.has(sessionId)) return ref(sessionId);
        const stored = await readStored(sessionId);
        return stored ? storedRef(stored) : undefined;
      },
      async listSessions(ctx, input, grant) {
        validateRead(ctx, grant);
        // 规格 0.14：workspace 过滤器已从工具面删除；只读全库授权在场时读整个本机会话库。
        const items = ctx.readAnyLocalSession
          ? await listStored(undefined)
          : await Promise.all([...roots.values()].filter((root) => root.verified).map(summary));
        const query = input.query?.toLocaleLowerCase();
        const paged = page(
          items
            .filter((item) => !query || item.title.toLocaleLowerCase().includes(query))
            .sort(
              (a, b) =>
                (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
                a.session.sessionId.localeCompare(b.session.sessionId),
            ),
          input.cursor,
          input.limit,
        );
        return {
          sessions: paged.items,
          ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
        };
      },
      async readSession(ctx, input, grant) {
        validateRead(ctx, grant);
        // 托管根沿用 manager 的规范引用与实时摘要；其他会话只在可读本机会话库时按 ID 读持久层。
        const root =
          roots.has(input.session.sessionId) || !ctx.readAnyLocalSession
            ? owner(input.session)
            : undefined;
        const stored = await readStored(input.session.sessionId);
        if (!root && (!stored || scopeKey(storedRef(stored)) !== scopeKey(input.session)))
          throw new SessionControlError("forbidden", "Session is not in the local session store");
        if (input.view === "summary")
          return { view: "summary", summary: root ? await summary(root) : storedSummary(stored!) };
        const visible = stored ? await readVisibleMessages(stored) : [];
        const paged = page(visible, input.cursor, input.limit);
        return {
          view: "messages",
          session: input.session,
          messages: paged.items.map((message) => ({
            id: String(message.info.id),
            role: message.info.role,
            text: message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          })),
          ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
        };
      },
    },
    execution: createCliRuntimeExecution(context),
    observations: {
      async open(ctx, operation, signal, grant) {
        validate(ctx, grant);
        owner(operation.session);
        return observations.open(operation, signal);
      },
    },
    deadlines: {
      create(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<void>((resolveDeadline) => {
          timer = setTimeout(resolveDeadline, timeoutMs);
        });
        return { expired, close: () => clearTimeout(timer) };
      },
    },
  });
}
