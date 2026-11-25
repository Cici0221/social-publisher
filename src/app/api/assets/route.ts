import { readAssets, scheduleAssetWork } from "@/server/assets/http";
import { listAssets } from "@/server/assets/service";

export function GET(request: Request) {
  return readAssets(async actor => {
    const result = await listAssets(actor, new URL(request.url).searchParams);
    scheduleAssetWork();
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  });
}
