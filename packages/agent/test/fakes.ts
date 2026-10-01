import type { Llm, LlmTask, StructuredRequest, StructuredResult } from "../src/llm/llm.js";
import type { Publisher } from "../src/graph/deps.js";
import type { Published, ReviewInput } from "../src/graph/state.js";
import type { Review } from "../src/review/schema.js";

type Handler = (request: StructuredRequest<unknown>) => unknown;

/**
 * An Llm that answers each task from a script. A handler may return the
 * output, throw, or use `request.tools` to drive the real tool path.
 */
export class ScriptedLlm implements Llm {
  readonly model = "scripted-model";
  readonly calls: StructuredRequest<unknown>[] = [];

  constructor(private readonly handlers: Partial<Record<LlmTask, Handler>>) {}

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(request);
    const handler = this.handlers[request.task];
    if (handler === undefined) throw new Error(`No scripted answer for ${request.task}`);
    const output = request.schema.parse(await handler(request));
    return {
      output,
      model: this.model,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 },
      toolCalls: 0,
    };
  }

  callsFor(task: LlmTask): StructuredRequest<unknown>[] {
    return this.calls.filter((c) => c.task === task);
  }
}

export class MemoryPublisher implements Publisher {
  readonly posted: { review: Review; input: ReviewInput }[] = [];

  publish(review: Review, input: ReviewInput): Promise<Published> {
    const alreadyPosted = this.posted.some((p) => p.review.meta.head === review.meta.head);
    if (!alreadyPosted) this.posted.push({ review, input });
    return Promise.resolve({
      kind: "file",
      location: `memory://${review.meta.head}`,
      alreadyPosted,
    });
  }
}
