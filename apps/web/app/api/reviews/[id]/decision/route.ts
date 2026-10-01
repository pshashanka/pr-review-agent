import { agentModule } from "@/lib/agent-module";
import { errorResponse, guardRequest, json } from "@/lib/http";
import { decideReview } from "@/lib/reviews";

/** POST /api/reviews/:id/decision  { action: "approve" | "edit" | "reject", ... } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = guardRequest(request, { mutating: true });
  if (guard !== null) return guard;
  try {
    const { id } = await params;
    const { ReviewDecisionSchema } = await agentModule();
    await decideReview(id, ReviewDecisionSchema.parse(await request.json()));
    return json({ ok: true }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
