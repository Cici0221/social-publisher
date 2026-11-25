import { z } from "zod";
import { platformKeys } from "@/lib/platforms";
import { ProviderError } from "@/platforms/types";
import { authorizeAccount, saveDemoAccount } from "@/server/accounts";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse } from "@/server/errors";

const platform = z.enum(platformKeys);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("AUTHORIZE"), platform }),
  z.object({ action: z.literal("MOCK"), platform, name: z.string().trim().min(1).max(80), language: z.enum(["ZH", "EN", "JA", "VI"]) }),
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN");
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) throw new AppError("账号设置无效。", 422);
    const input = parsed.data;
    if (input.action === "AUTHORIZE") return Response.json({ url: await authorizeAccount(actor, input.platform) });
    return Response.json(await saveDemoAccount(actor, input.platform, input.name, input.language), { status: 201 });
  } catch (error) {
    return errorResponse(error instanceof ProviderError ? new AppError(error.message, 422) : error);
  }
}
