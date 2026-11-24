import { describe, expect, it } from "vitest";
import {
  addResponseUsage,
  addUsage,
  emptyUsage,
  normalizeModelId,
  priceFor,
  promptTokens,
} from "../../src/agent/pricing.js";

const MTOK = 1_000_000;

describe("priceFor", () => {
  it.each([
    ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
    ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
    ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
    ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
    ["claude-mythos-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
    ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ])("knows the list price of %s", (model, price) => {
    expect(priceFor(model)).toEqual(price);
  });

  it("bills Haiku 5.5 prompts above 100K tokens at the long-prompt rate", () => {
    expect(priceFor("claude-haiku-5-5", 100_000)?.input).toBe(0.1);
    expect(priceFor("claude-haiku-5-5", 100_001)).toEqual({
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    });
    // Other models have no long-prompt tier.
    expect(priceFor("claude-opus-5-5", 900_000)?.input).toBe(4);
  });

  it("ignores provider prefixes and snapshot dates", () => {
    expect(priceFor("us.anthropic.claude-opus-5-5")?.input).toBe(4);
    expect(priceFor("anthropic.claude-sonnet-5-5")?.input).toBe(2);
    expect(priceFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(normalizeModelId(" eu.anthropic.claude-opus-5-5 ")).toBe("claude-opus-5-5");
    expect(normalizeModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("returns null for unknown models", () => {
    expect(priceFor("claude-custom-preview")).toBeNull();
    expect(priceFor("gpt-whatever")).toBeNull();
  });
});

describe("addUsage", () => {
  it("adds tokens and prices every kind of token", () => {
    const totals = addUsage(emptyUsage(), "claude-opus-5-5", {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 4_000,
    });

    expect(totals).toMatchObject({
      requests: 1,
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 4_000,
    });
    expect(totals.costUsd).toBeCloseTo((1_000 * 4 + 2_000 * 20 + 10_000 * 0.2 + 4_000 * 5) / MTOK, 12);
    expect(promptTokens(totals)).toBe(15_000);
  });

  it("treats missing cache counts as zero", () => {
    const totals = addUsage(emptyUsage(), "claude-sonnet-5-5", {
      input_tokens: MTOK,
      output_tokens: MTOK,
      cache_read_input_tokens: null,
    });
    expect(totals.costUsd).toBeCloseTo(12, 10);
  });

  it("prices a long Haiku 5.5 prompt (cache reads count toward the threshold)", () => {
    const totals = addUsage(emptyUsage(), "claude-haiku-5-5", {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 150_000,
    });
    expect(totals.costUsd).toBeCloseTo((1_000 * 0.5 + 1_000 * 2.5 + 150_000 * 0.05) / MTOK, 12);
  });

  it("makes the total unknown once one response is unpriced, and keeps counting tokens", () => {
    let totals = addUsage(emptyUsage(), "claude-opus-5-5", { input_tokens: 10, output_tokens: 10 });
    totals = addUsage(totals, "claude-custom-preview", { input_tokens: 5, output_tokens: 5 });
    totals = addUsage(totals, "claude-opus-5-5", { input_tokens: 1, output_tokens: 1 });

    expect(totals.costUsd).toBeNull();
    expect(totals.requests).toBe(3);
    expect(totals.inputTokens).toBe(16);
  });

  it("does not mutate the totals it is given", () => {
    const start = emptyUsage();
    addUsage(start, "claude-opus-5-5", { input_tokens: 10, output_tokens: 10 });
    expect(start).toEqual(emptyUsage());
  });
});

describe("addResponseUsage", () => {
  it("uses the top-level usage when there are no iterations", () => {
    const totals = addResponseUsage(emptyUsage(), "claude-opus-5-5", {
      input_tokens: 100,
      output_tokens: 10,
      iterations: [],
    });
    expect(totals.requests).toBe(1);
    expect(totals.costUsd).toBeCloseTo((100 * 4 + 10 * 20) / MTOK, 12);
  });

  it("prices each attempt of a fallback-rescued response by its own model, as one request", () => {
    const totals = addResponseUsage(emptyUsage(), "claude-opus-4-8", {
      input_tokens: 2_000,
      output_tokens: 100,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000, output_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000, output_tokens: 100 },
        { type: "fallback_message", input_tokens: 0, output_tokens: 10 },
      ],
    });

    expect(totals.requests).toBe(1);
    expect(totals.inputTokens).toBe(2_000);
    expect(totals.outputTokens).toBe(110);
    expect(totals.costUsd).toBeCloseTo((1_000 * 4 + 1_000 * 5 + 110 * 25) / MTOK, 12);
  });
});
