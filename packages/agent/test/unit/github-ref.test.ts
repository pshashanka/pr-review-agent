import { describe, expect, it } from "vitest";
import { parsePullRequestRef, PullRequestRefSchema } from "../../src/publish/github.js";

describe("PullRequestRefSchema", () => {
  it("accepts a well-formed ref", () => {
    expect(
      PullRequestRefSchema.safeParse({ owner: "octo-org", repo: "my.repo", number: 12 }).success,
    ).toBe(true);
  });

  it.each([
    { owner: "..", repo: "..", number: 1 },
    { owner: "owner", repo: "..", number: 1 },
    { owner: "-bad", repo: "repo", number: 1 },
    { owner: "owner", repo: "repo", number: 0 },
  ])("rejects %j", (ref) => {
    expect(PullRequestRefSchema.safeParse(ref).success).toBe(false);
  });
});

describe("parsePullRequestRef", () => {
  it("parses a well-formed owner/repo#number", () => {
    expect(parsePullRequestRef("octo-org/my.repo#12")).toEqual({
      owner: "octo-org",
      repo: "my.repo",
      number: 12,
    });
  });

  it.each(["../..#1", "owner/..#1", "-bad/repo#1", "owner/repo#0", "a/b"])("rejects %s", (text) => {
    expect(() => parsePullRequestRef(text)).toThrow(/owner\/repo#123/);
  });
});
