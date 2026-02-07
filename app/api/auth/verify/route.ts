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

    // Accept either publicKey (new) or publickey (older)
    const publicKey = String(body.publicKey ?? body.publickey ?? "").trim();
    const message = String(body.message ?? "");
    const signature = String(body.signature ?? "");

    if (!publicKey || !message || !signature) {
      return NextResponse.json(
        { ok: false, error: "Missing fields" },
        { status: 400 }
      );
    }

    // ✅ Read nonce cookie
    const cookieStore = await cookies();
    const nonceCookie = cookieStore.get("ss_nonce")?.value;

    if (!nonceCookie) {
      return NextResponse.json(
        { ok: false, error: "Nonce cookie missing/expired." },
        { status: 401 }
      );
    }

    // ✅ Ensure message contains nonce
    if (!message.includes(nonceCookie)) {
      return NextResponse.json(
        { ok: false, error: "Nonce mismatch." },
        { status: 401 }
      );
    }

    // ✅ Verify signature
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = base64ToBytes(signature); // signature is base64
    const pubBytes = bs58.decode(publicKey);   // wallet pubkey is base58

    const verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);

    if (!verified) {
      return NextResponse.json(
        { ok: false, error: "Invalid signature." },
        { status: 401 }
      );
    }

    // ✅ IMPORTANT: persist verified_at in Supabase
    const nowIso = new Date().toISOString();

    const { error: upsertErr } = await supabaseAdmin
      .from("users")
      .upsert(
        {
          wallet: publicKey,
          verified_at: nowIso,
        },
        { onConflict: "wallet" }
      );

    if (upsertErr) {
      console.error("SUPABASE VERIFY UPSERT ERROR:", upsertErr);
      return NextResponse.json(
        { ok: false, error: "Failed to update verification in database." },
        { status: 500 }
      );
    }

    // ✅ Clear nonce on success
    const res = NextResponse.json({ ok: true, verified_at: nowIso });
    res.cookies.set("ss_nonce", "", { maxAge: 0, path: "/" });

    return res;
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
