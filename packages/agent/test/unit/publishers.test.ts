import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilePublisher } from "../../src/publish/file.js";
import { GitHubPublisher, parsePullRequestRef } from "../../src/publish/github.js";
import { reviewMarker } from "../../src/review/render-markdown.js";
import { ZERO_USAGE, type Finding, type Review } from "../../src/review/schema.js";

const HEAD = "b".repeat(40);

const finding = (overrides: Partial<Finding>): Finding => ({
  id: "1.1",
  path: "src/math.js",
  line: 4,
  endLine: null,
  severity: "major",
  category: "bug",
  confidence: "high",
  title: "Zero check",
  body: "Divides by zero.",
  suggestion: null,
  inline: true,
  ...overrides,
});

const review: Review = {
  summary: "Summary.",
  verdict: "request_changes",
  findings: [
    finding({}),
    finding({ id: "1.2", line: 2, endLine: 3 }),
    finding({ id: "1.3", inline: false }),
  ],
  risks: [],
  coverage: { status: "adequate", untestedPaths: [], notes: "Fine." },
  meta: {
    base: "a".repeat(40),
    head: HEAD,
    mergeBase: "a".repeat(40),
    model: "claude-opus-5",
    filesReviewed: ["src/math.js"],
    filesSkipped: [],
    fileErrors: [],
    usage: ZERO_USAGE,
  },
};

const pr = { base: "main", head: "HEAD", pullRequest: { owner: "acme", repo: "calc", number: 7 } };

describe("FilePublisher", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "publisher-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes Markdown and JSON once per head commit", async () => {
    const publisher = new FilePublisher(dir);

    const first = await publisher.publish(review);
    const second = await publisher.publish({ ...review, summary: "Changed." });

    expect(first).toEqual({
      kind: "file",
      location: join(dir, `review-${HEAD.slice(0, 12)}.md`),
      alreadyPosted: false,
    });
    expect(second.alreadyPosted).toBe(true);
    const markdown = await readFile(first.location, "utf8");
    expect(markdown).toContain("Summary.");
    expect(markdown).not.toContain("Changed.");
    expect(markdown).toContain("### `src/math.js:4`");
    const json = JSON.parse(
      await readFile(first.location.replace(/\.md$/, ".json"), "utf8"),
    ) as Review;
    expect(json.findings).toHaveLength(3);
  });
});

/** A fake GitHub API that records requests. */
function fakeGitHub(existingReviews: { body: string; html_url: string }[] = []) {
  const requests: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  // The publisher always passes a string URL.
  const fetchFn: typeof fetch = (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({
      method,
      url: url as string,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
      auth: headers.get("authorization"),
    });
    const payload =
      method === "GET"
        ? existingReviews
        : { html_url: "https://github.com/acme/calc/pull/7#review-1" };
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: method === "GET" ? 200 : 201 }),
    );
  };
  return { fetch: fetchFn, requests };
}

describe("GitHubPublisher", () => {
  it("posts a COMMENT review pinned to the reviewed commit with inline comments", async () => {
    const github = fakeGitHub();
    const publisher = new GitHubPublisher({ token: "t0k", fetch: github.fetch });

    const result = await publisher.publish(review, pr);

    expect(result).toEqual({
      kind: "github",
      location: "https://github.com/acme/calc/pull/7#review-1",
      alreadyPosted: false,
    });
    const post = github.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("https://api.github.com/repos/acme/calc/pulls/7/reviews");
    expect(post?.auth).toBe("Bearer t0k");
    expect(post?.body).toMatchObject({
      commit_id: HEAD,
      event: "COMMENT",
      comments: [
        { path: "src/math.js", side: "RIGHT", line: 4 },
        { path: "src/math.js", side: "RIGHT", line: 3, start_line: 2, start_side: "RIGHT" },
      ],
    });
    expect((post?.body as { body: string }).body).toContain(reviewMarker(HEAD));
  });

  it("submits the verdict only when asked to", async () => {
    const github = fakeGitHub();
    await new GitHubPublisher({ token: "t", fetch: github.fetch, submitVerdict: true }).publish(
      review,
      pr,
    );

    expect(github.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      event: "REQUEST_CHANGES",
    });
  });

  it("does not post again if a review for this head already exists", async () => {
    const github = fakeGitHub([
      { body: `old\n${reviewMarker(HEAD)}`, html_url: "https://github.com/x#r0" },
    ]);

    const result = await new GitHubPublisher({ token: "t", fetch: github.fetch }).publish(
      review,
      pr,
    );

    expect(result).toEqual({
      kind: "github",
      location: "https://github.com/x#r0",
      alreadyPosted: true,
    });
    expect(github.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("surfaces API errors", async () => {
    const failing = (() =>
      Promise.resolve(new Response("Bad credentials", { status: 401 }))) as typeof fetch;

    await expect(
      new GitHubPublisher({ token: "t", fetch: failing }).publish(review, pr),
    ).rejects.toThrow(/401 Bad credentials/);
  });

  it("needs a pull request", async () => {
    await expect(
      new GitHubPublisher({ token: "t", fetch: fakeGitHub().fetch }).publish(review, {
        ...pr,
        pullRequest: null,
      }),
    ).rejects.toThrow(/needs a pull request/);
  });

  it("encodes owner and repo in the request path, as defence in depth", async () => {
    const github = fakeGitHub();
    await new GitHubPublisher({ token: "t", fetch: github.fetch }).publish(review, {
      ...pr,
      pullRequest: { owner: "weird owner/x", repo: "weird repo?y", number: 7 },
    });

    const post = github.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(
      "https://api.github.com/repos/weird%20owner%2Fx/weird%20repo%3Fy/pulls/7/reviews",
    );
  });
});

describe("parsePullRequestRef", () => {
  it("parses owner/repo#number", () => {
    expect(parsePullRequestRef("acme/calc.js#42")).toEqual({
      owner: "acme",
      repo: "calc.js",
      number: 42,
    });
  });

  it("rejects anything else", () => {
    expect(() => parsePullRequestRef("acme/calc")).toThrow(/owner\/repo#123/);
  });
});
