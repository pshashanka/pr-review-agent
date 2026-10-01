import { errorResponse, json } from "@/lib/http";
import { StartReviewSchema, startReview } from "@/lib/reviews";

/** POST /api/reviews  { repo, base, head?, pullRequest? } → { threadId } */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = StartReviewSchema.parse(await request.json());
    return json(await startReview(input), 202);
  } catch (error) {
    return errorResponse(error);
  }
}
