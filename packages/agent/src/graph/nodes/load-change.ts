import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";

/** Resolves the refs once; every later step uses the pinned SHAs. */
export function loadChange({ tools }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = await tools.listChangedFiles({ base: state.input.base, head: state.input.head });
    emit(config, {
      type: "status",
      node: "loadChange",
      message: `${change.files.length} files changed, head ${change.head.slice(0, 12)}`,
    });
    return { change };
  };
}
