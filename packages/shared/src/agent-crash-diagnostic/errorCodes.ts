/**
 * Node / libuv 公开的 errno 名称。只有这些名字才算 errno：旧逻辑把任意大写 E 开头的词
 * （HTTP 响应头里的 `server: 'ESA'`、`END`、`ENV`）都当成 errno。
 */
const NODE_ERRNO_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAGAIN",
  "EAI_ADDRFAMILY",
  "EAI_AGAIN",
  "EAI_BADFLAGS",
  "EAI_BADHINTS",
  "EAI_CANCELED",
  "EAI_FAIL",
  "EAI_FAMILY",
  "EAI_MEMORY",
  "EAI_NODATA",
  "EAI_NONAME",
  "EAI_OVERFLOW",
  "EAI_PROTOCOL",
  "EAI_SERVICE",
  "EAI_SOCKTYPE",
  "EALREADY",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECHARSET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDESTADDRREQ",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EFTYPE",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EILSEQ",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "EMSGSIZE",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODATA",
  "ENODEV",
  "ENOENT",
  "ENOMEM",
  "ENONET",
  "ENOPROTOOPT",
  "ENOSPC",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSOCK",
  "ENOTSUP",
  "ENOTTY",
  "ENXIO",
  "EOVERFLOW",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EREMOTEIO",
  "EROFS",
  "ESHUTDOWN",
  "ESOCKTNOSUPPORT",
  "ESPIPE",
  "ESRCH",
  "ETIMEDOUT",
  "ETXTBSY",
  "EXDEV",
  // 上面没覆盖到的 libuv / os.constants.errno 名（getSystemErrorMap 只列当前平台的映射，
  // EOPNOTSUPP 在 Linux 上与 ENOTSUP 同值，因此不在其中）。
  "EBADMSG",
  "ECHILD",
  "EDEADLK",
  "EDOM",
  "EDQUOT",
  "EIDRM",
  "EINPROGRESS",
  "EMULTIHOP",
  "ENETRESET",
  "ENOEXEC",
  "ENOLCK",
  "ENOLINK",
  "ENOMSG",
  "ENOSR",
  "ENOSTR",
  "EOPNOTSUPP",
  "ESTALE",
  "ETIME",
  "EUNATCH",
  "EWOULDBLOCK",
  // Node dns 模块（c-ares / getaddrinfo）的错误码，如 `getaddrinfo ENOTFOUND host`。
  // 不收 EOF：它在普通文本里太常见，会重演 `ESA` 那类误报。
  "EADDRGETNETWORKPARAMS",
  "EBADFAMILY",
  "EBADFLAGS",
  "EBADHINTS",
  "EBADNAME",
  "EBADQUERY",
  "EBADRESP",
  "EBADSTR",
  "ECANCELLED",
  "EDESTRUCTION",
  "EFILE",
  "EFORMERR",
  "ELOADIPHLPAPI",
  "ENONAME",
  "ENOTFOUND",
  "ENOTIMP",
  "ENOTINITIALIZED",
  "EREFUSED",
  "ESERVFAIL",
  "ETIMEOUT",
]);

// `code: undefined` 之类对象转储里的字面量不是错误码。
const NON_CODE_LITERALS = new Set(["ERROR", "UNDEFINED", "NULL", "TRUE", "FALSE"]);

function isKnownImplicitErrorCode(code: string): boolean {
  return NODE_ERRNO_CODES.has(code) || code.includes("ERR_") || code.startsWith("SQLITE_");
}

function extractAgentErrorCode(value: string): string {
  const explicit = value.match(/\bcode:\s*["']?([A-Z][A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
  if (explicit && !NON_CODE_LITERALS.has(explicit)) {
    return explicit;
  }
  // 没有显式 `code:` 时才扫裸词；裸词只接受真实 errno 名与 ERR_ / SQLITE_ 前缀。
  return (
    value
      .match(/\b(?:[A-Z]+_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|E[A-Z0-9_]{2,})\b/g)
      ?.find(isKnownImplicitErrorCode) ?? ""
  );
}

function isErrnoCode(errorCode: string): boolean {
  return NODE_ERRNO_CODES.has(errorCode);
}
export {
  NODE_ERRNO_CODES,
  NON_CODE_LITERALS,
  isKnownImplicitErrorCode,
  extractAgentErrorCode,
  isErrnoCode,
};
