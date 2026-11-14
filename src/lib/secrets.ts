import { AsyncLocalStorage } from "node:async_hooks";
import { redactMessageCredentials, REDACTED } from "./redact.js";

const scopedSecrets = new AsyncLocalStorage<string[]>();
/** Characters of one foreign text (provider, Figma, runtime error) that are kept where it is read. */
export const ERROR_TEXT_SCAN_CHARS = 1000;

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

function redactMessageValue(safe: string): string {
  // Invalid redaction configuration must still be reportable without leaking a secret.
  try { return redactMessageCredentials(safe); } catch { return safe; }
}

/** Normalize messages before rendering them to the user. */
export function redactMessage(text: string, additionalSecrets: string[] = []): string {
  return redactMessageValue(redactConfiguredSecrets(text, additionalSecrets));
}

/**
 * Cuts foreign text (provider, Figma, runtime errors) where it is read. A word the cut runs through is dropped,
 * so the redaction that follows never sees part of a URL or token.
 */
export function boundExternalText(text: string, limit = ERROR_TEXT_SCAN_CHARS): string {
  if (text.length <= limit) return text;
  let end = limit;
  if (!/\s/.test(text[end]!)) while (end > 0 && !/\s/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Foreign text: exact secrets go first, then the text is bounded at a word boundary and redacted. Shorten for output only afterwards. */
export function redactExternalErrorText(text: string, additionalSecrets: string[] = []): string {
  return redactMessageValue(boundExternalText(redactConfiguredSecrets(text, additionalSecrets)));
}

export function validateHeaderSecret(value: string, source: string): void {
  if (/[^\x20-\x7e]/.test(value.trim())) {
    throw new Error(`${source} contains characters that cannot be sent in an HTTP header, such as smart quotes or a line break. Copy the token again.`);
  }
}

/** Keep typed errors (timeouts, status and cooldown) while redacting their message; messages the server composed stay complete. */
export function redactError(error: unknown, additionalSecrets: string[] = []): Error {
  if (error instanceof Error) {
    error.message = redactMessage(error.message, additionalSecrets);
    return error;
  }
  return new Error(redactMessage(String(error), additionalSecrets));
}

/** For errors of foreign origin (fetch, SDK, streams): their message is bounded before it is redacted. */
export function redactExternalError(error: unknown, additionalSecrets: string[] = []): Error {
  if (error instanceof Error) {
    error.message = redactExternalErrorText(error.message, additionalSecrets);
    return error;
  }
  return new Error(redactExternalErrorText(String(error), additionalSecrets));
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
