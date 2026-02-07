import { NextResponse } from "next/server";

export async function GET() {
  // Generate a random nonce
  const nonce = crypto.randomUUID();

  // Message the wallet will sign
  const message = `Seeker Streaks verification\nNonce: ${nonce}`;

  // Create response FIRST
  const response = NextResponse.json({ message });

  // ✅ Set cookie on the SAME response object
  response.cookies.set("ss_nonce", nonce, {
    httpOnly: true,
    secure: true, // ngrok is HTTPS
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 minutes
  });

  return response;
}
