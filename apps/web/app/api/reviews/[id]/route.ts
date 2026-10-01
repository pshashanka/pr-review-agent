import { errorResponse, json } from "@/lib/http";
import { loadThread } from "@/lib/reviews";
import { getRegistry } from "@/lib/run-registry";

/** GET /api/reviews/:id → current status from the checkpoint. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const { status } = await loadThread(id);
    return json({ status, live: getRegistry().isLive(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
