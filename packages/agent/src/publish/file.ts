import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Publisher } from "../graph/deps.js";
import type { Published } from "../graph/state.js";
import { renderInlineComment, renderReviewBody } from "../review/render-markdown.js";
import type { Review } from "../review/schema.js";

/**
 * Writes the review as Markdown (what a human reads) and JSON (what tools
 * read), named by head SHA. An existing file for the same head isn't
 * overwritten, which makes publishing idempotent.
 */
export class FilePublisher implements Publisher {
  constructor(private readonly directory: string) {}

  async publish(review: Review): Promise<Published> {
    const base = join(resolve(this.directory), `review-${review.meta.head.slice(0, 12)}`);
    const location = `${base}.md`;
    if (await exists(location)) return { kind: "file", location, alreadyPosted: true };

    await mkdir(this.directory, { recursive: true });
    const inline = review.findings
      .filter((f) => f.inline)
      .map((f) => `### \`${f.path}:${f.line}\`\n\n${renderInlineComment(f)}`);
    const markdown = [renderReviewBody(review), ...inline].join("\n\n---\n\n");
    await writeFile(`${base}.json`, `${JSON.stringify(review, null, 2)}\n`);
    await writeFile(location, `${markdown}\n`, { flag: "wx" });
    return { kind: "file", location, alreadyPosted: false };
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}
