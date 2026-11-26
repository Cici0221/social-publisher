import { z } from "zod";
import { platformKeys } from "@/lib/platforms";
import { ProviderError } from "@/platforms/types";
import { authorizeAccount, saveDemoAccount } from "@/server/accounts";
import { saveManualAccount } from "@/server/manual";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";

const platform = z.enum(platformKeys);
const details = { platform, name: z.string().trim().min(1).max(80), language: z.enum(["ZH", "EN", "JA", "VI"]) };
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("AUTHORIZE"), platform }),
  z.object({ action: z.literal("MOCK"), ...details }),
  z.object({ action: z.literal("MANUAL"), ...details, backendUrl: z.string().max(2048).optional() }),
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN");
    const parsed = requestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("账号设置无效。", 422);
    const input = parsed.data;
    if (input.action === "AUTHORIZE") return Response.json({ url: await authorizeAccount(actor, input.platform) });
    if (input.action === "MANUAL") return Response.json(await saveManualAccount(actor, input.platform, input.name, input.language, input.backendUrl), { status: 201 });
    return Response.json(await saveDemoAccount(actor, input.platform, input.name, input.language), { status: 201 });
  } catch (error) {
    return errorResponse(error instanceof ProviderError ? new AppError(error.message, 422) : error);
  }
}
