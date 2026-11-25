import { z } from "zod";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";
import { markInboxRead } from "@/server/notification-read";

const selection = z.union([z.strictObject({ id: z.uuid() }), z.strictObject({ all: z.literal(true) })]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const parsed = selection.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("请选择要标记的通知。");
    await markInboxRead(actor.id, "id" in parsed.data ? parsed.data.id : undefined);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
