import { z } from "zod";

// Schemas the model fills in (via structured outputs) use nullable rather than
// optional fields and enums rather than numeric ranges: every field is always
// present, and there are no constraints the model has to guess at.

export const SeveritySchema = z.enum(["blocker", "major", "minor", "nit"]);
export const CategorySchema = z.enum([
  "bug",
  "security",
  "performance",
  "maintainability",
  "testing",
  "docs",
]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const VerdictSchema = z.enum(["approve", "comment", "request_changes"]);

export type Severity = z.infer<typeof SeveritySchema>;
export type Verdict = z.infer<typeof VerdictSchema>;

/** One issue in one file, as the model reports it. */
export const FileFindingSchema = z.object({
  line: z
    .number()
    .int()
    .describe("Line number in the NEW version of the file. Must be a line shown in the diff."),
  endLine: z
    .number()
    .int()
    .nullable()
    .describe("Last line of a multi-line finding, or null for a single line."),
  severity: SeveritySchema.describe(
    "blocker: must fix before merge (bug, data loss, security hole). major: should fix. " +
      "minor: worth fixing. nit: style or preference.",
  ),
  category: CategorySchema,
  confidence: ConfidenceSchema.describe("How sure you are that this is a real problem."),
  title: z.string().describe("One line, e.g. 'Off-by-one when the list is empty'."),
  body: z.string().describe("Why this is a problem, with evidence from the code. Markdown."),
  suggestion: z
    .string()
    .nullable()
    .describe("Exact replacement code for line..endLine, or null if there is no simple fix."),
});

/** Output of the per-file analysis. */
export const FileAnalysisSchema = z.object({
  summary: z.string().describe("One or two sentences: what changed in this file."),
  findings: z.array(FileFindingSchema),
});

export type FileAnalysis = z.infer<typeof FileAnalysisSchema>;

/** A finding after the agent has attached identity and location. */
export interface Finding extends z.infer<typeof FileFindingSchema> {
  id: string;
  path: string;
  /** True if `line` is on the head side of a diff hunk, so it can be an inline comment. */
  inline: boolean;
}

export const DiffSummarySchema = z.object({
  summary: z.string().describe("Three to six sentences: what this change does and why."),
  keyChanges: z.array(z.string()).describe("The most important changes, one short line each."),
});

export type DiffSummary = z.infer<typeof DiffSummarySchema>;

export const RiskKindSchema = z.enum([
  "secrets",
  "dependencies",
  "ci_config",
  "migration",
  "auth",
  "large_deletion",
  "public_api",
  "concurrency",
  "other",
]);
export const RiskLevelSchema = z.enum(["high", "medium", "low"]);

export const ModelRisksSchema = z.object({
  risks: z.array(
    z.object({
      kind: RiskKindSchema,
      level: RiskLevelSchema,
      paths: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
});

type ModelRisk = z.infer<typeof ModelRisksSchema>["risks"][number];

export interface Risk extends ModelRisk {
  /** "rule" risks come from deterministic checks; "model" risks from the LLM. */
  source: "rule" | "model";
}

export const CoverageSchema = z.object({
  status: z.enum(["adequate", "partial", "missing", "not_applicable"]),
  untestedPaths: z
    .array(z.string())
    .describe("Changed source files whose new behaviour has no test."),
  notes: z.string(),
});

export type Coverage = z.infer<typeof CoverageSchema>;

/**
 * Output of the synthesis step. It selects and orders existing findings by id
 * rather than writing new ones, so every inline comment traces back to a
 * per-file analysis of real diff lines.
 */
export const SynthesisSchema = z.object({
  summary: z.string().describe("The review's opening paragraph, for the PR author. Markdown."),
  verdict: VerdictSchema,
  findingIds: z
    .array(z.string())
    .describe("Ids of findings to include, most important first. Drop duplicates and noise."),
});

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface Review {
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  risks: Risk[];
  coverage: Coverage;
  meta: {
    base: string;
    head: string;
    mergeBase: string | null;
    model: string;
    filesReviewed: string[];
    filesSkipped: { path: string; reason: string }[];
    fileErrors: { path: string; error: string }[];
    usage: Usage;
  };
}
