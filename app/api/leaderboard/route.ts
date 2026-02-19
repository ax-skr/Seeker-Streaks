import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function edgeCache(res: NextResponse) {
  // Make leaderboard feel instant but still fresh.
  res.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=15, stale-while-revalidate=60"
  );
  return res;
}

export async function GET(_req: NextRequest) {
  try {
    // ✅ FAST: DB only, no on-chain calls here.
    // ✅ Only verified users
    // ✅ Only top 100
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("wallet, points, streak, verified_at, skr_name")
      .not("verified_at", "is", null)
      .order("streak", { ascending: false })
      .order("points", { ascending: false })
      .limit(100);

    if (error?.code === "PGRST204") {
      return edgeCache(
        NextResponse.json(
          {
            ok: false,
            error: "Missing users.skr_name column in Supabase.",
          },
          { status: 500 }
        )
      );
    }

    if (error) {
      console.error("leaderboard select error:", error);
      return edgeCache(
        NextResponse.json({ ok: false, error: "Failed to load leaderboard" }, { status: 500 })
      );
    }

    const rows = (data ?? []).map((u: any, i: number) => ({
      rank: i + 1,
      wallet: String(u.wallet ?? ""),
      points: Number(u.points ?? 0),
      streak: Number(u.streak ?? 0),
      // Use cached value if present, UI will fill missing using batch endpoint
      name:
        typeof u.skr_name === "string" && u.skr_name.toLowerCase().endsWith(".skr")
          ? String(u.skr_name)
          : null,
    }));

    return edgeCache(NextResponse.json({ ok: true, rows }));
  } catch (e: any) {
    console.error("leaderboard error:", e);
    return edgeCache(
      NextResponse.json(
        { ok: false, error: "Internal server error", detail: String(e?.message || e) },
        { status: 500 }
      )
    );
  }
}