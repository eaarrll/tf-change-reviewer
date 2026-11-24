// A real Anthropic SDK client whose fetch replays scripted responses (no network), for end-to-end
// tests of reviewPlan and the CLI with the agent enabled.
import Anthropic from "@anthropic-ai/sdk";

export interface RecordedRequest {
  url: string;
  raw: string;
}

export type ScriptStep = Response | ((raw: string) => Response);

export function scriptedClient(steps: ScriptStep[]): { client: Anthropic; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = String(init?.body);
    requests.push({ url, raw });
    const step = steps[requests.length - 1];
    if (!step) throw new Error(`unexpected request #${requests.length}`);
    return typeof step === "function" ? step(raw) : step;
  };
  return { client: new Anthropic({ apiKey: "sk-test", fetch, maxRetries: 0 }), requests };
}

let counter = 0;

export function reply(content: unknown[], stopReason: string): Response {
  counter += 1;
  return json({
    id: `msg_test_${counter}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": `req_test_${counter}` },
  });
}

export const thinking = { type: "thinking", thinking: "", signature: "c2lnbmF0dXJlLWZvci10ZXN0cw==" };

export function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

/** A final answer with a wire-format verdict (snake_case cause_refs). */
export function verdictReply(verdict: {
  summary: string;
  findings: {
    address: string;
    severity: "critical" | "high" | "medium";
    title: string;
    impact: string;
    cause: string;
    cause_refs: { file: string; line: number }[];
    confidence: "high" | "medium" | "low";
  }[];
  dismissed: { address: string; reason: string }[];
}): Response {
  return reply([thinking, { type: "text", text: JSON.stringify(verdict) }], "end_turn");
}
