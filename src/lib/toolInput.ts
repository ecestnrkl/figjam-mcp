import type { z } from "zod";

/**
 * zod drops unknown keys before a handler runs, so a host that sends ingest_mode instead of
 * ingestMode would get the default without a word. The guard wraps the schema's Standard Schema
 * validation (public SDK API) to see the raw arguments first; the advertised JSON Schema is the
 * schema's own and stays unchanged.
 */

const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 64;

export interface IgnoredArguments {
  /** The dropped keys, shortened; never their values. */
  keys: string[];
  /** One sentence for the text content. */
  sentence: string;
}

const ignoredByInput = new WeakMap<object, IgnoredArguments>();

/** The unknown keys the guard dropped from this validated input, if any. */
export function ignoredArgumentsOf(input: object): IgnoredArguments | undefined {
  return ignoredByInput.get(input);
}

/** Lowercase without "_" and "-": ingest_mode, node-ids and NodeIds read as ingestMode and nodeIds. */
const canonicalKey = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

const shown = (key: string) => {
  const flat = key.replace(/\s+/g, " ");
  return flat.length > MAX_KEY_LENGTH ? `${flat.slice(0, MAX_KEY_LENGTH)}…` : flat;
};

/** Splits unknown keys into those that read as a parameter (mistakes) and the rest. */
export function classifyArguments(args: unknown, params: readonly string[]): {
  near: Array<{ key: string; params: string[] }>;
  other: string[];
} {
  const near: Array<{ key: string; params: string[] }> = [];
  const other: string[] = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { near, other };
  const known = new Set(params);
  for (const key of Object.keys(args)) {
    if (known.has(key)) continue;
    const matches = params.filter((param) => canonicalKey(param) === canonicalKey(key));
    if (matches.length) near.push({ key, params: matches });
    else other.push(key);
  }
  return { near, other };
}

export function unknownArgumentsError(near: ReadonlyArray<{ key: string; params: string[] }>): string {
  const shownNear = near.slice(0, MAX_KEYS);
  const lines = shownNear.map(({ key, params }) => `Unknown argument ${shown(key)} — did you mean ${params.join(" or ")}?`);
  const more = near.length - shownNear.length;
  return `${lines.join(" ")}${more > 0 ? ` (and ${more} more)` : ""} Nothing was done.`;
}

export function ignoredArgumentsSentence(tool: string, keys: readonly string[], params: readonly string[]): string {
  const takes = params.length ? `${tool} takes ${params.join(", ")}` : `${tool} takes no arguments`;
  return `Ignored unknown argument${keys.length === 1 ? "" : "s"} ${keys.join(", ")}; ${takes}.`;
}

/**
 * Registers `schema` with an input check in front of validation:
 *  - a key that equals a parameter but for case, "_" and "-" ends the call before any work;
 *  - other unknown keys are dropped as before, and named in the text and in ignoredArguments.
 */
export function guardToolInput<S extends z.ZodObject>(tool: string, schema: S): S {
  const params = Object.keys(schema.shape);
  const standard = schema["~standard"];
  const guardedStandard = Object.create(standard, {
    validate: {
      value: async (args: unknown) => {
        const { near, other } = classifyArguments(args, params);
        if (near.length) throw new Error(unknownArgumentsError(near));
        const result = await standard.validate(args);
        if (!result.issues && other.length && typeof result.value === "object" && result.value !== null) {
          const keys = other.slice(0, MAX_KEYS).map(shown);
          const omitted = other.length - keys.length;
          const named = omitted > 0 ? [...keys, `and ${omitted} more`] : keys;
          ignoredByInput.set(result.value, { keys, sentence: ignoredArgumentsSentence(tool, named, params) });
        }
        return result;
      },
    },
  });
  return Object.create(schema, { "~standard": { value: guardedStandard, enumerable: false } }) as S;
}
