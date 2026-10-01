import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SYSTEM, renderPatches, reviewContext } from "../../llm/prompts.js";
import { DiffSummarySchema } from "../../review/schema.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { describeError, isTransient } from "./errors.js";
import { requireValue } from "./require.js";

/**
 * A refusal or unusable output here isn't fatal: the review carries on
 * without a diff summary (`synthesize` prints "(not available)"). Transient
 * failures are rethrown for the node's retry policy.
 */
export function summarizeDiff({ llm, options }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = requireValue(state.change, "change");
    const plan = requireValue(state.plan, "plan");

    try {
      const result = await llm.structured({
        task: "summarizeDiff",
        system: SYSTEM.summarizeDiff,
        context: reviewContext(change, plan),
        prompt: `Summarize this change.\n\n${renderPatches(
          plan,
          plan.files.map((f) => f.path),
          options.promptDiffBytes,
        )}`,
        schema: DiffSummarySchema,
        onProgress: (progress) => {
          emit(config, { type: "llm", task: "summarizeDiff", path: null, progress });
        },
      });
      return { diffSummary: result.output, usage: result.usage, model: result.model };
    } catch (error) {
      if (isTransient(error)) throw error;
      const message = describeError(error);
      emit(config, { type: "step_failed", node: "summarizeDiff", error: message });
      return { stepErrors: [{ step: "summarizeDiff", error: message }] };
    }
  };
}
