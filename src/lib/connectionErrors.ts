const TLS_CODES = /^(?:CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|HOSTNAME_MISMATCH)/;

export function describeConnectionCause(error: unknown): string {
  let code: string | undefined;
  let text = "";
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const link = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (!code && typeof link.code === "string") code = link.code;
    if (!code && Array.isArray(link.errors)) {
      const inner = link.errors.find((item: unknown) => typeof (item as { code?: unknown } | undefined)?.code === "string") as { code: string } | undefined;
      code = inner?.code;
    }
    if (typeof link.message === "string") text += ` ${link.message}`;
    current = link.cause;
  }
  if (code && /^(?:ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME)$/.test(code)) return "host not found";
  if (code && /^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return "connection timed out";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code && /^(?:EHOSTUNREACH|ENETUNREACH|ENETDOWN|EHOSTDOWN)$/.test(code)) return "host unreachable";
  if ((code && TLS_CODES.test(code)) || /\b(?:certificate|ssl|tls)\b/i.test(text)) {
    return "TLS error; check the certificate and whether the URL should use http or https";
  }
  if (code && /^(?:ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code)) return "connection closed unexpectedly";
  return "network error";
}

