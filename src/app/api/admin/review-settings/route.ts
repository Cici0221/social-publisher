import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";
import { setReviewRequired } from "@/server/reviews";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN");
    const input: unknown = await request.json().catch(() => { throw new AppError("审核设置格式有误。"); });
    return Response.json(await setReviewRequired(actor, input));
  } catch (error) { return errorResponse(error); }
}
