export interface WebConfig {
  /** Repositories this server may review, by name. The browser only ever sends a name. */
  repos: ReadonlyMap<string, string>;
  /** Checkpoints and file-published reviews go here. */
  dataDir: string;
  /** Use the canned offline model instead of Claude. */
  demo: boolean;
  githubToken: string | null;
  /** Extra Host header values (name, no port) the API will accept besides localhost. */
  allowedHosts: string[];
}

/**
 * Reads configuration from the environment:
 *   PR_REVIEW_REPOS="calc=/path/to/calc,api=/path/to/api"
 *   PR_REVIEW_DATA=.pr-review   PR_REVIEW_DEMO=1   GITHUB_TOKEN=...
 *   PR_REVIEW_ALLOWED_HOSTS="review.example.com,review.lan"
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const repos = new Map<string, string>();
  for (const entry of (env["PR_REVIEW_REPOS"] ?? "").split(",")) {
    const [name, path] = entry.split("=").map((s) => s.trim());
    if (name === undefined || name === "" || path === undefined || path === "") continue;
    if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid repo name in PR_REVIEW_REPOS: ${name}`);
    repos.set(name, path);
  }
  const allowedHosts = (env["PR_REVIEW_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  return {
    repos,
    // Kept as given; relative paths resolve against the server's working directory.
    dataDir: env["PR_REVIEW_DATA"] ?? ".pr-review",
    demo: env["PR_REVIEW_DEMO"] === "1",
    githubToken: env["GITHUB_TOKEN"] || null,
    allowedHosts,
  };
}
