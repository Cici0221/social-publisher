import { requireActor } from "@/server/auth";
import { assertSameOrigin, errorResponse } from "@/server/errors";
import { retryTask } from "@/server/publications";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    await retryTask(await requireActor("ADMIN", "EDITOR"), (await params).id);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
