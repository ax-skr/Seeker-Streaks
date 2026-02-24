import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type RowOut = {
  rank: number;
  wallet: string;
  points: number;
  streak: number;
  name: string | null; // from DB only
};

function looksLikeDomain(v: unknown) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (!s.includes(".")) return null; // basic sanity: "name.tld"
  if (s.length > 80) return null;
  return s;
}

function cacheHeaders(res: NextResponse) {
  res.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=10, stale-while-revalidate=60"
  );
  return res;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = String(searchParams.get("wallet") ?? "").trim(); // optional

    // 1) Top 100 (FAST)
    const { data: topRows, error: topErr } = await supabaseAdmin
      .from("users")
      .select("wallet, points, streak, verified_at, main_domain")
      .not("verified_at", "is", null)
      .order("streak", { ascending: false })
      .order("points", { ascending: false })
      .order("wallet", { ascending: true })
      .range(0, 99);

    if (topErr) {
      console.error("leaderboard top100 error:", topErr);
      return cacheHeaders(
        NextResponse.json(
          { ok: false, error: "Failed to load leaderboard" },
          { status: 500 }
        )
      );
    }

    const rows: RowOut[] = (topRows ?? []).map((u: any, i: number) => ({
      rank: i + 1,
      wallet: String(u.wallet ?? ""),
      points: Number(u.points ?? 0),
      streak: Number(u.streak ?? 0),
      name: looksLikeDomain(u.main_domain),
    }));

    // If no wallet requested, return only top100
    if (!wallet) {
      return cacheHeaders(NextResponse.json({ ok: true, rows }));
    }

    // 2) Fetch "me" row (real points/streak)
    const { data: meRow, error: meErr } = await supabaseAdmin
      .from("users")
      .select("wallet, points, streak, verified_at, main_domain")
      .eq("wallet", wallet)
      .maybeSingle();

    if (meErr) {
      console.error("leaderboard me select error:", meErr);
      return cacheHeaders(NextResponse.json({ ok: true, rows, me: null }));
    }

    if (!meRow?.wallet || !meRow?.verified_at) {
      return cacheHeaders(NextResponse.json({ ok: true, rows, me: null }));
    }

    const myStreak = Number(meRow.streak ?? 0);
    const myPoints = Number(meRow.points ?? 0);

    // 3) Compute rank without loading all users:
    // Order = streak DESC, points DESC, wallet ASC
    const { count: higherStreakCount } = await supabaseAdmin
      .from("users")
      .select("wallet", { count: "exact", head: true })
      .not("verified_at", "is", null)
      .gt("streak", myStreak);

    const { count: sameStreakHigherPointsCount } = await supabaseAdmin
      .from("users")
      .select("wallet", { count: "exact", head: true })
      .not("verified_at", "is", null)
      .eq("streak", myStreak)
      .gt("points", myPoints);

    const { count: sameStreakSamePointsLowerWalletCount } = await supabaseAdmin
      .from("users")
      .select("wallet", { count: "exact", head: true })
      .not("verified_at", "is", null)
      .eq("streak", myStreak)
      .eq("points", myPoints)
      .lt("wallet", wallet);

    const rank =
      (higherStreakCount ?? 0) +
      (sameStreakHigherPointsCount ?? 0) +
      (sameStreakSamePointsLowerWalletCount ?? 0) +
      1;

    const me: RowOut = {
      rank,
      wallet: String(meRow.wallet),
      points: myPoints,
      streak: myStreak,
      name: looksLikeDomain(meRow.main_domain),
    };

    return cacheHeaders(NextResponse.json({ ok: true, rows, me }));
  } catch (e: any) {
    console.error("leaderboard error:", e);
    return cacheHeaders(
      NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 })
    );
  }
}