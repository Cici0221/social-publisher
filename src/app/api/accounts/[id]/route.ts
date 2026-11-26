import { z } from "zod";
import { changeAccount } from "@/server/accounts";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";

const schema = z.object({ language: z.enum(["ZH", "EN", "JA", "VI"]).optional(), detach: z.literal(true).optional() })
  .refine(data => Boolean(data.language || data.detach));

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN");
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("账号设置无效。", 422);
    await changeAccount(actor, (await params).id, parsed.data);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
