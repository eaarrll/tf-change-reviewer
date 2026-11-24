import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolRunner,
  BetaToolRunnerParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  AgentInput,
  AgentOptions,
  AgentOutcome,
  AgentRunInfo,
  AgentVerdict,
  Effort,
  Lineage,
  Logger,
} from "../types.js";
import { buildDigest, maskText } from "./digest.js";
import { addResponseUsage, emptyUsage, normalizeModelId, promptTokens, type UsageTotals } from "./pricing.js";
import { buildSystemPrompt } from "./prompt.js";
import { VERDICT_OUTPUT_FORMAT, parseVerdict } from "./result-schema.js";
import { createTools, type ReviewTool, type ToolCallTrace } from "./tools.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Judging materiality and tracing causes is intelligence-sensitive work; Opus 5.5 alone defaults to medium. */
export const DEFAULT_EFFORT: Effort = "high";

/** Non-streaming requests stay well under the SDK's HTTP timeout at this size. */
const MAX_TOKENS = 16_000;
/**
 * Retries cover 429/5xx/connection drops. A slow turn is not retried on a short per-request
 * timeout (that would bill the same turn several times); the review deadline bounds it.
 */
const MAX_RETRIES = 2;
/** The final answer gets at least this share of the time budget... */
const FINAL_RESERVE_SHARE = 0.2;
/** ...or this multiple of the slowest turn so far, whichever is larger. */
const FINAL_RESERVE_TURNS = 1.5;
/** setTimeout fires at once for delays above this (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;
/** Tool calls run per model turn; extra parallel calls are refused so one turn cannot fan out. */
export const MAX_TOOL_CALLS_PER_TURN = 8;
/** Consecutive turns cut off at max_tokens inside a tool call before the agent must answer. */
const MAX_TRUNCATED_RETRIES = 1;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/**
 * Models that accept server-side refusal fallbacks (`fallbacks: "default"`). Matched on the exact
 * first-party id: a provider-prefixed id means a cloud platform, where the parameter is unavailable.
 */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-fable-5",
]);
/** Models that accept a `role: "system"` message inside `messages`. */
const SYSTEM_MESSAGE_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Why the loop asked for the final answer. */
type StopCause = "complete" | "budget" | "max_turns" | "timeout";
type BudgetCause = Exclude<StopCause, "complete">;

const FINAL_INSTRUCTIONS: Record<BudgetCause, string> = {
  budget: "The cost budget for this review is used up.",
  max_turns: "The turn limit for this review is reached.",
  timeout: "The time limit for this review is nearly reached.",
};

const ANSWER_NOW =
  "Do not call any more tools. Using only the evidence gathered so far, reply now with the final verdict JSON " +
  "object. Judge every candidate; where a change or its cause is not verified, lower the confidence and say so " +
  "in cause, and cite only lines you have seen.";

const REPAIR_REQUEST =
  "Your previous reply was not a valid verdict JSON object. Reply with only the JSON object that matches the " +
  "required schema: no prose, no code fences.";

/** AgentOutcome plus the run's detail, for logs, evals and debugging. */
export interface AgentReviewOutcome extends AgentOutcome {
  trace: ToolCallTrace[];
  usage: UsageTotals;
}

/** Mutable bookkeeping shared by the loop and the error path, so a failure still reports what was spent. */
interface RunState {
  usage: UsageTotals;
  trace: ToolCallTrace[];
  turns: number;
  /** Model that served the last response (a fallback can differ from the one asked for). */
  modelUsed: string | null;
  started: number;
}

class DeadlineExceeded extends Error {}

/**
 * Review the plan with read-only tools and return a structured verdict. Never throws: on any
 * failure the verdict is null and `info.status` / `info.error` say why.
 */
export async function runAgentReview(input: AgentInput, opts: AgentOptions): Promise<AgentReviewOutcome> {
  const state: RunState = {
    usage: emptyUsage(),
    trace: [],
    turns: 0,
    modelUsed: null,
    started: performance.now(),
  };
  let model = DEFAULT_MODEL;
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    model = modelOf(opts);
    const skip = skipReason(input, opts);
    if (skip) {
      opts.logger?.info(`AI review skipped: ${skip}.`);
      return outcome(state, model, null, "skipped", skip);
    }
    timer = setTimeout(() => deadline.abort(), Math.min(opts.timeoutMs, MAX_TIMER_MS));
    // The race guarantees an answer at the deadline even if a tool call is stuck on slow I/O.
    return await Promise.race([review(input, opts, state, deadline.signal), rejectOnAbort(deadline.signal)]);
  } catch (error) {
    const timedOut = error instanceof DeadlineExceeded || error instanceof APIUserAbortError;
    const reason = describeError(error, opts);
    try {
      opts.logger?.warn(`AI review failed: ${reason}`);
    } catch {
      // A broken logger must not turn a reported failure into a thrown one.
    }
    return outcome(state, model, null, timedOut ? "timeout" : "error", reason);
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

function modelOf(opts: AgentOptions): string {
  return opts.model?.trim() || DEFAULT_MODEL;
}

function skipReason(input: AgentInput, opts: AgentOptions): string | null {
  if (!opts.client && !opts.apiKey?.trim()) return "no Anthropic API key";
  if (!(opts.timeoutMs > 0)) return "the time limit is not positive";
  if (!(opts.maxCostUsd > 0)) return "the cost budget is not positive";
  if (!(opts.maxTurns >= 1)) return "the turn limit is below 1";
  if (!input.ctx.scored.some((s) => s.change.action !== "no-op")) return "the plan changes nothing";
  return null;
}

/*
 * The loop runs on the SDK tool runner. Each yielded message is one API response; the loop body
 * prices it, checks for a refusal or a final answer, and steers the next request through the
 * runner's documented hooks: after `setMessagesParams()` in the loop body the runner sends exactly
 * the messages given and runs no tools on its own, so the budget finalization and the repair
 * request are both "append these messages, send once more". History is append-only throughout,
 * which preserved thinking requires.
 */
async function review(
  input: AgentInput,
  opts: AgentOptions,
  state: RunState,
  signal: AbortSignal,
): Promise<AgentReviewOutcome> {
  const { logger } = opts;
  const model = modelOf(opts);
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const client = await createClient(opts);
  warnAboutModelControls(model, effort, logger);

  let admittedTurn = -1;
  let admittedCalls = 0;
  const tools = createTools({
    ctx: input.ctx,
    knownLineage: knownLineage(input),
    ...(logger && { logger }),
    // Tools run after the response that asked for them, so the current turn is the right one.
    onCall: (call) => state.trace.push({ turn: state.turns, ...call }),
    admit: () => {
      if (signal.aborted) return "Skipped: the review's time limit was reached.";
      if (admittedTurn !== state.turns) {
        admittedTurn = state.turns;
        admittedCalls = 0;
      }
      admittedCalls += 1;
      return admittedCalls > MAX_TOOL_CALLS_PER_TURN
        ? `Skipped: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls run per turn. Make fewer, more targeted calls.`
        : null;
    },
  });

  const startFinal = opts.maxTurns <= 1;
  const params = buildParams(input, opts, model, effort, tools, startFinal);
  const runner = client.beta.messages.toolRunner(params, { signal });

  let stopCause: StopCause = startFinal ? "max_turns" : "complete";
  let finalRequested = startFinal;
  let repairRequested = false;
  let warnedUnpriced = false;
  let turnStarted = state.started;
  let slowestTurnMs = 0;
  let truncatedRetries = 0;

  for await (const message of runner) {
    const now = performance.now();
    slowestTurnMs = Math.max(slowestTurnMs, now - turnStarted);
    state.turns += 1;
    state.modelUsed = message.model;
    state.usage = addResponseUsage(state.usage, message.model, message.usage);
    logTurn(logger, state, message);

    if (message.stop_reason === "refusal") return refusal(state, model, message);
    // Only server tools pause a turn; the runner resumes it by itself.
    if (message.stop_reason === "pause_turn") continue;

    // A tool call cut off at max_tokens may carry a silently truncated input: never run it.
    // Retry once (budget permitting); after that, or when a limit is hit, the agent must answer.
    if (message.stop_reason === "max_tokens" && hasToolUse(message) && !finalRequested) {
      const cause =
        budgetCause(state, opts, now - state.started, slowestTurnMs) ??
        (truncatedRetries >= MAX_TRUNCATED_RETRIES ? "max_turns" : null);
      const errors = truncatedToolResults(message);
      if (cause) {
        stopCause = cause;
        finalRequested = true;
        logger?.warn(`Turn ${state.turns} hit max_tokens inside a tool call; asking for the final answer.`);
        continueWithFinal(runner, message, errors, cause);
      } else {
        truncatedRetries += 1;
        logger?.warn(`Turn ${state.turns} hit max_tokens inside a tool call; asking the agent to retry it.`);
        continueWith(runner, message, [{ role: "user", content: errors }], false);
      }
      turnStarted = performance.now();
      continue;
    }
    truncatedRetries = 0;

    if (message.stop_reason === "tool_use" && !finalRequested) {
      if (state.usage.costUsd === null && !warnedUnpriced) {
        warnedUnpriced = true;
        logger?.warn(`No price is known for ${message.model}; the cost budget cannot be enforced.`);
      }
      const cause = budgetCause(state, opts, now - state.started, slowestTurnMs);
      if (cause) {
        stopCause = cause;
        finalRequested = true;
        logger?.info(`${FINAL_INSTRUCTIONS[cause]} Asking for the final answer.`);
        await requestFinalAnswer(runner, message, cause);
      }
      turnStarted = performance.now();
      continue;
    }

    const verdict = parseVerdict(finalText(message));
    if (verdict) return outcome(state, model, verdict, stopCause);
    if (repairRequested) {
      return outcome(
        state,
        model,
        null,
        "error",
        "the final answer was not a valid verdict JSON object, even after a repair request",
      );
    }
    repairRequested = true;
    logger?.warn(
      `The final answer was not valid verdict JSON (stop reason ${message.stop_reason}); asking once more.`,
    );
    await requestRepair(runner, message);
    turnStarted = performance.now();
  }

  return outcome(
    state,
    model,
    null,
    "error",
    `the agent stopped after ${state.turns} turns without a final answer`,
  );
}

function knownLineage(input: AgentInput): Map<string, Lineage | null> {
  return new Map(input.candidates.map((c) => [c.scored.change.address, c.lineage] as const));
}

async function createClient(opts: AgentOptions): Promise<Anthropic> {
  if (opts.client !== undefined) {
    const injected = opts.client as Partial<Anthropic> | null;
    if (typeof injected?.beta?.messages?.toolRunner !== "function") {
      throw new Error("the injected client is not an Anthropic SDK client");
    }
    return injected as Anthropic;
  }
  return new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: MAX_RETRIES,
    timeout: Math.min(opts.timeoutMs, MAX_TIMER_MS),
    ...(await proxyOptions(process.env, opts.logger)),
  });
}

function buildParams(
  input: AgentInput,
  opts: AgentOptions,
  model: string,
  effort: Effort,
  tools: ReviewTool[],
  startFinal: boolean,
): BetaToolRunnerParams & { stream?: false } {
  const controlledEffort = effortFor(model, effort);
  const digest = buildDigest(input);
  return {
    model,
    max_tokens: MAX_TOKENS,
    // One explicit breakpoint after the stable tools + system prefix, plus automatic caching of
    // the growing conversation tail.
    system: [
      { type: "text", text: buildSystemPrompt(opts.extraInstructions), cache_control: { type: "ephemeral" } },
    ],
    cache_control: { type: "ephemeral" },
    messages: [
      {
        role: "user",
        content: startFinal
          ? [
              { type: "text", text: digest },
              { type: "text", text: `${FINAL_INSTRUCTIONS.max_turns} ${ANSWER_NOW}` },
            ]
          : digest,
      },
    ],
    tools,
    // Never a forced tool_choice (any/tool is a 400 on the 5.5 models); "none" only for the final answer.
    ...(startFinal && { tool_choice: { type: "none" } }),
    // Adaptive thinking is the default on the 5.x models (and cannot be turned off on Opus 5.5) but
    // must be asked for on Opus 4.6-4.8 and Sonnet 4.6. Older models get no thinking param.
    ...(supportsAdaptiveThinking(model) && { thinking: { type: "adaptive" } }),
    output_config: { ...(controlledEffort && { effort: controlledEffort }), format: VERDICT_OUTPUT_FORMAT },
    ...(FALLBACK_MODELS.has(model) && {
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    }),
    // Initial turns, the final answer, and one repair request; the loop stops itself earlier.
    max_iterations: Math.max(opts.maxTurns, 1) + 1,
    // Full history on every request: no server-held thread state, so each request is
    // self-contained and the run works under zero-data-retention settings.
    thread: false,
  };
}

function budgetCause(
  state: RunState,
  opts: AgentOptions,
  elapsedMs: number,
  slowestTurnMs: number,
): BudgetCause | null {
  if (state.usage.costUsd !== null && state.usage.costUsd >= opts.maxCostUsd) return "budget";
  if (state.turns >= opts.maxTurns - 1) return "max_turns";
  // Leave room for the tool calls already requested plus one more model turn.
  const timeoutMs = Math.min(opts.timeoutMs, MAX_TIMER_MS);
  const reserveMs = Math.max(timeoutMs * FINAL_RESERVE_SHARE, slowestTurnMs * FINAL_RESERVE_TURNS);
  if (elapsedMs + reserveMs >= timeoutMs) return "timeout";
  return null;
}

/** Answer the pending tool calls, then make the next request a tool-less final one. */
async function requestFinalAnswer(
  runner: BetaToolRunner<false>,
  message: BetaMessage,
  cause: BudgetCause,
): Promise<void> {
  continueWithFinal(runner, message, await toolResults(runner), cause);
}

/** Send `blocks` (the answers to the pending tool calls) plus the "answer now" instruction. */
function continueWithFinal(
  runner: BetaToolRunner<false>,
  message: BetaMessage,
  blocks: BetaContentBlockParam[],
  cause: BudgetCause,
): void {
  const instruction = `${FINAL_INSTRUCTIONS[cause]} ${ANSWER_NOW}`;
  // A system message is the operator channel; older models get the same text after the tool results.
  const followUp: BetaMessageParam[] =
    supportsSystemMessages(message.model) && blocks.length > 0
      ? [
          { role: "user", content: blocks },
          { role: "system", content: instruction },
        ]
      : [{ role: "user", content: [...blocks, { type: "text", text: instruction }] }];
  continueWith(runner, message, followUp);
}

async function requestRepair(runner: BetaToolRunner<false>, message: BetaMessage): Promise<void> {
  // A reply cut off at max_tokens can end in a tool call; the API needs a result for it.
  const results = await toolResults(runner);
  continueWith(runner, message, [
    { role: "user", content: [...results, { type: "text", text: REPAIR_REQUEST }] },
  ]);
}

async function toolResults(runner: BetaToolRunner<false>): Promise<BetaContentBlockParam[]> {
  const response = await runner.generateToolResponse();
  if (!response) return [];
  return typeof response.content === "string" ? [{ type: "text", text: response.content }] : response.content;
}

function continueWith(
  runner: BetaToolRunner<false>,
  message: BetaMessage,
  followUp: BetaMessageParam[],
  final = true,
): void {
  runner.setMessagesParams((params) => ({
    ...params,
    ...(final && { tool_choice: { type: "none" as const } }),
    // While the loop body runs, params.messages does not hold the reply yet; it goes back unchanged.
    messages: [...params.messages, { role: "assistant", content: message.content }, ...followUp],
  }));
}

function hasToolUse(message: BetaMessage): boolean {
  return message.content.some((block) => block.type === "tool_use");
}

function truncatedToolResults(message: BetaMessage): BetaContentBlockParam[] {
  return message.content.flatMap((block) =>
    block.type === "tool_use"
      ? [
          {
            type: "tool_result" as const,
            tool_use_id: block.id,
            is_error: true,
            content: "This tool call was cut off by the output token limit and was not run. Call it again.",
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

type ClientOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>;

/**
 * Self-hosted runners behind a proxy set HTTPS_PROXY (Octokit already honours it). Node's built-in
 * fetch does not, so route the Anthropic client through undici's env-aware agent, which also
 * respects NO_PROXY. undici is loaded only when a proxy is set (it ships with @actions/http-client);
 * when it cannot be loaded the client goes direct and a warning says so.
 */
export async function proxyOptions(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): Promise<Pick<ClientOptions, "fetch" | "fetchOptions">> {
  const proxy = env["HTTPS_PROXY"] ?? env["https_proxy"] ?? env["HTTP_PROXY"] ?? env["http_proxy"];
  if (!proxy) return {};
  try {
    const undici = await import("undici");
    // undici's fetch and dispatcher are typed separately from the DOM fetch types the SDK uses.
    return {
      fetch: undici.fetch as unknown as ClientOptions["fetch"],
      fetchOptions: {
        dispatcher: new undici.EnvHttpProxyAgent(),
      } as unknown as ClientOptions["fetchOptions"],
    };
  } catch (error) {
    logger?.warn(
      `A proxy is configured but undici could not be loaded (${errorText(error)}); connecting directly.`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Model capabilities
// ---------------------------------------------------------------------------

/** Opus/Sonnet 4.6 and later, every 5.x model, Fable and Mythos. Haiku 4.5 and 4.5-era models are excluded. */
function supportsAdaptiveThinking(model: string): boolean {
  const id = normalizeModelId(model);
  if (/^claude-(fable|mythos)-/.test(id)) return true;
  if (/^claude-(opus|sonnet|haiku)-([5-9]|\d{2,})(-|$)/.test(id)) return true;
  return /^claude-(opus|sonnet)-4-([6-9])(-|$)/.test(id);
}

function warnAboutModelControls(model: string, effort: Effort, logger: Logger | undefined): void {
  const controlled = effortFor(model, effort);
  if (controlled === null) {
    logger?.warn(`${model} has no effort control; the effort setting (${effort}) is ignored.`);
  } else if (controlled !== effort) {
    logger?.warn(`${model} does not support effort ${effort}; using ${controlled}.`);
  }
}

function supportedEfforts(model: string): readonly Effort[] {
  const id = normalizeModelId(model);
  if (/^claude-(fable|mythos)-/.test(id)) return ALL_EFFORTS;
  if (/^claude-(opus|sonnet|haiku)-([5-9]|\d{2,})(-|$)/.test(id)) return ALL_EFFORTS;
  if (/^claude-opus-4-[78](-|$)/.test(id)) return ALL_EFFORTS;
  if (/^claude-(opus|sonnet)-4-6(-|$)/.test(id)) return ["low", "medium", "high", "max"];
  if (/^claude-opus-4-5(-|$)/.test(id)) return ["low", "medium", "high"];
  return [];
}

/** The requested effort, stepped down to the highest level the model accepts; null when it has no effort control. */
export function effortFor(model: string, requested: Effort): Effort | null {
  const supported = supportedEfforts(model);
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;
  const ceiling = ALL_EFFORTS.indexOf(requested);
  return (
    [...supported].reverse().find((level) => ALL_EFFORTS.indexOf(level) < ceiling) ?? supported[0] ?? null
  );
}

function supportsSystemMessages(model: string): boolean {
  const id = normalizeModelId(model);
  return SYSTEM_MESSAGE_MODELS.has(id) || /^claude-(fable|mythos)-5(-|$)/.test(id);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function finalText(message: BetaMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function refusal(state: RunState, model: string, message: BetaMessage): AgentReviewOutcome {
  const details = message.stop_details;
  const category = details?.category ? ` (${details.category})` : "";
  const explanation = details?.explanation ? `: ${details.explanation}` : "";
  return outcome(
    state,
    model,
    null,
    "refusal",
    `Claude declined to review this plan${category}${explanation}`,
  );
}

function outcome(
  state: RunState,
  requestedModel: string,
  verdict: AgentVerdict | null,
  status: AgentRunInfo["status"],
  error?: string,
): AgentReviewOutcome {
  const info: AgentRunInfo = {
    model: state.modelUsed ?? requestedModel,
    turns: state.turns,
    toolCalls: state.trace.length,
    costUsd: state.usage.costUsd,
    // Every prompt token the model read (uncached, cache reads and cache writes).
    inputTokens: promptTokens(state.usage),
    outputTokens: state.usage.outputTokens,
    durationMs: Math.round(performance.now() - state.started),
    status,
    ...(error !== undefined && { error: maskText(error) }),
  };
  return { verdict, info, trace: [...state.trace], usage: { ...state.usage } };
}

function logTurn(logger: Logger | undefined, state: RunState, message: BetaMessage): void {
  if (!logger) return;
  const calls = message.content.flatMap((block) => (block.type === "tool_use" ? [block.name] : []));
  const summary =
    calls.length > 0 ? calls.join(", ") : message.stop_reason === "refusal" ? "refusal" : "final answer";
  logger.info(`Turn ${state.turns}: ${summary}`);
  const { usage } = message;
  const cost = state.usage.costUsd === null ? "unknown" : `$${state.usage.costUsd.toFixed(4)}`;
  logger.debug?.(
    `turn ${state.turns}: model=${message.model} stop=${message.stop_reason} input=${usage.input_tokens} ` +
      `output=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_write=${usage.cache_creation_input_tokens ?? 0} total_cost=${cost}`,
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DeadlineExceeded()), { once: true });
  });
}

/** A one-line, operator-facing reason. Never includes the API key. */
function describeError(error: unknown, opts: Pick<AgentOptions, "apiKey" | "timeoutMs">): string {
  return scrubSecrets(errorReason(error, opts.timeoutMs), opts.apiKey);
}

function errorReason(error: unknown, timeoutMs: number): string {
  if (error instanceof DeadlineExceeded || error instanceof APIUserAbortError) {
    return `the agent timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  if (error instanceof AuthenticationError)
    return "Anthropic API key rejected (401); check the API key secret";
  if (error instanceof PermissionDeniedError)
    return `Anthropic API permission denied (403): ${apiDetail(error)}`;
  if (error instanceof RateLimitError) {
    return `Anthropic API rate or spend limit reached (429), even after retries: ${apiDetail(error)}`;
  }
  if (error instanceof NotFoundError)
    return `Anthropic API returned 404, often an unknown model id: ${apiDetail(error)}`;
  if (error instanceof BadRequestError)
    return `Anthropic API rejected the request (400): ${apiDetail(error)}`;
  if (error instanceof APIConnectionTimeoutError) return "the Anthropic API request timed out";
  if (error instanceof APIConnectionError) return `could not reach the Anthropic API: ${error.message}`;
  if (error instanceof APIError)
    return `Anthropic API error ${error.status ?? "(no status)"}: ${apiDetail(error)}`;
  return `the agent failed: ${errorText(error)}`;
}

function apiDetail(error: APIError): string {
  return error.apiMessage ?? error.message;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scrubSecrets(text: string, apiKey: string | undefined): string {
  const key = apiKey?.trim();
  const withoutKey = key ? text.split(key).join("[REDACTED]") : text;
  return withoutKey.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
