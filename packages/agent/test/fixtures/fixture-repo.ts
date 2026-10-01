import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureRepo {
  root: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "calc", type: "module", scripts: { test: "node --test" }, dependencies: {} },
    null,
    2,
  ),
  "README.md": "# calc\n",
  "src/math.js": "export const add = (a, b) => a + b;\n",
  "test/math.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/math.js";',
    "",
    'test("add", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"),
  ".github/workflows/ci.yml": "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
};

/**
 * A pull request with something for every node to find:
 * - src/math.js gains `divide`, with a planted bug (no zero check) and no test
 * - src/strings.js is new and untested
 * - package.json adds a dependency, and the CI workflow changes (rule-based risks)
 * - pnpm-lock.yaml changes (skipped as a lockfile), assets/logo.png is binary
 */
const FEATURE_FILES: Record<string, string | Uint8Array> = {
  "src/math.js": [
    "export const add = (a, b) => a + b;",
    "",
    "export function divide(a, b) {",
    "  return a / b;",
    "}",
    "",
  ].join("\n"),
  "src/strings.js": "export const shout = (s) => s.toUpperCase() + '!';\n",
  "package.json": JSON.stringify(
    {
      name: "calc",
      type: "module",
      scripts: { test: "node --test" },
      dependencies: { "left-pad": "^1.3.0" },
    },
    null,
    2,
  ),
  ".github/workflows/ci.yml":
    "on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
};

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr-review-fixture-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    }).trim();
  const writeAll = async (files: Record<string, string | Uint8Array>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  };

  git("init", "--quiet");
  await writeAll(BASE_FILES);
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  git("checkout", "--quiet", "-b", "feature");
  await writeAll(FEATURE_FILES);
  git("add", "--all");
  git("commit", "--quiet", "-m", "add divide and strings");
  const headSha = git("rev-parse", "HEAD");

  return { root, baseSha, headSha, cleanup: () => rm(root, { recursive: true, force: true }) };
}
