import { z } from "zod";
import { draftUpdateSchema } from "@/lib/draft-schema";
import { requireActor } from "@/server/auth";
import { findDraft, saveDraft } from "@/server/drafts";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";

type Context = { params: Promise<{ id: string }> };

async function draftId(context: Context) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new AppError("草稿不存在。", 404);
  return id;
}

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    const draft = await findDraft(actor.id, await draftId(context));
    if (!draft) throw new AppError("草稿不存在或已提交。", 404);
    return Response.json(draft);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const parsed = draftUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("草稿格式或字段长度不符合要求。", 422);
    return Response.json(await saveDraft(actor.id, await draftId(context), parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
