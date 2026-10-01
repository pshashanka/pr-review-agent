import type { Finding, Review, ReviewStep, Severity, Verdict } from "./schema.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};

const SEVERITY_ORDER: Severity[] = ["blocker", "major", "minor", "nit"];

const STEP_LABEL: Record<ReviewStep, string> = {
  summarizeDiff: "diff summary",
  checkCoverage: "coverage check",
  flagRisks: "risk analysis",
};

/** Hidden marker that identifies a posted review, so a retry never posts twice. */
export function reviewMarker(head: string): string {
  return `<!-- pr-review-agent:${head} -->`;
}

/** The review body. Inline findings are listed briefly (their detail is on the line). */
export function renderReviewBody(review: Review): string {
  const sections: string[] = [`## Review: ${VERDICT_LABEL[review.verdict]}`, review.summary];

  if (review.risks.length > 0) {
    const rows = review.risks.map(
      (r) =>
        `| ${r.level} | ${r.kind} | ${r.paths.map((p) => `\`${p}\``).join(", ")} | ${oneLine(r.rationale)} |`,
    );
    sections.push(
      [
        "### Risks",
        "",
        "| Level | Kind | Files | Why |",
        "| --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }

  const coverage = review.coverage;
  const untested =
    coverage.untestedPaths.length > 0
      ? `\n\nUntested: ${coverage.untestedPaths.map((p) => `\`${p}\``).join(", ")}`
      : "";
  sections.push(`### Tests: ${coverage.status.replace("_", " ")}\n\n${coverage.notes}${untested}`);

  if (review.findings.length > 0) {
    const lines: string[] = ["### Findings"];
    for (const severity of SEVERITY_ORDER) {
      for (const finding of review.findings.filter((f) => f.severity === severity)) {
        const where = `\`${finding.path}:${finding.line}\``;
        lines.push(
          finding.inline
            ? `- **${severity}** ${where} ${finding.title} _(inline)_`
            : `- **${severity}** ${where} ${finding.title}\n\n${indent(finding.body)}`,
        );
      }
    }
    sections.push(lines.join("\n"));
  }

  if (review.meta.stepErrors.length > 0) {
    sections.push(
      review.meta.stepErrors
        .map((e) => `_Not completed: ${STEP_LABEL[e.step]} (${e.error})._`)
        .join("\n\n"),
    );
  }

  const { meta } = review;
  const skipped =
    meta.filesSkipped.length + meta.fileErrors.length > 0
      ? ` · ${meta.filesSkipped.length} skipped · ${meta.fileErrors.length} failed`
      : "";
  sections.push(
    `<sub>Reviewed ${meta.filesReviewed.length} files${skipped} at \`${meta.head.slice(0, 12)}\` by ${meta.model}.</sub>`,
    reviewMarker(meta.head),
  );
  return sections.join("\n\n");
}

/** Body of an inline comment, with a GitHub suggestion block if there is a fix. */
export function renderInlineComment(finding: Finding): string {
  const header = `**${finding.severity} · ${finding.category}** ${finding.title}`;
  const suggestion =
    finding.suggestion === null ? "" : `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  return `${header}\n\n${finding.body}${suggestion}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}
