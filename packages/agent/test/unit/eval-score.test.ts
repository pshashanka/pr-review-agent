import { describe, expect, it } from "vitest";
import { CASES, type EvalCase } from "../../eval/cases.js";
import { scoreCase, summarize } from "../../eval/score.js";
import { ZERO_USAGE, type Finding, type Review } from "../../src/review/schema.js";

const evalCase: EvalCase = {
  name: "c",
  base: {},
  head: {},
  bugs: [
    { id: "a", path: "x.js", lines: [10, 12], description: "" },
    { id: "b", path: "y.js", lines: [3, 3], description: "" },
  ],
};

const finding = (overrides: Partial<Finding>): Finding => ({
  id: "1",
  path: "x.js",
  line: 11,
  endLine: null,
  severity: "major",
  category: "bug",
  confidence: "high",
  title: "t",
  body: "b",
  suggestion: null,
  inline: true,
  ...overrides,
});

const review = (findings: Finding[], verdict: Review["verdict"] = "comment"): Review => ({
  summary: "",
  verdict,
  findings,
  risks: [],
  coverage: { status: "adequate", untestedPaths: [], notes: "" },
  meta: {
    base: "",
    head: "",
    mergeBase: null,
    model: "m",
    filesReviewed: [],
    filesSkipped: [],
    fileErrors: [],
    stepErrors: [],
    usage: ZERO_USAGE,
  },
});

describe("scoreCase", () => {
  it("counts a bug as caught by a finding on the same file within tolerance", () => {
    const score = scoreCase(evalCase, review([finding({ line: 14 })]));

    expect(score).toMatchObject({ caught: ["a"], missed: ["b"], falsePositives: 0 });
  });

  it("doesn't count nits, wrong files or far-away lines", () => {
    const score = scoreCase(
      evalCase,
      review([
        finding({ line: 11, severity: "nit" }),
        finding({ path: "z.js", line: 11, severity: "minor" }),
        finding({ path: "y.js", line: 9, severity: "minor" }),
      ]),
    );

    expect(score.caught).toEqual([]);
  });

  it("counts unmatched blocker and major findings as false positives", () => {
    const score = scoreCase(
      evalCase,
      review([
        finding({ id: "1" }),
        finding({ id: "2", path: "z.js", severity: "blocker" }),
        finding({ id: "3", path: "z.js", severity: "minor" }),
      ]),
    );

    expect(score.falsePositives).toBe(1);
  });
});

describe("summarize", () => {
  it("reports recall across cases and verdicts on clean cases", () => {
    const clean: EvalCase = { name: "clean", base: {}, head: {}, bugs: [] };
    const summary = summarize(
      [scoreCase(evalCase, review([finding({})])), scoreCase(clean, review([], "approve"))],
      [evalCase, clean],
    );

    expect(summary).toEqual({ recall: 0.5, falsePositives: 0, cleanCaseVerdicts: ["approve"] });
  });
});

describe("eval cases", () => {
  it("point planted bugs at lines that exist in the head files", () => {
    for (const c of CASES) {
      for (const bug of c.bugs) {
        const lineCount = (c.head[bug.path] ?? "").split("\n").length - 1;
        expect(bug.lines[1], `${c.name}/${bug.id}`).toBeLessThanOrEqual(lineCount);
      }
    }
  });
});
