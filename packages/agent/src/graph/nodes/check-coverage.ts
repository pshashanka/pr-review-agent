import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SYSTEM, renderPatches, reviewContext } from "../../llm/prompts.js";
import { keepWithinBytes } from "../../llm/text.js";
import { CoverageSchema } from "../../review/schema.js";
import { emit, type ReviewDeps } from "../deps.js";
import type { State, Update } from "../state.js";
import { requireValue } from "./require.js";

const TEST_OUTPUT_BYTES = 8_000;

/**
 * Combines three signals: which sources have matching test changes (by name),
 * an optional real test run, and the model's reading of source vs test diffs.
 */
export function checkCoverage({ tools, llm, options }: ReviewDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const change = requireValue(state.change, "change");
    const plan = requireValue(state.plan, "plan");
    const { pairing } = plan;

    if (pairing.sources.length === 0) {
      return {
        coverage: {
          status: "not_applicable",
          untestedPaths: [],
          notes: "No source code changed, so there is nothing to test.",
        },
      };
    }

    let testRun = "Tests were not run.";
    if (options.testTarget !== null && tools.toolNames.has("run_tests")) {
      const run = await tools.runTests({ target: options.testTarget });
      emit(config, {
        type: "tests_run",
        target: run.target,
        passed: run.passed,
        durationMs: run.durationMs,
      });
      const output = keepWithinBytes(run.stdout + run.stderr, TEST_OUTPUT_BYTES).text;
      testRun = `Test run "${run.target}": ${run.passed ? "passed" : run.timedOut ? "timed out" : `failed (exit ${run.exitCode ?? "?"})`}.\n<test_output>\n${output}\n</test_output>`;
    }

    const result = await llm.structured({
      task: "checkCoverage",
      system: SYSTEM.checkCoverage,
      context: reviewContext(change, plan),
      prompt: [
        `Changed source files: ${list(pairing.sources)}`,
        `Changed test files: ${list(pairing.tests)}`,
        `Source files with no test change of the same name: ${list(pairing.sourcesWithoutTests)}`,
        testRun,
        "",
        renderPatches(plan, [...pairing.sources, ...pairing.tests], options.promptDiffBytes),
      ].join("\n"),
      schema: CoverageSchema,
      onProgress: (progress) => {
        emit(config, { type: "llm", task: "checkCoverage", path: null, progress });
      },
    });
    return { coverage: result.output, usage: result.usage, model: result.model };
  };
}

function list(paths: readonly string[]): string {
  return paths.length === 0 ? "none" : paths.join(", ");
}
