import { z } from "zod";
import { UnknownRepoError } from "./agents";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Maps errors to responses. Unexpected errors are logged, not echoed. */
export function errorResponse(error: unknown): Response {
  // Matched by name too: errors from the agent come from its own copy of zod.
  if (error instanceof z.ZodError || (error instanceof Error && error.name === "ZodError")) {
    return json({ error: "Invalid request", issues: (error as z.ZodError).issues }, 400);
  }
  if (error instanceof UnknownRepoError) return json({ error: error.message }, 404);
  if (error instanceof ConflictError) return json({ error: error.message }, 409);
  console.error("[pr-review-web]", error);
  return json({ error: "Internal error" }, 500);
}

export class ConflictError extends Error {}
