/** Token and cost totals across one agent run. */
export interface UsageTotals {
  /** HTTP requests (a response rescued by a fallback model counts once). */
  requests: number;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null as soon as one response came from a model without a known price. */
  costUsd: number | null;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PriceEntry extends ModelPrice {
  /** Requests whose prompt exceeds `threshold` tokens bill every token at `price`. */
  longPrompt?: { threshold: number; price: ModelPrice };
}

/**
 * First-party list prices. `cacheWrite` is the 5-minute TTL rate (1.25x input); the agent never
 * asks for the 1-hour TTL.
 */
const PRICES: Readonly<Record<string, PriceEntry>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: {
      threshold: 100_000,
      price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // Mythos models share their Fable counterparts' per-token prices.
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

/** Cloud provider prefixes such as "anthropic." or "us.anthropic." (Amazon Bedrock style). */
const PROVIDER_PREFIX = /^(?:[a-z]{2,6}\.)?anthropic\./;

/** Snapshot suffixes: a response can name "claude-haiku-4-5-20251001" for a "claude-haiku-4-5" request. */
const DATE_SUFFIX = /-\d{8}$/;

/** The first-party model id without a provider prefix; everything else is kept as is. */
export function normalizeModelId(model: string): string {
  return model.trim().replace(PROVIDER_PREFIX, "");
}

/** The price that applies to one request with `promptTokens` prompt tokens, or null when unknown. */
export function priceFor(model: string, promptTokens = 0): ModelPrice | null {
  const id = normalizeModelId(model);
  const entry = PRICES[id] ?? PRICES[id.replace(DATE_SUFFIX, "")];
  if (!entry) return null;
  if (entry.longPrompt && promptTokens > entry.longPrompt.threshold) return entry.longPrompt.price;
  return {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
  };
}

export function emptyUsage(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Returns new totals with one response's usage added, priced by the model that served it. */
export function addUsage(totals: UsageTotals, model: string, usage: ApiUsage): UsageTotals {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const price = priceFor(model, usage.input_tokens + cacheRead + cacheWrite);
  const responseCost =
    price === null
      ? null
      : (usage.input_tokens * price.input +
          usage.output_tokens * price.output +
          cacheRead * price.cacheRead +
          cacheWrite * price.cacheWrite) /
        1_000_000;

  return {
    requests: totals.requests + 1,
    inputTokens: totals.inputTokens + usage.input_tokens,
    outputTokens: totals.outputTokens + usage.output_tokens,
    cacheReadTokens: totals.cacheReadTokens + cacheRead,
    cacheWriteTokens: totals.cacheWriteTokens + cacheWrite,
    // One unpriced response makes the whole total unknown; a partial sum would look authoritative.
    costUsd: totals.costUsd === null || responseCost === null ? null : totals.costUsd + responseCost,
  };
}

/** One sampling attempt inside a response, as reported in `usage.iterations`. */
export interface ApiIterationUsage extends ApiUsage {
  type: string;
  model?: string | null;
}

/**
 * Adds one API response. When it carries `usage.iterations` (a refusal that a fallback model
 * rescued), each attempt is priced by the model that ran it, so the declined attempt is not
 * silently dropped; otherwise the top-level usage is used.
 */
export function addResponseUsage(
  totals: UsageTotals,
  responseModel: string,
  usage: ApiUsage & { iterations?: readonly ApiIterationUsage[] | null },
): UsageTotals {
  const iterations = usage.iterations ?? [];
  if (iterations.length === 0) return addUsage(totals, responseModel, usage);
  const summed = iterations.reduce((acc, it) => addUsage(acc, it.model ?? responseModel, it), totals);
  // Several attempts, one HTTP request.
  return { ...summed, requests: totals.requests + 1 };
}

/** All prompt tokens (uncached + cache reads + cache writes): what the model actually read. */
export function promptTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
