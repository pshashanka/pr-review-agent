import Anthropic from "@anthropic-ai/sdk";
import { RepoToolTransportError } from "../../mcp/repo-tools.js";

/**
 * Errors worth retrying: the MCP server connection broke, or the Anthropic API
 * was unreachable or overloaded even after the SDK's own retries.
 */
export function isTransient(error: unknown): boolean {
  return (
    error instanceof RepoToolTransportError ||
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError
  );
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
