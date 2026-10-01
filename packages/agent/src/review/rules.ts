import picomatch from "picomatch";
import type { ChangedFile, Diff } from "../mcp/repo-tools.js";
import type { Risk } from "./schema.js";

const LOCKFILES = picomatch(
  [
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/bun.lock",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/uv.lock",
    "**/go.sum",
    "**/Gemfile.lock",
    "**/composer.lock",
  ],
  { dot: true },
);

const GENERATED = picomatch(
  [
    "**/*.min.{js,css}",
    "**/*.map",
    "**/dist/**",
    "**/build/**",
    "**/vendor/**",
    "**/node_modules/**",
    "**/*.generated.*",
    "**/__snapshots__/**",
    "**/*.snap",
  ],
  { dot: true },
);

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface FileSelection {
  /** Files to analyze, highest churn first. */
  files: ChangedFile[];
  skipped: SkippedFile[];
}

/**
 * Decides which changed files are worth a model call. Everything skipped is
 * reported with a reason, so the review says what it didn't look at.
 */
export function selectFiles(files: readonly ChangedFile[], maxFiles: number): FileSelection {
  const skipped: SkippedFile[] = [];
  const candidates: ChangedFile[] = [];

  for (const file of files) {
    const reason = skipReason(file);
    if (reason === null) candidates.push(file);
    else skipped.push({ path: file.path, reason });
  }

  candidates.sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
  );
  for (const file of candidates.slice(maxFiles)) {
    skipped.push({ path: file.path, reason: `over the ${maxFiles}-file limit` });
  }
  return { files: candidates.slice(0, maxFiles), skipped };
}

function skipReason(file: ChangedFile): string | null {
  if (file.status === "deleted") return "deleted";
  if (file.isBinary) return "binary";
  if (LOCKFILES(file.path)) return "lockfile";
  if (GENERATED(file.path)) return "generated";
  if (file.status === "renamed" && file.additions + file.deletions === 0) return "rename only";
  return null;
}

const RISK_RULES: {
  kind: Risk["kind"];
  level: Risk["level"];
  match: (path: string) => boolean;
  why: string;
}[] = [
  {
    kind: "secrets",
    level: "high",
    match: picomatch(
      ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/secrets/**"],
      {
        dot: true,
        nocase: true,
      },
    ),
    why: "Changes a file that usually holds secrets.",
  },
  {
    kind: "migration",
    level: "high",
    match: picomatch(["**/migrations/**", "**/migrate/**", "**/*.sql"], { dot: true }),
    why: "Changes a database migration or schema; check it is reversible and safe on live data.",
  },
  {
    kind: "dependencies",
    level: "medium",
    match: picomatch(
      [
        "**/package.json",
        "**/requirements*.txt",
        "**/pyproject.toml",
        "**/go.mod",
        "**/Cargo.toml",
        "**/Gemfile",
        "**/composer.json",
      ],
      { dot: true },
    ),
    why: "Changes dependency manifests; review new or upgraded packages.",
  },
  {
    kind: "ci_config",
    level: "medium",
    match: picomatch(
      [
        ".github/workflows/**",
        ".gitlab-ci.yml",
        ".circleci/**",
        "**/Jenkinsfile",
        "**/Dockerfile",
        "**/*.dockerfile",
      ],
      { dot: true },
    ),
    why: "Changes CI or build configuration, which runs with elevated access.",
  },
  {
    kind: "auth",
    level: "medium",
    match: (path) => /(^|[/_.-])(auth|login|session|permission|oauth|jwt|acl|rbac)/i.test(path),
    why: "Touches authentication or authorization code.",
  },
];

const LARGE_FILE_DELETIONS = 300;
const LARGE_TOTAL_DELETIONS = 1000;

/** Risks that can be spotted from paths and line counts alone, without a model. */
export function ruleRisks(files: readonly ChangedFile[], diff: Diff | null): Risk[] {
  const risks: Risk[] = [];
  for (const rule of RISK_RULES) {
    const paths = files.filter((f) => rule.match(f.path)).map((f) => f.path);
    if (paths.length > 0) {
      risks.push({
        kind: rule.kind,
        level: rule.level,
        paths,
        rationale: rule.why,
        source: "rule",
      });
    }
  }

  const hidden = (diff?.files ?? []).filter((f) => f.patchOmitted === "denied").map((f) => f.path);
  const secrets = risks.find((r) => r.kind === "secrets");
  const unflaggedHidden = hidden.filter((p) => !secrets?.paths.includes(p));
  if (unflaggedHidden.length > 0) {
    risks.push({
      kind: "secrets",
      level: "high",
      paths: unflaggedHidden,
      rationale: "Changes files whose contents the repository policy hides from review.",
      source: "rule",
    });
  }

  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const large = files.filter((f) => f.status === "deleted" || f.deletions >= LARGE_FILE_DELETIONS);
  if (large.length > 0 || totalDeletions >= LARGE_TOTAL_DELETIONS) {
    risks.push({
      kind: "large_deletion",
      level: "medium",
      paths: large.map((f) => f.path),
      rationale: `Removes ${totalDeletions} lines; check nothing still depends on the removed code.`,
      source: "rule",
    });
  }
  return risks;
}

const CODE_EXTENSIONS =
  /\.(m?[jt]sx?|c[jt]s|py|go|rs|rb|java|kt|cs|php|swift|scala|c|cc|cpp|h|hpp)$/;

export interface TestPairing {
  /** Changed, non-test code files. */
  sources: string[];
  /** Changed test files. */
  tests: string[];
  /** Source files with no changed test whose name matches. */
  sourcesWithoutTests: string[];
}

/**
 * Pairs changed source files with changed tests by name (`math.ts` ↔
 * `math.test.ts`, `test_math.py`, `math_test.go`). A cheap signal that the
 * model then judges against the actual patches.
 */
export function pairTests(files: readonly ChangedFile[]): TestPairing {
  const live = files.filter((f) => f.status !== "deleted");
  const tests = live.filter((f) => f.isTest).map((f) => f.path);
  const sources = live
    .filter((f) => !f.isTest && CODE_EXTENSIONS.test(f.path) && !GENERATED(f.path))
    .map((f) => f.path);
  const testStems = new Set(tests.map(testStem));
  return { sources, tests, sourcesWithoutTests: sources.filter((s) => !testStems.has(stem(s))) };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

function testStem(path: string): string {
  return stem(path)
    .replace(/[.-](test|spec)$/, "")
    .replace(/_test$/, "")
    .replace(/^test_/, "");
}
