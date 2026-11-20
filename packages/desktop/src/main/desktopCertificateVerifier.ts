import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { isIP } from "node:net";
import {
  AlgorithmIdentifier,
  AuthorityKeyIdentifier,
  Certificate,
  CertificateChainValidationEngine,
  CryptoEngine,
  NameConstraints,
  RSASSAPSSParams,
} from "pkijs";
import type { Session } from "electron";

interface DesktopNetworkPolicyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

type CertificateVerifyProc = NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>;

interface CertificateLike {
  data?: string;
  fingerprint?: string;
  issuerCert?: CertificateLike | null;
}

const USE_CHROMIUM_DEFAULT_VERIFICATION = -3;

const ACCEPT_CERTIFICATE = 0;

const MAX_CERTIFICATE_CHAIN_DEPTH = 16;

const CERT_AUTHORITY_INVALID = -202;

const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";

const ANY_EXTENDED_KEY_USAGE_OID = "2.5.29.37.0";

// 仅接受链验证器、域名验证和下方用途检查真正处理的 critical 扩展；能解析不等于支持其语义。
const SUPPORTED_CRITICAL_CERTIFICATE_EXTENSIONS = new Set([
  "2.5.29.14", // subjectKeyIdentifier
  "2.5.29.15", // keyUsage
  "2.5.29.17", // subjectAltName
  "2.5.29.19", // basicConstraints
  "2.5.29.30", // nameConstraints
  "2.5.29.32", // certificatePolicies
  "2.5.29.33", // policyMappings
  "2.5.29.35", // authorityKeyIdentifier
  "2.5.29.36", // policyConstraints
  "2.5.29.37", // extKeyUsage
  "2.5.29.54", // inhibitAnyPolicy
]);

const certificateCrypto = new CryptoEngine({ name: "node", crypto: globalThis.crypto });

export function createCustomCaCertificateVerifyProc(
  trustedCertificates: readonly X509Certificate[],
): CertificateVerifyProc | null {
  if (trustedCertificates.length === 0) return null;
  const trustedCerts = trustedCertificates.map((cert) => Certificate.fromBER(cert.raw));
  // fullchain 可包含服务端叶证书；常规建链只使用具备 CA 签发资格的锚，避免叶证书抢先命中。
  // 自签名服务证书仍从完整配置集逐字匹配，不以 CA 资格取消用户的显式信任。
  const trustedAuthorities = trustedCerts.filter((_, index) => trustedCertificates[index]!.ca);
  return (request, callback) => {
    // 自定义 CA 只补充信任根；其它错误保留 Chromium 判定。未知 CA 会遮住弱算法错误，链验证另行拒绝。
    if (request.errorCode !== CERT_AUTHORITY_INVALID) {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }
    void verifyCustomCaChain(
      request.hostname,
      request.certificate,
      trustedCerts,
      trustedAuthorities,
    )
      .then((valid) => callback(valid ? ACCEPT_CERTIFICATE : USE_CHROMIUM_DEFAULT_VERIFICATION))
      .catch(() => callback(USE_CHROMIUM_DEFAULT_VERIFICATION));
  };
}

export function readCustomCaCertificatesFromPem(pem: string): X509Certificate[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(
    (block) => new X509Certificate(block),
  );
}

async function verifyCustomCaChain(
  hostname: string,
  certificate: CertificateLike,
  trustedCerts: Certificate[],
  trustedAuthorities: Certificate[],
): Promise<boolean> {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  let current: CertificateLike | null | undefined = certificate;
  while (current && chain.length < MAX_CERTIFICATE_CHAIN_DEPTH) {
    if (!current.data) return false;
    const parsed = new X509Certificate(current.data);
    if (seen.has(parsed.fingerprint256)) break;
    seen.add(parsed.fingerprint256);
    chain.push(parsed);
    current = current.issuerCert;
  }
  const leaf = chain[0];
  if (!leaf || checkServerIdentity(hostname, leaf.toLegacyObject())) return false;
  const certs = chain.reverse().map((cert) => Certificate.fromBER(cert.raw));
  const endEntity = certs.at(-1)!;
  // PKIjs 完成签名、有效期、CA、名称/策略与关键扩展检查；不能只匹配链中的根指纹。
  const engine = new CertificateChainValidationEngine({ certs, trustedCerts: trustedAuthorities });
  // Chromium 已给出有序链；通用建链器若重访交叉签发证书会递归不止。
  // 只沿收到的链向根前进，显式信任锚可直接终止，链长上限才真正约束验证工作量。
  engine.findIssuer = async (cert, validation, crypto) => {
    const index = certs.indexOf(cert);
    const authority = cert.extensions?.find(
      (extension) => extension.extnID === "2.5.29.35",
    )?.parsedValue;
    let issuers: Certificate[];
    if (
      authority instanceof AuthorityKeyIdentifier &&
      !authority.keyIdentifier &&
      authority.authorityCertIssuer
    ) {
      // PKIjs 将 GeneralName[] 误作单个 DN；issuer/serial 指向签发者证书的 issuer，而非 subject。
      issuers = [];
      for (const candidate of [...trustedAuthorities, ...certs.slice(0, index)]) {
        if (
          !cert.issuer.isEqual(candidate.subject) ||
          !authority.authorityCertSerialNumber?.isEqual(candidate.serialNumber)
        )
          continue;
        if (
          !authority.authorityCertIssuer.some(
            (name) => name.type === 4 && candidate.issuer.isEqual(name.value),
          )
        )
          continue;
        if (await cert.verify(candidate, crypto)) issuers.push(candidate);
      }
    } else {
      issuers = await validation.defaultFindIssuer(cert, validation, crypto);
    }
    return issuers.filter(
      (issuer) =>
        trustedAuthorities.includes(issuer) ||
        (certs.indexOf(issuer) >= 0 && certs.indexOf(issuer) < index),
    );
  };
  const result = await engine.verify({}, certificateCrypto);
  let verifiedPath = result.certificatePath;
  if (!result.result) {
    if (certs.length !== 1) return false;
    // PKIjs 会复制单证书锚并按 CA 检查，非 CA 或无签发用途时返回 14 而非短链错误 9。
    // 仅对用户逐字配置的自签名服务证书补充信任；仍经过下方完整叶证书约束。
    const anchor = trustedCerts.find((cert) =>
      Buffer.from(cert.toSchema().toBER(false)).equals(leaf.raw),
    );
    const now = Date.now();
    if (
      !anchor ||
      !endEntity.subject.isEqual(endEntity.issuer) ||
      !leaf.verify(leaf.publicKey) ||
      now < anchor.notBefore.value.getTime() ||
      now > anchor.notAfter.value.getTime()
    )
      return false;
    verifiedPath = [endEntity];
  }
  if (!verifiedPath) return false;
  if (!verifyPathNameConstraints(verifiedPath, hostname)) return false;
  // TLS 的服务端用途与 pathLen 不由通用 PKIjs 策略验证器施加，按实际已验证路径补齐。
  return verifiedPath.every((cert, index) => {
    // PKIjs 的 basicCheck 只对 CA 调用扩展检查，叶证书会遗漏未知 critical 和 TLS keyUsage。
    // PKIjs 结构解析失败会返回带 parsingError 的真值对象，不能仅凭 parsedValue 存在放行。
    // 显式信任的单证书路径也必须经过同一约束，不能因信任锚匹配而绕过用途校验。
    if (
      cert.extensions?.some(
        (extension) =>
          extension.critical &&
          (!SUPPORTED_CRITICAL_CERTIFICATE_EXTENSIONS.has(extension.extnID) ||
            !extension.parsedValue ||
            "parsingError" in extension.parsedValue),
      )
    )
      return false;
    const usage = cert.extensions?.find((extension) => extension.extnID === "2.5.29.15");
    if (usage) {
      // DER 能解码不代表扩展结构正确：INTEGER 等对象也有 valueHexView，不能当成 BIT STRING。
      const tag = usage.parsedValue?.idBlock;
      if (tag?.tagClass !== 1 || tag.tagNumber !== 3 || tag.isConstructed) return false;
      const bits: Uint8Array | undefined = usage.parsedValue?.valueBlock?.valueHexView;
      const unused: number | undefined = usage.parsedValue?.valueBlock?.unusedBits;
      // keyUsage 只有 9 个定义位；校验整条路径，避免 CA 的 INTEGER 被库当成签发位读取。
      if (
        !bits?.length ||
        bits.length > 2 ||
        unused === undefined ||
        unused < 0 ||
        unused > 7 ||
        (bits.at(-1)! & ((1 << unused) - 1)) !== 0 ||
        (bits.length === 2 && (bits[1]! & 0x7f) !== 0) ||
        (bits[0] === 0 && (bits[1] ?? 0) === 0) ||
        (((bits[0]! & 0x01) !== 0 || ((bits[1] ?? 0) & 0x80) !== 0) && (bits[0]! & 0x08) === 0)
      )
        return false;
      // 当前 Chromium 的服务端握手需要签名；没有 keyUsage 扩展表示未施加该用途限制。
      if (index === 0 && (bits[0]! & 0x80) === 0) return false;
      if (index > 0 && (bits[0]! & 0x04) === 0) return false;
      const isCa = cert.extensions?.find((extension) => extension.extnID === "2.5.29.19")
        ?.parsedValue?.cA;
      if ((bits[0]! & 0x04) !== 0 && isCa !== true) return false;
    }
    // 未知 CA 的高优先级错误可遮住弱签名/密钥，WebCrypto 验签成功也不表示强度合格。
    if (
      [
        "1.2.840.113549.1.1.4",
        "1.2.840.113549.1.1.5",
        "1.2.840.10040.4.3",
        "1.2.840.10045.4.1",
      ].includes(cert.signatureAlgorithm.algorithmId)
    )
      return false;
    if (cert.signatureAlgorithm.algorithmId === "1.2.840.113549.1.1.10") {
      // PSS 的摘要藏在参数中；省略字段按 SHA-1 默认值解释，不能仅检查外层签名 OID。
      const params = cert.signatureAlgorithm.algorithmParams;
      const pss = new RSASSAPSSParams(params ? { schema: params } : {});
      const strongDigests = [
        "2.16.840.1.101.3.4.2.4",
        "2.16.840.1.101.3.4.2.1",
        "2.16.840.1.101.3.4.2.2",
        "2.16.840.1.101.3.4.2.3",
      ];
      if (
        !strongDigests.includes(pss.hashAlgorithm.algorithmId) ||
        pss.maskGenAlgorithm.algorithmId !== "1.2.840.113549.1.1.8" ||
        !pss.maskGenAlgorithm.algorithmParams
      )
        return false;
      const maskDigest = new AlgorithmIdentifier({ schema: pss.maskGenAlgorithm.algorithmParams });
      if (!strongDigests.includes(maskDigest.algorithmId)) return false;
    }
    const key = new X509Certificate(Buffer.from(cert.toSchema().toBER(false))).publicKey;
    if (
      (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      return false;
    const eku = cert.extensions?.find((extension) => extension.extnID === "2.5.29.37")?.parsedValue;
    if (
      eku &&
      !eku.keyPurposes.includes(SERVER_AUTH_OID) &&
      !eku.keyPurposes.includes(ANY_EXTENDED_KEY_USAGE_OID)
    )
      return false;
    const basic = cert.extensions?.find(
      (extension) => extension.extnID === "2.5.29.19",
    )?.parsedValue;
    if (typeof basic?.pathLenConstraint === "number") {
      const intermediateCount = verifiedPath!
        .slice(1, index)
        .filter((child) => !child.subject.isEqual(child.issuer)).length;
      if (intermediateCount > basic.pathLenConstraint) return false;
    }
    return true;
  });
}

function dnsConstraint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/\.$/, "");
  const domain = normalized.startsWith(".") ? normalized.slice(1) : normalized;
  return domain.length > 0 &&
    domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    ? normalized
    : null;
}

function matchesNameConstraint(type: number, name: unknown, constraint: unknown): boolean {
  if (type === 2) {
    const value = dnsConstraint(name);
    const allowed = dnsConstraint(constraint);
    if (!value || value.startsWith(".") || !allowed) return false;
    return allowed.startsWith(".")
      ? value.endsWith(allowed)
      : value === allowed || value.endsWith("." + allowed);
  }
  const address: Uint8Array | undefined = (name as { valueBlock?: { valueHexView?: Uint8Array } })
    ?.valueBlock?.valueHexView;
  const range: Uint8Array | undefined = (
    constraint as { valueBlock?: { valueHexView?: Uint8Array } }
  )?.valueBlock?.valueHexView;
  return Boolean(
    address &&
    range &&
    (address.length === 4 || address.length === 16) &&
    range.length === address.length * 2 &&
    address.every(
      (byte, index) =>
        (byte & range[index + address.length]!) ===
        (range[index]! & range[index + address.length]!),
    ),
  );
}

function verifyPathNameConstraints(path: readonly Certificate[], hostname: string): boolean {
  // PKIjs 会合并各级 permitted 集合后按 OR 匹配，还可能只检查 SAN 中任意一个名字。
  // 每级 CA 独立约束所有后代名字：级内 OR、级间 AND；不能由子 CA 扩大父 CA 的授权。
  for (let issuerIndex = 1; issuerIndex < path.length; issuerIndex++) {
    const extension = path[issuerIndex]!.extensions?.find((item) => item.extnID === "2.5.29.30");
    if (!extension) continue;
    const constraints = extension.parsedValue;
    if (!(constraints instanceof NameConstraints) || "parsingError" in constraints) return false;
    const permitted = constraints.permittedSubtrees ?? [];
    const excluded = constraints.excludedSubtrees ?? [];
    if (permitted.length + excluded.length === 0) return false;
    // 未支持的名称形式或距离不能静默忽略；保持失败关闭，而非伪称完整 RFC 5280 实现。
    for (const subtree of [...permitted, ...excluded]) {
      if ((subtree.minimum ?? 0) !== 0 || subtree.maximum !== undefined) return false;
      if (subtree.base.type === 2) {
        if (!dnsConstraint(subtree.base.value)) return false;
      } else if (subtree.base.type === 7) {
        const bytes = subtree.base.value?.valueBlock?.valueHexView;
        if (!(bytes instanceof Uint8Array) || (bytes.length !== 8 && bytes.length !== 32))
          return false;
      } else return false;
    }
    for (let subjectIndex = 0; subjectIndex < issuerIndex; subjectIndex++) {
      const subject = path[subjectIndex]!;
      if (subjectIndex > 0 && subject.subject.isEqual(subject.issuer)) continue;
      const names = subject.extensions?.find((item) => item.extnID === "2.5.29.17")?.parsedValue
        ?.altNames;
      if (names !== undefined && !Array.isArray(names)) return false;
      // 约束下的叶证书必须提供可检查的 SAN；CN 回退或通配符不借此额外获得信任。
      if (
        subjectIndex === 0 &&
        (!names?.some((name: { type: number }) => name.type === (isIP(hostname) ? 7 : 2)) ||
          names.some(
            (name: { type: number; value: unknown }) =>
              name.type === 2 &&
              (!dnsConstraint(name.value) || dnsConstraint(name.value)!.startsWith(".")),
          ))
      )
        return false;
      for (const name of names ?? []) {
        const allowed = permitted.filter((subtree) => subtree.base.type === name.type);
        if (
          excluded.some(
            (subtree) =>
              subtree.base.type === name.type &&
              matchesNameConstraint(name.type, name.value, subtree.base.value),
          )
        )
          return false;
        if (
          allowed.length > 0 &&
          !allowed.some((subtree) =>
            matchesNameConstraint(name.type, name.value, subtree.base.value),
          )
        )
          return false;
      }
    }
  }
  return true;
}
export {
  type DesktopNetworkPolicyLogger,
  type CertificateVerifyProc,
  type CertificateLike,
  USE_CHROMIUM_DEFAULT_VERIFICATION,
  ACCEPT_CERTIFICATE,
  MAX_CERTIFICATE_CHAIN_DEPTH,
  CERT_AUTHORITY_INVALID,
  SERVER_AUTH_OID,
  ANY_EXTENDED_KEY_USAGE_OID,
  SUPPORTED_CRITICAL_CERTIFICATE_EXTENSIONS,
  certificateCrypto,
  verifyCustomCaChain,
  dnsConstraint,
  matchesNameConstraint,
  verifyPathNameConstraints,
};
