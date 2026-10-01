import { describe, expect, it } from "vitest";
import { INITIAL_VIEW, reduceRun } from "@/lib/run-view";
import type { WebEvent } from "@/lib/run-registry";

const run = (events: WebEvent[]) => events.reduce(reduceRun, INITIAL_VIEW);

describe("reduceRun", () => {
  it("tracks finished steps and per-file progress", () => {
    const view = run([
      { type: "snapshot", status: { state: "running", next: [] }, live: true },
      { type: "node_finished", node: "loadChange" },
      { type: "progress", event: { type: "file_started", path: "a.ts" } },
      { type: "progress", event: { type: "file_started", path: "b.ts" } },
      { type: "progress", event: { type: "file_done", path: "a.ts", findings: 2 } },
      { type: "progress", event: { type: "file_failed", path: "b.ts", error: "refused" } },
    ]);

    expect(view.finished).toEqual({ loadChange: true });
    expect(view.files).toEqual({
      "a.ts": { state: "done", findings: 2 },
      "b.ts": { state: "failed", error: "refused" },
    });
    expect(view.live).toBe(true);
  });

  it("accumulates thinking per step and file, and resets when the label changes", () => {
    const thinking = (path: string | null, delta: string): WebEvent => ({
      type: "progress",
      event: { type: "llm", task: "analyzeFile", path, progress: { type: "thinking", delta } },
    });

    expect(run([thinking("a.ts", "Look"), thinking("a.ts", "ing")]).thinking).toEqual({
      label: "analyzeFile · a.ts",
      text: "Looking",
    });
    expect(run([thinking("a.ts", "Looking"), thinking("b.ts", "Other")]).thinking?.text).toBe(
      "Other",
    );
  });

  it("marks earlier steps finished when a snapshot shows the run paused or done", () => {
    const view = run([
      {
        type: "snapshot",
        status: { state: "rejected", review: {} as never, reason: "no" },
        live: false,
      },
    ]);

    expect(view.finished.humanApproval).toBe(true);
    expect(view.finished.postReview).toBeUndefined();
  });

  it("records failures and stops being live", () => {
    const view = run([
      { type: "snapshot", status: { state: "running", next: [] }, live: true },
      { type: "failed", error: "boom" },
    ]);

    expect(view).toMatchObject({ error: "boom", live: false });
  });
});
