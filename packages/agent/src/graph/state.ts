import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type { ChangeSet, ChangedFile } from "../mcp/repo-tools.js";
import type { SkippedFile, TestPairing } from "../review/rules.js";
import {
  VerdictSchema,
  ZERO_USAGE,
  addUsage,
  type Coverage,
  type DiffSummary,
  type Finding,
  type Review,
  type Risk,
  type Usage,
} from "../review/schema.js";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ReviewInput {
  base: string;
  head: string;
  /** Where to post the review. Without it, the review is written to a file. */
  pullRequest: PullRequestRef | null;
}

export interface ReviewPlan {
  files: ChangedFile[];
  skipped: SkippedFile[];
  /** Patch per changed path; null when the diff tool withheld it (binary, denied, too large). */
  patches: Record<string, string | null>;
  pairing: TestPairing;
}

export interface FileResult {
  path: string;
  summary: string;
  findings: Finding[];
}

/**
 * What a human decides at the approval step. This arrives from outside (CLI,
 * web UI), so it is validated. An edit can rewrite text and drop findings but
 * can't add or move them, so every inline comment stays anchored to the diff.
 */
export const ReviewDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), reason: z.string() }),
  z.object({
    action: z.literal("edit"),
    summary: z.string(),
    verdict: VerdictSchema,
    findings: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        suggestion: z.string().nullable(),
      }),
    ),
  }),
]);

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface Published {
  kind: "github" | "file";
  location: string;
  /** True if an existing post for this head was found, so nothing new was posted. */
  alreadyPosted: boolean;
}

const replace = <T>(fallback: () => T) =>
  Annotation<T>({ reducer: (_current, update) => update, default: fallback });

const append = <T>() =>
  Annotation<T[]>({ reducer: (current, update) => current.concat(update), default: () => [] });

/**
 * Graph state. Lists that parallel branches write to use append reducers;
 * everything else is written by exactly one node.
 */
export const ReviewState = Annotation.Root({
  input: Annotation<ReviewInput>,
  change: replace<ChangeSet | null>(() => null),
  plan: replace<ReviewPlan | null>(() => null),
  fileResults: append<FileResult>(),
  fileErrors: append<{ path: string; error: string }>(),
  rejectedFindings: append<{ finding: Finding; reason: string }>(),
  diffSummary: replace<DiffSummary | null>(() => null),
  coverage: replace<Coverage | null>(() => null),
  risks: append<Risk>(),
  draft: replace<{ summary: string; verdict: Review["verdict"]; findingIds: string[] } | null>(
    () => null,
  ),
  review: replace<Review | null>(() => null),
  decision: replace<ReviewDecision | null>(() => null),
  published: replace<Published | null>(() => null),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ZERO_USAGE }),
  model: replace<string | null>(() => null),
});

export type State = typeof ReviewState.State;
export type Update = typeof ReviewState.Update;
