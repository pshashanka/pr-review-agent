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

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Reads an SSE response to the end and returns its data payloads in order. */
async function readEvents(response: Response): Promise<WebEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.split("\n").some((line) => line.startsWith("data: ")))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse((dataLine as string).slice(6)) as WebEvent;
    });
}

/** Reads an SSE response and returns each frame's id (null for snapshots) and payload. */
async function readFrames(response: Response): Promise<{ id: number | null; event: WebEvent }[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.split("\n").some((line) => line.startsWith("data: ")))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const idLine = lines.find((line) => line.startsWith("id: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      return {
        id: idLine === undefined ? null : Number(idLine.slice(4)),
        event: JSON.parse((dataLine as string).slice(6)) as WebEvent,
      };
    });
}

describe("review API", () => {
  let threadId: string;

  it("starts a review and streams it to the approval pause", async () => {
    const started = await routes.start.POST(post({ repo: "calc", base: "main" }));
    expect(started.status).toBe(202);
    threadId = ((await started.json()) as { threadId: string }).threadId;
    expect(threadId).toBe(`calc|base:main@${repo.headSha}`);

    const response = await routes.events.GET(new Request("http://localhost"), ctx(threadId));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = await readFrames(response);
    const events = frames.map((f) => f.event);

    expect(events[0]).toMatchObject({ type: "snapshot", live: true });
    // The snapshot has no id; every buffered event carries a monotonic id so a
    // reconnecting EventSource can resume from Last-Event-ID without replays.
    expect(frames[0]?.id).toBeNull();
    const ids = frames.slice(1).map((f) => f.id);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
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

  it("tells the browser to retry a dropped connection after about a second", async () => {
    const response = await routes.events.GET(new Request("http://localhost"), ctx(threadId));

    expect(await response.text()).toContain("retry: 1000");
  });

  it("returns the same thread, without a new run, when started again", async () => {
    const again = await routes.start.POST(post({ repo: "calc", base: "main" }));

    expect(((await again.json()) as { threadId: string }).threadId).toBe(threadId);
    const status = await routes.status.GET(new Request("http://localhost"), ctx(threadId));
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
      await routes.events.GET(new Request("http://localhost"), ctx(threadId)),
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
    const response = await routes.status.GET(new Request("http://localhost"), ctx("nonsense"));

    expect(response.status).toBe(400);
  });
});

describe("request guards", () => {
  let threadId: string;

  beforeAll(async () => {
    // A distinct pull request ref gives this a fresh thread id, separate from
    // the one the "review API" tests above already published.
    const started = await routes.start.POST(
      post({
        repo: "calc",
        base: "main",
        pullRequest: { owner: "acme", repo: "guard-check", number: 1 },
      }),
    );
    threadId = ((await started.json()) as { threadId: string }).threadId;
    // Drain the SSE stream so the run reaches its approval pause before the
    // tests below touch this thread.
    await readEvents(await routes.events.GET(new Request("http://localhost"), ctx(threadId)));
  });

  it("refuses a start with a non-JSON content type", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ repo: "calc", base: "main" }),
      headers: { "content-type": "text/plain" },
    });

    const response = await routes.start.POST(request);

    expect(response.status).toBe(415);
    const status = await routes.status.GET(new Request("http://localhost"), ctx(threadId));
    expect(await status.json()).toMatchObject({ status: { state: "awaiting_approval" } });
  });

  it("refuses a decision from a cross-origin Origin header", async () => {
    const response = await routes.decision.POST(
      post({ action: "approve" }, { origin: "https://evil.example" }),
      ctx(threadId),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a decision with the literal Origin: null", async () => {
    const response = await routes.decision.POST(
      post({ action: "approve" }, { origin: "null" }),
      ctx(threadId),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a decision with a malformed Origin header", async () => {
    const response = await routes.decision.POST(
      post({ action: "approve" }, { origin: "not a url" }),
      ctx(threadId),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a request with Sec-Fetch-Site: cross-site", async () => {
    const response = await routes.decision.POST(
      post({ action: "approve" }, { "sec-fetch-site": "cross-site" }),
      ctx(threadId),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a GET with an unrecognised Host header", async () => {
    const response = await routes.status.GET(
      new Request("http://localhost", { headers: { host: "evil.example" } }),
      ctx(threadId),
    );

    expect(response.status).toBe(403);
  });

  it("rejects a start with an invalid pull request ref", async () => {
    const response = await routes.start.POST(
      post({ repo: "calc", base: "main", pullRequest: { owner: "..", repo: "..", number: 1 } }),
    );

    expect(response.status).toBe(400);
  });

  it("accepts a configured extra host", async () => {
    const previous = process.env["PR_REVIEW_ALLOWED_HOSTS"];
    process.env["PR_REVIEW_ALLOWED_HOSTS"] = "review.lan";
    try {
      const response = await routes.status.GET(
        new Request("http://localhost", { headers: { host: "review.lan:3000" } }),
        ctx(threadId),
      );

      expect(response.status).not.toBe(403);
    } finally {
      if (previous === undefined) delete process.env["PR_REVIEW_ALLOWED_HOSTS"];
      else process.env["PR_REVIEW_ALLOWED_HOSTS"] = previous;
    }
  });
});
