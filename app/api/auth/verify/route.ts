import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import bs58 from "bs58";

function base64ToBytes(s: string): Uint8Array {
  // Route handlers run on the server (Node), Buffer exists
  return new Uint8Array(Buffer.from(s, "base64"));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Accept either publicKey (new) or publickey (older)
    const publicKey = body.publicKey ?? body.publickey;
    const message = body.message;
    const signature = body.signature;

    if (!publicKey || !message || !signature) {
      return NextResponse.json(
        { ok: false, error: "Missing fields" },
        { status: 400 }
      );
    }

    // ✅ Read nonce cookie (cookies() is async)
const cookieStore = await cookies();
const nonceCookie = cookieStore.get("ss_nonce")?.value;

if (!nonceCookie) {
  return NextResponse.json(
    { ok: false, error: "Nonce cookie missing/expired." },
    { status: 401 }
  );
}

    // ✅ Ensure message contains nonce
    if (!String(message).includes(nonceCookie)) {
      return NextResponse.json(
        { ok: false, error: "Nonce mismatch." },
        { status: 401 }
      );
    }

    // ✅ Verify signature
    const msgBytes = new TextEncoder().encode(String(message));
    const sigBytes = base64ToBytes(String(signature)); // signature is base64
    const pubBytes = bs58.decode(String(publicKey));   // wallet pubkey is base58

    const verified = nacl.sign.detached.verify(
      msgBytes,
      sigBytes,
      pubBytes
    );

    if (!verified) {
      return NextResponse.json(
        { ok: false, error: "Invalid signature." },
        { status: 401 }
      );
    }

    // ✅ Clear nonce on success
    const res = NextResponse.json({ ok: true });
    res.cookies.set("ss_nonce", "", {
      maxAge: 0,
      path: "/",
    });

    return res;
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
