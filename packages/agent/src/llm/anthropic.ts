import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ZERO_USAGE, addUsage, type Usage } from "../review/schema.js";
import {
  LlmOutputError,
  LlmRefusalError,
  type Llm,
  type LlmProgress,
  type LlmTask,
  type LlmTool,
  type StructuredRequest,
  type StructuredResult,
} from "./llm.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_MODEL = "claude-opus-5";

/** Deeper thinking where judgement matters most; lighter where the task is mechanical. */
export const DEFAULT_EFFORT: Record<LlmTask, Effort> = {
  summarizeDiff: "low",
  analyzeFile: "medium",
  checkCoverage: "medium",
  flagRisks: "medium",
  synthesize: "high",
};

const DEFAULT_MAX_TOOL_ROUNDS = 6;

export interface AnthropicLlmOptions {
  /** Only `beta.messages.stream` is used, which keeps this easy to fake in tests. */
  client?: Pick<Anthropic, "beta">;
  model?: string;
  effort?: Partial<Record<LlmTask, Effort>>;
  maxTokens?: number;
}

/**
 * Calls Claude with structured outputs, adaptive thinking, prompt caching and
 * server-side refusal fallbacks. When tools are given, it runs a manual tool
 * loop and the final answer is still schema-constrained.
 *
 * Transient API errors (429, 5xx, connection) are retried inside the SDK, so
 * graph nodes don't retry them again.
 */
export class AnthropicLlm implements Llm {
  readonly model: string;
  readonly #client: Pick<Anthropic, "beta">;
  readonly #effort: Record<LlmTask, Effort>;
  readonly #maxTokens: number;

  constructor(options: AnthropicLlmOptions = {}) {
    this.#client = options.client ?? new Anthropic({ maxRetries: 4 });
    this.model = options.model ?? DEFAULT_MODEL;
    this.#effort = { ...DEFAULT_EFFORT, ...options.effort };
    this.#maxTokens = options.maxTokens ?? 32_000;
  }

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const tools = request.tools ?? [];
    const maxToolRounds = request.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const ephemeral = { type: "ephemeral" } as const;

    // Render order is tools → system → messages. Both breakpoints sit on content
    // that is identical across a task's calls, so fan-out calls hit the cache.
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: "text", text: request.system, cache_control: ephemeral },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: request.context, cache_control: ephemeral },
          { type: "text", text: request.prompt },
        ],
      },
    ];

    let usage: Usage = ZERO_USAGE;
    let toolCalls = 0;
    let toolRounds = 0;

    for (;;) {
      const outOfToolRounds = toolRounds >= maxToolRounds;
      const stream = this.#client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.#maxTokens,
          system,
          messages,
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => t.definition),
                tool_choice: { type: outOfToolRounds ? "none" : "auto" },
              }
            : {}),
          thinking: { type: "adaptive", display: "summarized" },
          output_config: {
            effort: this.#effort[request.task],
            format: betaZodOutputFormat(request.schema),
          },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (request.onProgress !== undefined) {
        const onProgress = request.onProgress;
        stream.on("thinking", (delta) => {
          onProgress({ type: "thinking", delta });
        });
      }

      const message = await stream.finalMessage();
      usage = addUsage(usage, toUsage(message.usage));

      if (message.stop_reason === "refusal") {
        throw new LlmRefusalError(message.stop_details?.category ?? null);
      }
      if (message.stop_reason === "max_tokens") {
        throw new LlmOutputError(`Ran out of output tokens (${this.#maxTokens}).`);
      }
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: afterFallback(message.content) });
        continue;
      }

      const content = afterFallback(message.content);
      const toolUses = content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );
      if (message.stop_reason === "tool_use" && toolUses.length > 0) {
        // Echo the turn back, thinking blocks included, but only what survives
        // the fallback boundary (see `afterFallback`); that also governs which
        // tool calls we execute, so a declined model's tool calls never run.
        messages.push({ role: "assistant", content });
        const results = await Promise.all(
          toolUses.map((use) => this.#runTool(use, tools, request.onProgress)),
        );
        // All results for one turn go in a single user message.
        messages.push({ role: "user", content: results });
        toolCalls += toolUses.length;
        toolRounds++;
        continue;
      }

      if (message.parsed_output === null) {
        throw new LlmOutputError("The model's answer did not match the output schema.");
      }
      return { output: message.parsed_output, model: message.model, usage, toolCalls };
    }
  }

  async #runTool(
    use: Anthropic.Beta.BetaToolUseBlock,
    tools: readonly LlmTool[],
    onProgress: ((event: LlmProgress) => void) | undefined,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    onProgress?.({ type: "tool_call", name: use.name, input: use.input });
    const tool = tools.find((t) => t.definition.name === use.name);
    const result =
      tool === undefined
        ? { text: `Unknown tool: ${use.name}`, isError: true }
        : await tool.run(use.input);
    onProgress?.({ type: "tool_result", name: use.name, isError: result.isError });
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: result.text,
      ...(result.isError ? { is_error: true } : {}),
    };
  }
}

/**
 * Content to echo back for a turn that may have crossed a server-side fallback.
 *
 * With `fallbacks: "default"`, a declining model's hop can end partway through
 * the response; the API then requires that, up to the last `fallback` block,
 * only `text` blocks be echoed back — `thinking`, `redacted_thinking`,
 * `tool_use` and any other model-internal block from the declining model's
 * unfinished span can't be replayed to it. The `fallback` block itself is an
 * ignored audit marker and is dropped. Content after the boundary, and `text`
 * blocks before it, pass through unchanged. With no `fallback` block, the
 * content is unchanged.
 */
export function afterFallback(
  content: readonly Anthropic.Beta.BetaContentBlock[],
): Anthropic.Beta.BetaContentBlock[] {
  const lastFallbackIndex = content.findLastIndex((block) => block.type === "fallback");
  if (lastFallbackIndex === -1) return content.slice();
  const beforeBoundary = content
    .slice(0, lastFallbackIndex)
    .filter((block) => block.type === "text");
  const afterBoundary = content.slice(lastFallbackIndex + 1);
  return [...beforeBoundary, ...afterBoundary];
}

function toUsage(usage: Anthropic.Beta.BetaUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
