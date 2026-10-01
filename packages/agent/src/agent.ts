import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { DEFAULT_OPTIONS, type Publisher, type ReviewOptions } from "./graph/deps.js";
import { compileReviewGraph, type ReviewGraph } from "./graph/graph.js";
import type { PullRequestRef } from "./graph/state.js";
import { AnthropicLlm, type AnthropicLlmOptions } from "./llm/anthropic.js";
import type { Llm } from "./llm/llm.js";
import { RepoTools, type RepoToolsConnection } from "./mcp/repo-tools.js";

export interface AgentConfig {
  repoTools: RepoToolsConnection;
  /** SQLite file for checkpoints. Use ":memory:" for throwaway runs. */
  checkpointDb: string;
  publisher: Publisher;
  llm?: Llm;
  llmOptions?: AnthropicLlmOptions;
  options?: Partial<ReviewOptions>;
}

export interface Agent {
  graph: ReviewGraph;
  tools: RepoTools;
  close(): Promise<void>;
}

/** Wires the MCP client, model, publisher and checkpointer into a compiled graph. */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  const tools = await RepoTools.connect(config.repoTools);
  if (config.checkpointDb !== ":memory:")
    mkdirSync(dirname(config.checkpointDb), { recursive: true });
  const checkpointer = SqliteSaver.fromConnString(config.checkpointDb);
  const graph = compileReviewGraph(
    {
      tools,
      llm: config.llm ?? new AnthropicLlm(config.llmOptions),
      publisher: config.publisher,
      options: { ...DEFAULT_OPTIONS, ...config.options },
    },
    checkpointer,
  );
  return { graph, tools, close: () => tools.close() };
}

/**
 * One thread per (target, head commit). Re-running a review of the same
 * commit resumes the existing thread instead of starting over; a new push
 * gets a new thread.
 */
export function threadIdFor(target: PullRequestRef | { base: string }, headSha: string): string {
  const scope =
    "number" in target ? `${target.owner}/${target.repo}#${target.number}` : `base:${target.base}`;
  return `${scope}@${headSha}`;
}
