import { createCredentialCipherBridge } from "@zcode/shared/credential-security";
import { credentialCipherReplySchema, zcodeProtocolMethods } from "@zcode/shared";
import type {
  CredentialCipherRequest,
  CredentialCipherReply,
} from "@zcode/shared/credential-security";

type ProtocolCredentialContext = {
  requestClient(
    method: string,
    params: CredentialCipherRequest,
    resultSchema: unknown,
    options: unknown,
  ): Promise<CredentialCipherReply>;
};

/** 内置 CLI 的凭据加解密只委托已连接 Host，禁止失败后改为本机系统库读取。 */
function createProtocolCredentialCipher(
  resolveContext: () => ProtocolCredentialContext | undefined,
) {
  const bridge = createCredentialCipherBridge((request) => {
    const context = resolveContext();
    if (!context) throw new Error("Credential cipher host is unavailable");
    void context
      .requestClient(
        zcodeProtocolMethods.interactionRequestCredentialCipher,
        request,
        credentialCipherReplySchema,
        {},
      )
      .then(
        (reply) => bridge.receive(reply),
        () =>
          bridge.receive({
            requestId: request.requestId,
            result: {
              ok: false,
              error: {
                code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
                message: "Credential cipher host is unavailable",
              },
            },
          }),
      );
  });
  return bridge;
}
export { type ProtocolCredentialContext, createProtocolCredentialCipher };
