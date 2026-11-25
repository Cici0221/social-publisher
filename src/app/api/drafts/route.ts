import { requireActor } from "@/server/auth";
import { createDraft, listDrafts } from "@/server/drafts";
import { assertSameOrigin, errorResponse } from "@/server/errors";

export async function GET() {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    return Response.json(await listDrafts(actor.id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    return Response.json(await createDraft(actor.id), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
