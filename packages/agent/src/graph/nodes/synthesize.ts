import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SYSTEM, reviewContext } from "../../llm/prompts.js";
import { SynthesisSchema } from "../../review/schema.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { requireValue } from "./require.js";

/** Turns the team's notes into a verdict, an opening summary and a curated list of finding ids. */
export function synthesize({ llm }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = requireValue(state.change, "change");
    const plan = requireValue(state.plan, "plan");

    const findings = state.fileResults.flatMap((r) => r.findings);
    const notes = [
      "<diff_summary>",
      state.diffSummary?.summary ?? "(not available)",
      ...(state.diffSummary?.keyChanges ?? []).map((c) => `- ${c}`),
      "</diff_summary>",
      "<file_summaries>",
      ...state.fileResults.map((r) => `- ${r.path}: ${r.summary}`),
      ...state.fileErrors.map((e) => `- ${e.path}: NOT REVIEWED (${e.error})`),
      "</file_summaries>",
      "<findings>",
      ...findings.map(
        (f) =>
          `[${f.id}] ${f.severity}/${f.category}/${f.confidence} ${f.path}:${f.line} ${f.title}\n${f.body}`,
      ),
      "</findings>",
      "<test_coverage>",
      JSON.stringify(state.coverage),
      "</test_coverage>",
      "<risks>",
      ...state.risks.map(
        (r) => `- ${r.level} ${r.kind} (${r.source}): ${r.paths.join(", ")}: ${r.rationale}`,
      ),
      "</risks>",
    ].join("\n");

    const result = await llm.structured({
      task: "synthesize",
      system: SYSTEM.synthesize,
      context: reviewContext(change, plan),
      prompt: `Write the review from these notes.\n\n${notes}`,
      schema: SynthesisSchema,
      onProgress: (progress) => {
        emit(config, { type: "llm", task: "synthesize", path: null, progress });
      },
    });
    return { draft: result.output, usage: result.usage, model: result.model };
  };
}
