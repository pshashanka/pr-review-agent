import { interrupt } from "@langchain/langgraph";
import { renderReviewBody } from "../../review/render-markdown.js";
import type { Review } from "../../review/schema.js";
import { ReviewDecisionSchema, type ReviewDecision, type State, type Update } from "../state.js";
import { guardVerdict } from "./validate-review.js";
import { requireValue } from "./require.js";

/** What the approval step shows the human. */
export interface ApprovalRequest {
  review: Review;
  markdown: string;
}

/**
 * Pauses the run until a human approves, edits or rejects the review. The
 * pause is checkpointed, so the answer can come much later from another
 * process (CLI or web UI).
 */
export function humanApproval() {
  return (state: State): Update => {
    const review = requireValue(state.review, "review");
    const request: ApprovalRequest = { review, markdown: renderReviewBody(review) };
    const decision = ReviewDecisionSchema.parse(interrupt(request));
    return decision.action === "edit"
      ? { decision, review: applyEdit(review, decision) }
      : { decision };
  };
}

/** Applies a human edit. Findings can be reworded or dropped, never added or moved. */
export function applyEdit(
  review: Review,
  edit: Extract<ReviewDecision, { action: "edit" }>,
): Review {
  const original = new Map(review.findings.map((f) => [f.id, f]));
  const findings = edit.findings.flatMap((change) => {
    const finding = original.get(change.id);
    return finding === undefined
      ? []
      : [{ ...finding, title: change.title, body: change.body, suggestion: change.suggestion }];
  });
  return {
    ...review,
    summary: edit.summary,
    verdict: guardVerdict(edit.verdict, findings),
    findings,
  };
}
