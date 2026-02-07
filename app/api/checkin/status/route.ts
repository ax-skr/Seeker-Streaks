import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const MAX_RESCUE_DAYS = 4;
const SKR_PER_DAY = 500;

// Optional debug endpoint (safe to keep)
export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST JSON: { wallet }",
    env: {
      hasSUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      hasSERVICE_ROLE: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const wallet = body?.wallet;

    if (!wallet) {
      return NextResponse.json({ error: "Wallet required" }, { status: 400 });
    }

    // Load user
    const { data: user, error } = await supabaseAdmin
      .from("users")
      .select(
        "wallet, streak, last_checkin_date, rescued_days_used_run, verified_at"
      )
      .eq("wallet", wallet)
      .maybeSingle();

    if (error) {
      console.error("Supabase error:", error);
      return NextResponse.json(
        { error: "Supabase query failed", details: error.message },
        { status: 500 }
      );
    }

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Not verified yet
    if (!user.verified_at) {
      return NextResponse.json({
        ok: true,
        verified: false,
      });
    }

    // Compute missed days (UTC-safe)
    const today = new Date();
    const todayUTC = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate()
      )
    );

    let missedDays = 0;
    if (user.last_checkin_date) {
      const last = new Date(user.last_checkin_date + "T00:00:00Z");
      const diffMs = todayUTC.getTime() - last.getTime();
      missedDays = Math.max(0, Math.floor(diffMs / 86400000) - 1);
    }

    const remainingRescue =
      MAX_RESCUE_DAYS - (user.rescued_days_used_run ?? 0);

    const canRescue =
      missedDays > 0 &&
      missedDays <= remainingRescue &&
      missedDays <= MAX_RESCUE_DAYS;

    const costSKR = canRescue ? missedDays * SKR_PER_DAY : 0;

    return NextResponse.json({
      ok: true,
      verified: true,
      missedDays,
      canRescue,
      costSKR,
      streak: user.streak ?? 0,
      remainingRescue,
    });
  } catch (e: any) {
    console.error("Status route crash:", e);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: e?.message ?? String(e),
      },
      { status: 500 }
    );
  }
}
