import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlm } from "../../src/llm/anthropic.js";
import {
  LlmOutputError,
  LlmRefusalError,
  type LlmProgress,
  type LlmTool,
} from "../../src/llm/llm.js";

type Params = Anthropic.Beta.MessageCreateParams;

interface FakeTurn {
  content?: unknown[];
  stop_reason?: string;
  stop_details?: { category: string | null } | null;
  parsed_output?: unknown;
  thinking?: string[];
}

/** A fake `beta.messages.stream` that replays scripted turns and records each request. */
function fakeClient(turns: FakeTurn[]) {
  const requests: Params[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Params) {
          // Snapshot via JSON: the loop mutates `messages` later, and the format holds a parse function.
          requests.push(JSON.parse(JSON.stringify(params)) as Params);
          const turn = turns.shift();
          if (turn === undefined) throw new Error("no scripted turn left");
          const listeners: ((delta: string) => void)[] = [];
          return {
            on(event: string, listener: (delta: string) => void) {
              if (event === "thinking") listeners.push(listener);
              return this;
            },
            finalMessage() {
              for (const delta of turn.thinking ?? []) for (const l of listeners) l(delta);
              return Promise.resolve({
                model: "claude-opus-5",
                content: turn.content ?? [],
                stop_reason: turn.stop_reason ?? "end_turn",
                stop_details: turn.stop_details ?? null,
                parsed_output: "parsed_output" in turn ? turn.parsed_output : null,
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 0,
                },
              });
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, "beta">, requests };
}

const schema = z.object({ answer: z.string() });

const baseRequest = {
  task: "synthesize" as const,
  system: "You review code.",
  context: "PR overview",
  prompt: "Do the thing.",
  schema,
};

const echoTool = (name: string, calls: unknown[]): LlmTool => ({
  definition: { name, description: name, input_schema: { type: "object", properties: {} } },
  run: (input) => {
    calls.push(input);
    return Promise.resolve({ text: `${name} ok`, isError: false });
  },
});

describe("AnthropicLlm", () => {
  it("sends a cached, schema-constrained request with adaptive thinking and fallbacks", async () => {
    const { client, requests } = fakeClient([{ parsed_output: { answer: "42" } }]);
    const llm = new AnthropicLlm({ client });

    const result = await llm.structured(baseRequest);

    expect(result).toEqual({
      output: { answer: "42" },
      model: "claude-opus-5",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
      toolCalls: 0,
    });
    const request = requests[0];
    expect(request).toMatchObject({
      model: "claude-opus-5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high", format: { type: "json_schema" } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: "You review code.", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "PR overview", cache_control: { type: "ephemeral" } },
            { type: "text", text: "Do the thing." },
          ],
        },
      ],
    });
    expect(request).not.toHaveProperty("tools");
  });

  it("uses the effort configured for each task", async () => {
    const { client, requests } = fakeClient([{ parsed_output: { answer: "x" } }]);
    const llm = new AnthropicLlm({ client, effort: { analyzeFile: "low" } });

    await llm.structured({ ...baseRequest, task: "analyzeFile" });

    expect(requests[0]?.output_config?.effort).toBe("low");
  });

  it("runs a tool loop: parallel calls answered in one message, history echoed back", async () => {
    const calls: unknown[] = [];
    const toolTurn = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_use", id: "t2", name: "search_code", input: { query: "foo" } },
    ];
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: toolTurn },
      { parsed_output: { answer: "done" } },
    ]);
    const llm = new AnthropicLlm({ client });

    const result = await llm.structured({
      ...baseRequest,
      tools: [echoTool("read_file", calls), echoTool("search_code", calls)],
    });

    expect(result.output).toEqual({ answer: "done" });
    expect(result.toolCalls).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
    expect(calls).toEqual([{ path: "a.ts" }, { query: "foo" }]);

    const second = requests[1];
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[1]).toEqual({ role: "assistant", content: toolTurn });
    expect(second?.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "read_file ok" },
        { type: "tool_result", tool_use_id: "t2", content: "search_code ok" },
      ],
    });
  });

  it("stops offering tools once the round limit is reached", async () => {
    const toolUse = { type: "tool_use", id: "t1", name: "read_file", input: {} };
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse] },
      { parsed_output: { answer: "done" } },
    ]);
    const llm = new AnthropicLlm({ client });

    await llm.structured({ ...baseRequest, tools: [echoTool("read_file", [])], maxToolRounds: 1 });

    expect(requests[0]?.tool_choice).toEqual({ type: "auto" });
    expect(requests[1]?.tool_choice).toEqual({ type: "none" });
  });

  it("returns an error result for a tool the model invented", async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "rm_rf", input: {} }],
      },
      { parsed_output: { answer: "ok" } },
    ]);
    const llm = new AnthropicLlm({ client });

    await llm.structured({ ...baseRequest, tools: [echoTool("read_file", [])] });

    expect(requests[1]?.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "Unknown tool: rm_rf", is_error: true },
      ],
    });
  });

  it("forwards thinking summaries and tool calls as progress", async () => {
    const events: LlmProgress[] = [];
    const { client } = fakeClient([
      {
        stop_reason: "tool_use",
        thinking: ["Looking at ", "the diff"],
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
      },
      { parsed_output: { answer: "ok" } },
    ]);
    const llm = new AnthropicLlm({ client });

    await llm.structured({
      ...baseRequest,
      tools: [echoTool("read_file", [])],
      onProgress: (e) => events.push(e),
    });

    expect(events).toEqual([
      { type: "thinking", delta: "Looking at " },
      { type: "thinking", delta: "the diff" },
      { type: "tool_call", name: "read_file", input: { path: "a" } },
      { type: "tool_result", name: "read_file", isError: false },
    ]);
  });

  it("throws LlmRefusalError on a refusal", async () => {
    const { client } = fakeClient([
      { stop_reason: "refusal", stop_details: { category: "cyber" } },
    ]);

    await expect(new AnthropicLlm({ client }).structured(baseRequest)).rejects.toEqual(
      new LlmRefusalError("cyber"),
    );
  });

  it("throws LlmOutputError when output runs out or doesn't parse", async () => {
    const truncated = fakeClient([{ stop_reason: "max_tokens" }]);
    const unparsed = fakeClient([{ parsed_output: null }]);

    await expect(
      new AnthropicLlm({ client: truncated.client }).structured(baseRequest),
    ).rejects.toBeInstanceOf(LlmOutputError);
    await expect(
      new AnthropicLlm({ client: unparsed.client }).structured(baseRequest),
    ).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("never runs tools from a turn that hit max_tokens", async () => {
    const calls: unknown[] = [];
    const { client } = fakeClient([
      {
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
      },
    ]);

    await expect(
      new AnthropicLlm({ client }).structured({
        ...baseRequest,
        tools: [echoTool("read_file", calls)],
      }),
    ).rejects.toBeInstanceOf(LlmOutputError);
    expect(calls).toEqual([]);
  });
});
