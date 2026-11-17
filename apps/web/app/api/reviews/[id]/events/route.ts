import { errorResponse, guardRequest } from "@/lib/http";
import { loadThread } from "@/lib/reviews";
import { getRegistry, type WebEvent } from "@/lib/run-registry";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/reviews/:id/events (Server-Sent Events).
 *
 * Sends a snapshot of the checkpointed status, then, if a run is live in this
 * process, replays its buffered events and streams new ones until it ends.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = guardRequest(request, { mutating: false });
  if (guard !== null) return guard;
  let id: string;
  let status;
  try {
    id = (await params).id;
    ({ status } = await loadThread(id));
  } catch (error) {
    return errorResponse(error);
  }

  const registry = getRegistry();
  const lastEventId = parseLastEventId(request.headers.get("last-event-id"));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // The snapshot is (re)sent on every connection without an id, so it is
      // never deduplicated by Last-Event-ID; buffered events carry ids.
      const send = (event: WebEvent, id: number | null) => {
        if (closed) return;
        const lines = id === null ? [] : [`id: ${id}`];
        lines.push(`data: ${JSON.stringify(event)}`);
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        controller.close();
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, HEARTBEAT_MS);

      // Tell EventSource to retry a dropped connection after ~1s instead of the
      // browser default, so mid-run drops recover while the run is still live.
      controller.enqueue(encoder.encode("retry: 1000\n\n"));

      send({ type: "snapshot", status, live: registry.isLive(id) }, null);
      const unsubscribe = registry.subscribe(
        id,
        { onEvent: (eventId, event) => send(event, eventId), onClose: close },
        lastEventId,
      );
      if (unsubscribe === null) close();
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Parses a Last-Event-ID header; absent or malformed means "from the start". */
function parseLastEventId(value: string | null): number {
  if (value === null) return 0;
  const id = Number(value);
  return Number.isFinite(id) && id >= 0 ? Math.floor(id) : 0;
}
