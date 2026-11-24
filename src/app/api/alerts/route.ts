import { getRecentAlerts } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const alerts = await getRecentAlerts(symbol?.toUpperCase() ?? null, limit);
  return Response.json({ ok: true, alerts, count: alerts.length });
}
