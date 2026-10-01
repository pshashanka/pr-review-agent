import { createRequire } from "node:module";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Local copies of the mcp-repo-tools output schemas this agent relies on.
// Parsing at the boundary turns a contract change in the server into a clear
// error here. Objects aren't strict, so new server fields are ignored.

const FileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
]);

export const ChangedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: FileStatusSchema,
  additions: z.number(),
  deletions: z.number(),
  isBinary: z.boolean(),
  isTest: z.boolean(),
});

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

const ListChangedFilesSchema = z.object({
  base: z.string(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  files: z.array(ChangedFileSchema),
});

export type ChangeSet = z.infer<typeof ListChangedFilesSchema>;

const GetDiffSchema = z.object({
  base: z.string(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().nullable(),
      status: FileStatusSchema,
      patch: z.string(),
      patchOmitted: z.enum(["binary", "denied", "size_limit"]).nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export type Diff = z.infer<typeof GetDiffSchema>;

const RunTestsSchema = z.object({
  target: z.string(),
  passed: z.boolean(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export type TestRun = z.infer<typeof RunTestsSchema>;

export type RepoToolsConnection =
  | {
      kind: "stdio";
      repo: string;
      /** mcp-repo-tools config file; needed for run_tests targets. */
      config?: string | undefined;
      allowRunTests?: boolean | undefined;
    }
  | { kind: "http"; url: string; token?: string | undefined };

/** The server answered with a tool error (`CODE: message`). Not retryable. */
export class RepoToolError extends Error {
  override readonly name = "RepoToolError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The server couldn't be reached or the connection broke. Worth retrying. */
export class RepoToolTransportError extends Error {
  override readonly name = "RepoToolTransportError";
}

/** Typed client for the mcp-repo-tools server. */
export class RepoTools {
  private constructor(
    private readonly client: Client,
    readonly toolNames: ReadonlySet<string>,
  ) {}

  static async connect(connection: RepoToolsConnection): Promise<RepoTools> {
    const client = new Client({ name: "pr-review-agent", version: "0.1.0" });
    try {
      await client.connect(createTransport(connection));
    } catch (error) {
      throw new RepoToolTransportError(`Couldn't connect to mcp-repo-tools: ${String(error)}`, {
        cause: error,
      });
    }
    const { tools } = await client.listTools();
    return new RepoTools(client, new Set(tools.map((t) => t.name)));
  }

  listChangedFiles(input: { base: string; head: string }): Promise<ChangeSet> {
    return this.callTyped("list_changed_files", input, ListChangedFilesSchema);
  }

  getDiff(input: {
    base: string;
    head: string;
    paths?: string[];
    maxBytes?: number;
  }): Promise<Diff> {
    return this.callTyped("get_diff", input, GetDiffSchema);
  }

  runTests(input: { target: string; args?: string[] }): Promise<TestRun> {
    return this.callTyped("run_tests", input, RunTestsSchema);
  }

  /** The named server tools as Anthropic tool definitions, in a stable order (for caching). */
  async anthropicTools(names: readonly string[]): Promise<Anthropic.Beta.BetaTool[]> {
    const { tools } = await this.client.listTools();
    return names.flatMap((name) => {
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) return [];
      return [
        {
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          input_schema: tool.inputSchema,
        },
      ];
    });
  }

  /**
   * Runs a tool on the model's behalf and returns the text to send back as a
   * tool_result. Tool errors become `isError` results so the model can adjust;
   * only transport failures throw. The server validates the model's input.
   */
  async callForModel(name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
    const result = await this.callRaw(name, input);
    return { text: textOf(result), isError: result.isError === true };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async callTyped<T>(name: string, input: object, schema: z.ZodType<T>): Promise<T> {
    const result = await this.callRaw(name, input);
    if (result.isError === true) throw toolError(textOf(result));
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new RepoToolError(
        "CONTRACT",
        `${name} returned unexpected output: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  private async callRaw(name: string, input: unknown): Promise<CallToolResult> {
    try {
      return (await this.client.callTool({
        name,
        arguments: input as Record<string, unknown>,
      })) as CallToolResult;
    } catch (error) {
      throw new RepoToolTransportError(`mcp-repo-tools ${name} failed: ${String(error)}`, {
        cause: error,
      });
    }
  }
}

function createTransport(connection: RepoToolsConnection): Transport {
  if (connection.kind === "http") {
    const headers: Record<string, string> =
      connection.token === undefined ? {} : { Authorization: `Bearer ${connection.token}` };
    return new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers } });
  }

  const serverEntry = createRequire(import.meta.url).resolve("mcp-repo-tools/dist/index.js");
  const args = [serverEntry, "--repo", connection.repo];
  if (connection.config !== undefined) args.push("--config", connection.config);
  if (connection.allowRunTests === true) args.push("--allow-run-tests");
  return new StdioClientTransport({ command: process.execPath, args, stderr: "ignore" });
}

function textOf(result: CallToolResult): string {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** mcp-repo-tools errors are `CODE: message`; schema rejections come from the SDK. */
function toolError(text: string): RepoToolError {
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(text);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return new RepoToolError(match[1], match[2]);
  }
  return new RepoToolError("INVALID_INPUT", text);
}
