import { requireActor } from "@/server/auth";
import { assertSameOrigin, errorResponse } from "@/server/errors";
import { copyHistory } from "@/server/history";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const result = await copyHistory(actor, (await params).id);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
