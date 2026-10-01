import Anthropic from "@anthropic-ai/sdk";
import { Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  type RepoToolsApi,
  type ReviewDeps,
  type ReviewEvent,
} from "../../src/graph/deps.js";
import { compileReviewGraph } from "../../src/graph/graph.js";
import type { ApprovalRequest } from "../../src/graph/nodes/human-approval.js";
import type { ReviewInput } from "../../src/graph/state.js";
import { LlmRefusalError, type StructuredRequest } from "../../src/llm/llm.js";
import { RepoTools, RepoToolTransportError } from "../../src/mcp/repo-tools.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";
import { MemoryPublisher, ScriptedLlm } from "../fakes.js";

let repo: FixtureRepo;
let tools: RepoTools;

beforeAll(async () => {
  repo = await createFixtureRepo();
  tools = await RepoTools.connect({ kind: "stdio", repo: repo.root });
});

afterAll(async () => {
  await tools.close();
  await repo.cleanup();
});

const reviewInput: ReviewInput = { base: "main", head: "HEAD", pullRequest: null };
const start = { input: reviewInput };

/** Scripted answers shaped like a real review of the fixture PR. */
function reviewScript(overrides: Partial<ConstructorParameters<typeof ScriptedLlm>[0]> = {}) {
  return new ScriptedLlm({
    summarizeDiff: () => ({
      summary: "Adds divide and shout.",
      keyChanges: ["divide()", "shout()"],
    }),
    analyzeFile: async (request: StructuredRequest<unknown>) => {
      if (request.prompt.includes("`src/math.js`")) {
        // Exercise the real tool path: read the old version through MCP.
        const readFile = request.tools?.find((t) => t.definition.name === "read_file");
        const old = await readFile?.run({ path: "src/math.js", ref: "main" });
        if (old?.isError !== false) throw new Error("read_file failed");
        return {
          summary: "Adds divide().",
          findings: [
            {
              line: 4,
              endLine: null,
              severity: "major",
              category: "bug",
              confidence: "high",
              title: "divide() returns Infinity for b = 0",
              body: "No zero check.",
              suggestion:
                "  if (b === 0) throw new RangeError('b must not be 0');\n  return a / b;",
            },
            {
              line: 40,
              endLine: null,
              severity: "minor",
              category: "docs",
              confidence: "low",
              title: "Document divide()",
              body: "Not on a diff line.",
              suggestion: null,
            },
          ],
        };
      }
      return { summary: "Fine.", findings: [] };
    },
    checkCoverage: () => ({
      status: "missing",
      untestedPaths: ["src/math.js", "src/strings.js"],
      notes: "Neither divide nor shout has a test.",
    }),
    flagRisks: () => ({
      risks: [
        { kind: "public_api", level: "low", paths: ["src/math.js"], rationale: "New export." },
      ],
    }),
    // Include every real id (once more as a duplicate) plus one invented id.
    synthesize: (request: StructuredRequest<unknown>) => {
      const ids = [...request.prompt.matchAll(/^\[([\d.]+)\]/gm)].map((m) => m[1] ?? "");
      return {
        summary: "Solid start; divide needs a zero check and tests.",
        verdict: "approve",
        findingIds: ["9.9", ...ids, ...ids.slice(0, 1)],
      };
    },
    ...overrides,
  });
}

function setup(
  llm: ScriptedLlm,
  toolsApi: RepoToolsApi = tools,
  options: ReviewDeps["options"] = DEFAULT_OPTIONS,
) {
  const publisher = new MemoryPublisher();
  const deps: ReviewDeps = { tools: toolsApi, llm, publisher, options };
  const checkpointer = SqliteSaver.fromConnString(":memory:");
  const graph = compileReviewGraph(deps, checkpointer);
  let thread = 0;
  const config = () => ({ configurable: { thread_id: `t${++thread}` } });
  return { graph, publisher, config };
}

async function runToApproval(
  graph: ReturnType<typeof setup>["graph"],
  config: { configurable: { thread_id: string } },
) {
  const events: ReviewEvent[] = [];
  const nodes: string[] = [];
  for await (const [mode, chunk] of await graph.stream(start, {
    ...config,
    streamMode: ["updates", "custom"],
  })) {
    if (mode === "custom") events.push(chunk as ReviewEvent);
    else nodes.push(...Object.keys(chunk));
  }
  const state = await graph.getState(config);
  const request = state.tasks.flatMap((t) => t.interrupts)[0]?.value as ApprovalRequest | undefined;
  return { events, nodes, state, request };
}

describe("review graph", () => {
  it("reviews the change and pauses for approval", async () => {
    const llm = reviewScript();
    const { graph, config } = setup(llm);
    const cfg = config();

    const { events, nodes, state, request } = await runToApproval(graph, cfg);

    expect(state.next).toEqual(["humanApproval"]);
    expect(nodes).toContain("synthesize");
    expect(request).toBeDefined();
    const review = request?.review;

    // Plan: lockfile and binary skipped; the rest reviewed, one model call each.
    expect(review?.meta.filesReviewed).toEqual([
      ".github/workflows/ci.yml",
      "package.json",
      "src/math.js",
      "src/strings.js",
    ]);
    expect(review?.meta.filesSkipped).toEqual([
      { path: "assets/logo.png", reason: "binary" },
      { path: "pnpm-lock.yaml", reason: "lockfile" },
    ]);
    expect(llm.callsFor("analyzeFile")).toHaveLength(4);
    // Deferred node: must fire exactly once, not once per fanned-in branch.
    expect(llm.callsFor("synthesize")).toHaveLength(1);

    // Findings: unknown and duplicate ids dropped; diff-line finding inline, other not.
    expect(review?.findings.map((f) => [f.path, f.line, f.inline])).toEqual([
      ["src/math.js", 4, true],
      ["src/math.js", 40, false],
    ]);
    // A major finding means the model's "approve" is downgraded.
    expect(review?.verdict).toBe("comment");

    // Risks: rule-based plus the model's.
    expect(review?.risks.map((r) => `${r.source}:${r.kind}`)).toEqual([
      "rule:dependencies",
      "rule:ci_config",
      "model:public_api",
    ]);
    expect(review?.coverage.status).toBe("missing");
    expect(review?.meta.head).toBe(repo.headSha);
    expect(review?.meta.usage.inputTokens).toBe(800); // 8 scripted calls × 100

    expect(request?.markdown).toContain("## Review: Comment");
    expect(events).toContainEqual({ type: "file_done", path: "src/math.js", findings: 2 });
  });

  it("still reviews when no file needs a model call", async () => {
    const llm = reviewScript();
    const { graph, config } = setup(llm, tools, { ...DEFAULT_OPTIONS, maxFiles: 0 });
    const cfg = config();

    const { state, request } = await runToApproval(graph, cfg);

    expect(state.next).toEqual(["humanApproval"]);
    expect(request).toBeDefined();
    const review = request?.review;

    expect(review?.meta.filesReviewed).toEqual([]);
    expect(review?.meta.filesSkipped.map((s) => s.path).sort()).toEqual(
      [
        ".github/workflows/ci.yml",
        "assets/logo.png",
        "package.json",
        "pnpm-lock.yaml",
        "src/math.js",
        "src/strings.js",
      ].sort(),
    );

    expect(llm.callsFor("analyzeFile")).toHaveLength(0);
    expect(llm.callsFor("synthesize")).toHaveLength(1);
  });

  it("gives every call the same shared context, so the prefix caches", async () => {
    const llm = reviewScript();
    const { graph, config } = setup(llm);
    await runToApproval(graph, config());

    const contexts = new Set(llm.calls.map((c) => c.context));
    expect(contexts.size).toBe(1);
    expect([...contexts][0]).toContain(`Head commit: ${repo.headSha}`);
  });

  it("feeds the deterministic test pairing to the coverage check", async () => {
    const llm = reviewScript();
    const { graph, config } = setup(llm);
    await runToApproval(graph, config());

    const prompt = llm.callsFor("checkCoverage")[0]?.prompt ?? "";
    expect(prompt).toContain(
      "Source files with no test change of the same name: src/math.js, src/strings.js",
    );
  });

  it("publishes once on approval", async () => {
    const { graph, publisher, config } = setup(reviewScript());
    const cfg = config();
    await runToApproval(graph, cfg);

    const final = await graph.invoke(new Command({ resume: { action: "approve" } }), cfg);

    expect(final.published).toEqual({
      kind: "file",
      location: `memory://${repo.headSha}`,
      alreadyPosted: false,
    });
    expect(publisher.posted).toHaveLength(1);
  });

  it("applies a human edit: reword or drop findings, verdict still guarded", async () => {
    const { graph, publisher, config } = setup(reviewScript());
    const cfg = config();
    const { request } = await runToApproval(graph, cfg);
    const id = request?.review.findings[0]?.id ?? "";

    await graph.invoke(
      new Command({
        resume: {
          action: "edit",
          summary: "Edited summary.",
          verdict: "approve",
          findings: [
            { id, title: "Guard against b = 0", body: "Edited.", suggestion: null },
            { id: "7.7", title: "x", body: "x", suggestion: null },
          ],
        },
      }),
      cfg,
    );

    const posted = publisher.posted[0]?.review;
    expect(posted?.summary).toBe("Edited summary.");
    expect(posted?.findings.map((f) => [f.title, f.line, f.inline])).toEqual([
      ["Guard against b = 0", 4, true],
    ]);
    expect(posted?.verdict).toBe("comment");
  });

  it("posts nothing when rejected", async () => {
    const { graph, publisher, config } = setup(reviewScript());
    const cfg = config();
    await runToApproval(graph, cfg);

    const final = await graph.invoke(
      new Command({ resume: { action: "reject", reason: "Too noisy" } }),
      cfg,
    );

    expect(final.decision).toEqual({ action: "reject", reason: "Too noisy" });
    expect(final.published).toBeNull();
    expect(publisher.posted).toEqual([]);
  });

  it("rejects a malformed decision instead of posting", async () => {
    const { graph, publisher, config } = setup(reviewScript());
    const cfg = config();
    await runToApproval(graph, cfg);

    await expect(graph.invoke(new Command({ resume: { action: "yolo" } }), cfg)).rejects.toThrow();
    expect(publisher.posted).toEqual([]);
  });

  it("carries on when one file fails, and reports it", async () => {
    const llm = reviewScript({
      analyzeFile: (request) => {
        if (request.prompt.includes("`src/strings.js`")) throw new LlmRefusalError("other");
        return { summary: "Fine.", findings: [] };
      },
      synthesize: () => ({ summary: "s", verdict: "comment", findingIds: [] }),
    });
    const { graph, config } = setup(llm);

    const { events, request } = await runToApproval(graph, config());

    expect(request?.review.meta.fileErrors).toEqual([
      { path: "src/strings.js", error: "LlmRefusalError: The model declined the request (other)." },
    ]);
    expect(request?.review.meta.filesReviewed).not.toContain("src/strings.js");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "file_failed", path: "src/strings.js" }),
    );
    expect(llm.callsFor("synthesize")[0]?.prompt).toContain("src/strings.js: NOT REVIEWED");
  });

  it("degrades when flagRisks refuses, keeping the rule-based risks", async () => {
    const llm = reviewScript({
      flagRisks: () => {
        throw new LlmRefusalError("other");
      },
    });
    const { graph, config } = setup(llm);

    const { request } = await runToApproval(graph, config());

    expect(request?.review.risks.length).toBeGreaterThan(0);
    expect(request?.review.risks.every((r) => r.source === "rule")).toBe(true);
    expect(request?.review.meta.stepErrors).toEqual([
      { step: "flagRisks", error: "LlmRefusalError: The model declined the request (other)." },
    ]);
    expect(request?.markdown).toContain("Not completed: risk analysis");
  });

  it("degrades when checkCoverage refuses, falling back to the name-based pairing", async () => {
    const llm = reviewScript({
      checkCoverage: () => {
        throw new LlmRefusalError("other");
      },
    });
    const { graph, config } = setup(llm);

    const { request } = await runToApproval(graph, config());

    expect(request?.review.coverage.status).toBe("unknown");
    expect(request?.review.coverage.untestedPaths).toEqual(["src/math.js", "src/strings.js"]);
    expect(request?.review.meta.stepErrors).toEqual([
      { step: "checkCoverage", error: "LlmRefusalError: The model declined the request (other)." },
    ]);
  });

  it("degrades when summarizeDiff refuses, and the review still exists", async () => {
    const llm = reviewScript({
      summarizeDiff: () => {
        throw new LlmRefusalError("other");
      },
    });
    const { graph, config } = setup(llm);

    const { request } = await runToApproval(graph, config());

    expect(request?.review).toBeDefined();
    expect(request?.review.meta.stepErrors).toEqual([
      { step: "summarizeDiff", error: "LlmRefusalError: The model declined the request (other)." },
    ]);
  });

  it("retries a transient failure in a whole-change step instead of degrading it", async () => {
    let failures = 1;
    const llm = reviewScript({
      flagRisks: () => {
        if (failures-- > 0) throw new RepoToolTransportError("boom");
        return {
          risks: [
            { kind: "public_api", level: "low", paths: ["src/math.js"], rationale: "New export." },
          ],
        };
      },
    });
    const { graph, config } = setup(llm);

    const { request: req } = await runToApproval(graph, config());

    expect(req?.review.meta.stepErrors).toEqual([]);
    expect(llm.callsFor("flagRisks")).toHaveLength(2);
  });

  it("retries a transient MCP failure", async () => {
    let failures = 1;
    const flaky: RepoToolsApi = {
      toolNames: tools.toolNames,
      listChangedFiles: (args) => tools.listChangedFiles(args),
      getDiff: (args) => {
        if (failures-- > 0) return Promise.reject(new RepoToolTransportError("connection reset"));
        return tools.getDiff(args);
      },
      runTests: (args) => tools.runTests(args),
      anthropicTools: (names) => tools.anthropicTools(names),
      callForModel: (name, args) => tools.callForModel(name, args),
    };
    const { graph, config } = setup(reviewScript(), flaky);

    const { state } = await runToApproval(graph, config());

    expect(state.next).toEqual(["humanApproval"]);
  });

  it("resumes from the checkpoint after a crash without redoing finished files", async () => {
    let synthesizeDown = true;
    const base = reviewScript();
    const llm = reviewScript({
      synthesize: (request) => {
        if (synthesizeDown) throw new Anthropic.APIConnectionError({ message: "network down" });
        return base.structured(request).then((r) => r.output);
      },
    });
    const { graph, config } = setup(llm);
    const cfg = config();

    await expect(graph.invoke(start, cfg)).rejects.toThrow("network down");
    expect(llm.callsFor("analyzeFile")).toHaveLength(4);
    expect(llm.callsFor("synthesize")).toHaveLength(3); // retried, then gave up

    synthesizeDown = false;
    await graph.invoke(null, cfg);

    const state = await graph.getState(cfg);
    expect(state.next).toEqual(["humanApproval"]);
    expect(llm.callsFor("analyzeFile")).toHaveLength(4);
  });
});
