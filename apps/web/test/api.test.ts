import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../../packages/agent/test/fixtures/fixture-repo";
import type { WebEvent } from "@/lib/run-registry";

// Route handlers, called directly with standard Request objects. The agent is
// real (MCP server on a fixture repo); the model is the offline demo model.

let repo: FixtureRepo;
let dataDir: string;
let routes: {
  start: typeof import("@/app/api/reviews/route");
  status: typeof import("@/app/api/reviews/[id]/route");
  events: typeof import("@/app/api/reviews/[id]/events/route");
  decision: typeof import("@/app/api/reviews/[id]/decision/route");
};

beforeAll(async () => {
  repo = await createFixtureRepo();
  dataDir = await mkdtemp(join(tmpdir(), "pr-review-web-"));
  process.env["PR_REVIEW_REPOS"] = `calc=${repo.root}`;
  process.env["PR_REVIEW_DATA"] = dataDir;
  process.env["PR_REVIEW_DEMO"] = "1";
  routes = {
    start: await import("@/app/api/reviews/route"),
    status: await import("@/app/api/reviews/[id]/route"),
    events: await import("@/app/api/reviews/[id]/events/route"),
    decision: await import("@/app/api/reviews/[id]/decision/route"),
  };
});

afterAll(async () => {
  const { getAgent } = await import("@/lib/agents");
  await (await getAgent("calc")).close();
  await rm(dataDir, { recursive: true, force: true });
  await repo.cleanup();
});

const post = (body: unknown) =>
  new Request("http://test/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Reads an SSE response to the end and returns its events. */
async function readEvents(response: Response): Promise<WebEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as WebEvent);
}

describe("review API", () => {
  let threadId: string;

  it("starts a review and streams it to the approval pause", async () => {
    const started = await routes.start.POST(post({ repo: "calc", base: "main" }));
    expect(started.status).toBe(202);
    threadId = ((await started.json()) as { threadId: string }).threadId;
    expect(threadId).toBe(`calc|base:main@${repo.headSha}`);

    const response = await routes.events.GET(new Request("http://test"), ctx(threadId));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await readEvents(response);

    expect(events[0]).toMatchObject({ type: "snapshot", live: true });
    expect(events.filter((e) => e.type === "node_finished").map((e) => e.node)).toEqual(
      expect.arrayContaining([
        "loadChange",
        "planReview",
        "analyzeFile",
        "synthesize",
        "validateReview",
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: "finished",
      status: { state: "awaiting_approval" },
    });
  });

  it("returns the same thread, without a new run, when started again", async () => {
    const again = await routes.start.POST(post({ repo: "calc", base: "main" }));

    expect(((await again.json()) as { threadId: string }).threadId).toBe(threadId);
    const status = await routes.status.GET(new Request("http://test"), ctx(threadId));
    expect(await status.json()).toMatchObject({
      status: { state: "awaiting_approval" },
      live: false,
    });
  });

  it("validates decisions", async () => {
    const bad = await routes.decision.POST(post({ action: "ship-it" }), ctx(threadId));

    expect(bad.status).toBe(400);
  });

  it("publishes on approval and refuses a second decision", async () => {
    const approved = await routes.decision.POST(post({ action: "approve" }), ctx(threadId));
    expect(approved.status).toBe(202);

    const events = await readEvents(
      await routes.events.GET(new Request("http://test"), ctx(threadId)),
    );
    expect(events.at(-1)).toMatchObject({ type: "finished", status: { state: "published" } });
    expect(await readdir(join(dataDir, "calc"))).toEqual([
      `review-${repo.headSha.slice(0, 12)}.json`,
      `review-${repo.headSha.slice(0, 12)}.md`,
    ]);

    const again = await routes.decision.POST(post({ action: "approve" }), ctx(threadId));
    expect(again.status).toBe(409);
  });

  it("only reviews configured repositories", async () => {
    const response = await routes.start.POST(post({ repo: "../../etc", base: "main" }));

    expect(response.status).toBe(404);
  });

  it("rejects malformed thread ids", async () => {
    const response = await routes.status.GET(new Request("http://test"), ctx("nonsense"));

    expect(response.status).toBe(400);
  });
});
