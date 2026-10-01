import { describe, expect, it } from "vitest";
import { anchorFindings, parsePatch } from "../../src/review/anchor.js";
import type { Finding } from "../../src/review/schema.js";

const PATCH = `diff --git a/src/math.js b/src/math.js
index 1111111..2222222 100644
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,4 @@
 export const add = (a, b) => a + b;
-export const sub = (a, b) => a - b;
+export const subtract = (a, b) => a - b;
+export const multiply = (a, b) => a * b;
 export const id = (x) => x;
@@ -20,2 +21,3 @@ function tail() {
 const z = 1;
+const w = 2;
 const y = 3;
\\ No newline at end of file
`;

describe("parsePatch", () => {
  it("collects head-side line numbers per hunk, skipping removed lines", () => {
    const { hunks } = parsePatch(PATCH);

    expect(hunks.map((h) => [...h])).toEqual([
      [1, 2, 3, 4],
      [21, 22, 23],
    ]);
  });

  it("returns no hunks for a header-only patch (pure rename)", () => {
    const patch =
      "diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to b.md\n";

    expect(parsePatch(patch).hunks).toEqual([]);
  });
});

const finding = (overrides: Partial<Finding>): Finding => ({
  id: "f1",
  path: "src/math.js",
  line: 3,
  endLine: null,
  severity: "major",
  category: "bug",
  confidence: "high",
  title: "t",
  body: "b",
  suggestion: null,
  inline: false,
  ...overrides,
});

describe("anchorFindings", () => {
  const patches = new Map<string, string | null>([
    ["src/math.js", PATCH],
    ["assets/logo.png", null],
  ]);

  it("marks findings on diff lines as inline", () => {
    const { kept } = anchorFindings([finding({ line: 3 })], patches);

    expect(kept).toEqual([expect.objectContaining({ line: 3, inline: true })]);
  });

  it("keeps findings outside the diff but not inline", () => {
    const { kept } = anchorFindings([finding({ line: 10 })], patches);

    expect(kept[0]).toMatchObject({ line: 10, inline: false });
  });

  it("keeps a multi-line range only if it stays within one hunk", () => {
    const { kept } = anchorFindings(
      [finding({ id: "a", line: 2, endLine: 4 }), finding({ id: "b", line: 4, endLine: 22 })],
      patches,
    );

    expect(kept.map((f) => [f.id, f.endLine])).toEqual([
      ["a", 4],
      ["b", null],
    ]);
  });

  it("rejects findings on files that are not in the change", () => {
    const { kept, rejected } = anchorFindings([finding({ path: "src/imaginary.js" })], patches);

    expect(kept).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("file is not part of the change");
  });

  it("keeps findings on files whose patch was omitted, not inline", () => {
    const { kept } = anchorFindings([finding({ path: "assets/logo.png", line: 1 })], patches);

    expect(kept[0]).toMatchObject({ inline: false });
  });
});
