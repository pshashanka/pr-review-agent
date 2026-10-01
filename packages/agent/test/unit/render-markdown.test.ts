import { describe, expect, it } from "vitest";
import {
  renderInlineComment,
  renderReviewBody,
  reviewMarker,
} from "../../src/review/render-markdown.js";
import { ZERO_USAGE, type Finding, type Review } from "../../src/review/schema.js";

const finding = (overrides: Partial<Finding>): Finding => ({
  id: "f1",
  path: "src/math.js",
  line: 3,
  endLine: null,
  severity: "major",
  category: "bug",
  confidence: "high",
  title: "Division by zero",
  body: "`divide(1, 0)` returns Infinity.",
  suggestion: null,
  inline: true,
  ...overrides,
});

const review: Review = {
  summary: "Adds multiply and divide.",
  verdict: "request_changes",
  findings: [
    finding({
      id: "a",
      severity: "nit",
      title: "Naming",
      inline: false,
      body: "Prefer `quotient`.",
    }),
    finding({ id: "b", severity: "blocker" }),
  ],
  risks: [
    {
      kind: "secrets",
      level: "high",
      paths: [".env"],
      rationale: "Touches a secrets file | really",
      source: "rule",
    },
  ],
  coverage: { status: "partial", untestedPaths: ["src/divide.js"], notes: "divide has no tests." },
  meta: {
    base: "a".repeat(40),
    head: "b".repeat(40),
    mergeBase: "a".repeat(40),
    model: "claude-opus-5",
    filesReviewed: ["src/math.js"],
    filesSkipped: [{ path: "pnpm-lock.yaml", reason: "lockfile" }],
    fileErrors: [],
    stepErrors: [],
    usage: ZERO_USAGE,
  },
};

describe("renderReviewBody", () => {
  const body = renderReviewBody(review);

  it("leads with the verdict and summary", () => {
    expect(body.startsWith("## Review: Request changes\n\nAdds multiply and divide.")).toBe(true);
  });

  it("orders findings by severity and details only the non-inline ones", () => {
    const blocker = body.indexOf("**blocker**");
    const nit = body.indexOf("**nit**");

    expect(blocker).toBeGreaterThan(-1);
    expect(nit).toBeGreaterThan(blocker);
    expect(body).toContain("`src/math.js:3` Division by zero _(inline)_");
    expect(body).toContain("  Prefer `quotient`.");
  });

  it("escapes pipes in the risk table", () => {
    expect(body).toContain("Touches a secrets file \\| really");
  });

  it("reports coverage, skipped files and the idempotency marker", () => {
    expect(body).toContain("### Tests: partial");
    expect(body).toContain("Untested: `src/divide.js`");
    expect(body).toContain("1 skipped · 0 failed");
    expect(body.endsWith(reviewMarker(review.meta.head))).toBe(true);
  });
});

describe("renderReviewBody with step errors", () => {
  it("reports a whole-change step that failed", () => {
    const body = renderReviewBody({
      ...review,
      meta: {
        ...review.meta,
        stepErrors: [{ step: "flagRisks", error: "LlmRefusalError: refused" }],
      },
    });

    expect(body).toContain("Not completed: risk analysis (LlmRefusalError: refused).");
  });
});

describe("renderInlineComment", () => {
  it("includes a GitHub suggestion block when there is a fix", () => {
    const text = renderInlineComment(finding({ suggestion: "return b === 0 ? null : a / b;" }));

    expect(text).toBe(
      "**major · bug** Division by zero\n\n`divide(1, 0)` returns Infinity.\n\n" +
        "```suggestion\nreturn b === 0 ? null : a / b;\n```",
    );
  });
});
