import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";
import { changeSchedule, scheduleChange } from "@/server/schedules";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const parsed = scheduleChange.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("发布时间无效。", 422);
    await changeSchedule(actor, (await params).id, parsed.data);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
