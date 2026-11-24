import { db } from "@/db";
import { sql } from "drizzle-orm";
import { warmCache } from "@/lib/warmup";

export const dynamic = "force-dynamic";

export async function GET() {
  // Kick off the cold-start warm-up without blocking the health probe. Render calls
  // this immediately after boot, which warms the instrument master before the first
  // real user scan.
  void warmCache();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
