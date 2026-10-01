import type { Finding } from "./schema.js";

/**
 * Head-side ("RIGHT") line numbers that appear in a unified diff, grouped by
 * hunk. GitHub only accepts inline comments on these lines, and a multi-line
 * comment must stay inside one hunk.
 */
export interface DiffLines {
  hunks: Set<number>[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffLines {
  const hunks: Set<number>[] = [];
  let current: Set<number> | null = null;
  let line = 0;

  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      line = Number(header[1]);
      current = new Set();
      hunks.push(current);
      continue;
    }
    if (current === null) continue; // file headers before the first hunk
    if (text.startsWith("+") || text.startsWith(" ")) {
      current.add(line);
      line++;
    }
    // "-" lines exist only on the base side; "\ No newline" lines are markers.
  }
  return { hunks };
}

/** The patch for each changed file, or null if the diff tool omitted it (binary, denied, size). */
export type PatchIndex = ReadonlyMap<string, string | null>;

export interface AnchorResult {
  kept: Finding[];
  rejected: { finding: Finding; reason: string }[];
}

/**
 * Checks every finding against the actual diff. Findings on files that aren't
 * in the change are rejected (the model made them up). Findings on lines
 * outside the diff are kept but not inline, so they go in the review body.
 */
export function anchorFindings(findings: readonly Finding[], patches: PatchIndex): AnchorResult {
  const parsed = new Map<string, DiffLines | null>();
  const linesFor = (path: string) => {
    if (!parsed.has(path)) {
      const patch = patches.get(path) ?? null;
      parsed.set(path, patch === null ? null : parsePatch(patch));
    }
    return parsed.get(path) ?? null;
  };

  const result: AnchorResult = { kept: [], rejected: [] };
  for (const finding of findings) {
    if (!patches.has(finding.path)) {
      result.rejected.push({ finding, reason: "file is not part of the change" });
      continue;
    }

    const hunk = linesFor(finding.path)?.hunks.find((h) => h.has(finding.line));
    if (hunk === undefined) {
      result.kept.push({ ...finding, inline: false, endLine: null });
      continue;
    }

    const endLine =
      finding.endLine !== null && finding.endLine > finding.line && hunk.has(finding.endLine)
        ? finding.endLine
        : null;
    result.kept.push({ ...finding, inline: true, endLine });
  }
  return result;
}
