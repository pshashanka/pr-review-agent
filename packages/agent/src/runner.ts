import { Command } from "@langchain/langgraph";
import type { ReviewEvent } from "./graph/deps.js";
import type { ReviewGraph } from "./graph/graph.js";
import type { ApprovalRequest } from "./graph/nodes/human-approval.js";
import type { Published, ReviewDecision, ReviewInput, State } from "./graph/state.js";
import type { Review } from "./review/schema.js";

/** Everything a UI needs to show a run as it happens. */
export type RunEvent =
  | { type: "node_finished"; node: string }
  | { type: "progress"; event: ReviewEvent }
  | { type: "awaiting_approval"; request: ApprovalRequest }
  | { type: "finished"; status: RunStatus };

export type RunStatus =
  | { state: "not_started" }
  | { state: "running"; next: string[] }
  | { state: "awaiting_approval"; request: ApprovalRequest }
  | { state: "published"; review: Review; published: Published }
  | { state: "rejected"; review: Review; reason: string };

const config = (threadId: string) => ({ configurable: { thread_id: threadId } });

/**
 * Starts a review, or continues one: after a crash (no input needed) or with
 * the human's decision. Yields progress until the run pauses or finishes.
 */
export async function* runReview(
  graph: ReviewGraph,
  threadId: string,
  step: { start: ReviewInput } | { decide: ReviewDecision } | { resume: true },
  signal?: AbortSignal,
): AsyncGenerator<RunEvent, RunStatus> {
  const options = {
    ...config(threadId),
    streamMode: ["updates", "custom"] as ("updates" | "custom")[],
    ...(signal === undefined ? {} : { signal }),
  };
  const stream =
    "start" in step
      ? await graph.stream({ input: step.start }, options)
      : "decide" in step
        ? await graph.stream(new Command({ resume: step.decide }), options)
        : await graph.stream(null, options);
  for await (const [mode, chunk] of stream) {
    if (mode === "custom") {
      yield { type: "progress", event: chunk as ReviewEvent };
      continue;
    }
    for (const node of Object.keys(chunk)) {
      if (node !== "__interrupt__") yield { type: "node_finished", node };
    }
  }

  const status = await getStatus(graph, threadId);
  if (status.state === "awaiting_approval")
    yield { type: "awaiting_approval", request: status.request };
  yield { type: "finished", status };
  return status;
}

/** Reads a thread's state from the checkpoint; works from any process. */
export async function getStatus(graph: ReviewGraph, threadId: string): Promise<RunStatus> {
  const snapshot = await graph.getState(config(threadId));
  if (snapshot.createdAt === undefined) return { state: "not_started" };

  const request = snapshot.tasks.flatMap((t) => t.interrupts)[0]?.value as
    ApprovalRequest | undefined;
  if (request !== undefined) return { state: "awaiting_approval", request };

  const values = snapshot.values as State;
  if (snapshot.next.length > 0 || values.review === null) {
    return { state: "running", next: [...snapshot.next] };
  }
  if (values.decision?.action === "reject") {
    return { state: "rejected", review: values.review, reason: values.decision.reason };
  }
  if (values.published !== null) {
    return { state: "published", review: values.review, published: values.published };
  }
  return { state: "running", next: [] };
}
