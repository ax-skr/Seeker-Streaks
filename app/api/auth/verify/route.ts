import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const publicKey = String(body.publicKey ?? body.publickey ?? "").trim();
    const message = String(body.message ?? "");
    const signature = String(body.signature ?? "");

    if (!publicKey || !message || !signature) {
      return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
    }

    // Read nonce cookie
    const cookieStore = await cookies();
    const nonceCookie = cookieStore.get("ss_nonce")?.value;

    if (!nonceCookie) {
      return NextResponse.json({ ok: false, error: "Nonce cookie missing/expired." }, { status: 401 });
    }

    if (!message.includes(nonceCookie)) {
      return NextResponse.json({ ok: false, error: "Nonce mismatch." }, { status: 401 });
    }

    // Verify signature
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = base64ToBytes(signature);
    const pubBytes = bs58.decode(publicKey);

    const verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    if (!verified) {
      return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
    }

    const nowIso = new Date().toISOString();

    // ✅ IMPORTANT: If user exists -> update verified_at
    // If not -> insert a full row with required defaults + verified_at
    const { data: existing, error: selErr } = await supabaseAdmin
      .from("users")
      .select("wallet")
      .eq("wallet", publicKey)
      .maybeSingle();

    if (selErr) {
      console.error("VERIFY SELECT ERROR:", selErr);
      return NextResponse.json({ ok: false, error: "Failed to read user." }, { status: 500 });
    }

    if (existing?.wallet) {
      const { error: updErr } = await supabaseAdmin
        .from("users")
        .update({ verified_at: nowIso })
        .eq("wallet", publicKey);

      if (updErr) {
        console.error("VERIFY UPDATE ERROR:", updErr);
        return NextResponse.json({ ok: false, error: "Failed to update verification." }, { status: 500 });
      }
    } else {
      const { error: insErr } = await supabaseAdmin
        .from("users")
        .insert({
          wallet: publicKey,
          points: 0,
          streak: 0,
          rescued_days_used_run: 0,
          last_checkin_date: null,
          verified_at: nowIso,
        });

      if (insErr) {
        console.error("VERIFY INSERT ERROR:", insErr);
        return NextResponse.json(
          { ok: false, error: "Failed to create verified user." },
          { status: 500 }
        );
      }
    }

    // Clear nonce
    const res = NextResponse.json({ ok: true, verified_at: nowIso });
    res.cookies.set("ss_nonce", "", { maxAge: 0, path: "/" });
    return res;
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
