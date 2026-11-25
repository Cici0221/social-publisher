import { readAssets } from "@/server/assets/http";
import { assetFileResponse } from "@/server/assets/service";

export function GET(_request: Request, context: { params: Promise<{ assetId: string }> }) {
  return readAssets(async () => assetFileResponse((await context.params).assetId, true, null));
}
