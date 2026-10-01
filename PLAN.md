# PLAN — pr-review-agent

Repo 2 of 3 in the code-review portfolio. A LangGraph.js agent that reviews a PR through
mcp-repo-tools, checkpoints to SQLite, pauses for human approval and then publishes (to a file or
GitHub). It comes with a CLI and a Next.js UI.

This plan was written after the fact (2026-09-30): tasks 1–11 were built before the lead/builder
workflow was adopted. Statuses: `todo` · `in progress` · `done` · `blocked`.

## Tasks

| #   | Task                                                                     | Commit    | Status  |
| --- | ------------------------------------------------------------------------ | --------- | ------- |
| 1   | Scaffold: pnpm workspace, agent package, lint, CI                        | `2230938` | done    |
| 2   | Review schema, diff-line anchoring, markdown rendering                   | `b1b0b09` | done    |
| 3   | Typed MCP client for mcp-repo-tools                                      | `2a39944` | done    |
| 4   | Claude client: structured outputs, bounded tool loop, prompt caching     | `cfaf9a9` | done    |
| 5   | Graph state and deterministic review rules                               | `01e12c8` | done    |
| 6   | Review graph: fan-out, approval interrupt, retry and resume              | `29e5b53` | done    |
| 7   | Publishers (file, GitHub), runner API, `pr-review` CLI                   | `b395ce0` | done    |
| 8   | Next.js API: start, SSE events, decision, resume                         | `2652872` | done    |
| 9   | Web UI: live timeline and approval panel                                 | `bab8146` | done    |
| 10  | Live eval: 3 planted-bug PRs and 1 clean control                         | `0d2e486` | done    |
| 11  | README; CI builds before lint                                            | `92e28bb` | done    |
| 12  | First live run: CLI and `pnpm eval` with a real ANTHROPIC_API_KEY        | —         | blocked |
| 13  | Lead quality-gate audit of tasks 1–11                                    | —         | done    |
| 14a | Zero reviewable files: graph never reaches synthesize                    | —         | done    |
| 14b | Tool loop: handle mid-output server-side fallback correctly              | —         | done    |
| 14c | Web/API hardening: Host/Origin/CSRF guard, PR ref validation             | —         | done    |
| 14d | Whole-change step failures degrade the review instead of killing the run | —         | done    |

Task 12 is blocked because there is no API key on the dev machine. Until it runs, the Claude
request shape is verified only against a scripted fake of the SDK stream.

## Key decisions

- **LangGraph for orchestration, the Anthropic SDK directly for model calls** (structured outputs,
  per-step effort, cache breakpoints, refusal fallbacks, typed errors), not `@langchain/anthropic`.
- **Deterministic where possible**: planning, file skipping, rule-based risks, test pairing,
  anchoring and validation are code. The model handles summary, per-file analysis, coverage
  judgement, semantic risks and synthesis.
- **One bounded tool loop**: only `analyzeFile` calls tools (`read_file`, `search_code`), with a
  round cap.
- **The model curates, it doesn't invent**: synthesis selects finding IDs. Human edits can reword or
  drop findings but not add them. `validateReview` drops unknown IDs and downgrades `approve` when a
  blocker or major finding remains.
- **Two failure classes**: per-file failures go to `fileErrors` and the run continues. Transient
  failures get node retries, then stop at the checkpoint. On resume, completed fan-out tasks are
  kept.
- **Thread ID = target + head SHA**. Publishing is idempotent through a hidden marker.
- **Cache-stable request order**: tools → frozen system prompt → per-run context block → per-call
  content.
- **Human owns the merge**: a real `interrupt()`; the resume value is Zod-validated; GitHub posting
  defaults to COMMENT.
- **The PR is an attack surface**: the defence is structural (read-only MCP tools, no token in
  model context, anchored findings, human gate), not just prompt text.
- **Dependency on repo 1**: an exact tarball URL, pinned under `allowBuilds` in
  `pnpm-workspace.yaml`.

## Open items

- Task 12 (needs a key).
- Multi-instance runs (queue + worker) and the Postgres checkpointer: documented, not built.

## Audit (task 13, 2026-09-30)

Baseline: lint, format, typecheck and tests (61 agent + 13 web) all green. Tests fake only the LLM
(and GitHub); the graph, MCP server and SQLite checkpointer are real. The request shape was checked
against the current API reference: `claude-opus-5`, adaptive thinking, `output_config.effort` and
format, and `fallbacks: "default"` with the `-2026-07-01` beta are all current.

Findings:

1. **Zero reviewable files → no review, stuck "running" (14a, high, reproduced).** `synthesize`
   joins on `["analyzeFile", …]`. When the plan has no files (lockfile-only, `.env`-only, every file
   denied or skipped), `analyzeFile` never runs, so the join never fires. `getStatus` then reports
   `running` forever in both the CLI and the web UI. Verified fix: `defer: true` on `synthesize`
   with single edges from each branch.
2. **Mid-output fallback echoed wrongly (14b, medium).** After a mid-output fallback, the API
   requires dropping `thinking`, `redacted_thinking` and `tool_use` blocks before the last
   `fallback` block. The loop echoes everything and would _execute_ tool calls from the model that
   declined.
3. **Web API has no CSRF/Origin/Host protection (14c, medium-high).** `request.json()` accepts
   `text/plain`, so any page the user visits can approve a pending review (publishing with the
   server's GITHUB_TOKEN) or start paid runs. DNS rebinding also works, because Host isn't checked.
4. **PR owner/repo not validated (14c, low-medium).** The web schema accepts any string, and the CLI
   regex allows `..`. Both end up in a token-bearing GitHub API URL.
5. **A refusal or tool error in summarize/coverage/risks kills the whole run (14d, medium).** These
   errors aren't transient, so the node fails, and resume replays the same failure. Per-file
   failures already degrade gracefully; whole-change steps should too (synthesize stays fatal).

Noted, not scheduled:

- Every `Send` payload carries the full `change` and `plan` (all patches), so checkpoints grow by
  about N × the patch size.
- GitHub 422 on an unresolvable inline line fails the whole post (no body-only fallback).
- CLI `--max-files abc` becomes NaN. MCP server stderr is discarded (`stderr: "ignore"`).
