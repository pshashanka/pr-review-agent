import { errorResponse, guardRequest, json } from "@/lib/http";
import { loadThread } from "@/lib/reviews";
import { getRegistry } from "@/lib/run-registry";

/** GET /api/reviews/:id → current status from the checkpoint. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = guardRequest(request, { mutating: false });
  if (guard !== null) return guard;
  try {
    const { id } = await params;
    const { status } = await loadThread(id);
    return json({ status, live: getRegistry().isLive(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
