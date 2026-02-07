import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) {
    // This will surface clearly in your API response once we add debug output
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// Helpful sanity check (won't print secrets)
try {
  // URL constructor will throw if malformed
  new URL(SUPABASE_URL);
} catch {
  throw new Error(`SUPABASE_URL is not a valid URL: ${SUPABASE_URL}`);
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
