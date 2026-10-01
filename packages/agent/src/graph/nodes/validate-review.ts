import type { Finding, Review, Verdict } from "../../review/schema.js";
import type { ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { requireValue } from "./require.js";

/**
 * Builds the final review from the synthesis draft. Deterministic checks:
 * only real finding ids survive, and the verdict can't be "approve" while a
 * blocker or major finding remains.
 */
export function validateReview({ llm }: ReviewDeps) {
  return (state: State): Update => {
    const change = requireValue(state.change, "change");
    const plan = requireValue(state.plan, "plan");
    const draft = requireValue(state.draft, "draft");
    const coverage = requireValue(state.coverage, "coverage");

    const byId = new Map(state.fileResults.flatMap((r) => r.findings).map((f) => [f.id, f]));
    const findings = [...new Set(draft.findingIds)].flatMap((id) => {
      const finding = byId.get(id);
      return finding === undefined ? [] : [finding];
    });

    const review: Review = {
      summary: draft.summary,
      verdict: guardVerdict(draft.verdict, findings),
      findings,
      risks: state.risks,
      coverage,
      meta: {
        base: change.base,
        head: change.head,
        mergeBase: change.mergeBase,
        model: state.model ?? llm.model,
        filesReviewed: state.fileResults.map((r) => r.path).sort(),
        filesSkipped: plan.skipped,
        fileErrors: state.fileErrors,
        stepErrors: state.stepErrors,
        usage: state.usage,
      },
    };
    return { review };
  };
}

/** A review with a blocker or major finding can't approve; downgrade to a comment. */
export function guardVerdict(verdict: Verdict, findings: readonly Finding[]): Verdict {
  const serious = findings.some((f) => f.severity === "blocker" || f.severity === "major");
  return verdict === "approve" && serious ? "comment" : verdict;
}
