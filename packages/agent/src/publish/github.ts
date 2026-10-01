import { z } from "zod";
import type { Publisher } from "../graph/deps.js";
import type { Published, PullRequestRef, ReviewInput } from "../graph/state.js";
import { renderInlineComment, renderReviewBody, reviewMarker } from "../review/render-markdown.js";
import type { Review, Verdict } from "../review/schema.js";

/** A pull request ref (`owner/repo#123`), validated against GitHub's own naming rules. */
export const PullRequestRefSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .refine((repo) => repo !== "." && repo !== "..", "Repo name can't be . or .."),
  number: z.number().int().positive(),
});

export interface GitHubPublisherOptions {
  token: string;
  /** For GitHub Enterprise. */
  apiUrl?: string;
  /**
   * Submit the verdict as a real APPROVE / REQUEST_CHANGES review. Off by
   * default: the agent comments, and humans own the merge decision.
   */
  submitVerdict?: boolean;
  fetch?: typeof fetch;
}

const EVENTS: Record<Verdict, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

/**
 * Posts the review to a pull request. Inline comments are pinned to the
 * reviewed commit (`commit_id`), so line numbers stay correct even if the PR
 * has moved on. A hidden marker in the body makes retries idempotent.
 */
export class GitHubPublisher implements Publisher {
  readonly #token: string;
  readonly #apiUrl: string;
  readonly #submitVerdict: boolean;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubPublisherOptions) {
    this.#token = options.token;
    this.#apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#submitVerdict = options.submitVerdict ?? false;
    this.#fetch = options.fetch ?? fetch;
  }

  async publish(review: Review, input: ReviewInput): Promise<Published> {
    const pr = input.pullRequest;
    if (pr === null) throw new Error("GitHubPublisher needs a pull request to post to.");
    // encodeURIComponent is defence in depth: callers should validate with
    // PullRequestRefSchema before this point.
    const owner = encodeURIComponent(pr.owner);
    const repo = encodeURIComponent(pr.repo);
    const reviewsUrl = `${this.#apiUrl}/repos/${owner}/${repo}/pulls/${pr.number}/reviews`;

    const existing = await this.#findExisting(reviewsUrl, reviewMarker(review.meta.head));
    if (existing !== null) return { kind: "github", location: existing, alreadyPosted: true };

    const comments = review.findings
      .filter((f) => f.inline)
      .map((f) => ({
        path: f.path,
        side: "RIGHT",
        line: f.endLine ?? f.line,
        ...(f.endLine === null ? {} : { start_line: f.line, start_side: "RIGHT" }),
        body: renderInlineComment(f),
      }));
    const created = await this.#request<{ html_url: string }>(reviewsUrl, {
      method: "POST",
      body: JSON.stringify({
        commit_id: review.meta.head,
        body: renderReviewBody(review),
        event: this.#submitVerdict ? EVENTS[review.verdict] : "COMMENT",
        comments,
      }),
    });
    return { kind: "github", location: created.html_url, alreadyPosted: false };
  }

  async #findExisting(reviewsUrl: string, marker: string): Promise<string | null> {
    for (let page = 1; page <= 10; page++) {
      const reviews = await this.#request<{ body: string | null; html_url: string }[]>(
        `${reviewsUrl}?per_page=100&page=${page}`,
      );
      const match = reviews.find((r) => r.body?.includes(marker) === true);
      if (match !== undefined) return match.html_url;
      if (reviews.length < 100) return null;
    }
    return null;
  }

  async #request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `GitHub API ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${response.status} ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }
}

/** Parses `owner/repo#123`. */
export function parsePullRequestRef(text: string): PullRequestRef {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text);
  const parsed =
    match?.[1] === undefined || match[2] === undefined || match[3] === undefined
      ? null
      : PullRequestRefSchema.safeParse({
          owner: match[1],
          repo: match[2],
          number: Number(match[3]),
        });
  if (parsed === null || !parsed.success) {
    throw new Error(`Expected a pull request like owner/repo#123, got ${JSON.stringify(text)}`);
  }
  return parsed.data;
}
