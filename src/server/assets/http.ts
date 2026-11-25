import { after } from "next/server";
import { requireActor, type Actor } from "../auth";
import { AppError, assertSameOrigin, errorResponse } from "../errors";
import { wakeAssetMaintenance } from "./service";

export function scheduleAssetWork() {
  after(wakeAssetMaintenance);
}

export async function jsonInput(request: Request): Promise<unknown> {
  try { return await request.json() as unknown; }
  catch { throw new AppError("请求格式有误。"); }
}

export async function readAssets(run: (actor: Actor) => Promise<Response>) {
  try { return await run(await requireActor()); }
  catch (error) { return errorResponse(error); }
}

export async function writeAssets(request: Request, run: (actor: Actor) => Promise<Response>) {
  try {
    assertSameOrigin(request);
    return await run(await requireActor("ADMIN", "EDITOR"));
  } catch (error) {
    return errorResponse(error);
  }
}
