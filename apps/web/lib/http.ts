import { z } from "zod";
import { getConfig, UnknownRepoError } from "./agents";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Lowercases a Host header value and strips the port, handling bracketed IPv6. */
function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    // Bracketed IPv6, optionally with a port: "[::1]:3000".
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.lastIndexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

/** Parses an Origin header into a lowercased `host`, or null if it can't be trusted. */
function parseOriginHost(origin: string): string | null {
  if (origin === "null") return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Guards API route handlers against cross-site requests and DNS rebinding.
 *
 * Checks the Host header against an allowlist for every request, and, for
 * mutating requests, that the body is JSON and the request isn't cross-site
 * (by Origin and Sec-Fetch-Site). Returns a Response to send, or null if the
 * request is OK to handle.
 */
export function guardRequest(
  request: Request,
  { mutating, body = true }: { mutating: boolean; body?: boolean },
): Response | null {
  const hostHeader = request.headers.get("host") ?? new URL(request.url).host;
  const host = hostnameOf(hostHeader);
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", ...getConfig().allowedHosts]);
  if (!allowed.has(host)) return json({ error: "Host not allowed" }, 403);

  if (mutating) {
    if (body) {
      const contentType = request.headers.get("content-type") ?? "";
      const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return json({ error: "Content-Type must be application/json" }, 415);
      }
    }

    const origin = request.headers.get("origin");
    if (origin !== null) {
      // "null" is sent by sandboxed iframes and some redirects; it never
      // matches a real Host, and a malformed Origin can't be trusted either.
      const originHost = parseOriginHost(origin);
      if (originHost === null || originHost !== hostHeader.trim().toLowerCase()) {
        return json({ error: "Cross-origin request refused" }, 403);
      }
    }

    const secFetchSite = request.headers.get("sec-fetch-site");
    if (secFetchSite !== null && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return json({ error: "Cross-origin request refused" }, 403);
    }
  }

  return null;
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
