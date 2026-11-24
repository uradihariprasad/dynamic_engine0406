import { getZoneDetail } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await context.params;
  const detail = await getZoneDetail(decodeURIComponent(zoneId));
  if (!detail) {
    return Response.json({ ok: false, error: "Zone not found or no persisted history yet." }, { status: 404 });
  }
  return Response.json({ ok: true, zone: detail });
}
