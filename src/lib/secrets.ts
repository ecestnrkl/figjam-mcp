import { AsyncLocalStorage } from "node:async_hooks";
import { redactMessageCredentials, REDACTED } from "./redact.js";

const scopedSecrets = new AsyncLocalStorage<string[]>();

/** A token argument stays local to its asynchronous tool call, including SDK logs. */
export function withSecretScope<T>(secrets: string[], run: () => T): T {
  return scopedSecrets.run([...(scopedSecrets.getStore() ?? []), ...secrets], run);
}

/** Exact configured secrets are hidden even when board credential redaction is disabled. */
export function redactConfiguredSecrets(text: string, additionalSecrets: string[] = []): string {
  const secrets = [process.env.LLM_API_KEY, process.env.FIGMA_ACCESS_TOKEN, ...(scopedSecrets.getStore() ?? []), ...additionalSecrets]
    // Local providers accept short placeholders; replacing them would corrupt board text and IDs.
    .flatMap(value => value && value.trim().length >= 16 ? [value, value.trim()] : [])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of new Set(secrets)) text = text.replaceAll(secret, REDACTED);
  return text;
}

/** Normalize messages at external error boundaries, before truncation or whitespace folding. */
export function redactMessage(text: string, additionalSecrets: string[] = []): string {
  const safe = redactConfiguredSecrets(text, additionalSecrets);
  // Invalid redaction configuration must still be reportable without leaking a secret.
  try { return redactMessageCredentials(safe); } catch { return safe; }
}

export function validateHeaderSecret(value: string, source: string): void {
  if (/[^\x20-\x7e]/.test(value.trim())) {
    throw new Error(`${source} contains characters that cannot be sent in an HTTP header, such as smart quotes or a line break. Copy the token again.`);
  }
}

/** Keep typed errors (timeouts, status and cooldown) while hiding their message. */
export function redactError(error: unknown, additionalSecrets: string[] = []): Error {
  if (error instanceof Error) {
    error.message = redactMessage(error.message, additionalSecrets);
    return error;
  }
  return new Error(redactMessage(String(error), additionalSecrets));
}

/** Final host boundary: covers summaries and warnings as well as structured tool text. */
export function redactOutputSecrets<T>(value: T, additionalSecrets: string[] = []): T {
  if (typeof value === "string") return redactConfiguredSecrets(value, additionalSecrets) as T;
  if (Array.isArray(value)) return value.map(item => redactOutputSecrets(item, additionalSecrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactOutputSecrets(item, additionalSecrets)])) as T;
  }
  return value;
}
