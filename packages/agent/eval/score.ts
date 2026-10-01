import type { Review } from "../src/review/schema.js";
import type { EvalCase } from "./cases.js";

/** How far (in lines) a finding may sit from the planted range and still count. */
export const LINE_TOLERANCE = 2;

export interface CaseScore {
  case: string;
  planted: number;
  caught: string[];
  missed: string[];
  /** Blocker/major findings that match no planted bug. */
  falsePositives: number;
  /** All findings in the published review. */
  findings: number;
  verdict: Review["verdict"];
}

/**
 * Scores one review against its case. A planted bug counts as caught if any
 * finding of severity minor or above is on the same file within the
 * tolerance of its line range. Nits don't count as catching a bug.
 */
export function scoreCase(evalCase: EvalCase, review: Review): CaseScore {
  const counted = review.findings.filter((f) => f.severity !== "nit");
  const matches = (bug: EvalCase["bugs"][number]) =>
    counted.filter(
      (f) =>
        f.path === bug.path &&
        f.line >= bug.lines[0] - LINE_TOLERANCE &&
        f.line <= bug.lines[1] + LINE_TOLERANCE,
    );

  const caught = evalCase.bugs.filter((bug) => matches(bug).length > 0).map((b) => b.id);
  const matched = new Set(evalCase.bugs.flatMap(matches));
  const falsePositives = review.findings.filter(
    (f) => (f.severity === "blocker" || f.severity === "major") && !matched.has(f),
  ).length;

  return {
    case: evalCase.name,
    planted: evalCase.bugs.length,
    caught,
    missed: evalCase.bugs.filter((b) => !caught.includes(b.id)).map((b) => b.id),
    falsePositives,
    findings: review.findings.length,
    verdict: review.verdict,
  };
}

export interface Summary {
  recall: number;
  falsePositives: number;
  cleanCaseVerdicts: Review["verdict"][];
}

export function summarize(scores: readonly CaseScore[], cases: readonly EvalCase[]): Summary {
  const planted = scores.reduce((n, s) => n + s.planted, 0);
  const caught = scores.reduce((n, s) => n + s.caught.length, 0);
  const clean = new Set(cases.filter((c) => c.bugs.length === 0).map((c) => c.name));
  return {
    recall: planted === 0 ? 1 : caught / planted,
    falsePositives: scores.reduce((n, s) => n + s.falsePositives, 0),
    cleanCaseVerdicts: scores.filter((s) => clean.has(s.case)).map((s) => s.verdict),
  };
}
