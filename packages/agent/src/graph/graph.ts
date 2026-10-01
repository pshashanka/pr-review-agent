import {
  END,
  START,
  Send,
  StateGraph,
  type BaseCheckpointSaver,
  type RetryPolicy,
} from "@langchain/langgraph";
import type { ReviewDeps } from "./deps.js";
import { analyzeFile, type FileTask } from "./nodes/analyze-file.js";
import { checkCoverage } from "./nodes/check-coverage.js";
import { isTransient } from "./nodes/errors.js";
import { flagRisks } from "./nodes/flag-risks.js";
import { humanApproval } from "./nodes/human-approval.js";
import { loadChange } from "./nodes/load-change.js";
import { planReview } from "./nodes/plan-review.js";
import { postReview } from "./nodes/post-review.js";
import { requireValue } from "./nodes/require.js";
import { summarizeDiff } from "./nodes/summarize-diff.js";
import { synthesize } from "./nodes/synthesize.js";
import { validateReview } from "./nodes/validate-review.js";
import { ReviewState, type State } from "./state.js";

/** Retries transient failures (MCP transport, API overload) a few times with backoff. */
export const TRANSIENT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 500,
  backoffFactor: 2,
  retryOn: isTransient,
};

/**
 * loadChange → planReview → { summarizeDiff, analyzeFile × N, checkCoverage, flagRisks }
 *   → synthesize → validateReview → humanApproval → postReview | END
 *
 * The four middle branches run in parallel in one superstep; synthesize runs
 * once all of them have finished.
 */
export function buildReviewGraph(deps: ReviewDeps) {
  return new StateGraph(ReviewState)
    .addNode("loadChange", loadChange(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("planReview", planReview(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("summarizeDiff", summarizeDiff(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("analyzeFile", analyzeFile(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("checkCoverage", checkCoverage(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("flagRisks", flagRisks(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("synthesize", synthesize(deps), { retryPolicy: TRANSIENT_RETRY })
    .addNode("validateReview", validateReview(deps))
    .addNode("humanApproval", humanApproval())
    .addNode("postReview", postReview(deps), { retryPolicy: TRANSIENT_RETRY })
    .addEdge(START, "loadChange")
    .addEdge("loadChange", "planReview")
    .addConditionalEdges("planReview", fanOut, [
      "analyzeFile",
      "summarizeDiff",
      "checkCoverage",
      "flagRisks",
    ])
    .addEdge(["analyzeFile", "summarizeDiff", "checkCoverage", "flagRisks"], "synthesize")
    .addEdge("synthesize", "validateReview")
    .addEdge("validateReview", "humanApproval")
    .addConditionalEdges("humanApproval", (state: State) =>
      state.decision?.action === "reject" ? END : "postReview",
    )
    .addEdge("postReview", END);
}

/** One `Send` per file to analyze, plus the three whole-change branches. */
function fanOut(state: State): (Send | string)[] {
  const change = requireValue(state.change, "change");
  const plan = requireValue(state.plan, "plan");
  const files = plan.files.map(
    (file, index) =>
      new Send("analyzeFile", { path: file.path, index, change, plan } satisfies FileTask),
  );
  return [...files, "summarizeDiff", "checkCoverage", "flagRisks"];
}

export function compileReviewGraph(deps: ReviewDeps, checkpointer: BaseCheckpointSaver) {
  return buildReviewGraph(deps).compile({ checkpointer });
}

export type ReviewGraph = ReturnType<typeof compileReviewGraph>;
