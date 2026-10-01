import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { parseWebThreadId, webThreadId } from "@/lib/thread-id";

describe("loadConfig", () => {
  it("parses the repo allowlist and flags", () => {
    const config = loadConfig({
      PR_REVIEW_REPOS: "calc=/src/calc, api = /src/api ,broken",
      PR_REVIEW_DEMO: "1",
      GITHUB_TOKEN: "",
    });

    expect([...config.repos]).toEqual([
      ["calc", "/src/calc"],
      ["api", "/src/api"],
    ]);
    expect(config.demo).toBe(true);
    expect(config.githubToken).toBeNull();
    expect(config.dataDir).toBe(".pr-review");
    expect(config.allowedHosts).toEqual([]);
  });

  it("rejects repo names that could be confused with paths", () => {
    expect(() => loadConfig({ PR_REVIEW_REPOS: "../x=/tmp" })).toThrow(/Invalid repo name/);
  });

  it("parses the allowed hosts list", () => {
    const config = loadConfig({ PR_REVIEW_ALLOWED_HOSTS: "Review.Example.com, review.lan ," });

    expect(config.allowedHosts).toEqual(["review.example.com", "review.lan"]);
  });
});

describe("web thread ids", () => {
  it("round-trips the repo name", () => {
    const id = webThreadId("calc", "acme/calc#7@abc");

    expect(id).toBe("calc|acme/calc#7@abc");
    expect(parseWebThreadId(id)).toEqual({ repo: "calc" });
    expect(parseWebThreadId("no-separator")).toBeNull();
  });
});
