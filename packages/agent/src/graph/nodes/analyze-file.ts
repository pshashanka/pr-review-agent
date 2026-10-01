import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LlmTool } from "../../llm/llm.js";
import { SYSTEM, renderPatches, reviewContext } from "../../llm/prompts.js";
import type { ChangeSet } from "../../mcp/repo-tools.js";
import { anchorFindings } from "../../review/anchor.js";
import { FileAnalysisSchema, type Finding } from "../../review/schema.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { ReviewPlan, Update } from "../state.js";
import { describeError, isTransient } from "./errors.js";

/** The payload of each `Send` in the fan-out: one file, plus the shared context. */
export interface FileTask {
  path: string;
  /** Position in the plan; used to give findings short, stable ids. */
  index: number;
  change: ChangeSet;
  plan: ReviewPlan;
}

const MODEL_TOOLS = ["read_file", "search_code"] as const;

/**
 * Reviews one file with a bounded tool loop. Findings are checked against the
 * diff straight away: ones on files outside the change are rejected.
 *
 * A failure specific to this file (refusal, unusable output) is recorded and
 * the review carries on. Transient failures are rethrown so the node's retry
 * policy, and after that checkpoint resume, can handle them.
 */
export function analyzeFile({ tools, llm, options }: ReviewDeps) {
  return async (task: FileTask, config: LangGraphRunnableConfig): Promise<Update> => {
    emit(config, { type: "file_started", path: task.path });
    try {
      const definitions = await tools.anthropicTools(MODEL_TOOLS);
      const modelTools: LlmTool[] = definitions.map((definition) => ({
        definition,
        run: (input) => tools.callForModel(definition.name, input),
      }));

      const result = await llm.structured({
        task: "analyzeFile",
        system: SYSTEM.analyzeFile,
        context: reviewContext(task.change, task.plan),
        prompt: [
          `Review the changes to \`${task.path}\`.`,
          `To read code, use ref ${task.change.head} for the new version and ${task.change.mergeBase ?? task.change.base} for the old one.`,
          "",
          renderPatches(task.plan, [task.path], options.promptDiffBytes),
        ].join("\n"),
        schema: FileAnalysisSchema,
        tools: modelTools,
        maxToolRounds: options.maxToolRounds,
        onProgress: (progress) => {
          emit(config, { type: "llm", task: "analyzeFile", path: task.path, progress });
        },
      });

      const findings: Finding[] = result.output.findings.map((finding, i) => ({
        ...finding,
        id: `${task.index + 1}.${i + 1}`,
        path: task.path,
        inline: false,
      }));
      const patches = new Map(Object.entries(task.plan.patches));
      const { kept, rejected } = anchorFindings(findings, patches);

      emit(config, { type: "file_done", path: task.path, findings: kept.length });
      return {
        fileResults: [{ path: task.path, summary: result.output.summary, findings: kept }],
        rejectedFindings: rejected,
        usage: result.usage,
        model: result.model,
      };
    } catch (error) {
      if (isTransient(error)) throw error;
      const message = describeError(error);
      emit(config, { type: "file_failed", path: task.path, error: message });
      return { fileErrors: [{ path: task.path, error: message }] };
    }
  };
}
