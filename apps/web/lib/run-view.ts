import type { RunStatus } from "@pr-review/agent";
import type { WebEvent } from "./run-registry";

export const STEPS = [
  ["loadChange", "Load change"],
  ["planReview", "Plan review"],
  ["summarizeDiff", "Summarize diff"],
  ["analyzeFile", "Analyze files"],
  ["checkCoverage", "Check test coverage"],
  ["flagRisks", "Flag risks"],
  ["synthesize", "Write review"],
  ["validateReview", "Validate findings"],
  ["humanApproval", "Your approval"],
  ["postReview", "Publish"],
] as const;

export type StepName = (typeof STEPS)[number][0];

export interface FileView {
  state: "running" | "done" | "failed";
  findings?: number;
  error?: string;
}

/** What the run page renders, derived purely from the event stream. */
export interface RunView {
  status: RunStatus | null;
  live: boolean;
  finished: Partial<Record<StepName, true>>;
  files: Record<string, FileView>;
  /** The latest thinking summary, labelled by step and file. */
  thinking: { label: string; text: string } | null;
  log: string[];
  error: string | null;
}

export const INITIAL_VIEW: RunView = {
  status: null,
  live: false,
  finished: {},
  files: {},
  thinking: null,
  log: [],
  error: null,
};

const MAX_THINKING_CHARS = 1_500;

export function reduceRun(view: RunView, event: WebEvent): RunView {
  switch (event.type) {
    case "snapshot":
      return {
        ...view,
        status: event.status,
        live: event.live,
        ...finishedFromStatus(event.status),
      };
    case "node_finished":
      return { ...view, finished: { ...view.finished, [event.node]: true } };
    case "awaiting_approval":
      return { ...view, status: { state: "awaiting_approval", request: event.request } };
    case "finished":
      return { ...view, status: event.status, live: false };
    case "failed":
      return { ...view, error: event.error, live: false };
    case "progress": {
      const p = event.event;
      switch (p.type) {
        case "status":
          return { ...view, log: [...view.log, p.message] };
        case "tests_run":
          return {
            ...view,
            log: [
              ...view.log,
              `Tests "${p.target}" ${p.passed ? "passed" : "failed"} in ${p.durationMs} ms`,
            ],
          };
        case "file_started":
          return { ...view, files: { ...view.files, [p.path]: { state: "running" } } };
        case "file_done":
          return {
            ...view,
            files: { ...view.files, [p.path]: { state: "done", findings: p.findings } },
          };
        case "file_failed":
          return {
            ...view,
            files: { ...view.files, [p.path]: { state: "failed", error: p.error } },
          };
        case "step_failed":
          return { ...view, log: [...view.log, `✗ ${p.node}: ${p.error}`] };
        case "llm": {
          if (p.progress.type !== "thinking") return view;
          const label = p.path === null ? p.task : `${p.task} · ${p.path}`;
          const previous = view.thinking?.label === label ? view.thinking.text : "";
          const text = (previous + p.progress.delta).slice(-MAX_THINKING_CHARS);
          return { ...view, thinking: { label, text } };
        }
      }
    }
  }
}

/** A snapshot of a paused or finished run implies every earlier step finished. */
function finishedFromStatus(status: RunStatus): Pick<RunView, "finished"> | object {
  const upTo =
    status.state === "awaiting_approval"
      ? "validateReview"
      : status.state === "published"
        ? "postReview"
        : status.state === "rejected"
          ? "humanApproval"
          : null;
  if (upTo === null) return {};
  const index = STEPS.findIndex(([name]) => name === upTo);
  return { finished: Object.fromEntries(STEPS.slice(0, index + 1).map(([name]) => [name, true])) };
}
