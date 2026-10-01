import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { requireValue } from "./require.js";

export function postReview({ publisher }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const review = requireValue(state.review, "review");
    const published = await publisher.publish(review, state.input);
    emit(config, {
      type: "status",
      node: "postReview",
      message: published.alreadyPosted
        ? `Already posted at ${published.location}`
        : `Posted to ${published.location}`,
    });
    return { published };
  };
}
