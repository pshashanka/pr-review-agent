#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createAgent, threadIdFor } from "./agent.js";
import type { Publisher } from "./graph/deps.js";
import type { ReviewDecision, ReviewInput } from "./graph/state.js";
import { AnthropicLlm, type Effort } from "./llm/anthropic.js";
import { FilePublisher } from "./publish/file.js";
import { GitHubPublisher, parsePullRequestRef } from "./publish/github.js";
import { getStatus, runReview, type RunEvent, type RunStatus } from "./runner.js";

const USAGE = `Usage: pr-review --repo <path> --base <ref> [options]

Reviews the changes on --head since it branched from --base. Running the same
command again continues the same review: it resumes after a crash, and once
the review is ready it asks for (or takes) your approval before posting.

Options:
  --repo <path>          Git repository to review (default: current directory)
  --base <ref>           Base branch or commit, e.g. main (required)
  --head <ref>           Head branch or commit (default: HEAD)
  --pr <owner/repo#n>    Post to this GitHub pull request (needs GITHUB_TOKEN)
  --submit-verdict       Post the verdict as APPROVE/REQUEST_CHANGES, not a comment
  --out <dir>            Without --pr, write the review here (default: .pr-review)
  --db <file>            Checkpoint database (default: .pr-review/checkpoints.sqlite)
  --model <id>           Claude model (default: claude-opus-5)
  --effort <level>       Effort for every step: low, medium, high, xhigh or max
  --max-files <n>        Analyze at most n files (default: 40)
  --mcp-config <file>    mcp-repo-tools config file (for run_tests targets)
  --test-target <name>   Run this mcp-repo-tools test target during the coverage check
  --approve              Approve and post a review that is waiting for approval
  --reject <reason>      Reject a review that is waiting for approval
  --verbose              Show the model's thinking summaries
  --help                 Show this help

Environment: ANTHROPIC_API_KEY (or an \`ant auth login\` profile), GITHUB_TOKEN for --pr.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: process.cwd() },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      pr: { type: "string" },
      "submit-verdict": { type: "boolean", default: false },
      out: { type: "string", default: ".pr-review" },
      db: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "max-files": { type: "string" },
      "mcp-config": { type: "string" },
      "test-target": { type: "string" },
      approve: { type: "boolean", default: false },
      reject: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.base === undefined) {
    process.stderr.write(`--base is required.\n\n${USAGE}`);
    return 2;
  }

  const pullRequest = values.pr === undefined ? null : parsePullRequestRef(values.pr);
  const publisher: Publisher =
    pullRequest === null
      ? new FilePublisher(values.out)
      : new GitHubPublisher({
          token: requireEnv("GITHUB_TOKEN"),
          submitVerdict: values["submit-verdict"],
        });

  const effort = values.effort === undefined ? undefined : parseEffort(values.effort);
  const agent = await createAgent({
    repoTools: {
      kind: "stdio",
      repo: values.repo,
      config: values["mcp-config"],
      allowRunTests: values["test-target"] !== undefined,
    },
    checkpointDb: values.db ?? `${values.out}/checkpoints.sqlite`,
    publisher,
    llm: new AnthropicLlm({
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(effort === undefined
        ? {}
        : {
            effort: {
              summarizeDiff: effort,
              analyzeFile: effort,
              checkCoverage: effort,
              flagRisks: effort,
              synthesize: effort,
            },
          }),
    }),
    options: {
      ...(values["max-files"] === undefined ? {} : { maxFiles: Number(values["max-files"]) }),
      testTarget: values["test-target"] ?? null,
    },
  });

  try {
    const input: ReviewInput = { base: values.base, head: values.head, pullRequest };
    const { head } = await agent.tools.listChangedFiles({ base: input.base, head: input.head });
    const threadId = threadIdFor(pullRequest ?? { base: input.base }, head);
    log(`Thread ${threadId}`);

    let status = await getStatus(agent.graph, threadId);
    if (status.state === "not_started") {
      status = await follow(runReview(agent.graph, threadId, { start: input }), values.verbose);
    } else if (status.state === "running") {
      log(`Resuming an interrupted run (next: ${status.next.join(", ") || "?"})`);
      status = await follow(runReview(agent.graph, threadId, { resume: true }), values.verbose);
    }

    if (status.state === "awaiting_approval") {
      const decision = await decide(status, values.approve, values.reject);
      if (decision === null) {
        log("Waiting for approval. Re-run with --approve or --reject <reason> to finish.");
        return 0;
      }
      status = await follow(runReview(agent.graph, threadId, { decide: decision }), values.verbose);
    }

    if (status.state === "published") {
      log(
        `${status.published.alreadyPosted ? "Already published" : "Published"}: ${status.published.location}`,
      );
    } else if (status.state === "rejected") {
      log(`Rejected: ${status.reason}`);
    }
    return 0;
  } finally {
    await agent.close();
  }
}

/** Prints progress as it streams and returns the final status. */
async function follow(
  run: AsyncGenerator<RunEvent, RunStatus>,
  verbose: boolean,
): Promise<RunStatus> {
  for (;;) {
    const next = await run.next();
    if (next.done === true) return next.value;
    const event = next.value;
    if (event.type === "node_finished" && event.node !== "analyzeFile") log(`✓ ${event.node}`);
    if (event.type !== "progress") continue;
    const p = event.event;
    if (p.type === "status") log(`  ${p.message}`);
    else if (p.type === "file_started") log(`  … ${p.path}`);
    else if (p.type === "file_done") log(`  ✓ ${p.path} (${p.findings} findings)`);
    else if (p.type === "file_failed") log(`  ✗ ${p.path}: ${p.error}`);
    else if (p.type === "tests_run") log(`  tests ${p.target}: ${p.passed ? "passed" : "failed"}`);
    else if (verbose && p.progress.type === "thinking")
      process.stderr.write(`\x1b[2m${p.progress.delta}\x1b[0m`);
  }
}

async function decide(
  status: Extract<RunStatus, { state: "awaiting_approval" }>,
  approve: boolean,
  rejectReason: string | undefined,
): Promise<ReviewDecision | null> {
  if (approve) return { action: "approve" };
  if (rejectReason !== undefined) return { action: "reject", reason: rejectReason };

  process.stdout.write(`\n${status.request.markdown}\n\n`);
  if (!process.stdin.isTTY) return null;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Post this review? [y]es / [n]o / [l]ater: "))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return { action: "approve" };
    if (answer === "n" || answer === "no") {
      const reason = await rl.question("Reason: ");
      return { action: "reject", reason: reason.trim() || "Rejected from the CLI" };
    }
    return null;
  } finally {
    rl.close();
  }
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function parseEffort(value: string): Effort {
  const effort = EFFORTS.find((e) => e === value);
  if (effort === undefined) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}.`);
  return effort;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set.`);
  return value;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(`pr-review: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
