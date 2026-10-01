import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SYSTEM, renderPatches, reviewContext } from "../../llm/prompts.js";
import { ruleRisks } from "../../review/rules.js";
import { ModelRisksSchema, type Risk } from "../../review/schema.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { describeError, isTransient } from "./errors.js";
import { requireValue } from "./require.js";

/**
 * Deterministic rules first; the model adds semantic risks the rules can't
 * see. The rules are computed before the model call, so a refusal or
 * unusable output only loses the model's risks, not the rule-based ones.
 * Transient failures are rethrown for the node's retry policy.
 */
export function flagRisks({ llm, options }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = requireValue(state.change, "change");
    const plan = requireValue(state.plan, "plan");

    const hidden = plan.skipped
      .filter((s) => s.reason === "hidden by repo policy")
      .map((s) => s.path);
    const rules = ruleRisks(change.files, hidden);
    const ruleSummary =
      rules.length === 0
        ? "none"
        : rules.map((r) => `- ${r.kind} (${r.level}): ${r.paths.join(", ")}`).join("\n");

    try {
      const result = await llm.structured({
        task: "flagRisks",
        system: SYSTEM.flagRisks,
        context: reviewContext(change, plan),
        prompt: [
          `Already flagged by rules:\n${ruleSummary}`,
          "",
          renderPatches(
            plan,
            plan.files.map((f) => f.path),
            options.promptDiffBytes,
          ),
        ].join("\n"),
        schema: ModelRisksSchema,
        onProgress: (progress) => {
          emit(config, { type: "llm", task: "flagRisks", path: null, progress });
        },
      });

      const modelRisks: Risk[] = result.output.risks.map((r) => ({ ...r, source: "model" }));
      return { risks: [...rules, ...modelRisks], usage: result.usage, model: result.model };
    } catch (error) {
      if (isTransient(error)) throw error;
      const message = describeError(error);
      emit(config, { type: "step_failed", node: "flagRisks", error: message });
      return { risks: rules, stepErrors: [{ step: "flagRisks", error: message }] };
    }
  };
}
