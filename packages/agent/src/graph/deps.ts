import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { Llm, LlmProgress, LlmTask } from "../llm/llm.js";
import type { RepoTools } from "../mcp/repo-tools.js";
import type { Review } from "../review/schema.js";
import type { Published, ReviewInput } from "./state.js";

/** The parts of RepoTools the graph uses; tests can wrap or replace them. */
export type RepoToolsApi = Pick<
  RepoTools,
  "listChangedFiles" | "getDiff" | "runTests" | "anthropicTools" | "callForModel" | "toolNames"
>;

/** Where an approved review goes. Must be idempotent: publishing twice posts once. */
export interface Publisher {
  publish(review: Review, input: ReviewInput): Promise<Published>;
}

export interface ReviewOptions {
  /** At most this many files get a model call; the rest are reported as skipped. */
  maxFiles: number;
  /** Tool rounds allowed per file before the model must answer. */
  maxToolRounds: number;
  /** mcp-repo-tools test target to run for the coverage check, if the server allows it. */
  testTarget: string | null;
  /** Budget for diff text in a single prompt. */
  promptDiffBytes: number;
}

export const DEFAULT_OPTIONS: ReviewOptions = {
  maxFiles: 40,
  maxToolRounds: 6,
  testTarget: null,
  promptDiffBytes: 120_000,
};

export interface ReviewDeps {
  tools: RepoToolsApi;
  llm: Llm;
  publisher: Publisher;
  options: ReviewOptions;
}

/** Progress events nodes emit on LangGraph's "custom" stream, for the CLI and web UI. */
export type ReviewEvent =
  | { type: "status"; node: string; message: string }
  | { type: "file_started"; path: string }
  | { type: "file_done"; path: string; findings: number }
  | { type: "file_failed"; path: string; error: string }
  | { type: "step_failed"; node: string; error: string }
  | { type: "tests_run"; target: string; passed: boolean; durationMs: number }
  | { type: "llm"; task: LlmTask; path: string | null; progress: LlmProgress };

export function emit(config: LangGraphRunnableConfig, event: ReviewEvent): void {
  config.writer?.(event);
}
