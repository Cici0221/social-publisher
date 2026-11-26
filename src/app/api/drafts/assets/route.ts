import { requireActor } from "@/server/auth";
import { draftPageNumber, listEditorAssets } from "@/server/drafts";
import { errorResponse } from "@/server/errors";

export async function GET(request: Request) {
  try {
    await requireActor("ADMIN", "EDITOR");
    const params = new URL(request.url).searchParams;
    const result = await listEditorAssets(draftPageNumber(params.get("page")), params.get("q") ?? "", params.get("kind") === "image");
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
