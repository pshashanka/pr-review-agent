import { errorResponse, json } from "@/lib/http";
import { resumeReview } from "@/lib/reviews";

/** POST /api/reviews/:id/resume: continue a run that stopped (crash, restart) from its checkpoint. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await resumeReview(id);
    return json({ ok: true }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
