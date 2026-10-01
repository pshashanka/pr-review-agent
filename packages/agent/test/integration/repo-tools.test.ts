import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepoToolError, RepoTools } from "../../src/mcp/repo-tools.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";

let repo: FixtureRepo;
let tools: RepoTools;

beforeAll(async () => {
  repo = await createFixtureRepo();
  tools = await RepoTools.connect({ kind: "stdio", repo: repo.root });
});

afterAll(async () => {
  await tools.close();
  await repo.cleanup();
});

describe("RepoTools (against a real mcp-repo-tools server)", () => {
  it("lists changed files with pinned SHAs", async () => {
    const change = await tools.listChangedFiles({ base: "main", head: "HEAD" });

    expect(change.head).toBe(repo.headSha);
    expect(change.mergeBase).toBe(repo.baseSha);
    expect(change.files.map((f) => f.path)).toEqual([
      ".github/workflows/ci.yml",
      "assets/logo.png",
      "package.json",
      "pnpm-lock.yaml",
      "src/math.js",
      "src/strings.js",
    ]);
  });

  it("gets per-file patches", async () => {
    const diff = await tools.getDiff({ base: "main", head: "HEAD", paths: ["src/math.js"] });

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.patch).toContain("+export function divide(a, b) {");
  });

  it("turns server tool errors into RepoToolError with the server's code", async () => {
    const error: unknown = await tools
      .listChangedFiles({ base: "nope", head: "HEAD" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RepoToolError);
    expect(error).toMatchObject({ code: "INVALID_REF" });
  });

  it("exposes only the requested tools to the model, in the requested order", async () => {
    const defs = await tools.anthropicTools(["search_code", "read_file", "not_a_tool"]);

    expect(defs.map((d) => d.name)).toEqual(["search_code", "read_file"]);
    expect(defs[1]?.input_schema).toMatchObject({
      type: "object",
      properties: { path: expect.anything() as unknown },
    });
  });

  it("returns policy errors to the model as error results, not exceptions", async () => {
    await expect(
      tools.callForModel("read_file", { path: "../../etc/passwd" }),
    ).resolves.toMatchObject({
      isError: true,
      text: expect.stringMatching(/^PATH_DENIED/) as unknown,
    });
  });

  it("returns schema violations from the model as error results too", async () => {
    await expect(tools.callForModel("read_file", { nope: true })).resolves.toMatchObject({
      isError: true,
    });
  });
});
