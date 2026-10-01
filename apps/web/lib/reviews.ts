import type { ReviewDecision, RunStatus } from "@pr-review/agent";
import { z } from "zod";
import { agentModule } from "./agent-module";
import { getAgent } from "./agents";
import { ConflictError } from "./http";
import { getRegistry } from "./run-registry";
import { parseWebThreadId, webThreadId } from "./thread-id";

export const StartReviewSchema = z.object({
  repo: z.string().min(1),
  base: z.string().min(1).max(256),
  head: z.string().min(1).max(256).default("HEAD"),
  pullRequest: z
    .object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      number: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});

/**
 * Starts a review, or picks up an existing one for the same head commit:
 * resumes it if a previous server process died mid-run, otherwise leaves it.
 */
export async function startReview(input: z.infer<typeof StartReviewSchema>) {
  const { getStatus, threadIdFor } = await agentModule();
  const agent = await getAgent(input.repo);
  const { head } = await agent.tools.listChangedFiles({ base: input.base, head: input.head });
  const agentThreadId = threadIdFor(input.pullRequest ?? { base: input.base }, head);
  const threadId = webThreadId(input.repo, agentThreadId);

  const registry = getRegistry();
  const status = await getStatus(agent.graph, agentThreadId);
  if (!registry.isLive(threadId)) {
    if (status.state === "not_started") {
      registry.start(threadId, agent.graph, agentThreadId, {
        start: { base: input.base, head: input.head, pullRequest: input.pullRequest },
      });
    } else if (status.state === "running") {
      registry.start(threadId, agent.graph, agentThreadId, { resume: true });
    }
  }
  return { threadId };
}

/** Looks up a web thread id: its agent, agent thread id and current status. */
export async function loadThread(threadId: string) {
  const parsed = parseWebThreadId(threadId);
  if (parsed === null)
    throw new z.ZodError([
      { code: "custom", path: ["id"], message: "Malformed review id", input: threadId },
    ]);
  const { getStatus } = await agentModule();
  const agent = await getAgent(parsed.repo);
  const agentThreadId = threadId.slice(parsed.repo.length + 1);
  const status: RunStatus = await getStatus(agent.graph, agentThreadId);
  return { agent, agentThreadId, status };
}

export async function decideReview(threadId: string, decision: ReviewDecision) {
  const { agent, agentThreadId, status } = await loadThread(threadId);
  const registry = getRegistry();
  if (registry.isLive(threadId) || status.state !== "awaiting_approval") {
    throw new ConflictError("This review is not waiting for a decision.");
  }
  registry.start(threadId, agent.graph, agentThreadId, { decide: decision });
}

export async function resumeReview(threadId: string) {
  const { agent, agentThreadId, status } = await loadThread(threadId);
  const registry = getRegistry();
  if (registry.isLive(threadId) || status.state !== "running") {
    throw new ConflictError("This review has nothing to resume.");
  }
  registry.start(threadId, agent.graph, agentThreadId, { resume: true });
}
