import type { Agent, Published, Publisher, Review, ReviewInput } from "@pr-review/agent";
import { agentModule } from "./agent-module";
import { loadConfig, type WebConfig } from "./config";
import { DemoLlm } from "./demo-llm";

/** Posts to GitHub when the run targets a PR, otherwise writes a file. */
class RoutingPublisher implements Publisher {
  constructor(
    private readonly file: Publisher,
    private readonly github: Publisher | null,
  ) {}

  publish(review: Review, input: ReviewInput): Promise<Published> {
    if (input.pullRequest === null) return this.file.publish(review, input);
    if (this.github === null)
      throw new Error("GITHUB_TOKEN is not set, so the review can't be posted.");
    return this.github.publish(review, input);
  }
}

// Survives Next.js dev-mode module reloads, so each repo keeps one MCP server process.
const cache = globalThis as unknown as { __prReviewAgents?: Map<string, Promise<Agent>> };

export function getConfig(): WebConfig {
  return loadConfig();
}

/** One agent (one MCP server, one checkpoint DB) per configured repo, created on first use. */
export function getAgent(repo: string, config: WebConfig = getConfig()): Promise<Agent> {
  const path = config.repos.get(repo);
  if (path === undefined) return Promise.reject(new UnknownRepoError(repo));

  cache.__prReviewAgents ??= new Map();
  let agent = cache.__prReviewAgents.get(repo);
  if (agent === undefined) {
    agent = agentModule().then(({ createAgent, FilePublisher, GitHubPublisher }) =>
      createAgent({
        repoTools: { kind: "stdio", repo: path },
        checkpointDb: `${config.dataDir}/${repo}.sqlite`,
        publisher: new RoutingPublisher(
          new FilePublisher(`${config.dataDir}/${repo}`),
          config.githubToken === null ? null : new GitHubPublisher({ token: config.githubToken }),
        ),
        ...(config.demo ? { llm: new DemoLlm() } : {}),
      }),
    );
    agent.catch(() => cache.__prReviewAgents?.delete(repo));
    cache.__prReviewAgents.set(repo, agent);
  }
  return agent;
}

export class UnknownRepoError extends Error {
  constructor(repo: string) {
    super(`Unknown repository: ${repo}`);
  }
}
