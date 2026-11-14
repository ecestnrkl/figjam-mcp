/** Waits named by Retry-After headers and cooldowns, shown the same way for Figma and the model provider. */

/** Up to this many seconds a wait is shown as seconds; a longer one as a time of day. */
const SECONDS_LIMIT = 120;

/** Retry-After in seconds or as an HTTP date, as milliseconds from now; undefined when absent, zero or past. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value || value.length > 1000) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const wait = Number(text) * 1000;
    return wait > 0 && Number.isFinite(new Date(now + wait).getTime()) ? wait : undefined;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

/** Rounded up to the minute, so that a retry at the named time is not too early. */
export function utcTime(ms: number): string {
  return `${new Date(Math.ceil(ms / 60_000) * 60_000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function roughDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  return days < 14 ? plural(days, "day") : plural(Math.round(days / 7), "week");
}

/**
 * A wait as "45 seconds" up to two minutes, else as "2026-11-10 14:30 UTC (in about 5 days)".
 * `at` is the end of the wait in milliseconds since 1970.
 */
export function describeWaitUntil(at: number, now = Date.now()): string {
  const waitMs = Math.max(0, at - now);
  if (waitMs <= SECONDS_LIMIT * 1000) {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${utcTime(at)} (in about ${roughDuration(waitMs)})`;
}
