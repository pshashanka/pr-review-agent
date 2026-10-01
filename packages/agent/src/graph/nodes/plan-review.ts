import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { pairTests, selectFiles } from "../../review/rules.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { requireValue } from "./require.js";

/**
 * Picks the files to review and fetches their patches. One diff call covers
 * the whole change; files that didn't fit its budget are fetched one by one,
 * and any that still don't fit are skipped as too large.
 */
export function planReview({ tools, options }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = requireValue(state.change, "change");
    const range = { base: change.base, head: change.head };
    const selection = selectFiles(change.files, options.maxFiles);

    const diff = await tools.getDiff(range);
    const patches: Record<string, string | null> = {};
    for (const file of diff.files)
      patches[file.path] = file.patchOmitted === null ? file.patch : null;

    const omitted = new Map(diff.files.map((f) => [f.path, f.patchOmitted]));
    const files = [];
    const skipped = [...selection.skipped];
    for (const file of selection.files) {
      let reason = omitted.get(file.path) ?? null;
      if (reason === "size_limit") {
        const single = await tools.getDiff({ ...range, paths: [file.path] });
        const entry = single.files[0];
        if (entry !== undefined && entry.patchOmitted === null) {
          patches[file.path] = entry.patch;
          reason = null;
        }
      }
      if (reason === null) files.push(file);
      else
        skipped.push({
          path: file.path,
          reason: reason === "denied" ? "hidden by repo policy" : "diff too large",
        });
    }

    emit(config, {
      type: "status",
      node: "planReview",
      message: `Reviewing ${files.length} files, skipping ${skipped.length}`,
    });
    return { plan: { files, skipped, patches, pairing: pairTests(change.files) } };
  };
}
