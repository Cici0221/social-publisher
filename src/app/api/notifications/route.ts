import { requireActor } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listInbox, parseInboxParams } from "@/server/notification-read";

export async function GET(request: Request) {
  try {
    const actor = await requireActor();
    const result = await listInbox(actor.id, parseInboxParams(new URL(request.url).searchParams));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
