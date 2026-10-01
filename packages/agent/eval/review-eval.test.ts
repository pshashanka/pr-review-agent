import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.js";
import { AnthropicLlm } from "../src/llm/anthropic.js";
import { getStatus, runReview } from "../src/runner.js";
import type { Review } from "../src/review/schema.js";
import { createRepoFromFiles } from "../test/fixtures/fixture-repo.js";
import { MemoryPublisher } from "../test/fakes.js";
import { CASES } from "./cases.js";
import { scoreCase, summarize, type CaseScore } from "./score.js";

/**
 * Live eval: runs the real agent with Claude on each case and scores the
 * review. Costs real money, so it only runs when ANTHROPIC_API_KEY is set
 * (`pnpm eval`), and never in CI.
 */
const live =
  process.env["ANTHROPIC_API_KEY"] !== undefined && process.env["ANTHROPIC_API_KEY"] !== "";

describe.runIf(live)("review quality (live)", () => {
  it("catches planted bugs without crying wolf", { timeout: 15 * 60_000 }, async () => {
    const scores: CaseScore[] = [];
    const runs: { case: string; seconds: number; review: Review }[] = [];

    for (const evalCase of CASES) {
      const repo = await createRepoFromFiles(evalCase.base, evalCase.head);
      const agent = await createAgent({
        repoTools: { kind: "stdio", repo: repo.root },
        checkpointDb: ":memory:",
        publisher: new MemoryPublisher(),
        llm: new AnthropicLlm(
          process.env["EVAL_MODEL"] ? { model: process.env["EVAL_MODEL"] } : {},
        ),
      });
      try {
        const started = performance.now();
        const threadId = `eval:${evalCase.name}`;
        for await (const event of runReview(agent.graph, threadId, {
          start: { base: "main", head: "HEAD", pullRequest: null },
        })) {
          if (event.type === "progress" && event.event.type === "file_failed") {
            console.warn(`[${evalCase.name}] ${event.event.path}: ${event.event.error}`);
          }
        }
        const status = await getStatus(agent.graph, threadId);
        if (status.state !== "awaiting_approval")
          throw new Error(`${evalCase.name}: ended in ${status.state}`);
        const review = status.request.review;
        scores.push(scoreCase(evalCase, review));
        runs.push({
          case: evalCase.name,
          seconds: Math.round((performance.now() - started) / 1000),
          review,
        });
      } finally {
        await agent.close();
        await repo.cleanup();
      }
    }

    const summary = summarize(scores, CASES);
    const usage = runs.reduce(
      (total, r) => ({
        input: total.input + r.review.meta.usage.inputTokens,
        output: total.output + r.review.meta.usage.outputTokens,
        cacheRead: total.cacheRead + r.review.meta.usage.cacheReadTokens,
      }),
      { input: 0, output: 0, cacheRead: 0 },
    );
    const report = {
      at: new Date().toISOString(),
      model: runs[0]?.review.meta.model,
      summary,
      usage,
      scores,
      runs,
    };

    const dir = join(import.meta.dirname, "results");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.table(
      scores.map((s) => ({ ...s, caught: s.caught.join(","), missed: s.missed.join(",") })),
    );
    console.log({ summary, usage });

    // Thresholds are opt-in so the eval reports rather than gates by default.
    const minRecall = Number(process.env["EVAL_MIN_RECALL"] ?? "0");
    expect(summary.recall).toBeGreaterThanOrEqual(minRecall);
  });
});
