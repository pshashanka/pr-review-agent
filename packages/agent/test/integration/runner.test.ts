import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent, threadIdFor, type Agent } from "../../src/agent.js";
import { FilePublisher } from "../../src/publish/file.js";
import { getStatus, runReview, type RunEvent } from "../../src/runner.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";
import { ScriptedLlm } from "../fakes.js";

let repo: FixtureRepo;
let out: string;
let agent: Agent;

const llm = new ScriptedLlm({
  summarizeDiff: () => ({ summary: "s", keyChanges: [] }),
  analyzeFile: () => ({ summary: "ok", findings: [] }),
  checkCoverage: () => ({ status: "partial", untestedPaths: [], notes: "n" }),
  flagRisks: () => ({ risks: [] }),
  synthesize: () => ({ summary: "Looks fine.", verdict: "approve", findingIds: [] }),
});

beforeAll(async () => {
  repo = await createFixtureRepo();
  out = await mkdtemp(join(tmpdir(), "runner-"));
  agent = await createAgent({
    repoTools: { kind: "stdio", repo: repo.root },
    checkpointDb: join(out, "checkpoints.sqlite"),
    publisher: new FilePublisher(out),
    llm,
  });
});

afterAll(async () => {
  await agent.close();
  await rm(out, { recursive: true, force: true });
  await repo.cleanup();
});

async function collect(run: AsyncGenerator<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("runReview / getStatus", () => {
  const threadId = () => threadIdFor({ base: "main" }, repo.headSha);

  it("starts, pauses for approval, then publishes after the decision", async () => {
    expect(await getStatus(agent.graph, threadId())).toEqual({ state: "not_started" });

    const first = await collect(
      runReview(agent.graph, threadId(), {
        start: { base: "main", head: "HEAD", pullRequest: null },
      }),
    );
    expect(first.filter((e) => e.type === "node_finished").map((e) => e.node)).toContain(
      "synthesize",
    );
    expect(first.at(-2)?.type).toBe("awaiting_approval");
    expect((await getStatus(agent.graph, threadId())).state).toBe("awaiting_approval");

    const second = await collect(
      runReview(agent.graph, threadId(), { decide: { action: "approve" } }),
    );
    const finished = second.at(-1);
    expect(finished).toMatchObject({ type: "finished", status: { state: "published" } });

    const status = await getStatus(agent.graph, threadId());
    expect(status).toMatchObject({
      state: "published",
      published: { kind: "file", alreadyPosted: false },
      review: { verdict: "approve", summary: "Looks fine." },
    });
  });

  it("keeps state in the SQLite file, readable by a fresh agent", async () => {
    const other = await createAgent({
      repoTools: { kind: "stdio", repo: repo.root },
      checkpointDb: join(out, "checkpoints.sqlite"),
      publisher: new FilePublisher(out),
      llm,
    });
    try {
      expect((await getStatus(other.graph, threadId())).state).toBe("published");
    } finally {
      await other.close();
    }
  });
});

describe("threadIdFor", () => {
  it("scopes threads by pull request or base, and by head commit", () => {
    expect(threadIdFor({ owner: "acme", repo: "calc", number: 7 }, "abc")).toBe("acme/calc#7@abc");
    expect(threadIdFor({ base: "main" }, "abc")).toBe("base:main@abc");
  });
});
