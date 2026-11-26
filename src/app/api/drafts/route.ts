import { requireActor } from "@/server/auth";
import { createDraft, draftPageNumber, listDrafts } from "@/server/drafts";
import { assertSameOrigin, errorResponse } from "@/server/errors";

export async function GET(request: Request) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    const page = draftPageNumber(new URL(request.url).searchParams.get("page"));
    const { drafts, hasMore } = await listDrafts(actor.id, page);
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    if (page > 1) headers.append("Link", `</api/drafts?page=${page - 1}>; rel="prev"`);
    if (hasMore) headers.append("Link", `</api/drafts?page=${page + 1}>; rel="next"`);
    return Response.json(drafts, { headers });
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
