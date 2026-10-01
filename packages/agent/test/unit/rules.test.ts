import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../src/mcp/repo-tools.js";
import { pairTests, ruleRisks, selectFiles } from "../../src/review/rules.js";

const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  additions: 1,
  deletions: 0,
  isBinary: false,
  isTest: /\.test\.|^test\//.test(path),
  ...overrides,
});

describe("selectFiles", () => {
  it("skips files a model can't usefully review, with reasons", () => {
    const { files, skipped } = selectFiles(
      [
        file("src/a.ts"),
        file("pnpm-lock.yaml"),
        file("packages/x/package-lock.json"),
        file("dist/bundle.js"),
        file("web/app.min.js"),
        file("logo.png", { isBinary: true }),
        file("src/old.ts", { status: "deleted", deletions: 10 }),
        file("docs/b.md", { status: "renamed", oldPath: "docs/a.md", additions: 0 }),
      ],
      50,
    );

    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(skipped).toEqual([
      { path: "pnpm-lock.yaml", reason: "lockfile" },
      { path: "packages/x/package-lock.json", reason: "lockfile" },
      { path: "dist/bundle.js", reason: "generated" },
      { path: "web/app.min.js", reason: "generated" },
      { path: "logo.png", reason: "binary" },
      { path: "src/old.ts", reason: "deleted" },
      { path: "docs/b.md", reason: "rename only" },
    ]);
  });

  it("keeps the highest-churn files when over the limit", () => {
    const { files, skipped } = selectFiles(
      [
        file("small.ts", { additions: 1 }),
        file("big.ts", { additions: 90 }),
        file("mid.ts", { additions: 10 }),
      ],
      2,
    );

    expect(files.map((f) => f.path)).toEqual(["big.ts", "mid.ts"]);
    expect(skipped).toEqual([{ path: "small.ts", reason: "over the 2-file limit" }]);
  });
});

describe("ruleRisks", () => {
  it("flags risky paths by kind", () => {
    const risks = ruleRisks(
      [
        file(".env.production"),
        file("package.json"),
        file(".github/workflows/ci.yml"),
        file("db/migrations/001_users.sql"),
        file("src/auth/session.ts"),
        file("src/math.ts"),
      ],
      null,
    );

    expect(risks.map((r) => [r.kind, r.level, r.paths])).toEqual([
      ["secrets", "high", [".env.production"]],
      ["migration", "high", ["db/migrations/001_users.sql"]],
      ["dependencies", "medium", ["package.json"]],
      ["ci_config", "medium", [".github/workflows/ci.yml"]],
      ["auth", "medium", ["src/auth/session.ts"]],
    ]);
    expect(risks.every((r) => r.source === "rule")).toBe(true);
  });

  it("flags files whose contents the repo policy hides", () => {
    const risks = ruleRisks([file("config/prod.secret")], {
      base: "a",
      head: "b",
      mergeBase: "a",
      truncated: false,
      files: [
        {
          path: "config/prod.secret",
          oldPath: null,
          status: "modified",
          patch: "",
          patchOmitted: "denied",
        },
      ],
    });

    expect(risks).toEqual([
      expect.objectContaining({ kind: "secrets", paths: ["config/prod.secret"] }),
    ]);
  });

  it("flags large deletions", () => {
    const risks = ruleRisks([file("src/legacy.ts", { status: "deleted", deletions: 50 })], null);

    expect(risks).toEqual([
      expect.objectContaining({ kind: "large_deletion", paths: ["src/legacy.ts"] }),
    ]);
  });

  it("returns nothing for an ordinary change", () => {
    expect(ruleRisks([file("src/math.ts")], null)).toEqual([]);
  });
});

describe("pairTests", () => {
  it("pairs sources with tests by name across conventions", () => {
    const pairing = pairTests([
      file("src/math.ts"),
      file("test/math.test.ts"),
      file("pkg/parse.go"),
      file("pkg/parse_test.go", { isTest: true }),
      file("app/util.py"),
      file("tests/test_util.py", { isTest: true }),
      file("src/strings.ts"),
      file("README.md"),
    ]);

    expect(pairing.sources).toEqual([
      "src/math.ts",
      "pkg/parse.go",
      "app/util.py",
      "src/strings.ts",
    ]);
    expect(pairing.sourcesWithoutTests).toEqual(["src/strings.ts"]);
  });

  it("ignores deleted files", () => {
    expect(pairTests([file("src/gone.ts", { status: "deleted" })]).sources).toEqual([]);
  });
});
