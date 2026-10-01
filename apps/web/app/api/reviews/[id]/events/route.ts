import { errorResponse } from "@/lib/http";
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
  let id: string;
  let status;
  try {
    id = (await params).id;
    ({ status } = await loadThread(id));
  } catch (error) {
    return errorResponse(error);
  }

  const registry = getRegistry();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: WebEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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

      send({ type: "snapshot", status, live: registry.isLive(id) });
      const unsubscribe = registry.subscribe(id, { onEvent: send, onClose: close });
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
