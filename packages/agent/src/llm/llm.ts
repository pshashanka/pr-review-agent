import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { Usage } from "../review/schema.js";

/** The graph steps that call the model. Each gets its own effort level. */
export type LlmTask =
  "summarizeDiff" | "analyzeFile" | "checkCoverage" | "flagRisks" | "synthesize";

/** A tool the model may call during a structured request. */
export interface LlmTool {
  definition: Anthropic.Beta.BetaTool;
  run(input: unknown): Promise<{ text: string; isError: boolean }>;
}

export type LlmProgress =
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; isError: boolean };

export interface StructuredRequest<T> {
  task: LlmTask;
  /** Instructions. Must be identical across calls of one task, so it caches. */
  system: string;
  /**
   * Context shared by many calls (e.g. the PR overview). Sent before `prompt`
   * with its own cache breakpoint, so a fan-out of calls reuses it.
   */
  context: string;
  prompt: string;
  schema: z.ZodType<T>;
  tools?: readonly LlmTool[];
  /** After this many tool rounds the model must answer without tools. */
  maxToolRounds?: number;
  signal?: AbortSignal;
  onProgress?: (event: LlmProgress) => void;
}

export interface StructuredResult<T> {
  output: T;
  /** The model that produced the answer (differs from the requested one after a fallback). */
  model: string;
  usage: Usage;
  toolCalls: number;
}

/** What the graph needs from a model. Tests substitute a scripted fake. */
export interface Llm {
  readonly model: string;
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** The model (and any fallback) declined the request. Retrying won't help. */
export class LlmRefusalError extends Error {
  override readonly name = "LlmRefusalError";

  constructor(readonly category: string | null) {
    super(`The model declined the request${category === null ? "" : ` (${category})`}.`);
  }
}

/** The model finished without a usable answer (ran out of tokens, or no parseable output). */
export class LlmOutputError extends Error {
  override readonly name = "LlmOutputError";
}
