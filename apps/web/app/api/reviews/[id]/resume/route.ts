import { errorResponse, guardRequest, json } from "@/lib/http";
import { resumeReview } from "@/lib/reviews";

/** POST /api/reviews/:id/resume: continue a run that stopped (crash, restart) from its checkpoint. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = guardRequest(request, { mutating: true, body: false });
  if (guard !== null) return guard;
  try {
    const { id } = await params;
    await resumeReview(id);
    return json({ ok: true }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
