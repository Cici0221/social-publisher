import { requireActor } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { exportHistory, parseHistoryFilters } from "@/server/history";

export async function GET(request: Request) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    const filters = parseHistoryFilters(new URL(request.url).searchParams);
    return new Response(exportHistory(actor, filters), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="publication-history.csv"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
