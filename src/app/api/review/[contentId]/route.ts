import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";
import { decideReview } from "@/server/reviews";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("REVIEWER");
    const input: unknown = await request.json().catch(() => { throw new AppError("审核请求格式有误。"); });
    const { contentId } = await context.params;
    return Response.json(await decideReview(actor, contentId, input));
  } catch (error) { return errorResponse(error); }
}
