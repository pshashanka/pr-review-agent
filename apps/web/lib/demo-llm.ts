import type { Llm, StructuredRequest, StructuredResult } from "@pr-review/agent";

/**
 * An offline stand-in for Claude, for trying the UI without an API key
 * (PR_REVIEW_DEMO=1). It flags added TODO/console.log lines and otherwise
 * returns canned text. It is clearly labelled in the UI and never used by
 * default.
 */
export class DemoLlm implements Llm {
  readonly model = "demo (offline, no model)";

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    for (const delta of ["Reading the diff… ", "checking edge cases… ", "done."]) {
      await new Promise((r) => setTimeout(r, 120));
      request.onProgress?.({ type: "thinking", delta });
    }
    return {
      output: request.schema.parse(answer(request)),
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCalls: 0,
    };
  }
}

function answer(request: StructuredRequest<unknown>): unknown {
  switch (request.task) {
    case "summarizeDiff":
      return {
        summary: "Demo mode: no model was called. This summary is a placeholder.",
        keyChanges: [],
      };
    case "analyzeFile": {
      const findings = addedLines(request.prompt)
        .filter(({ text }) => /\bTODO\b|console\.log/.test(text))
        .map(({ line, text }) => ({
          line,
          endLine: null,
          severity: "nit",
          category: "maintainability",
          confidence: "medium",
          title: text.includes("TODO") ? "Leftover TODO" : "Leftover console.log",
          body: "Found by the offline demo heuristic.",
          suggestion: null,
        }));
      return { summary: "Reviewed by the demo heuristic.", findings };
    }
    case "checkCoverage": {
      const match = /Source files with no test change of the same name: (.*)/.exec(request.prompt);
      const untested = match?.[1] === undefined || match[1] === "none" ? [] : match[1].split(", ");
      return {
        status: untested.length === 0 ? "adequate" : "partial",
        untestedPaths: untested,
        notes: "Demo mode: based on file names only.",
      };
    }
    case "flagRisks":
      return { risks: [] };
    case "synthesize": {
      const ids = [...request.prompt.matchAll(/^\[([\d.]+)\]/gm)].map((m) => m[1]);
      return {
        summary: "Demo review generated offline. Connect an Anthropic API key for a real review.",
        verdict: ids.length > 0 ? "comment" : "approve",
        findingIds: ids,
      };
    }
  }
}

/** Added lines with their new-file line numbers, from the unified diff in a prompt. */
function addedLines(prompt: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  let line = 0;
  for (const text of prompt.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (header) line = Number(header[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) result.push({ line: line++, text });
    else if (text.startsWith(" ")) line++;
  }
  return result;
}
