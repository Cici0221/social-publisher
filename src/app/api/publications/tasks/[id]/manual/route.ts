import { z } from "zod";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";
import { confirmManual, getManualDelivery, manualConfirmationSchema } from "@/server/manual";

type Context = { params: Promise<{ id: string }> };

async function taskId(context: Context) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new AppError("找不到半自动发布任务。", 404);
  return id;
}

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    return Response.json(await getManualDelivery(actor, await taskId(context)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const result = manualConfirmationSchema.safeParse(await request.json().catch(() => null));
    if (!result.success) throw new AppError("请填写发布链接并检查文案长度。", 422);
    return Response.json(await confirmManual(actor, await taskId(context), result.data));
  } catch (error) {
    return errorResponse(error);
  }
}
