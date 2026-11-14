function nodeSupports(minor22: number, minor24: number): boolean {
  const [major, minor = 0] = process.versions.node.split(".").map(Number);
  return (major === 22 && minor >= minor22) || (major === 24 && minor >= minor24) || (major ?? 0) > 24;
}

function proxyConfigured(): boolean {
  return ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].some(name => Boolean(process.env[name]?.trim()));
}

/** Node separates arguments at unquoted spaces and honors backslash escapes inside double quotes. */
function nodeOptions(value: string): string[] {
  const options: string[] = [];
  let quoted = false;
  let option = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '"') quoted = !quoted;
    else if (char === "\\" && quoted) {
      const escaped = value[++index];
      if (escaped === undefined) return [];
      option += escaped;
    } else if (char === " " && !quoted) {
      if (option) options.push(option);
      option = "";
    } else option += char;
  }
  if (quoted) return [];
  if (option) options.push(option);
  return options;
}

function nodeNetworkSettings() {
  const args = [...process.execArgv, ...nodeOptions(process.env.NODE_OPTIONS ?? "")];
  const flagEnabled = (flag: string) => process.allowedNodeEnvironmentFlags.has(flag) && args.includes(flag);
  return {
    proxyActive: nodeSupports(21, 0) && proxyConfigured() && (process.env.NODE_USE_ENV_PROXY === "1" || flagEnabled("--use-env-proxy")),
    systemCaActive: (nodeSupports(19, 6) && process.env.NODE_USE_SYSTEM_CA === "1") || flagEnabled("--use-system-ca"),
  };
}

// Node initializes environment proxy support before the server loads its own env file.
let startupSettings: ReturnType<typeof nodeNetworkSettings> | undefined;
export function captureNodeNetworkSettings(): void {
  startupSettings = nodeNetworkSettings();
}

export function nodeProxyStatus() {
  return {
    nodeVersion: process.versions.node,
    proxyConfigured: proxyConfigured(),
    proxyActive: (startupSettings ?? nodeNetworkSettings()).proxyActive,
  };
}

export function nodeProxyHint(status = nodeProxyStatus()): string | undefined {
  if (status.proxyActive || !status.proxyConfigured) return undefined;
  if (!nodeSupports(21, 0)) {
    return `Node.js ${status.nodeVersion} is too old for NODE_USE_ENV_PROXY. For fetch(), use Node.js 22.21.0+ on the 22.x line or 24.0.0+.`;
  }
  return "Node ignores HTTPS_PROXY and HTTP_PROXY unless NODE_USE_ENV_PROXY=1. Set the proxy and NODE_USE_ENV_PROXY before Node starts.";
}

export function nodeSystemCaHint(): string | undefined {
  if ((startupSettings ?? nodeNetworkSettings()).systemCaActive) return undefined;
  if (!nodeSupports(19, 6)) {
    if (process.allowedNodeEnvironmentFlags.has("--use-system-ca")) return "Try starting Node with --use-system-ca to use system certificates.";
    return `Node.js ${process.versions.node} is too old for NODE_USE_SYSTEM_CA. Use Node.js 22.19.0+ on the 22.x line or 24.6.0+.`;
  }
  return "Try NODE_USE_SYSTEM_CA=1 to use system certificates.";
}
